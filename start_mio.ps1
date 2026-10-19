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

# ★ 环境变量大小写去重（2026-10-19 实测踩到）：
#   Windows PowerShell 5.1 的 Start-Process 在**同一环境变量存在两种大小写写法**时
#   （Clash/v2ray/系统代理常同时设置 HTTP_PROXY 与 http_proxy）会抛
#     "已添加项。字典中的关键字:"HTTPS_PROXY" 所添加的关键字:"https_proxy""
#   导致后端根本起不来。这里在拉起子进程前删掉重复的小写键（保留大写）。
function Remove-DuplicateEnvKeys {
    try {
        $vars = [Environment]::GetEnvironmentVariables('Process')
        $seen = @{}
        foreach ($k in @($vars.Keys)) {
            $lower = $k.ToLowerInvariant()
            if ($seen.ContainsKey($lower)) {
                $prev = $seen[$lower]
                if ($k -ceq $k.ToUpperInvariant()) {
                    [Environment]::SetEnvironmentVariable($prev, $null, 'Process')
                    $seen[$lower] = $k
                } else {
                    [Environment]::SetEnvironmentVariable($k, $null, 'Process')
                }
            } else {
                $seen[$lower] = $k
            }
        }
    } catch {}
}
Remove-DuplicateEnvKeys

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

