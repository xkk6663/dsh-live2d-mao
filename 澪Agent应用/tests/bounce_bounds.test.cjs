/**
 * 桌宠边界反弹逻辑的单元测试（不依赖浏览器/Electron）。
 *
 * 被测逻辑从 live2d-pet.js 里原样抄出来（那两段是纯函数，无副作用），
 * 保证测的就是线上跑的那套算法。若将来改了实现，记得同步这里。
 *
 * 覆盖：
 *   1. 目标尺寸与边界计算
 *   2. 左/右/上/下四个方向的反弹（速度反向 + 位置钳回）
 *   3. 撞角（两轴同时反弹）
 *   4. 能量损耗（反弹后速度变小，不会永动）
 *   5. 边界内不动（不误伤）
 *   6. 模拟完整甩出过程：不会跑出可视区
 *   7. 极小屏兜底（模型比屏大时不产生 min>max）
 */
const assert = require('node:assert')

// ── 被测实现（与 live2d-pet.js 保持一致）────────────────────────────────
function targetSize(percent = 150) {
  const p = Number(percent) / 100
  return { width: 280 * p, height: 400 * p }
}

function petBounds(sizePercent = 150, vw = 1920, vh = 1080) {
  const t = targetSize(sizePercent)
  const halfW = t.width / 2
  const halfH = t.height / 2
  return {
    minX: Math.min(halfW, vw / 2),
    maxX: Math.max(vw - halfW, vw / 2),
    minY: Math.min(halfH, vh / 2),
    maxY: Math.max(vh - halfH, vh / 2),
  }
}

function bounceIntoBounds(pos, vel, bounds) {
  const RESTITUTION = 0.62
  let x = pos.x, y = pos.y, vx = vel.vx, vy = vel.vy, bounced = false
  if (x < bounds.minX) { x = bounds.minX; vx = Math.abs(vx) * RESTITUTION; bounced = true }
  else if (x > bounds.maxX) { x = bounds.maxX; vx = -Math.abs(vx) * RESTITUTION; bounced = true }
  if (y < bounds.minY) { y = bounds.minY; vy = Math.abs(vy) * RESTITUTION; bounced = true }
  else if (y > bounds.maxY) { y = bounds.maxY; vy = -Math.abs(vy) * RESTITUTION; bounced = true }
  return { pos: { x, y }, vel: { vx, vy }, bounced }
}

// ── 测试 ─────────────────────────────────────────────────────────────────
let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); console.log(`  [OK]   ${name}`); pass += 1 }
  catch (e) { console.log(`  [FAIL] ${name}\n         ${e.message}`); fail += 1 }
}

console.log('\n[1] 目标尺寸与边界')
t('默认 150% → 420x600', () => {
  const s = targetSize(150)
  assert.strictEqual(s.width, 420)
  assert.strictEqual(s.height, 600)
})
t('1920x1080 屏的合法中心范围', () => {
  const b = petBounds(150, 1920, 1080)
  assert.strictEqual(b.minX, 210)   // 宽 420 的一半
  assert.strictEqual(b.maxX, 1710)  // 1920 - 210
  assert.strictEqual(b.minY, 300)   // 高 600 的一半
  assert.strictEqual(b.maxY, 780)   // 1080 - 300
})

console.log('\n[2] 四方向反弹')
const b = petBounds(150, 1920, 1080)
t('撞左边界 → x 钳回、vx 变正', () => {
  const r = bounceIntoBounds({ x: 100, y: 500 }, { vx: -800, vy: 0 }, b)
  assert.strictEqual(r.pos.x, b.minX)
  assert.ok(r.vel.vx > 0, 'vx 应反向为正')
  assert.strictEqual(r.bounced, true)
})
t('撞右边界 → x 钳回、vx 变负', () => {
  const r = bounceIntoBounds({ x: 1900, y: 500 }, { vx: 900, vy: 0 }, b)
  assert.strictEqual(r.pos.x, b.maxX)
  assert.ok(r.vel.vx < 0, 'vx 应反向为负')
})
t('撞上边界 → y 钳回、vy 变正', () => {
  const r = bounceIntoBounds({ x: 900, y: 50 }, { vx: 0, vy: -700 }, b)
  assert.strictEqual(r.pos.y, b.minY)
  assert.ok(r.vel.vy > 0)
})
t('撞下边界 → y 钳回、vy 变负', () => {
  const r = bounceIntoBounds({ x: 900, y: 1050 }, { vx: 0, vy: 800 }, b)
  assert.strictEqual(r.pos.y, b.maxY)
  assert.ok(r.vel.vy < 0)
})

