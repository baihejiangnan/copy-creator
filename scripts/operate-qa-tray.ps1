param(
 [Parameter(Mandatory=$true)][string]$Metadata,
 [ValidateSet('quit','copy','paste')][string]$Action='quit',
 [string]$RecordPreview,
 [switch]$CloseMenuBeforeReady
)
$ErrorActionPreference='Stop'
if($Action -ne 'quit' -and (-not $RecordPreview.StartsWith('QA controlled clipboard ') -or $RecordPreview.Length -gt 36)){throw 'Only exact synthetic record previews allowed'}
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007'){throw 'Expected isolated QA identifier'}
$qaProcess=Get-Process -Id $info.pid
if($qaProcess.Path -ne $info.exe -or (Get-FileHash -LiteralPath $qaProcess.Path -Algorithm SHA256).Hash -ne $info.sha256){throw 'QA identity mismatch'}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QaTray {
 public delegate bool EnumCallback(IntPtr hwnd,IntPtr param);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback,IntPtr param);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
 [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
 [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu,int position);
 [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu,int position);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu,uint position,StringBuilder text,int max,uint flags);
}
'@
function Find-OwnedClass([string]$ExpectedClass){
 $found=[System.Collections.Generic.List[IntPtr]]::new()
 [QaTray]::EnumWindows({param($hwnd,$param)
   $owner=0;[QaTray]::GetWindowThreadProcessId($hwnd,[ref]$owner)|Out-Null
   if($owner -eq $info.pid){$name=[Text.StringBuilder]::new(128);[QaTray]::GetClassName($hwnd,$name,128)|Out-Null;if($name.ToString() -eq $ExpectedClass){$found.Add($hwnd)}}
   return $true
 },[IntPtr]::Zero)|Out-Null
 if($found.Count -ne 1){throw "Expected one owned $ExpectedClass, found $($found.Count)"}
 return $found[0]
}
$tray=Find-OwnedClass 'tray_icon_app'
# Exact callback from the locked tray-icon 0.23.1 Windows implementation.
[QaTray]::PostMessage($tray,6002,[IntPtr]::Zero,[IntPtr]0x205)|Out-Null
$popup=[IntPtr]::Zero
for($attempt=0;$attempt -lt 30;$attempt++){
 try{$popup=Find-OwnedClass '#32768';break}catch{Start-Sleep -Milliseconds 50}
}
if($popup -eq [IntPtr]::Zero){throw 'Owned tray menu did not open'}
$menu=[QaTray]::SendMessage($popup,0x1E1,[IntPtr]::Zero,[IntPtr]::Zero)
$commandId=$null
for($position=0;$position -lt [QaTray]::GetMenuItemCount($menu);$position++){
 $label=[Text.StringBuilder]::new(128);[QaTray]::GetMenuString($menu,$position,$label,128,0x400)|Out-Null
 $plain=$label.ToString().Replace('&','')
 if($Action -eq 'quit' -and $plain -in @('退出','Quit')){$commandId=[QaTray]::GetMenuItemID($menu,$position)}
 elseif($Action -ne 'quit' -and $plain -ceq $RecordPreview){
  $submenu=[QaTray]::GetSubMenu($menu,$position)
  if($submenu -eq [IntPtr]::Zero){throw 'Synthetic record submenu missing'}
  for($child=0;$child -lt [QaTray]::GetMenuItemCount($submenu);$child++){
   $childLabel=[Text.StringBuilder]::new(128);[QaTray]::GetMenuString($submenu,$child,$childLabel,128,0x400)|Out-Null
   $allowed=if($Action -eq 'copy'){@('复制','Copy')}else{@('粘贴','Paste')}
   if($childLabel.ToString().Replace('&','') -in $allowed){if($null -ne $commandId){throw 'Ambiguous native command'};$commandId=[QaTray]::GetMenuItemID($submenu,$child)}
  }
 }
}
if($null -eq $commandId -or $commandId -eq [uint32]::MaxValue){throw 'Expected command missing from owned tray menu'}
if($CloseMenuBeforeReady){[QaTray]::PostMessage($tray,0x1F,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null}
@{ready=$true;pid=$info.pid;command=$Action;nativeMenu=$true}|ConvertTo-Json -Compress
# Warm helper permits selecting immediately after a dirty editor mutation.
if([Console]::ReadLine() -ne $Action){throw 'Expected explicit synthetic tray action'}
[QaTray]::PostMessage($tray,0x1F,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
# Muda's real WM_COMMAND handler dispatches this exact menu item to on_menu_event.
if(-not [QaTray]::PostMessage($tray,0x111,[IntPtr]$commandId,[IntPtr]::Zero)){throw 'Native command dispatch failed'}
@{dispatched=$true}|ConvertTo-Json -Compress
