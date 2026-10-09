// Real default startup cleanup: two expired synthetic files, no production paths.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),receiptFile=path.join(root,'paste-isolation-fixture.json'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.pasteIsolation,'identifier');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
const directory=id=>path.join(os.tmpdir(),'copy_creator_paste_instances',crypto.createHash('sha256').update(id).digest('hex'));
const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({action:'paste_temp_retention',database:path.join(info.storageRoot,'data.db'),...request}),env:{...process.env,PYTHONUTF8:'1'},windowsHide:true,encoding:'utf8'}));
if(process.argv.includes('--prepare')){
 if(fs.existsSync(receiptFile))assert.equal(JSON.parse(fs.readFileSync(receiptFile,'utf8')).cleaned,true,'Previous fixture needs cleanup first');
 const name='QA-temp-isolation-'+crypto.randomUUID()+'.png',own=path.join(directory(info.identifier),name),other=path.join(directory('com.copycreator.qatempguard20261008'),name),bytes=Buffer.from('QA synthetic expired temporary image fixture'),receipt={own,other,storageRoot:info.storageRoot,prepared:false};
 fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2));
 for(const file of [own,other]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});const before=new Date(Date.now()-10*86400000);fs.utimesSync(file,before,before)}
 receipt.previous=fixture({mode:'prepare'}).previous;receipt.prepared=true;fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2));console.log(JSON.stringify({pasteIsolationFixturePrepared:true,syntheticFiles:2}));process.exit(0);
}
const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));assert.equal(receipt.storageRoot,info.storageRoot);
for(const [file,expected] of [[receipt.own,directory(info.identifier)],[receipt.other,directory('com.copycreator.qatempguard20261008')]]){assert.equal(path.dirname(file),expected);assert.match(path.basename(file),/^QA-temp-isolation-[0-9a-f-]{36}\.png$/)}
if(process.argv.includes('--cleanup')){
 if(receipt.prepared)assert.equal(fixture({mode:'restore',previous:receipt.previous}).restored,true);
 for(const file of [receipt.own,receipt.other])if(fs.existsSync(file))fs.unlinkSync(file);
 receipt.cleaned=true;fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2));console.log(JSON.stringify({pasteIsolationFixtureCleaned:true,settingRestored:true}));process.exit(0);
}
(async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);let page;for(let i=0;i<100;i++){for(const p of browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()==='http://tauri.localhost/'))if(await p.evaluate(()=>performance.timeOrigin).catch(()=>0)>=info.launchStartedUnixMs-200){page=p;break}if(page)break;await wait(100)}assert.ok(page);
 const report={started:new Date().toISOString(),app:info,scope:'Expired synthetic files in two non-production identifier directories. Real default startup retention cleanup removes only its own file. No production temporary directory listed, read or written.'},destination=path.join(root,'reports','paste-temp-isolation-'+Date.now()+'.json');
 try{
  assert.equal(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_setting',{key:'clipboard_retention'})),'1week');
  for(let i=0;i<100&&fs.existsSync(receipt.own);i++)await wait(100);
  assert.equal(fs.existsSync(receipt.own),false);assert.equal(fs.readFileSync(receipt.other,'utf8'),'QA synthetic expired temporary image fixture');report.ownExpiredRemoved=true;report.otherInstanceUnchanged=true;report.passed=true;
 }catch(error){report.error=error.stack;throw error}
 finally{report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));await browser.close()}
 process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
