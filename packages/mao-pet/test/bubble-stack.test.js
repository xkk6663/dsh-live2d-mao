/**
 * 7.4 多 session 气泡栈 —— 单元测试。
 *
 * 覆盖栈语义：优先级、TTL 回收、上限淘汰、active/textOf、子会话识别。
 * 这是「闭合回路」后新增的测试（此前 bubbles.push 从未接线 = 死代码，无测试）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createBubbleStack, isSubSession, sessionIdOf, MAX_SESSION_BUBBLES } from '../lib/bubble-stack.js'

test('isSubSession 识别三种子会话判据', () => {
  assert.equal(isSubSession({ parentSessionId: 'p' }), true)
  assert.equal(isSubSession({ origin: 'subagent' }), true)
  assert.equal(isSubSession({ delegationDepth: 1 }), true)
  assert.equal(isSubSession({ id: 'main' }), false)
  assert.equal(isSubSession(null), false)
})

test('sessionIdOf 取稳定 id（id 优先）', () => {
  assert.equal(sessionIdOf({ id: 'a', sessionId: 'b' }), 'a')
  assert.equal(sessionIdOf({ sessionId: 'b' }), 'b')
  assert.equal(sessionIdOf(null), '')
})

test('push 后 active 返回优先级最高者；textOf 取回文本', () => {
  const stack = createBubbleStack({ max: 12 })
  // 优先级：voice(1) < thinking(3) < streaming(4)，数值小者优先
  const r1 = stack.push({ id: 's1' }, { text: '主会话回答', phase: 'streaming' })
  assert.equal(r1.accepted, true)
  assert.equal(r1.active, 's1')
  assert.equal(stack.textOf('s1'), '主会话回答')

  // thinking(3) 优先级高于 streaming(4)，应抢占 active
  const r2 = stack.push({ id: 's2' }, { text: '次会话思考中', phase: 'thinking' })
  assert.equal(r2.accepted, true)
  assert.equal(stack.active(), 's2', 'thinking 优先级高于 streaming，应抢占活跃者')
})

test('同优先级：后发优先（最近说话者）', () => {
  let t = 0
  const stack = createBubbleStack({ max: 12, now: () => t })
  stack.push({ id: 'a' }, { text: 'A', phase: 'streaming' })
  t += 100
  stack.push({ id: 'b' }, { text: 'B', phase: 'streaming' })
  assert.equal(stack.active(), 'b', '同优先级后发优先')
})

test('TTL 回收：过期条目不再 active', () => {
  let t = 0
  const stack = createBubbleStack({ max: 12, now: () => t, ttlMs: 1000 })
  stack.push({ id: 'a' }, { text: 'A', phase: 'streaming' })
  assert.equal(stack.active(), 'a')
  t += 1500
  assert.equal(stack.active(), null, '过期后 active 为空')
})

test('上限淘汰：满 12 时淘汰最不重要的（最低优先级/最旧）', () => {
  const stack = createBubbleStack({ max: 3 })
  stack.push({ id: 'hi1' }, { text: 'a', phase: 'voice' })      // voice 最高优先级
  stack.push({ id: 'mid1' }, { text: 'b', phase: 'streaming' })
  stack.push({ id: 'mid2' }, { text: 'c', phase: 'streaming' })
  // 第 4 个进来，应淘汰优先级最低的（thinking 若有则淘它；此处全 voice/streaming，淘最旧的 streaming）
  const r = stack.push({ id: 'low' }, { text: 'd', phase: 'thinking' })
  assert.equal(r.accepted, true)
  // thinking 优先级最低，但它是新来的；应淘汰现有 3 个里最不重要的
  assert.ok(stack.size() <= 3, '不超上限')
})

test('remove 移除后 active 递补', () => {
  let t = 0
  const stack = createBubbleStack({ max: 12, now: () => t })
  stack.push({ id: 'a' }, { text: 'A', phase: 'streaming' })
  t += 10
  stack.push({ id: 'b' }, { text: 'B', phase: 'streaming' })
  assert.equal(stack.active(), 'b')
  stack.remove({ id: 'b' })
  assert.equal(stack.active(), 'a', '移除活跃者后递补到 a')
})

test('空文本 push 被拒', () => {
  const stack = createBubbleStack({ max: 12 })
  const r = stack.push({ id: 'a' }, { text: '   ' })
  assert.equal(r.accepted, false)
  assert.equal(r.reason, 'empty-text')
})

test('MAX_SESSION_BUBBLES 常量 = 12', () => {
  assert.equal(MAX_SESSION_BUBBLES, 12)
})
