/* market-panel.js — 插件市场面板（设置页 tab + 左侧「插件市场」功能页）
 * ════════════════════════════════════════════════════════════════════════════
 * 契约：docs/插件市场-契约.md §2（HTTP）/ §3.3（启用态真值）/ §5（市场 UI）
 * 规则：docs/SKILL-插件开发规则.md 的 R1~R9（本文件逐条对照见下）
 *
 * ── 数据来源（R2：只调自己的接口，绝不读别的插件的 API）─────────────────────
 *   GET    /api/plugin/market/catalog              全量清单 + 每条实时状态（唯一数据源）
 *   POST   /api/plugin/market/plugins              上架
 *   POST   /api/plugin/market/plugins/{id}/enable  启用 / 停用
 *   DELETE /api/plugin/market/plugins/{id}         下架（只删清单条目，不动磁盘）
 *   POST   /api/plugin/market/reload               重新扫描（丢后端缓存重读盘）
 *   GET    /api/plugin/market/diagnostics          清单健康度
 *   全部请求收口在 fetchAll() / callApi() 两个函数里 —— 方便打桩单测（见文件末尾注释）。
 *
 * ── 设计取舍（为什么这么做）────────────────────────────────────────────────
 * 1. **状态只有一个来源**：卡片上的「已启用/已停用」一律读 catalog 里的 `enabled`，
 *    而 catalog 的 enabled 已经按契约 §3.3 归一过了（builtin 恒 true；占总线的看总线；
 *    纯 UI 插件看清单）。前端**不自己再算一遍**，也不去读 /api/companion/agents，
 *    否则两套口径迟早打架（踩过：总线未注册时每个插件都判"停用"）。
 * 2. **卡片不显示"目录名"**：清单里 feiyu 的 agentId 是 cloud_feiyu，目录名是 plugins/feiyu/。
 *    界面上所有 id 一律来自 catalog，代码里没有任何 agentId 字面量。
 * 3. **操作后必须重扫前端**：上架/下架/启停改的是**后端清单**，而界面上插件的
 *    <script> 是 loader 之前注入的。不调 reload() 就会"清单变了、界面没变"（契约 §3.1）。
 *    再补一次 __mioPluginNav.refresh()：nav 的显隐虽然由 /agents 驱动，但插件 tab
 *    的新增/移除是 loader 通知 nav 的，双保险让左侧与 tab 同步收回。
 * 4. **导航按钮用 MutationObserver + 2.5s 轮询自愈（R4）**：Vue 重渲染 nav 会整批重建
 *    children，外部 append 的按钮会**永久消失**（dsh-panel.js 实测踩过）。
 *    本文件给按钮打 data-mio-plugin-nav="market"，loader 卸载时按它精确摘除。
 * 5. **不加「保存」按钮**：设置页底部已有统一保存条，这里所有操作都是即时提交
 *    （点按钮 = 发请求 = 立即生效），不存在"待保存的草稿"。
 * 6. **样式只走 CSS 变量**（--ink / --muted / --line / --accent / --surface-soft），
 *    不写死背景色；唯一写死的颜色是**语义色**（成功绿 / 危险红 / 告警黄），
 *    它们表达的是"状态"而不是"主题"，与主题换色无关。
 *
 * ── 本文件不 import 任何东西、不引用其它插件的全局变量 ─────────────────────
 * 只碰三个**内核级**约定：window['market-panel']（R7 导出名）、
 * __mioPluginLoader（重扫）、__mioPluginNav（刷新 tab/nav）。后两个都是"有就用、没有就跳过"。
 * ════════════════════════════════════════════════════════════════════════════
 */
