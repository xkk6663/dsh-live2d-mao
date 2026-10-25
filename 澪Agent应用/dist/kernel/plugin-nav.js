/* plugin-nav.js — 左侧导航插件化：固定导航前置 + agent 功能入口按 enabled 动态显隐
 * 规则：
 *   - 固定导航固定顺序：桌宠 → 设置，始终显示
 *   - 插件导航统一追加在固定导航之后（按出现顺序往后排），随后端 agent enabled 显隐，
 *     显隐规则**完全由各插件 manifest 的 nav.keywords 驱动**，不硬编码任何 agentId
 * 状态源：GET /api/companion/agents（与桌宠插件总线同口径，以后端 enabled 为准）
 * 暴露：window.__mioPluginNav.refresh()（Agent 页切换 enabled 后立即调用）
 *
 * DSH 专用化（2026-10-17）：原来这里有两段小智专用逻辑
 * （停用小智时收起 xz-mcp-panel、按 xiaozhi enabled 显隐桌宠页「观察」子tab），
 * 已随小智插件整体阉割删除。通用机制原样保留。
 */
(function () {
  if (window.__mioPluginNav) return
  var agentEnabled = {}
  var POLL_MS = 8000

  // 固定导航：始终显示且固定顺序（桌宠 → 设置；Agent 管理已收敛至对话页右侧 rail 面板，不再占左侧导航）
  var FIXED_NAV_ORDER = ['桌宠', '设置']

  // 从插件注册表/ manifest 动态收集导航规则（插件零相互依赖：各自声明，这里只聚合）
  // 优先走 kernel/plugin-registry.js（统一状态），不存在时回退直读 manifest 对象
  function collectNavRules() {
    var reg = window.__mioPluginRegistry
    if (reg && reg.navRules) return reg.navRules()
    var rules = {}
    var ms = window.__mioPluginManifests || {}
    for (var id in ms) {
      var m = ms[id]
      if (m && m.nav && m.nav.keywords) rules[id] = m.nav.keywords
    }
    return rules
  }

  // DSH 专用化：observeTabEnabled() 已移除。
  // 它唯一的消费者是 applyObserveTab()（小智「观察」子 tab 显隐），两者都随小智插件删掉了。
  // 若将来有插件需要 observeTab 能力，再按 manifest 重新加回来（机制本身是通用的）。

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function getNavItems() {
    var nav = $q('nav')
    return nav ? Array.prototype.slice.call(nav.querySelectorAll('button.nav-item')) : []
  }

  function matchItem(btn, keywords) {
    var t = (btn.getAttribute('title') || '') + ' ' + (btn.textContent || '')
    for (var i = 0; i < keywords.length; i++) {
      if (t.indexOf(keywords[i]) >= 0) return true
    }
    return false
  }

  // 导航排序：固定导航（Agent → 桌宠 → 设置）前置，插件导航按出现顺序追加其后
  // 防递归：顺序已一致时不动 DOM（appendChild 会触发 MutationObserver，避免无限循环卡死 UI）
  function reorderNav() {
    var nav = $q('nav')
    if (!nav) return
    var items = getNavItems()
    // 固定导航按槽位收集（同标题可能出现多个，如 settings-panel 插的"设置"+ 原版"设置"，全部保留不覆盖）
    var fixed = []
    for (var f = 0; f < FIXED_NAV_ORDER.length; f++) fixed.push([])
    var plugins = []
    for (var i = 0; i < items.length; i++) {
      var btn = items[i]
      var t = (btn.getAttribute('title') || '') + ' ' + (btn.textContent || '')
      var idx = -1
      for (var f2 = 0; f2 < FIXED_NAV_ORDER.length; f2++) {
        if (t.indexOf(FIXED_NAV_ORDER[f2]) >= 0) { idx = f2; break }
      }
      if (idx >= 0) fixed[idx].push(btn)
      else plugins.push(btn)
    }
    var ordered = []
    for (var j = 0; j < fixed.length; j++) ordered = ordered.concat(fixed[j])
    ordered = ordered.concat(plugins)
    // 提取 nav 中 button.nav-item 的实际顺序（跳过头像/Logo/分隔符等非按钮元素）
    var current = []
    for (var c = 0; c < nav.children.length; c++) {
      var child = nav.children[c]
      if (child && child.classList && child.classList.contains('nav-item')) current.push(child)
    }
    // 当前按钮顺序已符合目标顺序 → 直接返回，不触发 DOM 变更
    if (current.length === ordered.length) {
      var same = true
      for (var k = 0; k < ordered.length; k++) {
        if (current[k] !== ordered[k]) { same = false; break }
      }
      if (same) return
    }
    // 按固定顺序依次 append（append 即移到末尾，保持传入顺序），插件导航自然排在固定导航之后
    for (var m = 0; m < ordered.length; m++) nav.appendChild(ordered[m])
  }

  // DSH 专用化：以下两个处理函数已随小智插件移除（原为小智专用）：
  //   - closePanelsFor(agentId)：停用小智时收起 xz-mcp-panel
  //   - applyObserveTab()：按 xiaozhi enabled 显隐桌宠页的「观察」子 tab
  // 现在 nav 显隐仍由通用机制（collectNavRules + applyVisibility）按各插件
  // manifest 驱动，不依赖任何硬编码 agentId。
  // 注意：applyVisibility 里原来会调 closePanelsFor / applyObserveTab，
  // 已一并移除，见下方函数体。

  function applyVisibility() {
    var items = getNavItems()
    var rules = collectNavRules()
    for (var agentId in rules) {
      var keywords = rules[agentId]
      // ★ 内置插件恒可见（宿主本体），不看 enabled
      var reg2 = window.__mioPluginRegistry
      var enabled = reg2 && reg2.visible ? reg2.visible(agentId) : (agentEnabled[agentId] === true)
      for (var i = 0; i < items.length; i++) {
        var btn = items[i]
        if (!matchItem(btn, keywords)) continue
        btn.style.display = enabled ? '' : 'none'
      }
    }
    // DSH 专用化：applyObserveTab()（小智「观察」子tab 显隐）已随小智插件移除。
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 设置页 tab 插件化（2026-10-25）
  // ──────────────────────────────────────────────────────────────────────────
  // 插件在 manifest 里声明 settingsTab: { id, label, order, panel }，
  // 本函数就把「tab 按钮」和「面板内容」挂进设置页，插件停用时整组隐藏。
  // 这样做的好处：新插件要加自己的设置页，只需写 manifest + 一个 renderInto，
  // 不需要改 settings-panel-inject.js（那个文件只管通用能力，不再堆各插件配置）。
  //
  // 约定（插件侧必须遵守，否则挂不上）：
  //   · 面板对象挂在 window[panel] 上，且提供 renderInto(host) —— 由插件自己渲染；
  //   · 不存在的 panel 会被跳过（插件没加载时安静失败，不报错）。
  var mountedSettingsTabs = {}
  var mountRetryTimer = null
  var lastRenderError = ''

  function collectSettingsTabs() {
    var out = []
    var ms = window.__mioPluginManifests || {}
    for (var id in ms) {
      var m = ms[id]
      if (m && m.settingsTab) out.push({ agentId: id, tab: m.settingsTab })
    }
    out.sort(function (a, b) { return (a.tab.order || 100) - (b.tab.order || 100) })
    return out
  }

  // 通用设置面板的**真实** DOM 契约（由 settings-panel-inject.js 的 buildTabs 渲染）：
  //   #mioSetTabs  —— tab 容器（里面的按钮带 data-tab 属性）
  //   #mioSetBody  —— 内容区
  // ★ 以前这里写的是虚构的 .settings-tabs / .settings-content-section，
  //   而通用面板根本不用这些 class ⇒ 插件 tab **一个都挂不上去**（用户实拍：设置页只有原生 4 个）。
  var TAB_BAR = '#mioSetTabs'
  var TAB_BODY = '#mioSetBody'

  function mountSettingsTabs() {
    var tabsWrap = $q(TAB_BAR)
    if (!tabsWrap) {
      // 设置面板还没被打开过（#mioSetTabs 由 settings-panel-inject 首次激活时才创建）。
      // 这里不放弃：挂一个短周期重试，用户一点开设置就立刻补上插件 tab，
      // 而不是等 8 秒轮询（体验上"点了设置半天没反应"）。
      if (!mountRetryTimer) {
        mountRetryTimer = window.setInterval(function () {
          if ($q(TAB_BAR)) {
            window.clearInterval(mountRetryTimer)
            mountRetryTimer = null
            try { mountSettingsTabs() } catch (e) { /* ignore */ }
          }
        }, 500)
      }
      return
    }
    if (mountRetryTimer) { window.clearInterval(mountRetryTimer); mountRetryTimer = null }
    var list = collectSettingsTabs()
    for (var i = 0; i < list.length; i++) {
      var item = list[i]
      var tab = item.tab
      var name = String(tab.panel || '')
      var panelObj = window[name]
      // 面板还没加载：下次 MutationObserver/轮询再试，不在这里报错
      if (!panelObj || typeof panelObj.renderInto !== 'function') continue

      var btn = tabsWrap.querySelector('[data-plugin-tab="' + tab.id + '"]')
      if (!btn) {
        // ★ 接管同名原生 tab（用户裁决 2026-10-25：「桌宠(插件)是空的，之前说的桌宠设置页没删」）：
        //   通用面板里仍有一个原生「桌宠」tab，插件再插一个同名 tab 会出现两个「桌宠」，
        //   点插件那个就把原生内容藏起来 → 用户看到的是"空页面"。
        //   正确处理：找到**同名原生 tab 并隐藏它**，插件 tab 顶替它的位置与名字。
        var natives = tabsWrap.querySelectorAll('button:not([data-plugin-tab])')
        for (var n = 0; n < natives.length; n++) {
          if ((natives[n].textContent || '').trim() === String(tab.label)) {
            natives[n].style.display = 'none'
            natives[n].setAttribute('data-plugin-taken', tab.id)
          }
        }
        btn = document.createElement('button')
        btn.type = 'button'
        btn.setAttribute('data-plugin-tab', tab.id)
        btn.textContent = tab.label
        // 与原生 tab 完全同一套样式（原生在 buildTabs 里内联这些值）
        btn.style.cssText = 'border:none;background:transparent;border-radius:8px;padding:5px 14px;font-size:12px;cursor:pointer;color:var(--muted, #687984);'
        // 若接管了同名原生 tab → 插在它原来的位置（保持「资料 桌宠 个性化 主题」的顺序）；
        // 否则（全新插件）→ 追加到**最右侧**（用户裁决）。
        var taken = tabsWrap.querySelector('[data-plugin-taken="' + tab.id + '"]')
        if (taken && taken.parentNode === tabsWrap) {
          tabsWrap.insertBefore(btn, taken.nextSibling)
        } else {
          tabsWrap.appendChild(btn)
        }
        ;(function (panelObjRef, tabRef, btnRef) {
          btnRef.addEventListener('click', function (e) {
            e.preventDefault()
            e.stopPropagation()
            setPluginTabActive(btnRef, tabRef.id)
            showPluginSettingsPanel(panelObjRef, tabRef)
          })
        })(panelObj, tab, btn)
      }
      // ★ 内置插件（builtin）恒可见：它是宿主本体，不参与 enabled 显隐。
      //   走 registry.visible() 统一口径，避免这里和 registry 各写一套判断。
      var reg = window.__mioPluginRegistry
      var visible = reg && reg.visible ? reg.visible(item.agentId) : (agentEnabled[item.agentId] === true)
      btn.style.display = visible ? '' : 'none'
      mountedSettingsTabs[tab.id] = { btn: btn, panel: panelObj }
    }
  }

  /** 高亮插件自己的 tab（原生 tab 由面板内部 setTab 自己管，这里只改插件类）。 */
  function setPluginTabActive(activeBtn, activeId) {
    var tabsWrap = $q(TAB_BAR)
    if (!tabsWrap) return
    var all = tabsWrap.querySelectorAll('button')
    for (var k = 0; k < all.length; k++) {
      var b = all[k]
      var isPlugin = b.getAttribute('data-plugin-tab')
      if (isPlugin) {
        var on = b === activeBtn
        b.style.background = on ? 'var(--accent, #4c8798)' : 'transparent'
        b.style.color = on ? '#fff' : 'var(--muted, #687984)'
      } else {
        // 原生 tab 取消高亮
        b.style.background = 'transparent'
        b.style.color = 'var(--muted, #687984)'
      }
    }
    if (activeId) hidePluginSettingsPanels(activeId)
  }

  /** 把插件面板放进**独立容器**（与 #mioSetBody 平级），并隐藏原生 body。
   *
   * ★★ 2026-10-25 用户实拍「两个插件 tab 打不开 / 空白」的真根因：
   *   原实现把插件面板塞进 `#mioSetBody`，而原生 `renderBody(id)` 第一行就是
   *   `body.innerHTML = ''` —— 只要原生 `setTab()` 被调用一次（切 tab、重新加载、
   *   定时刷新），插件面板就被整个清空 ⇒ 用户看到的是空白页。
   *   两者**不能共用同一个容器**。
   *   现在另建一个 `#mioPluginSetBody`，插在 #mioSetBody 后面，
   *   显示插件时 display:none 原生 body，反之亦然，互不覆盖。
   */
  function pluginBody() {
    var host = document.getElementById('mioPluginSetBody')
    if (host) return host
    var nativeBody = $q(TAB_BODY)
    if (!nativeBody || !nativeBody.parentNode) return null
    host = document.createElement('div')
    host.id = 'mioPluginSetBody'
    host.style.cssText = 'flex:1;overflow-y:auto;padding:16px 20px;display:none;'
    // 与原生 body 平级，插在它后面
    nativeBody.parentNode.insertBefore(host, nativeBody.nextSibling)
    return host
  }

  function showPluginSettingsPanel(panelObj, tab) {
    var nativeBody = $q(TAB_BODY)
    var body = pluginBody()
    if (!body) return
    // 隐藏原生内容区（不是清空它，保留用户已填的表单）
    if (nativeBody) nativeBody.style.display = 'none'
    body.style.display = 'block'

    var hostId = 'mio-plugin-settings-' + tab.id
    var host = document.getElementById(hostId)

    if (!host) {
      host = document.createElement('div')
      host.id = hostId
      host.setAttribute('data-mio-plugin-panel', tab.id)
      body.appendChild(host)
    }
    // 隐藏同一容器里的其它插件面板
    for (var i = 0; i < body.children.length; i++) {
      var sib = body.children[i]
      if (!sib || sib === host) continue
      sib.style.display = 'none'
    }
    host.style.display = ''
    // 立即给可见占位：renderInto 要等 /api/companion/status 回来（0.6~2s）
    host.innerHTML = ''
    var loading = document.createElement('div')
    loading.style.cssText = 'font-size:12px;color:var(--muted,#687984);padding:18px 4px;'
    loading.textContent = '正在读取配置…'
    host.appendChild(loading)
    // 渲染失败不能静默：抛错时把错误条显示出来（否则用户只看到空白）
    try {
      panelObj.renderInto(host)
      lastRenderError = ''
    } catch (err) {
      lastRenderError = (err && err.message) || String(err)
      host.innerHTML = ''
      var box = document.createElement('div')
      box.style.cssText = 'font-size:12px;line-height:1.7;color:#c0392b;background:#fff2f2;border:1px solid #efc6c6;border-radius:10px;padding:12px 14px;'
      box.textContent = '插件面板渲染失败：' + lastRenderError
      host.appendChild(box)
      try { console.error('[plugin-nav] renderInto 失败', tab.id, err) } catch (e) { /* ignore */ }
    }
  }

  /** 收起插件面板，恢复原生内容区。 */
  function hidePluginSettingsPanels(exceptId) {
    var pluginHost = document.getElementById('mioPluginSetBody')
    if (pluginHost && !exceptId) pluginHost.style.display = 'none'
    var nativeBody = $q(TAB_BODY)
    if (nativeBody && !exceptId) nativeBody.style.display = ''
    for (var id in mountedSettingsTabs) {
      if (exceptId && id === exceptId) continue
      var host = document.getElementById('mio-plugin-settings-' + id)
      if (host) host.style.display = 'none'
    }
    // 插件 tab 自身取消高亮
    for (var pid in mountedSettingsTabs) {
      var b = mountedSettingsTabs[pid].btn
      if (b) { b.style.background = 'transparent'; b.style.color = 'var(--muted, #687984)' }
    }
  }

  // 点原生 tab（不带 data-plugin-tab 的按钮）时收起插件面板
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(TAB_BAR + ' button') : null
    if (!btn) return
    if (btn.getAttribute('data-plugin-tab')) return
    hidePluginSettingsPanels(null)
  }, true)

  function refresh() {
    return fetch('/api/companion/agents', { headers: { 'Cache-Control': 'no-cache' } })
      .then(function (r) { return r.json() })
      .then(function (data) {
        var list = (data && data.agents) || []
        var next = {}
        for (var i = 0; i < list.length; i++) {
          var a = list[i]
          if (a && a.agent_id) next[String(a.agent_id)] = a.enabled !== false
        }
        agentEnabled = next
        var reg = window.__mioPluginRegistry
        if (reg && reg.reconcile) reg.reconcile(list)
        reorderNav()
        applyVisibility()
        mountSettingsTabs()
      })
      .catch(function () { /* 后端暂不可达时保持现状 */ })
  }

  // Vue 重渲染 / 其他脚本重建导航时兜底：重新排序 + 重新显隐
  // 去抖 + 重入保护：mutation 事件合并到宏任务执行，避免高频 DOM 写引发递归
  var repairScheduled = false
  function scheduleRepair() {
    if (repairScheduled) return
    repairScheduled = true
    setTimeout(function () {
      repairScheduled = false
      try { reorderNav(); applyVisibility(); mountSettingsTabs() } catch (e) { /* ignore */ }
    }, 0)
  }
  var mo = new MutationObserver(function () { scheduleRepair() })
  mo.observe(document.body, { childList: true, subtree: true })

  // 启动：尽快执行一次（导航渲染完成前静默等待），8s 轮询兜底覆盖外部 enabled 变化
  function start() {
    refresh()
    setInterval(refresh, POLL_MS)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()

  window.__mioPluginNav = {
    refresh: refresh,
    /**
     * 自检：打印"插件 tab 到底卡在哪一步"。
     * 用户在控制台执行 `__mioPluginNav.debug()` 就能定位，不用再靠猜。
     */
    debug: function () {
      var bar = $q(TAB_BAR)
      var manifests = window.__mioPluginManifests || {}
      var rows = []
      var list = collectSettingsTabs()
      for (var i = 0; i < list.length; i++) {
        var it = list[i]
        var panelName = String(it.tab.panel || '')
        var obj = window[panelName]
        var btn = bar ? bar.querySelector('[data-plugin-tab="' + it.tab.id + '"]') : null
        var reg = window.__mioPluginRegistry
        rows.push({
          tab: it.tab.id,
          label: it.tab.label,
          agentId: it.agentId,
          panelName: panelName,
          panelLoaded: !!(obj && typeof obj.renderInto === 'function'),
          buttonMounted: !!btn,
          buttonVisible: btn ? btn.style.display !== 'none' : false,
          visible: reg && reg.visible ? reg.visible(it.agentId) : null,
        })
      }
      var out = {
        tabBarFound: !!bar,
        tabBarSelector: TAB_BAR,
        bodyFound: !!$q(TAB_BODY),
        manifests: Object.keys(manifests),
        retryRunning: !!mountRetryTimer,
        lastRenderError: lastRenderError,
        tabs: rows,
      }
      try { console.table(rows) } catch (e) { /* ignore */ }
      console.log('[plugin-nav] 自检', out)
      return out
    },
  }
})()
