// Twenty actual physical-chord/native-paste cycles; dedicated owned textbox only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),readline=require('node:readline'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');assert.ok(['native-release-image-idle','native-release-paste-monitor','native-release-paste-settle','native-release-paste-feedback'].includes(info.nativeArtifact));assert.equal(info.profile,'release-default');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);page.setDefaultTimeout(10000);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));const epoch=await invoke('get_storage_epoch');
 const prefix='QA controlled clipboard repeat '+crypto.randomUUID()+' ',destination=path.join(root,'reports','paste-repeat-'+Date.now()+'.json'),report={app:info,started:new Date().toISOString(),runPrefix:prefix,cycles:[],scope:'Physical Ctrl+Shift+right-click from dedicated helper textbox; actual native text paste and exact Unicode target content, focus and foreground assertions. No arbitrary paste target, no IME simulation, no latency benchmark. Clipboard preserved/restored by outer wrapper.'};
 const helper=spawn(process.env.QA_POWERSHELL,['-NoProfile','-STA','-File',path.join(__dirname,'qa-desktop-target.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let queued=[],pending=[],ended=false,helperError='';helper.stderr.on('data',d=>helperError+=d);
 readline.createInterface({input:helper.stdout}).on('line',line=>{let value;try{value=JSON.parse(line)}catch{return}pending.length?pending.shift().resolve(value):queued.push(value)});
 helper.on('exit',code=>{ended=true;for(const p of pending.splice(0))p.reject(Error('Owned helper exited '+code+': '+helperError))});
 const next=()=>queued.length?Promise.resolve(queued.shift()):ended?Promise.reject(Error('Owned helper ended')):new Promise((resolve,reject)=>{const item={resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}};const timer=setTimeout(()=>{pending=pending.filter(p=>p!==item);reject(Error('Owned helper response timeout'))},15000);pending.push(item)});
 const command=async request=>{const response=next();helper.stdin.write(JSON.stringify(request)+'\n');return response};
 try{
  const ready=await next();assert.equal(ready.ready,true);report.ownedHelperPid=ready.pid;report.clipboardProbe='Non-opening GetOpenClipboardWindow snapshot at KeyPress: 0=no opener window observed (not guaranteed available), 1=QA app, 2=owned target, 3=other process. A predefined process category may be resolved after input handling; no PID, arbitrary process name, path, command line, window title or clipboard content exported.';
  const selfControl=process.argv.includes('--self-control'),uiCard=process.argv.includes('--ui-card'),helperControl=process.argv.includes('--helper-control');assert.ok([selfControl,uiCard,helperControl].filter(Boolean).length<=1);report.selfControl=selfControl;report.uiCard=uiCard;report.helperControl=helperControl;
  const backgroundKeys=process.argv.includes('--background-keys');assert.ok(!backgroundKeys||helperControl);report.backgroundKeys=backgroundKeys;
  const fastFocus=process.argv.includes('--fast-focus');assert.ok(!fastFocus||helperControl);report.fastFocus=fastFocus;
  const clipboardBusy=process.argv.includes('--clipboard-busy');assert.ok(!clipboardBusy||![selfControl,uiCard,helperControl].some(Boolean));report.clipboardBusy=clipboardBusy;
  const clipboardRecover=process.argv.includes('--clipboard-recover');assert.ok(!clipboardRecover||![clipboardBusy,selfControl,uiCard,helperControl].some(Boolean));const clipboardHoldMs=clipboardRecover?250:clipboardBusy?1000:0;report.clipboardHoldMs=clipboardHoldMs;
  if(clipboardBusy)report.scope='Negative acceptance: owned helper holds only this round synthetic clipboard for 1000ms after native write; native paste must refuse before V, leave target empty and release Ctrl. Hold always finishes before helper closes and outer restoration. Not a successful insertion test.';
  if(clipboardRecover)report.scope='Recovery acceptance: owned helper holds only this round synthetic clipboard for 250ms after native write, then releases; native paste must wait and insert exactly once. Hold always finishes before helper closes and outer restoration.';
  if(helperControl)report.scope='Control only: physical app hotkey, actual native copy_text, hide app, explicit owned-target focus, then helper-generated Ctrl+V '+(backgroundKeys?'from a background thread so the target UI can process each key immediately.':'on the target UI thread, blocking its message loop during the chord.')+' Differs from product focus restoration and injection; cannot substitute for product acceptance.';
  if(fastFocus)report.scope+=' Explicit helper focus uses no additional 100ms settling delay; foreground and textbox focus are still asserted.';
  if(uiCard){await invoke('plugin:window|show',{label:'main'});await invoke('plugin:window|set_focus',{label:'main'});await command({command:'focusQa'});await page.locator('.sidebar-nav').getByRole('button',{name:/^(剪切板|Clipboard)$/}).click();await page.getByPlaceholder(/^(搜索剪切板\.\.\.|Search clipboard\.\.\.)$/).fill(prefix.trim());await wait(Math.max(0,info.launchStartedUnixMs+2100-Date.now()));}
  const cycles=Number(process.argv.find(v=>v.startsWith('--cycles='))?.split('=')[1]||20);assert.ok([2,20].includes(cycles));report.requestedCycles=cycles;
  await wait(Math.max(0,info.launchStartedUnixMs+2600-Date.now())); // Let initial native show/load settle before taking owned focus.
  for(let round=0;round<cycles;round++){
   const expected=(prefix+round+' 中文😀 '+('repeat '.repeat(round%4))).trimEnd();
   await invoke('plugin:window|hide',{label:'main'});await command({command:'clearTarget'});const focused=await command({command:'focusTarget'});assert.equal(focused.textboxFocused,true);await wait(150);
   if(selfControl){await command({command:'writeSynthetic',text:expected});await command({command:'selfPaste'});}
   else{if(uiCard){await command({command:'writeSynthetic',text:expected});let captured=false;for(let i=0;i<60;i++){const rows=await invoke('get_clipboard_records',{search:expected,limit:30});if(rows.some(row=>(row.content||row.preview||'')===expected)){captured=true;break}await wait(50)}assert.equal(captured,true,'Synthetic UI paste fixture must be committed by the actual monitor');}await command({command:'globalToggle'});
   await page.waitForFunction(async()=>await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'}));let qaFocus;for(let i=0;i<40;i++){qaFocus=await command({command:'assertQaForeground'});if(qaFocus.qaForeground)break;await wait(25)}assert.equal(qaFocus.qaForeground,true,'Selection must follow actual QA foreground activation');report.beforePaste=qaFocus;if(clipboardHoldMs){await command({command:'armClipboardHold',expected,milliseconds:clipboardHoldMs});let error=null;try{await invoke('paste_text',{text:expected,expectedStorageEpoch:epoch})}catch(e){error=String(e)}report.beforeHoldRelease=await command({command:'assertTarget',expected});assert.equal((await command({command:'finishClipboardHold'})).heldSyntheticClipboard,true);const target=await command({command:'assertTarget',expected}),trace=await command({command:'keyTrace'});report.lastRound={round:round+1,...target,...trace,error};if(clipboardBusy){assert.ok(error?.includes('clipboard.pasteFailed'),'Busy clipboard must reject before dispatch, not acknowledge a lost paste');assert.equal(target.length,0);assert.equal(target.physicalModifiers,0);assert.equal(trace.keys.some(k=>k.key===86||k.character===22),false);if(info.nativeArtifact==='native-release-paste-feedback'){
 await page.locator('.clipboard-paste-toast[role=alert]').waitFor({state:'visible'});
 assert.equal(await invoke('plugin:window|is_visible',{label:'main'}),true);
 assert.match(await page.locator('.clipboard-paste-toast').innerText(),/无法完成粘贴|Could not complete the paste/);
 for(const themeMode of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),themeMode);
  await page.screenshot({path:destination.replace('.json','-alert-'+(round+1)+'-'+themeMode+'.png')});
 }
 await page.locator('.clipboard-paste-toast button').click();
 await page.locator('.clipboard-paste-toast').waitFor({state:'hidden'});
 report.visibleFailureAlert=true;
}
report.cycles.push({round:round+1,busyRejectedBeforeV:true,noDuplicatePaste:true,controlReleased:true});continue;}assert.equal(error,null,'Transient synthetic clipboard hold must recover');}else if(uiCard){await page.locator('.clipboard-card').filter({hasText:expected}).getByText(expected,{exact:true}).click();}else if(helperControl){await invoke('copy_text',{text:expected,expectedStorageEpoch:epoch});await invoke('plugin:window|hide',{label:'main'});assert.equal((await command({command:fastFocus?'focusTargetFast':'focusTarget'})).textboxFocused,true);await command({command:backgroundKeys?'backgroundPaste':'selfPaste'});}else{await invoke('paste_text',{text:expected,expectedStorageEpoch:epoch});}}
   let result;for(let i=0;i<40;i++){result=await command({command:'assertTarget',expected});if(result.targetMatches&&result.textboxFocused&&result.targetForeground&&(!backgroundKeys||result.physicalModifiers===0))break;await wait(50)}report.lastRound={round:round+1,...result,...await command({command:'assertClipboard',expected}),...await command({command:'keyTrace'}),...await command({command:'assertQaForeground'})};if(!result.targetMatches&&result.length===0&&result.textboxFocused&&result.targetForeground){report.failedRoundDirectDiagnostic=await command({command:'diagnoseEmptyPaste',expected});}assert.equal(result.targetMatches,true);assert.equal(result.textboxFocused,true);assert.equal(result.targetForeground,true);if(backgroundKeys)assert.equal(result.physicalModifiers,0);
   report.cycles.push({round:round+1,exactText:true,ownedTargetFocused:true,ownedTargetForeground:true,length:result.length,keys:report.lastRound.keys});fs.writeFileSync(destination,JSON.stringify(report,null,2));
  }
  if(clipboardBusy&&info.nativeArtifact==='native-release-paste-feedback'){
   await invoke('plugin:window|hide',{label:'main'});
   await invoke('plugin:event|emit',{event:'clipboard-paste-failed',payload:{storage_epoch:epoch+1000,value:true}});
   await wait(150);assert.equal(await invoke('plugin:window|is_visible',{label:'main'}),false);
   assert.equal(await page.locator('.clipboard-paste-toast').count(),0);
   await invoke('plugin:event|emit',{event:'clipboard-paste-failed',payload:{storage_epoch:epoch,value:true}});
   await page.locator('.clipboard-paste-toast').waitFor({state:'visible'});
   try{
    await invoke('plugin:event|emit',{event:'storage-changed',payload:{storage_epoch:epoch+1000}});
    await page.locator('.clipboard-paste-toast').waitFor({state:'hidden'});
   }finally{await invoke('plugin:event|emit',{event:'storage-changed',payload:{storage_epoch:epoch}})}
   report.frontendEventIdentity={staleEventIgnoredWithoutShowing:true,currentEventVisible:true,identityNotificationClearedAlert:true,scope:'Synthetic native event envelopes; frontend invalidation test only, not an additional database migration.'};
  }
  report.passed=true;
 }catch(error){report.passed=false;report.error=error.stack||String(error);throw error}
 finally{
  try{
   // The ordinary monitor may retain synthetic copies. Remove this run only.
   if(report.uiCard){await invoke('plugin:window|show',{label:'main'});await page.getByPlaceholder(/^(搜索剪切板\.\.\.|Search clipboard\.\.\.)$/).fill('');}
   const rows=await invoke('get_clipboard_records',{search:prefix,limit:120});assert.ok(rows.length<=20);for(const row of rows){assert.ok((row.content||row.preview||'').startsWith(prefix));await invoke('delete_clipboard_record',{id:row.id,expectedStorageEpoch:epoch})}report.removedSyntheticRows=rows.length;
   if(!ended){await command({command:'close'});helper.stdin.end();}report.ownedHelperClosed=true;
  }catch(error){report.cleanupError=error.stack||String(error);report.passed=false;helper.stdin.end();}
  await browser.close();report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,cycles:report.cycles.length,report:destination}));
 }
 assert.equal(report.passed,true,'Repeated native paste or cleanup failed');
})().catch(error=>{console.error(error.stack||String(error));process.exitCode=1});
