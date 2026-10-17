/**
 * 推送层：phase / stream / bubble 三条旁路 → 桌宠总线。
 *
 * 传输无关（transport-agnostic）：本模块**只依赖注入的 transport 接口**，
 * 不认识 HTTP、也不认识 WS。这样做的直接收益是 6.5 的插件侧正确性
 * （选路 / 节流 / 失败退避 / 体结构）可以用 mock transport 端到端单测，
 * 不必等后端端点落地、也不必真连桌宠。
 *
 * 与后端 `agent_bus_service` 的分工（**刻意不重写它一行**）：
 *   - `emit(agent_id, phase, state, force)` → 驱动动画/徽标（抢"身体"）
 *   - `stream(agent_id, payload)`          → 逐 token 追加渲染（M7 7.1）
 *   - `announce(agent_id, text, duration)` → 一次性说一句（M7 7.4）
 *   300ms 同 phase 节流、活跃聚焦优先级、WS 广播**全在 emit 内部**，
 *   插件侧只做"变化才发 / 失败退避"这一层**网络层**节流，避免双重语义。
 */

import { isKnownPhase } from '../phases.js'
import { jsonClone, safeCall } from '../util.js'

/**
 * 本插件在**总线上的身份**。
 *
 * ★ 2026-10-17 用户裁决（合并为单一 DSH 身份）：
 *   产品定位是「DSH 专用桌宠」，不应该在桌宠上看到 `Mao-pet` 和 `DSH` 两个 agent
 *   互相抢镜头。故插件推送时**复用日志边车的 agent_id `dsh`** —— 总线上只有
 *   一个 agent，徽标只显示 `DSH · xxx`。
 *
 * ⚠ 注意区分两个"名字"，别混：
 *   - **npm 包名 / cordis 插件 id** = `mao-pet`（D5 裁决，装插件用，**不变**）；
 *   - **总线 agent_id** = `dsh`（这是"桌宠看到谁"，与边车共用）。
 *   本文件只影响后者。`AGENT_NAME` 用 DSH 的显示名，`AGENT_ACCENT` 用 DSH 的靛蓝，
 *   与 `dsh_adapter.py` 的 `AGENT_ID="dsh"` / `DSH_ACCENT` 保持一致。
 */
export const AGENT_ID = 'dsh'
export const AGENT_NAME = 'DeepSeek Harness'
/** 身份色：与后端 dsh 插件 / 前端 manifest 同值（靛蓝）。 */
export const AGENT_ACCENT = '#4F6BED'

/**
 * 「我来自插件」标记：随 state 透传给后端，供边车判断"插件正在驱动，我让位"。
 * 后端 `ingest._sanitize_state` 会放行这个布尔字段（见该处注释）。
 */
export const SOURCE_FLAG = 'plugin_owned'

/**
 * ★ 插件**自身**的身份（与"总线身份"区分，别混用）：
 *   - 本常量 = 插件是谁（npm 包名 / cordis id / 自己的 HTTP 路由前缀都用它，D5 裁决 → `mao-pet`）；
 *   - `AGENT_ID` = 插件在**桌宠总线上**代表谁（与日志边车共用 → `dsh`）。
 * 踩过的坑：合并身份时把两处都改成 dsh，导致插件 `/mao-pet/status` 自报 id 变成 dsh，
 * 前端 `parsed.plugin.id` 断言失败 —— 故显式拆成两个常量。
 */
export const PLUGIN_ID = 'mao-pet'
export const PLUGIN_NAME = 'Mao-pet'

/**
 * 网络层失败退避：连续失败时按指数拉长重试间隔，上限 30s。
 * 桌宠后端没起（用户没手动 start_mio.ps1）是**正常情况**，不是错误，
 * 所以这里只退避、不抛、不刷屏。
 */
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

/**
 * @param {object} opts
 * @param {object} opts.transport   `{ send(body) => Promise<{ok, status, body}> }`
 * @param {object} [opts.logger]    `{info, warn, debug}`（默认 console 包装）
 */
