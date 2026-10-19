# ============================================================
#  Mio 桌宠 · 一键安装依赖（发布版用户运行）
#  用法: 右键“使用 PowerShell 运行”，或:
#        pwsh -NoProfile -ExecutionPolicy Bypass -File 安装依赖.ps1
#  作用: 1) 检测 Python / Node 环境
#        2) 创建后端虚拟环境并安装 Python 依赖
#        3) 安装 Electron 桌宠运行时 (npm install)
#        4) 准备桌宠运行时目录并补齐权限（换机/单独 clone 必需）
#  说明: 需要联网（首次下载 Electron ~100MB）；耗时数分钟
# ============================================================
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Say($msg, $color = 'Cyan') { Write-Host $msg -ForegroundColor $color }

Say '========== Mio 桌宠 · 依赖安装 =========='

# ---------- 1) 环境检测 ----------
Say '[1/5] 检测环境...'
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
    Say '[2/5] 后端虚拟环境已存在，跳过创建'
} else {
    Say '[2/5] 创建后端虚拟环境...'
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
    Say '[3/5] Electron 桌宠运行时已存在，跳过'
} else {
    Say '[3/5] 安装 Electron 桌宠运行时（npm install，首次约 100MB）...'
    Push-Location $l2dDir
    try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
    } finally { Pop-Location }
    Say '       Electron 安装完成'
}

# ---------- 4) 桌宠运行时目录 + 权限（方案 B） ----------
# ★ 独立性（2026-10-19）：详见 docs/项目独立性-技术分析.md
#   历史版本"能跑"靠的是仓库根上一条**从上游复制继承来的** ACL 规则；
#   单独 clone 到新机器时这条规则不存在 → Electron 建不了单实例锁 →
#   "Lock file can not be created! Error code: 3" → 主进程秒退。
#   权限必须在**安装期**用正常用户权限补齐（运行期 Electron 是受限令牌，icacls 同样被拒）。
Say '[4/5] 准备桌宠运行时目录并补齐权限...'

$petData     = Join-Path $root 'pet-data'
$petInstance = Join-Path $petData 'pet-instance'
$petState    = Join-Path $petData 'Live2D桌宠'
$petSession  = Join-Path $petState 'Chromium'
$petDirs     = @($petData, $petInstance, $petState, $petSession)
foreach ($d in $petDirs) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d -ErrorAction SilentlyContinue | Out-Null }
}

# AppContainer SID 探测：这条规则**不是**系统自动生成的（换机器不会带过来），
# 只在现有 ACL 里出现过才复用；探测不到就只靠 当前用户 + Everyone（普通用户场景足够）。
# 探测顺序：先 pet-data（本脚本自己加的，重跑时在这里），再仓库根（整目录拷贝时可能带过来）。
$appContainerSid = $null
foreach ($probeDir in @($petData, $root)) {
    if ($appContainerSid) { break }
    try {
        $existing = (Get-Acl -Path $probeDir).Access |
            Where-Object { "$($_.IdentityReference)" -match '^S-1-4-' } |
            Select-Object -First 1
        if ($existing) { $appContainerSid = "$($existing.IdentityReference)" }
    } catch {}
}
if ($appContainerSid) { Say "       复用已有 AppContainer SID: $appContainerSid" }

$me = "$env:USERDOMAIN\$env:USERNAME"
$aclFailed = @()
$aclWarn = @()

# 身份解析（2026-10-19 实测踩到）：
#   FileSystemAccessRule 用**字符串**构造时会尝试把名字翻译成 SID，AppContainer SID
#   （S-1-4-…）**没有对应名字**，于是抛「未能转换部分或所有标识引用」。
#   所以统一先解析成 SecurityIdentifier 对象再建规则。
function Resolve-Identity($id) {
    try {
        if ($id -match '^S-1-\d') {
            return New-Object System.Security.Principal.SecurityIdentifier($id)
        }
        $nt = New-Object System.Security.Principal.NTAccount($id)
        return $nt.Translate([System.Security.Principal.SecurityIdentifier])
    } catch {
        return $null
    }
}

# ── 步骤 A：只为 AppContainer SID 补一条显式规则 ────────────────────────────
# 为什么不用 .NET 重建整个 DACL（最初写法，已放弃）：
#   `Set-Acl` 对**已处于"保护"状态**的 DACL 写入时，本机稳定抛
#   「该进程不具有执行此操作所需的 SeSecurityPrivilege 特权」——
#   于是脚本第二次运行就必然报错（幂等性坏掉，实测可复现）。
#   `icacls` 没有这个问题，但它**不认 SID 字符串**（"账户名与安全标识间无任何映射"），
#   AppContainer SID 只能走 .NET 加。
#   ⇒ 分工：.NET 只在"尚未保护"时补一条 SID 规则；其余全部交给 icacls。
if ($appContainerSid) {
    $sidObj = Resolve-Identity $appContainerSid
    if ($null -eq $sidObj) {
        $aclWarn += "无法解析 AppContainer SID：$appContainerSid"
    } else {
        $inheritFlags = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        foreach ($d in $petDirs) {
            try {
                $cur = Get-Acl -Path $d
                $has = @($cur.Access | Where-Object { "$($_.IdentityReference)" -eq $appContainerSid }).Count -gt 0
                if ($has) { continue }                       # 已有，跳过（幂等）
                if ($cur.AreAccessRulesProtected) {
                    # 已被保护 ⇒ 本机 Set-Acl 会失败，不硬试，只记一条提示
                    $aclWarn += ("{0} 已保护但缺少 AppContainer SID 规则（普通用户不影响）" -f $d)
                    continue
                }
                $cur.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $sidObj, 'FullControl', $inheritFlags, [System.Security.AccessControl.PropagationFlags]::None,
                    [System.Security.AccessControl.AccessControlType]::Allow)))
                Set-Acl -Path $d -AclObject $cur -ErrorAction Stop
            } catch {
                $aclWarn += ("{0} 追加 AppContainer SID 失败：{1}" -f $d, $_.Exception.Message)
            }
        }
    }
}

