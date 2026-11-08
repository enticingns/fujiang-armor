# 富江破甲安装脚本（DSH 0.2.x / 0.2.2-rc.1 适配版）
#
# 用法：
#   .\install.ps1                                   # 安装到当前默认 DSH（$env:DSH_HOME 或 %USERPROFILE%\.dsh）
#   .\install.ps1 -DshHome "D:\dsh-rc\.dsh-home"   # 安装到隔离实例，完全不影响默认 DSH
#   .\install.ps1 -Profile desktop                  # 只装到 desktop profile
#   .\install.ps1 -AllProfiles                      # 装到该 home 下所有 profile
#   .\install.ps1 -InjectionMode user              # 模式一：user 会话注入（默认）
#   .\install.ps1 -InjectionMode legacy            # 模式二：老版本 system 双层段注入
#
# 说明：本脚本只写 -DshHome 指定的那一个数据目录，不会碰其它 DSH 数据目录。

[CmdletBinding()]
param(
    [string]$DshHome,
    [string[]]$Profile,
    [switch]$AllProfiles,
    [switch]$SkipPnpmInstall,
    [ValidateSet('user', 'legacy')]
    [string]$InjectionMode = 'user'
)

$ErrorActionPreference = 'Stop'
$pluginName  = 'fujiang-armor'
$pluginLabel = '富江破甲'
$pluginVersion = '0.7.0'
$srcDir = $PSScriptRoot

# ---------- 输出辅助 ----------
function Write-Step { param([string]$Msg) Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "    [OK] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "    [!] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "    [X] $Msg" -ForegroundColor Red }

# 调用 compat.js 并读回它的 JSON 结果。
# 不能直接捕获子进程 stdout：PowerShell 按控制台代码页解码，中文 Windows（GBK）下
# node 输出的 UTF-8 中文会被解成乱码、连引号都可能被吃掉，ConvertFrom-Json 随即报
# 「传入了未终止的字符串」。所以让 node 把结果写成 UTF-8 文件（--out），再用 UTF-8 读回。
function Invoke-Compat {
    param(
        [Parameter(Mandatory = $true)][string]$Node,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $outFile = Join-Path ([System.IO.Path]::GetTempPath()) ("fujiang-compat-{0}.json" -f ([guid]::NewGuid().ToString('N')))
    try {
        $argv = $Arguments + @('--out', $outFile)
        $native = & $Node @argv 2>&1
        $exit = $LASTEXITCODE
        $data = $null
        if (Test-Path -LiteralPath $outFile) {
            $text = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8)
            if ($text.Trim()) {
                try { $data = $text | ConvertFrom-Json } catch { $data = $null }
            }
        }
        return [pscustomobject]@{
            ExitCode = $exit
            Data     = $data
            Output   = (($native | ForEach-Object { "$_" }) -join ' ')
        }
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    }
}

