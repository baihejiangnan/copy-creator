// Complete QA Release: real clipboard monitor cleanup alongside native note saves.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),readline=require('node:readline');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const distribution=rows=>{const values=rows.map(row=>row.ms).sort((a,b)=>a-b),at=p=>values[Math.ceil(values.length*p)-1];return {samples:values.length,p50_ms:at(.5),p95_ms:at(.95),p99_ms:at(.99),max_ms:at(1)}};
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.ok(path.resolve(info.exe).startsWith(root+path.sep));
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 assert.equal(String(info.debugPort),new URL(process.env.QA_CDP_URL).port);
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);let page;
 for(let attempt=0;attempt<100;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await wait(100)}assert.ok(page);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({...request,database:path.join(info.storageRoot,'data.db')}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true,maxBuffer:1024*1024}));
 const prefix='QA-cleanup-'+crypto.randomUUID(),sentinel='QA controlled clipboard cleanup '+crypto.randomUUID(),epoch=await invoke('get_storage_epoch');
 const report={started:new Date().toISOString(),app:info,prefix,steps:[],scope:'Synthetic old normal/favorite/manual-key/label-key records. Real default OS monitor enforces capacity; 8 reads plus one native save per round. No TTL worker or backup contention claim.'};
 const destination=path.join(root,'reports','cleanup-pressure-'+Date.now()+'.json'),record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const helper=spawn(process.env.QA_POWERSHELL,['-NoProfile','-STA','-File',path.join(__dirname,'qa-desktop-target.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let pending=[],queued=[],ended=false,helperError='';helper.stderr.on('data',value=>{helperError+=value;process.stderr.write(value)});
 readline.createInterface({input:helper.stdout}).on('line',line=>{let value;try{value=JSON.parse(line)}catch{return}if(pending.length)pending.shift().resolve(value);else queued.push(value)});
 helper.on('exit',code=>{ended=true;for(const item of pending.splice(0))item.reject(Error('Owned helper exited '+code+': '+helperError))});
 const next=()=>queued.length?Promise.resolve(queued.shift()):ended?Promise.reject(Error('Owned helper ended')):new Promise((resolve,reject)=>{const item={resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}};const timer=setTimeout(()=>{pending=pending.filter(value=>value!==item);reject(Error('Owned helper timeout'))},15000);pending.push(item)});
 const command=async request=>{const response=next();helper.stdin.write(JSON.stringify(request)+'\n');return response};
 let loaded;
 try{
  assert.equal((await next()).ready,true);await wait(2000);
  const draft={title:prefix,body:'QA cleanup note independent of clipboard TTL/capacity 中文\r\n  '+('body '.repeat(800)),refs:[]};
  const created=await invoke('create_note',{expectedStorageEpoch:epoch,id:crypto.randomUUID(),mutationId:crypto.randomUUID(),draft});
  const note=created.value.note;
  const measure=()=>page.evaluate(async({epoch,note,draft})=>{
   const invoke=window.__TAURI_INTERNALS__.invoke;let current=(await invoke('get_note',{expectedStorageEpoch:epoch,id:note.id})).value,busy=0;const samples=[];
   const call=async(command,args)=>{for(let retry=0;;retry++){try{return await invoke(command,{expectedStorageEpoch:epoch,...args})}catch(error){if(error?.code!=='notes.busy'||retry>=50)throw Error(JSON.stringify(error));busy++;await new Promise(resolve=>setTimeout(resolve,10))}}};
   for(let round=0;round<110;round++){
    const start=performance.now();
    const reads=Array.from({length:8},(_,index)=>call(index%2?'get_note':'list_notes',index%2?{id:note.id}:{filter:'active',search:draft.title,cursor:null,limit:50}));
    let finish;const saved=call('save_note',{id:note.id,expectedRevision:current.revision,mutationId:crypto.randomUUID(),draft:{...draft,body:draft.body+'\nround '+round}}).then(result=>{finish=performance.now();return result});
    const [result]=await Promise.all([saved,...reads]);current=result.value.note;
    samples.push({start,finish,ms:finish-start,round});
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   return {samples,busy,revision:current.revision,body:current.body};
  },{epoch,note,draft});
  const baseline=await measure();record('baseline mixed reads and saves',{latency:distribution(baseline.samples.slice(10)),busy:baseline.busy,revision:baseline.revision});
  loaded=fixture({action:'cleanup_load',prefix});record('capacity fixture prepared',loaded);
  const pressurePromise=measure();await wait(200);
  const triggerTime=await page.evaluate(()=>performance.now());await command({command:'writeSynthetic',text:sentinel});
  let completion,stats;
  for(let attempt=0;attempt<200;attempt++){stats=await invoke('get_clipboard_storage_stats');if(stats.record_count<=loaded.maxItems){completion=await page.evaluate(()=>performance.now());break}await wait(25)}
  assert.ok(completion,'Actual default monitor must finish capacity cleanup');
  const pressure=await pressurePromise,overlap=pressure.samples.filter(row=>row.start<=completion&&row.finish>=triggerTime);
  assert.ok(overlap.length,'Saves must overlap monitor trigger and cleanup observation');
  record('real monitor capacity cleanup and mixed saves',{triggerTime,completionTime:completion,observedTriggerToCompletionMs:completion-triggerTime,latency:distribution(pressure.samples.slice(10)),overlapLatency:distribution(overlap),overlapRounds:overlap.length,busy:pressure.busy,stats});
  const state=fixture({action:'cleanup_inspect',prefix,sentinel});assert.equal(state.baselineIdsHash,loaded.baselineIdsHash);
  const groups=new Map(state.groups.map(([favorite,manual,label,count])=>[[favorite,manual,label].join(','),count]));
  for(const key of ['1,0,0','0,1,0','0,0,1'])assert.equal(groups.get(key),20);
  assert.ok(groups.get('0,0,0')<2000);assert.equal(state.records,loaded.maxItems);assert.equal(state.integrity,'ok');
  const saved=(await invoke('get_note',{expectedStorageEpoch:epoch,id:note.id})).value;
  assert.equal(saved.body,pressure.body);assert.equal(saved.revision,pressure.revision);assert.equal(saved.refs.length,0);
  record('original clipboard IDs, 60 protected fixtures and independent saved note intact',{...state,noteRevision:saved.revision});
  report.passed=true;record('passed');
 }catch(error){report.error=error.message||JSON.stringify(error);record('failed',{error:report.error});throw error}
 finally{
  if(loaded)record('only own clipboard fixtures removed and original limits restored',fixture({action:'remove_cleanup_load',prefix,sentinel,settings:loaded.settings}));
  if(!ended){try{await command({command:'close'})}catch{}helper.stdin.end()}
 }
 console.log(JSON.stringify({passed:true,report:destination}));process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
