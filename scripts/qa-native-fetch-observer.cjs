// Numeric IPC transport observation, without Debugger breakpoints. The locked
// Tauri 2.11.1 protocol may use fetch or the WebView postMessage fallback.
// Inspect only command/callback IDs; never log payloads, headers or invoke keys.
exports.install=async page=>{
 await page.evaluate(()=>{
  if(window.__qaNativeFetch)throw Error('Fetch observer already installed');
  const original=window.fetch,origin=new URL(window.__TAURI_INTERNALS__.convertFileSrc('get_storage_path','ipc'));
  const allowed=new Set(['get_storage_path','get_clipboard_records','get_image_thumbnail','get_image_base64']);
  const q=window.__qaNativeFetch={original,commands:{},active:{},peak:{},phases:{},phase:'setup',errors:0,transports:{},restores:[]};
  const seen=new Set();
  const observe=(command,callback,error,transport)=>{
   if(!allowed.has(command))return;
   if(seen.has(callback))return;seen.add(callback);if(seen.size>10000)throw Error('Bounded observer exhausted');
   q.transports[transport]=(q.transports[transport]||0)+1;
   q.commands[command]=(q.commands[command]||0)+1;q.active[command]=(q.active[command]||0)+1;q.peak[command]=Math.max(q.peak[command]||0,q.active[command]);
   const phase=q.phases[q.phase]??={};phase[command]=(phase[command]||0)+1;
   let settled=false;for(const id of [callback,error]){const originalCallback=window.__TAURI_INTERNALS__.callbacks.get(Number(id));if(typeof originalCallback!=='function')throw Error('Native callback missing');window.__TAURI_INTERNALS__.callbacks.set(Number(id),value=>{if(!settled){settled=true;q.active[command]--;if(Number(id)===Number(error))q.errors++;}return originalCallback(value)})}
  };
  const wrapped=function(input,init){
   let command;try{const target=new URL(typeof input==='string'?input:input.url);if(target.protocol===origin.protocol&&target.host===origin.host){const candidate=decodeURIComponent(target.pathname.slice(1));if(allowed.has(candidate))command=candidate}}catch{}
   if(!command)return original.call(this,input,init);
   const headers=init?.headers instanceof Headers?init.headers:new Headers(init?.headers);observe(command,headers.get('Tauri-Callback'),headers.get('Tauri-Error'),'fetch');
   return original.call(this,input,init);
  };
  q.wrapped=wrapped;window.fetch=wrapped;if(window.fetch!==wrapped)throw Error('Fetch transport is not replaceable');
  q.restores.push(()=>{if(window.fetch!==wrapped)throw Error('Fetch ownership changed');window.fetch=original});
  const wrapBridge=(owner,name)=>{
   if(typeof owner?.postMessage!=='function')return false;
   const originalBridge=owner.postMessage,wrappedBridge=function(...args){let message;try{message=typeof args[0]==='string'?JSON.parse(args[0]):args[0]}catch{}if(message&&typeof message==='object')observe(message.cmd,message.callback,message.error,name);return originalBridge.apply(this,args)};
   try{owner.postMessage=wrappedBridge}catch{}if(owner.postMessage!==wrappedBridge)return false;
   q.restores.push(()=>{if(owner.postMessage!==wrappedBridge)throw Error('Bridge ownership changed');owner.postMessage=originalBridge});return true;
  };
  if(!wrapBridge(window.ipc,'ipc-postMessage'))wrapBridge(window.chrome?.webview,'webview-postMessage');
 });
 await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'));
 const check=await page.evaluate(()=>({count:window.__qaNativeFetch.commands.get_storage_path,active:window.__qaNativeFetch.active.get_storage_path,transports:window.__qaNativeFetch.transports}));
 if(check.count!==1||check.active!==0)throw Error('Native transport observer self-check failed: '+JSON.stringify(check));
};
exports.restore=async page=>page.evaluate(()=>{const q=window.__qaNativeFetch;if(!q)return;for(const restore of q.restores.reverse())restore();delete window.__qaNativeFetch;});
exports.snapshot=async page=>page.evaluate(()=>{const q=window.__qaNativeFetch;return {commands:q.commands,active:q.active,peak:q.peak,phases:q.phases,errors:q.errors,transports:q.transports}});
