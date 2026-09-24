/* Isolated native acceptance for explicit same-book local overwrite.
 * Run with Node (it launches hidden Electron children):
 * node scripts/smoke-cloud-overwrite.cjs [--app-root <root-or-app.asar>]
 *   [--case confirm-and-cancel|concurrent-409|crash-response] [--electron <path>]
 * Only synthetic files/accounts, intercepted fetch, and blocked renderer HTTP are used.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (name === '--native') options.native = true;
  else if (['--app-root', '--case', '--electron', '--directory', '--phase'].includes(name) && process.argv[i + 1]) options[name.slice(2)] = process.argv[++i];
  else throw new Error(`Unknown or incomplete argument: ${name}`);
}
const targetRoot = path.resolve(options['app-root'] || root);
const scenarios = ['confirm-and-cancel', 'concurrent-409', 'crash-response'];
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = document => { const { cloudLink: _link, ...inventory } = document; return inventory; };

function inventoryFixture() {
  const stamp = '2026-09-24T12:00:00.000Z', barcode = 'SYNTHETIC-OVERWRITE-01';
  const item = { barcode, sortIndex: 0, nickname: '原始合成商品', lookupName: 'Synthetic overwrite item', brand: '', category: '', imageUrl: '',
    priceAmount: 3, salePriceAmount: 8, priceCurrency: 'CAD', lookupSource: 'none', lookupConfidence: 0, quantityOnHand: 5, totalIn: 5, totalOut: 0,
    firstInAt: stamp, lastInAt: stamp, lastOutAt: null, lookupStatus: 'not_found', lookupUpdatedAt: stamp, createdAt: stamp, updatedAt: stamp,
    listed: false, shop: { imageId: null, originalCents: 1000, currentCents: 800, discountBps: 2000, priceSource: 'current' } };
  return { schemaVersion: 7, inventoryId: randomUUID(), inventoryName: '同一云库存覆盖验收（合成）', createdAt: stamp, updatedAt: stamp,
    items: { [barcode]: item }, transactions: [{ id: randomUUID(), barcode, type: 'in', timestamp: stamp,
      quantityChange: 5, quantityAfter: 5, lookupNameAtTime: item.lookupName, nicknameAtTime: item.nickname }] };
}

async function driver() {
  const selected = options.case ? [options.case] : scenarios;
  assert.ok(selected.every(name => scenarios.includes(name)), 'Unknown overwrite scenario');
  const isolatedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'amane-overwrite-qa-'));
  const output = path.join(root, 'artifacts', 'release-0.2.4', `native-cloud-overwrite-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fsp.mkdir(output, { recursive: true });
  const electron = path.resolve(options.electron || path.join(root, 'node_modules/electron/dist/electron.exe'));
  const report = { status: 'RUNNING', targetRoot, electron, isolatedRoot, output, checks: [], realRequests: 0, realInventories: 0 };
  async function child(name, phase, directory) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
      const processHandle = spawn(electron, [__filename, '--native', '--case', name, '--phase', phase, '--directory', directory, '--app-root', targetRoot],
        { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      processHandle.stdout.on('data', bytes => { stdout += bytes; }); processHandle.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => processHandle.kill(), 65000);
      processHandle.on('error', reject);
      processHandle.on('close', async code => {
        clearTimeout(timer);
        await Promise.all([fsp.writeFile(path.join(output, `${name}-${phase}.stdout.log`), stdout), fsp.writeFile(path.join(output, `${name}-${phase}.stderr.log`), stderr)]);
        resolve({ code, stdout, stderr });
      });
    });
  }
  try {
    for (const name of selected) {
      const directory = path.join(isolatedRoot, name); await fsp.mkdir(directory);
      await fsp.writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ name, inventory: inventoryFixture(), account: {
        id: randomUUID(), username: 'synthetic-overwrite', displayName: '覆盖流程隔离验收', permissions: ['inventory.manage', 'pricing.manage'], mustChangePassword: false,
      } }));
      let result = await child(name, 'first', directory);
      if (name === 'crash-response') {
        assert.equal(result.code, 42, `Expected controlled exit after the server commit, got ${result.code}\n${result.stderr}`);
        result = await child(name, 'resume', directory);
      }
      assert.equal(result.code, 0, `${name} native acceptance failed\n${result.stderr}`);
      const evidence = readJson(path.join(directory, 'result.json')); assert.equal(evidence.status, 'PASS');
      report.checks.push(evidence); console.log(`PASS ${name}`);
    }
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.failure = error.stack; process.exitCode = 1; }
  await fsp.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(root, 'artifacts', 'release-0.2.4', 'native-cloud-overwrite.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, output, failure: report.failure }, null, 2));
}

async function native() {
  const { app, BrowserWindow, session, dialog } = require('electron');
  app.disableHardwareAcceleration();
  const directory = path.resolve(options.directory);
  assert.ok(directory.startsWith(path.join(os.tmpdir(), 'amane-overwrite-qa-')), 'Only isolated QA folders are accepted');
  const fixture = readJson(path.join(directory, 'fixture.json')), id = fixture.inventory.inventoryId, barcode = Object.keys(fixture.inventory.items)[0];
  const file = path.join(directory, 'synthetic.json'), journalFile = path.join(directory, 'stock-sync-journal.json'), stateFile = path.join(directory, 'synthetic-server.json');
  const resuming = options.phase === 'resume';
  const state = resuming ? readJson(stateFile) : { book: null, mode: 'initial', requests: [], commits: [], responses: {}, blocked: [],
    cloudSnapshots: {}, expectedLocal: null, staleRequestKey: null, overwriteAttempts: [], uiChecks: [], crash: null };
  const persist = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const backups = async () => (await fsp.readdir(directory)).filter(name => name.startsWith('synthetic.json.cloud-v') && name.endsWith('.json'));
  async function verifyBackup(version) {
    const matching = (await backups()).filter(name => name.startsWith(`synthetic.json.cloud-v${version}.backup-`));
    assert.equal(matching.length, 1, `One immutable backup of cloud v${version} before PUT`);
    const backup = readJson(path.join(directory, matching[0]));
    assert.deepEqual(backup, state.cloudSnapshots[version]); assert.equal(backup.cloudLink, undefined);
    return matching[0];
  }
  function advanceCloud(label) {
    state.book = structuredClone(state.book); state.book.version++;
    state.book.inventory.items[barcode].nickname = label; state.book.inventory.items[barcode].quantityOnHand = 2;
    state.cloudSnapshots[state.book.version] = canonical(structuredClone(state.book.inventory)); persist();
  }
  global.fetch = async (target, request = {}) => {
    const url = new URL(String(target)), method = request.method || 'GET', headers = new Headers(request.headers);
    if (url.origin !== 'https://api.amaneacg.space') { state.blocked.push(url.origin); persist(); throw new Error('Real network is forbidden'); }
    assert.equal(headers.get('Origin'), 'https://console.amaneacg.space'); assert.equal(request.redirect, 'error');
    if (url.pathname === '/api/auth/login') {
      const responseHeaders = new Headers({ 'content-type': 'application/json' });
      responseHeaders.append('set-cookie', '__Host-amane_admin_session=synthetic-overwrite-session; Secure; HttpOnly; Path=/');
      responseHeaders.append('set-cookie', '__Host-amane_admin_csrf=synthetic-overwrite-csrf; Secure; Path=/');
      return new Response(JSON.stringify({ authenticated: true, account: fixture.account }), { headers: responseHeaders });
    }
    assert.ok(headers.get('cookie')?.includes('__Host-amane_admin_session=synthetic-overwrite-session'));
    if (method !== 'GET') assert.equal(headers.get('X-CSRF-Token'), 'synthetic-overwrite-csrf');
    if (url.pathname === '/api/auth/session') return json({ authenticated: true, account: fixture.account });
    if (url.pathname === '/api/auth/logout') return json({ ok: true });
    assert.ok(['/api/stock-books', `/api/stock-books/${id}`].includes(url.pathname), `Unspecified synthetic route ${url.pathname}`);
    state.requests.push({ method, path: url.pathname, body: request.body || null }); persist();
    if (method === 'GET') return url.pathname === '/api/stock-books' ? json({ items: [] }) : state.book ? json(state.book) : json({ error: 'STOCK_REQUEST_FAILED' }, 404);
    const body = JSON.parse(request.body);
    assert.equal(body.inventory.inventoryId, id, 'Overwrite retains the cloud inventory identity');
    const journal = readJson(journalFile)[0];
    assert.equal(journal.pending?.body, request.body, 'Exact snapshot is durable before every mutation');
    if (state.responses[body.requestKey]) {
      assert.equal(state.responses[body.requestKey].wire, request.body, 'Retry reuses byte-identical request');
      return json(state.responses[body.requestKey].record);
    }
    if (state.mode === 'seed-conflict') {
      assert.equal(method, 'PUT'); state.staleRequestKey = body.requestKey; advanceCloud('云端原始修改（必须备份）'); state.mode = 'conflicted'; persist();
      return json({ error: 'STOCK_CONFLICT' }, 409);
    }
    if (state.mode !== 'initial') {
      assert.equal(method, 'PUT', 'Explicit overwrite must never create another inventory');
      assert.notEqual(body.requestKey, state.staleRequestKey, 'Explicit choice creates a new idempotency key');
      assert.equal(body.version, state.book.version, 'Explicit overwrite reads the latest cloud version');
      assert.deepEqual(canonical(body.inventory), state.expectedLocal, 'The current local snapshot is preserved');
      await verifyBackup(body.version);
      state.overwriteAttempts.push({ requestKey: body.requestKey, version: body.version, wire: request.body }); persist();
      if (fixture.name === 'concurrent-409' && state.overwriteAttempts.length === 1) {
        advanceCloud('第二次云端修改（必须再次确认）'); state.mode = 'second-conflict'; persist();
        return json({ error: 'STOCK_CONFLICT' }, 409);
      }
    }
    if (state.book && body.version !== state.book.version) return json({ error: 'STOCK_CONFLICT' }, 409);
    state.book = { id, version: state.book ? state.book.version + 1 : 1, inventory: body.inventory, updatedAt: fixture.inventory.updatedAt, shopRegisteredBarcodes: [] };
    state.responses[body.requestKey] = { wire: request.body, record: structuredClone(state.book) };
    state.commits.push({ method, id, version: state.book.version, requestKey: body.requestKey }); persist();
    if (fixture.name === 'crash-response' && state.mode !== 'initial' && !resuming) {
      state.crash = { requestKey: body.requestKey, wire: request.body, committedVersion: state.book.version }; persist();
      fs.writeFileSync(path.join(directory, 'crash-evidence.json'), JSON.stringify({ crash: state.crash, journal: readJson(journalFile), inventory: readJson(file) }, null, 2));
      app.exit(42); return new Promise(() => {});
    }
    return json(state.book);
  };
  app.setPath('userData', directory); app.setPath('sessionData', directory);
  if (!resuming) {
    await fsp.writeFile(file, JSON.stringify(fixture.inventory)); await fsp.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ lastInventoryPath: file })); persist();
  }
  app.on('browser-window-created', (_event, window) => { window.hide(); window.on('show', () => window.hide()); });
  dialog.showErrorBox = (title, message) => { throw new Error(`Unexpected dialog ${title}: ${message}`); };
  const timeout = setTimeout(() => { process.stderr.write('OVERWRITE_NATIVE_TIMEOUT\n'); app.exit(1); }, 55000);
  async function until(test, label) { for (let i = 0; i < 150; i++) { if (await test()) return; await delay(60); } throw new Error('Timed out: ' + label); }
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const external = /^https?:/i.test(details.url); if (external) { state.blocked.push(new URL(details.url).origin); persist(); } callback({ cancel: external });
    });
    require(path.join(targetRoot, 'out/main/index.js'));
    await until(() => BrowserWindow.getAllWindows().length > 0, 'native window');
    const window = BrowserWindow.getAllWindows()[0], js = code => window.webContents.executeJavaScript(code);
    await until(() => js('Boolean(window.amaneStock && document.querySelector(".shop-editor"))').catch(() => false), 'sandboxed renderer');
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true); assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true);
    const status = () => js('window.amaneStock.cloudStatus()');
    const hasButton = text => js(`Array.from(document.querySelectorAll('.cloud-panel button')).some(button => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled)`);
    const click = async text => {
      await until(() => hasButton(text), 'enabled button ' + text);
      return js(`(() => { const button = Array.from(document.querySelectorAll('.cloud-panel button')).find(button => button.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('Button unavailable'); button.click(); })()`);
    };
    if (!(await status()).account) await js('window.amaneStock.cloudLogin("synthetic-overwrite", "synthetic-password-only")');
    if (!resuming) {
      assert.equal(state.commits.length, 0, 'Login alone does not upload inventory');
      await js('window.amaneStock.cloudConnect()'); await js('window.amaneStock.cloudRetry()');
      await until(async () => (await status()).state === 'synced', 'initial explicit connection');
      state.mode = 'seed-conflict'; persist();
      await js(`window.amaneStock.updateQuantity(${JSON.stringify(barcode)}, 9)`);
      await js(`window.amaneStock.updateNickname(${JSON.stringify(barcode)}, '本地需保留的商品名称')`);
      state.expectedLocal = canonical((await js('window.amaneStock.getCurrentInventory()')).inventory); persist();
      await js('window.amaneStock.cloudRetry()'); await until(async () => (await status()).state === 'conflict', 'seeded version conflict');
      assert.equal(readJson(journalFile)[0].pending.requestKey, state.staleRequestKey);
      const beforeRequests = state.requests.length, beforeCommits = state.commits.length;
      await click('使用本地覆盖云端');
      await until(() => js('Boolean(document.querySelector(".cloud-overwrite-confirm"))'), 'inline confirmation');
      assert.equal(state.requests.length, beforeRequests, 'Opening confirmation makes no network request');
      assert.equal((await backups()).length, 0, 'Opening confirmation does not create backups');
      await click('取消覆盖');
      await until(() => js('!document.querySelector(".cloud-overwrite-confirm")'), 'confirmation cancelled');
      assert.equal(state.requests.length, beforeRequests, 'Cancellation makes no network request');
      assert.equal(state.commits.length, beforeCommits); assert.deepEqual(canonical(readJson(file)), state.expectedLocal);
      state.uiChecks.push('renderer confirmation and cancellation leave both inventories unchanged'); persist();
      await click('使用本地覆盖云端');
      await until(() => js('Boolean(document.querySelector(".cloud-overwrite-confirm"))'), 'confirmation reopened');
      if (fixture.name === 'confirm-and-cancel') {
        const screenshot = await Promise.race([window.webContents.capturePage().catch(() => null), delay(2000).then(() => null)]);
        if (screenshot) await fsp.writeFile(path.join(directory, 'native-overwrite-confirm.png'), screenshot.toPNG());
      }
      state.mode = 'overwrite'; persist(); await click('确认覆盖云端');
      if (fixture.name === 'concurrent-409') {
        await until(async () => state.overwriteAttempts.length === 1 && (await status()).state === 'conflict' && await hasButton('使用本地覆盖云端'), 'second 409 requires a new choice');
        await delay(250); assert.equal(state.overwriteAttempts.length, 1, 'Conflict is not automatically retried');
        assert.equal(state.commits.length, 1); assert.deepEqual(canonical(readJson(file)), state.expectedLocal);
        await click('使用本地覆盖云端'); await until(() => js('Boolean(document.querySelector(".cloud-overwrite-confirm"))'), 'fresh confirmation after another conflict');
        state.mode = 'overwrite'; persist(); await click('确认覆盖云端');
        await until(() => state.overwriteAttempts.length === 2, 'second explicit overwrite');
        assert.notEqual(state.overwriteAttempts[0].requestKey, state.overwriteAttempts[1].requestKey);
        state.uiChecks.push('another cloud edit returns to conflict and needs another explicit confirmation');
      }
    } else {
      await js('window.amaneStock.cloudRetry()');
    }
    await until(() => state.commits.length === 2 && readJson(journalFile)[0].pending === null, 'same-ID overwrite acknowledged');
    // The controller schedules its periodic check after resolution. Complete that read-only
    // check through the real UI instead of waiting for the 30-second poll interval.
    if ((await status()).state !== 'synced') await click('立即同步 / 重试');
    await until(async () => (await status()).state === 'synced', 'resolved inventory is synchronized');
    const current = readJson(file), journal = readJson(journalFile)[0];
    assert.equal(current.inventoryId, id); assert.equal(journal.inventoryId, id); assert.equal(journal.pending, null); assert.equal(journal.conflict, false);
    assert.deepEqual(canonical(current), state.expectedLocal); assert.deepEqual(canonical(state.book.inventory), state.expectedLocal);
    assert.equal(state.commits.filter(commit => commit.method === 'POST').length, 1, 'No additional inventory is created');
    assert.equal(state.commits.filter(commit => commit.method === 'PUT').length, 1, 'Exactly one successful overwrite');
    assert.equal((await backups()).length, fixture.name === 'concurrent-409' ? 2 : 1);
    for (const version of Object.keys(state.cloudSnapshots)) await verifyBackup(Number(version));
    if (resuming) {
      const replay = state.requests.filter(request => request.method === 'PUT' && JSON.parse(request.body).requestKey === state.crash.requestKey);
      assert.equal(replay.length, 2); assert.equal(replay[0].body, replay[1].body); assert.equal(replay[0].body, state.crash.wire);
      state.uiChecks.push('process restart replays the exact committed request without a second logical mutation');
    }
    assert.deepEqual(state.blocked, []); assert.equal(JSON.stringify(current).includes('synthetic-overwrite-session'), false);
    const evidence = { status: 'PASS', scenario: fixture.name, phase: options.phase, appVersion: readJson(path.join(targetRoot, 'package.json')).version,
      mainSha256: hash(fs.readFileSync(path.join(targetRoot, 'out/main/index.js'))), isolatedData: directory, uiChecks: state.uiChecks,
      backups: await backups(), overwriteVersions: state.overwriteAttempts.map(attempt => attempt.version), logicalCreates: 1, logicalOverwrites: 1,
      sameInventoryId: true, localPreserved: true, csrfAndOriginVerified: true, realRequests: 0, realInventories: 0 };
    await fsp.writeFile(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2)); persist(); clearTimeout(timeout); app.exit(0);
  } catch (error) { clearTimeout(timeout); process.stderr.write(String(error.stack || error) + '\n'); app.exit(1); }
}

if (options.native) native().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); require('electron').app.exit(1); });
else driver().catch(error => { console.error(error); process.exitCode = 1; });
