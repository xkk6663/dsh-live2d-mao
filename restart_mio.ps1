# ============================================================
#  Mio 桌宠 重启后端 + 一键拉起（后端 + Electron 桌宠）
#
#  用法: pwsh -NoProfile -ExecutionPolicy Bypass -File restart_mio.ps1
#        pwsh ... -File restart_mio.ps1 -SkipPet      # 只重启后端，不动桌宠
#
#  与 start_mio.ps1 的区别：
#    start_mio.ps1 是**幂等启动**（已在跑就跳过），用于日常开机；
#    本脚本会**先停掉旧后端再拉起**——改过后端代码（新增路由/改逻辑）后
#    必须重启才生效，否则你会对着旧进程调试、看到 404 以为是代码没写对。
#
#  安全性（重要）：
#    - **只杀监听 8000 端口的那个进程**，不按进程名批量杀 python
#      （机器上可能还有别的 python 在跑，批量杀会误伤）。
#    - 杀之前会打印它的 PID / 路径 / 启动时间，让你看见杀的是谁。
#    - 默认**不动 Electron 桌宠**（它在跑就跳过）——重启后端会短暂断开
#      WS，桌宠会自动重连，不需要重启窗口，避免打断正在看的东西。
#
#  日志: <项目根>\start_mio.log（与 start_mio.ps1 共用，便于对照）
# ============================================================
param(
    # 只重启后端，跳过桌宠那一步
    [switch]$SkipPet,
    # 强制重启桌宠（即使已在运行）。改过 main.js / preload.js（Electron 外壳）
    # 后必须用它，否则运行中的旧外壳不会加载新代码。
    [switch]$ForcePet,
    # 等待后端就绪的最长秒数（默认 30，venv 兜底会再等 20）
    [int]$ReadyTimeoutSec = 30
)

$ErrorActionPreference = 'Stop'

# ★ 关键（2026-10-17 真根因）：DSH 宿主进程以 ELECTRON_RUN_AS_NODE=1 运行，
#   这个环境变量会**继承**给本脚本再传给 electron.exe，导致 electron 退化成
#   node 模式 —— 表现为 `bad option: --no-sandbox`、`require('electron')` 为空、
#   `app.setName` 报 undefined，桌宠窗口秒崩起不来。
#   必须在拉起 electron 前清掉它（只影响本脚本进程树，不动宿主）。
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_RUN_AS_NODE = $null

$root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }

$backendPy   = Join-Path $root '私人AI日记系统\backend\.venv\Scripts\python.exe'
$backendDir  = Join-Path $root '私人AI日记系统\backend'
$outLog      = Join-Path $root 'backend_out.log'
$errLog      = Join-Path $root 'backend_err.log'
$startLog    = Join-Path $root 'start_mio.log'

# ────────────────────────────────────────────────────────────────────────────
#  Electron 桌宠外壳的定位
# ────────────────────────────────────────────────────────────────────────────
#  ★ 2026-10-18 独立性改造：本项目**完全独立**，不依赖任何其它仓库/项目。
#    原实现会去同级 `../Mao` 目录找 electron.exe 与 pet-instance —— 那是开发期便利，
#    却让"单独 clone 本仓库"跑不起来（没有 Mao 目录就找不到 electron）。
#    现在只认**本仓库内**与**标准安装位置**。
#
#  桌宠运行时由两部分组成，都必须来自本仓库：
#    1) Electron **外壳**（main.js/preload 等，来自 live2d-desktop/）
#    2) **页面内容** /agent-app/live2d-pet/* —— 由**后端**静态托管
$electronCandidates = @()
if ($env:MIO_ELECTRON_EXE) { $electronCandidates += $env:MIO_ELECTRON_EXE }
$electronCandidates += @(
    (Join-Path $root '澪Agent应用\live2d-desktop\node_modules\electron\dist\electron.exe'),
    (Join-Path $root '澪Agent应用\node_modules\electron\dist\electron.exe'),
    (Join-Path $env:APPDATA 'npm\node_modules\electron\dist\electron.exe'),
    (Join-Path $env:LOCALAPPDATA 'pnpm\global\5\node_modules\electron\dist\electron.exe')
)
$electronExe = $null
foreach ($cand in $electronCandidates) {
    if ($cand -and (Test-Path $cand)) { $electronExe = $cand; break }
}
if (-not $electronExe) {
    Write-Host '  ❌ 找不到 electron.exe。请先安装桌宠外壳依赖：' -ForegroundColor Red
    Write-Host '     cd 澪Agent应用\live2d-desktop' -ForegroundColor Yellow
    Write-Host '     npm ci' -ForegroundColor Yellow
    Write-Host '     （或用环境变量 MIO_ELECTRON_EXE 显式指定）' -ForegroundColor Yellow
    exit 1
}
Write-Host "  electron: $electronExe"
# electron.exe -> dist -> electron -> node_modules -> live2d-desktop（即工作目录）
#
# ★ 关键修正（2026-10-17）：Electron **工作目录决定它加载哪份 main.js/preload.js**。
#   之前的逻辑把工作目录设成"electron.exe 所在仓库的 live2d-desktop"，于是当本仓库
#   node_modules 缺失、electron.exe 回落到 Mao 主仓库时，外壳跑的是 **Mao 的 main.js**
#   —— Mao 的 main.js 没有本仓库的横条区域命中 / 双击 DSH / strip-bounds 等改动，
#   表现为"双击没反应、要右键才能拖/关"。
#   修正：electron.exe 二进制可以复用 Mao 的（node_modules 没进版本库），但**工作目录
#   必须固定指向本仓库的 live2d-desktop**，让 main.js/preload.js 一定用本仓库那份。
$electronWorkDir = Join-Path $root '澪Agent应用\live2d-desktop'
if (-not (Test-Path (Join-Path $electronWorkDir 'main.js'))) {
    # 兜底：本仓库 live2d-desktop 不存在时再回落（理论上不该发生）
    if ($electronExe) {
        $d = Split-Path -Parent $electronExe   # dist
        $d = Split-Path -Parent $d             # electron
        $d = Split-Path -Parent $d             # node_modules
        $electronWorkDir = Split-Path -Parent $d
    }
}

