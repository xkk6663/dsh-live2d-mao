/**
 * 6.2 / 6.5 验收：事件订阅 → phase → 推送（含节流、退避、请求体契约）。
 *
 * 这是"传输无关"设计的直接受益点：**端点尚未上线**也能把插件侧正确性测死。
 * mock transport 记录每一个信封，我们断言到 HTTP body 一层。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createPusher, stableStringify, AGENT_ID, AGENT_NAME } from '../lib/push/pusher.js'
import { createMockTransport } from '../lib/push/transports/mock.js'
import { createHttpTransport, INGEST_PATH } from '../lib/push/transports/http.js'
import { createConnector, REEMIT_MS } from '../lib/events.js'

/** 静默 logger：测试不该刷屏。 */
const quiet = { info: () => {}, warn: () => {}, debug: () => {} }

function makePusher(opts = {}) {
  const transport = createMockTransport(opts)
  const pusher = createPusher({ transport, logger: quiet })
  return { transport, pusher }
}

/** 等待微任务队列清空（推送是 fire-and-forget）。 */
const flush = () => new Promise((r) => setImmediate(r))

// ─────────────────────────────────────────────────────────────────────────────
// 身份：D5 命名裁决
// ─────────────────────────────────────────────────────────────────────────────

test('6.1 · 身份：总线 agent_id = dsh（与日志边车共用），名字/色值对齐 DSH', () => {
  // ★ 2026-10-17 用户裁决（合并身份）：产品是「DSH 专用桌宠」，桌宠上不该出现
  //   `dsh-live2d-mao` 和 `DSH` 两个 agent 抢镜头 ⇒ 插件推送复用边车的 `dsh`。
  //   ⚠ 注意：D5 约束的是 **npm 包名 / cordis 插件 id** = `dsh-live2d-mao`（装插件用），
  //     由 architecture.test.js 的 R3 守卫；本文件断言的是**总线身份**，两者不同。
  assert.equal(AGENT_ID, 'dsh')
  assert.equal(AGENT_NAME, 'DeepSeek Harness')
  assert.equal(AGENT_ID, AGENT_ID.toLowerCase(), '总线 agent_id 必须全小写')
})

test('6.5 · 信封带齐身份三件套（后端据此 register 与上色）', async () => {
  const { transport, pusher } = makePusher()
  await pusher.pushPhase('thinking', {})
  assert.equal(transport.last.agent_id, 'dsh')
  assert.equal(transport.last.name, 'DeepSeek Harness')
  assert.equal(transport.last.accent, '#4F6BED')
  assert.equal(transport.last.kind, 'phase')
  // 合并身份的来源标记：边车据此让位（见 dsh_adapter._plugin_owns_bus）
  assert.equal(transport.last.state.plugin_owned, true, '必须带 plugin_owned 标记')
})

// ─────────────────────────────────────────────────────────────────────────────
// phase 推送
// ─────────────────────────────────────────────────────────────────────────────

test('6.5 · 合法 phase 正常推送，force=true（phase 变化时强发，绕过后端 300ms 节流）', async () => {
  const { transport, pusher } = makePusher()
  const r = await pusher.pushPhase('executing_tool', { tool: 'pwsh' })
  assert.equal(r.ok, true)
  assert.equal(transport.last.phase, 'executing_tool')
  // state 会额外带 plugin_owned 标记（边车据此让位，见 pusher.js 注释）
  assert.deepEqual(transport.last.state, { tool: 'pwsh', plugin_owned: true })
  assert.equal(transport.last.force, true)
})

test('6.5 · 非法 phase 被插件拦下，不发往后端（后端 emit 会 raise ValueError）', async () => {
  const { transport, pusher } = makePusher()
  const r = await pusher.pushPhase('not-a-real-phase', {})
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unknown-phase')
  assert.equal(transport.count, 0, '不该把垃圾丢给后端')
})

test('6.5 · 同 phase 且 state 未变 → 跳过（不重复刷屏）', async () => {
  const { transport, pusher } = makePusher()
  await pusher.pushPhase('thinking', { a: 1 })
  const r2 = await pusher.pushPhase('thinking', { a: 1 })
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'unchanged')
  assert.equal(transport.count, 1)
})

