param(
  [Parameter(Mandatory=$true)][string]$Metadata,
  [ValidateSet('inspect','select','save','cancel')][string]$Action='inspect',
  [string]$FixturePath
)
$ErrorActionPreference='Stop'
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007'){throw 'Expected isolated QA identifier'}
$qaProcess=Get-Process -Id $info.pid
if($qaProcess.Path -ne $info.exe){throw 'QA process path mismatch'}
if((Get-FileHash -Algorithm SHA256 -LiteralPath $qaProcess.Path).Hash -ne $info.sha256){throw 'QA binary hash mismatch'}
if($Action -in @('select','save')){
  $scope=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization'))+[IO.Path]::DirectorySeparatorChar
  $resolved=[IO.Path]::GetFullPath($FixturePath)
  if(-not $resolved.StartsWith($scope,[StringComparison]::OrdinalIgnoreCase)){throw 'Selection must stay in synthetic optimization fixtures'}
  if($Action -eq 'select' -and -not (Test-Path -LiteralPath $resolved)){throw 'Fixture missing'}
  if($Action -eq 'save' -and ((Test-Path -LiteralPath $resolved) -or -not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($resolved))))){throw 'Expected a new backup in an existing fixture directory'}
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QaDialogWindows {
 public delegate bool EnumCallback(IntPtr hwnd,IntPtr param);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback,IntPtr param);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent,EnumCallback callback,IntPtr param);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,IntPtr wparam,string text,uint flags,uint timeout,out IntPtr result);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@
$handles=[System.Collections.Generic.List[IntPtr]]::new()
$qaPid=[uint32]$info.pid
for($attempt=0;$attempt -lt 50;$attempt++){
 $handles.Clear()
 [QaDialogWindows]::EnumWindows({param($hwnd,$param)
  $owner=0
  [QaDialogWindows]::GetWindowThreadProcessId($hwnd,[ref]$owner) | Out-Null
  if($owner -eq $qaPid -and [QaDialogWindows]::IsWindowVisible($hwnd)){
    $class=[Text.StringBuilder]::new(128)
    [QaDialogWindows]::GetClassName($hwnd,$class,128) | Out-Null
    if($class.ToString() -eq '#32770'){$handles.Add($hwnd)}
  }
  return $true
},[IntPtr]::Zero) | Out-Null
 if($handles.Count -gt 0){break}
 Start-Sleep -Milliseconds 100
}
if($handles.Count -ne 1){throw "Expected one owned QA dialog, found $($handles.Count)"}
if($Action -eq 'inspect'){
  # The acceptance gate needs the exact owned native dialog, not framework UIA.
  # Framework WPF assemblies cannot reliably load in the bundled .NET host.
  $native=[System.Collections.Generic.List[object]]::new()
  [QaDialogWindows]::EnumChildWindows($handles[0],{param($hwnd,$param)
    $class=[Text.StringBuilder]::new(128)
    [QaDialogWindows]::GetClassName($hwnd,$class,128) | Out-Null
    $native.Add([pscustomobject]@{class=$class.ToString();id=[QaDialogWindows]::GetDlgCtrlID($hwnd)})
    return $true
  },[IntPtr]::Zero) | Out-Null
  if(-not ($native | Where-Object {$_.class -eq 'Edit' -and $_.id -in @(1148,1001,1152)})){throw 'Owned dialog has no filename field'}
  if(-not ($native | Where-Object {$_.class -eq 'Button' -and $_.id -eq 2})){throw 'Owned dialog has no cancel action'}
  [pscustomobject]@{ownedDialog=$true;qaPid=$qaPid;native=$native;scope='Win32 HWND/PID/hash verified dialog and native controls; no UIA or contents'} | ConvertTo-Json -Depth 4
  exit
}
$fields=[System.Collections.Generic.List[IntPtr]]::new()
$buttons=[System.Collections.Generic.List[IntPtr]]::new()
$actionId=if($Action -eq 'cancel'){2}else{1}
[QaDialogWindows]::EnumChildWindows($handles[0],{param($hwnd,$param)
  $class=[Text.StringBuilder]::new(128)
  [QaDialogWindows]::GetClassName($hwnd,$class,128) | Out-Null
  $id=[QaDialogWindows]::GetDlgCtrlID($hwnd)
  if($id -in @(1148,1001,1152) -and $class.ToString() -eq 'Edit' -and [QaDialogWindows]::IsWindowVisible($hwnd)){$fields.Add($hwnd)}
  if($id -eq $actionId -and $class.ToString() -eq 'Button'){$buttons.Add($hwnd)}
  return $true
},[IntPtr]::Zero) | Out-Null
if($Action -in @('select','save')){
  if($fields.Count -ne 1){throw 'Expected one file-name field'}
  $result=[IntPtr]::Zero
  if([QaDialogWindows]::SendMessageTimeout($fields[0],0x000C,[IntPtr]::Zero,$resolved,2,3000,[ref]$result) -eq [IntPtr]::Zero){throw 'File-name field did not accept text'}
}
if($buttons.Count -ne 1){throw 'Expected one dialog action button'}
if(-not [QaDialogWindows]::PostMessage($buttons[0],0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Dialog action failed'}
[pscustomobject]@{action=$Action;qaPid=$qaPid;path=$resolved} | ConvertTo-Json
