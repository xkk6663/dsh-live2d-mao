/**
 * 7.1 验收：`agent/assistant-stream` 逐 token
 *
 * 关键断言：
 *   - `text-chunks` 帧被正确解析，`dt.length === texts.length - 1` 校验生效；
 *   - **`reasoning-chunks` 一律不外发**（推理草稿进气泡是明确越界）；
 *   - `tool-call-chunks` / `block-start` / `usage` / `finish` 不外发；
 *   - `block-end` + `block.type==='text'` 提供权威全文用于零丢字校正；
 *   - 畸形帧不抛、不误发。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseStreamFrame,
  createStreamAssembler,
  totalMsOf,
  ALLOWED_FRAMES,
} from '../lib/stream.js'

test('7.1 · ALLOWED_FRAMES 白名单只含 text-chunks（正文）', () => {
  assert.deepEqual([...ALLOWED_FRAMES], ['text-chunks'])
})

test('7.1 · text-chunks 帧被解析为可外发载荷', () => {
  const p = parseStreamFrame({
    type: 'text-chunks', time0: 1000, index: 0, dt: [10, 20], texts: ['你', '好', '世界'],
  }, { session: 's1', turn: 1, step: 2, seq: 9 })

  assert.equal(p.frame, 'text-chunks')
  assert.equal(p.session, 's1')
  assert.equal(p.turn, 1)
  assert.equal(p.step, 2)
  assert.equal(p.seq, 9)
  assert.equal(p.time0, 1000)
  assert.deepEqual(p.dt, [10, 20])
  assert.deepEqual(p.texts, ['你', '好', '世界'])
  assert.equal(p.final_text, '你好世界')
  assert.equal(p.total_ms, 30)
})

test('7.1 · ★ reasoning-chunks 必须被丢弃（推理草稿不得进气泡）', () => {
  const p = parseStreamFrame({
    type: 'reasoning-chunks', time0: 1000, index: 0, dt: [5], texts: ['让我', '想想'],
  }, { session: 's1' })
  assert.equal(p, null, 'reasoning-chunks 必须返回 null（不外发）')
})

test('7.1 · ★ tool-call-chunks 必须被丢弃（不属正文）', () => {
  const p = parseStreamFrame({
    type: 'tool-call-chunks', time0: 1, index: 0, dt: [1], id: 'c1', name: 'pwsh', args: ['a', 'b'],
  }, { session: 's1' })
  assert.equal(p, null)
})

test('7.1 · 未知帧类型被丢弃（白名单，不是黑名单）', () => {
  for (const type of ['something-new', 'REASONING-CHUNKS', 'text_chunks', '', null, undefined]) {
    assert.equal(parseStreamFrame({ type, time0: 1, index: 0, dt: [], texts: ['x'] }, {}), null,
      `${String(type)} 不该被外发`)
  }
})

test('7.1 · dt.length 必须 === texts.length - 1（契约校验，源码 :437-439 同一断言）', () => {
  // 合法：3 块 → 2 个间隔
  assert.notEqual(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [1, 2], texts: ['a', 'b', 'c'] }, {}), null)
  // 非法：dt 少一个（帧被截断）→ 宁可不发，也不要时间轴错乱的打字机
  assert.equal(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['a', 'b', 'c'] }, {}), null)
  // 非法：dt 多一个
  assert.equal(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [1, 2, 3], texts: ['a', 'b'] }, {}), null)
  // 合法：1 块 → 0 个间隔
  assert.notEqual(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['only'] }, {}), null)
})

test('7.1 · time0 非安全整数 → 丢弃（时间轴不可信）', () => {
  for (const time0 of [null, undefined, 1.5, NaN, '1000', Infinity]) {
    assert.equal(parseStreamFrame({ type: 'text-chunks', time0, index: 0, dt: [], texts: ['x'] }, {}), null,
      `time0=${String(time0)} 应被丢弃`)
  }
})

test('7.1 · dt 含非法间隔 → 过滤后长度不符则丢弃', () => {
  // dt 里混入非整数 → 过滤掉后长度变成 0，而 texts 有 2 块 → 不满足契约 → 丢弃
  assert.equal(parseStreamFrame({
    type: 'text-chunks', time0: 1, index: 0, dt: ['x'], texts: ['a', 'b'],
  }, {}), null)
  // 但如果是安全的混合（2 个 dt，其中 1 个非法）→ 过滤后 1 个，texts 2 块 → 合规？
  // 不：契约要求 dt.length === texts.length - 1，过滤后 1 === 1 → 合规，保留
  const p = parseStreamFrame({
    type: 'text-chunks', time0: 1, index: 0, dt: [7, 'bad'], texts: ['a', 'b'],
  }, {})
  assert.notEqual(p, null)
  assert.deepEqual(p.dt, [7])
})

test('7.1 · 空 texts / 非数组 texts → 丢弃', () => {
  assert.equal(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [] }, {}), null)
  assert.equal(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: 'abc' }, {}), null)
  assert.equal(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [] }, {}), null)
})

test('7.1 · block-end(text) 提供权威全文，用于零丢字校正', () => {
  const p = parseStreamFrame({
    type: 'chunk', time: 2000, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '完整正文' } },
  }, { session: 's1' })
  assert.equal(p.frame, 'block-end')
  assert.equal(p.final_text, '完整正文')
  assert.equal(p.time0, 2000)
})

test('7.1 · ★ block-end(reasoning) 必须被丢弃（不能靠 block-end 夹带推理）', () => {
  const p = parseStreamFrame({
    type: 'chunk', time: 2000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '我的推理' } },
  }, { session: 's1' })
  assert.equal(p, null)
})

test('7.1 · block-end(tool-call) / block-start / usage / finish 一律不外发', () => {
  const cases = [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' } },
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'usage', inputTokens: 1 },
    { type: 'finish', reason: 'stop' },
  ]
  for (const chunk of cases) {
    assert.equal(parseStreamFrame({ type: 'chunk', time: 1, chunk }, {}), null,
      `${chunk.type} 不该外发`)
  }
})

test('7.1 · 空 block-end 文本不外发', () => {
  assert.equal(parseStreamFrame({
    type: 'chunk', time: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
  }, {}), null)
})

test('7.1 · 畸形帧不抛（帧形状不由我们控制）', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { type: 'text-chunks' }, { type: 'chunk' },
    { type: 'chunk', chunk: null }, { type: 'chunk', chunk: {} }]) {
    assert.doesNotThrow(() => parseStreamFrame(bad, {}))
    assert.equal(parseStreamFrame(bad, {}), null)
  }
})

test('7.1 · totalMsOf 求 dt 之和', () => {
  assert.equal(totalMsOf([1, 2, 3]), 6)
  assert.equal(totalMsOf([]), 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 装配器：增量 + 权威全文校正
// ─────────────────────────────────────────────────────────────────────────────

test('7.1 · 装配器累积增量正文', () => {
  const a = createStreamAssembler()
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['你'] }, { session: 's1' }))
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['好'] }, { session: 's1' }))
  assert.equal(a.finalText('s1'), '你好')
})

test('7.1 · ★ 权威全文覆盖增量（零丢字校正）', () => {
  const a = createStreamAssembler()
  // 模拟增量丢了一块
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['你好'] }, { session: 's1' }))
  // 权威全文到达 → 应覆盖
  a.push(parseStreamFrame({
    type: 'chunk', time: 9, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '你好世界' } },
  }, { session: 's1' }))
  assert.equal(a.finalText('s1'), '你好世界', '权威全文必须覆盖增量')
})

test('7.1 · 装配器按 session 隔离，不串账', () => {
  const a = createStreamAssembler()
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['AAA'] }, { session: 's1' }))
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['BBB'] }, { session: 's2' }))
  assert.equal(a.finalText('s1'), 'AAA')
  assert.equal(a.finalText('s2'), 'BBB')
})

test('7.1 · reset 清空指定会话', () => {
  const a = createStreamAssembler()
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['x'] }, { session: 's1' }))
  a.reset('s1')
  assert.equal(a.finalText('s1'), '')
})

test('7.1 · 装配器有长度上限（防内存无界）', () => {
  const a = createStreamAssembler({ maxChars: 10 })
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['12345'] }, { session: 's1' }))
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['67890'] }, { session: 's1' }))
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['XXXXX'] }, { session: 's1' }))
  assert.equal(a.finalText('s1'), '1234567890', '超上限不再累积')
})

test('7.1 · 未知名 session 的 finalText 返回空串（不是 undefined）', () => {
  const a = createStreamAssembler()
  assert.equal(a.finalText('nope'), '')
  assert.equal(a.finalText(null), '')
})

test('7.1 · snapshot 只读诊断', () => {
  const a = createStreamAssembler()
  a.push(parseStreamFrame({ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['abc'] }, { session: 's1' }))
  const snap = a.snapshot()
  assert.equal(snap.length, 1)
  assert.equal(snap[0].session_id, 's1')
  assert.equal(snap[0].chars, 3)
})
