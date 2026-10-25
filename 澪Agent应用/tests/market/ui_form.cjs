/* ui_form.cjs — 点真实的「上架插件」表单，走完整交互 */
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const cfg = require('./_config.cjs')
const BASE = cfg.BASE

let pass = 0, fail = 0
function check(n, ok, d) {
  if (ok) { pass++; console.log('  [OK]   ' + n) }
  else { fail++; console.log('  [FAIL] ' + n + (d ? ' — ' + d : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await cfg.assertBackend()
  const b = await chromium.launch(cfg.launchOptions())
  const p = await b.newPage({ viewport: { width: 1400, height: 950 } })
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))

  await p.goto(BASE + '/agent-app/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(2500)
  await p.click('button[data-mio-plugin-nav="market"]')
  await sleep(1200)

  console.log('=== 打开上架表单 ===')
  // 找「＋ 上架插件」按钮
  const addBtn = await p.$('[data-mio-market-action="add"]') ||
    (await p.$$('button')).find ? null : null
  // 用文本定位更稳
  const clicked = await p.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
    const t = btns.find((x) => /上架插件|\+\s*上架/.test(x.textContent))
    if (t) { t.click(); return true }
    return false
  })
  check('找到并点击「上架插件」', clicked)
  await sleep(600)

  // 表单字段是否出现
  const fields = await p.evaluate(() => {
    const inp = Array.from(document.querySelectorAll('#mio-market-page input'))
    return inp.map((i) => i.getAttribute('data-mio-field') || i.name || i.placeholder || '?')
  })
  check('表单出现输入框', fields.length > 0, '字段=' + fields.join(','))
  console.log('    字段: ' + fields.join(' | '))

  console.log('\n=== 准备一个真插件并填表上架 ===')
  const dir = path.join(cfg.pluginsDir(), '_formprobe')
  // 兜底清理（同 ui_closure：中途失败也要删掉临时插件目录）
  global.__mioFormProbeDir = dir
  process.once('exit', () => {
    // Windows 上 node 的 rmSync 对刚被浏览器读过文件的目录可能
    // "报告成功但其实没删"（实测），用 rmdir /s /q 兜底。
    try {
      var _fs = require('node:fs')
      var _cp = require('node:child_process')
      var d = global.__mioFormProbeDir
      _fs.rmSync(d, { recursive: true, force: true })
      if (_fs.existsSync(d)) _cp.execSync('rmdir /s /q "' + d.replace(/\//g, '\\') + '"', { stdio: 'ignore' })
    } catch (e) {}
  })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.js'), `window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['formprobe'] = {
  agentId: 'formprobe', name: '表单探针',
  nav: { keywords: ['表单探针'], mode: 'own' },
  observeTab: false, health: false,
  bubble: { colorKey: 'formprobe', accent: '#16A085' },
  settingsTab: { id: 'formprobe', label: '表单探针', order: 970, panel: 'formprobe-panel' },
}
if (window.__mioPluginRegistry) window.__mioPluginRegistry.register(window.__mioPluginManifests['formprobe'])
`, 'utf8')
  fs.writeFileSync(path.join(dir, 'formprobe-panel.js'), `(function () {
  if (window.__mioFormProbePanelLoaded) return
  window.__mioFormProbePanelLoaded = true
  function renderInto(host) { host.innerHTML = '<div>表单探针面板</div>' }
  window['formprobe-panel'] = { renderInto: renderInto }
})()
`, 'utf8')

  // 填表：这些输入框没有 name/data-field，按 placeholder 特征定位
  const filled = await p.evaluate(() => {
    const root = document.querySelector('#mio-market-page')
    const setV = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const inputs = Array.from(root.querySelectorAll('input'))
    // 按 placeholder 语义匹配（这是面板实际使用的标记方式）
    const pick = (re) => inputs.find((i) => re.test(i.placeholder || ''))
    const plan = [
      [/例如 myplug|agentId/i, 'formprobe'],
      [/显示名|name/i, '表单探针'],
      [/^1\.0\.0$|版本|version/i, '1.0.0'],
      [/manifest\.js.*manifest|plugins\/myplug\/manifest/i, 'plugins/_formprobe/manifest.js'],
      [/-panel\.js|plugins\/myplug\/myplug-panel/i, 'plugins/_formprobe/formprobe-panel.js'],
    ]
    const done = []
    for (const [re, v] of plan) {
      const el = pick(re)
      if (el) { setV(el, v); done.push(v) }
    }
    return { ok: done.length >= 4, done, count: inputs.length }
  })
  check('表单可填写', filled.ok, JSON.stringify(filled))
  console.log('    填入: ' + (filled.done || []).join(' , '))
  await sleep(400)
  await p.screenshot({ path: cfg.shotPath('06-form-filled.png') })

  // 提交
  const submitted = await p.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#mio-market-page button'))
    const t = btns.find((x) => /上架并立即生效|确认上架/.test(x.textContent))
    if (t) { t.click(); return t.textContent.trim() }
    return null
  })
  check('点击提交', !!submitted, submitted)
  await sleep(2500)

  const after = await p.evaluate(() => ({
    inRegistry: window.__mioPluginRegistry.list().includes('formprobe'),
    bodyText: document.body.innerText.slice(0, 400),
  }))
  check('表单上架后插件被装载', after.inRegistry === true)
  await p.screenshot({ path: cfg.shotPath('07-form-submitted.png') })

  console.log('\n=== 清理 ===')
  // 通过 API 下架
  await fetch(BASE + '/api/plugin/market/plugins/formprobe', { method: 'DELETE' })
  fs.rmSync(dir, { recursive: true, force: true })
  check('无 JS 报错', errs.length === 0, errs.join(' | '))

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
  await b.close()
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.log('ERR', e.message); process.exit(2) })
