/**
 * 7.6 横条「最后一公里」测试：宿主侧 remote 代理 —— 插件 → 后端 → 桌宠。
 *
 * 这三条断言守住的是**真实缺陷**（不是形式覆盖）：
 *   1. 宿主侧没有 `window.__mioPetStrip`（那在桌宠窗口里），若不传 remote，
 *      横条内容**永远送不出去**、只会降级成气泡 —— 7.6 的横条形态等于没落地。
 *   2. remote 必须把动作转成**正确的端点与请求体**（与后端 routes.plugin_strip 对齐）。
 *   3. 任何网络/后端异常都**不得抛**（契约铁律），也不得拖垮气泡链路。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createStripController } from '../lib/strip.js'
import { createStripRemote, STRIP_PATH } from '../lib/push/strip-remote.js'

/** 造一个记录型 fetch，返回可控响应。 */
function fakeFetch(recorder, { ok = true, status = 200, body = { ok: true, delivered: true } } = {}) {
  return async (url, init) => {
    recorder.push({ url, init, body: JSON.parse(init.body) })
    return {
      ok,
      status,
      json: async () => body,
    }
  }
}

/** 无 window 环境（宿主侧真实情形）。 */
const NO_WINDOW = {}

test('7.6·remote · ★ 宿主侧无 window 全局时，remote 让横条**仍然可用**（不降级气泡）', () => {
  const rec = []
  const strip = createStripController({
    win: NO_WINDOW,
    remote: createStripRemote({ fetchImpl: fakeFetch(rec) }),
    logger: { info() {}, warn() {}, debug() {} },
  })
  const r = strip.pushStream('宿主侧内容', { sessionId: 's1', append: true, sticky: true })
  assert.equal(r.shown, true, '应判定为已展示')
  assert.equal(r.via, 'strip', '★ 必须走横条，不是降级到气泡')
  assert.equal(rec.length, 1, '应真的发出一次请求')
  assert.equal(rec[0].url, 'http://127.0.0.1:8000' + STRIP_PATH)
})

test('7.6·remote · 不传 remote 时确实会降级（证明 remote 是必要条件）', () => {
  const strip = createStripController({
    win: NO_WINDOW,
    logger: { info() {}, warn() {}, debug() {} },
  })
  const r = strip.pushStream('没有 remote', { sessionId: 's1' })
  assert.equal(r.shown, false)
  assert.equal(r.via, 'none')
})

test('7.6·remote · 请求体与后端契约逐字段对齐（kind/text/sessionId/sticky/durationMs）', () => {
  const rec = []
  const strip = createStripController({
    win: NO_WINDOW,
    remote: createStripRemote({ fetchImpl: fakeFetch(rec) }),
    logger: { info() {}, warn() {}, debug() {} },
  })

  strip.pushStream('整段', { sessionId: 'ses-A', durationMs: 2500 })
  assert.deepEqual(rec[0].body, {
    kind: 'show', text: '整段', sessionId: 'ses-A', sticky: false, durationMs: 2500,
  })

  strip.pushStream('增量', { sessionId: 'ses-B', append: true, sticky: true })
  assert.deepEqual(rec[1].body, {
    kind: 'append', text: '增量', sessionId: 'ses-B',
  })
})

test('7.6·remote · 动作走 POST + JSON content-type', () => {
  const rec = []
  const strip = createStripController({
    win: NO_WINDOW,
    remote: createStripRemote({ fetchImpl: fakeFetch(rec) }),
    logger: { info() {}, warn() {}, debug() {} },
  })
  strip.pushStream('x', { sessionId: 's' })
  assert.equal(rec[0].init.method, 'POST')
  assert.equal(rec[0].init.headers['Content-Type'], 'application/json')
})

test('7.6·remote · style 动作与 show/append 分开（不混进文本通道）', () => {
  const rec = []
  const remote = createStripRemote({ fetchImpl: fakeFetch(rec) })
  const got = remote.applyStyle('terminal')
  assert.equal(got, 'terminal')
  assert.deepEqual(rec[0].body, { kind: 'style', styleId: 'terminal' })
})

test('7.6·remote · hide 动作', () => {
  const rec = []
  const remote = createStripRemote({ fetchImpl: fakeFetch(rec) })
  remote.hide()
  assert.deepEqual(rec[0].body, { kind: 'hide' })
})

test('7.6·remote · 空文本不发请求（不制造无意义流量）', () => {
  const rec = []
  const remote = createStripRemote({ fetchImpl: fakeFetch(rec) })
  assert.equal(remote.show('   '), false)
  assert.equal(remote.append(''), false)
  assert.equal(remote.applyStyle(''), null)
  assert.equal(rec.length, 0)
})

