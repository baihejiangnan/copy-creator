// User-authorized OS clipboard QA. Original data stays in the helper's RAM.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),readline=require('node:readline');
const baseline=process.argv[2]==='verify-common-runtime.cjs'&&process.argv.includes('--baseline');
const root=path.resolve(__dirname,'../output/optimization/'+(baseline?'baseline-runtime-20261008':'QA-notes-20261007'));
const powershell=process.env.QA_POWERSHELL||'C:/Users/ABD18/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
const metadata=path.join(root,'process.json');
const run=(file,args,env=process.env,timeoutMs=60000)=>new Promise((resolve,reject)=>{
 const child=spawn(file,args,{windowsHide:true,env,stdio:['ignore','pipe','pipe']});let output='',error='';
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill()},timeoutMs);
 child.stdout.on('data',value=>{output+=value;process.stdout.write(value)});child.stderr.on('data',value=>{error+=value;process.stderr.write(value)});
 child.on('error',failure=>{clearTimeout(timer);reject(failure)});child.on('exit',code=>{clearTimeout(timer);code===0&&!timedOut?resolve(output):reject(Error((timedOut?'QA child deadline exceeded; owned child stopped. ':'')+'QA child failed ('+code+'): '+error))});
});
(async()=>{
 const driver=process.argv[2];assert.ok(['verify-terminal-paste.cjs','verify-paste-repeat.cjs','verify-updates-about.cjs','verify-images-continuous.cjs','verify-query-ipc.cjs','verify-lifecycle-first-ready.cjs','verify-notes-scrollbars.cjs','verify-notes-crash.cjs','verify-qa-driver-deadline.cjs','verify-memory-target.cjs','verify-tray-storage-race.cjs','verify-hourly-cleanup.cjs','verify-backup-metrics.cjs','verify-qa-process-isolation.cjs','verify-dpi-session.cjs','verify-periodic-failure.cjs','verify-periodic-cleanup.cjs','verify-paste-temp-isolation.cjs','verify-copy-worker-drain.cjs','verify-copy-storage-race.cjs','verify-lifecycle-restart.cjs','verify-lifecycle-reload.cjs','verify-clipboard-latency.cjs','verify-font-startup.cjs','verify-font-woff2.cjs','verify-vault-session-race.cjs','verify-lifecycle-unresponsive.cjs','verify-common-runtime.cjs','verify-backup-handoff.cjs','verify-ttl-images.cjs','verify-storage-event-race.cjs','verify-translation-storage-race.cjs','verify-storage-read-races.cjs','verify-phrase-storage-race.cjs','verify-vault-master-merge.cjs','verify-storage-remaining.cjs','verify-autostart-isolation.cjs','verify-startup-pages.cjs','verify-native-profile.cjs','verify-cleanup-pressure.cjs','verify-backup-legacy.cjs','verify-backup-rich.cjs','verify-lifecycle-joint.cjs','verify-search-runtime-qa.cjs','verify-controlled-desktop.cjs','verify-notes-scale.cjs','verify-notes-files.cjs','verify-notes-capture.cjs','verify-notes-backup.cjs','verify-notes-storage.cjs','verify-notes-exit.cjs','verify-images-desktop.cjs','verify-notes-desktop.cjs','verify-notes-performance.cjs'].includes(driver),'Expected reviewed QA driver');
 const selected=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(selected.autostartIsolation,'identifier','Refusing legacy QA with a shared production autostart name');assert.equal(selected.pasteIsolation,'identifier','Refusing legacy QA with shared production paste-image temporary cleanup');
 await run(powershell,['-NoProfile','-File',path.join(__dirname,'qa-process-isolation.ps1')]);
 const report={started:new Date().toISOString(),driver,authorization:'User explicitly approved controlled system clipboard/global shortcut acceptance and restoration',scope:'Only isolated QA app; original clipboard bytes/values/hashes never exported'};
 const destination=path.join(root,'reports','controlled-clipboard-'+Date.now()+'.json');
 const helper=spawn(powershell,['-NoProfile','-STA','-File',path.join(__dirname,'protect-qa-clipboard.ps1'),'-Metadata',metadata,'-Scope',baseline?'baseline':'default'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let helperError='',pending=[],queued=[],ended=false;
 helper.stderr.on('data',data=>{helperError+=data;process.stderr.write(data)});
 const lines=readline.createInterface({input:helper.stdout});
 lines.on('line',line=>{let value;try{value=JSON.parse(line)}catch{return}if(pending.length)pending.shift().resolve(value);else queued.push(value)});
 helper.on('exit',code=>{ended=true;for(const request of pending.splice(0))request.reject(Error('Clipboard helper exited '+code+': '+helperError));});
 const next=()=>queued.length?Promise.resolve(queued.shift()):ended?Promise.reject(Error('Clipboard helper ended')):new Promise((resolve,reject)=>{const item={resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}};const timer=setTimeout(()=>{pending=pending.filter(value=>value!==item);reject(Error('Clipboard helper timeout'))},60000);pending.push(item)});
 const command=async request=>{const response=next();helper.stdin.write(JSON.stringify(request)+'\n');return response};
 let preserved=false,launched=false,pasteFixture=false;
 try{
  report.preservation=await next();assert.equal(report.preservation.ready,true);preserved=true;
  console.log(JSON.stringify({clipboardPreserved:true,formats:report.preservation.formatsPreserved}));
  const sentinel='QA controlled clipboard '+crypto.randomUUID();
  assert.equal((await command({command:'writeText',text:sentinel})).writtenSynthetic,true);
  if(driver==='verify-paste-temp-isolation.cjs'){pasteFixture=true;await run(process.execPath,[path.join(__dirname,driver),'--prepare']);}
  launched=true;await run(powershell,['-NoProfile','-File',path.join(__dirname,baseline?'runtime-baseline-process.ps1':'launch-saved-qa.ps1'),'-Metadata',metadata,...(baseline?['-Action','launch']:driver==='verify-lifecycle-first-ready.cjs'?['-WaitForScriptDebugger']:[])]);
  const info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
  const env={...process.env,QA_STORAGE_ROOT:info.storageRoot,QA_CDP_URL:`http://127.0.0.1:${info.debugPort}`,QA_POWERSHELL:powershell,QA_RUNTIME_METADATA:metadata};
  for(const name of ['QA_PROCESS_METADATA','QA_SCALE_FIXTURE','QA_SCALE_STAGES'])delete env[name];
  const driverDeadlineMs=driver==='verify-qa-driver-deadline.cjs'?15000:driver==='verify-hourly-cleanup.cjs'?75*60000:baseline?20*60000:45*60000;
  report.driverDeadlineMs=driverDeadlineMs;
  await run(process.execPath,[path.join(__dirname,driver),...process.argv.slice(3)],env,driverDeadlineMs);
  report.driverPassed=true;
 }catch(error){report.error=error.message;throw error}
 finally{
  try{
   if(launched&&driver==='verify-lifecycle-first-ready.cjs')try{await run(process.execPath,[path.join(__dirname,'resume-qa-debugger.cjs')])}catch(error){report.debuggerRecoveryError=error.message;console.error('Debugger resume failed; attempting verified native stop next.');}
   if(launched){let stopError;for(let attempt=0;attempt<3;attempt++){try{await run(powershell,['-NoProfile','-File',path.join(__dirname,baseline?'runtime-baseline-process.ps1':'stop-saved-qa.ps1'),'-Metadata',metadata,...(baseline?['-Action','stop']:[])]);stopError=null;break}catch(error){stopError=error;await new Promise(resolve=>setTimeout(resolve,1000))}}if(stopError){report.stopError=stopError.message;console.error('QA stop failed; clipboard snapshot helper remains alive for recovery.');throw stopError}}
   if(pasteFixture){try{await run(process.execPath,[path.join(__dirname,driver),'--cleanup'])}catch(error){report.fixtureCleanupError=error.message;}}
   if(preserved){report.restoration=await command({command:'restore'});assert.equal(report.restoration.restored,true);assert.equal(report.restoration.byteFormatsVerified,true);helper.stdin.end();}
   else helper.stdin.end();
   if(report.fixtureCleanupError)throw Error(report.fixtureCleanupError);
  }finally{report.finished=new Date().toISOString();report.passed=Boolean(report.driverPassed&&!report.fixtureCleanupError&&report.restoration?.restored&&report.restoration?.byteFormatsVerified);fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({controlledReport:destination,passed:report.passed,restoration:report.restoration}));}
 }
 process.exit(0);
})().catch(error=>{console.error(error.stack);process.exitCode=1});
