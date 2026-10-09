// Real current QA WebView, native GitHub read, and document-start IPC counts.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.ok(['native-release-image-idle','native-release-paste-settle','native-release-paste-feedback','native-release-version-025'].includes(info.nativeArtifact));assert.equal(info.profile,'release-default');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const expectedVersion=info.nativeArtifact==='native-release-version-025'?'0.2.25':'0.2.24';
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);page.setDefaultTimeout(20000);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
 assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const original={auto:await invoke('get_setting',{key:'auto_check_updates'}),language:await invoke('get_setting',{key:'language'}),theme:await invoke('get_setting',{key:'theme'}),size:await page.evaluate(()=>({width:innerWidth,height:innerHeight}))};
 const destination=path.join(root,'reports','updates-about-'+Date.now()+'.json'),screenshots=path.join(root,'screenshots',path.basename(destination,'.json'));fs.mkdirSync(screenshots,{recursive:true});
 const report={app:info,originalSettings:original,started:new Date().toISOString(),steps:[],scope:'Current real WebView/native commands; public GitHub latest release read only. No download/install, user data, fake update responses or external browser activation. Reload is a fresh JS session, not a new native process or first-ever lifecycle ready. OS scale unchanged.'};let pinned=false;
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 const settings=async()=>{await page.getByRole('button',{name:/^(设置|Settings)$/,exact:true}).click();await page.locator('#settings-tab-updates').click();await page.locator('#auto-check-updates').waitFor();};
 const closeSettings=async()=>{const close=page.locator('.settings-panel-close');if(await close.count())await close.click();else await page.locator('.sidebar-nav button').filter({hasText:/剪切板|剪贴板|Clipboard/}).click()};
 const about=()=>page.getByRole('button',{name:/^(关于|About)$/,exact:true});
 const auto=async value=>{await settings();const control=page.locator('#auto-check-updates');if((await control.getAttribute('aria-checked'))!==String(value))await control.click();await page.waitForFunction(value=>document.getElementById('auto-check-updates')?.getAttribute('aria-checked')===String(value),value);assert.equal(await invoke('get_setting',{key:'auto_check_updates'}),value?'1':'0');await closeSettings();};
 const reload=async()=>{await page.reload();await page.locator('.sidebar-nav').waitFor();await page.waitForFunction(()=>document.documentElement.lang==='en'||!!document.querySelector('.sidebar-nav'));const q=await page.evaluate(()=>window.__qaUpdatesEarly);assert.ok(q?.installed&&q.initialRootChildren===0,'Document-start observation did not precede app mounting');await invoke('get_storage_path');assert.equal(await page.evaluate(()=>window.__qaUpdatesEarly.commands.get_storage_path),1,'Actual transport self-check failed');};
 const counts=()=>page.evaluate(()=>({...window.__qaUpdatesEarly.commands}));
 const state=async()=>page.evaluate(async()=>{const resource=performance.getEntriesByType('resource').find(e=>/\/main-[^/]+\.js$/.test(e.name));if(!resource)throw Error('Main entry missing');const candidates=Object.values(await import(resource.name));const store=candidates.find(v=>v?.getState?.().check&&v.getState().setAutoCheck);if(!store)throw Error('Existing update store export missing');window.__qaUpdatesStore=store;const s=store.getState();return {checking:s.checking,error:s.error,status:s.result?.status,checkedAt:s.checkedAt,version:s.info?.version,auto:s.autoCheck};});
 try{
  await invoke('plugin:window|show',{label:'main'});await invoke('plugin:window|set_focus',{label:'main'});
  if(await page.getByRole('button',{name:/^(固定窗口|Pin Window)$/,exact:true}).count()){await page.getByRole('button',{name:/^(固定窗口|Pin Window)$/,exact:true}).click();pinned=true;}
  await auto(false);
  await page.addInitScript(()=>{
   const owner=window.chrome?.webview,original=owner?.postMessage,q=window.__qaUpdatesEarly={installed:false,initialRootChildren:document.querySelector('#root')?.childElementCount||0,commands:{}};
   if(typeof original!=='function')return;
   const wrapped=function(...args){let m;try{m=typeof args[0]==='string'?JSON.parse(args[0]):args[0]}catch{}if(['get_storage_path','get_app_info','check_for_updates'].includes(m?.cmd))q.commands[m.cmd]=(q.commands[m.cmd]||0)+1;return original.apply(this,args)};
   try{owner.postMessage=wrapped}catch{}q.installed=owner.postMessage===wrapped;q.restore=()=>{if(owner.postMessage===wrapped)owner.postMessage=original};
  });
  await reload();await wait(800);assert.equal((await counts()).check_for_updates||0,0);record('disabled automatic check persists through real WebView reload',await counts());
  for(let i=0;i<3;i++){await about().click();await page.locator('.about-dialog').waitFor();await page.keyboard.press('Escape');await page.locator('.about-dialog').waitFor({state:'detached'});assert.equal(await about().evaluate(el=>document.activeElement===el),true);await settings();await closeSettings();}
  assert.equal((await counts()).check_for_updates||0,0);record('repeated lazy about/settings mounts do not trigger disabled startup checks');
  await about().click();await page.locator('.about-dialog').getByRole('button',{name:/^(检查更新|Check for updates)$/,exact:true}).click();
  await page.locator('.about-dialog .update-buttons button').first().waitFor();await page.waitForFunction(()=>{const b=document.querySelector('.about-update .update-buttons button');return !!b&&!b.disabled},undefined,{timeout:25000});
  const manual=await state();assert.equal(manual.checking,false);assert.equal((await counts()).check_for_updates,1);assert.ok(manual.status||manual.error);const aboutStatus=await page.locator('.about-dialog .update-status').innerText();
  await page.keyboard.press('Escape');await settings();assert.equal(await page.locator('.settings-categorized .update-status').innerText(),aboutStatus);record('one real native manual check is shared between about and settings',{status:manual.status,error:manual.error,version:manual.version,checks:(await counts()).check_for_updates});await closeSettings();
  await auto(true);assert.equal((await counts()).check_for_updates,1);await reload();await page.waitForFunction(()=>window.__qaUpdatesEarly?.commands.check_for_updates===1);await wait(200);
  await about().click();await page.locator('.about-dialog .update-buttons button').first().waitFor();await page.waitForFunction(()=>{const b=document.querySelector('.about-update .update-buttons button');return !!b&&!b.disabled},undefined,{timeout:25000});const started=await state();assert.equal(started.checking,false);assert.equal(started.auto,true);assert.equal((await counts()).check_for_updates,1);assert.equal(started.version,expectedVersion);
  await page.keyboard.press('Escape');for(let i=0;i<3;i++){await settings();await closeSettings();await about().click();await page.keyboard.press('Escape');}assert.equal((await counts()).check_for_updates,1);record('enabled automatic check runs once in new JS session despite repeated mounts',{status:started.status,error:started.error,checks:(await counts()).check_for_updates});
  await invoke('plugin:window|set_size',{label:'main',value:{Logical:{width:440,height:420}}});
  for(const language of ['zh-CN','en']){
   await settings();await page.locator('#settings-tab-general').click();await page.getByRole('button',{name:language==='en'?'EN':'ZH',exact:true}).click();await page.waitForFunction(lang=>document.querySelector('.sidebar-footer-item[aria-haspopup="dialog"]')?.getAttribute('aria-label')===(lang==='en'?'About':'关于'),language);await closeSettings();
   for(const theme of ['light','dark']){
    if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme){await page.getByRole('button',{name:/^(亮色|暗色|Light|Dark)$/,exact:true}).click();await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);}
    await about().click();await page.evaluate(()=>document.fonts.ready);await wait(100);assert.equal(await page.locator('.about-dialog .update-version').innerText(),'v'+expectedVersion);
    const geometry=await page.locator('.about-dialog').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,horizontalOverflow:el.scrollWidth>el.clientWidth,verticalScrollable:el.scrollHeight>el.clientHeight}});assert.ok(geometry.left>=0&&geometry.top>=0&&geometry.right<=geometry.width+1&&geometry.bottom<=geometry.height+1);assert.equal(geometry.horizontalOverflow,false);
    await page.screenshot({path:path.join(screenshots,language+'-'+theme+'.png')});await page.locator('.about-close').click();await page.locator('.about-dialog').waitFor({state:'detached'});assert.equal(await about().evaluate(el=>document.activeElement===el),true);record('minimum native window about dialog fits and restores focus',{language,theme,...geometry});
   }
  }
  await about().click();await page.mouse.click(2,2);await page.locator('.about-dialog').waitFor({state:'detached'});assert.equal(await about().evaluate(el=>document.activeElement===el),true);record('dialog backdrop click closes and restores focus');
  await assert.rejects(()=>invoke('open_external_link',{url:'file:///QA-not-an-executable'}));record('real native external-link protocol guard refuses file URL');report.passed=true;
 }catch(error){report.error=error.stack||String(error);throw error}
 finally{
  try{await wait(300);if(await page.locator('.about-dialog').count()){await page.locator('.about-close').click();await page.locator('.about-dialog').waitFor({state:'detached'});}await auto(original.auto!=='0');await settings();await page.locator('#settings-tab-general').click();await page.getByRole('button',{name:original.language==='en'?'EN':'ZH',exact:true}).click();await closeSettings();if(await page.evaluate(()=>document.documentElement.dataset.theme)!==original.theme)await page.getByRole('button',{name:/^(亮色|暗色|Light|Dark)$/,exact:true}).click();await invoke('plugin:window|set_size',{label:'main',value:{Logical:original.size}});if(pinned)assert.equal(await invoke('toggle_always_on_top'),false);await page.evaluate(()=>window.__qaUpdatesEarly?.restore?.());report.restoredSettings=true;}
  catch(error){report.cleanupError=error.stack||String(error);report.passed=false;}
  await browser.close();report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));
 }
 assert.equal(report.passed,true,'Update/about acceptance or cleanup failed');
})().catch(error=>{console.error(error.stack||String(error));process.exitCode=1});
