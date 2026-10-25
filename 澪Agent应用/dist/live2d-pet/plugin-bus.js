/* plugin-bus.js — 桌宠前端插件总线
 * 核心职责：agent enabled 状态 → 插件 mount/unmount（即插即用），动态菜单聚合。
 * 设计：
 *   - 插件 manifest: { id, agentId, name, menuItems:[{action,label,order}], onMount(ctx), onUnmount() }
 *   - 状态源：后端 /api/companion/agents 快照（含 enabled），由渲染层 fetchAgentsSnapshot/applyAgentStatus 同步进来
 *   - 菜单：核心层打开右键菜单时调用 getMenuItems() 只渲染"已挂载插件"声明的条目
 *   - 清单：复用市场同一份 GET /api/plugin/market/catalog（契约 §4），
 *     只用来决定"哪些插件还该存在"，**不参与 <script> 注入**（渲染端不建第二套加载器）
 */
(function () {
  if (window.__mioPluginBus) return

  const plugins = new Map()       // id -> manifest
  const mounted = new Set()       // 已挂载插件 id
  const agentEnabled = new Map()  // agentId -> boolean
  const menuEntries = new Map()   // action -> { pluginId, label, order }
  let menuListener = null
  let catalogIds = null           // 最近一次合法 catalog 里的插件 id 集合（null = 还没拿到过）
  let catalogState = 'idle'       // idle | loaded | failed

  const CATALOG_URL = '/api/plugin/market/catalog'

  function notifyMenu() {
    try { if (menuListener) menuListener() } catch (_) {}
  }

  // 从 menuEntries 摘掉某插件的全部条目（返回移除条数）
  // 必须先于 unmount：否则反注册后 getMenuItems() 仍按旧 pluginId 命中 isPluginAction，
  // 核心层会把这些 action 判成"插件项"却又找不到归属，菜单项就永远藏在 hidden 里。
  function dropMenuEntries(pluginId) {
    let n = 0
    for (const [action, entry] of menuEntries) {
      if (entry && entry.pluginId === pluginId) { menuEntries.delete(action); n += 1 }
    }
    return n
  }

  const bus = {
    register(manifest) {
      if (!manifest || !manifest.id) return
      // 同名 id 重注册：先清掉上一版声明的菜单条目，避免新旧 label/order 叠加
      dropMenuEntries(manifest.id)
      plugins.set(manifest.id, manifest)
      if (Array.isArray(manifest.menuItems)) {
        for (const item of manifest.menuItems) {
          if (!item || !item.action) continue
          menuEntries.set(item.action, {
            pluginId: manifest.id,
            label: item.label,
            order: Number(item.order) || 0,
          })
        }
      }
      // 注册时若对应 agent 已启用则立即挂载（适用于插件脚本后于状态到达的场景）
      if (manifest.agentId && agentEnabled.get(String(manifest.agentId)) === true) {
        bus.mount(manifest.id)
      }
      notifyMenu()
    },

    // 卸载并抹掉注册痕迹：plugins / menuEntries 一并删除，最后 notifyMenu。
    // 与 unmount 的区别：unmount 只是"临时下线"（enabled=false，重启即回），
    // unregister 是"这个插件不存在了"（下架/删除），菜单与核心层判定都不能再认它。
    unregister(id) {
      const pluginId = String(id || '')
      if (!pluginId || !plugins.has(pluginId)) return false
      bus.unmount(pluginId)                    // 内部已 notifyMenu（若确实挂着）
      dropMenuEntries(pluginId)
      plugins.delete(pluginId)
      notifyMenu()
      return true
    },

    // 全量同步：agents 快照 [{agent_id, name, status, enabled, phase, active}]
    updateAgents(agents) {
      if (!Array.isArray(agents)) return
      for (const a of agents) {
        if (!a || !a.agent_id) continue
        if (a.enabled !== undefined) agentEnabled.set(String(a.agent_id), a.enabled !== false)
      }
      reconcile()
    },

    // 增量同步：单个 agent 状态变化（socket agent_status）
    setAgentEnabled(agentId, enabled) {
      if (!agentId || enabled === undefined) return
      agentEnabled.set(String(agentId), Boolean(enabled))
      reconcile()
    },

    // 按市场清单收敛：清单里没有（下架）、或 enabled:false 且非 builtin 的插件 → unregister。
    // 只处理"本渲染端已注册"的插件；幂等，可反复调用。
    syncCatalog(catalog) {
      const pluginsList = catalog && Array.isArray(catalog.plugins) ? catalog.plugins : null
      if (!pluginsList) return []              // 非法 body：什么都不做（fail-safe）
      const alive = new Set()
      catalogIds = new Set()
      for (const p of pluginsList) {
        if (!p || !p.id) continue
        const pid = String(p.id)
        catalogIds.add(pid)
        if (p.builtin === true || p.enabled !== false) alive.add(pid)
      }
      catalogState = 'loaded'
      const removed = []
      for (const id of [...plugins.keys()]) {
        if (alive.has(id)) continue
        if (bus.unregister(id)) removed.push(id)
      }
      return removed
    },

    // GET 市场清单 → syncCatalog。**只有 200 + 合法 body 才动手删插件**：
    // 后端未起 / 接口 404 / 返回格式不对时，宁可保持现状也绝不把已挂载插件的菜单清空。
    async loadCatalog() {
      if (typeof fetch !== 'function') return null
      try {
        const res = await fetch(CATALOG_URL, { headers: { Accept: 'application/json' } })
        if (!res || res.ok !== true) {
          catalogState = 'failed'
          console.warn('[plugin-bus] catalog 不可用，保持现状', res && res.status)
          return null
        }
        const body = await res.json()
        if (!body || !Array.isArray(body.plugins)) {
          catalogState = 'failed'
          console.warn('[plugin-bus] catalog 响应缺少 plugins 数组，保持现状')
          return null
        }
        return bus.syncCatalog(body)
      } catch (err) {
        catalogState = 'failed'
        console.warn('[plugin-bus] catalog 拉取失败，保持现状', err && err.message || err)
        return null
      }
    },

    isMounted(pluginId) { return mounted.has(pluginId) },
    isAgentEnabled(agentId) { return agentEnabled.get(String(agentId)) === true },

    // 菜单聚合：仅返回"已挂载插件"声明的条目（核心层据此隐藏未启用插件的 UI 入口）
    getMenuItems() {
      const items = []
      for (const [action, entry] of menuEntries) {
        if (!mounted.has(entry.pluginId)) continue
        items.push({ action, label: entry.label, order: entry.order })
      }
      items.sort((a, b) => a.order - b.order)
      return items
    },

    // 某 action 是否属于插件声明条目（核心层用于区分核心菜单项/插件菜单项）
    isPluginAction(action) { return menuEntries.has(action) },

    onMenuChanged(cb) { menuListener = cb },

    mount(pluginId) {
      const manifest = plugins.get(pluginId)
      if (!manifest || mounted.has(pluginId)) return
      mounted.add(pluginId)
      try {
        if (manifest.onMount) manifest.onMount({ bus, pluginId })
      } catch (err) {
        console.error('[plugin-bus] mount error', pluginId, err && err.message || err)
      }
      notifyMenu()
    },

    unmount(pluginId) {
      if (!mounted.has(pluginId)) return
      mounted.delete(pluginId)
      try {
        const manifest = plugins.get(pluginId)
        if (manifest && manifest.onUnmount) manifest.onUnmount()
      } catch (err) {
        console.error('[plugin-bus] unmount error', pluginId, err && err.message || err)
      }
      notifyMenu()
    },

    _debug() {
      return {
        plugins: [...plugins.keys()],
        mounted: [...mounted],
        agents: [...agentEnabled.entries()].map(([k, v]) => `${k}=${v ? 'on' : 'off'}`),
        catalog: { state: catalogState, ids: catalogIds ? [...catalogIds] : null },
      }
    },
  }

  function reconcile() {
    for (const [id, manifest] of plugins) {
      const on = manifest.agentId
        ? agentEnabled.get(String(manifest.agentId)) === true
        : true
      if (on && !mounted.has(id)) bus.mount(id)
      else if (!on && mounted.has(id)) bus.unmount(id)
    }
  }

  window.__mioPluginBus = bus
})()
