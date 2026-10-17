/* health-panel-inject.js — 桌宠体检增强
 * 接管原版 CompanionPage 的「体检」面板（.health-simple-panel），做各插件(agent)与本体自检：
 *   - 插件/Agent 自检：agents 接口全量（enabled/status/phase/active/error），小智连接、DSH、Octop 一屏可见
 *   - 本体自检：语音语言（当前语言框架）、后端服务/版本、音频设备、会话 ID
 *   - 小智连接状态修正：同时参考 /api/xiaozhi/status.connected 与 agents 的 enabled/status，避免"连上了显示断开"
 * 轮询刷新（6s），离开体检页 Vue 重渲染后自动重新接管。
 */
(function () {
  'use strict'
  if (window.__mioHealthPanelLoaded) return
  window.__mioHealthPanelLoaded = true

  var POLL_MS = 6000
  var PHASE_NAMES = {
    voice: '发声', executing_tool: '执行工具', awaiting_approval: '等待确认',
    thinking: '思考', planning: '规划', streaming: '流式输出',
    waiting_input: '等待输入', complete: '完成', error: '错误',
    paused: '暂停', heartbeat: '心跳', idle: '空闲',
  }

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function fetchJson(path, fallback) {
    return fetch(path, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .catch(function () { return fallback })
  }

  var data = {
    agents: [], xz: {}, version: {}, settings: {}, audio: { devices: [], banner: '' },
    msg: '',
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function loadAll() {
    return Promise.all([
      fetchJson('/api/companion/agents', { agents: [] }).then(function (j) {
        data.agents = (j && j.agents) || []
      }),
      // DSH 专用化：原来这里还会 fetch /api/xiaozhi/status，用于体检页的「小智连接」行。
      // 小智插件已整体阉割（后端路由与前端入口都已删除），故不再请求该接口。
      // data.xz 保持空对象，下游有 typeof 兜底，不会因缺字段报错。
      fetchJson('/api/companion/version', { data: {} }).then(function (j) {
        data.version = (j && j.data) || {}
      }),
      fetchJson('/api/companion/status', { pet: { settings: {} } }).then(function (j) {
        data.settings = (j && j.pet && j.pet.settings) || {}
      }),
      fetchJson('/api/companion/audio/devices', { devices: [] }).then(function (j) {
        var devices = (j && j.devices) || []
        var def = null
        for (var i = 0; i < devices.length; i++) {
          if (devices[i].is_default) { def = devices[i]; break }
        }
        var banner = '⚠ 未识别到默认输出设备'
        if (def) {
          banner = def.muted
            ? '⚠ 默认设备「' + def.name + '」已静音'
            : (def.volume != null && def.volume < 30
              ? '⚠ 默认设备音量仅 ' + def.volume + '%，建议调大'
              : '✓ 默认设备正常（' + (def.volume == null ? '?' : def.volume + '%') + '）')
        }
        data.audio = { devices: devices, banner: banner }
      }),
    ])
  }

  function langLabel(code) {
    if (code === 'ja') return '日语（ja）'
    if (code === 'zh') return '中文（zh）'
    return esc(code || '中文（zh）')
  }

  function agentRow(a) {
    if (!a) return ''
    var enabled = a.enabled !== false
    var status = a.status || 'unknown'
    var online = status === 'online'
    var phase = PHASE_NAMES[a.phase] || esc(a.phase || '空闲')
    var name = esc(a.name || a.agent_id)
    var badge = enabled
      ? '<b style="background:#37b45c;color:#fff;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:600;">启用</b>'
      : '<b style="background:#b6c2c8;color:#fff;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:600;">停用</b>'
    var statusTxt = online ? '在线' : '离线'
    var statusStyle = online ? 'color:#37b45c;' : 'color:#c0392b;'
    var activeMark = a.active ? '<i style="font-style:normal;color:#3370ff;font-size:11px;">工作中</i>' : ''
    var err = a.error ? '<div style="font-size:11px;color:#c0392b;margin-top:3px;">' + esc(a.error) + '</div>' : ''
    var caps = (a.capabilities && Object.keys(a.capabilities).filter(function (k) { return a.capabilities[k] }).join(' · ')) || ''
    return '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--line, #d9e2e6);">' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
          '<strong style="font-size:12px;color:var(--ink, #20303a);">' + name + '</strong>' +
          badge +
          '<span style="font-size:11px;' + statusStyle + '">' + statusTxt + '</span>' +
          '<span style="font-size:11px;color:var(--muted, #687984);">' + phase + '</span>' +
          activeMark +
        '</div>' +
        '<div style="font-size:11px;color:var(--muted, #687984);margin-top:2px;">' + (caps || '无能力') + '</div>' +
        err +
      '</div>' +
    '</div>'
  }

  // 小智连接行：仅当插件 manifest 声明 health.connection 时显示（小智插件声明；停用/卸载插件则本行消失）
  function connectionAgentId() {
    var reg = window.__mioPluginRegistry
    if (reg && reg.connectionSection) return reg.connectionSection()
    var ms = window.__mioPluginManifests || {}
    for (var id in ms) {
      if (ms[id] && ms[id].health && ms[id].health.connection === true) return id
    }
    return null
  }

  function render(panel) {
    // DSH 专用化：原 xzAgent / xzConnected / xzEnabled / xzOnline / xzLine / connAgentId
    // 全部用于「小智连接」那一行，已随小智插件一并移除。
    var lang = langLabel(data.settings.pet_speech_language)

    var rows = []
    var html =
      '<div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line, #d9e2e6);">' +
        '<strong style="font-size:14px;flex:none;">桌宠体检 · 增强自检</strong>' +
        '<span style="flex:1;font-size:11px;color:var(--muted, #687984);">各插件(agent)与本体状态 · 每 ' + (POLL_MS / 1000) + 's 自动刷新</span>' +
        '<button type="button" data-hp-refresh style="border:1px solid var(--line, #d9e2e6);background:transparent;border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;color:var(--ink, #20303a);">刷新</button>' +
      '</div>'

    // 1) 插件/Agent 自检
    html += '<div style="padding:10px 16px;">' +
      '<div style="font-size:12px;font-weight:600;color:var(--muted, #687984);margin:6px 0 4px;display:flex;align-items:center;gap:6px;">' +
        '<span style="width:4px;height:12px;border-radius:2px;background:var(--accent, #4c8798);"></span>插件 / Agent 自检</div>'
    if (!data.agents.length) html += '<div style="font-size:11px;color:var(--muted, #687984);padding:6px 0;">未读取到 agent 列表</div>'
    for (var a = 0; a < data.agents.length; a++) html += agentRow(data.agents[a])
    html += '</div>'

    // 2) 本体自检
    html += '<div style="padding:0 16px 10px;">' +
      '<div style="font-size:12px;font-weight:600;color:var(--muted, #687984);margin:10px 0 4px;display:flex;align-items:center;gap:6px;">' +
        '<span style="width:4px;height:12px;border-radius:2px;background:var(--accent, #4c8798);"></span>桌宠本体自检</div>'
    html += '<div class="health-rows" style="display:flex;flex-direction:column;gap:7px;font-size:12px;color:var(--ink, #20303a);">' +
      // DSH 专用化：原「小智连接」与「会话 ID」两行随小智插件移除
      //（它们的数据源就是 /api/xiaozhi/status 与小智 agent 记录）
      rowHtml('语音语言（当前框架）', '<b style="font-weight:600;">' + lang + '</b>') +
      rowHtml('后端服务', '<b>' + esc(data.version.name || '-') + '</b>') +
      rowHtml('后端 Python', '<b>' + esc(data.version.python || '-') + '</b>') +
      rowHtml('音频解码', '<b>' + esc(data.version.av || '-') + '</b>') +
      '</div>'
    html += '<div style="font-size:11px;color:var(--muted, #687984);line-height:1.6;margin-top:8px;">' + esc(data.audio.banner) + '</div>'
    if (data.audio.devices.length) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">'
      for (var d = 0; d < data.audio.devices.length; d++) {
        var dv = data.audio.devices[d]
        html += '<span style="border:1px solid var(--line, #d9e2e6);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--muted, #687984);">' +
          esc(dv.name) + (dv.is_default ? ' <b style="color:#3370ff;">默认</b>' : '') + (dv.muted ? ' <b style="color:#c0392b;">静音</b>' : '') +
          ' <i style="font-style:normal;">' + (dv.volume == null ? '?' : dv.volume + '%') + '</i></span>'
      }
      html += '</div>'
    }
    html += '</div>'

    // 3) 测试音
    html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--line, #d9e2e6);">' +
      '<span style="flex:1;font-size:11px;color:var(--muted, #687984);" data-hp-msg>' + esc(data.msg || '') + '</span>' +
      '<button type="button" data-hp-web style="border:1px solid var(--line, #d9e2e6);background:transparent;border-radius:8px;padding:5px 14px;font-size:12px;cursor:pointer;color:var(--ink, #20303a);">网页测试音</button>' +
      '<button type="button" data-hp-sys style="border:none;background:var(--accent, #4c8798);color:#fff;border-radius:8px;padding:5px 14px;font-size:12px;cursor:pointer;">系统测试音</button>' +
      '</div>'

    panel.innerHTML = html

    var ref = $q('[data-hp-refresh]', panel)
    if (ref) ref.addEventListener('click', function () { refreshNow() })
    var web = $q('[data-hp-web]', panel)
    if (web) web.addEventListener('click', playWebTone)
    var sys = $q('[data-hp-sys]', panel)
    if (sys) sys.addEventListener('click', playSystemTone)
  }

  function rowHtml(label, value) {
    return '<div style="display:flex;align-items:center;gap:10px;">' +
      '<span style="flex:1;color:var(--muted, #687984);">' + esc(label) + '</span>' +
      value +
      '</div>'
  }

  function refreshNow() {
    loadAll().then(function () {
      var panel = $q('.health-simple-panel')
      if (panel && panel.__mioHealthTaken) render(panel)
    })
  }

  function playWebTone() {
    data.msg = '已播放网页测试音'
    var panel = $q('.health-simple-panel')
    if (panel) render(panel)
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)()
      var osc = ctx.createOscillator()
      osc.frequency.value = 880
      var gain = ctx.createGain()
      gain.gain.value = 0.4
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      setTimeout(function () { try { osc.stop() } catch (e) {} }, 1500)
    } catch (e) {
      data.msg = '网页测试音播放失败：' + (e && e.message || e)
      if (panel) render(panel)
    }
  }

  function playSystemTone() {
    data.msg = '正在播放系统测试音…'
    var panel = $q('.health-simple-panel')
    if (panel) render(panel)
    fetch('/api/companion/audio/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ freq: 440, seconds: 1.2 }),
    }).then(function (r) { return r.json() })
      .then(function () {
        data.msg = '已播放系统测试音'
        if (panel) render(panel)
      })
      .catch(function (e) {
        data.msg = '播放失败：' + (e && e.message || e)
        if (panel) render(panel)
      })
  }

  // 接管：Vue 渲染/重渲染出 .health-simple-panel 时替换为增强版（每次新节点都接管）
  function takeOver() {
    var panel = $q('.health-simple-panel')
    if (!panel || panel.__mioHealthTaken) return
    panel.__mioHealthTaken = true
    // ★ 先用缓存数据同步渲染一次，再异步刷新最新数据。
    //   若只走 refreshNow()（await 全部接口后才 render），Vue 空壳的占位内容会裸露
    //   一整个取数周期（几百 ms），看起来像"进体检闪一下加载占位"。
    //   render() 对空数据完全防御（全字段有兜底），缓存为空也不会崩。
    try { render(panel) } catch (e) { /* 缓存渲染失败不阻断，等 refreshNow 兜底 */ }
    refreshNow()
  }

  var repairScheduled = false
  function scheduleTakeOver() {
    if (repairScheduled) return
    repairScheduled = true
    setTimeout(function () {
      repairScheduled = false
      try { takeOver() } catch (e) { /* ignore */ }
    }, 0)
  }
  var mo = new MutationObserver(function () { scheduleTakeOver() })
  mo.observe(document.body, { childList: true, subtree: true })

  function start() {
    loadAll()
    setInterval(refreshNow, POLL_MS)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()

  window.__mioHealthPanel = { refresh: refreshNow }
})()
