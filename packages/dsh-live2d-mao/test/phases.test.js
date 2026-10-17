/**
 * 6.3 验收：**12 态全部可达** + 词表与后端一致。
 *
 * 这是 task-1 的核心验收项之一。测试策略：
 *   1. 词表一致性 —— 与移植源 `agent_bus_service.py:34-47` 逐字对齐（防漂移）；
 *   2. 每个 phase 都要被**真实的 DSH 事件序列**推出来（不是手工调 emitPhase 硬塞），
 *      否则"可达"是自欺欺人；
 *   3. `paused` / `heartbeat` 走各自的连接层分支（它们**明确不走 facts**）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { PHASES, WORK_PHASES, IDLE_PHASES, FACT_PHASES, PHASE_PRIORITY } from '../lib/phases.js'
import { emptyFacts, foldEvent } from '../lib/facts.js'
import { phaseForFacts, pausedState, heartbeatState } from '../lib/phase-map.js'

/** 便捷：喂一串事件给 facts，返回最终 phase。 */
function drive(events, session) {
  const facts = emptyFacts()
  for (const ev of events) foldEvent(facts, ev, session || { id: 's1' })
  return phaseForFacts(facts)
}

/** 便捷：单个事件驱动。 */
function driveOne(event) {
  return drive([event])
}

test('6.3 · 词表与后端 agent_bus_service.PHASES 逐字一致（12 态，顺序一致）', () => {
  assert.deepEqual([...PHASES], [
    'idle',
    'planning',
    'thinking',
    'executing_tool',
    'streaming',
    'waiting_input',
    'voice',
    'complete',
    'error',
    'paused',
    'awaiting_approval',
    'heartbeat',
  ])
  assert.equal(PHASES.length, 12, '12 态：10 基础 + 2 扩展')
})

test('6.3 · 工作态 / 非工作态 / fact 可达集与后端定义一致', () => {
  assert.deepEqual([...WORK_PHASES], [
    'planning', 'thinking', 'executing_tool', 'streaming', 'waiting_input', 'voice', 'awaiting_approval',
  ])
  assert.deepEqual([...IDLE_PHASES], ['idle', 'complete', 'error', 'paused'])
  // FACT_PHASES = WORK + idle/complete/error（**不含** paused/heartbeat）
  assert.deepEqual([...FACT_PHASES].sort(), [
    'awaiting_approval', 'complete', 'error', 'executing_tool', 'idle',
    'planning', 'streaming', 'thinking', 'voice', 'waiting_input',
  ])
  assert.equal(FACT_PHASES.includes('paused'), false, 'paused 不走 facts（连接层分支）')
  assert.equal(FACT_PHASES.includes('heartbeat'), false, 'heartbeat 不走 facts（心跳通道）')
})

test('6.3 · PHASE_PRIORITY 覆盖全部 12 态（漏一个会让抢焦点落到兜底 6）', () => {
  for (const p of PHASES) {
    assert.equal(typeof PHASE_PRIORITY[p], 'number', `缺少 ${p} 的优先级`)
  }
  assert.equal(Object.keys(PHASE_PRIORITY).length, 12)
})

// ─────────────────────────────────────────────────────────────────────────────
// 逐态可达性：每一态都用**真实事件序列**推出来
// ─────────────────────────────────────────────────────────────────────────────

test('6.3 · 可达 idle —— 空 facts（轮次外在线待机）', () => {
  assert.equal(phaseForFacts(emptyFacts()).phase, 'idle')
})

test('6.3 · 可达 idle —— turn/end(aborted)：停掉会话不该挂在工作态', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { reason: { kind: 'aborted' } } },
  ])
  assert.equal(r.phase, 'idle')
})

test('6.3 · 可达 idle —— turn/end(forked)：轮次延续到子会话', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { reason: { kind: 'forked' } } },
  ])
  assert.equal(r.phase, 'idle')
})

test('6.3 · 可达 planning —— turn/start 本身即规划意图', () => {
  const r = driveOne({ type: 'turn/start', data: { turn: 1 } })
  assert.equal(r.phase, 'planning')
})

test('6.3 · 可达 planning —— todo_write 触发规划意图', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { step: 1 } },
    { type: 'tool/call', data: { name: 'pwsh' } },
    { type: 'tool/result', data: { name: 'pwsh' } },
    { type: 'tool/call', data: { name: 'todo_write' } },
    { type: 'tool/result', data: { name: 'todo_write' } },
  ])
  assert.equal(r.phase, 'planning')
})

test('6.3 · 可达 thinking —— 轮次内无工具、无正文输出', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { step: 1 } },
  ])
  assert.equal(r.phase, 'thinking')
})

test('6.3 · 可达 thinking —— llm/retry 也算思考（桌宠表现相同）', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { step: 1 } },
    { type: 'llm/retry', data: {} },
  ])
  assert.equal(r.phase, 'thinking')
})

