/* _config.cjs — 插件市场回归测试的共享配置（别人拉代码后能直接跑的关键）
 *
 * 为什么要有这个文件：这几份测试最早是我在 probe_tmp/ 里现写的，
 * 里面把 Chrome 路径、端口、dist 路径全写死了 —— 换台机器/换个目录就跑不起来。
 * 挪进仓库当"正式回归"之后，这些必须全部变成可探测 + 可用环境变量覆盖。
 *
 * 可用环境变量（都有合理缺省，一般不用设）：
 *   PET_CHROME   Chrome/Chromium 可执行文件（默认自动探测常见安装位置）
 *   PET_BASE_URL 后端地址（默认 http://127.0.0.1:8000）
 *   MIO_DIST     前端产物目录（默认从本文件位置推出仓库根的 澪Agent应用/dist）
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 仓库根：本文件在 <root>/澪Agent应用/tests/market/_config.cjs */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const APP_DIR = path.join(REPO_ROOT, '澪Agent应用')
const DIST = process.env.MIO_DIST
  ? path.resolve(process.env.MIO_DIST)
  : path.join(APP_DIR, 'dist')

const BASE = (process.env.PET_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '')

/** 探测 Chrome。顺序：环境变量 → 常见安装位置 → playwright 自带 chromium。 */
function detectChrome() {
  if (process.env.PET_CHROME) {
    if (!fs.existsSync(process.env.PET_CHROME)) {
      throw new Error('PET_CHROME 指向的文件不存在：' + process.env.PET_CHROME)
    }
    return process.env.PET_CHROME
  }
  const candidates = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // 最后交给 playwright 自带的 chromium（它自己知道路径）
  return undefined
}

/** 统一启动参数（与现有 e2e_stream_pet.cjs 保持一致的沙箱规避）。 */
function launchOptions() {
  const executablePath = detectChrome()
  const opts = { args: ['--no-sandbox'] }
  if (executablePath) opts.executablePath = executablePath
  return opts
}

/** 后端是否就绪。测试前置检查，给出人话错误而不是一堆 ECONNREFUSED。 */
async function assertBackend() {
  try {
    const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
  } catch (e) {
    throw new Error(
      '后端没起或不可达：' + BASE + '\n' +
      '  先启动后端（仓库根的 启动桌宠.cmd / restart_mio.ps1），再跑本测试。\n' +
      '  原始错误：' + (e && e.message)
    )
  }
}

/** 插件目录（测试会往里造临时插件）。 */
function pluginsDir() {
  return path.join(DIST, 'plugins')
}

/** 造一个临时插件目录，返回路径。调用方负责删除（建议挂 process.on('exit')）。 */
function makeProbePlugin(dirName, files) {
  const dir = path.join(pluginsDir(), dirName)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8')
  }
  return dir
}

/** 删临时插件目录。
 *  Windows 上 node 的 rmSync 对"刚被浏览器读过文件"的目录可能报成功但没删掉（实测），
 *  所以再用 rmdir /s /q 兜一层。
 */
function removeDir(dir) {
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    if (fs.existsSync(dir) && process.platform === 'win32') {
      require('node:child_process').execSync(
        'rmdir /s /q "' + dir.replace(/\//g, '\\') + '"',
        { stdio: 'ignore' }
      )
    }
  } catch (e) { /* 清理失败不该让测试红 */ }
}

/** 装一个"进程退出时清理"的兜底（测试中途失败也留不下垃圾）。 */
function cleanupOnExit(dir) {
  process.once('exit', () => removeDir(dir))
}

/** 简洁的断言收集器（几个脚本复用的同一套输出风格）。 */
function makeChecker() {
  let pass = 0
  const failures = []
  return {
    check(name, ok, detail) {
      if (ok) { pass++; console.log('  [OK]   ' + name) }
      else {
        failures.push(name)
        console.log('  [FAIL] ' + name + (detail === undefined ? '' : ' — ' + detail))
      }
    },
    report(title) {
      const fail = failures.length
      console.log('\n' + '='.repeat(68))
      console.log(`结果：${pass} 通过 / ${fail} 失败`)
      if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
      console.log('='.repeat(68))
      return fail === 0 ? 0 : 1
    },
  }
}

/** 截图输出路径：统一落到 tests/market/.screenshots/（该目录已 gitignore）。
 *  不让脚本往"当前工作目录"里乱建 .ui-shots/ —— 别人在仓库根跑就会留下一堆杂物。
 */
function shotPath(name) {
  const dir = path.join(__dirname, '.screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}

module.exports = {
  REPO_ROOT, APP_DIR, DIST, BASE,
  detectChrome, launchOptions, assertBackend,
  pluginsDir, makeProbePlugin, removeDir, cleanupOnExit,
  shotPath,
  makeChecker,
}
