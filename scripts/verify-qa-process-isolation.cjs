// Admission checks use real live process inventory; no OS UI or clipboard access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../output/optimization/QA-notes-20261007');
const metadata=path.join(root,'process.json'),raw=fs.readFileSync(metadata),info=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));
const report={started:new Date().toISOString(),app:info,scope:'Actual live isolated default process; child admission checks only. No second native launch, clipboard helper or database cloning expected.',steps:[]};
const destination=path.join(root,'reports','qa-process-isolation-'+Date.now()+'.json');
const run=(file,args)=>spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
const pwsh=args=>run(process.env.QA_POWERSHELL,['-NoProfile',...args]);
const inventory=()=>{const result=pwsh(['-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.StartsWith('"+root.replace(/'/g,"''")+"\\',[StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith('"+path.resolve(root,'../baseline-runtime-20261008').replace(/'/g,"''")+"\\',[StringComparison]::OrdinalIgnoreCase)) } | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress"]);assert.equal(result.status,0,result.stderr);return [].concat(JSON.parse(result.stdout)||[]).sort((a,b)=>a-b)};
const reject=(label,result,marker)=>{assert.notEqual(result.status,0,label+' must refuse');assert.ok((result.stdout+result.stderr).includes(marker),label+' expected refusal');report.steps.push({step:label,refused:true,marker});};
try{
 assert.equal(info.identifier,'com.copycreator.qa20261007');assert.equal(info.pasteIsolation,'identifier');assert.equal(info.autostartIsolation,'identifier');
 const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(info.exe)).digest('hex');assert.equal(digest(),info.sha256.toLowerCase());
 const before=inventory();assert.deepEqual(before,[info.pid]);
 const marker='Refusing QA launch: live owned QA process inventory is not empty; PIDs='+info.pid;
 reject('read-only live inventory gate',pwsh(['-File',path.join(__dirname,'qa-process-isolation.ps1')]),marker);
 reject('saved default launcher',pwsh(['-File',path.join(__dirname,'launch-saved-qa.ps1'),'-Metadata',metadata]),marker);
 const nested=run(process.execPath,[path.join(__dirname,'with-controlled-clipboard-qa.cjs'),'verify-qa-process-isolation.cjs']);
 reject('controlled wrapper before clipboard helper',nested,marker);assert.ok(!(nested.stdout+nested.stderr).includes('clipboardPreserved'));
 reject('retired legacy search launcher',pwsh(['-File',path.join(__dirname,'start-search-runtime-qa.ps1'),'-SourceDatabase',path.join(info.storageRoot,'data.db')]),'Retired search QA launcher:');
 assert.deepEqual(inventory(),before);assert.deepEqual(fs.readFileSync(metadata),raw);assert.equal(digest(),info.sha256.toLowerCase());
 report.currentProcessRemainsAlive=true;report.noAdditionalQaNativeProcesses=true;report.metadataAndExecutableUnchanged=true;report.nestedClipboardHelperNotStarted=true;report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;console.error(error.stack)}
finally{report.finished=new Date().toISOString();fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed||false,steps:report.steps,report:destination}));}
