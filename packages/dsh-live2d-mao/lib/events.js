/**
 * 事件订阅层：DSH session 事件 → facts 折叠 → phase → 推送。
 *
 * 分层刻意分明（为 M7 留位，避免返工）：
 *   `events.js`（本文件：订阅+折叠+节流决策）
 *     → `phase-map.js`（纯策略：facts → phase）
 *       → `push/pusher.js`（纯传输无关：节流+退避+分派）
 *
 * M7 的 7.1/7.4 只需在**本文件**挂旁路（assistant-stream / 多 session 分桶），
 * 不必动下面两层。
 */

import { emptyFacts, foldEvent } from './facts.js'
import { phaseForFacts, pausedState, heartbeatState } from './phase-map.js'
import { isWorkPhase, PHASES } from './phases.js'
import { readProjection, summarizeContextPressure } from './projections.js'
import { safeCall } from './util.js'

/**
 * 同 phase 周期补发间隔（毫秒）。
 *
 * 为什么要周期补发（而不是"变了才发"）—— 移植 `dsh_adapter.py:201-208` 的实测结论：
 * 桌宠渲染端的动作/表情**有时限**（Live2D：speaking 4s、其余 2.6s 后回落待机）。
 * DSH 单次工具调用可持续几十秒（本机实测有 33s 的 pwsh 调用），这期间**没有任何新事件**；
 * 若只在事件到达时上报，桌宠会在工具还在跑时就变回待机 —— 看着像 DSH 停工了。
 * 故把补发间隔压到桌宠活动窗口以内（2000ms < 2600ms）。
 */
export const REEMIT_MS = 2000

/** 心跳间隔：仅为"我还在线"（不改变动画），比 phase 补发宽松得多。 */
export const HEARTBEAT_MS = 15_000

/**
 * 创建连接器（不订阅，仅构造状态机）——订阅由 index.js 在拿到 ctx 后做。
 *
 * @param {object} opts
 * @param {object} opts.pusher
 * @param {object} [opts.logger]
 * @param {number} [opts.reemitMs]
 * @param {number} [opts.heartbeatMs]
 */
