/**
 * 7.6 验收：横条复用为 DSH 流式提示窗口（插件侧编排层）。
 *
 * 四条验收在本文件的落点：
 *   ① 流式提示显示在横条内、可拖动、✕ 可关 —— 插件侧验证"调到 __mioPetStrip.show/append"；
 *      拖动与 ✕ 属主体（本层只读 isDismissed）。
 *   ② 气泡与横条不同时弹同一内容 —— 互斥状态机。
 *   ③ 横条主题可自定义 —— applyStyle 委托主体，主键 live2d_strip_style（+ 别名 pet_strip_style）。
 *   ④ 关闭后本次会话不再自动弹 —— suppressedSessions（且不跨会话）。
 *   外加：__mioPetStrip 缺席时**优雅降级**到 __mioPetBubble，且不报错。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createStripController, MODE, STRIP_GLOBAL, BUBBLE_GLOBAL, STRIP_STYLE_KEY,
  STRIP_STYLE_KEY_ALIAS, STRIP_STYLE_KEYS,
  describeStripContract,
} from '../lib/strip.js'

const quiet = { info: () => {}, warn: () => {}, debug: () => {} }

/** 构造一个假 window，含可编程的横条与气泡 API。 */
function fakeWin(opts = {}) {
  const calls = []
  const win = {}

  if (opts.strip !== false) {
    win[STRIP_GLOBAL] = {
      show: (text, o) => { calls.push(['strip.show', text, o]); return opts.stripShowReturns ?? true },
      append: (t, o) => { calls.push(['strip.append', t, o]); return opts.stripAppendReturns ?? true },
      hide: () => { calls.push(['strip.hide']) },
      isVisible: () => opts.visible ?? true,
      isDismissed: () => opts.dismissed ?? false,
      setEnabled: (on) => { calls.push(['strip.setEnabled', on]) },
      applyStyle: (id) => { calls.push(['strip.applyStyle', id]); return opts.appliedStyle ?? id },
      info: () => ({ visible: true, dismissed: false, enabled: true, styleId: 'navy' }),
    }
  }

  if (opts.bubble !== false) {
    win[BUBBLE_GLOBAL] = {
      show: (text, d, rid, aid, accent) => { calls.push(['bubble.show', text, d, aid, accent]); return true },
      hide: () => { calls.push(['bubble.hide']) },
      isVisible: () => true,
      setEnabled: (on) => { calls.push(['bubble.setEnabled', on]) },
    }
  }

  win.__calls = calls
  return win
}

// ═════════════════════════════════════════════════════════════════════════════
// ① 流式提示进横条
// ═════════════════════════════════════════════════════════════════════════════

test('7.6① · 流式内容经 __mioPetStrip.show 显示在横条内', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  const r = c.pushStream('正在分析代码…', { sessionId: 's1' })
  assert.equal(r.shown, true)
  assert.equal(r.via, 'strip')
  assert.equal(win.__calls[0][0], 'strip.show')
  assert.equal(win.__calls[0][1], '正在分析代码…')
  assert.equal(win.__calls[0][2].sessionId, 's1')
})

test('7.6① · append 模式用于逐 token 追加', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.pushStream('第一段', { sessionId: 's1', append: true })
  assert.equal(win.__calls[0][0], 'strip.append')
})

test('7.6① · sticky / durationMs 透传给主体', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.pushStream('x', { sessionId: 's1', sticky: true, durationMs: 3000 })
  const opts = win.__calls[0][2]
  assert.equal(opts.sticky, true)
  assert.equal(opts.durationMs, 3000)
})

test('7.6① · 空文本不推（也不调主体）', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  const r = c.pushStream('   ', { sessionId: 's1' })
  assert.equal(r.shown, false)
  assert.equal(r.reason, 'empty-text')
  assert.equal(win.__calls.length, 0)
})

test('7.6① · 主体拒绝（show 返回 false）→ 不报错，如实返回', () => {
  const win = fakeWin({ stripShowReturns: false })
  const c = createStripController({ win, logger: quiet })
  const r = c.pushStream('x', { sessionId: 's1' })
  assert.equal(r.shown, false)
  assert.equal(r.reason, 'strip-rejected')
})

test('7.6① · ✕ 已关（isDismissed）→ 不弹，且**不报错**', () => {
  const win = fakeWin({ dismissed: true })
  const c = createStripController({ win, logger: quiet })
  const r = c.pushStream('x', { sessionId: 's1' })
  assert.equal(r.shown, false)
  assert.equal(r.reason, 'dismissed')
})

// ═════════════════════════════════════════════════════════════════════════════
// ② 互斥：气泡与横条不同时弹同一内容
// ═════════════════════════════════════════════════════════════════════════════

test('7.6② · ★ 同一内容已由横条承载 → 不再弹气泡（互斥）', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.pushStream('同一句话', { sessionId: 's1' })
  assert.equal(c.mode, MODE.STRIP)

  const r = c.pushBubble('同一句话', { sessionId: 's1' })
  assert.equal(r.shown, false)
  assert.equal(r.reason, 'same-content-on-strip')
  // 不得调用气泡
  assert.equal(win.__calls.filter((x) => x[0] === 'bubble.show').length, 0)
})

