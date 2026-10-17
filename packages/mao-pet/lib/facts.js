/**
 * facts 折叠器：把 DSH 的**流式事件序列**折叠成一份"当前客观事实"快照。
 *
 * 为什么要折叠而不是单事件直接映射（移植源 `dsh_adapter.py:479-488` 的同一理由）：
 * 单事件无法表达「审批是否已结束」「工具是否还在跑」这类**跨事件聚合语义**——
 * `tool/call` 说"开始跑工具"，`tool/result` 说"跑完了"，只看后者的 phase 是错的。
 * 所以实时链路一律走 facts 折叠，再由 `phase_for_facts` 做纯函数映射。
 *
 * 只读、无副作用、不依赖 Cordis —— 便于单测直接喂事件序列（这是 12 态可达性
 * 能被单元测试穷举覆盖的前提）。
 */

import { clampError, clampStr } from './util.js'

/** 新建一份空 facts。字段名刻意与后端 `dsh_adapter.py` 的 facts 保持一致。 */
export function emptyFacts() {
  return {
    // 轮次
    in_turn: false,
    turn: null,
    turn_end_reason: '',
    step: null,
    // 工具
    tool_calls: 0,
    active_tools: 0,
    last_tool: '',
    last_event: '',
    last_event_failed: false,
    // 规划
    plan_intent: false,
    goal_operation: '',
    todo_count: 0,
    // 用户交互
    approvals_pending: 0,
    awaiting_user: false,
    // 语音（D1：无 TTS 依赖，本字段恒为 false —— 保留位，供未来外部源置位）
    voice_active: false,
    // 其它
    retrying: false,
    errored: false,
    last_error: '',
    // 流式正文判据：最近一条 assistant/message 是否**纯文字**（无 tool-call 块）
    last_message_text_only: false,
    // ★ 最近一条 assistant 纯文本（供多会话气泡栈投递"最近一句话"，截断防超长）
    last_message_text: '',
    // 会话
    session_id: '',
  }
}

/** DSH 事件类型常量（勿硬编码字符串到各处，便于对照源码）。 */
export const EVENT = Object.freeze({
  TURN_START: 'turn/start',
  TURN_END: 'turn/end',
  STEP_START: 'step/start',
  STEP_END: 'step/end',
  TOOL_CALL: 'tool/call',
  TOOL_RESULT: 'tool/result',
  ASSISTANT_MESSAGE: 'assistant/message',
  USER_MESSAGE: 'user/message',
  APPROVAL_ASKED: 'approval/asked',
  APPROVAL_DECIDED: 'approval/decided',
  LLM_RETRY: 'llm/retry',
  LLM_RETRY_STARTED: 'llm/retry-started',
  ERROR: 'error',
})

/** 规划类工具名：调用它们 = "正在梳理要做什么"，与"正在推理怎么做"不同表现。 */
const PLAN_TOOLS = new Set(['todo_write', 'create_goal', 'update_goal'])

/** 等待用户输入的语义工具（DSH 真实存在的 `ask_user_question`）。 */
const ASK_TOOLS = new Set(['ask_user_question'])

/**
 * 从事件对象里安全地取 payload。
 * DSH 事件的形状是 `{ type, data }`（数据在 `data` 里，不是顶层）。
 */
function payloadOf(event) {
  const data = event && event.data
  return data && typeof data === 'object' ? data : {}
}

/** turn/end 的 reason 既可能是字符串也可能是 `{kind}` 对象 —— 两种都归一。 */
function turnEndKind(payload) {
  const reason = payload && payload.reason
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object') return String(reason.kind || '')
  return ''
}

/**
 * 折叠单个事件到 facts（**原地修改** facts，调用方负责持有它）。
 *
 * 返回值：本次事件后 facts 是否发生了"对 phase 有影响"的变化。
 * 用于跳过无意义的重复上报。
 *
 * @param {object} facts   `emptyFacts()` 产出的可变对象
 * @param {object} event   DSH session 事件 `{type, data}`
 * @param {object} [session] DSH session 对象（取 id 用）
 * @returns {{changed: boolean, type: string}}
 */
