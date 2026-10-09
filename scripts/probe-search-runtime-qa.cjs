const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007/search-runtime-qa');
 const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007search');
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`);
 let page;
 const deadline=Date.now()+40000;
 while(!page&&Date.now()<deadline){page=browser.contexts().flatMap(context=>context.pages()).find(p=>p.url()==='http://tauri.localhost/');if(!page)await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(page,'Main WebView did not navigate within 40 seconds');
 await page.waitForFunction(()=>Boolean(window.__TAURI_INTERNALS__),{timeout:10000});
 const result=await page.evaluate(async()=>({storage:await window.__TAURI_INTERNALS__.invoke('get_storage_path'),epoch:await window.__TAURI_INTERNALS__.invoke('get_storage_epoch')}));
 assert.equal(require('./qa-path.cjs')(result.storage),require('./qa-path.cjs')(info.storageRoot));
 console.log(JSON.stringify(result));process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
