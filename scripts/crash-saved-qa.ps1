# Deliberate abnormal termination of the exact default synthetic QA process.
param([Parameter(Mandatory=$true)][string]$Metadata)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
if([IO.Path]::GetFullPath($Metadata) -ne (Join-Path $root 'process.json')){throw 'Expected exact QA metadata'}
$info=Get-Content -LiteralPath $Metadata -Raw|ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007' -or $info.profile -ne 'release-default' -or $info.synchronous -ne 'FULL' -or $info.nativeArtifact -ne 'native-release-notes-scrollbars' -or $info.pasteIsolation -ne 'identifier' -or $info.autostartIsolation -ne 'identifier' -or [IO.Path]::GetFullPath($info.exe) -ne (Join-Path $root 'copy-creator-qa.exe')){throw 'Expected exact default QA artifact'}
$native=Get-Process -Id $info.pid -ErrorAction Stop
if($native.Path -ne $info.exe -or (Get-FileHash -LiteralPath $native.Path -Algorithm SHA256).Hash -ne $info.sha256){throw 'QA owner/hash changed'}
Stop-Process -Id $native.Id -ErrorAction Stop
if(-not $native.WaitForExit(10000)){throw 'QA abnormal termination did not finish'}
@{abnormallyStoppedQaPid=$info.pid;saveBarrierUsed=$false;scope='Synthetic QA only, process kill; not power loss or storage hardware failure'}|ConvertTo-Json -Compress
