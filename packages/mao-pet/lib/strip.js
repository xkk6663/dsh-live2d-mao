/**
 * 7.6 横条复用为 DSH 流式提示窗口 —— **插件侧编排层 + 主体契约**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 一、职责分界（Lead 裁决 A：分两半交付）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | 归属 | 内容 | 持久性 |
 * |---|---|---|
 * | **主体**（`澪Agent应用/dist/live2d-pet/`） | 横条本体 DOM、拖动位置、关闭态、主题类应用 | **跨会话持久**（重启后位置/皮肤还在） |
 * | **插件**（本文件） | 何时推内容、何时抑制、与气泡的互斥编排 | **会话内**（热重载即重置） |
 *
 * ⚠ 这条分界是刻意的：**拖动位置与关闭态属于主体**。
 * 若放进插件，插件热重载/重装就会丢掉用户拖好的位置与"我已关掉"的状态 ——
 * 那正是 DSH 插件最常见的状态丢失事故。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 二、★ 主体契约：`window.__mioPetStrip`（**以本文件为准**）
 * ═══════════════════════════════════════════════════════════════════════════
 * 依 `docs/项目接管执行方案.md` §18："横条组件若需主体暴露，走 `window.__mioPet*` 通道，
 * 与 `__mioPetBubble` 同一模式。"（即**新增通道**是文档预设的做法，
 * §3.5 禁的是"插件直接改核心 DOM"，不是"新增通道"。）
 *
 * ```ts
 * window.__mioPetStrip = {
 *   // 显示/更新横条内容。幂等：同文本重复调用不产生额外动效。
 *   show(text: string, opts?: {
 *     sessionId?: string      // 用于主体侧区分来源（可选）
 *     sticky?: boolean        // true=不清除自动隐藏计时（流式中持续追加时用）
 *     durationMs?: number     // 0/缺省 = 由主体决定默认时长
 *   }): boolean               // false = 主体拒绝（例如横条被用户关掉了）
 *
 *   // 追加一个 token（流式打字机）。内容与 show 共用同一缓冲区。
 *   append(token: string, opts?: { sessionId?: string }): boolean
 *
 *   // 隐藏横条的内容（**不改变"用户已关闭"状态**）。
 *   hide(): void
 *
 *   // 当前是否可见。
 *   isVisible(): boolean
 *
 *   // 用户是否已在本会话关闭过（主体持久化这个状态）。
 *   isDismissed(): boolean
 *
 *   // 全局开关（设置页"启用横条"）。false 后 show/append 一律返回 false。
 *   setEnabled(on: boolean): void
 *
 *   // 应用主题（由主体读写 settings.live2d_strip_style 并落类）。
 *   // 插件**不**直接改类，只请求主体应用。
 *   applyStyle(styleId: string): string   // 返回实际生效的 styleId
 *
 *   // 只读元信息（诊断用）。
 *   info(): { visible: boolean, dismissed: boolean, enabled: boolean, styleId: string }
 * }
 * ```
 *
 * **错误语义**：
 *   - 任何方法**都不得抛异常**。主体实现应内部兜底并返回安全值
 *     （`show`/`append` 返回 `false`，其余返回空值）；
 *   - `show`/`append` 在「横条被关闭」「被禁用」「横条未挂载」三种情况下都返回 `false`，
 *     插件据此**静默降级**，不得报错、不得重试风暴。
 *
 * **主题键**：主键 **`live2d_strip_style`**，别名 **`pet_strip_style`**（**两个都认**）。
 * 主键与 `live2d_bubble_style` **同族**，设置页「泡泡」扩展「横条」目标时最一致。
 * 两端都认这两个键，避免"插件叫一套、主体叫一套"的键名漂移。
 * 落点在服务端 settings，经 `settings_changed` 热应用 ——
 * 与 `live2d-pet.js` 里 `bs.setStyle(...)` 那条既有通路完全一致。
 * ⚠ 插件**不自己读写 settings / 不落 CSS 类**，一律经 `applyStyle()` 委托主体。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三、四条验收在本层的落点
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① 流式提示显示在横条内、可拖动、✕ 可关 → 插件调 `show`/`append`；
 *      拖动与 ✕ 由**主体**实现（本层只读 `isDismissed()`）。
 *   ② 气泡与横条**不同时弹同一内容** → 本层互斥状态机（`mode` 单值）。
 *   ③ 横条主题可在「泡泡」界面自定义 → `applyStyle` 请求主体应用；
 *      键 `live2d_strip_style`（主）/ `pet_strip_style`（别名）。
 *   ④ 关闭后本次会话不再自动弹 → 本层 `suppressedSessions` 集合 + 主体 `isDismissed()`。
 *
 * ⚠ **降级**：`__mioPetStrip` 不存在时（主体尚未实现 / 旧版桌宠），
 * 本层自动回落到 `window.__mioPetBubble`，**验收 ① 的"横条内"不成立但功能不丢**，
 * 且**不报错**。测试覆盖这条路径。
 */