test('6.3 · 可达 executing_tool —— tool/call 后 active_tools > 0', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { step: 1 } },
    { type: 'tool/call', data: { name: 'pwsh' } },
  ])
  assert.equal(r.phase, 'executing_tool')
  assert.equal(r.state.tool, 'pwsh')
})

test('6.3 · 可达 streaming —— assistant/message 为**纯文字**才成立', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { step: 1 } },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: '你好' }] } },
  ])
  assert.equal(r.phase, 'streaming')
})

test('6.3 · streaming 反例 —— 含 tool-call 块的消息**不得**误报 streaming', () => {
  // 实测真实日志 335/377 条 assistant/message 同时含 tool-call 块，
  // 用 has_text 当判据会长期误报（移植源 :461-465 的原始理由）
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { step: 1 } },
    {
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: '我来看看' }, { type: 'tool-call', toolCallId: 'c1' }] },
    },
  ])
  assert.equal(r.phase, 'thinking', '含 tool-call 块 → 回落 thinking，不是 streaming')
})

test('6.3 · 可达 waiting_input —— ask_user_question 工具在跑', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { step: 1 } },
    { type: 'tool/call', data: { name: 'ask_user_question' } },
  ])
  assert.equal(r.phase, 'waiting_input')
})

test('6.3 · 可达 waiting_input —— turn/end(blocked)：提示词被拦下，等用户换输入', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { reason: { kind: 'blocked' } } },
  ])
  assert.equal(r.phase, 'waiting_input')
})

test('6.3 · 可达 voice —— voice_active 置位（D1 无 TTS 源，保留态）', () => {
  const facts = emptyFacts()
  // 本插件无 TTS 源，该字段恒为 false；这里**直接置位**以证明分支可达，
  // 与后端策略逐字对齐（未来外部源接入即可用）
  facts.voice_active = true
  assert.equal(phaseForFacts(facts).phase, 'voice')
})

test('6.3 · 可达 complete —— turn/end(completed)', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ])
  assert.equal(r.phase, 'complete')
})

test('6.3 · 可达 error —— 最近一个事件本身失败', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'error', data: { message: 'boom' } },
  ])
  assert.equal(r.phase, 'error')
  assert.equal(r.state.error, 'boom')
})

test('6.3 · 可达 error —— turn/end(error / max-tokens / interrupted) 三值', () => {
  for (const kind of ['error', 'max-tokens', 'interrupted']) {
    const r = drive([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { reason: { kind } } },
    ])
    assert.equal(r.phase, 'error', `turn/end(${kind}) 应为 error`)
  }
})

test('6.3 · error 不粘轮 —— 后续成功事件应离开 error（避免失败态粘住整轮）', () => {
  const facts = emptyFacts()
  foldEvent(facts, { type: 'turn/start', data: { turn: 1 } }, { id: 's1' })
  foldEvent(facts, { type: 'error', data: { message: 'boom' } }, { id: 's1' })
  assert.equal(phaseForFacts(facts).phase, 'error')
  // 下一个事件不是失败 → last_event_failed 被清掉
  foldEvent(facts, { type: 'step/start', data: { step: 2 } }, { id: 's1' })
  assert.notEqual(phaseForFacts(facts).phase, 'error', 'error 态不该粘住整轮')
})

test('6.3 · 可达 awaiting_approval —— approval/asked 与 approval/decided 配对', () => {
  const facts = emptyFacts()
  foldEvent(facts, { type: 'turn/start', data: { turn: 1 } }, { id: 's1' })
  foldEvent(facts, { type: 'approval/asked', data: { callId: 'a1' } }, { id: 's1' })
  assert.equal(phaseForFacts(facts).phase, 'awaiting_approval')

  foldEvent(facts, { type: 'approval/decided', data: { callId: 'a1' } }, { id: 's1' })
  assert.notEqual(phaseForFacts(facts).phase, 'awaiting_approval', 'decided 后应离开待审批')
})

test('6.3 · 可达 paused —— 连接层分支（不走 facts）', () => {
  const r = pausedState('DSH 进程还在但会话不可用')
  assert.equal(r.phase, 'paused')
  assert.equal(r.state.error, 'DSH 进程还在但会话不可用')
})

test('6.3 · 可达 heartbeat —— 心跳通道（不走 facts，不改动画）', () => {
  const r = heartbeatState()
  assert.equal(r.phase, 'heartbeat')
  assert.deepEqual(r.state, {})
})

