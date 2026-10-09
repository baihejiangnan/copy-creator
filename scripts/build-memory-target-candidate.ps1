# Frozen QA experiment only; no changes to application source or selected EXE.
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $repo 'output/optimization/QA-notes-20261007'
$artifact=Join-Path $root 'native-release-memory-target-candidate'
if(Test-Path -LiteralPath $artifact){throw 'Refusing to overwrite preserved candidate'}
$original=Join-Path $root 'native-release-backup-metrics/source'
New-Item -ItemType Directory -Path $artifact | Out-Null
Copy-Item -LiteralPath $original -Destination (Join-Path $artifact 'source') -Recurse
$work=Join-Path $artifact 'source'
$entry=Join-Path $work 'src-tauri/src/lib.rs'
$source=[IO.File]::ReadAllText($entry)
if(-not $source.Contains('.invoke_handler(tauri::generate_handler![')){throw 'Expected frozen command registration'}
$source="mod qa_memory_target;`r`n"+$source.Replace('.invoke_handler(tauri::generate_handler![','.invoke_handler(tauri::generate_handler![qa_memory_target::qa_memory_target,')
[IO.File]::WriteAllText($entry,$source)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'qa-memory-target.rs') -Destination (Join-Path $work 'src-tauri/src/qa_memory_target.rs')
Add-Content -LiteralPath (Join-Path $work 'src-tauri/Cargo.toml') -Value "`r`n[target.'cfg(windows)'.dependencies]`r`nwebview2-com = `"=0.38.2`"`r`nwindows-core-for-webview = { package = `"windows-core`", version = `"=0.61.2`" }" -Encoding utf8
# Tauri CLI normalizes this manifest to LF; freeze that representation up front.
$manifest=Join-Path $work 'src-tauri/Cargo.toml'
[IO.File]::WriteAllText($manifest,[IO.File]::ReadAllText($manifest).Replace("`r`n","`n"))
$env:PATH="$HOME/.cargo/bin;C:/Users/ABD18/dev/nodejs;"+$env:PATH
$env:CARGO_TARGET_DIR=Join-Path $repo 'copy-creator/src-tauri/target'
foreach($name in @('CARGO_PROFILE_RELEASE_LTO','CARGO_PROFILE_RELEASE_CODEGEN_UNITS','CARGO_PROFILE_RELEASE_STRIP','CARGO_PROFILE_RELEASE_OPT_LEVEL')){Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue}
Push-Location $work
try {
 # Update only this frozen candidate lockfile, offline; existing exact transitive versions.
 & cargo metadata --offline --format-version 1 --no-deps --manifest-path src-tauri/Cargo.toml | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Candidate metadata failed'}
 & cargo check --offline --manifest-path src-tauri/Cargo.toml 2>&1 | Tee-Object -FilePath (Join-Path $artifact 'check.log')
 if($LASTEXITCODE -ne 0){throw 'Candidate check failed'}
 $hashes=@(& rg --files src src-tauri package.json pnpm-lock.yaml vite.config.ts index.html radial.html | ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash}})
 $hashes|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $artifact 'source-hashes.json') -Encoding utf8
 $config=Join-Path $artifact 'tauri-qa.json'
 $frontend=Join-Path $root 'frontend-clipboard-errors'
 @{identifier='com.copycreator.qa20261007';build=@{frontendDist=[IO.Path]::GetRelativePath((Join-Path $work 'src-tauri'),$frontend);beforeBuildCommand=''}}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $config -Encoding utf8
 $timer=[Diagnostics.Stopwatch]::StartNew()
 & C:/Users/ABD18/dev/nodejs/node.exe (Join-Path $repo 'copy-creator/node_modules/@tauri-apps/cli/tauri.js') build --no-bundle --ci --config $config -- --locked --offline 2>&1|Tee-Object -FilePath (Join-Path $artifact 'build.log')
 if($LASTEXITCODE -ne 0){throw 'Candidate build failed'}
 foreach($item in $hashes){if((Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash -ne $item.sha256){throw 'Frozen candidate changed during build'}}
 $exe=Join-Path $artifact 'copy-creator.exe';Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/copy-creator.exe') -Destination $exe
 @{identifier='com.copycreator.qa20261007';autostartIsolation='identifier';pasteIsolation='identifier';profile='release-default';synchronous='FULL';frontend='frontend-clipboard-errors';experimental='MemoryUsageTargetLevel only; explicit command; never TrySuspend or JS suspension';bytes=(Get-Item -LiteralPath $exe).Length;sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash;buildSeconds=$timer.Elapsed.TotalSeconds}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $artifact 'build.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $artifact 'build.json')
}finally{Pop-Location}
