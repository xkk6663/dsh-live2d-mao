/**
 * 无依赖小工具。刻意不引第三方包（D1 精神：只引必要的东西；
 * 本插件整棵树零 runtime dependencies）。
 */

/** 截断字符串到 n 个字符（按码位，不切碎代理对）。 */
export function clampStr(value, n) {
  const s = String(value ?? '')
  if (!s) return ''
  const max = Number(n)
  if (!Number.isFinite(max) || max <= 0) return s
  // 用 Array.from 按码位切，避免把 emoji 的代理对切成乱码
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max).join('')
}

/**
 * 错误信息截断（默认 200）—— 与后端 `state["error"] = err[:200]` 对齐。
 * 额外把换行压成空格：桌宠气泡是单行渲染，多行会把布局顶坏。
 */
export function clampError(value, n = 200) {
  return clampStr(String(value ?? '').replace(/\s+/g, ' ').trim(), n)
}

/** 安全整数转换（facts 里大量"可能是字符串的数字"）。 */
export function toInt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** 安全执行，失败返回 fallback。用于所有"绝不能让插件拖垮宿主"的边界。 */
export function safeCall(fn, fallback = undefined) {
  try {
    return fn()
  } catch (err) {
    return fallback
  }
}

/** 简易深拷贝（只处理 JSON 安全结构；facts/state 都是）。 */
export function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (err) {
    return null
  }
}
