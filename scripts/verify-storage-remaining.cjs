// Native folder picker: read-only target, changed staging receipt and encrypted joint move.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),metadata=path.join(root,'process.json');
(async()=>{
 let info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.autostartIsolation,'identifier');
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);let page;
 for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await new Promise(r=>setTimeout(r,100))}assert.ok(page);page.setDefaultTimeout(20000);
 const invoke=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return {ok:false,error}}},{command,args});if(!result.ok)throw result.error;return result.value};
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const source=info.storageRoot,database=path.join(source,'data.db'),directory=path.join(root,'storage-fixtures',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
 const targets={readonly:path.join(directory,'只读 目标,拒绝'),changed:path.join(directory,'暂存 已改,保留'),success:path.join(directory,'联合 搬迁,成功')};
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify(request),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true,maxBuffer:1024*1024}));
 const shell=(file,args=[])=>execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,file),'-Metadata',metadata,...args],{windowsHide:true,timeout:15000,stdio:'pipe'});
 const snapshot=db=>fixture({action:'storage_snapshot',database:db});
 const destination=path.join(root,'reports','storage-remaining-'+Date.now()+'.json'),report={started:new Date().toISOString(),app:info,steps:[],scope:'Complete default Release, actual settings folder picker, synthetic source and targets. Read-only file is a real Windows filesystem write denial, not an ACL/disk-full/volume failure simulation.'};
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const master='QA-only-rich-vault-master-2026';let fault=false,readOnly=false,epoch=await invoke('get_storage_epoch');
 try{
  assert.equal((await invoke('get_vault_status')).configured,true);await invoke('unlock_vault',{masterPassword:master});
  const summaries=await invoke('list_vault_entries',{search:''}),privateEntries=[];assert.ok(summaries.length>0);
  for(const entry of summaries)privateEntries.push(await invoke('get_vault_entry',{id:entry.id}));
  const sourceBefore=snapshot(database);assert.ok(sourceBefore.counts.notes>0);assert.ok(sourceBefore.counts.vault_entries>0);
  record('source fixture integrity and eligible migration scope',{counts:sourceBefore.counts,orphanOriginsExcluded:sourceBefore.orphanOriginsExcluded,foreignKeyViolations:sourceBefore.foreignKeyViolations,scope:'Only origin rows referencing existing notes migrate by design. Historical QA orphan provenance is unproven and retained; never silently counted as preserved.'});
  for(const target of Object.values(targets))fixture({action:'prepare',kind:'empty',database:path.join(target,'data.db')});
  shell('restore-qa-window.ps1');await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'数据',exact:true}).click();
  const panel=page.getByRole('tabpanel',{name:'数据',exact:true});
  const choose=async target=>{await panel.getByRole('button',{name:'更改',exact:true}).click();shell('operate-qa-dialog.ps1',['-Action','select','-FixturePath',target]);};
  const refused=async target=>{await choose(target);await panel.locator('.vault-error').waitFor();assert.equal(await invoke('get_storage_epoch'),epoch);assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(source));return await panel.locator('.vault-error').innerText()};
  const readonlyDb=path.join(targets.readonly,'data.db'),beforeFile=crypto.createHash('sha256').update(fs.readFileSync(readonlyDb)).digest('hex');
  fs.chmodSync(readonlyDb,0o444);readOnly=true;const readonlyError=await refused(targets.readonly);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(readonlyDb)).digest('hex'),beforeFile);assert.deepEqual(snapshot(database),sourceBefore);
  fs.chmodSync(readonlyDb,0o666);readOnly=false;record('real read-only target refuses writes; original connection, source and target file unchanged',{error:readonlyError,epoch});
  fixture({action:'fault',database});fault=true;const stagedError=await refused(targets.changed);
  const staged=snapshot(path.join(targets.changed,'data.db'));assert.equal(staged.hasReceipt,true);assert.deepEqual(staged.hashes,sourceBefore.hashes);assert.deepEqual(staged.counts,sourceBefore.counts);
  fixture({action:'storage_target_edit',database:path.join(targets.changed,'data.db')});const changed=snapshot(path.join(targets.changed,'data.db'));
  fixture({action:'unfault',database});fault=false;const changedError=await refused(targets.changed);assert.match(changedError,/已有|冲突|already|conflict/i);
  assert.deepEqual(snapshot(path.join(targets.changed,'data.db')),changed);assert.deepEqual(snapshot(database),sourceBefore);
  record('changed committed staging target refuses retry; notes, vault ciphertext and external edit retained',{stagedError,error:changedError,counts:changed.counts,integrity:changed.integrity});
  await invoke('unlock_vault',{masterPassword:master});await choose(targets.success);await panel.getByRole('button',{name:'立即重启',exact:true}).waitFor();
  const oldEpoch=epoch;epoch=await invoke('get_storage_epoch');assert.ok(epoch>oldEpoch);assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(targets.success));
  info={...info,storageRoot:targets.success};fs.writeFileSync(metadata,JSON.stringify(info,null,2));
  const moved=snapshot(path.join(targets.success,'data.db'));assert.deepEqual(moved.hashes,sourceBefore.hashes);assert.deepEqual(moved.counts,sourceBefore.counts);assert.deepEqual(moved.targetSetting,['keep']);assert.equal(moved.integrity,'ok');
  assert.equal(moved.foreignKeyViolations,0);assert.equal(moved.orphanOriginsExcluded,0);assert.equal((await invoke('get_vault_status')).unlocked,false);
  await assert.rejects(invoke('get_vault_entry',{id:privateEntries[0].id}),error=>/locked/i.test(String(error)));
  await invoke('unlock_vault',{masterPassword:master});for(const entry of privateEntries)assert.deepEqual(await invoke('get_vault_entry',{id:entry.id}),entry);
  await invoke('lock_vault');record('successful joint move preserves every eligible note/ref/origin, protected settings and vault ciphertext; old session locked; unlock returns identical synthetic entries',{counts:moved.counts,epoch,integrity:moved.integrity,foreignKeyViolations:moved.foreignKeyViolations,privateEntriesCompared:privateEntries.length});
  report.passed=true;
 }catch(error){report.error=error.message||JSON.stringify(error);record('failed',{error:report.error});throw error}
 finally{
  if(readOnly)fs.chmodSync(path.join(targets.readonly,'data.db'),0o666);
  if(fault)fixture({action:'unfault',database});await invoke('lock_vault').catch(()=>{});
  try{shell('operate-qa-dialog.ps1',['-Action','cancel'])}catch{}
  report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));
 }
 process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
