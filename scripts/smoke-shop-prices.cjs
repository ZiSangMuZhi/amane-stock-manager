/* Isolated native Electron/IPC acceptance. Synthetic transport only; never uses
 * a real login, inventory, shop product or installed updater. Run with Electron:
 * electron scripts/smoke-shop-prices.cjs [packaged-resources/app]
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), target = path.resolve(process.argv[2] || root);
app.disableHardwareAcceleration();
const stamp = '2026-09-23T12:00:00.000Z', id = randomUUID(), barcode = 'SYNTHETIC-PRICE-01';
const account = {id:randomUUID(),username:'price-qa',displayName:'隔离价格验收',permissions:['inventory.manage','products.manage','pricing.manage'],mustChangePassword:false};
const item = {barcode,sortIndex:0,nickname:'合成商品',lookupName:'Synthetic item',brand:'',category:'',imageUrl:'',priceAmount:3,salePriceAmount:10,priceCurrency:'CAD',lookupSource:'none',lookupConfidence:0,quantityOnHand:5,totalIn:5,totalOut:0,firstInAt:stamp,lastInAt:stamp,lastOutAt:null,lookupStatus:'not_found',lookupUpdatedAt:stamp,createdAt:stamp,updatedAt:stamp,listed:false,shop:{imageId:null,originalCents:1200,currentCents:1000,discountBps:1667,priceSource:'current'}};
const inventory = {schemaVersion:7,inventoryId:id,inventoryName:'价格同步验收',createdAt:stamp,updatedAt:stamp,items:{[barcode]:item},transactions:[]};
let book = null, product = {id:randomUUID(),version:7,content:{name:'商店独立名称',imageId:randomUUID(),currency:'CAD',originalCents:1200,currentCents:1000,discountBps:1667,priceSource:'current'},stock:5,listed:true,sourceBookId:id,sourceBarcode:barcode,shopRegistered:true,deletedAt:null,createdAt:stamp,updatedAt:stamp,categoryId:randomUUID(),categoryName:'保留分类'};
const stockReplay = new Map(), productReplay = new Map(), writes = [], productAttempts = [], checks = [];
let losePriceResponse = false, conflictAfterStock = false, productCommits = 0;
const json = (value, status=200) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
global.fetch = async (target, options={}) => {
  const url = new URL(String(target)), method = options.method || 'GET';
  assert.equal(url.origin, 'https://api.amaneacg.space', 'all requests stay on the migrated service');
  if (url.pathname === '/api/auth/login') {
    const headers = new Headers({'content-type':'application/json'});
    headers.append('set-cookie','__Host-amane_admin_session=qa-session; Secure; Path=/; HttpOnly');
    headers.append('set-cookie','__Host-amane_admin_csrf=qa-csrf; Secure; Path=/');
    return new Response(JSON.stringify({authenticated:true,account}),{headers});
  }
  if (url.pathname === '/api/auth/session') return json({authenticated:true,account});
  if (method !== 'GET' && (options.headers.Origin !== 'https://console.amaneacg.space' || options.headers['X-CSRF-Token'] !== 'qa-csrf')) return json({error:'REQUEST_VERIFICATION_FAILED'},403);
  if (url.pathname === '/api/auth/logout') return json({ok:true});
  if (url.pathname === '/api/products') return json({items:[product]});
  if (url.pathname === `/api/products/${product.id}`) {
    if (method === 'GET') return json(product);
    assert.equal(method,'PUT'); assert.equal(options.headers['X-CSRF-Token'],'qa-csrf');
    const body = JSON.parse(options.body); productAttempts.push(options.body);
    if (productReplay.has(body.requestKey)) { const previous = productReplay.get(body.requestKey); assert.equal(previous.wire,options.body); return json(previous.value); }
    if (body.version !== product.version) return json({error:'PRODUCT_REQUEST_FAILED'},409);
    assert.equal(body.content.name,product.content.name); assert.equal(body.content.imageId,product.content.imageId);
    assert.equal(Object.hasOwn(body.content,'categoryId'),false,'price changes preserve authoritative classification');
    product = {...product,version:product.version+1,content:body.content}; productCommits++;
    productReplay.set(body.requestKey,{wire:options.body,value:structuredClone(product)});
    if (losePriceResponse) { losePriceResponse=false; throw new Error('Synthetic lost response AFTER price commit'); }
    return json(product);
  }
  if (url.pathname === '/api/stock-books' || url.pathname === `/api/stock-books/${id}`) {
    if (method === 'GET') return book ? json(book) : json({error:'STOCK_REQUEST_FAILED'},404);
    const body=JSON.parse(options.body);
    if(stockReplay.has(body.requestKey)) return json(stockReplay.get(body.requestKey));
    if(book && (method==='POST' || body.version!==book.version)) return json({error:'STOCK_REQUEST_FAILED'},409);
    if(book && body.inventory.items[barcode].quantityOnHand!==product.stock) product={...product,version:product.version+1,stock:body.inventory.items[barcode].quantityOnHand};
    book={id,version:(book?.version||0)+1,inventory:body.inventory,updatedAt:stamp,shopRegisteredBarcodes:[barcode]};
    stockReplay.set(body.requestKey,structuredClone(book)); writes.push(structuredClone(book));
    if(conflictAfterStock) { conflictAfterStock=false; product={...product,version:product.version+1,content:{...product.content,currentCents:650,discountBps:4583,priceSource:'current',name:'后台编辑后的名称'}}; }
    return json(book);
  }
  throw new Error(`Unspecified synthetic route: ${method} ${url.pathname}`);
};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label) { for(let i=0;i<140;i++){ if(await test())return; await delay(50); }throw new Error('Timed out: '+label); }
const timeout=setTimeout(()=>{process.stderr.write('NATIVE_PRICE_QA_TIMEOUT\n');app.exit(1);},55000);
(async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'amane-price-qa-'));
  app.setPath('userData',directory); app.setPath('sessionData',directory);
  const file=path.join(directory,'synthetic.json');
  await fs.writeFile(file,JSON.stringify(inventory)); await fs.writeFile(path.join(directory,'settings.json'),JSON.stringify({lastInventoryPath:file}));
  app.on('browser-window-created',(_event,window)=>{window.hide();window.on('show',()=>window.hide());});
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
  require(path.join(target,'out/main/index.js'));
  await until(()=>BrowserWindow.getAllWindows().length>0,'native window');
  const window=BrowserWindow.getAllWindows()[0], js=code=>window.webContents.executeJavaScript(code);
  await until(()=>js('Boolean(window.amaneStock && document.querySelector(".shop-editor"))').catch(()=>false),'sandboxed preload and UI');
  await js('window.amaneStock.cloudLogin("price-qa","synthetic-only")'); assert.equal(writes.length,0);
  await js('window.amaneStock.cloudConnect()'); await js('window.amaneStock.cloudRetry()');
  assert.equal((await js('window.amaneStock.cloudStatus()')).state,'synced');
  checks.push('explicit connection and migrated origin');
  losePriceResponse=true;
  await js(`window.amaneStock.updatePrice(${JSON.stringify(barcode)},3,7.25,'CAD')`);
  await js('window.amaneStock.cloudRetry()');
  const partial=await js('window.amaneStock.cloudStatus()');
  assert.notEqual(partial.state,'synced'); assert.equal(partial.pending,true);
  const pendingJournal=JSON.parse(await fs.readFile(path.join(directory,'stock-sync-journal.json'),'utf8'))[0];
  assert.ok(pendingJournal.shopPricePending.length>0,'partial result is durable');
  await js('window.amaneStock.cloudRetry()');
  assert.equal((await js('window.amaneStock.cloudStatus()')).state,'synced');
  assert.equal(product.content.currentCents,725); assert.equal(productCommits,1); assert.equal(productAttempts[0],productAttempts[1]);
  assert.equal(product.listed,true); assert.ok(product.categoryId); assert.equal(product.content.name,'商店独立名称');
  checks.push('CAD card price, response loss, exact replay, metadata preservation');
  const before=productAttempts.length;
  await js(`window.amaneStock.updatePrice(${JSON.stringify(barcode)},4,7.25,'CAD')`); await js('window.amaneStock.cloudRetry()');
  await js(`window.amaneStock.updateQuantity(${JSON.stringify(barcode)},6)`); await js('window.amaneStock.cloudRetry()');
  assert.equal(productAttempts.length,before); assert.equal(product.stock,6);
  checks.push('cost and stock changes do not overwrite storefront pricing');
  conflictAfterStock=true;
  await js(`window.amaneStock.updateShop(${JSON.stringify(barcode)},{imageId:null,originalCents:1200,currentCents:800,discountBps:3333,priceSource:'current'})`);
  await js('window.amaneStock.cloudRetry()');
  const conflict=await js('window.amaneStock.cloudStatus()'); assert.equal(conflict.shopPriceConflict,true); assert.equal(conflict.state,'error');
  assert.equal(product.content.currentCents,650);
  await js('window.amaneStock.cloudResolveShopPrices("retry-local")'); await js('window.amaneStock.cloudRetry()');
  assert.equal(product.content.currentCents,800); assert.equal(product.content.name,'后台编辑后的名称');
  assert.equal((await js('window.amaneStock.getCurrentInventory()')).inventory.items[barcode].salePriceAmount,8);
  checks.push('shop editor prices flow to CAD card; concurrent backend price requires explicit resolution');
  conflictAfterStock=true;
  await js(`window.amaneStock.updatePrice(${JSON.stringify(barcode)},4,9,'CAD')`); await js('window.amaneStock.cloudRetry()');
  assert.equal((await js('window.amaneStock.cloudStatus()')).shopPriceConflict,true);
  await js('window.amaneStock.cloudResolveShopPrices("keep-shop")'); await js('window.amaneStock.cloudRetry()');
  assert.equal(product.content.currentCents,650);
  const final=await js('window.amaneStock.getCurrentInventory()'); assert.equal(final.inventory.items[barcode].salePriceAmount,6.5);
  assert.equal(final.inventory.items[barcode].priceAmount,4); assert.equal(final.inventory.items[barcode].quantityOnHand,6);
  assert.equal((await js('window.amaneStock.cloudStatus()')).state,'synced');
  checks.push('adopt shop price without losing cost or stock');
  const output=path.join(root,'artifacts',`release-${require(path.join(root,'package.json')).version}`); await fs.mkdir(output,{recursive:true});
  const report={status:'PASS',target,checks,productCommits,productAttempts:productAttempts.length,stockCommits:writes.length,isolatedData:directory,realRequests:0,realInventories:0};
  await fs.writeFile(path.join(output,'native-shop-price-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report)); clearTimeout(timeout); window.destroy();app.exit(0);
})().catch(error=>{clearTimeout(timeout);process.stderr.write(String(error.stack||error)+'\n');app.exit(1);});
