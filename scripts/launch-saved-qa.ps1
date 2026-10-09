param([Parameter(Mandatory=$true)][string]$Metadata,[switch]$WaitForScriptDebugger)
$ErrorActionPreference='Stop'
$qaRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
if([IO.Path]::GetFullPath($Metadata) -ne (Join-Path $qaRoot 'process.json')){throw 'Expected exact QA metadata'}
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007' -or [IO.Path]::GetFullPath($info.exe) -ne (Join-Path $qaRoot 'copy-creator-qa.exe')){throw 'Expected isolated QA identifier and executable'}
if($info.pasteIsolation -ne 'identifier'){throw 'Refusing QA artifact with shared production paste-image temporary cleanup; select an isolated rebuild'}
if($info.autostartIsolation -ne 'identifier'){throw 'Refusing legacy QA artifact that shares the production autostart entry; select an isolated rebuild'}
if((Get-FileHash -LiteralPath $info.exe -Algorithm SHA256).Hash -ne $info.sha256){throw 'QA binary hash mismatch'}
& (Join-Path $PSScriptRoot 'qa-process-isolation.ps1')
$previous=Get-Process -Id $info.pid -ErrorAction SilentlyContinue
if($previous -and $previous.Path -eq $info.exe){throw 'QA already running'}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$($info.debugPort)"
$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $qaRoot 'webview-profile-release-min-window'
if($WaitForScriptDebugger){
 if($info.nativeArtifact -notin @('native-release-notes-scrollbars','native-release-image-idle','native-release-paste-settle','native-release-paste-feedback') -or $info.profile -ne 'release-default'){throw 'Initial readiness check requires a known current default QA build'}
 $env:WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER='true'
 $env:WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER='QA_'+[guid]::NewGuid().ToString('N')
 $pipePath='WebView2\Debugger\copy-creator-qa.exe\'+$env:WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER
 # Microsoft WebView2 multi-view debugger handshake; scoped to this EXE.
 $debugPipes=@(1..2 | ForEach-Object {
  $stream=[IO.Pipes.NamedPipeServerStream]::new($pipePath,[IO.Pipes.PipeDirection]::InOut,2,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous)
  @{stream=$stream;connection=$stream.WaitForConnectionAsync();buffer=[byte[]]::new(65536);read=$null;recorded=$false}
 })
}else{
 Remove-Item -LiteralPath Env:WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER -ErrorAction SilentlyContinue
 Remove-Item -LiteralPath Env:WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER -ErrorAction SilentlyContinue
 $debugPipes=@()
}
$run='controlled-'+[guid]::NewGuid().ToString()
$qaProcess=Start-Process -FilePath $info.exe -WorkingDirectory $qaRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $qaRoot "$run.stdout.log") -RedirectStandardError (Join-Path $qaRoot "$run.stderr.log") -PassThru
$info.pid=$qaProcess.Id
$info | Add-Member -MemberType NoteProperty -Name launchStartedUnixMs -Value ([DateTimeOffset]::new($qaProcess.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()) -Force
$info | Add-Member -MemberType NoteProperty -Name debuggerPausedLaunch -Value ([bool]$WaitForScriptDebugger) -Force
$info | ConvertTo-Json | Set-Content -LiteralPath $Metadata -Encoding utf8
try {
 $pipeMessages=@()
 for($attempt=0;$attempt -lt 100;$attempt++){
  foreach($entry in $debugPipes){
   if($entry.connection.IsCompleted -and -not $entry.read){$entry.connection.GetAwaiter().GetResult();$entry.read=$entry.stream.ReadAsync($entry.buffer,0,$entry.buffer.Length)}
   if($entry.read -and $entry.read.IsCompleted -and -not $entry.recorded){
    $length=$entry.read.GetAwaiter().GetResult()
    if($length -le 0){throw 'Debugger named pipe returned no target'}
    $target=[Text.Encoding]::UTF8.GetString($entry.buffer,0,$length) | ConvertFrom-Json
    $pipeMessages+=@{id=$target.id;type=$target.type;url=$target.url}
    $entry.recorded=$true
   }
  }
  try {
   $targets=Invoke-RestMethod -Uri "http://127.0.0.1:$($info.debugPort)/json/list" -TimeoutSec 1
   if(($targets | Where-Object {$_.url -eq 'http://tauri.localhost/'}) -and (-not $WaitForScriptDebugger -or $pipeMessages.Count -eq 2)){
    $info | Add-Member -MemberType NoteProperty -Name debuggerPipeTargets -Value $pipeMessages -Force
    $info | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Metadata -Encoding utf8
    $info | ConvertTo-Json -Depth 5
    exit
   }
  }catch {if($qaProcess.HasExited){throw 'QA exited before main WebView ready'}}
  Start-Sleep -Milliseconds 100
 }
 throw 'Main QA WebView readiness timeout'
}finally{
 foreach($entry in $debugPipes){$entry.stream.Dispose()}
}
