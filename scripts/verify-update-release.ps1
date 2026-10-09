[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Directory, [Parameter(Mandatory=$true)][string]$Verifier)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath $Directory).Path
$manifestPath = Join-Path $root 'latest.json'
if ((Get-Item -LiteralPath $manifestPath).Length -gt 1048576) { throw 'Metadata too large' }
$jsonOptions=@{}
# PowerShell 7.5+ otherwise converts ISO strings to DateTime automatically.
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $jsonOptions.DateKind='String' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json @jsonOptions
if ($manifest.version -notmatch '^\d+\.\d+\.\d+$' -or $manifest.notes -isnot [string]) { throw 'Invalid metadata version/notes' }
if ($manifest.tag -ne "v$($manifest.version)" -and ($manifest.tag -notmatch ('^v'+[regex]::Escape($manifest.version)+'-baihejiangnan\.([1-9]\d*)$') -or [uint64]$Matches[1] -gt [uint32]::MaxValue)) { throw 'Invalid metadata tag' }
if ($manifest.pub_date -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$') { throw 'Invalid UTC date' }
[DateTimeOffset]::Parse($manifest.pub_date) | Out-Null
$names=@("Copy-Creator-$($manifest.version)-portable.exe", "Copy-Creator_$($manifest.version)_x64.msi")
$five=@($names[0], ($names[0]+'.sig'), $names[1], ($names[1]+'.sig'), 'latest.json')
$expected=@($five + 'SHA256SUMS.txt') | Sort-Object
$actual=@(Get-ChildItem -LiteralPath $root -File | ForEach-Object Name) | Sort-Object
if (($actual -join '|') -cne ($expected -join '|')) { throw 'Expected exactly six release files' }
if ((@($manifest.platforms.PSObject.Properties.Name) | Sort-Object) -join '|' -cne 'windows-x86_64|windows-x86_64-portable') { throw 'Expected two Windows platform entries' }
for ($index=0; $index -lt 2; $index++) {
    $name=$names[$index]; $asset=Join-Path $root $name
    $key=if($index -eq 0){'windows-x86_64-portable'}else{'windows-x86_64'}
    $entry=$manifest.platforms.$key
    if ($entry.url -cne "https://github.com/baihejiangnan/copy-creator/releases/download/$($manifest.tag)/$name" -or
        $entry.size -ne (Get-Item -LiteralPath $asset).Length -or $entry.size -le 0 -or $entry.size -gt 536870912 -or
        $entry.signature -cne [IO.File]::ReadAllText($asset+'.sig').Trim()) { throw "Invalid artifact: $key" }
    & $Verifier $asset ($asset+'.sig')
    if ($LASTEXITCODE -ne 0) { throw "Signature failed: $key" }
}
$expectedSums=@($five | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $root $_) -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+$_ })
$actualSums=@([IO.File]::ReadAllLines((Join-Path $root 'SHA256SUMS.txt')))
if (($actualSums -join "`n") -cne ($expectedSums -join "`n")) { throw 'SHA256SUMS mismatch' }
@{verified=$true;assets=6;version=$manifest.version;scope='Local files, client signatures, metadata and hashes; no public download or installation'} | ConvertTo-Json -Compress
