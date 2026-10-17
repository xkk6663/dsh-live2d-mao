/**
 * facts → phase（策略层）—— 逐分支移植
 * `私人AI日记系统/backend/app/agents/dsh/dsh_adapter.py:386-471`
 *
 * 本文件是**纯函数**，不碰 ctx、不碰网络、不看时钟 —— 这是 12 态可达性
 * 能用单测穷举覆盖的前提，也是 M7 复用它的基础。
 *
 * 判定顺序即优先级（移植源注释原文）：
 *     审批 > 等待用户 > 语音 > 错误 > 轮次结束 > 轮次内工作态 > 待机
 */

import { clampError, clampStr, toInt } from './util.js'

/**
 * 把 facts 折叠出的客观事实映射为 `{ phase, state }`。
 *
 * `state` 是**透传给桌宠的短上下文**（工具名、错误信息等）。刻意只放短字段：
 * 它会被塞进 WS 广播并驱动渲染端，放大对象等于放大广播体积。
 *
 * @param {object} facts `facts.js` 产出的 facts 快照
 * @returns {{phase: string, state: object}}
 */
export function phaseForFacts(facts) {
  if (!facts || typeof facts !== 'object') return { phase: 'idle', state: {} }

  const state = {}
  const tool = clampStr(facts.last_tool || '', 60)
  if (tool) state.tool = tool
  if (toInt(facts.tool_calls)) state.tool_calls = toInt(facts.tool_calls)
  if (facts.turn !== null && facts.turn !== undefined) state.turn = facts.turn
  if (facts.step !== null && facts.step !== undefined) state.step = facts.step
  if (toInt(facts.todo_count)) state.todos = toInt(facts.todo_count)
  const goalOp = clampStr(facts.goal_operation || '', 40)
  if (goalOp) state.goal = goalOp
  const err = clampError(facts.last_error || '', 200)
  if (err) state.error = err

  const inTurn = Boolean(facts.in_turn)
  const turnReason = String(facts.turn_end_reason || '')

  // 1) 等待审批（桌宠表现：待确认）
  if (toInt(facts.approvals_pending) > 0) return { phase: 'awaiting_approval', state }

  // 2) 等待用户交互 —— 工具在跑但语义是"等用户"
  if (facts.awaiting_user) return { phase: 'waiting_input', state }

  // 3) 语音播报（D1：本插件无 TTS 源，故此分支恒不触发；
  //    保留它是为了与后端策略**逐字对齐**，未来外部源置位即可用）
  if (facts.voice_active) return { phase: 'voice', state }

  // 4) 错误：仅"最近一个事件本身是失败"时进入 error，避免失败态粘住整轮
  if (facts.last_event_failed) return { phase: 'error', state }
  if (turnReason === 'error' || turnReason === 'max-tokens' || turnReason === 'interrupted') {
    return { phase: 'error', state }
  }

  // 5) 轮次结束
  if (turnReason === 'completed') return { phase: 'complete', state }
  if (turnReason === 'blocked') {
    // preStep 被 hook 拒绝 → 提示词被拦下，系统在等用户换一个输入。
    // 与 DSH 官方桌宠投影一致（blocked → waiting），比归 idle 更准确。
    return { phase: 'waiting_input', state }
  }
  if (turnReason === 'aborted' || turnReason === 'forked') {
    // aborted：会话被停；forked：轮次延续到子会话。都不该让桌宠挂在工作态。
    return { phase: 'idle', state }
  }

  // 6) 轮次内工作态
  if (inTurn) {
    if (toInt(facts.active_tools) > 0) return { phase: 'executing_tool', state }
    // 规划意图（轮次开始 / todo_write / goal 变更）优先于思考：
    // 它表达的是"正在梳理要做什么"，与"正在推理怎么做"是不同的桌宠表现。
    if (facts.plan_intent) return { phase: 'planning', state }
    // 「正在输出正文」= 最近一条 assistant/message 是**纯文字**（无 tool-call）
    if (facts.last_message_text_only) return { phase: 'streaming', state }
    // retrying 与普通思考在桌宠侧表现相同（都是 thinking 动画），
    // 显式保留分支以对齐后端，但不产生第三种表现。
    if (facts.retrying) return { phase: 'thinking', state }
    return { phase: 'thinking', state }
  }

  // 7) 轮次外：在线待机
  return { phase: 'idle', state }
}

/**
 * 非 facts 来源的两个 phase（`paused` / `heartbeat`）的显式构造器。
 *
 * 为什么单独开函数：这两个态**在语义上不是"从会话事实推出来的"**
 * （见 phases.js FACT_PHASES 注释），混进 phaseForFacts 会让那个纯函数
 * 反而要承担连接层状态，破坏可测性。
 */

/** DSH 进程还在、但会话不可用（连接中断）→ paused。 */
export function pausedState(reason) {
  const state = {}
  const r = clampError(reason || '', 200)
  if (r) state.error = r
  return { phase: 'paused', state }
}

/** 存活心跳：**不改变动画**，走总线 heartbeat 通道而非 emit（见 phases.js 注释）。 */
export function heartbeatState() {
  return { phase: 'heartbeat', state: {} }
}
