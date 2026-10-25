/* nav_modes.cjs — 两种 nav.mode 的停用/启用往返回归
 *
 * 为什么单独一个脚本：
 *   - `own` 模式（DSH）：导航按钮由插件自己 append，卸载时该**删除**；
 *   - `host` 模式（大肥鱼）：按钮由原版 Vue 渲染，卸载时只能**隐藏**（铁律 R9，删了回不来）。
 *   这两条路径历史上各挂过一次：
 *     · own  —— 卸载顺序错，manifest 先没了导致关键词读不到；
 *     · host —— 只靠 plugin-nav 按 navRules 显隐，而 navRules 来自 manifest，
 *               manifest 被卸载删掉后"该隐藏的规则"自己就没了，按钮原地不动。
 *   所以两类都必须有真浏览器回归。
 */
const { chromium } = require('playwright')
const cfg = require('./_config.cjs')
const BASE = cfg.BASE

let pass = 0, fail = 0
const failures = []
function check(n, ok, d) {
  if (ok) { pass++; console.log('  [OK]   ' + n) }
  else { fail++; failures.push(n); console.log('  [FAIL] ' + n + (d ? ' — ' + d : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await cfg.assertBackend()
  const b = await chromium.launch(cfg.launchOptions())
  const p = await b.newPage({ viewport: { width: 1880, height: 900 } })
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(BASE + '/agent-app/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(3200)

  // 用「按标题找 nav 按钮」的方式同时覆盖 own / host 两种形态
  const navState = (titlePart) => p.evaluate((t) => {
    const btn = Array.from(document.querySelectorAll('nav.main-nav button.nav-item'))
      .find((x) => (x.getAttribute('title') || '').includes(t))
    if (!btn) return { exists: false, visible: false }
    return {
      exists: true,
      visible: getComputedStyle(btn).display !== 'none',
      hiddenMark: btn.getAttribute('data-mio-plugin-hidden'),
      marked: btn.getAttribute('data-mio-plugin-nav'),
    }
  }, titlePart)

  const clickCardBtn = (agentId, re) => p.evaluate(([id, pat]) => {
    const card = document.querySelector('[data-mio-market-card="' + id + '"]')
    if (!card) return 'no-card'
    const btn = Array.from(card.querySelectorAll('button')).find((x) => new RegExp(pat).test(x.textContent))
    if (!btn) return 'no-btn'
    btn.click()
    return 'clicked'
  }, [agentId, re])

  // 打开市场，保证按钮可点
  await p.click('button[data-mio-plugin-nav="market"]')
  await sleep(1200)

  // ─────────────────── host 模式：大肥鱼 ───────────────────
  console.log('\n=== host 模式（大肥鱼 cloud_feiyu）===')
  let s = await navState('大肥鱼')
  check('初始可见', s.exists && s.visible, JSON.stringify(s))

  await clickCardBtn('cloud_feiyu', '^停用$')
  await sleep(3500)
  s = await navState('大肥鱼')
  check('★ 停用后不可见', !s.visible, JSON.stringify(s))
  check('★ 节点仍在（只隐藏不删，R9）', s.exists === true, JSON.stringify(s))
  check('带 data-mio-plugin-hidden 标记', s.hiddenMark === 'cloud_feiyu', String(s.hiddenMark))

  await clickCardBtn('cloud_feiyu', '^启用$')
  await sleep(3500)
  s = await navState('大肥鱼')
  check('★ 启用后恢复可见', s.exists && s.visible, JSON.stringify(s))
  check('隐藏标记已清除', !s.hiddenMark, String(s.hiddenMark))

  // ─────────────────── own 模式：DSH ───────────────────
  console.log('\n=== own 模式（DSH dsh）===')
  s = await navState('DSH')
  check('初始可见', s.exists && s.visible, JSON.stringify(s))

  await clickCardBtn('dsh', '^停用$')
  await sleep(3500)
  s = await navState('DSH')
  check('★ 停用后不可见', !s.visible, JSON.stringify(s))

  await clickCardBtn('dsh', '^启用$')
  await sleep(3500)
  s = await navState('DSH')
  check('★ 启用后恢复可见', s.exists && s.visible, JSON.stringify(s))

  // ─────────────────── 市场自身常驻 ───────────────────
  console.log('\n=== 市场自身常驻（点别人的开关不该影响它）===')
  const mkt = await p.evaluate(() => {
    const n = document.querySelector('button[data-mio-plugin-nav="market"]')
    const pg = document.getElementById('mio-market-page')
    return {
      nav: !!n && getComputedStyle(n).display !== 'none',
      pageOpen: pg ? getComputedStyle(pg).display !== 'none' : false,
    }
  })
  check('开关若干轮后市场导航仍在', mkt.nav)
  check('开关若干轮后市场页面仍打开', mkt.pageOpen)

  check('全程无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '))

  console.log('\n====================================================================')
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '))
  console.log('====================================================================')
  await b.close()
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.log('ERR', e.message); process.exit(2) })
