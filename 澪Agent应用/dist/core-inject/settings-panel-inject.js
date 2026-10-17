/* settings-panel-inject.js — 重建设置页：废弃原版设置 UI，内嵌主界面框架的自有设置面板
 *
 * 数据源：
 *   GET  /api/companion/status                     → pet.settings（桌宠/语音/观察键）
 *   GET  /api/xiaozhi/observe/status               → 自动观察配置（enabled/min/max/quiet）
 *   GET  /api/xiaozhi/prompts                      → 图片识别/观察提示词
 *   GET  /api/companion/live2d/schedule            → 模型自动更换
 *   GET  /api/xiaozhi/status                       → 小智绑定/设备码
 *   GET  /api/settings/profile                     → Mio 资料（名称/头像 custom）
 * 保存：
 *   PATCH /api/companion/settings                   → 桌宠+语音+屏幕观察键
 *   POST  /api/xiaozhi/observe/start | /observe/stop → 自动观察
 *   PUT   /api/xiaozhi/prompts                      → 提示词
 *   PATCH /api/companion/live2d/schedule            → 模型调度
 *   PATCH /api/settings/profile                     → Mio 名称
 *   POST  /api/settings/avatar | DELETE             → 侧栏头像上传/重置
 *
 * UI：内嵌原版内容区（保留侧边栏/顶栏），样式走原框架 CSS 变量，观感统一。
 * 导航：点击原版「设置」导航项 → 打开本面板（不再进入原版设置页）。
 */
