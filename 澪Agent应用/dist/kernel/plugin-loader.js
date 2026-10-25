/* plugin-loader.js — 前端微内核 · 插件动态加载器（管理窗侧，唯一加载器）
 * ────────────────────────────────────────────────────────────────────────────
 * 契约出处：docs/插件市场-契约.md §3.1 / §3.2 / §3.3 / §3.4（唯一出处，改这里先改文档）
 *
 * 为什么要有它：
 *   以前插件是**写死在 dist/index.html 里的 <script> 标签** —— 装了才有、卸了还在、
 *   改了要重启。现在 dist/plugins/ 下的插件目录是可枚举的数据（清单 /api/plugin/market/catalog），
 *   由本文件按清单动态插 <script>、按清单动态拔掉。
 *
 * 加载顺序（契约硬约束，不得打乱）：
 *   kernel/plugin-registry.js → kernel/plugin-loader.js → plugins/pet/manifest.js(builtin)
 *     → …loader 异步加载清单内插件… → kernel/plugin-nav.js
 *   注意 loader **异步**抓清单，所以插件通常晚于 plugin-nav.js 落地。这不是 bug：
 *   plugin-nav 有 MutationObserver + 8s 轮询自愈，且本文件每次 load/unload 完成后
 *   都会主动 __mioPluginNav.refresh()，两条腿都保底。
 *
 * 暴露：window.__mioPluginLoader = { load, unload, reload, status, init, catalog }
 *
 * ★ 本文件**不认识任何具体插件**：插件是数据，路径来自清单的 entry/panel。
 * ★ 后端不可达时 fail-safe：只 console.warn，**绝不清空现有界面**（现有的 manifest、导航、
 *   设置 tab 一个都不动），等下一次刷新重试。
 * ────────────────────────────────────────────────────────────────────────────
 */
