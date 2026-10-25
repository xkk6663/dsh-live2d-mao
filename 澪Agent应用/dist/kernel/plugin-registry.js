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

    /**
     * 是否内置插件（builtin）。
     *
     * ★ 概念（2026-10-25 用户裁决）：
     *   插件体系里有两类东西 —
     *     · 可热插拔插件：DSH / 大肥鱼，可随时停用，停用后入口整体消失；
     *     · 内置插件（builtin=true）：**桌宠本体自己**。它是宿主的一部分，
     *       形态上与其他插件一致（有 manifest、有 panel、走同一套挂载流程），
     *       但**不允许热插拔** —— 停用它等于把宿主拆了，只会让界面变成一堆空壳。
     *   所以下面所有"按 enabled 显隐"的地方，都必须先问 isBuiltin()：
     *   内置插件恒为可见，不看后端 enabled。
     */
    isBuiltin: function (id) {
      var m = manifests[id]
      return !!(m && m.builtin === true)
    },

    // 全部内置插件 id（宿主必须存在的部分）
    builtinList: function () {
      var out = []
      for (var id in manifests) if (manifests[id] && manifests[id].builtin === true) out.push(id)
      return out
    },

    /** 该插件当前是否"应当可见"：内置恒真，其余看后端 enabled。 */
    visible: function (id) {
      if (registry.isBuiltin(id)) return true
      return enabled[id] === true
    },

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
