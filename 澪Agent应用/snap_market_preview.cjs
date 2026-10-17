/**
 * 给 docs/dsh-market-preview.html 截图（用于人工检查市场展示页观感）。
 *
 * 用法：node tools/snap_market_preview.cjs [宽度] [输出路径]
 * 产出：分段的整页截图（超长页面切成几张，便于逐屏查看）
 */
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')

const WIDTH = Number(process.argv[2] || 900)
const OUT = process.argv[3] || 'docs/market-preview-shot.png'
const ROOT = path.resolve(__dirname, '..')
const TARGET = path.join(ROOT, 'docs', 'dsh-market-preview.html')

async function main() {
  if (!fs.existsSync(TARGET)) {
    throw new Error(`预览文件不存在: ${TARGET}（先跑 python tools/build_market_preview.py）`)
  }
  const browser = await chromium.launch({ channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 1400 }, deviceScaleFactor: 1 })
  await page.goto('file:///' + TARGET.replace(/\\/g, '/'), { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  const height = await page.evaluate(() => document.body.scrollHeight)
  console.log(`页面总高: ${height}px`)

  // 整页截图（Playwright 会自动拼接；太长时仍可用）
  const full = OUT.replace(/\.png$/, '-full.png')
  await page.screenshot({ path: path.join(ROOT, full), fullPage: true })
  console.log('整页截图:', full)

  // 首屏（标题区 + 安装）
  const first = OUT.replace(/\.png$/, '-top.png')
  await page.screenshot({ path: path.join(ROOT, first), clip: { x: 0, y: 0, width: WIDTH, height: Math.min(1400, height) } })
  console.log('首屏截图:', first)

  await browser.close()
}

main().catch((e) => { console.error('截图失败:', e.message); process.exit(1) })

