param([Parameter(Mandatory=$true)][string]$Metadata,[switch]$Graceful)
$ErrorActionPreference='Stop'
$qaRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
if([IO.Path]::GetFullPath($Metadata) -ne (Join-Path $qaRoot 'process.json')){throw 'Expected exact QA metadata'}
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007' -or [IO.Path]::GetFullPath($info.exe) -ne (Join-Path $qaRoot 'copy-creator-qa.exe')){throw 'Expected isolated QA identity'}
$qaProcess=Get-Process -Id $info.pid -ErrorAction SilentlyContinue
if(-not $qaProcess){@{alreadyStopped=$true}|ConvertTo-Json -Compress;exit}
if($qaProcess.Path -ne $info.exe -or (Get-FileHash -LiteralPath $qaProcess.Path -Algorithm SHA256).Hash -ne $info.sha256){throw 'QA process identity mismatch'}
& C:/Users/ABD18/dev/nodejs/node.exe (Join-Path $PSScriptRoot 'flush-qa.cjs') $Metadata
if($LASTEXITCODE -ne 0){throw 'QA save barrier failed; process preserved'}
if($Graceful){
 if(-not $env:QA_POWERSHELL){throw 'Set the reviewed QA PowerShell runtime'}
 'quit' | & $env:QA_POWERSHELL -NoProfile -File (Join-Path $PSScriptRoot 'operate-qa-tray.ps1') -Metadata $Metadata
 if($LASTEXITCODE -ne 0){throw 'Owned tray Quit failed; process preserved'}
}else{Stop-Process -Id $info.pid}
if(-not $qaProcess.WaitForExit(10000)){throw 'QA did not stop'}
@{stoppedQaPid=$info.pid;saveBarrierConfirmed=$true;scope=$(if($Graceful){'Owned tray Quit for repeated startup; no dirty-content acceptance claim'}else{'Harness stop, not native Quit acceptance'})} | ConvertTo-Json -Compress
