/* feiyu plugin manifest — 大肥鱼插件包声明
 * ────────────────────────────────────────────────────────────────────────────
 * 加载顺序：manifest.js 必须先于 kernel/plugin-registry.js（index.html 引用序保证）。
 * 状态口径：以后端 /api/companion/agents 的 enabled 为准（与桌宠插件总线同源）。
 * 插件零相互依赖：本文件只声明自己，不引用其它插件的任何东西。
 * ────────────────────────────────────────────────────────────────────────────
 */
window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['cloud_feiyu'] = {
  // ★ 必须与后端 /api/companion/agents 的 agent_id 完全一致（实测后端是 cloud_feiyu）。
  //   写错会导致：插件的启停联动永远对不上 —— enabled 一直是 false，
  //   设置 tab 与左侧导航被一直隐藏（表现为"插件装了但什么都不出现"）。
  agentId: 'cloud_feiyu',
  name: '大肥鱼',

  // ★ 左侧「大肥鱼」导航项是**原版 Vue 硬编码**的（index 包里 navItems 数组），
  //   不是本插件创建的。但它的显隐必须跟着插件启用状态走 ——
  //   声明 nav.keywords 后，kernel/plugin-nav.js 的 applyVisibility()
  //   就会在插件停用时把这一项隐藏（它按关键词匹配导航按钮，不管是谁建的）。
  //   mode: 'host' = 复用宿主已有的导航按钮，本插件**不**自己 append，
  //   避免出现两个「大肥鱼」。契约检查脚本会据此断言 panel 里没有 appendChild(navBtn)。
  nav: { keywords: ['大肥鱼'], mode: 'host' },

  // 桌宠页「观察」子 tab 不归本插件
  observeTab: false,

  // 体检面板：本插件暂不声明自检条目（云端连通性由观察页的“立即看一眼”覆盖）
  health: false,

  // 桌宠气泡配色键：与 DSH（靛蓝 #4F6BED）区分 —— 本插件 = 鲑鱼粉
  bubble: { colorKey: 'feiyu', accent: '#E08A9B' },

  // ★ 设置页 tab：插件自行声明要在设置页顶部插入的 tab（按 order 升序，最左优先）。
  //   kernel/plugin-nav.js 的 mountSettingsTabs() 会据此把 tab 与面板挂上去；
  //   插件停用时整组隐藏 —— 即插即用。
  settingsTab: { id: 'feiyu', label: '大肥鱼', order: 10, panel: 'feiyu-panel' },
}
// 注册进前端微内核注册表（幂等）
if (window.__mioPluginRegistry) window.__mioPluginRegistry.register(window.__mioPluginManifests['cloud_feiyu'])
