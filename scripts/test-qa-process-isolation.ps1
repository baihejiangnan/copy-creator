$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'qa-process-isolation.ps1')
$qa=$script:qaProcessRoots[0];$baseline=$script:qaProcessRoots[1]
$fixtures=@(
 [pscustomobject]@{ProcessId=101;ExecutablePath=(Join-Path $qa 'copy-creator-qa.exe')},
 [pscustomobject]@{ProcessId=102;ExecutablePath=(Join-Path $qa 'search-runtime-qa/copy-creator-search-qa.exe')},
 [pscustomobject]@{ProcessId=103;ExecutablePath=(Join-Path $baseline 'copy-creator-qa.exe')},
 [pscustomobject]@{ProcessId=104;ExecutablePath=(Join-Path ($qa+'-unrelated') 'app.exe')},
 [pscustomobject]@{ProcessId=105;ExecutablePath='C:/Users/ABD18/Documents/Copy-Creator-0.2.24-portable.exe'},
 [pscustomobject]@{ProcessId=106;ExecutablePath=$null},
 [pscustomobject]@{ProcessId=107;ExecutablePath=(Join-Path $qa '../unrelated/app.exe')}
)
$found=@(Find-OwnedQaProcesses -Inventory $fixtures)
if(($found.pid -join ',') -ne '101,102,103'){throw 'QA inventory path boundary regression'}
Assert-OwnedQaStopped -Inventory @()
Assert-OwnedQaStopped -Inventory @($fixtures | Where-Object {$_.ProcessId -ge 104})
$refused=$false
try{Assert-OwnedQaStopped -Inventory $fixtures}catch{if($_.Exception.Message.StartsWith('Refusing QA launch: live owned QA process inventory')){$refused=$true}else{throw}}
if(-not $refused){throw 'A live legacy QA must prevent admission'}
$elevated=[pscustomobject]@{ProcessId=108;Name='copy-creator-qa.exe';ExecutablePath=$null}
$resolved=@(Find-OwnedQaProcesses -Inventory @($elevated) -ResolveImagePath {param($ProcessId) if($ProcessId -ne 108){throw 'Unexpected process query'};Join-Path $qa 'copy-creator-qa.exe'})
if($resolved.Count -ne 1 -or $resolved[0].pid -ne 108){throw 'Elevated QA must not be excluded when WMI omits its image'}
$refused=$false
try{Find-OwnedQaProcesses -Inventory @($elevated) -ResolveImagePath {param($ProcessId) $null} | Out-Null}catch{if($_.Exception.Message.StartsWith('Refusing QA launch: cannot verify')){$refused=$true}else{throw}}
if(-not $refused){throw 'Unverifiable elevated candidate must refuse admission'}
@{passed=$true;syntheticCases=9;liveInventoryAccessed=$false;scope='Production/unrelated/null/normalized sibling paths excluded; default/search/baseline/elevated native instances included; unknown elevated candidate refuses admission'} | ConvertTo-Json -Compress
