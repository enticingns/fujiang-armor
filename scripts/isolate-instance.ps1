# 创建「隔离实例」启动器
#
# 作用：为另一个 DSH 程序目录（例如 D:\dsh-rc）准备一套完全独立的数据目录，
#       并生成启动器。隔离实例使用自己的 DSH_HOME 与 Electron user-data 目录，
#       因此不会读写正在运行的那套 DSH（默认 %USERPROFILE%\.dsh）的任何文件。
#
# 用法：
#   .\isolate-instance.ps1 -AppDir "D:\dsh-rc"
#   .\isolate-instance.ps1 -AppDir "D:\dsh-rc" -SeedFrom "$env:USERPROFILE\.dsh"
#
# 生成的启动器：<AppDir>\启动隔离实例.bat

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [string]$HomeDir,
    [string]$UserDataDir,
    [string]$SeedFrom,
    [string]$LauncherName = '启动隔离实例.bat'
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "    [OK] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "    [!] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "    [X] $Msg" -ForegroundColor Red }

$appDir = [System.IO.Path]::GetFullPath($AppDir.Trim('"')).TrimEnd('\')
if (-not (Test-Path -LiteralPath $appDir -PathType Container)) { Write-Err "程序目录不存在：$appDir"; exit 1 }

$exe = Join-Path $appDir 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    $found = @(Get-ChildItem -LiteralPath $appDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*Harness*' } | Select-Object -First 1)
    if ($found.Count -eq 0) { Write-Err "目录里找不到 DeepSeek Harness.exe：$appDir"; exit 1 }
    $exe = $found[0].FullName
}

if (-not $HomeDir) { $HomeDir = Join-Path $appDir '.dsh-home' }
if (-not $UserDataDir) { $UserDataDir = Join-Path $appDir '.dsh-userdata' }
$homeDir = [System.IO.Path]::GetFullPath($HomeDir.Trim('"')).TrimEnd('\')
$userDataDir = [System.IO.Path]::GetFullPath($UserDataDir.Trim('"')).TrimEnd('\')

Write-Host "`n====================" -ForegroundColor Cyan
Write-Host "  DSH 隔离实例" -ForegroundColor Cyan
Write-Host "====================" -ForegroundColor Cyan
Write-Ok "程序：$exe"
Write-Ok "数据目录（DSH_HOME）：$homeDir"
Write-Ok "Electron 用户目录：$userDataDir"

# ---------- [1] 目录 ----------
Write-Step '创建隔离目录'
foreach ($dir in @($homeDir, (Join-Path $homeDir 'profiles'), $userDataDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}
Write-Ok '目录已就绪'

# ---------- [2] 可选：从现有实例复制登录凭据与配置 ----------
if ($SeedFrom) {
    $seed = [System.IO.Path]::GetFullPath($SeedFrom.Trim('"')).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $seed -PathType Container)) { Write-Warn "种子目录不存在：$seed（跳过）" }
    else {
        Write-Step "复制登录凭据与配置（只读源目录：$seed）"

        foreach ($file in @('.credentials.yaml', '.env')) {
            $from = Join-Path $seed $file
            if (Test-Path -LiteralPath $from -PathType Leaf) {
                Copy-Item -LiteralPath $from -Destination (Join-Path $homeDir $file) -Force
                Write-Ok "已复制 $file"
            }
        }

        # 只复制「配置覆盖」行：保留模型供应商/界面设置，丢掉第三方插件挂载。
        $seedProfiles = Join-Path $seed 'profiles'
        if (Test-Path -LiteralPath $seedProfiles) {
            $nodeBin = $null
            $runtimeRoot = Join-Path $seed 'dsh-runtimes'
            if (Test-Path -LiteralPath $runtimeRoot) {
                foreach ($rd in @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Force -ErrorAction SilentlyContinue)) {
                    $candidate = Join-Path $rd.FullName 'dependencies\node\bin\node.exe'
                    if (-not $nodeBin -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $nodeBin = $candidate }
                }
            }
            if (-not $nodeBin) {
                $sysNode = Get-Command node -ErrorAction SilentlyContinue
                if ($sysNode) { $nodeBin = $sysNode.Source }
            }

            foreach ($p in @(Get-ChildItem -LiteralPath $seedProfiles -Directory -Force -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -ne 'node_modules' })) {
                $targetProfile = Join-Path (Join-Path $homeDir 'profiles') $p.Name
                if (-not (Test-Path -LiteralPath (Join-Path $p.FullName 'package.json'))) { continue }
                # 已初始化过的 profile 不再播种：避免重跑本脚本覆盖已安装的插件与后续手工改动。
                if (Test-Path -LiteralPath (Join-Path $targetProfile 'package.json')) {
                    Write-Ok "[$($p.Name)] 已存在，保留现状（不覆盖）"
                    continue
                }
                if (-not (Test-Path -LiteralPath $targetProfile)) { New-Item -ItemType Directory -Path $targetProfile -Force | Out-Null }

                # cordis.yml / pnpm-workspace.yaml 原样复制
                foreach ($file in @('cordis.yml', 'pnpm-workspace.yaml')) {
                    $from = Join-Path $p.FullName $file
                    if (Test-Path -LiteralPath $from -PathType Leaf) {
                        Copy-Item -LiteralPath $from -Destination (Join-Path $targetProfile $file) -Force
                    }
                }

                # package.json：清空依赖，bundles 只留官方基础 bundle
                $pkgPath = Join-Path $p.FullName 'package.json'
                $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $pkg.dependencies = [pscustomobject]@{}
                if ($null -eq $pkg.dsh) { $pkg | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{}) -Force }
                $bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app')
                $profileObj = [pscustomobject]@{ bundles = $bundles }
                $pkg.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue $profileObj -Force
                $json = $pkg | ConvertTo-Json -Depth 12
                [System.IO.File]::WriteAllText((Join-Path $targetProfile 'package.json'), $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))

                # cordis.patch.yml：只保留 config 覆盖行
                $patchSrc = Join-Path $p.FullName 'cordis.patch.yml'
                $patchDst = Join-Path $targetProfile 'cordis.patch.yml'
                if (Test-Path -LiteralPath $patchSrc) {
                    $text = [System.IO.File]::ReadAllText($patchSrc, [System.Text.Encoding]::UTF8)
                    $compatJs = Join-Path $PSScriptRoot 'lib\compat.js'
                    $seeded = $false
                    if ($nodeBin -and (Test-Path -LiteralPath $compatJs)) {
                        # 由 node 直接写目标文件：不经过 stdout，避免控制台代码页（GBK）把中文补丁内容解坏
                        try {
                            $seedArgs = @($compatJs, 'seed', $patchSrc, $patchDst)
                            & $nodeBin @seedArgs 2>&1 | Out-Null
                            if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $patchDst)) { $seeded = $true }
                        } catch { }
                    }
                    if (-not $seeded) {
                        # 无 node 时的保守回退：删掉所有根级 insert 块与含 {{cwd}} 的行
                        $clean = [regex]::Replace($text, '(?ms)^-[ \t]+insert:[^\n]*\n(?:[ \t].*\n|\n)*', '')
                        $clean = ($clean -split "\r?\n" | Where-Object { $_ -notmatch '\{\{\s*cwd\s*\}\}' }) -join "`n"
                        [System.IO.File]::WriteAllText($patchDst, ($clean.TrimEnd() + "`n"), (New-Object System.Text.UTF8Encoding($false)))
                    }
                    Write-Ok "[$($p.Name)] 已复制配置覆盖行（第三方插件挂载未复制）"
                }
            }
        }
        Write-Ok '登录凭据与模型配置已就绪（源目录未被修改）'
    }
}

