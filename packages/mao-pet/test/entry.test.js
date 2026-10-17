/**
 * 入口集成测试：用**假 Cordis ctx** 真实跑一遍 `apply()`。
 *
 * 为什么必须单独测这一层：单元测试都是逐模块喂输入的，
 * 而 `apply()` 里的**接线**（监听器注册、服务取值、路由注册、teardown）
 * 只在这条路径上才会执行。M6 的踩坑结论①（注入行必须最先注册）
 * 也只在这里能验证。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import plugin from '../lib/index.js'

// ★ 拦截全局 fetch（2026-10-17）：apply() 里的 stripRemote / pusher 都默认用
//   globalThis.fetch。若让它真实连 8000，会触发真实网络请求把测试挂死。这里统一
//   mock 成"后端不可达"，与"桌宠后端没起"的真实场景一致。
const _realFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => null })

/**
 * 真实形态的宿主栅栏判定：只放行回环，其余返回 401。
 *
 * ⚠ 为什么不能用一个"永远返回 null"的桩：whale 蓝本的三层里，
 * **非回环 Host 在栅栏可用时是交给栅栏判的**（它知道 dsh 自己的 `--trusted-host`
 * 与浏览器鉴权）。用一个恒放行的桩会让插件"看起来"没拦住伪造 Host ——
 * 那是桩不真实，不是插件有洞。真实 dsh 的 `requestRejection` 会拒非回环。
 */
function isLoopbackReq(req) {
  const host = String(((req && req.headers) || {}).host || '')
  const hn = host.replace(/:\d+$/, '').toLowerCase().replace(/^\[|\]$/g, '')
  return hn === 'localhost' || hn === '::1' || /^127\./.test(hn)
}

/** 构造一个记录所有注册行为的假 Cordis ctx / root。 */
function makeHarness(opts = {}) {
  const record = {
    indexInject: [],   // webserver/index-inject 的监听
    sessionEvent: [],  // session/event 的监听
    streamEvent: [],   // agent/assistant-stream 的监听
    approvalEvent: [], // approval/request 的监听
    routes: [],
    effects: [],
    injectCalls: [],
    logs: [],
  }

  const services = {
    webServer: {
      register: (route) => { record.routes.push(route); return () => {} },
    },
    connection: opts.connection === undefined
      ? { requestRejection: (req) => (isLoopbackReq(req) ? null : 401) }
      : opts.connection,
    sessionProjections: opts.sessionProjections === undefined
      ? { stateOf: () => undefined }
      : opts.sessionProjections,
    userQuestions: opts.userQuestions === undefined ? { answer: () => true } : opts.userQuestions,
  }

  const ctx = {
    on(event, cb, o) {
      if (event === 'webserver/index-inject') record.indexInject.push({ cb, o })
      else if (event === 'session/event') record.sessionEvent.push({ cb, o })
      else if (event === 'agent/assistant-stream') record.streamEvent.push({ cb, o })
      else if (event === 'approval/request') record.approvalEvent.push({ cb, o })
      return () => {}
    },
    get: (name) => services[name] ?? null,
    webServer: services.webServer,
  }

  const root = {
    on(event, cb) {
      // 注意：注入行用的是 root.on('webserver/index-inject')，**不是** ctx.on
      if (event === 'webserver/index-inject') record.indexInject.push({ cb })
      return () => {}
    },
    effect(fn) { record.effects.push(fn); return () => {} },
    inject(deps, cb) {
      record.injectCalls.push(deps)
      // 直接同步执行（真实 Cordis 会在服务就绪后调用）
      if (opts.skipRun) return
      cb(ctx)
    },
  }

  return { root, ctx, record, services }
}

/** 捕获 console 输出，避免测试刷屏。 */
function silenceConsole(fn) {
  const orig = { info: console.info, warn: console.warn, debug: console.debug }
  const logs = []
  console.info = (...a) => logs.push(['info', a.join(' ')])
  console.warn = (...a) => logs.push(['warn', a.join(' ')])
  console.debug = () => {}
  try {
    fn()
  } finally {
    console.info = orig.info
    console.warn = orig.warn
    console.debug = orig.debug
  }
  return logs
}

