// Withhold actual native save-request delivery; do not synthesize a success.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
(async()=>{
 const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.autostartIsolation,'identifier');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);page.setDefaultTimeout(25000);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));const originalEpoch=await invoke('get_storage_epoch');
 const destination=path.join(root,'reports','lifecycle-unresponsive-'+Date.now()+'.json'),report={started:new Date().toISOString(),app:info,steps:[],scope:'Actual native 15s restart-save request timeout with genuine callback delivery withheld. No ready response is fabricated, no WebView crash/reload or disk failure claim. No draft is discarded.'};
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};let armed=false;
 try{
  await page.evaluate(async()=>{const entry=performance.getEntriesByType('resource').find(e=>/\/main-[^/]+\.js$/.test(e.name));const barrier=Object.values(await import(entry.name)).find(v=>v?.run&&v?.register&&v?.getSnapshot);if(!barrier)throw Error('Actual save barrier unavailable');await barrier.run('qa-before-unresponsive',async()=>{});barrier.dismissError();window.__qaUnresponsive={barrier};const q=window.__qaUnresponsive,map=window.__TAURI_INTERNALS__.callbacks,original=map.get;q.map=map;q.original=original;q.requests=[];map.get=function(key){const callback=original.call(this,key);if(!callback)return callback;return data=>{if(data?.event==='lifecycle-save-request'){q.requests.push(data.payload);q.release=()=>callback(data);return}callback(data)}}});armed=true;
  const start=Date.now();await invoke('request_app_restart');await page.waitForFunction(()=>window.__qaUnresponsive.requests.length===1);
  const request=await page.evaluate(()=>window.__qaUnresponsive.requests[0]);assert.equal(request.purpose,'restart');
  await assert.rejects(invoke('request_app_restart'),error=>error.message==='page.evaluate: lifecycle.busy');
  await page.locator('.lifecycle-error').filter({hasText:/超时|timed out/i}).waitFor();const duration=Date.now()-start;assert.ok(duration>=14500&&duration<25000);
  assert.equal(await invoke('get_storage_epoch'),originalEpoch);
  await assert.rejects(invoke('lifecycle_saved',{requestId:request.requestId,sessionId:request.sessionId}),error=>error.message==='page.evaluate: lifecycle.expired');
  record('native save-request expires without frontend response; duplicate request and late success are rejected',{observedDeadlineMs:duration,duplicateRejected:true,lateSuccessRejected:true});
  await page.evaluate(()=>{const q=window.__qaUnresponsive;q.map.get=q.original;q.release();q.barrier.dismissError()});armed=false;
  await page.waitForFunction(()=>!window.__qaUnresponsive.barrier.getSnapshot().busy);await new Promise(r=>setTimeout(r,500));
  const epoch=await invoke('get_storage_epoch'),token=crypto.randomUUID();await invoke('begin_storage_operation',{sessionId:request.sessionId,kind:'export',expectedStorageEpoch:epoch,operationToken:token});await invoke('end_storage_operation',{sessionId:request.sessionId,operationToken:token});
  await page.evaluate(()=>window.__qaUnresponsive.barrier.dismissError());record('late genuine event cannot terminate app; later exclusive operation succeeds',{appResponsive:true,laterLeaseReleased:true});report.passed=true;
 }catch(error){report.error=error.stack||String(error);throw error}
 finally{if(armed)await page.evaluate(async()=>{const q=window.__qaUnresponsive;if(q?.map){q.map.get=q.original;const request=q.requests[0];if(request)await window.__TAURI_INTERNALS__.invoke('lifecycle_cancel',{requestId:request.requestId,sessionId:request.sessionId}).catch(()=>{});/* Never release a withheld request on a failing path. */}}).catch(()=>{});report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));}
 process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
