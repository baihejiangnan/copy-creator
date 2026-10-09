// Real settings UI and native autostart plugin; registry values stay in the guard's RAM.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process'),readline=require('node:readline');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
(async()=>{
 const metadata=path.join(root,'process.json'),info=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));
 assert.equal(info.autostartIsolation,'identifier');assert.equal(info.identifier,'com.copycreator.qa20261007');
 const guard=spawn(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,'guard-qa-autostart.ps1'),'-Metadata',metadata],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let pending=[],queued=[],ended=false,error='';guard.stderr.on('data',data=>error+=data);
 readline.createInterface({input:guard.stdout}).on('line',line=>{let value;try{value=JSON.parse(line)}catch{return}if(pending.length)pending.shift().resolve(value);else queued.push(value)});
 guard.on('exit',code=>{ended=true;for(const request of pending.splice(0))request.reject(Error('Registry guard exited '+code+': '+error))});
 const next=()=>queued.length?Promise.resolve(queued.shift()):ended?Promise.reject(Error(error)):new Promise((resolve,reject)=>{const item={resolve:value=>{clearTimeout(timer);resolve(value)},reject:e=>{clearTimeout(timer);reject(e)}};const timer=setTimeout(()=>{pending=pending.filter(v=>v!==item);reject(Error('Registry guard timeout'))},15000);pending.push(item)});
 const check=async command=>{const response=next();guard.stdin.write(command+'\n');return response};
 const run=async(file,args=[])=>new Promise((resolve,reject)=>{const child=spawn(process.env.QA_POWERSHELL,['-NoProfile','-File',path.join(__dirname,file),'-Metadata',metadata,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',data=>error+=data);child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(file+' failed: '+error)))});
 const destination=path.join(root,'reports','autostart-isolation-'+Date.now()+'.json'),report={started:new Date().toISOString(),app:info,steps:[],scope:'Real QA startup and settings enable/disable. Production Run value compared in guard RAM against restored running production executable; no production value/path/hash exported.'};
 const record=(step,data={})=>{report.steps.push({step,...data});fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({step,...data}))};
 let invoke,toggle,mayHaveEnabled=false;
 try{
  record('production Run still matches restoration after new QA startup',await next());
  const browser=await chromium.connectOverCDP(process.env.QA_CDP_URL);let page;
  for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await new Promise(r=>setTimeout(r,100))}assert.ok(page);
  invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  assert.equal(require('./qa-path.cjs')(await invoke('get_storage_path')),require('./qa-path.cjs')(info.storageRoot));
  assert.equal(await invoke('plugin:autostart|is_enabled'),false);
  await page.getByRole('button',{name:/^(设置|Settings)$/,exact:true}).click();
  toggle=page.getByRole('switch',{name:/^(开机自启动|开机启动|Launch at startup|Start on boot)$/i});
  await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'false');
  mayHaveEnabled=true;await toggle.click();await page.waitForFunction(async()=>await window.__TAURI_INTERNALS__.invoke('plugin:autostart|is_enabled'));
  record('actual settings enable writes only the unique QA entry',await check('enabled'));
  await run('stop-saved-qa.ps1',['-Graceful']);await run('launch-saved-qa.ps1');
  const restarted=JSON.parse(fs.readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));assert.notEqual(restarted.pid,info.pid);
  const replacement=await chromium.connectOverCDP(process.env.QA_CDP_URL);page=undefined;
  for(let i=0;i<100;i++){page=replacement.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='http://tauri.localhost/');if(page)break;await new Promise(r=>setTimeout(r,100))}assert.ok(page);
  assert.equal(await invoke('plugin:autostart|is_enabled'),true);record('new process startup repair retains the owned QA entry and leaves production unchanged',{...await check('enabled'),replacementPid:restarted.pid});
  await page.getByRole('button',{name:/^(设置|Settings)$/,exact:true}).click();toggle=page.getByRole('switch',{name:/^(开机自启动|开机启动|Launch at startup|Start on boot)$/i});await toggle.waitFor();
  await page.waitForFunction(()=>document.querySelector('.settings-category-body')?.disabled===false);
  assert.equal(await toggle.getAttribute('aria-checked'),'true');
  await toggle.click();await page.waitForFunction(async()=>!await window.__TAURI_INTERNALS__.invoke('plugin:autostart|is_enabled'));
  record('actual settings disable removes only the unique QA entry',await check('disabled'));mayHaveEnabled=false;
  report.passed=true;
 }catch(error){report.error=error.message||JSON.stringify(error);throw error}
 finally{
  if(mayHaveEnabled&&invoke){await invoke('plugin:autostart|disable');record('owned QA entry removed during recovery',await check('disabled'))}
  guard.stdin.end();report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,report:destination}));
 }
 process.exit(0);
})().catch(error=>{console.error(error.stack||JSON.stringify(error));process.exit(1)});