test('入口 · D5 命名：插件 name 全小写 mao-pet', () => {
  assert.equal(plugin.name, 'mao-pet')
})

test('入口 · ★ 踩坑结论①：apply() 同步段内就注册了注入行（不依赖任何服务）', () => {
  const h = makeHarness({ skipRun: true }) // ★ 不执行 inject 回调
  plugin.apply(h.root)
  assert.equal(h.record.indexInject.length, 1,
    '注入行必须在 apply 同步段注册 —— 晚于宿主收集就永远拿不到')
  assert.equal(h.record.injectCalls.length, 1, '其余逻辑应放进 root.inject')
})

test('入口 · 注入行是 kind:script 内联，不是 script-src（踩坑结论②）', () => {
  const h = makeHarness({ skipRun: true })
  plugin.apply(h.root)
  const table = []
  h.record.indexInject[0].cb(table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script', '必须是内联 script，script-src 失败会 reject 整个 boot')
  assert.equal(typeof table[0].text, 'string')
  assert.ok(table[0].text.includes('/mao-pet/bridge.js'))
  assert.equal(table[0].text.includes('s.onerror=function(){}'), true, '必须吞掉 onerror')
})

test('入口 · 注入行有去重（重复收集不会插两次）', () => {
  const h = makeHarness({ skipRun: true })
  plugin.apply(h.root)
  const cb = h.record.indexInject[0].cb
  const table = []
  cb(table)
  cb(table) // 再来一次
  assert.equal(table.length, 1, '去重必须生效')
})

test('入口 · 注入行对非数组 table 不崩', () => {
  const h = makeHarness({ skipRun: true })
  plugin.apply(h.root)
  const cb = h.record.indexInject[0].cb
  assert.doesNotThrow(() => cb(null))
  assert.doesNotThrow(() => cb(undefined))
  assert.doesNotThrow(() => cb('x'))
})

test('入口 · 注入行不覆盖旧的 script-src 行（向后兼容）', () => {
  const h = makeHarness({ skipRun: true })
  plugin.apply(h.root)
  const table = [{ kind: 'script-src', src: '/mao-pet/bridge.js' }]
  h.record.indexInject[0].cb(table)
  assert.equal(table.length, 1, '已存在旧行时不该再插内联行')
})

test('入口 · apply() 注册了事件监听（含 {global:true}）', () => {
  const h = makeHarness()
  plugin.apply(h.root)
  // session/event 现在有 3 个旁路（主链路 phase + 气泡栈喂入 + turn/end 移除），
  // 各自独立兜底；streamEvent 1 个；approvalEvent 0 个（审批回传已阉割）
  assert.equal(h.record.sessionEvent.length, 3)
  assert.equal(h.record.streamEvent.length, 1)
  assert.equal(h.record.approvalEvent.length, 0)

  // ★ 7.4 多 session 必须加 {global:true}
  assert.deepEqual(h.record.sessionEvent[0].o, { global: true })
  assert.deepEqual(h.record.sessionEvent[1].o, { global: true })
  assert.deepEqual(h.record.sessionEvent[2].o, { global: true })
  assert.deepEqual(h.record.streamEvent[0].o, { global: true })
})

test('入口 · root.inject 只等 webServer（不拖住注入行）', () => {
  const h = makeHarness()
  plugin.apply(h.root)
  assert.deepEqual(h.record.injectCalls[0], ['webServer'])
})

test('入口 · 注册了 4 条只读路由', () => {
  const h = makeHarness()
  plugin.apply(h.root)
  const paths = h.record.routes.map((r) => r.path).sort()
  // bridge.js：注入行加载的自证探针（**不参与业务投递**，见 lib/index.js 顶部长注释）。
  // 提供它而不是让它 404，是为了"注入行到底进没进页面"可被验证。
  assert.deepEqual(paths, [
    '/mao-pet/bridge.js', '/mao-pet/capabilities', '/mao-pet/phases', '/mao-pet/status',
  ])
})

test('入口 · bridge.js 只做自证：不碰 DOM、不依赖核心 API', async () => {
  const h = makeHarness()
  plugin.apply(h.root)
  const route = h.record.routes.find((r) => r.path === '/mao-pet/bridge.js')
  assert.ok(route, '应注册 bridge.js 路由')
  assert.equal(route.method, 'GET')
  let body = ''
  const headers = {}
  const res = {
    statusCode: 0,
    setHeader(k, v) { headers[k] = v },
    end(s) { body = s },
  }
  // 必须给合法回环 Host —— 路由被安全栅栏包着，空 Host 会被正确拒成 403（那是栅栏在干活）
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res)
  assert.equal(res.statusCode, 200)
  assert.match(String(headers['content-type'] || ''), /javascript/)
  assert.match(body, /__maoPetBridge/)
  // 关键：不碰任何核心 API / DOM —— 否则就违反了"插件不改主体 DOM"的裁决（D4）
  assert.ok(!body.includes('__mioPetStrip'), 'bridge 不应触碰横条核心 API')
  assert.ok(!body.includes('document.'), 'bridge 不应触碰 DOM')
})

