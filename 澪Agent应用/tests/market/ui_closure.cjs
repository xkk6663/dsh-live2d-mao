/* ui_closure.cjs — 插件市场 UI 闭环实测（真 Chrome + 真后端）
 *
 * 只验证「用户眼睛能看到、手指能点到」的那条链：
 *   打开管理窗 → 左侧出现「插件市场」→ 点开 → 卡片渲染 → 停用 DSH（导航+tab 同时消失）
 *   → 启用回来 → 上架一个新插件（卡片立即出现）→ 下架（卡片立即消失）→ 内置项按钮灰掉
 *
 * 跑法（后端必须先起着）：
 *   NODE_PATH=<有 playwright 的 node_modules> node 澪Agent应用/tests/market/ui_closure.cjs
 *   可覆盖：PET_CHROME（浏览器路径）/ PET_BASE_URL（后端地址）/ MIO_DIST（前端产物目录）
 *
 * 与 market_panel_harness.cjs 的区别：那个是假 DOM 单测，
 * 这个是真浏览器、真 CSS、真 loader、真后端。两者互补，不互相替代。
 */
const { chromium } = require('playwright')
const cfg = require('./_config.cjs')

const BASE = cfg.BASE
const PAGE = `${BASE}/agent-app/index.html`

const { check, report } = cfg.makeChecker()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fs = require('node:fs')
const path = require('node:path')
const shotPath = cfg.shotPath

async function api(path, opts) {
  const res = await fetch(BASE + '/api/plugin/market' + path, opts)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch (e) { body = text }
  return { status: res.status, body }
}

async function waitFor(fn, timeout = 8000, step = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v } catch (e) { /* retry */ }
    await sleep(step)
  }
  return null
}