# electron userData 锁目录：**只在本仓库内**（pet-data\pet-instance），不可写则退到用户 Temp。
# 原实现强制复用同级 Mao 仓库的目录（跨仓库依赖），已删除。
# 目录存在 ≠ 能写（AppContainer capability 情形会 Error 5），故实际写探测文件确认。
$stateDir = Join-Path $root 'pet-data\Live2D桌宠'
$instanceCandidates = @(
    (Join-Path $root 'pet-data\pet-instance'),
    (Join-Path $env:TEMP 'mao-pet-instance')
)
$env:MIO_PET_INSTANCE_DIR = ''
foreach ($dir in $instanceCandidates) {
    if (-not $dir) { continue }
    try {
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null }
        $probe = Join-Path $dir ('.write-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
        Set-Content -Path $probe -Value 'ok' -ErrorAction Stop
        Remove-Item $probe -Force -ErrorAction SilentlyContinue
        $env:MIO_PET_INSTANCE_DIR = $dir
        Write-Host "  instance: $dir"
        break
    } catch {
        Write-Host "  instance 不可写，尝试下一个：$dir"
    }
}
if (-not $env:MIO_PET_INSTANCE_DIR) {
    Write-Host '  ⚠ 没有可写的 pet-instance 目录，桌宠可能无法启动' -ForegroundColor Yellow
}
$env:MIO_PET_STATE_DIR = $stateDir

# 就绪探测用 /api/companion/agents（纯读总线，稳定）；
# 不用 /api/companion/status —— 它依赖 Live2D 资源与磁盘写入，
# 资源异常时返回 500 会让脚本误判"后端未运行"而重复拉起。
$healthUrl = 'http://127.0.0.1:8000/api/companion/agents'
# 本次改动新增的路由：就绪后**逐个确认存在**，否则等于白重启。
$requiredRoutes = @(
    '/api/plugin/dsh/ingest',
    '/api/plugin/dsh/strip',
    '/api/plugin/dsh/agent'
)

function Write-Step($msg) {
    Write-Host $msg -ForegroundColor Cyan
    try { Add-Content -Path $startLog -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) -Encoding utf8 } catch {}
}
function Write-Warn2($msg) {
    Write-Host $msg -ForegroundColor Yellow
    try { Add-Content -Path $startLog -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) -Encoding utf8 } catch {}
}
function Write-Ok($msg) {
    Write-Host $msg -ForegroundColor Green
    try { Add-Content -Path $startLog -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) -Encoding utf8 } catch {}
}

