/* market manifest — 插件市场（内置管理入口：不可停用、不可下架）
 * ────────────────────────────────────────────────────────────────────────────
 * 契约出处：docs/插件市场-契约.md §1（清单条目）/ §5（市场 UI）。改这里先改文档。
 *
 * 为什么市场也要是一个"插件"：
 *   它读的、改的、启停的，和界面上别的插件是**同一份清单**
 *   （数据/插件市场.json ← GET /api/plugin/market/catalog）。
 *   如果让市场作为"宿主内置功能"游离在清单之外，就会出现两套口径；
 *   所以它老老实实占一条 agentId='market'，走同一套加载/挂载流程 ——
 *   kernel 依然不认识它（loader 只按清单里的 entry 去插脚本）。
 *
 * ★ 为什么 builtin:true（用户裁决 2026-10-25，与 pet 同一条原则）：
 *   市场是所有插件的管理入口。若它可以被停用/下架，
 *   点一下"停用" → loader 立刻卸掉它的 manifest 与面板 →
 *   所有插件的启停/上架/下架入口**全部消失**，而"重新启用"这个动作恰好也只在市场里
 *   → 除非手改 数据/插件市场.json 或重装，否则永远回不来。
 *   这叫"把自己锁在门外"，与 AGENTS.md 对 pet 的裁决同源：
 *   「停用它等于把宿主拆了」的插件，一律 builtin。
 *
 *   builtin 只影响"启停与下架"两个按钮（市场面板里渲染成灰态），
 *   不影响它作为插件参与市场列表 —— 它照样是一张卡片。
 *
 * ★ agentId 不从别的插件推：默认清单里大肥鱼的 agentId 是 **cloud_feiyu**
 *   （目录却叫 plugins/feiyu/），桌宠的目录名与 agentId 恰好相同 ——
 *   目录名 ≠ id 这条已经踩过一次，所以市场面板里所有 id 一律从 /catalog 读，不写死。
 * ────────────────────────────────────────────────────────────────────────────
 */
window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['market'] = {
  agentId: 'market',
  name: '插件市场',

  // ★ 内置：恒可见、不可停用、不可下架（理由见文件头）。
  //   与后端 plugin_market_service.DEFAULT_PLUGINS 里 market 条目的 builtin 必须一致，
  //   否则会出现"后端让它可停用、前端却恒显示"的口径分裂。
  builtin: true,

  // ★ 左侧「插件市场」= nav.mode:'own'：原版 Vue 的 navItems 里没有这个入口，
  //   所以必须由 market-panel.js 自己 append 一个导航按钮，否则左侧什么都没有。
  //   （选错成 'host' 会变成"声明了入口却没人建"：契约检查脚本 §③ 会直接判红。）
  //   按钮带 data-mio-plugin-nav="market"：loader 卸载时按这个标记精确摘除，
  //   不会误伤桌宠/设置这类固定导航，也不靠"猜按钮文字"。
  nav: { keywords: ['插件市场'], mode: 'own' },

  // 市场不接桌宠的「观察」子 tab，也不当气泡说话方
  observeTab: false,

  // 体检：市场没有自己的 /diagnostics 后端条目（清单健康度在面板里直接展示）
  health: false,

  // 气泡/身份色：紫色，与 dsh 靛蓝 #4F6BED、feiyu 鲑鱼粉 #E08A9B、pet 青 #4C8798 区分（R5）
  bubble: { colorKey: 'market', accent: '#8B5CF6' },

  // 设置页 tab：order 900 → 排在所有插件 tab 之后（R8：只决定插件之间的相对次序，
  // 位置一律 appendChild 到最右侧）。panel 名必须与 market-panel.js 的导出名逐字一致（R7）。
  settingsTab: { id: 'market', label: '插件市场', order: 900, panel: 'market-panel' },
}
// 注册进前端微内核注册表（幂等）
if (window.__mioPluginRegistry) window.__mioPluginRegistry.register(window.__mioPluginManifests['market'])