export function createPusher(opts = {}) {
  const transport = opts.transport
  const logger = opts.logger || defaultLogger()
  if (!transport || typeof transport.send !== 'function') {
    throw new TypeError('createPusher: 需要一个实现了 send() 的 transport')
  }

  // 最近一次成功推送的 phase：用于"变化才发"判定（与网络重试解耦）
  let lastSentPhase = ''
  let lastSentSignature = ''
  // 退避状态
  let failures = 0
  let nextAttemptAt = 0
  // 统计（供 diagnostics 路由与单测断言）
  const stats = { sent: 0, skipped: 0, failed: 0, coalesced: 0 }

  function now() {
    return Date.now()
  }

  /** 指数退避：失败 n 次后间隔 = min(base * 2^(n-1), max)。 */
  function backoffDelay() {
    const d = BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1)
    return Math.min(BACKOFF_MAX_MS, d)
  }

  /**
   * 发送一个信封（envelope）。
   *
   * 信封形状与后端 ingest 契约一致：
   *   `{ agent_id, name, accent, kind, phase, state, seq, force }`
   * `kind` 区分三条旁路（phase/stream/bubble），后端按 kind 分派到
   * emit / stream / announce。
   *
   * 绝不抛异常：插件在网络层失败时**必须**静默降级，
   * 否则会在宿主里产生 unhandled rejection（桌宠后端没起是常态）。
   */
  async function dispatch(envelope, { bypassBackoff = false } = {}) {
    if (!bypassBackoff && failures > 0 && now() < nextAttemptAt) {
      stats.coalesced += 1
      logger.debug?.('[mao-pet] 退避中，跳过本次推送（下次可试 ' + new Date(nextAttemptAt).toISOString() + '）')
      return { ok: false, throttled: true, reason: 'backoff' }
    }

    let result
    try {
      result = await transport.send(envelope)
    } catch (err) {
      failures += 1
      nextAttemptAt = now() + backoffDelay()
      stats.failed += 1
      logger.debug?.('[mao-pet] 推送异常（已退避 ' + backoffDelay() + 'ms）：' + String(err && err.message || err))
      return { ok: false, error: String(err && err.message || err) }
    }

    if (result && result.ok) {
      if (failures > 0) {
        logger.info?.('[mao-pet] 桌宠后端恢复连接（连续失败 ' + failures + ' 次后成功）')
      }
      failures = 0
      nextAttemptAt = 0
      stats.sent += 1
      return { ok: true, status: result.status, body: result.body }
    }

    failures += 1
    nextAttemptAt = now() + backoffDelay()
    stats.failed += 1
    // 只在**首次失败**与**恢复后再次失败**时打日志，避免刷屏
    if (failures === 1) {
      logger.info?.('[mao-pet] 桌宠后端暂不可达（' + (result && result.status ? 'HTTP ' + result.status : '无响应')
        + '）。已进入退避，连接恢复后自动继续。提示：桌宠需手动 `start_mio.ps1` 启动。')
    }
    return { ok: false, status: result && result.status, body: result && result.body }
  }

  return {
    AGENT_ID,
    AGENT_NAME,
    AGENT_ACCENT,

    /**
     * 推送 phase 变化。**只推合法 phase**（非法值直接丢弃 —— 后端 emit 会
     * raise ValueError，插件不该把垃圾丢过去）。
     *
     * `force`：后端 emit 的 300ms 同 phase 节流会吃掉"立即恢复"语义
     * （见 dsh_adapter.py:819-822 的同一取舍）。**phase 发生变化时我们传 true**，
     * 同 phase 补发时才交给后端节流。
     *
     * @returns {Promise<object>} `{ok, throttled?, reason?}`
     */
    async pushPhase(phase, state = {}, opts2 = {}) {
      if (!isKnownPhase(phase)) {
        stats.skipped += 1
        logger.warn?.('[mao-pet] 丢弃未知 phase：' + String(phase))
        return { ok: false, reason: 'unknown-phase' }
      }

      const signature = phase + '|' + stableStringify(state)
      const changed = phase !== lastSentPhase
      // 同 phase 且 state 完全没变 → 无事发生，不发
      if (!changed && signature === lastSentSignature && !opts2.force) {
        stats.skipped += 1
        return { ok: false, reason: 'unchanged' }
      }

      const envelope = {
        agent_id: AGENT_ID,
        name: AGENT_NAME,
        accent: AGENT_ACCENT,
        kind: 'phase',
        phase,
        // ★ 复用 dsh 身份后，边车与插件会同时驱动同一个 agent。
        //   带上 plugin_owned 让后端/边车知道"这一条来自插件（实时源）"，
        //   边车据此让位，避免两边 phase 互相覆盖造成抖动。
        state: { ...(jsonClone(state) || {}), plugin_owned: true },
        seq: opts2.seq,
        // 变化即强发；同 phase 补发时也强发（我们在上层已按 REEMIT 节流）
        force: Boolean(opts2.force ?? changed),
      }

      const res = await dispatch(envelope)
      if (res.ok) {
        lastSentPhase = phase
        lastSentSignature = signature
      }
      return res
    },

    /**
     * 逐 token 流式正文（M7 7.1）。**只出气泡，不改 phase、不抢"身体"**
     * —— 与后端 `announce` 同一分层。
     *
     * ⚠ `reasoning-chunks` 一律不外发：推理草稿进桌宠气泡是明确越界
     * （见 docs/M7-协议测绘-源码级.md §7 第 3 条）。此处做最后一道白名单。
     */
    async pushStream(payload) {
      const body = payload && typeof payload === 'object' ? payload : null
      if (!body) return { ok: false, reason: 'bad-payload' }
      const frame = String(body.frame || '')
      if (frame && frame !== 'text-chunks') {
        stats.skipped += 1
        return { ok: false, reason: 'frame-not-allowed', frame }
      }
      return dispatch({
        agent_id: AGENT_ID,
        name: AGENT_NAME,
        accent: AGENT_ACCENT,
        kind: 'stream',
        payload: jsonClone(body) || {},
      })
    },

    /** 一次性气泡（M7 7.4）。不改 phase、不抢"身体"。 */
    async pushBubble(text, durationMs = 0) {
      const body = String(text || '').trim()
      if (!body) return { ok: false, reason: 'empty-text' }
      return dispatch({
        agent_id: AGENT_ID,
        name: AGENT_NAME,
        accent: AGENT_ACCENT,
        kind: 'bubble',
        text: body,
        duration_ms: Math.max(0, Math.trunc(Number(durationMs) || 0)),
      })
    },

    /**
     * 存活心跳。**不改变动画**（后端 heartbeat 通道的语义），
     * 且**绕过退避**——否则后端一断线，心跳也会被自己退避掉，
     * 恢复后无法第一时间重新报到。
     */
    async pushHeartbeat() {
      return dispatch({
        agent_id: AGENT_ID,
        name: AGENT_NAME,
        accent: AGENT_ACCENT,
        kind: 'heartbeat',
      }, { bypassBackoff: true })
    },

    /** 诊断快照（webServer 路由用；只读、无副作用）。 */
    diagnostics() {
      return {
        agent_id: AGENT_ID,
        name: AGENT_NAME,
        accent: AGENT_ACCENT,
        last_phase: lastSentPhase,
        consecutive_failures: failures,
        next_attempt_at: nextAttemptAt ? new Date(nextAttemptAt).toISOString() : null,
        stats: { ...stats },
      }
    },

    /** 测试/重连用：清空节流与退避状态。 */
    reset() {
      lastSentPhase = ''
      lastSentSignature = ''
      failures = 0
      nextAttemptAt = 0
      stats.sent = 0
      stats.skipped = 0
      stats.failed = 0
      stats.coalesced = 0
    },
  }
}

/**
 * 稳定的 JSON 字符串化：键顺序无关，用于"state 是否真的变了"的比较。
 * 直接 JSON.stringify 会因键插入顺序不同而误判为"变了"，导致无谓推送。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + safeCall(() => stableStringify(value[k]), 'null')).join(',') + '}'
}

function defaultLogger() {
  return {
    info: (...a) => safeCall(() => console.info(...a)),
    warn: (...a) => safeCall(() => console.warn(...a)),
    debug: () => {},
  }
}
