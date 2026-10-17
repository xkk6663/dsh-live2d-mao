/**
 * 7.1 逐 token 流式正文：`agent/assistant-stream`
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★ 交接单措辞的必要修正（Lead 已确认，务必保留此说明）
 * ────────────────────────────────────────────────────────────────────────────
 * 交接单 7.1 的验收写"打字机延迟 < 100ms（⚠ 日志通道只能事后回放，
 * **真实时必须走 `session/follow`**）"。
 *
 * **这条在插件形态下不成立，且不需要**：
 *   - `session/follow` 是给**浏览器客户端**用的 Remote —— 要走 WS + 浏览器会话凭据
 *     cookie + 端口发现；
 *   - 插件跑在 **DSH 宿主进程内**，`agent/assistant-stream` 是
 *     `this.dispatch.emit("agent/assistant-stream", { frame })`
 *     （`dsh-agent-loop/lib/index.js:1068`）的**进程内实时 dispatch**，
 *     没有写盘往返、没有轮询 —— **天然就是真增量**。
 *
 * 参照数据：现有日志边车通道的 p50 延迟是 **215ms**（事后回放），
 * 插件形态省掉整个写盘+跟随往返，快一个量级。
 * ⇒ **这是插件形态相对现有链路的实质性收益，应记入结论。**
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 帧结构（源码确证：`dsh-llm/lib/types/assistant-stream.js:31-128`）
 * ────────────────────────────────────────────────────────────────────────────
 * 帧是**紧凑记录（compact record）**，不是原始 delta：
 *   | record.type        | 字段                                          | 处理 |
 *   |--------------------|-----------------------------------------------|------|
 *   | `text-chunks`      | `{type,time0,index,dt:[],texts:[]}`           | ★ 正文，外发 |
 *   | `reasoning-chunks` | `{type,time0,index,dt:[],texts:[]}`           | ★ **丢弃** |
 *   | `tool-call-chunks` | `{type,time0,index,dt:[],id,name?,args:[]}`   | 不属正文，丢弃 |
 *   | `chunk`            | `{type,time,chunk:{...}}`                     | 见下 |
 *
 * `chunk.chunk.type === 'block-end'` 且 `block.type === 'text'` 时带**权威全文**，
 * 用于零丢字校正（`:102-107` 只作为 `chunk` 记录落库，不参与 run 合并）。
 *
 * 拼接规则（`expandAssistantStream`，:135-168）：`dt.length === texts.length - 1`
 * （`:437-439` 有硬校验）；第 0 块时间 = `time0`，第 i 块 = 前 i 个 dt 之和 + time0。
 *
 * ⚠ **`reasoning-chunks` 一律不外发**：推理草稿进桌宠气泡是明确越界。
 * 这是硬约束，本模块在**解析层**就把它们过滤掉（而不是靠调用方自觉）。
 */

/** 允许外发的帧类型白名单（**只有正文**）。 */
export const ALLOWED_FRAMES = Object.freeze(['text-chunks'])

/**
 * 解析一个 `agent/assistant-stream` 帧，产出可直接交给推送层的载荷。
 *
 * @param {object} frame  事件里的 `frame` 字段（紧凑记录）
 * @param {object} [ctxInfo] `{session, turn, step, seq}` 透传上下文
 * @returns {object|null} 可外发的 stream 载荷；**不可外发时返回 null**
 */
export function parseStreamFrame(frame, ctxInfo = {}) {
  if (!frame || typeof frame !== 'object') return null

  const type = String(frame.type || '')

  if (type === 'chunk') {
    // 原始块：只有 text 类型的 block-end 才带正文（权威全文，用于校正）
    return parseRawChunk(frame, ctxInfo)
  }

  // ★ 逐字白名单：reasoning-chunks / tool-call-chunks 在此被丢弃
  if (!ALLOWED_FRAMES.includes(type)) return null

  const texts = Array.isArray(frame.texts) ? frame.texts.filter((t) => typeof t === 'string') : null
  if (!texts || texts.length === 0) return null

  const time0 = Number.isSafeInteger(frame.time0) ? frame.time0 : null
  const dt = Array.isArray(frame.dt)
    ? frame.dt.filter((d) => Number.isSafeInteger(d))
    : []

  // 契约校验：dt.length 必须 === texts.length - 1（源码 :437-439 同一断言）。
  // 不满足说明帧被截断/畸形 —— **宁可不发，也不要发出时间轴错乱的打字机**。
  if (time0 === null || dt.length !== texts.length - 1) return null

  const finalText = texts.join('')
  return {
    session: str(ctxInfo.session),
    turn: ctxInfo.turn ?? null,
    step: ctxInfo.step ?? null,
    seq: ctxInfo.seq ?? null,
    index: Number.isSafeInteger(frame.index) ? frame.index : 0,
    frame: 'text-chunks',
    time0,
    dt,
    texts,
    final_text: finalText,
    total_ms: totalMsOf(dt),
  }
}

