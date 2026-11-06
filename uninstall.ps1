# 富江破甲卸载脚本（DSH 0.2.x / 0.2.2-rc.1 适配版）
#
# 用法：
#   .\uninstall.ps1                                  # 卸载默认 DSH（$env:DSH_HOME 或 %USERPROFILE%\.dsh）
#   .\uninstall.ps1 -DshHome "D:\dsh-rc\.dsh-home"
#   .\uninstall.ps1 -Profile desktop
#
# 只修改 -DshHome 指定的那一个数据目录。

[CmdletBinding()]
param(
    [string]$DshHome,
    [string[]]$Profile,
    [switch]$AllProfiles
)

$ErrorActionPreference = 'Stop'
$pluginName  = 'fujiang-armor'
$pluginLabel = '富江破甲'
$srcDir = $PSScriptRoot

function Write-Step { param([string]$Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "    [OK] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "    [!] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "    [X] $Msg" -ForegroundColor Red }

Write-Host "`n====================" -ForegroundColor Cyan
Write-Host "  $pluginLabel 一键卸载" -ForegroundColor Cyan
Write-Host "====================" -ForegroundColor Cyan

# ---------- [1] 定位数据目录 ----------
Write-Step '定位 DSH 数据目录'
$defaultHome = Join-Path $env:USERPROFILE '.dsh'
if ($DshHome) { $targetHome = [System.IO.Path]::GetFullPath($DshHome.Trim('"')) }
elseif ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { $targetHome = [System.IO.Path]::GetFullPath($env:DSH_HOME.Trim('"')) }
else { $targetHome = $defaultHome }
$targetHome = $targetHome.TrimEnd('\')

$profilesRoot = Join-Path $targetHome 'profiles'
if (-not (Test-Path -LiteralPath $profilesRoot -PathType Container)) {
    Write-Err "未找到 DSH 数据目录：$targetHome"
    exit 1
}
Write-Ok "目标数据目录：$targetHome"
if ($targetHome -ne $defaultHome.TrimEnd('\')) { Write-Ok "隔离模式：默认目录 $defaultHome 不会被修改" }

# ---------- [2] 选择 profile ----------
Write-Step '选择 profile'
$allDirs = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'node_modules' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'package.json')) })
$profileDirs = @()
if ($Profile -and $Profile.Count -gt 0) {
    foreach ($want in $Profile) {
        $hit = $allDirs | Where-Object { $_.Name -ieq $want } | Select-Object -First 1
        if ($hit) { $profileDirs += $hit.FullName }
    }
} elseif ($AllProfiles) {
    $profileDirs = @($allDirs | ForEach-Object { $_.FullName })
} else {
    foreach ($name in @('desktop', 'web', 'default', 'tui')) {
        $hit = $allDirs | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
        if ($hit) { $profileDirs += $hit.FullName }
    }
    if ($profileDirs.Count -eq 0) { $profileDirs = @($allDirs | ForEach-Object { $_.FullName }) }
}
if ($profileDirs.Count -eq 0) { Write-Err '没有可处理的 profile，退出。'; exit 1 }
foreach ($pDir in $profileDirs) { Write-Ok "$(Split-Path $pDir -Leaf)  ->  $pDir" }

# ---------- [3] 解析 node ----------
# 依次尝试：目标实例自带运行时 → 默认实例自带运行时 → 本插件下载的运行时 → PATH
$nodeBin = $null
$runtimeRoots = @(
    (Join-Path $targetHome 'dsh-runtimes'),
    (Join-Path $defaultHome 'dsh-runtimes')
)
foreach ($runtimeRoot in $runtimeRoots) {
    if (-not (Test-Path -LiteralPath $runtimeRoot)) { continue }
    foreach ($rd in @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Force -ErrorAction SilentlyContinue)) {
        $candidate = Join-Path $rd.FullName 'dependencies\node\bin\node.exe'
        if (-not $nodeBin -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $nodeBin = $candidate }
    }
}
if (-not $nodeBin) {
    $armorRuntime = Join-Path $env:LOCALAPPDATA 'FujiangArmor\runtime'
    if (Test-Path -LiteralPath $armorRuntime) {
        foreach ($rd in @(Get-ChildItem -LiteralPath $armorRuntime -Directory -Force -ErrorAction SilentlyContinue)) {
            $candidate = Join-Path $rd.FullName 'node.exe'
            if (-not $nodeBin -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $nodeBin = $candidate }
        }
    }
}
if (-not $nodeBin) {
    $sysNode = Get-Command node -ErrorAction SilentlyContinue
    if ($sysNode) { $nodeBin = $sysNode.Source }
}
if ($nodeBin) { Write-Ok "node：$nodeBin" }

