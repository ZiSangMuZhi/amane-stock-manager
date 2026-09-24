// Real renderer, synthetic Electron IPC. No inventory file, cloud, or external network writes.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const root=process.cwd(),output=path.resolve('test-results/shop-connectivity-ui'),sha=b=>createHash('sha256').update(b).digest('hex');
const sources=['src/renderer/ShopEditor.tsx','src/renderer/shopPriceDraft.ts','src/renderer/cardPriceDraft.ts','src/renderer/main.tsx','src/renderer/cloud.css'];
const sourceFiles=await Promise.all(sources.map(async name=>({path:name,sha256:sha(await readFile(name))})));
const report={passed:false,syntheticIpc:true,realWrites:0,remoteWrites:0,sourceFiles,sourceUnchanged:false,checks:[],errors:[],blocked:[],screenshots:[]};await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:path.resolve('src/renderer'),plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}});await server.listen();const origin=server.resolvedUrls.local[0];
// Use an installed Playwright package, or an explicitly supplied test runtime.
const runtime=await import(process.env.AMANE_PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.AMANE_PLAYWRIGHT_MODULE)).href : 'playwright');
const browser=await(runtime.default||runtime).chromium.launch({channel:process.env.AMANE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),headless:true}),context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage();
const check=name=>{report.checks.push({name,passed:true});console.log('PASS '+name);};
page.on('pageerror',e=>report.errors.push(e.message));await context.route('**/*',route=>{const r=route.request();if(new URL(r.url()).origin!==new URL(origin).origin||!['GET','HEAD'].includes(r.method())){report.blocked.push(r.method()+' '+r.url());return route.abort();}return route.continue();});
await context.addInitScript(()=>{
 const stamp='2026-09-23T12:00:00Z',image='12345678-1234-4234-8234-123456789012';
 const item={barcode:'123',createdAt:stamp,updatedAt:stamp,nickname:'晴空徽章',lookupName:'相遇纪念',brand:'',category:'',imageUrl:'',sortIndex:0,listed:false,shop:{imageId:image,originalCents:2000,currentCents:1500,discountBps:2500,priceSource:'current'},priceAmount:4,salePriceAmount:15,priceCurrency:'CAD',lookupSource:'none',lookupConfidence:0,quantityOnHand:10,totalIn:10,totalOut:0,firstInAt:stamp,lastInAt:stamp,lastOutAt:null,lookupStatus:'idle',lookupUpdatedAt:null};
 const initial={filePath:'C:/synthetic/first.json',fileName:'first.json',inventory:{schemaVersion:7,inventoryId:'first',inventoryName:'合成价格验收',createdAt:stamp,updatedAt:stamp,items:{'123':item},transactions:[]}};
 const listeners=new Set(),cloudListeners=new Set(),clone=structuredClone;
 window.qa={document:clone(initial),calls:[],fail:false,defer:false,pending:null,applyCount:0,cloud:{state:'synced',message:'合成云状态',inventoryId:'first',registeredBarcodes:[],shopOperationsSupported:true,account:{id:'synthetic',username:'stock-qa',displayName:'库存验收',permissions:['inventory.manage','products.manage','pricing.manage']},secureStorage:true,connected:true,pending:false,lastSuccess:null},emit(patch){Object.assign(this.document.inventory.items['123'],patch);for(const f of listeners)f(clone(this.document));},cloudEmit(patch){Object.assign(this.cloud,patch);for(const f of cloudListeners)f(clone(this.cloud));},switchFile(){this.document=clone(initial);this.document.filePath='C:/synthetic/second.json';this.document.fileName='second.json';this.document.inventory.inventoryId='second';for(const f of listeners)f(clone(this.document));this.cloudEmit({inventoryId:'second',registeredBarcodes:[]});}};
 const qa=window.qa,save=async value=>{if(qa.fail)throw Error('合成磁盘保存失败');if(qa.defer)return new Promise(resolve=>{qa.pending=()=>resolve(clone(value));});qa.document=clone(value);return clone(value);};
 window.amaneStock={getCurrentInventory:async()=>clone(qa.document),getVersion:async()=>'QA',onInventoryChanged:f=>(listeners.add(f),()=>listeners.delete(f)),cloudStatus:async()=>clone(qa.cloud),onCloudStatus:f=>(cloudListeners.add(f),()=>cloudListeners.delete(f)),getShopImage:async()=> 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',chooseShopImage:async()=>({dataUrl:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',width:1,height:1}),
  updateShop:async(barcode,shop)=>{qa.calls.push({kind:'shop',barcode,shop:clone(shop)});const next=clone(qa.document),item=next.inventory.items[barcode];item.shop=clone(shop);if(item.priceCurrency==='CAD')item.salePriceAmount=shop.currentCents/100;return save(next);},
  updateListing:async(barcode,listed)=>{qa.calls.push({kind:'listing',barcode,listed});const next=clone(qa.document);next.inventory.items[barcode].listed=listed;return save(next);},
  uploadShopImage:async(barcode,dataUrl,crop)=>{qa.calls.push({kind:'image',barcode,dataUrl,crop});const next=clone(qa.document);next.inventory.items[barcode].shop.imageId='22222222-2222-4222-8222-222222222222';return save(next);},
  uploadShopImageAsset:async(dataUrl,crop)=>{qa.calls.push({kind:'image-upload',dataUrl,crop});return '22222222-2222-4222-8222-222222222222';},
  cloudShopOperation:async operation=>{qa.calls.push({kind:'shop-operation',operation});const next=clone(qa.document);if(operation.type==='shop-image')next.inventory.items[operation.barcode].shop.imageId=operation.imageId;else for(const barcode of operation.barcodes)next.inventory.items[barcode].listed=operation.listed;return save(next);},
  updatePrice:async(barcode,purchase,sale,currency)=>{qa.calls.push({kind:'card-price',barcode,purchase,sale,currency});const next=clone(qa.document),item=next.inventory.items[barcode];Object.assign(item,{priceAmount:purchase,salePriceAmount:sale,priceCurrency:currency});if(currency==='CAD'&&sale!==null)item.shop={...item.shop,originalCents:Math.max(item.shop.originalCents,Math.round(sale*100)),currentCents:Math.round(sale*100),priceSource:'current'};return save(next);}
 };
});
try {
 await page.goto(origin); await page.locator('[data-item-barcode="123"]').waitFor();
 await page.evaluate(()=>{const qa=window.qa,one=qa.document.inventory.items['123'];for(const [barcode,name] of [['456','透明立牌'],['789','钥匙扣']])qa.document.inventory.items[barcode]={...structuredClone(one),barcode,nickname:name,lookupName:'',shop:{...one.shop,imageId:null}};qa.emit({});});
 const toolbar=page.getByRole('region',{name:'批量商店管理'});
 await toolbar.getByRole('button',{name:'批量上架 / 下架',exact:true}).click();
 await toolbar.getByRole('button',{name:'全选当前结果',exact:true}).click();
 await toolbar.getByText(/已选 3/).waitFor();
 await page.evaluate(()=>window.qa.cloudEmit({shopOperationsSupported:false}));
 assert.ok(await toolbar.getByRole('button',{name:'批量上架',exact:true}).isDisabled());
 await toolbar.getByText(/等待 Mac 服务端升级/).waitFor();
 check('old server capabilities disable publication without sending a request');
 await page.evaluate(()=>window.qa.cloudEmit({shopOperationsSupported:true}));
 await toolbar.getByRole('button',{name:'批量上架',exact:true}).click();
 await toolbar.getByText(/未注册的商品会同时在商店注册/).waitFor();
 const before=await page.evaluate(()=>window.qa.calls.length);
 await toolbar.getByRole('button',{name:'取消批量操作',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.qa.calls.length),before);
 check('batch confirmation cancel performs no IPC mutation');
 await toolbar.getByRole('button',{name:'批量上架',exact:true}).click();
 await page.evaluate(()=>window.qa.fail=true);
 await toolbar.getByRole('button',{name:'确认批量上架',exact:true}).click();
 await page.getByText('合成磁盘保存失败',{exact:true}).waitFor();
 await toolbar.getByText(/已选 3/).waitFor();
 assert.equal(await page.evaluate(()=>Object.values(window.qa.document.inventory.items).some(item=>item.listed)),false);
 check('failed batch retains selection and does not claim publication');
 await page.evaluate(()=>window.qa.fail=false);
 await toolbar.getByRole('button',{name:'确认批量上架',exact:true}).click();
 await page.getByText('3 件商品已上架到次元商店。',{exact:true}).waitFor();
 assert.deepEqual((await page.evaluate(()=>window.qa.calls.at(-1).operation.barcodes)).sort(),['123','456','789']);
 assert.equal(await page.evaluate(()=>Object.values(window.qa.document.inventory.items).every(item=>item.listed)),true);
 await toolbar.getByText(/已选 0/).waitFor();
 check('confirmed batch publishes exactly selected records and clears selection on success');
 await toolbar.getByRole('button',{name:'全选当前结果',exact:true}).click();
 const search=page.locator('input[type="search"]');
 await search.fill('晴空'); await toolbar.getByText(/已选 1/).waitFor();
 await toolbar.getByRole('button',{name:'批量下架',exact:true}).click();
 await toolbar.getByRole('button',{name:'确认批量下架',exact:true}).click();
 await page.getByText('1 件商品已从次元商店下架。',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.qa.calls.at(-1).operation),{type:'shop-listing-batch',barcodes:['123'],listed:false});
 check('filtering removes hidden selections before batch action');
 await search.fill('');
 await toolbar.getByRole('button',{name:'全选当前结果',exact:true}).click();
 await toolbar.getByRole('button',{name:'批量上架',exact:true}).click();
 const beforeReplacement=await page.evaluate(()=>window.qa.calls.length);
 // Fire the stale confirmation in the same JS turn as the incoming inventory event, before React's effect can clean up.
 await page.evaluate(()=>{const button=document.querySelector('.shop-batch-submit');window.qa.emit({createdAt:'2026-09-24T12:34:56Z'});button.click();});
 await toolbar.getByText(/已选 2/).waitFor();
 assert.equal(await page.evaluate(()=>window.qa.calls.length),beforeReplacement);
 assert.equal(await toolbar.getByRole('button',{name:'确认批量上架',exact:true}).count(),0);
 assert.equal(await page.locator('[data-item-barcode="123"] .shop-select-item').getAttribute('aria-pressed'),'false');
 check('recreated same-barcode item loses selection and same-turn stale confirmation sends no operation');
 await toolbar.getByRole('button',{name:'批量上架',exact:true}).click();
 const beforeAccount=await page.evaluate(()=>window.qa.calls.length);
 await page.evaluate(()=>{const button=document.querySelector('.shop-batch-submit');window.qa.cloudEmit({account:{...window.qa.cloud.account,id:'second-account'}});button.click();});
 await toolbar.getByRole('button',{name:'批量上架 / 下架',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.qa.calls.length),beforeAccount);
 assert.equal(await toolbar.getByRole('button',{name:'确认批量上架',exact:true}).count(),0);
 await page.evaluate(()=>window.qa.cloudEmit({account:{...window.qa.cloud.account,id:'synthetic'}}));
 await toolbar.getByRole('button',{name:'批量上架 / 下架',exact:true}).click();
 await toolbar.getByText(/已选 0/).waitFor();
 check('account changes clear selection and block same-turn confirmation from the previous account');
 await toolbar.getByRole('button',{name:'全选当前结果',exact:true}).click();
 await toolbar.getByRole('button',{name:'批量上架',exact:true}).click();
 await page.evaluate(()=>{window.qa.emit({quantityOnHand:11});document.querySelector('.shop-batch-submit').click();});
 await page.getByText('3 件商品已上架到次元商店。',{exact:true}).waitFor();
 assert.deepEqual((await page.evaluate(()=>window.qa.calls.at(-1).operation.barcodes)).sort(),['123','456','789']);
 check('unrelated quantity refresh preserves an otherwise valid batch confirmation');
 const card=page.locator('[data-item-barcode="123"]'),shop=card.locator('.shop-editor');await shop.locator('summary').click();
 await page.evaluate(()=>window.qa.cloudEmit({registeredBarcodes:['123']}));
 await shop.getByRole('button',{name:'选择并裁切自有图片',exact:true}).click();
 await shop.getByRole('button',{name:'裁切并上传图片',exact:true}).click();
 await shop.getByText(/裁切图已上传/).waitFor();
 const desired='22222222-2222-4222-8222-222222222222';
 assert.notEqual(await page.evaluate(()=>window.qa.document.inventory.items['123'].shop.imageId),desired);
 await page.evaluate(()=>window.qa.emit({shop:{...window.qa.document.inventory.items['123'].shop,imageId:'99999999-9999-4999-8999-999999999999'}}));
 await shop.getByText('云端主图已变化，当前图片草稿仍保留。',{exact:true}).waitFor();
 assert.ok(await shop.getByRole('button',{name:'保存主图',exact:true}).isDisabled());
 await shop.getByRole('button',{name:'保留图片草稿',exact:true}).click();
 await page.evaluate(()=>window.qa.fail=true);
 await shop.getByRole('button',{name:'保存主图',exact:true}).click();
 await shop.getByText(/操作未确认成功/).waitFor();
 assert.notEqual(await page.evaluate(()=>window.qa.document.inventory.items['123'].shop.imageId),desired);
 await page.evaluate(()=>window.qa.fail=false);
 await shop.getByRole('button',{name:'保存主图',exact:true}).click();
 await shop.getByText(/主图已保存到云端库存/).waitFor();
 assert.equal(await page.evaluate(()=>window.qa.document.inventory.items['123'].shop.imageId),desired);
 assert.deepEqual(await page.evaluate(()=>window.qa.calls.at(-1).operation),{type:'shop-image',barcode:'123',imageId:desired});
 check('registered image drafts survive remote conflict and save failure with image-only retry');
 await page.evaluate(()=>window.qa.cloudEmit({account:{id:'synthetic',username:'stock-qa',displayName:'库存验收',permissions:['inventory.manage']}}));
 assert.ok(await shop.getByRole('button',{name:'选择并裁切自有图片',exact:true}).isDisabled());
 await page.evaluate(()=>window.qa.cloudEmit({account:{id:'synthetic',username:'stock-qa',displayName:'库存验收',permissions:['inventory.manage','products.manage','pricing.manage']},shopOperationPending:true}));
 assert.ok(await toolbar.getByRole('button',{name:'批量上架',exact:true}).isDisabled());
 await page.evaluate(()=>window.qa.cloudEmit({shopOperationPending:false}));
 check('missing product permission and unresolved durable operation disable new writes');
 await toolbar.getByRole('button',{name:'全选当前结果',exact:true}).click();
 await toolbar.getByRole('button',{name:'批量上架',exact:true}).click();
 await page.waitForTimeout(250); await page.screenshot({path:path.join(output,'desktop-batch-light.png'),fullPage:true});report.screenshots.push('desktop-batch-light.png');
 await page.setViewportSize({width:768,height:1000});await page.getByRole('button',{name:'深色',exact:true}).click();
 await page.waitForTimeout(250); await page.screenshot({path:path.join(output,'desktop-batch-dark-768.png'),fullPage:true});report.screenshots.push('desktop-batch-dark-768.png');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.evaluate(()=>window.qa.switchFile());
 await toolbar.getByRole('button',{name:'批量上架 / 下架',exact:true}).waitFor();
 assert.equal(await toolbar.getByRole('button',{name:'确认批量上架',exact:true}).count(),0);
 check('file switching discards old selection and confirmation; 768px dark view does not overflow');
 await page.evaluate(()=>{const qa=window.qa,one=qa.document.inventory.items['123'];for(let index=0;index<204;index++){const barcode='B'+index;qa.document.inventory.items[barcode]={...structuredClone(one),barcode,nickname:barcode,shop:{...one.shop,imageId:null}};}qa.emit({});});
 await toolbar.getByRole('button',{name:'批量上架 / 下架',exact:true}).click();
 await toolbar.getByRole('button',{name:'选择当前前 200 件',exact:true}).click();
 await toolbar.getByText(/已选 200/).waitFor();
 assert.equal(await page.locator('.shop-select-item[aria-pressed="true"]').count(),200);
 check('large selection is bounded to 200 and never silently publishes hidden items');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.blocked,[]);for(const row of sourceFiles)assert.equal(sha(await readFile(row.path)),row.sha256);report.sourceUnchanged=true;report.passed=true;
} catch(error) {report.failure=error.stack;await page.waitForTimeout(250); await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
finally {await browser.close();await server.close();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('REPORT '+output);}
