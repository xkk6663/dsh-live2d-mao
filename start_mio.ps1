# ============================================================
#  Mio 桌宠 一键启动脚本（后端 + Electron 桌宠）
#  用法: pwsh -NoProfile -ExecutionPolicy Bypass -File start_mio.ps1
#  幂等: 已在运行的服务会被跳过，不会重复启动
#  日志: C:\Users\xiao1\Mio\start_mio.log
#  说明: 所有子进程以 CreateNoWindow 启动（不附加控制台），
#        关闭启动终端不会影响桌宠/后端运行。
# ============================================================
$ErrorActionPreference = 'Stop'

# ★ 关键（2026-10-17 真根因）：DSH 宿主进程以 ELECTRON_RUN_AS_NODE=1 运行，
#   该环境变量会继承给 electron.exe 使其退化成 node 模式（桌宠秒崩）。
#   拉起 electron 前必须清掉（只影响本脚本进程树）。
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_RUN_AS_NODE = $null

# 发布版相对路径：脚本所在目录为项目根，可在任意位置解压运行
$root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($root)) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }

$backendPy      = Join-Path $root '私人AI日记系统\backend\.venv\Scripts\python.exe'
$backendDir     = Join-Path $root '私人AI日记系统\backend'
$electronExe    = Join-Path $root '澪Agent应用\live2d-desktop\node_modules\electron\dist\electron.exe'
$electronDir    = Join-Path $root '澪Agent应用\live2d-desktop'
$outLog         = Join-Path $root 'backend_out.log'
$errLog         = Join-Path $root 'backend_err.log'
$startLog       = Join-Path $root 'start_mio.log'

function Write-Step($msg) {
    Write-Host $msg -ForegroundColor Cyan
    Add-Content -Path $startLog -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) -Encoding utf8
}

# 启动完全脱离控制台的子进程（CreateNoWindow，不继承父控制台）
$script:detachedProcs = New-Object System.Collections.ArrayList
function Start-Detached($exe, $argList, $workdir, $stdoutLog, $stderrLog) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $exe
    $psi.Arguments = $argList
    $psi.WorkingDirectory = $workdir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    if ($stdoutLog) { $psi.RedirectStandardOutput = $true }
    if ($stderrLog) { $psi.RedirectStandardError = $true }
    $proc = [System.Diagnostics.Process]::Start($psi)
    if ($stdoutLog) {
        $proc.OutputDataReceived += {
            param($s, $e)
            if ($e.Data) { Add-Content -Path $stdoutLog -Value $e.Data -Encoding utf8 }
        }
        $proc.BeginOutputReadLine()
    }
    if ($stderrLog) {
        $proc.ErrorDataReceived += {
            param($s, $e)
            if ($e.Data) { Add-Content -Path $stderrLog -Value $e.Data -Encoding utf8 }
        }
        $proc.BeginErrorReadLine()
    }
    [void]$script:detachedProcs.Add($proc)
    return $proc
}

# 用 WMI 启动（父进程=WmiPrvSE 系统服务）：彻底脱离脚本进程树，
# 关闭/杀掉启动终端、父脚本均不影响该进程存活
function Start-Wmi($exe, $argList, $workdir) {
    $cmdline = '"' + $exe + '" ' + $argList
    # ★ 环境变量透传（2026-10-17）：WMI Create 不继承 $env: 修改，故经
    #   cmd /c "set ... && " 前缀显式注入 MIO_PET_INSTANCE_DIR / MIO_PET_STATE_DIR。
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
            CommandLine = $cmdline
            CurrentDirectory = $workdir
        }
        if ($r.ReturnValue -eq 0) { return $r.ProcessId }
        Write-Step "      WMI 启动返回 $($r.ReturnValue)，改用直接启动"
    } catch {
        Write-Step "      WMI 启动失败: $($_.Exception.Message)，改用直接启动"
    }
    $proc = Start-Process -FilePath $exe -WorkingDirectory $workdir -WindowStyle Hidden -PassThru
    return $proc.Id
}

Write-Step '========== Mio 桌宠启动 =========='

# ---------- 1) 后端 (uvicorn :8000) ----------
# 桌宠数据目录：后端与 Electron 必须解析到**同一个**目录，否则后端写的
# runtime.json（模型选择）与桌宠读的不是同一个文件 → 切角色"成功但无效"。
# 这里显式传入，避免两边各自推导出不同路径。
$petStateDir = Join-Path $root 'pet-data\Live2D桌宠'

# 就绪探测用 /api/companion/agents（纯读总线，稳定）；
# 不用 /api/companion/status —— 它依赖 Live2D 资源与磁盘写入，
# 资源异常时返回 500 会让脚本误判"后端未运行"而重复拉起。
$healthUrl = 'http://127.0.0.1:8000/api/companion/agents'
$backendUp = $false
try { $null = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2; $backendUp = $true } catch {}

