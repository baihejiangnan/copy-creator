// Run only through with-controlled-clipboard-qa.cjs. The owned Terminal receiver
// consumes native input without evaluating any text as shell commands.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),readline=require('node:readline');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))}catch{return null}};
async function until(check,timeout=12000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const result=await check();if(result)return result;await wait(50)}throw Error('Owned terminal condition timed out')}
(async()=>{
 const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),metadata=path.join(root,'process.json');
 const info=read(metadata);assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);
 const page=await until(async()=>{for(const p of browser.contexts().flatMap(c=>c.pages()))if(p.url()==='http://tauri.localhost/'&&await p.evaluate(()=>performance.timeOrigin).catch(()=>0)>=info.launchStartedUnixMs-200)return p;});
 page.setDefaultTimeout(10000);const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const epoch=await invoke('get_storage_epoch'),directory=path.join(root,'terminal-fixtures',crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
 const report={started:new Date().toISOString(),app:info,directory,cycles:[],scope:'Owned Windows Terminal native input receiver; synthetic text only, never shell evaluation'};
 const destination=path.join(root,'reports','terminal-paste-'+Date.now()+'.json'),prefix='QA controlled clipboard terminal '+crypto.randomUUID();
 let helper,receiver,helperEnded=false,settingsPath,profileInsertion;const save=()=>fs.writeFileSync(destination,JSON.stringify(report,null,2));
 try{
  const title='CopyCreator terminal QA '+path.basename(directory),wt=path.join(process.env.LOCALAPPDATA,'Microsoft/WindowsApps/wt.exe');
  const receiverShell='C:\\Program Files\\PowerShell\\7\\pwsh.exe';assert.ok(fs.existsSync(receiverShell));
  // A temporary, explicitly non-elevated profile avoids inheriting the user's
  // administrator default. Insert/remove only this entry, preserving settings.
  settingsPath=path.join(process.env.LOCALAPPDATA,'Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json');
  const settings=fs.readFileSync(settingsPath,'utf8'),config=JSON.parse(settings);
  assert.ok(config.profiles.list.length);const matches=[...settings.matchAll(/"list"\s*:\s*\[/g)];assert.equal(matches.length,1);
  const profileGuid='{'+crypto.randomUUID()+'}',profile={guid:profileGuid,name:title,commandline:'"'+receiverShell+'" -NoLogo -NoProfile -File "'+path.join(__dirname,'qa-terminal-receiver.ps1')+'" -Directory "'+directory+'"',elevate:false,startingDirectory:directory,closeOnExit:'always'};
  profileInsertion='\n'+JSON.stringify(profile)+',';const index=matches[0].index+matches[0][0].length;
  fs.writeFileSync(settingsPath,settings.slice(0,index)+profileInsertion+settings.slice(index));await wait(1500);
  // This is the interactive test target, rather than a background helper.
  const launch=spawn(wt,['--window','-1','new-tab','--profile',profileGuid,'--title',title,'--suppressApplicationTitle'],{windowsHide:false,stdio:'ignore'});
  launch.on('error',error=>{report.launchError=error.message;save()});
  receiver=await until(()=>read(path.join(directory,'ready.json'))?.ready&&read(path.join(directory,'ready.json')),20000);
  report.receiver=receiver;
  helper=spawn(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'qa-terminal-control.ps1'),'-Directory',directory,'-Metadata',metadata],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let queued=[],pending=[],helperError='';helper.stderr.on('data',data=>{helperError+=data;process.stderr.write(data)});
  readline.createInterface({input:helper.stdout}).on('line',line=>{let value;try{value=JSON.parse(line)}catch{return}if(pending.length)pending.shift().resolve(value);else queued.push(value)});
  helper.on('exit',code=>{helperEnded=true;for(const item of pending.splice(0))item.reject(Error('Owned helper exited '+code+': '+helperError))});
  const next=()=>queued.length?Promise.resolve(queued.shift()):new Promise((resolve,reject)=>{const item={resolve:value=>{clearTimeout(timer);resolve(value)},reject};const timer=setTimeout(()=>{pending=pending.filter(i=>i!==item);reject(Error('Owned terminal helper timed out'))},12000);pending.push(item)});
  const command=async request=>{const pending=next();helper.stdin.write(JSON.stringify(request)+'\n');const value=await pending;assert.equal(value.ok,true,value.error);return value};
  assert.equal((await next()).ready,true);await wait(800);
  let generation=0;
  const modes=process.argv.includes('--product-only')?['product']:['control','control-shift','product'];
  for(const mode of modes){
   fs.writeFileSync(path.join(directory,'reset'),String(++generation));await until(()=>read(path.join(directory,'input.json'))?.generation===generation);
   await invoke('plugin:window|hide',{label:'main'});const before=await command({command:'focusTerminal'});assert.equal(before.focused,true);await wait(200);
   const expected=prefix+' '+mode+' 中文';let error=null;
   if(mode==='product'){
    await invoke('plugin:window|show',{label:'main'});assert.equal((await command({command:'focusQa'})).focused,true);await wait(150);
    try{await invoke('paste_text',{text:expected,expectedStorageEpoch:epoch})}catch(e){error=String(e)}
   }else{
    await invoke('copy_text',{text:expected,expectedStorageEpoch:epoch});await wait(250);await command({command:'controlPaste',shift:mode==='control-shift'});
   }
   let input;for(let i=0;i<40;i++){input=read(path.join(directory,'input.json'));if(input?.text===expected)break;await wait(50)}
   const after=await command({command:'inspect'});const cycle={mode,before,after,error,expected,input,exactText:input?.text===expected};report.cycles.push(cycle);save();console.log(JSON.stringify({mode,exactText:cycle.exactText,error,before,after}));
  }
  if(process.argv.includes('--alerts')){
   const toast=page.locator('.clipboard-paste-toast[role=alert]');
   await invoke('plugin:window|hide',{label:'main'});
   for(const payload of [{storage_epoch:epoch+1000,value:'requiresElevation'},{storage_epoch:epoch,value:'unrecognized'}]){
    await invoke('plugin:event|emit',{event:'clipboard-paste-failed',payload});await wait(200);
    assert.equal(await toast.count(),0);assert.equal(await invoke('plugin:window|is_visible',{label:'main'}),false);
   }
   await invoke('plugin:event|emit',{event:'clipboard-paste-failed',payload:{storage_epoch:epoch,value:'requiresElevation'}});
   await toast.waitFor({state:'visible'});assert.equal(await invoke('plugin:window|is_visible',{label:'main'}),true);
   assert.match(await toast.innerText(),/管理员|administrator/);assert.match(await toast.innerText(),/手动粘贴|Paste manually/);
   const restart=toast.getByRole('button',{name:/以管理员权限重启|Restart as administrator/});await restart.waitFor({state:'visible'});
   for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
    const bounds=await toast.boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y+bounds.height<=viewport.height);
    await page.screenshot({path:destination.replace('.json','-warning-'+theme+'.png')});
   }
   const originalView=await page.evaluate(()=>({width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme}));
   await page.evaluate(async()=>{
    const entry=performance.getEntriesByType('resource').find(entry=>/\/i18n-[^/]+\.js$/.test(entry.name));
    if(!entry)throw Error('Loaded QA translation module missing');
    const translations=Object.values(await import(entry.name)).filter(value=>typeof value?.changeLanguage==='function');
    if(translations.length!==1)throw Error('QA translation singleton missing');
    window.__qaTranslations={instance:translations[0],language:translations[0].language};
   });
   try{
    await invoke('plugin:window|set_size',{label:'main',value:{Logical:{width:440,height:420}}});
    for(const language of ['zh-CN','en'])for(const theme of ['light','dark']){
     await page.evaluate(async({language,theme})=>{await window.__qaTranslations.instance.changeLanguage(language);document.documentElement.dataset.theme=theme},{language,theme});await wait(100);
     const bounds=await toast.boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
     assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y+bounds.height<=viewport.height);
     const button=await restart.boundingBox();assert.ok(button.x>=bounds.x&&button.x+button.width<=bounds.x+bounds.width);
     await page.screenshot({path:destination.replace('.json','-warning-'+language+'-'+theme+'-min.png')});
    }
   }finally{
    await page.evaluate(async theme=>{await window.__qaTranslations.instance.changeLanguage(window.__qaTranslations.language);delete window.__qaTranslations;document.documentElement.dataset.theme=theme},originalView.theme);
    await invoke('plugin:window|set_size',{label:'main',value:{Logical:{width:originalView.width,height:originalView.height}}});
   }
   // Never click the real elevation control during automated acceptance.
   // Tauri's invoke property is immutable; assigning a mock can silently fail.
   // Cancellation feedback is a separate synthetic lifecycle event check.
   await invoke('plugin:event|emit',{event:'lifecycle-error',payload:'lifecycle.elevationCancelled'});
   await page.locator('.lifecycle-error[role=alert]').waitFor({state:'visible'});
   assert.match(await page.locator('.lifecycle-error').innerText(),/取消管理员授权|permission was cancelled/);
   await page.locator('.lifecycle-error button').click();
   await toast.getByRole('button',{name:/^关闭$|^Close$/}).click();await toast.waitFor({state:'hidden'});
   await invoke('plugin:event|emit',{event:'clipboard-paste-failed',payload:{storage_epoch:epoch,value:true}});
   await toast.waitFor({state:'visible'});assert.match(await toast.innerText(),/无法完成粘贴|Could not complete the paste/);
   try{await invoke('plugin:event|emit',{event:'storage-changed',payload:{storage_epoch:epoch+1000}});await toast.waitFor({state:'hidden'})}
   finally{await invoke('plugin:event|emit',{event:'storage-changed',payload:{storage_epoch:epoch}})}
   report.alerts={permissionWarningVisible:true,lightDarkWithinViewport:true,minimumWindowLanguagesThemes:4,visualStateRestored:true,closeWorks:true,staleAndUnknownIgnored:true,legacyFailureSupported:true,storageChangeClears:true,restartButtonPresent:true,cancellationFeedbackSynthetic:true,scope:'Synthetic native event envelopes and cancellation feedback only; the real elevation button is never clicked, target elevation separately verified with native token query, no UAC or keys sent to administrator windows'};
  }
  report.passed=report.cycles.every(c=>c.exactText&&!c.error);if(!report.passed)throw Error('Terminal paste did not insert exact synthetic content');
 }catch(error){report.passed=false;report.error=error.stack||String(error);throw error}
 finally{
  fs.writeFileSync(path.join(directory,'stop'),'stop');if(helper&&!helperEnded)helper.stdin.end();
  if(profileInsertion){const settings=fs.readFileSync(settingsPath,'utf8');if(settings.includes(profileInsertion)){fs.writeFileSync(settingsPath,settings.replace(profileInsertion,''));report.temporaryProfileRemoved=true}else{report.cleanupError='Temporary profile changed concurrently; preserved settings';report.passed=false}}
  if(receiver){await until(()=>{try{process.kill(receiver.pid,0);return false}catch{return true}},15000).then(()=>{report.receiverStopped=true}).catch(error=>{report.cleanupError=error.message;report.passed=false})}
  try{const rows=await invoke('get_clipboard_records',{search:prefix,limit:100});assert.ok(rows.length<20);for(const row of rows){assert.ok((row.content||row.preview||'').startsWith(prefix));await invoke('delete_clipboard_record',{id:row.id,expectedStorageEpoch:epoch})}report.syntheticRowsRemoved=rows.length}catch(error){report.cleanupError=error.message;report.passed=false}
  await browser.close();report.finished=new Date().toISOString();save();console.log(JSON.stringify({passed:report.passed,report:destination}));
 }
 assert.equal(report.passed,true);
})().catch(error=>{console.error(error.stack||String(error));process.exitCode=1});
