const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
} = require('electron')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const {
  modelCapabilities,
  previewCandidate,
  registerUnlistedExpressions,
  renderOptimizedModel,
} = require('./model-discovery')

const API_BASE = String(process.env.MIO_PET_API_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '')

// ══════════════════════════════════════════════════════════════════════════
// 运行时目录自举（2026-10-19 独立性改造 · 方案 B）
//
// 目标：**单独 clone / 下载本仓库，不依赖任何其它仓库**，解压即能起。
// 事实（见 docs/项目独立性-技术分析.md）：
//   · 历史版本"能跑"靠的是仓库根上一条**从上游复制继承来的** ACL 规则；
//   · 新机器 / 新目录 clone 没有这条规则 ⇒ 单实例锁写不进去 ⇒ Error code 3 秒退。
//
// 本段做两件事：
//   1) 按**候选链**探测"真的能写"（真写探针文件，不只看 existsSync —— 目录存在
//      但无权限时 existsSync 仍返回 true，是历史上最大的误判来源）；
//   2) 全部候选都不可写时，用 dialog.showErrorBox 明确告知修复命令，
//      **不再静默秒退**（这个函数在 app ready 之前就可用）。
//
// 为什么运行期不做 ACL 授权：受限令牌（AppContainer / 宿主沙箱）里 icacls 同样
// 被拒，改了也没用。授权必须在安装期用**正常用户权限**做 → 见 安装依赖.ps1 第 4 步。
// ══════════════════════════════════════════════════════════════════════════
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const LOCAL_ROOT = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')

/** 目录是否**真的**可写（mkdir + 写探针 + 删探针）。任何一步失败即 false。 */
function canWriteDir(dir) {
  return probeDir(dir).ok
}

/**
 * 同 canWriteDir，但把失败原因带出来（用于弹窗 / 启动日志定位）。
 *
 * ★ 2026-10-19 实测补充：**本探针失败 ≠ DACL 有问题**。
 *   最常见的原因是目标目录缺 `Low` 完整性标签 —— Electron 被降权到 Low IL 运行时，
 *   往 Medium 对象写入会被 no-write-up 策略直接挡（EPERM/EACCES），DACL 再宽松也没用。
 *   所以错误文案必须把底层 code 一起抛出来，否则只能看到"不可写"三个字无从下手。
 */
function probeDir(dir) {
  if (!dir) return { ok: false, error: 'empty path' }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}.tmp`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return { ok: true, error: '' }
  } catch (err) {
    const code = (err && (err.code || err.errno)) || 'UNKNOWN'
    return { ok: false, error: `${code}: ${(err && err.message) || err}` }
  }
}

/**
 * 启动日志（惰性决定落点）。
 *
 * ⚠ 2026-10-19 实测：Electron 以 Low IL 运行时**写不进 %TEMP%**（那是 Medium 对象，
 *   同样受 no-write-up 限制）——所以 %TEMP% 只能是首选、不能当保证。
 *   首选失败就回落到 `pet-data/`（该目录带 Low 标签，Low 进程可写）。
 *   两个都写不进去时静默放弃，绝不能因为日志把启动搞崩。
 */
const BOOT_LOG_CANDIDATES = [
  path.join(os.tmpdir(), 'mao-pet-boot.log'),
  path.join(PROJECT_ROOT, 'pet-data', 'mao-pet-boot.log'),
]
let _bootLogPath = ''
function bootLogPath() {
  if (_bootLogPath) return _bootLogPath
  for (const candidate of BOOT_LOG_CANDIDATES) {
    try {
      fs.appendFileSync(candidate, '')
      _bootLogPath = candidate
      return candidate
    } catch {}
  }
  _bootLogPath = BOOT_LOG_CANDIDATES[0]
  return _bootLogPath
}
function bootLog(line) {
  try {
    fs.appendFileSync(bootLogPath(), `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

/**
 * 解析桌宠数据目录（STATE_DIR，完整指向 "Live2D桌宠" 那一层）。
 * 优先级：显式环境变量 → 项目内 pet-data → 用户 LOCALAPPDATA → 系统 TEMP。
 */
function resolveStateDir() {
  const explicit = String(process.env.MIO_PET_STATE_DIR || '').trim()
  if (explicit) {
    // 显式指定就尊重用户意图（不再偷偷换目录，否则后端与桌面端会各指一处）
    const dir = path.resolve(explicit)
    const probe = probeDir(dir)
    if (!probe.ok) {
      console.error(`[mao-pet] ⚠ MIO_PET_STATE_DIR 不可写：${dir}（${probe.error}）`)
      bootLog(`⚠ MIO_PET_STATE_DIR 不可写：${dir}（${probe.error}）`)
      return { dir, source: `env(不可写: ${probe.error})` }
    }
    return { dir, source: 'env:MIO_PET_STATE_DIR' }
  }
  const candidates = [
    [path.join(PROJECT_ROOT, 'pet-data', 'Live2D桌宠'), '项目内 pet-data'],
    [path.join(LOCAL_ROOT, 'Mao-pet', 'Live2D桌宠'), '用户 LOCALAPPDATA'],
    [path.join(os.tmpdir(), 'mao-pet-runtime', 'Live2D桌宠'), '系统 TEMP'],
  ]
  for (const [dir, source] of candidates) {
    if (canWriteDir(dir)) return { dir: path.resolve(dir), source }
  }
  return { dir: path.resolve(candidates[0][0]), source: '❌ 全部不可写' }
}

/**
 * 解析 Electron userData 目录（单实例锁 SingletonLock 所在）。
 * 必须与 STATE_DIR 同盘同权限层级：优先 `<pet-data>/pet-instance`。
 *
 * ★ 2026-10-19：**显式环境变量也要探测**。启动脚本以 Medium 身份探测通过就把它塞进
 *   MIO_PET_INSTANCE_DIR，但真正跑 Electron 的是 Low IL —— 环境变量指过来也可能写不进去。
 *   旧写法 `if (explicit) return explicit` 会把这条死路当唯一答案，直接导致秒退。
 */
function resolveInstanceDir(stateDir) {
  if (process.env.MIO_PET_ALLOW_PARALLEL === '1') return path.join(stateDir, 'instance')
  const explicit = String(process.env.MIO_PET_INSTANCE_DIR || '').trim()
  const base = path.dirname(stateDir) // pet-data / Mao-pet / mao-pet-runtime
  const candidates = []
  if (explicit) candidates.push(path.resolve(explicit))
  candidates.push(
    path.join(base, 'pet-instance'),
    path.join(stateDir, 'instance'),
    path.join(LOCAL_ROOT, 'Mao-pet', 'pet-instance'),
    path.join(os.tmpdir(), 'mao-pet-instance'),
  )
  for (const dir of candidates) {
    if (canWriteDir(dir)) return dir
  }
  return candidates[0]
}

const _stateChoice = resolveStateDir()
const STATE_DIR = _stateChoice.dir
const MODELS_DIR = path.join(STATE_DIR, 'models')
const STATE_PATH = path.join(STATE_DIR, 'runtime.json')
const LOG_PATH = path.join(STATE_DIR, 'desktop-pet.log')
const SESSION_DIR = path.join(STATE_DIR, 'Chromium')
const INSTANCE_DIR = resolveInstanceDir(STATE_DIR)