(function () {
  'use strict'
  if (window.__mioSettingsPanelLoaded) return
  window.__mioSettingsPanelLoaded = true

  // ---------- 工具 ----------
  function $q(sel, root) { return (root || document).querySelector(sel) }

  function apiGet(path) {
    return fetch(path).then(function (r) { return r.json() })
  }
  function apiSend(path, method, body) {
    return fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json() })
  }

  // ---------- 原框架内容区探测（与 mcp-tools-panel 一致） ----------
  function findShell() { return $q('.app-shell') }
  function findContentArea() {
    var shell = findShell()
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
          var a = el.offsetWidth * el.offsetHeight
          var b = best.offsetWidth * best.offsetHeight
          if (a > b) best = el
        }
        if (best) return best
      }
    }
    return null
  }

  // ---------- 导航：隐藏原版「设置」项，原位插入自有「设置」按钮（不带 Vue 事件） ----------
  var navBtn = null
  var ourBtn = null
  function ensureNav() {
    var nav = $q('nav')
    if (!nav) return
    var btns = nav.querySelectorAll('button.nav-item')
    var orig = null
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].__mioOurBtn) continue // 跳过我们自己的按钮
      var t = (btns[i].getAttribute('title') || '') + (btns[i].textContent || '')
      if (t.indexOf('设置') >= 0 && t.indexOf('小智') < 0) { orig = btns[i]; break }
    }
    if (!orig) return
    // 隐藏原版设置按钮（Vue 重渲染后恢复 → keepAlive 再次隐藏）
    if (!orig.__mioHidden) {
      orig.style.display = 'none'
      orig.__mioHidden = true
    }
    // 原位插入我们的按钮（clone 外观，去掉数据绑定属性，绑定自有 handler）
    if (!ourBtn || !ourBtn.isConnected) {
      ourBtn = orig.cloneNode(true)
      ourBtn.__mioOurBtn = true
      ourBtn.removeAttribute('data-scu-ref')
      ourBtn.addEventListener('click', function (e) {
        e.preventDefault()
        e.stopPropagation()
        togglePanel()
      })
      orig.parentNode.insertBefore(ourBtn, orig)
    }
    // 确保我们的按钮始终可见（clone 可能复制了 display:none / Vue 可能置 hide）
    ourBtn.style.display = ''
    navBtn = ourBtn
  }

  // ---------- 面板 ----------
  var panel = null
  var state = {
    settings: {}, observe: {}, prompts: {}, schedule: {}, xz: {}, profile: {},
  }
  var activeTab = 'profile'

  var TABS = [
    { id: 'profile', label: '资料' },
    { id: 'pet', label: '桌宠' },
    { id: 'voice', label: '语音' },
    // DSH 专用化：原「屏幕观察」「提示词」「小智」三个 tab 已移除。
    // 它们全部服务于小智插件（自动截屏让小智点评 / 图片识别提示词 / 小智设备绑定），
    // 小智插件已整体阉割（后端 /api/xiaozhi/* 路由与前端入口都已删除）。
    // 保留它们只会渲染出"永远读不到数据、点保存就报错"的空界面。
    { id: 'bubble', label: '泡泡' },
  ]

  function setNavActive(on) {
    if (navBtn) navBtn.classList.toggle('active', !!on)
  }

  function buildPanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = 'mio-settings-panel'
    panel.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;z-index:98;display:none;flex-direction:column;' +
      'background:var(--app-bg, #e9eef0);color:var(--ink, #20303a);' +
      'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;'
    panel.innerHTML =
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:12px 20px;background:var(--sidebar-bg, #f4f7f8);border-bottom:1px solid var(--line, #d9e2e6);">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:var(--accent, #4c8798);flex:none;"></span>' +
        '<strong style="font-size:14px;flex:none;">设置</strong>' +
        '<span style="flex:1;font-size:11px;color:var(--muted, #687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" id="mioSetStatus">桌宠 · 语音 · 观察 · 提示词 · 小智</span>' +
        '<button type="button" id="mioSetClose" title="关闭设置" style="border:none;background:transparent;font-size:16px;cursor:pointer;color:var(--muted, #687984);padding:2px 6px;">✕</button>' +
      '</div>' +
      '<div style="flex:none;display:flex;gap:4px;padding:8px 20px;background:var(--surface-soft, #f2f6f7);border-bottom:1px solid var(--line, #d9e2e6);" id="mioSetTabs"></div>' +
      '<div id="mioSetBody" style="flex:1;overflow-y:auto;padding:16px 20px;"></div>' +
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:10px 20px;border-top:1px solid var(--line, #d9e2e6);background:var(--sidebar-bg, #f4f7f8);">' +
        '<span style="flex:1;font-size:11px;color:var(--muted, #687984);" id="mioSetHint">修改后点击保存生效</span>' +
        '<button type="button" id="mioSetCancel" style="border:1px solid var(--line, #d9e2e6);background:transparent;border-radius:8px;padding:6px 18px;font-size:12px;cursor:pointer;color:var(--ink, #20303a);">取消</button>' +
        '<button type="button" id="mioSetSave" style="border:none;background:var(--accent, #4c8798);color:#fff;border-radius:8px;padding:6px 22px;font-size:12px;cursor:pointer;">保存</button>' +
      '</div>'
    // 内容区可能无 position:relative，补上
    var host = findContentArea()
    if (host && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
      panel.__mioHostFixed = true
    }
    ;(host || document.body).appendChild(panel)
    $q('#mioSetClose', panel).addEventListener('click', deactivate)
    $q('#mioSetCancel', panel).addEventListener('click', deactivate)
    $q('#mioSetSave', panel).addEventListener('click', saveAll)
    buildTabs()
    return panel
  }

  function buildTabs() {
    var bar = $q('#mioSetTabs', panel)
    if (!bar) return
    bar.innerHTML = ''
    TABS.forEach(function (t) {
      var b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('data-tab', t.id)
      b.textContent = t.label
      b.style.cssText = 'border:none;background:transparent;border-radius:8px;padding:5px 14px;font-size:12px;cursor:pointer;color:var(--muted, #687984);'
      b.addEventListener('click', function () { setTab(t.id) })
      bar.appendChild(b)
    })
    setTab(activeTab)
  }

  function setTab(id) {
    activeTab = id
    var bar = $q('#mioSetTabs', panel)
    if (bar) {
      var btns = bar.querySelectorAll('button[data-tab]')
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-tab') === id
        btns[i].style.background = on ? 'var(--accent, #4c8798)' : 'transparent'
        btns[i].style.color = on ? '#fff' : 'var(--muted, #687984)'
      }
    }
    renderBody(id)
  }

  // ---------- 控件 ----------
  function makeSwitch(checked, title) {
    var sw = document.createElement('button')
    sw.type = 'button'
    sw.className = 'mio-set-switch'
    sw.setAttribute('data-on', checked ? '1' : '0')
    sw.title = title || ''
    sw.style.cssText = 'flex:none;width:38px;height:22px;border-radius:11px;border:none;cursor:pointer;position:relative;transition:background .18s;' + (checked ? 'background:var(--accent, #4c8798);' : 'background:var(--line-strong, #c4d1d7);')
    var knob = document.createElement('span')
    knob.style.cssText = 'position:absolute;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .18s;' + (checked ? 'left:18px;' : 'left:2px;')
    sw.appendChild(knob)
    return sw
  }
  function readSwitch(sw) { return sw.getAttribute('data-on') === '1' }
  function setSwitch(sw, on) {
    sw.setAttribute('data-on', on ? '1' : '0')
    sw.style.background = on ? 'var(--accent, #4c8798)' : 'var(--line-strong, #c4d1d7)'
    sw.querySelector('span').style.left = on ? '18px' : '2px'
  }

  function row(label, desc, control, key, onChanged) {
    var r = document.createElement('div')
    r.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface-soft, #f2f6f7);border:1px solid var(--line, #d9e2e6);border-radius:10px;margin-bottom:10px;'
    var info = document.createElement('div')
    info.style.cssText = 'flex:1;min-width:0;'
    var nm = document.createElement('div')
    nm.style.cssText = 'font-size:12px;font-weight:600;color:var(--ink, #20303a);'
    nm.textContent = label
    var ds = document.createElement('div')
    ds.style.cssText = 'font-size:11px;color:var(--muted, #687984);line-height:1.5;margin-top:2px;'
    ds.textContent = desc || ''
    info.appendChild(nm)
    info.appendChild(ds)
    r.appendChild(info)
    if (control) {
      control.setAttribute('__mioKey', key)
      r.appendChild(control)
      // switch 点击自动翻转
      if (control.classList && control.classList.contains('mio-set-switch')) {
        control.addEventListener('click', function () {
          setSwitch(control, !readSwitch(control))
        })
      }
      if (onChanged) {
        control.addEventListener('click', function () { onChanged(control, readSwitch(control)) }, true)
        control.addEventListener('input', function () { onChanged(control, control.value) })
        control.addEventListener('change', function () { onChanged(control, control.value) })
      }
    }
    return r
  }

  function section(title) {
    var s = document.createElement('div')
    s.style.cssText = 'font-size:12px;font-weight:600;color:var(--muted, #687984);margin:14px 0 8px;display:flex;align-items:center;gap:6px;'
    var dot = document.createElement('span')
    dot.style.cssText = 'width:4px;height:12px;border-radius:2px;background:var(--accent, #4c8798);'
    s.appendChild(dot)
    s.appendChild(document.createTextNode(title))
    return s
  }

  function makeSlider(value, min, max, step, suffix) {
    var wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex:none;'
    var inp = document.createElement('input')
    inp.type = 'range'
    inp.min = String(min)
    inp.max = String(max)
    inp.step = String(step || 1)
    inp.value = String(value)
    inp.style.cssText = 'width:120px;accent-color:var(--accent, #4c8798);'
    var val = document.createElement('span')
    val.style.cssText = 'font-size:11px;color:var(--ink, #20303a);min-width:42px;text-align:right;'
    val.textContent = value + (suffix || '')
    inp.addEventListener('input', function () { val.textContent = inp.value + (suffix || '') })
    wrap.appendChild(inp)
    wrap.appendChild(val)
    wrap.__mioInput = inp
    wrap.__mioVal = val
    return wrap
  }
  function readSlider(wrap) { return Number(wrap.__mioInput.value) }

  function makeSelect(value, options) {
    var sel = document.createElement('select')
    sel.style.cssText = 'flex:none;border:1px solid var(--line, #d9e2e6);border-radius:8px;background:var(--surface-soft, #f2f6f7);color:var(--ink, #20303a);font-size:12px;padding:4px 8px;'
    options.forEach(function (o) {
      var op = document.createElement('option')
      op.value = o.v
      op.textContent = o.t
      if (String(o.v) === String(value)) op.selected = true
      sel.appendChild(op)
    })
    return sel
  }
  function readSelect(sel) { return sel.value }

  function makeText(text) {
    var ta = document.createElement('textarea')
    ta.style.cssText = 'flex:none;width:220px;height:52px;border:1px solid var(--line, #d9e2e6);border-radius:8px;background:var(--surface-soft, #f2f6f7);color:var(--ink, #20303a);font-size:12px;padding:6px 8px;resize:none;'
    ta.value = text || ''
    return ta
  }
  function readText(ta) { return ta.value.trim() }

  // 可复用头像设置行：预览 + 上传/恢复默认（用于侧栏头像/对话发送方/对话接收方）
  // opt: { previewId, src, title, desc, custom, onSelect(dataUrl), onReset() }
  function makeAvatarRow(opt) {
    var row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:14px;padding:12px;background:var(--surface-soft, #f2f6f7);border:1px solid var(--line, #d9e2e6);border-radius:10px;margin-bottom:10px;'
    var img = document.createElement('img')
    img.id = opt.previewId
    img.src = opt.src + '?v=' + Date.now()
    img.style.cssText = 'width:56px;height:56px;border-radius:50%;object-fit:cover;flex:none;border:1px solid var(--line, #d9e2e6);background:var(--line-strong, #c4d1d7);'
    var col = document.createElement('div')
    col.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:4px;align-items:flex-start;min-width:0;'
    var ttl = document.createElement('div')
    ttl.style.cssText = 'font-size:12px;font-weight:600;color:var(--ink, #20303a);'
    ttl.textContent = opt.title || ''
    var dsc = document.createElement('div')
    dsc.style.cssText = 'font-size:11px;color:var(--muted, #687984);line-height:1.5;'
    dsc.textContent = opt.desc || ''
    var btns = document.createElement('div')
    btns.style.cssText = 'display:flex;gap:8px;margin-top:4px;'
    var btnUpload = document.createElement('button')
    btnUpload.type = 'button'
    btnUpload.textContent = opt.custom ? '更换头像' : '上传头像'
    btnUpload.style.cssText = 'border:none;background:var(--accent, #4c8798);color:#fff;border-radius:8px;padding:5px 14px;font-size:12px;cursor:pointer;'
    var btnReset = document.createElement('button')
    btnReset.type = 'button'
    btnReset.textContent = '恢复默认'
    btnReset.style.cssText = 'border:1px solid var(--line, #d9e2e6);background:transparent;border-radius:8px;padding:5px 14px;font-size:12px;cursor:pointer;color:var(--muted, #687984);'
    var fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/*'
    fileInput.style.display = 'none'
    btnUpload.addEventListener('click', function () { fileInput.click() })
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0]
      if (!f) return
      var reader = new FileReader()
      reader.onload = function () {
        opt.onSelect && opt.onSelect(String(reader.result))
        var prev = $q('#' + opt.previewId, panel)
        if (prev) prev.src = String(reader.result)
        btnUpload.textContent = '已选择 · 点保存生效'
      }
      reader.readAsDataURL(f)
    })
    btnReset.addEventListener('click', function () {
      opt.onReset && opt.onReset()
      var prev = $q('#' + opt.previewId, panel)
      if (prev) prev.src = opt.src + '?v=' + Date.now()
      btnUpload.textContent = opt.custom ? '更换头像' : '上传头像'
    })
    btns.appendChild(btnUpload)
    btns.appendChild(btnReset)
    col.appendChild(ttl)
    col.appendChild(dsc)
    col.appendChild(btns)
    row.appendChild(img)
    row.appendChild(col)
    row.appendChild(fileInput)
    return row
  }

  // ---------- 渲染 ----------
  function renderBody(id) {
    var body = $q('#mioSetBody', panel)
    if (!body) return
    body.innerHTML = ''
    var s = state.settings || {}
    if (id === 'profile') {
      var pf = state.profile || {}
      body.appendChild(section('头像'))
      body.appendChild(makeAvatarRow({
        previewId: 'mioProfileAvatarPreview',
        src: '/api/settings/avatar',
        title: '侧栏头像',
        desc: '左侧导航栏与各处的桌宠形象头像',
        custom: pf.custom,
        onSelect: function (d) { state.profile.avatarDataUrl = d; state.profile.resetAvatar = false },
        onReset: function () { state.profile.avatarDataUrl = ''; state.profile.resetAvatar = true },
      }))
      body.appendChild(section('对话头像'))
      body.appendChild(makeAvatarRow({
        previewId: 'mioUserAvatarPreview',
        src: '/api/settings/user-avatar',
        title: '发送方（你）',
        desc: '对话中你（用户）消息旁的头像',
        custom: !!pf.userAvatarCustom,
        onSelect: function (d) { state.profile.userAvatarDataUrl = d; state.profile.userAvatarReset = false },
        onReset: function () { state.profile.userAvatarDataUrl = ''; state.profile.userAvatarReset = true },
      }))
      body.appendChild(makeAvatarRow({
        previewId: 'mioAssistantAvatarPreview',
        src: '/api/settings/avatar',
        title: '接收方（小智）',
        desc: '对话中小智消息旁的头像（与侧栏头像一个存储）',
        custom: pf.custom,
        onSelect: function (d) { state.profile.avatarDataUrl = d; state.profile.resetAvatar = false },
        onReset: function () { state.profile.avatarDataUrl = ''; state.profile.resetAvatar = true },
      }))
      body.appendChild(section('名称'))
      // 名称表单卡片：label + 输入框同行，说明文字独立一行（避免长说明在窄列竖排堆叠）
      var nameCard = document.createElement('div')
      nameCard.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:14px;background:var(--surface-soft, #f2f6f7);border:1px solid var(--line, #d9e2e6);border-radius:10px;margin-bottom:10px;'
      var nameTop = document.createElement('div')
      nameTop.style.cssText = 'display:flex;align-items:center;gap:12px;'
      var nameLbl = document.createElement('div')
      nameLbl.style.cssText = 'font-size:12px;font-weight:600;color:var(--ink, #20303a);flex:none;'
      nameLbl.textContent = '显示名称'
      var nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.maxLength = '80'
      nameInput.value = pf.name || ''
      nameInput.placeholder = '应用显示名称'
      nameInput.style.cssText = 'flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--line, #d9e2e6);border-radius:8px;background:#fff;color:var(--ink, #20303a);font-size:12px;padding:8px 10px;outline:none;transition:border-color .15s;'
      nameInput.addEventListener('focus', function () { nameInput.style.borderColor = 'var(--accent, #4c8798)' })
      nameInput.addEventListener('blur', function () { nameInput.style.borderColor = 'var(--line, #d9e2e6)' })
      nameInput.addEventListener('input', function () { state.profile.name = nameInput.value.trim() })
      nameInput.addEventListener('change', function () { state.profile.name = nameInput.value.trim() })
      nameTop.appendChild(nameLbl)
      nameTop.appendChild(nameInput)
      nameCard.appendChild(nameTop)
      var nameDesc = document.createElement('div')
      nameDesc.style.cssText = 'font-size:11px;color:var(--muted, #687984);line-height:1.6;'
      nameDesc.textContent = '左侧导航栏与各处显示的 Mio 名字，保存后立即生效。'
      nameCard.appendChild(nameDesc)
      body.appendChild(nameCard)
      var hint = document.createElement('div')
      hint.style.cssText = 'font-size:11px;color:var(--muted, #687984);line-height:1.8;padding:0 4px;'
      hint.textContent = '头像与名称保存在后端设置中；桌宠立绘头像走另一通道（桌面端右键菜单「更换立绘」）。'
      body.appendChild(hint)
    } else if (id === 'pet') {
      body.appendChild(section('外观'))
      body.appendChild(row('桌宠大小', '整体缩放百分比', makeSlider(s.pet_size_percent != null ? s.pet_size_percent : 80, 20, 200, 5, '%'), 'pet_size_percent'))
      body.appendChild(row('模型缩放', 'Live2D 模型内缩放', makeSlider(s.live2d_scale != null ? s.live2d_scale : 1.0, 0.5, 2.0, 0.05, '×'), 'live2d_scale'))
      body.appendChild(row('垂直偏移', '模型上下偏移', makeSlider(s.live2d_vertical_offset != null ? s.live2d_vertical_offset : 0, -200, 200, 5, 'px'), 'live2d_vertical_offset'))
      body.appendChild(section('行为'))
      body.appendChild(row('跟随鼠标', '角色视线跟随鼠标移动', makeSwitch(!!s.live2d_follow_cursor, '跟随鼠标'), 'live2d_follow_cursor'))
      body.appendChild(row('窗口置顶', '桌宠窗口始终置顶', makeSwitch(!!s.live2d_always_on_top, '窗口置顶'), 'live2d_always_on_top'))
      body.appendChild(row('透明穿透', '鼠标点击穿透（锁定后生效）', makeSwitch(!!s.live2d_smart_passthrough, '透明穿透'), 'live2d_smart_passthrough'))
      body.appendChild(row('对话气泡', '显示小智对话气泡', makeSwitch(!!s.live2d_speech_bubble_enabled, '对话气泡'), 'live2d_speech_bubble_enabled'))
      body.appendChild(section('模型自动更换'))
      body.appendChild(row('自动更换模型', '每天定时随机更换角色', makeSwitch(!!(state.schedule && state.schedule.enabled), '自动更换模型'), 'schedule_enabled'))
      body.appendChild(row('更换时间', '每天此时间触发', makeSelect((state.schedule && state.schedule.time) || '12:00', [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 8, 9, 10, 11].map(function (h) { return { v: h + ':00', t: h + ':00' } })), 'schedule_time'))
    } else if (id === 'voice') {
      body.appendChild(section('小智语音'))
      body.appendChild(row('语音回复', '小智回答时播放语音', makeSwitch(s.voice_enabled !== false, '语音回复'), 'voice_enabled'))
      body.appendChild(row('流式播放', '边接收边播放（低延迟）', makeSwitch(!!s.voice_streaming_enabled, '流式播放'), 'voice_streaming_enabled'))
      body.appendChild(row('音量', '语音播放音量', makeSlider(s.voice_volume != null ? s.voice_volume : 85, 0, 100, 5, '%'), 'voice_volume'))
      body.appendChild(row('回复语言', '小智语音与文字语言', makeSelect(s.pet_speech_language || 'zh', [{ v: 'zh', t: '中文' }, { v: 'ja', t: '日语' }]), 'pet_speech_language'))
      body.appendChild(section('屏幕观察播报'))
      body.appendChild(row('观察时语音播报', '屏幕观察分析后语音播报', makeSwitch(!!s.speak_screen_observations, '观察语音播报'), 'speak_screen_observations'))
    // DSH 专用化：原 'observe' / 'prompts' / 'xz' 三个 tab 的渲染分支已随小智插件删除
    } else if (id === 'bubble') {
      // 泡泡工坊：皮肤 / 点击互动 / 图片素材库 —— UI 由 bubble-panel-inject.js 渲染模块提供
      var bubbleHost = document.createElement('div')
      bubbleHost.id = 'mio-bubble-host'
      bubbleHost.style.cssText = 'display:flex;flex-direction:column;gap:12px;'
      body.appendChild(bubbleHost)
      if (window.__mioBubblePanel && window.__mioBubblePanel.renderInto) {
        window.__mioBubblePanel.renderInto(bubbleHost)
      } else {
        bubbleHost.innerHTML = '<div style="font-size:12px;color:var(--muted,#687984);padding:14px;">泡泡模块未加载，请刷新页面后重试。</div>'
      }
    }
  }

  // ---------- 加载 / 保存 ----------
  function loadAll() {
    var st = $q('#mioSetStatus', panel)
    if (st) st.textContent = '加载中…'
    return Promise.all([
      apiGet('/api/companion/status').then(function (j) {
        state.settings = (j && j.pet && j.pet.settings) || {}
      }).catch(function () { state.settings = {} }),
      // DSH 专用化：原三行 apiGet('/api/xiaozhi/{observe/status,prompts,status}') 已移除。
      // 这三个接口随小智插件一并删除；保留调用只会在 console 里刷 404。
      // state.observe / state.prompts / state.xz 保持空对象，避免残留代码读到 undefined。
      apiGet('/api/companion/live2d/schedule').then(function (j) { state.schedule = (j && j.schedule) ? j.schedule : (j || {}) }).catch(function () { state.schedule = {} }),
      apiGet('/api/settings/profile').then(function (j) {
        state.profile = {
          name: (j && j.profile && j.profile.identity && j.profile.identity.name) || '',
          custom: !!(j && j.avatar && j.avatar.custom),
          userAvatarCustom: !!(j && j.user_avatar && j.user_avatar.custom),
          avatarVersion: Date.now(),
        }
      }).catch(function () { state.profile = {} }),
    ]).then(function () {
      renderBody(activeTab)
      var st2 = $q('#mioSetStatus', panel)
      if (st2) st2.textContent = '已加载 · 修改后点击保存生效'
    }).catch(function () {
      var st3 = $q('#mioSetStatus', panel)
      if (st3) st3.textContent = '部分数据加载失败'
    })
  }

  function collectValues() {
    var body = $q('#mioSetBody', panel)
    if (!body) return {}
    var out = {}
    var rows = body.querySelectorAll('[data-row]')
    // 按 __mioKey 收集：控件在 row 的 children 里
    var controls = body.querySelectorAll('input[type="range"], button.mio-set-switch, select, textarea, input[type="number"], input[type="time"]')
    var vals = {}
    // 用 row 结构收集：遍历所有带 __mioKey 的容器
    var keys = body.querySelectorAll('[__mioKey]')
    for (var i = 0; i < keys.length; i++) {
      var el = keys[i]
      var k = el.getAttribute('__mioKey')
      var v
      if (el.classList && el.classList.contains('mio-set-switch')) v = readSwitch(el)
      else if (el.tagName === 'SELECT') v = readSelect(el)
      else if (el.tagName === 'TEXTAREA') v = readText(el)
      else if (el.tagName === 'INPUT' && el.type === 'range') v = Number(el.value)
      else if (el.__mioMin) v = { min: Number(el.__mioMin.value), max: Number(el.__mioMax.value) }
      else if (el.__mioStart) v = { start: el.__mioStart.value, end: el.__mioEnd.value }
      if (k && v !== undefined) vals[k] = v
    }
    return vals
  }

  function saveAll() {
    var vals = collectValues()
    var btn = $q('#mioSetSave', panel)
    var st = $q('#mioSetStatus', panel)
    if (btn) { btn.disabled = true; btn.textContent = '保存中…' }
    // 1) 桌宠 + 语音 + 观察键 → PATCH /api/companion/settings
    var settingsBody = {}
    var settingsKeys = [
      'pet_size_percent', 'live2d_scale', 'live2d_vertical_offset',
      'live2d_follow_cursor', 'live2d_always_on_top', 'live2d_smart_passthrough',
      'live2d_speech_bubble_enabled', 'voice_enabled', 'voice_streaming_enabled',
      'voice_volume', 'pet_speech_language', 'speak_screen_observations',
      'screen_ai_enabled',
    ]
    settingsKeys.forEach(function (k) { if (vals[k] !== undefined) settingsBody[k] = vals[k] })
    // 2) 自动观察 → observe/start or stop
    var observeBody = {}
    if (vals.observe_interval) {
      observeBody.min_seconds = vals.observe_interval.min
      observeBody.max_seconds = vals.observe_interval.max
    }
    if (vals.observe_quiet) {
      observeBody.quiet_start = vals.observe_quiet.start
      observeBody.quiet_end = vals.observe_quiet.end
    }
    // 3) 提示词 → PUT prompts
    var promptsBody = {}
    if (vals.image_prompt !== undefined) promptsBody.image_prompt = vals.image_prompt
    if (vals.observe_prompt !== undefined) promptsBody.observe_prompt = vals.observe_prompt
    if (vals.force_60 !== undefined) promptsBody.force_60 = !!vals.force_60
    // 4) 模型调度 → PATCH live2d/schedule
    var schedBody = {}
    if (vals.schedule_enabled !== undefined) schedBody.enabled = !!vals.schedule_enabled
    if (vals.schedule_time !== undefined) schedBody.time = vals.schedule_time
    // 5) 资料 → 名称 PATCH /api/settings/profile + 头像 POST/DELETE /api/settings/avatar
    if (vals.profile_name !== undefined && state.profile) state.profile.name = vals.profile_name
    var pf = state.profile || {}
    var profileBody = {}
    if (pf.name) profileBody.profile = { identity: { name: pf.name } }

    var proms = []
    if (Object.keys(settingsBody).length) proms.push(apiSend('/api/companion/settings', 'PATCH', settingsBody))
    // DSH 专用化：原三处 apiSend('/api/xiaozhi/{observe/*,prompts}') 已移除
    //（自动屏幕观察开关/间隔/免打扰、图片与观察提示词 —— 全部属小智插件，
    //  对应 tab 已删，值也不会再被收集；保留只会让"保存"整体失败）。
    if (Object.keys(schedBody).length) proms.push(apiSend('/api/companion/live2d/schedule', 'PATCH', schedBody))
    if (Object.keys(profileBody).length) proms.push(apiSend('/api/settings/profile', 'PATCH', profileBody))
    if (pf.avatarDataUrl) proms.push(apiSend('/api/settings/avatar', 'POST', { data_url: pf.avatarDataUrl }))
    if (pf.resetAvatar) proms.push(apiSend('/api/settings/avatar', 'DELETE', null))
    if (pf.userAvatarDataUrl) proms.push(apiSend('/api/settings/user-avatar', 'POST', { data_url: pf.userAvatarDataUrl }))
    if (pf.userAvatarReset) proms.push(apiSend('/api/settings/user-avatar', 'DELETE', null))

    Promise.all(proms.map(function (p) { return p.catch(function (e) { return { __err: String(e && e.message || e) } }) }))
      .then(function (results) {
        var errs = results.filter(function (r) { return r && r.__err || (r && r.detail) })
        if (st) st.textContent = errs.length ? ('保存完成，但有 ' + errs.length + ' 项失败') : '已保存 ✓'
        state.profile.avatarDataUrl = ''
        state.profile.resetAvatar = false
        state.profile.userAvatarDataUrl = ''
        state.profile.userAvatarReset = false
        syncBrandBlock()
        return loadAll()
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = '保存' }
      })
  }

  // ---------- 侧栏头像/名称同步（保存后立即反映，不依赖 Vue 重渲染） ----------
  function syncBrandBlock() {
    var bb = $q('.sidebar .brand-block') || $q('.brand-block')
    if (!bb) return
    var strong = bb.querySelector('strong')
    if (strong && state.profile && state.profile.name) strong.textContent = state.profile.name
    var img = bb.querySelector('img.brand-avatar')
    if (img) img.src = '/api/settings/avatar?v=' + Date.now()
  }

  // ---------- 激活 / 退出 ----------
  function activate() {
    window.__mioSettingsPanelActive = true
    buildPanel()
    setNavActive(true)
    panel.style.display = 'flex'
    loadAll()
  }
  function deactivate() {
    window.__mioSettingsPanelActive = false
    setNavActive(false)
    if (panel) {
      if (panel.__mioHostFixed) {
        var host = findContentArea()
        if (host) host.style.position = ''
      }
      panel.style.display = 'none'
    }
  }
  function togglePanel() {
    if (panel && panel.style.display === 'flex') deactivate()
    else activate()
  }

  // 点击其他导航项时关闭本面板
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('nav button.nav-item')
    if (!b || b === navBtn) return
    if (panel && panel.style.display === 'flex') deactivate()
  }, true)

  // 保活
  function keepAlive() {
    try {
      ensureNav()
      if (panel && panel.style.display === 'flex') {
        if (!panel.isConnected) {
          var host = findContentArea() || document.body
          host.appendChild(panel)
          renderBody(activeTab)
        }
      }
    } catch (e) { /* ignore */ }
  }
  var mo = new MutationObserver(function () { try { keepAlive() } catch (e) {} })
  try {
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true })
  } catch (e) {
    mo.observe(document.documentElement, { childList: true, subtree: true })
  }
  setInterval(keepAlive, 1500)
  setTimeout(ensureNav, 1000)
  setTimeout(ensureNav, 3000)
})()