export function foldEvent(facts, event, session) {
  if (!facts || typeof facts !== 'object') return { changed: false, type: '' }
  if (!event || typeof event !== 'object') return { changed: false, type: '' }

  const type = String(event.type || '')
  const payload = payloadOf(event)
  const before = facts.last_event
  const beforePhaseish = phaseSignature(facts)

  if (session && session.id) facts.session_id = String(session.id)
  facts.last_event = type
  // 每条新事件默认清掉"上一个事件失败"的粘性标记，避免 error 态粘住整轮
  // （移植 `dsh_adapter.py:435-437` 的同一取舍：仅"最近一个事件本身是失败"才 error）。
  facts.last_event_failed = false

  switch (type) {
    case EVENT.TURN_START: {
      facts.in_turn = true
      facts.turn = payload.turn ?? facts.turn
      facts.turn_end_reason = ''
      facts.step = null
      facts.tool_calls = 0
      facts.active_tools = 0
      facts.last_tool = ''
      facts.errored = false
      facts.last_error = ''
      facts.approvals_pending = 0
      facts.awaiting_user = false
      facts.retrying = false
      // 轮次开始本身就是"规划意图"（要开始梳理做什么了）
      facts.plan_intent = true
      break
    }

    case EVENT.TURN_END: {
      facts.in_turn = false
      facts.turn_end_reason = turnEndKind(payload)
      // 轮次结束后工具不可能还在跑，否则 active_tools 会跨轮泄漏
      facts.active_tools = 0
      facts.awaiting_user = false
      facts.approvals_pending = 0
      facts.plan_intent = false
      facts.retrying = false
      if (facts.turn_end_reason === 'error') {
        facts.errored = true
        facts.last_error = clampError(payload.error || payload.message || '')
      }
      break
    }

    case EVENT.STEP_START:
    case EVENT.STEP_END: {
      facts.step = payload.step ?? payload.index ?? facts.step
      if (type === EVENT.STEP_START) {
        // 新 step 开始 → 上一 step 的规划意图不再成立
        facts.plan_intent = false
      }
      break
    }

    case EVENT.TOOL_CALL: {
      const name = clampStr(payload.name || payload.toolName || '', 60)
      facts.tool_calls = (Number(facts.tool_calls) || 0) + 1
      facts.active_tools = (Number(facts.active_tools) || 0) + 1
      if (name) facts.last_tool = name
      if (name && PLAN_TOOLS.has(name)) facts.plan_intent = true
      if (name && ASK_TOOLS.has(name)) facts.awaiting_user = true
      if (payload.goalOperation || payload.operation) {
        facts.goal_operation = clampStr(payload.goalOperation || payload.operation, 40)
        facts.plan_intent = true
      }
      break
    }

    case EVENT.TOOL_RESULT: {
      // 工具返回 → 该工具不再 active；工具失败也不直接进 error
      // （DSH 里工具失败常常是同轮内可自愈的，进 error 会让桌宠频繁闪红）
      facts.active_tools = Math.max(0, (Number(facts.active_tools) || 0) - 1)
      const name = clampStr(payload.name || payload.toolName || '', 60)
      if (name) facts.last_tool = name
      if (name && ASK_TOOLS.has(name)) facts.awaiting_user = false
      // ★ 注意：`plan_intent` **不在工具返回时清除**。
      // 规划意图表达的是"这一轮正在梳理要做什么"（turn-scoped），不是"这个工具还在跑"
      // （call-scoped）。若在 todo_write 返回时就清掉，planning 态只会闪现一瞬，
      // 桌宠看到的是"规划了一下立刻变回思考"——这正是本用例抓到的 bug。
      // 清它的正确时机只有两处：新 step 开始（重新进入推理）、轮次结束。
      if (payload.failed || payload.isError || payload.error) {
        facts.errored = true
        facts.last_error = clampError(payload.error || payload.message || '')
      }
      break
    }

    case EVENT.ASSISTANT_MESSAGE: {
      // ★ 判据是"纯文字"而不是"has_text"：实测真实日志 335/377 条
      // assistant/message 同时含 tool-call 块，用 has_text 会长期误报 streaming
      // （移植 `dsh_adapter.py:461-465`）。
      facts.last_message_text_only = isTextOnlyMessage(payload)
      // ★ 保存最近一条纯文本（供气泡栈/审批/提问展示"最近一句话"），
      //   截断 400 字（与 bubble-stack 的 400 上限一致，防超长外泄）。
      facts.last_message_text = facts.last_message_text_only
        ? clampStr(extractText(payload), 400)
        : ''
      facts.retrying = false
      break
    }

    case EVENT.USER_MESSAGE: {
      facts.awaiting_user = false
      facts.last_message_text_only = false
      break
    }

    case EVENT.APPROVAL_ASKED: {
      facts.approvals_pending = (Number(facts.approvals_pending) || 0) + 1
      break
    }

    case EVENT.APPROVAL_DECIDED: {
      facts.approvals_pending = Math.max(0, (Number(facts.approvals_pending) || 0) - 1)
      break
    }

    case EVENT.LLM_RETRY:
    case EVENT.LLM_RETRY_STARTED: {
      facts.retrying = true
      break
    }

    case EVENT.ERROR: {
      facts.errored = true
      facts.last_event_failed = true
      facts.last_error = clampError(payload.message || payload.error || '')
      break
    }

    default:
      break
  }

  const changed = before !== facts.last_event || beforePhaseish !== phaseSignature(facts)
  return { changed, type }
}

