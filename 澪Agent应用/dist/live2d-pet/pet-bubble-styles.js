/* pet-bubble-styles.js — 桌宠气泡 / 横条皮肤 + 全局主题联动的应用器
 *
 * 定位：**只负责"把皮肤套到元素上"**，不做任何 UI。
 * 选择/预览/持久化在管理页「设置 → 泡泡」（core-inject/bubble-panel-inject.js），
 * 走后端 settings.live2d_bubble_style（跨窗口同步：settings_changed → 热应用）。
 *
 * ★ 2026-10-19 三项合并：
 *   1. **气泡与横条共用同一套皮肤**：同一个 id、同一个 class（style-<id>），
 *      面板里只出现一次选择器（以前两处各列 8 款，"显示两遍"）。
 *   2. **跟随主界面主题**：新增 `theme` 皮肤，调色板由 ui_theme 推导
 *      （与主界面 .app-shell.theme-* 同一批色值），实现"气泡跟着整个 UI 走"。
 *   3. 新增 glass / neon / paper / ink 四款（纯 CSS 复刻，不引 WebGPU 依赖）。
 *
 * 机制：皮肤 = CSS 类（覆盖 --bubble-bg/border/ink/shadow 四个变量）；
 *       `theme` 例外——它把变量**内联**写到元素上，因为调色板是算出来的。
 *       切走时必须把内联变量清掉，否则会盖住下一个皮肤的 CSS 类。
 */