# 杀掉一棵进程树。
#
# 为什么不能只 `Stop-Process -Id`：Windows 上 `python.exe`（尤其 venv 的启动器
# 与 `Start-Process` 起的那个）常会再 spawn 一个**子进程**来真正干活。
# 只杀父进程会留下**孤儿子进程继续占着 8000 端口** —— 新后端起不来，
# 而且每跑一次脚本就多留一个（实测踩到：shim 43500 已失效，
# 其子进程 47436 才是真正监听的）。
#
# 故优先用 `taskkill /T`（连子树一起杀），不可用时回落到逐个终止子进程。
function Stop-Tree($processId) {
    if (-not $processId) { return }
    # 先收集子进程（taskkill 不可用时的兜底顺序：先子后父）
    $children = @()
    try {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty ProcessId)
    } catch {}

    try {
        $null = & taskkill.exe /PID $processId /T /F 2>&1
        return
    } catch {}

    foreach ($childPid in $children) {
        try { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue } catch {}
    }
    try { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } catch {}
}

# 用 WMI 启动（父进程=WmiPrvSE 系统服务）：彻底脱离脚本进程树，
# 关闭/杀掉启动终端、父脚本均不影响该进程存活
function Start-Wmi($exe, $argList, $workdir) {
    $cmdline = '"' + $exe + '" ' + $argList
    # ★ 环境变量透传（2026-10-17）：WMI Create 不继承调用 shell 的 $env: 修改，
    #   故把关键环境变量经 cmd /c "set ... && " 前缀显式注入，确保 electron
    #   子进程拿到 MIO_PET_INSTANCE_DIR / MIO_PET_STATE_DIR（否则锁目录回落默认）。
    $envPrefix = ''
    foreach ($k in @('MIO_PET_INSTANCE_DIR', 'MIO_PET_STATE_DIR', 'MIO_PET_API_BASE')) {
        $v = [Environment]::GetEnvironmentVariable($k, 'Process')
        if ($v) { $envPrefix += "set $k=$v&& " }
    }
    if ($envPrefix) {
        $cmdline = 'cmd.exe /c "' + $envPrefix + $cmdline + '"'
    }
    try {
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine      = $cmdline
            CurrentDirectory = $workdir
        }
        if ($r.ReturnValue -eq 0) { return $r.ProcessId }
        Write-Warn2 "      WMI 启动返回 $($r.ReturnValue)，改用直接启动"
    } catch {
        Write-Warn2 "      WMI 启动失败: $($_.Exception.Message)，改用直接启动"
    }
    $proc = Start-Process -FilePath $exe -WorkingDirectory $workdir -WindowStyle Hidden -PassThru
    return $proc.Id
}

Write-Step '========== Mio 桌宠 重启后端 =========='

# ---------- 0) 找到监听 8000 的进程 ----------
# 只认"确实在监听 8000"的进程，避免误伤其它 python。
$targets = @()
try {
    $conns = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and ($targets -notcontains $proc.Id)) { $targets += $proc.Id }
    }
} catch {
    Write-Warn2 "      Get-NetTCPConnection 不可用：$($_.Exception.Message)"
}

if ($targets.Count -eq 0) {
    Write-Step '[1/4] 没有进程在监听 8000，无需停止'
} else {
    Write-Step "[1/4] 停止占用 8000 的旧后端（$($targets.Count) 个）..."
    foreach ($pid_ in $targets) {
        $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        # 把"杀的是谁"打出来 —— 这类误杀最难查，必须可见
        $cmd = ''
        try {
            $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$pid_" -ErrorAction SilentlyContinue
            if ($ci) { $cmd = $ci.CommandLine }
        } catch {}
        Write-Host ("      - PID {0}  {1}  启动于 {2}" -f $proc.Id, $proc.ProcessName, $proc.StartTime) -ForegroundColor DarkGray
        if ($cmd) { Write-Host ("        {0}" -f $cmd) -ForegroundColor DarkGray }
        # 用 Stop-Tree 而非单杀：后端的真实解释器常是"启动器 shim 的子进程"，
        # 只杀父会留下孤儿子进程继续占着 8000（详见 Stop-Tree 上方注释）。
        Stop-Tree $pid_
        Start-Sleep -Milliseconds 300
        if (Get-Process -Id $pid_ -ErrorAction SilentlyContinue) {
            Write-Warn2 '        停止失败（进程仍在）'
        } else {
            Write-Host "        已停止" -ForegroundColor DarkGray
        }
    }
    # 等端口真正释放（否则新进程会 "address already in use"）
    $freed = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 400
        $still = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
        if (-not $still) { $freed = $true; break }
    }
    if ($freed) { Write-Step '      端口 8000 已释放' }
    else { Write-Warn2 '      端口 8000 仍被占用，新后端可能起不来（可稍后重跑本脚本）' }
}

