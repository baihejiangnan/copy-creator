// Intentional negative test: owned driver stays alive until wrapper deadline.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.autostartIsolation,'identifier');assert.equal(info.pasteIsolation,'identifier');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);
 assert.equal(require('./qa-path.cjs')(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'))),require('./qa-path.cjs')(info.storageRoot));
 console.log(JSON.stringify({intentionalOwnedDriverHang:true,connectedNativePid:info.pid,scope:'Negative wrapper deadline test; no business writes or clipboard operations in driver'}));
 await new Promise(()=>{}); // CDP transport intentionally remains open.
})().catch(e=>{console.error(e.stack||String(e));process.exit(1)});
