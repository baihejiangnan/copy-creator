param([Parameter(Mandatory=$true)][string]$Metadata)
$ErrorActionPreference='Stop'
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007'){throw 'Expected isolated QA identifier'}
$process=Get-Process -Id $info.pid
if($process.Path -ne $info.exe){throw 'QA process path mismatch'}
if((Get-FileHash -Algorithm SHA256 -LiteralPath $process.Path).Hash -ne $info.sha256){throw 'QA binary hash mismatch'}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QaWindowRestore {
 public delegate bool EnumCallback(IntPtr hwnd,IntPtr param);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback,IntPtr param);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd,int command);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
}
'@
$qaPid=[uint32]$info.pid
$results=[System.Collections.Generic.List[object]]::new()
[QaWindowRestore]::EnumWindows({param($hwnd,$param)
  $owner=0
  [QaWindowRestore]::GetWindowThreadProcessId($hwnd,[ref]$owner) | Out-Null
  if($owner -eq $qaPid){
    $title=[System.Text.StringBuilder]::new(256)
    [QaWindowRestore]::GetWindowText($hwnd,$title,256) | Out-Null
    if($title.ToString() -eq 'Copy Creator'){
      $before=[QaWindowRestore]::IsIconic($hwnd)
      [QaWindowRestore]::ShowWindowAsync($hwnd,9) | Out-Null
      $results.Add([pscustomobject]@{title='Copy Creator';minimizedBefore=$before;action='restore'})
    } elseif($title.Length -eq 0){
      [QaWindowRestore]::ShowWindowAsync($hwnd,0) | Out-Null
    }
  }
  return $true
},[IntPtr]::Zero) | Out-Null
if($results.Count -ne 1){throw 'Expected exactly one QA main window'}
$results | ConvertTo-Json
