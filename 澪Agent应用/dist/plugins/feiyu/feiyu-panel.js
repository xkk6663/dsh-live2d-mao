/* feiyu-panel.js — 大肥鱼插件 · 设置页 tab（不是左侧功能页）
 * ────────────────────────────────────────────────────────────────────────────
 * ★ 2026-10-25 用户裁决（第三次修订）：
 *   「设置页新增设置页面 tab」——大肥鱼**只做设置页 tab**，不在左侧导航建功能页。
 *   之前本文件会往左侧 nav 插一个「大肥鱼」按钮，已删除。
 *
 * ★ 保存按钮归属（用户实拍：页里一个「保存」+ 底部又一个「保存」）：
 *   设置面板底部已有统一保存条，插件页**不再自带保存按钮**。
 *   本页所有控件走「输入即保存」（debounce 400ms），与底部保存条互不冲突。
 *
 * 数据（只调自己的接口）：
 *   GET   /api/companion/status            取 pet.settings
 *   PATCH /api/companion/settings          保存（只提交本插件自己的键）
 *   POST  /api/companion/screen/look-now   立即看一眼
 * ────────────────────────────────────────────────────────────────────────────
 */
(function () {
  if (window.__mioFeiyuPanelLoaded) return
  window.__mioFeiyuPanelLoaded = true

  // ★ 强调色跟随当前主题（--accent），不再写死鲑鱼粉 —— 否则与 rose/mist 主题撞色。
  //   manifest.bubble.accent 仍保留固定值，那是**气泡身份色**（聊天界面区分谁在说话），
  //   与设置页的主题色是两回事，不要混用。
  var ACCENT = 'var(--accent, #c9879f)'
  var AGENT_ID = 'cloud_feiyu'
  var TAB_ID = 'feiyu'

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
    input: 'width:76px;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:#fff;color:var(--ink,#20303a);font-size:12px;padding:4px 8px;text-align:right;',
    textarea: 'width:100%;box-sizing:border-box;min-height:58px;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:#fff;color:var(--ink,#20303a);font-size:12px;padding:6px 8px;resize:vertical;font-family:inherit;',
    btn: 'flex:none;border:1px solid var(--accent,#c9879f);border-radius:8px;background:var(--accent,#c9879f);color:#fff;font-size:12px;padding:5px 14px;cursor:pointer;font-weight:600;',
  }

  function section(t) {
    var s = el('div', C.section)
    s.appendChild(el('span', 'width:4px;height:12px;border-radius:2px;background:var(--accent,#c9879f);'))
    s.appendChild(document.createTextNode(t))
    return s
  }

  function mkSwitch(on) {
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'mio-switch'
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
    'screen_ai_enabled', 'speak_screen_observations',
    'screen_trigger_random_enabled', 'screen_trigger_min_minutes', 'screen_trigger_max_minutes',
    'screen_analysis_interval_seconds',
    'screen_observation_prompt', 'screen_observation_max_chars',
    'screen_minimum_importance', 'screen_voice_cooldown_seconds',
    'screen_observation_voice_enabled', 'voice_enabled', 'voice_volume', 'audio_autoplay',
    'screen_request_timeout_seconds', 'screen_daily_cost_limit_yuan',
  ]

  var MINUTE_OPTS = [
    { v: 15, t: '15分钟' }, { v: 30, t: '30分钟' }, { v: 60, t: '1小时' },
    { v: 90, t: '1.5小时' }, { v: 120, t: '2小时' }, { v: 180, t: '3小时' },
    { v: 360, t: '6小时' }, { v: 720, t: '12小时' },
  ]

  function renderInto(host) {
    if (!host) return
    host.innerHTML = ''
    var wrap = el('div', 'padding:4px 4px 8px;')
    var box = el('div', 'max-width:100%;')
    wrap.appendChild(box)

    // 标题 + 一句话说明（不重复做保存按钮 —— 底部保存条统一负责）
    var head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:2px;')
    head.appendChild(el('span', 'width:4px;height:15px;border-radius:2px;background:var(--accent,#c9879f);'))
    head.appendChild(el('span', 'font-size:13px;font-weight:700;color:var(--ink,#20303a);', '大肥鱼'))
    box.appendChild(head)
    box.appendChild(el('div', 'font-size:11px;color:var(--muted,#687984);margin:0 0 4px 12px;',
      '云端人格化 Agent。改动即时生效，无需再点保存。'))

    var status = el('div', 'font-size:11px;color:var(--accent,#c9879f);min-height:16px;margin:6px 0 0;')
    var form = el('div', '')
    box.appendChild(status)
    box.appendChild(form)

    api('GET', '/api/companion/status').then(function (j) {
      var s = ((j && j.pet && j.pet.settings) || {})
      form.innerHTML = ''

      // ── 观察开关 ────────────────────────────────────────────────
      form.appendChild(section('观察'))
      form.appendChild(row('屏幕观察', '关掉后只截图不分析，不产生任何云端请求',
        mkSwitch(s.screen_ai_enabled !== false), 'screen_ai_enabled'))
      form.appendChild(row('主动开口', '关掉后观察结果只记录，不进对话也不出气泡',
        mkSwitch(s.speak_screen_observations !== false), 'speak_screen_observations'))

      // ── 触发节奏 ────────────────────────────────────────────────
      form.appendChild(section('触发节奏'))
      form.appendChild(row('随机触发', '在下面区间里随机挑时刻看一眼',
        mkSwitch(s.screen_trigger_random_enabled !== false), 'screen_trigger_random_enabled'))
      form.appendChild(row('最短间隔', '两次观察之间至少隔多久',
        mkSelect(Number(s.screen_trigger_min_minutes) || 60, MINUTE_OPTS), 'screen_trigger_min_minutes'))
      form.appendChild(row('最长间隔', '与最短间隔之间均匀随机',
        mkSelect(Number(s.screen_trigger_max_minutes) || 120, MINUTE_OPTS), 'screen_trigger_max_minutes'))
      form.appendChild(row('分析间隔', '关掉随机触发时用：画面变化后至少隔多久再分析',
        mkSelect(Number(s.screen_analysis_interval_seconds) || 5,
          [{ v: 5, t: '5秒' }, { v: 10, t: '10秒' }, { v: 15, t: '15秒' }, { v: 30, t: '30秒' }]),
        'screen_analysis_interval_seconds'))

      // ── 说什么 ──────────────────────────────────────────────────
      form.appendChild(section('说什么'))
      form.appendChild(row('观察提示词', '每次观察额外交代给模型的话；留空用默认口吻',
        mkText(s.screen_observation_prompt || ''), 'screen_observation_prompt', true))
      form.appendChild(row('回答字数上限', '0 = 不限；10 = 每句 10 字以内（超了本地截断兜底）',
        mkNumber(Number(s.screen_observation_max_chars) || 0, 0, 200, 1, ' 字'), 'screen_observation_max_chars'))
      form.appendChild(row('开口门槛', '事件优先级达到此值才说话；调高更安静',
        mkNumber(Number(s.screen_minimum_importance) || 0.62, 0.1, 1, 0.02, ''), 'screen_minimum_importance'))
      form.appendChild(row('回应冷却', '一次开口后至少等多久',
        mkSelect(Number(s.screen_voice_cooldown_seconds) || 5,
          [{ v: 5, t: '5秒' }, { v: 10, t: '10秒' }, { v: 15, t: '15秒' }, { v: 30, t: '30秒' }, { v: 60, t: '1分钟' }]),
        'screen_voice_cooldown_seconds'))

      // ── 声音 ────────────────────────────────────────────────────
      form.appendChild(section('声音'))
      form.appendChild(row('观察语音播报', '观察结果同时发语音；文字气泡照常显示',
        mkSwitch(s.screen_observation_voice_enabled !== false), 'screen_observation_voice_enabled'))
      form.appendChild(row('语音总开关', '关掉后桌宠完全不出声',
        mkSwitch(s.voice_enabled !== false), 'voice_enabled'))
      form.appendChild(row('音量', '语音播放音量',
        mkNumber(Number(s.voice_volume) || 85, 0, 100, 1, '%'), 'voice_volume'))
      form.appendChild(row('音频自动播放', '发来语音/点歌时自动出声；关闭后改为手动播放',
        mkSwitch(s.audio_autoplay !== false), 'audio_autoplay'))

      // ── 成本与容错 ──────────────────────────────────────────────
      form.appendChild(section('成本与容错'))
      form.appendChild(row('请求超时', '单次观察等云端多久算失败',
        mkSelect(Number(s.screen_request_timeout_seconds) || 25,
          [{ v: 15, t: '15秒' }, { v: 25, t: '25秒' }, { v: 40, t: '40秒' }, { v: 60, t: '60秒' }]),
        'screen_request_timeout_seconds'))
      form.appendChild(row('每日花费上限', '当天观察累计花费达到上限后停止',
        mkNumber(Number(s.screen_daily_cost_limit_yuan) || 5, 0.1, 1000, 0.1, ' 元'), 'screen_daily_cost_limit_yuan'))

      // ── 立即看一眼（唯一保留的操作按钮）──────────────────────────
      var act = el('div', 'display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap;')
      var lookBtn = el('button', C.btn, '立即看一眼')
      var lookStatus = el('span', 'flex:1;font-size:11px;color:var(--muted,#687984);min-width:150px;')
      act.appendChild(lookBtn)
      act.appendChild(lookStatus)
      box.appendChild(act)

      lookBtn.addEventListener('click', function () {
        lookBtn.disabled = true
        lookStatus.textContent = '正在截图并等待云端…'
        api('PATCH', '/api/companion/settings', collect())
          .then(function () { return api('POST', '/api/companion/screen/look-now', {}) })
          .then(function (res) {
            var a = (res && res.analysis) || {}
            lookStatus.textContent = (res && res.replied)
              ? '已回话：' + String(a.last_reply || '').slice(0, 50)
              : '没开口：' + String(a.last_error || '未取得新画面或未达开口条件').slice(0, 60)
          })
          .catch(function (e) { lookStatus.textContent = '失败：' + ((e && e.message) || e) })
          .finally(function () { lookBtn.disabled = false })
      })

      // ── 输入即保存（debounce），不额外放保存按钮 ─────────────────
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
        if (t && (t.tagName === 'TEXTAREA' || t.type === 'number')) scheduleSave()
      })
    }).catch(function (e) {
      form.innerHTML = '<div style="font-size:12px;color:#c0392b;padding:10px 0;">读取配置失败：' + ((e && e.message) || e) + '</div>'
    })

    function collect() {
      var body = {}
      var items = form.querySelectorAll('[__feiyuKey]')
      for (var i = 0; i < items.length; i++) {
        var n = items[i]
        var k = n.getAttribute('__feiyuKey')
        if (!k || OWN_KEYS.indexOf(k) < 0) continue
        var v
        if (n.classList && n.classList.contains('mio-switch')) v = readSwitch(n)
        else if (n.tagName === 'SELECT') v = Number(n.value)
        else if (n.tagName === 'TEXTAREA') v = String(n.value)
        else if (n.tagName === 'INPUT' && n.type === 'number') v = Number(n.value)
        else if (n.querySelector && n.querySelector('input')) v = Number(n.querySelector('input').value)
        if (v !== undefined) body[k] = v
      }
      return body
    }

    // ★★ 2026-10-25 实测抓到的致命 bug：整段 UI 都挂在 wrap 上，
    //   但**从来没有把 wrap 塞进 host** —— wrap 是个游离节点，永远不进 DOM。
    //   表现就是：插件 tab 点开一片空白、host.children.length === 0、且不报任何错。
    //   （前面几轮我一直以为是数据/时序问题，用浏览器真跑一遍才发现是漏了这一行。）
    host.appendChild(wrap)
  }

  function row(label, desc, control, key, stacked) {
    var r = el('div', C.card)
    if (stacked) {
      r.style.display = 'block'
      var info0 = el('div', '')
      info0.appendChild(el('div', C.title, label))
      info0.appendChild(el('div', C.desc, desc || ''))
      r.appendChild(info0)
      if (control) {
        control.setAttribute('__feiyuKey', key || '')
        var holder = el('div', 'margin-top:6px;')
        holder.appendChild(control)
        r.appendChild(holder)
      }
      return r
    }
    var info = el('div', 'flex:1;min-width:0;')
    info.appendChild(el('div', C.title, label))
    info.appendChild(el('div', C.desc, desc || ''))
    r.appendChild(info)
    if (control) {
      control.setAttribute('__feiyuKey', key || '')
      if (control.classList && control.classList.contains('mio-switch')) {
        control.addEventListener('click', function () {
          setSwitch(control, control.getAttribute('data-on') !== '1')
        })
      }
      r.appendChild(control)
    }
    return r
  }

  function mkText(v) {
    var t = document.createElement('textarea')
    t.style.cssText = C.textarea
    t.value = v || ''
    t.placeholder = '例如：锐评此刻的屏幕'
    t.maxLength = 2000
    return t
  }

  // ★ 只做设置页 tab：不建左侧导航、不做浮层
  window['feiyu-panel'] = {
    accent: 'var(--accent, #c9879f)',
    agentId: AGENT_ID,
    tabId: TAB_ID,
    renderInto: renderInto,
  }
  window.__mioFeiyuPanel = window['feiyu-panel']
})()
