// Default Release image queues/cache in the two real WebViews. No OS clipboard.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{execFileSync,spawn}=require('node:child_process'),readline=require('node:readline');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),metadata=path.join(root,'process.json');
 const info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`),pages=browser.contexts()[0].pages();
 const main=pages.find(page=>page.url()==='http://tauri.localhost/'),radial=pages.find(page=>page.url().endsWith('/radial.html'));assert.ok(main);assert.ok(radial);main.setDefaultTimeout(15000);
 assert.equal(require('./qa-path.cjs')(await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'))),require('./qa-path.cjs')(info.storageRoot));
 const prefix='QA-images-'+randomUUID(),directory=path.join(root,'image-fixtures',randomUUID());fs.mkdirSync(directory,{recursive:true});
 const phasePath=path.join(directory,'phase.txt'),stopPath=path.join(directory,'stop'),memoryPath=path.join(directory,'memory.jsonl');
 const report={time:new Date().toISOString(),app:info,directory,steps:[]},reportPath=path.join(root,'reports',`images-${Date.now()}.json`);
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(reportPath,JSON.stringify(report,null,2))};
 const phase=name=>fs.writeFileSync(phasePath,name);
 const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({...request,database:path.join(info.storageRoot,'data.db')}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true}));
 // Tauri freezes invoke/ipc. Observe calls with a non-pausing CDP conditional
 // breakpoint and wrap only their existing one-shot completion callbacks.
 // This run validates counts/bounds; debugger overhead excludes latency claims.
 const observers=[];
 const install=async page=>{
  await page.evaluate(()=>{
   const stats=window.__qaImageStats={commands:{},active:{},peak:{},returnedBytes:0,blockedPaste:0,thumbnailPaths:[]};const paths=new Set();
   window.__qaObserveIpc=message=>{
    const command=message.cmd;
    if(/paste|copy_record|clipboard-manager\|(write|clear)/.test(command)){stats.blockedPaste++;message.cmd='qa_image_verification_forbidden_clipboard_write';return}
    if(!['get_image_thumbnail','get_image_base64','get_clipboard_records','get_storage_path'].includes(command))return;
    stats.commands[command]=(stats.commands[command]||0)+1;stats.active[command]=(stats.active[command]||0)+1;stats.peak[command]=Math.max(stats.peak[command]||0,stats.active[command]);
    if(command==='get_image_thumbnail'){paths.add(message.payload.path);stats.thumbnailPaths=[...paths]}
    const callbacks=window.__TAURI_INTERNALS__.callbacks;let settled=false;
    for(const [id,success] of [[message.callback,true],[message.error,false]]){
     const original=callbacks.get(id);if(typeof original!=='function')throw Error('Missing Tauri callback');
     callbacks.set(id,value=>{if(!settled){settled=true;stats.active[command]--;if(success)stats.returnedBytes+=typeof value==='string'?value.length:new TextEncoder().encode(JSON.stringify(value)).length}return original(value)});
    }
   };
  });
  const session=await page.context().newCDPSession(page);await session.send('Debugger.enable');
  const {result}=await session.send('Runtime.evaluate',{expression:'window.__TAURI_INTERNALS__.ipc'});
  const breakpoint=await session.send('Debugger.setBreakpointOnFunctionCall',{objectId:result.objectId,condition:'(window.__qaObserveIpc(message), false)'});observers.push({session,breakpoint});
  await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'));
  assert.equal(await page.evaluate(()=>window.__qaImageStats.commands.get_storage_path),1,'IPC observer must pass its native self-check');
 };
 const cache=page=>page.evaluate(async()=>{
  const entry=performance.getEntriesByType('resource').find(e=>/\/clipboardStore-[^/]+\.js$/.test(e.name));const module=await import(entry.name);
  const store=Object.values(module).find(value=>typeof value?.getState==='function'&&typeof value.getState().getThumbnail==='function');const state=store.getState();
  return {stats:window.__qaImageStats,thumbs:Object.keys(state.thumbnailCache).length,thumbReservedBytes:Object.values(state.thumbnailCache).reduce((sum,value)=>sum+value.length*2,0),previews:Object.keys(state.imageCache).length,previewReservedBytes:Object.values(state.imageCache).reduce((sum,value)=>sum+value.length*2,0),records:state.records.length,documentHidden:document.hidden,renderedImages:document.images.length};
 });
 const emit=async(event,payload)=>main.evaluate(({event,payload})=>window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to',{target:{kind:'WebviewWindow',label:'radial-menu'},event,payload}),{event,payload});
 const invoke=(command,args)=>main.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 let monitor;let pinned=false;
 try {
  const load=fixture({action:'image_load',prefix,count:150});record('150 synthetic native PNG images prepared',load);
  await install(main);await install(radial);
  const initial=await cache(radial);assert.equal(initial.stats.commands.get_image_thumbnail||0,0);assert.equal(initial.renderedImages,0);record('never-opened radial requests no images',initial);
  monitor=spawn(process.env.QA_PYTHON,[path.join(__dirname,'monitor-qa-processes.py'),metadata,memoryPath,phasePath,stopPath],{env:{...process.env,PYTHONUTF8:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});let monitorError='';monitor.stderr.on('data',data=>monitorError+=data);
  const lines=readline.createInterface({input:monitor.stdout});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(monitorError||'monitor timeout')),10000);lines.once('line',()=>{clearTimeout(timer);resolve()});monitor.once('exit',code=>{if(code){clearTimeout(timer);reject(Error(monitorError))}})});
  execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'restore-qa-window.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:'ignore'});
  if(await main.locator('.lifecycle-error').count())await main.locator('.lifecycle-error button').click();
  await main.locator('.sidebar-nav').getByRole('button',{name:'剪切板',exact:true}).click();await main.getByPlaceholder('搜索剪切板...',{exact:true}).fill(prefix);
  await main.waitForFunction(()=>document.querySelectorAll('.clipboard-card').length===120);
  await main.getByRole('button',{name:'固定窗口',exact:true}).click();pinned=true;
  phase('main-first-visible');await wait(1500);
  const scroll=async(page,selector,steps)=>{
   for(let step=0;step<steps;step++){await page.locator(selector).evaluate((element,index)=>{element.scrollTop=index*180},step);await wait(65)}
  };
  phase('main-scroll-120');await scroll(main,'.clipboard-list',100);await main.locator('.clipboard-load-more').click();await main.waitForFunction(()=>document.querySelectorAll('.clipboard-card').length===150);
  await scroll(main,'.clipboard-list',150);await wait(1200);const afterScroll=await cache(main);
  record('main scroll observation before acceptance',{...afterScroll,geometry:await main.locator('.clipboard-list').evaluate(element=>({top:element.scrollTop,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,visibleThumbs:[...element.querySelectorAll('.clipboard-card-thumb')].filter(thumb=>{const box=thumb.getBoundingClientRect(),list=element.getBoundingClientRect();return box.bottom>list.top&&box.top<list.bottom}).length}))});
  assert.ok(afterScroll.stats.thumbnailPaths.length>80);assert.ok(afterScroll.thumbs<=80);assert.ok(afterScroll.thumbReservedBytes<=12*1024*1024);record('main scroll past cache capacity stays bounded',afterScroll);
  phase('main-stopped');const stopped=afterScroll.stats.commands.get_image_thumbnail;await wait(2500);assert.equal((await cache(main)).stats.commands.get_image_thumbnail,stopped);record('stopped main list does not refetch evicted offscreen images',{before:stopped,after:(await cache(main)).stats.commands.get_image_thumbnail});
  phase('main-hover');await main.locator('.clipboard-list').evaluate(element=>element.scrollTop=0);await wait(600);
  for(let index=0;index<20;index++){const thumb=main.locator('.clipboard-card-thumb').nth(index);await thumb.scrollIntoViewIfNeeded();await thumb.hover();await wait(25)}
  await main.locator('.panel-window-header').hover();await wait(800);const fast=await cache(main);record('rapid hover and leave bounded full-image work',fast);
  const thumb=main.locator('.clipboard-card-thumb').first();await thumb.scrollIntoViewIfNeeded();await thumb.hover();await main.locator('.thumb-hover-overlay img').waitFor();await wait(500);await main.screenshot({path:path.join(directory,'main-full-preview.png')});await main.locator('.panel-window-header').hover();
  phase('both-visible');await invoke('plugin:window|show',{label:'radial-menu'});await emit('radial-menu-down',{x:20,y:20,theme:'light'});await radial.locator('[data-radial-list]').waitFor();await wait(1500);await scroll(radial,'[data-radial-list]',100);await wait(1000);
  const both={main:await cache(main),radial:await cache(radial)};for(const value of Object.values(both)){assert.ok((value.stats.peak.get_image_thumbnail||0)<=3);assert.ok((value.stats.peak.get_image_base64||0)<=1);assert.ok(value.thumbs<=80);assert.ok(value.previews<=4);assert.ok(value.previewReservedBytes<=24*1024*1024)}record('two native WebViews have independent bounded image pools',both);
  await emit('radial-menu-move',{x:-100,y:-100});await wait(100);await emit('radial-menu-up',null);await radial.waitForFunction(()=>!document.querySelector('[data-radial-list]'));
  phase('radial-hidden');const closed=await cache(radial);await wait(1500);const closedAfter=await cache(radial);assert.equal(closedAfter.stats.commands.get_image_thumbnail,closed.stats.commands.get_image_thumbnail);assert.equal(closedAfter.renderedImages,0);assert.equal(closedAfter.stats.blockedPaste,0);record('closed radial unmounts all images and stops requests',closedAfter);
  phase('main-hidden');await main.locator('.window-close-btn').click();await wait(500);
  assert.equal(await invoke('plugin:window|is_visible',{label:'main'}),false);
  const hidden=await cache(main);
  for(let index=0;index<10;index++){await invoke('plugin:event|emit_to',{target:{kind:'WebviewWindow',label:'main'},event:'clipboard-refresh',payload:{storage_epoch:await invoke('get_storage_epoch'),value:null}});await wait(50)}
  await main.locator('.clipboard-list').evaluate(element=>element.scrollTop=element.scrollHeight);await wait(1500);
  const hiddenAfter=await cache(main);assert.equal(hiddenAfter.stats.commands.get_image_thumbnail,hidden.stats.commands.get_image_thumbnail);assert.equal(hiddenAfter.stats.commands.get_clipboard_records,hidden.stats.commands.get_clipboard_records);
  record('native-hidden main pauses image and repeated refresh requests',{before:hidden,after:hiddenAfter,nativeVisible:false});
  await invoke('plugin:window|show',{label:'main'});await invoke('plugin:window|set_focus',{label:'main'});report.passed=true;
 } catch(error){record('failed',{error:error.message});throw error}
 finally {
  try{await emit('radial-menu-move',{x:-100,y:-100});await wait(100);await emit('radial-menu-up',null)}catch{}
  try{await invoke('plugin:window|show',{label:'main'});if(pinned)await main.getByRole('button',{name:'取消固定',exact:true}).click()}catch{}
  for(const {session,breakpoint} of observers)try{await session.send('Debugger.removeBreakpoint',breakpoint);await session.detach()}catch{}
  record('only own synthetic images removed',fixture({action:'remove_image_load',prefix}));
  if(monitor){fs.writeFileSync(stopPath,'stop');await new Promise(resolve=>{if(monitor.exitCode!==null)resolve();else monitor.once('exit',resolve)});report.memorySamples=memoryPath}
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,reportPath,steps:report.steps.map(item=>item.step)}));
 }
 process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