# ────────────────────────────────────────────────────────────────────────────
#  运行时目录探测（2026-10-19 独立性改造 · 方案 B）
#
#  ★ 原则：单独 clone 本仓库，不依赖任何其它仓库/机器上遗留的 ACL 规则就能跑。
#    目录存在 ≠ 能写（受限令牌下 mkdir 会 Error 5），所以必须**真写探针**。
#    探测链与 澪Agent应用/live2d-desktop/main.js 的 resolveStateDir() 完全一致：
#      ① 项目内 pet-data（数据随项目走，首选）
#      ② %LOCALAPPDATA%\Mao-pet（项目目录不可写时的标准位置）
#      ③ %TEMP%\mao-pet-runtime（最后兜底）
#    全部不可写 → 打印修复命令且**不启动**（避免窗口秒退后用户一脸问号）。
# ────────────────────────────────────────────────────────────────────────────
function Test-DirWritable($dir) {
    if (-not $dir) { return $false }
    try {
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null }
        $probe = Join-Path $dir ('.write-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
        Set-Content -Path $probe -Value 'ok' -ErrorAction Stop
        Remove-Item $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

# ★ Low 完整性标签检查（2026-10-19 真根因）：
#   本脚本是 Medium 进程，能写 ≠ Electron 能写 —— Electron 被降权到 Low IL，
#   往 Medium 目录写入会被 no-write-up 直接挡。缺这个标签时桌宠会弹
#   「运行时目录不可写」然后秒退，而这里的所有探测都是"通过"的。
#   故单独查标签，缺了就在启动前提示，别等用户对着弹窗猜。
function Test-LowIntegrityLabel($dir) {
    if (-not $dir) { return $false }
    try { return (((& icacls.exe $dir) -join "`n") -match 'Low Mandatory Level') } catch { return $false }
}

$runtimeCandidates = @(
    @{ State = (Join-Path $root 'pet-data\Live2D桌宠');               Instance = (Join-Path $root 'pet-data\pet-instance'); Label = '项目内 pet-data' },
    @{ State = (Join-Path $env:LOCALAPPDATA 'Mao-pet\Live2D桌宠');    Instance = (Join-Path $env:LOCALAPPDATA 'Mao-pet\pet-instance'); Label = '用户 LOCALAPPDATA' },
    @{ State = (Join-Path $env:TEMP 'mao-pet-runtime\Live2D桌宠');    Instance = (Join-Path $env:TEMP 'mao-pet-instance'); Label = '系统 TEMP' }
)
$petStateDir = $null
$petInstanceDir = $null
foreach ($c in $runtimeCandidates) {
    if ((Test-DirWritable $c.State) -and (Test-DirWritable (Join-Path $c.State 'Chromium')) -and (Test-DirWritable $c.Instance)) {
        $petStateDir = $c.State
        $petInstanceDir = $c.Instance
        Write-Step "运行时目录: $petStateDir（来源：$($c.Label)）"
        break
    }
    Write-Step "运行时目录不可写，尝试下一个：$($c.State)"
}
if (-not $petStateDir) {
    Write-Step '❌ 找不到可写的桌宠运行时目录，已中止（不启动，避免窗口秒退）。'
    Write-Step '   请在本项目根目录用**普通用户 PowerShell**运行一次：'
    Write-Step '     pwsh -NoProfile -ExecutionPolicy Bypass -File 安装依赖.ps1'
    Write-Step '   或手动授权：'
    Write-Step ('     icacls "{0}" /grant "{1}:(OI)(CI)F" /T' -f (Join-Path $root 'pet-data'), "$env:USERDOMAIN\$env:USERNAME")
    Write-Step '   详细原因见 docs/项目独立性-技术分析.md'
    [Environment]::Exit(1)
}

# Low 标签预检：缺失时明确告知（不中止——Electron 若以 Medium 跑仍可工作）
$petDataRoot = Split-Path $petStateDir -Parent
if (-not (Test-LowIntegrityLabel $petDataRoot)) {
    Write-Step "⚠ $(Split-Path $petStateDir -Parent) 缺少 Low 完整性标签"
    Write-Step '   Electron 以 Low 完整性级别运行时将无法写入 → 桌宠会弹「运行时目录不可写」并秒退。'
    Write-Step '   修复：运行一次 安装依赖.ps1（第 4 步会补），或手动执行：'
    Write-Step ('     icacls "{0}" /setintegritylevel (OI)(CI)Low /T' -f $petDataRoot)
}

# ---------- 1) 后端 (uvicorn :8000) ----------
# 桌宠数据目录：后端与 Electron 必须解析到**同一个**目录，否则后端写的
# runtime.json（模型选择）与桌宠读的不是同一个文件 → 切角色"成功但无效"。
# 这里显式传入，避免两边各自推导出不同路径。

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
    # ─────────────────────────────────────────────────────────────────────────
    # electron.exe 探测（2026-10-18 独立性改造）
    #
    # ★ 原则：本项目**完全独立**，不依赖任何其它仓库/项目。
    #   原实现会去同级 `../Mao` 目录找 electron.exe 和 pet-instance —— 那是开发期
    #   的临时便利，但让"单独 clone 本仓库"无法运行，违反独立性。
    #   全部删除，只认**本仓库内**与**标准安装位置**：
    #   ① 环境变量 MIO_ELECTRON_EXE（显式指定，兜底逃生门）
    #   ② 本仓库 live2d-desktop/node_modules（cd 澪Agent应用\live2d-desktop; npm ci）
    #   ③ 本仓库 澪Agent应用/node_modules（统一在应用目录装依赖的情形）
    #   ④ 全局 electron（npm i -g electron / pnpm add -g electron）
    # ─────────────────────────────────────────────────────────────────────────
    $candidates = @()
    if ($env:MIO_ELECTRON_EXE) { $candidates += $env:MIO_ELECTRON_EXE }
    $candidates += @(
        (Join-Path $electronDir 'node_modules\electron\dist\electron.exe'),
        (Join-Path $root '澪Agent应用\node_modules\electron\dist\electron.exe'),
        (Join-Path $env:APPDATA 'npm\node_modules\electron\dist\electron.exe'),
        (Join-Path $env:LOCALAPPDATA 'pnpm\global\5\node_modules\electron\dist\electron.exe')
    )
    foreach ($cand in $candidates) {
        if ($cand -and (Test-Path $cand)) { $electronExe = $cand; break }
    }
    if (-not (Test-Path $electronExe)) {
        Write-Step '      ❌ 找不到 electron.exe。请先安装桌宠外壳依赖：'
        Write-Step '         cd 澪Agent应用\live2d-desktop'
        Write-Step '         npm ci'
        Write-Step '         （或用环境变量 MIO_ELECTRON_EXE 显式指定 electron.exe）'
        Write-Step '      后端已就绪，桌宠窗口未启动。'
        [Environment]::Exit(1)
    }
    Write-Step "      electron: $electronExe"

    # userData 锁目录 / 数据目录：已在上方统一探测（$petInstanceDir / $petStateDir），
    # 与 main.js 的 resolveStateDir()/resolveInstanceDir() 结果一致，不再各自推导。
    $env:MIO_PET_INSTANCE_DIR = $petInstanceDir
    $env:MIO_PET_STATE_DIR = $petStateDir
    Write-Step "      instance: $petInstanceDir"
    # --no-sandbox: 当前系统（Win11 预览版 + 近期更新）Chromium 沙箱初始化崩溃，
    # 必须禁用沙箱才能启动；数据目录默认已迁至项目根 pet-data（避开受控目录）
    $petPid = Start-Wmi $electronExe '--no-sandbox .' $electronDir
    Write-Step "      桌宠窗口已拉起 (pid=$petPid)，几秒内出现"
}

Write-Step '========== 完成 =========='
# 强制退出：Start-Detached 的异步事件处理器会阻止脚本自然结束；
# 用 Environment.Exit 强制终止进程，确保启动窗口立即关闭、不留窗口给用户误关
[Environment]::Exit(0)
