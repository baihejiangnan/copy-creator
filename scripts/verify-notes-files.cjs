// Real native dialogs and Explorer selection, only with synthetic QA files.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
const metadata=path.join(root,'process.json');
const powershell=process.env.QA_POWERSHELL;
assert.ok(powershell&&fs.existsSync(powershell),'Set QA_POWERSHELL to the installed PowerShell executable');
const runPS=script=>execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ${script}`],{encoding:'utf8',timeout:15000,windowsHide:true});
const dialog=(action,fixture)=>execFileSync(powershell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'operate-qa-dialog.ps1'),'-Metadata',metadata,'-Action',action,...(fixture?['-FixturePath',fixture]:[])],{encoding:'utf8',timeout:15000,windowsHide:true,stdio:['ignore','pipe','pipe']});
(async()=>{
  const info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
  assert.equal(info.identifier,'com.copycreator.qa20261007');
  assert.equal(String(info.debugPort),new URL(process.env.QA_CDP_URL).port);
  const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL,{timeout:5000});
  let page;
  for(let attempt=0;attempt<40;attempt++){
    page=browser.contexts()[0].pages().find(p=>p.url()==='http://tauri.localhost/');
    if(page)break;await new Promise(resolve=>setTimeout(resolve,125));
  }
  assert.ok(page);page.setDefaultTimeout(5000);
  const storage=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'));
  assert.equal(require('./qa-path.cjs')(storage),require('./qa-path.cjs')(process.env.QA_STORAGE_ROOT));
  const directory=path.join(root,'file-fixtures',randomUUID());fs.mkdirSync(directory,{recursive:true});
  const files=['普通文件.txt','中文 空格.txt','中文,逗号 和空格.txt'].map(name=>path.join(directory,name));
  for(const file of files)fs.writeFileSync(file,'Synthetic note file reference fixture.\n');
  const progress={app:info,directory,steps:[],selections:[]};
  const progressPath=path.join(root,'reports',`files-progress-${Date.now()}.json`);
  const record=step=>{progress.steps.push({time:new Date().toISOString(),step});fs.writeFileSync(progressPath,JSON.stringify(progress,null,2));};
  const psLiteral=value=>"'"+value.replaceAll("'","''")+"'";
  const selected=()=>JSON.parse(runPS(`$ErrorActionPreference='Stop'; $shell=New-Object -ComObject Shell.Application; $views=$shell.Windows(); $matches=@(for($i=0;$i -lt $views.Count;$i++){ $window=$views.Item($i); try { $location=[Uri]$window.LocationURL; if($location.IsFile -and $location.LocalPath.TrimEnd('\\') -eq ${psLiteral(directory)}){ $selection=$window.Document.SelectedItems(); [pscustomobject]@{folder=$location.LocalPath;selected=@(for($j=0;$j -lt $selection.Count;$j++){$selection.Item($j).Path})} } } catch {} }); ConvertTo-Json -InputObject $matches -Depth 4`));
  const restore=()=>execFileSync(powershell,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'restore-qa-window.ps1'),'-Metadata',metadata],{encoding:'utf8',timeout:10000,windowsHide:true});
  let moved=null;
  try {
    restore();
    await page.locator('.sidebar-nav').getByRole('button',{name:'便签',exact:true}).click();
    const notes=page.locator('.notes-page'),button=name=>notes.getByRole('button',{name,exact:true});
    if(await page.locator('.lifecycle-error').isVisible())await page.locator('.lifecycle-error').getByRole('button',{name:'关闭',exact:true}).click();
    if(await button('返回').isVisible()){
      const titleField=notes.getByRole('textbox',{name:'标题（可选）',exact:true});
      if((await titleField.inputValue()).startsWith('QA 文件引用 ')&&await notes.locator('.notes-save-status').filter({hasText:'尚未保存'}).isVisible()){
        await button('放弃本机稿').click();await button('确认').click();
      }else await button('返回').click();
    }
    if(await button('关闭提示').isVisible())await button('关闭提示').click();
    await button('新建便签').click();
    const title=`QA 文件引用 ${Date.now()}`;
    await notes.getByRole('textbox',{name:'标题（可选）',exact:true}).fill(title);
    for(const file of files){
      await button('添加文件引用').click();
      await new Promise(resolve=>setTimeout(resolve,550));
      assert.equal(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'})),true,'Owned file dialog must not auto-hide its parent');
      if(file===files[0]){
        const duplicate=await page.evaluate(async()=>{
          try {const epoch=await window.__TAURI_INTERNALS__.invoke('get_storage_epoch');await window.__TAURI_INTERNALS__.invoke('select_note_files',{expectedStorageEpoch:epoch});return 'unexpected second dialog';}
          catch(error){return error;}
        });assert.equal(duplicate,'notes.busy');record('second native picker refused while one is open');
      }
      dialog('select',file);
      await notes.locator('.notes-reference').filter({hasText:path.basename(file)}).waitFor();
      assert.equal(await page.locator('.lifecycle-error').isVisible(),false,'File dialog must not trigger a premature title-only hide flush');
      record(`selected ${path.basename(file)}`);
    }
    // Cancellation adds no reference and leaves accepted references intact.
    await button('添加文件引用').click();await new Promise(resolve=>setTimeout(resolve,550));dialog('cancel');
    assert.equal(await notes.locator('.notes-reference').count(),3);
    await button('立即保存').click();await notes.locator('.notes-save-status').filter({hasText:'已保存'}).waitFor();
    const saved=await page.evaluate(async title=>{
      const resource=performance.getEntriesByType('resource').find(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name));
      const {useNotesWorkspace}=await import(resource.name);const state=useNotesWorkspace.getState();
      const epoch=await window.__TAURI_INTERNALS__.invoke('get_storage_epoch');
      const note=(await window.__TAURI_INTERNALS__.invoke('get_note',{id:state.selectedId,expectedStorageEpoch:epoch})).value;
      if(note.title!==title)throw Error('Selected note mismatch');return {note,epoch};
    },title);
    assert.deepEqual(saved.note.refs.map(ref=>ref.target),files);
    progress.noteId=saved.note.id;record('persisted three references; cancelled picker adds none');
    const selections=[];
    for(const file of files){
      await notes.locator('.notes-reference').filter({hasText:path.basename(file)}).getByRole('button',{name:'在文件夹中显示',exact:true}).click();
      let found=false,lastWindows=[];
      for(let i=0;i<20;i++){
        const windows=selected();lastWindows=windows;
        if(windows.some(window=>window.selected.includes(file))){selections.push({file,windows});progress.selections=selections;record(`Explorer selected ${path.basename(file)}`);found=true;break;}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      assert.ok(found,`Explorer must actually select the exact synthetic file: ${JSON.stringify({file,lastWindows})}`);
      restore();
    }
    moved=files[0]+'.temporarily-missing';fs.renameSync(files[0],moved);
    await notes.locator('.notes-reference').filter({hasText:path.basename(files[0])}).getByRole('button',{name:'在文件夹中显示',exact:true}).click();
    await notes.getByRole('alert').filter({hasText:'文件已不存在或无法访问'}).waitFor();
    assert.equal(await notes.locator('.notes-reference').count(),3);
    record('missing file reports error and retains all references');
    fs.renameSync(moved,files[0]);moved=null;
    await button('关闭提示').click();
    await notes.locator('.notes-reference').filter({hasText:path.basename(files[0])}).getByRole('button',{name:'移除引用',exact:true}).click();
    await button('立即保存').click();await notes.locator('.notes-save-status').filter({hasText:'已保存'}).waitFor();
    await button('删除').click();await button('确认').click();await button('回收站').click();
    await notes.getByRole('searchbox').fill(title);await notes.locator('.notes-row').filter({hasText:title}).click();
    await button('恢复').click();
    for(const file of files)assert.equal(fs.readFileSync(file,'utf8'),'Synthetic note file reference fixture.\n');
    record('removing reference and deleting/restoring note preserve every external fixture');
    const result={passed:'Native file selection/cancel, Unicode/spaces/commas, exact Explorer selection, missing-file error with reference retained, reference removal and note deletion preserve external files',noteId:saved.note.id,directory,selections};
    fs.writeFileSync(path.join(root,'reports',`files-${Date.now()}.json`),JSON.stringify({time:new Date().toISOString(),app:info,result},null,2));
    console.log(JSON.stringify(result));
  } catch(error) {
    progress.failure=error.message;record('failed');throw error;
  } finally {
    if(moved&&fs.existsSync(moved))fs.renameSync(moved,files[0]);
    try{dialog('cancel');}catch{}
    // A fresh unique fixture folder cannot be an everyday Explorer view.
    runPS(`$shell=New-Object -ComObject Shell.Application; $views=$shell.Windows(); for($i=$views.Count-1;$i -ge 0;$i--){ $window=$views.Item($i); try { $location=[Uri]$window.LocationURL; if($location.IsFile -and $location.LocalPath.TrimEnd('\\') -eq ${psLiteral(directory)}){$window.Quit()} } catch {} }`);
    restore();
  }
  process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