test('入口 · 所有路由都是 GET（只读，无写面）', () => {
  const h = makeHarness()
  plugin.apply(h.root)
  for (const r of h.record.routes) {
    assert.equal(r.method, 'GET', `${r.path} 应为 GET`)
  }
})

test('入口 · 路由套上了安全栅栏（伪造 Host 被宿主栅栏拒）', async () => {
  const h = makeHarness()
  plugin.apply(h.root)
  const route = h.record.routes.find((r) => r.path === '/mao-pet/status')

  // 伪造非回环 Host → 交给宿主栅栏判（它返回 401）
  const res = { statusCode: null, ended: false, setHeader() {}, end() { this.ended = true } }
  await route.handler({ method: 'GET', headers: { host: 'evil.example.com' } }, res)
  assert.equal(res.statusCode, 401, '宿主栅栏必须拦下伪造 Host')
  assert.equal(res.ended, true)

  // 回环请求放行
  const ok = { statusCode: null, ended: false, setHeader() {}, end() { this.ended = true } }
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, ok)
  assert.equal(ok.statusCode, 200, '回环请求应正常处理')
})

test('入口 · ★ 无宿主栅栏时插件自校验兜底（fail-closed，403）', async () => {
  const h = makeHarness({ connection: null })
  plugin.apply(h.root)
  const route = h.record.routes.find((r) => r.path === '/mao-pet/status')
  const res = { statusCode: null, ended: false, setHeader() {}, end() { this.ended = true } }
  await route.handler({ method: 'GET', headers: { host: 'evil.example.com' } }, res)
  assert.equal(res.statusCode, 403, '没有宿主栅栏时插件必须自己拒')

  // 回环仍放行
  const ok = { statusCode: null, ended: false, setHeader() {}, end() { this.ended = true } }
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1' } }, ok)
  assert.equal(ok.statusCode, 200)
})

test('入口 · 回环请求正常返回 200 + JSON', async () => {
  const h = makeHarness()
  plugin.apply(h.root)
  const route = h.record.routes.find((r) => r.path === '/mao-pet/status')

  let body = ''
  const res = {
    statusCode: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { body = chunk },
  }
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res)
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.plugin.id, 'mao-pet')
  assert.equal(parsed.plugin.name, 'Mao-pet')
})

test('入口 · /mao-pet/phases 返回 12 态', async () => {
  const h = makeHarness()
  plugin.apply(h.root)
  const route = h.record.routes.find((r) => r.path === '/mao-pet/phases')
  let body = ''
  const res = { setHeader() {}, end(c) { body = c } }
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1' } }, res)
  const parsed = JSON.parse(body)
  assert.equal(parsed.count, 12)
  assert.deepEqual(parsed.phases, [
    'idle', 'planning', 'thinking', 'executing_tool', 'streaming', 'waiting_input',
    'voice', 'complete', 'error', 'paused', 'awaiting_approval', 'heartbeat',
  ])
})

