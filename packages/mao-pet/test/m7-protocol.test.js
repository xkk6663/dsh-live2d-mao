/**
 * 7.2 / 7.3 / 7.4 / 7.5 验收。
 *
 * ⚠ 标注纪律（任务要求"如实标注哪些是实测、哪些是源码推断"）：
 *   - **实测**：本文件全部断言 —— 都是对**本插件代码**的真实执行结果；
 *   - **源码推断**：被 mock 的 DSH 服务行为（`userQuestions.answer` / `stateOf` /
 *     `approval/request` waterfall）来自源码行号级阅读，**未在真实 DSH 会话里跑过**，
 *     因为（a）7.2 的审批闸门当前是 `never`（联调需切 `ask`），
 *     （b）7.1~7.5 的真机联调归 task-3（需用户在场）。
 *     每条 mock 旁都注明了对应的源码行号，便于日后核对。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createApprovalDecider, raceTimeout, describeApproval,
  OUTCOMES, GRANT, REJECT, CANCELLED, UNAVAILABLE,
} from '../lib/approval.js'
import {
  createQuestionAnswerer, validateAnswers, pendingQuestions, describeQuestions,
} from '../lib/questions.js'
import {
  readProjection, readProjections, summarizeContextPressure, summarizeTokenUsage,
  summarizeInbox, summarizeAll, KNOWN_KEYS,
} from '../lib/projections.js'
import {
  createBubbleStack, isSubSession, sessionIdOf, MAX_SESSION_BUBBLES,
} from '../lib/bubble-stack.js'

const quiet = { info: () => {}, warn: () => {}, debug: () => {} }

// ═════════════════════════════════════════════════════════════════════════════
// 7.2 审批
// ═════════════════════════════════════════════════════════════════════════════

test('7.2 · OUTCOMES 与源码 :30-35 逐字一致（4 值，顺序一致）', () => {
  assert.deepEqual([...OUTCOMES], ['allowed-once', 'rejected', 'cancelled', 'unavailable'])
})

test('7.2 · 允许 → allowed-once（唯一允许值）', async () => {
  const d = createApprovalDecider({ askUser: async () => 'allow', logger: quiet })
  assert.equal(await d.decide({ toolName: 'pwsh' }), GRANT)
})

test('7.2 · 拒绝 → rejected', async () => {
  const d = createApprovalDecider({ askUser: async () => 'deny', logger: quiet })
  assert.equal(await d.decide({ toolName: 'pwsh' }), REJECT)
})

test('7.2 · 用户不答 / 超时 → cancelled（不是 rejected，语义不同）', async () => {
  const d = createApprovalDecider({
    askUser: () => new Promise(() => {}), // 永不 resolve
    timeoutMs: 20,
    logger: quiet,
  })
  assert.equal(await d.decide({ toolName: 'x' }), CANCELLED)
})

test('7.2 · signal 已 abort → cancelled，且**不打扰用户**', async () => {
  let asked = false
  const d = createApprovalDecider({ askUser: async () => { asked = true; return 'allow' }, logger: quiet })
  const r = await d.decide({ signal: { aborted: true } })
  assert.equal(r, CANCELLED)
  assert.equal(asked, false, '已取消的请求不该再弹窗问用户')
})

test('7.2 · signal 中途 abort → cancelled（不等满超时）', async () => {
  const listeners = []
  const signal = {
    aborted: false,
    addEventListener: (t, fn) => listeners.push(fn),
    removeEventListener: () => {},
  }
  const d = createApprovalDecider({
    askUser: () => new Promise(() => {}),
    timeoutMs: 10_000,
    logger: quiet,
  })
  const p = d.decide({ signal })
  // 模拟 DSH 取消
  setTimeout(() => { for (const fn of listeners) fn() }, 5)
  assert.equal(await p, CANCELLED)
})

test('7.2 · ★ 询问层抛异常 → cancelled（fail-closed，绝不放行）', async () => {
  const d = createApprovalDecider({
    askUser: async () => { throw new Error('pet gone') },
    logger: quiet,
  })
  const r = await d.decide({ toolName: 'x' })
  assert.equal(r, CANCELLED)
  assert.notEqual(r, GRANT, '异常绝不能变成允许')
})

test('7.2 · 询问层返回非法值 → unavailable（与源码 :176 规范化一致）', async () => {
  for (const v of ['maybe', 42, {}, 'ALLOWED', 'yes-please']) {
    const d = createApprovalDecider({ askUser: async () => v, logger: quiet })
    assert.equal(await d.decide({}), UNAVAILABLE, `${JSON.stringify(v)} 应被规范化`)
  }
})

test('7.2 · normalize 宽松别名映射到协议枚举', () => {
  const d = createApprovalDecider({ askUser: async () => null, logger: quiet })
  assert.equal(d.normalize(true), GRANT)
  assert.equal(d.normalize('allow'), GRANT)
  assert.equal(d.normalize('yes'), GRANT)
  assert.equal(d.normalize(false), REJECT)
  assert.equal(d.normalize('no'), REJECT)
  assert.equal(d.normalize(null), CANCELLED)
  assert.equal(d.normalize(undefined), CANCELLED)
  assert.equal(d.normalize('cancel'), CANCELLED)
  assert.equal(d.normalize('weird'), UNAVAILABLE)
})

test('7.2 · ★ 任何路径的返回值都落在 OUTCOMES 内（否则被 :176 吃掉）', async () => {
  const inputs = ['allow', 'deny', 'cancel', 'garbage', null, undefined, 1, {}, []]
  for (const i of inputs) {
    const d = createApprovalDecider({ askUser: async () => i, logger: quiet })
    const r = await d.decide({})
    assert.ok(OUTCOMES.includes(r), `${JSON.stringify(i)} → ${r} 不在枚举内`)
  }
})

test('7.2 · diagnostics 统计各 outcome', async () => {
  let n = 0
  const d = createApprovalDecider({
    askUser: async () => (++n === 1 ? 'allow' : 'deny'),
    logger: quiet,
  })
  await d.decide({})
  await d.decide({})
  const diag = d.diagnostics()
  assert.equal(diag.asked, 2)
  assert.equal(diag.allowed, 1)
  assert.equal(diag.rejected, 1)
})

test('7.2 · describeApproval 只取短字段（不外发 req 原文）', () => {
  const d = describeApproval({
    toolName: 'pwsh',
    reason: '要执行命令',
    callId: 'c1',
    agent: { secret: 'x' },
    env: { TOKEN: 'secret' },
  })
  assert.equal(d.kind, 'approval')
  assert.equal(d.tool, 'pwsh')
  assert.equal(d.reason, '要执行命令')
  assert.equal(d.call_id, 'c1')
  assert.equal(d.agent, undefined, '不得外发 agent 对象')
  assert.equal(d.env, undefined, '不得外发 env')
})

test('7.2 · describeApproval 对畸形输入不抛', () => {
  for (const bad of [null, undefined, 42, 'x', {}]) {
    assert.doesNotThrow(() => describeApproval(bad))
  }
  assert.equal(describeApproval(null).kind, 'approval')
})

test('7.2 · raceTimeout：正常 resolve / 超时 / reject 三条路径', async () => {
  assert.equal(await raceTimeout(Promise.resolve('v'), 100), 'v')
  assert.equal(await raceTimeout(new Promise(() => {}), 10), null)
  await assert.rejects(() => raceTimeout(Promise.reject(new Error('e')), 100))
})

// ═════════════════════════════════════════════════════════════════════════════
// 7.3 提问
// ═════════════════════════════════════════════════════════════════════════════

test('7.3 · validateAnswers：合法批次通过', () => {
  const qs = [{ id: 'q1' }, { id: 'q2' }]
  const as = [{ id: 'q1', selected: ['a'] }, { id: 'q2', selected: ['b'], custom: 'x' }]
  assert.equal(validateAnswers(qs, as).ok, true)
})

test('7.3 · ★ validateAnswers：必须恰好命名每个问题一次（源码 :560 的核心校验）', () => {
  const qs = [{ id: 'q1' }, { id: 'q2' }]
  // 少答一个
  assert.equal(validateAnswers(qs, [{ id: 'q1', selected: [] }]).ok, false)
  // 多答一个
  assert.equal(validateAnswers(qs, [
    { id: 'q1', selected: [] }, { id: 'q2', selected: [] }, { id: 'q3', selected: [] },
  ]).ok, false)
  // 重复 id
  assert.equal(validateAnswers(qs, [
    { id: 'q1', selected: [] }, { id: 'q1', selected: [] },
  ]).ok, false)
  // 命名了不存在的问题
  assert.equal(validateAnswers(qs, [
    { id: 'q1', selected: [] }, { id: 'qX', selected: [] },
  ]).ok, false)
})

test('7.3 · validateAnswers：selected 必须是字符串数组；custom 必须是字符串', () => {
  const qs = [{ id: 'q1' }]
  assert.equal(validateAnswers(qs, [{ id: 'q1', selected: 'a' }]).ok, false)
  assert.equal(validateAnswers(qs, [{ id: 'q1', selected: [1] }]).ok, false)
  assert.equal(validateAnswers(qs, [{ id: 'q1', selected: [], custom: 5 }]).ok, false)
  assert.equal(validateAnswers(qs, [{ id: 'q1', selected: [] }]).ok, true)
})

test('7.3 · 合法答案提交给服务并返回 ok', () => {
  const calls = []
  const svc = { answer: (a, c, ans) => { calls.push({ a, c, ans }); return true } }
  const q = createQuestionAnswerer({ service: svc, logger: quiet })
  const r = q.answer({ id: 'agent1' }, 'call1', [{ id: 'q1' }], [{ id: 'q1', selected: ['opt'] }])
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].c, 'call1')
  assert.deepEqual(calls[0].ans, { answers: [{ id: 'q1', selected: ['opt'] }] })
})

test('7.3 · ★ 非法批次不提交给服务（本地预校验挡住 BAD_ANSWER）', () => {
  let called = false
  const svc = { answer: () => { called = true; return true } }
  const q = createQuestionAnswerer({ service: svc, logger: quiet })
  const r = q.answer({}, 'c1', [{ id: 'q1' }, { id: 'q2' }], [{ id: 'q1', selected: [] }])
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-answer')
  assert.equal(called, false, '非法批次不该打到服务')
})

test('7.3 · 服务返回 false → not-continued（问题已 settle，源码 :555）', () => {
  const q = createQuestionAnswerer({ service: { answer: () => false }, logger: quiet })
  const r = q.answer({}, 'c1', [{ id: 'q1' }], [{ id: 'q1', selected: [] }])
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-continued')
})

test('7.3 · 服务抛错 → 捕获为 service-error（不穿透）', () => {
  const err = new Error('a reply is already queued')
  err.code = 'REPLY_QUEUED'
  const q = createQuestionAnswerer({ service: { answer: () => { throw err } }, logger: quiet })
  const r = q.answer({}, 'c1', [{ id: 'q1' }], [{ id: 'q1', selected: [] }])
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'service-error')
  assert.equal(r.code, 'REPLY_QUEUED')
})

test('7.3 · 服务缺失 → service-unavailable（较老 dsh 上不炸）', () => {
  const q = createQuestionAnswerer({ logger: quiet })
  assert.equal(q.answer({}, 'c1', [{ id: 'q1' }], [{ id: 'q1', selected: [] }]).reason, 'service-unavailable')
})

test('7.3 · pendingQuestions 抽出 continued/open 的问题', () => {
  const view = {
    questions: {
      active: [
        { callId: 'c1', state: 'continued', questions: [{ id: 'q1', question: '选哪个？' }] },
        { callId: 'c2', state: 'open', questions: [{ id: 'q2' }] },
        { callId: 'c3', state: 'settled', questions: [{ id: 'q3' }] },
      ],
      settled: [],
    },
  }
  const p = pendingQuestions(view)
  assert.equal(p.length, 2)
  assert.deepEqual(p.map((x) => x.callId), ['c1', 'c2'])
})

test('7.3 · ★ pendingQuestions 对 undefined/null 兜底（stateOf 对未注册 key 返回 undefined）', () => {
  for (const bad of [undefined, null, {}, { questions: null }, { questions: {} }, 'x', 42]) {
    assert.deepEqual(pendingQuestions(bad), [])
  }
})

test('7.3 · describeQuestions 归一 options 的两种形状', () => {
  const d = describeQuestions({
    callId: 'c1',
    questions: [{
      id: 'q1', header: '确认', question: '要哪个？', multiSelect: true,
      options: ['a', { value: 'b', label: '选项B' }],
    }],
  })
  assert.equal(d.call_id, 'c1')
  assert.equal(d.items.length, 1)
  assert.deepEqual(d.items[0].options, [
    { value: 'a', label: 'a' },
    { value: 'b', label: '选项B' },
  ])
  assert.equal(d.items[0].multi, true)
  assert.equal(d.items[0].header, '确认')
})

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