if ($backendUp) {
    Write-Step '[1/2] 后端已在运行，跳过'
} else {
    Write-Step '[1/2] 后端未运行，正在启动...'
    # 用 Start-Process 文件重定向（不用 .NET 管道：uvicorn 日志多时管道缓冲满会卡死后端）
    # -u: python 无缓冲，日志实时落盘便于排查音频链路
    # MIO_PET_STATE_DIR：与 Electron main.js 同一个变量，指向完整的
    # "Live2D桌宠" 目录（Electron 直接当 STATE_DIR 用，不再拼子目录）。
    $env:MIO_PET_STATE_DIR = $petStateDir
    $p = Start-Process -FilePath $backendPy -ArgumentList '-u','-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000' -WorkingDirectory $backendDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    Write-Step "      已启动 (pid=$($p.Id))，数据目录=$petStateDir，等待就绪..."
    $ready = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 1000
        try { $null = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1; $ready = $true; break } catch {}
    }
    # venv 兜底：venv launcher 在含中文的路径下可能读不了 pyvenv.cfg（窄字符 API
    # 按 ANSI 编码解析），导致起的是"裸系统 Python"（没有 fastapi）直接退出。
    # 就绪失败时改用系统 Python + venv site-packages（PYTHONPATH）重拉一次。
    if (-not $ready) {
        Write-Step '      venv 启动未就绪，改用系统 Python + venv site-packages 兜底...'
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        $systemPy = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
        if (-not (Test-Path $systemPy)) { $systemPy = 'python.exe' }
        $env:PYTHONPATH = Join-Path $backendDir '.venv\Lib\site-packages'
        $p = Start-Process -FilePath $systemPy -ArgumentList '-u','-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000' -WorkingDirectory $backendDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
        Write-Step "      兜底已启动 (pid=$($p.Id))，继续等待就绪..."
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 1000
            try { $null = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1; $ready = $true; break } catch {}
        }
    }
    if ($ready) { Write-Step '      后端就绪 OK' }
    else { Write-Step '      后端启动超时，请查看 backend_err.log' }
}

# ---------- 2) Electron 桌宠 ----------
$electronRunning = [bool](Get-Process -Name electron -ErrorAction SilentlyContinue)
if ($electronRunning) {
    Write-Step '[2/2] 桌宠已在运行，跳过'
} else {
    Write-Step '[2/2] 桌宠未运行，正在启动...'
    # ★ electron.exe 回退：本仓库 node_modules 被 gitignore（clone 出来没有），
    #   优先本仓库、缺失回落到 Mao 主仓库的 electron.exe 二进制（外壳代码仍用本仓库）。
    if (-not (Test-Path $electronExe)) {
        $maoElectron = Join-Path (Split-Path -Parent $root) 'Mao\澪Agent应用\live2d-desktop\node_modules\electron\dist\electron.exe'
        if (Test-Path $maoElectron) { $electronExe = $maoElectron }
    }
    # ★★ userData 锁目录（2026-10-17 真根因）：chromium 单实例锁在本仓库 clone 的
    #   pet-data\pet-instance 报 Error 5，复用 Mao 主仓库的 pet-instance 可稳定创建。
    #   pet-instance 只是缓存/锁，不含源码，共享无害；状态数据仍走本仓库。
    $maoInstanceDir = Join-Path (Split-Path -Parent $root) 'Mao\pet-data\pet-instance'
    if (Test-Path $maoInstanceDir) {
        $env:MIO_PET_INSTANCE_DIR = $maoInstanceDir
    } else {
        $localInstance = Join-Path $root 'pet-data\pet-instance'
        if (-not (Test-Path $localInstance)) { New-Item -ItemType Directory -Force -Path $localInstance | Out-Null }
        $env:MIO_PET_INSTANCE_DIR = $localInstance
    }
    $env:MIO_PET_STATE_DIR = $petStateDir
    # --no-sandbox: 当前系统（Win11 预览版 + 近期更新）Chromium 沙箱初始化崩溃，
    # 必须禁用沙箱才能启动；数据目录默认已迁至项目根 pet-data（避开受控目录）
    $petPid = Start-Wmi $electronExe '--no-sandbox .' $electronDir
    Write-Step "      桌宠窗口已拉起 (pid=$petPid)，几秒内出现"
}

Write-Step '========== 完成 =========='
# 强制退出：Start-Detached 的异步事件处理器会阻止脚本自然结束；
# 用 Environment.Exit 强制终止进程，确保启动窗口立即关闭、不留窗口给用户误关
[Environment]::Exit(0)
