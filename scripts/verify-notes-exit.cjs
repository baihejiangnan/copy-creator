// Select the real native tray Quit command on the isolated QA process only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const readline=require('node:readline');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),metadata=path.join(root,'process.json');
 const info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`);
 const page=browser.contexts()[0].pages().find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);
 assert.equal(require('./qa-path.cjs')(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'))),require('./qa-path.cjs')(info.storageRoot));
 await page.locator('.sidebar-nav').getByRole('button',{name:'便签',exact:true}).click();
 const id=randomUUID(),body=`QA exit raw ${randomUUID()}\r\n中文😀\rtrailing  \n`;
 await page.evaluate(async id=>{
   const epoch=await window.__TAURI_INTERNALS__.invoke('get_storage_epoch');
   await window.__TAURI_INTERNALS__.invoke('create_note',{expectedStorageEpoch:epoch,id,mutationId:crypto.randomUUID(),draft:{title:'QA pending native exit',body:'QA initial',refs:[]}});
   const entry=performance.getEntriesByType('resource').find(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name));
   await (await import(entry.name)).useNotesWorkspace.getState().open(id);
 },id);
 const helper=spawn(process.env.QA_POWERSHELL,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'operate-qa-tray.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stderr='';helper.stderr.on('data',data=>stderr+=data);
 const lines=readline.createInterface({input:helper.stdout});
 await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Tray helper timeout: '+stderr)),15000);
   lines.on('line',line=>{try{if(JSON.parse(line).ready){clearTimeout(timer);resolve()}}catch{}});
   helper.once('exit',code=>{if(code){clearTimeout(timer);reject(Error(stderr))}});
 });
 const phase=await page.evaluate(async({id,body})=>{
   const entry=performance.getEntriesByType('resource').find(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name));
   const {coordinator}=(await import(entry.name)).useNotesWorkspace.getState();coordinator.edit(id,{body});
   return coordinator.getSession(id).status;
 },{id,body});assert.equal(phase,'dirty');
 const started=Date.now();helper.stdin.end('quit\n');
 const exited=await new Promise(resolve=>{
   const timer=setInterval(()=>{
    try{execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-NonInteractive','-Command',`Get-Process -Id ${Number(info.pid)} -ErrorAction Stop | Out-Null`],{stdio:'ignore',windowsHide:true,timeout:2000})}
    catch{clearInterval(timer);resolve(true)}
    if(Date.now()-started>20000){clearInterval(timer);resolve(false)}
   },250);
 });
 const inspection=JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({action:'inspect',database:path.join(info.storageRoot,'data.db'),ids:[id],historyId:'QA-unused'}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true}));
 const report={time:new Date().toISOString(),app:info,id,dirtyBeforeSelection:phase,selection:'real owned tray menu WM_COMMAND',nativeExit:exited,elapsedMs:Date.now()-started,bodyMatches:inspection.notes[0].body===body,revision:inspection.notes[0].revision,integrity:inspection.integrity,helperError:stderr};
 const reportPath=path.join(root,'reports',`exit-${Date.now()}.json`);fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({reportPath,...report}));
 assert.equal(inspection.notes[0].body,body);assert.equal(inspection.integrity,'ok');assert.equal(exited,true,'Native Quit must actually terminate the QA process');
 process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
