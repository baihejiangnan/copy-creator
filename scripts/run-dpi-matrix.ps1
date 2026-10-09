# A live guarded QA session must already exist. Restore OS scaling in finally.
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
$session=Join-Path $root 'dpi-session'
$ready=Get-Content -LiteralPath (Join-Path $session 'ready.json') -Raw | ConvertFrom-Json
$info=Get-Content -LiteralPath (Join-Path $root 'process.json') -Raw | ConvertFrom-Json
if(-not $ready.ready -or $ready.app.pid -ne $info.pid -or $info.identifier -ne 'com.copycreator.qa20261007'){throw 'Expected live current default DPI session'}
$qa=Get-Process -Id $info.pid -ErrorAction Stop
if($qa.Path -ne $info.exe -or (Get-FileHash -LiteralPath $info.exe -Algorithm SHA256).Hash -ne $info.sha256){throw 'DPI QA process/hash mismatch'}
$systemShell=Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
function Display([string]$Action='inspect',[int]$Scale=0,[int]$Expected=0){
 $out=& $systemShell -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'qa-display-scale.ps1') -Action $Action -Scale $Scale -ExpectedCurrent $Expected -Restore
 if($LASTEXITCODE -ne 0){throw 'Display-scale helper failed'}
 $out | ConvertFrom-Json
}
$initial=Display 'expand'
if($initial.beforeScale -ne 125){throw 'Expected observed original Windows scale 125%; no scale was changed'}
$report=@{started=[DateTimeOffset]::UtcNow.ToString('o');qaPid=$info.pid;qaSha256=$info.sha256;driverReport=$ready.report;originalScale=125;offeredChoices=$initial.choices;variants=@();passed=$false;scope='Real OS scaling and QA native scale_factor/WebView DPR; no emulation. Full acceptance still requires 200%.'}
$destination=Join-Path $root ('reports/dpi-matrix-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+'.json')
$seq=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
function Send([hashtable]$Request){
 $script:seq++
 $Request.seq=$script:seq
 $temporary=Join-Path $session 'request.tmp'
 [IO.File]::WriteAllText($temporary,($Request|ConvertTo-Json -Compress))
 Move-Item -LiteralPath $temporary -Destination (Join-Path $session 'request.json') -Force
 $responsePath=Join-Path $session "response-$script:seq.json"
 for($attempt=0;$attempt -lt 400;$attempt++){
  if(Test-Path -LiteralPath $responsePath){
   try{$response=Get-Content -LiteralPath $responsePath -Raw|ConvertFrom-Json}catch{$response=$null}
   if($response){if(-not $response.ok){throw $response.error};return $response}
  }
  if(-not(Get-Process -Id $info.pid -ErrorAction SilentlyContinue)){throw 'QA stopped during DPI matrix'}
  Start-Sleep -Milliseconds 100
 }
 throw 'DPI response timeout'
}
try{
 foreach($percentage in @(125,100,150)){
  $current=(Display).beforeScale
  if($current -ne $percentage){$change=Display 'select' $percentage $current;if($change.afterScale -ne $percentage){throw 'OS scale was not confirmed'}}
  foreach($language in @('zh-CN','en')){foreach($theme in @('light','dark')){foreach($view in @('editor','list','context')){
   $response=Send @{command='variant';scale=($percentage/100);language=$language;theme=$theme;view=$view}
   $report.variants+=@{name=$response.name;nativeScale=$response.nativeScale;dpr=$response.dpr;screenshot=$response.screenshot;overflow=$response.overflow}
   $report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $destination -Encoding utf8
   @{variant=$response.name;nativeScale=$response.nativeScale;passed=$true}|ConvertTo-Json -Compress
  }}}
 }
 $report.partialMatrixPassed=$true
 if(-not($initial.choices|Where-Object {$_ -match '^200%'})){$report.unavailableScale=200;$report.limitation='200% is not offered by the current real Windows display scale control; no custom scaling/logoff or resolution change attempted'}
 else{throw '200% was offered; extend actual matrix before acceptance'}
}catch{$report.error=$_.Exception.Message;throw}
finally{
 try{
  $current=(Display).beforeScale
  if($current -ne 125){if($current -notin @(100,150)){throw 'Unexpected current OS scale; refusing to override unrelated change'};$restored=Display 'select' 125 $current;if($restored.afterScale -ne 125){throw 'Restore was not confirmed'}}
  $report.restoredOriginalScale=((Display).beforeScale -eq 125)
 }catch{$report.restoreError=$_.Exception.Message}
 if(Test-Path -LiteralPath (Join-Path $session 'ready.json')){try{Send @{command='abort';reason='Actual supported-scale matrix ended; 200% unavailable in this Windows display control'}|Out-Null}catch{$report.sessionEnd=$_.Exception.Message}}
 $report.finished=[DateTimeOffset]::UtcNow.ToString('o')
 $report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $destination -Encoding utf8
 @{report=$destination;variants=$report.variants.Count;partialMatrixPassed=[bool]$report.partialMatrixPassed;fullMatrixPassed=$false;originalScaleRestored=[bool]$report.restoredOriginalScale}|ConvertTo-Json -Compress
}
if($report.restoreError){throw $report.restoreError}
exit 2