# pnpm-workspace.yaml 的 allowBuilds 里出现重复键时 pnpm 会直接报
# "duplicated mapping key" 退出。这里做一次幂等修复：去重、丢弃被截断的 "pkg@https" 残键。
function Repair-PnpmWorkspaceConfig {
    param([string]$ProfileDir)

    $wsPath = Join-Path $ProfileDir 'pnpm-workspace.yaml'
    if (-not (Test-Path -LiteralPath $wsPath -PathType Leaf)) { return }

    $text = [System.IO.File]::ReadAllText($wsPath, [System.Text.Encoding]::UTF8)
    $out = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    $inAllowBuilds = $false
    $removed = 0

    foreach ($line in ($text -split "\r?\n")) {
        if ($line -match '^\S') {
            $inAllowBuilds = ($line -match '^allowBuilds\s*:')
            $seen = @{}
        }
        if ($inAllowBuilds -and $line -match '^(\s+)(.+):\s') {
            $key = $Matches[2].Trim()
            if ($key -match '@https?$') { $removed++; continue }
            if ($seen.ContainsKey($key)) { $removed++; continue }
            $seen[$key] = $true
        }
        $out.Add($line)
    }

    if ($removed -gt 0) {
        Copy-Item -LiteralPath $wsPath -Destination "$wsPath.bak-dupkeys" -Force
        $next = ($out -join "`n").TrimEnd() + "`n"
        [System.IO.File]::WriteAllText($wsPath, $next, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "已修复 pnpm-workspace.yaml 重复/损坏键（$removed 处）"
    }
}

# ---------- [0] 解析目标 DSH 数据目录 ----------
Write-Host "`n====================" -ForegroundColor Cyan
Write-Host "  $pluginLabel v$pluginVersion 一键安装" -ForegroundColor Cyan
Write-Host "====================" -ForegroundColor Cyan

Write-Step '定位 DSH 数据目录'

$defaultHome = Join-Path $env:USERPROFILE '.dsh'
$targetHome = $null
if ($DshHome) {
    $targetHome = [System.IO.Path]::GetFullPath($DshHome.Trim('"'))
} elseif ($env:DSH_HOME -and $env:DSH_HOME.Trim()) {
    $targetHome = [System.IO.Path]::GetFullPath($env:DSH_HOME.Trim('"'))
} else {
    $targetHome = $defaultHome
}
$targetHome = $targetHome.TrimEnd('\')

if (-not (Test-Path -LiteralPath $targetHome -PathType Container)) {
    Write-Err "DSH 数据目录不存在：$targetHome"
    Write-Host '  请先启动一次目标 DSH 实例（隔离实例用启动器启动一次），再运行本安装器。' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $targetHome 'profiles') -PathType Container)) {
    Write-Err "目录里没有 profiles 子目录：$targetHome"
    Write-Host '  请确认这是 DSH 数据目录（$DSH_HOME），或先启动一次 DSH。' -ForegroundColor Red
    exit 1
}
Write-Ok "目标数据目录：$targetHome"
if ($targetHome -ne $defaultHome.TrimEnd('\')) {
    Write-Ok "隔离模式：默认目录 $defaultHome 不会被修改"
}

# ---------- [1] 选择 profile ----------
Write-Step '选择 profile'

$profilesRoot = Join-Path $targetHome 'profiles'
$allDirs = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'node_modules' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'package.json')) })
if ($allDirs.Count -eq 0) {
    Write-Err "未找到任何 profile（$profilesRoot 下没有含 package.json 的目录）。"
    Write-Host '  请先启动一次目标 DSH 实例，让它生成 profile。' -ForegroundColor Red
    exit 1
}

