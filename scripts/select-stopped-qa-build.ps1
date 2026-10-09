param([Parameter(Mandatory=$true)][ValidatePattern('^native-(release|profile)-[a-z0-9-]+$')][string]$Variant)
$ErrorActionPreference='Stop'
$qaRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
$metadata=Join-Path $qaRoot 'process.json'
$info=Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007' -or [IO.Path]::GetFullPath($info.exe) -ne (Join-Path $qaRoot 'copy-creator-qa.exe')){throw 'Expected exact isolated QA identity'}
$running=Get-Process -Id $info.pid -ErrorAction SilentlyContinue
if($running -and $running.Path -eq $info.exe){throw 'Stop QA through clipboard-preserving wrapper before selecting another build'}
if((Get-FileHash -LiteralPath $info.exe -Algorithm SHA256).Hash -ne $info.sha256){throw 'Current selected QA hash mismatch'}
$artifact=Join-Path $qaRoot $Variant
$build=Get-Content -LiteralPath (Join-Path $artifact 'build.json') -Raw | ConvertFrom-Json
$source=Join-Path $artifact 'copy-creator.exe'
if($build.identifier -ne $info.identifier -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $build.sha256){throw 'Candidate QA identity/hash mismatch'}
$info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifact ('selection-before-'+[guid]::NewGuid().ToString()+'.json')) -Encoding utf8
Copy-Item -LiteralPath $source -Destination $info.exe
if((Get-FileHash -LiteralPath $info.exe -Algorithm SHA256).Hash -ne $build.sha256){throw 'Selected QA copy mismatch'}
$info.sha256=$build.sha256;$info.profile=$build.profile;$info.frontend=$build.frontend;$info.synchronous=$build.synchronous
$info | Add-Member -MemberType NoteProperty -Name nativeArtifact -Value $Variant -Force
$info | Add-Member -MemberType NoteProperty -Name autostartIsolation -Value $(if($build.autostartIsolation){$build.autostartIsolation}else{'shared-name-legacy'}) -Force
$pasteSource=Join-Path $artifact 'source/src-tauri/src/paste.rs'
$dbSource=Join-Path $artifact 'source/src-tauri/src/db.rs'
$pasteIsolated=$false
$hashList=Join-Path $artifact 'source-hashes.json'
if(-not(Test-Path -LiteralPath $hashList)){$hashList=Join-Path $artifact 'native-source-hashes.json'}
if((Test-Path -LiteralPath $pasteSource) -and (Test-Path -LiteralPath $dbSource) -and (Test-Path -LiteralPath $hashList)){
 $hashes=Get-Content -LiteralPath $hashList -Raw | ConvertFrom-Json
 $pasteHash=$hashes | Where-Object {$_.path.Replace('\','/') -eq 'src-tauri/src/paste.rs'}
 $dbHash=$hashes | Where-Object {$_.path.Replace('\','/') -eq 'src-tauri/src/db.rs'}
 if($pasteHash.sha256 -eq (Get-FileHash -LiteralPath $pasteSource -Algorithm SHA256).Hash -and $dbHash.sha256 -eq (Get-FileHash -LiteralPath $dbSource -Algorithm SHA256).Hash){
  $pasteText=Get-Content -LiteralPath $pasteSource -Raw;$dbText=Get-Content -LiteralPath $dbSource -Raw
  $pasteIsolated=$pasteText.Contains('copy_creator_paste_instances') -and $pasteText.Contains('let mut dir = paste_image_directory(app);') -and $dbText.Contains('let paste_dir = crate::paste::paste_image_directory(app);')
 }
}
$info | Add-Member -MemberType NoteProperty -Name pasteIsolation -Value $(if($pasteIsolated){'identifier'}else{'shared-temp-legacy'}) -Force
$info | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding utf8
@{selected=$Variant;sha256=$build.sha256;started=$false;scope='Stopped isolated QA launcher only; original build artifacts retained'} | ConvertTo-Json -Compress
