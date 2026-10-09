// Actual UI restore of self-generated v0/v1 JSON and encrypted v2 fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`);let page;for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await wait(100)}assert.ok(page);page.setDefaultTimeout(30000);
 const invoke=async(command,args={})=>{const r=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return {ok:false,error}}},{command,args});if(!r.ok)throw r.error;return r.value};
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const directory=path.join(root,'legacy-backup',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});const report={started:new Date().toISOString(),app:info,directory,steps:[]},destination=path.join(root,'reports','backup-legacy-'+Date.now()+'.json');
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({...request,database:path.join(info.storageRoot,'data.db')}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true}));
 const dialog=file=>execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'operate-qa-dialog.ps1'),'-Metadata',metadata,'-Action','select','-FixturePath',file],{windowsHide:true,timeout:15000,stdio:'pipe'});
 const backupPassword='QA-only-legacy-v2-backup-password';
 try{
  const epoch=await invoke('get_storage_epoch'),id=crypto.randomUUID(),body='QA existing note must survive legacy '+crypto.randomUUID();await invoke('create_note',{expectedStorageEpoch:epoch,id,mutationId:crypto.randomUUID(),draft:{title:'QA legacy survival',body,refs:[]}});
  const vaultBefore=fixture({action:'legacy_protection_status'});assert.equal(vaultBefore.settingProtected,true);
  execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'restore-qa-window.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:'ignore'});
  if(await page.locator('.lifecycle-error').isVisible())await page.locator('.lifecycle-error').getByRole('button').click();await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'数据',exact:true}).click();
  const panel=page.getByRole('tabpanel',{name:'数据',exact:true}),status=panel.locator('.settings-transfer-status[role="status"]');
  for(const version of [0,1,2]){
   const prefix='QA legacy v'+version+' '+crypto.randomUUID(),normalId=crypto.randomUUID(),keyId=crypto.randomUUID();
   const bundle={version,settings:{ai_model:prefix,ai_api_key:'QA-only-incoming-setting-'+version},favorites:[{id:normalId,type:'text',content:'  '+prefix+'\r\n原文  \n',source_app:'QA legacy fixture',created_at:'2026-10-01 00:00:00',favorite_note:'QA old favorite'},{id:keyId,type:'text',content:'QA-only-manual-protected-key-'+crypto.randomUUID(),source_app:'QA legacy protected',created_at:'2026-10-01 00:00:00',user_api_key:true,is_favorite:false}]};
   const file=path.join(directory,'legacy-v'+version+(version===2?'.ccbackup':'.json'));
   if(version===2){
    // Node's official argon2Sync API; same Argon2id-v19/AES-GCM contract as Rust.
    // https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html
    const salt=crypto.randomBytes(16),nonce=crypto.randomBytes(12),key=crypto.argon2Sync('argon2id',{message:backupPassword,nonce:salt,parallelism:1,tagLength:32,memory:65536,passes:3});
    try{const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('copy-creator/user-backup/v2/argon2id-v19-m65536-t3-p1/aes-256-gcm'));const encrypted=Buffer.concat([nonce,cipher.update(JSON.stringify(bundle),'utf8'),cipher.final(),cipher.getAuthTag()]);fs.writeFileSync(file,JSON.stringify({format:'copy-creator-encrypted-backup',version:2,kdf:'argon2id-v19-m65536-t3-p1',cipher:'aes-256-gcm',salt:salt.toString('base64'),payload:'v1:'+encrypted.toString('base64')}));}finally{key.fill(0)}
    assert.equal(fs.readFileSync(file).includes(Buffer.from(prefix)),false);
   }else fs.writeFileSync(file,JSON.stringify(bundle));
   const before=fixture({action:'legacy_protection_status'});await panel.getByRole('button',{name:'导入',exact:true}).click();await wait(200);dialog(file);
   await panel.getByRole('button',{name:'查看备份内容',exact:true}).waitFor();if(version===2)await panel.getByLabel('备份密码',{exact:true}).fill(backupPassword);
   await panel.getByRole('button',{name:'查看备份内容',exact:true}).click();await panel.getByRole('button',{name:'确认导入',exact:true}).waitFor();assert.match(await panel.locator('.settings-backup-preview').innerText(),/0 条便签/);
   await panel.getByRole('button',{name:'确认导入',exact:true}).click();await status.filter({hasText:'已导入'}).waitFor();const nextEpoch=await invoke('get_storage_epoch');
   assert.equal(await invoke('get_setting',{key:'ai_model'}),prefix);assert.equal(await invoke('get_clipboard_record_content',{id:normalId}),bundle.favorites[0].content);assert.equal((await invoke('get_note',{expectedStorageEpoch:nextEpoch,id})).value.body,body);
   await assert.rejects(invoke('capture_clipboard_as_note',{expectedStorageEpoch:nextEpoch,recordId:keyId,mutationId:crypto.randomUUID()}),error=>error.code==='notes.protectedSource');
   const after=fixture({action:'legacy_protection_status',recordId:keyId});assert.equal(after.recordProtected,true);assert.equal(after.settingProtected,true);assert.equal(after.vaultHash,before.vaultHash);
   if(version<2)assert.equal(after.settingHash,before.settingHash);else assert.notEqual(after.settingHash,before.settingHash);
   record('actual v'+version+' preview/import preserves existing note and vault, restores raw favorite and protects manual Key',{encrypted:version===2,epoch:nextEpoch,legacySecretIgnored:version<2,portableSettingReprotected:version===2});
  }
  report.passed=true;fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,report:destination}));
 }catch(error){record('failed',{error:error.message||error});throw error}
 process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