// ★ 关键（2026-10-17 真根因）：INSTANCE_DIR 是 electron 的 userData（单实例锁所在）。
//   目录不存在 ⇒ "单实例锁文件创建失败(Error code 3)" ⇒ 主进程秒退。
//   必须在 setPath 前先建好。Chromium/sessionData 由 electron 自建，
//   不要手动 mkdir 子目录（会 EPERM，且与 electron 内部管理冲突）。
//   这里先探针 + 打日志（放在 setName 之前，保证日志一定先落盘，便于排障）。
const _instanceProbe = probeDir(INSTANCE_DIR)
const _sessionProbe = probeDir(SESSION_DIR)
console.log(`[mao-pet] 数据目录 = ${STATE_DIR}（来源：${_stateChoice.source}）`)
console.log(`[mao-pet] 锁目录   = ${INSTANCE_DIR}（可写：${_instanceProbe.ok}${_instanceProbe.ok ? '' : ' — ' + _instanceProbe.error}）`)
console.log(`[mao-pet] 缓存目录 = ${SESSION_DIR}（可写：${_sessionProbe.ok}${_sessionProbe.ok ? '' : ' — ' + _sessionProbe.error}）`)
console.log(`[mao-pet] 启动日志 = ${bootLogPath()}`)
bootLog(`---- 启动 pid=${process.pid} ----`)
bootLog(`数据目录=${STATE_DIR}（${_stateChoice.source}）`)
bootLog(`锁目录=${INSTANCE_DIR} ok=${_instanceProbe.ok} ${_instanceProbe.error}`)
bootLog(`缓存目录=${SESSION_DIR} ok=${_sessionProbe.ok} ${_sessionProbe.error}`)
bootLog(`env: MIO_PET_STATE_DIR=${process.env.MIO_PET_STATE_DIR || '(空)'} MIO_PET_INSTANCE_DIR=${process.env.MIO_PET_INSTANCE_DIR || '(空)'}`)

app.setName('MioLive2D桌宠')
app.setAppUserModelId('local.mio.live2d.desktop')

if (!_instanceProbe.ok) {
  // dialog.showErrorBox 在 app ready 之前即可用（同步 MessageBox），
  // 这是唯一"用户在双击场景下一定看得见"的错误通道。仍然继续尝试启动，
  // 因为部分受限环境下 mkdir 探针会误报失败、而 electron 自己的锁能建。
  bootLog(`❌ 锁目录不可写：${_instanceProbe.error}`)
  try {
    dialog.showErrorBox(
      'Mao-pet 启动失败：运行时目录不可写',
      `无法写入：\n${INSTANCE_DIR}\n\n` +
        `底层错误：${_instanceProbe.error}\n\n` +
        '最常见原因：pet-data 缺 **Low 完整性标签**。Electron 以 Low 完整性级别运行时，\n' +
        '向 Medium 目录写入会被系统直接挡住（DACL 再宽松也没用）。\n\n' +
        '请在项目根目录运行一次安装脚本（它会补齐权限 + Low 标签）：\n' +
        '  右键「安装依赖.ps1」→ 使用 PowerShell 运行\n\n' +
        '或手动执行（普通用户 PowerShell，不要在受限沙箱里）：\n' +
        `  icacls "${PROJECT_ROOT}\\pet-data" /setintegritylevel (OI)(CI)Low /T\n\n` +
        `排查日志：${bootLogPath()}\n` +
        `详细分析见 docs/项目独立性-技术分析.md`,
    )
  } catch {}
  console.error('[mao-pet] ❌ 锁目录不可写，桌宠大概率会秒退（已弹出提示）')
}

app.setPath('userData', INSTANCE_DIR)
app.setPath('sessionData', SESSION_DIR)
try {
  fs.mkdirSync(MODELS_DIR, { recursive: true })
} catch (err) {
  console.error(`[mao-pet] ⚠ 模型目录创建失败：${MODELS_DIR}（${err.message}）`)
}
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// 透明窗口 WebGL 合成保险：开机后首个 Electron 实例偶发模型层不上屏（DOM 徽标正常），
// 显式启用透明视觉合成，保证自启动场景下 Live2D 画面一定参与桌面合成
app.commandLine.appendSwitch('enable-transparent-visuals')
if (process.env.MIO_PET_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.MIO_PET_DEBUG_PORT))
}
if (process.env.MIO_PET_DISABLE_GPU === '1') app.disableHardwareAcceleration()

let mainWindow = null
let lockControlWindow = null
let chatWindow = null
let xiaozhiWindow = null
let tray = null
let modelServer = null
let modelServerOrigin = ''
let quitting = false
let rendererRestarts = []
let desiredAlwaysOnTop = true
let clickThroughLocked = false
let rendererInteractive = false
// 渲染层上报的横条命中区（渲染层坐标，相对窗口）；null = 横条隐藏/不可命中
let stripBounds = null
let chatWindowOpen = false
let modelBounds = null
let uiOpen = false
let mousePolicyTimer = null
let lastIgnoreMouseEvents = null
// DSH 专用化（用户裁决 2026-10-17）：原 `xiaozhiEnabled` 是"小智插件是否挂载"的开关，
// 用来门控对话窗/托盘入口。小智插件已整体阉割，对话横条现在是**桌宠自己的**功能
// （走 /api/companion/chat），不该再被一个不存在的插件开关挡住。
// 故直接恒定可用；保留变量名是为了让下面十几处守卫不必全改（语义已从"小智开关"
// 变成"对话功能是否可用"）。
let xiaozhiEnabled = true
let topmostWatchdog = null
let lockControlAnchor = null
let parentWatchdog = null
const lastWindowReportAt = new Map()

function log(message, details = '') {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 1024 * 1024) {
      fs.renameSync(LOG_PATH, `${LOG_PATH}.1`)
    }
    fs.appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} ${message}${details ? ` ${details}` : ''}\n`,
      'utf8',
    )
  } catch (_) {}
}

function startParentWatchdog() {
  const parentPid = Number(process.env.MIO_AGENT_PARENT_PID || 0)
  if (!Number.isInteger(parentPid) || parentPid <= 0) return
  clearInterval(parentWatchdog)
  parentWatchdog = setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch (_) {
      log('agent.parent_gone', `pid=${parentPid}`)
      quitting = true
      app.quit()
    }
  }, 1500)
}

function postBackend(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${API_BASE}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Length': '0' },
      timeout: 5000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${body}`))
          return
        }
        try { resolve(body ? JSON.parse(body) : { ok: true }) }
        catch (_) { resolve({ ok: true }) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('请求 Mio 超时')))
    request.on('error', reject)
    request.end()
  })
}

function postBackendJson(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const request = http.request(`${API_BASE}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
      timeout: 3000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${text}`))
          return
        }
        try { resolve(text ? JSON.parse(text) : { ok: true }) }
        catch (_) { resolve({ ok: true }) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('窗口拓扑上报超时')))
    request.on('error', reject)
    request.end(body)
  })
}

function windowState(windowId, window, action) {
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  if (window && !window.isDestroyed()) bounds = window.getBounds()
  return {
    source: 'electron-main',
    runtime: 'electron',
    window_id: windowId,
    pid: process.pid,
    action,
    correlation_id: `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`,
    visible: Boolean(window && !window.isDestroyed() && window.isVisible()),
    focused: Boolean(window && !window.isDestroyed() && window.isFocused()),
    bounds,
  }
}

function reportWindowAction(windowId, window, action) {
  const reportKey = `${windowId}:${action}`
  const now = Date.now()
  if (action === 'positioned' && now - Number(lastWindowReportAt.get(reportKey) || 0) < 250) return null
  lastWindowReportAt.set(reportKey, now)
  const payload = windowState(windowId, window, action)
  log(
    'window.action',
    `source=${payload.source} runtime=${payload.runtime} window_id=${windowId} pid=${payload.pid} action=${action} correlation_id=${payload.correlation_id}`,
  )
  postBackendJson('/api/companion/window-topology/events', payload).catch((error) => {
    log('window.action_report_failed', `${windowId} ${action} ${error.message || String(error)}`)
  })
  return payload
}

let petAdminWindow = null
function openPetAdmin() {
  if (petAdminWindow && !petAdminWindow.isDestroyed()) {
    petAdminWindow.show()
    petAdminWindow.focus()
    return
  }
  petAdminWindow = new BrowserWindow({
    width: 1180, height: 780,
    title: 'Mio',
    backgroundColor: '#f5f7f9',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, 'preload.js') },
  })
  // 强制清缓存 + 清存储：防止旧页面/旧分片残留导致红点（输入区找不到）/按钮不注入
  const sess = petAdminWindow.webContents.session
  sess.clearCache().then(() => sess.clearStorageData()).then(() => {
    // 桌宠管理窗口：对话入口 = 原版 ChatPage 改造版（小智历史+WS+音频+跟随对话按钮+会话抽屉，无缝衔接原版框架）
    petAdminWindow.loadURL(`${API_BASE}/agent-app/?workspace=main&v=20261015a`)
  })
  petAdminWindow.on('closed', () => { petAdminWindow = null })
}

