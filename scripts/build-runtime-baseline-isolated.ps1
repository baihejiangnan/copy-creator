param([Parameter(Mandatory=$true)][ValidateSet('R0','R1','current')][string]$Variant)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $repo 'output/optimization/baseline-runtime-20261008'
$identifier='com.copycreator.qabaseline20261008v2'
$artifact=Join-Path $root "$Variant-embedded-v2"
if(Test-Path -LiteralPath $artifact){throw 'Refusing to overwrite preserved isolated baseline'}
New-Item -ItemType Directory -Path $artifact | Out-Null
$work=Join-Path $artifact 'source/copy-creator'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$frozen=Join-Path $repo 'output/optimization/R0-20261007/source/copy-creator'
if($Variant -eq 'current'){
 Push-Location (Join-Path $repo 'copy-creator')
 try{foreach($file in @(& rg --files src src-tauri package.json pnpm-lock.yaml vite.config.ts index.html radial.html)){$destination=Join-Path $work $file;New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force|Out-Null;Copy-Item -LiteralPath $file -Destination $destination}}finally{Pop-Location}
 $frontend=Join-Path $repo 'output/optimization/QA-notes-20261007/frontend-clipboard-errors'
}else{
 foreach($item in Get-ChildItem -LiteralPath $frozen -Force){Copy-Item -LiteralPath $item.FullName -Destination $work -Recurse -ErrorAction Stop}
}
if($Variant -ne 'current'){
 $entry=Join-Path $work 'src-tauri/src/lib.rs';$source=[IO.File]::ReadAllText($entry)
 $old=".plugin(tauri_plugin_autostart::init(`r`n            tauri_plugin_autostart::MacosLauncher::LaunchAgent,`r`n            Some(vec![`"--hidden`"]),`r`n        ))"
 if(-not $source.Contains($old)){throw 'Frozen baseline autostart source does not match reviewed block'}
 $replacement=".plugin(tauri_plugin_autostart::Builder::new().app_name(`"Copy Creator ($identifier)`").arg(`"--hidden`" ).build())"
 [IO.File]::WriteAllText($entry,$source.Replace($old,$replacement))
 $digest=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($identifier))).Replace('-','').ToLowerInvariant()
 $pasteFile=Join-Path $work 'src-tauri/src/paste.rs';$paste=[IO.File]::ReadAllText($pasteFile)
 $oldPath="let mut dir = std::env::temp_dir();`r`n        dir.push(`"copy_creator_paste`");"
 if(-not $paste.Contains($oldPath)){throw 'Frozen baseline clipboard image writer differs from reviewed block'}
 $paste=$paste.Replace($oldPath,'let mut dir = baseline_paste_image_directory();')
 $paste+="`r`n// Baseline-only identity fixed by this build configuration; no business behavior change.`r`npub(crate) fn baseline_paste_image_directory() -> std::path::PathBuf {`r`n    std::env::temp_dir().join(`"copy_creator_paste_instances`").join(`"$digest`")`r`n}`r`n"
 [IO.File]::WriteAllText($pasteFile,$paste)
 $dbFile=Join-Path $work 'src-tauri/src/db.rs';$db=[IO.File]::ReadAllText($dbFile)
 $oldCleanup='let paste_dir = std::env::temp_dir().join("copy_creator_paste");'
 if(-not $db.Contains($oldCleanup)){throw 'Frozen baseline cleanup differs from reviewed block'}
 [IO.File]::WriteAllText($dbFile,$db.Replace($oldCleanup,'let paste_dir = crate::paste::baseline_paste_image_directory();'))
 foreach($relative in @('src-tauri/src/lib.rs','src-tauri/src/paste.rs','src-tauri/src/db.rs')){
  & git diff --no-index -- (Join-Path $frozen $relative) (Join-Path $work $relative) | Add-Content -LiteralPath (Join-Path $artifact 'isolation-only.patch') -Encoding utf8
  if($LASTEXITCODE -gt 1){throw 'Cannot retain isolation patch'}
 }
 $frontend=Join-Path $repo $(if($Variant -eq 'R0'){'output/optimization/R0-20261007/frontend'}else{'output/optimization/R1-fonts-20261007/frontend'})
}
if(-not(Test-Path -LiteralPath (Join-Path $frontend 'index.html'))){throw 'Frozen frontend missing'}
$config=Join-Path $artifact 'qa-config.json'
@{identifier=$identifier;build=@{frontendDist=[IO.Path]::GetRelativePath((Join-Path $work 'src-tauri'),$frontend);beforeBuildCommand=''}}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $config -Encoding utf8
$env:PATH="$HOME/.cargo/bin;C:/Users/ABD18/dev/nodejs;"+$env:PATH
$env:CARGO_TARGET_DIR=Join-Path $repo 'copy-creator/src-tauri/target'
foreach($name in @('CARGO_PROFILE_RELEASE_LTO','CARGO_PROFILE_RELEASE_CODEGEN_UNITS','CARGO_PROFILE_RELEASE_STRIP','CARGO_PROFILE_RELEASE_OPT_LEVEL')){Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue}
Push-Location $work
try{
 $hashes=@(& rg --files src src-tauri package.json pnpm-lock.yaml vite.config.ts index.html | ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash}})
 $hashes|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $artifact 'source-hashes.json') -Encoding utf8
 $timer=[Diagnostics.Stopwatch]::StartNew()
 & C:/Users/ABD18/dev/nodejs/node.exe (Join-Path $repo 'copy-creator/node_modules/@tauri-apps/cli/tauri.js') build --no-bundle --ci --config $config -- --locked --offline 2>&1|Tee-Object -FilePath (Join-Path $artifact 'build.log')
 if($LASTEXITCODE -ne 0){throw 'Isolated baseline build failed; preserve log'}
 $timer.Stop()
 foreach($item in $hashes){if((Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash -ne $item.sha256){throw 'Frozen baseline source changed during build'}}
 $exe=Join-Path $artifact 'copy-creator.exe';Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/copy-creator.exe') -Destination $exe
 if((Get-Item -LiteralPath $exe).Length -lt $(if($Variant -eq 'R0'){70000000}else{40000000})){throw 'Unexpected missing embedded frontend resources'}
 @{identifier=$identifier;autostartIsolation='identifier';pasteIsolation='identifier';profile='release-default';variant=$Variant;generation=2;frontend=$frontend;bytes=(Get-Item -LiteralPath $exe).Length;sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash;buildSeconds=$timer.Elapsed.TotalSeconds;schemaMax=$(if($Variant -eq 'current'){5}else{0});scope=$(if($Variant -eq 'current'){'Current frozen native source; original five-font frozen frontend; default profile; all system paths isolated'}else{'Frozen R0 business source and original profile; only autostart naming and shared image write/cleanup directory isolated; R0/R1 differ only in frozen font collection'})}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $artifact 'build.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $artifact 'build.json')
}finally{Pop-Location}
