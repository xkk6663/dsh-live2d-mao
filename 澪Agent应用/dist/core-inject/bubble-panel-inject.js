/* bubble-panel-inject.js — 泡泡工坊渲染模块（UI 在「设置 → 泡泡」tab）
 *
 * 定位：气泡皮肤 + 点击互动（含点击序列）+ 图片素材库 + 音效（事件表/片段库/裁剪）
 *       的统一管理，导出渲染函数由 settings-panel-inject.js 的「泡泡」tab 调用。
 * 数据：GET  /api/companion/status            （当前 settings）
 *       PATCH /api/companion/settings         （保存 → settings_changed → 桌宠热应用）
 *       GET/POST/DELETE /api/companion/bubble-images（图片素材库）
 *       GET/POST/DELETE /api/companion/sounds （音效片段素材库）
 * 桌宠端应用器：pet-bubble-styles.js / pet-random-image.js / pet-sound.js
 * 裁剪：纯前端（decodeAudioData → OfflineAudioContext 渲染 → WAV 编码 → 上传），
 *       不引入 ffmpeg 等外部依赖。
 */
(function () {
  if (window.__mioBubblePanelLoaded) return
  window.__mioBubblePanelLoaded = true

  var ACCENT = '#2d7ff9'
  var POLL_MS = 5000

  // 与桌宠端 pet-bubble-styles.js 的 STYLES 保持一致（id/cls/swatch）
  var STYLE_DEFS = [
    { id: 'default', name: '默认白', swatch: '#ffffff' },
    { id: 'mono', name: '墨黑', swatch: '#243036' },
    { id: 'navy', name: '靛蓝', swatch: '#4f6bed' },
    { id: 'peach', name: '蜜桃粉', swatch: '#f7b8c4' },
    { id: 'matcha', name: '抹茶绿', swatch: '#9db87a' },
    { id: 'note', name: '便利贴', swatch: '#ffe27a' },
    { id: 'terminal', name: '终端绿', swatch: '#17301f' },
    { id: 'comic', name: '漫画描边', swatch: '#ffffff' },
  ]

  // 与桌宠端 pet-sound.js 的 EVENT_PRESET 保持一致（事件 → 说明）
  var SOUND_EVENTS = [
    { id: 'press', label: '按压桌宠', hint: '按住桌宠时的即时反馈' },
    { id: 'release', label: '松开桌宠', hint: '松开时的回落音' },
    { id: 'switch', label: 'Agent 交接', hint: '活跃 Agent 换人时' },
    { id: 'task_end', label: '任务结束', hint: '一轮工作完成时' },
    { id: 'ask', label: '需要你回答', hint: 'DSH 抛出提问时' },
    { id: 'approval', label: '需要你授权', hint: 'DSH 等待批准时' },
    { id: 'error', label: '出现异常', hint: '工作流报错时' },
  ]

  // 音频格式要求（**必须与后端 /api/companion/sounds 的白名单一致**）。
  // 关键约束不是我们的白名单，而是**浏览器解码器**：试听/裁剪/桌宠播放都走
  // Web Audio 的 decodeAudioData，Chromium 只认这些容器+编码，其余（WMA/APE/
  // AMR/AIFF/MIDI 等）会在解码阶段失败。
  var SOUND_EXTS = ['.wav', '.mp3', '.ogg', '.opus', '.m4a', '.aac', '.flac', '.webm']
  var SOUND_ACCEPT = SOUND_EXTS.join(',')
  var SOUND_MAX_MB = 10

  var container = null
  var pollTimer = null
  var clickTalk = true
  var styleId = 'default'
  // 7.6 横条皮肤（与 styleId 同族，独立存储）
  var stripStyleId = 'default'
  var streamText = true
  var images = []
  var imageWeights = {}
  var sounds = []
  var soundEvents = {}
  var clickCfg = { first: '', queue: [] }
  var trim = null            // {name, buffer, start, end, busy}
  var audioCtx = null

  function $q(sel, root) { return (root || document).querySelector(sel) }

  function card(title, body) {
    return '<div style="border:1px solid var(--line,#d9e2e6);border-radius:10px;background:var(--surface,#fff);padding:14px 16px;">' +
      (title ? '<div style="font-size:12px;font-weight:700;margin-bottom:10px;color:var(--ink,#20303a);">' + title + '</div>' : '') +
      body + '</div>'
  }

  function btnStyle(kind) {
    if (kind === 'primary') {
      return 'border:1px solid ' + ACCENT + '55;background:' + ACCENT + '12;color:' + ACCENT + ';border-radius:7px;padding:4px 11px;font-size:12px;cursor:pointer;'
    }
    if (kind === 'danger') {
      return 'border:1px solid #c0392b44;background:#c0392b0f;color:#c0392b;border-radius:7px;padding:4px 11px;font-size:12px;cursor:pointer;'
    }
    return 'border:1px solid var(--line,#d9e2e6);background:var(--surface,#fff);color:var(--ink,#20303a);border-radius:7px;padding:4px 11px;font-size:12px;cursor:pointer;'
  }

  function toast(msg, ok) {
    var el = $q('#bpToast', container)
    if (!el) return
    el.textContent = msg
    el.style.color = ok ? '#2e9e5b' : '#c0392b'
    window.clearTimeout(el.__t)
    el.__t = window.setTimeout(function () { el.textContent = '' }, 2600)
  }

  function saveSettings(patch, doneMsg) {
    return fetch('/api/companion/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      toast(doneMsg || '已保存，桌宠热应用中', true)
    }).catch(function (e) { toast('保存失败：' + (e.message || e), false) })
  }

  function fmtTime(sec) {
    return (Math.round(Number(sec) * 100) / 100).toFixed(2) + 's'
  }

  // ---------- 皮肤 ----------

  function renderStyles() {
    var items = STYLE_DEFS.map(function (s) {
      var cur = s.id === styleId
      return '<button type="button" data-style="' + s.id + '" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:9px 4px;border:1px solid ' +
        (cur ? ACCENT : 'var(--line,#d9e2e6)') + ';border-radius:10px;background:' + (cur ? ACCENT + '10' : 'var(--surface,#fff)') +
        ';cursor:pointer;box-shadow:' + (cur ? '0 0 0 2px ' + ACCENT + '2e' : 'none') + ';">' +
        '<span style="width:26px;height:26px;border-radius:50%;background:' + s.swatch + ';border:1px solid #94a7ad;"></span>' +
        '<span style="font-size:11px;color:var(--ink,#20303a);">' + s.name + '</span></button>'
    }).join('')
    return card('气泡皮肤',
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">' + items + '</div>' +
      '<div style="margin-top:9px;font-size:10px;color:var(--muted,#687984);">插件身份色（如 DSH 蓝）优先于皮肤——气泡颜色跟"谁在说话"走。</div>')
  }

  // ---------- 横条皮肤（7.6：DSH 流式提示专用窗位）----------

  // 横条与气泡**共用同一套皮肤 id**（default/mono/navy/…），只是作用元素不同。
  // 所以这里复用 STYLE_DEFS 渲染，避免两处各自维护一份皮肤清单导致漂移。
  function renderStripStyles() {
    var items = STYLE_DEFS.map(function (s) {
      var cur = s.id === stripStyleId
      return '<button type="button" data-strip-style="' + s.id + '" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:9px 4px;border:1px solid ' +
        (cur ? ACCENT : 'var(--line,#d9e2e6)') + ';border-radius:10px;background:' + (cur ? ACCENT + '10' : 'var(--surface,#fff)') +
        ';cursor:pointer;box-shadow:' + (cur ? '0 0 0 2px ' + ACCENT + '2e' : 'none') + ';">' +
        '<span style="width:26px;height:26px;border-radius:7px;background:' + s.swatch + ';border:1px solid #94a7ad;"></span>' +
        '<span style="font-size:11px;color:var(--ink,#20303a);">' + s.name + '</span></button>'
    }).join('')
    return card('横条皮肤（DSH 流式提示）',
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">' + items + '</div>' +
      '<div style="margin-top:9px;font-size:10px;line-height:1.8;color:var(--muted,#687984);">' +
        '• 横条是 DSH 下发**流式提示**的专用窗位（可拖动、✕ 可关），与说话气泡**互斥**使用，不再打架。<br />' +
        '• 形状是胶囊条，所以这里用圆角色块示意；皮肤与气泡共用同一套配色。<br />' +
        '• 用户按 ✕ 关闭后，横条在本机**不会自动再弹**；重新想用请点下面这个按钮。' +
      '</div>' +
      '<div style="margin-top:9px;display:flex;gap:8px;">' +
        '<button type="button" data-strip-reset="1" style="' + btnStyle() + '">重新启用横条</button>' +
      '</div>')
  }

  // ---------- 逐 token 流式（M1） ----------

  function renderStreamText() {
    return card('逐 token 流式',
      '<div style="display:flex;align-items:center;gap:9px;padding:7px 9px;border:1px solid var(--line,#d9e2e6);border-radius:9px;background:var(--surface,#fff);">' +
        '<input type="checkbox" id="bpStreamText"' + (streamText ? ' checked' : '') + ' style="flex:none;" />' +
        '<label for="bpStreamText" style="flex:1;display:flex;flex-direction:column;cursor:pointer;">' +
          '<strong style="font-size:12px;">助手正文逐块铺进气泡</strong>' +
          '<small style="font-size:10px;color:var(--muted,#687984);">Agent（如 DSH）输出正文时，气泡按上游原始节奏逐块追加，而不是整段一次性弹出</small></label>' +
      '</div>' +
      '<div style="margin-top:9px;font-size:10px;line-height:1.8;color:var(--muted,#687984);">' +
        '• 关掉后仍可用「一次性文本气泡」（插件主动喊你时的一句话），只是不逐块铺开。<br />' +
        '• 上游把几十个 token 一次性 flush 时，气泡会给每块垫一个可感知的最小间隔，避免"啪"地全段出现。<br />' +
        '• 收尾用权威全文校正一次，保证零丢字、零重复；播完按文字长度停留 3.5~12 秒。' +
      '</div>')
  }

  // ---------- 点击互动（开关 + 点击序列） ----------

  function renderClickTalk() {
    var queueRows = clickCfg.queue.map(function (text, i) {
      return '<div style="display:flex;align-items:center;gap:6px;">' +
        '<span style="flex:none;font-size:10px;color:var(--muted,#687984);width:34px;">第' + (i + 2) + '次</span>' +
        '<input type="text" data-queue-idx="' + i + '" value="' + String(text).replace(/"/g, '&quot;') + '" style="flex:1;min-height:26px;padding:0 8px;border:1px solid #d5e0e3;border-radius:6px;font-size:11px;" />' +
        '<button type="button" data-queue-up="' + i + '" title="上移" style="' + btnStyle() + 'padding:2px 7px;">↑</button>' +
        '<button type="button" data-queue-del="' + i + '" title="删除" style="' + btnStyle('danger') + 'padding:2px 7px;">✕</button>' +
      '</div>'
    }).join('')

    return card('点击互动',
      '<div style="display:flex;align-items:center;gap:9px;padding:7px 9px;border:1px solid var(--line,#d9e2e6);border-radius:9px;background:var(--surface,#fff);margin-bottom:10px;">' +
        '<input type="checkbox" id="bpClickTalk"' + (clickTalk ? ' checked' : '') + ' style="flex:none;" />' +
        '<label for="bpClickTalk" style="flex:1;display:flex;flex-direction:column;cursor:pointer;">' +
          '<strong style="font-size:12px;">点击桌宠时随机互动</strong>' +
          '<small style="font-size:10px;color:var(--muted,#687984);">关闭后除了"点击序列"，随机语句/图片也不再触发</small></label>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:7px;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span style="flex:none;font-size:10px;color:var(--muted,#687984);width:34px;">第1次</span>' +
          '<input type="text" id="bpClickFirst" placeholder="首次点击显示的话（留空跳过）" value="' + String(clickCfg.first || '').replace(/"/g, '&quot;') + '" style="flex:1;min-height:26px;padding:0 8px;border:1px solid #d5e0e3;border-radius:6px;font-size:11px;" />' +
          '<button type="button" id="bpQueueAdd" style="' + btnStyle('primary') + '">加一条</button>' +
        '</div>' +
        queueRows +
      '</div>' +
      '<div style="margin-top:9px;font-size:10px;line-height:1.8;color:var(--muted,#687984);">' +
        '点桌宠按「第1次 → 第2次 → … → 循环」推进（whale 的点击序列玩法）。<br />' +
        '单项语法：<code>a|b|c</code> = 等权随机取一句；<code>{image}</code> = 从图片素材库随机抽一张。<br />' +
        '未配置序列时走缺省随机：素材库有图时约 45% 出图片，否则随机语句。气泡 3 秒自动消失。' +
      '</div>')
  }

  // ---------- 图片素材库（含权重） ----------

  function renderImages() {
    var items = images.map(function (im) {
      var w = Number(imageWeights[im.name])
      var weight = Number.isFinite(w) && w > 0 ? w : 1
      return '<div style="position:relative;width:104px;">' +
        '<img src="' + im.url + '?v=' + im.mtime + '" style="width:104px;height:64px;object-fit:cover;border-radius:7px;border:1px solid var(--line,#d9e2e6);" />' +
        '<button type="button" data-del="' + encodeURIComponent(im.name) + '" title="删除" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border:none;border-radius:50%;background:#c0392b;color:#fff;font-size:10px;cursor:pointer;">✕</button>' +
        '<div style="display:flex;align-items:center;gap:4px;margin-top:3px;">' +
          '<span style="flex:1;font-size:9px;color:var(--muted,#687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" title="' + im.name + '">' + im.name + '</span>' +
          '<input type="number" min="1" max="99" step="1" data-weight="' + encodeURIComponent(im.name) + '" value="' + weight + '" title="抽到权重（越大越常出）" style="width:38px;min-height:20px;padding:0 3px;border:1px solid #d5e0e3;border-radius:5px;font-size:10px;" />' +
        '</div></div>'
    }).join('')
    var empty = images.length ? '' : '<div style="font-size:11px;color:var(--muted,#687984);padding:8px 2px;">素材库为空——上传图片后，点击互动就能出图片了。</div>'
    return card('图片素材库（' + images.length + ' 张）',
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">' +
        '<button type="button" id="bpUploadBtn" style="' + btnStyle('primary') + '">上传图片</button>' +
        '<input type="file" id="bpUploadFile" accept=".png,.jpg,.jpeg,.gif,.webp" multiple style="display:none;" />' +
        '<span id="bpToast" style="font-size:11px;"></span>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:12px;">' + items + empty + '</div>' +
      '<div style="margin-top:9px;font-size:10px;color:var(--muted,#687984);">单张 ≤5MB，支持 PNG/JPG/GIF/WebP；右下角数字是抽到权重（默认 1）。也可以直接把图片放进 Live2D桌宠/bubble-imgs 目录。</div>')
  }

  // ---------- 音效（事件表 + 片段库） ----------

  function clipOptions(selected) {
    var opts = '<option value=""' + (selected ? '' : ' selected') + '>内置合成音</option>'
    sounds.forEach(function (s) {
      opts += '<option value="' + s.name.replace(/"/g, '&quot;') + '"' + (s.name === selected ? ' selected' : '') + '>' + s.name + '</option>'
    })
    return opts
  }

  function renderSoundEvents() {
    var rows = SOUND_EVENTS.map(function (ev) {
      var cfg = soundEvents[ev.id] || {}
      var on = cfg.enabled !== false
      var vol = Number.isFinite(Number(cfg.volume)) ? Number(cfg.volume) : 100
      var clip = typeof cfg.clip === 'string' ? cfg.clip : ''
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--line,#d9e2e6);border-radius:9px;background:var(--surface,#fff);flex-wrap:wrap;">' +
        '<input type="checkbox" data-snd-on="' + ev.id + '"' + (on ? ' checked' : '') + ' style="flex:none;" title="响不响" />' +
        '<div style="flex:1;min-width:96px;display:flex;flex-direction:column;">' +
          '<strong style="font-size:12px;">' + ev.label + '</strong>' +
          '<small style="font-size:10px;color:var(--muted,#687984);">' + ev.hint + '</small></div>' +
        '<select data-snd-clip="' + ev.id + '" style="min-height:26px;max-width:150px;border:1px solid #d5e0e3;border-radius:6px;font-size:11px;">' + clipOptions(clip) + '</select>' +
        '<input type="range" min="0" max="100" step="5" value="' + vol + '" data-snd-vol="' + ev.id + '" title="本事件音量" style="width:82px;" />' +
        '<span data-snd-vol-out="' + ev.id + '" style="flex:none;width:32px;font-size:10px;color:var(--muted,#687984);">' + vol + '%</span>' +
        '<button type="button" data-snd-play="' + ev.id + '" style="' + btnStyle() + '">试听</button>' +
      '</div>'
    }).join('')
    return card('音效事件',
      '<div style="display:flex;flex-direction:column;gap:7px;">' + rows + '</div>' +
      '<div style="margin-top:9px;font-size:10px;line-height:1.8;color:var(--muted,#687984);">' +
        '每行可单独开关 / 换片段 / 调音量；片段选「内置合成音」以外的项即播放自定义音频（点击音就是按压+松开两行）。<br />' +
        '总开关与基准音量在「设置 → 桌宠 → 音效」；本页音量是各事件相对基准的百分比。</div>')
  }

  function renderSoundClips() {
    var rows = sounds.map(function (s) {
      var active = trim && trim.name === s.name
      var row = '<div style="display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--line,#d9e2e6);border-radius:9px;background:var(--surface,#fff);">' +
        '<span style="flex:1;font-size:11px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" title="' + s.name + '">' + s.name + '</span>' +
        '<span style="flex:none;font-size:10px;color:var(--muted,#687984);">' + (s.bytes / 1024).toFixed(1) + ' KB</span>' +
        '<button type="button" data-clip-play="' + encodeURIComponent(s.name) + '" style="' + btnStyle() + '">试听</button>' +
        '<button type="button" data-clip-trim="' + encodeURIComponent(s.name) + '" style="' + btnStyle('primary') + '">裁剪</button>' +
        '<button type="button" data-clip-del="' + encodeURIComponent(s.name) + '" style="' + btnStyle('danger') + '">删除</button>' +
      '</div>'
      if (active) {
        row += '<div style="margin:6px 0 2px;padding:9px;border:1px dashed ' + ACCENT + '66;border-radius:9px;background:' + ACCENT + '08;">' +
          '<canvas id="bpTrimCanvas" width="420" height="72" style="width:100%;max-width:420px;height:72px;background:#fff;border:1px solid var(--line,#d9e2e6);border-radius:6px;cursor:crosshair;"></canvas>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap;">' +
            '<span id="bpTrimRange" style="font-size:11px;color:var(--muted,#687984);">' + (trim.busy ? '解码中…' : '在波形上按住拖选要保留的区间') + '</span>' +
            '<button type="button" id="bpTrimPreview" style="' + btnStyle() + '">试听选区</button>' +
            '<button type="button" id="bpTrimSave" style="' + btnStyle('primary') + '">保存为片段</button>' +
            '<button type="button" id="bpTrimCancel" style="' + btnStyle() + '">取消</button>' +
          '</div></div>'
      }
      return row
    }).join('')
    var empty = sounds.length ? '' : '<div style="font-size:11px;color:var(--muted,#687984);padding:6px 2px;">还没有自定义片段——上传音频后可在上方事件表里替换任意事件音。</div>'
    return card('音效片段（' + sounds.length + ' 个）',
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">' +
        '<button type="button" id="bpSoundUploadBtn" style="' + btnStyle('primary') + '" title="支持：' + SOUND_EXTS.join(' / ') + '（≤' + SOUND_MAX_MB + 'MB）">上传音频</button>' +
        '<input type="file" id="bpSoundUploadFile" accept="' + SOUND_ACCEPT + '" multiple style="display:none;" />' +
      '</div>' +
      '<div style="margin-bottom:10px;padding:8px 10px;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:var(--surface-soft,#f2f6f7);font-size:10px;line-height:1.9;color:var(--muted,#687984);">' +
        '<b style="color:var(--ink,#20303a);">格式要求</b>：只支持浏览器能解码的音频 —— ' +
        SOUND_EXTS.join(' / ') + '，单个 ≤' + SOUND_MAX_MB + 'MB。<br />' +
        '• <b>推荐 WAV / MP3</b>（最稳，任何浏览器都能播）；OGG/Opus/FLAC 也支持。<br />' +
        '• <b>不支持</b> WMA / APE / AMR / AIFF / MIDI / 加密音乐平台下载的受保护格式（后缀对不上会被拒，后缀对得上但编码不支持会在试听/裁剪时报"无法解码"，请先转成 WAV 或 MP3）。<br />' +
        '• 建议做<b>短音效</b>：≤3 秒、单声道、22.05~44.1kHz 即可，体积小、触发延迟低。<br />' +
        '• 事件音若没绑片段，走内置合成音（不需要任何素材）。' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' + rows + empty + '</div>' +
      '<div style="margin-top:9px;font-size:10px;color:var(--muted,#687984);">「裁剪」在波形上拖选区间，保存为新片段（WAV），原片段保留。</div>')
  }

  function renderAll() {
    var body = $q('#bpBody', container)
    if (!body) return
    body.innerHTML = renderStyles() + renderStripStyles() + renderStreamText() + renderClickTalk() + renderImages() + renderSoundEvents() + renderSoundClips()
    bindAll()
    if (trim) drawTrim()
  }

  // ---------- 音频工具（裁剪用） ----------

  function getAudioCtx() {
    if (audioCtx) return audioCtx
    try {
      var AC = window.AudioContext || window.webkitAudioContext
      audioCtx = AC ? new AC() : null
    } catch (_) { audioCtx = null }
    return audioCtx
  }

  function clipUrlOf(name) {
    var found = null
    sounds.forEach(function (s) { if (s.name === name) found = s })
    return found ? found.url : ('/api/companion/sounds/' + encodeURIComponent(name))
  }

  function openTrim(name) {
    var ctx = getAudioCtx()
    if (!ctx) { toast('当前环境不支持音频裁剪', false); return }
    trim = { name: name, buffer: null, start: 0, end: 1, busy: true }
    renderAll()
    fetch(clipUrlOf(name) + '?t=' + Date.now())
      .then(function (r) { return r.arrayBuffer() })
      .then(function (buf) { return ctx.decodeAudioData(buf) })
      .then(function (audioBuf) {
        if (!trim || trim.name !== name) return
        trim.buffer = audioBuf
        trim.busy = false
        trim.start = 0
        trim.end = 1
        renderAll()
      })
      .catch(function () { toast('该文件浏览器解不开——请转成 WAV / MP3 再传（见上方格式要求）', false); trim = null; renderAll() })
  }

  function drawTrim() {
    var cv = $q('#bpTrimCanvas', container)
    if (!cv || !trim) return
    var ctx2d = cv.getContext('2d')
    var W = cv.width
    var H = cv.height
    ctx2d.clearRect(0, 0, W, H)
    ctx2d.fillStyle = '#f5f8fa'
    ctx2d.fillRect(0, 0, W, H)
    if (!trim.buffer) return
    var data = trim.buffer.getChannelData(0)
    var step = Math.max(1, Math.floor(data.length / W))
    ctx2d.strokeStyle = '#7f96a3'
    ctx2d.beginPath()
    for (var x = 0; x < W; x++) {
      var peak = 0
      for (var i = 0; i < step; i++) {
        var v = Math.abs(data[x * step + i] || 0)
        if (v > peak) peak = v
      }
      var h = Math.max(1, peak * (H - 8))
      ctx2d.moveTo(x + 0.5, (H - h) / 2)
      ctx2d.lineTo(x + 0.5, (H + h) / 2)
    }
    ctx2d.stroke()
    // 选区高亮
    var x0 = Math.round(trim.start * W)
    var x1 = Math.round(trim.end * W)
    ctx2d.fillStyle = ACCENT + '22'
    ctx2d.fillRect(x0, 0, Math.max(1, x1 - x0), H)
    ctx2d.strokeStyle = ACCENT
    ctx2d.beginPath()
    ctx2d.moveTo(x0 + 0.5, 0); ctx2d.lineTo(x0 + 0.5, H)
    ctx2d.moveTo(x1 + 0.5, 0); ctx2d.lineTo(x1 + 0.5, H)
    ctx2d.stroke()
    var out = $q('#bpTrimRange', container)
    if (out && trim.buffer) {
      var dur = trim.buffer.duration
      out.textContent = fmtTime(trim.start * dur) + ' ~ ' + fmtTime(trim.end * dur) + ' / 共 ' + fmtTime(dur)
    }
  }

  function previewTrim() {
    if (!trim || !trim.buffer) return
    var ctx = getAudioCtx()
    if (!ctx) return
    var dur = trim.buffer.duration
    var src = ctx.createBufferSource()
    src.buffer = trim.buffer
    src.connect(ctx.destination)
    src.start(0, trim.start * dur, Math.max(0.05, (trim.end - trim.start) * dur))
  }

  function encodeWav(audioBuffer) {
    var numCh = audioBuffer.numberOfChannels
    var len = audioBuffer.length
    var sampleRate = audioBuffer.sampleRate
    var bytesPerSample = 2
    var blockAlign = numCh * bytesPerSample
    var dataSize = len * blockAlign
    var buffer = new ArrayBuffer(44 + dataSize)
    var view = new DataView(buffer)
    function writeStr(offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
    }
    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, numCh, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * blockAlign, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, 16, true)
    writeStr(36, 'data')
    view.setUint32(40, dataSize, true)
    var channels = []
    for (var c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c))
    var offset = 44
    for (var i = 0; i < len; i++) {
      for (var ch = 0; ch < numCh; ch++) {
        var s = Math.max(-1, Math.min(1, channels[ch][i]))
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
        offset += 2
      }
    }
    return buffer
  }

  function saveTrim() {
    if (!trim || !trim.buffer) return
    var ctx = getAudioCtx()
    if (!ctx) return
    var dur = trim.buffer.duration
    var startSec = trim.start * dur
    var segSec = Math.max(0.05, (trim.end - trim.start) * dur)
    var frames = Math.max(1, Math.floor(segSec * trim.buffer.sampleRate))
    var base = trim.name.replace(/\.[^.]+$/, '').replace(/_trim\d*$/, '')
    var outName = base + '_trim.wav'
    var off
    try {
      off = ctx.createOfflineAudioContext
        ? ctx.createOfflineAudioContext(trim.buffer.numberOfChannels, frames, trim.buffer.sampleRate)
        : new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(trim.buffer.numberOfChannels, frames, trim.buffer.sampleRate)
    } catch (_) { toast('当前环境不支持离线渲染', false); return }
    var src = off.createBufferSource()
    src.buffer = trim.buffer
    src.connect(off.destination)
    src.start(0, startSec, segSec)
    off.startRendering().then(function (rendered) {
      var wavBuf = encodeWav(rendered)
      var bytes = new Uint8Array(wavBuf)
      var binary = ''
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      var dataUrl = 'data:audio/wav;base64,' + window.btoa(binary)
      return fetch('/api/companion/sounds/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: outName, data_url: dataUrl }),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
    }).then(function (res) {
      toast(res.ok ? '已保存为 ' + outName : (res.j && res.j.detail) || '保存失败', res.ok)
      trim = null
      return refreshSounds()
    }).catch(function () {
      toast('裁剪保存失败', false)
    })
  }

  // ---------- 绑定 ----------

  function bindAll() {
    var body = $q('#bpBody', container)
    if (!body) return

    body.querySelectorAll('[data-style]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        styleId = btn.getAttribute('data-style')
        saveSettings({ live2d_bubble_style: styleId }, '皮肤已切换').then(function () { refresh() })
      })
    })

    // 7.6 横条皮肤：写 live2d_strip_style（与气泡皮肤同族）。
    // 桌宠渲染端认这个键并热应用（applySettings → __mioPetStrip.applyStyle）。
    body.querySelectorAll('[data-strip-style]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        stripStyleId = btn.getAttribute('data-strip-style')
        saveSettings({ live2d_strip_style: stripStyleId }, '横条皮肤已切换').then(function () { refresh() })
      })
    })

    // 「重新启用横条」：清掉用户按 ✕ 留下的"已拒绝"长期记忆。
    // 该状态存在桌宠窗口的 localStorage（主体拥有），设置页读不到，
    // 故经服务端 settings 下发一个一次性信号，由渲染端执行 resetDismissed()。
    var stripResetBtn = $q('[data-strip-reset]', body)
    if (stripResetBtn) {
      stripResetBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        saveSettings({ pet_strip_reset_token: Date.now() }, '横条已重新启用（桌宠下次刷新即生效）')
      })
    }

    var streamCb = $q('#bpStreamText', body)
    if (streamCb) {
      streamCb.addEventListener('change', function () {
        streamText = streamCb.checked
        saveSettings({ live2d_stream_text_enabled: streamText }, streamText ? '逐 token 流式已开启' : '逐 token 流式已关闭')
      })
    }
    var clickCb = $q('#bpClickTalk', body)
    if (clickCb) {
      clickCb.addEventListener('change', function () {
        clickTalk = clickCb.checked
        saveSettings({ pet_click_talk_enabled: clickTalk }, clickTalk ? '点击互动已开启' : '点击互动已关闭')
      })
    }
    var firstInput = $q('#bpClickFirst', body)
    if (firstInput) {
      firstInput.addEventListener('change', function () {
        clickCfg.first = firstInput.value
        saveSettings({ pet_click_bubbles: clickCfg }, '首次点击泡已保存')
      })
    }
    var addBtn = $q('#bpQueueAdd', body)
    if (addBtn) {
      addBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        clickCfg.queue.push('')
        saveSettings({ pet_click_bubbles: clickCfg }, '已加一条（填入内容后自动保存）').then(function () { renderAll() })
      })
    }
    body.querySelectorAll('[data-queue-idx]').forEach(function (input) {
      input.addEventListener('change', function () {
        var i = Number(input.getAttribute('data-queue-idx'))
        clickCfg.queue[i] = input.value
        saveSettings({ pet_click_bubbles: clickCfg }, '序列已保存')
      })
    })
    body.querySelectorAll('[data-queue-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        clickCfg.queue.splice(Number(btn.getAttribute('data-queue-del')), 1)
        saveSettings({ pet_click_bubbles: clickCfg }, '已删除该条').then(function () { renderAll() })
      })
    })
    body.querySelectorAll('[data-queue-up]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        var i = Number(btn.getAttribute('data-queue-up'))
        if (i > 0) {
          var t = clickCfg.queue[i - 1]
          clickCfg.queue[i - 1] = clickCfg.queue[i]
          clickCfg.queue[i] = t
          saveSettings({ pet_click_bubbles: clickCfg }, '顺序已调整').then(function () { renderAll() })
        }
      })
    })

    // 图片上传 / 删除 / 权重
    var upBtn = $q('#bpUploadBtn', body)
    var upFile = $q('#bpUploadFile', body)
    if (upBtn && upFile) {
      upBtn.addEventListener('click', function (e) { e.stopPropagation(); upFile.click() })
      upFile.addEventListener('change', function () {
        var files = Array.prototype.slice.call(upFile.files || [])
        if (!files.length) return
        var chain = Promise.resolve()
        files.forEach(function (f) {
          chain = chain.then(function () {
            if (f.size > 5 * 1024 * 1024) { toast(f.name + ' 超过 5MB', false); return }
            return new Promise(function (resolve) {
              var reader = new FileReader()
              reader.onload = function () {
                fetch('/api/companion/bubble-images/upload', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: f.name, data_url: reader.result }),
                }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
                  .then(function (res) { toast(res.ok ? '已上传 ' + f.name : (res.j && res.j.detail) || '上传失败', res.ok) })
                  .catch(function () { toast('上传失败：网络错误', false) })
                  .then(resolve)
              }
              reader.onerror = function () { toast(f.name + ' 读取失败', false); resolve() }
              reader.readAsDataURL(f)
            })
          })
        })
        chain.then(function () { refreshImages() })
        upFile.value = ''
      })
    }
    body.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        fetch('/api/companion/bubble-images/' + btn.getAttribute('data-del'), { method: 'DELETE' })
          .then(function () { toast('已删除', true); refreshImages() })
          .catch(function () { toast('删除失败', false) })
      })
    })
    body.querySelectorAll('[data-weight]').forEach(function (input) {
      input.addEventListener('change', function () {
        var name = decodeURIComponent(input.getAttribute('data-weight'))
        var w = Math.max(1, Math.min(99, Math.round(Number(input.value) || 1)))
        input.value = w
        imageWeights[name] = w
        saveSettings({ pet_image_weights: imageWeights }, '权重已保存')
      })
    })

    // 音效事件
    body.querySelectorAll('[data-snd-on]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-snd-on')
        var cfg = soundEvents[id] || (soundEvents[id] = {})
        cfg.enabled = cb.checked
        saveSettings({ pet_sound_events: soundEvents }, (cb.checked ? '已开启 ' : '已静音 ') + id)
      })
    })
    body.querySelectorAll('[data-snd-clip]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var id = sel.getAttribute('data-snd-clip')
        var cfg = soundEvents[id] || (soundEvents[id] = {})
        cfg.clip = sel.value
        saveSettings({ pet_sound_events: soundEvents }, cfg.clip ? '已绑定片段' : '已回到内置合成音')
      })
    })
    body.querySelectorAll('[data-snd-vol]').forEach(function (slider) {
      slider.addEventListener('input', function () {
        var out = $q('[data-snd-vol-out="' + slider.getAttribute('data-snd-vol') + '"]', body)
        if (out) out.textContent = slider.value + '%'
      })
      slider.addEventListener('change', function () {
        var id = slider.getAttribute('data-snd-vol')
        var cfg = soundEvents[id] || (soundEvents[id] = {})
        cfg.volume = Number(slider.value)
        saveSettings({ pet_sound_events: soundEvents }, '音量已保存')
      })
    })
    body.querySelectorAll('[data-snd-play]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        var id = btn.getAttribute('data-snd-play')
        // 管理页试听：本地合成音/片段都用管理页自己的 AudioContext 播（不依赖桌宠窗口）
        previewEvent(id)
      })
    })

    // 音效片段：上传 / 试听 / 裁剪 / 删除
    var sUpBtn = $q('#bpSoundUploadBtn', body)
    var sUpFile = $q('#bpSoundUploadFile', body)
    if (sUpBtn && sUpFile) {
      sUpBtn.addEventListener('click', function (e) { e.stopPropagation(); sUpFile.click() })
      sUpFile.addEventListener('change', function () {
        var files = Array.prototype.slice.call(sUpFile.files || [])
        if (!files.length) return
        var chain = Promise.resolve()
        files.forEach(function (f) {
          chain = chain.then(function () {
            // 客户端预检：先按格式/体积给出**明确原因**，不浪费一次上传（后端同样会拒）
            var ext = ('.' + (String(f.name).split('.').pop() || '')).toLowerCase()
            if (SOUND_EXTS.indexOf(ext) < 0) {
              toast(f.name + '：不支持的格式（用 ' + SOUND_EXTS.join('/') + '）', false)
              return
            }
            if (f.size > SOUND_MAX_MB * 1024 * 1024) { toast(f.name + ' 超过 ' + SOUND_MAX_MB + 'MB', false); return }
            return new Promise(function (resolve) {
              var reader = new FileReader()
              reader.onload = function () {
                fetch('/api/companion/sounds/upload', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: f.name, data_url: reader.result }),
                }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
                  .then(function (res) { toast(res.ok ? '已上传 ' + f.name : (res.j && res.j.detail) || '上传失败', res.ok) })
                  .catch(function () { toast('上传失败：网络错误', false) })
                  .then(resolve)
              }
              reader.onerror = function () { toast(f.name + ' 读取失败', false); resolve() }
              reader.readAsDataURL(f)
            })
          })
        })
        chain.then(function () { refreshSounds() })
        sUpFile.value = ''
      })
    }
    body.querySelectorAll('[data-clip-play]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        previewClip(decodeURIComponent(btn.getAttribute('data-clip-play')))
      })
    })
    body.querySelectorAll('[data-clip-trim]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        openTrim(decodeURIComponent(btn.getAttribute('data-clip-trim')))
      })
    })
    body.querySelectorAll('[data-clip-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        var name = decodeURIComponent(btn.getAttribute('data-clip-del'))
        fetch('/api/companion/sounds/' + encodeURIComponent(name), { method: 'DELETE' })
          .then(function () { toast('已删除 ' + name, true); refreshSounds() })
          .catch(function () { toast('删除失败', false) })
      })
    })
    var trimCancel = $q('#bpTrimCancel', body)
    if (trimCancel) {
      trimCancel.addEventListener('click', function (e) { e.stopPropagation(); trim = null; renderAll() })
    }
    var trimPreview = $q('#bpTrimPreview', body)
    if (trimPreview) {
      trimPreview.addEventListener('click', function (e) { e.stopPropagation(); previewTrim() })
    }
    var trimSave = $q('#bpTrimSave', body)
    if (trimSave) {
      trimSave.addEventListener('click', function (e) { e.stopPropagation(); saveTrim() })
    }
    var cv = $q('#bpTrimCanvas', body)
    if (cv && trim) {
      var dragging = false
      var posOf = function (ev) {
        var rect = cv.getBoundingClientRect()
        return Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      }
      var anchor = 0
      cv.addEventListener('pointerdown', function (ev) {
        ev.stopPropagation()
        dragging = true
        anchor = posOf(ev)
        trim.start = anchor
        trim.end = anchor
        cv.setPointerCapture(ev.pointerId)
        drawTrim()
      })
      cv.addEventListener('pointermove', function (ev) {
        if (!dragging) return
        var p = posOf(ev)
        trim.start = Math.min(anchor, p)
        trim.end = Math.max(anchor, p)
        if (trim.end - trim.start < 0.005) trim.end = Math.min(1, trim.start + 0.005)
        drawTrim()
      })
      cv.addEventListener('pointerup', function (ev) {
        dragging = false
        try { cv.releasePointerCapture(ev.pointerId) } catch (_) {}
        drawTrim()
      })
    }
  }

  // 管理页本地试听（不依赖桌宠窗口的 AudioContext）
  var auditCtx = null
  function auditContext() {
    if (auditCtx) return auditCtx
    try {
      var AC = window.AudioContext || window.webkitAudioContext
      auditCtx = AC ? new AC() : null
    } catch (_) { auditCtx = null }
    return auditCtx
  }

  function builtinTone(ctx, id) {
    var PRESET = {
      press: [{ f: 620, t: 880, d: 0.075 }],
      release: [{ f: 760, t: 520, d: 0.085 }],
      switch: [{ f: 700, t: 700, d: 0.06 }, { f: 980, t: 980, d: 0.08, delay: 0.07 }],
      task_end: [{ f: 660, t: 660, d: 0.07 }, { f: 880, t: 880, d: 0.07, delay: 0.08 }, { f: 1180, t: 1180, d: 0.12, delay: 0.165 }],
      ask: [{ f: 720, t: 1080, d: 0.09 }, { f: 900, t: 1180, d: 0.11, delay: 0.11 }],
      approval: [{ f: 1040, t: 1040, d: 0.08 }, { f: 1320, t: 1320, d: 0.1, delay: 0.095 }],
      error: [{ f: 320, t: 300, d: 0.14 }, { f: 240, t: 220, d: 0.18, delay: 0.13 }],
    }
    var notes = PRESET[id] || PRESET.press
    try { if (ctx.state === 'suspended') ctx.resume() } catch (_) {}
    notes.forEach(function (n) {
      var t0 = ctx.currentTime + 0.02 + (n.delay || 0)
      var osc = ctx.createOscillator()
      var g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(n.f, t0)
      if (n.t !== n.f) osc.frequency.exponentialRampToValueAtTime(n.t, t0 + n.d)
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.d)
      osc.connect(g)
      g.connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + n.d + 0.02)
    })
  }

  function previewEvent(id) {
    var ctx = auditContext()
    if (!ctx) return
    var cfg = soundEvents[id] || {}
    var vol = Number.isFinite(Number(cfg.volume)) ? Math.max(0, Math.min(1, Number(cfg.volume) / 100)) : 1
    var clip = typeof cfg.clip === 'string' ? cfg.clip.trim() : ''
    if (!clip) { builtinTone(ctx, id); return }
    previewClip(clip, vol)
  }

  function previewClip(name, vol) {
    var ctx = auditContext()
    if (!ctx) return
    try { if (ctx.state === 'suspended') ctx.resume() } catch (_) {}
    fetch(clipUrlOf(name) + '?t=' + Date.now())
      .then(function (r) { return r.arrayBuffer() })
      .then(function (buf) { return ctx.decodeAudioData(buf) })
      .then(function (audioBuf) {
        var src = ctx.createBufferSource()
        var g = ctx.createGain()
        src.buffer = audioBuf
        g.gain.value = Number.isFinite(vol) ? vol : 1
        src.connect(g)
        g.connect(ctx.destination)
        src.start()
      })
      .catch(function () { toast('无法试听：浏览器不支持该编码，请转成 WAV / MP3', false) })
  }

  // ---------- 数据刷新 ----------

  function refreshImages() {
    return fetch('/api/companion/bubble-images', { headers: { 'Cache-Control': 'no-cache' } })
      .then(function (r) { return r.json() })
      .then(function (j) {
        images = (j && j.images) || []
        if (container && container.isConnected) renderAll()
      })
      .catch(function () {})
  }

  function refreshSounds() {
    return fetch('/api/companion/sounds', { headers: { 'Cache-Control': 'no-cache' } })
      .then(function (r) { return r.json() })
      .then(function (j) {
        sounds = (j && j.sounds) || []
        if (container && container.isConnected) renderAll()
      })
      .catch(function () {})
  }

  function refresh() {
    if (!container || !container.isConnected) { stopPoll(); return }
    return Promise.all([
      fetch('/api/companion/status', { headers: { 'Cache-Control': 'no-cache' } }).then(function (r) { return r.json() }).catch(function () { return null }),
      fetch('/api/companion/bubble-images', { headers: { 'Cache-Control': 'no-cache' } }).then(function (r) { return r.json() }).catch(function () { return null }),
      fetch('/api/companion/sounds', { headers: { 'Cache-Control': 'no-cache' } }).then(function (r) { return r.json() }).catch(function () { return null }),
    ]).then(function (res) {
      if (!container || container.isConnected !== undefined && !container.isConnected) { stopPoll(); return }
      var st = (res[0] && res[0].pet && res[0].pet.settings) || {}
      styleId = String(st.live2d_bubble_style || 'default')
      stripStyleId = String(st.live2d_strip_style || 'default')
      clickTalk = st.pet_click_talk_enabled !== false
      streamText = st.live2d_stream_text_enabled !== false
      soundEvents = (st.pet_sound_events && typeof st.pet_sound_events === 'object') ? JSON.parse(JSON.stringify(st.pet_sound_events)) : {}
      imageWeights = (st.pet_image_weights && typeof st.pet_image_weights === 'object') ? JSON.parse(JSON.stringify(st.pet_image_weights)) : {}
      var cb = (st.pet_click_bubbles && typeof st.pet_click_bubbles === 'object') ? st.pet_click_bubbles : {}
      clickCfg = {
        first: String(cb.first || ''),
        queue: Array.isArray(cb.queue) ? cb.queue.map(function (x) { return String(x || '') }) : [],
      }
      images = (res[1] && res[1].images) || []
      sounds = (res[2] && res[2].sounds) || []
      renderAll()
    })
  }

  function startPoll() {
    if (pollTimer) return
    pollTimer = window.setInterval(function () {
      // 裁剪中不刷新（会打断拖选）
      if (trim && trim.buffer) return
      if (container && container.isConnected) refresh()
      else stopPoll()
    }, POLL_MS)
  }

  function stopPoll() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null }
  }

  // ---------- 入口：渲染进指定容器（由设置面板「泡泡」tab 调用） ----------

  function renderInto(host) {
    if (!host) return
    container = host
    stopPoll()
    container.innerHTML =
      '<div style="flex:none;padding:10px 14px;font-size:11px;line-height:1.7;color:var(--muted,#687984);background:var(--surface-soft,#f2f6f7);border:1px solid var(--line,#d9e2e6);border-radius:9px;margin-bottom:12px;">' +
        '所有改动<b style="color:var(--accent,#4c8798);">即时保存</b>并热应用到桌宠（无需重启）。' +
        '气泡 3 秒自动消失；点桌宠按「点击序列」推进（未配置则随机语句/图片）。' +
      '</div>' +
      '<div id="bpBody" style="display:flex;flex-direction:column;gap:14px;"></div>'
    refresh(true)
    startPoll()
  }

  window.__mioBubblePanel = {
    renderInto: renderInto,
    refresh: refresh,
    destroy: stopPoll,
  }
})()
