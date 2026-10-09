param([Parameter(Mandatory=$true)][ValidateSet('R0','R1','current')][string]$Variant)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/baseline-runtime-20261008'))
$metadata=Join-Path $root 'process.json'
& (Join-Path $PSScriptRoot 'qa-process-isolation.ps1')
if(Test-Path -LiteralPath $metadata){
 $previous=Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
 $running=Get-Process -Id $previous.pid -ErrorAction SilentlyContinue
 if($running -and $running.Path -eq $previous.exe){throw 'Stop runtime baseline before selection'}
}
$python=if($env:QA_PYTHON){$env:QA_PYTHON}else{'C:/Users/ABD18/AppData/Local/Programs/Python/Python311/python.exe'}
$guard=@{action='build';variant=$Variant}|ConvertTo-Json -Compress|& $python (Join-Path $PSScriptRoot 'qa-runtime-baseline-guard.py')
if($LASTEXITCODE -ne 0){throw 'Generation-2 baseline admission failed'}
$artifact=Join-Path $root "$Variant-embedded-v2"
$build=Get-Content -LiteralPath (Join-Path $artifact 'build.json') -Raw | ConvertFrom-Json
$binary=Join-Path $artifact 'copy-creator.exe'
if($build.identifier -ne 'com.copycreator.qabaseline20261008v2' -or $build.generation -ne 2 -or $build.autostartIsolation -ne 'identifier' -or $build.pasteIsolation -ne 'identifier' -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $build.sha256){throw 'Expected verified isolated embedded runtime baseline'}
$minimum=if($Variant -eq 'R0'){70000000}else{40000000}
if((Get-Item -LiteralPath $binary).Length -lt $minimum){throw 'Unexpected unembedded runtime baseline'}
New-Item -ItemType Directory -Path (Join-Path $root 'reports') -Force | Out-Null
$exe=Join-Path $root 'copy-creator-qa.exe';Copy-Item -LiteralPath $binary -Destination $exe
@{identifier=$build.identifier;generation=2;profile=$build.profile;schemaMax=$build.schemaMax;autostartIsolation=$build.autostartIsolation;pasteIsolation=$build.pasteIsolation;variant=$Variant;frontend=$build.frontend;exe=$exe;sha256=$build.sha256;pid=0;debugPort=9246;storageRoot=(Join-Path $env:APPDATA $build.identifier)} | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding utf8
@{selected=$Variant;started=$false;sha256=$build.sha256}|ConvertTo-Json -Compress