# ---------- [3] 生成启动器 ----------
Write-Step '生成启动器'
$batPath = Join-Path $appDir $LauncherName
# cmd.exe 按系统 ANSI 代码页读取 .bat，用默认编码写回才能正确显示中文路径。
$ansiEncoding = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage)
$lines = @(
    '@echo off',
    'setlocal',
    'title DSH 隔离实例',
    'rem 隔离实例：独立 DSH_HOME + 独立 Electron 用户目录，不读写默认 %USERPROFILE%\.dsh',
    'rem 从 DSH 终端/子进程启动时会继承 ELECTRON_RUN_AS_NODE=1，必须清掉，否则程序会以 node 模式运行并报 bad option',
    'set "ELECTRON_RUN_AS_NODE="',
    ('set "DSH_HOME=' + $homeDir + '"'),
    'set "DSH_PROFILE=desktop"',
    ('start "" "' + $exe + '" --user-data-dir="' + $userDataDir + '"'),
    'exit /b 0'
)
[System.IO.File]::WriteAllLines($batPath, $lines, $ansiEncoding)
Write-Ok "启动器：$batPath"

# ---------- [4] 汇总 ----------
Write-Step '完成'
Write-Host ''
Write-Host '  下一步：' -ForegroundColor White
Write-Host "    1) 双击「$LauncherName」启动一次隔离实例（首次会生成 profiles\desktop 与运行环境）" -ForegroundColor White
Write-Host "    2) 完全退出后执行： .\install.ps1 -DshHome `"$homeDir`"" -ForegroundColor White
Write-Host "    3) 再双击「$LauncherName」，新建会话查看「富江破甲已激活」" -ForegroundColor White
Write-Host ''
Write-Host "  默认实例（$env:USERPROFILE\.dsh）全程未被读写。" -ForegroundColor Green
Write-Host ''
exit 0
