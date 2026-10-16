/**
 * 7.2 审批应答：`approval/request` waterfall
 *
 * 源码契约（`dsh-user-approval/lib/index.js`）：
 * ```js
 * // :172-189  ApprovalService.decide(req, session)
 * async decide(req, session) {
 *   const signal = req.signal
 *   if (signal?.aborted) return "cancelled"                      // :174
 *   if (this.effectivePolicy(session) === "never") return "rejected"  // :175 ★ 前置闸门
 *   const answer = Promise.resolve()
 *     .then(() => this.ctx.waterfall(
 *         scopeTarget(req.agent, req.agent),   // Agent 作用域
 *         "approval/request", req,
 *         () => Promise.resolve("unavailable")))   // 无应答者兜底
 *     .then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable",
 *           () => "unavailable")                              // :176 fail-closed
 *   ...
 * }
 * ```
 *
 * outcome 枚举（`:30-35`）：`["allowed-once", "rejected", "cancelled", "unavailable"]`
 * - **`allowed-once` 是唯一的"允许"**（:124 原文 "`'allowed-once'` is the only grant"）
 * - 兜底 / 任何异常 → `unavailable`（=拒绝，fail-closed）
 *
 * ⚠⚠ **联调前置条件（写给下一个人，别误判成插件没生效）** ⚠⚠
 * `:175` 的闸门 `if (effectivePolicy(session) === "never") return "rejected"` 会在
 * **派发 waterfall 之前**短路。**当前本会话的审批策略就是 `never`**（审批提示已被禁用），
 * 所以插件**根本收不到** `approval/request`，也就无法作答。
 * ⇒ **要联调 7.2，必须先把 DSH 的审批策略切回 `ask`。** 这是环境前提，不是代码缺陷。
 */

/** outcome 枚举 —— 与源码 `:30-35` 逐字对齐。 */
export const OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/** 唯一允许值。 */
export const GRANT = 'allowed-once'
/** 拒绝值。 */
export const REJECT = 'rejected'
/** 取消值（用户不点 / 超时 / signal abort）。 */
export const CANCELLED = 'cancelled'
/** 无应答者兜底值（=拒绝语义）。 */
export const UNAVAILABLE = 'unavailable'

/** 兜底答案：无应答者时交给 decide 继续走链。 */
export const NO_ANSWER = UNAVAILABLE

/**
 * 审批决策器：把"桌宠上点允许/拒绝"翻译成合法 outcome。
 *
 * 设计要点：
 *   - **返回值必须落在 OUTCOMES 内**，否则被 :176 规范化成 `unavailable`（=拒绝）；
 *   - 超时/取消 → `cancelled`（而不是 rejected，语义不同：前者是"没答"）；
 *   - signal abort → `cancelled`（与 :174/:181-182 同一语义）；
 *   - **绝不抛**：抛出去会被 :176 的 catch 吞成 unavailable，
 *     但我们会丢掉诊断信息，所以这里显式兜底并记录。
 *
 * @param {object} opts
 * @param {Function} opts.askUser  `(req) => Promise<'allow'|'deny'|'cancel'|null>`
 *   null/超时 → cancelled。这是桌宠侧的唯一注入点（测试可 mock）。
 * @param {number} [opts.timeoutMs] 超时（缺省 120s）；超时按 `cancelled`
 */
export function createApprovalDecider(opts = {}) {
  const askUser = opts.askUser
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120_000
  const logger = opts.logger || { info: () => {}, warn: () => {} }
  const stats = { asked: 0, allowed: 0, rejected: 0, cancelled: 0, unavailable: 0 }

  /**
   * 规范化：任何输入都映射到合法 outcome。**这是最后一道防线。**
   * 非法值 → `unavailable`（与源码 :176 的规范化行为一致）。
   */
  function normalize(value) {
    if (value === GRANT || value === REJECT || value === CANCELLED || value === UNAVAILABLE) return value
    // 宽松别名：桌宠 UI 的按钮语义 → 协议枚举
    if (value === true || value === 'allow' || value === 'allowed' || value === 'yes') return GRANT
    if (value === false || value === 'deny' || value === 'denied' || value === 'no') return REJECT
    if (value === 'cancel' || value === null || value === undefined) return CANCELLED
    return UNAVAILABLE
  }

  /**
   * waterfall 应答器。注册方式见 index.js：
   * `ctx.on('approval/request', (req, next) => decider.decide(req, next))`
   *
   * @param {object} req   `{agent, toolName, callId?, reason?, signal?}`
   * @param {Function} [next] waterfall 的下一环
   * @returns {Promise<string>} 合法 outcome
   */
  async function decide(req, next) {
    // signal 已 abort → cancelled（与源码 :174 一致，且**不必**打扰用户）
    if (req && req.signal && req.signal.aborted) {
      stats.cancelled += 1
      return CANCELLED
    }

    stats.asked += 1

    let raw
    try {
      raw = await raceTimeout(askUser(req), timeoutMs, req && req.signal)
    } catch (err) {
      // 询问层自己塌了 → 不能放行（fail-closed）。用 cancelled 而非 rejected：
      // 语义是"没拿到答复"，与"用户明确拒绝"区分开，便于事后审计。
      logger.warn?.('[Mao-pet] 审批询问失败，按 cancelled 处理：' + String(err && err.message || err))
      stats.cancelled += 1
      return CANCELLED
    }

    const outcome = normalize(raw)
    if (outcome === GRANT) stats.allowed += 1
    else if (outcome === REJECT) stats.rejected += 1
    else if (outcome === CANCELLED) stats.cancelled += 1
    else stats.unavailable += 1

    logger.info?.('[Mao-pet] 审批应答 ' + outcome
      + (req && req.toolName ? '（工具 ' + req.toolName + '）' : ''))
    return outcome
  }

  return {
    decide,
    normalize,
    OUTCOMES,
    diagnostics: () => ({ ...stats, timeout_ms: timeoutMs, outcomes: OUTCOMES }),
  }
}

/**
 * 与 signal 竞速的超时包装。
 *
 * 为什么必须支持 signal：DSH 在请求被取消时会 abort signal，
 * 此时我们应立即返回 cancelled **而不是**等满超时（否则桌宠弹窗会挂在屏幕上）。
 */
export function raceTimeout(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true
      cleanup()
      fn(v)
    }
    const timer = setTimeout(() => done(resolve, null), timeoutMs)
    const onAbort = () => done(resolve, 'cancel')
    function cleanup() {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    Promise.resolve(promise).then(
      (v) => done(resolve, v),
      (e) => done(reject, e),
    )
  })
}

/**
 * 审批请求 → 桌宠可展示的描述。
 *
 * **只取短字段**：这个对象会被推给桌宠渲染端。
 * 刻意**不外发** `req` 原文（可能含文件路径、命令行等敏感内容）。
 */
export function describeApproval(req) {
  const r = req && typeof req === 'object' ? req : {}
  const out = { kind: 'approval' }
  const tool = String(r.toolName || r.tool || '')
  if (tool) out.tool = tool.slice(0, 60)
  const reason = String(r.reason || '')
  if (reason) out.reason = reason.slice(0, 200)
  const callId = String(r.callId || '')
  if (callId) out.call_id = callId.slice(0, 80)
  return out
}
