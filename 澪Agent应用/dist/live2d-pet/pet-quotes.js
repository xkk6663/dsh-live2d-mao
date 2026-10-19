/* pet-quotes.js — 模型专属台词库加载器（M2：大肥鱼名言录）
 *
 * 定位：把「空闲自语」的台词从**代码里的通用池**升级成**模型自己的数据文件**。
 *   - 数据位置：./quotes/<modelId>.json，找不到就回退 ./quotes/default.json；
 *   - 零依赖：只暴露 window.__mioPetQuotes，不引用插件、不改渲染主逻辑；
 *   - 结构化：每条可带 expression（直接播的模型表情）与 motion（语义动作 hint），
 *     让"说话"和"表情/动作"配成一次完整的表演，而不是只有文字；
 *   - 24h 去重：localStorage 记已说过的 id，跨天自动清空（不是只排除"上一句"）；
 *   - 静默降级：文件缺失 / 内容非法 / 网络失败，一律返回 null，调用方回退旧内容池。
 *
 * ⚠ 后端静态路由对**不存在的文件返回 index.html（200 + text/html）**，
 *   所以不能只看 res.ok，必须校验 content-type 或让 JSON.parse 抛错后兜底。
 */
(function () {
  if (window.__mioPetQuotes) return
  'use strict'

  // 场景词汇表（when 字段的合法值）。
  //   any    任意时刻
  //   idle   没在忙（!busy）
  //   busy   Agent 正在干活
  //   night  深夜 23:00-05:59（与 live2d-pet.js isNightHour 同口径）
  //   lonely 长时间没人理（idleMs >= 15min）
  //   late   深夜加班 23:00-02:59（night 的子集，单开一池给"还在熬"的语境）
  //   dawn   清晨 05:00-07:59
  //   poke   被连点（caller 用 scene:'poke' 强制）
  //   grind  同一任务连续跑很久（caller 用 scene:'grind' 强制）
  var WHEN_VALUES = {
    any: 1, idle: 1, busy: 1, night: 1, lonely: 1,
    late: 1, dawn: 1, poke: 1, grind: 1,
  }
  var SEEN_KEY = 'mio-pet-quotes-seen'
  var LONELY_MS = 15 * 60 * 1000

  var state = {
    modelId: '',
    source: '',
    lines: [],
    loadedAt: 0,
    error: '',
  }

  function nowDay() {
    var d = new Date()
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function readSeen() {
    try {
      var raw = window.localStorage.getItem(SEEN_KEY)
      if (!raw) return { day: nowDay(), ids: [] }
      var parsed = JSON.parse(raw)
      if (!parsed || parsed.day !== nowDay() || !Array.isArray(parsed.ids)) {
        return { day: nowDay(), ids: [] }
      }
      return { day: parsed.day, ids: parsed.ids.map(String) }
    } catch (_) {
      return { day: nowDay(), ids: [] }
    }
  }

  function writeSeen(seen) {
    try {
      // 只保留最近 300 条，避免 localStorage 无限长
      var ids = seen.ids.slice(-300)
      window.localStorage.setItem(SEEN_KEY, JSON.stringify({ day: seen.day, ids: ids }))
    } catch (_) {}
  }

  function normalizeLines(raw) {
    var list = raw && Array.isArray(raw.lines) ? raw.lines : []
    var out = []
    for (var i = 0; i < list.length; i++) {
      var item = list[i]
      if (!item || typeof item !== 'object') continue
      var text = String(item.text || '').trim()
      if (!text) continue
      var when = String(item.when || 'any')
      if (!WHEN_VALUES[when]) when = 'any'
      var weight = Number(item.weight)
      out.push({
        id: String(item.id || ('line-' + i)),
        text: text,
        when: when,
        weight: isFinite(weight) && weight > 0 ? weight : 1,
        expression: String(item.expression || '').trim(),
        motion: String(item.motion || '').trim(),
      })
    }
    return out
  }

  async function fetchJson(url) {
    var res = await window.fetch(url, { cache: 'no-store' })
    if (!res || !res.ok) throw new Error('http ' + (res && res.status))
    var type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '')
    // 后端 404 兜底会返回 index.html（200 + text/html），这里显式拦掉
    if (type && type.indexOf('json') < 0) throw new Error('not json: ' + type)
    return await res.json()
  }

  /**
   * 加载某个模型的台词库。失败时回退 default.json，再失败则 state.lines 为空。
   * @param {string} modelId
   * @returns {Promise<boolean>} 是否拿到可用台词
   */
  async function load(modelId) {
    var id = String(modelId || '').trim()
    if (state.lines.length && state.modelId === id) return true
    state.modelId = id
    state.error = ''
    var candidates = []
    if (id && id !== 'default') candidates.push('./quotes/' + encodeURIComponent(id) + '.json')
    candidates.push('./quotes/default.json')
    for (var i = 0; i < candidates.length; i++) {
      try {
        var raw = await fetchJson(candidates[i])
        var lines = normalizeLines(raw)
        if (!lines.length) throw new Error('empty lines')
        state.lines = lines
        state.source = candidates[i]
        state.loadedAt = Date.now()
        return true
      } catch (err) {
        state.error = String((err && err.message) || err)
      }
    }
    state.lines = []
    state.source = ''
    return false
  }

  function pickWeighted(pool, excludeIds) {
    var usable = []
    for (var i = 0; i < pool.length; i++) {
      if (excludeIds.indexOf(pool[i].id) < 0) usable.push(pool[i])
    }
    // 全都说过了：允许重说，避免"没话可说"
    if (!usable.length) usable = pool
    var total = 0
    for (var j = 0; j < usable.length; j++) total += usable[j].weight
    var roll = Math.random() * total
    var acc = 0
    var chosen = usable[usable.length - 1]
    for (var k = 0; k < usable.length; k++) {
      acc += usable[k].weight
      if (roll <= acc) { chosen = usable[k]; break }
    }
    return chosen
  }

  /**
   * 一条台词是否命中当前场景。
   * @param {string} when
   * @param {object} c 归一化后的上下文 { busy, night, lonely, late, dawn, scene }
   */
  function whenMatches(when, c) {
    if (when === 'any') return true
    if (when === 'idle') return !c.busy
    if (when === 'busy') return c.busy
    if (when === 'night') return c.night
    if (when === 'lonely') return c.lonely
    if (when === 'late') return c.late
    if (when === 'dawn') return c.dawn
    if (when === 'poke') return c.scene === 'poke'
    if (when === 'grind') return c.scene === 'grind'
    return true
  }

  /**
   * 按场景抽一条。
   * @param {object} ctx { busy, night, idleMs, hour, scene, allowExpressions: string[] }
   *   scene 非空时**只取该场景**（poke / grind 这类"由 caller 明确要求"的场景），
   *   该场景池为空才退回普通过滤 —— 保证"加了新池但 JSON 还没跟上"时不会哑掉。
   * @returns {{id:string,text:string,expression:string,motion:string}|null}
   */
  function pick(ctx) {
    if (!state.lines.length) return null
    var c = ctx || {}
    var hour = Number(c.hour)
    if (!isFinite(hour)) hour = new Date().getHours()
    var norm = {
      busy: !!c.busy,
      night: !!c.night,
      late: hour >= 23 || hour < 3,
      dawn: hour >= 5 && hour < 8,
      lonely: !c.busy && (Number(c.idleMs) || 0) >= LONELY_MS,
      scene: String(c.scene || ''),
    }
    var allowed = Array.isArray(c.allowExpressions) ? c.allowExpressions.map(String) : []

    function collect(strict) {
      var pool = []
      for (var i = 0; i < state.lines.length; i++) {
        var line = state.lines[i]
        var ok = strict ? (line.when === norm.scene) : whenMatches(line.when, norm)
        if (!ok) continue
        // 表情白名单：模型没这个表情就丢掉该字段（台词照说，不因为配错而失声）
        if (line.expression && allowed.length && allowed.indexOf(line.expression) < 0) {
          pool.push({ id: line.id, text: line.text, when: line.when, weight: line.weight, expression: '', motion: line.motion })
          continue
        }
        pool.push(line)
      }
      return pool
    }

    var pool = norm.scene ? collect(true) : []
    if (!pool.length) pool = collect(false)
    if (!pool.length) return null
    var seen = readSeen()
    var chosen = pickWeighted(pool, seen.ids)
    if (seen.ids.indexOf(chosen.id) < 0) seen.ids.push(chosen.id)
    writeSeen(seen)
    return {
      id: chosen.id,
      text: chosen.text,
      expression: chosen.expression || '',
      motion: chosen.motion || '',
    }
  }

  window.__mioPetQuotes = {
    load: load,
    pick: pick,
    count: function () { return state.lines.length },
    state: function () {
      return {
        modelId: state.modelId,
        source: state.source,
        count: state.lines.length,
        error: state.error,
        loadedAt: state.loadedAt,
      }
    },
    resetSeen: function () {
      try { window.localStorage.removeItem(SEEN_KEY) } catch (_) {}
    },
  }
})()
