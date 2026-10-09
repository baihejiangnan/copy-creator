# Read-only admission check. Metadata describes a selected artifact; it cannot
# prove that a different/older QA instance has actually stopped.
$ErrorActionPreference='Stop'
$script:qaProcessRoots=@(
 [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007')),
 [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/baseline-runtime-20261008'))
)
function Find-OwnedQaProcesses {
 param([Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$Inventory)
 foreach($process in $Inventory){
  if(-not $process.ExecutablePath){continue}
  $path=[IO.Path]::GetFullPath($process.ExecutablePath)
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