test('7.6·remote · ★ 网络异常不抛（契约铁律：横条通道不得把调用方带崩）', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED') }
  const remote = createStripRemote({ fetchImpl: boom })
  assert.doesNotThrow(() => remote.show('x', { sessionId: 's' }))
  assert.doesNotThrow(() => remote.append('x'))
  assert.doesNotThrow(() => remote.hide())
  assert.doesNotThrow(() => remote.applyStyle('navy'))
  // 等一拍，确保异步 catch 分支真的跑过（未被 unhandled rejection 打断）
  await new Promise((r) => setTimeout(r, 20))
})

test('7.6·remote · 后端 404（旧进程无此路由）不抛、不算致命', async () => {
  const rec = []
  const remote = createStripRemote({ fetchImpl: fakeFetch(rec, { ok: false, status: 404 }) })
  const res = await remote.send({ kind: 'hide' })
  assert.equal(res.ok, false)
  assert.equal(res.status, 404)
})

test('7.6·remote · 无 fetch 的运行时安全降级（不抛）', () => {
  const remote = createStripRemote({ fetchImpl: null })
  assert.doesNotThrow(() => remote.show('x'))
  assert.equal(remote.isVisible(), false)
  assert.equal(remote.isDismissed(), false)
})

test('7.6·remote · baseUrl 末尾斜杠被规整（不产生双斜杠）', () => {
  const rec = []
  const remote = createStripRemote({
    baseUrl: 'http://127.0.0.1:8000///',
    fetchImpl: fakeFetch(rec),
  })
  remote.show('x')
  assert.equal(rec[0].url, 'http://127.0.0.1:8000' + STRIP_PATH)
  assert.ok(!rec[0].url.includes('//api'))
})

test('7.6·remote · 环境变量 MAO_PET_BACKEND 可覆盖后端地址', () => {
  const prev = process.env.MAO_PET_BACKEND
  process.env.MAO_PET_BACKEND = 'http://127.0.0.1:9999'
  try {
    const rec = []
    const remote = createStripRemote({ fetchImpl: fakeFetch(rec) })
    remote.show('x')
    assert.equal(rec[0].url, 'http://127.0.0.1:9999' + STRIP_PATH)
  } finally {
    if (prev === undefined) delete process.env.MAO_PET_BACKEND
    else process.env.MAO_PET_BACKEND = prev
  }
})

test('7.6·remote · isVisible/isDismissed 如实返回保守值（不假装知道跨进程状态）', () => {
  const remote = createStripRemote({ fetchImpl: fakeFetch([]) })
  // 宿主侧读不到桌宠窗口的 localStorage，故必须保守 —— 撒谎会让编排层做错决策
  assert.equal(remote.isVisible(), false)
  assert.equal(remote.isDismissed(), false)
  const info = remote.info()
  assert.equal(info.transport, 'http')
  assert.equal(info.local, false)
})

test('7.6·remote · ★ 会话级抑制对 remote 同样生效（不因换传输而丢语义）', () => {
  const rec = []
  const strip = createStripController({
    win: NO_WINDOW,
    remote: createStripRemote({ fetchImpl: fakeFetch(rec) }),
    logger: { info() {}, warn() {}, debug() {} },
  })
  strip.markDismissed('sess-X')
  const after = strip.pushStream('不该发', { sessionId: 'sess-X' })
  assert.equal(after.shown, false)
  assert.equal(after.reason, 'session-suppressed')
  assert.equal(rec.length, 0, '被抑制时不应产生任何请求')
})

test('7.6·remote · ★ 互斥仍走横条通道（与气泡不同时弹）', () => {
  const rec = []
  const bubbleRec = []
  const strip = createStripController({
    win: {
      __mioPetBubble: {
        show: (t) => { bubbleRec.push(t); return true },
        hide() {}, isVisible: () => false, setEnabled() {},
      },
    },
    remote: createStripRemote({ fetchImpl: fakeFetch(rec) }),
    logger: { info() {}, warn() {}, debug() {} },
  })
  // 同一内容先走横条，再推气泡 → 应被互斥挡下
  strip.pushStream('同一条内容', { sessionId: 's' })
  const dup = strip.pushBubble('同一条内容', { sessionId: 's' })
  assert.equal(dup.shown, false)
  assert.equal(dup.reason, 'same-content-on-strip')
  assert.equal(bubbleRec.length, 0, '气泡侧不应被调用')
})