(function () {
  if (window.__mioPetBubbleStyles) return

  var FALLBACK_KEY = 'mio-pet-bubble-style'
  var FALLBACK_THEME_KEY = 'mio-pet-ui-theme'

  // 与管理页 bubble-panel-inject.js 的 STYLE_DEFS 保持一致（id/name/swatch/shape）
  // shape: 'bubble' 圆形色块示意 / 'strip' 圆角色块示意（仅影响面板预览观感）
  var STYLES = [
    { id: 'theme', name: '跟随主题', cls: 'style-theme', swatch: 'conic-gradient(#4c8798,#b7798f,#668978,#4c8798)', theme: true },
    { id: 'default', name: '默认白', cls: '', swatch: '#ffffff' },
    { id: 'mono', name: '墨黑', cls: 'style-mono', swatch: '#243036' },
    { id: 'navy', name: '靛蓝', cls: 'style-navy', swatch: '#4f6bed' },
    { id: 'peach', name: '蜜桃粉', cls: 'style-peach', swatch: '#f7b8c4' },
    { id: 'matcha', name: '抹茶绿', cls: 'style-matcha', swatch: '#9db87a' },
    { id: 'note', name: '便利贴', cls: 'style-note', swatch: '#ffe27a' },
    { id: 'terminal', name: '终端绿', cls: 'style-terminal', swatch: '#17301f' },
    { id: 'comic', name: '漫画描边', cls: 'style-comic', swatch: '#ffffff' },
    { id: 'glass', name: '磨砂玻璃', cls: 'style-glass', swatch: 'rgba(255,255,255,0.55)' },
    { id: 'aero', name: '透明玻璃', cls: 'style-aero', swatch: 'rgba(255,255,255,0.26)' },
    { id: 'neon', name: '霓虹', cls: 'style-neon', swatch: '#0b1220' },
    { id: 'paper', name: '纸墨', cls: 'style-paper', swatch: '#f7f0df' },
    { id: 'ink', name: '夜墨', cls: 'style-ink', swatch: '#14161a' },
  ]

  // 主界面主题调色板（必须与 src/styles/companion.css 的 .app-shell.theme-* 同值）。
  // 用途：皮肤选 `theme` 时，用它推导气泡/横条的四个调色板变量。
  var UI_THEMES = {
    mist: { bg: '#e9eef0', ink: '#20303a', line: '#d9e2e6', accent: '#4c8798' },
    clear: { bg: '#f0f4f4', ink: '#26363d', line: '#dce5e7', accent: '#5b8c98' },
    rose: { bg: '#f0eaed', ink: '#2d282c', line: '#e5dce1', accent: '#9a6f78' },
    forest: { bg: '#edf1ed', ink: '#293a34', line: '#d9e2dc', accent: '#668978' },
    sakura: { bg: '#f3eef1', ink: '#38323a', line: '#e5dce2', accent: '#b7798f' },
    celadon: { bg: '#e9f0ee', ink: '#22322e', line: '#d5e2dd', accent: '#5f8f80' },
    amber: { bg: '#f3ede2', ink: '#3a3128', line: '#e4dbcb', accent: '#a8763c' },
    // ★ 2026-10-19 AI 娘配色五款 + 自定义（与 App.vue THEME_OPTIONS / companion.css 同值）
    whale: { bg: '#e9eef8', ink: '#1d2b45', line: '#d7e0f0', accent: '#3f6ac4' },
    miku: { bg: '#ecf7f5', ink: '#1f3a37', line: '#d2e8e4', accent: '#2fbdb3' },
    neuro: { bg: '#fdf0f6', ink: '#3d2a34', line: '#f2dce6', accent: '#e8659b' },
    qwen: { bg: '#f1eefa', ink: '#2b2740', line: '#e2dcf4', accent: '#7a5af5' },
    doubao: { bg: '#eef4fd', ink: '#1f2c48', line: '#d9e4f6', accent: '#4d6bfe' },
    // custom 的真色值由 setUiTheme(id, palette) 第三参动态合并进来；
    // 下面是"还没推过自定义色"时的中性兜底。
    custom: { bg: '#e9eef0', ink: '#20303a', line: '#d9e2e6', accent: '#4c8798' },
  }
  var DEFAULT_THEME = 'mist'

  var currentId = 'default'
  var uiThemeId = DEFAULT_THEME

  function styleOf(id) {
    var wanted = String(id || '').trim()
    var found = null
    STYLES.forEach(function (s) { if (s.id === wanted) found = s })
    return found || STYLES[1] // 兜底 default（STYLES[0] 是 theme）
  }

  function current() {
    return styleOf(currentId)
  }

  function themePalette() {
    return UI_THEMES[uiThemeId] || UI_THEMES[DEFAULT_THEME]
  }

  // 只清"我们自己的"类与内联变量，绝不动 agent-accent 等外部状态
  function clear(el) {
    if (!el) return
    STYLES.forEach(function (s) {
      if (s.cls) el.classList.remove(s.cls)
    })
    ;['--bubble-bg', '--bubble-border', '--bubble-ink', '--bubble-shadow'].forEach(function (name) {
      el.style.removeProperty(name)
    })
  }

  /**
   * 把指定皮肤套到元素上（气泡与横条共用）。
   * @param {HTMLElement} el
   * @param {string} [id] 不传则用当前皮肤
   * @returns {string} 实际生效的皮肤 id
   */
  function applyTo(el, id) {
    var target = styleOf(id === undefined ? currentId : id)
    if (!el) return target.id
    clear(el)
    if (target.theme) {
      // 跟随主题：调色板 = 主界面 accent + ink 推导，内联写入
      var t = themePalette()
      el.style.setProperty('--bubble-bg', 'color-mix(in srgb, ' + t.accent + ' 8%, rgb(255 255 255 / 96%))')
      el.style.setProperty('--bubble-border', 'color-mix(in srgb, ' + t.accent + ' 42%, transparent)')
      el.style.setProperty('--bubble-ink', t.ink)
      el.style.setProperty('--bubble-shadow', '0 8px 24px rgb(24 43 50 / 16%), 0 0 0 2px color-mix(in srgb, ' + t.accent + ' 10%, transparent)')
      el.classList.add('style-theme')
      el.setAttribute('data-bubble-theme', uiThemeId)
    } else {
      el.removeAttribute('data-bubble-theme')
      if (target.cls) el.classList.add(target.cls)
    }
    return target.id
  }

  /** 老接口：套到气泡元素（keep-alive，外部只传 el） */
  function apply(targetEl) {
    return applyTo(targetEl, currentId)
  }

  /** 切换皮肤并落 localStorage 兜底；applyEl 可传单个元素或数组 */
  function setStyle(id, applyEl) {
    currentId = styleOf(String(id || '').trim()).id
    try { window.localStorage.setItem(FALLBACK_KEY, currentId) } catch (_) {}
    if (applyEl) {
      var list = Array.isArray(applyEl) ? applyEl : [applyEl]
      list.forEach(function (el) { applyTo(el, currentId) })
    }
    return currentId
  }

  /** 切换"跟随的主界面主题"（只影响 theme 皮肤的配色） */
  function setUiTheme(themeId, applyEl, palette) {
    var wanted = String(themeId || '').trim().toLowerCase()
    // 自定义主题：三色（bg/ink/line/accent，缺 line 用 bg 混出的近似）动态并入调色板。
    // 老调用只传两个参 → 不影响；颜色非法时保留现有值（含上次推过的自定义色）。
    if (palette && typeof palette === 'object') {
      var hex = function (v, fallback) {
        var s = String(v || '').trim()
        return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback
      }
      var cur = UI_THEMES.custom
      var bg = hex(palette.bg, cur.bg)
      var ink = hex(palette.ink, cur.ink)
      var accent = hex(palette.accent, cur.accent)
      UI_THEMES.custom = {
        bg: bg,
        ink: ink,
        line: hex(palette.line, bg),
        accent: accent,
      }
    }
    uiThemeId = UI_THEMES[wanted] ? wanted : DEFAULT_THEME
    try { window.localStorage.setItem(FALLBACK_THEME_KEY, uiThemeId) } catch (_) {}
    if (applyEl && currentId === 'theme') {
      var list = Array.isArray(applyEl) ? applyEl : [applyEl]
      list.forEach(function (el) { applyTo(el, 'theme') })
    }
    return uiThemeId
  }

  try {
    var saved = window.localStorage.getItem(FALLBACK_KEY)
    if (saved && STYLES.some(function (s) { return s.id === saved })) currentId = saved
    var savedTheme = window.localStorage.getItem(FALLBACK_THEME_KEY)
    if (savedTheme && UI_THEMES[savedTheme]) uiThemeId = savedTheme
  } catch (_) {}

  window.__mioPetBubbleStyles = {
    STYLES: STYLES,
    UI_THEMES: UI_THEMES,
    current: current,
    currentId: function () { return currentId },
    uiThemeId: function () { return uiThemeId },
    apply: apply,
    applyTo: applyTo,
    setStyle: setStyle,
    setUiTheme: setUiTheme,
  }
})()
