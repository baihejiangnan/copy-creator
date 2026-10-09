// Real default QA lifecycle with synthetic note and settings drafts.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),readline=require('node:readline');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`);let page;for(let i=0;i<100;i++){for(const candidate of browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()==='http://tauri.localhost/'))if(await candidate.evaluate(()=>performance.timeOrigin).catch(()=>0)>=info.launchStartedUnixMs-200){page=candidate;break}if(page)break;await new Promise(r=>setTimeout(r,100))}assert.ok(page);page.setDefaultTimeout(20000);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const epoch=await invoke('get_storage_epoch'),id=crypto.randomUUID(),title='QA lifecycle joint '+crypto.randomUUID();
 const report={started:new Date().toISOString(),app:info,id,steps:[],scope:'Native restart/Quit and actual app save participants; only synthetic note, non-secret model/URL drafts. Transport fault injection is frontend delivery, not disk failure.'};
 const destination=path.join(root,'reports','lifecycle-joint-'+Date.now()+'.json');
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const live=()=>{try{execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-Command',`Get-Process -Id ${Number(info.pid)} -ErrorAction Stop | Out-Null`],{windowsHide:true,stdio:'ignore',timeout:3000});return true}catch{return false}};
 const tray=async()=>{
  const helper=spawn(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'operate-qa-tray.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stderr='';helper.stderr.on('data',data=>stderr+=data);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned tray menu timeout: '+stderr)),15000);readline.createInterface({input:helper.stdout}).on('line',line=>{try{if(JSON.parse(line).ready){clearTimeout(timer);resolve()}}catch{}});helper.on('exit',code=>{if(code){clearTimeout(timer);reject(Error(stderr))}})});
  return ()=>helper.stdin.end('quit\n');
 };
 try{
  if(await page.locator('.lifecycle-error').isVisible())await page.locator('.lifecycle-error').getByRole('button').click();
  await page.locator('.sidebar-nav').getByRole('button',{name:/^(便签|Notes)$/}).click();
  await invoke('create_note',{expectedStorageEpoch:epoch,id,mutationId:crypto.randomUUID(),draft:{title,body:'QA joint initial',refs:[]}});
  await page.evaluate(async id=>{
   const entry=performance.getEntriesByType('resource').find(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name));const workspace=(await import(entry.name)).useNotesWorkspace;await workspace.getState().initialize();await workspace.getState().open(id);
   const main=performance.getEntriesByType('resource').find(e=>/\/main-[^/]+\.js$/.test(e.name));const values=Object.values(await import(main.name));
   const settings=values.find(v=>v?.getState?.().commitAll),effective=values.find(v=>v?.getState?.().setSetting),barrier=values.find(v=>v?.run&&v?.register&&v?.getSnapshot);
   if(!settings||!effective||!barrier)throw Error('Actual settings/barrier exports unavailable');await settings.getState().initialize();
   const coordinator=workspace.getState().coordinator;window.__qaLife={workspace,coordinator,settings,effective,barrier,original:coordinator.transport,originalModel:settings.getState().values.ai_model,originalUrl:settings.getState().values.ai_api_url};
  },id);
  // Settings validation fails while the independently valid note can commit.
  await page.evaluate(id=>{const q=window.__qaLife;q.settings.getState().edit('ai_api_url','QA-invalid-url');q.coordinator.edit(id,{body:'QA settings failure retained note'});},id);
  await invoke('request_app_restart');await page.locator('.lifecycle-error').waitFor();assert.equal(live(),true);
  const settingsFailure=await page.evaluate(()=>{const q=window.__qaLife,s=q.settings.getState();return {error:s.errors.ai_api_url,value:s.values.ai_api_url,paused:s.paused,barrierBusy:q.barrier.getSnapshot().busy}});
  assert.equal(settingsFailure.error,'settings.invalidUrl');assert.equal(settingsFailure.value,'QA-invalid-url');assert.equal(settingsFailure.paused,false);assert.equal(settingsFailure.barrierBusy,false);
  record('actual native restart refused for invalid settings; setting draft remains, participants resume',settingsFailure);
  await page.evaluate(()=>{const q=window.__qaLife;q.settings.getState().edit('ai_api_url',q.originalUrl);q.barrier.dismissError()});
  // A failed note prevents a real tray Quit despite a valid settings draft.
  const quitFailed=await tray();
  const failureBody='QA joint failed note '+crypto.randomUUID();
  await page.evaluate(({id,body})=>{const q=window.__qaLife;q.coordinator.transport=()=>Promise.reject({code:'notes.databaseFailed'});q.settings.getState().edit('ai_model','QA-joint-model-'+id);q.coordinator.edit(id,{body});},{id,body:failureBody});quitFailed();
  await page.locator('.lifecycle-error').waitFor();assert.equal(live(),true);
  const noteFailure=await page.evaluate(id=>{const q=window.__qaLife,s=q.coordinator.getSession(id);return {body:s.draft.body,status:s.status,paused:q.settings.getState().paused,barrierBusy:q.barrier.getSnapshot().busy}},id);
  assert.equal(noteFailure.body,failureBody);assert.equal(noteFailure.status,'error');assert.equal(noteFailure.barrierBusy,false);
  record('real tray Quit refused for note delivery failure; body retained and settings resumed',{status:noteFailure.status,paused:noteFailure.paused});
  await page.evaluate(id=>{const q=window.__qaLife;q.coordinator.transport=q.original;q.barrier.dismissError();return q.coordinator.flush(id)},id);
  // Hold only delivery, not native locks, through the real 10s save deadline.
  const timeoutBody='QA joint timeout '+crypto.randomUUID();
  await page.evaluate(({id,body})=>{const q=window.__qaLife;q.coordinator.transport=request=>new Promise((resolve,reject)=>{q.release=()=>q.original(request).then(resolve,reject)});q.coordinator.edit(id,{body});},{id,body:timeoutBody});
  const started=Date.now();await invoke('request_app_restart');await page.locator('.lifecycle-error').filter({hasText:/超时|timed out/i}).waitFor();assert.equal(live(),true);
  assert.equal((await invoke('get_note',{id,expectedStorageEpoch:epoch})).value.body,failureBody);
  const retained=await page.evaluate(id=>{const q=window.__qaLife;return {body:q.coordinator.getSession(id).draft.body,busy:q.barrier.getSnapshot().busy,paused:q.settings.getState().paused}},id);
  assert.equal(retained.body,timeoutBody);assert.equal(retained.busy,false);assert.equal(retained.paused,false);
  const finalBody=timeoutBody+'\r\nnew input after timeout  \n';
  await page.evaluate(async({id,body})=>{const q=window.__qaLife;q.coordinator.transport=q.original;q.coordinator.edit(id,{body});await q.release();await q.coordinator.flush(id);q.barrier.dismissError();},{id,body:finalBody});
  await new Promise(r=>setTimeout(r,500));assert.equal(live(),true);assert.equal((await invoke('get_note',{id,expectedStorageEpoch:epoch})).value.body,finalBody);
  record('real save deadline cancels restart; late acknowledgment never restarts or clears newer draft',{deadlineObservedMs:Date.now()-started});
  // Close/hide saves jointly without treating it as application exit.
  const hideBody=finalBody+'hide checkpoint';
  await page.evaluate(({id,body})=>{const q=window.__qaLife;q.settings.getState().edit('ai_model','QA-joint-hide-'+id);q.coordinator.edit(id,{body});},{id,body:hideBody});
  await page.locator('.window-close-btn').click();
  await page.waitForFunction(async()=>!await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'}));
  await page.waitForFunction(id=>window.__qaLife.coordinator.getSession(id).status==='saved',id);assert.equal(live(),true);
  assert.equal(await invoke('get_setting',{key:'ai_model'}),'QA-joint-hide-'+id);assert.equal((await invoke('get_note',{id,expectedStorageEpoch:epoch})).value.body,hideBody);
  record('actual hide button jointly flushes note and setting, process remains alive');
  execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'restore-qa-window.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:'ignore'});
  const quitSuccess=await tray(),exitBody=hideBody+'\r\nreal joint Quit  \n';
  const dirty=await page.evaluate(({id,body})=>{const q=window.__qaLife;q.settings.getState().edit('ai_model','QA-joint-exit-'+id);q.coordinator.edit(id,{body});return q.coordinator.getSession(id).status;},{id,body:exitBody});assert.equal(dirty,'dirty');quitSuccess();
  let exited=false;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));if(!live()){exited=true;break}}assert.equal(exited,true);
  const inspection=JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({action:'inspect_joint',database:path.join(info.storageRoot,'data.db'),id}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true}));
  assert.equal(inspection.body,exitBody);assert.equal(inspection.model,'QA-joint-exit-'+id);assert.equal(inspection.integrity,'ok');record('real tray Quit saves both dirty note and uncommitted setting before actual process termination',{revision:inspection.revision,integrity:inspection.integrity});
  report.passed=true;fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,report:destination}));
 }catch(error){record('failed',{error:error.message||error});throw error}
 finally{if(live()){await page.evaluate(async id=>{const q=window.__qaLife;if(!q)return;q.coordinator.transport=q.original;try{await q.release?.()}catch{}q.settings.getState().edit('ai_api_url',q.originalUrl);q.barrier.dismissError();await q.coordinator.flush(id);await q.settings.getState().commitAll();},id).catch(()=>{})}}
 process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
