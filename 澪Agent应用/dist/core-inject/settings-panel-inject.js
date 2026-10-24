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
    // ★ 2026-10-17 用户裁决：原「泡泡」「横条」两个 tab 合并为「主题」
    //    （气泡皮肤/点击互动/音效 + 横条尺寸/皮肤，都是外观主题范畴）。
    // ★ 2026-10-19 用户裁决：再拆一次 —— 「主题」只留**看得见的外观**
    //    （皮肤 / 全局主题 / 横条尺寸）；其余"行为与玩法"（活人感、交互打磨、
    //    模型自动更换、流式、点击互动、图片素材库、音效）统统搬到新开的「个性化」。
    //    理由：主题页当时堆了 7 段，用户原话"分布还是有点杂乱"。
    { id: 'personalization', label: '个性化' },
    { id: 'theme', label: '主题' },
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
        '<span style="flex:1;font-size:11px;color:var(--muted, #687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" id="mioSetStatus">资料 · 桌宠 · 语音 · 个性化 · 主题</span>' +
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

  /**
   * 话痨档位 → 一句人话（"正常 · 每 6~15 分钟说一句 · 每 30~90 秒换个表情"）。
   * 曲线与文案的唯一真源在 bubble-panel-inject.js（锚点又来自 live2d-pet.js TALK_ANCHORS），
   * 这里只调用、不重算；模块没加载时退化成裸档位，不至于报错。
   */
  function talkPreviewText(level) {
    var lv = Math.max(0, Math.min(100, Math.round(Number(level) || 0)))
    var api = window.__mioBubblePanel && window.__mioBubblePanel.talkativeness
    if (!api) return '当前档位 ' + lv + ' / 100'
    return '当前：' + api.label(lv) + ' · ' + api.preview(lv)
  }

  // 触发间隔的可选档位（分钟）。与后端 configuration.py 的 1..1440 钳制范围一致，
  // 最长间隔多给一个 12 小时档（用户想要"一整天看一眼"时用）。
  var TRIGGER_MINUTE_OPTIONS = [
    { v: 15, t: '15分钟' }, { v: 30, t: '30分钟' }, { v: 60, t: '1小时' },
    { v: 90, t: '1.5小时' }, { v: 120, t: '2小时' }, { v: 180, t: '3小时' },
    { v: 360, t: '6小时' },
  ]
  var TRIGGER_MINUTE_OPTIONS_LONG = TRIGGER_MINUTE_OPTIONS.concat([{ v: 720, t: '12小时' }])

  // 识图通路（screen_vision_route）
  //   ★ 2026-10-24 用户裁决：**桌宠端完全不需要任何模型 API，模型全部走云端服务器**。
  //     所以这里只剩一条路：
  //       feiyu = 云端大肥鱼直连：一帧图 + 一段自然语言提示词直接发 AstrBot，她亲自看图回话
  //     原来的 local（本机 Ollama 跑视觉）与 cloud（本机拼 JSON、让某个云端 VL 模型吐 JSON）
  //     两条都要本机持有模型配置/凭据，按裁决移除。
  var VISION_ROUTE_OPTIONS = [
    { v: 'feiyu', t: '云端大肥鱼（图+提示词直发）' },
  ]

  /** 立刻按当前通路看一眼（不等随机触发），结果同时进气泡和对话。 */
  function makeLookNow(btnLabel) {
    var btn = document.createElement('button')
    btn.textContent = btnLabel || '看一眼'
    btn.style.cssText = 'flex:none;border:1px solid var(--line, #d9e2e6);border-radius:8px;background:var(--surface-soft, #f2f6f7);color:var(--ink, #20303a);font-size:12px;padding:5px 12px;cursor:pointer;'
    return btn
  }

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
    } else if (id === 'personalization') {
      // ★ 2026-10-19 新 tab「个性化」：所有"行为与玩法"集中在这里。
      //   来源分两批：
      //     ① 从「桌宠」搬来：活人感 / 交互打磨 / 模型自动更换（都是 __mioKey 行，走本页保存按钮）
      //     ② 从「主题」搬来：逐 token 流式 / 点击互动 / 图片素材库 / 音效事件 / 音效片段
      //        —— 这五张卡由 bubble-panel-inject 渲染，通过 renderInto(host, 'behavior') 只取这一组。
      //   为什么这样分：主题页只管"看得见的外观（皮肤/主题/横条尺寸）"，
      //   个性化页只管"它怎么动、怎么说话、点什么、放什么声音"。
      body.appendChild(section('活人感'))
      var talkNum = Number(s.pet_talkativeness)
      if (!isFinite(talkNum)) talkNum = 45
      var talkSlider = makeSlider(Math.round(talkNum), 0, 100, 5, '')
      talkSlider.__mioInput.style.width = '160px'
      if (talkSlider.__mioVal) talkSlider.__mioVal.style.fontSize = '12px'
      var talkHint = document.createElement('div')
      talkHint.id = 'mioSetTalkHint'
      talkHint.style.cssText = 'font-size:12px;color:var(--muted, #687984);line-height:1.6;margin:-4px 0 10px 12px;'
      talkHint.textContent = talkPreviewText(talkNum)
      talkSlider.__mioInput.addEventListener('input', function () {
        talkHint.textContent = talkPreviewText(Number(talkSlider.__mioInput.value))
      })
      body.appendChild(row('话痨程度', '一条滑块同时决定"多久说一句"和"多久换个表情"', talkSlider, 'pet_talkativeness'))
      body.appendChild(talkHint)
      body.appendChild(row('随机微表情', '不说话时也会随机换个表情，别像冻住的图',
        makeSwitch(s.pet_idle_beat_enabled !== false, '随机微表情'), 'pet_idle_beat_enabled'))
      body.appendChild(row('模型专属台词', '用该形象的台词库（如大肥鱼名言录）；关掉则用通用问候，长任务提醒也一并停止',
        makeSwitch(s.pet_quotes_enabled !== false, '模型专属台词'), 'pet_quotes_enabled'))
      body.appendChild(row('连点彩蛋', '3 秒内连点 3 下 → 嫌弃；连点 6 下 → 装死 60 秒（X X 眼，怎么戳都不理）',
        makeSwitch(s.pet_poke_enabled !== false, '连点彩蛋'), 'pet_poke_enabled'))

      body.appendChild(section('交互打磨'))
      body.appendChild(row('锁定位置', '开启后桌宠不可拖动（点击互动仍有效）', makeSwitch(!!s.live2d_pet_locked, '锁定位置'), 'live2d_pet_locked'))
      body.appendChild(row('SHIFT 拖动', '开启后需按住 Shift 才能拖动，防误拖', makeSwitch(!!s.live2d_pet_shift_drag, 'SHIFT 拖动'), 'live2d_pet_shift_drag'))
      body.appendChild(row('拖拽惯性', '松手后按拖动速度惯性滑行、阻尼停稳', makeSwitch(s.live2d_pet_inertia !== false, '拖拽惯性'), 'live2d_pet_inertia'))

      body.appendChild(section('模型自动更换'))
      body.appendChild(row('自动更换模型', '每天定时随机更换角色', makeSwitch(!!(state.schedule && state.schedule.enabled), '自动更换模型'), 'schedule_enabled'))
      body.appendChild(row('更换时间', '每天此时间触发', makeSelect((state.schedule && state.schedule.time) || '12:00', [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 8, 9, 10, 11].map(function (h) { return { v: h + ':00', t: h + ':00' } })), 'schedule_time'))

      // 气泡行为卡（逐 token 流式 / 点击互动 / 图片素材库 / 音效事件 / 音效片段）
      var behaviorHost = document.createElement('div')
      behaviorHost.id = 'mio-bubble-behavior-host'
      behaviorHost.style.cssText = 'display:flex;flex-direction:column;gap:12px;margin-top:14px;'
      body.appendChild(behaviorHost)
      if (window.__mioBubblePanel && window.__mioBubblePanel.renderInto) {
        window.__mioBubblePanel.renderInto(behaviorHost, 'behavior')
      } else {
        behaviorHost.innerHTML = '<div style="font-size:12px;color:var(--muted,#687984);padding:14px;">泡泡模块未加载，请刷新页面后重试。</div>'
      }
    } else if (id === 'voice') {
      body.appendChild(section('小智语音'))
      body.appendChild(row('语音回复', '小智回答时播放语音', makeSwitch(s.voice_enabled !== false, '语音回复'), 'voice_enabled'))
      body.appendChild(row('流式播放', '边接收边播放（低延迟）', makeSwitch(!!s.voice_streaming_enabled, '流式播放'), 'voice_streaming_enabled'))
      body.appendChild(row('音量', '语音播放音量', makeSlider(s.voice_volume != null ? s.voice_volume : 85, 0, 100, 5, '%'), 'voice_volume'))
      // ★ 2026-10-23 新增「音频自动播放」开关。
      //   用户反馈：「收到音频之后会自动播放一次，然后相关都不知道在哪里关」。
      //   背景：渲染端 playAgentAudio() 早就认 `settings.audio_autoplay === false`，
      //   但**没有任何 UI 能设置它**，也没有默认值（undefined !== false）⇒ 永远自动播放。
      //   这里补上开关，默认开（不改变现有体验）；关掉后气泡只提示
      //   「♪ 正在播放：歌名（自动播放已关闭）」，改为在对话界面手动点播放。
      body.appendChild(row(
        '音频自动播放',
        '大肥鱼发来语音/点歌时自动出声；关闭后只在气泡提示，改为在对话里手动播放',
        makeSwitch(s.audio_autoplay !== false, '音频自动播放'),
        'audio_autoplay',
      ))
      body.appendChild(row('回复语言', '小智语音与文字语言', makeSelect(s.pet_speech_language || 'zh', [{ v: 'zh', t: '中文' }, { v: 'ja', t: '日语' }]), 'pet_speech_language'))
      body.appendChild(section('屏幕观察播报'))
      // ★ 2026-10-24「气泡不显示」的真凶（用户实测）：真正决定**观察结果要不要主动开口**
      //   的是 speak_screen_observations（后端 _deliver_observation 的 speak_on），
      //   可它在两个设置页里都**没有控件**，只能靠默认值。
      //   下面这个「观察语音播报」只控制"要不要额外合成一条语音"，文字气泡本该照常显示；
      //   用户以为它管文字，实际文字那条被前一个键静默关着 —— 所以这里先把总开关补出来。
      body.appendChild(row(
        '屏幕观察播报',
        '关掉后观察结果只记录、不进对话也不出气泡；打开才会主动说一句话（下面的语音开关只管要不要额外出声）',
        makeSwitch(s.speak_screen_observations !== false, '屏幕观察播报'),
        'speak_screen_observations',
      ))
      // ★ 2026-10-24：用户反馈「设置页看不到触发间隔 / 想自己写观察提示词」。
      //   之前这里只有一个 speak_screen_observations 开关，而**真正在用的**
      //   触发间隔(screen_trigger_*) 与提示词(screen_observation_prompt)
      //   只做在了 澪Agent应用 的 Vue 设置页里 —— 用户日常用的是这个注入面板，
      //   所以两套 UI 里都得有，否则"改了半天没反应"。
      body.appendChild(row(
        '随机触发',
        '在下面区间里随机挑一个时刻看一眼；关掉后回到"画面变了才分析"',
        makeSwitch(s.screen_trigger_random_enabled !== false, '随机触发'),
        'screen_trigger_random_enabled',
      ))
      body.appendChild(row(
        '最短间隔',
        '两次观察之间至少隔多久',
        makeSelect(Number(s.screen_trigger_min_minutes) || 60, TRIGGER_MINUTE_OPTIONS),
        'screen_trigger_min_minutes',
      ))
      body.appendChild(row(
        '最长间隔',
        '与最短间隔之间均匀随机',
        makeSelect(Number(s.screen_trigger_max_minutes) || 120, TRIGGER_MINUTE_OPTIONS_LONG),
        'screen_trigger_max_minutes',
      ))
      body.appendChild(row(
        '观察语音播报',
        '观察结果同时发语音；文字气泡照常显示',
        makeSwitch(s.screen_observation_voice_enabled !== false, '观察语音播报'),
        'screen_observation_voice_enabled',
      ))
      body.appendChild(row(
        '观察提示词',
        '每次观察额外交代给模型的话，例如「锐评一下此刻的电脑屏幕画面」；留空用默认口吻',
        makeText(s.screen_observation_prompt || ''),
        'screen_observation_prompt',
      ))
      // ★ 2026-10-24（用户裁决 m02071）：识图通路 + 立即看一眼。
      //   以前「哪条路在看屏幕」只能改配置文件；换成云端大肥鱼直连后，
      //   用户需要能在这里当场切换、当场验证（不等 30~90 分钟的随机触发）。
      body.appendChild(row(
        '识图通路',
        '云端大肥鱼 = 一帧图 + 提示词直接发云端，由她亲自看图回话；普通云端/本地两条是老链路（要求模型吐 JSON）',
        makeSelect(s.screen_vision_route || 'local', VISION_ROUTE_OPTIONS),
        'screen_vision_route',
      ))
      var lookNowBtn = makeLookNow('立即看一眼')
      var lookNowStatus = document.createElement('span')
      lookNowStatus.style.cssText = 'flex:1;font-size:12px;color:var(--muted,#687984);margin-left:10px;'
      lookNowBtn.addEventListener('click', function () {
        lookNowBtn.disabled = true
        lookNowStatus.textContent = '正在截图并等待云端…'
        // 先保存当前控件值（尤其是刚改的通路/提示词），再立刻观察，避免"改了没生效"
        var patchPromise = Object.keys(settingsBodyFromPanel()).length
          ? apiSend('/api/companion/settings', 'PATCH', settingsBodyFromPanel())
          : Promise.resolve({})
        patchPromise
          .then(function () {
            return apiSend('/api/companion/screen/look-now', 'POST', {})
          })
          .then(function (res) {
            var analysis = (res && res.analysis) || {}
            if (res && res.replied) {
              lookNowStatus.textContent = '已回话：' + String(analysis.last_reply || '').slice(0, 60)
            } else {
              lookNowStatus.textContent = '没开口：' + String(analysis.last_error || '本轮没有取得新画面或未达到开口条件').slice(0, 80)
            }
          })
          .catch(function (err) {
            lookNowStatus.textContent = '失败：' + String((err && err.message) || err).slice(0, 80)
          })
          .finally(function () {
            lookNowBtn.disabled = false
          })
      })
      var lookNowRow = row('立即看一眼', '不用等下一次随机触发，马上截一帧按当前通路观察一次（建议先改完上面的通路/提示词再点）', lookNowBtn, '')
      lookNowRow.appendChild(lookNowStatus)
      body.appendChild(lookNowRow)
    // DSH 专用化：原 'observe' / 'prompts' / 'xz' 三个 tab 的渲染分支已随小智插件删除
    } else if (id === 'theme') {
      // ★ 主题页（2026-10-17 用户裁决）：原「泡泡」「横条」两 tab 合并。
      //  ── 上半：横条设置（尺寸 / 行数 / 皮肤）──
      //    值走 PATCH /api/companion/settings → settings_changed → 桌宠横条热应用；
      //    反向（桌宠手动拉伸 → persistCompanionSetting 回写）也已打通 ——
      //    所以这里的初始值 = 横条**实时状态**（拉伸过就显示拉伸后的宽度）。
      var sw0 = Number(s.live2d_strip_width) || 0
      var sr0 = Number(s.live2d_strip_rows) || 1

      body.appendChild(section('横条尺寸'))
      // 默认宽度：0 = CSS 默认（420px，文字换行）；>0 = 固定像素宽。
      //   在桌宠上手动拉伸横条也会更新这个值（双向同步）。
      var widthSlider = makeSlider(sw0, 0, 1600, 20, 'px')
      widthSlider.__mioInput.min = '0'
      body.appendChild(row('默认宽度', '横条的固定宽度；0 = 默认 420px。在桌宠上手动拉伸横条会同步更新这里，保存后立即生效。', widthSlider, 'live2d_strip_width'))

      // 行数：文字按宽度换行往下递增，超出可见行数由右侧竖条滚动浏览
      var rowsSlider = makeSlider(sr0, 1, 5, 1, ' 行')
      body.appendChild(row('显示行数', '横条可见窗口的行数；文字按宽度换行往下递增，超出的历史由右侧竖条滚动浏览（最新在最底）。', rowsSlider, 'live2d_strip_rows'))

      // ★ 2026-10-19：原本这里的"横条配色"下拉框已**删除**。
      //   它和下方泡泡工坊的「皮肤」是同一套配色，用户看到两份，
      //   改一份另一份不动（写的是 live2d_strip_style / live2d_bubble_style 两个键）。
      //   现在皮肤统一在下方「皮肤与全局主题」里选一次、两处同时生效；
      //   横条这里只保留真正只属于横条的两项：默认宽度、显示行数。

      //  ── 下半：皮肤 + 全局主题 ──
      //   ★ 2026-10-19：本 tab 只留**看得见的外观**。流式 / 点击互动 / 图片 / 音效这些
      //   "行为与玩法"已经搬到「个性化」tab（renderInto 的第二参数 'behavior'）。
      //   这里传 'appearance' ⇒ 只渲染 appearance + personalization 两张卡。
      body.appendChild(section('皮肤与全局主题'))
      var bubbleHost = document.createElement('div')
      bubbleHost.id = 'mio-bubble-host'
      bubbleHost.style.cssText = 'display:flex;flex-direction:column;gap:12px;'
      body.appendChild(bubbleHost)
      if (window.__mioBubblePanel && window.__mioBubblePanel.renderInto) {
        window.__mioBubblePanel.renderInto(bubbleHost, 'appearance')
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
      // ★ 滑条（2026-10-17 修复）：makeSlider 返回的 wrap 是 DIV，__mioKey 设在
      //   wrap 上而非 input 上 —— 之前只判 INPUT 永远不命中，滑条值从未被收集
      //   （"修改后点保存自动恢复默认值"的根因）。wrap.__mioInput 指向真实 input。
      else if (el.__mioInput && el.__mioInput.type === 'range') v = Number(el.__mioInput.value)
      else if (el.tagName === 'INPUT' && el.type === 'range') v = Number(el.value)
      else if (el.__mioMin) v = { min: Number(el.__mioMin.value), max: Number(el.__mioMax.value) }
      else if (el.__mioStart) v = { start: el.__mioStart.value, end: el.__mioEnd.value }
      if (k && v !== undefined) vals[k] = v
    }
    return vals
  }

  /**
   * 本页保存时允许提交的按键白名单 → PATCH /api/companion/settings 的 body。
   * ★ 抽成函数是因为「立即看一眼」要先保存再观察：两处必须用**同一份**白名单，
   *   否则一边改了另一边没跟上，又会出现"控件能点、保存被静默丢掉"。
   */
  function settingsBodyFromValues(vals) {
    var body = {}
    var settingsKeys = [
      'pet_size_percent', 'live2d_scale', 'live2d_vertical_offset',
      'live2d_follow_cursor', 'live2d_always_on_top', 'live2d_smart_passthrough',
      'live2d_speech_bubble_enabled', 'voice_enabled', 'voice_streaming_enabled',
      'voice_volume', 'pet_speech_language', 'speak_screen_observations',
      // ★ 音频自动播放（2026-10-23）：渲染端 playAgentAudio 认这个键决定是否直接出声。
      //   **必须列进本白名单**，否则开关能点、保存后值被这里静默丢掉
      //   （本页保存是按这份表挑值的）→ 表现为"关了还是会自动播放"。
      'audio_autoplay',
      'screen_ai_enabled',
      // ★ 屏幕观察触发与提示词（2026-10-24）：用户在用注入面板设置，
      //   必须列进白名单，否则控件能改、点保存被静默丢掉 →「设了没反应」。
      'screen_trigger_random_enabled', 'screen_trigger_min_minutes', 'screen_trigger_max_minutes',
      'screen_observation_voice_enabled', 'screen_observation_prompt',
      // ★ 识图通路（2026-10-24）：feiyu = 图+提示词直发云端大肥鱼。
      //   同样必须进白名单，否则下拉框能选、点保存被静默丢掉（"改了没反应"的老坑）。
      'screen_vision_route',
      // ★ 横条个性化（2026-10-17）。2026-10-19 起皮肤并入 live2d_bubble_style，
      //   这里不再收集 live2d_strip_style（留着只会让"改了没反应"更难查）。
      'live2d_strip_width', 'live2d_strip_rows',
      // ★ 交互打磨（2026-10-17）
      'live2d_pet_opacity', 'live2d_pet_locked', 'live2d_pet_shift_drag', 'live2d_pet_inertia',
      // ★ 活人感（2026-10-19，从主题页迁来）：话痨程度 + 三个能力开关。
      //   缺这几个键 = 滑块能拖、点保存没反应（本页保存是按这份白名单挑值的）。
      'pet_talkativeness', 'pet_idle_beat_enabled', 'pet_quotes_enabled', 'pet_poke_enabled',
    ]
    settingsKeys.forEach(function (k) { if (vals[k] !== undefined) body[k] = vals[k] })
    return body
  }

  /** 从当前面板控件直接收集一次保存体（「立即看一眼」用，不依赖别处传值）。 */
  function settingsBodyFromPanel() {
    return settingsBodyFromValues(collectValues())
  }

  function saveAll() {
    var vals = collectValues()
    var btn = $q('#mioSetSave', panel)
    var st = $q('#mioSetStatus', panel)
    if (btn) { btn.disabled = true; btn.textContent = '保存中…' }
    var settingsBody = settingsBodyFromValues(vals)
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
