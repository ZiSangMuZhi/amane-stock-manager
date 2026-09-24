/* Native Electron/preload/IPC acceptance with a strict synthetic server and isolated userData.
 * node scripts/smoke-shop-operations.cjs [--app-root <candidate>] [--case <name>]
 * No production requests, accounts, inventory files, updater runs or installations.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), options = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--native') options.native = true;
  else if (['--app-root', '--case', '--directory', '--phase'].includes(process.argv[i]) && process.argv[i + 1]) options[process.argv[i].slice(2)] = process.argv[++i];
  else throw new Error('Unknown argument');
}
const targetRoot = path.resolve(options['app-root'] || root);
const cases = ['batch-image', 'restart-replay', 'concurrent-edit', 'old-server', 'conflict-409'];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KAAAAABJRU5ErkJggg==';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const stamp = '2026-09-24T12:00:00.000Z', inventoryId = randomUUID();
  const items = Object.fromEntries(['QA-01', 'QA-02'].map((barcode, sortIndex) => [barcode, {
    barcode, sortIndex, nickname: `Synthetic ${barcode}`, lookupName: '', brand: '', category: '', imageUrl: '', priceAmount: 3,
    salePriceAmount: 10, priceCurrency: 'CAD', lookupSource: 'none', lookupConfidence: 0, quantityOnHand: 5, totalIn: 5, totalOut: 0,
    firstInAt: stamp, lastInAt: stamp, lastOutAt: null, lookupStatus: 'not_found', lookupUpdatedAt: stamp, createdAt: stamp, updatedAt: stamp,
    listed: false, shop: { imageId: null, originalCents: 1200, currentCents: 1000, discountBps: 1667, priceSource: 'current' }
  }]));
  return { inventory: { schemaVersion: 7, inventoryId, inventoryName: '隔离商店操作验收', createdAt: stamp, updatedAt: stamp, items, transactions: [] },
    imageId: randomUUID(), account: { id: randomUUID(), username: 'operations-qa', displayName: '隔离验收', mustChangePassword: false,
      permissions: ['inventory.manage', 'products.manage'] } };
}
async function driver() {
  const selected = options.case ? [options.case] : cases; assert.ok(selected.every(name => cases.includes(name)));
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'amane-operations-qa-'));
  const output = path.join(root, 'artifacts', 'release-0.2.4'); await fsp.mkdir(output, { recursive: true });
  const sourceHashes = Object.fromEntries(['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'].map(file => [file, sha(fs.readFileSync(path.join(targetRoot, file)))]));
  const report = { status: 'RUNNING', targetRoot, sourceHashes, isolatedRoot: directory, realRequests: 0, realInventories: 0, checks: [] };
  async function child(name, phase, data) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
      const native = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [__filename, '--native', '--case', name,
        '--phase', phase, '--directory', data, '--app-root', targetRoot], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      native.stdout.on('data', bytes => { stdout += bytes; }); native.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => native.kill(), 50000); native.on('error', reject);
      native.on('close', async code => { clearTimeout(timer); await Promise.all([
        fsp.writeFile(path.join(output, `native-shop-operations-${name}-${phase}.stdout.log`), stdout),
        fsp.writeFile(path.join(output, `native-shop-operations-${name}-${phase}.stderr.log`), stderr)
      ]); resolve({ code, stderr }); });
    });
  }
  try {
    for (const name of selected) {
      const data = path.join(directory, name); await fsp.mkdir(data); await fsp.writeFile(path.join(data, 'fixture.json'), JSON.stringify(fixture()));
      let result = await child(name, 'first', data);
      if (name === 'restart-replay') { assert.equal(result.code, 42, result.stderr); result = await child(name, 'resume', data); }
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      const proof = read(path.join(data, 'proof.json')); assert.equal(proof.status, 'PASS'); report.checks.push(proof); console.log(`PASS ${name}`);
    }
    for (const [file, hash] of Object.entries(sourceHashes)) assert.equal(sha(fs.readFileSync(path.join(targetRoot, file))), hash, 'candidate changed during QA');
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.failure = String(error.stack || error); process.exitCode = 1; }
  await fsp.writeFile(path.join(output, 'native-shop-operations-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.checks.length, output, failure: report.failure }));
}
async function native() {
  const { app, BrowserWindow, session, dialog } = require('electron'); app.disableHardwareAcceleration();
  const directory = path.resolve(options.directory);
  assert.ok(directory.startsWith(path.join(os.tmpdir(), 'amane-operations-qa-')));
  const data = read(path.join(directory, 'fixture.json')), id = data.inventory.inventoryId, resume = options.phase === 'resume';
  const inventoryPath = path.join(directory, 'synthetic.json'), journalPath = path.join(directory, 'stock-sync-journal.json'), serverPath = path.join(directory, 'server.json');
  const state = resume ? read(serverPath) : { book: null, products: {}, replay: {}, requests: [], stockCommits: [], operationCommits: [], blocked: [] };
  const save = () => fs.writeFileSync(serverPath, JSON.stringify(state));
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  let js, mutateDuringOperation = false, rejectOperation = false;
  const addCapabilities = record => ({ ...record, ...(options.case === 'old-server' ? {} : { shopOperationsSupported: true }), shopRegisteredBarcodes: Object.keys(state.products) });
  const currentBook = () => addCapabilities(structuredClone(state.book));
  const assertDurable = body => {
    const journals = read(journalPath), pending = journals.find(j => j.inventoryId === id && j.accountId === data.account.id)?.shopOperationPending;
    assert.equal(pending?.body, body, 'exact operation bytes must already be durable');
    assert.equal(pending.requestKey, JSON.parse(body).requestKey);
  };
  global.fetch = async (target, request = {}) => {
    const url = new URL(String(target)), route = url.pathname, method = request.method || 'GET';
    assert.equal(url.origin, 'https://api.amaneacg.space', 'main-process transport never leaves fixed API origin');
    assert.equal(request.redirect, 'error'); assert.equal(request.headers.Origin, 'https://console.amaneacg.space');
    if (route === '/api/auth/login') {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', '__Host-amane_admin_session=synthetic-session; Secure; HttpOnly; Path=/');
      headers.append('set-cookie', '__Host-amane_admin_csrf=synthetic-csrf; Secure; Path=/');
      return new Response(JSON.stringify({ authenticated: true, account: data.account }), { headers });
    }
    if (route === '/api/auth/session') return json({ authenticated: true, account: data.account });
    assert.match(request.headers.Cookie, /__Host-amane_admin_session=synthetic-session/);
    if (method !== 'GET') assert.equal(request.headers['X-CSRF-Token'], 'synthetic-csrf');
    if (route === '/api/auth/logout') return json({ ok: true });
    state.requests.push({ route, method, body: request.body || null }); save();
    if (route === '/api/products' && method === 'GET') return json({ items: Object.values(state.products) });
    if (/^\/api\/products\/[a-f0-9-]+$/.test(route) && method === 'GET') {
      const product = Object.values(state.products).find(p => p.id === route.split('/').at(-1)); assert.ok(product); return json(product);
    }
    if (route === '/api/products/media' && method === 'POST') {
      const payload = JSON.parse(request.body); assert.equal(payload.base64, png); assert.deepEqual(payload.crop, { x: 0, y: 0, width: 1, height: 1 });
      return json({ id: data.imageId });
    }
    if (route === `/api/products/media/${data.imageId}` && method === 'GET') return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
    if (route === `/api/stock-books/${id}/operations`) {
      assert.equal(method, 'POST'); assert.notEqual(options.case, 'old-server'); assertDurable(request.body);
      const body = JSON.parse(request.body); assert.deepEqual(Object.keys(body).sort(), ['operation', 'requestKey', 'version']);
      const previous = state.replay[body.requestKey];
      if (previous) { assert.equal(previous.wire, request.body, 'restart must keep exact bytes and request key'); return json(previous.record); }
      if (rejectOperation || body.version !== state.book.version) return json({ error: 'STOCK_REQUEST_FAILED' }, 409);
      const operation = body.operation, barcodes = operation.type === 'shop-image' ? [operation.barcode] : operation.barcodes;
      assert.ok(barcodes.length && barcodes.length <= 200); assert.equal(new Set(barcodes).size, barcodes.length);
      for (const barcode of barcodes) {
        const item = state.book.inventory.items[barcode]; assert.ok(item);
        if (!state.products[barcode]) state.products[barcode] = { id: randomUUID(), version: 1, sourceBookId: id, sourceBarcode: barcode,
          shopRegistered: true, deletedAt: null, stock: item.quantityOnHand, listed: item.listed,
          content: { name: item.nickname, currency: 'CAD', ...item.shop } };
        const product = state.products[barcode];
        if (operation.type === 'shop-image') { item.shop.imageId = operation.imageId; product.content.imageId = operation.imageId; }
        else { assert.equal(operation.type, 'shop-listing-batch'); assert.equal(typeof operation.listed, 'boolean'); item.listed = product.listed = operation.listed; }
        product.version++;
      }
      state.book.version++; const record = currentBook();
      state.replay[body.requestKey] = { wire: request.body, record }; state.operationCommits.push({ type: operation.type, requestKey: body.requestKey }); save();
      if (options.case === 'restart-replay' && !resume) {
        fs.writeFileSync(path.join(directory, 'crash.json'), JSON.stringify({ pending: read(journalPath)[0].shopOperationPending, record }));
        app.exit(42); return new Promise(() => {});
      }
      if (mutateDuringOperation) { mutateDuringOperation = false; await js('window.amaneStock.updateNickname("QA-01", "Edited while operation response was pending")'); }
      return json(record);
    }
    assert.ok(route === '/api/stock-books' || route === `/api/stock-books/${id}`, `Unspecified synthetic route: ${method} ${route}`);
    if (method === 'GET') return route === '/api/stock-books' ? json({ items: [] }) : state.book ? json(currentBook()) : json({ error: 'STOCK_REQUEST_FAILED' }, 404);
    const body = JSON.parse(request.body); assert.equal(body.inventory.inventoryId, id);
    if (state.replay[body.requestKey]) { assert.equal(state.replay[body.requestKey].wire, request.body); return json(state.replay[body.requestKey].record); }
    assert.ok(method === 'POST' || method === 'PUT');
    if (state.book && (method === 'POST' || body.version !== state.book.version)) return json({ error: 'STOCK_REQUEST_FAILED' }, 409);
    const inventory = structuredClone(body.inventory);
    // The real service preserves registered catalog metadata on ordinary stock PUT.
    for (const [barcode, product] of Object.entries(state.products)) if (inventory.items[barcode]) {
      inventory.items[barcode].listed = product.listed; inventory.items[barcode].shop.imageId = product.content.imageId;
      product.stock = inventory.items[barcode].quantityOnHand;
    }
    state.book = { id, inventory, version: (state.book?.version || 0) + 1, updatedAt: inventory.updatedAt };
    const record = currentBook(); state.replay[body.requestKey] = { wire: request.body, record }; state.stockCommits.push({ id, method }); save(); return json(record);
  };
  app.setPath('userData', directory); app.setPath('sessionData', directory);
  if (!resume) { await fsp.writeFile(inventoryPath, JSON.stringify(data.inventory)); await fsp.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ lastInventoryPath: inventoryPath })); save(); }
  app.on('browser-window-created', (_event, window) => { window.hide(); window.on('show', () => window.hide()); });
  dialog.showErrorBox = (title, message) => { throw new Error(`Unexpected dialog: ${title}: ${message}`); };
  const timeout = setTimeout(() => { process.stderr.write('SHOP_OPERATIONS_NATIVE_TIMEOUT\n'); app.exit(1); }, 45000);
  async function until(test, label) { for (let i = 0; i < 140; i++) { if (await test()) return; await delay(50); } throw new Error(`Timed out: ${label}`); }
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => { const blocked = /^https?:/i.test(details.url); if (blocked) { state.blocked.push(new URL(details.url).origin); save(); } callback({ cancel: blocked }); });
    require(path.join(targetRoot, 'out/main/index.js'));
    await until(() => BrowserWindow.getAllWindows().length > 0, 'window'); const window = BrowserWindow.getAllWindows()[0];
    js = code => window.webContents.executeJavaScript(code);
    await until(() => js('Boolean(window.amaneStock?.cloudShopOperation && document.querySelector(".shop-editor"))').catch(() => false), 'renderer/preload');
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true); assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true);
    assert.equal(await js('typeof window.require'), 'undefined');
    if (!(await js('window.amaneStock.cloudStatus()')).account) await js('window.amaneStock.cloudLogin("operations-qa", "synthetic-only")');
    if (!resume) { assert.equal(state.stockCommits.length, 0); await js('window.amaneStock.cloudConnect()'); }
    await js('window.amaneStock.cloudRetry()');
    const listing = { type: 'shop-listing-batch', barcodes: ['QA-01', 'QA-02'], listed: true };
    if (!resume) {
      if (options.case === 'old-server') {
        await assert.rejects(js(`window.amaneStock.cloudShopOperation(${JSON.stringify(listing)})`), /升级 Mac 服务端/);
        assert.equal(state.requests.filter(r => r.route.endsWith('/operations')).length, 0);
      } else if (options.case === 'conflict-409') {
        rejectOperation = true;
        await assert.rejects(js(`window.amaneStock.cloudShopOperation(${JSON.stringify(listing)})`), /云端商品已更新/);
        assert.equal((await js('window.amaneStock.cloudStatus()')).shopOperationPending, false);
        assert.equal(read(journalPath)[0].conflict, false); assert.equal(state.operationCommits.length, 0);
      } else {
        mutateDuringOperation = options.case === 'concurrent-edit';
        await js(`window.amaneStock.cloudShopOperation(${JSON.stringify(listing)})`);
        assert.equal(state.operationCommits.length, 1);
        if (options.case === 'batch-image') {
          const uploaded = await js(`window.amaneStock.uploadShopImageAsset("data:image/png;base64,${png}", {x:0,y:0,width:1,height:1})`); assert.equal(uploaded, data.imageId);
          const image = { type: 'shop-image', barcode: 'QA-01', imageId: uploaded };
          await js(`window.amaneStock.cloudShopOperation(${JSON.stringify(image)})`);
          assert.equal((await js('window.amaneStock.getCurrentInventory()')).inventory.items['QA-01'].shop.imageId, uploaded);
          assert.equal(state.products['QA-01'].content.imageId, uploaded);
          await js('window.amaneStock.cloudShopOperation({type:"shop-image",barcode:"QA-01",imageId:null})');
          assert.equal(state.products['QA-01'].content.imageId, null);
        }
      }
    }
    const current = await js('window.amaneStock.getCurrentInventory()'), journal = read(journalPath)[0];
    assert.equal(current.inventory.inventoryId, id); assert.equal(state.stockCommits.filter(r => r.method === 'POST').length, 1, 'no operation may recreate the book');
    assert.equal(journal.shopOperationPending, undefined); assert.equal(journal.pending, null);
    if (!['old-server', 'conflict-409'].includes(options.case)) {
      for (const barcode of listing.barcodes) { assert.equal(current.inventory.items[barcode].listed, true); assert.equal(state.products[barcode].listed, true); }
      assert.deepEqual(new Set((await js('window.amaneStock.cloudStatus()')).registeredBarcodes), new Set(listing.barcodes));
    } else for (const barcode of listing.barcodes) assert.equal(current.inventory.items[barcode].listed, false);
    if (options.case === 'concurrent-edit') { assert.equal(current.inventory.items['QA-01'].nickname, 'Edited while operation response was pending'); assert.equal(state.book.inventory.items['QA-01'].nickname, current.inventory.items['QA-01'].nickname); }
    const operationAttempts = state.requests.filter(r => r.route.endsWith('/operations'));
    if (resume) {
      const crash = read(path.join(directory, 'crash.json')); assert.equal(state.operationCommits.length, 1);
      assert.equal(operationAttempts.length, 2); assert.equal(operationAttempts[0].body, crash.pending.body); assert.equal(operationAttempts[1].body, crash.pending.body);
    }
    assert.equal(JSON.stringify(current.inventory).includes('synthetic-session'), false);
    const proof = { status: 'PASS', case: options.case, sandbox: true, trustedPreloadIpc: true, sameBookId: id, originalStockPosts: 1,
      operationCommits: state.operationCommits.length, operationAttempts: operationAttempts.length, exactRequestHashes: operationAttempts.map(r => sha(r.body)),
      registeredItems: Object.keys(state.products).length, concurrentEditPreserved: options.case === 'concurrent-edit', restartReplay: resume,
      externalNetworkBlocked: true, realRequests: 0 };
    await fsp.writeFile(path.join(directory, 'proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
    clearTimeout(timeout); window.destroy(); app.exit(0);
  } catch (error) { clearTimeout(timeout); process.stderr.write(String(error.stack || error) + '\n'); app.exit(1); }
}
if (options.native) native(); else driver().catch(error => { console.error(error); process.exitCode = 1; });
