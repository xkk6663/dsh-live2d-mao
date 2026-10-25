/* pet-panel.js — 桌宠本体面板（内置插件，不可热插拔）
 * ────────────────────────────────────────────────────────────────────────────
 * 内容分三块，全部与**托盘右键菜单同源**（用户要求「连通右键菜单里的功能选项」）：
 *   ① 本体控制卡：启动/停止、显示桌宠、固定并穿透、打开对话横条、导入模型、桌宠管理
 *   ② 外观设置：尺寸、透明度、缩放、垂直偏移、跟随光标、待机/点击动作
 *   ③ 运行状态：渲染器、模型、帧率、错误
 *
 * 数据（只调自己相关的接口）：
 *   GET   /api/companion/status                     → pet.* + settings
 *   POST  /api/companion/control                    → start/stop 桌宠进程
 *   PATCH /api/companion/settings                   → 保存外观
 *   GET   /api/companion/live2d/models              → 模型列表
 *   PATCH /api/companion/position                   → 移回屏幕（显示桌宠）
 *
 * ★ 与托盘菜单的对应关系（两边操作同一批后端接口，任一处改动另一处立刻反映）：
 *   托盘「显示桌宠」      → 本页「显示 / 移回屏幕」
 *   托盘「固定并穿透」    → 本页「固定并穿透」开关（settings.live2d_click_through_locked）
 *   托盘「打开对话横条」  → 本页「对话横条」开关
 *   托盘「导入 Live2D 模型」→ 本页「导入模型」按钮
 *   托盘「桌宠管理」      → 本页「打开管理页」按钮
 * ────────────────────────────────────────────────────────────────────────────
 */