# ── 步骤 B：icacls 统一重建为「自包含」DACL（幂等，可反复运行）──────────────
#   /inheritance:r  = 断开继承并**丢弃**所有继承 ACE（关键：不再依赖上游那条规则）
#   /remove:d       = 清掉历史遗留的 Deny（Everyone: Deny DeleteSubdirectoriesAndFiles 会挡删除）
#   /grant:r        = 覆盖该身份原有授权，重复运行不叠加
foreach ($d in $petDirs) {
    $icaclsArgs = @(
        $d, '/inheritance:r',
        '/remove:d', 'Everyone',
        '/grant:r', ("{0}:(OI)(CI)F" -f $me),
        '/grant:r', 'SYSTEM:(OI)(CI)F',
        '/grant:r', 'Administrators:(OI)(CI)F',
        '/grant:r', 'Everyone:(OI)(CI)M'
    )
    $icaclsOut = & icacls.exe @icaclsArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $aclFailed += ("{0}  (icacls exit={1} {2})" -f $d, $LASTEXITCODE, ($icaclsOut -join ' '))
    }
}

# ── 步骤 C：完整性标签（★"桌宠起不来"的真根因，2026-10-19 实测补上）─────────
#   现象：DACL 全对、普通 PowerShell 能写，但 Electron 一启动就弹
#         「Mao-pet 启动失败：运行时目录不可写」并秒退。
#   原因：Electron 被降权到 **Low 完整性级别** 运行，而 Low 进程往 Medium 对象
#         写入会被 no-write-up 策略直接挡 —— DACL 给得再宽松也没用。
#   证据：上游 C:\Users\xiao1\Mao 的根目录上有
#           Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
#         而本仓库 clone 出来的根目录**没有这一行**（Get-Acl 只读 DACL，看不到它，
#         所以早期对比"两个仓库 ACL 完全相同"的结论是漏了这一项）。
#   修法：给 pet-data 显式打同一个 Low 标签（与上游一致），/T 让已有子项也生效。
if ($petData) {
    $out = & icacls.exe $petData /setintegritylevel '(OI)(CI)Low' /T 2>&1
    if ($LASTEXITCODE -ne 0) {
        $aclFailed += ("{0}  (setintegritylevel exit={1} {2})" -f $petData, $LASTEXITCODE, ($out -join ' '))
    }
}

# ── 步骤 D：真写探针 ────────────────────────────────────────────────────────
# 目录存在 ≠ 能写（AppContainer/受限令牌下 mkdir 会 Error 5）。
# 必须真的写一个文件再删掉，否则等于没验证。
# ⚠ 注意：本探针以**当前 Medium 进程**身份跑，只能证明"普通进程可写"，
#   证明不了"Low IL 的 Electron 可写"——后者靠步骤 C 的标签保证。
$unwritable = @()
foreach ($d in $petDirs) {
    try {
        $probe = Join-Path $d ('.write-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
        Set-Content -Path $probe -Value 'ok' -ErrorAction Stop
        Remove-Item $probe -Force -ErrorAction SilentlyContinue
    } catch {
        $unwritable += $d
    }
}

# 完整性标签复核（Low IL 的 Electron 能不能写，全看这一行）
$labelOk = $false
try { $labelOk = ((& icacls.exe $petData) -join "`n") -match 'Low Mandatory Level' } catch {}
if (-not $labelOk) {
    $aclWarn += 'pet-data 缺少 Low 完整性标签 —— Low IL 的 Electron 会写不进去（桌宠起不来）'
}

if ($unwritable.Count -eq 0) {
    Say '       运行时目录已就绪且可写' Green
    if ($labelOk) { Say '       完整性标签 Low（Electron 可写）✓' Green }
    if ($aclFailed.Count -gt 0) {
        Say '       ⚠ 部分目录的 ACL 改写失败（不影响普通用户使用）：' Yellow
        foreach ($f in $aclFailed) { Say "         $f" DarkGray }
    }
    foreach ($w in $aclWarn) { Say "       ⚠ $w" Yellow }
} else {
    Say '       ❌ 以下目录不可写：' Red
    foreach ($d in $unwritable) { Say "         $d" DarkGray }
    Say '       桌宠会自动回退到 %LOCALAPPDATA%\Mao-pet 或 %TEMP%（功能正常，数据不在项目内）。' Yellow
    Say '       若想数据随项目走，请用**普通用户 PowerShell**（非受限沙箱）手动执行：' Yellow
    Say ('         icacls "{0}" /grant "{1}:(OI)(CI)F" /T' -f $petData, $me) DarkGray
}

# ---------- 5) 完成 ----------
Say '[5/5] 依赖安装完成！'
Say '现在可以运行 start_mio.ps1 启动桌宠。'
Say 'DSH 专用版：桌宠状态由本机 DSH 插件线驱动（见 docs/DSH专用化阉割计划.md）。'
Read-Host '按回车退出'