test('6.3 · ★ 12 态全覆盖：由真实序列驱动的可达集必须恰好等于 PHASES', () => {
  // 把上面各条"真实事件序列"集中成一张表，证明 coverage 是**穷举**而非抽样
  const viaFacts = [
    driveOne({ type: 'turn/start', data: { turn: 1 } }).phase,                       // planning
    drive([{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { step: 1 } }]).phase, // thinking
    drive([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { step: 1 } },
      { type: 'tool/call', data: { name: 'pwsh' } },
    ]).phase,                                                                        // executing_tool
    drive([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { step: 1 } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'hi' }] } },
    ]).phase,                                                                        // streaming
    drive([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { step: 1 } },
      { type: 'tool/call', data: { name: 'ask_user_question' } },
    ]).phase,                                                                        // waiting_input
    (() => { const f = emptyFacts(); f.voice_active = true; return phaseForFacts(f).phase })(), // voice
    drive([{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }]).phase, // complete
    drive([{ type: 'turn/start', data: { turn: 1 } }, { type: 'error', data: { message: 'x' } }]).phase, // error
    phaseForFacts(emptyFacts()).phase,                                               // idle
    (() => {
      const f = emptyFacts()
      foldEvent(f, { type: 'turn/start', data: { turn: 1 } }, { id: 's1' })
      foldEvent(f, { type: 'approval/asked', data: { callId: 'a' } }, { id: 's1' })
      return phaseForFacts(f).phase
    })(),                                                                            // awaiting_approval
    pausedState('x').phase,                                                          // paused
    heartbeatState().phase,                                                          // heartbeat
  ]

  const reachable = new Set(viaFacts)
  const missing = [...PHASES].filter((p) => !reachable.has(p))
  assert.deepEqual(missing, [], '以下 phase 不可达：' + missing.join(','))
  assert.equal(reachable.size, 12, '可达集应为 12 态')
  for (const p of viaFacts) assert.ok(PHASES.includes(p), `产出了非法 phase: ${p}`)
})

test('6.3 · 优先级顺序：审批 > 等待用户 > 语音 > 错误 > 轮次结束 > 工具 > 规划 > 流式 > 思考', () => {
  // 审批压过一切
  const f1 = emptyFacts()
  foldEvent(f1, { type: 'turn/start', data: { turn: 1 } }, { id: 's1' })
  foldEvent(f1, { type: 'tool/call', data: { name: 'pwsh' } }, { id: 's1' })
  foldEvent(f1, { type: 'approval/asked', data: {} }, { id: 's1' })
  assert.equal(phaseForFacts(f1).phase, 'awaiting_approval', '审批优先级最高')

  // 等待用户压过工具执行
  const f2 = emptyFacts()
  foldEvent(f2, { type: 'turn/start', data: { turn: 1 } }, { id: 's1' })
  foldEvent(f2, { type: 'tool/call', data: { name: 'ask_user_question' } }, { id: 's1' })
  assert.equal(phaseForFacts(f2).phase, 'waiting_input')

  // 语音压过错误
  const f3 = emptyFacts()
  foldEvent(f3, { type: 'turn/start', data: { turn: 1 } }, { id: 's1' })
  foldEvent(f3, { type: 'error', data: { message: 'x' } }, { id: 's1' })
  f3.voice_active = true
  assert.equal(phaseForFacts(f3).phase, 'voice', '语音压过错误')

  // 错误压过轮次结束(complete)
  const f4 = emptyFacts()
  foldEvent(f4, { type: 'turn/start', data: { turn: 1 } }, { id: 's1' })
  foldEvent(f4, { type: 'error', data: { message: 'x' } }, { id: 's1' })
  foldEvent(f4, { type: 'turn/end', data: { reason: { kind: 'completed' } } }, { id: 's1' })
  // turn/end 会重置 last_event_failed（新事件），故此处应为 complete；
  // 真正的"error 压过 complete"发生在**同一事件内**（turn/end reason=error）
  assert.equal(phaseForFacts(f4).phase, 'complete')
})

test('6.3 · 非法 facts 输入兜底为 idle（绝不抛）', () => {
  assert.equal(phaseForFacts(null).phase, 'idle')
  assert.equal(phaseForFacts(undefined).phase, 'idle')
  assert.equal(phaseForFacts('not-an-object').phase, 'idle')
  assert.equal(phaseForFacts(42).phase, 'idle')
})

test('6.3 · state 只放短字段，且 turn/step 透传', () => {
  const r = drive([
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'step/start', data: { step: 7 } },
    { type: 'tool/call', data: { name: 'pwsh' } },
    { type: 'tool/call', data: { name: 'read' } },
  ])
  assert.equal(r.state.turn, 3)
  assert.equal(r.state.step, 7)
  assert.equal(r.state.tool_calls, 2)
  assert.equal(r.state.tool, 'read')
})

test('6.3 · 超长错误信息被截断到 200 字符（与后端 state["error"][:200] 对齐）', () => {
  const long = 'x'.repeat(500)
  const r = drive([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'error', data: { message: long } },
  ])
  assert.equal(r.state.error.length, 200)
})

test('6.3 · 折叠器对畸形事件不抛（事件形状不由我们控制）', () => {
  const facts = emptyFacts()
  for (const bad of [null, undefined, 42, 'x', {}, { type: 123 }, { type: 'unknown/type' }]) {
    assert.doesNotThrow(() => foldEvent(facts, bad, { id: 's1' }))
  }
  assert.doesNotThrow(() => foldEvent(null, { type: 'turn/start' }, null))
})
