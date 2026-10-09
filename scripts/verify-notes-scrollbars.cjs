// Actual native Release visual check of the Notes-only color-scheme fix.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007'),wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.nativeArtifact,'native-release-notes-scrollbars');assert.equal(info.profile,'release-default');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex'),info.sha256.toLowerCase());
 const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);let page;
 for(let i=0;i<100;i++){for(const p of browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()==='http://tauri.localhost/'))if(await p.evaluate(()=>performance.timeOrigin).catch(()=>0)>=info.launchStartedUnixMs-200){page=p;break}if(page)break;await wait(100)}assert.ok(page);
 const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
 const original={theme:await invoke('get_setting',{key:'theme'}),size:await page.evaluate(()=>({width:innerWidth,height:innerHeight}))},epoch=await invoke('get_storage_epoch'),id=crypto.randomUUID(),prefix='QA-scale-scrollbars-'+crypto.randomUUID();
 const destination=path.join(root,'reports','notes-scrollbars-'+Date.now()+'.json'),screenshots=path.join(root,'screenshots',path.basename(destination,'.json'));fs.mkdirSync(screenshots,{recursive:true});
 const report={app:info,started:new Date().toISOString(),scope:'Actual 440x420 native window at unchanged OS scale; light/dark long-text editor and overflowing note list. This is not the missing 200% matrix.',variants:[]};let created=false;
 const theme=async desired=>{if(await page.evaluate(()=>document.documentElement.dataset.theme)!==desired){await page.getByRole('button',{name:/^(亮色|暗色|Light|Dark)$/,exact:true}).click();await page.waitForFunction(t=>document.documentElement.dataset.theme===t,desired)}};
 try{
  await invoke('plugin:window|show',{label:'main'});await invoke('plugin:window|set_focus',{label:'main'});await invoke('plugin:window|set_size',{label:'main',value:{Logical:{width:440,height:420}}});
  await page.locator('.sidebar-nav').getByRole('button',{name:/^(便签|Notes)$/,exact:true}).click();await page.locator('.notes-page').waitFor();
  await invoke('create_note',{expectedStorageEpoch:epoch,id,mutationId:crypto.randomUUID(),draft:{title:prefix,body:('中文 English 0123456789 scrollbar\n').repeat(300),refs:[]}});created=true;
  for(const desired of ['light','dark'])for(const view of ['editor','list']){
   await theme(desired);await page.evaluate(async id=>{const entry=performance.getEntriesByType('resource').find(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name));await (await import(entry.name)).useNotesWorkspace.getState().open(id)},id);
   if(view==='list')await page.locator('.notes-page').getByRole('button',{name:/^(返回|Back)$/,exact:true}).click();
   await page.evaluate(()=>document.fonts.ready);await wait(200);
   const metrics=await page.evaluate(view=>{const selector=view==='editor'?'.cm-scroller':'.notes-page > .notes-scroll';const element=document.querySelector(selector);if(!element)throw Error('Missing actual scroll container '+selector);return {theme:document.documentElement.dataset.theme,scheme:getComputedStyle(element).colorScheme,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth}},view);
   assert.equal(metrics.scheme,desired);assert.equal(metrics.theme,desired);assert.equal(metrics.overflow,false);assert.ok(metrics.scrollHeight>metrics.clientHeight,'Expected a visible native scrollbar');
   const screenshot=path.join(screenshots,desired+'-'+view+'.png');await page.screenshot({path:screenshot});report.variants.push({view,...metrics,screenshot});
  }
  report.passed=true;
 }catch(e){report.error=e.stack||String(e);throw e}
 finally{
  try{if(created){const result=JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({action:'remove_scale_load',database:path.join(info.storageRoot,'data.db'),prefix}),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},windowsHide:true}));assert.equal(result.integrity,'ok');report.cleanup=result;}await theme(original.theme);await invoke('plugin:window|set_size',{label:'main',value:{Logical:original.size}});report.settingsRestored=true;}
  catch(e){report.cleanupError=e.message;report.passed=false;}
  finally{report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({passed:report.passed||false,report:destination}));}
 }
 assert.equal(report.passed,true,'Visual check or fixture/settings cleanup failed');
})().catch(e=>{console.error(e.stack||String(e));process.exitCode=1});
