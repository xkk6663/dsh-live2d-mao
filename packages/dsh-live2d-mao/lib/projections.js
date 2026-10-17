/**
 * 7.5 projections：**直读宿主 Cordis 服务**，不用 `session/follow`
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★ 交接单措辞的必要修正（第二条，务必保留）
 * ────────────────────────────────────────────────────────────────────────────
 * 技术方案说 7.5 要"走 `session/follow` Remote 拿 projections"。
 *
 * **插件形态下不成立**：`sessionProjections` 是**宿主侧 Cordis 服务**
 * （`Service` 子类，服务名 `"sessionProjections"`，
 * `dsh-session-projection/lib/index.js:52`），插件在自己的 `apply()` 里
 * **直接调用即可** —— 不需要 browser-session 凭据 cookie，也不需要端口发现。
 *
 * `session/follow` 是给**浏览器客户端**用的 Remote（走 WS + 凭据）；
 * 插件跑在宿主进程内，属于"内部人"。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 接口契约（源码确证）
 * ────────────────────────────────────────────────────────────────────────────
 * ```js
 * // dsh-session-projection/lib/index.js:127-132
 * stateOf(session, key) {
 *   const registration = this.registrations.get(key);
 *   if (registration === void 0) return void 0;      // :129 ★ 未注册 key → undefined
 *   this.materializeCells(session);
 *   return this.cellFor(registration, session).state;
 * }
 * ```
 *
 * 可读 key（本机已注册）：
 *   | key                | 注册方                 | 关键字段 |
 *   |--------------------|------------------------|----------|
 *   | `contextPressure`  | `dsh-token-meter:614`  | `{contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens?}` |
 *   | `tokenUsage`       | `dsh-token-meter:613`  | `{totals:{...}}` |
 *   | `contextBreakdown` | `dsh-token-meter:615`  | `{nodes:[...]}` |
 *   | `userQuestions`    | `dsh-user-questions:492`| `{questions:{active:[],settled:[]}}` |
 *   | `inbox`            | session-controller     | `{next-turn:[], next-step:[]}` |
 *
 * ⚠ **`stateOf` 对未注册 key 返回 `undefined`** —— 必须兜底，别把 undefined 塞进气泡。
 */

/** 本机已知的 projection key（**仅**用于文档与诊断，不做白名单限制）。 */
export const KNOWN_KEYS = Object.freeze([
  'contextPressure',
  'tokenUsage',
  'contextBreakdown',
  'userQuestions',
  'inbox',
])

/**
 * 安全读一个 projection。
 *
 * 三层兜底，缺一不可：
 *   1. 服务不存在（较老 dsh / 服务未就绪）→ null；
 *   2. key 未注册（`stateOf` 返回 undefined，:129）→ null；
 *   3. `stateOf` 自身抛异常 → null。
 * **绝不抛**：projection 是"锦上添花"的信息，不该因为读不到就把主链路拖垮。
 *
 * @param {object} service `ctx.sessionProjections`
 * @param {object} session
 * @param {string} key
 * @returns {any|null}
 */
export function readProjection(service, session, key) {
  if (!service || typeof service.stateOf !== 'function') return null
  if (!session) return null
  try {
    const state = service.stateOf(session, key)
    return state === undefined ? null : state
  } catch (err) {
    return null
  }
}

/**
 * 读多个 projection，返回 `{key: value|null}`。任意一项失败不影响其它项。
 */
export function readProjections(service, session, keys = KNOWN_KEYS) {
  const out = {}
  for (const key of keys) out[key] = readProjection(service, session, key)
  return out
}

/**
 * `contextPressure` → 桌宠可展示的**短**上下文占用摘要。
 *
 * 字段名按 `dsh-token-meter` 的 schema（`:469-472` 的
 * `key:"contextPressure"`, `init:()=>({surfaceTokens:0})`）逐字取，
 * 但**每个字段都做存在性与类型兜底**（schema 有可选字段）。
 *
 * @param {object} view `readProjection(..., 'contextPressure')`
 * @returns {object|null} `{pressure?, window?, surface?, percent?}`
 */
export function summarizeContextPressure(view) {
  if (!view || typeof view !== 'object') return null
  const out = {}

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  const pressure = num(view.pressureTokens)
  const windowSize = num(view.contextWindow)
  const surface = num(view.surfaceTokens)
  const sampled = num(view.sampledSurfaceTokens)

  if (pressure !== null) out.pressure = pressure
  if (windowSize !== null) out.window = windowSize
  if (surface !== null) out.surface = surface
  if (sampled !== null) out.sampled_surface = sampled

  // 百分比只在 window 有效且 > 0 时算 —— 除零会产出 Infinity，
  // 那东西进了 JSON 会变成 null，到了桌宠就成 NaN 渲染，不如不给。
  if (windowSize !== null && windowSize > 0) {
    const basis = pressure !== null ? pressure : surface
    if (basis !== null) {
      out.percent = Math.round((basis / windowSize) * 1000) / 10
    }
  }

  return Object.keys(out).length ? out : null
}

/**
 * `tokenUsage` → 简短用量摘要（总分）。
 * schema：`{totals: {...}}`（`dsh-token-meter:613`）。
 */
export function summarizeTokenUsage(view) {
  if (!view || typeof view !== 'object') return null
  const totals = view.totals && typeof view.totals === 'object' ? view.totals : null
  if (!totals) return null
  const out = {}
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  // 常见字段名都试一遍（schema 里是 totals 内的自由对象）
  for (const [src, dst] of [
    ['input', 'in'], ['inputTokens', 'in'],
    ['output', 'out'], ['outputTokens', 'out'],
    ['cacheRead', 'cache_read'], ['cachedInputTokens', 'cache_read'],
    ['total', 'total'], ['totalTokens', 'total'],
  ]) {
    const v = num(totals[src])
    if (v !== null && out[dst] === undefined) out[dst] = v
  }
  return Object.keys(out).length ? out : null
}

/** `inbox` → pending 条数（含 next-turn / next-step）。 */
export function summarizeInbox(view) {
  if (!view || typeof view !== 'object') return null
  const turn = Array.isArray(view['next-turn']) ? view['next-turn'].length : 0
  const step = Array.isArray(view['next-step']) ? view['next-step'].length : 0
  if (!turn && !step) return null
  return { next_turn: turn, next_step: step }
}

/**
 * 汇总成一份可推给桌宠的"投影摘要"（**只含短字段**）。
 *
 * @param {object} service
 * @param {object} session
 * @returns {object} 可能为空对象（读不到任何东西时）
 */
export function summarizeAll(service, session) {
  const out = {}
  const pressure = summarizeContextPressure(readProjection(service, session, 'contextPressure'))
  if (pressure) out.context = pressure
  const usage = summarizeTokenUsage(readProjection(service, session, 'tokenUsage'))
  if (usage) out.usage = usage
  const inbox = summarizeInbox(readProjection(service, session, 'inbox'))
  if (inbox) out.inbox = inbox
  return out
}