# ---------- [4] 卸载挂载 ----------
Write-Step '移除 profile 挂载'
if ($nodeBin -and (Test-Path -LiteralPath (Join-Path $srcDir 'scripts\lib\compat.js'))) {
    $unmountArgs = @((Join-Path $srcDir 'scripts\lib\compat.js'), 'unmount', $targetHome) + $profileDirs
    & $nodeBin @unmountArgs 2>&1 | Out-Null
    $unlinkArgs = @((Join-Path $srcDir 'scripts\lib\compat.js'), 'unlink', $targetHome) + $profileDirs
    & $nodeBin @unlinkArgs 2>&1 | Out-Null
    Write-Ok '已移除 cordis.patch.yml 托管块、dependencies 与 bundles 记录'
} else {
    Write-Warn '缺少 node 或 compat.js，改为手工清理 cordis.patch.yml 与 package.json'
    foreach ($pDir in $profileDirs) {
        $patchPath = Join-Path $pDir 'cordis.patch.yml'
        if (Test-Path -LiteralPath $patchPath) {
            $text = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
            $text = $text -replace "(?ms)^# >>> fujiang-armor.*?^# <<< fujiang-armor[^\r\n]*\r?\n?", ''
            $text = $text -replace "(?ms)^-\s*insert:\s*\r?\n\s*-\s*id:\s*fujiang-armor[\s\S]*?(?=^- |\z)", ''
            $text = $text -replace "(?m)^\s*includeHarnessIdentity:\s*false\s*\r?\n", ''
            [System.IO.File]::WriteAllText($patchPath, $text.TrimEnd() + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
            Write-Ok "[$(Split-Path $pDir -Leaf)] 已清理托管块与 includeHarnessIdentity 覆盖"
        }
        $pkgPath = Join-Path $pDir 'package.json'
        if (Test-Path -LiteralPath $pkgPath) {
            try {
                $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties.Name -contains $pluginName) {
                    $pkg.dependencies.PSObject.Properties.Remove($pluginName)
                    $json = $pkg | ConvertTo-Json -Depth 12
                    [System.IO.File]::WriteAllText($pkgPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
                    Write-Ok "[$(Split-Path $pDir -Leaf)] 已移除 dependencies 中的 $pluginName"
                }
            } catch { Write-Warn "[$(Split-Path $pDir -Leaf)] package.json 清理失败：$($_.Exception.Message)" }
        }
    }
}

# ---------- [5] 清理 node_modules 链接 ----------
Write-Step '清理 node_modules 链接'
foreach ($pDir in $profileDirs) {
    $nmEntry = Join-Path (Join-Path $pDir 'node_modules') $pluginName
    if (-not (Test-Path -LiteralPath $nmEntry)) { continue }
    $item = Get-Item -LiteralPath $nmEntry -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        cmd.exe /c "rmdir `"$nmEntry`"" 2>$null | Out-Null
    } else {
        Remove-Item -LiteralPath $nmEntry -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Ok "[$(Split-Path $pDir -Leaf)] 已清理 node_modules\$pluginName"
}

# ---------- [6] 删除插件目录 ----------
Write-Step '删除插件目录'
$pluginDir = Join-Path (Join-Path $targetHome 'plugins') $pluginName
if (Test-Path -LiteralPath $pluginDir) {
    Remove-Item -LiteralPath $pluginDir -Recurse -Force
    Write-Ok "已删除：$pluginDir"
} else {
    Write-Ok '插件目录不存在，无需删除'
}

Write-Step '卸载完成'
Write-Host ''
Write-Host "  $pluginLabel 已从 $targetHome 卸载，请完全退出并重启该 DSH 实例。" -ForegroundColor Green
Write-Host '  注意：profile 补丁里如果还有 dsh-purge 等其它插件，本脚本不会改动它们。' -ForegroundColor White
Write-Host ''
try { if (-not $env:DSH_UNINSTALL_NO_PAUSE) { Read-Host '按回车键退出' } } catch { }
exit 0
