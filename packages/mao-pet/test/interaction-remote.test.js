/**
 * 交互回路远程客户端 —— 单元测试。
 *
 * 覆盖「上报 → 轮询 → resolve」：用 mock fetch 模拟后端三端点。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createInteractionRemote, POLL_MS } from '../lib/push/interaction-remote.js'

/** 构造一个 mock fetch：按 URL+method 返回预设响应。 */
function makeMockFetch(handler) {
  return async (url, opts) => {
    const method = String((opts && opts.method) || 'GET')
    const body = opts && opts.body ? JSON.parse(opts.body) : null
    const res = await handler(url, method, body)
    return {
      ok: res.ok,
      status: res.status || 200,
      json: async () => res.body,
    }
  }
}

test('openApproval：上报成功 → 轮询拿到 outcome → 返回', async () => {
  let openCalled = 0
  let pollCount = 0
  const fetch = makeMockFetch(async (url, method, body) => {
    if (method === 'POST') {
      openCalled += 1
      return { ok: true, status: 200, body: { ok: true, request_id: 'abc123' } }
    }
    // GET 轮询：第 2 次返回已答复
    pollCount += 1
    if (pollCount >= 2) {
      return { ok: true, status: 200, body: { ok: true, answered: true, result: 'allowed-once' } }
    }
    return { ok: true, status: 200, body: { ok: true, answered: false, result: null } }
  })
  const remote = createInteractionRemote({ fetchImpl: fetch, pollMs: 10, maxMs: 5000 })
  const outcome = await remote.openApproval({ tool: 'read' })
  assert.equal(openCalled, 1)
  assert.equal(outcome, 'allowed-once')
})

test('openApproval：后端不可达 → null（fail-closed）', async () => {
  const fetch = makeMockFetch(async () => ({ ok: false, status: 0, body: null }))
  const remote = createInteractionRemote({ fetchImpl: fetch, pollMs: 10, maxMs: 1000 })
  const outcome = await remote.openApproval({ tool: 'read' })
  assert.equal(outcome, null)
})

test('openQuestion：上报成功 → 轮询拿到 answers → 返回', async () => {
  let pollCount = 0
  const fetch = makeMockFetch(async (url, method) => {
    if (method === 'POST') {
      return { ok: true, status: 200, body: { ok: true, request_id: 'q1' } }
    }
    pollCount += 1
    if (pollCount >= 1) {
      return { ok: true, status: 200, body: { ok: true, answered: true, result: [{ id: 'a', selected: ['x'] }] } }
    }
    return { ok: true, status: 200, body: { ok: true, answered: false, result: null } }
  })
  const remote = createInteractionRemote({ fetchImpl: fetch, pollMs: 10, maxMs: 5000 })
  const answers = await remote.openQuestion({ items: [] })
  assert.deepEqual(answers, [{ id: 'a', selected: ['x'] }])
})

test('openApproval：超时 → null', async () => {
  const fetch = makeMockFetch(async (url, method) => {
    if (method === 'POST') return { ok: true, status: 200, body: { ok: true, request_id: 't1' } }
    return { ok: true, status: 200, body: { ok: true, answered: false, result: null } }
  })
  const remote = createInteractionRemote({ fetchImpl: fetch, pollMs: 10, maxMs: 300 })
  const outcome = await remote.openApproval({ tool: 'read' })
  assert.equal(outcome, null)
})

test('无 fetch：方法返回 null，不抛', async () => {
  const remote = createInteractionRemote({ fetchImpl: null })
  assert.equal(await remote.openApproval({ tool: 'read' }), null)
  assert.equal(await remote.openQuestion({ items: [] }), null)
})

test('POLL_MS 常量 = 500', () => {
  assert.equal(POLL_MS, 500)
})