import { safeCall } from './util.js'

/** 横条在 window 上的挂载点。 */
export const STRIP_GLOBAL = '__mioPetStrip'
/** 降级用的气泡挂载点（既有核心 API）。 */
export const BUBBLE_GLOBAL = '__mioPetBubble'
/** 气泡皮肤应用器（主体侧，用于查询当前皮肤 id）。 */
export const BUBBLE_STYLES_GLOBAL = '__mioPetBubbleStyles'

/**
 * 横条主题的服务端 settings **主键**（与 `live2d_bubble_style` 同族）。
 * 主体侧同时认别名 `pet_strip_style`。
 */
export const STRIP_STYLE_KEY = 'live2d_strip_style'
/** 别名（历史/兼容；主体侧同样认）。 */
export const STRIP_STYLE_KEY_ALIAS = 'pet_strip_style'
/** 两个都认的完整列表（供设置页/诊断用）。 */
export const STRIP_STYLE_KEYS = Object.freeze([STRIP_STYLE_KEY, STRIP_STYLE_KEY_ALIAS])

/** 窗位占用模式 —— **单值**，这正是"互斥"的实现方式。 */
export const MODE = Object.freeze({
  IDLE: 'idle',
  STRIP: 'strip',   // 横条在承载流式内容
  BUBBLE: 'bubble', // 气泡在承载说话内容
})

/**
 * 创建横条编排器。
 *
 * @param {object} opts
 * @param {object} [opts.win]    window 形状对象（测试注入；缺省 globalThis）
 * @param {object} [opts.logger]
 * @param {Function} [opts.onDegrade] 降级回调（诊断/日志用）
 * @param {object} [opts.remote] **宿主侧远程代理**（没有浏览器 window 时用）
 *   形状：`{ show(text,opts), append(text,opts), hide(), isVisible(), isDismissed(),
 *           setEnabled(on), applyStyle(id), info() }`，返回值语义与浏览器侧一致。
 *
 *   **为什么需要它**（本次补齐的关键一环，别删）：
 *   `window.__mioPetStrip` 只存在于**桌宠窗口**；插件宿主跑在 DSH 的 Node 子进程里，
 *   那里永远没有这个全局 —— 所以宿主侧 `stripApi()` 恒为 null，横条内容**永远送不出去**。
 *   远程代理把动作转成 `POST /api/plugin/dsh/strip`，由后端经 WS `agent_strip`
 *   转发到桌宠窗口（与 `agent_stream` 同一条链路思路）。
 *   没有它，7.6 在真机上只能降级走气泡，"横条"这一形态等于没落地。
 */
