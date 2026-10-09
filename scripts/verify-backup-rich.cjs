// Actual settings UI, owned dialogs, synthetic near-limit images/vault/notes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),readline=require('node:readline');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`);let page;for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await wait(100)}assert.ok(page);page.setDefaultTimeout(60000);
 const invoke=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return {ok:false,error}}},{command,args});if(!result.ok)throw result.error;return result.value};
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const directory=path.join(root,'rich-backup',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
 const prefix='QA rich backup '+crypto.randomUUID(),loadPrefix='QA-backup-load-'+crypto.randomUUID(),imagePrefix='QA-images-'+crypto.randomUUID();
 const report={started:new Date().toISOString(),app:info,directory,prefix,loadPrefix,imagePrefix,steps:[],scope:'Complete default Release, actual settings UI/owned dialogs, only synthetic fixtures. No production passwords/keys or actual external content.'};
 const destination=path.join(root,'reports','backup-rich-'+Date.now()+'.json');
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({...request,database:path.join(info.storageRoot,'data.db')}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024}));
 const dialog=(action,file)=>execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'operate-qa-dialog.ps1'),'-Metadata',metadata,'-Action',action,...(file?['-FixturePath',file]:[])],{windowsHide:true,timeout:15000,stdio:'pipe'});
 const password='QA-only-rich-backup-password-2026',master='QA-only-rich-vault-master-2026';
 const phasePath=path.join(directory,'phase.txt'),stopPath=path.join(directory,'stop'),memoryPath=path.join(directory,'memory.jsonl');
 const monitor=spawn(process.env.QA_PYTHON,[path.join(__dirname,'monitor-qa-processes.py'),metadata,memoryPath,phasePath,stopPath],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},stdio:['ignore','pipe','pipe']});let monitorError='';monitor.stderr.on('data',data=>monitorError+=data);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Memory monitor timeout '+monitorError)),10000);readline.createInterface({input:monitor.stdout}).on('line',line=>{if(JSON.parse(line).ready){clearTimeout(timer);resolve()}});monitor.once('exit',code=>{if(code){clearTimeout(timer);reject(Error(monitorError))}})});
 const phase=name=>fs.writeFileSync(phasePath,name);let fault=false,load=false,images=false;
 try{
  phase('fixture');const statusVault=await invoke('get_vault_status');if(!statusVault.configured)await invoke('setup_vault',{masterPassword:master});else await invoke('unlock_vault',{masterPassword:master});
  const entries=[];for(let i=0;i<2;i++){
   const entry={id:'',title:prefix+' account '+i,website:'https://example.invalid/qa-rich',username:'QA synthetic user '+i,email:'qa@example.invalid',phone:'',password:'QA-SYNTHETIC-PRIVATE-'+crypto.randomUUID(),tags:['QA'],fields:[{id:crypto.randomUUID(),label:'QA recovery',value:'QA synthetic recovery '+i,sensitive:true}],verification:[{id:crypto.randomUUID(),kind:'recovery_codes',label:'QA recovery',value:'QA synthetic code '+i,note:'QA only'}],notes:'QA synthetic private notes',created_at:'',updated_at:''};
   entry.id=await invoke('save_vault_entry',{entry});entries.push(await invoke('get_vault_entry',{id:entry.id}));
  }
  const epoch=await invoke('get_storage_epoch'),noteId=crypto.randomUUID(),body='  '+prefix+'\r\n中文😀\rraw original  \n';
  let original=(await invoke('create_note',{expectedStorageEpoch:epoch,id:noteId,mutationId:crypto.randomUUID(),draft:{title:prefix,body,refs:[]}})).value.note;
  await invoke('set_setting',{key:'ai_api_key',value:'QA-synthetic-protected-key-'+crypto.randomUUID()});
  const imageLoad=fixture({action:'image_load',prefix:imagePrefix,count:12});images=true;for(const id of imageLoad.ids)await invoke('toggle_clipboard_favorite',{id});
  const imageHashes=Array.from({length:12},(_,i)=>crypto.createHash('sha256').update(fs.readFileSync(path.join(info.storageRoot,'images',imagePrefix+'-'+i+'.png'))).digest('hex'));
  const corpus=fixture({action:'backup_load',prefix:loadPrefix,targetBytes:72*1024*1024});load=true;
  record('near-limit synthetic notes, twelve favorite PNGs, two encrypted accounts and protected setting prepared',{notesAdded:corpus.ids.length,rawNoteBytes:corpus.afterRawBytes,imageBytes:imageLoad.encodedBytes,images:12,vault:2});
  execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'restore-qa-window.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:'ignore'});
  if(await page.locator('.lifecycle-error').isVisible())await page.locator('.lifecycle-error').getByRole('button').click();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'数据',exact:true}).click();
  const panel=page.getByRole('tabpanel',{name:'数据',exact:true}),status=panel.locator('.settings-transfer-status[role="status"]'),backup=path.join(directory,'rich-near-limit.ccbackup');
  phase('idle-before-export');await wait(1200);phase('rich-export');let started=Date.now();
  await panel.getByRole('button',{name:'导出',exact:true}).click();await panel.getByLabel('备份密码',{exact:true}).fill(password);await panel.getByLabel('确认备份密码',{exact:true}).fill(password);
  await panel.getByRole('button',{name:'创建加密备份',exact:true}).click();await wait(200);dialog('save',backup);await status.filter({hasText:'已导出'}).waitFor();
  const envelope=JSON.parse(fs.readFileSync(backup,'utf8')),payloadBytes=Buffer.from(envelope.payload.slice(3),'base64').length-28;
  assert.equal(envelope.version,3);assert.ok(payloadBytes<74*1024*1024&&payloadBytes>72*1024*1024);assert.ok(fs.statSync(backup).size<100*1024*1024);
  assert.equal(fs.readFileSync(backup).includes(Buffer.from(entries[0].password)),false);record('actual near-limit rich encrypted export',{elapsedMs:Date.now()-started,fileBytes:fs.statSync(backup).size,payloadBytes,payloadFraction:payloadBytes/(74*1024*1024)});
  phase('prepare-rollback');const exportModel=await invoke('get_setting',{key:'ai_model'});await invoke('set_setting',{key:'ai_model',value:'QA rich local model '+crypto.randomUUID()});
  original=(await invoke('save_note',{expectedStorageEpoch:epoch,id:noteId,expectedRevision:original.revision,mutationId:crypto.randomUUID(),draft:{title:prefix,body:body+'local retained',refs:[]}})).value.note;
  for(const entry of entries)await invoke('delete_vault_entry',{id:entry.id});fixture({action:'remove_image_load',prefix:imagePrefix});images=false;
  const before=fixture({action:'rich_backup_inspect'});fixture({action:'rich_backup_fault',prefix});fault=true;
  const choose=async file=>{await panel.getByRole('button',{name:'导入',exact:true}).click();await wait(200);dialog('select',file);await panel.getByLabel('备份密码',{exact:true}).waitFor();await panel.getByLabel('备份密码',{exact:true}).fill(password)};
  phase('rich-preview');started=Date.now();await choose(backup);await panel.getByRole('button',{name:'查看备份内容',exact:true}).click();await panel.getByRole('button',{name:'确认导入',exact:true}).waitFor();record('actual rich authenticated preview',{elapsedMs:Date.now()-started,preview:await panel.locator('.settings-backup-preview').innerText()});
  phase('rich-rollback');started=Date.now();await panel.getByRole('button',{name:'确认导入',exact:true}).click();await status.filter({hasText:'失败'}).waitFor();assert.deepEqual(fixture({action:'rich_backup_inspect'}),before);
  assert.equal(await invoke('get_storage_epoch'),epoch);record('note-insert failure atomically rolls back settings, images, vault and search maps; staged files removed',{elapsedMs:Date.now()-started,integrity:before.integrity});
  fixture({action:'rich_backup_unfault'});fault=false;
  phase('rich-import');started=Date.now();await panel.getByRole('button',{name:'确认导入',exact:true}).click();await status.filter({hasText:'已导入'}).waitFor();
  const importedEpoch=await invoke('get_storage_epoch');assert.ok(importedEpoch>epoch);assert.equal(await invoke('get_setting',{key:'ai_model'}),exportModel);
  assert.equal((await invoke('get_vault_status')).unlocked,false);await assert.rejects(invoke('get_vault_entry',{id:entries[0].id}),error=>error==='vault.locked');await invoke('unlock_vault',{masterPassword:master});
  for(const entry of entries)assert.deepEqual(await invoke('get_vault_entry',{id:entry.id}),entry);
  const restored=(await invoke('get_clipboard_records',{category:'image',limit:100})).filter(row=>row.source_app===imagePrefix);assert.equal(restored.length,12);
  const afterHashes=restored.map(row=>crypto.createHash('sha256').update(fs.readFileSync(path.join(info.storageRoot,row.content))).digest('hex')).sort();assert.deepEqual(afterHashes,[...imageHashes].sort());
  const matches=(await invoke('list_notes',{expectedStorageEpoch:importedEpoch,filter:'active',search:prefix,cursor:null,limit:100})).value.records;assert.equal(matches.length,2);
  assert.equal((await invoke('get_note',{expectedStorageEpoch:importedEpoch,id:noteId})).value.body,body+'local retained');assert.equal((await invoke('get_note',{expectedStorageEpoch:importedEpoch,id:matches.find(n=>n.id!==noteId).id})).value.body,body);
  record('actual rich retry restores all images/account fields, retains local note and creates raw conflict copy',{elapsedMs:Date.now()-started,epoch:importedEpoch,images:12,vault:2,status:await status.innerText()});
  phase('rich-repeat');await choose(backup);await panel.getByRole('button',{name:'查看备份内容',exact:true}).click();await panel.getByRole('button',{name:'确认导入',exact:true}).waitFor();assert.match(await panel.locator('.settings-backup-preview').innerText(),/0 个冲突副本/);
  await panel.getByRole('button',{name:'确认导入',exact:true}).click();await status.filter({hasText:'已导入'}).waitFor();assert.equal((await invoke('get_vault_status')).unlocked,false);record('repeat rich import skips existing account/note origins without duplicates');
  phase('rich-tamper');const tampered=path.join(directory,'rich-tampered.ccbackup');const bytes=Buffer.from(envelope.payload.slice(3),'base64');bytes[bytes.length-17]^=1;fs.writeFileSync(tampered,JSON.stringify({...envelope,payload:'v1:'+bytes.toString('base64')}));
  const beforeTamper=fixture({action:'rich_backup_inspect'});await choose(tampered);await panel.getByRole('button',{name:'查看备份内容',exact:true}).click();await status.filter({hasText:'备份密码错误'}).waitFor();assert.equal(await panel.getByRole('button',{name:'确认导入',exact:true}).count(),0);assert.deepEqual(fixture({action:'rich_backup_inspect'}),beforeTamper);record('near-limit ciphertext tampering refuses preview and leaves DB/files unchanged');
  report.passed=true;
 }catch(error){record('failed',{error:error.message||error});throw error}
 finally{
  try{dialog('cancel')}catch{}if(fault)fixture({action:'rich_backup_unfault'});if(load)record('own near-limit notes removed',fixture({action:'remove_backup_load',prefix:loadPrefix}));
  record('own original or restored image fixtures removed',fixture({action:'remove_rich_images',prefix:imagePrefix}));
  fs.writeFileSync(stopPath,'stop');await new Promise(resolve=>{if(monitor.exitCode!==null)resolve();else monitor.once('exit',resolve)});
  const summary={};for(const row of fs.readFileSync(memoryPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)){const item=summary[row.phase]||={samples:0,treePeakPrivateBytes:0,nativePeakPrivateBytes:0};item.samples++;item.treePeakPrivateBytes=Math.max(item.treePeakPrivateBytes,row.privateBytes);item.nativePeakPrivateBytes=Math.max(item.nativePeakPrivateBytes,row.processes.find(p=>p.pid===info.pid)?.privateBytes||0)}
  report.memory={intervalMs:100,scope:'Verified QA and descendants, observed peaks; driver/KDF fixture generator excluded',monitorError,summary};report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:Boolean(report.passed),report:destination,memory:report.memory}));
 }
 process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