console.log('\n[3] 撞角（两轴同时）')
t('右上角 → vx 与 vy 都反向', () => {
  const r = bounceIntoBounds({ x: 1900, y: 50 }, { vx: 850, vy: -750 }, b)
  assert.strictEqual(r.pos.x, b.maxX)
  assert.strictEqual(r.pos.y, b.minY)
  assert.ok(r.vel.vx < 0, 'vx 应反向')
  assert.ok(r.vel.vy > 0, 'vy 应反向')
})

console.log('\n[4] 能量损耗（不会永动）')
t('反弹后速度约为原来的 62%', () => {
  const r = bounceIntoBounds({ x: 1900, y: 500 }, { vx: 1000, vy: 0 }, b)
  assert.ok(Math.abs(r.vel.vx) < 1000, '必须损耗能量')
  assert.ok(Math.abs(r.vel.vx) > 0, '不能完全停住（那是"撞墙"不是"反弹"）')
  assert.strictEqual(Math.round(Math.abs(r.vel.vx)), 620)
})
t('连续反弹速度单调递减', () => {
  let vx = 2000
  let x = 1900
  const speeds = []
  for (let i = 0; i < 5; i += 1) {
    const r = bounceIntoBounds({ x, y: 500 }, { vx, vy: 0 }, b)
    vx = r.vel.vx
    x = r.pos.x === b.maxX ? 1899 : 100   // 交替撞两侧
    speeds.push(Math.abs(vx))
  }
  for (let i = 1; i < speeds.length; i += 1) assert.ok(speeds[i] < speeds[i - 1], '应逐次递减')
})

console.log('\n[5] 边界内不动（不误伤）')
t('内部位置与速度原样返回', () => {
  const r = bounceIntoBounds({ x: 900, y: 500 }, { vx: 300, vy: -200 }, b)
  assert.strictEqual(r.pos.x, 900)
  assert.strictEqual(r.pos.y, 500)
  assert.strictEqual(r.vel.vx, 300)
  assert.strictEqual(r.vel.vy, -200)
  assert.strictEqual(r.bounced, false)
})

console.log('\n[6] 模拟完整甩出（用户报障场景）')
t('向右猛甩 60 帧后始终在可视区内', () => {
  let pos = { x: 1200, y: 500 }
  let vel = { vx: 6000, vy: -1500 }   // 用力甩向右上
  let outOfBounds = 0
  for (let i = 0; i < 60; i += 1) {
    const dt = 1 / 60
    const next = bounceIntoBounds(
      { x: pos.x + vel.vx * dt, y: pos.y + vel.vy * dt },
      vel, b,
    )
    pos = next.pos
    vel = { vx: next.vel.vx * 0.92, vy: next.vel.vy * 0.92 }
    if (pos.x < b.minX - 0.01 || pos.x > b.maxX + 0.01 || pos.y < b.minY - 0.01 || pos.y > b.maxY + 0.01) {
      outOfBounds += 1
    }
  }
  assert.strictEqual(outOfBounds, 0, `有 ${outOfBounds} 帧跑出边界`)
  assert.ok(pos.x >= b.minX && pos.x <= b.maxX, '最终应在界内')
  assert.ok(pos.y >= b.minY && pos.y <= b.maxY, '最终应在界内')
})
t('向左猛甩也不会丢', () => {
  let pos = { x: 600, y: 500 }
  let vel = { vx: -9000, vy: 2000 }
  for (let i = 0; i < 60; i += 1) {
    const next = bounceIntoBounds({ x: pos.x + vel.vx / 60, y: pos.y + vel.vy / 60 }, vel, b)
    pos = next.pos
    vel = { vx: next.vel.vx * 0.92, vy: next.vel.vy * 0.92 }
  }
  assert.ok(pos.x >= b.minX && pos.x <= b.maxX)
  assert.ok(pos.y >= b.minY && pos.y <= b.maxY)
})

console.log('\n[7] 极小屏兜底')
t('模型比屏幕还大时 min<=max（不产生反转边界）', () => {
  const tiny = petBounds(200, 300, 200)   // 模型 560x800，屏只有 300x200
  assert.ok(tiny.minX <= tiny.maxX, 'minX 不应大于 maxX')
  assert.ok(tiny.minY <= tiny.maxY, 'minY 不应大于 maxY')
})
t('极小屏上不抛错', () => {
  const tiny = petBounds(200, 300, 200)
  const r = bounceIntoBounds({ x: 0, y: 0 }, { vx: -500, vy: -500 }, tiny)
  assert.ok(Number.isFinite(r.pos.x) && Number.isFinite(r.pos.y))
})

console.log(`\n${'='.repeat(60)}`)
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(60))
process.exit(fail === 0 ? 0 : 1)
