// Synthetic clipboard DB cards; no reading or writing of the system clipboard.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
  const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`,{timeout:5000});
  const page=browser.contexts()[0].pages().find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);page.setDefaultTimeout(15000);
  const canonical=value=>value.replace(/^\\\\\?\\/,'').toLowerCase();
  const actual=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'));assert.equal(canonical(actual),canonical(info.storageRoot));
  const originalSize=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  if(await page.locator('.lifecycle-error').count())await page.locator('.lifecycle-error').getByRole('button',{name:/^(Close|关闭)$/}).click();
  if(process.env.QA_MIN_WINDOW==='1')await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width:440,height:420}}}));
  const database=path.join(info.storageRoot,'data.db');
  const fixture=request=>JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({...request,database}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true}));
  execFileSync(process.env.QA_POWERSHELL,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'restore-qa-window.ps1'),'-Metadata',path.join(root,'process.json')],{windowsHide:true,stdio:'ignore'});
  const english=process.env.QA_LANG==='en';
  if(english){
    if(!await page.locator('#settings-tab-general').isVisible())await page.getByRole('button',{name:/^(Settings|设置)$/}).click();
    await page.locator('#settings-tab-general').click();await page.getByRole('button',{name:'EN',exact:true}).click();
    if(await page.getByRole('button',{name:'Dark',exact:true}).count())await page.getByRole('button',{name:'Dark',exact:true}).click();
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  }
  const labels=english?{clipboard:'Clipboard',search:'Search clipboard...',capture:'Save as note'}:{clipboard:'剪切板',search:'搜索剪切板...',capture:'收为便签'};
  const prefix=`QA捕获 ${randomUUID()}`,directory=path.join(root,'capture-fixtures',randomUUID());fs.mkdirSync(directory,{recursive:true});
  const external=path.join(directory,'中文, 引用.txt');fs.writeFileSync(external,'QA capture external file unchanged');
  const body=prefix+'  raw 中文😀\r\n'+('full-content-not-preview 中文😀 '.repeat(1200))+'\rlast trailing  \n';
  const records=[
    {id:randomUUID(),type:'text',content:body,source_app:'QA capture full text'},
    {id:randomUUID(),type:'link',content:`https://example.invalid/QA-capture/${randomUUID()}?q=%25_`,source_app:'QA capture link'},
    {id:randomUUID(),type:'file',content:external,source_app:'QA capture file'},
    {id:randomUUID(),type:'text',content:`QA protected ${randomUUID()}`,source_app:'QA capture manual protected',user_api_key:true},
    {id:randomUUID(),type:'image',content:`images/QA-capture-${randomUUID()}.png`,source_app:'QA capture unsupported image'},
  ];fixture({action:'capture',records});
  const report={time:new Date().toISOString(),app:info,directory,geometry:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})),steps:[]},reportPath=path.join(root,'reports',`capture-${Date.now()}.json`);
  const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(reportPath,JSON.stringify(report,null,2))};
  const invoke=async(command,args={})=>{
    const response=await page.evaluate(async({command,args})=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return {ok:false,error}}},{command,args});if(!response.ok)throw response.error;return response.value;
  };
  try {
    const epoch=await invoke('get_storage_epoch');
    const openClipboard=async query=>{
      await page.locator('.sidebar-nav').getByRole('button',{name:labels.clipboard,exact:true}).click();
      await page.getByPlaceholder(labels.search, {exact:true}).fill(query);
      await page.waitForFunction(()=>document.querySelectorAll('.clipboard-card').length===1);
      return page.locator('.clipboard-card');
    };
    const captured=[];
    for(const source of records.slice(0,3)){
      const card=await openClipboard(source.type==='text'?prefix:source.content);
      const preview=await card.locator('.clipboard-card-body').innerText();
      if(source.type==='text')assert.ok(preview.length<source.content.length,'UI must use a truncated preview');
      await card.click({button:'right'});
      const menu=page.locator('.clipboard-ctx-menu');await menu.waitFor();
      await page.waitForFunction(()=>{const element=document.querySelector('.clipboard-ctx-menu');const box=element.getBoundingClientRect();return element.parentElement===document.body&&box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight});
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('.clipboard-ctx-menu')).opacity==='1');
      if(source.type==='text')await page.screenshot({path:path.join(directory,'capture-menu.png')});
      if(english){assert.equal(await menu.getByRole('button',{name:'Paste',exact:true}).count(),1);assert.equal(await menu.getByRole('button',{name:'Delete',exact:true}).count(),1);assert.equal(await menu.getByText(/粘贴|删除|标记/).count(),0)}
      await page.getByRole('button',{name:labels.capture,exact:true}).click();
      await page.locator('.notes-page').waitFor();
      const current=await page.evaluate(async()=>{
        const entry=performance.getEntriesByType('resource').find(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name));
        const state=(await import(entry.name)).useNotesWorkspace.getState();return {id:state.selectedId,session:state.coordinator.getSession(state.selectedId)};
      });assert.ok(current.id);
      const saved=(await invoke('get_note',{expectedStorageEpoch:epoch,id:current.id})).value;
      assert.equal(saved.source.record_id,source.id);assert.equal(saved.source.source_app,source.source_app);
      if(source.type==='text')assert.equal(saved.body,body);
      else if(source.type==='link'){assert.equal(saved.body,source.content);assert.equal(saved.refs[0].kind,'url');assert.equal(saved.refs[0].target,source.content)}
      else {assert.equal(saved.body,'');assert.equal(saved.refs[0].kind,'file');assert.equal(saved.refs[0].target,external)}
      captured.push(saved);record(`actual ${source.type} card captures full native snapshot`,{bytes:Buffer.byteLength(saved.body),refs:saved.refs.length});
    }
    fixture({action:'delete_history',ids:records.slice(0,3).map(r=>r.id)});
    for(const note of captured)assert.deepEqual((await invoke('get_note',{expectedStorageEpoch:epoch,id:note.id})).value,note);
    record('source clipboard records deleted; independent notes and source snapshots unchanged');
    const protectedCard=await openClipboard(records[3].content);await protectedCard.click({button:'right'});
    assert.equal(await page.getByRole('button',{name:labels.capture,exact:true}).count(),0);
    await page.keyboard.press('Escape');
    for(const [source,code] of [[records[3],'notes.protectedSource'],[records[4],'notes.unsupportedSource']]){
      await assert.rejects(invoke('capture_clipboard_as_note',{expectedStorageEpoch:epoch,recordId:source.id,mutationId:randomUUID()}),e=>e.code===code);
    }
    assert.equal(fs.readFileSync(external,'utf8'),'QA capture external file unchanged');
    record('protected card hides capture; native boundary rejects protected text and image');
    report.passed=true;fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,reportPath,steps:report.steps}));
  } catch(error){record('failed',{error:error.message||error});throw error}
  finally {
    if(process.env.QA_MIN_WINDOW==='1')await page.evaluate(({width,height})=>window.__TAURI_INTERNALS__.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width,height}}}),originalSize);
    if(english){await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'ZH',exact:true}).click();if(await page.getByRole('button',{name:'亮色',exact:true}).count())await page.getByRole('button',{name:'亮色',exact:true}).click()}
  }
  process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