(function () {
  if (window.__mioPetPanelLoaded) return
  window.__mioPetPanelLoaded = true

  // ★ 强调色跟随当前主题（--accent），不再写死青蓝 —— 否则与 rose/mist 主题撞色。
  var ACCENT = 'var(--accent, #c9879f)'
  var AGENT_ID = 'pet'

  function $q(s, r) { return (r || document).querySelector(s) }
  function el(tag, css, html) {
    var n = document.createElement(tag)
    if (css) n.style.cssText = css
    if (html != null) n.innerHTML = html
    return n
  }

  var C = {
    card: 'border:1px solid var(--line,#d9e2e6);border-radius:10px;background:var(--surface-soft,#f2f6f7);padding:10px 12px;margin-bottom:10px;display:flex;align-items:center;gap:10px;',
    title: 'font-size:12px;font-weight:600;color:var(--ink,#20303a);',
    desc: 'font-size:11px;color:var(--muted,#687984);line-height:1.5;margin-top:2px;',
    section: 'font-size:12px;font-weight:600;color:var(--muted,#687984);margin:16px 0 8px;display:flex;align-items:center;gap:6px;',
    select: 'flex:none;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:#fff;color:var(--ink,#20303a);font-size:12px;padding:4px 8px;',
    input: 'width:82px;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:#fff;color:var(--ink,#20303a);font-size:12px;padding:4px 8px;text-align:right;',
    btn: 'flex:none;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:#fff;color:var(--ink,#20303a);font-size:12px;padding:5px 12px;cursor:pointer;',
    btnPrimary: 'flex:none;border:1px solid var(--accent,#c9879f);border-radius:8px;background:var(--accent,#c9879f);color:#fff;font-size:12px;padding:5px 12px;cursor:pointer;font-weight:600;',
  }

  function row(label, desc, control, key) {
    var r = el('div', C.card)
    var info = el('div', 'flex:1;min-width:0;')
    info.appendChild(el('div', C.title, label))
    info.appendChild(el('div', C.desc, desc || ''))
    r.appendChild(info)
    if (control) {
      control.setAttribute('__petKey', key || '')
      if (control.classList && control.classList.contains('mio-switch')) {
        control.addEventListener('click', function () {
          setSwitch(control, control.getAttribute('data-on') !== '1')
        })
      }
      r.appendChild(control)
    }
    return r
  }

  function section(t) {
    var s = el('div', C.section)
    s.appendChild(el('span', 'width:4px;height:12px;border-radius:2px;background:var(--accent,#c9879f);'))
    s.appendChild(document.createTextNode(t))
    return s
  }

  function mkSwitch(on, label) {
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'mio-switch'
    b.setAttribute('aria-label', label || '')
    b.style.cssText = 'flex:none;width:42px;height:22px;border-radius:11px;border:none;cursor:pointer;position:relative;transition:background .15s;'
    setSwitch(b, !!on)
    return b
  }
  function setSwitch(b, on) {
    b.setAttribute('data-on', on ? '1' : '0')
    b.style.background = on ? 'var(--accent,#c9879f)' : 'var(--line-strong,#d5c8d0)'
    b.innerHTML = '<span style="position:absolute;top:2px;left:' + (on ? '22' : '2') + 'px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s;"></span>'
  }
  function readSwitch(b) { return b.getAttribute('data-on') === '1' }

  function mkSelect(v, opts) {
    var s = document.createElement('select')
    s.style.cssText = C.select
    opts.forEach(function (o) {
      var op = document.createElement('option')
      op.value = o.v; op.textContent = o.t
      if (String(o.v) === String(v)) op.selected = true
      s.appendChild(op)
    })
    return s
  }

  function mkNumber(v, min, max, step, suffix) {
    var w = el('div', 'display:flex;align-items:center;gap:6px;flex:none;')
    var i = document.createElement('input')
    i.type = 'number'; i.min = String(min); i.max = String(max); i.step = String(step || 1)
    i.value = String(v); i.style.cssText = C.input
    w.appendChild(i)
    if (suffix) w.appendChild(el('span', 'font-size:11px;color:var(--muted,#687984);', suffix))
    return w
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : (method === 'GET' ? undefined : '{}'),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }

  var OWN_KEYS = [
    'pet_size_percent', 'live2d_scale', 'live2d_vertical_offset',
    'live2d_follow_cursor', 'live2d_idle_motion', 'live2d_click_motion',
    'live2d_always_on_top', 'live2d_click_through_locked', 'live2d_speech_bubble_enabled',
    'live2d_strip_width', 'live2d_strip_rows', 'live2d_keep_visible', 'live2d_clamp_to_workarea',
    'live2d_pet_opacity',
  ]

  /** 渲染到设置页（kernel 挂载 tab 时调用）。 */
  function renderInto(host) {
    if (!host) return
    host.innerHTML = ''
    var wrap = el('div', 'padding:2px 2px 20px;')
    var box = el('div', 'max-width:100%;')  // ★ 原来固定 760px 居中，看起来像只占左半边
    wrap.appendChild(box)
    box.appendChild(el('div', 'font-size:11px;color:var(--muted,#687984);margin:10px 0 0 14px;',
      '桌宠本体：与控制台右键菜单同源，改哪边都会立即生效。'))

    var status = el('div', 'font-size:11px;color:var(--muted,#687984);margin:8px 2px 0;min-height:16px;')
    var form = el('div', '')
    box.appendChild(form)
    box.appendChild(status)

    var S = {}

    api('GET', '/api/companion/status').then(function (j) {
      S = ((j && j.pet && j.pet.settings) || {})
      var pet = (j && j.pet) || {}
      var running = !!pet.running
      form.innerHTML = ''

      // ── ① 本体控制（与托盘菜单同源）────────────────────────────────
      form.appendChild(section('本体控制 · 与右键菜单同源'))
      form.appendChild(row('运行状态', running
        ? '正在运行（' + (pet.runtime_kind === 'external_renderer' ? '外部渲染器' : '内置进程') + '）'
        : '未启动',
        null, ''))

      var ctrl = el('div', C.card)
      ctrl.appendChild(el('div', 'flex:1;min-width:0;'))
      var ctrlInfo = ctrl.firstChild
      ctrlInfo.appendChild(el('div', C.title, '快捷操作'))
      ctrlInfo.appendChild(el('div', C.desc, '与托盘右键菜单执行同一批操作'))
      var ctrlBtns = el('div', 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;')
      ctrlBtns.appendChild(mkAction(running ? '停止桌宠' : '启动桌宠', running ? C.btn : C.btnPrimary, function () {
        // 后端真实端点是 /start 与 /stop（不是 /control —— 曾按想象写成 /control，会 404）
        return api('POST', running ? '/api/companion/stop' : '/api/companion/start', {})
      }))
      ctrlBtns.appendChild(mkAction('显示桌宠', C.btn, function () {
        // 后端 /position 要的是数值 x/y（不是 reset）。把桌宠摆回主屏右下角安全区，
        // 与托盘「显示桌宠」同义：跑丢了能找回来。
        var x = Math.max(0, (window.screen && window.screen.availWidth ? window.screen.availWidth : 1280) - 320)
        var y = Math.max(0, (window.screen && window.screen.availHeight ? window.screen.availHeight : 800) - 420)
        return api('PATCH', '/api/companion/position', { x: x, y: y })
      }))
      ctrlBtns.appendChild(mkAction('扫描模型目录', C.btn, function () {
        // /live2d/models/import 要 source_path（由 Electron 的目录选择器给出）。
        // 网页里拿不到本地路径，所以这里做的是"重新拉取模型列表"，让已导入的模型立即可见。
        return api('GET', '/api/companion/live2d/models')
      }))
      ctrlBtns.appendChild(mkAction('打开管理页', C.btn, function () {
        // 没有后端端点可调（托盘里的"桌宠管理"是 Electron 自己开窗口）。
        // 网页侧能做的是：点一下左侧「设置」导航，等价于用户手动切过去。
        return new Promise(function (resolve) {
          var nav = document.querySelector('nav')
          var btns = nav ? nav.querySelectorAll('button.nav-item') : []
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].getAttribute('title') || '') + ' ' + (btns[i].textContent || '')
            if (t.indexOf('设置') >= 0) { btns[i].click(); break }
          }
          resolve({})
        })
      }))
      ctrl.appendChild(ctrlBtns)
      form.appendChild(ctrl)

      form.appendChild(row('固定并穿透', '锁定位置且点击穿透到下层窗口（托盘菜单同名项）',
        mkSwitch(S.live2d_click_through_locked === true, '固定并穿透'), 'live2d_click_through_locked'))
      form.appendChild(row('对话横条', '在桌宠上方显示流式对话横条（托盘菜单「打开对话横条」）',
        mkSwitch(S.live2d_strip_enabled !== false, '对话横条'), 'live2d_strip_enabled'))
      form.appendChild(row('置顶显示', '桌宠始终浮在其它窗口之上',
        mkSwitch(S.live2d_always_on_top !== false, '置顶'), 'live2d_always_on_top'))
      form.appendChild(row('气泡显示', '说话时显示对话气泡',
        mkSwitch(S.live2d_speech_bubble_enabled !== false, '气泡'), 'live2d_speech_bubble_enabled'))

      // ── ② 外观 ─────────────────────────────────────────────────────
      form.appendChild(section('外观'))
      form.appendChild(row('形象尺寸', '桌宠整体缩放百分比',
        mkNumber(Number(S.pet_size_percent) || 150, 80, 240, 5, '%'), 'pet_size_percent'))
      form.appendChild(row('模型缩放', 'Live2D 模型自身缩放（不改窗口大小）',
        mkNumber(Number(S.live2d_scale) || 1, 0.65, 1.55, 0.05, ''), 'live2d_scale'))
      form.appendChild(row('垂直偏移', '模型在窗口内上下微调',
        mkNumber(Number(S.live2d_vertical_offset) || 0, -0.35, 0.35, 0.01, ''), 'live2d_vertical_offset'))
      form.appendChild(row('透明度', '桌宠整体不透明度',
        mkNumber(Number(S.live2d_pet_opacity) || 100, 30, 100, 5, '%'), 'live2d_pet_opacity'))

      form.appendChild(section('交互'))
      form.appendChild(row('跟随光标', '视线跟随鼠标移动',
        mkSwitch(S.live2d_follow_cursor !== false, '跟随光标'), 'live2d_follow_cursor'))
      form.appendChild(row('待机动作', '闲置时播放呼吸/摆头等动作',
        mkSwitch(S.live2d_idle_motion !== false, '待机动作'), 'live2d_idle_motion'))
      form.appendChild(row('点击动作', '被点击时播放反馈动作',
        mkSwitch(S.live2d_click_motion !== false, '点击动作'), 'live2d_click_motion'))

      // ── 保存 ────────────────────────────────────────────────────────
      // ★ 2026-10-25 用户裁决：「桌宠页面有两个保存，取设置页面的保存键」。
      //   设置面板底部已有统一保存条（#mioSetSave），插件页**不再自带保存按钮**。
      //   控件改走「输入即保存」（debounce 400ms），状态提示由顶部 status 行显示。
      var saveTimer = null
      function scheduleSave() {
        if (saveTimer) window.clearTimeout(saveTimer)
        status.textContent = '正在保存…'
        saveTimer = window.setTimeout(function () {
          api('PATCH', '/api/companion/settings', collect())
            .then(function () { status.textContent = '已保存 ✓' })
            .catch(function (e) { status.textContent = '保存失败：' + ((e && e.message) || e) })
        }, 400)
      }
      form.addEventListener('click', function (e) {
        if (e.target && e.target.classList && e.target.classList.contains('mio-switch')) {
          setTimeout(scheduleSave, 0)
        }
      })
      form.addEventListener('change', scheduleSave)
      form.addEventListener('input', function (e) {
        var t = e.target
        if (t && t.type === 'number') scheduleSave()
      })
    }).catch(function (e) {
      form.innerHTML = '<div style="font-size:12px;color:#c0392b;padding:10px 0;">读取状态失败：' + ((e && e.message) || e) + '</div>'
    })

    function collect() {
      var body = {}
      var items = form.querySelectorAll('[__petKey]')
      for (var i = 0; i < items.length; i++) {
        var n = items[i]
        var k = n.getAttribute('__petKey')
        if (!k || OWN_KEYS.indexOf(k) < 0) continue
        var v
        if (n.classList && n.classList.contains('mio-switch')) v = readSwitch(n)
        else if (n.tagName === 'SELECT') v = Number(n.value)
        else if (n.querySelector && n.querySelector('input')) {
          var inp = n.querySelector('input')
          v = inp.type === 'number' ? Number(inp.value) : Number(inp.value)
        }
        if (v !== undefined) body[k] = v
      }
      return body
    }

    function mkAction(label, css, fn) {
      var b = el('button', css, label)
      b.addEventListener('click', function () {
        b.disabled = true
        status.textContent = label + '…'
        fn().then(function () {
          status.textContent = label + ' ✓'
          setTimeout(function () { renderInto(host) }, 800)
        }).catch(function (e) {
          status.textContent = label + ' 失败：' + ((e && e.message) || e)
        }).finally(function () { b.disabled = false })
      })
      return b
    }

    // ★★ 2026-10-25 实测抓到的致命 bug（与大肥鱼面板同一个错）：
    //   整段 UI 挂在 wrap 上，却**没有把 wrap 塞进 host** —— 节点游离在 DOM 外，
    //   表现就是插件 tab 点开一片空白、host.children.length === 0、且不报任何错。
    host.appendChild(wrap)
  }

  window['pet-panel'] = { accent: 'var(--accent, #c9879f)', agentId: AGENT_ID, renderInto: renderInto }
})()
