param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
$scope=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007/terminal-fixtures'))+[IO.Path]::DirectorySeparatorChar
$directoryPath=[IO.Path]::GetFullPath($Directory)
if(-not $directoryPath.StartsWith($scope,[StringComparison]::OrdinalIgnoreCase)){throw 'Expected synthetic terminal fixture directory'}
$token=Split-Path $directoryPath -Leaf
if($token -notmatch '^[a-f0-9-]{36}$'){throw 'Expected unique terminal fixture token'}
trap { $_ | Out-String | Set-Content -LiteralPath (Join-Path $directoryPath 'receiver-error.log') -Encoding utf8; exit 1 }
[Console]::Title='CopyCreator terminal QA '+$token
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QaTerminalReader {
 [StructLayout(LayoutKind.Explicit, Size=20, CharSet=CharSet.Unicode)] public struct Record {
  [FieldOffset(0)] public ushort type;
  [FieldOffset(4)] public int down;
  [FieldOffset(8)] public ushort repeat;
  [FieldOffset(10)] public ushort key;
  [FieldOffset(12)] public ushort scan;
  [FieldOffset(14)] public char character;
  [FieldOffset(16)] public uint control;
 }
 [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int handle);
 [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr input,out uint mode);
 [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr input,uint mode);
 [DllImport("kernel32.dll")] public static extern bool GetNumberOfConsoleInputEvents(IntPtr input,out uint count);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern bool ReadConsoleInputW(IntPtr input,out Record record,uint length,out uint read);
}
'@
$inputHandle=[QaTerminalReader]::GetStdHandle(-10)
$originalMode=[uint32]0
if(-not [QaTerminalReader]::GetConsoleMode($inputHandle,[ref]$originalMode)){throw 'Expected owned native console input'}
if(-not [QaTerminalReader]::SetConsoleMode($inputHandle,($originalMode -band 0xfffffff9))){throw 'Console mode change failed'}
$events=[Collections.Generic.List[object]]::new()
$generation=0
try{
 @{pid=$PID;token=$token;version=$PSVersionTable.PSVersion.ToString();ready=$true} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $directoryPath 'ready.json') -Encoding utf8
 Write-Host 'Synthetic input receiver. Input is recorded, never evaluated as commands.'
 $deadline=[DateTime]::UtcNow.AddMinutes(5)
 while([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $directoryPath 'stop'))){
  $resetPath=Join-Path $directoryPath 'reset'
  if(Test-Path -LiteralPath $resetPath){$next=[int](Get-Content -LiteralPath $resetPath -Raw);if($next -ne $generation){$generation=$next;$events.Clear()}}
  $count=[uint32]0
  if(-not [QaTerminalReader]::GetNumberOfConsoleInputEvents($inputHandle,[ref]$count)){throw 'Console input count failed'}
  for($i=0;$i -lt [Math]::Min($count,1000);$i++){
   $record=[QaTerminalReader+Record]::new();$read=[uint32]0
   if(-not [QaTerminalReader]::ReadConsoleInputW($inputHandle,[ref]$record,1,[ref]$read)){throw 'Console input read failed'}
   if($record.type -eq 1 -and $record.down -ne 0){$events.Add(@{key=[int]$record.key;scan=[int]$record.scan;character=[int]$record.character;control=[int]$record.control;repeat=[int]$record.repeat})}
  }
  $text=-join @($events | Where-Object character -GE 32 | ForEach-Object {([string][char]$_.character)*$_.repeat})
  @{generation=$generation;text=$text;events=@($events.ToArray());receiverPid=$PID} | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath (Join-Path $directoryPath 'input.json') -Encoding utf8
  Start-Sleep -Milliseconds 25
 }
}finally{[QaTerminalReader]::SetConsoleMode($inputHandle,$originalMode) | Out-Null}
