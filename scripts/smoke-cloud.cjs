/* Hidden native smoke: synthetic data, intercepted fetch, isolated userData; never touches real inventories. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();

let directory;
const requests = [];
const books = new Map();
const responses = new Map();
const account = { id: randomUUID(), username: 'synthetic-smoke', displayName: '本地模拟账号', permissions: ['content.manage', 'pricing.manage'], mustChangePassword: false };
const stamp = new Date().toISOString();
const inventoryId = randomUUID();
const item = { barcode:'4901234567894', sortIndex:0, nickname:'测试商品 · 春日徽章', lookupName:'Synthetic product', brand:'Amane', category:'测试', imageUrl:'', priceAmount:4.5,salePriceAmount:8,priceCurrency:'CAD',lookupSource:'none',lookupConfidence:0,quantityOnHand:3,totalIn:5,totalOut:2,firstInAt:stamp,lastInAt:stamp,lastOutAt:stamp,lookupStatus:'not_found',lookupUpdatedAt:stamp,createdAt:stamp,updatedAt:stamp,listed:false,shop:{imageId:null,originalCents:1200,currentCents:960,discountBps:2000,priceSource:'discount'} };
const inventory = { schemaVersion:7, inventoryId,inventoryName:'仅用于原生验收的模拟库存',createdAt:stamp,updatedAt:stamp,items:{[item.barcode]:item},transactions:[] };

function json(value, status=200, headers={}) { return new Response(JSON.stringify(value), {status,headers:{'content-type':'application/json',...headers}}); }
global.fetch = async (target, options={}) => {
  const url = new URL(String(target));
  requests.push({path:url.pathname,method:options.method||'GET'});
  if (url.origin !== 'https://amane-admin-mtjbdhzwkq-uc.a.run.app') return json({error:'SYNTHETIC_NETWORK_DISABLED'},404);
  const route = url.pathname;
  if (route === '/api/auth/login') {
    const headers = new Headers();
    headers.append('set-cookie','__Host-amane_admin_session=synthetic-session; Path=/; Secure; HttpOnly');
    headers.append('set-cookie','__Host-amane_admin_csrf=synthetic-csrf; Path=/; Secure');
    return new Response(JSON.stringify({authenticated:true,account}),{headers});
  }
  if (route === '/api/auth/logout') return json({ok:true});
  if (route === '/api/auth/session') return json({authenticated:true,account});
  if (route === '/api/stock-books' && (!options.method || options.method === 'GET')) return json({items:[...books.values()].map(r=>({id:r.id,name:r.inventory.inventoryName,version:r.version,itemCount:1,quantityOnHand:3,updatedAt:stamp}))});
  if (route.startsWith('/api/stock-books')) {
    if (options.body) {
      const body = JSON.parse(options.body);
      if (responses.has(body.requestKey)) return json(responses.get(body.requestKey));
      const previous = books.get(body.inventory.inventoryId);
      if (previous && (options.method === 'POST' || body.version !== previous.version)) return json({error:'VERSION_CONFLICT'},409);
      const record = {id:body.inventory.inventoryId,version:(previous?.version||0)+1,inventory:body.inventory,updatedAt:new Date().toISOString()};
      books.set(record.id,record);responses.set(body.requestKey,record);return json(record);
    }
    return books.has(route.split('/').at(-1)) ? json(books.get(route.split('/').at(-1))) : json({error:'NOT_FOUND'},404);
  }
  return json({error:'SYNTHETIC_NETWORK_DISABLED'},404);
};

function delay(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
async function until(callback,message) { for(let i=0;i<100;i++){ if(await callback())return;await delay(100); }throw new Error(`Timed out: ${message}`); }
let timeout = setTimeout(()=>{process.stderr.write('NATIVE_SMOKE_TIMEOUT\n');app.exit(1);},45000);

(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(),'amane-native-smoke-'));
  app.setPath('userData',directory);
  const inventoryPath=path.join(directory,'synthetic.json');
  await fs.writeFile(inventoryPath,JSON.stringify(inventory));
  await fs.writeFile(path.join(directory,'settings.json'),JSON.stringify({lastInventoryPath:inventoryPath}));
  app.on('browser-window-created',(_event,window)=>window.hide());
  await app.whenReady();
  require('../out/main/index.js');
  await until(()=>BrowserWindow.getAllWindows().length>0,'window creation');
  const window=BrowserWindow.getAllWindows()[0];window.hide();
  await until(()=>window.webContents.executeJavaScript('Boolean(window.amaneStock && document.querySelector(".shop-editor"))').catch(()=>false),'sandboxed bridge and renderer');
  const js=script=>window.webContents.executeJavaScript(script);
  assert.equal(window.webContents.getLastWebPreferences().sandbox,true);
  assert.equal(window.webContents.getLastWebPreferences().contextIsolation,true);
  assert.equal(await js('typeof window.require'),'undefined');
  assert.equal((await js('window.amaneStock.getCurrentInventory()')).inventory.inventoryId,inventoryId);
  await js('document.querySelector(".cloud-summary button").click()');
  await until(()=>js('Boolean(document.querySelector(".cloud-controls input[autocomplete=username]"))'),'login controls');
  await js(`(() => { const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; const inputs=document.querySelectorAll('.cloud-controls input'); set.call(inputs[0],'synthetic-smoke');inputs[0].dispatchEvent(new Event('input',{bubbles:true}));set.call(inputs[1],'synthetic-test-only');inputs[1].dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await delay(100);
  await js('document.querySelector(".cloud-controls form button").click()');
  await until(async()=>Boolean((await js('window.amaneStock.cloudStatus()')).account),'login through UI and native IPC');
  assert.equal(requests.filter(r=>r.path.startsWith('/api/stock-books')&&r.method!=='GET').length,0,'login must not upload');
  await js(`Array.from(document.querySelectorAll('.cloud-book-actions button')).find(b=>b.textContent.includes('连接并上传当前')).click()`);
  await until(async()=>(await js('window.amaneStock.cloudStatus()')).state==='synced','explicit connect and sync');
  await js('document.querySelector(".shop-listing input").click()');
  await until(()=>Boolean(books.get(inventoryId)?.inventory.items[item.barcode].listed),'listing auto sync');
  await js('document.querySelector(".shop-editor details").open=true');
  await js(`Array.from(document.querySelectorAll('.cloud-book-actions button')).find(b=>b.textContent.includes('读取云端')).click()`);
  await until(()=>js('document.querySelectorAll(".cloud-book-actions select option").length===2'),'cloud inventory list UI');
  const output=path.resolve(__dirname,'../artifacts/native-cloud-smoke.png');
  await fs.mkdir(path.dirname(output),{recursive:true});
  let screenshot=output,captureError=null;
  try { const capture=await Promise.race([window.webContents.capturePage(),delay(2000).then(()=>{throw new Error('Hidden display capture unavailable within 2 seconds');})]); await fs.writeFile(output,capture.toPNG()); }
  catch(error) { screenshot=null;captureError=String(error.message||error); }
  // A separate native BrowserWindow with the same sandboxed preload must not invoke trusted IPC.
  const rogue=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../out/preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await rogue.loadFile(path.resolve(__dirname,'../out/renderer/index.html'));
  const denied=await rogue.webContents.executeJavaScript('window.amaneStock.getCurrentInventory().then(()=>false,()=>true)');
  assert.equal(denied,true);rogue.destroy();
  const persisted=JSON.parse(await fs.readFile(inventoryPath,'utf8'));
  assert.equal(persisted.items[item.barcode].listed,true);
  assert.equal(JSON.stringify(persisted).includes('synthetic-session'),false);
  await js('window.amaneStock.cloudLogout()');
  assert.equal((await js('window.amaneStock.cloudStatus()')).account,null);
  const journal=JSON.parse(await fs.readFile(path.join(directory,'stock-sync-journal.json'),'utf8'));
  assert.equal(journal[0].pending,null);
  process.stdout.write(JSON.stringify({result:'NATIVE_SMOKE_PASSED',sandbox:true,bridge:true,uiLogin:true,loginUploadCount:0,explicitSync:true,listingAutosync:true,bookSelector:true,forgedWindowIpcDenied:true,screenshot,captureError,requests:requests.length,isolatedData:directory})+'\n');
  clearTimeout(timeout);window.destroy();
  // Electron may hold cache handles until exit; userData is intentionally retained as an isolated QA artifact.
  app.exit(0);
})().catch(error=>{clearTimeout(timeout);process.stderr.write(String(error.stack||error)+'\n');app.exit(1);});
