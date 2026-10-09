param([Parameter(Mandatory=$true)][string]$Metadata,[Parameter(Mandatory=$true)][ValidateSet('launch','stop')][string]$Action)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/baseline-runtime-20261008'))
if([IO.Path]::GetFullPath($Metadata) -ne (Join-Path $root 'process.json')){throw 'Expected exact runtime baseline metadata'}
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qabaseline20261008v2' -or $info.generation -ne 2 -or $info.autostartIsolation -ne 'identifier' -or [IO.Path]::GetFullPath($info.exe) -ne (Join-Path $root 'copy-creator-qa.exe')){throw 'Expected isolated runtime baseline'}
if((Get-FileHash -LiteralPath $info.exe -Algorithm SHA256).Hash -ne $info.sha256){throw 'Runtime baseline hash mismatch'}
$running=Get-Process -Id $info.pid -ErrorAction SilentlyContinue
if($Action -eq 'stop'){
 if($running){if($running.Path -ne $info.exe){throw 'Runtime baseline process owner mismatch'};Stop-Process -Id $info.pid;if(-not $running.WaitForExit(10000)){throw 'Runtime baseline did not stop'}}
 @{stopped=$true;scope='Read-only baseline harness stop; no lifecycle or dirty-save acceptance claim'} | ConvertTo-Json -Compress
 exit
}
if($info.pasteIsolation -ne 'identifier'){throw 'Refusing runtime baseline with shared production paste-image temporary cleanup; rebuild the isolated baseline first'}
$python=if($env:QA_PYTHON){$env:QA_PYTHON}else{'C:/Users/ABD18/AppData/Local/Programs/Python/Python311/python.exe'}
@{action='selected';metadata=$Metadata}|ConvertTo-Json -Compress|& $python (Join-Path $PSScriptRoot 'qa-runtime-baseline-guard.py')
if($LASTEXITCODE -ne 0){throw 'Generation-2 baseline/schema admission failed'}
& (Join-Path $PSScriptRoot 'qa-process-isolation.ps1')
if($running -and $running.Path -eq $info.exe){throw 'Runtime baseline already running'}
$default=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007/process.json') -Raw | ConvertFrom-Json
$other=Get-Process -Id $default.pid -ErrorAction SilentlyContinue
if($other -and $other.Path -eq $default.exe){throw 'Stop default QA before runtime comparison'}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$($info.debugPort)"
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $root 'webview-profile'
$run='runtime-'+[guid]::NewGuid().ToString()
$process=Start-Process -FilePath $info.exe -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root "$run.stdout.log") -RedirectStandardError (Join-Path $root "$run.stderr.log") -PassThru
$info.pid=$process.Id
$info | Add-Member -MemberType NoteProperty -Name launchStartedUnixMs -Value ([DateTimeOffset]::new($process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()) -Force
$info | ConvertTo-Json | Set-Content -LiteralPath $Metadata -Encoding utf8
for($attempt=0;$attempt -lt 100;$attempt++){
 try {$targets=Invoke-RestMethod -Uri "http://127.0.0.1:$($info.debugPort)/json/list" -TimeoutSec 1;if($targets | Where-Object {$_.url -eq 'http://tauri.localhost/'}){$info | ConvertTo-Json;exit}}
 catch {if($process.HasExited){throw 'Runtime baseline exited before WebView ready'}}
 Start-Sleep -Milliseconds 100
}
throw 'Runtime baseline readiness timeout'
