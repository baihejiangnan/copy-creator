# Control only the observed Windows Settings display-scale ComboBox.
param(
 [ValidateSet('inspect','expand','select')][string]$Action='inspect',
 [ValidateSet(0,100,125,150,200)][int]$Scale=0,
 [ValidateSet(0,100,125,150,200)][int]$ExpectedCurrent=0,
 [switch]$Restore
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$settings=@(Get-Process -Name SystemSettings -ErrorAction Stop)
if($settings.Count -ne 1 -or $settings[0].Path -ne (Join-Path $env:WINDIR 'ImmersiveControlPanel/SystemSettings.exe')){throw 'Expected one Windows Settings process'}
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class DisplaySettingsRestore {
 public delegate bool Callback(IntPtr hwnd,IntPtr param);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback,IntPtr param);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd,int command);
}
'@
$frames=[Collections.Generic.List[IntPtr]]::new()
$owned=[Collections.Generic.List[object]]::new()
$settingsCaption=[string]::Concat([char]0x8bbe,[char]0x7f6e)
[DisplaySettingsRestore]::EnumWindows({param($hwnd,$param)
 $title=[Text.StringBuilder]::new(256);$class=[Text.StringBuilder]::new(128)
 [DisplaySettingsRestore]::GetWindowText($hwnd,$title,256) | Out-Null
 [DisplaySettingsRestore]::GetClassName($hwnd,$class,128) | Out-Null
 $owner=[uint32]0;[DisplaySettingsRestore]::GetWindowThreadProcessId($hwnd,[ref]$owner) | Out-Null
 $matches=$title.ToString() -in @($settingsCaption,'Settings')
 if($owner -eq $settings[0].Id){$owned.Add(@{class=$class.ToString();titleIsSettings=$matches;handle=$hwnd.ToInt64()})}
 if($matches){
  $ownerProcess=Get-Process -Id $owner -ErrorAction Stop
  if($class.ToString() -eq 'ApplicationFrameWindow' -and $ownerProcess.Path -eq (Join-Path $env:WINDIR 'System32/ApplicationFrameHost.exe')){$frames.Add($hwnd)}
 }
 return $true
},[IntPtr]::Zero) | Out-Null
if($frames.Count -ne 1){@{owned=$owned;settingsFrames=$frames.Count}|ConvertTo-Json -Depth 4 -Compress;throw ('Expected one Settings application frame, found '+$frames.Count)}
$handle=$frames[0]
if($Restore){
 [DisplaySettingsRestore]::ShowWindowAsync($handle,9) | Out-Null
 Start-Sleep -Milliseconds 500
}
$window=[Windows.Automation.AutomationElement]::FromHandle($handle)
if(-not $window){throw 'Settings has no accessible window'}
$children=$window.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
$rootMetadata=@{automationId=$window.Current.AutomationId;class=$window.Current.ClassName;controlType=$window.Current.ControlType.ProgrammaticName;offscreen=$window.Current.IsOffscreen;children=$children.Count;processId=$window.Current.ProcessId;nativeHandle=$handle.ToInt64()}
$condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::ComboBox)
$combos=$window.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
$values=@()
$scaleControl=$null
foreach($item in $combos){
 $row=@{automationId=$item.Current.AutomationId;name=$item.Current.Name;offscreen=$item.Current.IsOffscreen;enabled=$item.Current.IsEnabled}
 if($item.Current.AutomationId -eq 'SystemSettings_Display_Scaling_ItemSizeOverride_ComboBox'){
  $scaleControl=$item
  $selection=$item.GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern)
  $row.selected=@($selection.Current.GetSelection() | ForEach-Object {$_.Current.Name})
 }
 $values+=$row
}
if(-not $scaleControl){throw 'Display scale control not found; open System > Display first'}
$before=@(($scaleControl.GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern)).Current.GetSelection() | ForEach-Object {$_.Current.Name})
if($before.Count -ne 1 -or $before[0] -notmatch '^(100|125|150|200)%'){throw 'Expected a supported current display scale'}
$beforeScale=[int]$Matches[1]
$choices=@()
if($Action -in @('expand','select')){
 if($Action -eq 'select' -and ($Scale -eq 0 -or $ExpectedCurrent -eq 0 -or $beforeScale -ne $ExpectedCurrent)){throw 'Scale change requires exact expected current percentage'}
 ($scaleControl.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand()
 Start-Sleep -Milliseconds 200
 $items=$scaleControl.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::ListItem))
 $choices=@($items | ForEach-Object {$_.Current.Name} | Where-Object {$_ -match '^\d+%'})
 if($Action -eq 'select'){
  $target=@($items | Where-Object {$_.Current.Name -match ('^'+$Scale+'%(?:\s|$)')})
  if($target.Count -ne 1){throw 'Expected exactly one matching scale choice'}
  ($target[0].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)).Select()
  $afterScale=0
  for($attempt=0;$attempt -lt 40;$attempt++){
   Start-Sleep -Milliseconds 100
   $window=[Windows.Automation.AutomationElement]::FromHandle($handle)
   $scaleControl=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,'SystemSettings_Display_Scaling_ItemSizeOverride_ComboBox'))
   $selected=@(($scaleControl.GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern)).Current.GetSelection() | ForEach-Object {$_.Current.Name})
   if($selected.Count -eq 1 -and $selected[0] -match ('^'+$Scale+'%')){$afterScale=$Scale;break}
  }
  if($afterScale -ne $Scale){throw 'Requested scale was not confirmed by the real Settings control'}
 }
}
@{settingsPid=$settings[0].Id;root=$rootMetadata;comboBoxes=$values;restoredWindow=[bool]$Restore;action=$Action;beforeScale=$beforeScale;afterScale=$afterScale;choices=$choices;scope='Only display scale in verified Windows Settings; no account or unrelated setting values; actual OS scaling, no DPR emulation'} | ConvertTo-Json -Depth 5 -Compress
