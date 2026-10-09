// Real Windows folder picker, source-routing failure, retry and native restart.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
const metadata=path.join(root,'process.json');
const powershell=process.env.QA_POWERSHELL,python=process.env.QA_PYTHON;
assert.ok(powershell&&python,'Set QA_POWERSHELL and QA_PYTHON');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const canonical=value=>path.resolve(value.replace(/^\\\\\?\\/,'' )).toLowerCase();
const shell=(file,args=[])=>execFileSync(powershell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,file),...args],{encoding:'utf8',timeout:15000,windowsHide:true,stdio:['ignore','pipe','pipe']});
const dialog=fixture=>shell('operate-qa-dialog.ps1',['-Metadata',metadata,'-Action','select','-FixturePath',fixture]);
const restore=()=>shell('restore-qa-window.ps1',['-Metadata',metadata]);
const fixture=request=>JSON.parse(execFileSync(python,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify(request),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:15000,windowsHide:true}));
(async()=>{
  let info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`,{timeout:5000});
  let page=browser.contexts()[0].pages().find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);page.setDefaultTimeout(20000);
  const invoke=async(command,args={})=>{
    const result=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return {ok:false,error}}},{command,args});
    if(!result.ok)throw result.error;return result.value;
  };
  const source=await invoke('get_storage_path');assert.equal(canonical(source),canonical(info.storageRoot||path.join(process.env.APPDATA,info.identifier)));
  const database=path.join(source,'data.db'),directory=path.join(root,'storage-fixtures',randomUUID());fs.mkdirSync(directory,{recursive:true});
  const target=path.join(directory,'迁移 目标,重试'),conflict=path.join(directory,'冲突 目标,保留');
  const external=path.join(directory,'外部 文件,保留.txt');fs.writeFileSync(external,'QA storage external file unchanged');
  const report={time:new Date().toISOString(),app:info,source,target,conflict,steps:[]};
  const reportPath=path.join(root,'reports',`storage-${Date.now()}.json`);
  const record=(step,data={})=>{report.steps.push({time:new Date().toISOString(),step,...data});fs.writeFileSync(reportPath,JSON.stringify(report,null,2));};
  let fault=false,epoch=await invoke('get_storage_epoch');
  const prefix=`QA迁移 ${randomUUID()}`,body='  QA migration 中文😀\r\nsecond\rlast  \n',notes=[];
  try {
    for(const state of ['active','archived','trash']){
      let note=(await invoke('create_note',{expectedStorageEpoch:epoch,id:randomUUID(),mutationId:randomUUID(),draft:{title:prefix+' '+state,body,refs:[{id:randomUUID(),kind:'file',target:external,display_name:'外部 文件,保留.txt'}]}})).value.note;
      if(state!=='active')note=(await invoke('set_note_state',{expectedStorageEpoch:epoch,id:note.id,expectedRevision:note.revision,mutationId:randomUUID(),action:state==='trash'?'delete':'archive'})).value.note;
      notes.push({state,note});
    }
    const ids=notes.map(n=>n.note.id),historyId=randomUUID();
    fixture({action:'history',database,id:historyId});
    fixture({action:'prepare',kind:'conflict',database:path.join(conflict,'data.db'),source:database,noteId:ids[0]});
    fixture({action:'prepare',kind:'empty',database:path.join(target,'data.db')});
    const inspect=db=>fixture({action:'inspect',database:db,ids,historyId});
    const conflictBefore=inspect(path.join(conflict,'data.db'));
    record('prepared synthetic active/archive/trash, external reference, history and two target databases',{ids,historyId});
    restore();await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'数据',exact:true}).click();
    const panel=page.getByRole('tabpanel',{name:'数据',exact:true});
    const choose=async destination=>{await panel.getByRole('button',{name:'更改',exact:true}).click();dialog(destination);};
    await choose(conflict);await panel.locator('.vault-error').waitFor();
    const conflictText=await panel.locator('.vault-error').innerText();assert.match(conflictText,/storageConflict|已有|already/i);
    assert.equal(await invoke('get_storage_epoch'),epoch);assert.equal(canonical(await invoke('get_storage_path')),canonical(source));
    assert.deepEqual(inspect(path.join(conflict,'data.db')),conflictBefore);
    record('ordinary target with a note refuses overwrite; original source and target preserved',{error:conflictText,epoch});
    fixture({action:'fault',database});fault=true;
    await choose(target);await panel.locator('.vault-error').waitFor();
    const routingText=await panel.locator('.vault-error').innerText();assert.match(routingText,/storageMigrationFailed|迁移|migration/i);
    assert.equal(await invoke('get_storage_epoch'),epoch);assert.equal(canonical(await invoke('get_storage_path')),canonical(source));
    const staged=inspect(path.join(target,'data.db'));assert.ok(staged.settings.internal_storage_migration_receipt_v1);assert.equal(staged.notes.length,3);assert.equal(staged.historyExists,false);
    assert.equal(inspect(database).historyExists,true);
    record('target committed but injected source route write failed; old connection/epoch and receipt retained',{error:routingText,epoch});
    const original=notes[0].note,newBody=body+'edited while routing failed';
    const edited=(await invoke('save_note',{expectedStorageEpoch:epoch,id:original.id,expectedRevision:original.revision,mutationId:randomUUID(),draft:{title:original.title,body:newBody,refs:original.refs}})).value.note;
    fixture({action:'unfault',database});fault=false;
    await choose(target);await panel.getByRole('button',{name:'立即重启',exact:true}).waitFor();
    const oldEpoch=epoch;epoch=await invoke('get_storage_epoch');assert.ok(epoch>oldEpoch);
    assert.equal(canonical(await invoke('get_storage_path')),canonical(target));
    info={...info,storageRoot:target};fs.writeFileSync(metadata,JSON.stringify(info,null,2));
    const destination=inspect(path.join(target,'data.db'));assert.equal(destination.integrity,'ok');assert.equal(destination.settings.qa_existing_target,'keep');assert.equal(destination.historyExists,false);
    for(const {state,note} of notes){
      const migrated=(await invoke('get_note',{expectedStorageEpoch:epoch,id:note.id})).value;
      assert.equal(migrated.body,state==='active'?newBody:body);assert.deepEqual(migrated.refs,note.refs);
      const raw=destination.notes.find(n=>n.id===note.id);assert.equal(raw.creation_mutation_id,note.creation_mutation_id||inspect(database).notes.find(n=>n.id===note.id).creation_mutation_id);
      assert.equal(raw.creation_hash,inspect(database).notes.find(n=>n.id===note.id).creation_hash);
      if(state==='archived')assert.notEqual(migrated.archived_at_ms,null);
      if(state==='trash')assert.notEqual(migrated.deleted_at_ms,null);
    }
    await assert.rejects(invoke('get_note',{expectedStorageEpoch:oldEpoch,id:original.id}),e=>e.code==='notes.storageChanged');
    await assert.rejects(invoke('save_note',{expectedStorageEpoch:oldEpoch,id:original.id,expectedRevision:edited.revision,mutationId:randomUUID(),draft:{title:original.title,body:'QA stale write',refs:[]}}),e=>e.code==='notes.storageChanged');
    assert.equal(fs.readFileSync(external,'utf8'),'QA storage external file unchanged');
    record('retry refreshes staged data with intervening source edit; target setting, protocol identities and references preserved',{epoch,clipboardHistoryCopied:false});
    await page.locator('.sidebar-nav').getByRole('button',{name:'便签',exact:true}).click();
    await page.locator('.notes-page').getByRole('searchbox').fill(original.title);
    await page.waitForFunction(()=>document.querySelectorAll('.notes-page .notes-scroll > .notes-row').length===1);
    const restartBody=newBody+'\nQA pending draft must survive native restart';
    // Exercise the actual coordinator and request_app_restart in the same JS task,
    // before its 500ms automatic-save timer can run.
    const restart=await page.evaluate(async({id,restartBody})=>{
      const resource=performance.getEntriesByType('resource').find(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name));
      const {useNotesWorkspace}=await import(resource.name);await useNotesWorkspace.getState().open(id);
      const state=useNotesWorkspace.getState();state.coordinator.edit(id,{body:restartBody});
      const pending=state.coordinator.getSession(id);const result={phase:pending.status,draft:pending.draft.body};
      await window.__TAURI_INTERNALS__.invoke('request_app_restart');return result;
    },{id:original.id,restartBody});
    assert.equal(restart.draft,restartBody);record('requested real native restart with a freshly pending coordinator draft',{oldPid:info.pid,phase:restart.phase});
    let newPid;
    for(let attempt=0;attempt<60;attempt++){
      await wait(500);
      const processes=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-Process -Name copy-creator-qa -ErrorAction SilentlyContinue | Select-Object Id,Path) | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:10000})||'[]');
      const matches=(Array.isArray(processes)?processes:[processes]).filter(p=>p&&canonical(p.Path||'')===canonical(info.exe)&&p.Id!==info.pid);
      if(matches.length===1){newPid=matches[0].Id;break}
    }
    assert.ok(newPid,'Native restart must create the replacement process');
    info={...info,pid:newPid};fs.writeFileSync(metadata,JSON.stringify(info,null,2));restore();
    let nextBrowser;
    for(let attempt=0;attempt<60;attempt++){
      try {nextBrowser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`,{timeout:1000});page=nextBrowser.contexts()[0].pages().find(p=>p.url()==='http://tauri.localhost/');if(page){await page.waitForFunction(()=>Boolean(window.__TAURI_INTERNALS__),null,{timeout:1000});break}} catch{}
      await wait(500);
    }
    assert.ok(page);epoch=await invoke('get_storage_epoch');assert.equal(canonical(await invoke('get_storage_path')),canonical(target));
    assert.equal((await invoke('get_note',{expectedStorageEpoch:epoch,id:original.id})).value.body,restartBody);
    assert.equal(inspect(path.join(target,'data.db')).notes.find(n=>n.id===original.id).body,restartBody);
    assert.equal(inspect(database).notes.find(n=>n.id===original.id).body,newBody);
    assert.equal(fs.readFileSync(external,'utf8'),'QA storage external file unchanged');
    record('replacement process follows source route and reopens target; pending draft persisted only to target',{newPid,epoch});
    report.passed=true;fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,reportPath,target,newPid,steps:report.steps.map(s=>s.step)}));
  } catch(error){record('failed',{error:typeof error==='object'?error.message||error: String(error)});throw error}
  finally {if(fault)fixture({action:'unfault',database});try{shell('operate-qa-dialog.ps1',['-Metadata',metadata,'-Action','cancel'])}catch{}try{restore()}catch{}}
  process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
