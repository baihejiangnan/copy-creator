// Process-cold / OS-cache-warm startup and first-page observations, not disk-cold.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),metadata=path.join(root,'process.json');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const read=()=>JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
const distribution=values=>{const sorted=[...values].sort((a,b)=>a-b),at=p=>sorted[Math.ceil(sorted.length*p)-1];return {samples:sorted.length,p50_ms:at(.5),p95_ms:at(.95),max_ms:at(1)}};
const ps=(script,args=[])=>new Promise((resolve,reject)=>{
 const child=spawn(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,script),'-Metadata',metadata,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';
 const timer=setTimeout(()=>{child.kill();reject(Error(script+' timeout; stdout='+output+' stderr='+error))},30000);
 child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>error+=value);
 child.on('error',failure=>{clearTimeout(timer);reject(failure)});child.on('exit',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error(script+' failed '+code+': '+error))});
});
(async()=>{
 const initial=read();assert.equal(initial.identifier,'com.copycreator.qa20261007');assert.ok(path.resolve(initial.exe).startsWith(root+path.sep));
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(initial.exe)).digest('hex'),initial.sha256.toLowerCase());
 if(process.argv[2]==='--sample'){
  assert.ok(initial.launchStartedUnixMs);const browser=await chromium.connectOverCDP(`http://127.0.0.1:${initial.debugPort}`);let page;
  for(let attempt=0;attempt<100;attempt++){
   for(const candidate of browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()==='http://tauri.localhost/')){
    if(await candidate.evaluate(()=>performance.timeOrigin).catch(()=>0)>=initial.launchStartedUnixMs-200){page=candidate;break}
   }
   if(page)break;await wait(100);
  }assert.ok(page);page.setDefaultTimeout(15000);
  const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(initial.storageRoot));
  await invoke('plugin:window|show',{label:'main'});await invoke('plugin:window|set_focus',{label:'main'});
  await page.waitForFunction(()=>document.querySelectorAll('.sidebar-nav button').length===5&&document.querySelector('.clipboard-page')&&!document.querySelector('.skeleton-line'));
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});
  const sample={pid:initial.pid,startupObservedMs:Date.now()-initial.launchStartedUnixMs,firstPages:{},navigation:await page.evaluate(()=>({timeOrigin:performance.timeOrigin,domContentLoaded:performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd,fontsLoaded:document.fonts.status==='loaded',visible:document.visibilityState}))};
  // Programmatic DOM clicks execute actual React page paths; no physical-input claim.
  for(const [name,index,selector] of [['notes',1,'.notes-page .notes-toolbar input[type="search"]'],['phrases',2,'.phrase-page input'],['translate',3,'.translation-page textarea'],['vault',4,'.vault-page input']]){
   const result=await page.evaluate(async({index,selector,name})=>{
    const start=performance.now();document.querySelectorAll('.sidebar-nav button')[index].click();
    const ready=()=>new Promise((resolve,reject)=>{const poll=()=>{const element=document.querySelector(selector);if(element&&!element.disabled){resolve();return}if(performance.now()-start>10000){reject(Error('Page not ready: '+name));return}requestAnimationFrame(poll)};poll()});
    await ready();await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {ms:performance.now()-start,start};
   },{index,selector,name});sample.firstPages[name]=result.ms;
   if(name==='notes'){
    const start=await page.evaluate(()=>performance.now());await page.locator('.notes-page .notes-toolbar').first().locator('button').first().click();await page.locator('.cm-content[contenteditable="true"]').waitFor();
    sample.notesEditorAfterListMs=await page.evaluate(start=>performance.now()-start,start);
    sample.notesInputFromNavigationMs=await page.evaluate(start=>performance.now()-start,result.start);
   }
  }
  if(process.argv.includes('--warm')){
   sample.warmPages=await page.evaluate(async()=>{
    const samples={};
    for(let round=0;round<110;round++)for(const [name,index,selector] of [['clipboard',0,'.clipboard-page input'],['notes',1,'.notes-page .cm-content'],['phrases',2,'.phrase-page input'],['translate',3,'.translation-page textarea'],['vault',4,'.vault-page input']]){
     const start=performance.now();document.querySelectorAll('.sidebar-nav button')[index].click();
     await new Promise((resolve,reject)=>{const poll=()=>{const element=document.querySelector(selector);if(element&&!element.disabled&&element.getClientRects().length){resolve();return}if(performance.now()-start>10000){reject(Error('Warm page not ready: '+name));return}requestAnimationFrame(poll)};poll()});
     await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));(samples[name]??=[]).push(performance.now()-start);
    }return Object.fromEntries(Object.entries(samples).map(([name,rows])=>[name,rows.slice(10)]));
   });
  }
  const allResources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/\.(js|css)(?:\?|$)/.test(e.name)).map(e=>({path:new URL(e.name).pathname,start:e.startTime,end:e.responseEnd,duration:e.duration})));sample.resources=allResources;
  console.log(JSON.stringify(sample));process.exit(0);
 }
 const count=process.argv[2]==='--warm-only'?1:30;
 const report={started:new Date().toISOString(),app:initial,samples:[],scope:count+' new process(es), same existing QA data and WebView profile, OS file caches not flushed. Startup is observed upper bound from process StartTime through CDP/DOM/fonts/two frames; includes observer overhead. Page clocks start at programmatic DOM click. Owned tray Quit between samples; final wrapper harness stop is not dirty-content acceptance.'};
 const destination=path.join(root,'reports','startup-pages-'+Date.now()+'.json'),record=()=>fs.writeFileSync(destination,JSON.stringify(report,null,2));record();
 try{
  for(let index=0;index<count;index++){
   if(index){await ps('stop-saved-qa.ps1',['-Graceful']);await wait(700);await ps('launch-saved-qa.ps1')}
   const current=read();assert.equal(current.sha256,initial.sha256);
   const sample=JSON.parse(execFileSync(process.execPath,[__filename,'--sample',...(index===count-1?['--warm']:[])],{windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:1024*1024}));
   report.samples.push(sample);record();console.log(JSON.stringify({sample:index+1,startupObservedMs:sample.startupObservedMs,firstPages:sample.firstPages}));
  }
  assert.equal(new Set(report.samples.map(sample=>sample.pid)).size,count);
  report.latency={startupObserved:distribution(report.samples.map(s=>s.startupObservedMs)),notesEditorAfterList:distribution(report.samples.map(s=>s.notesEditorAfterListMs)),...Object.fromEntries(Object.keys(report.samples[0].firstPages).map(name=>[name,distribution(report.samples.map(s=>s.firstPages[name]))]))};
  report.latency.notesInputFromNavigation=distribution(report.samples.map(s=>s.notesInputFromNavigationMs));
  report.warmLatency=Object.fromEntries(Object.entries(report.samples.at(-1).warmPages).map(([name,rows])=>[name,distribution(rows)]));
  report.passed=true;record();console.log(JSON.stringify({passed:true,report:destination,latency:report.latency,warmLatency:report.warmLatency}));process.exit(0);
 }catch(error){report.error=error.message;record();throw error}
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
