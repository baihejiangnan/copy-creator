// Recovery only: resume script-debugger waiting targets of the verified QA app.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{
 const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(path.resolve(info.exe),path.join(root,'copy-creator-qa.exe'));if(!info.debuggerPausedLaunch){console.log(JSON.stringify({resumed:0,notDebuggerLaunch:true}));return;}assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 let targets;try{targets=await(await fetch(`http://127.0.0.1:${info.debugPort}/json/list`,{signal:AbortSignal.timeout(3000)})).json()}catch{console.log(JSON.stringify({resumed:0,endpointUnavailable:true,scope:'Stop helper still verifies actual native process termination'}));return;}
 let resumed=0;
 for(const target of targets.filter(t=>t.type==='page')){
  const url=new URL(target.webSocketDebuggerUrl);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,String(info.debugPort));
  await new Promise((resolve,reject)=>{const socket=new WebSocket(url),timer=setTimeout(()=>{socket.close();reject(Error('Debugger recovery timeout'))},3000);socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method:'Runtime.runIfWaitingForDebugger'})));socket.addEventListener('error',error=>{clearTimeout(timer);reject(error)},{once:true});socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id===1){clearTimeout(timer);socket.close();value.error?reject(Error(JSON.stringify(value.error))):(resumed++,resolve())}});});
 }
 console.log(JSON.stringify({resumed,scope:'Only owned QA page runtimes resumed; no target closed'}));
})().catch(error=>{console.error(error.stack||String(error));process.exitCode=1});
