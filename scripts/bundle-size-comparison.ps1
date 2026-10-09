param([Parameter(Mandatory=$true)][ValidateSet('R0','R1','current','current-latest','notes-scrollbars','image-idle','paste-settle','paste-feedback','font-control','font-woff2')][string]$Variant)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qaRoot=Join-Path $repo 'output/optimization/QA-notes-20261007'
$sources=@{
 R0=(Join-Path $repo 'output/optimization/R0-20261007/native-production')
 R1=(Join-Path $repo 'output/optimization/R1-fonts-20261007/native-production')
 current=(Join-Path $qaRoot 'native-release-clipboard-ack')
 'current-latest'=(Join-Path $qaRoot 'native-release-translation-identity')
 'notes-scrollbars'=(Join-Path $qaRoot 'native-release-notes-scrollbars')
 'image-idle'=(Join-Path $qaRoot 'native-release-image-idle')
 'paste-settle'=(Join-Path $qaRoot 'native-release-paste-settle')
 'paste-feedback'=(Join-Path $qaRoot 'native-release-paste-feedback')
 'font-control'=(Join-Path $qaRoot 'native-release-font-control')
 'font-woff2'=(Join-Path $qaRoot 'native-release-font-woff2')
}
$source=$sources[$Variant]
$build=Get-Content -LiteralPath (Join-Path $source 'build.json') -Raw | ConvertFrom-Json
$binary=Join-Path $source 'copy-creator.exe'
if((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $build.sha256){throw 'Preserved source EXE hash mismatch'}
$artifact=Join-Path $qaRoot "installer-size-$($Variant.ToLower())"
if(Test-Path -LiteralPath $artifact){throw 'Refusing to replace preserved installer measurement'}
$target=Join-Path $artifact 'target'
New-Item -ItemType Directory -Path (Join-Path $target 'release') | Out-Null
Copy-Item -LiteralPath $binary -Destination (Join-Path $target 'release/copy-creator.exe')
$config=Join-Path $artifact 'package-qa.json'
$frontend=if($build.PSObject.Properties.Name -contains 'frontend'){$build.frontend}else{'frontend-clipboard-ack'}
@{identifier='com.copycreator.packageqa20261008';build=@{beforeBuildCommand='';beforeBundleCommand='';frontendDist="../../output/optimization/QA-notes-20261007/$frontend"}} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $config -Encoding utf8
$env:CARGO_TARGET_DIR=$target
$env:PATH="$HOME/.cargo/bin;C:/Users/ABD18/dev/nodejs;"+$env:PATH
Push-Location (Join-Path $repo 'copy-creator')
try {
 $timer=[Diagnostics.Stopwatch]::StartNew()
 & C:/Users/ABD18/dev/nodejs/node.exe node_modules/@tauri-apps/cli/tauri.js bundle --ci --no-sign --bundles nsis,msi --config $config 2>&1 | Tee-Object -FilePath (Join-Path $artifact 'bundle.log')
 if($LASTEXITCODE -ne 0){throw 'Bundle generation failed; preserved log'}
 $timer.Stop()
 if((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $build.sha256){throw 'Preserved source EXE changed'}
 $packagedCopy=Join-Path $target 'release/copy-creator.exe'
 if((Get-Item -LiteralPath $packagedCopy).Length -ne $build.bytes){throw 'Unexpected packaged-copy size change'}
 $installers=@(Get-ChildItem -LiteralPath (Join-Path $target 'release/bundle') -Recurse -File | Where-Object {$_.Extension -in @('.msi','.exe')} | ForEach-Object {@{file=$_.FullName;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
 if($installers.Count -ne 2){throw 'Expected NSIS and MSI packages'}
 @{variant=$Variant;sourceExeBytes=$build.bytes;sourceExeSha256=$build.sha256;bundlerStampedCopySha256=(Get-FileHash -LiteralPath $packagedCopy -Algorithm SHA256).Hash;packageIdentifier='com.copycreator.packageqa20261008';installers=$installers;elapsedSeconds=$timer.Elapsed.TotalSeconds;scope='Compression/packaging comparison only. Preserved original EXEs unchanged; Tauri stamps bundle type on temporary copies. Identical current packaging tools/config/icons. Package metadata QA identifier does not rewrite embedded EXE identity. Never install or launch these measurement packages; no installer functionality or release claim.'} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $artifact 'report.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $artifact 'report.json')
} finally {Pop-Location}
