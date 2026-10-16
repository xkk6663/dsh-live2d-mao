/**
 * 7.3 提问应答：`ctx.userQuestions.answer(...)`
 *
 * 源码契约（`dsh-user-questions/lib/index.js:552-588`）：
 * ```js
 * answer(agent, callId, answer) {                    // :552
 *   this.assertLiveRoot(agent)                       // :553
 *   const question = this.continued(agent).find(item => item.callId === callId)
 *   if (question === void 0) return false            // :555 ← 只对 state==='continued' 有效
 *   // :558 已排队 → 抛 REPLY_QUEUED
 *   const answered = new Set(answer.answers.map(i => i.id))
 *   if (answered.size !== answer.answers.length
 *       || question.questions.length !== answer.answers.length
 *       || !question.questions.every(i => answered.has(i.id)))
 *     throw new UserQuestionError('...must name each of its N questions exactly once', 'BAD_ANSWER')  // :560
 *   // :561-577 组装 user-question-reply 用户消息
 *   agent.steer(message)                             // :582 ← 答案作为 steer 注入 agent
 *   return true                                      // :587
 * }
 * ```
 *
 * answers 形状（`:58-66` 的 `answerSchema`）：`{ id: string, selected: string[], custom?: string }`
 *
 * 三条硬约束（都会**抛**，不是返回 false）：
 *   1. 必须**逐个命名**该 call 的**每一个问题，且恰好一次**（:560）；
 *   2. 同一 call 已有排队回复 → `REPLY_QUEUED`（:558）；
 *   3. 只对 `state === 'continued'` 的问题有效（:554-555）；否则返回 `false`。
 *
 * 观测走 projection key `"userQuestions"`（`:268-289`，wire view = `state.questions`）：
 *   `view.questions.active`  → `[{callId, questions:[{id,question,header?,options?[],multiSelect?}], state}]`
 *   `view.questions.settled` → `[{callId, answers:[...]}]`
 */

/** 校验一批答案是否满足"恰好命名每个问题一次"。 */
export function validateAnswers(questions, answers) {
  if (!Array.isArray(questions)) return { ok: false, error: 'questions-not-array' }
  if (!Array.isArray(answers)) return { ok: false, error: 'answers-not-array' }
  if (answers.length !== questions.length) {
    return { ok: false, error: 'count-mismatch', expected: questions.length, got: answers.length }
  }
  const ids = new Set()
  for (const a of answers) {
    if (!a || typeof a !== 'object') return { ok: false, error: 'answer-not-object' }
    if (typeof a.id !== 'string' || !a.id) return { ok: false, error: 'answer-id-missing' }
    if (!Array.isArray(a.selected) || a.selected.some((s) => typeof s !== 'string')) {
      return { ok: false, error: 'selected-must-be-string-array' }
    }
    if (a.custom !== undefined && typeof a.custom !== 'string') {
      return { ok: false, error: 'custom-must-be-string' }
    }
    if (ids.has(a.id)) return { ok: false, error: 'duplicate-id', id: a.id }
    ids.add(a.id)
  }
  // 每个问题都必须被命名到（这一条是 :560 的核心校验）
  for (const q of questions) {
    if (!q || typeof q !== 'object' || typeof q.id !== 'string') {
      return { ok: false, error: 'question-id-missing' }
    }
    if (!ids.has(q.id)) return { ok: false, error: 'question-not-named', id: q.id }
  }
  return { ok: true }
}

/**
 * 提问应答器。
 *
 * @param {object} opts
 * @param {object} opts.service     `ctx.userQuestions` 服务
 * @param {object} [opts.logger]
 */
