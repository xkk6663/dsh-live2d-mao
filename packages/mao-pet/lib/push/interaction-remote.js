/**
 * 交互回路远程客户端：审批 / 提问的「上报 → 轮询 → resolve」。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要这一层（M7 2.2/2.3 的"最后一公里"回传）
 * ────────────────────────────────────────────────────────────────────────────
 * DSH 的 `approval/request` 是 waterfall，插件 `decide()` 的**返回值就是最终结果**，
 * 必须"阻塞"等用户点击；但用户点击发生在**桌宠窗口**（另一个进程）。故需要一条
 * 「桌宠 → 后端 → 插件」的回传通道：
 *
 *   插件 decide() 挂起 ──POST /api/plugin/dsh/interaction──▶ 后端 pending 表
 *   桌宠弹按钮 → 用户点 ──POST /interaction/{id}/answer──▶ 后端更新 result
 *   插件轮询 ──GET /interaction/{id}──▶ 拿到 outcome → resolve decide()
 *
 * 取结果用**轮询**（用户裁决：简单可靠），间隔 500ms，超时由 approval.js 的
 * raceTimeout 兜底（120s）。本层**永不抛**：后端没起/超时都返回 null（→ cancelled，
 * fail-closed，绝不放行）。
 *
 * 只依赖 Node 内置 fetch（零依赖，D1 不引 TTS 相关）。
 */

const INTERACTION_PATH = '/api/plugin/dsh/interaction'

/** 轮询间隔（毫秒）。审批/提问场景 0.5s 延迟可接受。 */
export const POLL_MS = 500

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]  缺省 `MAO_PET_BACKEND`，再缺省 8000
 * @param {number} [opts.pollMs]   轮询间隔，缺省 500
 * @param {number} [opts.maxMs]    单次交互最长等待，缺省 120000（对齐 approval timeout）
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试可 mock）
 * @param {object} [opts.logger]
 */
export function createInteractionRemote(opts = {}) {
  const baseUrl = String(
    opts.baseUrl || process.env.MAO_PET_BACKEND || 'http://127.0.0.1:8000',
  ).replace(/\/+$/, '')
  const pollMs = Math.max(100, Number(opts.pollMs) || POLL_MS)
  const maxMs = Math.max(1000, Number(opts.maxMs) || 120_000)
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const logger = opts.logger || { info() {}, warn() {}, debug() {} }

  if (typeof fetchImpl !== 'function') {
    // 无 fetch 时所有方法都返回 null（调用方按"无人应答"处理）
    return {
      url: baseUrl + INTERACTION_PATH,
      async openApproval() { return null },
      async openQuestion() { return null },
    }
  }

  const base = baseUrl + INTERACTION_PATH

  async function post(path, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => { try { controller.abort() } catch (_) {} }, 3000) : null
    try {
      const res = await fetchImpl(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      })
      let parsed = null
      try { parsed = await res.json() } catch (_) { parsed = null }
      return { ok: Boolean(res && res.ok), status: res && res.status, body: parsed }
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function get(path) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => { try { controller.abort() } catch (_) {} }, 3000) : null
    try {
      const res = await fetchImpl(base + path, {
        method: 'GET',
        signal: controller ? controller.signal : undefined,
      })
      let parsed = null
      try { parsed = await res.json() } catch (_) { parsed = null }
      return { ok: Boolean(res && res.ok), status: res && res.status, body: parsed }
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 轮询直到有结果或超时。返回结果值或 null（= 无人应答/后端不可达）。 */
  async function waitForResult(requestId) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      const r = await get('/' + requestId)
      if (r.ok && r.body && r.body.ok && r.body.answered) {
        return r.body.result
      }
      if (r.ok && r.body && r.body.ok === false) {
        // 已过期/不存在：无人应答
        return null
      }
      await new Promise((res) => setTimeout(res, pollMs))
    }
    return null // 超时
  }

  return {
    url: base,

    /**
     * 打开一个审批请求并阻塞等待结果。
     *
     * @param {object} desc describeApproval(req) 的短字段描述
     * @returns {Promise<string|null>} outcome（'allowed-once'/'rejected'/'cancelled'），
     *   null = 无人应答/后端不可达（调用方按 cancelled 处理）
     */
    async openApproval(desc) {
      const r = await post('', {
        kind: 'approval',
        payload: desc && typeof desc === 'object' ? desc : {},
      })
      if (!r.ok || !r.body || !r.body.ok) {
        logger.debug?.('[Mao-pet] 交互上报失败（审批）：' + (r.status || r.error))
        return null
      }
      return waitForResult(r.body.request_id)
    },

    /**
     * 打开一个提问并阻塞等待答案。
     *
     * @param {object} desc describeQuestions(entry) 的短字段描述
     * @returns {Promise<Array|null>} answers `[{id, selected, custom?}]`，null = 无人应答
     */
    async openQuestion(desc) {
      const r = await post('', {
        kind: 'question',
        payload: desc && typeof desc === 'object' ? desc : {},
      })
      if (!r.ok || !r.body || !r.body.ok) {
        logger.debug?.('[Mao-pet] 交互上报失败（提问）：' + (r.status || r.error))
        return null
      }
      return waitForResult(r.body.request_id)
    },
  }
}
