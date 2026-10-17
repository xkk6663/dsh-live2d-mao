/**
 * 宿主侧横条远程代理：把 `__mioPetStrip` 的动作转成 `POST /api/plugin/dsh/strip`。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么必须有这一层（本次补齐的"最后一公里"，别删）
 * ────────────────────────────────────────────────────────────────────────────
 * 横条 API `window.__mioPetStrip` 只存在于**桌宠窗口**。而插件有三个位置互不相通：
 *
 *   - 插件**代码**跑在 DSH 的 Node 子进程（宿主侧）—— `ELECTRON_RUN_AS_NODE=1`，
 *     没有 electron、更没有桌宠窗口的 window；
 *   - 插件的**注入行**跑在 **DSH Web GUI 窗口** —— 那里也没有 `__mioPetStrip`
 *     （那是桌宠窗口的核心 API，不是 DSH GUI 的）；
 *   - `__mioPetStrip` 在**桌宠 Electron 窗口**里。
 *
 * ⇒ 宿主侧 `createStripController` 直接查 `globalThis.__mioPetStrip` 恒为 null，
 *   横条内容**永远送不出去**，7.6 在真机上只会静默降级成气泡 = 该形态等于没落地。
 *
 * 正确链路（与既有 `agent_stream` 同一思路，不新造概念）::
 *
 *   插件(宿主) → POST /api/plugin/dsh/strip → 总线 agent_bus_service.strip()
 *     → WS `agent_strip` → 桌宠窗口 socket.onmessage → applyAgentStrip()
 *     → window.__mioPetStrip
 *
 * 本代理只做最后一段的反向端点调用；**不缓存状态**（横条的"已关闭/皮肤/位置"
 * 都归主体持久化，插件侧只在会话内做抑制编排）。
 */

/** 横条动作端点路径（与后端 routes.plugin_strip 对应）。 */
export const STRIP_PATH = '/api/plugin/dsh/strip'

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]   缺省 `MAO_PET_BACKEND` 环境变量，再缺省 8000
 * @param {number} [opts.timeoutMs] 单次请求超时，缺省 3000
 * @param {string} [opts.path]      端点路径（测试可覆盖）
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试可 mock）
 * @param {object} [opts.logger]
 */
export function createStripRemote(opts = {}) {
  const baseUrl = String(
    opts.baseUrl || process.env.MAO_PET_BACKEND || 'http://127.0.0.1:8000',
  ).replace(/\/+$/, '')
  const path = String(opts.path || STRIP_PATH)
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const logger = opts.logger || { info() {}, warn() {}, debug() {} }
  const url = baseUrl + path

  /**
   * 发一条动作。**永不抛**（契约：横条通道任何方法都不得把调用方带崩）。
   *
   * @returns {Promise<{ok:boolean, delivered?:boolean, status?:number, error?:string}>}
   */
  async function send(body) {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, error: 'no-fetch' }
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      })
      let parsed = null
      try { parsed = await res.json() } catch (_) { parsed = null }
      if (!res.ok) {
        // 400/403/422 都属"后端明确拒绝"——记一条 debug 即可，不刷 warn：
        // 旧后端没有这个路由（404）是**部署态**而非插件 bug，重试也没用。
        logger.debug?.('[dsh-live2d-mao] strip 被后端拒绝 status=' + res.status)
        return { ok: false, status: res.status, error: 'http-' + res.status }
      }
      return {
        ok: true,
        status: res.status,
        delivered: parsed && typeof parsed.delivered === 'boolean' ? parsed.delivered : true,
      }
    } catch (err) {
      logger.debug?.('[dsh-live2d-mao] strip 请求失败：' + String((err && err.message) || err))
      return { ok: false, error: String((err && err.name) || 'error') }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // ── 契约方法 ──────────────────────────────────────────────────────────
  // ⚠ 契约里 show/append 返回 **boolean**（同步）。远程调用天然是异步的，
  //   故这里采用**乐观返回**：请求已发出即返回 true，真实结果走日志/诊断。
  //   这是刻意的取舍——编排层需要同步判定"是否占用窗位"来做气泡互斥，
  //   若返回 Promise 会让互斥状态机变成异步，复杂度陡增且容易出竞态。
  //   "后端真的收到了吗"由 webServer 侧的 /dsh-live2d-mao/status 诊断暴露。
  return {
    url,
    send,

    show(text, o = {}) {
      const body = String(text || '')
      if (!body.trim()) return false
      send({
        kind: 'show',
        text: body,
        sessionId: String(o.sessionId || ''),
        sticky: Boolean(o.sticky),
        durationMs: Number(o.durationMs) || 0,
      }).catch(() => {})
      return true
    },

    append(text, o = {}) {
      const body = String(text || '')
      if (!body.trim()) return false
      send({
        kind: 'append',
        text: body,
        sessionId: String(o.sessionId || ''),
      }).catch(() => {})
      return true
    },

    hide() {
      send({ kind: 'hide' }).catch(() => {})
    },

    /**
     * 宿主侧**无从得知**桌宠窗口里的真实可见性/关闭态
     * （那是主体 localStorage 的事，跨进程读不到）。
     * 故如实返回保守值：不假装知道。编排层的抑制逻辑不依赖它
     * （用自己的 suppressedSessions + 主体的 show 返回 false 来判定）。
     */
    isVisible() { return false },
    isDismissed() { return false },
    setEnabled() {},

    applyStyle(styleId) {
      const id = String(styleId || '').trim()
      if (!id) return null
      send({ kind: 'style', styleId: id }).catch(() => {})
      return id
    },

    info() {
      return { url, transport: 'http', local: false }
    },
  }
}