# ---------- 1) 拉起后端 ----------
$petStateDir = Join-Path $root 'pet-data\Live2D桌宠'
Write-Step '[2/4] 启动后端 (uvicorn :8000)...'

# 启动前轮转一次日志：旧后端可能已把 out/err 写得很长，
# 追加模式下"本次启动的日志"会被埋在末尾，排障时容易看错。
foreach ($f in @($outLog, $errLog)) {
    try {
        if (Test-Path $f) {
            $bak = "$f.prev"
            if (Test-Path $bak) { Remove-Item $bak -Force -ErrorAction SilentlyContinue }
            Move-Item $f $bak -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

# MIO_PET_STATE_DIR：与 Electron main.js 同一个变量，指向完整的
# "Live2D桌宠" 目录（Electron 直接当 STATE_DIR 用，不再拼子目录）。
$env:MIO_PET_STATE_DIR = $petStateDir

# 用 Start-Process 文件重定向（不用 .NET 管道：uvicorn 日志多时管道缓冲满会卡死后端）
# -u: python 无缓冲，日志实时落盘便于排查
$p = Start-Process -FilePath $backendPy `
    -ArgumentList '-u', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000' `
    -WorkingDirectory $backendDir -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
Write-Step "      已启动 (pid=$($p.Id))，数据目录=$petStateDir，等待就绪..."

$ready = $false
for ($i = 0; $i -lt $ReadyTimeoutSec; $i++) {
    Start-Sleep -Milliseconds 1000
    try { $null = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1; $ready = $true; break } catch {}
}

# venv 兜底：venv launcher 在含中文的路径下可能读不了 pyvenv.cfg（窄字符 API
# 按 ANSI 编码解析），导致起的是"裸系统 Python"（没有 fastapi）直接退出。
# 就绪失败时改用系统 Python + venv site-packages（PYTHONPATH）重拉一次。
#
# ⚠ 杀进程必须**连子进程一起**（本次实测踩到的坑）：
#   `Start-Process` 返回的是 **venv 的 python.exe 启动器 shim**，它自己会再
#   spawn 一个真正的解释器作为**子进程**。只 `Stop-Process -Id $p.Id` 杀掉 shim，
#   子进程会变成孤儿并**继续占着 8000 端口** —— 于是"兜底"那个进程反而起不来，
#   而且每跑一次脚本就多留一个孤儿。
#   实测证据：shim PID 43500（已失效）→ 子进程 47436 才是真正监听的进程。
#   故这里用 taskkill /T（杀整棵进程树）兜住这种情况。
if (-not $ready) {
    Write-Warn2 '      venv 启动未就绪，改用系统 Python + venv site-packages 兜底...'
    Stop-Tree $p.Id
    $systemPy = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
    if (-not (Test-Path $systemPy)) { $systemPy = 'python.exe' }
    $env:PYTHONPATH = Join-Path $backendDir '.venv\Lib\site-packages'
    $p = Start-Process -FilePath $systemPy `
        -ArgumentList '-u', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000' `
        -WorkingDirectory $backendDir -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    Write-Step "      兜底已启动 (pid=$($p.Id))，继续等待就绪..."
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 1000
        try { $null = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1; $ready = $true; break } catch {}
    }
}

if ($ready) { Write-Ok '      后端就绪 OK' }
else { Write-Warn2 '      后端启动超时，请查看 backend_err.log' }

# ---------- 2) 确认新路由真的在（重启的唯一目的） ----------
Write-Step '[3/4] 校验本次改动的新路由...'
$missing = @()
if ($ready) {
    foreach ($route in $requiredRoutes) {
        try {
            # 用 POST（这些是写端点）；404 才是"路由不存在"，
            # 400/403/422 都说明**路由在**（只是参数/来源不合规）——那也算通过。
            $code = 0
            try {
                $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:8000" + $route) -Method POST `
                    -ContentType 'application/json' -Body '{}' -TimeoutSec 3 -UseBasicParsing
                $code = [int]$resp.StatusCode
            } catch {
                $code = [int]$_.Exception.Response.StatusCode.value__
            }
            if ($code -eq 404) {
                $missing += $route
                Write-Warn2 "      $route -> 404（未生效）"
            } else {
                Write-Ok "      $route -> $code（路由已在）"
            }
        } catch {
            Write-Warn2 "      $route -> 探测失败：$($_.Exception.Message)"
        }
    }
    if ($missing.Count -eq 0) { Write-Ok '      新路由全部就绪' }
    else { Write-Warn2 '      有路由缺失 —— 确认拉起的后端是本仓库的代码（见 backend_err.log）' }

    # 顺带确认"后端托管的是本仓库的页面内容"——这是本次改动能否生效的**真正关键**。
    # 桌宠页面 /agent-app/live2d-pet/index.html 由后端静态托管：
    # **后端在哪个仓库，页面就用哪个仓库的 dist**。若这里拿到的是旧页面
    # （没有 pet-strip 元素 / 没有 stream-bubble 按钮），说明后端仍是别的仓库的代码。
    try {
        $page = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/agent-app/live2d-pet/index.html' `
            -TimeoutSec 5 -UseBasicParsing
        $hasStrip = $page.Content -match 'pet-strip'
        $hasStreamBtn = $page.Content -match 'stream-bubble'
        if ($hasStrip -and $hasStreamBtn) {
            Write-Ok '      页面内容是本次改动版（含 pet-strip 横条 + stream-bubble 按钮）'
        } else {
            Write-Warn2 '      ⚠ 页面内容**不含**本次改动（缺 pet-strip 或 stream-bubble）'
            Write-Warn2 "         pet-strip=$hasStrip  stream-bubble=$hasStreamBtn"
            Write-Warn2 '         多半是：后端仍在跑别的仓库的代码，或静态目录指向了别处'
        }
    } catch {
        Write-Warn2 "      页面内容校验跳过：$($_.Exception.Message)"
    }
} else {
    Write-Warn2 '      后端未就绪，跳过路由校验'
}

# ---------- 3) Electron 桌宠 ----------
if ($SkipPet) {
    Write-Step '[4/4] -SkipPet：不动桌宠'
} else {
    $electronRunning = [bool](Get-Process -Name electron -ErrorAction SilentlyContinue)
    if ($electronRunning -and -not $ForcePet) {
        # 有意**不重启**桌宠：重启后端只让 WS 短暂断开，桌宠会自动重连，
        # 重启窗口会打断用户正在看的东西（且窗口是用户手动起的）。
        Write-Step '[4/4] 桌宠已在运行，跳过（后端重启后它会自动重连 WS）'
        Write-Host '      提示：若要让页面内容用本次改动，请刷新桌宠窗口（Ctrl+R）或手动重开；' -ForegroundColor DarkGray
        Write-Host '            页面由后端静态托管，后端已换成新仓库，但旧页面仍在内存里。' -ForegroundColor DarkGray
        Write-Host '      ⚠ 若改动的是 Electron 外壳（main.js/preload.js），刷新无效，' -ForegroundColor Yellow
        Write-Host '        必须加 -ForcePet 重启：pwsh ... restart_mio.ps1 -ForcePet' -ForegroundColor Yellow
    } elseif ($electronRunning -and $ForcePet) {
        Write-Step '[4/4] -ForcePet：强制重启桌宠外壳（加载新 main.js/preload.js）'
        # 关掉所有 electron 桌宠窗口（Mao 与本仓库共用的外壳都属桌宠，安全杀掉）
        Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
        if ($electronExe -and (Test-Path $electronExe) -and $electronWorkDir) {
            Write-Host "      外壳: $electronExe" -ForegroundColor DarkGray
            Write-Host "      工作目录: $electronWorkDir" -ForegroundColor DarkGray
            $petPid = Start-Wmi $electronExe '--no-sandbox .' $electronWorkDir
            Write-Step "      桌宠窗口已拉起 (pid=$petPid)，几秒内出现"
        } else {
            Write-Warn2 '      找不到 electron.exe 或本仓库 live2d-desktop'
        }
    } else {
        Write-Step '[4/4] 桌宠未运行，正在启动...'
        if ($electronExe -and (Test-Path $electronExe) -and $electronWorkDir) {
            Write-Host "      外壳: $electronExe" -ForegroundColor DarkGray
            # --no-sandbox: 当前系统（Win11 预览版 + 近期更新）Chromium 沙箱初始化崩溃，
            # 必须禁用沙箱才能启动
            $petPid = Start-Wmi $electronExe '--no-sandbox .' $electronWorkDir
            Write-Step "      桌宠窗口已拉起 (pid=$petPid)，几秒内出现"
        } else {
            Write-Warn2 '      找不到 electron.exe（本仓库 node_modules 被 gitignore，且未在 Mao 找到）'
            Write-Warn2 '      桌宠外壳需先安装：cd 澪Agent应用\live2d-desktop; npm ci'
        }
    }
}

Write-Step '========== 完成 =========='
# 强制退出：后台事件处理器会阻止脚本自然结束，
# 确保启动窗口立即关闭、不留窗口给用户误关
[Environment]::Exit(0)