function loadRuntimeState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch (_) {
    return {}
  }
}

function saveRuntimeState(changes) {
  const state = { ...loadRuntimeState(), ...changes }
  const temporary = `${STATE_PATH}.tmp`
  // ★ 容错（2026-10-17）：写状态失败（EPERM/磁盘/占用）**绝不能**让未捕获异常
  //   弹"A JavaScript error in the main process"把桌宠卡死——状态只是 UI 偏好
  //   （点击穿透锁定/模型选择等），写失败仅记日志，桌宠继续跑。
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(temporary, STATE_PATH)
  } catch (err) {
    console.error('[state] saveRuntimeState 失败（已忽略，桌宠继续运行）:', err.message)
  }
  return state
}

function sanitizeModelId(name) {
  const normalized = String(name || 'model')
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'model'
  return `${normalized}-${Date.now().toString(36)}`
}

function walkFiles(root) {
  const found = []
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(absolute)
      else found.push(absolute)
    }
  }
  return found
}

function modelCatalog() {
  const catalog = []
  // 内置模型：扫描渲染器 models 目录（dist/live2d-pet/models），动态发现并合并进管理列表，
  // id 与 live2d-pet.js builtInModels 的 id（目录名小写）保持一致，选中后可正常切换。
  const builtInRoot = path.resolve(__dirname, '..', 'dist', 'live2d-pet', 'models')
  if (fs.existsSync(builtInRoot)) {
    for (const entry of fs.readdirSync(builtInRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const modelRoot = path.join(builtInRoot, entry.name)
      const modelFile = fs.readdirSync(modelRoot).find((f) => f.toLowerCase().endsWith('.model3.json'))
      if (!modelFile) continue
      catalog.push({
        id: entry.name.toLowerCase(),
        name: entry.name,
        source: 'built_in',
        modelUrl: `./models/${entry.name}/${modelFile}`,
        importedAt: '',
        renderOptimization: {},
        sourceLabel: '内置官方模型',
        capabilities: {},
      })
    }
  }
  if (!fs.existsSync(MODELS_DIR)) return catalog
  for (const entry of fs.readdirSync(MODELS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const modelRoot = path.join(MODELS_DIR, entry.name)
    const metadataPath = path.join(modelRoot, 'mio-model.json')
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
      const sourceModelPath = path.resolve(modelRoot, metadata.modelPath)
      if (!sourceModelPath.startsWith(`${modelRoot}${path.sep}`) || !fs.existsSync(sourceModelPath)) continue
      let renderAsset = {
        modelPath: sourceModelPath,
        optimized: false,
        optimizedTextureCount: 0,
        maxTextureSize: 2048,
        sourceTextureMaxSize: 0,
      }
      try {
        renderAsset = renderOptimizedModel(modelRoot, sourceModelPath, nativeImage, 2048)
      } catch (error) {
        log('model.optimize_failed', `${entry.name}: ${error.message || String(error)}`)
      }
      const modelPath = renderAsset.modelPath
      const relative = path.relative(modelRoot, modelPath).split(path.sep).map(encodeURIComponent).join('/')
      catalog.push({
        id: entry.name,
        name: String(metadata.name || entry.name),
        source: 'imported',
        modelUrl: `${modelServerOrigin}/models/${encodeURIComponent(entry.name)}/${relative}`,
        importedAt: String(metadata.importedAt || ''),
        renderOptimization: {
          optimized: Boolean(renderAsset.optimized),
          optimizedTextureCount: Number(renderAsset.optimizedTextureCount || 0),
          maxTextureSize: Number(renderAsset.maxTextureSize || 2048),
          sourceTextureMaxSize: Number(renderAsset.sourceTextureMaxSize || 0),
        },
        sourceLabel: String(metadata.sourceLabel || '本地目录导入'),
        capabilities: metadata.capabilities && typeof metadata.capabilities === 'object'
          ? metadata.capabilities
          : {},
        authorization: metadata.authorization && typeof metadata.authorization === 'object'
          ? metadata.authorization
          : { status: 'unknown', notice: '未记录模型授权，禁止随安装包分发。' },
      })
    } catch (_) {}
  }
  return catalog
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return {
    '.json': 'application/json; charset=utf-8',
    '.moc3': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.wav': 'audio/wav',
  }[extension] || 'application/octet-stream'
}

function startModelServer() {
  return new Promise((resolve, reject) => {
    modelServer = http.createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*')
      response.setHeader('Cache-Control', 'no-cache')
      try {
        const requestUrl = new URL(request.url, 'http://127.0.0.1')
        const parts = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent)
        if (parts.length < 3 || parts[0] !== 'models') {
          response.writeHead(404).end()
          return
        }
        const modelRoot = path.resolve(MODELS_DIR, parts[1])
        const filePath = path.resolve(modelRoot, ...parts.slice(2))
        if (!filePath.startsWith(`${modelRoot}${path.sep}`) || !fs.statSync(filePath).isFile()) {
          response.writeHead(403).end()
          return
        }
        response.writeHead(200, { 'Content-Type': contentType(filePath) })
        fs.createReadStream(filePath).pipe(response)
      } catch (_) {
        response.writeHead(404).end()
      }
    })
    modelServer.once('error', reject)
    modelServer.listen(0, '127.0.0.1', () => {
      const address = modelServer.address()
      modelServerOrigin = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
}

function virtualBounds() {
  const displays = screen.getAllDisplays()
  const left = Math.min(...displays.map((display) => display.bounds.x))
  const top = Math.min(...displays.map((display) => display.bounds.y))
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// ★ B2 多屏 workArea 并集（2026-10-19）：与 virtualBounds 的区别是**剔除任务栏**。
//   渲染层的"可见下限/可选 clamp"用 workArea 才不会把桌宠压到任务栏底下；
//   display-metrics-changed / display-added / removed 已有监听（renderer 每次拉
//   get-state 都是现算值，无需推送通道）。
function workAreaBounds() {
  const displays = screen.getAllDisplays()
  const left = Math.min(...displays.map((display) => display.workArea.x))
  const top = Math.min(...displays.map((display) => display.workArea.y))
  const right = Math.max(...displays.map((display) => display.workArea.x + display.workArea.width))
  const bottom = Math.max(...displays.map((display) => display.workArea.y + display.workArea.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'desktop', 'mio.ico')
    : path.resolve(__dirname, '..', 'desktop', 'mio.ico')
}

function sendModelsChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('mio-desktop:models-changed', {
    models: modelCatalog(),
    selectedModelId: String(loadRuntimeState().selectedModelId || ''),
  })
}

async function importModel() {
  const result = await dialog.showOpenDialog({
    title: '导入 Live2D 模型目录',
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
  const sourceRoot = result.filePaths[0]
  const allFiles = walkFiles(sourceRoot)
  const modelFiles = allFiles.filter((file) => file.toLowerCase().endsWith('.model3.json'))
  if (!modelFiles.length) {
    return { ok: false, error: '所选目录中没有 .model3.json 文件' }
  }
  const sourceModel = modelFiles[0]
  let capabilities
  try {
    capabilities = modelCapabilities(sourceRoot, sourceModel, allFiles)
  } catch (error) {
    return { ok: false, error: `模型配置无法解析：${error.message || error}` }
  }
  const id = sanitizeModelId(path.basename(sourceRoot))
  const targetRoot = path.join(MODELS_DIR, id)
  fs.cpSync(sourceRoot, targetRoot, { recursive: true, errorOnExist: true })
  const modelPath = path.relative(sourceRoot, sourceModel)
  const importedModelPath = path.join(targetRoot, modelPath)
  const importedFiles = walkFiles(targetRoot)
  registerUnlistedExpressions(targetRoot, importedModelPath, importedFiles)
  capabilities = modelCapabilities(targetRoot, importedModelPath, importedFiles)
  const preview = previewCandidate(sourceRoot, allFiles)
  fs.writeFileSync(
    path.join(targetRoot, 'mio-model.json'),
    JSON.stringify({
      name: path.basename(sourceRoot),
      modelPath,
      previewPath: preview ? path.relative(sourceRoot, preview) : '',
      sourceLabel: sourceRoot,
      importedAt: new Date().toISOString(),
      capabilities,
      authorization: {
        status: capabilities.licenseFiles.length ? 'files_found' : 'unverified',
        licenseFiles: capabilities.licenseFiles,
        notice: capabilities.licenseFiles.length
          ? '已发现随模型提供的授权文件；使用和分发前仍需按文件内容核对。'
          : '未发现授权文件；该模型只能本机测试，禁止随安装包分发。',
        distributionAllowed: false,
      },
    }, null, 2),
    'utf8',
  )
  saveRuntimeState({ selectedModelId: id })
  sendModelsChanged()
  return { ok: true, modelId: id, models: modelCatalog() }
}

function setMainWindowIgnoreMouseEvents(ignore) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // 状态去重：只有需要翻转时才调用 setIgnoreMouseEvents，
  // 避免高频切换 Windows hit-test 导致 pointer 事件流中断/丢失（拖动卡顿、漂移根因）
  if (lastIgnoreMouseEvents === ignore) return
  lastIgnoreMouseEvents = ignore
  mainWindow.setIgnoreMouseEvents(ignore)
}

function applyMainWindowMousePolicy() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (chatWindowOpen) {
    setMainWindowIgnoreMouseEvents(true)
    return
  }
  if (clickThroughLocked) {
    setMainWindowIgnoreMouseEvents(true)
    return
  }
  // 不再依赖渲染层鼠标事件转发（--no-sandbox 下 forward 不可靠）：
  // 主进程轮询鼠标位置——在模型区域内或 UI 打开且鼠标在窗口内时可交互，否则穿透。
  const pt = screen.getCursorScreenPoint()
  const wb = mainWindow.getBounds()
  const inModel = modelBounds
    && pt.x >= wb.x + modelBounds.x && pt.x <= wb.x + modelBounds.x + modelBounds.width
    && pt.y >= wb.y + modelBounds.y && pt.y <= wb.y + modelBounds.y + modelBounds.height
  // ★ 横条区域命中：鼠标在横条矩形内 ⇒ 可交互（可拖动/拉伸/点✕），
  //   横条之外照常穿透 —— 用户要求"只有横条那一小块可控制，其余画面不受影响"。
  const inStrip = stripBounds
    && pt.x >= wb.x + stripBounds.x && pt.x <= wb.x + stripBounds.x + stripBounds.width
    && pt.y >= wb.y + stripBounds.y && pt.y <= wb.y + stripBounds.y + stripBounds.height
  const inWindow = pt.x >= wb.x && pt.x <= wb.x + wb.width && pt.y >= wb.y && pt.y <= wb.y + wb.height
  setMainWindowIgnoreMouseEvents(!(inModel || inStrip || rendererInteractive || (uiOpen && inWindow)))
}

// 全局鼠标位置推送（渲染层坐标 = 屏幕坐标 - 虚拟边界原点）：
// Electron 穿透模式下渲染层收不到 mousemove，视线跟随必须由主进程高频喂数据
function sendMouseMoveToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = virtualBounds()
    const pt = screen.getCursorScreenPoint()
    mainWindow.webContents.send('mio-desktop:mouse-move', {
      x: pt.x - bounds.x,
      y: pt.y - bounds.y,
    })
  } catch (_) {}
}

function setMouseInteractive(interactive) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  rendererInteractive = Boolean(interactive)
  applyMainWindowMousePolicy()
}

