// Real default Release settings flow, synthetic 72 MiB note corpus, owned dialogs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const readline=require('node:readline'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),metadata=path.join(root,'process.json');
 const info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`),page=browser.contexts()[0].pages().find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);page.setDefaultTimeout(60000);
 assert.equal(require('./qa-path.cjs')(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'))),require('./qa-path.cjs')(info.storageRoot));
 const directory=path.join(root,'backup-capacity',randomUUID());fs.mkdirSync(directory,{recursive:true});
 const prefix='QA-backup-load-'+randomUUID(),phasePath=path.join(directory,'phase.txt'),stopPath=path.join(directory,'stop'),memoryPath=path.join(directory,'memory.jsonl');
 const report={time:new Date().toISOString(),app:info,directory,steps:[]},reportPath=path.join(root,'reports',`backup-capacity-${Date.now()}.json`);
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(reportPath,JSON.stringify(report,null,2))};
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({...request,database:path.join(info.storageRoot,'data.db')}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true}));
 const dialog=(action,file)=>execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'operate-qa-dialog.ps1'),'-Metadata',metadata,'-Action',action,...(file?['-FixturePath',file]:[])],{windowsHide:true,timeout:15000,stdio:'pipe'});
 const monitor=spawn(process.env.QA_PYTHON,[path.join(__dirname,'monitor-qa-processes.py'),metadata,memoryPath,phasePath,stopPath],{env:{...process.env,PYTHONUTF8:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let monitorError='';monitor.stderr.on('data',data=>monitorError+=data);const lines=readline.createInterface({input:monitor.stdout});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Monitor timeout: '+monitorError)),10000);lines.on('line',line=>{if(JSON.parse(line).ready){clearTimeout(timer);resolve()}});monitor.on('exit',code=>{if(code){clearTimeout(timer);reject(Error(monitorError))}})});
 const phase=name=>fs.writeFileSync(phasePath,name);
 try {
  phase('idle-before-seed');await wait(1200);
  phase('seed');const load=fixture({action:'backup_load',prefix,targetBytes:72*1024*1024});record('synthetic 72 MiB raw corpus prepared',{count:load.ids.length,beforeRawBytes:load.beforeRawBytes,afterRawBytes:load.afterRawBytes});
  execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'restore-qa-window.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:'ignore'});
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'数据',exact:true}).click();
  const panel=page.getByRole('tabpanel',{name:'数据',exact:true}),status=panel.locator('.settings-transfer-status[role="status"]');
  const password='QA-only-synthetic-capacity-password-2026',backup=path.join(directory,'near-limit.ccbackup');
  const exportTo=async file=>{
   await panel.getByRole('button',{name:'导出',exact:true}).click();await panel.getByLabel('备份密码',{exact:true}).fill(password);await panel.getByLabel('确认备份密码',{exact:true}).fill(password);
   await panel.getByRole('button',{name:'创建加密备份',exact:true}).click();await wait(150);dialog('save',file);
  };
  phase('idle-before-export');await wait(1200);phase('export-near-limit');let started=Date.now();await exportTo(backup);await status.filter({hasText:'已导出'}).waitFor();
  const envelope=JSON.parse(fs.readFileSync(backup,'utf8')),payloadBytes=Buffer.from(envelope.payload.slice(3),'base64').length-28;
  assert.equal(envelope.version,3);assert.ok(payloadBytes<74*1024*1024);assert.ok(payloadBytes>72*1024*1024);
  record('real near-limit encrypted export',{elapsedMs:Date.now()-started,fileBytes:fs.statSync(backup).size,payloadBytes,payloadFraction:payloadBytes/(74*1024*1024),status:await status.innerText()});
  phase('idle-after-export');await wait(1500);phase('select-near-limit');started=Date.now();
  await panel.getByRole('button',{name:'导入',exact:true}).click();await wait(150);dialog('select',backup);await panel.getByLabel('备份密码',{exact:true}).waitFor();record('near-limit file selected',{elapsedMs:Date.now()-started});
  await panel.getByLabel('备份密码',{exact:true}).fill(password);phase('preview-near-limit');started=Date.now();await panel.getByRole('button',{name:'查看备份内容',exact:true}).click();await panel.getByRole('button',{name:'确认导入',exact:true}).waitFor();record('near-limit authenticated preview',{elapsedMs:Date.now()-started,preview:await panel.locator('.settings-backup-preview').innerText()});
  phase('import-near-limit');started=Date.now();await panel.getByRole('button',{name:'确认导入',exact:true}).click();await status.filter({hasText:'已导入'}).waitFor();record('near-limit repeated import',{elapsedMs:Date.now()-started,status:await status.innerText()});
  phase('idle-after-import');await wait(1500);phase('seed-over-limit');const over=fixture({action:'backup_load',prefix,targetBytes:80*1024*1024});record('over-limit raw corpus prepared',{added:over.ids.length,rawBytes:over.afterRawBytes});
  const refused=path.join(directory,'must-not-exist.ccbackup');phase('export-over-limit');started=Date.now();await exportTo(refused);await status.filter({hasText:'失败'}).waitFor();assert.equal(fs.existsSync(refused),false);assert.match(await status.innerText(),/过大|大小|容量|限制/);record('over-limit refusal creates no destination',{elapsedMs:Date.now()-started,status:await status.innerText()});
  phase('idle-after-refusal');await wait(1500);report.passed=true;
 } catch(error){record('failed',{error:error.message});throw error}
 finally {
  try{dialog('cancel')}catch{}phase('cleanup');record('only own load notes removed',fixture({action:'remove_backup_load',prefix}));fs.writeFileSync(stopPath,'stop');await new Promise(resolve=>{if(monitor.exitCode!==null)resolve();else monitor.once('exit',resolve)});
  const samples=fs.readFileSync(memoryPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),summary={};
  for(const sample of samples){const item=summary[sample.phase]||={samples:0,treePeakPrivateBytes:0,treePeakWorkingSet:0,nativePeakPrivateBytes:0,nativePeakWorkingSet:0};item.samples++;item.treePeakPrivateBytes=Math.max(item.treePeakPrivateBytes,sample.privateBytes);item.treePeakWorkingSet=Math.max(item.treePeakWorkingSet,sample.workingSet);const native=sample.processes.find(p=>p.pid===info.pid);if(native){item.nativePeakPrivateBytes=Math.max(item.nativePeakPrivateBytes,native.privateBytes);item.nativePeakWorkingSet=Math.max(item.nativePeakWorkingSet,native.workingSet)}}
  report.memory={intervalMs:100,scope:'verified QA process and all descendants, observed peaks rather than allocation maxima',monitorError,summary};fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,reportPath,steps:report.steps,memory:report.memory}));
 }
 process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