export function createStripController(opts = {}) {
  const win = opts.win || (typeof globalThis !== 'undefined' ? globalThis : {})
  const logger = opts.logger || { info: () => {}, warn: () => {}, debug: () => {} }
  const onDegrade = typeof opts.onDegrade === 'function' ? opts.onDegrade : () => {}
  /** 宿主侧远程代理（可为 null：纯浏览器/测试环境不需要）。 */
  const remote = opts.remote && typeof opts.remote === 'object' ? opts.remote : null

  /** 当前占用窗位的内容模式（互斥的载体）。 */
  let mode = MODE.IDLE
  /** 当前窗位承载的是哪条内容（用于"同一内容不重复弹"判定）。 */
  let currentKey = ''
  /** 本会话已被用户 ✕ 关闭 → 不再自动弹。 */
  const suppressedSessions = new Set()
  /** 降级只告警一次，避免刷屏。 */
  let degradeWarned = false

  /** 取主体实现的横条 API（浏览器全局优先；宿主侧回落远程代理）。 */
  function stripApi() {
    const local = safeCall(() => {
      const api = win[STRIP_GLOBAL]
      // 必须排除数组：`typeof [] === 'object'`，而数组不是合法的 API 对象。
      // 另外要求至少实现 show 或 append —— 否则"通道存在但不可用"，
      // 会被误判为可用而走进降级不了的分支。
      if (!api || typeof api !== 'object' || Array.isArray(api)) return null
      if (typeof api.show !== 'function' && typeof api.append !== 'function') return null
      return api
    }, null)
    if (local) return local
    // 宿主侧：没有浏览器全局，但有远程代理时，横条**依然可用**（经后端 → WS 转发）。
    // 这条分支是 7.6 能在真机跑通的前提。
    if (remote && (typeof remote.show === 'function' || typeof remote.append === 'function')) {
      return remote
    }
    return null
  }

  /** 取降级用的气泡 API（不存在则 null）。 */
  function bubbleApi() {
    return safeCall(() => {
      const api = win[BUBBLE_GLOBAL]
      if (!api || typeof api !== 'object' || Array.isArray(api)) return null
      return typeof api.show === 'function' ? api : null
    }, null)
  }

  /** 横条是否在主体侧被用户关闭（`isDismissed` 缺失时按未关闭处理）。 */
  function isDismissed() {
    const api = stripApi()
    if (!api) return false
    return safeCall(() => (typeof api.isDismissed === 'function' ? Boolean(api.isDismissed()) : false), false)
  }

  function noteDegrade(reason) {
    if (degradeWarned) return
    degradeWarned = true
    logger.info?.('[Mao-pet] 横条通道不可用（' + reason + '），已降级到说话气泡；'
      + '功能不受影响，但流式提示会占用气泡窗位。')
    safeCall(() => onDegrade(reason))
  }

  /** 稳定的内容标识：用于"同一内容不重复弹"与互斥判定。 */
  function contentKey(text) {
    const s = String(text || '')
    return s.length > 120 ? s.slice(0, 120) : s
  }

  return {
    MODE,
    STRIP_STYLE_KEY,
    STRIP_STYLE_KEY_ALIAS,
    STRIP_STYLE_KEYS,

    /** 当前占用模式（只读）。 */
    get mode() {
      return mode
    },

    /** 当前内容标识（只读）。 */
    get currentKey() {
      return currentKey
    },

    /** 横条通道是否可用（主体是否已实现 `__mioPetStrip`）。 */
    hasStrip() {
      return stripApi() !== null
    },

    /** 本会话是否已被抑制（测试/诊断用）。 */
    isSuppressed(sessionId) {
      return suppressedSessions.has(String(sessionId || ''))
    },

    /**
     * ④ 用户点了 ✕ → 本会话不再自动弹（下次流式/提示仍会弹 = 不跨会话记忆）。
     *
     * 注意：**主体也持久化 "dismissed"**（跨会话），两者语义不同：
     *   - 主体的 dismissed：用户在界面上的关闭态（持久）；
     *   - 本层 suppressedSessions：**本会话**内"关过就不再自动弹"（会话结束即清）。
     */
    markDismissed(sessionId) {
      const sid = String(sessionId || '')
      if (!sid) return
      suppressedSessions.add(sid)
      mode = MODE.IDLE
      currentKey = ''
    },

    /** 会话结束/新会话：清掉抑制。 */
    clearSuppressed(sessionId) {
      if (sessionId === undefined || sessionId === null) suppressedSessions.clear()
      else suppressedSessions.delete(String(sessionId))
    },

    /**
     * ① 推一段流式内容到横条。
     *
     * @param {string} text
     * @param {object} opts2 `{sessionId, sticky, durationMs, append}`
     * @returns {{shown:boolean, via:'strip'|'bubble'|'none', reason?:string}}
     */
    pushStream(text, opts2 = {}) {
      const body = String(text || '')
      if (!body.trim()) return { shown: false, via: 'none', reason: 'empty-text' }

      const sid = String(opts2.sessionId || '')
      // ④ 本会话已被抑制 → 不自动弹
      if (sid && suppressedSessions.has(sid)) {
        return { shown: false, via: 'none', reason: 'session-suppressed' }
      }

      const api = stripApi()
      if (api) {
        // 主体侧用户已关闭 → 不弹（但**不报错**，也不算失败）
        if (isDismissed()) return { shown: false, via: 'none', reason: 'dismissed' }

        const ok = safeCall(() => {
          if (opts2.append && typeof api.append === 'function') {
            return api.append(body, { sessionId: sid })
          }
          if (typeof api.show !== 'function') return false
          return api.show(body, {
            sessionId: sid,
            sticky: Boolean(opts2.sticky),
            durationMs: Number(opts2.durationMs) || 0,
          })
        }, false)

        if (ok === false) return { shown: false, via: 'none', reason: 'strip-rejected' }

        // ② 互斥：一旦横条承载流式，气泡模式即让位
        mode = MODE.STRIP
        currentKey = contentKey(body)
        return { shown: true, via: 'strip' }
      }

      // 降级：无横条 → 回落气泡
      noteDegrade('window.' + STRIP_GLOBAL + ' 不存在')
      return this.pushBubble(text, opts2)
    },

    /**
     * ② 推一段"说话"内容到气泡（与横条互斥）。
     *
     * 互斥规则（**同一内容不同时弹**）：
     *   - 若横条正在承载**同一条内容** → 拒绝重复弹气泡；
     *   - 若内容不同 → 允许，并切换占用模式为 bubble。
     */
    pushBubble(text, opts2 = {}) {
      const body = String(text || '')
      if (!body.trim()) return { shown: false, via: 'none', reason: 'empty-text' }

      const key = contentKey(body)
      // 同一内容已由横条承载 → 不再弹气泡（验收 ②）
      if (mode === MODE.STRIP && currentKey === key) {
        return { shown: false, via: 'none', reason: 'same-content-on-strip' }
      }

      const api = bubbleApi()
      if (!api) return { shown: false, via: 'none', reason: 'no-bubble-api' }

      const sid = String(opts2.sessionId || '')
      const ok = safeCall(() => api.show(body, {
        durationMs: Number(opts2.durationMs) || 0,
        agentId: sid,
        accent: String(opts2.accent || ''),
      }))

      if (ok === false) return { shown: false, via: 'none', reason: 'bubble-rejected' }

      // 切到气泡模式：横条应让位（内容不重叠）
      if (mode === MODE.STRIP) {
        const sApi = stripApi()
        safeCall(() => sApi && typeof sApi.hide === 'function' && sApi.hide())
      }
      mode = MODE.BUBBLE
      currentKey = key
      return { shown: true, via: 'bubble' }
    },

    /** 收尾：清空窗位（流式结束 / 会话结束）。 */
    clear(opts2 = {}) {
      const api = stripApi()
      if (api) safeCall(() => api.hide && api.hide())
      else safeCall(() => { const b = bubbleApi(); if (b && b.hide) b.hide() })
      if (opts2.resetKey !== false) currentKey = ''
      mode = MODE.IDLE
    },

    /**
     * ③ 请求主体应用横条主题。
     *
     * 插件**不**直接改 DOM/CSS 类 —— 只调主体的 `applyStyle`。
     * 主体负责把它落到 settings 的 `live2d_strip_style`（别名 `pet_strip_style`）
 * 并经 `settings_changed` 热应用
     * （与 `live2d_bubble_style` 完全同一条通路）。
     *
     * @returns {{applied:boolean, styleId:string|null, reason?:string}}
     */
    applyStyle(styleId) {
      const wanted = String(styleId || '').trim()
      const api = stripApi()
      if (!api || typeof api.applyStyle !== 'function') {
        return { applied: false, styleId: null, reason: 'strip-unavailable' }
      }
      const got = safeCall(() => api.applyStyle(wanted), null)
      return { applied: got != null, styleId: got == null ? null : String(got) }
    },

    /** 只读诊断。 */
    diagnostics() {
      const api = stripApi()
      return {
        mode,
        current_key: currentKey,
        has_strip: api !== null,
        has_bubble: bubbleApi() !== null,
        dismissed: isDismissed(),
        suppressed_sessions: [...suppressedSessions],
        strip_info: safeCall(() => (api && typeof api.info === 'function' ? api.info() : null), null),
      }
    },
  }
}

/**
 * 供主体侧参考的**最小实现骨架**（不是本插件的运行代码）。
 *
 * 放在这里是为了让契约可执行、可对照：主体实现照这个形状填即可满足上述契约。
 * 本插件**不会**调用这个函数 —— 它只是文档的一部分（导出以便单测验证契约形状）。
 *
 * @param {object} host `{show, append, hide, isVisible, isDismissed, setEnabled, applyStyle, info}`
 *   主体自己的实现细节（DOM、拖动、持久化）。
 */
export function describeStripContract(host = {}) {
  const required = ['show', 'append', 'hide', 'isVisible', 'isDismissed', 'setEnabled', 'applyStyle', 'info']
  return {
    global: STRIP_GLOBAL,
    styleKey: STRIP_STYLE_KEY,
    styleKeys: [...STRIP_STYLE_KEYS],
    required_methods: required,
    missing: required.filter((m) => typeof host[m] !== 'function'),
    // 契约要求：任何方法都不得抛
    must_not_throw: true,
  }
}
