// Actual default startup TTL, shared assets and image/thumb reclamation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),metadata=path.join(root,'process.json'),wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 let info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.autostartIsolation,'identifier');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 let page;const connect=async()=>{const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`);for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await wait(100)}assert.ok(page);assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));};
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});await connect();
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({database:path.join(info.storageRoot,'data.db'),...request}),env:{...process.env,PYTHONUTF8:'1'},windowsHide:true,encoding:'utf8',maxBuffer:1024*1024}));
 const shell=file=>new Promise((resolve,reject)=>{
  const child=spawn(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,file),'-Metadata',metadata],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';
  const timer=setTimeout(()=>{child.kill();reject(Error(file+' timeout '+error))},30000);
  child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>error+=value);child.once('error',failure=>{clearTimeout(timer);reject(failure)});child.once('exit',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(file+' failed '+error))});
 });
 const prefix='QA-cleanup-'+crypto.randomUUID(),imagePrefix='QA-images-'+crypto.randomUUID(),sentinel='QA controlled clipboard cleanup '+crypto.randomUUID();
 const report={started:new Date().toISOString(),app:info,steps:[],scope:'Unmodified default Release startup TTL function and actual thumbnails. No accelerated clock, periodic-hour scheduling or concurrent-save claim. Only synthetic fixtures; original clipboard held by wrapper.'},destination=path.join(root,'reports','ttl-images-'+Date.now()+'.json');
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 let loaded,prepared,images=false;
 try{
  const before=fixture({action:'storage_snapshot'});loaded=fixture({action:'cleanup_load',prefix});images=true;const imageLoad=fixture({action:'image_load',prefix:imagePrefix,count:12});
  for(let i=0;i<12;i++)await invoke('get_image_thumbnail',{path:`images/${imagePrefix}-${i}.png`,maxSize:160,expectedStorageEpoch:await invoke('get_storage_epoch')});
  prepared=fixture({action:'ttl_prepare',prefix,imagePrefix});const baseline=fixture({action:'ttl_inspect',prefix,imagePrefix});
  const hashes=new Map(prepared.paths.map(relative=>[relative,crypto.createHash('sha256').update(fs.readFileSync(path.join(info.storageRoot,relative))).digest('hex')]));
  record('2000 expired normal texts, 12 image records and thumbnails prepared; 60 protected texts and shared favorite image',{normalTexts:2000,normalImages:12,protectedTexts:60,sharedProtectedImages:1,imageBytes:imageLoad.encodedBytes});
  await shell('stop-saved-qa.ps1');const started=Date.now();await shell('launch-saved-qa.ps1');const launchCommandMs=Date.now()-started;info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));await connect();const nativeReadyObservedMs=Date.now()-info.launchStartedUnixMs;
  const after=fixture({action:'ttl_inspect',prefix,imagePrefix});assert.equal(after.baselineClipboardHash,baseline.baselineClipboardHash);assert.equal(after.foreignKeyViolations,0);assert.equal(after.integrity,'ok');
  const groups=new Map(after.groups.map(([type,favorite,manual,label,count])=>[[type,favorite,manual,label].join(','),count]));
  assert.equal(groups.get('text,0,0,0')||0,0);assert.equal(groups.get('image,0,0,0')||0,0);for(const key of ['text,1,0,0','text,0,1,0','text,0,0,1'])assert.equal(groups.get(key),20);assert.equal(groups.get('image,1,0,0'),1);
  for(const relative of prepared.paths){const file=path.join(info.storageRoot,relative),thumb=path.join(info.storageRoot,'images','thumbs',path.basename(relative));if(relative===prepared.sharedProtectedPath){assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hashes.get(relative));assert.ok(fs.existsSync(thumb))}else{assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(thumb),false)}}
  const afterBusiness=fixture({action:'storage_snapshot'});for(const table of ['notes','note_refs','note_import_origins','vault_config','vault_entries'])assert.equal(afterBusiness.hashes[table],before.hashes[table]);
  record('default startup TTL removes 2012 unprotected records and eleven unreferenced original/thumb pairs',{launchCommandMs,nativeReadyObservedMs,totalThroughInspectionMs:Date.now()-started,timingScope:'Observed upper bounds include launch/CDP overhead; single sample, not a startup distribution',groups:after.groups,baselineClipboardUnchanged:true,notesRefsOriginsAndVaultUnchanged:true,sharedFavoriteImageAndThumbUnchanged:true,foreignKeyViolations:0,integrity:'ok'});report.passed=true;
 }catch(error){report.error=error.message||JSON.stringify(error);record('failed',{error:report.error});throw error}
 finally{
  if(images)record('only owned remaining images removed',fixture({action:'remove_image_load',prefix:imagePrefix}));
  if(loaded)record('only owned text fixtures removed; original limits restored',fixture({action:'remove_cleanup_load',prefix,sentinel,settings:loaded.settings}));
  if(prepared)fixture({action:'ttl_restore',prefix,imagePrefix,settings:{...prepared.settings,...loaded.settings}});
  report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));
 }
 process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
