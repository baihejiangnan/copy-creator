// Native Release IPC against explicitly isolated synthetic 10k/50k fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
const distribution=values=>{const sorted=[...values].sort((a,b)=>a-b),at=p=>sorted[Math.ceil(sorted.length*p)-1];return {samples:sorted.length,p50_ms:at(.5),p95_ms:at(.95),p99_ms:at(.99),max_ms:at(1)}};
(async()=>{
 const metadata=path.resolve(process.env.QA_PROCESS_METADATA||path.join(root,'process.json'));
 assert.ok(metadata.startsWith(root+path.sep),'Metadata must stay inside QA artifacts');
 const info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
 assert.ok(['com.copycreator.qa20261007','com.copycreator.qa20261007search'].includes(info.identifier));
 assert.ok(path.resolve(info.exe).startsWith(root+path.sep));
 assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`),page=browser.contexts()[0].pages().find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);
 assert.equal(require('./qa-path.cjs')(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'))),require('./qa-path.cjs')(info.storageRoot));
 const counts=process.argv[2]?[Number(process.argv[2])]:[10000,50000];assert.ok(counts.every(count=>[10000,50000].includes(count)));
 let prepared;
 if(process.env.QA_SCALE_FIXTURE){
  const fixtureFile=path.resolve(process.env.QA_SCALE_FIXTURE);assert.ok(fixtureFile.startsWith(root+path.sep));
  assert.equal(info.identifier,'com.copycreator.qa20261007search');
  prepared=JSON.parse(fs.readFileSync(fixtureFile,'utf8').replace(/^\uFEFF/,''));
  assert.deepEqual(counts,[prepared.fixture.notes]);assert.ok(prepared.prefix.startsWith('QA-scale-migration-'));
 }
 const report={started:new Date().toISOString(),app:info,scenarios:[],scope:'Release native IPC for the exact QA artifact in app metadata, 110 rounds with first 10 excluded; busy retries included. Synthetic ~4 KiB notes and 2,000 clipboard records protected only to isolate background eviction. No debugger hooks, not input-to-paint or cleanup/backup contention acceptance.'};
 report.busyRetry={maxRetries:400,delayMs:10};
 const destination=path.join(root,'reports',`scale-${Date.now()}.json`),record=()=>fs.writeFileSync(destination,JSON.stringify(report,null,2));
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({...request,database:path.join(info.storageRoot,'data.db')}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true,maxBuffer:1024*1024}));
 for(const count of counts){
  const prefix=prepared?.prefix||'QA-scale-'+randomUUID()+'%_',scenario={count,prefix,stages:[],preparedBeforeMigration:Boolean(prepared)};report.scenarios.push(scenario);record();
  try {
   scenario.fixture=prepared?.fixture||fixture({action:'scale_load',prefix,count});record();console.log(JSON.stringify({prepared:count,noteRawBytes:scenario.fixture.noteRawBytes}));
   const stages=process.env.QA_SCALE_STAGES?.split(',')||['ordinary','mixed','pagination'];assert.ok(stages.every(stage=>['ordinary','mixed','pagination'].includes(stage)));
   for(const stage of stages){
    const result=await page.evaluate(async({prefix,firstId,count,stage})=>{
     const invoke=window.__TAURI_INTERNALS__.invoke,epoch=await invoke('get_storage_epoch'),samples={};let busy=0,maxListBytes=0;
     const timed=async(name,command,args)=>{
      const start=performance.now();let response;
      for(let attempt=0;;attempt++){
       try{response=await invoke(command,{expectedStorageEpoch:epoch,...args});break}
       catch(error){if(error?.code!=='notes.busy'||attempt>=400)throw Error(JSON.stringify({command,error,attempt}));busy++;await new Promise(resolve=>setTimeout(resolve,10))}
      }
      (samples[name]??=[]).push(performance.now()-start);return command==='get_clipboard_records'||command==='get_clipboard_storage_stats'?response:response.value;
     };
     const listArgs={filter:'active',search:prefix,cursor:null,limit:50};
     if(stage==='pagination'){
      let cursor=null,pages=0;const seen=new Set(),inserted=[];let firstPage=true;
      do{
       const value=await timed('page','list_notes',{...listArgs,cursor});
       for(const note of value.records){if(seen.has(note.id)||!note.title.startsWith(prefix))throw Error('Duplicate or foreign note');seen.add(note.id)}
       cursor=value.next_cursor;pages++;
       if(firstPage){firstPage=false;const id=crypto.randomUUID();await invoke('create_note',{expectedStorageEpoch:epoch,id,mutationId:crypto.randomUUID(),draft:{title:prefix+' inserted-after-first-page',body:'QA cursor insertion',refs:[]}});inserted.push(id)}
      }while(cursor);
      if(seen.size!==count||inserted.some(id=>seen.has(id)))throw Error('Insertion disturbed original cursor traversal');
      let clipCursor=null,clipPages=0;const clipSeen=new Set();
      do{
       const rows=await timed('clipboardPage','get_clipboard_records',{search:prefix,limit:120,cursor:clipCursor});
       for(const row of rows){if(clipSeen.has(row.id)||row.source_app!==prefix)throw Error('Clipboard cursor duplicate/foreign record');clipSeen.add(row.id)}
       const last=rows.at(-1);clipCursor=rows.length===120?{created_at:last.created_at,id:last.id}:null;clipPages++;
      }while(clipCursor);
      if(clipSeen.size!==2000)throw Error('Clipboard pagination skipped records');
      return {pages,records:seen.size,insertedAboveCursor:inserted.length,clipPages,clipRecords:clipSeen.size,samples,busy};
     }
     let current=(await invoke('get_note',{expectedStorageEpoch:epoch,id:firstId})).value;
     const draft={title:current.title,body:current.body,refs:[]};
     for(let index=0;index<110;index++){
      if(stage==='ordinary'){
       const list=await timed('list','list_notes',listArgs);if(list.records.length!==50||list.records.some(row=>Object.hasOwn(row,'body')))throw Error('Summary contract failed');
       maxListBytes=Math.max(maxListBytes,new TextEncoder().encode(JSON.stringify(list)).length);
       const absent=await timed('searchAbsent','list_notes',{...listArgs,search:prefix+'-absent'});if(absent.records.length)throw Error('Absent search matched');
       const bodyMatch=await timed('searchBody','list_notes',{...listArgs,search:prefix+'-body-only'});if(bodyMatch.records.length!==50)throw Error('Body search failed');
       await timed('clipboard','get_clipboard_records',{search:prefix,limit:120,cursor:null});
       await timed('storageStats','get_clipboard_storage_stats',{});
       current=(await timed('save','save_note',{id:firstId,expectedRevision:current.revision,mutationId:crypto.randomUUID(),draft:{...draft,body:draft.body+'\n'+index}})).note;
      }else{
       const reads=Array.from({length:8},(_,i)=>timed('mixedRead',i%2?'get_note':'list_notes',i%2?{id:firstId}:{...listArgs,search:i%4?prefix:prefix+'-absent'}));
       const clipboard=timed('mixedClipboard','get_clipboard_records',{search:prefix,limit:120,cursor:null});
       const save=timed('mixedSave','save_note',{id:firstId,expectedRevision:current.revision,mutationId:crypto.randomUUID(),draft:{...draft,body:draft.body+'\nmixed '+index}});
       const [saved]=await Promise.all([save,clipboard,...reads]);current=saved.note;
      }
     }
     return {samples,busy,maxListBytes,finalRevision:current.revision};
    },{prefix,firstId:scenario.fixture.firstId,count,stage});
    const {samples,...details}=result;scenario.stages.push({stage,...details,latency:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,distribution(stage==='pagination'?values:values.slice(name==='mixedRead'?80:10))]))});record();console.log(JSON.stringify({count,stage,latency:scenario.stages.at(-1).latency}));
   }
   scenario.passed=true;
  }catch(error){scenario.error=error.message;record();throw error}
  finally{scenario.cleanup=fixture({action:'remove_scale_load',prefix});assert.equal(scenario.cleanup.integrity,'ok');record()}
 }
 report.passed=true;report.finished=new Date().toISOString();record();console.log(JSON.stringify({passed:true,report:destination}));process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