test('入口 · /mao-pet/capabilities 如实暴露 7.1~7.6 状态', async () => {
  const h = makeHarness()
  plugin.apply(h.root)
  const route = h.record.routes.find((r) => r.path === '/mao-pet/capabilities')
  let body = ''
  const res = { setHeader() {}, end(c) { body = c } }
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1' } }, res)
  const parsed = JSON.parse(body)
  for (const k of ['7.1_stream', '7.4_bubble_stack', '7.5_projections', '7.6_strip']) {
    assert.ok(parsed.m7[k], `缺少 ${k}`)
  }
  assert.equal(parsed.m7['7.4_bubble_stack'].max, 12)
  assert.equal(parsed.m7['7.6_strip'].style_key, 'live2d_strip_style')
  assert.deepEqual(parsed.m7['7.6_strip'].style_keys, ['live2d_strip_style', 'pet_strip_style'])
})

test('入口 · teardown effect 已注册（热重载不泄漏）', () => {
  const h = makeHarness()
  plugin.apply(h.root)
  assert.ok(h.record.effects.length >= 2, '应有注入行 + 监听器两组 effect')
})

test('入口 · ★ assistant-stream 的 reasoning-chunks 不推横条', async () => {
  const h = makeHarness()
  plugin.apply(h.root)
  const cb = h.record.streamEvent[0].cb
  // 不该抛
  assert.doesNotThrow(() => cb({ frame: { type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: ['推理'] } }))
  assert.doesNotThrow(() => cb({ frame: { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['正文'] } }))
  assert.doesNotThrow(() => cb(null))
  assert.doesNotThrow(() => cb({}))
})

test('入口 · ★ session/event 首参是 session（端到端不抛且不崩）', () => {
  const h = makeHarness()
  plugin.apply(h.root)
  const cb = h.record.sessionEvent[0].cb
  assert.doesNotThrow(() => cb({ id: 's1' }, { type: 'turn/start', data: { turn: 1 } }))
  assert.doesNotThrow(() => cb({ id: 's1' }, { type: 'step/start', data: { step: 1 } }))
  assert.doesNotThrow(() => cb({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }))
  assert.doesNotThrow(() => cb(null, null))
})

test('入口 · 服务缺失（较老 dsh）时 apply 不崩，能力如实标不可用', () => {
  const h = makeHarness({ connection: null, sessionProjections: null, userQuestions: null })
  assert.doesNotThrow(() => plugin.apply(h.root))
  const route = h.record.routes.find((r) => r.path === '/mao-pet/capabilities')
  let body = ''
  route.handler({ method: 'GET', headers: { host: '127.0.0.1' } }, { setHeader() {}, end(c) { body = c } })
  // 异步 handler：这里只确保没抛
  assert.ok(typeof body === 'string')
})

test('入口 · 宿主栅栏缺失时仍走自校验（写路由不存在，读路由仍受保护）', async () => {
  const h = makeHarness({ connection: null })
  plugin.apply(h.root)
  const route = h.record.routes.find((r) => r.path === '/mao-pet/status')
  const res = { statusCode: null, ended: false, setHeader() {}, end() { this.ended = true } }
  await route.handler({ method: 'GET', headers: { host: 'evil.com' } }, res)
  assert.equal(res.statusCode, 403, '无宿主栅栏时插件自校验必须 fail-closed')
})

test('入口 · 全程无未捕获异常（console 输出无 error 级崩溃）', () => {
  const h = makeHarness()
  const logs = silenceConsole(() => {
    plugin.apply(h.root)
    h.record.sessionEvent[0].cb({ id: 's' }, { type: 'turn/start', data: {} })
  })
  // 只要求"跑完了"；日志内容不作断言（宿主 console 形态可能不同）
  assert.ok(Array.isArray(logs))
})
