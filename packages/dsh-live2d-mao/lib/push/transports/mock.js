/**
 * 测试用 mock transport —— 记录所有信封，可编程返回成功/失败序列。
 *
 * 放在 `lib/` 而非 `test/`：它是**被测对象的合法注入点**（传输无关设计的直接产物），
 * 也让 6.5 的"端点未上线"期间仍能端到端验证插件侧正确性。
 * 零副作用、不碰网络。
 */
export function createMockTransport(opts = {}) {
  const sent = []
  // 可编程结果队列；耗尽后回落到 opts.defaultResult（缺省成功）
  const scripted = Array.isArray(opts.scripted) ? [...opts.scripted] : []
  const defaultResult = opts.defaultResult || { ok: true, status: 200, body: { ok: true } }

  return {
    sent,
    /** 按顺序取一个脚本化结果；用于测退避/恢复。 */
    async send(envelope) {
      sent.push(envelope)
      const next = scripted.length ? scripted.shift() : defaultResult
      if (typeof next === 'function') return next(envelope)
      if (next instanceof Error) throw next
      return next
    },
    /** 便捷断言辅助：最近一次发送的信封。 */
    get last() {
      return sent.length ? sent[sent.length - 1] : null
    },
    get count() {
      return sent.length
    },
    clear() {
      sent.length = 0
    },
  }
}
