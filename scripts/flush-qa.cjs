const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const metadata=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
  assert.ok(['com.copycreator.qa20261007','com.copycreator.qa20261007search'].includes(metadata.identifier));
  const qaRoot=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
  assert.ok(path.resolve(metadata.exe).startsWith(qaRoot+path.sep));
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(metadata.exe)).digest('hex'),metadata.sha256.toLowerCase());
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${metadata.debugPort}`,{timeout:5000});
  let page;for(let attempt=0;attempt<100;attempt++){for(const candidate of browser.contexts().flatMap(context=>context.pages()).filter(page=>page.url()==='http://tauri.localhost/')){if(await candidate.evaluate(()=>performance.timeOrigin).catch(()=>0)>=(metadata.launchStartedUnixMs||0)-200){page=candidate;break}}if(page)break;await new Promise(resolve=>setTimeout(resolve,100))}assert.ok(page);
  await page.evaluate(async expected=>{
    const actual=await window.__TAURI_INTERNALS__.invoke('get_storage_path');
    const canonical=value=>value.replace(/^\\\\\?\\/,'').replace(/\\$/,'').toLowerCase();
    if(canonical(actual)!==canonical(expected))throw Error('Refusing non-QA storage');
    const entry=performance.getEntriesByType('resource').find(entry=>/\/main-[^/]+\.js$/.test(entry.name));
    if(!entry)throw Error('QA main chunk missing');
    const barriers=Object.values(await import(entry.name)).filter(value=>value?.run&&value?.getSnapshot&&value?.register);
    if(barriers.length!==1)throw Error('QA save barrier missing');
    await barriers[0].run('qa-refresh',async()=>{});
  },metadata.storageRoot||path.join(process.env.APPDATA,metadata.identifier));
  console.log('QA save barrier confirmed');process.exit(0);
})().catch(error=>{console.error(error.message);process.exit(1)});
