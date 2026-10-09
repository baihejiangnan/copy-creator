param([Parameter(Mandatory=$true)][string]$RunId)
$ErrorActionPreference='Stop'
if($RunId -notmatch '^migration-[a-z0-9-]+$'){throw 'Expected bounded QA run name'}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $repo 'output/optimization/QA-notes-20261007/search-runtime-qa'
$metaPath=Join-Path $root 'process.json'
$info=Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007search'){throw 'Expected dedicated search QA identifier'}
$exe=Join-Path $root 'copy-creator-search-qa.exe'
if([IO.Path]::GetFullPath($info.exe) -ne $exe){throw 'Unexpected search QA executable'}
$qaProcess=Get-Process -Id $info.pid
if($qaProcess.Path -ne $exe -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $info.sha256){throw 'Experimental QA identity mismatch'}
$incoming=[IO.Path]::GetFullPath((Join-Path $root 'migration-incoming'))
$storage=[IO.Path]::GetFullPath($info.storageRoot)
$preserved=[IO.Path]::GetFullPath((Join-Path $root "storage-before-$RunId"))
foreach($target in @($incoming,$storage,$preserved)){if(-not $target.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'All move paths must stay in the exact QA experiment'}}
if(Test-Path -LiteralPath $preserved){throw 'Refusing to replace preserved QA state'}
$env:PYTHONUTF8='1'
$env:QA_MIGRATION_RUN_ID=$RunId
& C:/Users/ABD18/AppData/Local/Programs/Python/Python311/python.exe (Join-Path $PSScriptRoot 'prepare-search-migration-fixture.py')
if($LASTEXITCODE -ne 0){throw 'Synthetic schema-4 migration fixture preparation failed'}
$env:PLAYWRIGHT_MODULE='C:/Users/ABD18/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
& C:/Users/ABD18/dev/nodejs/node.exe (Join-Path $PSScriptRoot 'flush-qa.cjs') $metaPath
if($LASTEXITCODE -ne 0){throw 'QA save barrier failed'}
# Harness refresh only; not evidence of a native Quit path.
Stop-Process -Id $info.pid
if(-not $qaProcess.WaitForExit(10000)){throw 'QA process remained alive'}
Move-Item -LiteralPath $storage -Destination $preserved
Move-Item -LiteralPath $incoming -Destination $storage
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$($info.debugPort)"
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $root 'webview-profile'
$timer=[Diagnostics.Stopwatch]::StartNew()
$newQa=Start-Process -FilePath $exe -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root "$RunId.stdout.log") -RedirectStandardError (Join-Path $root "$RunId.stderr.log") -PassThru
$info.pid=$newQa.Id
$info | ConvertTo-Json | Set-Content -LiteralPath $metaPath -Encoding utf8
$ready=$false
for($attempt=0;$attempt -lt 150;$attempt++){
 try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$($info.debugPort)/json/version" -TimeoutSec 1;$ready=$true;break}
 catch {if($newQa.HasExited){throw 'Search migration QA exited'};Start-Sleep -Milliseconds 200}
}
if(-not $ready){throw 'WebView readiness timeout'}
$cdpReadyMs=$timer.Elapsed.TotalMilliseconds
& C:/Users/ABD18/dev/nodejs/node.exe (Join-Path $PSScriptRoot 'probe-search-runtime-qa.cjs')
if($LASTEXITCODE -ne 0){throw 'Post-migration native identity check failed'}
$timer.Stop()
@{identifier=$info.identifier;pid=$newQa.Id;cdpReadyMs=$cdpReadyMs;nativeReadyMs=$timer.Elapsed.TotalMilliseconds;scope='Single schema-4 52,100-note synthetic upgrade; process start to native ready includes WebView and Node probe overhead, not 30-run cold startup or pure migration timing.'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root "$RunId-start.json") -Encoding utf8
Get-Content -LiteralPath (Join-Path $root "$RunId-start.json")
