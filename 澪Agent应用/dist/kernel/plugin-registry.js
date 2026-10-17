/* plugin-registry.js — 前端微内核 · 插件注册表
 * 统一聚合各插件 manifest + 后端 enabled 状态，供 kernel 组件（导航/体检等）查询。
 * 插件零相互依赖：各自 manifest.js 独立声明，registry 只做聚合与查询。
 * 暴露：window.__mioPluginRegistry
 */
(function () {
  if (window.__mioPluginRegistry) return

  var manifests = {}   // agentId -> manifest
  var enabled = {}     // agentId -> bool（以 /api/companion/agents enabled 为准）

  var registry = {
    // 插件包自身调用：注册 manifest（幂等，同名覆盖）
    register: function (m) {
      if (!m || !m.agentId) return
      manifests[m.agentId] = m
    },

    get: function (id) { return manifests[id] || null },
    list: function () { return Object.keys(manifests) },

    isEnabled: function (id) { return enabled[id] === true },
    setEnabled: function (id, on) { enabled[id] = !!on },

    // 后端 agents API -> enabled 映射（reconcile 全量）
    reconcile: function (agents) {
      var next = {}
      for (var i = 0; i < (agents || []).length; i++) {
        var a = agents[i]
        if (a && a.agent_id) next[String(a.agent_id)] = a.enabled !== false
      }
      enabled = next
    },

    // 聚合：插件导航关键词（agentId -> keywords[]）
    navRules: function () {
      var rules = {}
      for (var id in manifests) {
        var m = manifests[id]
        if (m && m.nav && m.nav.keywords) rules[id] = m.nav.keywords
      }
      return rules
    },

    // 聚合：声明 observeTab 且已启用 的插件是否存在（决定「观察」子tab显隐）
    observeTabEnabled: function () {
      for (var id in manifests) {
        var m = manifests[id]
        if (m && m.observeTab === true && enabled[id] === true) return true
      }
      return false
    },

    // 聚合：声明 health.connection 的插件是否存在（决定体检页「连接自检」行的显隐）
    // DSH 专用化：原本只有小智声明 health.connection；小智插件已阉割 → 该行自然消失。
    // 机制保持通用，将来有插件声明即生效。
    connectionSection: function () {
      for (var id in manifests) {
        var m = manifests[id]
        if (m && m.health && m.health.connection === true) return id
      }
      return null
    },
  }

  window.__mioPluginRegistry = registry
})()