/**
 * 原始 `chunk` 记录 → 载荷。
 *
 * 只认 `block-end` + `block.type === 'text'`：它是该文本块的**权威全文**，
 * 推送层可用它做"零丢字"收尾校正（对照 `dsh_adapter.py` 的 `final_text` 语义）。
 * `block-start` / `usage` / `finish` / `tool-call` 一律不外发。
 */
function parseRawChunk(frame, ctxInfo) {
  const inner = frame.chunk
  if (!inner || typeof inner !== 'object') return null
  if (String(inner.type || '') !== 'block-end') return null
  const block = inner.block
  if (!block || typeof block !== 'object') return null
  if (String(block.type || '') !== 'text') return null
  // ★ 推理块的 block-end 也走这里 —— 必须显式排除（防"正文块"判据被推理块骗过）
  const text = typeof block.text === 'string' ? block.text : ''
  if (!text) return null

  return {
    session: str(ctxInfo.session),
    turn: ctxInfo.turn ?? null,
    step: ctxInfo.step ?? null,
    seq: ctxInfo.seq ?? null,
    index: Number.isSafeInteger(inner.index) ? inner.index : 0,
    frame: 'block-end',
    time0: Number.isSafeInteger(frame.time) ? frame.time : null,
    dt: [],
    texts: [],
    final_text: text,
    total_ms: 0,
  }
}

/** 时间轴总跨度：dt 之和（第 0 块时间 = time0，故总跨度就是 dt 求和）。 */
export function totalMsOf(dt) {
  let sum = 0
  for (const d of dt) sum += d
  return sum
}

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

/**
 * 逐会话的正文装配器：把多个 `text-chunks` run 拼成一段完整正文，
 * 并在收到 `block-end` 权威全文时做**校正**（防止增量丢字导致气泡尾巴不对）。
 *
 * 这是 7.1 的"零丢字"落点：增量用于**实时打字机**，权威全文用于**收尾校正**。
 */
export function createStreamAssembler(opts = {}) {
  /** 超过该长度即认为本轮正文已足够长，不再累积（防内存无界）。 */
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 200_000
  const bySession = new Map() // sessionId -> { text, blockText, seq }

  function bucket(sessionId) {
    let b = bySession.get(sessionId)
    if (!b) {
      b = { text: '', blockText: '', frames: 0 }
      bySession.set(sessionId, b)
    }
    return b
  }

  return {
    /**
     * 吃一个载荷（`parseStreamFrame` 的产物），返回累积状态。
     * @returns {{session:string, text:string, frames:number, authoritative:boolean}}
     */
    push(payload) {
      const sid = String((payload && payload.session) || '')
      const b = bucket(sid)
      b.frames += 1
      if (payload.frame === 'block-end') {
        // 权威全文：**覆盖**增量累积（增量可能丢字/重排）
        b.blockText = String(payload.final_text || '')
      } else if (Array.isArray(payload.texts)) {
        if (b.text.length + payload.final_text.length <= maxChars) {
          b.text += payload.final_text
        }
      }
      return {
        session: sid,
        text: b.text,
        frames: b.frames,
        authoritative: b.blockText.length > 0,
      }
    },

    /** 本轮最终正文：有权威全文就用它，否则用增量累积。 */
    finalText(sessionId) {
      const b = bySession.get(String(sessionId || ''))
      if (!b) return ''
      return b.blockText || b.text
    },

    /** 新轮次开始时调用：清空该会话的累积。 */
    reset(sessionId) {
      bySession.delete(String(sessionId || ''))
    },

    /** 只读诊断。 */
    snapshot() {
      const out = []
      for (const [sid, b] of bySession.entries()) {
        out.push({ session_id: sid, chars: (b.blockText || b.text).length, frames: b.frames })
      }
      return out
    },
  }
}
