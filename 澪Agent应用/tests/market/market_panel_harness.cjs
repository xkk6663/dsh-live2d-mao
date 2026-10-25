#!/usr/bin/env node
/* market_panel_harness.cjs — 市场面板的**离线**验证：假 DOM + fetch 打桩
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么需要它（本次任务的硬约束）：
 *   后端进程还跑着**旧代码**（/api/plugin/market/* 要重启才生效），前端没法联调；
 *   而「上架后 reload 是否真的被调用」「内置插件的下架按钮是否真的 disabled」
 *   「后端 400 的 detail 是否原样红字回显」这些恰恰是最容易写错、也最需要证据的地方。
 *   所以这里用 Node 造一个**够用的假浏览器**：
 *     · 假 DOM（innerHTML 解析器只管标签/属性/文本，够渲染布局断言）
 *     · 假 fetch：按 method+path 路由到固定响应，并记录每一次调用
 *     · 假 loader / nav：只记录 reload()/refresh() 被调用了几次
 *   面板代码本身**一行不改**地跑在 vm 里 —— 验证的是真实产物，不是复制的逻辑。
 *
 * 断言失败退出码 1，全绿退出码 0。用法：
 *   node 私人AI日记系统/backend/probe_tmp/market_panel_harness.cjs
 * ════════════════════════════════════════════════════════════════════════════
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const HERE = __dirname
const REPO = path.resolve(HERE, '..', '..', '..')
const PANEL = path.join(REPO, '澪Agent应用', 'dist', 'plugins', 'market', 'market-panel.js')
const MANIFEST = path.join(REPO, '澪Agent应用', 'dist', 'plugins', 'market', 'manifest.js')
const FIXTURES = path.join(HERE, '_market_fixtures')

// ── 断言 ─────────────────────────────────────────────────────────────────────
let PASS = 0
let FAIL = 0
const FAILURES = []
function check(name, ok, detail) {
  if (ok) { PASS += 1; console.log('  [OK]   ' + name) } else {
    FAIL += 1
    FAILURES.push(name + (detail ? '  ' + detail : ''))
    console.log('  [FAIL] ' + name + (detail ? '  ' + detail : ''))
  }
}
function checkEq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 极简假 DOM ───────────────────────────────────────────────────────────────
// 只需要支撑面板用到的 API：createElement / appendChild / innerHTML / querySelector /
// setAttribute / classList / addEventListener / textContent / isConnected 等。
// innerHTML 解析：只处理本文件关心的 start/end/void 标签与裸文本（不处理注释、脚本转义）。
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'path', 'circle', 'rect'])

class FakeNode {
  constructor(doc, tag) {
    this.ownerDocument = doc
    this.tagName = String(tag || 'div').toUpperCase()
    this.nodeType = 1
    this.children = []
    this.parentNode = null
    this._attrs = Object.create(null)
    this._text = ''
    this._listeners = Object.create(null)
    this.style = new Proxy({ cssText: '' }, {
      get: (t, k) => (k in t ? t[k] : ''),
      set: (t, k, v) => { t[k] = v; return true },
    })
    this.disabled = false
    this.value = ''
  }
  get classList() {
    const self = this
    return {
      contains: (c) => String(self._attrs.class || '').split(/\s+/).indexOf(c) >= 0,
      add: (c) => { const s = String(self._attrs.class || '').split(/\s+/).filter(Boolean); if (s.indexOf(c) < 0) s.push(c); self._attrs.class = s.join(' ') },
      remove: (c) => { self._attrs.class = String(self._attrs.class || '').split(/\s+/).filter((x) => x && x !== c).join(' ') },
      toggle: (c, on) => { if (on) self.classList.add(c); else self.classList.remove(c) },
    }
  }
  get id() { return this._attrs.id || '' }
  set id(v) { this._attrs.id = String(v) }
  get title() { return this._attrs.title || '' }
  set title(v) { this._attrs.title = String(v) }
  get className() { return this._attrs.class || '' }
  set className(v) { this._attrs.class = String(v) }
  get placeholder() { return this._attrs.placeholder || '' }
  set placeholder(v) { this._attrs.placeholder = String(v) }
  get type() { return this._attrs.type || '' }
  set type(v) { this._attrs.type = String(v) }
  get rows() { return Number(this._attrs.rows || 0) }
  set rows(v) { this._attrs.rows = String(v) }
  get maxLength() { return Number(this._attrs.maxlength || 0) }
  set maxLength(v) { this._attrs.maxlength = String(v) }
  get isConnected() {
    let n = this
    while (n.parentNode) n = n.parentNode
    return n === this.ownerDocument.documentElement || n === this.ownerDocument.body
  }
  get offsetParent() { return this.parentNode }
  get offsetWidth() { return 800 }
  get offsetHeight() { return 600 }
  setAttribute(k, v) { this._attrs[k] = String(v) }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null }
  removeAttribute(k) { delete this._attrs[k] }
  hasAttribute(k) { return k in this._attrs }
  appendChild(n) {
    if (n.parentNode && n.parentNode !== this) n.parentNode.removeChild(n)
    n.parentNode = this
    this.children.push(n)
    return n
  }
  insertBefore(n, ref) {
    const i = this.children.indexOf(ref)
    if (n.parentNode) n.parentNode.removeChild(n)
    n.parentNode = this
    if (i < 0) this.children.push(n)
    else this.children.splice(i, 0, n)
    return n
  }
  removeChild(n) {
    const i = this.children.indexOf(n)
    if (i >= 0) this.children.splice(i, 1)
    n.parentNode = null
    return n
  }
  get firstChild() { return this.children[0] || null }
  get nextSibling() {
    if (!this.parentNode) return null
    const i = this.parentNode.children.indexOf(this)
    return this.parentNode.children[i + 1] || null
  }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn) }
  removeEventListener(t, fn) { const a = this._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) }
  /** 触发监听器。面板里的点击逻辑都是同步的，这里也同步派发。 */
  click() {
    const ev = { target: this, preventDefault() {}, stopPropagation() {}, type: 'click' }
    for (const fn of (this._listeners.click || []).slice()) fn(ev)
  }
  focus() {}
  get textContent() {
    // ★ 这里必须忠实模拟浏览器：**表单控件自身的 textContent 不算它的值**
    //   （<input value="x"> 的 textContent 是 ''，值在 .value 上）。
    //   早先的版本给 INPUT/TEXTAREA/SELECT 特判返回 value，于是
    //   `<select><option>启用</option><option>停用</option></select>` 的文本里
    //   永远能搜到"启用"这个词，把"卡片本该显示已停用"的回归给盖住了 ——
    //   harness 自己必须先过这一关，否则它验的就不是浏览器的行为。
    if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT') return ''
    let s = this._text || ''
    for (const c of this.children) s += c.textContent
    return s
  }
  set textContent(v) { this.children.length = 0; this._text = String(v == null ? '' : v) }
  get innerHTML() { return this._html != null ? this._html : this._buildHtml() }
  set innerHTML(v) { this._html = null; this.children.length = 0; this._text = ''; parseInto(this, String(v == null ? '' : v)) }
  _buildHtml() {
    if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT') return this.value || this._text || ''
    let h = escapeHtml(this._text || '')
    for (const c of this.children) h += c._buildHtml()
    return h
  }
  // ── 选择器：只需支持面板用到的形态：#id / .class / [attr] / [attr="v"] / tag，可组合、可后代
  matches(sel) {
    const parts = sel.trim().match(/(#[\w-]+|\.[\w-]+|\[[^\]]+\]|[\w-]+)/g) || []
    for (const p of parts) {
      if (p[0] === '#') { if (this.id !== p.slice(1)) return false } else if (p[0] === '.') {
        if (!this.classList.contains(p.slice(1))) return false
      } else if (p[0] === '[') {
        const m = p.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"']*)["']?)?$/)
        if (!m) return false
        const v = this.getAttribute(m[1])
        if (v == null) return false
        if (m[2] !== undefined && v !== m[2]) return false
      } else if (this.tagName !== p.toUpperCase()) return false
    }
    return true
  }
  querySelectorAll(sel) {
    const out = []
    // 拆成"后代"分组：'a b' → 先找 a，再在 a 里找 b（面板只用到一层后代）
    const groups = String(sel).trim().split(/\s+/)
    const walk = (node, gi) => {
      for (const c of node.children) {
        if (c.matches(groups[gi])) {
          if (gi === groups.length - 1) out.push(c)
          else walk(c, gi + 1)
        }
        walk(c, gi)  // 同一层继续找（命中与继续下沉都要做）
      }
    }
    walk(this, 0)
    return out
  }
  querySelector(sel) { const a = this.querySelectorAll(sel); return a.length ? a[0] : null }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function parseInto(root, html) {
  // 扫描 <tag attr="v" attr2=v>…</tag>、自闭合/void 标签、以及裸文本
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g
  const stack = [root]
  let m
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1]
    if (m[5] !== undefined) {
      const txt = m[5]
      if (txt) top._text = (top._text || '') + decodeEntities(txt)
      continue
    }
    const closing = m[1] === '/'
    const tag = m[2]
    const attrs = m[3] || ''
    if (closing) {
      // 弹到匹配的那一层（容错：不等就弹一层）
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break }
      }
      continue
    }
    const node = new FakeNode(root.ownerDocument, tag)
    const are = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    let a
    while ((a = are.exec(attrs))) {
      const val = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''))
      const name = a[1]
      if (name === 'style') node.style.cssText = val
      else if (name === 'class') node.className = val
      else if (name === 'value') node.value = decodeEntities(val)
      else if (name === 'checked') node.checked = true
      else node.setAttribute(name, decodeEntities(val))
    }
    top.appendChild(node)
    if (!m[4] && !VOID_TAGS.has(tag.toLowerCase())) stack.push(node)
  }
}
function decodeEntities(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

// ── 假 document / window ─────────────────────────────────────────────────────
function makeDoc() {
  const doc = {
    readyState: 'complete',
    _listeners: Object.create(null),
    createElement(tag) { return new FakeNode(doc, tag) },
    createTextNode(t) { const n = new FakeNode(doc, '#text'); n._text = String(t); n.nodeType = 3; return n },
    addEventListener(t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn) },
    querySelector(sel) { return doc.documentElement.querySelector(sel) },
    querySelectorAll(sel) { return doc.documentElement.querySelectorAll(sel) },
    getElementById(id) { return doc.documentElement.querySelector('#' + id) },
  }
  doc.documentElement = new FakeNode(doc, 'html')
  doc.body = new FakeNode(doc, 'body')
  doc.head = new FakeNode(doc, 'head')
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)
  return doc
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
}