function Test-DshProfile {
    param([string]$Dir)
    try {
        $json = Get-Content -LiteralPath (Join-Path $Dir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        return ($null -ne $json.dsh -and $null -ne $json.dsh.profile)
    } catch { return $false }
}

$profileDirs = @()
if ($Profile -and $Profile.Count -gt 0) {
    foreach ($want in $Profile) {
        $hit = $allDirs | Where-Object { $_.Name -ieq $want } | Select-Object -First 1
        if ($hit) { $profileDirs += $hit.FullName }
        else { Write-Warn "profile 不存在：$want（已跳过）" }
    }
} elseif ($AllProfiles) {
    $profileDirs = @($allDirs | ForEach-Object { $_.FullName })
} else {
    $preferred = @()
    foreach ($name in @('desktop', 'web', 'default', 'tui')) {
        $hit = $allDirs | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
        if ($hit) { $preferred += $hit.FullName }
    }
    if ($preferred.Count -gt 0) {
        $profileDirs = $preferred
    } elseif ($allDirs.Count -eq 1) {
        $profileDirs = @($allDirs[0].FullName)
    } else {
        Write-Host '检测到多个 DSH profile，请选择要安装的目标：' -ForegroundColor Yellow
        for ($i = 0; $i -lt $allDirs.Count; $i++) {
            Write-Host "  [$($i + 1)] $($allDirs[$i].Name)  ($($allDirs[$i].FullName))" -ForegroundColor White
        }
        try {
            $sel = Read-Host '请输入序号（回车=全部）'
            if ([string]::IsNullOrWhiteSpace($sel)) {
                $profileDirs = @($allDirs | ForEach-Object { $_.FullName })
            } else {
                $idx = [int]$sel - 1
                if ($idx -ge 0 -and $idx -lt $allDirs.Count) { $profileDirs = @($allDirs[$idx].FullName) }
            }
        } catch { }
        if ($profileDirs.Count -eq 0) { Write-Err '选择无效，退出。'; exit 1 }
    }
}

if ($profileDirs.Count -eq 0) { Write-Err '没有可安装的 profile，退出。'; exit 1 }
foreach ($pDir in $profileDirs) {
    $flag = ''
    if (-not (Test-DshProfile $pDir)) { $flag = '（不是标准 dsh profile，跳过）' }
    Write-Ok "$(Split-Path $pDir -Leaf)  ->  $pDir $flag"
}
$profileDirs = @($profileDirs | Where-Object { Test-DshProfile $_ })
if ($profileDirs.Count -eq 0) { Write-Err '选中的目录都不是标准 dsh profile，退出。'; exit 1 }

# ---------- [2] 检查安装包完整性 ----------
Write-Step '检查安装包'
$required = @(
    'package.json', 'index.js', 'client.js', 'cordis.patch.yml',
    'scripts\lib\compat.js', 'scripts\lib\migrate.js', 'prompts\fujiang.md', 'prompts\fujiang-mirror.md'
)
foreach ($relativeFile in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $srcDir $relativeFile) -PathType Leaf)) {
        Write-Err "安装包缺少文件：$relativeFile。请完整解压后再运行，不要只复制 BAT 文件。"
        exit 1
    }
}
Write-Ok "安装包完整（$($required.Count) 个必需文件）"

# ---------- [3] 运行环境 ----------
Write-Step '准备运行环境'

# 桌面版自带 Node 24 / pnpm 11（位于 $DSH_HOME\dsh-runtimes），优先复用，避免联网下载。
$nodeBin = $null
$pnpmCmd = $null
$runtimeRoot = Join-Path $targetHome 'dsh-runtimes'
$runtimeRoots = @($runtimeRoot, (Join-Path $defaultHome 'dsh-runtimes'))
foreach ($candidateRoot in $runtimeRoots) {
    if (-not (Test-Path -LiteralPath $candidateRoot)) { continue }
    $runtimeDirs = @(Get-ChildItem -LiteralPath $candidateRoot -Directory -Force -ErrorAction SilentlyContinue)
    foreach ($rd in $runtimeDirs) {
        $candidate = Join-Path $rd.FullName 'dependencies\node\bin\node.exe'
        if (-not $nodeBin -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $nodeBin = $candidate }
    }
    foreach ($rd in $runtimeDirs) {
        $candidate = Join-Path $rd.FullName 'dependencies\pnpm\bin\pnpm.mjs'
        if (-not $pnpmCmd -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $pnpmCmd = $candidate }
    }
}
if ($nodeBin) {
    Write-Ok "复用 DSH 自带 Node：$nodeBin"
} else {
    # 上一次安装下载过的运行时
    $armorRuntime = Join-Path $env:LOCALAPPDATA 'FujiangArmor\runtime'
    if (Test-Path -LiteralPath $armorRuntime) {
        foreach ($rd in @(Get-ChildItem -LiteralPath $armorRuntime -Directory -Force -ErrorAction SilentlyContinue)) {
            $candidate = Join-Path $rd.FullName 'node.exe'
            if (-not $nodeBin -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $nodeBin = $candidate }
        }
    }
    if ($nodeBin) { Write-Ok "复用已就绪的 Node：$nodeBin" }
}
if (-not $nodeBin) {
    try {
        . (Join-Path $srcDir 'scripts\ensure-runtime.ps1')
        $runtime = Ensure-FujiangRuntime
        $nodeBin = $runtime.NodePath
        $pnpmCmd = $runtime.PnpmPath
        Write-Ok "运行环境已就绪：$nodeBin"
    } catch {
        Write-Err "运行环境准备失败：$($_.Exception.Message)"
        exit 1
    }
}
if ($pnpmCmd) { Write-Ok "pnpm：$pnpmCmd" } else { Write-Warn '未找到 pnpm，将跳过依赖安装（Junction 链接已足够加载插件）' }

