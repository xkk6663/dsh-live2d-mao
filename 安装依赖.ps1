# ============================================================
#  Mio 桌宠 · 一键安装依赖（发布版用户运行）
#  用法: 右键“使用 PowerShell 运行”，或:
#        pwsh -NoProfile -ExecutionPolicy Bypass -File 安装依赖.ps1
#  作用: 1) 检测 Python / Node 环境
#        2) 创建后端虚拟环境并安装 Python 依赖
#        3) 安装 Electron 桌宠运行时 (npm install)
#  说明: 需要联网（首次下载 Electron ~100MB）；耗时数分钟
# ============================================================
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Say($msg, $color = 'Cyan') { Write-Host $msg -ForegroundColor $color }

Say '========== Mio 桌宠 · 依赖安装 =========='

# ---------- 1) 环境检测 ----------
Say '[1/4] 检测环境...'
$py = $null
foreach ($c in @('python', 'py')) {
    try { $v = & $c --version 2>$null; if ($v -match 'Python 3\.(1[0-9]|[2-9][0-9])') { $py = $c; break } } catch {}
}
if (-not $py) {
    Write-Host '未检测到 Python 3.10+，请先安装 Python: https://www.python.org/downloads/' -ForegroundColor Red
    Write-Host '（安装时务必勾选 Add python.exe to PATH）' -ForegroundColor Yellow
    Read-Host '按回车退出'
    exit 1
}
Say "       Python: $((& $py --version 2>$null))"

$npm = $null
foreach ($c in @('npm', 'node')) {
    try { $v = & $c --version 2>$null; if ($v) { $npm = $c; break } } catch {}
}
if (-not $npm) {
    Write-Host '未检测到 Node.js 22+（Electron 桌宠需要），请先安装: https://nodejs.org/' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}
$nodeVer = & node --version 2>$null
Say "       Node: $nodeVer"

# ---------- 2) 后端虚拟环境 ----------
$venvPy = Join-Path $root '私人AI日记系统\backend\.venv\Scripts\python.exe'
$reqTxt = Join-Path $root '私人AI日记系统\backend\requirements.txt'

if (Test-Path $venvPy) {
    Say '[2/4] 后端虚拟环境已存在，跳过创建'
} else {
    Say '[2/4] 创建后端虚拟环境...'
    Push-Location (Join-Path $root '私人AI日记系统\backend')
    try {
        & $py -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'venv 创建失败' }
        Say '       安装 Python 依赖（pip install -r requirements.txt）...'
        & .\.venv\Scripts\python.exe -m pip install --upgrade pip --quiet
        & .\.venv\Scripts\python.exe -m pip install -r requirements.txt
        if ($LASTEXITCODE -ne 0) { throw 'pip install 失败' }
    } finally { Pop-Location }
    Say '       后端依赖安装完成'
}

# ---------- 3) Electron 运行时 ----------
$l2dDir = Join-Path $root '澪Agent应用\live2d-desktop'
$electronExe = Join-Path $l2dDir 'node_modules\electron\dist\electron.exe'
if (Test-Path $electronExe) {
    Say '[3/4] Electron 桌宠运行时已存在，跳过'
} else {
    Say '[3/4] 安装 Electron 桌宠运行时（npm install，首次约 100MB）...'
    Push-Location $l2dDir
    try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
    } finally { Pop-Location }
    Say '       Electron 安装完成'
}

# ---------- 4) 完成 ----------
Say '[4/4] 依赖安装完成！'
Say '现在可以运行 start_mio.ps1 启动桌宠。'
Say 'DSH 专用版：桌宠状态由本机 DSH 插件线驱动（见 docs/DSH专用化阉割计划.md）。'
Read-Host '按回车退出'