test('6.5 · 同 phase 但 state 变了 → 照发（工具名变化必须可见）', async () => {
  const { transport, pusher } = makePusher()
  await pusher.pushPhase('executing_tool', { tool: 'pwsh' })
  await pusher.pushPhase('executing_tool', { tool: 'read' })
  assert.equal(transport.count, 2)
  assert.equal(transport.last.state.tool, 'read')
})

test('6.5 · state 键顺序不同不算"变了"（stableStringify 的价值）', async () => {
  const { transport, pusher } = makePusher()
  await pusher.pushPhase('thinking', { a: 1, b: 2 })
  const r = await pusher.pushPhase('thinking', { b: 2, a: 1 })
  assert.equal(r.reason, 'unchanged', '键顺序不该造成无谓推送')
  assert.equal(transport.count, 1)
})

test('6.5 · stableStringify 对嵌套结构也稳定', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }))
  assert.equal(stableStringify({ x: { p: 1, q: 2 } }), stableStringify({ x: { q: 2, p: 1 } }))
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }))
  assert.equal(stableStringify([1, 2]), '[1,2]')
  assert.equal(stableStringify(null), 'null')
})

test('6.5 · force 可绕过"未变化"判定（用于立即恢复语义）', async () => {
  const { transport, pusher } = makePusher()
  await pusher.pushPhase('thinking', {})
  await pusher.pushPhase('thinking', {}, { force: true })
  assert.equal(transport.count, 2)
})

// ─────────────────────────────────────────────────────────────────────────────
// 失败退避（桌宠后端没起是常态，不能刷屏、不能抛）
// ─────────────────────────────────────────────────────────────────────────────

test('6.5 · transport 抛异常时 pusher 不抛，进入退避', async () => {
  const transport = createMockTransport()
  transport.send = async () => { throw new Error('ECONNREFUSED') }
  const pusher = createPusher({ transport, logger: quiet })
  const r = await pusher.pushPhase('thinking', {})
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('ECONNREFUSED'))
  assert.equal(pusher.diagnostics().consecutive_failures, 1)
})

test('6.5 · 退避期间后续推送被合并（不反复打不可达的后端）', async () => {
  const { transport, pusher } = makePusher({
    scripted: [{ ok: false, status: 0 }, { ok: true, status: 200 }],
  })
  await pusher.pushPhase('thinking', {})
  assert.equal(pusher.diagnostics().consecutive_failures, 1)
  // 立刻再发 → 退避中，被合并
  const r = await pusher.pushPhase('executing_tool', {})
  assert.equal(r.reason, 'backoff')
  assert.equal(transport.count, 1, '退避期间不该真的发出去')
})

test('6.5 · heartbeat 绕过退避（否则断线恢复后无法重新报到）', async () => {
  const { transport, pusher } = makePusher({
    scripted: [{ ok: false, status: 0 }, { ok: true, status: 200 }],
  })
  await pusher.pushPhase('thinking', {})
  assert.equal(pusher.diagnostics().consecutive_failures, 1)
  await pusher.pushHeartbeat()
  assert.equal(transport.count, 2, 'heartbeat 必须能穿过退避')
  assert.equal(transport.last.kind, 'heartbeat')
})

test('6.5 · 恢复成功后连续失败计数清零', async () => {
  const { pusher } = makePusher({
    scripted: [{ ok: false, status: 0 }, { ok: true, status: 200 }],
  })
  await pusher.pushPhase('thinking', {})
  assert.equal(pusher.diagnostics().consecutive_failures, 1)
  await pusher.pushHeartbeat()
  assert.equal(pusher.diagnostics().consecutive_failures, 0)
})

test('6.5 · 后端返回 HTTP 400/422（契约不符）也算失败并退避，不刷栈', async () => {
  const { pusher } = makePusher({ scripted: [{ ok: false, status: 400 }] })
  const r = await pusher.pushPhase('thinking', {})
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
})