function applyWindowLayering() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setAlwaysOnTop(desiredAlwaysOnTop, desiredAlwaysOnTop ? 'screen-saver' : 'normal')
  applyMainWindowMousePolicy()
  if (desiredAlwaysOnTop && !chatWindowOpen) mainWindow.moveTop()
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
    chatWindow.setAlwaysOnTop(true, 'screen-saver')
    chatWindow.moveTop()
  }
  if (lockControlWindow && !lockControlWindow.isDestroyed()) {
    lockControlWindow.setAlwaysOnTop(
      desiredAlwaysOnTop,
      desiredAlwaysOnTop ? 'screen-saver' : 'normal',
    )
    if (desiredAlwaysOnTop) lockControlWindow.moveTop()
  }
}

function setChatWindowOpen(open) {
  chatWindowOpen = Boolean(open)
  applyWindowLayering()
}

function normalizedChatAnchor(anchor) {
  const anchorX = Number(anchor?.anchorX ?? anchor?.anchor_x)
  const anchorY = Number(anchor?.anchorY ?? anchor?.anchor_y)
  if (Number.isFinite(anchorX) && Number.isFinite(anchorY)) return { x: anchorX, y: anchorY }
  if (lockControlAnchor) {
    const desktop = virtualBounds()
    return {
      x: desktop.x + lockControlAnchor.x + lockControlAnchor.width / 2,
      y: desktop.y + lockControlAnchor.y,
    }
  }
  const cursor = screen.getCursorScreenPoint()
  return { x: cursor.x, y: cursor.y }
}

function positionChatWindow(anchor) {
  if (!chatWindow || chatWindow.isDestroyed()) return
  const point = normalizedChatAnchor(anchor)
  const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
  const area = display.workArea
  const [width, height] = chatWindow.getSize()
  const preferredAbove = Math.round(point.y - height - 18)
  const fallbackBelow = Math.round(point.y + 24)
  const x = Math.max(area.x + 8, Math.min(area.x + area.width - width - 8, Math.round(point.x - width / 2)))
  const y = preferredAbove >= area.y + 8
    ? preferredAbove
    : Math.max(area.y + 8, Math.min(area.y + area.height - height - 8, fallbackBelow))
  chatWindow.setPosition(x, y, false)
  reportWindowAction('pet-chat-input', chatWindow, 'positioned')
}

function hideChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.executeJavaScript(
      "window.dispatchEvent(new CustomEvent('mio:pet-chat-hidden'))",
      true,
    ).catch(() => {})
    chatWindow.hide()
    reportWindowAction('pet-chat-input', chatWindow, 'hidden')
  }
  setChatWindowOpen(false)
  return { ok: true, visible: false }
}

function createChatWindow(anchor) {
  chatWindow = new BrowserWindow({
    width: 460,
    height: 66,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'pet-chat-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  reportWindowAction('pet-chat-input', chatWindow, 'created')
  chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // DSH 专用化：对话横条页面从中性的 chat-bar/ 加载（原来指向 xiaozhi/xiaozhi-chat.html，
  // 那是小智专用页；小智插件已阉割，页面已重写为走 /api/companion/chat 的通用对话横条）
  chatWindow.loadURL(`${API_BASE}/agent-app/live2d-pet/chat-bar/pet-chat-bar.html?v=20261017`)
  chatWindow.once('ready-to-show', () => {
    positionChatWindow(anchor)
    chatWindow.show()
    chatWindow.focus()
    setChatWindowOpen(true)
    reportWindowAction('pet-chat-input', chatWindow, 'shown')
  })
  chatWindow.on('hide', () => setChatWindowOpen(false))
  chatWindow.on('focus', () => reportWindowAction('pet-chat-input', chatWindow, 'focused'))
  chatWindow.on('closed', () => {
    reportWindowAction('pet-chat-input', chatWindow, 'closed')
    chatWindow = null
    setChatWindowOpen(false)
  })
  chatWindow.webContents.on('did-fail-load', (_event, code, description) => {
    log('chat_window.load_failed', `${code} ${description}`)
  })
}

// DSH 专用化：原 createXiaozhiWindow()（打开小智对话）与 closeChatWindowIfOpen()
// （小智停用时关闭对话窗）已删除 —— 小智插件已阉割，对话横条改为桌宠自有功能。

function showChatWindow(anchor) {
  // 插件化守卫：xiaozhi 未启用时禁止打开小智对话窗
  if (!xiaozhiEnabled) return { ok: false, visible: false, disabled: true }
  if (!chatWindow || chatWindow.isDestroyed()) {
    createChatWindow(anchor)
    return { ok: true, visible: true, created: true }
  }
  positionChatWindow(anchor)
  chatWindow.show()
  chatWindow.focus()
  setChatWindowOpen(true)
  reportWindowAction('pet-chat-input', chatWindow, 'shown')
  return { ok: true, visible: true, created: false }
}

function toggleChatWindow(anchor) {
  if (!xiaozhiEnabled) return { ok: false, visible: false, disabled: true }
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) return hideChatWindow()
  return showChatWindow(anchor)
}

// 插件停用小智时关闭已打开的小智对话窗

function restoreWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isVisible()) mainWindow.showInactive()
  applyWindowLayering()
  if (lockControlWindow && !lockControlWindow.isDestroyed()) {
    if (!lockControlAnchor) positionLockControlAtDefault()
    if (!lockControlWindow.isVisible()) lockControlWindow.showInactive()
  }
}

