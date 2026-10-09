// Same synthetic image bytes and native operations for compiler-profile comparison.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const distribution=values=>{const sorted=[...values].sort((a,b)=>a-b),at=p=>sorted[Math.ceil(sorted.length*p)-1];return {samples:sorted.length,p50_ms:at(.5),p95_ms:at(.95),p99_ms:at(.99),max_ms:at(1)}};
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.ok(path.resolve(info.exe).startsWith(root+path.sep));
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 assert.equal(String(info.debugPort),new URL(process.env.QA_CDP_URL).port);
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);let page;
 for(let attempt=0;attempt<100;attempt++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await wait(100)}assert.ok(page);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({...request,database:path.join(info.storageRoot,'data.db')}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true,maxBuffer:1024*1024}));
 const prefix='QA-images-'+crypto.randomUUID(),noteTitle='QA native profile '+crypto.randomUUID();
 const report={started:new Date().toISOString(),app:info,steps:[],scope:'Same seeded 1024x768 PNG corpus, 110 sequential IPC calls with first 10 excluded. Thumbnail calls use different uncached paths; preview calls always decode/encode. Synthetic vault master only. No debugger breakpoints, startup or all-feature acceptance claim.'};
 const destination=path.join(root,'reports','native-profile-'+Date.now()+'.json'),record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 let images=false;
 try{
  const loaded=fixture({action:'image_load',prefix,count:110,seed:'QA-native-profile-fixed-images-v1'});images=true;
  const hashes=Array.from({length:110},(_,i)=>crypto.createHash('sha256').update(fs.readFileSync(path.join(info.storageRoot,'images',prefix+'-'+i+'.png'))).digest('hex'));
  const {ids,...imageMetadata}=loaded;assert.equal(ids.length,110);record('same seeded image fixture',{...imageMetadata,corpusSha256:crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex')});
  const epoch=await invoke('get_storage_epoch'),status=await invoke('get_vault_status');assert.equal(status.configured,true);
  await invoke('lock_vault');
  const draft={title:noteTitle,body:'QA native profile raw 中文😀\r\n  '+('body '.repeat(800)),refs:[]};
  const created=await invoke('create_note',{expectedStorageEpoch:epoch,id:crypto.randomUUID(),mutationId:crypto.randomUUID(),draft});
  for(const stage of ['save','thumbnail','preview','argon2-unlock']){
   const result=await page.evaluate(async({epoch,note,draft,prefix,stage})=>{
    const invoke=window.__TAURI_INTERNALS__.invoke,samples=[];let current=(await invoke('get_note',{expectedStorageEpoch:epoch,id:note.id})).value,outputBytes=0;
    for(let index=0;index<110;index++){
     const start=performance.now();let result;
     if(stage==='save')result=await invoke('save_note',{expectedStorageEpoch:epoch,id:note.id,expectedRevision:current.revision,mutationId:crypto.randomUUID(),draft:{...draft,body:draft.body+'\n'+index}});
     else if(stage==='argon2-unlock')result=await invoke('unlock_vault',{masterPassword:'QA-only-rich-vault-master-2026'});
     else result=await invoke(stage==='thumbnail'?'get_image_thumbnail':'get_image_base64',{expectedStorageEpoch:epoch,path:'images/'+prefix+'-'+index+'.png',maxSize:stage==='thumbnail'?264:1600});
     samples.push(performance.now()-start);
     if(stage==='save')current=result.value.note;
     else if(stage==='argon2-unlock')await invoke('lock_vault');
     else {const raw=atob(result);if(raw.slice(1,4)!=='PNG')throw Error('PNG output required');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20);if(stage==='thumbnail'?(width!==264||height!==198):(width!==1024||height!==768))throw Error('Image dimensions changed');outputBytes+=bytes.length;}
    }
    return {samples,outputBytes,revision:current.revision};
   },{epoch,note:created.value.note,draft,prefix,stage});
   record(stage,{latency:distribution(result.samples.slice(10)),outputBytes:result.outputBytes,revision:result.revision});
  }
  const saved=(await invoke('get_note',{expectedStorageEpoch:epoch,id:created.value.note.id})).value;assert.equal(saved.body,draft.body+'\n109');assert.equal(saved.revision,111);
  report.passed=true;record('passed');
 }catch(error){report.error=error.message||JSON.stringify(error);record('failed',{error:report.error});throw error}
 finally{await invoke('lock_vault').catch(()=>{});if(images)record('own image fixtures removed',fixture({action:'remove_image_load',prefix}))}
 console.log(JSON.stringify({passed:true,report:destination}));process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
