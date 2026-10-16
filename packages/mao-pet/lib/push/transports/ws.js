/**
 * WS transport —— 6.5 的后半程（"先 HTTP 轮询跑通，再上 WS"）。
 *
 * ★ 重要设计说明（与交接单措辞的必要澄清）
 * ---------------------------------------------------------------
 * 交接单 6.5 写"复用现有 `pet_event_service` WS，不要另建连接层"。
 * 经源码核查：`pet_event_service` 是**只出（publish-only）**通道 ——
 * 它的 `serve(websocket)`（`routes/companion.py:153`）只负责把后端已有事件
 * 推给已连接的渲染端，**没有任何 client → server 的注入语义**。
 *
 * 所以"复用 WS"在后端内部（emit → pet_event_service.publish → WS 广播）
 * 那一段**本来就是复用的**，且由 HTTP ingest 自动继承 —— 我们 POST 一下，
 * 桌宠就会经由**同一条既有 WS** 收到 `agent_phase`。
 *
 * 结论：插件侧**不需要**为了"复用 WS"而自己维持一条 WS 长连接。
 * HTTP ingest 已经是"复用现有 WS"的正确形态，且更简单、更健壮
 * （无重连状态机、无连接泄漏）。本文件保留一个**可选**的 WS 直连实现，
 * 仅用于排障/降级演练：当 HTTP 端点不可达时，可直接把同样的 post-ready JSON
 * 文本发到桌宠 WS，观察后端是否接受。**默认不启用**。
 */

/**
 * @param {object} opts
 * @param {string} [opts.url]    缺省 `ws://127.0.0.1:8000/api/companion/ws`
 * @param {number} [opts.connectTimeoutMs]
 */
export function createWsTransport(opts = {}) {
  const url = String(opts.url || process.env.MAO_PET_WS || 'ws://127.0.0.1:8000/api/companion/ws')
  const connectTimeoutMs = Number(opts.connectTimeoutMs) > 0 ? Number(opts.connectTimeoutMs) : 3000
  let ws = null

  async function ensureSocket(WebSocketImpl) {
    if (ws && (ws.readyState === 1 /* OPEN */ || ws.readyState === 0 /* CONNECTING */)) return ws
    if (typeof WebSocketImpl !== 'function') {
      throw new Error('当前运行时没有 WebSocket 实现（Node <22 需注入）')
    }
    const sock = new WebSocketImpl(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS 连接超时')), connectTimeoutMs)
      sock.addEventListener?.('open', () => { clearTimeout(timer); resolve() })
      sock.addEventListener?.('error', (e) => { clearTimeout(timer); reject(new Error('WS 连接失败')) })
    })
    ws = sock
    return sock
  }

  return {
    url,

    async send(envelope) {
      const WebSocketImpl = opts.WebSocketImpl || globalThis.WebSocket
      let sock
      try {
        sock = await ensureSocket(WebSocketImpl)
      } catch (err) {
        return { ok: false, status: 0, error: String(err && err.message || err) }
      }
      try {
        // 桌宠 WS 的入站消息是我们约定的 JSON 文本（与 HTTP body 同形）
        sock.send(JSON.stringify(envelope))
        return { ok: true, status: 101, body: null }
      } catch (err) {
        ws = null
        return { ok: false, status: 0, error: String(err && err.message || err) }
      }
    },

    close() {
      try { ws?.close() } catch (err) {}
      ws = null
    },
  }
}
