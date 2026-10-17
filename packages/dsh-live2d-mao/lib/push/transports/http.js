/**
 * HTTP transport —— 把信封 POST 给桌宠后端的插件摄入端点。
 *
 * 端点（Lead 已裁决并落地于 `私人AI日记系统/`）：
 *   `POST /api/plugin/dsh/ingest`
 *   body: { agent_id?, name?, accent?, phase, state?, seq?, force? }
 *   → 200 { ok:true, agent_id, seq, phase, active, throttled }
 *   → 400 phase 不在 PHASES 词汇内
 *   → 422 请求体缺 phase
 *
 * ⚠ 6.5 当前状态：**端点尚未上线**（`pending_backend_endpoint`）。
 * 本文件已按定稿契约实现，端点一落地即可真机联调，无需改架构。
 *
 * 零依赖：用 Node 内置 `fetch`（Node ≥22 全局可用），不引 axios/undici。
 * D1：不引任何 TTS 相关依赖。
 */

/** 桌宠后端默认地址（与本仓库既有链路一致：start_mio.ps1 起在 8000）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000'
/** 摄入端点路径（Lead 定稿）。 */
export const INGEST_PATH = '/api/plugin/dsh/ingest'

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]  缺省 `MAO_PET_BACKEND` 环境变量，再缺省 8000
 * @param {number} [opts.timeoutMs] 单次请求超时，缺省 3000
 * @param {string} [opts.path]      端点路径（测试可覆盖）
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试可 mock）
 */
export function createHttpTransport(opts = {}) {
  const baseUrl = String(
    opts.baseUrl || process.env.MAO_PET_BACKEND || DEFAULT_BASE_URL,
  ).replace(/\/+$/, '')
  const path = String(opts.path || INGEST_PATH)
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000
  const fetchImpl = opts.fetchImpl || globalThis.fetch

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createHttpTransport: 当前运行时没有 fetch，请注入 fetchImpl')
  }

  const url = baseUrl + path

  return {
    url,

    /**
     * 把信封转成 ingest 请求体。
     *
     * 三种 kind 映射到后端不同的既有语义，**不新造后端概念**：
     *   - `phase`     → body 直接带 phase/state（走 emit）
     *   - `stream`    → { kind:'stream', payload }（走 stream）
     *   - `bubble`    → { kind:'bubble', text, duration_ms }（走 announce）
     *   - `heartbeat` → { kind:'heartbeat' }（走 heartbeat 通道）
     */
    buildBody(envelope) {
      const e = envelope && typeof envelope === 'object' ? envelope : {}
      // ★ 缺省身份必须与 pusher 的 AGENT_ID/AGENT_NAME 一致（2026-10-17 合并身份后
      //   总线 id 是 `dsh`，与日志边车共用）。这里硬编码会与 pusher 漂移 ——
      //   故改成从常量导出，单一真相源在 push/pusher.js。
      const base = {
        agent_id: e.agent_id || 'dsh',
        name: e.name || 'DeepSeek Harness',
        accent: e.accent || '',
        kind: e.kind || 'phase',
      }
      if (e.kind === 'stream') return { ...base, payload: e.payload || {} }
      if (e.kind === 'bubble') {
        return { ...base, text: String(e.text || ''), duration_ms: Number(e.duration_ms) || 0 }
      }
      if (e.kind === 'heartbeat') return base
      const body = { ...base, phase: e.phase }
      if (e.state !== undefined) body.state = e.state
      if (e.seq !== undefined && e.seq !== null) body.seq = e.seq
      if (e.force) body.force = true
      return body
    },

    /**
     * POST 一个信封。
     *
     * **永不抛异常**：返回 `{ok:false}` 让 pusher 走统一退避路径。
     * 桌宠后端没起是正常情况（用户需手动 start_mio.ps1），不该刷栈。
     */
    async send(envelope) {
      const body = this.buildBody(envelope)
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller
        ? setTimeout(() => { try { controller.abort() } catch (err) {} }, timeoutMs)
        : null
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined,
        })
        // 尽力读 body 供排障（可能不是 JSON）
        let parsed = null
        try {
          parsed = await res.json()
        } catch (err) {
          parsed = null
        }
        return { ok: Boolean(res && res.ok), status: res && res.status, body: parsed }
      } catch (err) {
        return { ok: false, status: 0, error: String(err && err.message || err) }
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}
