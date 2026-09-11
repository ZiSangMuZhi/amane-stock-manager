/* Native runtime acceptance only: fresh synthetic userData, intercepted transport,
 * hidden Electron windows, and deliberate process exits at durable boundaries.
 * Usage: node scripts/smoke-cloud-recreate.cjs [--app-root <root-or-app.asar>]
 *        [--case <name>] [--electron <electron.exe>]
 * No real inventory, account, update, cloud request, or installer is used.
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
const cases = ['marked-410-get', 'marked-404-get', 'marked-410-put', 'generic-404', 'network', 'forbidden', 'unauthorized', 'crash-intent', 'crash-local', 'crash-post'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function inventoryFixture() {
  const stamp = '2026-09-11T00:00:00.000Z', barcode = '4901234567894';
  const item = { barcode, sortIndex: 0, nickname: '模拟徽章 · 保留名称', lookupName: 'Synthetic badge', brand: 'Amane', category: '合成测试', imageUrl: '', priceAmount: 4.5, salePriceAmount: 8, priceCurrency: 'CAD', lookupSource: 'none', lookupConfidence: 0, quantityOnHand: 3, totalIn: 5, totalOut: 2, firstInAt: stamp, lastInAt: stamp, lastOutAt: stamp, lookupStatus: 'not_found', lookupUpdatedAt: stamp, createdAt: stamp, updatedAt: stamp, listed: false, shop: { imageId: null, originalCents: 1200, currentCents: 960, discountBps: 2000, priceSource: 'discount' } };
  return { schemaVersion: 7, inventoryId: randomUUID(), inventoryName: '云端删除后自动恢复 · 合成库存', createdAt: stamp, updatedAt: stamp, items: { [barcode]: item }, transactions: [
    { id: randomUUID(), barcode, type: 'in', timestamp: stamp, quantityChange: 5, quantityAfter: 5, lookupNameAtTime: item.lookupName, nicknameAtTime: item.nickname },
    { id: randomUUID(), barcode, type: 'out', timestamp: stamp, quantityChange: -2, quantityAfter: 3, lookupNameAtTime: item.lookupName, nicknameAtTime: item.nickname }
  ] };
}
async function driver() {
  const selected = options.case ? [options.case] : cases;
  assert.ok(selected.every(name => cases.includes(name)), 'Unknown scenario');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'amane-recreate-qa-'));
  const output = path.join(root, 'artifacts', `native-cloud-recreate-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fsp.mkdir(output, { recursive: true });
  const electron = path.resolve(options.electron || path.join(root, 'node_modules/electron/dist/electron.exe'));
  const report = { status: 'RUNNING', targetRoot, electron, isolatedRoot: directory, output, checks: [], realRequests: 0, realInventories: 0, realEmails: 0 };
  async function child(name, phase, data) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
      const nativeProcess = spawn(electron, [__filename, '--native', '--case', name, '--phase', phase, '--directory', data, '--app-root', targetRoot], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      nativeProcess.stdout.on('data', bytes => { stdout += bytes; }); nativeProcess.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => nativeProcess.kill(), 55000);
      nativeProcess.on('error', reject);
      nativeProcess.on('close', async code => { clearTimeout(timer); await Promise.all([fsp.writeFile(path.join(output, `${name}-${phase}.stdout.log`), stdout), fsp.writeFile(path.join(output, `${name}-${phase}.stderr.log`), stderr)]); resolve({ code, stdout, stderr }); });
    });
  }
  try {
    for (const name of selected) {
      const data = path.join(directory, name); await fsp.mkdir(data);
      const inventory = inventoryFixture();
      const fixture = { name, inventory, account: { id: randomUUID(), username: 'synthetic-recreate', displayName: '隔离原生测试账号', permissions: ['content.manage', 'pricing.manage'], mustChangePassword: false } };
      await fsp.writeFile(path.join(data, 'fixture.json'), JSON.stringify(fixture));
      let result = await child(name, 'first', data);
      if (name.startsWith('crash-')) { assert.equal(result.code, 42, `${name}: expected controlled abrupt exit, got ${result.code}\n${result.stderr}`); result = await child(name, 'resume', data); }
      assert.equal(result.code, 0, `${name}: native failure\n${result.stderr}`);
      const evidence = readJson(path.join(data, 'result.json'));
      assert.equal(evidence.status, 'PASS'); report.checks.push(evidence); console.log(`PASS ${name}`);
    }
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.failure = error.stack; process.exitCode = 1; }
  await fsp.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, output, isolatedRoot: directory, failure: report.failure }, null, 2));
}
async function native() {
  const { app, BrowserWindow, session, dialog } = require('electron');
  app.disableHardwareAcceleration();
  const directory = path.resolve(options.directory), fixture = readJson(path.join(directory, 'fixture.json'));
  assert.ok(directory.startsWith(path.join(os.tmpdir(), 'amane-recreate-qa-')), 'Only owned QA directories are allowed');
  const inventoryPath = path.join(directory, 'synthetic.json'), journalPath = path.join(directory, 'stock-sync-journal.json'), statePath = path.join(directory, 'synthetic-server.json');
  const initialId = fixture.inventory.inventoryId, barcode = Object.keys(fixture.inventory.items)[0];
  const resuming = options.phase === 'resume';
  let state = resuming ? readJson(statePath) : { active: false, books: {}, responses: {}, requests: [], commits: [], blocked: [], expected: fixture.inventory, crash: null };
  const persist = () => fs.writeFileSync(statePath, JSON.stringify(state));
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  function crash(where, value) { state.crash = { where, ...value }; persist(); fs.writeFileSync(path.join(directory, 'crash-evidence.json'), JSON.stringify({ ...state.crash, journal: readJson(journalPath), inventory: readJson(inventoryPath) }, null, 2)); app.exit(42); }
  const originalRename = fsp.rename.bind(fsp);
  fsp.rename = async (from, to) => {
    await originalRename(from, to);
    if (resuming || !state.active) return;
    if (fixture.name === 'crash-intent' && same(to, journalPath)) { const journal = readJson(journalPath)[0]; if (journal?.replacement) crash('replacement-intent-durable', { nextId: journal.replacement.inventoryId }); }
    if (fixture.name === 'crash-local' && same(to, inventoryPath)) { const inventory = readJson(inventoryPath); if (inventory.inventoryId !== initialId) crash('local-id-durable', { nextId: inventory.inventoryId }); }
  };
  global.fetch = async (target, request = {}) => {
    const url = new URL(String(target)), method = request.method || 'GET';
    if (url.origin !== 'https://amane-admin-mtjbdhzwkq-uc.a.run.app') { state.blocked.push(url.origin + url.pathname); persist(); throw new Error('Synthetic test blocked external request'); }
    const route = url.pathname;
    if (route === '/api/auth/login') {
      const headers = new Headers({ 'content-type': 'application/json' }); headers.append('set-cookie', '__Host-amane_admin_session=synthetic-session; Path=/; Secure; HttpOnly'); headers.append('set-cookie', '__Host-amane_admin_csrf=synthetic-csrf; Path=/; Secure');
      return new Response(JSON.stringify({ authenticated: true, account: fixture.account }), { headers });
    }
    if (route === '/api/auth/session') return json({ authenticated: true, account: fixture.account });
    if (route === '/api/auth/logout') return json({ ok: true });
    if (!/^\/api\/stock-books(?:\/[a-f0-9-]+)?$/i.test(route)) { state.blocked.push(method + ' ' + route); persist(); throw new Error('Unspecified synthetic route'); }
    const body = request.body ? JSON.parse(request.body) : null;
    const id = body?.inventory?.inventoryId || route.split('/').at(-1);
    const entry = { method, route, id, body: request.body || null };
    state.requests.push(entry); persist();
    if (method !== 'GET') { assert.equal(request.headers['X-CSRF-Token'], 'synthetic-csrf'); assert.ok(body.requestKey); }
    if (state.active && id === initialId) {
      if (fixture.name === 'network') throw new Error('Synthetic disconnected transport');
      if (fixture.name === 'forbidden') return json({ error: 'STOCK_REQUEST_FAILED' }, 403);
      if (fixture.name === 'unauthorized') return json({ error: 'STOCK_REQUEST_FAILED' }, 401);
      if (fixture.name === 'generic-404') return json({ error: 'NOT_FOUND' }, 404);
      return json({ error: 'STOCK_REQUEST_FAILED' }, fixture.name === 'marked-404-get' ? 404 : 410);
    }
    if (method === 'GET') { if (route === '/api/stock-books') return json({ items: [] }); return state.books[id] ? json(state.books[id]) : json({ error: 'STOCK_REQUEST_FAILED' }, 404); }
    if (state.responses[body.requestKey]) { assert.equal(state.responses[body.requestKey].wire, request.body, 'Retry must keep exact serialized body'); return json(state.responses[body.requestKey].record); }
    const previous = state.books[id];
    if ((method === 'POST' && previous) || (method === 'PUT' && (!previous || body.version !== previous.version))) return json({ error: 'STOCK_REQUEST_FAILED' }, 409);
    const record = { id, inventory: body.inventory, version: (previous?.version || 0) + 1, updatedAt: new Date().toISOString() };
    state.books[id] = record; state.responses[body.requestKey] = { wire: request.body, record }; state.commits.push({ id, method, requestKey: body.requestKey }); persist();
    if (!resuming && fixture.name === 'crash-post' && id !== initialId) crash('new-post-committed-response-lost', { nextId: id, requestKey: body.requestKey, wire: request.body });
    return json(record);
  };
  app.setPath('userData', directory); app.setPath('sessionData', directory);
  if (!resuming) { await fsp.writeFile(inventoryPath, JSON.stringify(fixture.inventory)); await fsp.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ lastInventoryPath: inventoryPath })); persist(); }
  app.on('browser-window-created', (_event, window) => { window.hide(); window.on('show', () => window.hide()); });
  dialog.showErrorBox = (title, message) => { throw new Error(`Unexpected native error dialog: ${title}: ${message}`); };
  const timeout = setTimeout(() => { process.stderr.write('RECREATE_NATIVE_TIMEOUT\n'); app.exit(1); }, 45000);
  async function until(callback, description) { for (let i = 0; i < 130; i++) { if (await callback()) return; await delay(75); } throw new Error('Timed out: ' + description); }
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => { const external = /^https?:/i.test(details.url); if (external) { state.blocked.push(new URL(details.url).origin); persist(); } callback({ cancel: external }); });
    require(path.join(targetRoot, 'out/main/index.js'));
    await until(() => BrowserWindow.getAllWindows().length > 0, 'native window');
    const updater = require(path.join(targetRoot, 'node_modules/velopack'));
    assert.equal(typeof updater.UpdateManager, 'function'); assert.equal(typeof updater.VelopackApp.build, 'function');
    const updaterNative = Object.keys(require.cache).filter(file => file.toLowerCase().startsWith(targetRoot.toLowerCase() + path.sep) && /velopack[^/\\]*\.node$/i.test(file));
    assert.equal(updaterNative.length, 1, 'The target application must load its own native Velopack module');
    const window = BrowserWindow.getAllWindows()[0], js = code => window.webContents.executeJavaScript(code); window.hide();
    await until(() => js('Boolean(window.amaneStock && document.querySelector(".shop-editor"))').catch(() => false), 'renderer and trusted preload');
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true); assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true); assert.equal(await js('typeof window.require'), 'undefined');
    if (!(await js('window.amaneStock.cloudStatus()')).account) {
      await js('document.querySelector(".cloud-summary button").click()');
      await until(() => js('Boolean(document.querySelector(".cloud-controls input[autocomplete=username]"))'), 'login form');
      await js(`(() => { const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; const inputs=document.querySelectorAll('.cloud-controls input'); set.call(inputs[0],'synthetic-recreate');inputs[0].dispatchEvent(new Event('input',{bubbles:true}));set.call(inputs[1],'synthetic-test-only');inputs[1].dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await delay(80); await js('document.querySelector(".cloud-controls form button").click()');
      await until(async () => Boolean((await js('window.amaneStock.cloudStatus()')).account), 'synthetic login');
    }
    if (!resuming) {
      assert.equal(state.requests.filter(r => r.method !== 'GET').length, 0, 'Login alone must not authorize upload');
      await js('window.amaneStock.cloudConnect()'); await until(async () => (await js('window.amaneStock.cloudStatus()')).state === 'synced', 'initial authorized synchronization');
      assert.equal(state.commits.filter(r => r.method === 'POST').length, 1);
      state.active = true; delete state.books[initialId];
      if (fixture.name === 'marked-410-put') { await js(`window.amaneStock.updateQuantity(${JSON.stringify(barcode)}, 7)`); }
      state.expected = (await js('window.amaneStock.getCurrentInventory()')).inventory; persist();
      await js('window.amaneStock.cloudRetry()');
    } else {
      await js('window.amaneStock.cloudRetry()');
    }
    const negative = ['generic-404', 'network', 'forbidden', 'unauthorized'].includes(fixture.name);
    if (negative) {
      const status = await js('window.amaneStock.cloudStatus()');
      assert.equal(status.state, fixture.name === 'network' ? 'offline' : fixture.name === 'unauthorized' ? 'expired' : 'error');
      assert.equal(readJson(inventoryPath).inventoryId, initialId);
      const journal = readJson(journalPath); assert.equal(journal.length, 1); assert.equal(journal[0].inventoryId, initialId); assert.equal(journal[0].replacement, undefined);
      assert.equal(state.commits.filter(r => r.method === 'POST').length, 1); assert.equal((await fsp.readdir(directory)).filter(name => name.startsWith('synthetic.json.backup-')).length, 0);
    } else {
      await until(async () => (await js('window.amaneStock.cloudStatus()')).state === 'synced', 'automatic recreation and synchronization');
      const current = readJson(inventoryPath), newId = current.inventoryId;
      assert.notEqual(newId, initialId); assert.equal(current.inventoryName, state.expected.inventoryName); assert.deepEqual(current.items, state.expected.items); assert.deepEqual(current.transactions, state.expected.transactions);
      const freshCreates = state.commits.filter(r => r.method === 'POST' && r.id !== initialId); assert.equal(freshCreates.length, 1, 'Exactly one logical replacement inventory'); assert.equal(freshCreates[0].id, newId);
      const backups = (await fsp.readdir(directory)).filter(name => name.startsWith('synthetic.json.backup-') && name.endsWith('.json'));
      assert.equal(backups.length, 1, 'One immutable local backup'); const backup = readJson(path.join(directory, backups[0])); assert.deepEqual(backup, state.expected);
      const journal = readJson(journalPath); assert.equal(journal.length, 1); assert.equal(journal[0].inventoryId, newId); assert.equal(journal[0].pending, null); assert.equal(journal[0].replacement, undefined);
      if (resuming) { assert.equal(newId, state.crash.nextId); if (fixture.name === 'crash-post') { const attempts = state.requests.filter(r => r.id === newId && r.method === 'POST'); assert.equal(attempts.length, 2); assert.equal(attempts[0].body, attempts[1].body); assert.equal(JSON.parse(attempts[1].body).requestKey, state.crash.requestKey); } }
      await js(`window.amaneStock.updateQuantity(${JSON.stringify(barcode)}, 11)`); await js('window.amaneStock.cloudRetry()');
      await until(() => state.books[newId]?.inventory.items[barcode].quantityOnHand === 11, 'continued PUT synchronization');
      const final = readJson(inventoryPath); assert.equal(final.inventoryId, newId); assert.deepEqual(final.transactions, state.expected.transactions); assert.equal(state.commits.filter(r => r.method === 'POST' && r.id !== initialId).length, 1); assert.ok(state.commits.some(r => r.method === 'PUT' && r.id === newId));
    }
    assert.deepEqual(state.blocked, []); assert.equal(JSON.stringify(readJson(inventoryPath)).includes('synthetic-session'), false);
    let screenshot = null, captureError = null;
    if (fixture.name === 'marked-410-get') { try { const png = await Promise.race([window.webContents.capturePage(), delay(2000).then(() => { throw new Error('Hidden capture unavailable'); })]); screenshot = path.join(directory, 'native-recreated.png'); await fsp.writeFile(screenshot, png.toPNG()); } catch (error) { captureError = error.message; } }
    const evidence = { status: 'PASS', name: fixture.name, phase: options.phase, appVersion: JSON.parse(fs.readFileSync(path.join(targetRoot, 'package.json'), 'utf8')).version, mainSha256: hash(fs.readFileSync(path.join(targetRoot, 'out/main/index.js'))), updaterNative, sandbox: true, contextIsolation: true, isolatedData: directory, requests: state.requests.length, logicalCreates: state.commits.filter(r => r.method === 'POST').length, crash: state.crash, screenshot, captureError, blocked: state.blocked, realRequests: 0 };
    await fsp.writeFile(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
    clearTimeout(timeout); app.exit(0);
  } catch (error) { clearTimeout(timeout); process.stderr.write(String(error.stack || error) + '\n'); app.exit(1); }
}
if (options.native) native().catch(error => { process.stderr.write(error.stack + '\n'); require('electron').app.exit(1); });
else driver().catch(error => { console.error(error); process.exitCode = 1; });