export function createConnector(opts = {}) {
  const pusher = opts.pusher
  const logger = opts.logger || console
  const reemitMs = Number(opts.reemitMs) > 0 ? Number(opts.reemitMs) : REEMIT_MS
  const heartbeatMs = Number(opts.heartbeatMs) > 0 ? Number(opts.heartbeatMs) : HEARTBEAT_MS

  // ── A2 上下文压力（2026-10-19）：宿主投影服务的获取方式 ──
  // 三种形态都收：
  //   function → 惰性 getter（index.js 传 `() => ctx.get('sessionProjections')`，
  //              因为 connector 创建时服务可能还没就绪）；
  //   object   → 直接是服务实例（测试注入 mock 最方便）；
  //   缺省     → 功能关闭（老宿主没有该服务也不影响主链路）。
  const projectionSource = typeof opts.projectionService === 'function'
    ? opts.projectionService
    : (opts.projectionService ? () => opts.projectionService : null)

  // 按 sessionId 分桶：多 session 并发时**不能串账**（M7 7.4 的基础）。
  // 主会话由 delegationDepth===0 / 无 parentSessionId 识别（见 M7 协议测绘 §5）。
  const buckets = new Map() // sessionId -> { facts, session, lastPhase, lastEmitAt, echo }
  // 最近一次真实 phase（用于控制台输出与 diagnostics）
  let lastLoggedPhase = ''
  let seq = 0
  // 通知钩子（控制台打点 / M7 前端）——数组便于多订阅者
  const phaseListeners = []

  function newBucket(sessionId, session) {
    return {
      facts: emptyFacts(),
      session: session || null,
      lastPhase: '',
      lastEmitAt: 0,
      // 「最近静默时间」用于 heartbeat 判定
      lastEventAt: Date.now(),
      sid: sessionId,
    }
  }

  function bucketFor(session, event) {
    const sid = String((session && session.id) || (event && event.sessionId) || '__default__')
    let b = buckets.get(sid)
    if (!b) {
      b = newBucket(sid, session)
      buckets.set(sid, b)
      // 桶上限：防止长跑会话表无限增长（只保留最近的，超限丢最旧的）
      if (buckets.size > MAX_BUCKETS) {
        const oldest = buckets.keys().next().value
        if (oldest !== sid) buckets.delete(oldest)
      }
    }
    if (session) b.session = session
    return b
  }

  /**
   * 处理一个 `session/event`。
   *
   * ⚠ 首参是 session、第二个才是 event（`dsh-agent-loop/lib/index.js:319,974` 三处一致）。
   * 写错会**静默拿不到事件** —— 最难查的一类 bug，故这里做形状防御：
   * 万一调用方传反了，我们要能识别并纠正而不是默默吞掉。
   */
  function handleSessionEvent(session, event) {
    // 形状防御：如果第一参看起来像事件、第二参像 session，就交换回来
    if (looksLikeEvent(session) && !looksLikeEvent(event)) {
      const t = session
      session = event
      event = t
    }
    if (!looksLikeEvent(event)) return { phase: null, reason: 'not-an-event' }

    const bucket = bucketFor(session, event)
    bucket.lastEventAt = Date.now()

    const { changed } = foldEvent(bucket.facts, event, session)
    return applyFacts(bucket, { force: changed })
  }

  /**
   * 由当前 facts 推 phase 并推送（含"变化即发 / 同 phase 按 REEMIT 补发"节流）。
   */
  function applyFacts(bucket, opts2 = {}) {
    const { phase, state } = phaseForFacts(bucket.facts)
    return emitPhase(bucket, phase, state, opts2)
  }

  /** 推送决策核心：返回 `{phase, state, pushed, reason}`。 */
  function emitPhase(bucket, phase, state, opts2 = {}) {
    const now = Date.now()
    const changed = phase !== bucket.lastPhase
    const isWork = isWorkPhase(phase)

    // 「变了才发」+「工作态每 reemitMs 补发一次」+「非工作态不重复刷屏」
    // —— 逐字移植 `dsh_adapter.py:810-818` 的门控。
    const due = now - bucket.lastEmitAt >= reemitMs
    if (!changed && !opts2.force && !isWork) {
      return { phase, state, pushed: false, reason: 'idle-unchanged' }
    }
    if (!changed && !isWork && !due) {
      return { phase, state, pushed: false, reason: 'throttled' }
    }
    if (!changed && isWork && !due && !opts2.force) {
      return { phase, state, pushed: false, reason: 'reemit-not-due' }
    }

    // 补上会话标识，便于桌宠侧区分（与后端 `state["session"]` 对齐）
    if (bucket.sid && bucket.sid !== '__default__') state.session = bucket.sid

    // ── A2 上下文压力：读宿主 `contextPressure` 投影，塞进 state 一起推 ──
    // 后端 `_sanitize_state` 白名单只收**整数**（ingest.py `("turn","step",
    // "tool_calls","todos","ctx_pressure")` 那个循环），故这里取整。
    // 读不到（服务缺失 / key 未注册 / 抛异常）→ 不放字段，绝不拖垮主链路。
    if (projectionSource && bucket.session) {
      const pct = safeCall(() => {
        const service = projectionSource()
        const summary = summarizeContextPressure(readProjection(service, bucket.session, 'contextPressure'))
        const p = summary && summary.percent
        return typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.round(p)) : null
      }, null)
      if (pct !== null) state.ctx_pressure = pct
    }

    const seqAtSend = ++seq
    bucket.lastPhase = phase
    bucket.lastEmitAt = now

    // 控制台打点：DP 验收要求"DSH 一说话就打出 phase 变化"
    if (phase !== lastLoggedPhase) {
      lastLoggedPhase = phase
      safeCall(() => logger.info(
        '[dsh-live2d-mao] phase → ' + phase + workBadge(isWork) + ' ' + JSON.stringify(state),
      ))
      for (const fn of phaseListeners) safeCall(() => fn({ phase, state, sessionId: bucket.sid, seq: seqAtSend }))
    }

    // 推送是异步的，**不 await**：事件回调不能被网络阻塞（否则拖慢 DSH 自身事件流）。
    // pusher 内部已保证不抛（退避 + 静默降级）。
    Promise.resolve()
      .then(() => pusher.pushPhase(phase, state, { seq: seqAtSend, force: changed }))
      .catch((err) => safeCall(() => logger.debug?.('[dsh-live2d-mao] 推送失败（已吞）：' + String(err && err.message || err))))

    return { phase, state, pushed: true, seq: seqAtSend }
  }

  /**
   * 连接中断/会话不可用 → `paused`。
   * **不走 facts**（见 phases.js FACT_PHASES 注释）：它不是"从会话事实推出来的"，
   * 而是连接层状态。由 index.js 在检测到 DSH 进程还在但会话失效时调用。
   */
  function emitPaused(reason) {
    const { phase, state } = pausedState(reason)
    const bucket = buckets.get('__conn__') || (() => {
      const b = newBucket('__conn__', null)
      buckets.set('__conn__', b)
      return b
    })()
    return emitPhase(bucket, phase, state, { force: true })
  }

  /**
   * 存活心跳 → `heartbeat`。
   * **走 pusher.pushHeartbeat（后端 heartbeat 通道），不走 emit** —— 移植源明确：
   * 总线的 `emit()` 对 heartbeat 不广播 agent_phase，且会把 agent.phase 写成
   * "heartbeat" 污染 Agent 页显示（`dsh_adapter.py:162-164`）。
   */
  async function emitHeartbeat() {
    safeCall(() => logger.debug?.('[dsh-live2d-mao] heartbeat'))
    return pusher.pushHeartbeat()
  }

  /** 定时器管理：返回 disposer。宿主热重载时必须清干净，否则定时器泄漏。 */
  function startTimers() {
    const phaseTimer = setInterval(() => {
      for (const bucket of buckets.values()) {
        if (bucket.sid === '__conn__') continue
        // 只在轮次内补发（轮次外待机不需要反复上报）
        if (bucket.facts.in_turn) applyFacts(bucket, { force: false })
      }
    }, reemitMs)
    const hbTimer = setInterval(() => { emitHeartbeat() }, heartbeatMs)
    // 不要因定时器让宿主进程无法退出
    phaseTimer.unref?.()
    hbTimer.unref?.()
    return () => {
      clearInterval(phaseTimer)
      clearInterval(hbTimer)
    }
  }

  return {
    handleSessionEvent,
    applyFacts,
    emitPhase,
    emitPaused,
    emitHeartbeat,
    startTimers,
    onPhase(fn) {
      phaseListeners.push(fn)
      return () => {
        const i = phaseListeners.indexOf(fn)
        if (i >= 0) phaseListeners.splice(i, 1)
      }
    },
    get lastPhase() {
      return lastLoggedPhase
    },
    /** 只读诊断快照（webServer 路由用）。 */
    snapshot() {
      const out = []
      for (const [sid, b] of buckets.entries()) {
        out.push({ session_id: sid, phase: b.lastPhase, in_turn: b.facts.in_turn, facts: { ...b.facts } })
      }
      return {
        agent_id: pusher.AGENT_ID,
        name: pusher.AGENT_NAME,
        known_phases: PHASES,
        sessions: out,
        seq,
        last_phase: lastLoggedPhase,
      }
    },
    /** 测试用：取某 session 的 bucket。 */
    _bucket(sessionId) {
      return buckets.get(String(sessionId))
    },
  }
}

/** 桶上限（M7 气泡栈上限 12 的同量级；这里放宽到 32 因为只是状态快照）。 */
const MAX_BUCKETS = 32

/** 形状判定：DSH 事件必有字符串 `type`。 */
function looksLikeEvent(x) {
  return Boolean(x && typeof x === 'object' && typeof x.type === 'string' && x.type.length > 0)
}

function workBadge(isWork) {
  return isWork ? ' [工作]' : ''
}