(function () {
  if (window.__mioMarketPanelLoaded) return
  window.__mioMarketPanelLoaded = true

  // ★ 强调色跟随主题（--accent），不写死紫色：写死会与 rose/mist 等主题撞色。
  //   紫色真正该出现的地方是气泡身份色（manifest.bubble.accent），与设置页主题色是两回事。
  var ACCENT = 'var(--accent, #8B5CF6)'
  var AGENT_ID = 'market'

  var API = '/api/plugin/market'
  var CATALOG_URL = API + '/catalog'
  var NAV_MARK = 'market'          // data-mio-plugin-nav 的值（loader 按它摘按钮）
  var NAV_LABEL = '插件市场'
  var ID_RE = /^[a-z0-9_-]{1,32}$/  // 契约 §1：agentId 格式（与后端 AGENT_ID_RE 同一条）
  var REL_START = 'plugins/'        // 契约 §1：entry/panel 必须落在 dist/plugins/ 内
  var CATEGORIES = ['agent', 'ui', 'pet', 'tool', 'other']
  var CATEGORY_LABEL = { agent: 'Agent', ui: '界面', pet: '桌宠', tool: '工具', other: '其他' }
  var PROBLEM_LABEL = {
    missing_entry: '入口脚本缺失',
    missing_panel: '面板脚本缺失',
    path_escape: '路径越界',
    duplicate_id: 'id 重名',
    not_registered: '总线未注册',
  }
  var SEMANTIC = { ok: '#2e9e5b', warn: '#d09b2c', danger: '#c0392b', idle: '#8a97a0' }

  // 面板级缓存：跨 renderInto 保留（切走再切回不必重新等网络）
  var cache = { plugins: null, diag: null, at: 0 }
  // 视图状态：搜索词 / 分类筛选 / 上架表单展开与否 / 表单里已填的值
  var view = { q: '', cat: 'all', formOpen: false, form: {} }
  var lastError = ''

  // ── DOM 小工具（与 pet-panel.js / dsh-panel.js 同一套写法，ES5 风格）────────
  function $q(sel, root) { return (root || document).querySelector(sel) }

  function el(tag, css, html) {
    var n = document.createElement(tag)
    if (css) n.style.cssText = css
    if (html != null) n.innerHTML = html   // 只用于**本文件自己拼的**常量/转义后文本
    return n
  }

  /** HTML 转义。★ 所有来自后端的数据（name/description/author…）都必须过这里：
   *  清单 JSON 是用户可编辑的文件，description 里写一段 <script> 就能打到管理窗里。
   *  注入脚本的那条路（plugin-loader 插 <script>）是契约授权的；
   *  但"一个文本框把清单内容当 HTML 渲染"不是，必须堵死。 */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  var C = {
    // 卡片网格：auto-fill + minmax，窄窗口自动换行，宽窗口一行多张
    grid: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:10px;',
    card: 'border:1px solid var(--line,#d9e2e6);border-radius:10px;background:var(--surface-soft,#f2f6f7);' +
          'padding:12px 12px 10px;display:flex;flex-direction:column;gap:8px;min-width:0;',
    title: 'font-size:13px;font-weight:600;color:var(--ink,#20303a);',
    desc: 'font-size:11px;color:var(--muted,#687984);line-height:1.6;',
    section: 'font-size:12px;font-weight:600;color:var(--muted,#687984);margin:16px 0 8px;display:flex;align-items:center;gap:6px;',
    input: 'border:1px solid var(--line,#d9e2e6);border-radius:8px;background:#fff;color:var(--ink,#20303a);' +
           'font-size:12px;padding:5px 9px;box-sizing:border-box;',
    btn: 'flex:none;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:#fff;color:var(--ink,#20303a);' +
         'font-size:12px;padding:4px 10px;cursor:pointer;white-space:nowrap;',
    btnPrimary: 'flex:none;border:1px solid var(--accent,#8B5CF6);border-radius:8px;background:var(--accent,#8B5CF6);' +
                'color:#fff;font-size:12px;padding:4px 12px;cursor:pointer;font-weight:600;white-space:nowrap;',
    btnDanger: 'flex:none;border:1px solid #e6c3c3;border-radius:8px;background:transparent;color:#c0392b;' +
               'font-size:12px;padding:4px 10px;cursor:pointer;white-space:nowrap;',
    btnDisabled: 'flex:none;border:1px solid var(--line,#d9e2e6);border-radius:8px;background:transparent;' +
                 'color:var(--muted,#687984);font-size:12px;padding:4px 10px;cursor:not-allowed;opacity:.6;white-space:nowrap;',
    badge: 'display:inline-block;font-size:10px;line-height:16px;border-radius:8px;padding:0 7px;border:1px solid transparent;white-space:nowrap;',
    label: 'font-size:11px;color:var(--muted,#687984);margin-bottom:3px;display:block;',
    msg: 'font-size:11px;line-height:1.6;min-height:16px;margin:8px 2px 0;',
  }

  function section(t) {
    var s = el('div', C.section)
    s.appendChild(el('span', 'width:4px;height:12px;border-radius:2px;background:' + ACCENT + ';'))
    s.appendChild(document.createTextNode(t))
    return s
  }

  /** 语义角标：颜色表达状态，不表达主题（所以这里可以写死色值）。 */
  function badge(text, color, title) {
    var b = el('span', C.badge + 'color:' + color + ';border-color:' + color + '55;background:' + color + '14;')
    b.textContent = text
    if (title) b.title = title
    return b
  }

  // ── 网络层（R2：全部收口在这里）────────────────────────────────────────────
  /** 统一请求：成功返回 JSON，失败抛出**带 detail 的** Error。
   *  后端把领域异常翻译成 {"detail": "人话"}（含具体路径），契约要求原样回显 ——
   *  所以这里把 detail 原样塞进 err.detail / err.message，UI 直接显示它，
   *  不要自己再拼一句"操作失败"，否则真正的线索（哪个字段、哪个路径）就没了。 */
  function callApi(method, url, body, wantJson) {
    var opt = {
      method: method,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      cache: 'no-store',
    }
    if (body !== undefined && body !== null) opt.body = JSON.stringify(body)
    else if (method !== 'GET') opt.body = '{}'   // 有些端点要 body 才过 FastAPI 校验
    return fetch(url, opt).then(function (r) {
      var ct = String((r.headers && r.headers.get && r.headers.get('Content-Type')) || '')
      var parse = wantJson === false || ct.indexOf('json') < 0
        ? Promise.resolve(null)
        : r.json().catch(function () { return null })
      return parse.then(function (j) {
        if (!r.ok) {
          var detail = j && (j.detail || j.error || j.note)
          if (detail && typeof detail !== 'string') {
            // FastAPI 的 422（缺 body）detail 是个数组，摊平成一行给人看
            try { detail = JSON.stringify(detail) } catch (e) { detail = String(detail) }
          }
          var err = new Error(detail ? String(detail) : ('HTTP ' + r.status))
          err.status = r.status
          err.detail = detail ? String(detail) : ''
          throw err
        }
        return j
      })
    })
  }

  /** 单函数取全部数据 —— 面板的重渲染只依赖它，打桩也只需要打这一个。
   *  两个请求并行、**互不拖累**：诊断端点挂了也照样能把卡片画出来（诊断只是补充信息）。 */
  function fetchAll() {
    var catalogJob = callApi('GET', CATALOG_URL).then(function (j) {
      var list = j && j.plugins
      if (!list || typeof list.length !== 'number') throw new Error('清单响应里没有 plugins 数组')
      return list
    })
    var diagJob = callApi('GET', API + '/diagnostics')
      .catch(function (e) {
        // 后端自己对诊断失败也返回 200 + ok:false；走到这里说明是网络/500，
        // 不该让整个面板变空，降级成"诊断不可用"。
        return { ok: false, checks: [], error: (e && e.message) || String(e) }
      })
    return Promise.all([catalogJob, diagJob]).then(function (res) {
      cache.plugins = res[0]
      cache.diag = res[1]
      cache.at = Date.now()
      return { plugins: res[0], diag: res[1] }
    })
  }

  // ── 内核联动（有就用、没有就静默 —— 不用可选链，老注入层环境更保险）──────
  function loaderObj() {
    var l = window.__mioPluginLoader
    return l && typeof l.reload === 'function' ? l : null
  }
  function navObj() {
    var n = window.__mioPluginNav
    return n && typeof n.refresh === 'function' ? n : null
  }

  /** 操作成功后的"让界面真的跟上"（契约 §3.1 热插拔落点）。
   *  顺序是刻意的：先 reload（重新插/拔 <script>、卸载残留），再 refresh 导航 ——
   *  反过来的话 nav 会拿着旧 manifest 重算一遍，用户会看到 tab 闪一下又回来。 */
  function rescanFrontend() {
    var l = loaderObj()
    var p = l ? Promise.resolve(l.reload()).catch(function (e) {
      // reload 失败不该吞掉操作本身的结果：清单已经改了，只是界面没重扫，
      // 让用户知道"需要手动刷新页面"比假装成功好。
      return { ok: false, error: (e && e.message) || String(e) }
    }) : Promise.resolve({ ok: false, error: 'loader 未就绪' })
    return p.then(function (out) {
      var n = navObj()
      if (n) { try { n.refresh() } catch (e) { /* 忽略：nav 自己 8s 轮询兜底 */ } }
      return out
    })
  }

  // ── 校验（前端先跑一遍，后端仍是唯一裁判）──────────────────────────────────
  function relPathError(rel, field, optional) {
    var s = String(rel || '').trim()
    // panel 是**可选**字段（契约 §1："缺省不加载"）：留空 = 这个插件没有自己的面板脚本，
    // 不是错误。只有填了才校验路径形态（填了空还当错，会让"只提供左侧页、不做设置页"
    // 的插件永远上架不了）。
    if (!s) return optional ? '' : field + ' 不能为空'
    if (s.indexOf('\\') >= 0) return field + ' 请用 / 分隔路径'
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) || s.indexOf('//') === 0) return field + ' 必须是相对路径，不接受 URL'
    if (s.charAt(0) === '/') return field + ' 必须是相对路径（不要以 / 开头）'
    var parts = s.split('/')
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..') return field + ' 不允许出现 ..'
    }
    if (s.replace(/^\.\//, '').indexOf(REL_START) !== 0) return field + ' 必须以 ' + REL_START + ' 开头'
    return ''
  }

  /** @returns {{ok:boolean, errors:string[], body:object|null}} */
  function validateForm(f) {
    var errors = []
    var id = String(f.agentId || '').trim()
    if (!id) errors.push('agentId 必须填（它要等于后端的 agent_id，写错插件会永远显示不出来）')
    else if (!ID_RE.test(id)) errors.push('agentId 不合法：' + id + '（只允许小写字母/数字/_/-，1~32 位）')
    var entryErr = relPathError(f.entry, 'entry')
    if (entryErr) errors.push(entryErr)
    var panelErr = relPathError(f.panel, 'panel', true)
    if (panelErr) errors.push(panelErr)
    if (String(f.name || '').length > 40) errors.push('name 超过 40 字上限')
    if (String(f.description || '').length > 200) errors.push('description 超过 200 字上限')
    var accent = String(f.accent || '').trim()
    if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) errors.push('accent 必须是 #RRGGBB 形式')
    if (f.category && CATEGORIES.indexOf(String(f.category)) < 0) errors.push('category 只能是 ' + CATEGORIES.join('/'))
    if (errors.length) return { ok: false, errors: errors, body: null }
    // 可选字段留空时**不提交**：空串会被后端 _clean_text 回落成默认值，
    // 但把 accent 传空串会覆盖掉旧值（PATCH 语义），上架时也拿不到界面上那个默认圆点色。
    var body = { agentId: id, entry: String(f.entry || '').trim() }
    var optional = ['name', 'panel', 'version', 'author', 'accent', 'description']
    for (var i = 0; i < optional.length; i++) {
      var v = String(f[optional[i]] || '').trim()
      if (v) body[optional[i]] = v
    }
    body.category = String(f.category || 'other')
    return { ok: true, errors: [], body: body }
  }

  /** 由 agentId 猜一个插件目录（只用来**预填** entry/panel，用户可以改）。
   *  猜法是 plugins/<最后一段>/manifest.js —— 对 dsh/pet/market 都成立，
   *  对 cloud_feiyu（目录 feiyu）不成立，所以这只是便利，绝不是规则。 */
  function guessDir(id) {
    var s = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
    return s ? 'plugins/' + s + '/' : ''
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  /** 状态判定：**全部基于 catalog 的归一化字段**，不在前端重算真值（契约 §3.3）。
   *  ★ 是否"异常"只认后端 health.ok，不认 problems 非空（理由见 isBroken 的注释：
   *    not_registered 是总线未就绪的观测，不拦加载、也不该染红卡片）。 */
  function stateOf(p) {
    if (p.builtin === true) return { key: 'builtin', label: '内置', color: SEMANTIC.idle, title: '宿主本体：恒可见，不可停用、不可下架' }
    if (isBroken(p)) {
      var problems = (p.health && p.health.problems) || []
      var names = []
      for (var i = 0; i < problems.length; i++) names.push(PROBLEM_LABEL[problems[i]] || problems[i])
      return { key: 'error', label: '异常', color: SEMANTIC.danger, title: names.length ? names.join(' / ') : '清单条目有问题' }
    }
    if (p.enabled === true) return { key: 'on', label: '已启用', color: SEMANTIC.ok, title: '点击「停用」后左侧入口与设置 tab 立即收回' }
    return { key: 'off', label: '已停用', color: SEMANTIC.warn, title: '点击「启用」后立即加载' }
  }

  /** 只有"真问题"才把卡片标成异常 —— 与后端 health.ok 的口径严格对齐。
   *  ★ 为什么单独挑出 not_registered（2026-10-25 harness 抓到的真实误判）：
   *    后端 _health() 明确把它排除在 health.ok 之外，理由写在 service 里 ——
   *    总线注册是适配器 **import 的副作用**，任何不跑 main() 的入口（自检、探针、
   *    进程刚起来的那一小段）看到的都是一张空总线，于是**每个插件**都报 not_registered。
   *    如果前端只看 problems 非空就标红，打开市场会看到"满屏异常"：这不是故障，
   *    是总线还没就绪。所以这里按 health.ok 判"异常"，not_registered 降级成一条提示。 */
  function isBroken(p) { return !!p && p.builtin !== true && !!p.health && p.health.ok === false }

  function accentDot(accent) {
    // 强调色来自清单（后端只接受 #RRGGBB），缺失时退回主题色 —— 圆点表达"身份"，不是主题
    var c = /^#[0-9a-fA-F]{6}$/.test(String(accent || '')) ? accent : ACCENT
    return el('span', 'flex:none;width:10px;height:10px;border-radius:50%;background:' + c + ';' +
      'box-shadow:0 0 0 3px ' + (String(accent || '').indexOf('#') === 0 ? accent + '22' : 'transparent') + ';')
  }

  function filterList(list) {
    var out = []
    var q = String(view.q || '').trim().toLowerCase()
    for (var i = 0; i < list.length; i++) {
      var p = list[i]
      if (view.cat !== 'all') {
        var cat = String(p.category || 'other')
        if (view.cat === 'error') {
          // 「仅看异常」与卡片角标同一口径：只认结构性缺陷（health.ok === false），
          // 不把"总线未注册"这种提示也算成异常。
          if (!isBroken(p)) continue
        } else if (cat !== view.cat) continue
      }
      if (q) {
        var hay = [p.agentId, p.name, p.description, p.author, p.category, p.entry].join(' ').toLowerCase()
        if (hay.indexOf(q) < 0) continue
      }
      out.push(p)
    }
    return out
  }

  /**
   * 主渲染。三次调用约定（只为"操作后局部刷新"时能保住滚动位置）：
   *   renderInto(host)                  —— 全量（先清空 host）
   *   renderInto(host, {keepScroll:1})  —— 全量但保留 host 的滚动位置（操作成功后用）
   *   renderInto(host, {reuse:true})    —— 只重画卡片网格与工具条上的计数（筛选/搜索时用）
   */
  function renderInto(host, opt) {
    if (!host) return
    opt = opt || {}

    // R6 幂等：每次先清空（局部刷新除外 —— 那时要复用已有节点以保住输入框焦点）
    if (!opt.reuse) {
      var scrollTop = opt.keepScroll ? host.scrollTop : 0
      host.innerHTML = ''
      var wrap = el('div', 'padding:2px 2px 20px;')
      wrap.setAttribute('data-mio-market', AGENT_ID)
      host.appendChild(wrap)          // ★ 必须真的挂进 host：游离节点 = 点了 tab 一片空白
      buildShell(wrap)
      if (opt.keepScroll) { try { host.scrollTop = scrollTop } catch (e) { /* ignore */ } }
      // 操作结果由调用方带过来（重画会清空状态行，见 doToggle 的注释）
      if (opt.msg) setMsg(wrap, opt.msg, opt.tone)
    } else {
      var w = $q('[data-mio-market="' + AGENT_ID + '"]', host)
      if (!w) { renderInto(host); return }
      paintCards(w)
      paintDiag(w)
      return
    }
    refreshData(host)
  }

  /** 搭骨架：工具条 / 卡片区 / 上架表单 / 诊断。骨架只搭一次，数据回来只重画卡片区。 */
  function buildShell(wrap) {
    // 顶部说明（与 pet-panel 同样的位置与字号，视觉一致）
    wrap.appendChild(el('div', 'font-size:11px;color:var(--muted,#687984);margin:2px 2px 10px;line-height:1.7;',
      '这里管理「插件」本身：启用/停用、上架/下架、重新扫描。改动只动清单，' +
      '不删 dist/plugins/ 里的任何文件 —— 下架后随时可以再上架回来。'))

    // ── 工具条 ──────────────────────────────────────────────────────────────
    var bar = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;')
    var search = document.createElement('input')
    search.type = 'search'
    search.placeholder = '搜索名称 / id / 说明…'
    search.value = view.q
    search.style.cssText = C.input + 'flex:1 1 180px;min-width:140px;'
    search.setAttribute('data-mio-market-q', '1')
    search.addEventListener('input', function () {
      view.q = search.value
      rerenderList(wrap)
    })

    var cat = document.createElement('select')
    cat.style.cssText = C.input + 'flex:none;'
    cat.setAttribute('data-mio-market-cat', '1')
    var catOpts = [{ v: 'all', t: '全部分类' }]
    for (var i = 0; i < CATEGORIES.length; i++) catOpts.push({ v: CATEGORIES[i], t: CATEGORY_LABEL[CATEGORIES[i]] })
    catOpts.push({ v: 'error', t: '仅看异常' })
    for (var j = 0; j < catOpts.length; j++) {
      var op = document.createElement('option')
      op.value = catOpts[j].v
      op.textContent = catOpts[j].t
      if (catOpts[j].v === view.cat) op.selected = true
      cat.appendChild(op)
    }
    cat.addEventListener('change', function () {
      view.cat = cat.value
      rerenderList(wrap)
    })

    var btnAdd = el('button', C.btnPrimary, '＋ 上架插件')
    btnAdd.type = 'button'
    btnAdd.setAttribute('data-mio-market-add', '1')
    btnAdd.addEventListener('click', function () { toggleForm(wrap, !view.formOpen) })

    var btnScan = el('button', C.btn, '⟳ 重新扫描')
    btnScan.type = 'button'
    btnScan.setAttribute('data-mio-market-scan', '1')
    btnScan.title = '让后端丢掉清单缓存重新读盘，再让前端重新注入插件脚本'
    btnScan.addEventListener('click', function () { manualRescan(wrap, btnScan) })

    bar.appendChild(search)
    bar.appendChild(cat)
    bar.appendChild(btnAdd)
    bar.appendChild(btnScan)
    wrap.appendChild(bar)

    // 操作结果 / 错误提示条（成功绿、失败红；后端 detail 原样显示）
    var msg = el('div', C.msg)
    msg.setAttribute('data-mio-market-msg', '1')
    wrap.appendChild(msg)

    // ── 卡片区 ──────────────────────────────────────────────────────────────
    wrap.appendChild(el('div', 'font-size:11px;color:var(--muted,#687984);margin:4px 2px 8px;', '')
      ).setAttribute('data-mio-market-count', '1')
    var grid = el('div', C.grid)
    grid.setAttribute('data-mio-market-grid', '1')
    grid.appendChild(el('div', C.desc, '正在读取插件清单…'))
    wrap.appendChild(grid)

    // ── 上架表单（可折叠；默认收起 —— 绝大多数时间用户只是来看状态的）────────
    wrap.appendChild(buildForm(wrap))

    // ── 诊断 ────────────────────────────────────────────────────────────────
    var diag = el('div', '')
    diag.setAttribute('data-mio-market-diag', '1')
    wrap.appendChild(diag)
    wrap.appendChild(el('div', 'font-size:10px;color:var(--muted,#687984);margin-top:14px;line-height:1.7;',
      '数据：GET /api/plugin/market/catalog（启停真值以后端归一化结果为准）。' +
      '本面板只调 /api/plugin/market/*，不读取其它插件的接口。'))

    // 首次渲染时上架表单是收着的（除非上次是打开的）
    toggleForm(wrap, view.formOpen)
  }

  function rerenderList(wrap) {
    paintCards(wrap)
    // 搜索/筛选只是本地过滤，不需要重新请求
  }

  // ── 卡片 ──────────────────────────────────────────────────────────────────
  function paintCards(wrap) {
    var grid = $q('[data-mio-market-grid]', wrap)
    if (!grid) return
    grid.innerHTML = ''
    var list = cache.plugins
    if (!list) {
      grid.appendChild(el('div', C.desc, '正在读取插件清单…'))
      return
    }
    var shown = filterList(list)
    var count = $q('[data-mio-market-count]', wrap)
    if (count) {
      var msg = '共 ' + list.length + ' 个插件'
      if (shown.length !== list.length) msg += '，当前筛选出 ' + shown.length + ' 个'
      count.textContent = msg
    }
    if (!shown.length) {
      var empty = el('div', C.desc)
      empty.style.cssText = C.desc + 'padding:18px 4px;'
      empty.textContent = list.length
        ? '没有匹配的插件（换个搜索词，或把分类切回「全部分类」）。'
        : '清单是空的。点「＋ 上架插件」把 dist/plugins/ 里已有的插件登记进来。'
      grid.appendChild(empty)
      return
    }
    for (var i = 0; i < shown.length; i++) grid.appendChild(buildCard(wrap, shown[i]))
  }

  function buildCard(wrap, p) {
    var st = stateOf(p)
    var card = el('div', C.card)
    card.setAttribute('data-mio-market-card', String(p.agentId || ''))

    // ① 头部：强调色圆点 + 名称 + 版本/作者 + 状态角标
    var head = el('div', 'display:flex;align-items:center;gap:7px;min-width:0;')
    head.appendChild(accentDot(p.accent))
    var nameBox = el('div', 'flex:1;min-width:0;')
    var nameRow = el('div', 'display:flex;align-items:center;gap:6px;min-width:0;')
    var nm = el('span', C.title, esc(p.name || p.agentId))
    nm.style.cssText = C.title + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    nm.title = String(p.name || '')
    nameRow.appendChild(nm)
    nameRow.appendChild(badge(st.label, st.color, st.title))
    nameBox.appendChild(nameRow)
    var sub = 'v' + esc(p.version || '1.0.0') + ' · ' + esc(p.author || 'Mio') + ' · ' + esc(CATEGORY_LABEL[p.category] || p.category || '其他')
    nameBox.appendChild(el('div', C.desc, sub))
    head.appendChild(nameBox)
    card.appendChild(head)

    // ② agentId（等宽字体，强调"这是主键，不是显示名"）
    var idRow = el('div', 'font-size:10px;color:var(--muted,#687984);font-family:Consolas,monospace;word-break:break-all;',
      esc(p.agentId))
    idRow.title = 'agentId（清单主键，必须等于后端 agent_id）'
    card.appendChild(idRow)

    // ③ 描述
    if (p.description) {
      var d = el('div', C.desc, esc(p.description))
      d.style.cssText = C.desc + 'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;'
      card.appendChild(d)
    }

    // ④ 健康问题：结构性缺陷红字、纯提示（如总线未注册）灰字 —— 不把"还没就绪"说成"坏了"
    var problems = (p.health && p.health.problems) || []
    if (problems.length) {
      var broken = isBroken(p)
      var line = el('div', 'font-size:10px;line-height:1.6;color:' + (broken ? SEMANTIC.danger : 'var(--muted,#687984)') + ';')
      var names = []
      for (var i = 0; i < problems.length; i++) names.push(PROBLEM_LABEL[problems[i]] || problems[i])
      line.textContent = (broken ? '清单问题：' : '提示：') + names.join(' / ')
      if (!broken) line.title = '总线注册是适配器启动时的副作用；进程刚起来或探针环境下可能尚未注册，不影响插件加载'
      card.appendChild(line)
    }

    // ⑤ 操作组
    var btns = el('div', 'display:flex;gap:6px;align-items:center;margin-top:2px;flex-wrap:wrap;')

    // 启用 ↔ 停用
    if (p.builtin === true) {
      var bBuiltin = el('button', C.btnDisabled, '内置 · 不可停用')
      bBuiltin.type = 'button'
      bBuiltin.disabled = true
      bBuiltin.title = '「' + String(p.name || p.agentId) + '」是宿主本体，恒可见，没有启停入口'
      btns.appendChild(bBuiltin)
    } else {
      var isOn = p.enabled === true
      var bToggle = el('button', isOn ? C.btn : C.btn, isOn ? '停用' : '启用')
      bToggle.type = 'button'
      bToggle.setAttribute('data-mio-market-toggle', String(p.agentId || ''))
      bToggle.title = isOn
        ? '停用后：左侧入口与设置页 tab 立即收回，插件脚本不再加载'
        : '启用后：插件脚本立即加载，左侧入口与设置页 tab 立即出现'
      bToggle.addEventListener('click', function () {
        doToggle(wrap, bToggle, p.agentId, !isOn)
      })
      btns.appendChild(bToggle)
    }

    // 下架
    var isSelf = String(p.agentId) === AGENT_ID
    var bDel = el('button', p.builtin === true ? C.btnDisabled : C.btnDanger, '下架')
    bDel.type = 'button'
    bDel.setAttribute('data-mio-market-del', String(p.agentId || ''))
    if (p.builtin === true) {
      // ★ 内置插件的下架按钮必须 disabled：后端会 403，但"能点、点了报错"是坏体验
      bDel.disabled = true
      bDel.title = '内置插件（宿主本体）不可下架 —— 下架桌宠等于把宿主本体拆掉'
    } else if (isSelf) {
      // 市场下架自己：契约 §5 允许，但必须把后果说清楚（下架后这个面板自己就没了）
      bDel.title = '下架「插件市场」本身：卡片、左侧入口、这个设置 tab 会一起消失'
      bDel.addEventListener('click', function () { doRemove(wrap, bDel, p, true) })
    } else {
      bDel.title = '只从清单移除条目，磁盘上的文件保留（随时可再上架）'
      bDel.addEventListener('click', function () { doRemove(wrap, bDel, p, false) })
    }
    btns.appendChild(bDel)
    card.appendChild(btns)
    return card
  }

  // ── 上架表单 ──────────────────────────────────────────────────────────────
  var FORM_FIELDS = [
    { k: 'agentId', label: 'agentId ★', ph: '例如 myplug（小写字母/数字/_/-，1~32 位）' },
    { k: 'name', label: 'name', ph: '显示名（≤40 字）' },
    { k: 'version', label: 'version', ph: '1.0.0' },
    { k: 'entry', label: 'entry ★', ph: 'plugins/myplug/manifest.js' },
    { k: 'panel', label: 'panel', ph: 'plugins/myplug/myplug-panel.js' },
  ]

  function buildForm(wrap) {
    var box = el('div', '')
    box.setAttribute('data-mio-market-formbox', '1')
    box.style.cssText = 'display:none;margin-top:14px;'
    box.appendChild(section('上架插件（登记一个已经在 dist/plugins/ 里的插件）'))

    var panelBox = el('div', 'border:1px solid var(--line,#d9e2e6);border-radius:10px;background:var(--surface-soft,#f2f6f7);padding:12px;')
    var intro = el('div', C.desc, '上架只是把插件**登记进清单**，不会复制或移动文件。' +
      'entry/panel 是相对 dist/ 的路径，且必须落在 dist/plugins/ 内（后端会 realpath 校验）。')
    intro.style.cssText = C.desc + 'margin-bottom:10px;'
    panelBox.appendChild(intro)

    // 两列自适应
    var grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;')
    var inputs = {}
    for (var i = 0; i < FORM_FIELDS.length; i++) {
      var f = FORM_FIELDS[i]
      var cell = el('div', 'min-width:0;')
      var lab = document.createElement('label')
      lab.style.cssText = C.label
      lab.textContent = f.label
      var inp = document.createElement('input')
      inp.type = 'text'
      inp.placeholder = f.ph
      inp.style.cssText = C.input + 'width:100%;'
      inp.value = view.form[f.k] || ''
      inp.setAttribute('data-mio-market-field', f.k)
      lab.appendChild(inp)
      cell.appendChild(lab)
      grid.appendChild(cell)
      inputs[f.k] = inp
      ;(function (key, node) {
        node.addEventListener('input', function () {
          view.form[key] = node.value
          // agentId 是唯一能推断目录的字段：用户还没手填 entry/panel 时，替他预填一版。
          // 这只是便利，填错了后端会给"文件不存在：<路径>"，原样回显在下面。
          if (key === 'agentId' && !view.form.__touchedEntry) {
            var dir = guessDir(node.value)
            if (dir) {
              inputs.entry.value = dir + 'manifest.js'
              view.form.entry = inputs.entry.value
              inputs.panel.value = dir + node.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') + '-panel.js'
              view.form.panel = inputs.panel.value
            }
          }
          if (key === 'entry' || key === 'panel') view.form.__touchedEntry = true
        })
      })(f.k, inp)
    }
    panelBox.appendChild(grid)

    // category + author + accent 一行三个（都是"可选、有默认值"的字段）
    var small = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-top:10px;')
    var catCell = el('div', 'min-width:0;')
    var catLab = document.createElement('label')
    catLab.style.cssText = C.label
    catLab.textContent = 'category'
    var catSel = document.createElement('select')
    catSel.style.cssText = C.input + 'width:100%;'
    catSel.setAttribute('data-mio-market-field', 'category')
    for (var c = 0; c < CATEGORIES.length; c++) {
      var o = document.createElement('option')
      o.value = CATEGORIES[c]
      o.textContent = CATEGORY_LABEL[CATEGORIES[c]] + '（' + CATEGORIES[c] + '）'
      if ((view.form.category || 'other') === CATEGORIES[c]) o.selected = true
      catSel.appendChild(o)
    }
    catSel.addEventListener('change', function () { view.form.category = catSel.value })
    catLab.appendChild(catSel)
    catCell.appendChild(catLab)
    small.appendChild(catCell)

    // author 与 accent 都可留空：留空时**不提交**，后端用默认值（author=Mio / accent 空）
    var authorCell = el('div', 'min-width:0;')
    var authorLab = document.createElement('label')
    authorLab.style.cssText = C.label
    authorLab.textContent = 'author（留空 = Mio）'
    var authorInp = document.createElement('input')
    authorInp.type = 'text'
    authorInp.placeholder = 'Mio'
    authorInp.style.cssText = C.input + 'width:100%;'
    authorInp.value = view.form.author || ''
    authorInp.setAttribute('data-mio-market-field', 'author')
    authorInp.addEventListener('input', function () { view.form.author = authorInp.value })
    authorLab.appendChild(authorInp)
    authorCell.appendChild(authorLab)
    small.appendChild(authorCell)

    var accentCell = el('div', 'min-width:0;')
    var accentLab = document.createElement('label')
    accentLab.style.cssText = C.label
    accentLab.textContent = 'accent（#RRGGBB）'
    var accentInp = document.createElement('input')
    accentInp.type = 'text'
    accentInp.placeholder = '#8B5CF6'
    accentInp.style.cssText = C.input + 'width:100%;'
    accentInp.value = view.form.accent || ''
    accentInp.setAttribute('data-mio-market-field', 'accent')
    accentInp.addEventListener('input', function () { view.form.accent = accentInp.value })
    accentLab.appendChild(accentInp)
    accentCell.appendChild(accentLab)
    small.appendChild(accentCell)

    panelBox.appendChild(small)

    // description
    var descCell = el('div', 'margin-top:10px;min-width:0;')
    var descLab = document.createElement('label')
    descLab.style.cssText = C.label
    descLab.textContent = 'description（≤200 字）'
    var ta = document.createElement('textarea')
    ta.placeholder = '一句话说明这个插件做什么'
    ta.rows = 3
    ta.style.cssText = C.input + 'width:100%;resize:vertical;font-family:inherit;min-height:56px;'
    ta.value = view.form.description || ''
    ta.setAttribute('data-mio-market-field', 'description')
    ta.addEventListener('input', function () { view.form.description = ta.value })
    descLab.appendChild(ta)
    descCell.appendChild(descLab)
    panelBox.appendChild(descCell)

    // 错误区（前端校验 + 后端 detail 都落这里，红字原样显示）
    var errBox = el('div', 'font-size:11px;line-height:1.7;color:' + SEMANTIC.danger +
      ';margin-top:10px;white-space:pre-wrap;word-break:break-word;')
    errBox.setAttribute('data-mio-market-formerr', '1')
    errBox.style.display = 'none'
    panelBox.appendChild(errBox)

    var actions = el('div', 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;')
    var bSubmit = el('button', C.btnPrimary, '上架并立即生效')
    bSubmit.type = 'button'
    bSubmit.setAttribute('data-mio-market-submit', '1')
    bSubmit.addEventListener('click', function () { doAdd(wrap, bSubmit, errBox) })
    var bCancel = el('button', C.btn, '收起')
    bCancel.type = 'button'
    bCancel.addEventListener('click', function () { toggleForm(wrap, false) })
    actions.appendChild(bSubmit)
    actions.appendChild(bCancel)
    actions.appendChild(el('span', C.desc, '上架成功后会自动重新加载插件，不用重启。'))
    panelBox.appendChild(actions)

    box.appendChild(panelBox)
    return box
  }

  function toggleForm(wrap, open) {
    view.formOpen = !!open
    var box = $q('[data-mio-market-formbox]', wrap)
    if (box) box.style.display = open ? 'block' : 'none'
    var b = $q('[data-mio-market-add]', wrap)
    if (b) b.innerHTML = open ? '收起上架表单' : '＋ 上架插件'
    if (open) {
      var first = $q('[data-mio-market-field="agentId"]', wrap)
      if (first) { try { first.focus() } catch (e) { /* ignore */ } }
    }
  }

  // ── 诊断区 ────────────────────────────────────────────────────────────────
  function paintDiag(wrap) {
    var box = $q('[data-mio-market-diag]', wrap)
    if (!box) return
    box.innerHTML = ''
    var diag = cache.diag
    if (!diag) return
    var checks = diag.checks || []
    box.appendChild(section('清单诊断' + (diag.ok === true ? ' · 全部正常' : '')))
    if (!checks.length) {
      box.appendChild(el('div', C.desc, '诊断不可用：' + esc(diag.error || '后端未返回检查项')))
      return
    }
    var bad = 0
    for (var i = 0; i < checks.length; i++) if (checks[i].ok !== true) bad++
    var listBox = el('div', 'display:flex;flex-direction:column;gap:4px;')
    for (var j = 0; j < checks.length; j++) {
      var ch = checks[j]
      var row = el('div', 'display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ink,#20303a);' +
        'padding:4px 8px;border-radius:7px;background:' + (ch.ok === true ? 'transparent' : SEMANTIC.danger + '0d') + ';')
      row.appendChild(el('span', 'flex:none;width:8px;height:8px;border-radius:50%;background:' +
        (ch.ok === true ? SEMANTIC.ok : SEMANTIC.danger) + ';'))
      row.appendChild(el('span', 'flex:none;width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,monospace;font-size:10px;color:var(--muted,#687984);',
        esc(ch.agentId)))
      row.appendChild(el('span', 'flex:1;min-width:0;word-break:break-all;', esc(ch.name || '')))
      var probs = ch.problems || []
      var txt = []
      for (var k = 0; k < probs.length; k++) txt.push(PROBLEM_LABEL[probs[k]] || probs[k])
      row.appendChild(el('span', 'flex:none;font-size:10px;color:' + (probs.length ? SEMANTIC.danger : SEMANTIC.idle) + ';',
        esc(txt.join(' / ') || '正常')))
      listBox.appendChild(row)
    }
    box.appendChild(listBox)
    if (bad) {
      box.appendChild(el('div', 'font-size:10px;color:var(--muted,#687984);margin-top:6px;line-height:1.7;',
        '「总线未注册」通常不是故障：适配器在进程启动后才会把身份注册进总线；' +
        '「文件缺失 / 路径越界」才是真问题，需要修清单条目或把文件放回 dist/plugins/。'))
    }
  }

  // ── 数据刷新 ──────────────────────────────────────────────────────────────
  function refreshData(host, opt) {
    opt = opt || {}
    return fetchAll().then(function (data) {
      lastError = ''
      var wrap = $q('[data-mio-market="' + AGENT_ID + '"]', host)
      if (!wrap) return data
      paintCards(wrap)
      paintDiag(wrap)
      return data
    }).catch(function (e) {
      lastError = (e && (e.detail || e.message)) || String(e)
      var wrap = $q('[data-mio-market="' + AGENT_ID + '"]', host)
      if (!wrap) return null
      var grid = $q('[data-mio-market-grid]', wrap)
      if (grid) {
        grid.innerHTML = ''
        grid.appendChild(el('div', 'font-size:12px;line-height:1.8;color:' + SEMANTIC.danger + ';' +
          'border:1px solid ' + SEMANTIC.danger + '44;background:' + SEMANTIC.danger + '0d;border-radius:10px;padding:12px 14px;',
          '读取插件清单失败：' + esc(lastError) +
          '<br /><span style="color:var(--muted,#687984);">后端 /api/plugin/market/* 不可用时，界面保持清空状态（不清空已有插件）。' +
          '请确认后端已重启到含插件市场的版本。</span>'))
      }
      return null
    })
  }

  function rerenderSelf(wrap, opt) {
    // 找到本面板所在的 host（wrap 的父节点），按约定整屏重画
    var host = wrap && wrap.parentNode
    if (host && host.nodeType === 1) renderInto(host, opt || {})
  }

  // ── 操作：启停 / 下架 / 上架 / 重扫 ───────────────────────────────────────
  function setMsg(wrap, text, tone) {
    var m = $q('[data-mio-market-msg]', wrap)
    if (!m) return
    var color = tone === 'ok' ? SEMANTIC.ok : (tone === 'err' ? SEMANTIC.danger : 'var(--muted,#687984)')
    m.style.color = color
    m.textContent = text || ''
  }

  /** 让按钮"忙"起来：既防连点，也让用户看到进度。返回恢复函数。 */
  function busy(btn, text) {
    var old = btn.textContent
    btn.disabled = true
    btn.style.opacity = '0.6'
    if (text) btn.textContent = text
    return function () {
      btn.disabled = false
      btn.style.opacity = ''
      btn.textContent = old
    }
  }

  function doToggle(wrap, btn, id, nextEnabled) {
    var done = busy(btn, nextEnabled ? '启用中…' : '停用中…')
    setMsg(wrap, (nextEnabled ? '正在启用 ' : '正在停用 ') + id + '…')
    // 提交的必须是**目标态本身**。这里曾经想"取反再比较"写成 !nextEnabled === false，
    // 那表达式恒为 true —— 点"停用"反而会把插件启用。布尔值直接传，别加工。
    callApi('POST', API + '/plugins/' + encodeURIComponent(id) + '/enable', { enabled: nextEnabled })
      .then(function (j) {
        // 再取一次总线真值：后端返回的 enabled 是**总线上的真值**，不是请求值
        var actual = j && j.enabled === true
        setMsg(wrap, (actual ? '已启用 ' : '已停用 ') + id + ' · 正在重新加载插件…', 'ok')
        return rescanFrontend().then(function (r) {
          setMsg(wrap, (actual ? '已启用 ' : '已停用 ') + id + '。左侧导航与设置页 tab 已同步。' +
            (r && r.ok === false ? '（前端重扫未完成，可手动刷新页面）' : ''), 'ok')
          // ★ 重渲染前后要保住状态行：整屏重画会把 msg 清成空，
          //   于是"到底成没成"这一句立刻消失（harness 第一轮就是这么抓到的）。
          //   先重画、再把消息补回去。
          var keep = (actual ? '已启用 ' : '已停用 ') + id + '。左侧导航与设置页 tab 已同步。' +
            (r && r.ok === false ? '（前端重扫未完成，可手动刷新页面）' : '')
          var keepTone = 'ok'
          rerenderSelf(wrap, { keepScroll: true, msg: keep, tone: keepTone })
        })
      })
      .catch(function (e) {
        setMsg(wrap, (nextEnabled ? '启用失败：' : '停用失败：') + ((e && (e.detail || e.message)) || String(e)), 'err')
        done()
      })
  }

  function doRemove(wrap, btn, p, isSelf) {
    var id = String(p.agentId || '')
    var name = String(p.name || id)
    var text = isSelf
      ? '下架「' + name + '」本身？\n\n下架后：\n· 这张卡片消失\n· 左侧「插件市场」入口消失\n· 设置页「插件市场」tab 消失\n\n' +
        '磁盘文件会保留；想再打开市场，需要重新 POST 一次上架清单条目。'
      : '下架「' + name + '」（' + id + '）？\n\n只从清单移除条目，dist/plugins/ 里的文件**不会**被删除，随时可以重新上架。'
    if (!window.confirm(text)) return
    var done = busy(btn, '下架中…')
    setMsg(wrap, '正在下架 ' + id + '…')
    callApi('DELETE', API + '/plugins/' + encodeURIComponent(id))
      .then(function () {
        setMsg(wrap, '已下架 ' + id + ' · 正在重新加载插件…', 'ok')
        return rescanFrontend()
      })
      .then(function () {
        if (isSelf) {
          // 下架市场自己：本面板即将不存在，不能再 rerenderSelf（会把已卸载的面板画回来）
          setMsg(wrap, '已下架「插件市场」本身。文件仍在 dist/plugins/market/，重新上架即可恢复。', 'ok')
          return
        }
        var kept = '已下架 ' + id + '。文件保留在 dist/plugins/，随时可重新上架。'
        rerenderSelf(wrap, { keepScroll: true, msg: kept, tone: 'ok' })
      })
      .catch(function (e) {
        setMsg(wrap, '下架失败：' + ((e && (e.detail || e.message)) || String(e)), 'err')
        done()
      })
  }

  function doAdd(wrap, btn, errBox) {
    var v = validateForm(view.form)
    if (!v.ok) {
      errBox.style.display = 'block'
      errBox.textContent = '请先修正：\n· ' + v.errors.join('\n· ')
      return
    }
    errBox.style.display = 'none'
    var done = busy(btn, '上架中…')
    setMsg(wrap, '正在上架 ' + v.body.agentId + '…')
    callApi('POST', API + '/plugins', v.body)
      .then(function (j) {
        var added = (j && j.plugin) || {}
        setMsg(wrap, '已上架 ' + (added.name || v.body.agentId) + ' · 正在加载插件…', 'ok')
        return rescanFrontend().then(function () {
          view.form = {}       // 成功后清空表单（失败时保留，用户不必重填）
          view.formOpen = false
          rerenderSelf(wrap, {
            keepScroll: true,
            msg: '上架成功：' + (added.name || v.body.agentId) + '（' + v.body.agentId + '）已生效，无需重启。',
            tone: 'ok',
          })
        })
      })
      .catch(function (e) {
        // ★ 后端 detail 原样红字回显（契约 §5："后端错误原样回显"）：
        //   里面通常带**具体路径**，正是用户要的信息，不要包裹成"操作失败"。
        errBox.style.display = 'block'
        errBox.textContent = String((e && (e.detail || e.message)) || e)
        setMsg(wrap, '上架失败（' + ((e && e.status) || '网络') + '）', 'err')
        done()
      })
  }

  function manualRescan(wrap, btn) {
    var done = busy(btn, '扫描中…')
    setMsg(wrap, '正在让后端重读清单并重新加载插件…')
    callApi('POST', API + '/reload')
      .then(function () { return rescanFrontend() })
      .then(function () {
        return refreshData(wrap.parentNode || document.body).then(function () {
          setMsg(wrap, '已重新扫描：清单与前端插件都已按最新状态加载。', 'ok')
        })
      })
      .catch(function (e) {
        setMsg(wrap, '重新扫描失败：' + ((e && (e.detail || e.message)) || String(e)), 'err')
      })
      .then(function () { done() })
  }

  // ── 外部事件：loader/nav 变更时让面板跟上（契约 §3.4 mio:plugins-changed）──
  window.addEventListener('mio:plugins-changed', function () {
    // 只刷新**仍挂在页面上**的面板，避免为不可见的面板白白发请求
    var wrap = document.querySelector('[data-mio-market="' + AGENT_ID + '"]')
    if (!wrap || !wrap.parentNode) return
    refreshData(wrap.parentNode)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 左侧「插件市场」功能页（nav.mode:'own' → 本文件负责建按钮，R9）
  // ══════════════════════════════════════════════════════════════════════════
  var NAV_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 9h18l-1.5 9.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5L3 9z"/>' +
    '<path d="M8 9V6a4 4 0 0 1 8 0v3"/></svg>'

  var page = null      // 功能页浮层（懒建）
  var navBtn = null
  var pagePollTimer = null

  /** 左侧导航的**实际占位宽度**（用于把内容推开，避免被浮层导航盖住）。
   *
   * ★ 2026-10-25 真机截图暴露：宿主 `main` 的 left 是 56px，但左侧 `<nav>` 是
   *   **浮层**（宽约 200px，z-index 高于 main），它压在 main 的左边一截上。
   *   结果是页面前 150px 的内容被导航挡死（真机截图里标题「…项目分发」缺了一半）。
   *   这不是本插件独有的问题（桌宠页同样如此），但市场页是新页面，
   *   没道理跟着一起烂：这里主动把内容区的左内边距撑到导航右边缘之外。
   *   折叠态导航很窄时不会多撑（取 max(20, 导航右边缘 - 宿主左边缘 + 12)）。
   */
  function navReserveLeft(host) {
    if (!host) return 20
    try {
      var hostRect = host.getBoundingClientRect()
      if (!hostRect.width) return 20
      // ★★ 这个函数踩了三次坑才写对，把结论记在这里：
      //
      //   ① 页面里有 **两个** <nav>：侧栏 `nav.main-nav`（会遮挡内容）和
      //      整行的 `nav.companion-tab-bar`（宽 1198）。用 `querySelector('nav')`
      //      可能选中任意一个 —— 实测选中过宽 41 的折叠态、也算出过 1210 的离谱值。
      //   ② 侧栏宽度**不是常量**：市场页刚打开的那一刻常常是折叠态（宽 41、right −26），
      //      而稳定后是展开态（left 7、宽 193、right 200）。
      //      所以**不能用"此刻 measured"** 决定内边距，否则页面会在折叠/展开之间来回跳。
      //   ③ 只有本地开发时把代码拿去实测才知道：真正的遮挡量 =
      //      「侧栏右边缘 − 内容容器左边缘」，不是"侧栏宽度"。
      //
      //   结论：优先按 CSS 声明的宽度（稳定的设计值）算，拿不到才退回实测，
      //   并且用展开态的经验值 193 作下限 —— 宁可多推一点，也不要让内容被盖住。
      var side = document.querySelector('nav.main-nav') || document.querySelector('nav[class*="main-nav"]')
      var width = 0
      var left = 0
      if (side) {
        var cs = getComputedStyle(side)
        var declared = parseFloat(cs.width) || 0
        var box = side.getBoundingClientRect()
        width = Math.max(declared, side.scrollWidth || 0, box.width || 0)
        left = box.left || 0
      }
      // 下限：展开态侧栏约 193px（本应用固定布局）
      if (width < 160) width = 193
      if (left < 0) left = 7
      var rightEdge = left + width
      var need = Math.round(rightEdge - hostRect.left) + 12
      if (need < 20) need = 20
      return Math.min(need, Math.round(hostRect.width * 0.35))
    } catch (e) { return 20 }
  }

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
          var n = kids[i]
          if (n.offsetParent === null || n.getAttribute('aria-hidden') === 'true') continue
          if (!best) { best = n; continue }
          if (n.offsetWidth * n.offsetHeight > best.offsetWidth * best.offsetHeight) best = n
        }
        if (best) return best
      }
    }
    return null
  }

  function setNavActive(on) {
    if (navBtn) navBtn.classList.toggle('active', !!on)
  }

  /** 功能页：与设置页 tab **共用同一个 renderInto**，所以只有一套渲染逻辑要维护。
   *  页面外壳自己带标题栏与 ✕（与 DSH 页同样的形态），内容区交给 renderInto。 */
  function buildPage() {
    if (page) return page
    page = document.createElement('div')
    page.id = 'mio-market-page'
    page.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;z-index:99;display:none;flex-direction:column;' +
      'background:var(--app-bg,#e9eef0);color:var(--ink,#20303a);' +
      'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;'
    page.innerHTML =
      '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px;' +
        'background:var(--sidebar-bg,#f4f7f8);border-bottom:1px solid var(--line,#d9e2e6);">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:' + ACCENT + ';flex:none;"></span>' +
        '<strong style="font-size:14px;flex:none;">插件市场</strong>' +
        '<span data-mio-market-sub style="flex:1;font-size:11px;color:var(--muted,#687984);' +
          'overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">管理已安装的插件</span>' +
        '<button type="button" data-mio-market-close title="关闭插件市场" ' +
          'style="border:none;background:transparent;font-size:16px;cursor:pointer;color:var(--muted,#687984);padding:2px 6px;">✕</button>' +
      '</div>' +
      '<div data-mio-market-pagebody style="flex:1;overflow-y:auto;padding:16px 20px;"></div>'
    var host = findContentArea()
    if (host && getComputedStyle(host).position === 'static') {
      host.style.position = 'relative'
      page.__mioMarketHostFixed = true
    }
    ;(host || document.body).appendChild(page)
    applyNavReserve(host)
    var closeBtn = $q('[data-mio-market-close]', page)
    if (closeBtn) closeBtn.addEventListener('click', function (e) { e.stopPropagation(); hidePage() })
    return page
  }

  /** 把内容左内边距撑开，避开浮层导航（见 navReserveLeft 的说明）。 */
  function applyNavReserve(host) {
    if (!page) return
    var body = $q('[data-mio-market-pagebody]', page)
    if (!body) return
    var h = host || findContentArea()
    var reserve = navReserveLeft(h)
    body.style.padding = '16px 20px 16px ' + reserve + 'px'
    // ★ 时序：刚 display:flex 出来的那一拍，布局可能还没完成，
    //   getBoundingClientRect 会返回 0 宽 → 算出兜底值 20。下一帧再校一次。
    if (reserve <= 20) {
      window.setTimeout(function () {
        try {
          if (!page || !body.parentNode) return
          var again = navReserveLeft(h || findContentArea())
          if (again > 20) body.style.padding = '16px 20px 16px ' + again + 'px'
        } catch (e) { /* ignore */ }
      }, 60)
    }
  }

  function showPage() {
    buildPage()
    var host = findContentArea()
    if (host && page.parentElement !== host) host.appendChild(page)
    page.style.display = 'flex'
    setNavActive(true)
    // 每次显示都重算左边距：侧栏可能被折叠/展开，宽度会变
    applyNavReserve(host)
    var body = $q('[data-mio-market-pagebody]', page)
    if (body) renderInto(body)
    if (!pagePollTimer) {
      pagePollTimer = window.setInterval(function () {
        // 轮询只在页可见时跑，且只更新卡片区（不重搭骨架，避免打断用户输入）
        if (!page || page.style.display === 'none') return
        var w = $q('[data-mio-market="' + AGENT_ID + '"]', page)
        if (w) refreshData(w)
      }, 8000)
    }
  }

  function hidePage() {
    if (page) page.style.display = 'none'
    setNavActive(false)
  }

  function togglePage() {
    if (page && page.style.display !== 'none') hidePage()
    else showPage()
  }

  // 点其它导航项时自动收起本功能页（它是 absolute 浮层，不参与 Vue 的视图切换）
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('nav button.nav-item') : null
    if (!b || b === navBtn) return
    if (page && page.style.display !== 'none') hidePage()
  }, true)

  function ensureNav() {
    if (navBtn && navBtn.isConnected) return
    var nav = $q('nav')
    if (!nav) return
    navBtn = document.createElement('button')
    navBtn.type = 'button'
    navBtn.className = 'nav-item mio-market-nav'
    navBtn.title = NAV_LABEL
    // ★ data-mio-plugin-nav：loader 卸载本插件时按这个标记精确摘掉按钮，
    //   不必去猜按钮文字（猜文字会误伤桌宠/设置这类固定导航）。
    navBtn.setAttribute('data-mio-plugin-nav', NAV_MARK)
    navBtn.innerHTML = NAV_SVG + '<span>' + NAV_LABEL + '</span>'
    navBtn.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      togglePage()
    })
    nav.appendChild(navBtn)
  }

  // ── R4 自愈：Vue 重渲染会整批重建 <nav> 的 children，外部 append 的按钮直接消失 ──
  // 两个来源缺一不可：MutationObserver 抓"刚刚被删"，setInterval 兜住
  // "body 被整体替换 / observer 漏事件"的极端情况。
  //
  // ★★ 2026-10-25：自愈必须能"被关掉"（与 dsh-panel 同一条修复）。
  //   loader 卸载插件时会主动摘导航按钮，如果自愈不认识"这次是卸载"，
  //   它会把按钮当成"被 Vue 删了"立刻补回来 —— 表现就是"插件停用了入口还在"。
  //
  // ★★ 但只认**显式 dispose()**，不再去问 registry：
  //   之前还加了一条"registry 里没有我就算已卸载"，结果踩了反坑 ——
  //   loader.reload() 在卸载阶段会短暂把 manifest 从 registry 摘掉，
  //   市场是 builtin（正常永远在册），却在这个瞬间把自己的自愈**永久关掉**，
  //   重装后脚本因幂等守卫不重跑 → 左侧入口再也不回来（用户实测就是这个）。
  //   现在：disposed 只由 loader 显式调用 dispose() 置位，revive() 负责复位。
  var disposed = false
  function isDisposed() {
    return disposed
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
        if (nav.querySelector('[data-mio-plugin-nav="' + NAV_MARK + '"]')) {
          // 我们的按钮还活着：但如果 navBtn 还没绑定（比如被外部重建过一次），补一次引用
          if (!navBtn || !navBtn.isConnected) navBtn = nav.querySelector('[data-mio-plugin-nav="' + NAV_MARK + '"]')
          return
        }
        ensureNav()
      } catch (e) { /* 自愈失败不能影响页面 */ }
    })
  }
  var mo = null
  if (typeof MutationObserver === 'function') {
    try {
      mo = new MutationObserver(scheduleRepair)
      mo.observe(document.body, { childList: true, subtree: true })
    } catch (e) { /* ignore */ }
  }
  var repairTimer = window.setInterval(function () {
    if (isDisposed()) { window.clearInterval(repairTimer); repairTimer = null; return }
    var nav = $q('nav')
    if (nav && !nav.querySelector('[data-mio-plugin-nav="' + NAV_MARK + '"]')) scheduleRepair()
  }, 2500)

  /** 卸载钩子（loader 调用）：停掉一切自愈 + 摘掉自己的 DOM。 */
  function dispose() {
    disposed = true
    try { if (mo) mo.disconnect() } catch (e) { /* ignore */ }
    if (repairTimer) { window.clearInterval(repairTimer); repairTimer = null }
    if (pagePollTimer) { window.clearInterval(pagePollTimer); pagePollTimer = null }
    try {
      var b = navBtn && navBtn.parentNode
      if (b) b.removeChild(navBtn)
      var p = document.getElementById('mio-market-page')
      if (p && p.parentNode) p.parentNode.removeChild(p)
      var host = document.getElementById('mio-plugin-settings-' + AGENT_ID)
      if (host && host.parentNode) host.parentNode.removeChild(host)
    } catch (e) { /* ignore */ }
    // navBtn 已摘除，清掉引用，避免 revive 时拿到游离节点
    navBtn = null
  }

  /** 复活钩子（loader 在"从停用恢复启用"时调用）：
   *  dispose 之后脚本有幂等守卫不会重跑，所以必须由本函数把现场重新支起来。
   */
  function revive() {
    if (!disposed) { ensureNav(); return }
    disposed = false
    // 重建 MutationObserver（dispose 时 disconnect 过）
    if (typeof MutationObserver === 'function') {
      try {
        mo = new MutationObserver(scheduleRepair)
        mo.observe(document.body, { childList: true, subtree: true })
      } catch (e) { /* ignore */ }
    }
    // 重建兜底轮询
    if (!repairTimer) {
      repairTimer = window.setInterval(function () {
        if (isDisposed()) { window.clearInterval(repairTimer); repairTimer = null; return }
        var nav = $q('nav')
        if (nav && !nav.querySelector('[data-mio-plugin-nav="' + NAV_MARK + '"]')) scheduleRepair()
      }, 2500)
    }
    ensureNav()
  }

  function boot() {
    if (!$q('nav')) { window.setTimeout(boot, 400); return }
    ensureNav()
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot()
  else document.addEventListener('DOMContentLoaded', boot)
  window.addEventListener('load', function () { if (!navBtn || !navBtn.isConnected) boot() })

  // ══════════════════════════════════════════════════════════════════════════
  // 导出（★ R7：导出名必须与 manifest.settingsTab.panel 逐字一致）
  // ══════════════════════════════════════════════════════════════════════════
  /** 测试钩子：把纯函数露出来，便于在无后端环境下单测（见 probe_tmp/market_panel_harness.cjs）。 */
  var api = {
    accent: ACCENT,
    agentId: AGENT_ID,
    renderInto: renderInto,
    show: showPage,
    hide: hidePage,
    ensureNav: ensureNav,
    refresh: function () {
      var wrap = document.querySelector('[data-mio-market="' + AGENT_ID + '"]')
      return wrap && wrap.parentNode ? refreshData(wrap.parentNode) : Promise.resolve(null)
    },
    // —— 以下供 harness 使用（生产环境无副作用）——
    fetchAll: fetchAll,
    callApi: callApi,
    rescanFrontend: rescanFrontend,
    validateForm: validateForm,
    stateOf: stateOf,
    filterList: filterList,
    setView: function (v) {
      if (!v) return view
      if (v.q != null) view.q = String(v.q)
      if (v.cat != null) view.cat = String(v.cat)
      if (v.formOpen != null) view.formOpen = !!v.formOpen
      if (v.form) view.form = v.form
      return view
    },
    cache: function () { return cache },
    lastError: function () { return lastError },
    // 卸载钩子：loader 停用/下架本插件时调用（停自愈 + 摘 DOM）
    dispose: dispose,
    // 复活钩子：从停用恢复启用时由 loader 调用（脚本幂等守卫不会重跑）
    revive: revive,
  }
  window['market-panel'] = api      // R7：逐字
  window.__mioMarketPanel = api     // 便利别名（nav 按钮复用 / 控制台自检）
})()
