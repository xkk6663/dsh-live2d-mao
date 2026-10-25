/* pet manifest — 桌宠本体（内置插件，不可热插拔）
 * ────────────────────────────────────────────────────────────────────────────
 * ★ 定位（2026-10-25 用户裁决）：
 *   这个项目**本身就是桌宠**。所以桌宠不是一个"可装可卸的插件"，
 *   而是宿主的一部分 —— 但它在形态上**完全遵循插件规范**：
 *   有 manifest、有 panel、走 kernel 同一套挂载流程。
 *
 *   builtin: true 的含义（见 kernel/plugin-registry.js 的 isBuiltin）：
 *     · 恒可见：不参与"按后端 enabled 显隐"的逻辑，永远不会因为某个开关变空；
 *     · 不可热插拔：不提供启停入口（它没有 /agents 记录，也不该有）；
 *     · 但它仍然可以像插件一样"被替换/扩展" —— 将来若要做第二个桌宠形态，
 *       再加一个 builtin 插件即可，kernel 不需要改。
 *
 *   与另外两个**可热插拔**插件的分工：
 *     · dsh   —— DSH 实时状态页（可停用）
 *     · feiyu —— 大肥鱼屏幕观察/语音（可停用）
 *     · pet   —— 桌宠本体：形象、外观、行为、横条、泡泡、体检（本文件，不可停用）
 * ────────────────────────────────────────────────────────────────────────────
 */
window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['pet'] = {
  agentId: 'pet',
  name: '桌宠',

  // ★ 内置：恒可见、不可停用
  builtin: true,

  // 左侧导航「桌宠」由原版 Vue 渲染（固定导航），本插件接管其内容区而不新建入口，
  // 所以这里不声明 nav.keywords（避免与固定导航重名导致隐藏逻辑误伤）。
  nav: null,

  observeTab: false,
  health: true,

  // 桌宠本体的强调色（与 dsh 靛蓝、feiyu 鲑鱼粉区分）
  bubble: { colorKey: 'pet', accent: '#4C8798' },

  // 设置页：桌宠相关的形象/外观/行为归本插件。
  //   order 20 → 排在 feiyu(10) 之后、其余之前。
  settingsTab: { id: 'pet', label: '桌宠', order: 20, panel: 'pet-panel' },
}
if (window.__mioPluginRegistry) window.__mioPluginRegistry.register(window.__mioPluginManifests['pet'])
