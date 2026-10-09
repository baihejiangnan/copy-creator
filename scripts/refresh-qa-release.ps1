param(
  [Parameter(Mandatory=$true)][string]$Metadata,
  [Parameter(Mandatory=$true)][string]$BuildDirectory,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$PlaywrightModule
)
$ErrorActionPreference='Stop'
$qaRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
$buildRoot=[IO.Path]::GetFullPath($BuildDirectory)
if(-not $buildRoot.StartsWith($qaRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Build must be inside isolated QA artifacts'}
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
$build=Get-Content -LiteralPath (Join-Path $buildRoot 'build.json') -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007' -or $build.identifier -ne $info.identifier){throw 'Expected isolated QA identifiers'}
if($info.autostartIsolation -ne 'identifier' -or $build.autostartIsolation -ne 'identifier'){throw 'Refusing a legacy QA executable with a shared production autostart name'}
if([IO.Path]::GetFullPath($info.exe) -ne (Join-Path $qaRoot 'copy-creator-qa.exe')){throw 'Unexpected QA executable path'}
$source=Join-Path $buildRoot 'copy-creator.exe'
if((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash -ne $build.sha256){throw 'QA build hash mismatch'}
$qaProcess=Get-Process -Id $info.pid
if($qaProcess.Path -ne $info.exe -or (Get-FileHash -Algorithm SHA256 -LiteralPath $qaProcess.Path).Hash -ne $info.sha256){throw 'Running QA identity mismatch'}
$env:PLAYWRIGHT_MODULE=$PlaywrightModule
& $NodePath (Join-Path $PSScriptRoot 'flush-qa.cjs') $Metadata
if($LASTEXITCODE -ne 0){throw 'QA save barrier failed; leaving process untouched'}
Stop-Process -Id $info.pid
if(-not $qaProcess.WaitForExit(10000)){throw 'QA process did not exit'}
for($attempt=0;$attempt -lt 10;$attempt++){
  try {Copy-Item -LiteralPath $source -Destination $info.exe;break}
  catch {if($attempt -eq 9){throw};Start-Sleep -Milliseconds 300}
}
if((Get-FileHash -Algorithm SHA256 -LiteralPath $info.exe).Hash -ne $build.sha256){throw 'QA copied hash mismatch'}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$($info.debugPort)"
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $qaRoot 'webview-profile-release-min-window'
$variant=Split-Path $buildRoot -Leaf
$newQA=Start-Process -FilePath $info.exe -WorkingDirectory $qaRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $qaRoot "$variant.stdout.log") -RedirectStandardError (Join-Path $qaRoot "$variant.stderr.log") -PassThru
$info.pid=$newQA.Id;$info.sha256=$build.sha256;$info.profile=$build.profile;$info.frontend=$build.frontend;$info.synchronous=$build.synchronous
$info | Add-Member -MemberType NoteProperty -Name nativeArtifact -Value $variant -Force
$info | Add-Member -MemberType NoteProperty -Name autostartIsolation -Value $build.autostartIsolation -Force
$info | ConvertTo-Json | Set-Content -LiteralPath $Metadata -Encoding utf8
$ready=$false
for($attempt=0;$attempt -lt 60;$attempt++){
  try { $null=Invoke-RestMethod -Uri "http://127.0.0.1:$($info.debugPort)/json/version" -TimeoutSec 1; $ready=$true;break }
  catch { if($newQA.HasExited){throw 'QA process exited before its WebView became ready'};Start-Sleep -Milliseconds 200 }
}
if(-not $ready){throw 'QA WebView did not become ready'}
$info | ConvertTo-Json