/**
 * 从 assistant/message payload 里提取纯文本（拼接所有 text 块）。
 *
 * 容错三种真实形状（与 isTextOnlyMessage 一致）：`content:[{type:'text'}]`、
 * `blocks:[{type:'text'}]`、以及只有 `text` 字符串的退化形状。
 */
export function extractText(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const blocks = Array.isArray(payload.content)
    ? payload.content
    : Array.isArray(payload.blocks)
      ? payload.blocks
      : null
  if (blocks) {
    const parts = []
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if ((b.type === 'text' || b.type === 'text-delta') && String(b.text || '')) {
        parts.push(String(b.text))
      }
    }
    return parts.join('')
  }
  return typeof payload.text === 'string' ? payload.text : ''
}

/**
 * 一条 assistant/message 是否"纯文字"（没有任何 tool-call 块）。
 *
 * 容错三种真实形状：`content:[{type:'text'|'tool-call'}]`、`blocks:[...]`、
 * 以及只有 `text` 字符串的退化形状。
 */
export function isTextOnlyMessage(payload) {
  if (!payload || typeof payload !== 'object') return false
  const blocks = Array.isArray(payload.content)
    ? payload.content
    : Array.isArray(payload.blocks)
      ? payload.blocks
      : null
  if (blocks) {
    const hasToolCall = blocks.some((b) => b && typeof b === 'object'
      && (b.type === 'tool-call' || b.type === 'tool_use' || b.toolCallId))
    if (hasToolCall) return false
    const hasText = blocks.some((b) => b && typeof b === 'object'
      && (b.type === 'text' || b.type === 'text-delta') && String(b.text || '').length > 0)
    return hasText
  }
  // 退化形状：没有块结构时，有非空 text 就当纯文字
  return typeof payload.text === 'string' && payload.text.trim().length > 0
}

/**
 * 相位相关字段的签名：用来判断"这次折叠有没有改变 phase 语义"。
 * 只包含**参与 phase 判定**的字段（不含 last_event / 计数噪声），
 * 否则每次事件都会误判为"变了"。
 */
function phaseSignature(facts) {
  return [
    facts.in_turn,
    facts.turn_end_reason,
    facts.approvals_pending,
    facts.awaiting_user,
    facts.voice_active,
    facts.last_event_failed,
    facts.active_tools,
    facts.plan_intent,
    facts.last_message_text_only,
  ].join('|')
}
