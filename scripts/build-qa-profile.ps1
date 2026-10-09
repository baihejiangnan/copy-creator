param(
 [Parameter(Mandatory=$true)][ValidateSet('thin-single','size-thin-single')][string]$Variant,
 [ValidatePattern('^frontend-[a-z0-9-]+$')][string]$Frontend='frontend-maintenance',
 [ValidatePattern('^[a-z0-9-]*$')][string]$Label=''
)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$app=Join-Path $repo 'copy-creator'
$qaRoot=Join-Path $repo 'output/optimization/QA-notes-20261007'
$artifactName="native-profile-$Variant"+$(if($Label){"-$Label"}else{''})
$artifact=Join-Path $qaRoot $artifactName
if(Test-Path -LiteralPath $artifact){throw 'Refusing to replace a preserved experiment'}
New-Item -ItemType Directory -Path $artifact | Out-Null
Push-Location $app
try {
 $pasteEntry=Get-Content -LiteralPath 'src-tauri/src/paste.rs' -Raw
 $dbEntry=Get-Content -LiteralPath 'src-tauri/src/db.rs' -Raw
 if(-not $pasteEntry.Contains('copy_creator_paste_instances') -or -not $pasteEntry.Contains('let mut dir = paste_image_directory(app);') -or -not $dbEntry.Contains('let paste_dir = crate::paste::paste_image_directory(app);')){throw 'QA requires identifier-isolated paste image writing and cleanup'}
 $nativeEntry=Get-Content -LiteralPath 'src-tauri/src/lib.rs' -Raw
 if(-not $nativeEntry.Contains('.app_name(autostart_name)') -or -not $nativeEntry.Contains('fn autostart_entry_name(')){throw 'Profile QA requires identifier-isolated autostart registration'}
 $nativeFiles=@(& rg --files src-tauri)
 if($LASTEXITCODE -ne 0){throw 'Source inventory failed'}
 $hashes=@()
 foreach($file in $nativeFiles){
  $target=Join-Path $artifact "source/$file"
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
  Copy-Item -LiteralPath $file -Destination $target
  $hashes+=@{path=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash}
 }
 $hashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $artifact 'native-source-hashes.json') -Encoding utf8
 Copy-Item -LiteralPath (Join-Path $qaRoot "$Frontend-inventory.json") -Destination (Join-Path $artifact 'frontend-inventory.json')
 $env:PATH="$HOME/.cargo/bin;C:/Users/ABD18/dev/nodejs;"+$env:PATH
 $env:CARGO_TARGET_DIR=Join-Path $qaRoot "native-target-$Variant"
 $env:CARGO_BUILD_JOBS='4'
 $env:CARGO_PROFILE_RELEASE_LTO='thin'
 $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS='1'
 $env:CARGO_PROFILE_RELEASE_STRIP='symbols'
 $env:CARGO_PROFILE_RELEASE_OPT_LEVEL=if($Variant -eq 'size-thin-single'){'s'}else{'3'}
 $config=Join-Path $artifact 'tauri-qa.json'
 @{identifier='com.copycreator.qa20261007';build=@{frontendDist="../../output/optimization/QA-notes-20261007/$Frontend";beforeBuildCommand=''}} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $config -Encoding utf8
 $timer=[Diagnostics.Stopwatch]::StartNew()
 & C:/Users/ABD18/dev/nodejs/node.exe node_modules/@tauri-apps/cli/tauri.js build --no-bundle --ci --config $config -- --locked --offline 2>&1 | Tee-Object -FilePath (Join-Path $artifact 'build.log')
 if($LASTEXITCODE -ne 0){throw 'Profile build failed; preserved log'}
 $timer.Stop()
 foreach($entry in $hashes){if((Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash -ne $entry.sha256){throw 'Native source changed during experiment'}}
 Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/copy-creator.exe') -Destination (Join-Path $artifact 'copy-creator.exe')
 $exe=Get-Item -LiteralPath (Join-Path $artifact 'copy-creator.exe')
 @{identifier='com.copycreator.qa20261007';autostartIsolation='identifier';profile="release-$Variant";synchronous='FULL';frontend=$Frontend;bytes=$exe.Length;sha256=(Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256).Hash;buildSeconds=$timer.Elapsed.TotalSeconds;compiler=@{lto='thin';codegenUnits=1;strip='symbols';optLevel=$env:CARGO_PROFILE_RELEASE_OPT_LEVEL;panic='default unwind'};scope='Isolated QA experiment; not adopted or published'} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $artifact 'build.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $artifact 'build.json')
} finally {Pop-Location}
