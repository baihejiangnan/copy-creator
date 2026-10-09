// Only through the clipboard-preserving wrapper; synthetic native writes and actual commit events.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),readline=require('node:readline'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const distribution=values=>{const a=[...values].sort((a,b)=>a-b);return {samples:a.length,p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1)}};
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.autostartIsolation,'identifier');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);let page;for(let i=0;i<100;i++){for(const p of browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()==='http://tauri.localhost/'))if(await p.evaluate(()=>performance.timeOrigin).catch(()=>0)>=info.launchStartedUnixMs-200){page=p;break}if(page)break;await wait(100)}assert.ok(page);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));const epoch=await invoke('get_storage_epoch');
 const report={started:new Date().toISOString(),app:info,samples:[],scope:'Actual synthetic native clipboard write through owned helper, native committed clipboard-update received by current WebView. Includes helper scheduling and event IPC; no source text or real clipboard exported. Startup suppression excluded.'},destination=path.join(root,'reports','clipboard-latency-'+Date.now()+'.json');
 const helper=spawn(process.env.QA_POWERSHELL,['-NoProfile','-STA','-File',path.join(__dirname,'qa-desktop-target.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:['pipe','pipe','pipe']});let pending=[],queued=[],ended=false,helperError='';helper.stderr.on('data',x=>helperError+=x);readline.createInterface({input:helper.stdout}).on('line',line=>{const value=JSON.parse(line);if(pending.length)pending.shift().resolve(value);else queued.push(value)});helper.on('exit',()=>{ended=true;for(const item of pending.splice(0))item.reject(Error('Helper ended: '+helperError))});
 const next=()=>queued.length?Promise.resolve(queued.shift()):ended?Promise.reject(Error('Helper ended')):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Helper timed out')),15000);pending.push({resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}})});const command=async request=>{const promise=next();helper.stdin.write(JSON.stringify(request)+'\n');return promise};
 let listener,callback;const ids=new Set();
 try{
  assert.equal((await next()).ready,true);await invoke('plugin:window|show',{label:'main'});await invoke('plugin:window|set_focus',{label:'main'});
  const prefix='QA controlled clipboard latency '+crypto.randomUUID();
  ({listener,callback}=await page.evaluate(async({epoch,prefix})=>{window.__qaClipboardLatency={events:[],epoch,prefix};const q=window.__qaClipboardLatency,internals=window.__TAURI_INTERNALS__;const callback=internals.transformCallback(event=>{const payload=event.payload;if(payload?.storage_epoch===q.epoch&&payload.value?.content?.startsWith(q.prefix))q.events.push({id:payload.value.id,content:payload.value.content,received:Date.now()})});return {callback,listener:await internals.invoke('plugin:event|listen',{event:'clipboard-update',target:{kind:'Any'},handler:callback})}},{epoch,prefix}));
  await wait(Math.max(0,info.launchStartedUnixMs+2100-Date.now()));
  for(let sample=0;sample<60;sample++){
   // Jitter prevents a fixed phase relative to the original 800ms polling cycle.
   await wait(17+(sample*73)%191);const text=prefix+' sample '+sample,started=Date.now();assert.equal((await command({command:'writeSynthetic',text})).writtenSynthetic,true);let event;
   for(let attempt=0;attempt<500;attempt++){event=await page.evaluate(text=>window.__qaClipboardLatency.events.find(e=>e.content===text),text);if(event)break;await wait(5)}assert.ok(event,'Committed unique text event missing');ids.add(event.id);report.samples.push({sample:sample+1,writeToCommitEventMs:event.received-started});if((sample+1)%10===0)console.log(JSON.stringify({samples:sample+1,latestMs:report.samples.at(-1).writeToCommitEventMs}));fs.writeFileSync(destination,JSON.stringify(report,null,2));
  }
  report.latencyMs=distribution(report.samples.map(s=>s.writeToCommitEventMs));report.under100ms=report.samples.filter(s=>s.writeToCommitEventMs<100).length;
  // Rapid genuine private copies must not leak into history when event wakeups race the copy.
  await invoke('unlock_vault',{masterPassword:'QA-only-rich-vault-master-2026',expectedStorageEpoch:epoch});
  const privatePrefix='QA controlled clipboard private '+crypto.randomUUID();report.privateBusyRetries=0;
  for(let sample=0;sample<100;sample++){
   for(let attempt=0;attempt<20;attempt++){try{await invoke('copy_vault_text',{text:privatePrefix+' '+sample,expectedStorageEpoch:epoch});break}catch(error){if(!String(error).includes('vault.clipboardBusy')||attempt===19)throw error;report.privateBusyRetries++;await wait(10)}}
   await wait(sample%7);
  }
  await wait(1000);const privateRows=await invoke('get_clipboard_records',{search:privatePrefix,limit:120});assert.equal(privateRows.length,0);report.privateCopiesNotRecorded=100;await invoke('lock_vault',{expectedStorageEpoch:epoch});report.passed=true;
 }catch(error){report.error=error.stack;throw error}
 finally{
  for(const id of ids)await invoke('delete_clipboard_record',{id,expectedStorageEpoch:epoch}).catch(()=>{});
  if(listener!==undefined)await invoke('plugin:event|unlisten',{event:'clipboard-update',eventId:listener}).catch(()=>{});if(callback!==undefined)await page.evaluate(callback=>window.__TAURI_INTERNALS__.unregisterCallback(callback),callback).catch(()=>{});
  await command({command:'close'}).catch(()=>{});helper.stdin.end();report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,latencyMs:report.latencyMs,under100ms:report.under100ms,report:destination}));await browser.close();
 }
 process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
