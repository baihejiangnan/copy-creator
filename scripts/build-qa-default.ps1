param(
 [Parameter(Mandatory=$true)][string]$Frontend,
 [Parameter(Mandatory=$true)][string]$Variant,
 [switch]$Diagnostics
)
$ErrorActionPreference='Stop'
if($Frontend -notmatch '^frontend-[a-z0-9-]+$' -or $Variant -notmatch '^native-release-[a-z0-9-]+$'){throw 'Expected QA artifact names'}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qaRoot=Join-Path $repo 'output/optimization/QA-notes-20261007'
$artifact=Join-Path $qaRoot $Variant
if(Test-Path -LiteralPath $artifact){throw 'Refusing to replace a preserved build'}
if(-not(Test-Path -LiteralPath (Join-Path $qaRoot "$Frontend/index.html"))){throw 'Missing frozen frontend'}
New-Item -ItemType Directory -Path $artifact | Out-Null
$manifest=Join-Path $qaRoot "$Frontend/.vite/manifest.json"
if(Test-Path -LiteralPath $manifest){
 Move-Item -LiteralPath $manifest -Destination (Join-Path $qaRoot "$Frontend-manifest.json")
 Remove-Item -LiteralPath (Join-Path $qaRoot "$Frontend/.vite")
}
Copy-Item -LiteralPath (Join-Path $qaRoot "$Frontend-inventory.json") -Destination (Join-Path $artifact 'frontend-inventory.json')
$config=Join-Path $artifact 'tauri-qa.json'
@{identifier='com.copycreator.qa20261007';build=@{frontendDist="../../output/optimization/QA-notes-20261007/$Frontend";beforeBuildCommand=''}} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $config -Encoding utf8
Push-Location (Join-Path $repo 'copy-creator')
try {
 $pasteEntry=Get-Content -LiteralPath 'src-tauri/src/paste.rs' -Raw
 $dbEntry=Get-Content -LiteralPath 'src-tauri/src/db.rs' -Raw
 if(-not $pasteEntry.Contains('copy_creator_paste_instances') -or -not $pasteEntry.Contains('let mut dir = paste_image_directory(app);') -or -not $dbEntry.Contains('let paste_dir = crate::paste::paste_image_directory(app);')){throw 'QA requires identifier-isolated paste image writing and cleanup'}
 $nativeEntry=Get-Content -LiteralPath 'src-tauri/src/lib.rs' -Raw
 if(-not $nativeEntry.Contains('.app_name(autostart_name)') -or -not $nativeEntry.Contains('fn autostart_entry_name(')){throw 'Default QA requires identifier-isolated autostart registration'}
 # Tauri rewrites this manifest to LF; freeze that representation beforehand.
 $qaManifest=Join-Path $PWD 'src-tauri/Cargo.toml'
 [IO.File]::WriteAllText($qaManifest,[IO.File]::ReadAllText($qaManifest).Replace("`r`n","`n"))
 $files=@(& rg --files src src-tauri package.json pnpm-lock.yaml vite.config.ts index.html radial.html)
 if($LASTEXITCODE -ne 0){throw 'Source inventory failed'}
 $hashes=@()
 foreach($file in $files){
  $target=Join-Path $artifact "source/$file"
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
  Copy-Item -LiteralPath $file -Destination $target
  $hashes+=@{path=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash}
 }
 $hashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $artifact 'source-hashes.json') -Encoding utf8
 $env:PATH="$HOME/.cargo/bin;C:/Users/ABD18/dev/nodejs;"+$env:PATH
 foreach($name in @('CARGO_PROFILE_RELEASE_LTO','CARGO_PROFILE_RELEASE_CODEGEN_UNITS','CARGO_PROFILE_RELEASE_STRIP','CARGO_PROFILE_RELEASE_OPT_LEVEL','CARGO_TARGET_DIR')){Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue}
 $timer=[Diagnostics.Stopwatch]::StartNew()
 $featureArgs=@();if($Diagnostics){$featureArgs=@('--features','diagnostics')}
 & C:/Users/ABD18/dev/nodejs/node.exe node_modules/@tauri-apps/cli/tauri.js build --no-bundle --ci --config $config @featureArgs -- --locked --offline 2>&1 | Tee-Object -FilePath (Join-Path $artifact 'build.log')
 if($LASTEXITCODE -ne 0){throw 'QA build failed; preserved log'}
 $timer.Stop()
 foreach($entry in $hashes){if((Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash -ne $entry.sha256){throw 'Source changed during QA build'}}
 $exe=Join-Path $artifact 'copy-creator.exe'
 Copy-Item -LiteralPath 'src-tauri/target/release/copy-creator.exe' -Destination $exe
 @{identifier='com.copycreator.qa20261007';autostartIsolation='identifier';profile=$(if($Diagnostics){'release-diagnostics'}else{'release-default'});synchronous='FULL';frontend=$Frontend;bytes=(Get-Item -LiteralPath $exe).Length;sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash;buildSeconds=$timer.Elapsed.TotalSeconds} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifact 'build.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $artifact 'build.json')
} finally {Pop-Location}
