/**
 * 7.4 / 7.5 验收。
 * （7.2 审批回传 / 7.3 提问回传 已随用户裁决阉割，见 AGENTS.md 关键决策。）
 *
 * ⚠ 标注纪律：本文件全部断言都是对**本插件代码**的真实执行结果；
 *   被 mock 的 DSH 服务行为（`stateOf`）来自源码行号级阅读，未在真实 DSH 会话里跑过。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  readProjection, readProjections, summarizeContextPressure, summarizeTokenUsage,
  summarizeInbox, summarizeAll, KNOWN_KEYS,
} from '../lib/projections.js'
import {
  createBubbleStack, isSubSession, sessionIdOf, MAX_SESSION_BUBBLES,
} from '../lib/bubble-stack.js'

const quiet = { info: () => {}, warn: () => {}, debug: () => {} }

// ═════════════════════════════════════════════════════════════════════════════
// 7.5 projections
// ═════════════════════════════════════════════════════════════════════════════

test('7.5 · readProjection：正常读取', () => {
  const svc = { stateOf: (s, k) => (k === 'contextPressure' ? { surfaceTokens: 100 } : undefined) }
  assert.deepEqual(readProjection(svc, { id: 's' }, 'contextPressure'), { surfaceTokens: 100 })
})

test('7.5 · ★ 未注册 key 返回 undefined → 我们兜底为 null（源码 :129）', () => {
  const svc = { stateOf: () => undefined }
  assert.equal(readProjection(svc, { id: 's' }, 'nonexistentKey'), null)
})

test('7.5 · 服务缺失 / stateOf 抛异常 / session 缺失 → 都返回 null，不抛', () => {
  assert.equal(readProjection(null, { id: 's' }, 'k'), null)
  assert.equal(readProjection({}, { id: 's' }, 'k'), null)
  assert.equal(readProjection({ stateOf: () => { throw new Error('x') } }, { id: 's' }, 'k'), null)
  assert.equal(readProjection({ stateOf: () => ({ a: 1 }) }, null, 'k'), null)
})

test('7.5 · readProjections 批量读，单项失败不影响其它', () => {
  const svc = {
    stateOf: (s, k) => {
      if (k === 'tokenUsage') throw new Error('boom')
      if (k === 'inbox') return { 'next-turn': [1] }
      return undefined
    },
  }
  const r = readProjections(svc, { id: 's' }, ['contextPressure', 'tokenUsage', 'inbox'])
  assert.equal(r.contextPressure, null)
  assert.equal(r.tokenUsage, null, '抛异常项应为 null')
  assert.deepEqual(r.inbox, { 'next-turn': [1] })
})

test('7.5 · KNOWN_KEYS 含五个已确证的 key', () => {
  assert.deepEqual([...KNOWN_KEYS], [
    'contextPressure', 'tokenUsage', 'contextBreakdown', 'userQuestions', 'inbox',
  ])
})

test('7.5 · summarizeContextPressure：算百分比', () => {
  const s = summarizeContextPressure({ pressureTokens: 5000, contextWindow: 100000, surfaceTokens: 4000 })
  assert.equal(s.pressure, 5000)
  assert.equal(s.window, 100000)
  assert.equal(s.percent, 5)
})

test('7.5 · ★ summarizeContextPressure：window 缺失或为 0 时不算百分比（避免 Infinity）', () => {
  const s = summarizeContextPressure({ surfaceTokens: 100 })
  assert.equal(s.percent, undefined)
  assert.equal(s.surface, 100)

  const s2 = summarizeContextPressure({ surfaceTokens: 100, contextWindow: 0 })
  assert.equal(s2.percent, undefined, '除零必须避免')
})

test('7.5 · ★ 空/畸形 view → null（未注册 key 的兜底链路）', () => {
  for (const bad of [undefined, null, {}, 'x', 42, []]) {
    assert.equal(summarizeContextPressure(bad), null)
  }
})

test('7.5 · summarizeTokenUsage 归一常见字段名', () => {
  const s = summarizeTokenUsage({ totals: { input: 10, output: 20 } })
  assert.equal(s.in, 10)
  assert.equal(s.out, 20)
  const s2 = summarizeTokenUsage({ totals: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } })
  assert.equal(s2.in, 5)
  assert.equal(s2.total, 11)
  assert.equal(summarizeTokenUsage({}), null)
  assert.equal(summarizeTokenUsage(null), null)
})

test('7.5 · summarizeInbox 统计 next-turn / next-step', () => {
  assert.deepEqual(summarizeInbox({ 'next-turn': [1, 2], 'next-step': [3] }), { next_turn: 2, next_step: 1 })
  assert.equal(summarizeInbox({}), null)
  assert.equal(summarizeInbox(null), null)
})

test('7.5 · summarizeAll 组合三项，读不到就不放该键', () => {
  const svc = {
    stateOf: (s, k) => {
      if (k === 'contextPressure') return { surfaceTokens: 10, contextWindow: 100 }
      return undefined
    },
  }
  const all = summarizeAll(svc, { id: 's' })
  assert.equal(all.context.surface, 10)
  assert.equal(all.usage, undefined, '读不到不该放空对象')
  assert.equal(all.inbox, undefined)
})

// ═════════════════════════════════════════════════════════════════════════════
// 7.4 气泡栈
// ═════════════════════════════════════════════════════════════════════════════

test('7.4 · MAX_SESSION_BUBBLES 为 12（技术方案 §2 表）', () => {
  assert.equal(MAX_SESSION_BUBBLES, 12)
})

test('7.4 · isSubSession 识别两种判据 + delegationDepth', () => {
  assert.equal(isSubSession({ id: 'a', parentSessionId: 'p' }), true)
  assert.equal(isSubSession({ id: 'a', origin: 'subagent' }), true)
  assert.equal(isSubSession({ id: 'a', delegationDepth: 1 }), true)
  assert.equal(isSubSession({ id: 'a', delegationDepth: 0 }), false)
  assert.equal(isSubSession({ id: 'a' }), false)
  assert.equal(isSubSession(null), false)
})

test('7.4 · sessionIdOf 兼容 id / sessionId', () => {
  assert.equal(sessionIdOf({ id: 'a' }), 'a')
  assert.equal(sessionIdOf({ sessionId: 'b' }), 'b')
  assert.equal(sessionIdOf(null), '')
})

test('7.4 · 压入气泡并被认作 active', () => {
  const st = createBubbleStack({ logger: quiet })
  const r = st.push({ id: 's1' }, { text: '你好', phase: 'streaming' })
  assert.equal(r.accepted, true)
  assert.equal(r.active, 's1')
  assert.equal(st.size(), 1)
})

test('7.4 · 空文本 / 无 session id 被拒', () => {
  const st = createBubbleStack({ logger: quiet })
  assert.equal(st.push({ id: 's1' }, { text: '  ' }).accepted, false)
  assert.equal(st.push({}, { text: 'x' }).accepted, false)
  assert.equal(st.push({ id: 's1' }, {}).accepted, false)
  assert.equal(st.size(), 0)
})

test('7.4 · ★ 超过 12 条时淘汰**优先级最低**的（不是最早来的）', () => {
  const st = createBubbleStack({ logger: quiet })
  // 压入 12 条，其中 s1 是最高优先级（voice=1）
  st.push({ id: 's1' }, { text: 'x', phase: 'voice' })
  for (let i = 2; i <= 12; i++) st.push({ id: 's' + i }, { text: 'x', phase: 'idle' })
  assert.equal(st.size(), 12)

  // 第 13 条 → 必须淘汰一个 idle，绝不能淘汰 s1(voice)
  const r = st.push({ id: 's13' }, { text: 'x', phase: 'idle' })
  assert.equal(r.accepted, true)
  assert.equal(st.size(), 12, '上限必须守住')
  assert.notEqual(r.evicted, 's1', '最高优先级的会话不该被淘汰')
  const ids = st.snapshot().map((e) => e.session_id)
  assert.ok(ids.includes('s1'), 's1 应仍在栈内')
})

test('7.4 · 同 session 重复压入是更新而非新增', () => {
  const st = createBubbleStack({ logger: quiet })
  st.push({ id: 's1' }, { text: 'a' })
  st.push({ id: 's1' }, { text: 'b' })
  assert.equal(st.size(), 1)
  assert.equal(st.snapshot()[0].text, 'b')
})

test('7.4 · 优先级高者成为 active（voice 压过 idle）', () => {
  const st = createBubbleStack({ logger: quiet })
  st.push({ id: 's1' }, { text: 'a', phase: 'idle' })
  st.push({ id: 's2' }, { text: 'b', phase: 'voice' })
  assert.equal(st.active(), 's2')
})

test('7.4 · 同优先级按最近活动排序', () => {
  let t = 1000
  const st = createBubbleStack({ logger: quiet, now: () => t })
  st.push({ id: 's1' }, { text: 'a', phase: 'thinking' })
  t = 2000
  st.push({ id: 's2' }, { text: 'b', phase: 'thinking' })
  assert.equal(st.active(), 's2', '更近活动者优先')
})

test('7.4 · TTL 到期后条目被回收', () => {
  let t = 1000
  const st = createBubbleStack({ logger: quiet, now: () => t, ttlMs: 100 })
  st.push({ id: 's1' }, { text: 'a' })
  assert.equal(st.size(), 1)
  t = 1200
  assert.equal(st.size(), 0, '过期应被清理')
  assert.equal(st.active(), null)
})

test('7.4 · remove 手动移除', () => {
  const st = createBubbleStack({ logger: quiet })
  st.push({ id: 's1' }, { text: 'a' })
  assert.equal(st.remove({ id: 's1' }), true)
  assert.equal(st.size(), 0)
})

test('7.4 · 子会话被标记 is_sub', () => {
  const st = createBubbleStack({ logger: quiet })
  st.push({ id: 'sub1', parentSessionId: 'main' }, { text: 'a' })
  assert.equal(st.snapshot()[0].is_sub, true)
})

test('7.4 · 上限可注入（测试用），且 snapshot 只读含 age_ms', () => {
  let t = 5000
  const st = createBubbleStack({ logger: quiet, max: 2, now: () => t })
  st.push({ id: 'a' }, { text: '1' })
  st.push({ id: 'b' }, { text: '2' })
  const r = st.push({ id: 'c' }, { text: '3' })
  assert.equal(r.accepted, true)
  assert.equal(st.size(), 2)
  assert.ok(typeof st.snapshot()[0].age_ms === 'number')
})
