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

  // 与桌宠端 pet-bubble-styles.js 的 STYLES 保持一致（id/name/swatch/theme）
  // ★ 2026-10-19：气泡与横条**合并成一套皮肤**，面板只列一次（以前两张卡各列 8 款）。
  var STYLE_DEFS = [
    { id: 'theme', name: '跟随主题', swatch: 'conic-gradient(#4c8798,#b7798f,#668978,#4c8798)', theme: true },
    { id: 'default', name: '默认白', swatch: '#ffffff' },
    { id: 'mono', name: '墨黑', swatch: '#243036' },
    { id: 'navy', name: '靛蓝', swatch: '#4f6bed' },
    { id: 'peach', name: '蜜桃粉', swatch: '#f7b8c4' },
    { id: 'matcha', name: '抹茶绿', swatch: '#9db87a' },
    { id: 'note', name: '便利贴', swatch: '#ffe27a' },
    { id: 'terminal', name: '终端绿', swatch: '#17301f' },
    { id: 'comic', name: '漫画描边', swatch: '#ffffff' },
    { id: 'glass', name: '磨砂玻璃', swatch: 'linear-gradient(135deg,rgba(255,255,255,.85),rgba(226,240,244,.45))', glass: true },
    { id: 'neon', name: '霓虹', swatch: 'radial-gradient(circle at 50% 50%,#9df6ff,#0b1220 70%)' },
    { id: 'paper', name: '纸墨', swatch: '#f7f0df' },
    { id: 'ink', name: '夜墨', swatch: '#14161a' },
  ]

  // 全局 UI 主题（必须与 src/styles/companion.css 的 .app-shell.theme-* 同值）
  var UI_THEME_DEFS = [
    { id: 'mist', name: '柔雾', colors: ['#e9eef0', '#4c8798', '#20303a'] },
    { id: 'clear', name: '清晨', colors: ['#f0f4f4', '#5b8c98', '#26363d'] },
    { id: 'rose', name: '蔷薇', colors: ['#f0eaed', '#9a6f78', '#2d282c'] },
    { id: 'forest', name: '森雨', colors: ['#edf1ed', '#668978', '#293a34'] },
    { id: 'sakura', name: '晚樱', colors: ['#f3eef1', '#b7798f', '#38323a'] },
    { id: 'celadon', name: '青瓷', colors: ['#e9f0ee', '#5f8f80', '#22322e'] },
    { id: 'amber', name: '琥珀', colors: ['#f3ede2', '#a8763c', '#3a3128'] },
  ]

  // 话痨程度锚点：**必须与 live2d-pet.js 的 TALK_ANCHORS 保持一致**，
  // 否则面板写"每 6~15 分钟"、桌宠按另一套节奏跑，用户会觉得滑块骗人。
  var TALK_ANCHORS = [
    { t: 0, talk: [1800, 2400], beat: [300, 600] },
    { t: 0.45, talk: [360, 900], beat: [30, 90] },
    { t: 1, talk: [60, 150], beat: [8, 20] },
  ]

  function talkativenessNumbers(level) {
    var t = Math.max(0, Math.min(100, Number(level) || 0)) / 100
    var lo = TALK_ANCHORS[0]
    var hi = TALK_ANCHORS[TALK_ANCHORS.length - 1]
    for (var i = 0; i < TALK_ANCHORS.length - 1; i++) {
      if (t >= TALK_ANCHORS[i].t && t <= TALK_ANCHORS[i + 1].t) { lo = TALK_ANCHORS[i]; hi = TALK_ANCHORS[i + 1]; break }
    }
    var k = hi.t === lo.t ? 0 : (t - lo.t) / (hi.t - lo.t)
    var mix = function (a, b) { return Math.round(a + (b - a) * k) }
    return {
      silent: t <= 0,
      talkMin: mix(lo.talk[0], hi.talk[0]), talkMax: mix(lo.talk[1], hi.talk[1]),
      beatMin: mix(lo.beat[0], hi.beat[0]), beatMax: mix(lo.beat[1], hi.beat[1]),
    }
  }

  function talkativenessLabel(level) {
    var v = Number(level) || 0
    if (v <= 0) return '完全安静'
    if (v < 25) return '寡言'
    if (v < 60) return '正常'
    if (v < 85) return '健谈'
    return '话痨'
  }

  /** 区间文案：只有**两端都到分钟级**才换成分钟（"6~15 分钟"），
      否则保持秒（"30~90 秒"）—— 30s 写成"1 分钟"会失真。 */
  function fmtRange(minSec, maxSec) {
    var a = Math.max(0, Math.round(Number(minSec) || 0))
    var b = Math.max(a, Math.round(Number(maxSec) || 0))
    if (a >= 60) {
      var am = Math.max(1, Math.round(a / 60))
      var bm = Math.max(am, Math.round(b / 60))
      return am + '~' + bm + ' 分钟'
    }
    return a + '~' + b + ' 秒'
  }

  /** "每 6~15 分钟说一句 · 每 30~90 秒换个表情" */
  function talkativenessPreview(level) {
    var n = talkativenessNumbers(level)
    if (n.silent) return '不会主动说话（微表情仍然保留，只是很慢）'
    return '每 ' + fmtRange(n.talkMin, n.talkMax) + '说一句 · 每 ' +
      fmtRange(n.beatMin, n.beatMax) + '换个表情'
  }


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
  // 个性化状态（2026-10-19）：全局主题。
  // 话痨程度 / 微表情 / 台词开关已迁到「设置 → 个性化 → 活人感」，本页只留主题。
  // ★ 同日二次拆分：本文件不再直接决定"哪些卡渲染"，而由 CARD_RENDER + PART_CARDS
  //   按「主题（appearance）」/「个性化（behavior）」两组分别注入到两个 tab。
  var uiThemeId = 'mist'
  var streamText = true
  var images = []
  var imageWeights = {}
  var sounds = []
  var soundEvents = {}
  var clickCfg = { first: '', queue: [] }
  var trim = null            // {name, buffer, start, end, busy}
  var audioCtx = null

  function $q(sel, root) { return (root || document).querySelector(sel) }

  // ---- 面板视觉基线（2026-10-19 美化）----
  // 参考 pbakaus/impeccable 的反模式清单，这里刻意遵守三条：
  //   1. **不做嵌套卡片**：卡片内只用"浅底控制行"（row()），不再给行加边框+投影；
  //   2. **功能文字不小于 12px**：旧版大量 9~10px 的说明/标签（含权重输入框）已提到 12px；
  //   3. **焦点可见**：所有可点元素保留浏览器默认 focus 环，并给 hover 态（旧版只有静态）。
  // 唯一的取舍：标题 16px / 正文 13px / 说明 12px，比例 1.23 略低于 impeccable 的 1.25 阶梯，
  // 因为宿主设置页正文就是 13px —— 与周边保持光学一致比满足纯比例更重要。
  function card(title, body) {
    return '<section style="border:1px solid var(--line,#d9e2e6);border-radius:12px;background:var(--surface,#fff);padding:16px;">' +
      (title ? '<h3 style="margin:0 0 12px;font-size:16px;font-weight:650;letter-spacing:.01em;color:var(--ink,#20303a);">' + title + '</h3>' : '') +
      body + '</section>'
  }

  /** 卡片内的控制行：浅底、无边框（避免"卡片套卡片"的反模式） */
  function row(inner) {
    return '<div style="padding:12px;border-radius:10px;background:var(--surface-soft,#f2f6f7);">' + inner + '</div>'
  }

  function hint(text) {
    return '<div style="margin-top:10px;font-size:12px;line-height:1.75;color:var(--muted,#687984);">' + text + '</div>'
  }

  function btnStyle(kind) {
    if (kind === 'primary') {
      return 'border:1px solid ' + ACCENT + '55;background:' + ACCENT + '12;color:' + ACCENT + ';border-radius:8px;padding:6px 13px;font-size:12px;font-weight:600;cursor:pointer;'
    }
    if (kind === 'danger') {
      return 'border:1px solid #c0392b44;background:#c0392b0f;color:#c0392b;border-radius:8px;padding:6px 13px;font-size:12px;font-weight:600;cursor:pointer;'
    }
    return 'border:1px solid var(--line,#d9e2e6);background:var(--surface,#fff);color:var(--ink,#20303a);border-radius:8px;padding:6px 13px;font-size:12px;font-weight:600;cursor:pointer;'
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

  // ---------- 主题（气泡 + 横条 合并成一处）----------

  function uiThemeName(id) {
    var found = null
    UI_THEME_DEFS.forEach(function (t) { if (t.id === id) found = t })
    return found ? found.name : id
  }

  function renderAppearance() {
    var items = STYLE_DEFS.map(function (s) {
      var cur = s.id === styleId
      // 预览同时画"气泡"（大块）和"横条"（细胶囊）：一眼看出这是一条设置管两个窗位
      return '<button type="button" data-style="' + s.id + '" aria-pressed="' + (cur ? 'true' : 'false') + '" title="' + s.name + '" ' +
        'style="display:flex;flex-direction:column;align-items:center;gap:7px;padding:10px 6px;border:1px solid ' +
        (cur ? ACCENT : 'var(--line,#d9e2e6)') + ';border-radius:12px;background:' + (cur ? ACCENT + '12' : 'var(--surface,#fff)') +
        ';cursor:pointer;transition:border-color .15s ease,box-shadow .15s ease;box-shadow:' + (cur ? '0 0 0 2px ' + ACCENT + '33' : 'none') + ';">' +
        '<span aria-hidden="true" style="display:flex;flex-direction:column;gap:3px;width:44px;">' +
          '<i style="display:block;height:15px;border-radius:6px 6px 6px 2px;background:' + s.swatch + ';box-shadow:inset 0 0 0 1px rgb(20 35 45 / 14%);"></i>' +
          '<i style="display:block;height:6px;width:72%;margin:0 auto;border-radius:3px;background:' + s.swatch + ';box-shadow:inset 0 0 0 1px rgb(20 35 45 / 14%);"></i>' +
        '</span>' +
        '<span style="font-size:12px;font-weight:600;color:var(--ink,#20303a);">' + s.name + '</span></button>'
    }).join('')
    var themeNote = styleId === 'theme'
      ? '<br />当前<b style="color:' + ACCENT + ';">跟随全局主题：' + uiThemeName(uiThemeId) + '</b>（在「个性化 → 全局主题」里切换）'
      : ''
    return card('气泡与横条主题',
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:8px;">' + items + '</div>' +
      hint('• 一处选择，<b>气泡和横条同时生效</b>——它们本来就是同一套视觉语言，以前分开配是重复劳动。' + themeNote +
        '<br />• 插件身份色（如 DSH 蓝）优先级更高：气泡颜色仍然跟"谁在说话"走。' +
        '<br />• 横条形状是胶囊条，所以预览只用细条示意；配色与气泡完全一致。') +
      '<div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
        '<button type="button" data-strip-reset="1" style="' + btnStyle() + '">重新启用横条</button>' +
        '<span style="font-size:12px;color:var(--muted,#687984);">按过 ✕ 之后横条不再自动弹出，点这里恢复。</span>' +
      '</div>')
  }

  // ---------- 个性化（话痨程度 / 微表情 / 台词库 / 全局主题）----------

  function renderPersonalization() {
    var themeTiles = UI_THEME_DEFS.map(function (t) {
      var cur = t.id === uiThemeId
      var swatches = t.colors.map(function (c) {
        return '<i style="display:block;width:100%;height:8px;background:' + c + ';"></i>'
      }).join('')
      return '<button type="button" data-ui-theme="' + t.id + '" aria-pressed="' + (cur ? 'true' : 'false') + '" ' +
        'style="display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid ' + (cur ? ACCENT : 'var(--line,#d9e2e6)') +
        ';border-radius:10px;background:' + (cur ? ACCENT + '12' : 'var(--surface,#fff)') + ';cursor:pointer;">' +
        '<span aria-hidden="true" style="display:flex;flex-direction:column;border-radius:4px;overflow:hidden;box-shadow:inset 0 0 0 1px rgb(20 35 45 / 10%);">' + swatches + '</span>' +
        '<span style="font-size:12px;font-weight:600;color:var(--ink,#20303a);text-align:left;">' + t.name + '</span></button>'
    }).join('')

    // ★ 2026-10-19：话痨滑块 + 两个"活人感"开关**整块迁到「设置 → 个性化 → 活人感」**。
    //   原因：本页已经有 7 张卡（皮肤 / 全局主题 / 流式 / 点击互动 / 图片 / 音效事件 / 音效片段），
    //   而话痨程度本质是桌宠**行为**，不是外观；放在个性化页更符合职责，也不会有两个入口。
    //   锚点换算仍然是本文件的 talkativenessNumbers/talkativenessPreview（唯一真源），
    //   个性化页通过 window.__mioBubblePanel.talkativeness.* 复用，不各算一套。
    //   ⚠ 本卡属于 PART_CARDS.appearance（主题 tab），提示里要指向"个性化"而不是"桌宠"。
    return card('全局主题',
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px;">' + themeTiles + '</div>' +
      hint('全局主题决定整个应用（含本页）的底色与主色，也是皮肤选「跟随主题」时气泡/横条的取色来源。' +
        '<br />与「设置 → 外观 → 主题」是同一个设置，改哪边都同步。' +
        '<br />话痨程度 / 随机微表情 / 模型台词已移到「个性化」页。'))
  }


  // ---------- 逐 token 流式（M1） ----------

  function renderStreamText() {
    return card('逐 token 流式',
      '<div style="display:flex;align-items:center;gap:9px;padding:7px 9px;border:1px solid var(--line,#d9e2e6);border-radius:9px;background:var(--surface,#fff);">' +
        '<input type="checkbox" id="bpStreamText"' + (streamText ? ' checked' : '') + ' style="flex:none;" />' +
        '<label for="bpStreamText" style="flex:1;display:flex;flex-direction:column;cursor:pointer;">' +
          '<strong style="font-size:12px;">助手正文逐块铺进气泡</strong>' +
          '<small style="font-size:12px;color:var(--muted,#687984);">Agent（如 DSH）输出正文时，气泡按上游原始节奏逐块追加，而不是整段一次性弹出</small></label>' +
      '</div>' +
      '<div style="margin-top:9px;font-size:12px;line-height:1.8;color:var(--muted,#687984);">' +
        '• 关掉后仍可用「一次性文本气泡」（插件主动喊你时的一句话），只是不逐块铺开。<br />' +
        '• 上游把几十个 token 一次性 flush 时，气泡会给每块垫一个可感知的最小间隔，避免"啪"地全段出现。<br />' +
        '• 收尾用权威全文校正一次，保证零丢字、零重复；播完按文字长度停留 3.5~12 秒。' +
      '</div>')
  }

  // ---------- 点击互动（开关 + 点击序列） ----------

  function renderClickTalk() {
    var queueRows = clickCfg.queue.map(function (text, i) {
      return '<div style="display:flex;align-items:center;gap:6px;">' +
        '<span style="flex:none;font-size:12px;color:var(--muted,#687984);width:34px;">第' + (i + 2) + '次</span>' +
        '<input type="text" data-queue-idx="' + i + '" value="' + String(text).replace(/"/g, '&quot;') + '" style="flex:1;min-height:26px;padding:0 8px;border:1px solid #d5e0e3;border-radius:6px;font-size:12px;" />' +
        '<button type="button" data-queue-up="' + i + '" title="上移" style="' + btnStyle() + 'padding:2px 7px;">↑</button>' +
        '<button type="button" data-queue-del="' + i + '" title="删除" style="' + btnStyle('danger') + 'padding:2px 7px;">✕</button>' +
      '</div>'
    }).join('')

    return card('点击互动',
      '<div style="display:flex;align-items:center;gap:9px;padding:7px 9px;border:1px solid var(--line,#d9e2e6);border-radius:9px;background:var(--surface,#fff);margin-bottom:10px;">' +
        '<input type="checkbox" id="bpClickTalk"' + (clickTalk ? ' checked' : '') + ' style="flex:none;" />' +
        '<label for="bpClickTalk" style="flex:1;display:flex;flex-direction:column;cursor:pointer;">' +
          '<strong style="font-size:12px;">点击桌宠时随机互动</strong>' +
          '<small style="font-size:12px;color:var(--muted,#687984);">关闭后除了"点击序列"，随机语句/图片也不再触发</small></label>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:7px;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span style="flex:none;font-size:12px;color:var(--muted,#687984);width:34px;">第1次</span>' +
          '<input type="text" id="bpClickFirst" placeholder="首次点击显示的话（留空跳过）" value="' + String(clickCfg.first || '').replace(/"/g, '&quot;') + '" style="flex:1;min-height:26px;padding:0 8px;border:1px solid #d5e0e3;border-radius:6px;font-size:12px;" />' +
          '<button type="button" id="bpQueueAdd" style="' + btnStyle('primary') + '">加一条</button>' +
        '</div>' +
        queueRows +
      '</div>' +
      '<div style="margin-top:9px;font-size:12px;line-height:1.8;color:var(--muted,#687984);">' +
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
        '<button type="button" data-del="' + encodeURIComponent(im.name) + '" title="删除" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border:none;border-radius:50%;background:#c0392b;color:#fff;font-size:12px;cursor:pointer;">✕</button>' +
        '<div style="display:flex;align-items:center;gap:4px;margin-top:3px;">' +
          '<span style="flex:1;font-size:12px;color:var(--muted,#687984);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" title="' + im.name + '">' + im.name + '</span>' +
          '<input type="number" min="1" max="99" step="1" data-weight="' + encodeURIComponent(im.name) + '" value="' + weight + '" title="抽到权重（越大越常出）" style="width:48px;min-height:22px;padding:0 4px;border:1px solid #d5e0e3;border-radius:5px;font-size:12px;" />' +
        '</div></div>'
    }).join('')
    var empty = images.length ? '' : '<div style="font-size:12px;color:var(--muted,#687984);padding:8px 2px;">素材库为空——上传图片后，点击互动就能出图片了。</div>'
    return card('图片素材库（' + images.length + ' 张）',
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">' +
        '<button type="button" id="bpUploadBtn" style="' + btnStyle('primary') + '">上传图片</button>' +
        '<input type="file" id="bpUploadFile" accept=".png,.jpg,.jpeg,.gif,.webp" multiple style="display:none;" />' +
        '<span id="bpToast" style="font-size:12px;"></span>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:12px;">' + items + empty + '</div>' +
      '<div style="margin-top:9px;font-size:12px;color:var(--muted,#687984);">单张 ≤5MB，支持 PNG/JPG/GIF/WebP；右下角数字是抽到权重（默认 1）。也可以直接把图片放进 Live2D桌宠/bubble-imgs 目录。</div>')
  }

  // ---------- 音效（事件表 + 片段库） ----------

  function clipOptions(selected) {
    // ★ 显式选择（2026-10-17 用户裁决）：去掉隐式优先级，下拉直接列出全部可播音频，
    //   所见即所得 —— 选中什么就播什么，试听也播所选的那条。
    //   值语义：''=默认（该事件的推荐音效）｜'__synth__'=合成音｜'builtin:…'=内置片段｜其它=我的片段
    var opts = '<option value=""' + (!selected ? ' selected' : '') + '>默认音效（推荐）</option>'
    opts += '<option value="__synth__"' + (selected === '__synth__' ? ' selected' : '') + '>内置合成音</option>'
    // 内置命名片段（来自桌宠音效系统；管理页独立于桌宠窗口，用静态路径清单兜底）
    var builtins = (window.__mioPetSound && window.__mioPetSound.builtinClips)
      ? window.__mioPetSound.builtinClips()
      : [
        { id: 'builtin:sounds/press.mp3', label: '小黄鸭 · 按压' },
        { id: 'builtin:sounds/release.mp3', label: '小黄鸭 · 松开' },
        { id: 'builtin:sounds/task-end.wav', label: 'Minecraft 经验球' },
        { id: 'builtin:sounds/ask.wav', label: '提问提示音' },
        { id: 'builtin:sounds/approval.wav', label: '授权提示音' },
      ]
    if (builtins.length) {
      opts += '<optgroup label="内置片段">'
      builtins.forEach(function (b) {
        opts += '<option value="' + b.id.replace(/"/g, '&quot;') + '"' + (b.id === selected ? ' selected' : '') + '>' + b.label + '</option>'
      })
      opts += '</optgroup>'
    }
    if (sounds.length) {
      opts += '<optgroup label="我的片段">'
      sounds.forEach(function (s) {
        opts += '<option value="' + s.name.replace(/"/g, '&quot;') + '"' + (s.name === selected ? ' selected' : '') + '>' + s.name + '</option>'
      })
      opts += '</optgroup>'
    }
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
          '<small style="font-size:12px;color:var(--muted,#687984);">' + ev.hint + '</small></div>' +
        '<select data-snd-clip="' + ev.id + '" style="min-height:26px;max-width:150px;border:1px solid #d5e0e3;border-radius:6px;font-size:12px;">' + clipOptions(clip) + '</select>' +
        '<input type="range" min="0" max="100" step="5" value="' + vol + '" data-snd-vol="' + ev.id + '" title="本事件音量" style="width:82px;" />' +
        '<span data-snd-vol-out="' + ev.id + '" style="flex:none;width:32px;font-size:12px;color:var(--muted,#687984);">' + vol + '%</span>' +
        '<button type="button" data-snd-play="' + ev.id + '" style="' + btnStyle() + '">试听</button>' +
      '</div>'
    }).join('')
    return card('音效事件',
      '<div style="display:flex;flex-direction:column;gap:7px;">' + rows + '</div>' +
      '<div style="margin-top:9px;font-size:12px;line-height:1.8;color:var(--muted,#687984);">' +
        '每行下拉直接选播什么：默认音效（推荐，内置片段）／内置合成音／内置片段（小黄鸭、Minecraft 经验球等）／我的片段。选中即所见，试听播的也是下拉当前选中的那条。<br />' +
        '总开关与基准音量在「设置 → 桌宠 → 音效」；本页音量是各事件相对基准的百分比。</div>')
  }

  function renderSoundClips() {
    var rows = sounds.map(function (s) {
      var active = trim && trim.name === s.name
      var row = '<div style="display:flex;align-items:center;gap:8px;padding:6px 9px;border:1px solid var(--line,#d9e2e6);border-radius:9px;background:var(--surface,#fff);">' +
        '<span style="flex:1;font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" title="' + s.name + '">' + s.name + '</span>' +
        '<span style="flex:none;font-size:12px;color:var(--muted,#687984);">' + (s.bytes / 1024).toFixed(1) + ' KB</span>' +
        '<button type="button" data-clip-play="' + encodeURIComponent(s.name) + '" style="' + btnStyle() + '">试听</button>' +
        '<button type="button" data-clip-trim="' + encodeURIComponent(s.name) + '" style="' + btnStyle('primary') + '">裁剪</button>' +
        '<button type="button" data-clip-del="' + encodeURIComponent(s.name) + '" style="' + btnStyle('danger') + '">删除</button>' +
      '</div>'
      if (active) {
        row += '<div style="margin:6px 0 2px;padding:9px;border:1px dashed ' + ACCENT + '66;border-radius:9px;background:' + ACCENT + '08;">' +
          '<canvas id="bpTrimCanvas" width="420" height="72" style="width:100%;max-width:420px;height:72px;background:#fff;border:1px solid var(--line,#d9e2e6);border-radius:6px;cursor:crosshair;"></canvas>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap;">' +
            '<span id="bpTrimRange" style="font-size:12px;color:var(--muted,#687984);">' + (trim.busy ? '解码中…' : '在波形上按住拖选要保留的区间') + '</span>' +
            '<button type="button" id="bpTrimPreview" style="' + btnStyle() + '">试听选区</button>' +
            '<button type="button" id="bpTrimSave" style="' + btnStyle('primary') + '">保存为片段</button>' +
            '<button type="button" id="bpTrimCancel" style="' + btnStyle() + '">取消</button>' +
          '</div></div>'
      }
      return row
    }).join('')
    var empty = sounds.length ? '' : '<div style="font-size:12px;color:var(--muted,#687984);padding:6px 2px;">还没有自定义片段——上传音频后可在上方事件表里替换任意事件音。</div>'
    return card('音效片段（' + sounds.length + ' 个）',
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">' +
        '<button type="button" id="bpSoundUploadBtn" style="' + btnStyle('primary') + '" title="支持：' + SOUND_EXTS.join(' / ') + '（≤' + SOUND_MAX_MB + 'MB）">上传音频</button>' +
        '<input type="file" id="bpSoundUploadFile" accept="' + SOUND_ACCEPT + '" multiple style="display:none;" />' +
      '</div>' +
      '<div style="margin-bottom:10px;padding:8px 10px;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:var(--surface-soft,#f2f6f7);font-size:12px;line-height:1.9;color:var(--muted,#687984);">' +
        '<b style="color:var(--ink,#20303a);">格式要求</b>：只支持浏览器能解码的音频 —— ' +
        SOUND_EXTS.join(' / ') + '，单个 ≤' + SOUND_MAX_MB + 'MB。<br />' +
        '• <b>推荐 WAV / MP3</b>（最稳，任何浏览器都能播）；OGG/Opus/FLAC 也支持。<br />' +
        '• <b>不支持</b> WMA / APE / AMR / AIFF / MIDI / 加密音乐平台下载的受保护格式（后缀对不上会被拒，后缀对得上但编码不支持会在试听/裁剪时报"无法解码"，请先转成 WAV 或 MP3）。<br />' +
        '• 建议做<b>短音效</b>：≤3 秒、单声道、22.05~44.1kHz 即可，体积小、触发延迟低。<br />' +
        '• 事件音默认用内置片段（小黄鸭 / Minecraft 经验球等），无需任何素材；下拉里选「内置合成音」可回到纯合成音。' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' + rows + empty + '</div>' +
      '<div style="margin-top:9px;font-size:12px;color:var(--muted,#687984);">「裁剪」在波形上拖选区间，保存为新片段（WAV），原片段保留。</div>')
  }

  // 卡片渲染表 + 分组（2026-10-19：设置页拆出「个性化」tab 后，本模块要能分两次渲染）
  //   appearance → 「设置 → 主题」：皮肤（气泡+横条）+ 全局主题
  //   behavior   → 「设置 → 个性化」：流式 / 点击互动 / 图片素材库 / 音效事件 / 音效片段
  // 只渲染当前这一组的原因：两个 tab 不会同时存在（renderBody 每次重建 #mioSetBody），
  // 没必要把另一组的 DOM 也塞进来再隐藏。绑定侧全是 querySelectorAll / 空值保护，
  // 少了元素不会抛错（已逐个核对过）。
  var CARD_RENDER = {
    appearance: renderAppearance,
    personalization: renderPersonalization,
    streamText: renderStreamText,
    clickTalk: renderClickTalk,
    images: renderImages,
    soundEvents: renderSoundEvents,
    soundClips: renderSoundClips,
  }
  var PART_CARDS = {
    appearance: ['appearance', 'personalization'],
    behavior: ['streamText', 'clickTalk', 'images', 'soundEvents', 'soundClips'],
  }
  var currentPart = 'all'

  var PART_INTRO = {
    appearance: '皮肤同时作用于<b style="color:var(--accent,#4c8798);">气泡与横条</b>；选「跟随主题」时调色板跟随全局 UI 主题。改动即时保存。',
    behavior: '所有改动<b style="color:var(--accent,#4c8798);">即时保存</b>并热应用到桌宠（无需重启）。' +
      '气泡 3 秒自动消失；点桌宠按「点击序列」推进（未配置则随机语句/图片）。',
    all: '所有改动<b style="color:var(--accent,#4c8798);">即时保存</b>并热应用到桌宠（无需重启）。',
  }

  function renderAll() {
    var body = $q('#bpBody', container)
    if (!body) return
    var keys = PART_CARDS[currentPart] || Object.keys(CARD_RENDER)
    var html = ''
    for (var i = 0; i < keys.length; i++) {
      var fn = CARD_RENDER[keys[i]]
      if (typeof fn === 'function') html += fn()
    }
    body.innerHTML = html
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
    // ★ 内置静态片段（'sounds/xxx' 相对路径）：指向桌宠 dist 的静态资源。
    //   管理页与桌宠页同源（都在后端 /agent-app/ 下），直接相对解析即可。
    if (name.indexOf('sounds/') === 0) return '/agent-app/live2d-pet/' + name
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
        saveSettings({ live2d_bubble_style: styleId }, '主题已切换（气泡与横条同时生效）').then(function () { refresh() })
      })
    })

    // ---- 话痨滑块/能力开关的绑定已移除 ----
    //   它们现在挂在「设置 → 个性化 → 活人感」（settings-panel-inject.js），
    //   沿用那一页的 collectValues + 保存按钮，PATCH 到同一批键（pet_talkativeness 等）。
    //   本页不再提供入口，避免同一设置两处可改、改一处漏另一处。

    // ---- 全局主题（与「设置 → 外观 → 主题」双向同步）----
    // 两处存储各管一层，缺一不可：
    //   ① 后端 ui_theme → 桌宠窗口的气泡/横条（"跟随主题"取色）；
    //   ② 本机 app preferences（localStorage）→ 主界面 Vue 的 .app-shell.theme-*。
    // storage 事件**同窗口不触发**，所以写完 localStorage 手动派发一次，
    // 让主界面即时换肤（不必再点"保存"，与面板"即时生效"的语义一致）。
    var applyGlobalTheme = function (themeId) {
      saveSettings({ ui_theme: themeId }, '全局主题：' + uiThemeName(themeId)).then(function () { refresh() })
      try {
        var raw = window.localStorage.getItem('mio_app_preferences')
        var prefs = raw ? JSON.parse(raw) : {}
        prefs.theme = themeId
        var next = JSON.stringify(prefs)
        window.localStorage.setItem('mio_app_preferences', next)
        window.dispatchEvent(new StorageEvent('storage', { key: 'mio_app_preferences', newValue: next }))
      } catch (_) {}
    }
    body.querySelectorAll('[data-ui-theme]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        uiThemeId = btn.getAttribute('data-ui-theme')
        applyGlobalTheme(uiThemeId)
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
        var msg = !cfg.clip ? '已设为默认音效'
          : (cfg.clip === '__synth__' ? '已设为内置合成音' : '已绑定：' + cfg.clip.replace(/^builtin:/, ''))
        saveSettings({ pet_sound_events: soundEvents }, msg)
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
        // ★ 所见即所得：试听播**下拉当前选中**的音频（未保存也照播），
        //   而不是已保存的 cfg——用户切到哪条听到哪条。
        var sel = $q('[data-snd-clip="' + id + '"]', body)
        var clip = sel ? String(sel.value || '') : ''
        previewEvent(id, clip)
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

  function previewEvent(id, clipOverride) {
    var ctx = auditContext()
    if (!ctx) return
    var cfg = soundEvents[id] || {}
    var vol = Number.isFinite(Number(cfg.volume)) ? Math.max(0, Math.min(1, Number(cfg.volume) / 100)) : 1
    // clipOverride = 下拉当前选中值（所见即所得）；未传则回退已保存值
    var clip = typeof clipOverride === 'string' ? clipOverride.trim()
      : (typeof cfg.clip === 'string' ? cfg.clip.trim() : '')
    if (clip === '__synth__') { builtinTone(ctx, id); return }
    if (clip.indexOf('builtin:') === 0) { previewClip(clip.slice(8), vol); return }
    if (!clip) {
      // 「默认音效」= 该事件的推荐内置片段；无对应素材（switch/error）→ 合成音
      var defaults = {
        press: 'sounds/press.mp3', release: 'sounds/release.mp3',
        task_end: 'sounds/task-end.wav', ask: 'sounds/ask.wav', approval: 'sounds/approval.wav',
      }
      var def = defaults[id]
      if (def) { previewClip(def, vol); return }
      builtinTone(ctx, id)
      return
    }
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
        // ★ 彩蛋图（hidden:true）只参与桌宠随机抽取，**不在素材库展示、也不可删除**。
        //   后端把彩蛋池与用户图池合并返回，这里过滤掉即可 —— 无需第二个接口。
        images = ((j && j.images) || []).filter(function (im) { return !(im && im.hidden) })
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
      // ★ 唯一真源 live2d_bubble_style；live2d_strip_style 只在"气泡还没选过"时做一次迁移
      styleId = String(st.live2d_bubble_style || 'default')
      if ((styleId === 'default' || !styleId) && st.live2d_strip_style && st.live2d_strip_style !== 'default') {
        styleId = String(st.live2d_strip_style)
      }
      uiThemeId = String(st.ui_theme || 'mist')
      clickTalk = st.pet_click_talk_enabled !== false
      streamText = st.live2d_stream_text_enabled !== false
      soundEvents = (st.pet_sound_events && typeof st.pet_sound_events === 'object') ? JSON.parse(JSON.stringify(st.pet_sound_events)) : {}
      imageWeights = (st.pet_image_weights && typeof st.pet_image_weights === 'object') ? JSON.parse(JSON.stringify(st.pet_image_weights)) : {}
      var cb = (st.pet_click_bubbles && typeof st.pet_click_bubbles === 'object') ? st.pet_click_bubbles : {}
      clickCfg = {
        first: String(cb.first || ''),
        queue: Array.isArray(cb.queue) ? cb.queue.map(function (x) { return String(x || '') }) : [],
      }
      // ★ 同 refreshImages：彩蛋图（hidden）不进素材库
      images = (((res[1] && res[1].images) || [])).filter(function (im) { return !(im && im.hidden) })
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

  // ---------- 入口：渲染进指定容器 ----------
  // 调用方：设置面板「主题」tab（part='appearance'）与「个性化」tab（part='behavior'）。
  // 不传 part 时渲染全部卡片（保留老行为，便于单独调试本模块）。

  function renderInto(host, part) {
    if (!host) return
    container = host
    currentPart = PART_CARDS[part] ? part : 'all'
    // 切换分组时清掉裁剪态：轮询遇到 trim.buffer 会整轮跳过刷新，
    // 而「音效片段」卡只在 behavior 组里 —— 带着残留的 trim 去「主题」tab，
    // 那一页会永远不刷新（看起来像卡死）。离开音效组就把状态丢掉。
    var cards = PART_CARDS[currentPart] || []
    if (currentPart !== 'all' && cards.indexOf('soundClips') < 0) trim = null
    stopPoll()
    // 注入一小段作用域限定的 CSS：内联样式写不了 :hover/:focus-visible，
    // 而"焦点看不见"是注入式面板最常见的可访问性缺口（impeccable 反模式之一）。
    // 选择器一律挂在 #bpBody 下，不外溢到宿主设置页。
    var scopedCss =
      '<style>' +
        '#bpBody button{transition:filter .15s ease, border-color .15s ease, box-shadow .15s ease;}' +
        '#bpBody button:hover{filter:brightness(.985);}' +
        '#bpBody button:focus-visible{outline:2px solid ' + ACCENT + ';outline-offset:2px;}' +
        '#bpBody input:focus-visible,#bpBody select:focus-visible,#bpBody textarea:focus-visible{outline:2px solid ' + ACCENT + ';outline-offset:2px;}' +
        '#bpBody input[type=range]{height:22px;}' +
        '#bpBody input[type=range]:focus-visible{outline-offset:4px;border-radius:6px;}' +
        '#bpBody input[type=checkbox]{width:15px;height:15px;accent-color:' + ACCENT + ';cursor:pointer;}' +
        '@media (prefers-reduced-motion: reduce){#bpBody *{transition:none !important;animation:none !important;}}' +
      '</style>'
    container.innerHTML =
      scopedCss +
      '<div style="flex:none;padding:11px 14px;font-size:12px;line-height:1.7;color:var(--muted,#687984);background:var(--surface-soft,#f2f6f7);border-radius:10px;margin-bottom:12px;">' +
        (PART_INTRO[currentPart] || PART_INTRO.all) +
      '</div>' +
      '<div id="bpBody" style="display:flex;flex-direction:column;gap:14px;"></div>'
    refresh(true)
    startPoll()
  }

  window.__mioBubblePanel = {
    renderInto: renderInto,
    refresh: refresh,
    destroy: stopPoll,
    // 「设置 → 个性化 → 活人感」复用同一套锚点/文案：
    // 曲线真源在 live2d-pet.js 的 TALK_ANCHORS，本文件是它的**面板侧镜像**，
    // 个性化页不再自己算一遍（否则三处各一套，滑块文案迟早和实际节奏对不上）。
    talkativeness: {
      numbers: talkativenessNumbers,
      label: talkativenessLabel,
      preview: talkativenessPreview,
      fmtRange: fmtRange,
    },
  }
})()
