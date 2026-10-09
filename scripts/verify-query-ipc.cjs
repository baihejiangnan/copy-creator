// Real current store/native IPC. R0 read-only reference uses its frozen source
// and the real Zustand vanilla state engine, without React mounting/listeners.
// Non-pausing CDP observation is for counts/semantics, never latency evidence.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const ts=require(require.resolve('typescript',{paths:[path.resolve(__dirname,'../copy-creator')]}));
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.nativeArtifact,'native-release-notes-scrollbars');assert.equal(info.profile,'release-default');
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const oldFile=path.resolve(__dirname,'../output/optimization/R0-20261007/source/copy-creator/src/stores/clipboardStore.ts'),oldSource=fs.readFileSync(oldFile,'utf8');
 const oldJs=ts.transpileModule(oldSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const vanillaFile=require.resolve('zustand/vanilla',{paths:[path.resolve(__dirname,'../copy-creator')]}),vanilla=fs.readFileSync(vanillaFile,'utf8');
 const destination=path.join(root,'reports','query-ipc-'+Date.now()+'.json'),report={started:new Date().toISOString(),app:info,steps:[],scope:'Actual production current store/native IPC on synthetic records. Frozen R0 store query source executes with real Zustand vanilla createStore and allowlisted native read adapter in the same current WebView/backend; no R0 React UI or historical executable claim. CDP conditional-breakpoint observation excludes all latency conclusions.',reference:{sourceSha256:crypto.createHash('sha256').update(oldSource).digest('hex'),vanillaSha256:crypto.createHash('sha256').update(vanilla).digest('hex')}};
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({database:path.join(info.storageRoot,'data.db'),...request}),encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},maxBuffer:1024*1024}));
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);page.setDefaultTimeout(20000);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const prefix='QA-query-'+crypto.randomUUID();let prepared=false,session,breakpoint,original;
 try{
  const loaded=fixture({action:'query_load',prefix});prepared=true;
  await invoke('plugin:window|show',{label:'main'});await invoke('plugin:window|set_focus',{label:'main'});
  await page.locator('.sidebar-nav button').filter({hasText:/剪切板|剪贴板/}).click();
  // Compile the trusted local reference into the CDP test function in Node.
  // The product's CSP remains enabled; no browser-side eval/new Function.
  const setup=async()=>{
   const resource=performance.getEntriesByType('resource').find(e=>/\/clipboardStore-[^/]+\.js$/.test(e.name));if(!resource)throw Error('Current compiled store missing');
   const current=Object.values(await import(resource.name)).find(v=>v?.getState?.().loadRecords&&v.getState().setVisible);if(!current)throw Error('Actual current store missing');
   const v={exports:{}};/* QA_VANILLA_FACTORY */(v.exports);
   const referenceExports={};/* QA_REFERENCE_FACTORY */(referenceExports,name=>{
    if(name==='zustand')return {create:v.exports.createStore};
    if(name==='@tauri-apps/api/core')return {invoke:(command,args)=>{if(command!=='get_clipboard_records')throw Error('Reference adapter forbids non-query command');return window.__TAURI_INTERNALS__.invoke(command,args)}};
    if(name==='@tauri-apps/api/event')return {listen:()=>{throw Error('Reference listeners are excluded')}};
    throw Error('Unexpected frozen reference dependency');
   });
   const q=window.__qaQueryIpc={current,reference:referenceExports.useClipboardStore,count:0,active:0,peak:0,holdNext:false,releases:[],held:false,issued:[]};
   window.__qaObserveQuery=message=>{
    if(message.cmd!=='get_clipboard_records')return;
    q.count++;q.active++;q.peak=Math.max(q.peak,q.active);q.issued.push(message.payload.search||'');
    const hold=q.holdNext;q.holdNext=false;let settled=false;
    for(const id of [message.callback,message.error]){
     const callback=window.__TAURI_INTERNALS__.callbacks.get(id);if(typeof callback!=='function')throw Error('Real IPC callback missing');
     window.__TAURI_INTERNALS__.callbacks.set(id,value=>{if(!settled){settled=true;q.active--;}if(hold&&id===message.callback){q.held=true;q.releases.push(()=>callback(value));return;}return callback(value)});
    }
   };
   return {search:current.getState().search,category:current.getState().category};
  };
  const setupSource=setup.toString().replace('/* QA_VANILLA_FACTORY */',()=>`((exports)=>{${vanilla}\n})`).replace('/* QA_REFERENCE_FACTORY */',()=>`((exports,require)=>{${oldJs}\n})`);
  original=await page.evaluate(`(${setupSource})()`);
  session=await page.context().newCDPSession(page);await session.send('Debugger.enable');const {result}=await session.send('Runtime.evaluate',{expression:'window.__TAURI_INTERNALS__.ipc'});
  breakpoint=await session.send('Debugger.setBreakpointOnFunctionCall',{objectId:result.objectId,condition:'(window.__qaObserveQuery(message), false)'});
  // Settle actual current UI before any counter assertions.
  await page.evaluate(async()=>{const q=window.__qaQueryIpc;q.current.getState().setCategory('all');q.current.getState().setVisible(true);await q.current.getState().loadRecords()});await wait(500);
  const counts=await page.evaluate(async prefix=>{
   const q=window.__qaQueryIpc,counts={};const reset=()=>{if(q.active)throw Error('Native reads still active');q.count=0;q.peak=0;q.issued=[]};
   reset();q.reference.getState().setSearch(prefix);await Promise.all(Array.from({length:100},()=>q.reference.getState().loadRecords()));counts.reference={requests:q.count,peak:q.peak,ids:q.reference.getState().records.map(r=>r.id)};
   reset();q.current.getState().setSearch(prefix);await Promise.all(Array.from({length:100},()=>q.current.getState().loadRecords()));counts.current={requests:q.count,peak:q.peak,ids:q.current.getState().records.map(r=>r.id)};
   reset();await Promise.all(Array.from({length:100},()=>q.current.getState().loadRecords()));counts.cached={requests:q.count,ids:q.current.getState().records.map(r=>r.id)};
   return counts;
  },prefix);
  assert.equal(counts.reference.requests,100);assert.equal(counts.current.requests,1);assert.equal(counts.cached.requests,0);assert.equal(counts.current.peak,1);assert.equal(counts.current.ids.length,120);assert.deepEqual(counts.current.ids,counts.reference.ids);assert.deepEqual(counts.cached.ids,counts.current.ids);
  record('100 same-query callers coalesce actual IPC; loaded-page repeats issue none',{referenceRequests:counts.reference.requests,currentRequests:counts.current.requests,cachedRequests:counts.cached.requests,rows:counts.current.ids.length,currentPeak:counts.current.peak});
  await wait(500);
  await page.evaluate(prefix=>{const q=window.__qaQueryIpc;q.count=0;q.issued=[];q.holdNext=true;q.current.getState().setSearch(prefix+' missing-held');q.pending=[q.current.getState().loadRecords()]},prefix);
  await page.waitForFunction(()=>window.__qaQueryIpc.held);
  await page.evaluate(async prefix=>{const q=window.__qaQueryIpc;for(let i=0;i<20;i++){q.current.getState().setSearch(i===19?prefix:prefix+' missing-pending-'+i);q.pending.push(q.current.getState().loadRecords());await Promise.resolve();await Promise.resolve()}},prefix);
  const queued=await page.evaluate(()=>({count:window.__qaQueryIpc.count,rows:window.__qaQueryIpc.current.getState().records.length}));assert.equal(queued.count,1);assert.equal(queued.rows,0);
  const last=await page.evaluate(async()=>{const q=window.__qaQueryIpc;for(const release of q.releases.splice(0))release();await Promise.all(q.pending);return {count:q.count,issued:q.issued,ids:q.current.getState().records.map(r=>r.id)}});
  assert.equal(last.count,2);assert.deepEqual(last.issued,[prefix+' missing-held',prefix]);assert.deepEqual(last.ids,counts.current.ids);
  record('twenty superseded waiting queries never reach IPC; old response cannot publish',{requests:last.count,superseded:19,finalRows:last.ids.length});
  const inserted=fixture({action:'query_append',prefix});assert.equal(inserted.count,1);
  const paged=await page.evaluate(async()=>{const q=window.__qaQueryIpc;await q.current.getState().loadRecords(true);await q.current.getState().loadRecords(true);return {ids:q.current.getState().records.map(r=>r.id),hasMore:q.current.getState().hasMore}});
  assert.equal(paged.ids.length,260);assert.equal(new Set(paged.ids).size,260);assert.deepEqual([...paged.ids].sort(),[...loaded.ids].sort());assert.equal(paged.hasMore,false);assert.ok(!paged.ids.includes(inserted.ids[0]));
  await page.evaluate(async()=>{const q=window.__qaQueryIpc;q.current.getState().invalidate();await q.current.getState().loadRecords()});
  assert.equal(await page.evaluate(id=>window.__qaQueryIpc.current.getState().records[0].id===id,inserted.ids[0]),true);
  record('cursor pagination retains all original 260 rows during newer insertion; refresh sees new row',{pages:3,originalRows:260,duplicates:0,refreshedNewest:true});report.passed=true;
 }catch(error){report.error=error.stack||String(error);throw error}
 finally{
  try{
   await page.evaluate(async original=>{const q=window.__qaQueryIpc;if(!q)return;for(const release of q.releases.splice(0))release();await Promise.all(q.pending||[]);if(original){q.current.getState().setSearch(original.search);q.current.getState().setCategory(original.category);await q.current.getState().loadRecords()}},original).catch(error=>{throw error});
   if(breakpoint)await session.send('Debugger.removeBreakpoint',breakpoint);if(session)await session.detach();
   if(prepared){const cleaned=fixture({action:'remove_query_load',prefix});assert.equal(cleaned.integrity,'ok');assert.equal(cleaned.foreignKeyViolations,0);report.cleanup=cleaned;}
  }catch(error){report.cleanupError=error.stack||String(error);report.passed=false;}
  await browser.close();report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));
 }
 assert.equal(report.passed,true,'Query IPC acceptance or cleanup failed');
})().catch(error=>{console.error(error.stack||String(error));process.exitCode=1});