export function createQuestionAnswerer(opts = {}) {
  const service = opts.service
  const logger = opts.logger || { info: () => {}, warn: () => {} }

  /**
   * 回答一个 pending 问题。
   *
   * @param {object} agent   DSH live root agent（**必须**是 live 的，否则 :553 抛）
   * @param {string} callId
   * @param {Array} questions 该 call 的问题列表（来自 projection，用于本地预校验）
   * @param {Array} answers   `[{id, selected, custom?}]`
   * @returns {{ok:boolean, reason?:string, error?:string}}
   */
  function answer(agent, callId, questions, answers) {
    if (!service || typeof service.answer !== 'function') {
      return { ok: false, reason: 'service-unavailable' }
    }
    // 本地预校验：把 BAD_ANSWER 挡在调用之前，避免让异常穿过 waterfall 边界。
    // 注意这**不替代**服务端校验（:560 仍会再校一遍），只是让失败可诊断。
    const check = validateAnswers(questions, answers)
    if (!check.ok) {
      logger.warn?.('[Mao-pet] 答案批次非法（' + check.error + '），不提交')
      return { ok: false, reason: 'bad-answer', error: check.error, detail: check }
    }

    try {
      const accepted = service.answer(agent, callId, { answers })
      if (accepted === false) {
        // :555 —— 问题已不是 continued（用户已在别处答过 / 已 settle）
        return { ok: false, reason: 'not-continued' }
      }
      return { ok: true }
    } catch (err) {
      // :558 REPLY_QUEUED / :560 BAD_ANSWER / :553 CALLER_NOT_LIVE 都走这里
      const code = (err && (err.code || err.name)) || ''
      logger.warn?.('[Mao-pet] 提交答案失败（' + code + '）：' + String(err && err.message || err))
      return { ok: false, reason: 'service-error', error: String(err && err.message || err), code: String(code) }
    }
  }

  return { answer }
}

/**
 * 从 projection 视图里抽出"等待用户回答"的问题。
 *
 * ⚠ `stateOf` 对未注册 key 返回 `undefined`（`dsh-session-projection/lib/index.js:129`），
 * 也对"尚未 materialize"的 cell 可能给空 —— **必须兜底**，别把 undefined 塞进气泡。
 *
 * @param {object} view `stateOf(session, 'userQuestions')` 的返回
 * @returns {Array} `[{callId, questions, state}]`（无则空数组）
 */
export function pendingQuestions(view) {
  const v = view && typeof view === 'object' ? view : null
  if (!v) return []
  const questions = v.questions && typeof v.questions === 'object' ? v.questions : null
  if (!questions) return []
  const active = Array.isArray(questions.active) ? questions.active : []
  return active
    .filter((q) => q && typeof q === 'object' && typeof q.callId === 'string')
    .filter((q) => q.state === 'continued' || q.state === 'open')
    .map((q) => ({
      callId: q.callId,
      state: String(q.state || ''),
      questions: Array.isArray(q.questions) ? q.questions : [],
    }))
}

/**
 * 把一个问题描述成桌宠可展示的选项（**只取短字段**）。
 * @returns {{call_id:string, items:Array<{id,header,question,options,multi}}}
 */
export function describeQuestions(entry) {
  const e = entry && typeof entry === 'object' ? entry : {}
  const items = (Array.isArray(e.questions) ? e.questions : []).map((q) => {
    const item = {
      id: String((q && q.id) || ''),
      question: String((q && q.question) || '').slice(0, 300),
    }
    const header = String((q && q.header) || '')
    if (header) item.header = header.slice(0, 80)
    if (Array.isArray(q && q.options) && q.options.length) {
      item.options = q.options.slice(0, 12).map((o) => {
        // options 既可能是字符串，也可能是 {value,label} —— 两种都归一
        if (typeof o === 'string') return { value: o, label: o }
        const oo = o && typeof o === 'object' ? o : {}
        return {
          value: String(oo.value ?? oo.id ?? ''),
          label: String(oo.label ?? oo.title ?? oo.value ?? ''),
        }
      })
    }
    if (q && q.multiSelect) item.multi = true
    return item
  })
  return { call_id: String(e.callId || ''), items }
}
