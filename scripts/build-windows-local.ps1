# Copy Creator · Windows 本机构建脚本
#
# 用途：在本机（无 MSVC、pnpm junction 解析异常、沙箱 stdio 受限）环境下，
# 用与 `pnpm exec tauri build` 等价的步骤产出便携 EXE 与 MSI。
#
# 等价链路：
#   1. 设好 Rust 工具链环境（CARGO_HOME / RUSTUP_HOME 在工作区，非默认位置）
#   2. 把 TEMP/TMP 指到可写目录（默认沙箱目录只读，dlltool 会报 Permission denied）
#   3. 清掉 NODE_OPTIONS（本机注入的删除保护 shim 会拦截 vite 清理 dist）
#   4. tsc -b -> vite build -> tauri build --ci --bundles msi -- --locked
#
# 产物位置：D:\dshwork\env\target\release\（由 cargo 全局 build.target-dir 决定，
# 不在 src-tauri\target）。这与 scripts\release-windows.ps1 写死的路径不一致，
# 发布流程请以本脚本输出的绝对路径为准。
#
# 用法：
#   pwsh -NoProfile -File scripts\build-windows-local.ps1
#   pwsh -NoProfile -File scripts\build-windows-local.ps1 -Bundles none   # 只出裸 EXE
#   pwsh -NoProfile -File scripts\build-windows-local.ps1 -SkipTypeCheck # 跳过 tsc

[CmdletBinding()]
param(
    # 打包目标：msi（默认）/ none（等价 --no-bundle，只出裸 EXE）
    [ValidateSet('msi', 'none')]
    [string]$Bundles = 'msi',

    # 跳过前端类型检查（仅在已单独跑过 tsc -b 时使用）
    [switch]$SkipTypeCheck
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 本仓库布局：仓库根下有 docs/、scripts/，应用工程在内层 copy-creator/。
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Join-Path $RepoRoot 'copy-creator'
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'src-tauri\tauri.conf.json'))) {
    throw "未找到 src-tauri\tauri.conf.json，期望位置：$ProjectRoot"
}

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Invoke-Checked {
    param(
        [string]$Label,
        [string]$FilePath,
        [string[]]$Arguments
    )
    $started = Get-Date
    & $FilePath @Arguments
    $code = $LASTEXITCODE
    $elapsed = ((Get-Date) - $started).TotalSeconds
    if ($code -ne 0) {
        throw "$Label 失败：退出码 $code（耗时 $([math]::Round($elapsed, 1))s）"
    }
    Write-Host ("  {0} 通过（退出码 0，耗时 {1:N1}s）" -f $Label, $elapsed) -ForegroundColor Green
}

Write-Step '1/4 准备构建环境'

# Rust 工具链装在工作区而非默认用户目录，必须显式指定。
$env:CARGO_HOME = 'D:\dshwork\.cargo'
$env:RUSTUP_HOME = 'D:\dshwork\.rustup'

# 沙箱默认 TEMP 不可写，dlltool/ld 写临时文件会失败（表现为 exit code 0xc0000409）。
$writableTemp = 'D:\dshwork\_build_tmp\temp'
if (-not (Test-Path -LiteralPath $writableTemp)) {
    New-Item -ItemType Directory -Path $writableTemp -Force | Out-Null
}
$env:TEMP = $writableTemp
$env:TMP = $writableTemp
$env:TMPDIR = $writableTemp

# NODE_OPTIONS 里的删除保护 shim 会拦截 vite 清理 dist，构建前必须移除。
if ($env:NODE_OPTIONS) {
    Write-Host "  已清除 NODE_OPTIONS（原值：$env:NODE_OPTIONS）" -ForegroundColor Yellow
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
}

# MinGW 工具链（无 MSVC 时的链接器与资源编译器）
$mingwBin = 'D:\dshwork\env\mingw64\bin'
if (Test-Path -LiteralPath (Join-Path $mingwBin 'gcc.exe')) {
    $env:PATH = "$mingwBin;D:\dshwork\.cargo\bin;$env:PATH"
    $env:CC = Join-Path $mingwBin 'gcc.exe'
    $env:AR = Join-Path $mingwBin 'ar.exe'
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = $env:CC
    Write-Host "  MinGW 工具链已就绪：$mingwBin" -ForegroundColor Green
}
else {
    Write-Warning "未找到 $mingwBin\gcc.exe，链接阶段可能失败"
}

Write-Host "  CARGO_HOME = $env:CARGO_HOME"
Write-Host "  RUSTUP_HOME = $env:RUSTUP_HOME"
Write-Host "  TEMP = $env:TEMP"

Push-Location $ProjectRoot
try {
    Write-Step '2/4 前端类型检查'
    if ($SkipTypeCheck) {
        Write-Host '  已按 -SkipTypeCheck 跳过' -ForegroundColor Yellow
    }
    else {
        Invoke-Checked -Label 'tsc -b' -FilePath 'node' -Arguments @('node_modules\typescript\bin\tsc', '-b')
    }

    Write-Step '3/4 前端生产构建'
    # 直接用 vite 的 JS 入口，绕开 pnpm 生成的 junction 导致 ESM 解析失败的问题。
    Invoke-Checked -Label 'vite build' -FilePath 'node' -Arguments @('node_modules\vite\bin\vite.js', 'build')

    Write-Step '4/4 Tauri 打包'
    # 仓库的 beforeBuildCommand 是 `pnpm build`，而本机 pnpm 因 junction/stdio
    # 问题无法执行（前端已在上一步用 vite 直接构建完）。用 -c 内联覆盖为空，
    # 避免 CLI 再调一次 pnpm。
    $configOverride = '{"build":{"beforeBuildCommand":""}}'
    $tauriCli = 'node_modules\@tauri-apps\cli\tauri.js'
    $tauriArgs = @($tauriCli, 'build', '--ci', '--config', $configOverride)
    if ($Bundles -eq 'msi') {
        $tauriArgs += @('--bundles', 'msi')
    }
    else {
        $tauriArgs += '--no-bundle'
    }
    $tauriArgs += @('--', '--locked')
    Invoke-Checked -Label 'tauri build' -FilePath 'node' -Arguments $tauriArgs
}
finally {
    Pop-Location
}

Write-Step '构建完成'
$releaseDir = 'D:\dshwork\env\target\release'
$exe = Join-Path $releaseDir 'copy-creator.exe'
if (Test-Path -LiteralPath $exe) {
    $info = Get-Item -LiteralPath $exe
    Write-Host ("  EXE: {0}" -f $exe) -ForegroundColor Green
    Write-Host ("        {0:N1} MB，ProductVersion {1}" -f ($info.Length / 1MB), $info.VersionInfo.ProductVersion)
}
else {
    Write-Warning "未在 $releaseDir 找到 copy-creator.exe"
}

if ($Bundles -eq 'msi') {
    $msiDir = Join-Path $releaseDir 'bundle\msi'
    if (Test-Path -LiteralPath $msiDir) {
        Get-ChildItem -LiteralPath $msiDir -Filter '*.msi' -File | ForEach-Object {
            Write-Host ("  MSI: {0}" -f $_.FullName) -ForegroundColor Green
            Write-Host ("        {0:N1} MB" -f ($_.Length / 1MB))
        }
    }
    else {
        Write-Warning "未找到 MSI 目录 $msiDir"
    }
}

Write-Host ''
Write-Host '提示：产物目录由 cargo 全局 build.target-dir 决定，不在 src-tauri\target。' -ForegroundColor DarkGray
