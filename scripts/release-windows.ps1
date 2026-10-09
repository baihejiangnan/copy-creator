#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$NotesFile,
    [string]$Tag = '',
    [switch]$AllowDirty
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appRoot = Join-Path $repoRoot 'copy-creator'
$notes = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $NotesFile).Path)
function Assert-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed ($LASTEXITCODE)" } }
Push-Location $repoRoot
try {
    $dirty = @(& git status --porcelain); Assert-Exit 'Read worktree'
    if ($dirty.Count -and -not $AllowDirty) { throw 'Commit the final source before a release build. -AllowDirty creates a local validation build only.' }
    $sourceCommit = (& git rev-parse HEAD).Trim(); Assert-Exit 'Read source commit'
    $package = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json
    $config = Get-Content -LiteralPath (Join-Path $appRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
    $version = $package.version
    if ($version -notmatch '^\d+\.\d+\.\d+$' -or $config.version -ne $version) { throw 'Expected matching stable base versions' }
    if (-not $Tag) { $Tag = "v$version-baihejiangnan.1" }
    if ($Tag -ne "v$version" -and ($Tag -notmatch ('^v' + [regex]::Escape($version) + '-baihejiangnan\.([1-9]\d*)$') -or [uint64]$Matches[1] -gt [uint32]::MaxValue)) { throw 'Tag must match the application base version and use a positive 32-bit suffix' }
    $localCredential = Join-Path $env:USERPROFILE '.tauri/copy-creator-updater.key'
    $signArgs = @()
    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
        if ($env:TAURI_SIGNING_PRIVATE_KEY_PATH) { $localCredential = $env:TAURI_SIGNING_PRIVATE_KEY_PATH }
        if (-not (Test-Path -LiteralPath $localCredential -PathType Leaf)) { throw 'Missing signing key. Provide a Tauri signing credential; the script never creates or replaces keys.' }
        $signArgs = @('--private-key-path', $localCredential)
        if ([string]::IsNullOrEmpty($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) { $signArgs += @('--password', '') }
    }
    $releaseRoot = Join-Path $repoRoot 'releases'
    $prefix = if ($AllowDirty) { 'validation-' } else { '' }
    $stage = Join-Path $releaseRoot ($prefix + $Tag + '-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Push-Location $appRoot
    try {
        $metadataText = & cargo metadata --manifest-path src-tauri/Cargo.toml --locked --no-deps --format-version 1
        Assert-Exit 'Read Cargo version'
        $metadata = $metadataText | ConvertFrom-Json
        $rustPackage = @($metadata.packages | Where-Object name -eq 'copy-creator')
        if ($rustPackage.Count -ne 1 -or $rustPackage[0].version -ne $version) { throw 'Cargo version differs' }
        & pnpm exec tsc -b; Assert-Exit 'Types'
        & pnpm test:unit; Assert-Exit 'Frontend unit tests'
        & pnpm lint; Assert-Exit 'Lint'
        & cargo test --manifest-path src-tauri/Cargo.toml --locked --lib; Assert-Exit 'Rust tests'
        # Tauri CLI preserves Cargo's separator under pnpm 11. This also runs
        # the normal frontend build hook. MSI and portable share one build.
        & node node_modules/@tauri-apps/cli/tauri.js build --ci --bundles msi -- --locked
        Assert-Exit 'Desktop build'
        $exe = Join-Path $appRoot 'src-tauri/target/release/copy-creator.exe'
        $msi = Join-Path $appRoot "src-tauri/target/release/bundle/msi/Copy Creator_${version}_x64_zh-CN.msi"
        if (-not (Test-Path -LiteralPath $msi)) { throw 'Expected this version of the MSI from the completed build' }
        $assetNames = @("Copy-Creator-$version-portable.exe", "Copy-Creator_${version}_x64.msi")
        Copy-Item -LiteralPath $exe -Destination (Join-Path $stage $assetNames[0])
        Copy-Item -LiteralPath $msi -Destination (Join-Path $stage $assetNames[1])
        # ProductVersion + install marker are read from MSI tables, never installed.
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.OpenDatabase($msi, 0)
        try {
            $view = $database.OpenView('SELECT `Value` FROM `Property` WHERE `Property` = ''ProductVersion''')
            $view.Execute(); $record = $view.Fetch()
            if (-not $record -or $record.StringData(1) -ne $version) { throw 'MSI ProductVersion mismatch' }
            $view.Close()
            $view = $database.OpenView('SELECT `Value` FROM `Registry` WHERE `Name` = ''ExecutablePath''')
            $view.Execute(); $record = $view.Fetch()
            if (-not $record -or $record.StringData(1) -ne '[INSTALLDIR]copy-creator.exe') { throw 'MSI update-mode marker missing' }
            $view.Close()
        } finally {
            if ($record) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) | Out-Null }
            if ($view) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) | Out-Null }
            [Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) | Out-Null
            [Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) | Out-Null
        }
        & cargo build --manifest-path src-tauri/update-verifier/Cargo.toml --locked
        Assert-Exit 'Client verifier build'
        $verifier = Join-Path $appRoot 'src-tauri/update-verifier/target/debug/copy-creator-update-verifier.exe'
        foreach ($name in $assetNames) {
            $asset = Join-Path $stage $name
            & node node_modules/@tauri-apps/cli/tauri.js signer sign @signArgs $asset; Assert-Exit 'Sign package'
            & $verifier $asset ($asset + '.sig'); Assert-Exit 'Verify package'
            # A disposable copy proves tamper rejection by the actual verifier.
            $tampered = Join-Path $stage ($name + '.tampered')
            Copy-Item -LiteralPath $asset -Destination $tampered
            $stream = [IO.File]::Open($tampered, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
            try { $byte = $stream.ReadByte(); $stream.Position = 0; $stream.WriteByte($byte -bxor 1) } finally { $stream.Dispose() }
            & $verifier $tampered ($asset + '.sig')
            if ($LASTEXITCODE -ne 1) { throw 'Client verifier did not reject tampering' }
            Remove-Item -LiteralPath $tampered
        }
        $platforms = [ordered]@{}
        for ($index=0; $index -lt 2; $index++) {
            $name = $assetNames[$index]; $asset = Join-Path $stage $name
            $key = if ($index -eq 0) { 'windows-x86_64-portable' } else { 'windows-x86_64' }
            $platforms[$key] = [ordered]@{url="https://github.com/baihejiangnan/copy-creator/releases/download/$Tag/$name";signature=[IO.File]::ReadAllText($asset + '.sig').Trim();size=(Get-Item -LiteralPath $asset).Length}
        }
        $manifest = [ordered]@{version=$version;tag=$Tag;notes=[string]$notes;pub_date=[DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");platforms=$platforms}
        $utf8 = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText((Join-Path $stage 'latest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
        if ((Get-Item -LiteralPath (Join-Path $stage 'latest.json')).Length -gt 1048576) { throw 'Metadata exceeds the client limit' }
        $fiveNames = @($assetNames[0], ($assetNames[0]+'.sig'), $assetNames[1], ($assetNames[1]+'.sig'), 'latest.json')
        $checksums = foreach ($name in $fiveNames) { ((Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $name) }
        [IO.File]::WriteAllText((Join-Path $stage 'SHA256SUMS.txt'), ($checksums -join "`n") + "`n", $utf8)
        & (Join-Path $PSScriptRoot 'verify-update-release.ps1') -Directory $stage -Verifier $verifier
        # Do not turn uncommitted code into a tagged production artifact.
        $sourceStatus = @(& git status --porcelain); Assert-Exit 'Read final source'
        if (-not $AllowDirty -and $sourceStatus.Count) { throw 'Build changed tracked source; commit and rebuild' }
        @{sourceCommit=$sourceCommit;validationOnly=[bool]$AllowDirty;version=$version;tag=$Tag;directory=$stage;assets=6;published=$false;installed=$false} | ConvertTo-Json
    } finally { Pop-Location }
} finally { Pop-Location }
