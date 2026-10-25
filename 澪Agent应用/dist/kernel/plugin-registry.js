/* plugin-registry.js — 前端微内核 · 插件注册表
 * 统一聚合各插件 manifest + 后端 enabled 状态，供 kernel 组件（导航/体检等）查询。
 * 插件零相互依赖：各自 manifest.js 独立声明，registry 只做聚合与查询。
 * 暴露：window.__mioPluginRegistry
 *
 * 插件市场（2026-10-25，见 docs/插件市场-契约.md §3.1/§3.4）：
 *   manifest 不再只从 index.html 里写死的 <script> 来，而是由 kernel/plugin-loader.js
 *   按清单动态注入。所以这里必须补上「反向」能力 ——
 *     · unregister(id)  卸载时把 manifest 摘掉（否则 nav/体检一直记得它）；
 *     · all()           返回全部 manifest（loader/reload 自检用）；
 *     · onChanged(cb)   任何增删都广播，nav 据此立即重算（不必等 8s 轮询）。
 *   ★ 本文件仍然**不认识任何具体插件**：新增的接口全是通用机制，不含任何 agentId 字面量。
 */
(function () {
  if (window.__mioPluginRegistry) return

  var manifests = {}   // agentId -> manifest
  var enabled = {}     // agentId -> bool（以 /api/companion/agents enabled 为准）
  var listeners = []   // onChanged 订阅者；派发载荷 {type, id}

  /** 广播 manifest 增删。监听器抛错不能影响注册流程本身（nav 挂了也不能让插件注册失败）。 */
  function emitChanged(type, id) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i]({ type: type, id: id }) } catch (e) {
        try { console.error('[plugin-registry] onChanged 监听器抛错', e) } catch (e2) { /* ignore */ }
      }
    }
  }

  var registry = {
    // 插件包自身调用：注册 manifest（幂等，同名覆盖）
    register: function (m) {
      if (!m || !m.agentId) return
      var isNew = !manifests[m.agentId]
      manifests[m.agentId] = m
      // 同名覆盖也派发：manifest 可能被重新加载（版本变了、nav 声明变了），nav 需要重算
      emitChanged('manifest-registered', String(m.agentId))
      return isNew
    },

    /**
     * 卸载时摘掉 manifest（loader/plugin-loader.js 调用）。
     * 同时清掉该 id 的 enabled 记录，避免下次同 id 注册时继承上一次的启停态。
     * @returns {boolean} 是否真的删掉了东西（不存在时返回 false，幂等）
     */
    unregister: function (id) {
      var key = String(id || '')
      if (!key || !manifests[key]) {
        if (key && key in enabled) delete enabled[key]
        return false
      }
      delete manifests[key]
      delete enabled[key]
      emitChanged('manifest-removed', key)
      return true
    },

    /** 全部 manifest 数组（只读副本语义：返回新数组，元素是 manifest 本身）。 */
    all: function () {
      var out = []
      for (var id in manifests) if (manifests[id]) out.push(manifests[id])
      return out
    },

    /**
     * 订阅 manifest 增删。返回退订函数（loader 不需要退订，但留给测试/热重载用）。
     * 载荷：{type: 'manifest-registered'|'manifest-removed', id}
     */
    onChanged: function (cb) {
      if (typeof cb !== 'function') return function () {}
      listeners.push(cb)
      return function () {
        var i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
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

    // 聚合：声明 settingsTab 的插件（插件市场需要把 tab 收回；与 plugin-nav 的收集口径一致）
    settingsTabs: function () {
      var out = []
      for (var id in manifests) {
        var m = manifests[id]
        if (m && m.settingsTab) out.push({ agentId: id, tab: m.settingsTab })
      }
      out.sort(function (a, b) { return (a.tab.order || 100) - (b.tab.order || 100) })
      return out
    },
  }

  window.__mioPluginRegistry = registry
})()
