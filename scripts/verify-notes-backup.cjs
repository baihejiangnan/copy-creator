// Native encrypted export/import through the actual settings UI and dialogs.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
const metadata=path.join(root,'process.json');
const powershell=process.env.QA_POWERSHELL;
assert.ok(powershell&&fs.existsSync(powershell),'Set QA_POWERSHELL');
const dialog=(action,fixture)=>execFileSync(powershell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'operate-qa-dialog.ps1'),'-Metadata',metadata,'-Action',action,...(fixture?['-FixturePath',fixture]:[])],{encoding:'utf8',timeout:15000,windowsHide:true,stdio:['ignore','pipe','pipe']});
const restore=()=>execFileSync(powershell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'restore-qa-window.ps1'),'-Metadata',metadata],{encoding:'utf8',timeout:10000,windowsHide:true});
(async()=>{
  const info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');
  assert.equal(String(info.debugPort),new URL(process.env.QA_CDP_URL).port);
  const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL,{timeout:5000});
  const page=browser.contexts()[0].pages().find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);page.setDefaultTimeout(15000);
  const storage=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'));
  assert.equal(require('./qa-path.cjs')(storage),require('./qa-path.cjs')(process.env.QA_STORAGE_ROOT));
  const directory=path.join(root,'backup-fixtures',randomUUID());fs.mkdirSync(directory,{recursive:true});
  const backupPath=path.join(directory,'中文 备份,往返.ccbackup');
  const external=path.join(directory,'外部文件,保留.txt');fs.writeFileSync(external,'Synthetic external file, never backed up.');
  const prefix=`QA备份 ${randomUUID()}`,body='  QA backup raw 中文😀\r\nsecond\rlast  \n';
  // Public synthetic test password; never use a user's password here.
  const password='QA-only-synthetic-backup-password-2026';
  const report={time:new Date().toISOString(),app:info,directory,steps:[]};
  const reportPath=path.join(root,'reports',`backup-${Date.now()}.json`);
  const record=(step,data={})=>{report.steps.push({time:new Date().toISOString(),step,...data});fs.writeFileSync(reportPath,JSON.stringify(report,null,2));};
  const invoke=async(command,args={})=>{
    const result=await page.evaluate(async({command,args})=>{
      try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}
      catch(error){return {ok:false,error};}
    },{command,args});
    if(!result.ok)throw result.error;return result.value;
  };
  let fixtures;
  try {
    fixtures=await page.evaluate(async({prefix,body,external})=>{
      const invoke=window.__TAURI_INTERNALS__.invoke,epoch=await invoke('get_storage_epoch');const result=[];
      for(const state of ['active','archived','trash']){
        let note=(await invoke('create_note',{expectedStorageEpoch:epoch,id:crypto.randomUUID(),mutationId:crypto.randomUUID(),draft:{title:prefix+' '+state,body,refs:[{id:crypto.randomUUID(),kind:'file',target:external,display_name:'外部文件,保留.txt'}]}})).value.note;
        if(state!=='active')note=(await invoke('set_note_state',{expectedStorageEpoch:epoch,id:note.id,expectedRevision:note.revision,mutationId:crypto.randomUUID(),action:state==='trash'?'delete':'archive'})).value.note;
        result.push({state,note});
      }
      return result;
    },{prefix,body,external});
    record('created active/archive/trash synthetic fixtures');restore();
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'数据',exact:true}).click();
    const panel=page.getByRole('tabpanel',{name:'数据',exact:true});
    const status=panel.locator('.settings-transfer-status[role="status"]');
    await panel.getByRole('button',{name:'导出',exact:true}).click();
    await panel.getByLabel('备份密码',{exact:true}).fill(password);await panel.getByLabel('确认备份密码',{exact:true}).fill(password);
    await panel.getByRole('button',{name:'创建加密备份',exact:true}).click();await new Promise(resolve=>setTimeout(resolve,550));
    assert.equal(await invoke('plugin:window|is_visible',{label:'main'}),true);dialog('save',backupPath);
    await status.filter({hasText:'已导出'}).waitFor();
    const encrypted=fs.readFileSync(backupPath),envelope=JSON.parse(encrypted.toString('utf8'));
    assert.equal(envelope.version,3);assert.equal(encrypted.includes(Buffer.from(body)),false);
    assert.equal(fs.readFileSync(external,'utf8'),'Synthetic external file, never backed up.');
    record('v3 encrypted export through real save dialog',{bytes:encrypted.length,status:await status.innerText()});
    const original=fixtures.find(f=>f.state==='active').note;
    let epoch=await invoke('get_storage_epoch');
    await invoke('save_note',{expectedStorageEpoch:epoch,id:original.id,expectedRevision:original.revision,mutationId:randomUUID(),draft:{title:original.title,body:body+'local edit after export',refs:original.refs}});
    const choose=async()=>{
      await panel.getByRole('button',{name:'导入',exact:true}).click();await new Promise(resolve=>setTimeout(resolve,550));dialog('select',backupPath);
      await panel.getByLabel('备份密码',{exact:true}).waitFor();
    };
    await choose();await panel.getByLabel('备份密码',{exact:true}).fill('QA-wrong-password');await panel.getByRole('button',{name:'查看备份内容',exact:true}).click();
    await status.filter({hasText:'备份密码错误'}).waitFor();
    assert.equal(await panel.getByRole('button',{name:'确认导入',exact:true}).count(),0);
    record('wrong password refuses preview/import');
    await panel.getByLabel('备份密码',{exact:true}).fill(password);await panel.getByRole('button',{name:'查看备份内容',exact:true}).click();
    await panel.getByRole('button',{name:'确认导入',exact:true}).waitFor();
    const preview=await panel.locator('.settings-backup-preview').innerText();assert.match(preview,/1 个冲突副本/);
    record('preview reports exactly one changed-note conflict',{preview});
    await panel.getByRole('button',{name:'确认导入',exact:true}).click();await status.filter({hasText:'已导入'}).waitFor();
    const oldEpoch=epoch;
    epoch=await invoke('get_storage_epoch');
    assert.ok(epoch>oldEpoch);
    await assert.rejects(invoke('get_note',{expectedStorageEpoch:oldEpoch,id:original.id}),error=>error.code==='notes.storageChanged');
    const retained=(await invoke('get_note',{expectedStorageEpoch:epoch,id:original.id})).value;
    assert.equal(retained.body,body+'local edit after export');
    await assert.rejects(invoke('save_note',{expectedStorageEpoch:oldEpoch,id:original.id,expectedRevision:retained.revision,mutationId:randomUUID(),draft:{title:original.title,body:'QA stale write must be rejected',refs:[]}}),error=>error.code==='notes.storageChanged');
    const matches=(await invoke('list_notes',{expectedStorageEpoch:epoch,filter:'active',search:original.title,cursor:null,limit:100})).value.records;
    assert.equal(matches.length,2);
    const copy=(await invoke('get_note',{expectedStorageEpoch:epoch,id:matches.find(n=>n.id!==original.id).id})).value;
    assert.equal(copy.body,body);assert.equal(copy.refs[0].target,external);assert.notEqual(copy.refs[0].id,original.refs[0].id);
    const archived=fixtures.find(f=>f.state==='archived').note,trash=fixtures.find(f=>f.state==='trash').note;
    assert.notEqual((await invoke('get_note',{expectedStorageEpoch:epoch,id:archived.id})).value.archived_at_ms,null);
    assert.notEqual((await invoke('get_note',{expectedStorageEpoch:epoch,id:trash.id})).value.deleted_at_ms,null);
    record('import retains local text, restores raw conflict copy with remapped reference, archive/trash remain correct',{epoch,originalId:original.id,copyId:copy.id,status:await status.innerText()});
    await choose();await panel.getByLabel('备份密码',{exact:true}).fill(password);await panel.getByRole('button',{name:'查看备份内容',exact:true}).click();
    await panel.getByRole('button',{name:'确认导入',exact:true}).waitFor();
    const repeated=await panel.locator('.settings-backup-preview').innerText();assert.match(repeated,/0 个冲突副本/);
    await panel.getByRole('button',{name:'确认导入',exact:true}).click();await status.filter({hasText:'已导入'}).waitFor();
    epoch=await invoke('get_storage_epoch');
    assert.equal((await invoke('list_notes',{expectedStorageEpoch:epoch,filter:'active',search:original.title,cursor:null,limit:100})).value.records.length,2);
    assert.equal(fs.readFileSync(external,'utf8'),'Synthetic external file, never backed up.');
    record('repeat import deduplicates conflict origin; external file unchanged',{preview:repeated,status:await status.innerText()});
    await page.locator('.sidebar-nav').getByRole('button',{name:'便签',exact:true}).click();
    const notes=page.locator('.notes-page');await notes.getByRole('button',{name:'便签',exact:true}).click();
    await notes.getByRole('searchbox').fill(original.title);
    await page.waitForFunction(()=>document.querySelectorAll('.notes-page .notes-scroll > .notes-row').length===2);
    const workspaceEpoch=await page.evaluate(async()=>{
      const entry=performance.getEntriesByType('resource').find(entry=>/\/notesWorkspace-[^/]+\.js$/.test(entry.name));
      const {useNotesWorkspace}=await import(entry.name);return useNotesWorkspace.getState().coordinator.storageEpoch;
    });assert.equal(workspaceEpoch,epoch);
    record('old-epoch read/write rejected and post-import UI reloads two current summaries',{epoch});
    report.passed=true;fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,reportPath,bytes:encrypted.length,steps:report.steps.map(s=>s.step)}));
  } catch(error){report.failure=error.message;record('failed');throw error;}
  finally {try{dialog('cancel');}catch{}restore();}
  process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
