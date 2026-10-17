/* dsh-panel.js — Mio 左侧导航「DSH」功能页：DSH 实时工作状态与能力自助面板
 * 数据：GET /api/plugin/dsh/status      （插件状态摘要，主数据源）
 *       GET /api/plugin/dsh/phases      （本插件能下发的全部 phase + 语义）
 *       GET /api/plugin/dsh/diagnostics （自检条目）
 *       GET /api/plugin/dsh/about       （关于/自检：版本、环境、脱敏路径）
 *       GET /api/plugin/dsh/update-check（仅点击时联网）
 * 说明：本页是 DSH 插件包**自带**的界面，只读自己的接口；不引用其它插件的任何资源。
 *       配色走原框架 CSS 变量（跟随主题），并用本插件专属强调色 #4F6BED 与其它插件区分。
 * v20261015a：首版——实时状态卡 / 12 态 phase 图例 / 事实面板 / 自检。
 * v20261015b：A5——新增「关于/自检」卡与「检查更新」（仅点击联网，路径由后端脱敏下发）。
 */
(function () {
  if (window.__mioDshPanelLoaded) return
  window.__mioDshPanelLoaded = true

  var ACCENT = '#4F6BED'          // DSH 插件专属色（与 manifest.bubble.accent 一致）
  var POLL_MS = 3000
  var svg = function (p) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'
  }
  // 与「小智工具」页同构的侧栏图标，但内嵌一个"节点/脉冲"语义，标识 DSH 状态源
  var NAV_SVG = svg('<path d="M3 12h4l3-7 4 14 3-7h4"/>')

  var panel = null
  var navBtn = null
  var pollTimer = null

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function findContentArea() {
    var shell = $q('.app-shell')
    if (shell) {
      var main = shell.querySelector('main')
      if (main && main.offsetParent !== null) return main
    }
    var nav = $q('nav')
    if (nav && nav.parentElement) {
      var parent = nav.parentElement.parentElement || nav.parentElement
      var kids = Array.prototype.slice.call(parent.children)
      var idx = kids.indexOf(nav.parentElement)
      if (idx >= 0) {
        var best = null
        for (var i = idx + 1; i < kids.length; i++) {
          var el = kids[i]
          if (el.offsetParent === null || el.getAttribute('aria-hidden') === 'true') continue
          if (!best) { best = el; continue }
          if (el.offsetWidth * el.offsetHeight > best.offsetWidth * best.offsetHeight) best = el
        }
        if (best) return best
      }
    }
    return null
  }

  function card(title, body) {
    return '<div style="border:1px solid var(--line,#d9e2e6);border-radius:10px;background:var(--surface,#fff);padding:14px 16px;">' +
      (title ? '<div style="font-size:12px;font-weight:700;margin-bottom:10px;color:var(--ink,#20303a);">' + title + '</div>' : '') +
      body + '</div>'
  }

  function kv(k, v) {
    return '<div style="display:flex;gap:10px;font-size:12px;line-height:1.9;">' +
      '<span style="flex:none;min-width:88px;color:var(--muted,#687984);">' + k + '</span>' +
      '<span style="flex:1;color:var(--ink,#20303a);word-break:break-all;">' + (v == null || v === '' ? '—' : v) + '</span></div>'
  }

  function stateColor(s) {
    if (s === 'online') return '#2e9e5b'
    if (s === 'connecting') return '#d09b2c'
    if (s === 'error') return '#c0392b'
    if (s === 'offline') return '#8a97a0'
    return '#8a97a0'
  }

  // ────────────────────────────────────────────────────────────────────────
  // ★ 12 态颜色自定义（2026-10-17 用户需求）：每个 phase 一个语义默认色，
  //   用户可在面板里点色块改成任意色，存 localStorage（本机展示偏好，不进后端）。
  // ────────────────────────────────────────────────────────────────────────
  var PHASE_COLOR_KEY = 'dsh_phase_colors'
  var PHASE_DEFAULT_COLORS = {
    planning: '#7c5cd6',
    thinking: '#5b7fd6',
    executing_tool: '#e08a3c',
    streaming: '#2e9e5b',
    waiting_input: '#3c9ad6',
    voice: '#d65b9e',
    awaiting_approval: '#d09b2c',
    idle: '#8a97a0',
    complete: '#5aa88c',
    error: '#c0392b',
    paused: '#9aa5ab',
    heartbeat: '#b9c2c7',
  }

  function loadPhaseColors() {
    try {
      var raw = JSON.parse(window.localStorage.getItem(PHASE_COLOR_KEY) || '{}')
      return (raw && typeof raw === 'object') ? raw : {}
    } catch (e) { return {} }
  }

  function savePhaseColors(colors) {
    try { window.localStorage.setItem(PHASE_COLOR_KEY, JSON.stringify(colors || {})) } catch (e) {}
  }

  function colorOf(phase, colors) {
    return String((colors && colors[phase]) || PHASE_DEFAULT_COLORS[phase] || ACCENT)
  }

  function buildPanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = 'dsh-panel'
    panel.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;z-index:99;display:none;flex-direction:column;' +
      'background:var(--app-bg,#e9eef0);color:var(--ink,#20303a);' +
      'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;'
    panel.innerHTML =
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px;background:var(--sidebar-bg,#f4f7f8);border-bottom:1px solid var(--line,#d9e2e6);">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:' + ACCENT + ';flex:none;"></span>' +
        '<strong style="font-size:14px;flex:none;">DSH</strong>' +
        '<span id="dshSub" style="flex:1;font-size:11px;color:var(--muted,#687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">DeepSeek Harness 实时工作状态</span>' +
        '<button type="button" id="dshReload" title="立即刷新" style="border:none;background:transparent;font-size:15px;cursor:pointer;color:var(--muted,#687984);padding:2px 6px;">⟳</button>' +
        '<button type="button" id="dshClose" title="关闭 DSH 页" style="border:none;background:transparent;font-size:16px;cursor:pointer;color:var(--muted,#687984);padding:2px 6px;">✕</button>' +
      '</div>' +
      '<div style="flex:none;padding:10px 20px;font-size:11px;line-height:1.7;color:var(--muted,#687984);background:var(--surface-soft,#f2f6f7);border-bottom:1px solid var(--line,#d9e2e6);">' +
        'DSH 插件把 DeepSeek Harness 的实时工作状态接入桌宠。本页只读展示本插件自己的状态，' +
        '启停请到「Agent」页。' +
      '</div>' +
      '<div id="dshBody" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;"></div>'

    var host = findContentArea()
    if (host && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
      panel.__hostFixed = true
    }
    ;(host || document.body).appendChild(panel)

    $q('#dshClose', panel).addEventListener('click', function (e) { e.stopPropagation(); hidePanel() })
    $q('#dshReload', panel).addEventListener('click', function (e) { e.stopPropagation(); refresh(true) })
    return panel
  }

  function render(data, phases, diag, about) {
    var body = $q('#dshBody', panel)
    if (!body) return
    var rt = (data && data.runtime) || {}
    var facts = (data && data.facts) || {}
    var caps = (data && data.capabilities) || {}
    var st = String(rt.status || 'offline')

    var html = ''

    // 1) 实时状态卡
    var curPhaseColor = colorOf(rt.phase, loadPhaseColors())
    html += card('实时状态',
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + stateColor(st) + ';flex:none;"></span>' +
        '<strong style="font-size:15px;color:' + curPhaseColor + ';">' + (rt.phase_label || rt.phase || '未知') + '</strong>' +
        '<span style="font-size:11px;color:var(--muted,#687984);">' + st + ' · ' + (rt.phase || '') + '</span>' +
      '</div>' +
      kv('会话', rt.session_id || '') +
      kv('当前工具', facts.last_tool || '') +
      kv('轮次 / 步骤', (facts.turn == null ? '—' : facts.turn) + ' / ' + (facts.step == null ? '—' : facts.step)) +
      kv('工具调用数', facts.tool_calls) +
      kv('进行中工具', facts.active_tools) +
      kv('待办', facts.todos ? facts.todos + ' 项' : '') +
      kv('最近事件', facts.last_event || ''))

    // 2) 事实面板（DSH 独有的运行时事实）
    var chips = []
    if (facts.in_turn) chips.push(['轮次进行中', '#2e9e5b'])
    if (facts.retrying) chips.push(['LLM 重试中', '#d09b2c'])
    if (facts.errored) chips.push(['本阶段有失败', '#c0392b'])
    if (!chips.length) chips.push(['无异常', '#8a97a0'])
    html += card('运行时事实',
      '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
        chips.map(function (c) {
          return '<span style="font-size:11px;padding:3px 10px;border-radius:10px;border:1px solid ' + c[1] + '33;background:' + c[1] + '14;color:' + c[1] + ';">' + c[0] + '</span>'
        }).join('') +
      '</div>')

    // 3) 12 态图例（颜色可自定义：localStorage dsh_phase_colors，自定义优先于语义默认色）
    var list = (phases && phases.phases) || []
    var colors = loadPhaseColors()
    var rows = list.map(function (p) {
      var c = colorOf(p.phase, colors)
      var isCur = p.phase === rt.phase
      var badge = p.work ? '<span style="font-size:10px;padding:1px 7px;border-radius:9px;background:' + c + '1a;color:' + c + ';">徽标</span>' : ''
      var reach = p.fact_reachable ? '' : '<span style="font-size:10px;color:var(--muted,#687984);">（专用路径）</span>'
      return '<div style="display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:7px;' +
        (isCur ? 'background:' + c + '12;' : '') + '">' +
        // 颜色块（点击弹取色器）
        '<label title="点击自定义颜色" style="flex:none;width:16px;height:16px;border-radius:5px;border:1px solid var(--line,#d9e2e6);background:' + c + ';cursor:pointer;position:relative;">' +
          '<input type="color" data-phase-color="' + p.phase + '" value="' + c + '" style="position:absolute;inset:0;opacity:0;cursor:pointer;" />' +
        '</label>' +
        '<span style="flex:none;width:104px;font-size:12px;font-weight:600;color:' + (isCur ? c : 'var(--ink,#20303a)') + ';">' + p.label + '</span>' +
        '<span style="flex:none;width:112px;font-size:11px;color:var(--muted,#687984);font-family:Consolas,monospace;">' + p.phase + '</span>' +
        '<span style="flex:none;width:74px;font-size:11px;color:var(--muted,#687984);">' + (p.hint || '') + '</span>' +
        badge + reach +
        (isCur ? '<span style="flex:none;font-size:10px;color:' + c + ';margin-left:auto;">当前</span>' : '') +
      '</div>'
    }).join('')
    var counts = (phases && phases.counts) || {}
    html += card('可下发的工作状态（' + (counts.registered || 12) + ' 个）',
      '<div style="display:flex;flex-direction:column;gap:2px;">' + rows + '</div>' +
      '<div style="margin-top:10px;display:flex;align-items:center;gap:10px;">' +
        '<span style="flex:1;font-size:11px;color:var(--muted,#687984);line-height:1.7;">' +
          '共 ' + (counts.registered || 0) + ' 个状态注册在总线；其中 ' + (counts.work || 0) + ' 个为工作细分态（桌宠头顶显示徽标），' +
          (counts.fact_reachable || 0) + ' 个可由实时事件直接产出。<br />' +
          '点行首色块可自定义该状态的颜色（保存到本机，立即生效并重渲染）。</span>' +
        '<button type="button" id="dshPhaseColorReset" style="flex:none;border:1px solid var(--line,#d9e2e6);background:var(--surface,#fff);border-radius:7px;padding:5px 12px;font-size:11px;cursor:pointer;color:var(--muted,#687984);">恢复默认颜色</button>' +
      '</div>')

    // 4) 关于 / 自检（A5）
    //    版本号唯一来源是 CHANGELOG 顶部；路径全部由后端脱敏后下发（前端不再自行拼接，
    //    避免把真实用户名带进页面）。
    var ab = (about && about.about) || {}
    var paths = (about && about.paths) || {}
    var files = (about && about.files) || []
    var fileRows = files.map(function (f) {
      return '<div style="display:flex;gap:10px;font-size:11px;line-height:1.8;">' +
        '<span style="flex:none;min-width:110px;color:var(--muted,#687984);font-family:Consolas,monospace;">' + f.name + '</span>' +
        '<span style="color:var(--ink,#20303a);">' + (f.bytes ? (f.bytes / 1024).toFixed(1) + ' KB' : '—') + '</span></div>'
    }).join('')
    html += card('关于 / 自检',
      kv('产品', (ab.product || '') + '　<b style="color:' + ACCENT + ';">' + (ab.version || '') + '</b>') +
      kv('运行环境', (ab.platform || '') + ' · ' + (ab.arch || '') + ' · Python ' + (ab.python || '')) +
      kv('后端进程', 'pid ' + ((about && about.runtime && about.runtime.pid) || '—') +
         '　桌宠 WS ' + (((about && about.runtime && about.runtime.pet_ws && about.runtime.pet_ws.connected) ? '已连接' : '未连接'))) +
      kv('仓库根', paths.repo_root || '') +
      kv('配置', paths.config || '') +
      '<div style="margin-top:8px;">' + fileRows + '</div>' +
      '<div style="margin-top:10px;display:flex;align-items:center;gap:10px;">' +
        '<button type="button" id="dshUpdateCheck" style="border:1px solid ' + ACCENT + '55;background:' + ACCENT + '12;color:' + ACCENT + ';border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer;">检查更新</button>' +
        '<span id="dshUpdateResult" style="font-size:11px;color:var(--muted,#687984);">只在点击时联网</span>' +
      '</div>' +
      '<div style="margin-top:8px;font-size:10px;line-height:1.6;color:var(--muted,#687984);">' +
        (about && about.privacy ? about.privacy : '') + '</div>')

    // 5) 自检
    var chk = (diag && diag.check) || {}
    html += card('自检',
      kv('状态', (chk.state || '') + ' · ' + (chk.detail || '')) +
      kv('边车', chk.sidecar_alive ? '在线' : '未就绪') +
      kv('DSH 进程', chk.dsh_process_running === true ? '运行中' : (chk.dsh_process_running === false ? '未运行' : '未知')) +
      kv('配置', chk.config_path || ''))

    body.innerHTML = html
    bindUpdateCheck()
    bindPhaseColors()

    var sub = $q('#dshSub', panel)
    if (sub) sub.textContent = 'DSH · ' + (rt.phase_label || rt.phase || '—') + ' · ' + st + (ab.version ? ' · ' + ab.version : '')
  }

  // ★ 绑定 12 态颜色自定义（取色器 + 恢复默认）
  function bindPhaseColors() {
    if (!panel) return
    var body = $q('#dshBody', panel)
    if (!body) return
    body.querySelectorAll('input[data-phase-color]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var phase = inp.getAttribute('data-phase-color')
        var val = String(inp.value || '')
        if (!phase || !/^#[0-9a-fA-F]{6}$/.test(val)) return
        var colors = loadPhaseColors()
        colors[phase] = val
        savePhaseColors(colors)
        refresh(false)   // 用新色重渲染当前面板
      })
    })
    var reset = $q('#dshPhaseColorReset', panel)
    if (reset) {
      reset.addEventListener('click', function (e) {
        e.stopPropagation()
        savePhaseColors({})
        refresh(false)
      })
    }
  }

  // 检查更新：**只在用户点击时发请求**（面板本身不轮询、不预取）
  function bindUpdateCheck() {
    var btn = $q('#dshUpdateCheck', panel)
    var out = $q('#dshUpdateResult', panel)
    if (!btn || !out) return
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      btn.disabled = true
      out.textContent = '检查中…'
      fetch('/api/plugin/dsh/update-check', { headers: { 'Cache-Control': 'no-cache' } })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) { out.textContent = (j && j.note) || '检查失败'; return }
          if (!j.checked) { out.textContent = j.note || '已跳过'; return }
          if (j.has_update) {
            out.innerHTML = '有新版本 <b style="color:' + ACCENT + ';">' + j.latest + '</b>（当前 ' + j.current + '）'
          } else if (j.latest) {
            out.textContent = '已是最新（' + j.current + '）'
          } else {
            out.textContent = j.note || '已是最新'
          }
        })
        .catch(function () { out.textContent = '网络不可用，已跳过' })
        .then(function () { btn.disabled = false })
    })
  }

  function refresh(showBusy) {
    return Promise.all([
      fetch('/api/plugin/dsh/status', { headers: { 'Cache-Control': 'no-cache' } }).then(function (r) { return r.json() }).catch(function () { return null }),
      fetch('/api/plugin/dsh/phases', { headers: { 'Cache-Control': 'no-cache' } }).then(function (r) { return r.json() }).catch(function () { return null }),
      fetch('/api/plugin/dsh/diagnostics', { headers: { 'Cache-Control': 'no-cache' } }).then(function (r) { return r.json() }).catch(function () { return null }),
      fetch('/api/plugin/dsh/about', { headers: { 'Cache-Control': 'no-cache' } }).then(function (r) { return r.json() }).catch(function () { return null }),
    ]).then(function (res) {
      if (panel && panel.style.display !== 'none') render(res[0], res[1], res[2], res[3])
    })
  }

  function startPoll() {
    if (pollTimer) return
    pollTimer = window.setInterval(function () {
      if (panel && panel.style.display !== 'none') refresh()
    }, POLL_MS)
  }

  function setNavActive(on) { if (navBtn) navBtn.classList.toggle('active', !!on) }

  function showPanel() {
    buildPanel()
    var host = findContentArea()
    if (host && panel.parentElement !== host) host.appendChild(panel)
    panel.style.display = 'flex'
    setNavActive(true)
    refresh(true)
    startPoll()
  }

  function hidePanel() {
    if (panel) panel.style.display = 'none'
    setNavActive(false)
  }

  function togglePanel() {
    if (panel && panel.style.display !== 'none') hidePanel()
    else showPanel()
  }

  // ★ 点击其它导航项（桌宠/设置等）时自动收起本面板（2026-10-17 修复）。
  //   根因：本面板是 position:absolute 的注入 overlay，不参与 Vue 的 activeView 切换，
  //   点别的导航项时 Vue 只是换了内容区，本面板仍盖在上面 —— 表现为"点别的界面
  //   DSH 页不自动收起、要右上角 ✕ 手动关"。与 settings-panel 的同一机制对齐。
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('nav button.nav-item') : null
    if (!b || b === navBtn) return
    if (panel && panel.style.display !== 'none') hidePanel()
  }, true)

  function ensureNav() {
    if (navBtn && navBtn.isConnected) return
    var nav = $q('nav')
    if (!nav) return
    navBtn = document.createElement('button')
    navBtn.type = 'button'
    navBtn.className = 'nav-item dsh-nav'
    navBtn.title = 'DSH'
    navBtn.innerHTML = NAV_SVG + '<span>DSH</span>'
    navBtn.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      togglePanel()
    })
    nav.appendChild(navBtn)
  }

  function boot() {
    if (!$q('nav')) { window.setTimeout(boot, 400); return }
    ensureNav()
    hidePanel()
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot()
  else document.addEventListener('DOMContentLoaded', boot)
  window.addEventListener('load', function () { if (!navBtn || !navBtn.isConnected) boot() })

  // ────────────────────────────────────────────────────────────────────────
  // ★ 自愈：Vue 重渲染会**删掉**我们手动 append 的导航按钮（既有缺陷，非本次引入）
  // ────────────────────────────────────────────────────────────────────────
  // 原因：`<nav>` 由 Vue 用 v-for 渲染 `navGroups[0].items`（桌宠/设置）。
  // 任何触发该列表重渲染的操作（切视图、窗口尺寸变化、settings 刷新等）都会把 nav
  // 的 children 整体重建，于是外部 append 的 `dsh-nav` 节点**永久消失** ——
  // 表现为「DSH 面板代码明明加载了（__mioDshPanel 存在），但左侧就是没有 DSH 入口」。
  //
  // 实测证据：加载后 window.__mioDshPanelLoaded=true、window.__mioDshPanel 是 object，
  // 但 document.querySelector('.dsh-nav') === null；与 Mao 主仓的 dsh-panel.js
  // 逐字节一致（同一缺陷），属**既有问题**。
  //
  // 修法：监听 body 的 childList 变化，发现 nav 里没有 .dsh-nav 就补回。
  // 用微任务去抖 + 重入保护，避免自己的 append 又触发 observer 造成死循环。
  var repairScheduled = false
  function scheduleRepair() {
    if (repairScheduled) return
    repairScheduled = true
    Promise.resolve().then(function () {
      repairScheduled = false
      try {
        var nav = $q('nav')
        if (!nav) return
        // 已有就什么都不做（防抖的核心：append 自己也会触发 mutation）
        if (nav.querySelector('.dsh-nav')) return
        ensureNav()
      } catch (e) { /* 忽略：自愈失败不应影响页面 */ }
    })
  }
  if (typeof MutationObserver === 'function') {
    try {
      new MutationObserver(scheduleRepair).observe(document.body, { childList: true, subtree: true })
    } catch (e) { /* 忽略 */ }
  }
  // 兜底轮询：极少数情况下 MutationObserver 观察不到（或 body 被整体替换）
  window.setInterval(function () {
    var nav = $q('nav')
    if (nav && !nav.querySelector('.dsh-nav')) scheduleRepair()
  }, 2500)

  // 供其它脚本（如桌宠气泡）查询本插件强调色，保证配色口径一致
  window.__mioDshPanel = { accent: ACCENT, show: showPanel, hide: hidePanel, refresh: refresh, ensureNav: ensureNav }
})()
