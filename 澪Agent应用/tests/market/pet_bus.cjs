/* pet_bus.cjs — 桌宠渲染端：plugin-bus 热插拔在真浏览器里的表现 */
const { chromium } = require('playwright')
const cfg = require('./_config.cjs')
const BASE = cfg.BASE

let pass = 0, fail = 0
function check(n, ok, d) {
  if (ok) { pass++; console.log('  [OK]   ' + n) }
  else { fail++; console.log('  [FAIL] ' + n + (d ? ' — ' + d : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await cfg.assertBackend()
  const b = await chromium.launch(cfg.launchOptions())
  const p = await b.newPage()
  await p.goto(BASE + '/agent-app/live2d-pet/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(3000)

  console.log('=== 桌宠渲染端 plugin-bus ===')
  const bus = await p.evaluate(() => (window.__mioPluginBus ? window.__mioPluginBus._debug() : null))
  check('__mioPluginBus 存在', !!bus)
  if (bus) console.log('    ' + JSON.stringify(bus))

  const hasUnregister = await p.evaluate(() => typeof window.__mioPluginBus.unregister === 'function')
  check('plugin-bus 有 unregister()', hasUnregister)
  const hasSync = await p.evaluate(() => typeof window.__mioPluginBus.syncCatalog === 'function')
  check('plugin-bus 有 syncCatalog()', hasSync)
  const hasLoad = await p.evaluate(() => typeof window.__mioPluginBus.loadCatalog === 'function')
  check('plugin-bus 有 loadCatalog()', hasLoad)

  console.log('\n=== 下架/停用后菜单条目同步收敛 ===')
  // 注册一个带菜单的临时插件，然后从清单层面"下架"，看 syncCatalog 是否把它清掉
  const result = await p.evaluate(async () => {
    const bus = window.__mioPluginBus
    let unmounted = false
    bus.register({
      id: 'menutest', agentId: 'menutest', name: '菜单测试',
      menuItems: [{ action: 'menutest-act', label: '菜单测试项', order: 5 }],
      onMount() {}, onUnmount() { unmounted = true },
    })
    bus.updateAgents([{ agent_id: 'menutest', enabled: true }])
    const before = bus.getMenuItems().map((m) => m.action)
    // 模拟清单里没有它 → 应被 unregister
    const removed = bus.syncCatalog({ plugins: [] })
    const after = bus.getMenuItems().map((m) => m.action)
    const stillAction = bus.isPluginAction('menutest-act')
    return { before, removed, after, stillAction, unmounted }
  })
  check('注册后菜单里出现该条目', result.before.includes('menutest-act'), JSON.stringify(result.before))
  check('syncCatalog(空清单) 把它卸掉', result.removed.includes('menutest'), JSON.stringify(result.removed))
  check('卸掉后菜单条目消失', !result.after.includes('menutest-act'), JSON.stringify(result.after))
  check('isPluginAction 不再认它', result.stillAction === false)
  check('调用了 onUnmount', result.unmounted === true)

  console.log('\n=== 后端不可达时 fail-safe ===')
  const fs = await p.evaluate(async () => {
    const bus = window.__mioPluginBus
    bus.register({ id: 'keepme', agentId: 'keepme', name: '保留', menuItems: [{ action: 'keep-act', label: '保留项', order: 1 }], onMount() {}, onUnmount() {} })
    bus.updateAgents([{ agent_id: 'keepme', enabled: true }])
    const before = bus.getMenuItems().map((m) => m.action)
    // 临时把 fetch 打挂
    const orig = window.fetch
    window.fetch = () => Promise.reject(new Error('offline'))
    await bus.loadCatalog()
    window.fetch = orig
    const after = bus.getMenuItems().map((m) => m.action)
    return { before, after }
  })
  check('离线时不清空已挂载插件的菜单',
    fs.before.length === fs.after.length && fs.after.includes('keep-act'),
    JSON.stringify(fs))

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
  await b.close()
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.log('ERR', e.message); process.exit(2) })
