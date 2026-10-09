param([Parameter(Mandatory=$true)][ValidateSet('R0','R1','current')][string]$Variant)
throw 'Retired: shared paste-image cleanup. Use build-runtime-baseline-isolated.ps1; never replay legacy artifacts.'
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $repo 'output/optimization/baseline-runtime-20261008'
$work=Join-Path $root $(if($Variant -eq 'current'){'work-current/copy-creator'}else{'work/copy-creator'})
$frozen=Join-Path $repo 'output/optimization/R0-20261007/source/copy-creator'
$artifact=Join-Path $root "$Variant-embedded"
if(Test-Path -LiteralPath $artifact){throw 'Refusing to replace runtime baseline artifact'}
New-Item -ItemType Directory -Path $artifact -Force | Out-Null
if(-not(Test-Path -LiteralPath $work)){
 New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($work)) -Force | Out-Null
 if($Variant -eq 'current'){
  Push-Location (Join-Path $repo 'copy-creator')
  try {foreach($file in @(& rg --files src src-tauri package.json pnpm-lock.yaml vite.config.ts index.html radial.html)){$destination=Join-Path $work $file;New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null;Copy-Item -LiteralPath $file -Destination $destination}} finally {Pop-Location}
 }else{
 Copy-Item -LiteralPath $frozen -Destination $work -Recurse
 $entry=Join-Path $work 'src-tauri/src/lib.rs'
 $source=Get-Content -LiteralPath $entry -Raw
 $old=".plugin(tauri_plugin_autostart::init(`r`n            tauri_plugin_autostart::MacosLauncher::LaunchAgent,`r`n            Some(vec![`"--hidden`"]),`r`n        ))"
 if(-not $source.Contains($old)){throw 'Frozen autostart source differs from reviewed baseline'}
 $replacement=".plugin(tauri_plugin_autostart::Builder::new().app_name(`"Copy Creator (com.copycreator.qabaseline20261008)`").arg(`"--hidden`" ).build())"
 [IO.File]::WriteAllText($entry,$source.Replace($old,$replacement),[Text.UTF8Encoding]::new($false))
 & git diff --no-index -- (Join-Path $frozen 'src-tauri/src/lib.rs') $entry | Set-Content -LiteralPath (Join-Path $root 'isolation-only.patch') -Encoding utf8
 if($LASTEXITCODE -gt 1){throw 'Cannot record isolation patch'}
 }
}
$entry=Get-Content -LiteralPath (Join-Path $work 'src-tauri/src/lib.rs') -Raw
if($Variant -eq 'current'){if(-not $entry.Contains('.app_name(autostart_name)') -or -not $entry.Contains('fn autostart_entry_name(')){throw 'Current runtime baseline requires identifier-isolated autostart'}}
elseif(-not $entry.Contains('.app_name("Copy Creator (com.copycreator.qabaseline20261008)")')){throw 'Runtime baseline requires isolated autostart name'}
$relativeFrontend=if($Variant -eq 'R0'){'R0-20261007/frontend'}elseif($Variant -eq 'R1'){'R1-fonts-20261007/frontend'}else{'QA-notes-20261007/frontend-clipboard-content'}
$frontend=Join-Path $repo "output/optimization/$relativeFrontend"
if(-not(Test-Path -LiteralPath (Join-Path $frontend 'index.html'))){throw 'Missing immutable baseline frontend'}
$config=Join-Path $artifact 'qa-config.json'
$relativeDist=[IO.Path]::GetRelativePath((Join-Path $work 'src-tauri'),$frontend)
@{identifier='com.copycreator.qabaseline20261008';build=@{frontendDist=$relativeDist;beforeBuildCommand=''}} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $config -Encoding utf8
$env:PATH="$HOME/.cargo/bin;C:/Users/ABD18/dev/nodejs;"+$env:PATH
# Reuse dependency cache only; immutable baseline EXEs are stored separately.
$env:CARGO_TARGET_DIR=Join-Path $repo 'copy-creator/src-tauri/target'
foreach($name in @('CARGO_PROFILE_RELEASE_LTO','CARGO_PROFILE_RELEASE_CODEGEN_UNITS','CARGO_PROFILE_RELEASE_STRIP','CARGO_PROFILE_RELEASE_OPT_LEVEL')){Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue}
Push-Location $work
try {
 $hashes=@(& rg --files src src-tauri package.json pnpm-lock.yaml vite.config.ts index.html | ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash}})
 $hashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $artifact 'source-hashes.json') -Encoding utf8
 $timer=[Diagnostics.Stopwatch]::StartNew()
 & C:/Users/ABD18/dev/nodejs/node.exe (Join-Path $repo 'copy-creator/node_modules/@tauri-apps/cli/tauri.js') build --no-bundle --ci --config $config -- --locked --offline 2>&1 | Tee-Object -FilePath (Join-Path $artifact 'build.log')
 if($LASTEXITCODE -ne 0){throw 'Isolated runtime baseline build failed; preserve log'}
 $timer.Stop()
 foreach($item in $hashes){if((Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash -ne $item.sha256){throw 'Runtime baseline sources changed during build'}}
 $exe=Join-Path $artifact 'copy-creator.exe'
 Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/copy-creator.exe') -Destination $exe
 $minimumBytes=if($Variant -eq 'R0'){70000000}else{40000000}
 if((Get-Item -LiteralPath $exe).Length -lt $minimumBytes){throw 'Unexpected missing embedded frontend resources; do not launch this sample'}
 $scope=if($Variant -eq 'current'){'Frozen current native source and current frontend with default Release profile. Config isolates application/data identity; native autostart name follows that identifier. Runtime acceptance sample, not original shipping size.'}else{'Frozen R0 native business code and original Release profile. Sole native patch isolates autostart app_name; config isolates application/data identity. R0/R1 differ only by frozen frontend font collection. Runtime acceptance sample, not original shipping size.'}
 @{identifier='com.copycreator.qabaseline20261008';autostartIsolation='identifier';variant=$Variant;frontend=$frontend;bytes=(Get-Item -LiteralPath $exe).Length;sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash;buildSeconds=$timer.Elapsed.TotalSeconds;scope=$scope} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifact 'build.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $artifact 'build.json')
} finally {Pop-Location}
