// Recover only the isolated harness after an evidenced failed native restart.
// This is a test-session reload, never evidence that native restart succeeded.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
  const info=JSON.parse(fs.readFileSync(path.join(root,'process.json'),'utf8').replace(/^\uFEFF/,''));assert.equal(info.identifier,'com.copycreator.qa20261007');
  const reportPath=path.resolve(process.argv[2]);assert.ok(reportPath.startsWith(root+path.sep));
  const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));assert.equal(report.app.pid,info.pid);
  assert.match(report.steps.at(-1).error,/Native restart must create the replacement process/);
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${info.debugPort}`,{timeout:5000});
  const page=browser.contexts()[0].pages().find(p=>p.url()==='http://tauri.localhost/');assert.ok(page);
  const canonical=value=>value.replace(/^\\\\\?\\/,'').toLowerCase();
  const actual=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_storage_path'));assert.equal(canonical(actual),canonical(info.storageRoot));
  const session=await page.evaluate(async()=>{
    const main=performance.getEntriesByType('resource').find(e=>/\/main-[^/]+\.js$/.test(e.name));
    const barrier=Object.values(await import(main.name)).find(v=>v?.run&&v?.getSnapshot&&v?.register);
    const snapshot=barrier.getSnapshot();if(!snapshot.busy||snapshot.purpose!=='restart'||snapshot.error)throw Error('Expected stalled terminal QA restart');
    const entry=performance.getEntriesByType('resource').find(e=>/\/notesWorkspace-[^/]+\.js$/.test(e.name));
    const state=(await import(entry.name)).useNotesWorkspace.getState();if(state.coordinator.hasPending)throw Error('QA drafts remain pending');
    const current=state.coordinator.getSession(state.selectedId);if(current.status!=='saved')throw Error('QA selected draft is not saved');return current;
  });
  const persisted=JSON.parse(execFileSync(process.env.QA_PYTHON,[path.join(__dirname,'qa-storage-fixture.py')],{input:JSON.stringify({action:'inspect',database:path.join(info.storageRoot,'data.db'),ids:[session.id],historyId:'QA-none'}),env:{...process.env,PYTHONUTF8:'1'},encoding:'utf8',windowsHide:true}));
  assert.equal(persisted.notes[0].body,session.draft.body);assert.equal(persisted.notes[0].revision,session.revision);assert.equal(persisted.integrity,'ok');
  await page.reload();console.log(JSON.stringify({harnessReloaded:true,allDraftsConfirmed:true,failedRestartReport:reportPath}));process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(1)});
