param([Parameter(Mandatory=$true)][string]$Metadata)
$ErrorActionPreference='Stop'
$qaRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
if([IO.Path]::GetFullPath($Metadata) -ne (Join-Path $qaRoot 'process.json')){throw 'Expected exact isolated QA metadata'}
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007' -or $info.autostartIsolation -ne 'identifier' -or [IO.Path]::GetFullPath($info.exe) -ne (Join-Path $qaRoot 'copy-creator-qa.exe')){throw 'Expected identifier-isolated QA'}
if((Get-FileHash -LiteralPath $info.exe -Algorithm SHA256).Hash -ne $info.sha256){throw 'QA hash mismatch'}
$receipt=Get-Content -LiteralPath (Join-Path $qaRoot 'reports/autostart-restoration.json') -Raw | ConvertFrom-Json
$production=Get-Process -Id $receipt.productionPid -ErrorAction Stop
if($production.Path.StartsWith($qaRoot,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $production.Path).VersionInfo.ProductName -ne 'Copy Creator'){throw 'Expected previously verified running production executable'}
$run=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run',$false)
if(!$run){throw 'Run key absent'}
try{
 $original=$run.GetValue('Copy Creator',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
 if($original -cne ($production.Path+' --hidden')){throw 'Production Run value differs from verified restoration; no mutation attempted'}
 $qaName='Copy Creator ('+$info.identifier+')'
 if($run.GetValueNames() -contains $qaName){throw 'QA Run value already exists; do not overwrite'}
 @{ready=$true;productionMatchesRestoration=$true;qaEntryInitiallyAbsent=$true} | ConvertTo-Json -Compress
 while($null -ne ($command=[Console]::ReadLine())){
  if($run.GetValue('Copy Creator',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $original){throw 'Production autostart changed during QA'}
  $qaValue=$run.GetValue($qaName,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if($command -eq 'enabled'){
   if($qaValue -cne ($info.exe+' --hidden')){throw 'QA enable did not write the exact owned executable and hidden argument'}
  }elseif($command -eq 'disabled'){
   if($null -ne $qaValue){throw 'QA disable left its Run value behind'}
  }else{throw 'Unsupported guard command'}
  @{productionUnchanged=$true;qaState=$command} | ConvertTo-Json -Compress
 }
}finally{$run.Dispose()}