// ─────────────────────────────────────────────────────────────────────────────
// 三条旁路：phase / stream / bubble / heartbeat
// ─────────────────────────────────────────────────────────────────────────────

test('6.5 · stream 旁路：只出气泡，不改 phase', async () => {
  const { transport, pusher } = makePusher()
  await pusher.pushStream({
    frame: 'text-chunks', texts: ['你', '好'], final_text: '你好',
    dt: [10], time0: 1, index: 0, session: 's1',
  })
  assert.equal(transport.last.kind, 'stream')
  assert.equal(transport.last.payload.final_text, '你好')
  assert.equal(transport.last.phase, undefined, 'stream 不得携带 phase')
})

test('6.5 · ★ reasoning-chunks 一律不外发（推理草稿进气泡是越界）', async () => {
  const { transport, pusher } = makePusher()
  const r = await pusher.pushStream({ frame: 'reasoning-chunks', texts: ['让我想想'], final_text: '让我想想' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'frame-not-allowed')
  assert.equal(transport.count, 0, '推理草稿绝不能出网')
})

test('6.5 · tool-call-chunks 同样不外发（不属正文）', async () => {
  const { transport, pusher } = makePusher()
  const r = await pusher.pushStream({ frame: 'tool-call-chunks', args: [] })
  assert.equal(r.ok, false)
  assert.equal(transport.count, 0)
})

test('6.5 · bubble 旁路：一次性气泡，空文本不发', async () => {
  const { transport, pusher } = makePusher()
  await pusher.pushBubble('DSH 正在等你确认', 6000)
  assert.equal(transport.last.kind, 'bubble')
  assert.equal(transport.last.text, 'DSH 正在等你确认')
  assert.equal(transport.last.duration_ms, 6000)

  const before = transport.count
  await pusher.pushBubble('   ')
  assert.equal(transport.count, before, '空文本不该发')
})

test('6.5 · heartbeat 旁路：kind=heartbeat 且不带 phase', async () => {
  const { transport, pusher } = makePusher()
  await pusher.pushHeartbeat()
  assert.equal(transport.last.kind, 'heartbeat')
  assert.equal(transport.last.phase, undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// HTTP transport：请求体契约（与 Lead 定稿的 ingest schema 对齐）
// ─────────────────────────────────────────────────────────────────────────────

test('6.5 · HTTP 端点路径为 Lead 定稿的 /api/plugin/dsh/ingest', () => {
  assert.equal(INGEST_PATH, '/api/plugin/dsh/ingest')
})

test('6.5 · HTTP body：phase 信封带 phase/state/agent_id/name/accent', () => {
  const t = createHttpTransport({ baseUrl: 'http://127.0.0.1:8000', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
  const body = t.buildBody({
    agent_id: 'dsh', name: 'DeepSeek Harness', accent: '#4F6BED',
    kind: 'phase', phase: 'thinking', state: { tool: 'pwsh' }, seq: 7, force: true,
  })
  assert.equal(body.agent_id, 'dsh')
  assert.equal(body.phase, 'thinking')
  assert.deepEqual(body.state, { tool: 'pwsh' })
  assert.equal(body.seq, 7)
  assert.equal(body.force, true)
})

test('6.5 · HTTP body：缺省补全 agent_id/name（端点不因缺字段 422）', () => {
  const t = createHttpTransport({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
  const body = t.buildBody({ kind: 'phase', phase: 'idle' })
  assert.equal(body.agent_id, 'dsh')
  assert.equal(body.name, 'DeepSeek Harness')
})

test('6.5 · HTTP body：stream/bubble/heartbeat 三种 kind 各按其形', () => {
  const t = createHttpTransport({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
  assert.deepEqual(
    t.buildBody({ kind: 'stream', payload: { final_text: 'x' } }),
    { agent_id: 'dsh', name: 'DeepSeek Harness', accent: '', kind: 'stream', payload: { final_text: 'x' } },
  )
  assert.equal(t.buildBody({ kind: 'bubble', text: 'hi', duration_ms: 100 }).text, 'hi')
  assert.equal(t.buildBody({ kind: 'heartbeat' }).kind, 'heartbeat')
})

test('6.5 · HTTP 真的 POST 到正确 URL 且带 json content-type', async () => {
  const calls = []
  const t = createHttpTransport({
    baseUrl: 'http://127.0.0.1:8000',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })
  await t.send({ kind: 'phase', phase: 'complete', agent_id: 'dsh' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/plugin/dsh/ingest')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(JSON.parse(calls[0].init.body).phase, 'complete')
})

test('6.5 · HTTP 网络失败返回 {ok:false} 而不抛（后端没起是常态）', async () => {
  const t = createHttpTransport({
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  const r = await t.send({ kind: 'phase', phase: 'idle' })
  assert.equal(r.ok, false)
  assert.equal(r.status, 0)
  assert.ok(String(r.error).includes('ECONNREFUSED'))
})

test('6.5 · HTTP 响应非 JSON 也不炸', async () => {
  const t = createHttpTransport({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }),
  })
  const r = await t.send({ kind: 'phase', phase: 'idle' })
  assert.equal(r.ok, true)
  assert.equal(r.body, null)
})

test('6.5 · baseUrl 末尾斜杠被规整（不产生双斜杠）', () => {
  const t = createHttpTransport({
    baseUrl: 'http://127.0.0.1:8000///',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  })
  assert.equal(t.url, 'http://127.0.0.1:8000/api/plugin/dsh/ingest')
})

test('6.5 · 环境变量 MAO_PET_BACKEND 可覆盖后端地址', () => {
  const old = process.env.MAO_PET_BACKEND
  process.env.MAO_PET_BACKEND = 'http://127.0.0.1:9999'
  try {
    const t = createHttpTransport({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
    assert.equal(t.url, 'http://127.0.0.1:9999/api/plugin/dsh/ingest')
  } finally {
    if (old === undefined) delete process.env.MAO_PET_BACKEND
    else process.env.MAO_PET_BACKEND = old
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 连接器：6.2 事件 → phase 端到端
// ─────────────────────────────────────────────────────────────────────────────

function makeConnector(opts = {}) {
  const transport = createMockTransport(opts)
  const pusher = createPusher({ transport, logger: quiet })
  const connector = createConnector({ pusher, logger: quiet, reemitMs: opts.reemitMs || REEMIT_MS })
  return { transport, pusher, connector }
}

test('6.2 · ★ session/event 首参是 session、第二个是 event —— 端到端打出 phase', async () => {
  const { transport, connector } = makeConnector()
  const session = { id: 'session-abc' }
  connector.handleSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  await flush()
  assert.equal(transport.last.phase, 'planning')
  assert.equal(transport.last.state.session, 'session-abc')
  assert.equal(transport.last.state.turn, 1)
})

test('6.2 · 完整轮次的事件序列产生正确的 phase 序列（DP 验收：一说话就出 phase）', async () => {
  const { connector } = makeConnector()
  const seen = []
  connector.onPhase((e) => seen.push(e.phase))
  const s = { id: 's1' }

  connector.handleSessionEvent(s, { type: 'turn/start', data: { turn: 1 } })
  connector.handleSessionEvent(s, { type: 'step/start', data: { step: 1 } })
  connector.handleSessionEvent(s, { type: 'tool/call', data: { name: 'pwsh' } })
  connector.handleSessionEvent(s, { type: 'tool/result', data: { name: 'pwsh' } })
  connector.handleSessionEvent(s, {
    type: 'assistant/message', data: { content: [{ type: 'text', text: '好了' }] },
  })
  connector.handleSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  // 序列解读（每一步都是**该事件之后的真实相位**，不是理想化的直线）：
  //   turn/start      → planning      （轮次开始 = 规划意图）
  //   step/start      → thinking      （进入推理）
  //   tool/call       → executing_tool（工具在跑）
  //   tool/result     → thinking      （工具返回后回到推理 —— 工具已不再 active）
  //   assistant/message(纯文字) → streaming（正文输出）
  //   turn/end(completed) → complete
  assert.deepEqual(seen, ['planning', 'thinking', 'executing_tool', 'thinking', 'streaming', 'complete'])
})

test('6.2 · 形状防御：参数传反了也能纠正（写错会静默失效，必须能识别）', () => {
  const { connector } = makeConnector()
  // 故意传反：先 event 后 session
  const r = connector.handleSessionEvent({ type: 'turn/start', data: { turn: 9 } }, { id: 's9' })
  assert.equal(r.phase, 'planning')
  assert.equal(r.pushed, true)
})

test('6.2 · 非事件输入被安全忽略（不抛）', () => {
  const { connector } = makeConnector()
  assert.doesNotThrow(() => connector.handleSessionEvent({ id: 's' }, null))
  assert.doesNotThrow(() => connector.handleSessionEvent(null, null))
  assert.doesNotThrow(() => connector.handleSessionEvent(undefined, undefined))
  assert.doesNotThrow(() => connector.handleSessionEvent({ id: 's' }, { noType: true }))
  assert.equal(connector.handleSessionEvent({ id: 's' }, { noType: true }).phase, null)
})

test('6.2 · 事件回调不因推送失败而抛（fire-and-forget + 内部吞异常）', async () => {
  const transport = createMockTransport()
  transport.send = async () => { throw new Error('boom') }
  const pusher = createPusher({ transport, logger: quiet })
  const connector = createConnector({ pusher, logger: quiet })
  assert.doesNotThrow(() => connector.handleSessionEvent({ id: 's' }, { type: 'turn/start', data: {} }))
  await flush() // 让 unhandled rejection 有机会冒出来
})

test('6.5 · 多 session 各自分桶，不串账（M7 7.4 的基础）', async () => {
  const { transport, connector } = makeConnector()
  connector.handleSessionEvent({ id: 's1' }, { type: 'turn/start', data: { turn: 1 } })
  connector.handleSessionEvent({ id: 's2' }, { type: 'tool/call', data: { name: 'pwsh' } })
  await flush()
  // s2 没有 turn/start，所以它不在轮次内 → 应为 idle（不是 executing_tool）
  const snap = connector.snapshot()
  assert.equal(snap.sessions.length, 2, '两个 session 应各有一个桶')
  const s2 = snap.sessions.find((x) => x.session_id === 's2')
  assert.equal(s2.in_turn, false, 's2 未经过 turn/start，不该被认为在轮次内')
})

test('6.5 · paused 走连接层分支，force 强发', async () => {
  const { transport, connector } = makeConnector()
  const r = connector.emitPaused('会话不可用')
  await flush()
  assert.equal(r.phase, 'paused')
  assert.equal(transport.last.phase, 'paused')
  assert.equal(transport.last.force, true)
  assert.equal(transport.last.state.error, '会话不可用')
})

test('6.5 · heartbeat 走 heartbeat 通道（不改 phase、不污染 Agent 页）', async () => {
  const { transport, connector } = makeConnector()
  await connector.emitHeartbeat()
  assert.equal(transport.last.kind, 'heartbeat')
  assert.equal(transport.last.phase, undefined)
})

test('6.5 · 节流：同 phase 非工作态不重复推（idle-unchanged）', async () => {
  const { connector } = makeConnector()
  const r1 = connector.handleSessionEvent({ id: 's' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(r1.pushed, true)
  // 再次 turn/start → 仍是 planning（工作态），但 reemit 未到 → 不推
  const r2 = connector.handleSessionEvent({ id: 's' }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(r2.pushed, false)
})

test('6.4 · startTimers 返回可释放的 disposer（热重载不泄漏定时器）', () => {
  const { connector } = makeConnector({ reemitMs: 10, heartbeatMs: 10 })
  const stop = connector.startTimers()
  assert.equal(typeof stop, 'function')
  assert.doesNotThrow(() => stop())
})

test('6.5 · snapshot 只读且含 12 态词汇', () => {
  const { connector } = makeConnector()
  const snap = connector.snapshot()
  assert.equal(snap.agent_id, 'dsh')
  assert.equal(snap.known_phases.length, 12)
})