# ---------- [4] 版本探测 ----------
Write-Step '探测 DSH 版本'
$compatJs = Join-Path $srcDir 'scripts\lib\compat.js'
$version = $null
try {
    $check = Invoke-Compat -Node $nodeBin -Arguments @($compatJs, 'check', $targetHome)
    if ($check.Data) { $version = $check.Data.version }
} catch { Write-Warn "版本探测失败：$($_.Exception.Message)" }

if ($version) {
    Write-Ok "DSH 版本：$version"
    $major = ($version -split '\.')[0]
    $minor = 0
    if (($version -split '\.').Count -gt 1) { $minor = [int](($version -split '\.')[1] -replace '[^0-9].*$','') }
    if ($major -eq '0' -and $minor -lt 2) {
        Write-Warn "检测到 DSH $version（0.2 之前）：本版插件面向 0.2.x 提示词段接口，请改用 0.4.x 插件。"
    } elseif ($major -eq '0' -and $minor -eq 2 -and $version -match '0\.2\.2') {
        Write-Ok '0.2.2 系列：已按新规则处理 personaSuffix 与 interpolate:false'
    }
} else {
    Write-Warn '无法确定 DSH 版本（可能尚未启动过该实例），按最新版规则安装'
}

# ---------- [5] 复制插件 ----------
Write-Step '复制插件文件'
$pluginsDir = Join-Path $targetHome 'plugins'
$destDir = Join-Path $pluginsDir $pluginName
if (-not (Test-Path -LiteralPath $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null }
if (Test-Path -LiteralPath $destDir) {
    Write-Warn "已存在 $destDir，覆盖更新"
    Remove-Item -LiteralPath $destDir -Recurse -Force
}
robocopy $srcDir $destDir /E /NFL /NDL /NJH /NJS /NC /NS /XD .git .fujiang-inspect /XF install.ps1 uninstall.ps1 install.sh uninstall.sh *.bat | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Err "复制失败（robocopy 退出码 $LASTEXITCODE）"; exit 1 }
Write-Ok "插件已复制到：$destDir"

# ---------- [6] 挂载到 profile（版本自适应） ----------
Write-Step '写入 profile 挂载'
$mount = Invoke-Compat -Node $nodeBin -Arguments (@($compatJs, 'mount', $targetHome) + $profileDirs + @('--mode', $InjectionMode))
if ($mount.ExitCode -ne 0) {
    Write-Err "挂载失败：$($mount.Output)"
    exit 1
}
if ($mount.Data) {
    foreach ($report in $mount.Data.profiles) {
        $name = Split-Path $report.profileDir -Leaf
        if ($report.cwdRemoved -and $report.cwdRemoved.Count -gt 0) {
            Write-Ok "[$name] 已清除失效的 {{cwd}} persona 子句（0.2.2 起会导致提示词组装失败）"
        }
        if ($report.changed) { Write-Ok "[$name] cordis.patch.yml 已更新（$($report.actions -join ', ')）" }
        else { Write-Ok "[$name] cordis.patch.yml 已是最新，无需改动" }
    }
    Write-Ok "注入模式：$($mount.Data.injectionMode)"
    foreach ($warning in $mount.Data.warnings) { Write-Warn $warning }
    if ($mount.Data.homePatch) { Write-Ok "已修复 home 级补丁中的 {{cwd}}：$($mount.Data.homePatch.file)" }
} else {
    Write-Warn '挂载已执行（退出码 0），但结果文件无法解析；不影响挂载本身'
}

