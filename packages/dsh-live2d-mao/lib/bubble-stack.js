/**
 * 7.4 多 session 气泡栈
 *
 * 契约要点：
 *   - `session/event` 全局监听（`{global:true}`）后**天然**能拿到多 session 的事件
 *     （证据：`dsh-user-questions/lib/index.js:510,514,524` 三处都用 `{global:true}`）；
 *   - 按 `session.id` 分桶；**上限 `MAX_SESSION_BUBBLES = 12`**；
 *   - 子会话识别：`session.parentSessionId` 存在 或 `session.origin === 'subagent'`
 *     （证据：`dsh-api-session-controller/lib/typert.host.js:448-450` 的 session 描述字段）。
 *
 * 为什么需要"栈"而不只是"桶"：桌宠的说话气泡是**单一窗位**（`#speech-bubble`），
 * 12 个会话不可能同时说话。所以真正要解决的是**谁现在占用气泡**——
 * 这是一个带优先级的、有超时回收的栈。
 */

import { PHASE_PRIORITY } from './phases.js'
import { safeCall } from './util.js'

/** 气泡栈上限（技术方案 §2 表给的定值）。 */
export const MAX_SESSION_BUBBLES = 12

/** 一条气泡的默认存活时长。 */
export const DEFAULT_BUBBLE_TTL_MS = 6000

/**
 * 判断一个 session 是否为子会话（子代理）。
 *
 * 两种判据都要认（不同 dsh 版本字段不同）：
 *   - `parentSessionId` 有值 → 是子会话；
 *   - `origin === 'subagent'` → 是子代理会话。
 */
export function isSubSession(session) {
  if (!session || typeof session !== 'object') return false
  if (session.parentSessionId) return true
  if (String(session.origin || '') === 'subagent') return true
  if (Number(session.delegationDepth) > 0) return true
  return false
}

/** 取 session 的稳定 id。 */
export function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return ''
  return String(session.id || session.sessionId || '')
}

/**
 * 气泡栈。
 *
 * @param {object} opts
 * @param {number} [opts.max]       栈上限（缺省 12）
 * @param {number} [opts.ttlMs]     单条存活（缺省 6000）
 * @param {Function} [opts.now]     时钟注入（测试用）
 * @param {object} [opts.logger]
 */
export function createBubbleStack(opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : MAX_SESSION_BUBBLES
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_BUBBLE_TTL_MS
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const logger = opts.logger || { debug: () => {} }

  /** sessionId -> entry */
  const entries = new Map()

  /** 清理过期条目（惰性调用，无需定时器）。 */
  function prune() {
    const t = now()
    for (const [sid, e] of entries.entries()) {
      if (e.expiresAt <= t) entries.delete(sid)
    }
  }

  /** 按优先级 + 时间排序的条目列表（最优者在前）。 */
  function ranked() {
    prune()
    return [...entries.values()].sort((a, b) => {
      // 优先级数值小者优先；同级按最近活动时间新者优先
      if (a.priority !== b.priority) return a.priority - b.priority
      return b.updatedAt - a.updatedAt
    })
  }

  return {
    MAX_SESSION_BUBBLES: max,

    /**
     * 压入/更新一条气泡。
     *
     * @param {object} session
     * @param {object} payload `{text, phase?, durationMs?}`
     * @returns {{accepted:boolean, reason?:string, evicted?:string, active?:string}}
     */
    push(session, payload = {}) {
      const sid = sessionIdOf(session)
      if (!sid) return { accepted: false, reason: 'no-session-id' }

      const text = String(payload.text || '').trim()
      if (!text) return { accepted: false, reason: 'empty-text' }

      const phase = String(payload.phase || '')
      const priority = PHASE_PRIORITY[phase] ?? 6
      const t = now()

      // 超上限时先淘汰**最差**的一条（优先级最低 / 最旧）。
      // 注意：淘汰的是"最不重要的"，不是"最早来的" —— 后者会把
      // 优先级最高的主会话误踢出去。
      let evicted = null
      if (!entries.has(sid) && entries.size >= max) {
        const worst = ranked().pop()
        if (worst) {
          entries.delete(worst.sessionId)
          evicted = worst.sessionId
          logger.debug?.('[dsh-live2d-mao] 气泡栈已满，淘汰 ' + worst.sessionId)
        }
      }

      entries.set(sid, {
        sessionId: sid,
        text: text.slice(0, 400),
        phase,
        priority,
        isSub: isSubSession(session),
        updatedAt: t,
        expiresAt: t + (Number(payload.durationMs) > 0 ? Number(payload.durationMs) : ttlMs),
      })

      return { accepted: true, evicted, active: ranked()[0]?.sessionId }
    },

    /** 手动移除（例如会话结束）。 */
    remove(session) {
      const sid = sessionIdOf(session)
      return entries.delete(sid)
    },

    /** 当前应当占用气泡窗位的会话 id（无则 null）。 */
    active() {
      return ranked()[0]?.sessionId ?? null
    },

    /** 取某会话当前气泡文本（无则空串）。 */
    textOf(sessionId) {
      const e = entries.get(String(sessionId || ''))
      return e ? e.text : ''
    },

    /** 当前栈内容（按优先级排序，只读快照）。 */
    snapshot() {
      return ranked().map((e) => ({
        session_id: e.sessionId,
        text: e.text,
        phase: e.phase,
        priority: e.priority,
        is_sub: e.isSub,
        age_ms: now() - e.updatedAt,
      }))
    },

    size() {
      prune()
      return entries.size
    },

    clear() {
      entries.clear()
    },
  }
}