function sendLockControlState() {
  if (!lockControlWindow || lockControlWindow.isDestroyed()) return
  lockControlWindow.webContents.send('mio-lock-control:state', { locked: clickThroughLocked })
}

function positionLockControlAtDefault() {
  if (!lockControlWindow || lockControlWindow.isDestroyed()) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const area = display.workArea
  const size = 34
  lockControlWindow.setBounds({
    x: Math.round(area.x + area.width - size - 14),
    y: Math.round(area.y + area.height * 0.55 - size / 2),
    width: size,
    height: size,
  }, false)
  reportWindowAction('pet-lock-control', lockControlWindow, 'positioned')
}

function positionLockControl(anchor) {
  if (!anchor || typeof anchor !== 'object') return
  const values = ['x', 'y', 'width', 'height'].map((key) => Number(anchor[key]))
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return
  lockControlAnchor = { x: values[0], y: values[1], width: values[2], height: values[3] }
  if (!lockControlWindow || lockControlWindow.isDestroyed()) return
  const desktop = virtualBounds()
  const anchorCenter = {
    x: Math.round(desktop.x + lockControlAnchor.x + lockControlAnchor.width / 2),
    y: Math.round(desktop.y + lockControlAnchor.y + lockControlAnchor.height / 2),
  }
  const workArea = screen.getDisplayNearestPoint(anchorCenter).workArea
  const size = 34
  const preferredX = desktop.x + lockControlAnchor.x + lockControlAnchor.width - size - 10
  // 放在角色右下方，避免挡住头顶的输入框和说话气泡。
  const preferredY = desktop.y + lockControlAnchor.y + lockControlAnchor.height + 10
  const x = Math.round(Math.max(workArea.x + 6, Math.min(workArea.x + workArea.width - size - 6, preferredX)))
  const y = Math.round(Math.max(workArea.y + 6, Math.min(workArea.y + workArea.height - size - 6, preferredY)))
  lockControlWindow.setBounds({ x, y, width: size, height: size }, false)
  reportWindowAction('pet-lock-control', lockControlWindow, 'positioned')
  if (!lockControlWindow.isVisible()) lockControlWindow.showInactive()
}

function createLockControlWindow() {
  lockControlWindow = new BrowserWindow({
    width: 34,
    height: 34,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'lock-control-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  reportWindowAction('pet-lock-control', lockControlWindow, 'created')
  lockControlWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  lockControlWindow.loadFile(path.join(__dirname, 'lock-control.html'))
  lockControlWindow.webContents.on('did-finish-load', () => {
    sendLockControlState()
    if (lockControlAnchor) positionLockControl(lockControlAnchor)
    else positionLockControlAtDefault()
    lockControlWindow.showInactive()
    reportWindowAction('pet-lock-control', lockControlWindow, 'shown')
  })
  lockControlWindow.on('closed', () => {
    reportWindowAction('pet-lock-control', lockControlWindow, 'closed')
    lockControlWindow = null
  })
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  const items = [
    {
      label: '固定并穿透',
      type: 'checkbox',
      checked: clickThroughLocked,
      click: (item) => setClickThroughLocked(Boolean(item.checked), true),
    },
    { label: '显示桌宠', click: () => restoreWindowVisibility() },
  ]
  // DSH 专用化：原条件是"xiaozhi 启用才提供打开小智对话"。
  // 对话横条现在是桌宠自己的功能（走 /api/companion/chat），恒可用；
  // 文案也从小智改为桌宠，与阉割后的实际语义一致。
  items.push({ label: '打开对话横条', click: () => toggleChatWindow() })
  items.push(
    { label: '导入 Live2D 模型', click: () => importModel() },
    { label: '桌宠管理', click: () => openPetAdmin() },
    { type: 'separator' },
    { label: '退出桌宠', click: () => { quitting = true; app.quit() } },
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function setClickThroughLocked(enabled, notifyRenderer = false) {
  const nextValue = Boolean(enabled)
  const changed = clickThroughLocked !== nextValue
  clickThroughLocked = nextValue
  if (changed) saveRuntimeState({ clickThroughLocked })
  if (nextValue) {
    // 进入锁定穿透模式：确保解锁浮窗存在（锁定模式下它是唯一可点击的交互入口）
    if (!lockControlWindow || lockControlWindow.isDestroyed()) {
      createLockControlWindow()
    } else if (!lockControlWindow.isVisible()) {
      lockControlWindow.showInactive()
    }
  } else if (lockControlWindow && !lockControlWindow.isDestroyed() && !lockControlWindow.isVisible()) {
    // 退出锁定模式：浮窗保持常驻（按钮继续提供"锁定"入口），恢复显示
    lockControlWindow.showInactive()
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    applyMainWindowMousePolicy()
    if (notifyRenderer) {
      mainWindow.webContents.send('mio-desktop:click-through-changed', clickThroughLocked)
    }
  }
  sendLockControlState()
  if (changed) updateTrayMenu()
}

// ---- 副屏虚拟边界（DIP 与物理像素换算，修正跨屏坐标） ----
const SYSTEM_PS = 'pwsh.exe'
const PHYS_BOUNDS_SCRIPT = path.join(__dirname, '..', '..', 'phys_bounds.ps1')

function applyMainWindowVirtualBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    execFile(SYSTEM_PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PHYS_BOUNDS_SCRIPT],
      { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        if (error) { log('window.extend_failed', String(error.message || error)); notifyWindowStable(); return }
        const line = String(stdout || '').trim().split(/\r?\n/).pop()
        const parts = line.split(',').map(Number)
        if (parts.length < 5 || !parts.every(Number.isFinite) || parts[4] <= 0) {
          log('window.extend_bad_output', line); notifyWindowStable(); return
        }
        const [physL, physT, physR, physB, primaryPhysW] = parts
        const primaryLogicalW = screen.getPrimaryDisplay().bounds.width
        const scale = primaryPhysW / Math.max(1, primaryLogicalW)
        mainWindow.setBounds({
          x: Math.round(physL / scale),
          y: Math.round(physT / scale),
          width: Math.round((physR - physL) / scale),
          height: Math.round((physB - physT) / scale),
        }, false)
        reportWindowAction('pet-root', mainWindow, 'repositioned-virtual')
        log('window.virtual_bounds', `${physL},${physT},${physR},${physB} scale=${scale.toFixed(3)}`)
        notifyWindowStable()
      })
  } catch (error) {
    log('window.extend_failed', String(error && error.message || error))
    notifyWindowStable()
  }
}

// 窗口虚拟边界修正完成（成功或失败）后通知渲染层：
// 渲染层此前保持模型隐藏，收到本消息才用最终坐标系 fit 并显示，杜绝启动跳位
function notifyWindowStable() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mio-desktop:window-stable')
    }
  } catch (_) {}
}

