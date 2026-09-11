/* Read-only candidate audit. Writes evidence under artifacts; never changes
 * Releases, publishes, installs, launches an updater, or uses real inventories. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash } = require('node:crypto');
const { unzipSync } = require('fflate');
const root = path.resolve(__dirname, '..');
const version = process.argv[2] || '0.2.1';
assert.match(version, /^\d+\.\d+\.\d+$/);
const directory = path.join(root, 'Releases');
const output = path.join(root, 'artifacts', `release-candidate-${version}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const sha = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const report = { status: 'RUNNING', version, directory, output, checks: [], assets: [], modifiesReleaseFiles: false, publishes: false, installs: false };
async function digest(file) { const h = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) h.update(chunk); return h.digest('hex'); }
async function inspectRuntimeZip(file, manifest, kind) {
  const bytes = await fsp.readFile(file), names = [];
  unzipSync(bytes, { filter: entry => { names.push(entry.name); return false; } });
  const runtimePackages = names.filter(name => /(?:^|\/)resources\/app\/package\.json$/.test(name));
  assert.equal(runtimePackages.length, 1, `${kind}: one unpacked runtime`);
  const prefix = runtimePackages[0].slice(0, -'package.json'.length);
  const wanted = unzipSync(bytes, { filter: entry => entry.name.startsWith(prefix) || entry.name.endsWith('.nuspec') });
  const runtime = Object.keys(wanted).filter(name => name.startsWith(prefix) && !name.endsWith('/'));
  assert.equal(runtime.length, manifest.files.length, `${kind}: no omitted or extra runtime files`);
  const actualPackage = JSON.parse(Buffer.from(wanted[`${prefix}package.json`]).toString('utf8'));
  assert.equal(actualPackage.version, version);
  for (const entry of manifest.files) {
    const content = wanted[prefix + entry.path]; assert.ok(content, `${kind}: missing ${entry.path}`);
    assert.equal(content.byteLength, entry.bytes, `${kind}: size ${entry.path}`); assert.equal(sha(content), entry.sha256, `${kind}: hash ${entry.path}`);
  }
  const roots = [...new Set(runtime.map(name => name.slice(prefix.length).split('/')[0]))].sort();
  assert.deepEqual(roots, ['assets', 'node_modules', 'out', 'package.json']);
  const native = `${prefix}node_modules/velopack/lib/native/velopack_nodeffi_win_x64_msvc.node`;
  assert.ok(wanted[native]?.byteLength > 0, 'Packaged Windows x64 native updater is required');
  if (kind === 'full-nupkg') {
    const specifications = Object.keys(wanted).filter(name => name.endsWith('.nuspec')); assert.equal(specifications.length, 1);
    assert.match(Buffer.from(wanted[specifications[0]]).toString('utf8'), new RegExp(`<version>${version.replaceAll('.', '\\.')}<\\/version>`));
  }
  return { kind, name: path.basename(file), bytes: bytes.length, sha256: sha(bytes), files: runtime.length, roots, runtimePrefix: prefix, mainSha256: sha(wanted[`${prefix}out/main/index.js`]), nativeUpdaterSha256: sha(wanted[native]) };
}
(async () => {
  await fsp.mkdir(output, { recursive: true });
  const manifestBytes = await fsp.readFile(path.join(root, 'dist-packaged/package-manifest.json'));
  const manifest = JSON.parse(manifestBytes); assert.equal(manifest.version, version);
  report.runtimeManifestSha256 = sha(manifestBytes);
  const fullName = `AmaneStockManager-${version}-full.nupkg`, deltaName = `AmaneStockManager-${version}-delta.nupkg`;
  report.checks.push(await inspectRuntimeZip(path.join(directory, fullName), manifest, 'full-nupkg'));
  report.checks.push(await inspectRuntimeZip(path.join(directory, 'AmaneStockManager-win-Portable.zip'), manifest, 'portable-zip'));
  const available = await fsp.readdir(directory);
  const names = [fullName, ...available.includes(deltaName) ? [deltaName] : [], 'AmaneStockManager-win-Setup.exe', 'AmaneStockManager-win-Portable.zip', 'releases.win.json', 'releases.win-x64.json', 'releases.stable.json', 'releases.json', 'RELEASES'];
  for (const name of names) { const file = path.join(directory, name); const stat = await fsp.stat(file); assert.ok(stat.size > 0); report.assets.push({ name, file, bytes: stat.size, sha256: await digest(file), modifiedAt: stat.mtime.toISOString() }); }
  const feedFiles = names.filter(name => name.startsWith('releases.'));
  let feedBytes;
  for (const name of feedFiles) { const bytes = await fsp.readFile(path.join(directory, name)); if (feedBytes) assert.ok(bytes.equals(feedBytes), 'All four compatible JSON feeds must be byte-identical'); else feedBytes = bytes; }
  const feed = JSON.parse(feedBytes);
  const current = feed.Assets.filter(asset => asset.Version === version);
  assert.equal(current.filter(asset => asset.Type === 'Full').length, 1);
  assert.equal(current.find(asset => asset.Type === 'Full').FileName, fullName);
  for (const asset of current) { assert.ok(['Full', 'Delta'].includes(asset.Type)); const expected = report.assets.find(entry => entry.name === asset.FileName); assert.ok(expected); assert.equal(expected.bytes, asset.Size); assert.equal(expected.sha256, asset.SHA256.toLowerCase()); }
  report.currentFeedAssets = current;
  report.legacyFeedReferences = feed.Assets.filter(asset => asset.Version !== version).map(asset => ({ version: asset.Version, file: asset.FileName, type: asset.Type }));
  const releaseText = await fsp.readFile(path.join(directory, 'RELEASES'), 'utf8');
  const releaseLines = releaseText.trim().split(/\r?\n/).filter(Boolean).map(line => { const [sha1, name, size] = line.trim().split(/\s+/); return { sha1, name, bytes: Number(size) }; });
  const currentLines = releaseLines.filter(entry => entry.name === fullName || entry.name === deltaName);
  assert.ok(currentLines.some(entry => entry.name === fullName));
  for (const entry of currentLines) { const bytes = await fsp.readFile(path.join(directory, entry.name)); assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes, 'sha1'), entry.sha1.toLowerCase()); }
  report.legacyReleaseReferences = releaseLines.filter(entry => !currentLines.includes(entry)).map(entry => entry.name);
  report.requiresFeedStaging = report.legacyFeedReferences.length > 0 || report.legacyReleaseReferences.length > 0;
  // Reproduce the installed client's version comparison using only an isolated
  // old manifest. The genuine updater file is copied for locator validation;
  // no updater executable, download, installation, or apply method is invoked.
  const oldBytes = await fsp.readFile(path.join(directory, 'AmaneStockManager-0.2.0-full.nupkg'));
  const oldEntries = unzipSync(oldBytes, { filter: entry => entry.name.endsWith('.nuspec') || entry.name === 'lib/app/Squirrel.exe' });
  const oldSpecifications = Object.keys(oldEntries).filter(name => name.endsWith('.nuspec')); assert.equal(oldSpecifications.length, 1);
  const locatorRoot = path.join(output, 'isolated-update-check'), packages = path.join(locatorRoot, 'packages'); await fsp.mkdir(packages, { recursive: true });
  const oldManifest = path.join(locatorRoot, 'sq.version'), updaterPath = path.join(locatorRoot, 'Update.exe');
  await fsp.writeFile(oldManifest, oldEntries[oldSpecifications[0]]); await fsp.writeFile(updaterPath, oldEntries['lib/app/Squirrel.exe']);
  const { UpdateManager } = require('velopack');
  const manager = new UpdateManager(directory, { AllowVersionDowngrade: false, ExplicitChannel: 'win', MaximumDeltasBeforeFallback: -1 }, { RootAppDir: locatorRoot, PackagesDir: packages, ManifestPath: oldManifest, UpdateExePath: updaterPath, CurrentBinaryDir: locatorRoot, IsPortable: true });
  assert.equal(manager.getAppId(), 'AmaneStockManager'); assert.equal(manager.getCurrentVersion(), '0.2.0');
  const update = await manager.checkForUpdatesAsync(); assert.equal(update.TargetFullRelease.Version, version); assert.equal(update.IsDowngrade, false);
  report.updateDetection = { currentVersion: '0.2.0', availableVersion: version, downgrade: false, localFeedOnly: true, installOrApplyCalled: false };
  report.suggestedFeed = { Assets: current };
  report.suggestedRELEASES = currentLines.map(entry => `${entry.sha1} ${entry.name} ${entry.bytes}`).join('\n') + '\n';
  report.advice = report.requiresFeedStaging ? 'Preserve local Releases and older GitHub releases. In a separate publish staging directory, use the listed current binaries, identical JSON feeds containing only current Full/Delta, and RELEASES with only those package lines. Re-hash the staged feeds before upload; do not upload old multi-GB packages.' : 'The listed assets can be staged unchanged. Preserve older local files and GitHub releases; publish only this explicit list.';
  report.status = 'PASS';
})().catch(error => { report.status = 'FAIL'; report.failure = error.stack; process.exitCode = 1; }).finally(async () => {
  await fsp.writeFile(path.join(output, 'candidate-audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, assets: report.assets.length, checks: report.checks, requiresFeedStaging: report.requiresFeedStaging, failure: report.failure }, null, 2));
});
