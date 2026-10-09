// Real native tray Quit before the main WebView's first lifecycle_ready.
// WebView2's documented debugger-start gate controls timing; no app patch.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),metadata=path.join(root,'process.json'),wait=ms=>new Promise(r=>setTimeout(r,ms));
function connect(url){return new Promise((resolve,reject)=>{
 const socket=new WebSocket(url);socket.addEventListener('error',reject,{once:true});socket.addEventListener('open',()=>{
  let id=0;const pending=new Map();socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id&&pending.has(value.id)){const request=pending.get(value.id);pending.delete(value.id);clearTimeout(request.timer);value.error?request.reject(Error(JSON.stringify(value.error))):request.resolve(value.result)}});
  resolve({socket,send:(method,params={})=>new Promise((resolve,reject)=>{const next=++id,timer=setTimeout(()=>{pending.delete(next);reject(Error('CDP timeout: '+method))},5000);pending.set(next,{resolve,reject,timer});socket.send(JSON.stringify({id:next,method,params}))})});
 },{once:true});
})}
(async()=>{
 const info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.ok(['native-release-notes-scrollbars','native-release-image-idle','native-release-paste-settle','native-release-paste-feedback'].includes(info.nativeArtifact));assert.equal(info.profile,'release-default');assert.equal(info.debuggerPausedLaunch,true);assert.equal(info.debuggerPipeTargets.length,2);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const destination=path.join(root,'reports','lifecycle-first-ready-'+Date.now()+'.json'),report={started:new Date().toISOString(),app:info,scope:'Intended first-ready scenario using current default EXE with WebView2 debugger launch environment. Actual gate must be verified before native Quit; a mounted app fails precondition and cannot count as first-ready evidence. Not startup performance or a WebView crash.'};
 const connections=[];let helper;
 const alive=()=>JSON.parse(execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-Command',"$p=Get-Process -Id "+info.pid+" -ErrorAction SilentlyContinue; @{alive=[bool]($p -and $p.Path -eq '"+info.exe.replace(/'/g,"''")+"')} | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:5000})).alive;
 try{
  const targets=await (await fetch(process.env.QA_CDP_URL+'/json/list')).json();const main=targets.find(t=>t.url==='http://tauri.localhost/');assert.ok(main);
  for(const target of targets.filter(t=>t.type==='page'))connections.push({target,connection:await connect(target.webSocketDebuggerUrl)});
  const mainConnection=connections.find(c=>c.target.id===main.id).connection;
  const before=(await mainConnection.send('Runtime.evaluate',{expression:'JSON.stringify({rootChildren:document.querySelector("#root")?.childElementCount||0,readyState:document.readyState,sidebar:!!document.querySelector(".sidebar-nav"),tauri:typeof window.__TAURI_INTERNALS__})',returnByValue:true})).result;
  assert.equal(before.type,'string');report.before=JSON.parse(before.value);report.debuggerGateObserved=report.before.rootChildren===0&&!report.before.sidebar;assert.equal(report.debuggerGateObserved,true,'Initial debugger gate did not hold app JS; no native Quit dispatched');
  if(process.argv.includes('--observe-startup')){
   const enabled=process.argv.includes('--auto=1');assert.ok(enabled||process.argv.includes('--auto=0'));
   report.scope='Real new native process; script gate verified before application mount, bridge counts installed before initial lifecycle_ready. Native update request is a real public GitHub read, no fabricated response. Debugger-controlled startup is not a startup performance measurement.';
   const installed=await mainConnection.send('Runtime.evaluate',{expression:`(()=>{
    const owner=window.chrome.webview,original=owner.postMessage,originalFetch=window.fetch,q=window.__qaStartup={commands:{}},seen=new Set(),allowed=new Set(['lifecycle_ready','get_app_info','check_for_updates']);
    const observe=(cmd,callback)=>{if(!allowed.has(cmd)||seen.has(String(callback)))return;seen.add(String(callback));if(seen.size>1000)throw Error('Startup observation exceeded bound');q.commands[cmd]=(q.commands[cmd]||0)+1};
    const wrapped=function(...args){let m;try{m=typeof args[0]==='string'?JSON.parse(args[0]):args[0]}catch{}if(m)observe(m.cmd,m.callback);return original.apply(this,args)};
    const wrappedFetch=function(input,init){let command;try{const url=new URL(typeof input==='string'?input:input.url),origin=new URL(window.__TAURI_INTERNALS__.convertFileSrc('get_app_info','ipc'));if(url.protocol===origin.protocol&&url.host===origin.host)command=decodeURIComponent(url.pathname.slice(1))}catch{}if(allowed.has(command)){const h=init?.headers instanceof Headers?init.headers:new Headers(init?.headers);observe(command,h.get('Tauri-Callback'))}return originalFetch.call(this,input,init)};
    owner.postMessage=wrapped;window.fetch=wrappedFetch;q.restore=()=>{if(owner.postMessage===wrapped)owner.postMessage=original;if(window.fetch===wrappedFetch)window.fetch=originalFetch};return owner.postMessage===wrapped&&window.fetch===wrappedFetch
   })()`,returnByValue:true});assert.equal(installed.result.value,true);
   for(const {connection}of connections)await connection.send('Runtime.runIfWaitingForDebugger');
   const started=Date.now();let current;
   while(Date.now()-started<30000){
    const result=await mainConnection.send('Runtime.evaluate',{expression:`(async()=>{if(!document.querySelector('.sidebar-nav'))return null;const resource=performance.getEntriesByType('resource').find(e=>/\\/main-[^/]+\\.js$/.test(e.name));if(!resource)return null;const store=Object.values(await import(resource.name)).find(v=>v?.getState?.().check&&v.getState().setAutoCheck);if(!store)return null;const s=store.getState();return JSON.stringify({initialized:s.initialized,checking:s.checking,auto:s.autoCheck,status:s.result?.status,error:s.error,commands:window.__qaStartup.commands})})()`,awaitPromise:true,returnByValue:true});
    if(result.result.value){current=JSON.parse(result.result.value);if(current.initialized&&!current.checking&&(current.commands.check_for_updates||0)===(enabled?1:0))break;}
    await wait(100);
   }
   report.nativeStartup=current;assert.ok(current?.initialized);assert.equal(current.checking,false);assert.equal(current.auto,enabled);assert.equal(current.commands.lifecycle_ready,1);assert.equal(current.commands.get_app_info,1);assert.equal(current.commands.check_for_updates||0,enabled?1:0);
   if(enabled)assert.ok(current.status||current.error);
   report.nativeStartup=current;report.passed=true;return;
  }
  helper=spawn(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'operate-qa-tray.ps1'),'-Metadata',metadata,'-Action','quit'],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',stderr='';helper.stdout.on('data',d=>output+=d);helper.stderr.on('data',d=>stderr+=d);
  await new Promise((resolve,reject)=>{let poll;const timer=setTimeout(()=>{clearInterval(poll);reject(Error('Tray readiness timeout'))},5000);poll=setInterval(()=>{if(output.includes('"ready":true')){clearInterval(poll);clearTimeout(timer);resolve()}},25);helper.once('exit',code=>{clearInterval(poll);clearTimeout(timer);reject(Error('Tray helper ended before dispatch '+code+stderr))})});
  helper.stdin.end('quit\n');await new Promise((resolve,reject)=>helper.once('exit',code=>code===0?resolve():reject(Error(stderr))));helper=null;report.nativeQuitDispatched=true;
  await wait(700);assert.equal(alive(),true);report.stayedAliveBeforeReady=true;
  const still=(await mainConnection.send('Runtime.evaluate',{expression:'document.querySelector("#root")?.childElementCount||0',returnByValue:true})).result;assert.equal(still.value,0);
  for(const {connection}of connections)await connection.send('Runtime.runIfWaitingForDebugger').catch(()=>{});
  const start=Date.now();while(Date.now()-start<10000&&alive())await wait(100);assert.equal(alive(),false);report.exitAfterResumeMs=Date.now()-start;report.passed=true;
 }catch(e){report.error=e.stack||String(e);throw e}
 finally{
  if(helper){helper.stdin.end();helper.kill()}
  // Failure must not leave the main runtime paused and prevent wrapper recovery.
  for(const {connection,target}of connections){await connection.send('Runtime.runIfWaitingForDebugger').catch(()=>{});if(target.url==='http://tauri.localhost/')await connection.send('Runtime.evaluate',{expression:'window.__qaStartup?.restore?.()'}).catch(()=>{});connection.socket.close()}
  report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));
 }
})().catch(e=>{console.error(e.stack||String(e));process.exitCode=1});