function registerDisplayListeners() {
  // 显示器增减/分辨率变化后自动修正桌宠虚拟边界
  screen.on('display-added', () => setTimeout(applyMainWindowVirtualBounds, 400))
  screen.on('display-removed', () => setTimeout(applyMainWindowVirtualBounds, 400))
  screen.on('display-metrics-changed', () => setTimeout(applyMainWindowVirtualBounds, 600))
}

function createWindow() {
  const bounds = virtualBounds()
  mainWindow = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    fullscreenable: false,
    thickFrame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  reportWindowAction('pet-root', mainWindow, 'created')
  desiredAlwaysOnTop = true
  clickThroughLocked = Boolean(loadRuntimeState().clickThroughLocked)
  restoreWindowVisibility()
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 新窗口实例的穿透状态独立，重置去重标记确保首次判定一定下发
  lastIgnoreMouseEvents = null
  setMouseInteractive(false)
  try { mainWindow.webContents.session.clearCache() } catch (_e) {}
  try { mainWindow.webContents.session.setCacheSizeLimit(0) } catch (_e) {}
  mainWindow.loadURL(`${API_BASE}/agent-app/live2d-pet/index.html?runtime=electron&v=20261020-orbnum`)
  log('window.load', `${API_BASE}/agent-app/live2d-pet/index.html`)
  // 主进程轮询鼠标位置驱动穿透/交互（不依赖渲染层 forward 转发）
  // 60ms ≈ 16Hz：穿透策略与视线跟随共用，兼顾响应度与开销
  if (!mousePolicyTimer) {
    mousePolicyTimer = setInterval(() => {
      if (quitting || !mainWindow || mainWindow.isDestroyed()) return
      applyMainWindowMousePolicy()
      sendMouseMoveToRenderer()
    }, 60)
  }
  // 启动后多次尝试修正跨屏虚拟边界（等渲染完成）
  ;[1200, 3200, 8000, 15000].forEach((ms) => setTimeout(applyMainWindowVirtualBounds, ms))
  mainWindow.once('ready-to-show', () => restoreWindowVisibility())
  mainWindow.on('show', () => reportWindowAction('pet-root', mainWindow, 'shown'))
  mainWindow.on('focus', () => reportWindowAction('pet-root', mainWindow, 'focused'))
  mainWindow.webContents.on('did-finish-load', () => restoreWindowVisibility())
  mainWindow.on('blur', () => {
    if (desiredAlwaysOnTop) setTimeout(restoreWindowVisibility, 40)
  })
  mainWindow.on('minimize', () => {
    if (desiredAlwaysOnTop) setTimeout(restoreWindowVisibility, 40)
  })
  mainWindow.on('hide', () => {
    reportWindowAction('pet-root', mainWindow, 'hidden')
    if (desiredAlwaysOnTop && !quitting) setTimeout(restoreWindowVisibility, 40)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    log('window.load_failed', `${code} ${description}`)
  })
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('preload.error', `${preloadPath} ${error?.message || error}`)
  })
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) log('renderer.console', `[level=${level}] ${String(message).slice(0, 400)}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('renderer.gone', `${details.reason} ${details.exitCode}`)
    if (quitting) return
    const now = Date.now()
    rendererRestarts = rendererRestarts.filter((value) => now - value < 60000)
    if (rendererRestarts.length >= 3) return
    rendererRestarts.push(now)
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
    }, details.reason === 'oom' ? 2500 : 800)
  })
  mainWindow.on('closed', () => {
    reportWindowAction('pet-root', mainWindow, 'closed')
    mainWindow = null
  })
  createLockControlWindow()  // 锁定/解锁按钮常驻（右下角圆钮），锁定模式提供穿透豁免入口，非锁定模式提供锁定入口
  clearInterval(topmostWatchdog)
  topmostWatchdog = setInterval(() => {
    if (!quitting && desiredAlwaysOnTop) restoreWindowVisibility()
  }, 1500)
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath())
  tray = new Tray(image)
  tray.setToolTip('Mio Live2D 桌宠')
  const showPet = () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    else restoreWindowVisibility()
  }
  updateTrayMenu()
  tray.on('double-click', showPet)
}

function registerIpc() {
  ipcMain.handle('mio-desktop:get-state', () => ({
    apiBase: API_BASE,
    bounds: virtualBounds(),
    workArea: workAreaBounds(),
    models: modelCatalog(),
    selectedModelId: String(loadRuntimeState().selectedModelId || ''),
    clickThroughLocked,
  }))
  ipcMain.on('mio-desktop:set-interactive', (_event, interactive) => setMouseInteractive(Boolean(interactive)))
  ipcMain.on('mio-desktop:model-bounds', (_event, bounds) => {
    modelBounds = bounds && Number.isFinite(bounds?.x) ? {
      x: Number(bounds.x),
      y: Number(bounds.y),
      width: Number(bounds.width),
      height: Number(bounds.height),
    } : null
  })
  // ★ 横条命中区（2026-10-17 用户裁决）：横条是全屏透明窗口里的一个小元素，
  //   之前渲染层在横条可见时 setInteractive(true) ⇒ **整个窗口**可交互 ⇒
  //   桌宠窗口后面的整块屏幕（如 B 站视频）全被挡住。改为照抄 modelBounds 的
  //   区域命中机制：渲染层上报横条矩形，主进程只在鼠标落进这一小块时才可交互。
  ipcMain.on('mio-desktop:strip-bounds', (_event, bounds) => {
    stripBounds = bounds && Number.isFinite(bounds?.x) && Number(bounds.width) > 0 ? {
      x: Number(bounds.x),
      y: Number(bounds.y),
      width: Number(bounds.width),
      height: Number(bounds.height),
    } : null
  })
  ipcMain.on('mio-desktop:ui-open', (_event, open) => {
    uiOpen = Boolean(open)
  })
  ipcMain.on('mio-desktop:set-click-through-locked', (_event, enabled) => {
    setClickThroughLocked(Boolean(enabled), false)
  })
  ipcMain.on('mio-desktop:set-lock-control-anchor', (_event, bounds) => {
    positionLockControl(bounds)
  })
  ipcMain.on('mio-lock-control:toggle', () => {
    setClickThroughLocked(!clickThroughLocked, true)
  })
  // ★ 2026-10-18 用户裁决：锁图标**右键 = 把桌宠叫回右下角**（左键仍是上/解锁）。
  //   实现在渲染层（那里才知道模型尺寸与虚拟屏偏移），主进程只负责转发。
  ipcMain.on('mio-lock-control:reset', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mio-desktop:reset-position')
    }
  })
  ipcMain.on('mio-desktop:set-always-on-top', (_event, enabled) => {
    desiredAlwaysOnTop = Boolean(enabled)
    restoreWindowVisibility()
  })
  ipcMain.on('mio-desktop:set-chat-window-open', (_event, open) => setChatWindowOpen(open))
  // DSH 专用化：原 `mio-desktop:set-agent-plugin` 只处理 xiaozhi 的启用/停用
  // （停用时关掉对话窗、刷新托盘）。小智插件已阉割，该 IPC 保留为**空实现**，
  // 以免渲染层若有残留调用时报 "no handler registered"。
  ipcMain.on('mio-desktop:set-agent-plugin', () => { /* no-op：小智已移除 */ })
  ipcMain.handle('mio-desktop:toggle-chat-window', (_event, anchor) => toggleChatWindow(anchor))
  ipcMain.handle('mio-desktop:show-chat-window', (_event, anchor) => showChatWindow(anchor))
  ipcMain.on('mio-pet-chat:hide', () => hideChatWindow())
  ipcMain.on('mio-pet-chat:open-admin', () => openPetAdmin())
  ipcMain.on('mio-desktop:restore-visibility', () => restoreWindowVisibility())
  ipcMain.handle('mio-desktop:import-model', importModel)
  ipcMain.handle('mio-desktop:select-model', (_event, modelId) => {
    const id = String(modelId || '')
    const available = modelCatalog().some((model) => model.id === id)
    saveRuntimeState({ selectedModelId: available ? id : '' })
    sendModelsChanged()
    return { ok: true, selectedModelId: available ? id : '' }
  })
  ipcMain.handle('mio-desktop:open-agent', () => openPetAdmin())
  // ───────────────────────────────────────────────────────────────────────────
  // ★ 双击桌宠 → 打开 **DSH 主应用**（2026-10-18 用户需求）
  //
  // 原来双击打开的是「MIO 管理窗里的 DSH 面板」，那是本项目的只读状态页；
  // 用户真正想跳转的是**正在跑任务的 DeepSeek Harness 主应用界面**。
  //
  // 策略（优先级从高到低）：
  //   ① 已有 DSH 窗口在跑 → 把它**激活到前台**（不新开实例，避免开出第二个 DSH）
  //   ② 没在跑 → 用已知路径启动 DSH
  //   ③ 都失败 → 由渲染层回落（保持原来的面板行为，不让双击变成死键）
  //
  // 激活窗口用 PowerShell + user32（SetForegroundWindow / ShowWindow）：
  //   Electron 自身没有「激活别的进程窗口」的 API，而 DSH 是独立进程。
  //   ▸ SW_RESTORE(9) 先还原（最小化时也能拉起来）
  //   ▸ 附带 ALT 键技巧绕过 Windows 前台锁（只 SetForegroundWindow 常被拒）
  // ───────────────────────────────────────────────────────────────────────────
  ipcMain.handle('mio-desktop:open-dsh-app', async () => {
    const DSH_EXE = String(process.env.MIO_DSH_EXE || '')
      || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')

    // ① 找正在跑的 DSH 主窗口并激活
    //
    // ⚠ 2026-10-18 修 bug：原实现把 PowerShell 脚本写成 JS 反引号模板字符串，
    //   里面既有 PowerShell 的 here-string 又有 $ 变量，经过模板字面量后语义被破坏，
    //   且依赖 `powershell` 在 PATH 里（Electron 从 DSH 继承的环境未必有）。
    //   现在改成**普通字符串数组 join**（彻底避开反引号/插值），并用 powershell 的
    //   绝对路径（%SystemRoot%\System32\...）+ 落盘脚本文件执行，不依赖 PATH。
    const psLines = [
      '$ErrorActionPreference = "SilentlyContinue"',
      'Add-Type -TypeDefinition @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class DshWin {',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
      '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
      '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);',
      '}',
      '"@',
      '$target = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue |',
      '  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
      'if (-not $target) { Write-Output "NO-WINDOW"; exit 0 }',
      '$h = $target.MainWindowHandle',
      'if ([DshWin]::IsIconic($h)) { [DshWin]::ShowWindow($h, 9) | Out-Null }',
      '$fg = [DshWin]::GetForegroundWindow()',
      '$fgThread = [DshWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)',
      '$myThread = [DshWin]::GetCurrentThreadId()',
      '[DshWin]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null',
      '[DshWin]::SetForegroundWindow($h) | Out-Null',
      '[DshWin]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null',
      'Write-Output ("ACTIVATED " + $target.Id)',
    ].join('\r\n')

    // powershell 绝对路径（不依赖 PATH；Electron 从 DSH 继承的环境未必有 powershell）
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const runPsScript = (scriptPath) => new Promise((resolve) => {
      execFile(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: 8000, windowsHide: true },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }))
    })

    try {
      // 脚本落盘到临时文件再执行：比 -EncodedCommand 更稳（长脚本/中文/引号都不怕）
      const scriptPath = path.join(os.tmpdir(), `mao-dsh-activate-${process.pid}.ps1`)
      // PowerShell 5.1 读 .ps1 默认按 ANSI；脚本纯 ASCII，安全
      fs.writeFileSync(scriptPath, psLines, 'utf8')
      let r1 = { stdout: '' }
      try { r1 = await runPsScript(scriptPath) } catch (_) {}
      try { fs.unlinkSync(scriptPath) } catch (_) {}

      if (/ACTIVATED/.test(r1.stdout)) {
        log('dsh.activate', r1.stdout.trim())
        return { ok: true, mode: 'activated', detail: r1.stdout.trim() }
      }
      if (/NO-WINDOW/.test(r1.stdout)) {
        // ② DSH 没在跑（或没有窗口）→ 启动它
        if (fs.existsSync(DSH_EXE)) {
          const { spawn } = require('child_process')
          spawn(DSH_EXE, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
          log('dsh.launch', `已启动 ${DSH_EXE}`)
          return { ok: true, mode: 'launched', detail: DSH_EXE }
        }
        log('dsh.open.failed', 'DSH 未运行且找不到可执行文件')
        return { ok: false, reason: 'dsh-not-found', detail: DSH_EXE }
      }
      log('dsh.open.failed', `激活脚本无预期输出｜stdout=${r1.stdout.trim()}｜stderr=${(r1.stderr || '').trim().slice(0, 200)}`)
      return { ok: false, reason: 'activate-failed', detail: (r1.stderr || r1.stdout || '').trim().slice(0, 300) }
    } catch (err) {
      log('dsh.open.error', String(err && err.message ? err.message : err))
      return { ok: false, reason: 'error', detail: String(err && err.message ? err.message : err) }
    }
  })
  // ★ 双击桌宠直达 DSH 面板（2026-10-17 用户要求）：打开管理窗后在其渲染层
  //   触发 dsh-panel 的 show()。面板脚本可能还没 boot 完（窗口首次创建），
  //   故带重试：每 400ms 试一次，最多 15 次（≈6s）。
  ipcMain.handle('mio-desktop:open-dsh-panel', async () => {
    openPetAdmin()
    const win = petAdminWindow
    if (!win || win.isDestroyed()) return { ok: false, reason: 'no-admin-window' }
    for (let i = 0; i < 15; i += 1) {
      try {
        const shown = await win.webContents.executeJavaScript(
          '(function(){ if (window.__mioDshPanel && typeof window.__mioDshPanel.show === "function")'
          + ' { window.__mioDshPanel.show(); return true } return false })()',
        )
        if (shown) return { ok: true, tries: i + 1 }
      } catch (_) { /* 页面还没就绪，继续等 */ }
      await new Promise((r) => setTimeout(r, 400))
    }
    return { ok: false, reason: 'dsh-panel-not-ready' }
  })
  // DSH 专用化：`open-xiaozhi` / `open-screen-crop` / `xiaozhi-bubble` 三个 IPC 已移除
  // （小智插件与其视觉通路已阉割）。用 on() 而非 handle()，所以渲染层若仍有残留调用
  // 也只是无人接收，不会抛 "no handler registered"。
  // 小智表情/口型事件转发给桌宠主窗（speaking/motion 等）
  ipcMain.on('mio-desktop:pet-event', (_event, ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mio-pet-event', ev)
    }
  })
  ipcMain.handle('mio-desktop:get-version', () => ({
    app: 'Mio Live2D 桌宠',
    frontend: 'runtime-v12',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    build: '2026-10-09',
  }))
  ipcMain.on('mio-desktop:close', () => { quitting = true; app.quit() })
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
else {
  app.on('second-instance', () => {
    restoreWindowVisibility()
  })
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => (
      permission === 'media' && requestingOrigin.startsWith(`${API_BASE}/`)
    ))
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const originAllowed = webContents.getURL().startsWith(`${API_BASE}/`)
      callback(permission === 'media' && originAllowed)
    })
    // ★ 2026-10-24 音频反应（舞蹈/呼吸摆动）所需：允许渲染端**采集系统输出音频**。
    //
    //   为什么需要这个处理器：Chromium 的 getDisplayMedia 默认会弹「选择共享内容」对话框，
    //   而在 Electron 里**不注册这个处理器就只会拿到黑屏/静音流**（甚至直接 reject）。
    //   我们要的不是"录屏"，而是"声卡输出端点的回环音频" —— 也就是用户正在听的声音
    //   （浏览器/播放器/游戏/她自己发的语音），所以这里：
    //     · video 给一个占位来源（桌宠窗口自身），因为 API 要求必须有 video 轨道；
    //       渲染端拿到后立刻 stop 掉 videoTrack，只留 audio，不产生任何录制/开销；
    //     · audio: 'loopback' → Chromium 原生 WASAPI 回环，全频段 44.1k 立体声。
    //
    //   安全：只对 `${API_BASE}/` 来源放行（和上面两个权限处理器一致），
    //   外部网页拿不到系统音频。
    //
    //   ★ Electron 43 实测要点：getDisplayMedia **必须**能拿到 video 轨，
    //     只回 `{audio:'loopback'}` 会被判为"没有可用来源"而 reject。
    //     所以必须同时给一个视频源（这里用桌宠自己的窗口），渲染端拿到后
    //     立刻 stop 掉 videoTrack —— 既不录屏，也不产生额外编码开销。
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        const origin = String((request && request.securityOrigin) || '')
        const allowed = origin.startsWith(`${API_BASE}/`) || origin.startsWith('http://127.0.0.1:')
        if (!allowed) {
          log('audio.loopback', `拒绝来源 ${origin || '(unknown)'}`)
          callback({})
          return
        }
        // video 只是"占位"，用来满足 getDisplayMedia 的来源校验；音频才是我们要的
        const videoSource = mainWindow && !mainWindow.isDestroyed()
          ? mainWindow
          : (BrowserWindow.getAllWindows()[0] || null)
        const options = { audio: 'loopback' }
        if (videoSource && typeof videoSource.getMediaSourceId === 'function') {
          options.video = videoSource.getMediaSourceId()
        } else if (videoSource) {
          options.video = videoSource
        }
        log('audio.loopback', `授权系统音频回环 origin=${origin} video=${Boolean(options.video)}`)
        callback(options)
      },
      { useSystemPicker: false },
    )
    await startModelServer()
    log('runtime.ready', `modelServer=${modelServerOrigin}`)
    registerIpc()
    registerDisplayListeners()
    // DSH 专用化：原 registerScreenShortcut()（Ctrl+Shift+S 框选提问）已移除，
    // 它依赖已阉割的小智视觉接口 /api/xiaozhi/vision-bubble。见文件下方说明。
    createWindow()
    createTray()
    startParentWatchdog()
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 退出时连带关闭后端（2026-10-18 修 bug）
//
// 症状（用户报障）：右键「退出桌宠」只结束了 UI 进程，后端 python 仍在跑并占着
//   :8000，导致 DSH 自己升版本、换 host 端口时被堵住。
//
// 根因：后端由 start_mio.ps1 用 Start-Process 起成**独立隐藏进程**，与 Electron
//   没有父子关系；原来的 before-quit 只清 UI 侧（定时器/窗口/modelServer），
//   从来没碰后端。
//
// 修法（两级，先优雅后兜底）：
//   ① POST /api/runtime/self-shutdown —— 后端走正常 lifespan 清理再退出；
//   ② 等 ~1.2s，若 :8000 仍在监听 → 按「端口 + 命令行」**精确**匹配杀进程。
//      绝不能按进程名 "python" 杀：用户可能开着别的 Python 项目。
//
// 只在**用户主动退出**时才做（quitting 由菜单/close 消息置位），单实例锁失败
// 那条路径不动别人的后端。
// ─────────────────────────────────────────────────────────────────────────────
function backendStillListening() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: 8000, path: '/api/runtime/policies', method: 'GET', timeout: 700 },
      (res) => { res.resume(); resolve(true) },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

function askBackendShutdown() {
  return new Promise((resolve) => {
    const body = '{}'
    const req = http.request(
      `${API_BASE}/api/runtime/self-shutdown`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 1500,
      },
      (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300) },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.write(body)
    req.end()
  })
}

/** 兜底：精确杀掉监听 8000 且命令行是本项目 uvicorn 的进程。 */
function killBackendByPort() {
  try {
    const { execFileSync } = require('child_process')
    // 找监听 :8000 的 PID（Get-NetTCPConnection 是 Windows 自带，无需额外依赖）
    const psOut = execFileSync(
      'powershell',
      ['-NoProfile', '-Command',
        "(Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique"],
      { encoding: 'utf8', timeout: 4000, windowsHide: true },
    )
    const pids = String(psOut).split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
    for (const pid of pids) {
      // 二次确认：命令行必须同时含 uvicorn 与 app.main:app，避免误杀别的东西
      let cmdline = ''
      try {
        cmdline = String(execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { encoding: 'utf8', timeout: 4000, windowsHide: true },
        ) || '')
      } catch (_) { continue }
      if (!/uvicorn/i.test(cmdline) || !/app\.main:app/i.test(cmdline)) continue
      try {
        process.kill(pid, 'SIGTERM')
        log('backend.kill', `已按端口精确结束后端 pid=${pid}`)
      } catch (_) {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 4000, windowsHide: true }) } catch (_e) {}
      }
    }
    if (!pids.length) log('backend.kill', '未发现监听 8000 的进程')
  } catch (err) {
    log('backend.kill.failed', String(err && err.message ? err.message : err))
  }
}

let backendShutdownStarted = false

/**
 * 关闭后端。返回 Promise，最迟约 3.5s 内 resolve（不阻塞退出太久）。
 */
async function shutdownBackend() {
  if (backendShutdownStarted) return
  backendShutdownStarted = true
  try {
    const alive = await backendStillListening()
    if (!alive) { log('backend.shutdown', '后端未运行，跳过'); return }
    const accepted = await askBackendShutdown()
    log('backend.shutdown', accepted ? '已请求后端自关闭' : '自关闭端点不可用，走兜底')
    // 给 lifespan 清理留时间；期间轮询确认它真的退出了
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 200))
      if (!(await backendStillListening())) { log('backend.shutdown', '后端已退出'); return }
    }
    log('backend.shutdown', '后端未在期限内退出，按端口精确清理')
    killBackendByPort()
    await new Promise((r) => setTimeout(r, 300))
  } catch (err) {
    log('backend.shutdown.failed', String(err && err.message ? err.message : err))
    try { killBackendByPort() } catch (_) {}
  }
}

/**
 * 带硬超时的后端清理：**绝不因为后端异常而卡住桌面退出**。
 * 用户点了「退出桌宠」，桌宠必须退出，这是契约；后端清理是尽力而为。
 */
function shutdownBackendWithTimeout(maxMs = 4000) {
  return Promise.race([
    shutdownBackend(),
    new Promise((resolve) => setTimeout(() => {
      log('backend.shutdown.timeout', `${maxMs}ms 内未完成，强制继续退出`)
      try { killBackendByPort() } catch (_) {}
      resolve()
    }, maxMs)),
  ])
}

app.on('window-all-closed', (event) => {
  if (!quitting) event.preventDefault()
})

// DSH 专用化（用户裁决 2026-10-17）：全局快捷键 Ctrl+Shift+S「框选屏幕提问」已移除。
//   它拉起 live2d-pet/overlay.html，该页调用 /api/xiaozhi/vision-bubble（小智官方云视觉），
//   随小智插件阉割已删除。将来若做 DSH 侧屏幕问答，应走新的 DSH 视觉通路，不要复活这套。

let quitCleanupDone = false

app.on('before-quit', (event) => {
  quitting = true
  clearInterval(topmostWatchdog)
  clearInterval(parentWatchdog)
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.destroy()
  if (modelServer) modelServer.close()

  // 后端清理：异步做完再真正退出。已经做完就直接放行（否则会二次进入这里）。
  // 用带硬超时的版本：后端异常绝不能卡住桌面退出。
  if (!quitCleanupDone) {
    event.preventDefault()
    shutdownBackendWithTimeout().finally(() => {
      quitCleanupDone = true
      app.quit()     // 再走一轮 before-quit，这次直接放行
    })
  }
})

// 兜底：万一上面那条路径被打断（比如被杀软拦、或 app.quit 被其它监听器取消），
//   will-quit 时再同步踢一脚 —— 此时已无法 await，用同步精确杀。
app.on('will-quit', () => {
  try {
    if (!backendShutdownStarted) killBackendByPort()
  } catch (_) {}
})
