// Two live WebViews, real native IPC transport, synthetic continuous additions.
// No Debugger breakpoints. All timing/memory remains instrumented observation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const observer=require('./qa-native-fetch-observer.cjs'),reference=require('./qa-frozen-clipboard.cjs').reference(),wait=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.ok(['native-release-notes-scrollbars','native-release-image-idle','native-release-paste-settle','native-release-paste-feedback'].includes(info.nativeArtifact));assert.equal(info.profile,'release-default');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL),pages=browser.contexts().flatMap(c=>c.pages()),main=pages.find(p=>p.url()==='http://tauri.localhost/'),radial=pages.find(p=>p.url().endsWith('/radial.html'));assert.ok(main&&radial);main.setDefaultTimeout(20000);radial.setDefaultTimeout(20000);
 const invoke=(command,args={})=>main.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({database:path.join(info.storageRoot,'data.db'),...request}),encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},maxBuffer:1024*1024}));
 const prefix='QA-images-'+crypto.randomUUID(),directory=path.join(root,'image-continuous',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
 const destination=path.join(root,'reports','images-continuous-'+Date.now()+'.json'),phaseFile=path.join(directory,'phase'),stopFile=path.join(directory,'stop'),memoryFile=path.join(directory,'memory.jsonl');
 const report={started:new Date().toISOString(),app:info,steps:[],scope:'Current default two real WebViews; native fetch/WebView-message IPC counting/peaks with transport self-check, no Debugger breakpoints. Synthetic SQLite additions followed by native event delivery, not OS image capture. Frozen R0 store uses real Zustand vanilla/query-image read adapter in current backend, no historical executable/UI or latency gain claim. External process sampler excludes Node fixture driver; cleanup is a separate phase.',reference:{sourceSha256:reference.sourceSha256,vanillaSha256:reference.vanillaSha256}};
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const phase=async name=>{fs.writeFileSync(phaseFile,name);for(const page of [main,radial])await page.evaluate(name=>{if(window.__qaNativeFetch)window.__qaNativeFetch.phase=name},name)};
 const emit=(label,event,payload)=>invoke('plugin:event|emit_to',{target:{kind:'WebviewWindow',label},event,payload});
 const cache=page=>page.evaluate(()=>{const q=window.__qaContinuous,s=q.store.getState();return {ids:s.records.map(r=>r.id),thumbs:Object.keys(s.thumbnailCache).length,thumbBytes:Object.values(s.thumbnailCache).reduce((n,s)=>n+s.length*2,0),previews:Object.keys(s.imageCache).length,previewBytes:Object.values(s.imageCache).reduce((n,s)=>n+s.length*2,0),renderedImages:document.images.length}});
 const batches=[],observed=[];let monitor,monitorExit,originals={},pinned=false;
 try{
  const initialPrefix=prefix+'-initial',initial=fixture({action:'image_load',prefix:initialPrefix,count:60,seed:'QA-continuous-initial'});batches.push(initialPrefix);const expected=[...initial.ids];
  await invoke('plugin:window|show',{label:'main'});await invoke('plugin:window|set_focus',{label:'main'});await main.locator('.sidebar-nav button').filter({hasText:/剪切板|剪贴板/}).click();
  if(await main.getByRole('button',{name:'固定窗口',exact:true}).count()){await main.getByRole('button',{name:'固定窗口',exact:true}).click();pinned=true;}
  for(const page of [main,radial]){
   originals[page===main?'main':'radial']=await page.evaluate(async()=>{const resource=performance.getEntriesByType('resource').find(e=>/\/clipboardStore-[^/]+\.js$/.test(e.name));const store=Object.values(await import(resource.name)).find(v=>v?.getState?.().getThumbnail);const state=store.getState();window.__qaContinuous={store};return {search:state.search,category:state.category}});
   await observer.install(page);observed.push(page);
  }
  assert.equal((await observer.snapshot(radial)).commands.get_image_thumbnail||0,0);assert.equal((await cache(radial)).renderedImages,0);
  // Unmount image cards for the source-reference workload, so unrelated UI
  // thumbnail effects cannot contaminate same-key request counts.
  await main.locator('.sidebar-nav button').filter({hasText:'快捷短语'}).click();await wait(600);
  await main.evaluate(()=>window.__qaContinuous.store.setState({thumbnailCache:{},imageCache:{}}));
  await main.evaluate(`window.__qaContinuous.reference=${reference.expression}`);
  // Distinct reference/current IDs bypass any existing caches; same PNG bytes.
  const referenceCounts=await main.evaluate(async({prefix,id})=>{
   const q=window.__qaContinuous,record={id,content:'images/'+prefix+'-0.png'},fetch=window.__qaNativeFetch;
   const count=()=>({...fetch.commands});const difference=(before,command)=>(fetch.commands[command]||0)-(before[command]||0);
   let before=count();const oldThumb=await Promise.all(Array.from({length:20},()=>q.reference.getState().getThumbnail(record)));const oldThumbnailRequests=difference(before,'get_image_thumbnail');
   before=count();fetch.peak.get_image_thumbnail=0;const newThumb=await Promise.all(Array.from({length:20},()=>q.store.getState().getThumbnail(record)));const newThumbnailRequests=difference(before,'get_image_thumbnail'),newThumbnailPeak=fetch.peak.get_image_thumbnail;
   if(oldThumb.some(v=>v!==oldThumb[0]||!v)||newThumb.some(v=>v!==oldThumb[0]))throw Error('Thumbnail bytes differ');
   before=count();const oldFull=await Promise.all(Array.from({length:10},()=>q.reference.getState().getImageData(record)));const oldPreviewRequests=difference(before,'get_image_base64');
   before=count();fetch.peak.get_image_base64=0;const newFull=await Promise.all(Array.from({length:10},()=>q.store.getState().getImageData(record)));const newPreviewRequests=difference(before,'get_image_base64'),newPreviewPeak=fetch.peak.get_image_base64;
   if(oldFull.some(v=>v!==oldFull[0]||!v)||newFull.some(v=>v!==oldFull[0]))throw Error('Preview bytes differ');
   const result={oldThumbnailRequests,newThumbnailRequests,newThumbnailPeak,oldPreviewRequests,newPreviewRequests,newPreviewPeak,thumbnailUrlBytes:oldThumb[0].length,previewUrlBytes:oldFull[0].length};q.reference=null;return result;
  },{prefix:initialPrefix,id:initial.ids[0]});
  assert.equal(referenceCounts.oldThumbnailRequests,3);assert.equal(referenceCounts.newThumbnailRequests,1);assert.equal(referenceCounts.newThumbnailPeak,1);assert.equal(referenceCounts.oldPreviewRequests,10);assert.equal(referenceCounts.newPreviewRequests,1);assert.equal(referenceCounts.newPreviewPeak,1);record('same-PNG duplicate requests reduced against frozen R0 store source',referenceCounts);
  await phase('both-visible-additions');
  monitor=spawn(process.env.QA_PYTHON,[path.join(__dirname,'monitor-qa-processes.py'),metadata,memoryFile,phaseFile,stopFile,'180'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let monitorError='';monitor.stderr.on('data',d=>monitorError+=d);monitorExit=new Promise((resolve,reject)=>{monitor.once('error',reject);monitor.once('exit',code=>code===0?resolve():reject(Error(monitorError)))});await new Promise((resolve,reject)=>{monitor.stdout.once('data',d=>{try{assert.equal(JSON.parse(d).ready,true);resolve()}catch(e){reject(e)}});monitor.once('error',reject)});
  // Avoid another module copy: both pages use their existing production store.
  await main.locator('.sidebar-nav button').filter({hasText:/剪切板|剪贴板/}).click();
  await main.evaluate(async prefix=>{const s=window.__qaContinuous.store;s.getState().setCategory('image');s.getState().setSearch(prefix);s.getState().setVisible(true);await s.getState().loadRecords()},prefix);
  await invoke('plugin:window|show',{label:'radial-menu'});await emit('radial-menu','radial-menu-down',{x:20,y:20,theme:await main.evaluate(()=>document.documentElement.dataset.theme||'light')});
  await radial.locator('[data-radial-list]').waitFor();await radial.evaluate(async prefix=>{const s=window.__qaContinuous.store;s.getState().setCategory('image');s.getState().setSearch(prefix);await s.getState().loadRecords()},prefix);
  // The real UI may already be loading thumbnails as its list appears. Start
  // this phase's peak at the actual accepted work, rather than requiring an
  // artificial idle instant between list mount and the incoming workload.
  for(const page of [main,radial])await page.evaluate(()=>{const q=window.__qaNativeFetch;q.peak={...q.active}});
  for(let batch=0;batch<10;batch++){
   const batchPrefix=prefix+'-batch-'+batch,added=fixture({action:'image_load',prefix:batchPrefix,count:5,seed:'QA-continuous-batch-'+batch});batches.push(batchPrefix);expected.push(...added.ids);
   const epoch=await invoke('get_storage_epoch');for(const label of ['main','radial-menu'])await emit(label,'clipboard-refresh',{storage_epoch:epoch,value:null});
   for(const page of [main,radial])await page.waitForFunction(count=>window.__qaContinuous.store.getState().records.length===count,expected.length);
   for(const [page,selector] of [[main,'.clipboard-list'],[radial,'[data-radial-list]']])await page.locator(selector).evaluate((el,batch)=>{el.scrollTop=batch%2?0:el.scrollHeight},batch);
   await wait(120);for(const page of [main,radial])assert.deepEqual((await cache(page)).ids.sort(),[...expected].sort());
  }
  const scroll=async(page,selector)=>{for(let i=0;i<=32;i++){await page.locator(selector).evaluate((el,i)=>{el.scrollTop=(el.scrollHeight-el.clientHeight)*i/32},i);await wait(55)}};
  await Promise.all([scroll(main,'.clipboard-list'),scroll(radial,'[data-radial-list]')]);await wait(1200);
  const both={main:{cache:await cache(main),transport:await observer.snapshot(main)},radial:{cache:await cache(radial),transport:await observer.snapshot(radial)}};
  for(const value of Object.values(both)){assert.ok((value.transport.peak.get_image_thumbnail||0)<=3);assert.ok((value.transport.peak.get_image_base64||0)<=1);assert.ok(value.cache.thumbs<=80&&value.cache.thumbBytes<=12*1024*1024);assert.ok(value.cache.previews<=4&&value.cache.previewBytes<=24*1024*1024);assert.equal(value.transport.errors,0);}
  record('ten additions with both windows active retain all 110 images and independent budgets',{batches:10,added:50,main:{...both.main.cache,ids:undefined,transport:both.main.transport},radial:{...both.radial.cache,ids:undefined,transport:both.radial.transport},scope:'Per-window limits; allowed aggregate is up to six thumbnail and two preview requests, not three/one for the whole app'});
  await phase('both-stopped');const stopped=await Promise.all([observer.snapshot(main),observer.snapshot(radial)]);await wait(3000);for(let i=0;i<2;i++)assert.equal((await observer.snapshot([main,radial][i])).commands.get_image_thumbnail,stopped[i].commands.get_image_thumbnail);
  await emit('radial-menu','radial-menu-move',{x:-100,y:-100});await wait(100);await emit('radial-menu','radial-menu-up',null);await radial.waitForFunction(()=>!document.querySelector('[data-radial-list]'));
  await main.locator('.window-close-btn').click();assert.equal(await invoke('plugin:window|is_visible',{label:'main'}),false);await wait(400);await phase('both-hidden');const before=await Promise.all([observer.snapshot(main),observer.snapshot(radial)]);
  for(let i=0;i<10;i++){const epoch=await invoke('get_storage_epoch');for(const label of ['main','radial-menu'])await emit(label,'clipboard-refresh',{storage_epoch:epoch,value:null});await wait(40)}await wait(3000);
  const after=await Promise.all([observer.snapshot(main),observer.snapshot(radial)]);for(let i=0;i<2;i++)for(const command of ['get_clipboard_records','get_image_thumbnail','get_image_base64'])assert.equal(after[i].commands[command]||0,before[i].commands[command]||0);
  assert.equal((await cache(radial)).renderedImages,0);
  if(['native-release-image-idle','native-release-paste-settle','native-release-paste-feedback'].includes(info.nativeArtifact))for(const page of [main,radial])assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length),0,'Hidden CSS animation remains running');
  record('static lists settle; both hidden windows issue no image/query work for ten refreshes',{main:after[0],radial:after[1]});
  await phase('hidden-settle');await wait(10000);
  const profiles=[];
  if(process.argv.includes('--diagnose-hidden'))for(const [label,page] of [['main',main],['radial',radial]]){
   const session=await page.context().newCDPSession(page);await session.send('Profiler.enable');await session.send('Profiler.start');profiles.push({label,session});
  }
  await phase('hidden-idle');await wait(30000);
  if(profiles.length){
   for(const {label,session} of profiles){const {profile}=await session.send('Profiler.stop');fs.writeFileSync(path.join(directory,label+'-hidden-profile.json'),JSON.stringify(profile));await session.detach();}
   const animationState=async page=>page.evaluate(()=>({documentHidden:document.hidden,animations:document.getAnimations().map(a=>({type:a.constructor.name,name:a.animationName||'',state:a.playState,target:a.effect?.target?.className||''})),images:document.images.length}));
   record('hidden animation and JavaScript profile diagnostic',{main:await animationState(main),radial:await animationState(radial),profileDirectory:directory});
   for(const page of [main,radial])await page.evaluate(()=>{window.__qaPausedAnimations=document.getAnimations().filter(a=>a.playState==='running');for(const a of window.__qaPausedAnimations)a.pause()});
   await phase('hidden-animation-paused');await wait(30000);
   for(const page of [main,radial])await page.evaluate(()=>{for(const a of window.__qaPausedAnimations||[])a.play();delete window.__qaPausedAnimations});
   await phase('hidden-animation-restored');await wait(30000);
   record('reversible animation pause and restore observation completed',{scope:'Diagnostic runtime mutation only; no product source change or memory gain claim'});
  }
  const idle=await Promise.all([observer.snapshot(main),observer.snapshot(radial)]);for(let i=0;i<2;i++)for(const command of ['get_clipboard_records','get_image_thumbnail','get_image_base64'])assert.equal(idle[i].commands[command]||0,after[i].commands[command]||0);
  record('after ten-second settling, thirty-second native-hidden observation keeps request counts fixed',{main:idle[0],radial:idle[1],mainRenderedImages:(await cache(main)).renderedImages,radialRenderedImages:(await cache(radial)).renderedImages});report.passed=true;
 }catch(error){report.error=error.stack||String(error);throw error}
 finally{
  try{
   if(monitor)fs.writeFileSync(phaseFile,'cleanup');
   await emit('radial-menu','radial-menu-move',{x:-100,y:-100});await wait(100);await emit('radial-menu','radial-menu-up',null);
   await invoke('plugin:window|show',{label:'main'});await invoke('plugin:window|set_focus',{label:'main'});
   for(const page of [main,radial])await page.evaluate(async original=>{const q=window.__qaContinuous;if(q&&original){q.store.getState().setSearch(original.search);q.store.getState().setCategory(original.category);if(original)await q.store.getState().loadRecords()}},originals[page===main?'main':'radial']);
   if(pinned)await main.getByRole('button',{name:'取消固定',exact:true}).click();
   for(const page of observed){await page.evaluate(()=>{for(const a of window.__qaPausedAnimations||[])a.play();delete window.__qaPausedAnimations});await observer.restore(page);}
  }catch(error){report.cleanupError=error.stack||String(error);report.passed=false;}
  for(const batch of batches)try{fixture({action:'remove_image_load',prefix:batch})}catch(error){report.cleanupError=error.stack||String(error);report.passed=false;}
  if(monitor){fs.writeFileSync(stopFile,'stop');try{await monitorExit;report.memoryFile=memoryFile}catch(error){report.cleanupError=error.stack||String(error);report.passed=false;}}
  await browser.close();report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));
 }
 assert.equal(report.passed,true,'Continuous image acceptance or cleanup failed');
})().catch(error=>{console.error(error.stack||String(error));process.exitCode=1});