async function main() {
  await cfg.assertBackend()
  const browser = await chromium.launch(cfg.launchOptions())
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()) })

  console.log('=== 1. 打开管理窗 ===')
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const ready = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-mio-ready') === 'true'))
  check('页面就绪（data-mio-ready）', !!ready)

  console.log('\n=== 2. loader 按清单动态装载 ===')
  const loaded = await waitFor(async () => {
    const ids = await page.evaluate(() => Object.keys(window.__mioPluginRegistry ? { ...Object.fromEntries(window.__mioPluginRegistry.list().map((i) => [i, 1])) } : {}))
    return ids.length >= 3 ? ids : null
  })
  check('registry 至少 3 个插件', !!loaded, loaded && loaded.join(','))
  console.log('      实际: ' + (loaded || []).join(', '))

  const pluginScripts = await page.evaluate(() => Array.from(document.querySelectorAll('script[data-mio-plugin]')).map((s) => s.getAttribute('data-mio-plugin') + ':' + s.getAttribute('data-mio-plugin-kind')))
  check('页面上有动态插入的插件脚本', pluginScripts.length > 0, pluginScripts.join(', '))

  console.log('\n=== 3. 左侧出现「插件市场」入口 ===')
  const marketNav = await waitFor(async () => page.$('button[data-mio-plugin-nav="market"]'))
  check('左侧有「插件市场」导航按钮', !!marketNav)

  console.log('\n=== 4. 点开市场，卡片渲染 ===')
  await marketNav.click()
  await sleep(1200)
  const cardCount = await page.evaluate(() => {
    const t = document.body.innerText
    return (t.match(/内置|已启用|已停用/g) || []).length
  })
  check('市场页渲染出状态徽标', cardCount > 0, 'badge 数=' + cardCount)
  const hasNames = await page.evaluate(() => {
    const t = document.body.innerText
    return ['DSH', '桌宠', '插件市场'].every((n) => t.includes(n))
  })
  check('卡片里能看到 DSH / 桌宠 / 插件市场', hasNames)
  await page.screenshot({ path: shotPath('01-market-open.png') })

  console.log('\n=== 5. 停用 DSH：导航 + 设置 tab 同时消失 ===')
  const dshNavBefore = await page.$('button.dsh-nav')
  check('停用前 DSH 导航存在', !!dshNavBefore)
  const r1 = await api('/plugins/dsh/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
  check('停用 DSH 接口 200', r1.status === 200, JSON.stringify(r1.body))

  const reloaded = await page.evaluate(async () => {
    const l = window.__mioPluginLoader
    if (l && l.reload) await l.reload()
    const n = window.__mioPluginNav
    if (n && n.refresh) await n.refresh()
    return true
  })
  check('前端 reload + nav.refresh 执行', !!reloaded)
  await sleep(1500)
  const dshNavHidden = await page.evaluate(() => {
    const b = document.querySelector('button.dsh-nav')
    if (!b) return 'gone'
    return getComputedStyle(b).display === 'none' || b.style.display === 'none' ? 'hidden' : 'visible'
  })
  check('停用后 DSH 导航不可见', dshNavHidden !== 'visible', '实际=' + dshNavHidden)
  const dshInRegistry = await page.evaluate(() => window.__mioPluginRegistry.list().includes('dsh'))
  check('停用后 DSH 已从 registry 摘除', dshInRegistry === false)
  await page.screenshot({ path: shotPath('02-dsh-disabled.png') })

  console.log('\n=== 6. 重新启用 DSH ===')
  const r2 = await api('/plugins/dsh/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
  check('启用 DSH 接口 200', r2.status === 200)
  await page.evaluate(async () => { await window.__mioPluginLoader.reload(); await window.__mioPluginNav.refresh() })
  await sleep(1500)
  const dshBack = await page.evaluate(() => window.__mioPluginRegistry.list().includes('dsh'))
  check('启用后 DSH 回到 registry', dshBack === true)

  console.log('\n=== 7. 上架新插件 → 卡片立即出现 ===')
  const NEW_ID = 'uiprobe'
  const dir = cfg.pluginsDir() + '/' + '_uiprobe'
  // 兜底清理：中途断言失败/抛错时也要把自己造的临时插件目录删掉，
  // 否则它会一直留在 dist/plugins/ 里，让 check_plugin_contract.cjs 报"多了一个插件"。
  cfg.cleanupOnExit(dir)
  cfg.makeProbePlugin('_uiprobe', {
    'manifest.js': `/* uiprobe — UI 闭环验证用临时插件（验证后自动删除） */
window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['uiprobe'] = {
  agentId: 'uiprobe',
  name: 'UI探针',
  nav: { keywords: ['UI探针'], mode: 'own' },
  observeTab: false,
  health: false,
  bubble: { colorKey: 'uiprobe', accent: '#E67E22' },
  settingsTab: { id: 'uiprobe', label: 'UI探针', order: 960, panel: 'uiprobe-panel' },
}
if (window.__mioPluginRegistry) window.__mioPluginRegistry.register(window.__mioPluginManifests['uiprobe'])
`,
    'uiprobe-panel.js': `(function () {
  if (window.__mioUiprobePanelLoaded) return
  window.__mioUiprobePanelLoaded = true
  function renderInto(host) { host.innerHTML = '<div style="font-size:12px;">UI 探针面板</div>' }
  window['uiprobe-panel'] = { renderInto: renderInto }
})()
`,
  })

  const add = await api('/plugins', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: NEW_ID, name: 'UI探针', entry: 'plugins/_uiprobe/manifest.js', panel: 'plugins/_uiprobe/uiprobe-panel.js', accent: '#E67E22', category: 'tool', description: 'UI 闭环验证' }),
  })
  check('上架接口 200', add.status === 200, JSON.stringify(add.body))
  await page.evaluate(async () => { await window.__mioPluginLoader.reload(); await window.__mioPluginNav.refresh() })
  await sleep(1500)
  const probeLoaded = await page.evaluate(() => window.__mioPluginRegistry.list().includes('uiprobe'))
  check('上架后新插件被装载进 registry', probeLoaded === true)
  const probeNav = await page.evaluate(() => !!document.querySelector('button[data-mio-plugin-nav="uiprobe"]') || document.body.innerText.includes('UI探针'))
  check('上架后左侧出现新插件入口', probeNav === true)
  await page.screenshot({ path: shotPath('03-after-add.png') })

  console.log('\n=== 8. 下架 → 立即消失，且文件保留 ===')
  const del = await api('/plugins/' + NEW_ID, { method: 'DELETE' })
  check('下架接口 200', del.status === 200, JSON.stringify(del.body))
  check('下架响应声明 files_kept', del.body && del.body.files_kept === true)
  check('源文件仍在磁盘上', fs.existsSync(path.join(dir, 'manifest.js')))
  await page.evaluate(async () => { await window.__mioPluginLoader.reload(); await window.__mioPluginNav.refresh() })
  await sleep(1500)
  const probeGone = await page.evaluate(() => !window.__mioPluginRegistry.list().includes('uiprobe'))
  check('下架后新插件从 registry 摘除', probeGone === true)
  cfg.removeDir(dir)

  console.log('\n=== 9. 内置项（桌宠 / 插件市场）不可停用不可下架 ===')
  const r3 = await api('/plugins/pet/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
  check('停用内置 pet 被拒（403）', r3.status === 403, String(r3.status))
  const r4 = await api('/plugins/market', { method: 'DELETE' })
  check('下架内置 market 被拒（403）', r4.status === 403, String(r4.status))

  console.log('\n=== 10. 页面上没有 JS 报错 ===')
  const realErrors = errors.filter((e) => !/favicon|net::ERR|404 \(Not Found\)/i.test(e))
  check('无 pageerror / console.error', realErrors.length === 0, realErrors.slice(0, 5).join(' | '))

  await browser.close()
  process.exit(report())
}

main().catch((e) => { console.error('UI 闭环崩溃：', e); process.exit(2) })