test('7.6② · 不同内容 → 气泡可弹，且横条让位', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.pushStream('流式内容', { sessionId: 's1' })
  const r = c.pushBubble('说话内容', { sessionId: 's1' })
  assert.equal(r.shown, true)
  assert.equal(r.via, 'bubble')
  assert.equal(c.mode, MODE.BUBBLE)
  assert.ok(win.__calls.some((x) => x[0] === 'strip.hide'), '横条应让位')
})

test('7.6② · 反方向：气泡在承载时，横条可直接接手（切换模式）', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.pushBubble('说话', { sessionId: 's1' })
  assert.equal(c.mode, MODE.BUBBLE)
  const r = c.pushStream('流式', { sessionId: 's1' })
  assert.equal(r.shown, true)
  assert.equal(c.mode, MODE.STRIP)
})

test('7.6② · 模式是单值（互斥的载体）', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  assert.equal(c.mode, MODE.IDLE)
  c.pushStream('a', { sessionId: 's' })
  assert.equal(c.mode, MODE.STRIP)
  c.clear()
  assert.equal(c.mode, MODE.IDLE)
})

test('7.6② · clear 清空窗位并复位模式', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.pushStream('a', { sessionId: 's' })
  c.clear()
  assert.equal(c.mode, MODE.IDLE)
  assert.equal(c.currentKey, '')
  assert.ok(win.__calls.some((x) => x[0] === 'strip.hide'))
})

// ═════════════════════════════════════════════════════════════════════════════
// ③ 主题自定义
// ═════════════════════════════════════════════════════════════════════════════

test('7.6③ · 主题键：主键 live2d_strip_style + 别名 pet_strip_style（两个都认）', () => {
  assert.equal(STRIP_STYLE_KEY, 'live2d_strip_style', '主键与 live2d_bubble_style 同族')
  assert.equal(STRIP_STYLE_KEY_ALIAS, 'pet_strip_style', '别名保留，防两端键名漂移')
  assert.deepEqual([...STRIP_STYLE_KEYS], ['live2d_strip_style', 'pet_strip_style'])
})

test('7.6③ · applyStyle 委托主体，返回实际生效的 id', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  const r = c.applyStyle('navy')
  assert.equal(r.applied, true)
  assert.equal(r.styleId, 'navy')
  assert.deepEqual(win.__calls[0], ['strip.applyStyle', 'navy'])
})

test('7.6③ · ★ 插件不自己改样式 —— 只调主体的 applyStyle（D4：不改核心 DOM）', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.applyStyle('mono')
  // 全部调用都应落在 strip 通道上，没有任何直接 DOM/class 操作
  assert.ok(win.__calls.every((x) => String(x[0]).startsWith('strip.')))
})

test('7.6③ · 横条不可用时 applyStyle 返回原因，不抛', () => {
  const win = fakeWin({ strip: false })
  const c = createStripController({ win, logger: quiet })
  const r = c.applyStyle('navy')
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'strip-unavailable')
})

test('7.6③ · 主体 applyStyle 抛异常 → 安全兜底', () => {
  const win = fakeWin()
  win[STRIP_GLOBAL].applyStyle = () => { throw new Error('boom') }
  const c = createStripController({ win, logger: quiet })
  assert.doesNotThrow(() => c.applyStyle('navy'))
  assert.equal(c.applyStyle('navy').applied, false)
})

// ═════════════════════════════════════════════════════════════════════════════
// ④ 关闭后本会话不再自动弹
// ═════════════════════════════════════════════════════════════════════════════

test('7.6④ · ★ 标记 dismissed 后，本会话不再自动弹', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.markDismissed('s1')

  const r = c.pushStream('后续流式内容', { sessionId: 's1' })
  assert.equal(r.shown, false)
  assert.equal(r.reason, 'session-suppressed')
  assert.equal(win.__calls.length, 0, '不该再打扰主体')
})

test('7.6④ · ★ 抑制是**会话级**的 —— 其它会话不受影响（不跨会话记忆）', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.markDismissed('s1')
  const r = c.pushStream('另一个会话的流式', { sessionId: 's2' })
  assert.equal(r.shown, true, '其它会话应正常弹')
})

test('7.6④ · ★ "下次流式再弹" —— 清掉抑制后同一会话可再弹', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.markDismissed('s1')
  assert.equal(c.pushStream('x', { sessionId: 's1' }).shown, false)
  c.clearSuppressed('s1')
  assert.equal(c.pushStream('y', { sessionId: 's1' }).shown, true)
})

test('7.6④ · markDismissed 同时复位占用模式（关掉即释放窗位）', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.pushStream('a', { sessionId: 's1' })
  c.markDismissed('s1')
  assert.equal(c.mode, MODE.IDLE)
  assert.equal(c.currentKey, '')
})

test('7.6④ · 无 sessionId 的推送不受抑制影响（保守放行）', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.markDismissed('s1')
  assert.equal(c.pushStream('x', {}).shown, true)
})

