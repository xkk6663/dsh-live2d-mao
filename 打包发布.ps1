# ============================================================
#  Mao 桌宠 · 打包发布版（生成发布 zip，不含运行时）
#  用法: pwsh -NoProfile -ExecutionPolicy Bypass -File 打包发布.ps1
#  输出: 发布\Mao桌宠_vX.zip （X 为版本号，自动递增，兼容识别旧 Mio 前缀）
#  说明: 发布包 = 后端源码 + 前端运行时 + Electron 源码 + 脚本 + 文档
#        不含: node_modules / .venv / 设备身份 / 运行数据 / 日志
#        用户拿到后运行「安装依赖.ps1」→「start_mio.ps1」即可
# ============================================================
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Say($msg, $color = 'Cyan') { Write-Host $msg -ForegroundColor $color }

Say '========== Mao 桌宠 · 打包发布版 =========='

# ---------- 版本号（基于现有 zip 递增，兼容 Mio/Mao 前缀） ----------
$pubDir = Join-Path $root '发布'
New-Item -ItemType Directory -Force $pubDir | Out-Null
$ver = 1
Get-ChildItem -Path $pubDir -Filter '*桌宠_v*.zip' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.BaseName -match '(?:Mao|Mio)桌宠_v(\d+)') { $v = [int]$Matches[1]; if ($v -ge $ver) { $ver = $v + 1 } }
}
$zipPath = Join-Path $pubDir ('Mao桌宠_v{0}.zip' -f $ver)
$staging = Join-Path $env:TEMP ('mao_publish_{0}' -f $ver)

# ---------- 清空暂存区 ----------
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force $staging | Out-Null

# ---------- 文件复制（robocopy 排除运行时与敏感数据） ----------
# 排除运行时/敏感数据；注意不要排除 dist 内的默认 Live2D 模型（models 仅根目录下载缓存不进包）
$exclDir = @('.venv', 'node_modules', '__pycache__', '.pytest_cache', 'release', 'build', 'Data', 'updates', '预览', '.git', '发布', 'l2d_downloads', 'l2d_official_models', 'dist_backup_20261009')
$exclFile = @('status.json', '*.log', '*.db', '*.sqlite', '*.wav', '*.mp3', '*.flac', '_*.txt', '*_out.txt')

$items = @(
    @{ Src = 'README.md'; Dst = '' },
    @{ Src = 'CHANGELOG.md'; Dst = '' },
    @{ Src = 'SRC-MAP-源码地图.md'; Dst = '' },
    @{ Src = 'LICENSE'; Dst = '' },
    @{ Src = 'THIRD_PARTY_NOTICES.md'; Dst = '' },
    @{ Src = 'start_mio.ps1'; Dst = '' },
    @{ Src = '安装依赖.ps1'; Dst = '' },
    @{ Src = '打包发布.ps1'; Dst = '' },
    @{ Src = '私人AI日记系统\backend'; Dst = '私人AI日记系统\backend' },
    @{ Src = '私人AI日记系统\工具'; Dst = '私人AI日记系统\工具' },
    @{ Src = '澪Agent应用\dist'; Dst = '澪Agent应用\dist' },
    @{ Src = '澪Agent应用\live2d-desktop'; Dst = '澪Agent应用\live2d-desktop' },
    @{ Src = '澪Agent应用\desktop'; Dst = '澪Agent应用\desktop' },
    @{ Src = '澪Agent应用\scripts'; Dst = '澪Agent应用\scripts' }
)

$robocopyArgs = @('/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP')
foreach ($e in $exclDir) { $robocopyArgs += @('/XD', $e) }
foreach ($e in $exclFile) { $robocopyArgs += @('/XF', $e) }

foreach ($it in $items) {
    $src = Join-Path $root $it.Src
    if (-not (Test-Path $src)) { Say "  跳过(不存在): $($it.Src)" -color Yellow; continue }
    $dst = if ($it.Dst) { Join-Path $staging $it.Dst } else { $staging }
    New-Item -ItemType Directory -Force $dst | Out-Null
    $itemAttr = Get-Item $src
    if ($itemAttr.PSIsContainer) {
        $rc = & robocopy $src $dst $robocopyArgs
        $code = $LASTEXITCODE
        if ($code -ge 8) { throw "robocopy 失败 ($code): $($it.Src)" }
    } else {
        Copy-Item $src $dst -Force
    }
    Say "  已复制: $($it.Src)"
}

# ---------- 压缩 ----------
Say '压缩发布包...'
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal
$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Say "完成: $zipPath  ($sizeMB MB)"
Remove-Item -Recurse -Force $staging
Say '提示: 发布包不含 Electron/Python 运行时，用户需先运行「安装依赖.ps1」'
