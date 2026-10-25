/* run-all.cjs — 一键跑插件市场的全部回归
 *
 * 跑法（后端必须先起着）：
 *   NODE_PATH=<有 playwright 的 node_modules> node 澪Agent应用/tests/market/run-all.cjs
 *
 * 说明：
 *   · market_panel_harness.cjs 是假 DOM 单测，**不需要**浏览器也不需要后端；
 *   · 其余四个是真浏览器 + 真后端，会真的启停插件、上架/下架临时插件。
 *   · 临时插件目录由各脚本自己清理（含中途失败），跑完 dist/plugins/ 应与跑前一致。
 */
'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')
const cfg = require('./_config.cjs')

const SUITES = [
  { file: 'market_panel_harness.cjs', needsBackend: false, note: '假 DOM 单测' },
  { file: 'ui_closure.cjs', needsBackend: true, note: 'UI 闭环（装载/启停/上架/下架）' },
  { file: 'nav_modes.cjs', needsBackend: true, note: 'own/host 两种 nav 模式往返' },
  { file: 'ui_form.cjs', needsBackend: true, note: '上架表单真实交互' },
  { file: 'pet_bus.cjs', needsBackend: true, note: '桌宠渲染端热插拔' },
]

function run(file) {
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env: process.env,
    cwd: __dirname,
  })
  return res.status === 0
}

;(async () => {
  // playwright 不在默认解析路径时，提前说清楚怎么跑（而不是让第一个用例抛 MODULE_NOT_FOUND）
  try {
    require.resolve('playwright')
  } catch (e) {
    console.error(
      '\n找不到 playwright。请用 NODE_PATH 指向装它的 node_modules，例如：\n' +
      '  NODE_PATH=<repo>/澪Agent应用/node_modules node 澪Agent应用/tests/market/run-all.cjs\n'
    )
    process.exit(2)
  }

  const results = []
  for (const s of SUITES) {
    console.log('\n' + '#'.repeat(68))
    console.log('# ' + s.file + '  —— ' + s.note)
    console.log('#'.repeat(68))
    if (s.needsBackend) {
      try {
        await cfg.assertBackend()
      } catch (e) {
        console.error(String(e.message))
        results.push({ file: s.file, ok: false, skipped: true })
        continue
      }
    }
    results.push({ file: s.file, ok: run(s.file) })
  }

  console.log('\n' + '='.repeat(68))
  console.log('汇总')
  console.log('='.repeat(68))
  let bad = 0
  for (const r of results) {
    const mark = r.skipped ? '跳过（后端未起）' : r.ok ? '通过' : '失败'
    if (!r.ok) bad++
    console.log('  ' + (r.ok ? '[OK]  ' : '[FAIL]') + ' ' + r.file.padEnd(26) + mark)
  }
  process.exit(bad === 0 ? 0 : 1)
})()
