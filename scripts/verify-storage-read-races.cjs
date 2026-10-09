// Hold actual old-store read replies across a native directory migration.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const metadata=path.join(root,'process.json');let info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.autostartIsolation,'identifier');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);let page;for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await wait(100)}assert.ok(page);page.setDefaultTimeout(20000);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({database:path.join(info.storageRoot,'data.db'),...request}),env:{...process.env,PYTHONUTF8:'1'},windowsHide:true,encoding:'utf8',maxBuffer:1024*1024}));
 const shell=(file,args=[])=>execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,file),'-Metadata',metadata,...args],{windowsHide:true,timeout:15000,stdio:'pipe'});
 const marker=crypto.randomUUID(),clipId=crypto.randomUUID(),clipText='QA identity clipboard '+marker,translationText='QA identity translation '+marker,translationResult='QA old translated result '+marker,modelA='QA old settings '+marker,modelB='QA new settings '+marker;
 const target=path.join(root,'storage-fixtures',crypto.randomUUID(),'旧读取 响应,隔离'),destination=path.join(root,'reports','storage-read-races-'+Date.now()+'.json'),report={started:new Date().toISOString(),app:info,steps:[],scope:'Actual stores and genuine native read replies (including private synthetic vault detail and cached translation), held only in RAM through callback delivery. Actual native folder picker changes storage; no fabricated replies/events or external network.'};
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const originalModel=await invoke('get_setting',{key:'ai_model'}),oldEpoch=await invoke('get_storage_epoch');let armed=false;
 try{
  shell('restore-qa-window.ps1');fixture({action:'capture',records:[{id:clipId,type:'text',content:clipText,source_app:'QA identity read race'}]});
  const engine=(await invoke('get_setting',{key:'default_translate_engine'}))||'google';fixture({action:'translation_cache',id:crypto.randomUUID(),text:translationText,result:translationResult,engine});
  await invoke('unlock_vault',{masterPassword:'QA-only-rich-vault-master-2026'});const vaultId=(await invoke('list_vault_entries',{search:''}))[0].id;
  const group=await invoke('create_phrase_group',{name:'QA identity phrase '+marker});
  await page.locator('.sidebar-nav').getByRole('button',{name:'快捷短语',exact:true}).click();await page.getByRole('button',{name:group.name,exact:true}).waitFor();
  await page.evaluate(async()=>{
   const resource=pattern=>performance.getEntriesByType('resource').find(entry=>pattern.test(entry.name))?.name;
   const main=Object.values(await import(resource(/\/main-[^/]+\.js$/))),clip=Object.values(await import(resource(/\/clipboardStore-[^/]+\.js$/))),phrase=Object.values(await import(resource(/\/phraseStore-[^/]+\.js$/)));
   const settings=main.find(value=>value?.getState?.().loadSettings),vault=main.find(value=>value?.getState?.().openEntry),clipboard=clip.find(value=>value?.getState?.().loadRecords),phrases=phrase.find(value=>value?.getState?.().loadGroups);
   if(!settings||!vault||!clipboard||!phrases)throw Error('Expected actual shared stores');await vault.getState().initialize();await phrases.getState().loadGroups();window.__qaReads={settings,vault,clipboard,phrases};
  });
  await invoke('set_setting',{key:'ai_model',value:modelA});
  await page.evaluate(({clipId,groupId,vaultId,modelA,translationResult})=>{
   const q=window.__qaReads,callbacks=window.__TAURI_INTERNALS__.callbacks,originalSet=callbacks.set;q.callbacks=callbacks;q.originalSet=originalSet;q.held={};q.releases=[];
   callbacks.set=function(id,callback){return originalSet.call(this,id,data=>{let key;if(Array.isArray(data)&&data.some(item=>item.id===clipId))key='clipboard';else if(Array.isArray(data)&&data.some(item=>item.id===groupId))key='phrases';else if(data?.id===vaultId&&typeof data.password==='string')key='vault';else if(data?.ai_model===modelA)key='settings';else if(data?.target_text===translationResult)key='translation';if(key&&!q.held[key]){q.held[key]=true;let released=false;q.releases.push(()=>{if(!released){released=true;callback(data)}});return}callback(data)})};
   q.pending=[q.settings.getState().loadSettings(),q.phrases.getState().loadGroups(),q.vault.getState().openEntry(vaultId)];q.clipboard.getState().setCategory('all');q.clipboard.getState().setSearch('QA identity clipboard');q.clipboard.getState().setVisible(true);q.pending.push(q.clipboard.getState().loadRecords());
  },{clipId,groupId:group.id,vaultId,modelA,translationResult});armed=true;
  await page.locator('.sidebar-nav').getByRole('button',{name:'翻译',exact:true}).click();await page.locator('.translation-input').fill(translationText);await page.locator('.translate-btn').click();
  await page.waitForFunction(()=>Object.keys(window.__qaReads.held).length===5);record('five genuine old-store read replies held',{modules:['clipboard','phrases','settings','vault private detail','cached translation']});
  await invoke('set_setting',{key:'ai_model',value:modelB});fixture({action:'prepare',kind:'empty',database:path.join(target,'data.db')});
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'数据',exact:true}).click();const panel=page.getByRole('tabpanel',{name:'数据',exact:true});await panel.getByRole('button',{name:'更改',exact:true}).click();shell('operate-qa-dialog.ps1',['-Action','select','-FixturePath',target]);await panel.getByRole('button',{name:'立即重启',exact:true}).waitFor();
  assert.ok(await invoke('get_storage_epoch')>oldEpoch);assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(target));info={...info,storageRoot:target};fs.writeFileSync(metadata,JSON.stringify(info,null,2));
  await page.waitForFunction(model=>window.__qaReads.settings.getState().model===model,modelB);assert.equal((await invoke('get_vault_status')).unlocked,false);
  await page.evaluate(async()=>{const q=window.__qaReads;q.callbacks.set=q.originalSet;for(const release of q.releases)release();await Promise.all(q.pending)});armed=false;await wait(300);
  const after=await page.evaluate(({clipId,groupId,modelB})=>{const q=window.__qaReads;return {oldClipboardVisible:q.clipboard.getState().records.some(item=>item.id===clipId),oldGroupVisible:q.phrases.getState().groups.some(item=>item.id===groupId),settingsStillCurrent:q.settings.getState().model===modelB,privateDetailCleared:q.vault.getState().selected===null,vaultLocked:q.vault.getState().status?.unlocked===false}}, {clipId,groupId:group.id,modelB});
  assert.deepEqual(after,{oldClipboardVisible:false,oldGroupVisible:false,settingsStillCurrent:true,privateDetailCleared:true,vaultLocked:true});
  await page.locator('.sidebar-nav').getByRole('button',{name:'翻译',exact:true}).click();assert.equal(await page.locator('.translation-result .result-text').count(),0);assert.equal(await page.locator('.translation-error').count(),0);assert.equal(await page.locator('.translate-btn').isEnabled(),true);assert.equal(fixture({action:'translation_cache_count',text:translationText}).count,0);
  record('late replies cannot repopulate current lists, overwrite settings, reveal locked private data or publish old translation',{...after,oldTranslationPublished:false,targetTranslationHistoryWritten:false});
  report.passed=true;
 }catch(error){report.error=error.message||JSON.stringify(error);record('failed',{error:report.error,heldModules:await page.evaluate(()=>Object.keys(window.__qaReads?.held||{})).catch(()=>[])});throw error}
 finally{
  if(armed)await page.evaluate(()=>{const q=window.__qaReads;if(q?.callbacks){q.callbacks.set=q.originalSet;for(const release of q.releases)release()}}).catch(()=>{});
  await invoke('set_setting',{key:'ai_model',value:originalModel});await invoke('lock_vault');await page.evaluate(async()=>{const q=window.__qaReads;if(q)await q.settings.getState().loadSettings()}).catch(()=>{});report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));
 }
 process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