/** 打桩后端：按 method + path 精确路由，并记录 calls（供断言"到底有没有真的调 reload"）。 */
function makeFetch(state) {
  const calls = []
  const fn = (url, opt) => {
    opt = opt || {}
    const method = String(opt.method || 'GET').toUpperCase()
    calls.push({ method, url, body: opt.body })
    const pathname = String(url).split('?')[0]
    const make = (status, body) => Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: () => Promise.resolve(body),
    })
    if (pathname === '/api/plugin/market/catalog' && method === 'GET') {
      if (state.catalogDown) return make(state.catalogDown, { detail: '后端内部错误（模拟）' })
      return make(200, state.catalog)
    }
    if (pathname === '/api/plugin/market/diagnostics' && method === 'GET') {
      if (state.diagDown) return make(state.diagDown, { detail: 'diagnostics 挂了（模拟）' })
      return make(200, state.diag)
    }
    if (pathname === '/api/plugin/market/reload' && method === 'POST') {
      return make(200, { ok: true, plugins: state.catalog.plugins })
    }
    if (pathname === '/api/plugin/market/plugins' && method === 'POST') {
      const body = JSON.parse(opt.body || '{}')
      const dup = (state.catalog.plugins || []).some((p) => p.agentId === body.agentId)
      if (dup) return make(409, readJson('err_409.json'))
      if (!String(body.entry || '').startsWith('plugins/')) return make(400, { detail: 'entry 必须以 plugins/ 开头（模拟）' })
      const added = Object.assign({
        agentId: body.agentId, name: body.name || body.agentId, version: body.version || '1.0.0',
        author: body.author || 'Mio', entry: body.entry, panel: body.panel || '',
        accent: body.accent || '', description: body.description || '',
        category: body.category || 'other', builtin: false, enabled: true,
        bus: { registered: true, enabled: true, status: 'offline', phase: 'idle' },
        health: { ok: true, problems: [] },
      }, {})
      state.catalog = { ok: true, version: 1, plugins: state.catalog.plugins.concat([added]) }
      return make(200, { ok: true, plugin: added })
    }
    let m = pathname.match(/^\/api\/plugin\/market\/plugins\/([^/]+)\/enable$/)
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1])
      const body = JSON.parse(opt.body || '{}')
      const p = (state.catalog.plugins || []).find((x) => x.agentId === id)
      if (!p) return make(404, readJson('err_404.json'))
      if (p.builtin) return make(403, readJson('err_400_builtin.json'))
      p.enabled = body.enabled === true
      return make(200, { ok: true, agentId: id, enabled: p.enabled, bus: { registered: true, enabled: p.enabled } })
    }
    m = pathname.match(/^\/api\/plugin\/market\/plugins\/([^/]+)$/)
    if (m && method === 'DELETE') {
      const id = decodeURIComponent(m[1])
      const p = (state.catalog.plugins || []).find((x) => x.agentId === id)
      if (!p) return make(404, readJson('err_404.json'))
      if (p.builtin) return make(403, readJson('err_400_builtin.json'))
      state.catalog.plugins = state.catalog.plugins.filter((x) => x.agentId !== id)
      return make(200, { ok: true, removed: id, files_kept: true })
    }
    return make(404, { detail: 'no route: ' + method + ' ' + pathname })
  }
  fn.calls = calls
  return fn
}