test('7.6④ · clearSuppressed() 无参 → 清空全部', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.markDismissed('s1')
  c.markDismissed('s2')
  c.clearSuppressed()
  assert.equal(c.isSuppressed('s1'), false)
  assert.equal(c.isSuppressed('s2'), false)
})

// ═════════════════════════════════════════════════════════════════════════════
// 优雅降级：横条缺席时回落气泡
// ═════════════════════════════════════════════════════════════════════════════

test('7.6降级 · ★ __mioPetStrip 不存在 → 回落 __mioPetBubble，且不报错', () => {
  const win = fakeWin({ strip: false })
  const c = createStripController({ win, logger: quiet })
  const r = c.pushStream('流式内容', { sessionId: 's1' })
  assert.equal(r.shown, true)
  assert.equal(r.via, 'bubble', '应降级到气泡')
  assert.ok(win.__calls.some((x) => x[0] === 'bubble.show'))
})

test('7.6降级 · 降级时只告警一次（不刷屏）', () => {
  const infos = []
  const win = fakeWin({ strip: false })
  const c = createStripController({ win, logger: { ...quiet, info: (m) => infos.push(m) } })
  c.pushStream('a', { sessionId: 's1' })
  c.pushStream('b', { sessionId: 's1' })
  c.pushStream('c', { sessionId: 's1' })
  assert.equal(infos.length, 1, '降级信息只应打一次')
  assert.ok(infos[0].includes('降级'))
})

test('7.6降级 · 降级回调被调用（供诊断）', () => {
  const reasons = []
  const win = fakeWin({ strip: false })
  const c = createStripController({ win, logger: quiet, onDegrade: (r) => reasons.push(r) })
  c.pushStream('a', { sessionId: 's1' })
  assert.equal(reasons.length, 1)
  assert.ok(reasons[0].includes(STRIP_GLOBAL))
})

test('7.6降级 · 横条与气泡都不存在 → 返回 shown:false，绝不抛', () => {
  const win = fakeWin({ strip: false, bubble: false })
  const c = createStripController({ win, logger: quiet })
  assert.doesNotThrow(() => c.pushStream('x', { sessionId: 's1' }))
  assert.equal(c.pushStream('x', { sessionId: 's1' }).shown, false)
})

test('7.6降级 · hasStrip 如实反映通道可用性', () => {
  assert.equal(createStripController({ win: fakeWin(), logger: quiet }).hasStrip(), true)
  assert.equal(createStripController({ win: fakeWin({ strip: false }), logger: quiet }).hasStrip(), false)
})

// ═════════════════════════════════════════════════════════════════════════════
// 健壮性 / 契约
// ═════════════════════════════════════════════════════════════════════════════

test('7.6 · 主体 API 抛异常时全部安全兜底（契约要求不得抛）', () => {
  const win = fakeWin()
  for (const m of ['show', 'append', 'hide', 'isVisible', 'isDismissed', 'applyStyle', 'info']) {
    win[STRIP_GLOBAL][m] = () => { throw new Error('主体 ' + m + ' 炸了') }
  }
  const c = createStripController({ win, logger: quiet })
  assert.doesNotThrow(() => c.pushStream('x', { sessionId: 's1' }))
  assert.doesNotThrow(() => c.pushStream('x', { sessionId: 's1', append: true }))
  assert.doesNotThrow(() => c.applyStyle('navy'))
  assert.doesNotThrow(() => c.clear())
  assert.doesNotThrow(() => c.diagnostics())
})

test('7.6 · 主体 API 形状畸形（非对象）时不崩', () => {
  for (const bad of ['str', 42, true, []]) {
    const win = { [STRIP_GLOBAL]: bad, [BUBBLE_GLOBAL]: undefined }
    const c = createStripController({ win, logger: quiet })
    assert.doesNotThrow(() => c.pushStream('x', { sessionId: 's' }))
    assert.equal(c.hasStrip(), false)
  }
})

test('7.6 · diagnostics 只读快照含关键状态', () => {
  const win = fakeWin()
  const c = createStripController({ win, logger: quiet })
  c.pushStream('a', { sessionId: 's1' })
  c.markDismissed('s2')
  const d = c.diagnostics()
  assert.equal(d.mode, MODE.IDLE)
  assert.equal(d.has_strip, true)
  assert.equal(d.has_bubble, true)
  assert.deepEqual(d.suppressed_sessions, ['s2'])
  assert.ok(d.strip_info)
})

test('7.6 · describeStripContract 列出主体必须实现的方法', () => {
  const contract = describeStripContract({})
  assert.equal(contract.global, '__mioPetStrip')
  assert.equal(contract.styleKey, 'live2d_strip_style')
  assert.deepEqual(contract.styleKeys, ['live2d_strip_style', 'pet_strip_style'])
  assert.deepEqual(contract.missing, [
    'show', 'append', 'hide', 'isVisible', 'isDismissed', 'setEnabled', 'applyStyle', 'info',
  ])
  // 全部实现 → missing 为空
  const full = {}
  for (const m of contract.required_methods) full[m] = () => {}
  assert.deepEqual(describeStripContract(full).missing, [])
})
