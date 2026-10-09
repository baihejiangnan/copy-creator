param([Parameter(Mandatory=$true)][string]$SourceDatabase)
$ErrorActionPreference='Stop'
# This historical experiment is already integrated into schema 5. Its frozen
# binary shares the old paste cleanup directory; do not clone or replay it.
throw 'Retired search QA launcher: shared paste-image cleanup is unsafe; use a frozen identifier-isolated default build and guarded launcher'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qaRoot=Join-Path $repo 'output/optimization/QA-notes-20261007'
$experiment=Join-Path $qaRoot 'search-runtime-qa'
$meta=Get-Content -LiteralPath (Join-Path $experiment 'experiment.json') -Raw | ConvertFrom-Json
if($meta.identifier -ne 'com.copycreator.qa20261007search'){throw 'Expected dedicated experimental QA identity'}
$sourcePath=[IO.Path]::GetFullPath($SourceDatabase)
if(-not $sourcePath.StartsWith($qaRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Only project-local synthetic QA sources may be cloned'}
$database=Join-Path $meta.storageRoot 'data.db'
if(Test-Path -LiteralPath $database){throw 'Refusing to overwrite any experimental database'}
$env:QA_SEARCH_SOURCE=$sourcePath
$env:QA_SEARCH_DATABASE=$database
& C:/Users/ABD18/AppData/Local/Programs/Python/Python311/python.exe -c 'import os,sqlite3; source=sqlite3.connect("file:"+os.environ["QA_SEARCH_SOURCE"]+"?mode=ro",uri=True); target=sqlite3.connect(os.environ["QA_SEARCH_DATABASE"]); source.backup(target); target.execute("DELETE FROM settings WHERE key IN (''storage_path'',''shortcut_key'')"); target.commit(); print({"schema":target.execute("PRAGMA user_version").fetchone()[0],"notes":target.execute("SELECT count(*) FROM notes").fetchone()[0]}); target.close(); source.close()'
if($LASTEXITCODE -ne 0){throw 'Synthetic clone failed'}
$source=Join-Path $repo 'copy-creator/src-tauri/target/release/copy-creator.exe'
$exe=Join-Path $experiment 'copy-creator-search-qa.exe'
Copy-Item -LiteralPath $source -Destination $exe
$hashes=Get-Content -LiteralPath (Join-Path $experiment 'source-hashes.json') -Raw | ConvertFrom-Json
foreach($entry in $hashes){if((Get-FileHash -LiteralPath (Join-Path $experiment "source/$($entry.path)") -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw 'Experimental source changed during build'}}
$sha=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
@{identifier=$meta.identifier;bytes=(Get-Item -LiteralPath $exe).Length;sha256=$sha;frontend='frontend-native-visibility';profile='release-default';synchronous='FULL';scope=$meta.scope} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $experiment 'build.json') -Encoding utf8
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$($meta.debugPort)"
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $experiment 'webview-profile'
$timer=[Diagnostics.Stopwatch]::StartNew()
$qaProcess=Start-Process -FilePath $exe -WorkingDirectory $experiment -WindowStyle Hidden -RedirectStandardOutput (Join-Path $experiment 'stdout.log') -RedirectStandardError (Join-Path $experiment 'stderr.log') -PassThru
$ready=$false
for($attempt=0;$attempt -lt 150;$attempt++){
 try {$null=Invoke-RestMethod -Uri "http://127.0.0.1:$($meta.debugPort)/json/version" -TimeoutSec 1;$ready=$true;break}
 catch {if($qaProcess.HasExited){throw 'Experimental QA exited before WebView ready'};Start-Sleep -Milliseconds 200}
}
if(-not $ready){throw 'Experimental WebView readiness timed out'}
$timer.Stop()
$info=@{pid=$qaProcess.Id;identifier=$meta.identifier;exe=$exe;sha256=$sha;debugPort=$meta.debugPort;storageRoot=$meta.storageRoot;frontend='frontend-native-visibility';nativeArtifact='search-runtime-qa';profile='release-default';synchronous='FULL';firstWebViewReadyMs=$timer.Elapsed.TotalMilliseconds;scope=$meta.scope}
$info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $experiment 'process.json') -Encoding utf8
$info | ConvertTo-Json