/** 起一个"管理窗"环境：nav/设置页容器 + 假 loader/nav + 面板脚本。 */
function boot(options) {
  options = options || {}
  const doc = makeDoc()
  const state = { catalog: readJson('catalog.json'), diag: readJson('diagnostics.json') }
  const fakeFetch = makeFetch(state)

  // 宿主侧 DOM：左侧 nav（Vue 渲染的固定项）+ 设置页 #mioSetTabs / #mioSetBody
  const nav = new FakeNode(doc, 'nav')
  doc.body.appendChild(nav)
  const shell = new FakeNode(doc, 'div')
  shell.className = 'app-shell'
  doc.body.appendChild(shell)
  const main = new FakeNode(doc, 'main')
  shell.appendChild(main)
  const settingsBody = new FakeNode(doc, 'div')
  settingsBody.id = 'mioSetBody'
  main.appendChild(settingsBody)

  const calls = { reload: 0, navRefresh: 0, confirm: [] }
  const confirmAnswers = options.confirmAnswers ? options.confirmAnswers.slice() : []

  const win = {
    __mioPluginManifests: {},
    __mioPluginRegistry: {
      _reg: {},
      register(m) { this._reg[m.agentId] = m; this.__mioPluginManifests && 0 },
      get(id) { return this._reg[id] || null },
    },
    __mioPluginLoader: {
      reload() { calls.reload += 1; return Promise.resolve() },
    },
    __mioPluginNav: {
      refresh() { calls.navRefresh += 1; return Promise.resolve() },
    },
    innerWidth: 1280,
    screen: { availWidth: 1280, availHeight: 800 },
    console,
    confirm(text) { calls.confirm.push(text); return confirmAnswers.length ? confirmAnswers.shift() : true },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 5)),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: () => 0,          // 不真的起轮询，避免测试进程挂住
    clearInterval: () => {},
    getComputedStyle: () => ({ position: 'static' }),
    location: { href: 'http://127.0.0.1:8000/' },
  }
  win.window = win
  win.document = doc
  win.Promise = Promise
  win.MutationObserver = undefined      // 测试里不要真的开观察者（不影响断言）
  win.fetch = fakeFetch
  win.CustomEvent = function (type, init) { return { type, detail: (init || {}).detail } }
  win.dispatchEvent = () => {}
  const winListeners = Object.create(null)
  win.addEventListener = (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn) }
  win.removeEventListener = () => {}
  win.__listeners = winListeners
  // nav 的 MutationObserver 自愈依赖 isConnected，这里只测 ensureNav() 的直接调用
  const ctx = vm.createContext(win)
  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), ctx, { filename: PANEL })
  return { win, doc, state, calls, fakeFetch, nav, settingsBody, main, ctx }
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('='.repeat(74))
  console.log('市场面板离线 harness（假 DOM + fetch 打桩）')
  console.log('='.repeat(74))
  console.log('面板：' + PANEL)
  console.log('数据：' + path.join(FIXTURES, 'catalog.json') + '（后端 service 层真实导出）\n')

  // ── [1] manifest 与导出（R7）──────────────────────────────────────────────
  console.log('[1] manifest 声明 / R7 导出名')
  const env = boot()
  const mfSrc = fs.readFileSync(MANIFEST, 'utf8')
  vm.runInContext(mfSrc, env.ctx, { filename: MANIFEST })
  const mf = env.win.__mioPluginManifests['market']
  check('manifest 注册为 market', !!mf)
  checkEq('nav.mode', mf.nav.mode, 'own')
  checkEq('nav.keywords', mf.nav.keywords, ['插件市场'])
  checkEq('settingsTab.panel', mf.settingsTab.panel, 'market-panel')
  checkEq('settingsTab.order', mf.settingsTab.order, 900)
  // ★ 2026-10-25 用户裁决：市场改为 builtin（不可停用/下架）。
  //   理由记在 manifest 文件头：市场是唯一的管理入口，若可停用，
  //   点一下就把"重新启用"的路也一起关掉了（自我锁死）。
  checkEq('builtin（市场是内置管理入口，不可停用/下架）', mf.builtin, true)
  checkEq('bubble.accent 为紫色（与 dsh/feiyu/pet 区分）', mf.bubble.accent, '#8B5CF6')
  const panelObj = env.win['market-panel']
  check("window['market-panel'] 存在（R7 逐字）", !!panelObj)
  check('提供 renderInto', !!(panelObj && typeof panelObj.renderInto === 'function'))
  check('同时暴露 __mioMarketPanel', env.win.__mioMarketPanel === panelObj)
  // manifest.panel 必须能在 window 上找到同名对象（loader 的 R7 自检口径）
  check('manifest.panel 对应的 window 对象可取到', !!env.win[mf.settingsTab.panel])

  // ── [2] 首次渲染 ─────────────────────────────────────────────────────────
  console.log('\n[2] renderInto：卡片网格 / 工具条 / 状态角标')
  const host = new FakeNode(env.doc, 'div')
  env.settingsBody.appendChild(host)
  panelObj.renderInto(host)
  await sleep(20)
  const hostHtml = host.innerHTML
  check('host 非空（不是"点开一片空白"）', hostHtml.length > 500, 'len=' + hostHtml.length)
  const grid = host.querySelector('[data-mio-market-grid]')
  check('存在卡片网格容器', !!grid)
  const cards = host.querySelectorAll('[data-mio-market-card]')
  checkEq('卡片数量 = 清单条目数（4 条固定 + brokenplug + market = 5）', cards.length, 5)
  const cardIds = cards.map((c) => c.getAttribute('data-mio-market-card'))
  console.log('        卡片 agentId：' + cardIds.join(', '))
  check('大肥鱼按 agentId=cloud_feiyu 渲染（不是目录名 feiyu）', cardIds.indexOf('cloud_feiyu') >= 0)
  check('市场自身作为一张卡片出现', cardIds.indexOf('market') >= 0)
  // 工具条四件套
  check('搜索框存在', !!host.querySelector('[data-mio-market-q]'))
  check('分类筛选存在', !!host.querySelector('[data-mio-market-cat]'))
  check('「上架插件」按钮存在', !!host.querySelector('[data-mio-market-add]'))
  check('「重新扫描」按钮存在', !!host.querySelector('[data-mio-market-scan]'))
  // 状态角标
  const byId = {}
  cards.forEach((c) => { byId[c.getAttribute('data-mio-market-card')] = c })
  /** 卡片角标：状态角标是卡片头里带 title 的 badge（避开 <select> 选项与按钮文案）。
   *  浏览器里 <select> 的 textContent 包含选项文字，但**选项文字不算卡片内容**，
   *  所以这里按 DOM 结构取，而不是在一个大字符串里 indexOf（那会把"启用"误判成角标）。 */
  function badgeOf(card) {
    const b = card.querySelectorAll('span').filter((s) => ['已启用', '已停用', '内置', '异常'].indexOf(s.textContent) >= 0)
    return b.length ? b[0].textContent : ''
  }
  check('pet 卡片显示「内置」', badgeOf(byId['pet']) === '内置')
  check('dsh 卡片显示「已启用」', badgeOf(byId['dsh']) === '已启用', badgeOf(byId['dsh']))
  check('brokenplug 卡片显示「异常」', badgeOf(byId['brokenplug']) === '异常', badgeOf(byId['brokenplug']))
  check('brokenplug 卡片列出「面板脚本缺失」', byId['brokenplug'].textContent.indexOf('面板脚本缺失') >= 0)
  check('dsh 的 not_registered 只作「提示」不作「异常」', byId['dsh'].textContent.indexOf('提示：总线未注册') >= 0,
    byId['dsh'].textContent)
  check('卡片显示版本与作者', byId['dsh'].textContent.indexOf('v1.0.0') >= 0 && byId['dsh'].textContent.indexOf('Mio') >= 0)

  // ── [3] 内置插件保护 ─────────────────────────────────────────────────────
  console.log('\n[3] builtin：停用/下架按钮必须 disabled 且不发请求')
  const petCard = byId['pet']
  const petToggle = petCard.querySelector('[data-mio-market-toggle]')
  const petDel = petCard.querySelector('[data-mio-market-del]')
  check('pet 没有启用/停用按钮（而不是灰掉一个真按钮）', petToggle === null)
  check('pet 显示「内置 · 不可停用」', petCard.textContent.indexOf('内置 · 不可停用') >= 0)
  check('pet 下架按钮存在', !!petDel)
  check('pet 下架按钮 disabled=true', !!(petDel && petDel.disabled === true))
  check('pet 下架按钮 title 说明原因', !!(petDel && petDel.title.indexOf('宿主本体') >= 0), petDel && petDel.title)
  const before = env.fakeFetch.calls.length
  if (petDel) petDel.click()
  await sleep(10)
  check('点 disabled 的下架按钮：没有发出任何请求', env.fakeFetch.calls.length === before,
    '新增=' + (env.fakeFetch.calls.length - before))
  check('也没有弹 confirm', env.calls.confirm.length === 0)

  // ── [4] 停用 → reload + nav.refresh ──────────────────────────────────────
  console.log('\n[4] 停用 dsh：POST /enable → loader.reload() + nav.refresh() → 重渲染')
  env.calls.reload = 0
  env.calls.navRefresh = 0
  const dshToggle = byId['dsh'].querySelector('[data-mio-market-toggle]')
  check('dsh 有启停按钮', !!dshToggle)
  check('dsh 按钮文案是「停用」（当前已启用）', dshToggle && dshToggle.textContent === '停用', dshToggle && dshToggle.textContent)
  dshToggle.click()
  await sleep(40)
  const enableCall = env.fakeFetch.calls.filter((c) => /\/enable$/.test(c.url))[0]
  check('发出了 POST /plugins/dsh/enable', !!enableCall && enableCall.method === 'POST')
  checkEq('提交的 body 是目标态 {enabled:false}', enableCall && JSON.parse(enableCall.body), { enabled: false })
  checkEq('调用了 __mioPluginLoader.reload()', env.calls.reload, 1)
  checkEq('调用了 __mioPluginNav.refresh()', env.calls.navRefresh, 1)
  const dshCard2 = host.querySelectorAll('[data-mio-market-card]').find((c) => c.getAttribute('data-mio-market-card') === 'dsh')
  check('重渲染后 dsh 变成「已停用」', badgeOf(dshCard2) === '已停用', badgeOf(dshCard2))
  const msg = host.querySelector('[data-mio-market-msg]')
  check('状态行报告结果', msg && msg.textContent.indexOf('已停用 dsh') >= 0, msg && msg.textContent)
  check('提示导航与 tab 已同步', msg && msg.textContent.indexOf('已同步') >= 0, msg && msg.textContent)

  // 再启用回来（验证方向正确 + body 没写反）
  env.calls.reload = 0
  const dshToggle2 = dshCard2.querySelector('[data-mio-market-toggle]')
  check('按钮文案变成「启用」', dshToggle2 && dshToggle2.textContent === '启用', dshToggle2 && dshToggle2.textContent)
  dshToggle2.click()
  await sleep(40)
  const enableCalls = env.fakeFetch.calls.filter((c) => /\/enable$/.test(c.url))
  checkEq('再次提交 {enabled:true}', JSON.parse(enableCalls[enableCalls.length - 1].body), { enabled: true })
  const dshCard3 = host.querySelectorAll('[data-mio-market-card]').find((c) => c.getAttribute('data-mio-market-card') === 'dsh')
  check('dsh 回到「已启用」', badgeOf(dshCard3) === '已启用', badgeOf(dshCard3))

  // ── [5] 下架：confirm + DELETE + reload ──────────────────────────────────
  console.log('\n[5] 下架 brokenplug：confirm 确认 → DELETE → reload → 卡片消失')
  const bplugDel = host.querySelectorAll('[data-mio-market-card]')
    .find((c) => c.getAttribute('data-mio-market-card') === 'brokenplug')
    .querySelector('[data-mio-market-del]')
  env.calls.reload = 0
  // 第一次点「取消」→ 不应发请求
  env.calls.confirm.length = 0
  const envCancel = boot({ confirmAnswers: [false] })
  const hostCancel = new FakeNode(envCancel.doc, 'div')
  envCancel.settingsBody.appendChild(hostCancel)
  envCancel.win['market-panel'].renderInto(hostCancel)
  await sleep(20)
  const delCancel = hostCancel.querySelectorAll('[data-mio-market-card]')
    .find((c) => c.getAttribute('data-mio-market-card') === 'brokenplug')
    .querySelector('[data-mio-market-del]')
  delCancel.click()
  await sleep(20)
  check('confirm 弹窗被调用（文案含插件名与"保留"承诺）', envCancel.calls.confirm.length === 1 &&
    envCancel.calls.confirm[0].indexOf('文件') >= 0, envCancel.calls.confirm[0])
  check('取消后不发出 DELETE', envCancel.fakeFetch.calls.filter((c) => c.method === 'DELETE').length === 0)

  bplugDel.click()
  await sleep(40)
  const delCall = env.fakeFetch.calls.filter((c) => c.method === 'DELETE')[0]
  check('发出 DELETE /plugins/brokenplug', !!delCall && delCall.url === '/api/plugin/market/plugins/brokenplug')
  check('最终未发出 DELETE /plugins/pet（内置不可删）',
    env.fakeFetch.calls.filter((c) => c.method === 'DELETE' && /pet$/.test(c.url)).length === 0)
  const afterIds = host.querySelectorAll('[data-mio-market-card]').map((c) => c.getAttribute('data-mio-market-card'))
  check('brokenplug 卡片已消失', afterIds.indexOf('brokenplug') < 0, afterIds.join(','))
  checkEq('下架后 reload 被调用一次', env.calls.reload, 1)

  // ── [6] 后端 detail 原样红字回显 ─────────────────────────────────────────
  console.log('\n[6] 上架：前端校验 + 后端 detail 原样回显（409 / 400 / 越界）')
  const addBtn = host.querySelector('[data-mio-market-add]')
  addBtn.click()
  const formBox = host.querySelector('[data-mio-market-formbox]')
  check('点「上架插件」展开表单', formBox && formBox.style.display === 'block')
  const fields = ['agentId', 'name', 'version', 'entry', 'panel', 'category', 'description', 'author', 'accent']
  const missing = fields.filter((f) => !host.querySelector('[data-mio-market-field="' + f + '"]'))
  checkEq('表单字段齐全', missing, [])
  check('表单里没有「保存」按钮', host.querySelectorAll('[data-mio-market-submit]').length === 1 &&
    panelObj && String(fs.readFileSync(PANEL, 'utf8')).indexOf('>保存<') < 0)

  const setField = (k, v) => {
    const n = host.querySelector('[data-mio-market-field="' + k + '"]')
    n.value = v
    for (const fn of (n._listeners.input || [])) fn({ target: n, type: 'input' })
    for (const fn of (n._listeners.change || [])) fn({ target: n, type: 'change' })
  }
  const submit = host.querySelector('[data-mio-market-submit]')
  const formErr = host.querySelector('[data-mio-market-formerr]')

  // 6a 前端校验：agentId 非法
  env.fakeFetch.calls.length = 0
  setField('agentId', 'Bad ID!')
  submit.click()
  await sleep(10)
  check('agentId 非法：不发请求', env.fakeFetch.calls.length === 0)
  check('agentId 非法：红字提示', formErr.style.display === 'block' && formErr.textContent.indexOf('agentId 不合法') >= 0,
    formErr.textContent)

  // 6b 前端校验：entry 不以 plugins/ 开头 / 带 ..
  const v1 = panelObj.validateForm({ agentId: 'okid', entry: '../etc/passwd' })
  check('validateForm 拒绝 entry 越界', v1.ok === false && v1.errors.join('|').indexOf('..') >= 0, v1.errors.join('|'))
  const v2 = panelObj.validateForm({ agentId: 'okid', entry: '/abs/x.js' })
  check('validateForm 拒绝绝对路径', v2.ok === false, v2.errors.join('|'))
  const v3 = panelObj.validateForm({ agentId: 'okid', entry: 'other/x.js' })
  check('validateForm 拒绝不在 plugins/ 下的路径', v3.ok === false && v3.errors.join('|').indexOf('plugins/') >= 0)
  const v4 = panelObj.validateForm({ agentId: 'okid', entry: 'plugins/okid/manifest.js' })
  check('validateForm 放行合法条目', v4.ok === true, v4.errors.join('|'))
  check('可选字段留空时不进 body（让后端用默认值）', !('author' in v4.body) && !('accent' in v4.body), JSON.stringify(v4.body))

  // 6c 后端 409：detail 原样回显
  env.fakeFetch.calls.length = 0
  setField('agentId', 'cloud_feiyu')
  setField('entry', 'plugins/feiyu/manifest.js')
  submit.click()
  await sleep(40)
  const post = env.fakeFetch.calls.filter((c) => c.method === 'POST' && c.url === '/api/plugin/market/plugins')[0]
  check('发出 POST /plugins', !!post)
  check('409 的 detail 原样显示在表单错误区',
    formErr.textContent === readJson('err_409.json').detail, JSON.stringify(formErr.textContent))
  check('409 后表单值保留（用户不必重填）',
    host.querySelector('[data-mio-market-field="agentId"]').value === 'cloud_feiyu')

  // 6d 成功上架 → reload + 卡片出现
  env.calls.reload = 0
  setField('agentId', 'newplug')
  setField('name', '新插件')
  setField('entry', 'plugins/newplug/manifest.js')
  setField('panel', 'plugins/newplug/newplug-panel.js')
  setField('accent', '#123456')
  submit.click()
  await sleep(60)
  check('上架成功后表单错误区清掉', formErr.style.display === 'none')
  check('上架成功后 reload 被调用（"上架即生效"的关键）', env.calls.reload >= 1, 'reload=' + env.calls.reload)
  const ids4 = host.querySelectorAll('[data-mio-market-card]').map((c) => c.getAttribute('data-mio-market-card'))
  check('新插件卡片出现', ids4.indexOf('newplug') >= 0, ids4.join(','))
  const okMsg = host.querySelector('[data-mio-market-msg]')
  check('提示"已生效，无需重启"', okMsg && okMsg.textContent.indexOf('已生效') >= 0, okMsg && okMsg.textContent)

  // ── [7] 搜索 / 分类筛选 ─────────────────────────────────────────────────
  console.log('\n[7] 搜索与分类筛选（同一数据集上单独跑一遍）')
  const env2 = boot()
  const host2 = new FakeNode(env2.doc, 'div')
  env2.settingsBody.appendChild(host2)
  const p2 = env2.win['market-panel']
  p2.renderInto(host2)
  await sleep(20)
  p2.setView({ q: '大肥鱼', cat: 'all' })
  const qbox = host2.querySelector('[data-mio-market-q]')
  qbox.value = '大肥鱼'
  for (const fn of (qbox._listeners.input || [])) fn({ target: qbox })
  let ids = host2.querySelectorAll('[data-mio-market-card]').map((c) => c.getAttribute('data-mio-market-card'))
  checkEq('搜索"大肥鱼"只剩 cloud_feiyu', ids, ['cloud_feiyu'])
  qbox.value = ''
  for (const fn of (qbox._listeners.input || [])) fn({ target: qbox })
  const catSel = host2.querySelector('[data-mio-market-cat]')
  catSel.value = 'error'
  for (const fn of (catSel._listeners.change || [])) fn({ target: catSel })
  ids = host2.querySelectorAll('[data-mio-market-card]').map((c) => c.getAttribute('data-mio-market-card'))
  checkEq('「仅看异常」只剩 brokenplug', ids, ['brokenplug'])
  catSel.value = 'all'
  for (const fn of (catSel._listeners.change || [])) fn({ target: catSel })
  ids = host2.querySelectorAll('[data-mio-market-card]').map((c) => c.getAttribute('data-mio-market-card'))
  checkEq('切回全部分类恢复 5 条', ids.length, 5)

  // ── [8] 重复渲染（R6 幂等）不含重复节点 ─────────────────────────────────
  console.log('\n[8] R6 幂等：重复 renderInto 不叠节点')
  p2.renderInto(host2)
  await sleep(20)
  checkEq('工具条只有一份（搜索框唯一）', host2.querySelectorAll('[data-mio-market-q]').length, 1)
  checkEq('卡片区只有一份', host2.querySelectorAll('[data-mio-market-grid]').length, 1)
  checkEq('卡片数量仍为 5', host2.querySelectorAll('[data-mio-market-card]').length, 5)

  // ── [9] CSS 变量 / 不写死背景 ───────────────────────────────────────────
  console.log('\n[9] 样式纪律：走 CSS 变量，不写死背景色')
  const panelSrc = fs.readFileSync(PANEL, 'utf8')
  // 只看**代码**：注释里为了解释而写到的 /api/companion/agents 不算调用点
  const codeSrc = panelSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  check('使用 var(--ink', codeSrc.indexOf('var(--ink') >= 0)
  check('使用 var(--muted', codeSrc.indexOf('var(--muted') >= 0)
  check('使用 var(--line', codeSrc.indexOf('var(--line') >= 0)
  check('使用 var(--accent', codeSrc.indexOf('var(--accent') >= 0)
  check('使用 var(--surface-soft', codeSrc.indexOf('var(--surface-soft') >= 0)
  // 「不写死背景色」的准确口径（对应任务里的"不要写死背景色，走 --ink/--muted/--line/--accent/--surface-soft"）：
  //   ① 面板**外壳**（功能页）的背景必须走 var(--app-bg) —— 它要随 14 套主题变；
  //   ② 卡片/容器背景必须走 var(--surface-soft) / var(--surface)；
  //   ③ 输入框与按钮的 `background:#fff` 是**控件底色**，不是主题背景，
  //      pet-panel.js / dsh-panel.js / feiyu-panel.js 全都是这么写的（别处改它反而会破主题）。
  //   所以这里断言"外壳走变量 + 容器走变量"，而不是简单 grep 一个 #fff。
  check('功能页外壳背景走 var(--app-bg)', /background:var\(--app-bg/.test(codeSrc))
  check('卡片/容器背景走 var(--surface-soft)', /background:var\(--surface-soft/.test(codeSrc))
  const shellBgHard = /background:\s*#(?!fff\b)[0-9a-fA-F]{3,6}/.test(codeSrc)
  check('外壳与容器没有写死非白背景色', !shellBgHard)
  const whiteBg = (codeSrc.match(/background:\s*#fff/g) || []).length
  check('写死 #fff 的只有控件底色（≤3 处，与既有插件同量级）', whiteBg <= 3, 'count=' + whiteBg)
  check('没有 import 语句', !/^\s*import\s/m.test(codeSrc))
  check('没有箭头函数（ES5 风格注入层）', codeSrc.indexOf('=>') < 0)
  check('没有 class 声明', !/\bclass\s+[A-Za-z_$][\w$]*\s*\{/.test(codeSrc))
  check('没有可选链 ?.', codeSrc.indexOf('?.') < 0)
  check('没有引用其它插件全局（__mioPetPanel/__mioDshPanel/__mioFeiyuPanel）',
    codeSrc.indexOf('__mioPetPanel') < 0 && codeSrc.indexOf('__mioDshPanel') < 0 && codeSrc.indexOf('__mioFeiyuPanel') < 0)
  const urls = codeSrc.match(/\/api\/[a-z0-9/_\-]*/gi) || []
  check('只调 /api/plugin/market/*（R2）', urls.every((u) => u.indexOf('/api/plugin/market') === 0), urls.join(','))
  check('运行时确实打了 /api/plugin/market/*', env.fakeFetch.calls.every((c) => c.url.indexOf('/api/plugin/market') === 0))
  check('运行时从不请求 /api/companion/agents（R2）',
    env.fakeFetch.calls.every((c) => c.url.indexOf('/api/companion') < 0))
  check('使用 window.confirm 做下架确认', codeSrc.indexOf('window.confirm') >= 0)
  check('导航按钮带 data-mio-plugin-nav', codeSrc.indexOf("setAttribute('data-mio-plugin-nav'") >= 0)
  check('有 MutationObserver 自愈（R4）', codeSrc.indexOf('MutationObserver') >= 0)
  check('有 setInterval 兜底（R4）', codeSrc.indexOf('setInterval') >= 0)
  check('幂等守卫 __mioMarketPanelLoaded', codeSrc.indexOf('window.__mioMarketPanelLoaded') >= 0)
  check('renderInto 先清空 host', /host\.innerHTML\s*=\s*''/.test(codeSrc))

  // ── [10] 导航按钮 + loader 摘除标记 ─────────────────────────────────────
  console.log('\n[10] 左侧导航按钮（nav.mode:own）与 loader 摘除标记')
  const env3 = boot()
  env3.win['market-panel'].ensureNav()
  const navBtns = env3.nav.querySelectorAll('button.nav-item')
  checkEq('nav 里新增 1 个按钮', navBtns.length, 1)
  checkEq('按钮带 data-mio-plugin-nav="market"', navBtns[0].getAttribute('data-mio-plugin-nav'), 'market')
  check('按钮文本是「插件市场」（与 nav.keywords 一致）', navBtns[0].textContent.indexOf('插件市场') >= 0)
  check('loader 的 removeNavButtons 能按标记定位', env3.nav.querySelectorAll('[data-mio-plugin-nav="market"]').length === 1)
  env3.win['market-panel'].ensureNav()
  checkEq('再次 ensureNav 不重复添加', env3.nav.querySelectorAll('button.nav-item').length, 1)
  // 点导航按钮 → 功能页出现，且同样渲染了卡片
  navBtns[0].click()
  await sleep(20)
  const pageEl = env3.doc.getElementById('mio-market-page')
  check('点按钮打开功能页', !!pageEl && pageEl.style.display === 'flex')
  checkEq('功能页里也渲染了 5 张卡片', pageEl.querySelectorAll('[data-mio-market-card]').length, 5)

  // ── [11] 后端不可用时的降级 ─────────────────────────────────────────────
  console.log('\n[11] catalog 不可用：清空态 + 可读报错（不清空已加载的插件状态）')
  const env4 = boot()
  env4.state.catalogDown = 500
  const host4 = new FakeNode(env4.doc, 'div')
  env4.settingsBody.appendChild(host4)
  env4.win['market-panel'].renderInto(host4)
  await sleep(20)
  check('页面仍然渲染出骨架（工具条在）', !!host4.querySelector('[data-mio-market-q]'))
  check('卡片区给出可读错误', host4.innerHTML.indexOf('读取插件清单失败') >= 0)
  check('错误里带后端 detail', host4.innerHTML.indexOf('后端内部错误') >= 0)

  // diagnostics 挂了但 catalog 正常 → 卡片照画
  const env5 = boot()
  env5.state.diagDown = 500
  const host5 = new FakeNode(env5.doc, 'div')
  env5.settingsBody.appendChild(host5)
  env5.win['market-panel'].renderInto(host5)
  await sleep(20)
  checkEq('诊断端点挂了不影响卡片渲染', host5.querySelectorAll('[data-mio-market-card]').length, 5)
  check('诊断区降级提示', host5.innerHTML.indexOf('诊断不可用') >= 0)

  // ── [12] 下架市场自身 ───────────────────────────────────────────────────
  console.log('\n[12] 下架「插件市场」自己：二次确认 + 不把面板画回来')
  const env6 = boot()
  const host6 = new FakeNode(env6.doc, 'div')
  env6.settingsBody.appendChild(host6)
  env6.win['market-panel'].renderInto(host6)
  await sleep(20)
  const selfCard = host6.querySelectorAll('[data-mio-market-card]').find((c) => c.getAttribute('data-mio-market-card') === 'market')
  selfCard.querySelector('[data-mio-market-del]').click()
  await sleep(40)
  check('下架自己时 confirm 文案警告"下架后消失"', env6.calls.confirm[0].indexOf('左侧「插件市场」入口消失') >= 0,
    env6.calls.confirm[0])
  check('发出 DELETE /plugins/market', env6.fakeFetch.calls.some((c) => c.method === 'DELETE' && c.url === '/api/plugin/market/plugins/market'))
  checkEq('下架自己后没有重新渲染整个面板（避免死而复生）', host6.querySelectorAll('[data-mio-market-card]').length, 5)
  check('状态行说明文件保留', host6.innerHTML.indexOf('文件仍在 dist/plugins/market/') >= 0)

  // ── 结果 ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(74))
  console.log('结果：' + PASS + ' 通过 / ' + FAIL + ' 失败')
  if (FAILURES.length) {
    console.log('失败项：')
    FAILURES.forEach((f) => console.log('  - ' + f))
  }
  console.log('='.repeat(74))
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('harness 崩溃：', e)
  process.exit(2)
})