(function () {
  if (window.__mioPluginLoader) return

  var CATALOG_URL = '/api/plugin/market/catalog'
  var BASE = '/agent-app/'          // backend main.py 把 dist/ 挂在这里
  var ID_RE = /^[a-z0-9_-]{1,32}$/  // 契约 §1：agentId 格式
  var STYLE_ID = 'mio-plugin-loader-style'
  var SELECTOR = 'script[data-mio-plugin]'

  // 本文件自己的状态（status() 全量暴露，方便控制台一眼定位）
  var entries = {}          // agentId -> 最近一次确认「应当加载」的清单条目（unload 时用它清 DOM）
  var records = {}          // agentId -> { entry, panel, version, status, error, injectedAt }
  var inflight = null       // 进行中的 load() promise（幂等 + 防并发）
  var inflightForce = false // 该 promise 是不是 force 发起的（force 可以让后来的调用排队）
  var lastLoadAt = 0
  var lastError = ''
  var loadedOnce = false
  var selfCheckPending = false
  var retryTimer = null

  function warn(msg, extra) {
    try { console.warn('[plugin-loader] ' + msg, extra === undefined ? '' : extra) } catch (e) { /* ignore */ }
  }

  function reg() { return window.__mioPluginRegistry || null }

  /** 宿主固定导航（桌宠/设置）：插件卸载时**永远不许**误伤。
   *  与 plugin-nav.js 的 FIXED_NAV_ORDER 同源，但这里只在本地比较，不跨文件依赖。 */
  var FIXED_NAV = ['桌宠', '设置', '设置页', '设置面板']
  function isFixedNav(text) {
    for (var i = 0; i < FIXED_NAV.length; i++) if (text.indexOf(FIXED_NAV[i]) >= 0) return true
    return false
  }

  /** 清单里的相对路径 → 浏览器 URL。
   *  ★ entry 是相对 dist/ 的路径（如 "plugins/dsh/manifest.js"），必须逐段 encodeURIComponent：
   *    契约要求路径安全（防 ../ 与 // 逃逸），这里再兜一层 —— 绝对路径、协议、.. 一律拒绝，
   *    不合法的条目当作"没有 entry"，既不加载也不崩。
   */
  function pluginUrl(rel, version) {
    var p = String(rel || '').replace(/\\/g, '/')
    if (!p) return ''
    if (p.charAt(0) === '/' || p.indexOf('//') === 0 || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return ''
    var parts = p.split('/')
    var enc = []
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i]
      if (!seg || seg === '.' || seg === '..') return ''   // 只受契约里的相对路径
      enc.push(encodeURIComponent(seg))
    }
    var q = '?v=' + encodeURIComponent(String(version || '1.0.0'))
    return BASE + enc.join('/') + q
  }

  function findScript(agentId) {
    var all = document.querySelectorAll(SELECTOR)
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-mio-plugin') === agentId) return all[i]
    }
    return null
  }

  /** 插一个插件脚本。
   *  kind='manifest'   → 只带 data-mio-plugin（契约 §3.2 规定的幂等判据）
   *  kind='panel'      → 额外带 data-mio-plugin-mirror="panel"：它随 manifest 一起被拔掉，
   *                      但**不是**判断"该插件已加载"的依据（否则同一插件两个 tag 撞 agentId）
   */
  function injectScript(url, agentId, kind, version) {
    return new Promise(function (resolve) {
      var el = document.createElement('script')
      el.async = true
      el.src = url
      el.setAttribute('data-mio-plugin', agentId)
      el.setAttribute('data-mio-plugin-kind', kind)
      el.setAttribute('data-mio-plugin-version', String(version || ''))
      if (kind === 'panel') el.setAttribute('data-mio-plugin-mirror', 'panel')
      function done(ok, why) { resolve({ ok: ok, reason: why || '' }) }
      el.onload = function () { done(true) }
      // 脚本 404 时后端会 SPA 兜底返回 index.html → 浏览器报 MIME 错，走 onerror
      el.onerror = function () { done(false, '脚本加载失败（404 / MIME / 路径越界）') }
      ;(document.head || document.documentElement).appendChild(el)
    })
  }

  /** manifest 查询：manifest.js 若只写了 window.__mioPluginManifests[..] = {...}
   *  （现有插件就是这样，register 是可选的一行），registry 里可能没有它 ——
   *  所以两个来源都要看。
   */
  function manifestOf(agentId) {
    var ms = window.__mioPluginManifests || {}
    var m = ms[agentId] || null
    if (m) return m
    var r = reg()
    return r && r.get ? r.get(agentId) : null
  }

  // ── 设置页 tab 的「桥」样式 ─────────────────────────────────────────────────
  // #mioPluginSetBody 由 plugin-nav 按需创建，display:none 的内联样式写在它身上。
  // 插件的 tab 按钮却挂在 #mioSetTabs 上（比它早出现），所以 tab 只显示、点了却看不到内容。
  // 纯 CSS 桥：body 不是 hidden 时，插件 tab 的容器自动可见。不碰 nav 的 DOM 逻辑。
  function ensureBridgeStyle() {
    if (document.getElementById(STYLE_ID)) return
    var st = document.createElement('style')
    st.id = STYLE_ID
    st.textContent =
      '#mioSetBody:has(~ #mioPluginSetBody[style*="block"]) + #mioPluginSetBody,' +
      '#mioSetBody:has(~ #mioPluginSetBody:not([style*="none"])) ~ #mioPluginSetBody' +
      '{display:block !important}'
    ;(document.head || document.documentElement).appendChild(st)
  }

  // ── DOM 残留清理（契约 §3.1 unload：manifest + 脚本 + nav 按钮 + settingsTab）────
  function removeScripts(agentId) {
    var all = document.querySelectorAll(SELECTOR)
    var n = 0
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (el.getAttribute('data-mio-plugin') !== agentId) continue
      if (el.parentNode) el.parentNode.removeChild(el)
      n++
    }
    return n
  }

  /** 该插件的 manifest 可能有两个来源，取宽：
   *    · 最近一次确认应加载的清单条目（entries[id]）
   *    · 当前仍登记在 __mioPluginManifests 里的 manifest（脚本自己声明了 nav/settingsTab）
   */
  function manifestSources(agentId) {
    var out = []
    var m = manifestOf(agentId)
    if (m) out.push(m)
    var e = entries[agentId]
    if (e) out.push(e)
    return out
  }

  /** 移除该插件 append 的导航按钮。
   *  约定 [data-mio-plugin-nav="{id}"]；现有插件没打标记，所以再按布局键（nav.mode === 'own'
   *  的那批 keywords）匹配按钮标题/文本。**mode:'host' 的 keywords 绝不能碰** —— 那是原版 Vue
   *  渲染的按钮，删掉就再也回不来了（铁律 R9）。
   */
  /** 旧入口保留为薄包装：内部先取快照再摘（供 reload 等已知 manifest 仍在场的调用方使用）。
   *  真正的实现见 removeNavButtonsBySnapshot —— 那里才处理"manifest 已被删"的顺序问题。
   */
  function removeNavButtons(agentId) {
    return removeNavButtonsBySnapshot(agentId, collectNavTargets(agentId))
  }

  /** 移除设置页 tab 按钮 + 已渲染面板容器。
   *  两个 id 都要收：manifest.settingsTab.id（tab 按钮）与 agentId（插件可能用任一作 id）。
   */
  function removeSettingsTabs(agentId) {
    var ids = [String(agentId)]
    var srcs = manifestSources(agentId)
    for (var s = 0; s < srcs.length; s++) {
      var st = srcs[s] && srcs[s].settingsTab
      var id = st && st.id ? String(st.id) : ''
      if (id && ids.indexOf(id) < 0) ids.push(id)
    }
    var n = 0
    for (var i = 0; i < ids.length; i++) {
      var btn = document.querySelector('[data-plugin-tab="' + ids[i] + '"]')

      if (btn && btn.parentNode) { btn.parentNode.removeChild(btn); n++ }
      var host = document.getElementById('mio-plugin-settings-' + ids[i])
      if (host && host.parentNode) { host.parentNode.removeChild(host); n++ }
    }
    // 被插件「接管」而隐藏的原生 tab（plugin-nav 打的 data-plugin-taken）要放回来，
    // 否则卸载插件后设置页会永久少一个原生 tab。
    for (var k = 0; k < ids.length; k++) {
      var natives = document.querySelectorAll('[data-plugin-taken="' + ids[k] + '"]')
      for (var j = 0; j < natives.length; j++) {
        natives[j].style.display = ''
        natives[j].removeAttribute('data-plugin-taken')
      }
    }
    // 插件面板容器空了就没必要留着（它比 #mioSetBody 平级，留着会占位）
    var body = document.getElementById('mioPluginSetBody')
    if (body && !body.children.length && body.parentNode) body.parentNode.removeChild(body)
    return n
  }

  function notifyNav(reason) {
    var plugins = []
    for (var id in entries) plugins.push(entries[id])
    try {
      window.dispatchEvent(new CustomEvent('mio:plugins-changed', {
        detail: { reason: reason, plugins: plugins },
      }))
    } catch (e) { /* ignore */ }
    // nav 自愈有两层（MutationObserver / 8s 轮询），这里再主动推一把：
    // 插件晚于 plugin-nav 落地时，不必等下一次轮询就能看到 tab / 导航。
    try {
      var nav = window.__mioPluginNav
      if (nav && typeof nav.refresh === 'function') {
        var p = nav.refresh()
        if (p && typeof p.then === 'function' && reason === 'load') {
          p.then(function () { scheduleSelfCheck() }, function () { /* ignore */ })
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ────────────────────────────────────────────────────────────── 装载主体
  function enabledOf(entry) {
    // §3.3 启用态真值：builtin 恒加载；普通插件看清单 enabled；
    // 真正"该不该显示"仍统一走 registry.visible()（这里只决定"要不要把代码载进来"）。
    if (entry.builtin === true) return true
    return entry.enabled !== false
  }

  /** builtin 的 manifest 已在 index.html 里无条件加载（宿主本体必须无条件在场）：
   *  这里只把清单上的元数据（版本等）对齐到已注册的 manifest，不重复插脚本。
   *  @returns {boolean} true = 已处理完，不需要再插 <script>
   */
  function applyBuiltinKnown(entry) {
    if (entry.builtin !== true) return false
    var m = manifestOf(entry.agentId)
    if (!m) return false
    if (entry.version) m.version = String(entry.version)
    if (entry.enabled !== false) m.enabled = true
    records[entry.agentId] = {
      entry: entry.entry, panel: entry.panel || '', version: entry.version,
      status: 'loaded', error: '', injectedAt: 0, source: 'index.html',
    }
    return true
  }

  function loadEntry(entry, force) {
    var id = entry.agentId
    var version = entry.version || '1.0.0'
    var manifestUrl = pluginUrl(entry.entry, version)
    if (!manifestUrl) {
      records[id] = { entry: entry.entry || '', panel: entry.panel || '', version: version, status: 'invalid-entry', error: 'entry 路径不合法（' + (entry.entry || '空') + '）', injectedAt: 0 }
      warn('跳过 ' + id + '：entry 路径不合法', entry.entry)
      return Promise.resolve()
    }
    var already = findScript(id)
    if (already) {
      // 幂等：已有标签就不重复插（契约 §3.2）。版本变了才重插（?v= 是缓存键）。
      var cur = String(already.getAttribute('data-mio-plugin-version') || '')
      if (cur === String(version)) {
        if (!records[id]) records[id] = { entry: entry.entry, panel: entry.panel || '', version: version, status: 'loaded', error: '', injectedAt: Date.now() }
        // 补点：老标签可能是 index.html 写死/上次版本留下的，manifest 缺字段时按清单补
        var mKnown = manifestOf(id)
        if (mKnown && entry.builtin === true && mKnown.builtin !== true) {
          mKnown.builtin = true
          var rk = reg()
          if (rk && rk.register) rk.register(mKnown)
        }
        return loadPanel(entry, version)
      }
      if (already.parentNode) already.parentNode.removeChild(already)
    }
    // force（或版本变了）→ 先摘干净旧 manifest 再插，避免新旧两份在 registry 里打架
    if (force) {
      var rPrev = reg()
      if (rPrev && rPrev.unregister) rPrev.unregister(id)
      try {
        var msPrev = window.__mioPluginManifests
        if (msPrev && msPrev[id]) delete msPrev[id]
      } catch (e) { /* ignore */ }
    }
    records[id] = { entry: entry.entry, panel: entry.panel || '', version: version, status: 'loading', error: '', injectedAt: 0 }
    return injectScript(manifestUrl, id, 'manifest', version).then(function (res) {
      if (!res.ok) {
        records[id].status = 'error'
        records[id].error = res.reason + '：' + entry.entry
        warn('manifest 加载失败 ' + id, records[id].error)
        return null
      }
      var m = manifestOf(id)
      if (!m) {
        records[id].status = 'error'
        // ★ 常见真因（2026-10-25 实测踩到）：清单里两个不同 agentId 指向**同一个 entry 文件**。
        //   脚本只会声明它自己那个 id（market.js 里写死 __mioPluginManifests['market']），
        //   于是第二个 id 执行完什么也没注册。第④步的"同名覆盖"不能帮上忙，
        //   因为这里连一份可覆盖的 manifest 都没有。
        //   这不是加载器的 bug，而是清单数据错了 —— 但报错必须让人一眼看出是哪一种错，
        //   否则只会看到"manifest.js 存在却加载失败"这种自相矛盾的提示。
        var owner = ''
        var msAll = window.__mioPluginManifests || {}
        for (var other in msAll) {
          if (other === id) continue
          var ow = entries[other]
          if (ow && String(ow.entry) === String(entry.entry)) { owner = other; break }
        }
        records[id].error = owner
          ? ('entry 与插件 ' + owner + ' 共用同一个 manifest 文件（' + entry.entry +
             '），该文件只会注册 ' + owner + '，请为 ' + id + ' 使用自己的 manifest')
          : ('脚本执行了但没有注册 manifest（检查 ' + entry.entry + '）')
        warn('manifest 未注册 ' + id, records[id].error)
        return null
      }
      // 清单字段 vs manifest 字段：清单是权威源（builtin 决定恒可见）
      if (entry.builtin === true && m.builtin !== true) {
        warn(id + ' 清单标记 builtin 但 manifest 未声明 builtin —— 以清单为准，补上内置标记')
        m.builtin = true
        var r = reg()
        if (r && r.register) r.register(m)
      }
      if ((entry.name || m.name) && !m.name) m.name = entry.name
      records[id].status = 'loaded'
      records[id].injectedAt = Date.now()
      return loadPanel(entry, version)
    })
  }

  /** 面板脚本：**停用的插件不下载面板**（契约 §3.1 ④）。
   *  panel 缺省 = 不加载；声明了 settingsTab 却没有 panel = 清单问题，只告警不阻塞 manifest。
   */
  function loadPanel(entry, version) {
    var id = entry.agentId
    if (!enabledOf(entry)) return Promise.resolve()
    // ★ 无条件先"复活"一次：把卸载时藏起来的 host 按钮放出来。
    //   放在这里而不是 loadPanel 的 then 里，是因为面板可能"已存在 → 提前 return"，
    //   那条路径根本不进 then，隐藏的 host 按钮就会一直藏着（重新启用后入口不回来）。
    revivePlugin(id)
    var rel = entry.panel
    if (!rel) {
      var mf0 = manifestOf(id)
      if (mf0 && mf0.settingsTab) warn(id + ' 声明了 settingsTab 但清单没给 panel —— 设置 tab 挂不上', mf0.settingsTab)
      return Promise.resolve()
    }
    var url = pluginUrl(rel, version)
    if (!url) {
      warn('跳过 ' + id + ' 的 panel：路径不合法', rel)
      records[id].error = 'panel 路径不合法：' + rel
      return Promise.resolve()
    }
    var all = document.querySelectorAll(SELECTOR)
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (el.getAttribute('data-mio-plugin') !== id) continue
      if (el.getAttribute('data-mio-plugin-mirror') !== 'panel') continue
      if (el.getAttribute('data-mio-plugin-version') === String(version)) return Promise.resolve()
      if (el.parentNode) el.parentNode.removeChild(el)
      break
    }
    return injectScript(url, id, 'panel', version).then(function (res) {
      if (!res.ok) {
        if (records[id]) records[id].error = res.reason + '：' + rel
        warn('panel 加载失败 ' + id, rel)
        return
      }
      var mf = manifestOf(id)
      var panelName = (mf && mf.settingsTab && mf.settingsTab.panel) || ''
      if (panelName && !window[String(panelName)]) {
        // 铁律 R7：导出名必须等于 manifest.settingsTab.panel
        warn(id + ' 的 panel 没有导出 window["' + panelName + '"]（R7：导出名必须与 manifest.panel 一致）')
      }
      revivePlugin(id)
    })
  }

  /** 让被 dispose 过的插件"复活"。
   *
   * ★ 为什么必须有它：插件脚本都有幂等守卫（`if (window.__mioXxxLoaded) return`），
   *   停用再启用时重新插 <script> **不会重新执行**，被 dispose() 摘掉的导航按钮/面板
   *   就永远回不来（用户实测：按了启停，市场左侧入口消失且再也不出现）。
   *   约定：插件把 revive 挂在面板对象上；没实现就退回"调一次 ensureNav"。
   */
  function revivePlugin(agentId) {
    var id = String(agentId || '')
    if (!id) return
    // ★ 先把卸载时被"藏起来"的 host 按钮放出来（否则重新启用后入口回不来）。
    //   host 按钮是原版 Vue 渲染的，我们只改过 display:none，所以这里复位即可。
    try {
      var hidden = document.querySelectorAll('[data-mio-plugin-hidden="' + id + '"]')
      for (var h = 0; h < hidden.length; h++) {
        hidden[h].style.display = ''
        hidden[h].removeAttribute('data-mio-plugin-hidden')
      }
    } catch (e) { /* ignore */ }
    var names = []
    var m = manifestOf(id)
    if (m && m.settingsTab && m.settingsTab.panel) names.push(String(m.settingsTab.panel))
    // 与 disposePlugin 同一套推导（DSH 这类没有 settingsTab 的插件靠它）
    var base = id.replace(/[-_]/g, '')
    var camel = base.charAt(0).toUpperCase() + base.slice(1)
    var derived = [id + '-panel', '__mio' + camel + 'Panel']
    for (var d = 0; d < derived.length; d++) {
      if (names.indexOf(derived[d]) < 0) names.push(derived[d])
    }
    for (var i = 0; i < names.length; i++) {
      var obj = window[names[i]]
      if (!obj) continue
      if (typeof obj.revive === 'function') {
        try { obj.revive() } catch (e) { warn('revive 失败 ' + id, e && e.message) }
        return
      }
      if (typeof obj.ensureNav === 'function') {
        try { obj.ensureNav() } catch (e) { /* ignore */ }
        return
      }
    }
  }

  function fetchCatalog() {
    return fetch(CATALOG_URL, { headers: { 'Cache-Control': 'no-cache' }, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (data) {
        if (!data || data.ok === false) throw new Error('catalog ok=false')
        var list = data.plugins
        if (!list || typeof list.length !== 'number') throw new Error('catalog 缺 plugins 数组')
        return list
      })
  }

  function normalize(list) {
    var out = []
    for (var i = 0; i < list.length; i++) {
      var e = list[i]
      if (!e) continue
      var id = String(e.agentId || e.agent_id || '')
      if (!ID_RE.test(id)) { warn('清单条目 agentId 不合法，已跳过', e.agentId); continue }
      var health = e.health
      // health.ok 缺省视为 ok（契约 §2.1 里它是必带字段，缺了不判死）
      if (health && health.ok === false) {
        warn('跳过 ' + id + '：health 不通过', health.problems)
        continue
      }
      if (!e.entry) { warn('跳过 ' + id + '：清单缺 entry'); continue }
      out.push({
        agentId: id,
        name: String(e.name || id),
        version: String(e.version || '1.0.0'),
        entry: String(e.entry),
        panel: e.panel ? String(e.panel) : '',
        builtin: e.builtin === true,
        enabled: e.enabled !== false,
      })
    }
    return out
  }

  function doLoad(force) {
    lastLoadAt = Date.now()
    return fetchCatalog().then(function (raw) {
      var list = normalize(raw)
      // 后端可达后才清掉"失败重试"状态
      lastError = ''
      if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null }
      ensureBridgeStyle()

      // builtin 排前面（宿主本体先就位），其余保持清单顺序
      var builtins = []
      var others = []
      for (var i = 0; i < list.length; i++) (list[i].builtin ? builtins : others).push(list[i])
      var ordered = builtins.concat(others)

      var wanted = {}
      var jobs = []
      for (var j = 0; j < ordered.length; j++) {
        var e = ordered[j]
        if (!enabledOf(e)) { continue }   // 停用：不载 manifest、更不载面板
        wanted[e.agentId] = true
        entries[e.agentId] = e
        if (applyBuiltinKnown(e)) continue
        jobs.push(loadEntry(e, force))
      }
      // 清单里已经没有的插件（被下架 / 被停用）：摘掉它的残留，否则界面留着"幽灵入口"
      var ids = []
      for (var id in entries) ids.push(id)
      for (var k = 0; k < ids.length; k++) {
        if (wanted[ids[k]]) continue
        unloadPlugin(ids[k], 'gone')
        delete entries[ids[k]]
      }
      loadedOnce = true
      return Promise.all(jobs)
    }).then(function () {
      var ok = 0
      var bad = []
      for (var id in records) {
        if (records[id].status === 'loaded') ok++
        else if (records[id].status === 'error' || records[id].status === 'invalid-entry') bad.push(id)
      }
      // 自检 console（设计见任务验收）：一眼看出"谁载了、谁没载、为什么"
      try {
        console.log('[plugin-loader] 装载完成 · 成功 ' + ok + ' / 失败 ' + bad.length +
          ' · 清单 ' + Object.keys(entries).length + ' 条' + (bad.length ? ' · 失败：' + bad.join(', ') : ''))
      } catch (e) { /* ignore */ }
      notifyNav('load')
    })
  }

  function scheduleRetry() {
    if (retryTimer) return
    // 后端还没起来 / 正在重启：20s 后自动重试一次，用户不必刷新页面
    retryTimer = window.setTimeout(function () {
      retryTimer = null
      load(false)
    }, 20000)
  }

  /** 抓清单并装载。
   *  force=true：对所有条目**强制重插**（等价"改了插件代码，立刻拿新版"）；
   *  默认（false）幂等短路：标签已在场且版本一致就不重复插（契约 §3.2）。
   *  注意 force 只是调用参数，不是「上次是否已加载」的状态 —— 自动重试必须仍走幂等路径，
   *  否则网络抖动时会把已在场的插件重插一遍。
   */
  function load(force) {
    if (inflight) {
      // 防并发：进行中的调用直接拿到同一个 promise（契约 §3.2 幂等）。
      // 例外：进行中的是普通 load、而这次要 force（例如刚启停过插件）→ 排队再来一次。
      if (force && !inflightForce) {
        return inflight.then(function () { return load(true) })
      }
      return inflight
    }
    inflightForce = !!force
    var p = doLoad(!!force)
      .catch(function (err) {
        // ★ fail-safe：后端不可达 → 只告警，**不动现有界面**（已在场的 manifest/nav/tab 原样保留）
        lastError = (err && err.message) || String(err)
        warn('清单读取失败（后端 /api/plugin/market/* 未就绪？），保持现有界面不变：' + lastError)
        scheduleRetry()
      })
      .then(function (v) {
        inflight = null
        inflightForce = false
        return v
      })
    inflight = p
    return p
  }

  /** 卸载单个插件：manifest + 脚本 + nav 按钮 + settingsTab + 面板容器 + 通知 nav。 */
  function unloadPlugin(agentId, reason) {
    var id = String(agentId || '')
    if (!id) return

    // ★★ 2026-10-25 真机抓到的顺序 bug（Chrome 实测：停用 DSH 后左侧「DSH」按钮还在）：
    //   removeNavButtons() 要读 manifest 的 nav.keywords 才知道该摘哪个按钮，
    //   而下面第 3 步已经把 manifest 从 registry 与 __mioPluginManifests 里删掉了 ——
    //   于是"按关键词兜底"那条路永远拿到空 keywords，只剩"按 data-mio-plugin-nav 标记"
    //   这条精确路径。DSH 的按钮是它自己 append 的、**没有打标记**，所以摘不掉，
    //   表现为"插件停用了，入口却还在"。
    //   修法：**先**把要摘的信息取出来（快照），再做删除。
    //   为什么不干脆要求所有插件都必须打标记：那是对既有插件的破坏性约束
    //   （dsh/feiyu 都是历史代码），loader 自己做快照更稳，也不用改插件。
    var navSnapshot = collectNavTargets(id)

    // ★ 先让插件自己把自愈停掉，再摘 DOM。
    //   顺序不能反：如果先摘了按钮再 dispose，面板的自愈（MutationObserver/轮询）
    //   可能抢在前面把按钮补回来 —— 那正是真机上"停用了但入口还在"的表现。
    disposePlugin(id, navSnapshot)
    var r = reg()
    if (r && r.unregister) r.unregister(id)
    // 插件自己写在 window.__mioPluginManifests 上的声明也要摘 —— 否则 nav 的
    // collectSettingsTabs() 直接读这个对象，仍然会把 tab 挂回来（契约 §3.1 要求"移除 manifest"）
    try {
      var ms = window.__mioPluginManifests
      if (ms && ms[id]) delete ms[id]
    } catch (e) { /* ignore */ }
    removeScripts(id)
    removeNavButtonsBySnapshot(id, navSnapshot)
    removeSettingsTabs(id)
    if (records[id]) {
      records[id].status = 'unloaded'
      records[id].injectedAt = 0
    }
    if (reason !== 'silent') notifyNav(reason || 'unload')
  }

  /** 卸载**之前**先取快照：nav 关键词（own / host 分开）+ 面板导出名（dispose 要用）。
   *
   *  ★★ 2026-10-25 用户实测：「停用大肥鱼后左侧大肥鱼入口没消失」。
   *  根因：feiyu 的 nav.mode 是 **'host'**（按钮由原版 Vue 渲染，插件不自建），
   *  loader 按铁律 R9 对 host 按钮**只隐藏不删除**。
   *  但"隐藏"这件事原先完全交给 plugin-nav 的 applyVisibility()，
   *  而它是**按 navRules 来遍历**的 —— navRules 又是从 __mioPluginManifests 里聚合的。
   *  卸载时我们把 manifest 删了 → navRules 里没有 cloud_feiyu 这一项 →
   *  applyVisibility 的循环根本不会走到它 → **"该隐藏"的规则自己先没了**，按钮原地不动。
   *  修法：卸载时自己动手把 host 按钮 display:none（不是删），
   *  这样既不动 Vue 的节点（R9 安全），又保证"停用=入口消失"。
   */
  function collectNavTargets(agentId) {
    var keywords = []      // mode:'own' —— 插件自己建的按钮，卸载时**删除**
    var hostKeywords = []  // mode:'host' —— 宿主 Vue 渲染的按钮，卸载时**隐藏**
    var panel = ''
    var srcs = manifestSources(agentId)
    for (var s = 0; s < srcs.length; s++) {
      var m = srcs[s]
      if (!m) continue
      // ★ 只认 manifest 里的 settingsTab.panel（那是**导出名**，如 'dsh-panel'）；
      //   entries[].panel 存的是**脚本路径**（如 'plugins/dsh/dsh-panel.js'），
      //   两者同名不同义 —— 混用过一次，导致 disposePlugin 拼出
      //   `__mioPlugins/dsh/dsh-panel.jsPanel` 这种不存在的名字，dispose 静默失效。
      if (!panel && m.settingsTab && m.settingsTab.panel) panel = String(m.settingsTab.panel)
      if (!m.nav || !m.nav.keywords) continue
      var isHost = m.nav.mode === 'host'
      var bucket = isHost ? hostKeywords : keywords
      for (var k = 0; k < m.nav.keywords.length; k++) {
        var kw = String(m.nav.keywords[k] || '')
        if (kw && bucket.indexOf(kw) < 0) bucket.push(kw)
      }
    }
    return { keywords: keywords, hostKeywords: hostKeywords, panel: panel }
  }

  /** 按快照摘导航按钮（原 removeNavButtons，改成接收已取好的关键词）。 */
  function removeNavButtonsBySnapshot(agentId, snapshot) {
    var nav = document.querySelector('nav')
    if (!nav) return 0
    var removed = 0
    var i
    var marked = nav.querySelectorAll('[data-mio-plugin-nav="' + agentId + '"]')
    for (i = 0; i < marked.length; i++) {
      if (marked[i].parentNode) marked[i].parentNode.removeChild(marked[i])
      removed++
    }
    var items = nav.querySelectorAll('button.nav-item')

    // ① mode:'host' → **隐藏不删**（铁律 R9：那是原版 Vue 渲染的节点，删了再也回不来）
    //    这是"停用大肥鱼后左侧入口没消失"的修复点：
    //    不能指望 plugin-nav 去藏它 —— 那条路依赖 navRules，而 manifest 已被我们删了。
    var hostKeywords = (snapshot && snapshot.hostKeywords) || []
    if (hostKeywords.length) {
      for (i = 0; i < items.length; i++) {
        var hb = items[i]
        if (hb.getAttribute('data-mio-plugin-nav')) continue
        var htext = (hb.getAttribute('title') || '') + ' ' + (hb.textContent || '')
        if (isFixedNav(htext)) continue
        var hhit = false
        for (var h = 0; h < hostKeywords.length; h++) if (htext.indexOf(hostKeywords[h]) >= 0) hhit = true
        if (!hhit) continue
        hb.style.display = 'none'
        hb.setAttribute('data-mio-plugin-hidden', agentId)
        removed++
      }
    }

    // ② mode:'own' → 删除（插件自己建的节点，删掉由它自己 revive 时重建）
    var keywords = (snapshot && snapshot.keywords) || []
    if (!keywords.length) return removed
    for (i = 0; i < items.length; i++) {
      var btn = items[i]
      if (btn.getAttribute('data-mio-plugin-nav')) continue   // 已由标记路径处理
      var text = (btn.getAttribute('title') || '') + ' ' + (btn.textContent || '')
      if (isFixedNav(text)) continue
      var hit = false
      for (var j = 0; j < keywords.length; j++) if (text.indexOf(keywords[j]) >= 0) hit = true
      if (!hit) continue
      if (btn.parentNode) btn.parentNode.removeChild(btn)
      removed++
    }
    return removed
  }

  /** 让插件自己停掉"自愈"。
   *
   * ★★ 2026-10-25 真机实测的核心修复：
   *   许多插件面板都做了 R4「DOM 自愈」—— 发现自己的导航按钮不在了就补回来
   *   （因为 Vue 重渲染会删掉外部 append 的节点，这是既有铁律）。
   *   但 loader **卸载**插件时也会摘那个按钮，于是面板自愈把它当成
   *   "Vue 又删了"，立刻补一个回来 → 用户看到「插件停了，入口还在」，
   *   而且会和 loader 打乒乓（loader 拔、面板补，以轮询周期反复）。
   *
   *   解法（与 Cordis 的 dispose 契约同构）：
   *     · loader 卸载前先调插件的 dispose()（若有）；
   *     · 插件侧的 dispose 负责：停轮询、断 MutationObserver、摘掉自己的 DOM。
   *   同时 loader 还会在摘 DOM **之前** 把 manifest 从 registry 里删掉，
   *   这样即使插件没实现 dispose，它的 isDisposed() 检查（读 registry）也能生效 ——
   *   两条路都堵上，不依赖插件是否配合。
   */
  function disposePlugin(agentId, snapshot) {
    var id = String(agentId || '')
    if (!id) return
    // 约定：插件把 dispose 挂在自己的面板对象上（window['<panel>'] 或 window.__mio<Xxx>Panel）。
    // ★★ 2026-10-25 补充兜底（真机回归抓到的漏网）：
    //   `manifestOf(id)` 在卸载阶段可能已经拿不到 manifest（先删了 registry 里的记录），
    //   于是 names 为空 → dispose 根本没被调到 → 面板自愈把按钮补回来 →
    //   表现为"停用 DSH 后左侧入口还在"。
    //   所以：① 优先用调用方在删除前取好的快照；② 再按 agentId 兜几种常见别名。
    var names = []
    var panelName = snapshot && snapshot.panel
    if (!panelName) {
      var m = manifestOf(id)
      panelName = m && m.settingsTab && m.settingsTab.panel
    }
    if (panelName) names.push(String(panelName))
    // ★ 兜底推导：agentId → 导出名。
    //   DSH 这类插件**没有声明 settingsTab**（它只做左侧功能页），
    //   所以拿不到 settingsTab.panel；但它的导出名遵循 `<id>-panel` 约定。
    //   两种常见形态都试：`<id>-panel` 与 `__mio<Camel>Panel`。
    var base = agentId.replace(/[-_]/g, '')
    var camel = base.charAt(0).toUpperCase() + base.slice(1)
    var derived = [id + '-panel', '__mio' + camel + 'Panel']
    for (var d = 0; d < derived.length; d++) {
      if (names.indexOf(derived[d]) < 0) names.push(derived[d])
    }
    for (var i = 0; i < names.length; i++) {
      var obj = window[names[i]]
      if (!obj || typeof obj.dispose !== 'function') continue
      try { obj.dispose() } catch (e) { warn('dispose 失败 ' + id, e && e.message) }
      return
    }
  }

  /** 公开的 unload：调用方显式卸载（市场停用按钮 / 开发调试）。
   *  同时从 entries 里摘掉，避免下次 load 又把它装回来。
   */
  function unload(agentId) {
    unloadPlugin(agentId, 'unload')
    delete entries[String(agentId || '')]
    return { agentId: String(agentId || ''), ok: true }
  }

  /** 热插拔落点：全量 unload → 全量 load。
   *
   * ★★ 2026-10-25 修正（harness 实测发现"白屏"根因）：
   *   旧实现是**先无条件 unload 所有插件、再去拉清单**。于是中间存在一个窗口：
   *   清单请求只要在此刻失败（后端正在重启 / 网络抖一下 / 用户刚点完停用），
   *   catch 里那句"保持现有界面不变"就成了一句空话 —— 界面**已经被清空了**，
   *   没有任何东西可供"保持"：左侧导航、设置页 tab、各面板集体消失，
   *   直到 20s 后的自动重试才回来。用户看到的就是"点了个开关，整个界面白了"。
   *
   *   现在改成 **先取清单、成功了才动手**：清单拿不到就直接返回，
   *   一个插件都不动（这才是 fail-safe 的本来含义）。
   */
  function reload() {
    return fetchCatalog().then(function (raw) {
      // ★★ 2026-10-25 用户实测反馈后的重写：原来是"全部卸载 → 全部重装"。
      //
      //   那个做法有一个致命副作用：**点任何一个插件的启停开关，市场自己也会被卸载重装**。
      //   而插件的 manifest/panel 脚本都有幂等守卫（`if (window.__mioXxxLoaded) return`），
      //   重插 <script> 并不会让它重新执行 → 被 dispose() 摘掉的导航按钮永远回不来。
      //   用户看到的就是「按了启用/停用，插件市场自己的左侧入口也没了」。
      //
      //   正确做法是**只动真正变化了的插件**（差异重载）：
      //     · 新清单里仍是 enabled 且已在场的 → **原样保留**（不 dispose、不重插）；
      //     · 新清单里消失了 / 变成停用了 → 才卸载；
      //     · 新出现的 / 从停用变启用的 → 才加载。
      //   这样点 DSH 的开关只会动 DSH，市场自己和其它插件纹丝不动 —— 这才是"热插拔"该有的语义。
      var next = normalize(raw)
      var want = {}
      for (var n = 0; n < next.length; n++) {
        if (enabledOf(next[n])) want[next[n].agentId] = next[n]
      }

      // ① 收掉"不再该在场"的（下架 / 停用 / 从清单移除）
      var present = []
      for (var id in entries) present.push(id)
      var sculpt = document.querySelectorAll(SELECTOR)
      for (var i = 0; i < sculpt.length; i++) {
        var sid = sculpt[i].getAttribute('data-mio-plugin')
        if (sid && present.indexOf(sid) < 0) present.push(sid)
      }
      var dropped = 0
      for (var k = 0; k < present.length; k++) {
        var pid = present[k]
        if (want[pid]) continue          // 仍要保留
        unloadPlugin(pid, 'reload')
        delete entries[pid]
        dropped++
      }

      // ② 只加载"该在场但还没在场"的（新上架 / 从停用恢复 / 首次）
      var toLoad = []
      for (var wid in want) {
        var e = want[wid]
        // 已在场：脚本标签还在、且 manifest 仍注册 → 不动
        if (entries[wid] && manifestOf(wid) && findScript(wid)) continue
        entries[wid] = e
        if (applyBuiltinKnown(e)) continue
        toLoad.push(e)
      }

      var jobs = []
      for (var j = 0; j < toLoad.length; j++) jobs.push(loadEntry(toLoad[j], true))

      return Promise.all(jobs).then(function () {
        // 差异重载**不需要 notifyNav 去重挂**，但要让 nav 重新算一次显隐（有新插件进来/有插件走了）
        notifyNav('reload')
      })
    }).catch(function (err) {
      lastError = (err && err.message) || String(err)
      warn('reload 中止：清单读取失败，保持现有界面不变：' + lastError)
      scheduleRetry()
    })
  }

  function status() {
    var rows = []
    for (var id in records) {
      rows.push({
        agentId: id,
        status: records[id].status,
        version: records[id].version,
        entry: records[id].entry,
        panel: records[id].panel,
        error: records[id].error,
        injectedAt: records[id].injectedAt,
        scriptTags: document.querySelectorAll(SELECTOR + '[data-mio-plugin="' + id + '"]').length,
        manifestRegistered: !!manifestOf(id),
      })
    }
    return {
      catalogUrl: CATALOG_URL,
      base: BASE,
      loading: !!inflight,
      loadedOnce: loadedOnce,
      lastLoadAt: lastLoadAt,
      lastError: lastError,
      retryScheduled: !!retryTimer,
      plugins: rows,
    }
  }

  /** 自检（console 设计）：
   *   `__mioPluginLoader.selfCheck()` / `__mioPluginLoader.status()`
   *   → 逐条打印 状态 / manifest 是否登记 / script 标签数 / 设置 tab 是否挂上 / 导航入口是否在。
   *  定位"插件装了但什么都不出现"时，一眼就能看出断在哪一步。
   */
  function selfCheck() {
    var reg2 = reg()
    var nav = document.querySelector('nav')
    var rows = []
    for (var id in records) {
      var rec = records[id]
      var m = manifestOf(id)
      var tabId = m && m.settingsTab && m.settingsTab.id ? String(m.settingsTab.id) : id
      var tabBtn = document.querySelector('[data-plugin-tab="' + tabId + '"]')
      var navHit = false
      if (nav && m && m.nav && m.nav.keywords) {
        var items = nav.querySelectorAll('button.nav-item')
        for (var i = 0; i < items.length; i++) {
          var t = (items[i].getAttribute('title') || '') + ' ' + (items[i].textContent || '')
          for (var k = 0; k < m.nav.keywords.length; k++) if (t.indexOf(m.nav.keywords[k]) >= 0) navHit = true
        }
      }
      rows.push({
        agentId: id,
        status: rec.status,
        version: rec.version,
        scriptTags: document.querySelectorAll(SELECTOR + '[data-mio-plugin="' + id + '"]').length,
        manifest: !!m,
        visible: reg2 && reg2.visible ? reg2.visible(id) : null,
        settingsTab: m && m.settingsTab ? !!tabBtn : '（未声明）',
        tabId: tabId,
        nav: navHit,
        error: rec.error || '',
      })
    }
    try { console.table(rows) } catch (e) { /* ignore */ }
    var out = status()
    out.rows = rows
    out.navApi = !!window.__mioPluginNav
    out.tabBarFound = !!document.querySelector('#mioSetTabs')
    try { console.log('[plugin-loader] 自检', out) } catch (e) { /* ignore */ }
    return out
  }

  function scheduleSelfCheck() {
    if (selfCheckPending) return
    selfCheckPending = true
    window.setTimeout(function () {
      selfCheckPending = false
      try {
        var reg2 = reg()
        var missing = []
        for (var id in records) {
          var rec = records[id]
          if (rec.status !== 'loaded') continue
          if (!reg2 || !reg2.get || !reg2.get(id)) missing.push(id)
        }
        if (missing.length) warn('脚本已载入但 registry 里没有 manifest：' + missing.join(', '))
      } catch (e) { /* ignore */ }
    }, 1200)
  }

  window.__mioPluginLoader = {
    load: load,
    unload: unload,
    reload: reload,
    status: status,
    selfCheck: selfCheck,
    /** 只取清单（不装载）：市场面板可以复用，避免两套 fetch 口径 */
    catalog: function () { return fetchCatalog().then(normalize) },
    /** 幂等启动：index.html 里自动调一次；外部（市场面板/测试）再调不会重复抓 */
    init: function () { return load(false) },
  }

  // registry 一变就让 nav 重算（nav 自己也会 8s 轮询兜底，这里只是让体验不等）
  var r0 = reg()
  if (r0 && r0.onChanged) {
    r0.onChanged(function (evt) {
      if (!evt || evt.type !== 'manifest-removed') return
      notifyNav('removed')
    })
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  // 必须等 DOM 就绪后再注入：插件的 manifest 同步执行，会立刻去找 <nav> /
  // 监听 document，早于 <body> 存在时它们会走到各自的 400ms 重试分支（多一轮无谓等待）。
  function start() {
    // 清单是唯一入口：dsh/feiyu 已从 index.html 摘掉，pet(内置) 仍由 index.html 无条件加载。
    // 后端不可达时 load() 内部 fail-safe（只告警 + 20s 后重试），界面保持宿主本体的完整形态。
    load(false)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
