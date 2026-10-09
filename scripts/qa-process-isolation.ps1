# Read-only admission check. Metadata describes a selected artifact; it cannot
# prove that a different/older QA instance has actually stopped.
$ErrorActionPreference='Stop'
$script:qaProcessRoots=@(
 [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007')),
 [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/baseline-runtime-20261008'))
)
function Get-LimitedProcessImage {
 param([uint32]$ProcessId)
 if(-not ('QaProcessImageQuery' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QaProcessImageQuery {
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint length);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
 public static string Read(uint pid){var handle=OpenProcess(0x1000,false,pid);if(handle==IntPtr.Zero)return null;try{uint length=32768;var path=new StringBuilder((int)length);return QueryFullProcessImageName(handle,0,path,ref length)?path.ToString():null;}finally{CloseHandle(handle);}}
}
'@
 }
 [QaProcessImageQuery]::Read($ProcessId)
}
function Find-OwnedQaProcesses {
 param([Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$Inventory,
       [scriptblock]$ResolveImagePath={param($ProcessId) Get-LimitedProcessImage -ProcessId $ProcessId})
 foreach($process in $Inventory){
  $imagePath=$process.ExecutablePath
  # WMI can omit an elevated process image even though limited native querying
  # can verify it. Never silently exclude a possible elevated QA successor.
  if(-not $imagePath -and $process.Name -match '^copy[-_]creator.*\.exe$'){
   $imagePath=& $ResolveImagePath ([uint32]$process.ProcessId)
   if(-not $imagePath){throw 'Refusing QA launch: cannot verify a possible elevated Copy Creator process'}
  }
  if(-not $imagePath){continue}
  $path=[IO.Path]::GetFullPath($imagePath)
  foreach($root in $script:qaProcessRoots){
   if($path.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
    [pscustomobject]@{pid=[int]$process.ProcessId;path=$path}
    break
   }
  }
 }
}
function Assert-OwnedQaStopped {
 param([Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$Inventory)
 $live=@(Find-OwnedQaProcesses -Inventory $Inventory)
 if($live.Count){throw ('Refusing QA launch: live owned QA process inventory is not empty; PIDs='+($live.pid -join ','))}
}
if($MyInvocation.InvocationName -ne '.'){
 $inventory=@(Get-CimInstance Win32_Process -ErrorAction Stop)
 Assert-OwnedQaStopped -Inventory $inventory
 @{ownedQaNativeProcesses=0;scope='Live executable-path inventory, includes retired search/profile/baseline instances; no process stopped'} | ConvertTo-Json -Compress
}
