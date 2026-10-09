// Requires the clipboard-preserving wrapper and explicit user authorization.
// Native input is restricted by the helper to the QA app and its own textbox.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),readline=require('node:readline');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
(async()=>{
 const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.ok(path.resolve(info.exe).startsWith(root+path.sep));
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 assert.equal(String(info.debugPort),new URL(process.env.QA_CDP_URL).port);
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);
 let page;for(let attempt=0;attempt<100;attempt++){for(const candidate of browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()==='http://tauri.localhost/'))if(await candidate.evaluate(()=>performance.timeOrigin).catch(()=>0)>=info.launchStartedUnixMs-200){page=candidate;break}if(page)break;await new Promise(r=>setTimeout(r,100))}assert.ok(page);page.setDefaultTimeout(10000);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const epoch=await invoke('get_storage_epoch'),directory=path.join(root,'controlled-desktop',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
 const report={started:new Date().toISOString(),app:info,directory,steps:[],scope:'User-authorized synthetic system clipboard, owned paste target, physical SendInput chord and real Windows IME. Original clipboard held only by outer guard.'};
 const destination=path.join(root,'reports','controlled-desktop-'+Date.now()+'.json');
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const helper=spawn(process.env.QA_POWERSHELL,['-NoProfile','-STA','-File',path.join(__dirname,'qa-desktop-target.ps1'),'-Metadata',path.join(root,'process.json')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let queued=[],pending=[],ended=false,helperError='';helper.stderr.on('data',data=>{helperError+=data;process.stderr.write(data)});
 readline.createInterface({input:helper.stdout}).on('line',line=>{let value;try{value=JSON.parse(line)}catch{return}if(pending.length)pending.shift().resolve(value);else queued.push(value)});
 helper.on('exit',code=>{ended=true;for(const request of pending.splice(0))request.reject(Error('Native helper exited '+code+': '+helperError))});
 const next=()=>queued.length?Promise.resolve(queued.shift()):ended?Promise.reject(Error('Native helper ended')):new Promise((resolve,reject)=>{const item={resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}};const timer=setTimeout(()=>{pending=pending.filter(v=>v!==item);reject(Error('Native helper timed out'))},15000);pending.push(item)});
 const command=async request=>{const response=next();helper.stdin.write(JSON.stringify(request)+'\n');return response};
 try{
  const ready=await next();assert.equal(ready.ready,true);record('owned native paste target ready',{pid:ready.pid});
  await command({command:'focusQa'});
  if(await page.locator('.lifecycle-error').isVisible())await page.locator('.lifecycle-error').getByRole('button',{name:/^(Close|关闭)$/}).click();
  await page.locator('.sidebar-nav').getByRole('button',{name:/^(便签|Notes)$/}).click();
  const notes=page.locator('.notes-page');
  await page.waitForFunction(()=>performance.getEntriesByType('resource').some(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name)));
  await page.evaluate(async()=>{const resource=performance.getEntriesByType('resource').find(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name));window.__qaWorkspace=(await import(resource.name)).useNotesWorkspace;});
  const external=path.join(directory,'中文, 空格 引用.txt');fs.writeFileSync(external,'Synthetic external file remains unchanged.');
  const body='QA controlled clipboard '+crypto.randomUUID()+' 中文😀\r\n  raw spaces  \n';
  const id=crypto.randomUUID(),draft={title:'QA controlled clipboard note '+crypto.randomUUID(),body,refs:[{id:crypto.randomUUID(),kind:'file',target:external,display_name:path.basename(external)}]};
  await invoke('create_note',{expectedStorageEpoch:epoch,id,mutationId:crypto.randomUUID(),draft});
  await page.evaluate(id=>window.__qaWorkspace.getState().open(id),id);
  await notes.getByRole('button',{name:/^(复制地址|Copy address)$/}).click();
  assert.equal((await command({command:'assertClipboard',expected:external})).clipboardMatches,true);record('actual note copy-reference button preserves exact Chinese comma/space path');
  await notes.getByRole('button',{name:/^(复制正文|Copy body)$/}).click();
  assert.equal((await command({command:'assertClipboard',expected:body})).clipboardMatches,true);record('actual copy-body button preserves raw newline and whitespace');
  // Hide first so the physical chord must actually show the app from our target.
  await invoke('plugin:window|hide',{label:'main'});await command({command:'focusTarget'});await new Promise(r=>setTimeout(r,200));
  await command({command:'globalToggle'});
  await page.waitForFunction(async()=>await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'}));
  record('physical Ctrl+Shift+right-click shows default QA main window');
  const paste='QA controlled clipboard native paste '+crypto.randomUUID()+' 中文😀';
  await invoke('paste_text',{text:paste,expectedStorageEpoch:epoch});
  let matched=false,lastTarget;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,75));lastTarget=await command({command:'assertTarget',expected:paste});if(lastTarget.targetMatches){matched=true;break}}
  report.nativePastePassed=matched;record(matched?'real native paste restores remembered owned target and inserts exact synthetic text':'native paste did not reach owned target',{lastTarget});
  if(process.argv.includes('--tray')){
   const trayId=crypto.randomUUID(),trayText='QA controlled clipboard '+crypto.randomUUID().slice(0,8);
   const prepared=JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({action:'capture',database:path.join(info.storageRoot,'data.db'),records:[{id:trayId,type:'text',content:trayText,source_app:'QA controlled tray fixture'}]}),env:{...process.env,PYTHONUTF8:'1'},windowsHide:true,encoding:'utf8'}));assert.equal(prepared.inserted,1);await invoke('update_tray_language');
   for(const action of ['copy','paste']){
    await command({command:'clearTarget'});await command({command:'focusTarget'});await new Promise(r=>setTimeout(r,150));
    const output=execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'operate-qa-tray.ps1'),'-Metadata',path.join(root,'process.json'),'-Action',action,'-RecordPreview',trayText],{windowsHide:true,timeout:15000,input:action+'\n',encoding:'utf8'});const lines=output.trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.ok(lines.some(line=>line.nativeMenu&&line.command===action));assert.ok(lines.some(line=>line.dispatched));
    let result;for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,25));result=await command({command:action==='copy'?'assertClipboard':'assertTarget',expected:trayText});if(action==='copy'?result.clipboardMatches:result.targetMatches)break}assert.equal(action==='copy'?result.clipboardMatches:result.targetMatches,true);record('actual native tray '+action+' resolves the current stamped synthetic record and completes',{nativeMenu:true,ownedTargetOnly:true});
   }
   await invoke('delete_clipboard_record',{id:trayId,expectedStorageEpoch:epoch});
  }
  await command({command:'focusQa'});
  await new Promise(r=>setTimeout(r,1800));
  const captured='QA controlled clipboard external monitor '+crypto.randomUUID()+'\r\n  中文😀 original  \n';
  await command({command:'writeSynthetic',text:captured});
  let rows=[];for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,150));rows=await invoke('get_clipboard_records',{search:captured.slice(0,85),limit:10});if(rows.some(row=>row.content===captured||row.preview?.startsWith('QA controlled clipboard external monitor')))break}
  assert.equal(rows.length,1,'Only the exact unique synthetic clipboard record expected');
  // Existing ordinary clipboard capture trims outer whitespace. Notes must
  // preserve the full stored record, which differs from the OS source here.
  const storedCapture=captured.trim();
  assert.equal(await invoke('get_clipboard_record_content',{id:rows[0].id}),storedCapture);
  await page.locator('.sidebar-nav').getByRole('button',{name:/^(剪切板|Clipboard)$/}).click();
  await page.getByPlaceholder(/^(搜索剪切板\.\.\.|Search clipboard\.\.\.)$/).fill(captured.split('\r\n')[0]);
  const card=page.locator('.clipboard-card');await card.waitFor();assert.equal(await card.count(),1);await card.click({button:'right'});
  await page.getByRole('button',{name:/^(收为便签|Save as note)$/}).click();await page.locator('.notes-page').waitFor();
  const capturedId=await page.evaluate(()=>window.__qaWorkspace.getState().selectedId);
  assert.equal((await invoke('get_note',{id:capturedId,expectedStorageEpoch:epoch})).value.body,storedCapture);record('normal OS monitor and actual card capture preserve complete stored synthetic record',{existingMonitorTrimsOuterWhitespace:true,sourceBytes:Buffer.byteLength(captured),storedBytes:Buffer.byteLength(storedCapture)});
  await page.evaluate(id=>window.__qaWorkspace.getState().open(id),id);
  const field=notes.locator('.cm-content');await field.waitFor();const editor=await require('./qa-note-editor.cjs')(page);
  await command({command:'focusQa'});await field.focus();await page.keyboard.press('Control+End');
  await page.evaluate(()=>{window.__qaComposition=[];const field=document.querySelector('.cm-content');for(const name of ['compositionstart','compositionupdate','compositionend'])field.addEventListener(name,event=>window.__qaComposition.push({type:event.type,time:performance.now(),data:event.data}),true)});
  const revision=(await invoke('get_note',{id,expectedStorageEpoch:epoch})).value.revision;
  const keyboard=await command({command:'focusQa'});await field.focus();await command({command:'typeLatin',text:'zhongwen'});
  let composition=await page.evaluate(()=>window.__qaComposition);
  if(!composition.some(event=>event.type==='compositionstart')){
   await command({command:'key',name:'escape'});await editor.set(field,body);await page.keyboard.press('Control+End');await command({command:'key',name:'shift'});await command({command:'typeLatin',text:'zhongwen'});composition=await page.evaluate(()=>window.__qaComposition);
  }
  assert.ok(composition.some(event=>event.type==='compositionstart'),'Native Windows IME compositionstart required; CDP simulation is not accepted');
  const composing=await page.evaluate(()=>{const state=window.__qaWorkspace.getState();return state.coordinator.getSession(state.selectedId).composing});assert.equal(composing,true);
  await new Promise(r=>setTimeout(r,2250));
  assert.equal((await invoke('get_note',{id,expectedStorageEpoch:epoch})).value.revision,revision,'IME preedit must not be persisted at max-save timer');
  await command({command:'key',name:'space'});await page.waitForFunction(()=>window.__qaComposition.some(event=>event.type==='compositionend'));
  await notes.locator('.notes-save-status').filter({hasText:/^(已保存|Saved)$/}).waitFor();
  const saved=(await invoke('get_note',{id,expectedStorageEpoch:epoch})).value;
  assert.ok(saved.body.startsWith(body)&&/[\u4e00-\u9fff]/.test(saved.body.slice(body.length)));assert.equal(await editor.read(field),saved.body);
  record('real Windows Chinese IME preedit pauses autosave beyond 2s, commit saves exact Chinese text',{keyboardLayout:keyboard.keyboardLayout,events:await page.evaluate(()=>window.__qaComposition.map(event=>({type:event.type,dataLength:event.data?.length||0}))),revisionBefore:revision,revisionAfter:saved.revision});
  assert.equal(fs.readFileSync(external,'utf8'),'Synthetic external file remains unchanged.');
  assert.ok(report.nativePastePassed,'Native Ctrl+V must arrive only in our dedicated target');report.passed=true;fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,report:destination}));
 }catch(error){report.error=error.message||error;
  try{record('failure view diagnostics',await page.evaluate(async()=>({nativeVisible:await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'}),nativeMinimized:await window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized',{label:'main'}),documentHidden:document.hidden,hasFocus:document.hasFocus(),clipboardCards:document.querySelectorAll('.clipboard-card').length,category:[...document.querySelectorAll('.clipboard-categories button')].find(b=>b.classList.contains('active'))?.textContent,searchLength:document.querySelector('.clipboard-page input')?.value.length,loadingIndicators:document.querySelectorAll('.clipboard-page .loading').length}))) }catch{}
  record('failed',{error:report.error});throw error}
 finally{if(!ended){try{if(await page.evaluate(()=>Boolean(window.__qaComposition?.length))){await command({command:'focusQa'});await command({command:'key',name:'escape'})}}catch{}try{await command({command:'close'})}catch{}helper.stdin.end()}}
 process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