# ---------- [7] 依赖与 node_modules ----------
Write-Step '写入依赖声明'
$link = Invoke-Compat -Node $nodeBin -Arguments (@($compatJs, 'link', $targetHome, "file:../../plugins/$pluginName") + $profileDirs)
if ($link.ExitCode -ne 0) {
    Write-Err "依赖写入失败：$($link.Output)"
    exit 1
}
if ($link.Data) {
    foreach ($report in $link.Data.profiles) {
        $name = Split-Path $report.profileDir -Leaf
        if ($report.dependency.changed) { Write-Ok "[$name] dependencies += $pluginName" }
        if ($report.bundles.changed) { Write-Ok "[$name] 已从 dsh.profile.bundles 移除同名项（避免重复挂载）" }
    }
} else {
    Write-Warn '依赖声明已写入（退出码 0），但结果文件无法解析；不影响依赖本身'
}

function Set-PluginJunction {
    param([string]$ProfileDir, [string]$Target)
    $nmDir = Join-Path $ProfileDir 'node_modules'
    if (-not (Test-Path -LiteralPath $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }
    $entry = Join-Path $nmDir $pluginName
    if (Test-Path -LiteralPath $entry) {
        $item = Get-Item -LiteralPath $entry -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            cmd.exe /c "rmdir `"$entry`"" 2>$null | Out-Null
        } else {
            Remove-Item -LiteralPath $entry -Recurse -Force
        }
    }
    cmd.exe /c "mklink /J `"$entry`" `"$Target`"" 2>$null | Out-Null
    return (Test-Path -LiteralPath $entry)
}

foreach ($pDir in $profileDirs) {
    $pName = Split-Path $pDir -Leaf
    Repair-PnpmWorkspaceConfig -ProfileDir $pDir

    # 先让 pnpm 同步依赖（会写入 lockfile 与 node_modules 副本）
    $pnpmOk = $false
    if (-not $SkipPnpmInstall -and $pnpmCmd) {
        Write-Host "  -> [$pName] pnpm install" -ForegroundColor White
        Push-Location $pDir
        try {
            if ($pnpmCmd -like '*.mjs') { & $nodeBin $pnpmCmd install }
            else { & $pnpmCmd install }
            if ($LASTEXITCODE -ne 0) { throw "pnpm 退出码 $LASTEXITCODE" }
            $pnpmOk = $true
            Write-Ok "[$pName] 依赖安装完成"
        } catch {
            Write-Warn "[$pName] pnpm install 未完成：$($_.Exception.Message)"
        } finally {
            Pop-Location
        }
    } elseif ($SkipPnpmInstall) {
        Write-Warn "[$pName] 已按参数跳过 pnpm install"
    }

    # 再把 node_modules 里的插件替换成指向 plugins 目录的实时链接，
    # 这样更新插件目录即刻生效（pnpm 后续 install 会保留该链接）。
    if (Set-PluginJunction -ProfileDir $pDir -Target $destDir) {
        Write-Ok "[$pName] node_modules\fujiang-armor 已链接到插件目录"
    } elseif ($pnpmOk) {
        Write-Warn "[$pName] 链接创建失败，使用 pnpm 写入的副本（功能等价，但改动需重装生效）"
    } else {
        Write-Err "[$pName] 既无法建立链接也没有完成 pnpm install，插件可能无法加载"
    }
}

# ---------- [8] 完成 ----------
Write-Step '安装完成'
Write-Host ''
Write-Host "  $pluginLabel v$pluginVersion 已安装到：" -ForegroundColor Green
Write-Host "    数据目录：$targetHome" -ForegroundColor White
Write-Host "    profile ：$((($profileDirs | ForEach-Object { Split-Path $_ -Leaf }) -join ', '))" -ForegroundColor White
Write-Host "    注入模式：$InjectionMode" -ForegroundColor White
Write-Host "    插件目录：$destDir" -ForegroundColor White
Write-Host ''
Write-Host '  最后一步：完全退出并重启该 DSH 实例，新建会话即可生效。' -ForegroundColor White
Write-Host '  验证方法：输入框上方应显示绿色状态条「富江破甲已激活」。' -ForegroundColor Yellow
Write-Host ''

try { if (-not $env:DSH_INSTALL_NO_PAUSE) { Read-Host '按回车键退出' } } catch { }
exit 0
