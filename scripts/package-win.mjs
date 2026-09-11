// Runtime-only Electron packaging. This helper never creates or publishes a release.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist-packaged');
const packageDirectory = path.join(output, 'Amane Stock Manager-win32-x64');
const requiredFiles = ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'];
const privateName = /^(?:\.env(?:\..*)?|\.git|\.agents|\.codex|\.config|\.bin|\.npmrc|\.yarnrc(?:\.yml)?|\.DS_Store|Thumbs\.db)$/i;

/** Positive root allowlist; dependencies are additionally pruned by Electron Packager. */
export function isPackagePath(entry) {
  const normalized = entry.replaceAll('\\', '/').replace(/^\//, '');
  if (!normalized) return true;
  const parts = normalized.split('/');
  if (parts.some(part => part === '..' || privateName.test(part) || /\.(?:log|map|pem|key|pfx|p12)$/i.test(part))) return false;
  return normalized === 'package.json' || ['out', 'assets', 'node_modules'].includes(parts[0]);
}

async function optionalStat(target) {
  try { return await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertNoLinks(directory) {
  const info = await optionalStat(directory);
  if (!info) return;
  if (info.isSymbolicLink()) throw new Error(`Refusing linked package path: ${directory}`);
  if (info.isDirectory()) for (const entry of await readdir(directory)) await assertNoLinks(path.join(directory, entry));
}

/** OneDrive placeholders are permitted only when every path resolves in place. */
export async function assertSafeReleaseDirectory(projectRoot) {
  const canonical = value => {
    const normalized = path.resolve(value).replace(/^\\\\\?\\/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const physicalRoot = await realpath(projectRoot), expected = path.join(physicalRoot, 'Releases');
  const directory = path.join(path.resolve(projectRoot), 'Releases');
  async function visit(current, expectedCurrent) {
    const info = await optionalStat(current);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link or junction in release output: ${current}`);
    // A cloud reparse point does not rename its target. Name-surrogate or other
    // filesystem redirections must resolve to exactly the expected location.
    if (canonical(await realpath(current)) !== canonical(expectedCurrent)) throw new Error(`Refusing redirected release path: ${current}`);
    if (info.isDirectory()) {
      for (const name of await readdir(current)) await visit(path.join(current, name), path.join(expectedCurrent, name));
    } else if (!info.isFile()) throw new Error(`Unsupported release filesystem entry: ${current}`);
  }
  await visit(directory, expected);
  return {directory, checked:true};
}

/** Audits before hashing, so an accidentally included private file is never read. */
export async function auditPackagedApp(directory) {
  const manifest = [];
  async function visit(relative = '') {
    if (!isPackagePath(relative)) throw new Error(`Unexpected file in packaged application: ${relative}`);
    const absolute = path.join(directory, relative), info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Linked file in packaged application: ${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) {
      manifest.push({path:relative, bytes:info.size, sha256:createHash('sha256').update(await readFile(absolute)).digest('hex')});
    } else throw new Error(`Unsupported filesystem entry in package: ${relative}`);
  }
  await visit();
  for (const required of requiredFiles) {
    if (!manifest.some(file => file.path === required && file.bytes > 0)) throw new Error(`Missing runtime file: ${required}`);
  }
  const packaged = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  for (const name of Object.keys(packaged.dependencies ?? {})) {
    if (!manifest.some(file => file.path === `node_modules/${name}/package.json`)) throw new Error(`Missing production dependency: ${name}`);
  }
  return manifest;
}

export function checkPackagePolicy() {
  const allowed = ['', '/package.json', '/out/main/index.js', '/out/renderer/assets/index.js', '/assets/app.svg', '/node_modules/velopack/lib/index.js', '/node_modules/velopack/lib/velopack.node', '/node_modules/@neon-rs/load/package.json'];
  const blocked = ['/tests/example.ts', '/artifacts/records.json', '/.agents/notes.md', '/.codex/config.toml', '/.env', '/.env.local', '/native-smoke.stdout.log', '/electron.vite.config.ts', '/tsconfig.json', '/package-lock.json', '/Releases/releases.win.json', '/dist-packaged/app.exe', '/src/main/index.ts', '/README.md', '/out/.env.production', '/assets/private.key', '/node_modules/pkg/.npmrc', '/node_modules/pkg/debug.log', '/node_modules/.bin/tool.cmd', '/out/main/index.js.map', '/out/../secret.json', '\\out\\.env'];
  for (const entry of allowed) assert.equal(isPackagePath(entry), true, `Runtime path rejected: ${entry}`);
  for (const entry of blocked) assert.equal(isPackagePath(entry), false, `Private/build path accepted: ${entry}`);
  return {allowed:allowed.length, blocked:blocked.length};
}

async function packageWindows() {
  // Existing output may be replaced, but neither it nor its parent may redirect
  // the packager's overwrite operation outside this checkout.
  const relative = path.relative(root, packageDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe package destination.');
  const parentInfo = await optionalStat(output);
  if (parentInfo?.isSymbolicLink()) throw new Error('dist-packaged must not be a symbolic link or junction.');
  await assertNoLinks(packageDirectory);
  for (const required of requiredFiles) {
    const info = await lstat(path.join(root, required));
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error(`Build output missing or unsafe: ${required}`);
  }
  const {packager} = await import('@electron/packager');
  let manifest;
  const directories = await packager({
    dir:root, name:'Amane Stock Manager', platform:'win32', arch:'x64', out:output,
    overwrite:true, prune:true, derefSymlinks:false,
    // Keep the current unpacked layout for Velopack's native .node module.
    asar:false,
    ...(await optionalStat(path.join(root, 'assets/app.ico')) ? {icon:path.join(root, 'assets/app.ico')} : {}),
    ignore:entry => !isPackagePath(entry),
    afterCopy:[async ({buildPath}) => { manifest = await auditPackagedApp(buildPath); }]
  });
  if (directories.length !== 1 || path.resolve(directories[0]) !== packageDirectory) throw new Error('Unexpected Electron package output.');
  manifest = await auditPackagedApp(path.join(packageDirectory, 'resources/app'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const report = {version:pkg.version, platform:'win32', arch:'x64', sourceRoots:['out', 'assets', 'node_modules (production only)', 'package.json'], files:manifest};
  const manifestPath = path.join(output, 'package-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({packaged:directories, files:manifest.length, manifest:manifestPath, publication:false}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Unexpected packaging arguments.');
    if (process.argv[2] === '--check-policy') console.log(JSON.stringify({passed:true, ...checkPackagePolicy(), publication:false}));
    else if (process.argv[2] === '--check-release-directory') console.log(JSON.stringify({...await assertSafeReleaseDirectory(root), publication:false}));
    else { if (process.argv.length > 2) throw new Error('Only --check-policy or --check-release-directory is supported.'); await packageWindows(); }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
