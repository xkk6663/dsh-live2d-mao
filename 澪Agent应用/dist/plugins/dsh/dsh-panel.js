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
  //   用户可在面板里点色块改成任意色。
  // ⚠ 存储位置（2026-10-17 修复"重开界面颜色丢失"）：**后端 settings**
  //   （live2d_phase_colors），而不是 localStorage —— 管理窗每次创建都会
  //   clearStorageData()（main.js:219），localStorage 根本不持久。
  //   读：refresh() 从 /api/companion/status 的 pet.settings 拉取后缓存到
  //   phaseColorsState；写：PATCH /api/companion/settings。
  // ────────────────────────────────────────────────────────────────────────
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

  /** 后端下发的自定义色缓存（refresh 时刷新）。null = 还没拉到。 */
  var phaseColorsState = null

  function loadPhaseColors() {
    if (phaseColorsState && typeof phaseColorsState === 'object') return phaseColorsState
    return {}
  }

  function savePhaseColors(colors) {
    phaseColorsState = colors || {}
    try {
      fetch('/api/companion/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ live2d_phase_colors: colors || {} }),
      }).catch(function () {})
    } catch (e) {}
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

  /** 12 态 → 中文标签。与桌宠徽标（live2d-pet.js PHASE_LABELS）保持同一口径。 */
  var PHASE_LABELS_UI = {
    idle: '待机', planning: '规划', thinking: '思考中', executing_tool: '执行工具',
    streaming: '回复中', waiting_input: '聆听中', voice: '说话中', complete: '完成',
    error: '出错', paused: '暂停', awaiting_approval: '待确认', heartbeat: '在线',
  }

  /** 当前 12 态配色表（多会话行要用它取 phase 色）。 */
  function colors0() {
    return loadPhaseColors()
  }

  /**
   * 多会话卡片里的一行：状态点 + 工作区名 + phase + turn/step/tool。
   *
   * 名字用 `a.name`（后端注册时给的就是工作区目录名，如 Mao-dsh-pet / elab-flow），
   * 与桌宠徽标口径一致 —— 两处看到的是同一个名字，不会一个叫 DSH 一个叫目录名。
   */
  function multiSessionRow(a, isMain, colors) {
    var st = String(a.status || 'offline')
    var phase = String(a.phase || 'idle')
    var state = a.state || {}
    var label = (PHASE_LABELS_UI[phase] || phase)
    var phaseColor = colorOf(phase, colors)
    // 显示工作区名（state.badge_name / state.workspace），不显示插件身份名 ——
    // agent.name 恒为 "DSH"，列出来全一样，看不出是哪个项目。
    var name = String((state.badge_name || state.workspace || a.name || a.agent_id || ''))
    var bits = []
    if (state.turn != null) bits.push('轮次 ' + state.turn)
    if (state.step != null) bits.push('步骤 ' + state.step)
    if (state.tool) bits.push('工具 ' + state.tool)
    if (state.tool_calls != null) bits.push('调用 ' + state.tool_calls + ' 次')
    if (state.workspace && state.workspace !== name) bits.push('工作区 ' + state.workspace)
    var meta = bits.join(' · ') || '—'
    var isDone = phase === 'complete' || phase === 'idle'
    var badge = isMain
      ? '<span style="font-size:10px;padding:1px 7px;border-radius:9px;background:#4F6BED1a;color:#4F6BED;">主</span>'
      : ''
    var done = isDone
      ? '<span style="font-size:10px;padding:1px 7px;border-radius:9px;background:#8a97a01a;color:#8a97a0;">已结束</span>'
      : ''
    return '<div style="display:flex;align-items:center;gap:9px;padding:7px 10px;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:var(--surface-soft,#f2f6f7);">' +
      '<span style="width:8px;height:8px;border-radius:50%;background:' + stateColor(st) + ';flex:none;"></span>' +
      '<span style="font-size:12px;font-weight:600;color:var(--ink,#20303a);min-width:130px;">' + name + '</span>' +
      badge + done +
      '<span style="font-size:11px;color:' + phaseColor + ';font-weight:600;min-width:56px;">' + label + '</span>' +
      '<span style="flex:1;font-size:11px;color:var(--muted,#687984);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + meta + '</span>' +
    '</div>'
  }

  function render(data, phases, diag, about, agentsSnapshot) {    var body = $q('#dshBody', panel)
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

    // 1.5) 多会话工作状态（2026-10-26 用户裁决：「优化 dsh 里面前端展示多会话工作状态」）
    //
    //   背景：DSH 允许同时开多个工作区窗口，每个窗口一个会话。
    //   后端会为**正在跑任务**的会话各注册一个 dsh:<短id> 身份
    //   （见 dsh_adapter._publish_multi_session_badges），桌宠头顶也会显示多个徽标。
    //   这里把同一份数据在 DSH 页里列出来，方便看清"到底几个项目在跑、各在干什么"。
    //
    //   数据源用 agents 快照（不是 runtime），因为 runtime 只描述"主会话"。
    //
    //   ★ 子会话识别用**后端声明**的 is_sub 标记（capabilities/state 里都有），
    //     不靠 `dsh:` 前缀猜 —— 前缀是实现细节，后端改命名就会失效；
    //     标记是契约，"这是谁的子会话"由插件自己声明（parent_agent）。
    var allAgents = (agentsSnapshot && agentsSnapshot.agents) || []
    function isSub(a) {
      if (!a) return false
      if (a.state && a.state.is_sub) return true
      if (a.capabilities && a.capabilities.is_sub) return true
      return String(a.agent_id || '').indexOf(':') >= 0
    }
    var subs = allAgents.filter(isSub)
    // 主会话也一起列出来，排在最前（它可能是最活跃的那个）
    var mainAgent = allAgents.filter(function (a) {
      return a && String(a.agent_id || '') === 'dsh'
    })[0]
    var rowsHtml = []
    if (mainAgent) {
      rowsHtml.push(multiSessionRow(mainAgent, true, colors0()))
    }
    subs.forEach(function (a) { rowsHtml.push(multiSessionRow(a, false, colors0())) })
    if (!rowsHtml.length) {
      rowsHtml.push('<div style="font-size:11px;color:var(--muted,#687984);padding:6px 2px;">当前没有正在工作的会话</div>')
    }
    html += card('多会话工作状态',
      '<div style="font-size:11px;color:var(--muted,#687984);margin-bottom:8px;">' +
        '同时开启多个工作区窗口时，这里列出每个正在跑的任务（最多同时显示 3 个徽标）' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' + rowsHtml.join('') + '</div>')

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
      // ★ 12 态自定义色：从 companion settings 拉取（localStorage 在管理窗不持久）
      fetch('/api/companion/status', { headers: { 'Cache-Control': 'no-cache' } })
        .then(function (r) { return r.json() })
        .then(function (j) { return (j && j.pet && j.pet.settings) || {} })
        .catch(function () { return {} }),
      // ★ 2026-10-26 多会话工作状态：总线里 dsh:<短id> 是我为"同时开多个
      //   工作区窗口"注册的子 agent（见 dsh_adapter._publish_multi_session_badges）。
      //   这里取全量快照，筛出 dsh 前缀的条目单独成卡。
      fetch('/api/companion/agents', { headers: { 'Cache-Control': 'no-cache' } })
        .then(function (r) { return r.json() })
        .catch(function () { return null }),
    ]).then(function (res) {
      // 缓存后端下发的自定义色（仅当用户没在本次会话改过时覆盖，避免回写竞态）
      var fromBackend = (res[4] && res[4].live2d_phase_colors) || null
      if (fromBackend && typeof fromBackend === 'object'
        && (!phaseColorsState || Object.keys(phaseColorsState).length === 0)) {
        phaseColorsState = fromBackend
      }
      if (panel && panel.style.display !== 'none') render(res[0], res[1], res[2], res[3], res[5])
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
  //
  // ★★ 2026-10-25 补第二个条件（真机实测暴露）：**自愈必须知道自己已经被卸载了**。
  //   loader 停用插件时会主动摘掉 nav 按钮，但这段自愈看到"nav 里没有 .dsh-nav"
  //   就当成"Vue 把它删了"，立刻又补一个回来 —— 表现为「插件停用了，左侧 DSH 入口还在」，
  //   而且会跟 loader 打乒乓（拔了补、补了拔），只是它以 2.5s 的间隔慢慢补，用户看到的是"关不掉"。
  //   所以先看 registry：这个 id 已经不在注册表里 = 插件被卸载了，自愈必须停手。
  var disposed = false
  function isDisposed() {
    return disposed
  }

  // 供 loader 卸载时调用：彻底停止自愈（否则轮询会一直把它加回来）
  function dispose() {
    disposed = true
    try {
      var nav = $q('nav')
      var b = nav && nav.querySelector('.dsh-nav')
      if (b && b.parentNode) b.parentNode.removeChild(b)
    } catch (e) { /* ignore */ }
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null }
    try { if (mo) mo.disconnect() } catch (e) { /* ignore */ }
  }

  /** 复活：从停用恢复启用时由 loader 调用（脚本幂等守卫不会重跑）。 */
  function revive() {
    if (!disposed) { ensureNav(); return }
    disposed = false
    if (typeof MutationObserver === 'function') {
      try {
        mo = new MutationObserver(scheduleRepair)
        mo.observe(document.body, { childList: true, subtree: true })
      } catch (e) { /* ignore */ }
    }
    if (!pollTimer) {
      pollTimer = window.setInterval(function () {
        if (isDisposed()) { window.clearInterval(pollTimer); pollTimer = null; return }
        var nav = $q('nav')
        if (nav && !nav.querySelector('.dsh-nav')) scheduleRepair()
      }, 2500)
    }
    ensureNav()
  }

  var repairScheduled = false
  function scheduleRepair() {
    if (repairScheduled || isDisposed()) return
    repairScheduled = true
    Promise.resolve().then(function () {
      repairScheduled = false
      try {
        if (isDisposed()) return
        var nav = $q('nav')
        if (!nav) return
        // 已有就什么都不做（防抖的核心：append 自己也会触发 mutation）
        if (nav.querySelector('.dsh-nav')) return
        ensureNav()
      } catch (e) { /* 忽略：自愈失败不应影响页面 */ }
    })
  }
  var mo = null
  if (typeof MutationObserver === 'function') {
    try {
      mo = new MutationObserver(scheduleRepair)
      mo.observe(document.body, { childList: true, subtree: true })
    } catch (e) { /* 忽略 */ }
  }
  // 兜底轮询：极少数情况下 MutationObserver 观察不到（或 body 被整体替换）
  var pollTimer = window.setInterval(function () {
    if (isDisposed()) { window.clearInterval(pollTimer); pollTimer = null; return }
    var nav = $q('nav')
    if (nav && !nav.querySelector('.dsh-nav')) scheduleRepair()
  }, 2500)

  // 供其它脚本（如桌宠气泡）查询本插件强调色，保证配色口径一致
  window.__mioDshPanel = { accent: ACCENT, show: showPanel, hide: hidePanel, refresh: refresh, ensureNav: ensureNav, dispose: dispose, revive: revive }
})()
