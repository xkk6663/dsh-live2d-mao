// clean-build.mjs — 构建前清空 dist-build，避免"已删除的代码仍然被打包"。
//
// ────────────────────────────────────────────────────────────────────────────
// 为什么需要这个脚本（真实踩到的坑）
// ────────────────────────────────────────────────────────────────────────────
// `vite build` **不会**清空 outDir（当 outDir 在项目根之外时尤甚；本项目
// outDir = dist-build，位于 澪Agent应用 下但不在 vite 的默认清理范围内），
// 于是每次构建只是**往旧目录里追加**新 hash 的 chunk：
//
//   dist-build/assets/
//     index-D9kb897a.js   ← 本次新产物
//     index-DXHDsGOF.js   ← 上一次的残留
//     ChatPage-eSMcwBsw.js← 源码里 ChatPage.vue **已被删除**，但这个 chunk 还在
//
// compose-dist 随后会把整个 dist-build/assets 拷进 dist/assets，
// 于是**已经被删掉的代码（含小智相关逻辑）继续随产物发布**。
// 表现就是：源码里明明删干净了，dist 里还能搜到 /api/xiaozhi/*。
//
// 清理是幂等的、只作用于 dist-build（构建中间目录，随时可重建），
// 绝不会碰 dist/ —— 那里面还有 PROTECTED 的手写注入层。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const BUILD = path.join(APP, 'dist-build')

// 安全断言：目标必须确实叫 dist-build 且位于本项目内，避免误删
if (path.basename(BUILD) !== 'dist-build' || !BUILD.startsWith(APP + path.sep)) {
  console.error(`✗ 拒绝清理可疑路径：${BUILD}`)
  process.exit(2)
}

if (fs.existsSync(BUILD)) {
  let before = 0
  try { before = fs.readdirSync(path.join(BUILD, 'assets')).length } catch { before = 0 }
  // Windows 上常见文件句柄占用（编辑器索引、杀软扫描、上一轮 vite 进程未完全退出），
  // fs.rmSync 会**静默失败**（force:true 吞掉 ENOENT，但 EBUSY/EPERM 也可能没删干净）。
  // 故：带重试删，并且**删完必须复核** —— 不能像初版那样打印"已清空"却留着旧文件
  // （那正是"删掉的代码仍被打包"的成因，必须大声失败而不是假装成功）。
  let lastError = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      fs.rmSync(BUILD, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } catch (error) {
      lastError = error
    }
    if (!fs.existsSync(BUILD)) break
    // 退避 150ms * attempt
    const wait = 150 * attempt
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
  }
  if (fs.existsSync(BUILD)) {
    const left = (() => {
      try { return fs.readdirSync(path.join(BUILD, 'assets')).length } catch { return -1 }
    })()
    console.error('✗ clean-build：dist-build 未能删除（仍有 ' + left + ' 个 assets）')
    if (lastError) console.error('  最后一次错误：' + lastError.message)
    console.error('  常见原因：有进程占用这些文件（编辑器索引/杀毒软件/未退出的 vite）。')
    console.error('  请关闭占用后重试，或手动删除：' + BUILD)
    process.exit(3)
  }
  console.log(`clean-build：已清空 ${path.relative(APP, BUILD) || 'dist-build'}（原 ${before} 个 assets，已复核）`)
} else {
  console.log('clean-build：dist-build 不存在，无需清理')
}
