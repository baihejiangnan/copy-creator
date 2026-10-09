// Native semantics and boundary-save acceptance for the guarded search binary.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const defaultQa=process.argv[2]==='default';
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007',defaultQa?'':'search-runtime-qa');
const stats=values=>{const sorted=[...values].sort((a,b)=>a-b),at=p=>sorted[Math.ceil(sorted.length*p)-1];return {samples:values.length,p50_ms:at(.5),p95_ms:at(.95),p99_ms:at(.99),max_ms:at(1)}};
(async()=>{
 const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,defaultQa?'com.copycreator.qa20261007':'com.copycreator.qa20261007search');
 if(defaultQa){assert.equal(path.resolve(info.exe),path.join(root,'copy-creator-qa.exe'));assert.ok(require('./qa-path.cjs')(info.storageRoot).startsWith(require('./qa-path.cjs')(path.join(root,'storage-fixtures'))+'\\'));}
 else assert.equal(path.resolve(info.storageRoot),path.join(root,'storage'));
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`);
 let page;for(let attempt=0;attempt<100;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await new Promise(r=>setTimeout(r,100))}assert.ok(page);
 assert.equal(require('./qa-path.cjs')(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'))),require('./qa-path.cjs')(info.storageRoot));
 const prefix='QA-search-native-'+crypto.randomUUID();
 const report={app:info,prefix,started:new Date().toISOString(),scope:(defaultQa?'Complete default Release with user-authorized clipboard-preserving wrapper. ':'Independent guarded QA binary only. ')+'Native IPC, no debugger hooks. Does not prove physical IME, backup UI or 50k migration.'};
 const destination=path.join(root,`native-acceptance-${Date.now()}.json`);
 try {
  report.result=await page.evaluate(async prefix=>{
   const invoke=window.__TAURI_INTERNALS__.invoke,epoch=await invoke('get_storage_epoch'),uid=()=>crypto.randomUUID();
   const call=async(command,args)=>{const result=await invoke(command,{expectedStorageEpoch:epoch,...args});return result.value};
   const list=async(search,filter='active')=>(await call('list_notes',{search,filter,cursor:null,limit:100})).records;
   const id=uid(),mutationId=uid(),refId=uid();
   let draft={title:prefix,body:`${prefix} 中文𠮷😀 abcDEF 100% _ \\ ' " OR AND * before\0after\n保留\r\n空白  `,
    refs:[{id:refId,kind:'url',target:`https://example.com/${prefix}/only-reference`,display_name:'文件引用 中文'}]};
   const createArgs={id,mutationId,draft};let current=(await call('create_note',createArgs)).note;
   const retry=await call('create_note',createArgs);if(retry.applied||retry.note.id!==id)throw Error('Creation retry duplicated');
   const checks=[];
   for(const query of ['中文','𠮷😀','abcdeF','100%',' _ ','\\','" OR AND','before\0different',prefix+'/only-reference','文件引用']){
    if(!(await list(query)).some(note=>note.id===id))throw Error('Literal/short/NUL/reference query missed '+JSON.stringify(query));checks.push(query);
   }
   if((await list(prefix+'-absent')).some(note=>note.id===id))throw Error('Absent search matched');
   draft={title:prefix,body:prefix+' replacement-new-token',refs:[]};
   current=(await call('save_note',{id,expectedRevision:current.revision,mutationId:uid(),draft})).note;
   if((await list('" OR AND')).some(note=>note.id===id)||(await list(prefix+'/only-reference')).some(note=>note.id===id))throw Error('Stale body/ref token survived');
   if(!(await list('replacement-new-token')).some(note=>note.id===id))throw Error('Updated token missing');
   const conflict=await invoke('save_note',{expectedStorageEpoch:epoch,id,expectedRevision:1,mutationId:uid(),draft}).then(()=>null,error=>error);
   if(conflict?.code!=='notes.conflict')throw Error('Revision guard failed '+JSON.stringify(conflict));
   for(const [action,filter] of [['archive','archived'],['unarchive','active'],['delete','trash'],['restore','active']]){
    current=(await call('set_note_state',{id,expectedRevision:current.revision,mutationId:uid(),action})).note;
    if(!(await list(prefix,filter)).some(note=>note.id===id))throw Error('State-filter search failed '+action);
    if(filter!=='active'&&(await list(prefix)).some(note=>note.id===id))throw Error('Inactive search leaked '+action);
   }
   const refs=Array.from({length:20},(_,i)=>({id:uid(),kind:'url',target:`https://example.com/${prefix}/reference-${i}`,display_name:'引用 '+i}));
   const body='中A'.repeat(65000),saveSamples=[];
   for(let index=0;index<110;index++){
    const start=performance.now();current=(await call('save_note',{id,expectedRevision:current.revision,mutationId:uid(),draft:{title:prefix,body:body+'\n'+index,refs}})).note;
    if(index>=10)saveSamples.push(performance.now()-start);
   }
   if(current.body!==body+'\n109'||current.refs.length!==20)throw Error('Boundary data changed');
   if(!(await list(prefix+'/reference-19')).some(note=>note.id===id))throw Error('Last reference missing');
   const stale=await invoke('get_note',{expectedStorageEpoch:epoch-1,id}).then(()=>null,error=>error);
   if(stale?.code!=='notes.storageChanged')throw Error('Epoch guard failed '+JSON.stringify(stale));
   return {id,checks,creationRetry:true,conflict:true,stateFilters:true,staleEpoch:true,bodyBytes:new TextEncoder().encode(current.body).length,refs:current.refs.length,saveSamples,revision:current.revision};
  },prefix);
  report.result.save=stats(report.result.saveSamples);delete report.result.saveSamples;report.passed=true;
 }catch(error){report.error=error.stack;throw error}
 finally{report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({report:destination,passed:report.passed,result:report.result}));}
 process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
