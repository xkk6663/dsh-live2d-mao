/**
 * 6.5 / 7.x 端到端契约测试：**插件真实推送层 ↔ 后端真实 app**。
 *
 * 与其它测试的区别：其它测试用 mock transport（验证插件侧逻辑），
 * 本测试把插件 `createHttpTransport` 的 `fetchImpl` 换成**直接调 FastAPI TestClient**，
 * 于是走通「插件造信封 → HTTP body → 后端 ingest → agent_bus_service.emit」全链路，
 * **不依赖 8000 端口那个活进程**（它是旧进程，没有 ingest 路由）。
 *
 * 运行前提：后端可 import（`私人AI日记系统/backend` 下能 import app.main），
 * 且装了 fastapi/httpx。**不满足时整组跳过**（不让插件测试因后端环境而红）。
 *
 * ⚠ **本组较慢**（约 80s）：每个断言都要起一个 python 子进程 import 整个 app。
 * 这是刻意的 —— 换来的是"对真实后端行为"的断言，而不是对 mock 的断言。
 * 单独跑：`node --test "test/e2e-ingest.test.js"`；
 * 只要快速反馈可跑：`node --test "test/!(e2e-*).test.js"`（见 package.json 的 test:fast）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHttpTransport } from '../lib/push/transports/http.js'
import { createPusher } from '../lib/push/pusher.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const BACKEND = path.join(REPO_ROOT, '私人AI日记系统', 'backend')
const PY = path.join(BACKEND, '.venv', 'Scripts', 'python.exe')

const quiet = { info: () => {}, warn: () => {}, debug: () => {} }

/**
 * 探测后端可测性：venv 是否存在 + app.main 能否 import。
 * 用一个极小的 python 进程做判断，失败即跳过整组。
 */
function backendReady() {
  try {
    execFileSync(PY, ['-c', 'import app.main; print("ok")'], {
      cwd: BACKEND, stdio: 'pipe', timeout: 60_000,
    })
    return true
  } catch (err) {
    return false
  }
}

const READY = backendReady()

/**
 * 通过 python 子进程把"插件产出的 HTTP body"真打进 TestClient，
 * 再把响应 JSON 带回来。这样 Node 侧就能对**真实后端行为**做断言。
 */
function postToRealApp(urlPath, body, headers = {}) {
  const script = `
import json, sys
from fastapi.testclient import TestClient
from app.main import app
c = TestClient(app)
payload = json.loads(sys.stdin.read())
r = c.post(payload["path"], json=payload["body"], headers=payload["headers"])
out = {"status": r.status_code}
try:
    out["json"] = r.json()
except Exception:
    out["json"] = None
print(json.dumps(out))
`
  const stdin = JSON.stringify({ path: urlPath, body, headers })
  const raw = execFileSync(PY, ['-c', script], {
    cwd: BACKEND, input: stdin, timeout: 120_000, encoding: 'utf8',
  })
  // 后端的 print 可能混入其它输出，取最后一行 JSON
  const lines = String(raw).trim().split(/\r?\n/).filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

/** 造一个"把 fetch 换成真实 TestClient"的 transport。 */
function realTransport() {
  return createHttpTransport({
    baseUrl: 'http://127.0.0.1:8000',
    fetchImpl: async (url, init) => {
      const u = new URL(url)
      const body = JSON.parse(init.body)
      const res = postToRealApp(u.pathname, body, init.headers || {})
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.json,
      }
    },
  })
}

test('6.5·E2E · 后端可测性探测', { skip: !READY && '后端环境不可用（venv / app.main import 失败），跳过端到端组' }, () => {
  assert.equal(READY, true)
})

test('6.5·E2E · ★ 插件真实 phase 信封 → 后端 200，且总线认到 mao-pet', { skip: !READY && '后端不可用' }, async () => {
  const t = realTransport()
  const pusher = createPusher({ transport: t, logger: quiet })

  const r = await pusher.pushPhase('thinking', { tool: 'pwsh', turn: 1 }, { seq: 1 })
  assert.equal(r.ok, true, '真实后端应接受插件信封')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  // ★ 证明后端真的注册并广播了 mao-pet（而不是默默丢弃）
  assert.equal(r.body.agent_id, 'mao-pet')
  assert.equal(r.body.phase, 'thinking')
})

test('6.5·E2E · ★ 12 态逐态打进真实后端，全部 200（无 400/422）', { skip: !READY && '后端不可用' }, async () => {
  const t = realTransport()
  const pusher = createPusher({ transport: t, logger: quiet })
  const phases = [
    'idle', 'planning', 'thinking', 'executing_tool', 'streaming', 'waiting_input',
    'voice', 'complete', 'error', 'paused', 'awaiting_approval', 'heartbeat',
  ]
  for (const p of phases) {
    // force 绕过我们这层的"未变化"节流；逐态都应是新 phase
    const r = await pusher.pushPhase(p, { probe: true }, { force: true })
    assert.equal(r.ok, true, `phase=${p} 应被真实后端接受`)
    assert.equal(r.status, 200, `phase=${p} 应返回 200（收到 ${r.status}）`)
  }
})

test('6.5·E2E · 非法 phase **不会**到达后端（插件侧已拦）', { skip: !READY && '后端不可用' }, async () => {
  const t = realTransport()
  const pusher = createPusher({ transport: t, logger: quiet })
  const r = await pusher.pushPhase('totally_bogus_phase', {})
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unknown-phase')
})

test('6.5·E2E · 真实后端拒绝非法 phase（后端侧防线，400）', { skip: !READY && '后端不可用' }, () => {
  // 绕过插件直接打 → 后端必须自己拒（两侧防线都要在）
  const res = postToRealApp('/api/plugin/dsh/ingest', { phase: 'totally_bogus_phase' })
  assert.equal(res.status, 400, '后端应返回 400 而不是 200')
})

test('6.5·E2E · 缺 phase → 后端 422（契约校验）', { skip: !READY && '后端不可用' }, () => {
  const res = postToRealApp('/api/plugin/dsh/ingest', { agent_id: 'mao-pet' })
  assert.equal(res.status, 422)
})

test('6.5·E2E · ★ 跨站请求被后端中间件 403（LocalControlMiddleware）', { skip: !READY && '后端不可用' }, () => {
  const res = postToRealApp(
    '/api/plugin/dsh/ingest',
    { phase: 'thinking', agent_id: 'mao-pet' },
    { 'sec-fetch-site': 'cross-site' },
  )
  assert.equal(res.status, 403, '跨站必须被拒')
})

test('6.5·E2E · ★ 非回环 Host 被后端 403', { skip: !READY && '后端不可用' }, () => {
  const res = postToRealApp(
    '/api/plugin/dsh/ingest',
    { phase: 'thinking', agent_id: 'mao-pet' },
    { host: 'evil.example.com' },
  )
  assert.equal(res.status, 403, '伪造 Host 必须被拒')
})

test('6.5·E2E · 缺省 agent_id 落到 mao-pet（D5 全小写）', { skip: !READY && '后端不可用' }, () => {
  const res = postToRealApp('/api/plugin/dsh/ingest', { phase: 'idle' })
  assert.equal(res.status, 200)
  assert.equal(res.json.agent_id, 'mao-pet')
})

test('6.5·E2E · 响应含 throttled / phase_changed（调试用字段）', { skip: !READY && '后端不可用' }, () => {
  const res = postToRealApp('/api/plugin/dsh/ingest', { phase: 'planning', agent_id: 'mao-pet', force: true })
  assert.equal(res.status, 200)
  assert.equal(typeof res.json.throttled, 'boolean')
  assert.equal(typeof res.json.phase_changed, 'boolean')
})

test('6.5·E2E · 只读联调快照端点可用（GET /api/plugin/dsh/agent）', { skip: !READY && '后端不可用' }, () => {
  const script = `
import json
from fastapi.testclient import TestClient
from app.main import app
c = TestClient(app)
r = c.get("/api/plugin/dsh/agent", params={"agent_id": "mao-pet"})
print(json.dumps({"status": r.status_code, "json": r.json() if r.status_code == 200 else None}))
`
  const raw = execFileSync(PY, ['-c', script], { cwd: BACKEND, timeout: 120_000, encoding: 'utf8' })
  const lines = String(raw).trim().split(/\r?\n/).filter(Boolean)
  const res = JSON.parse(lines[lines.length - 1])
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.ok(res.json.agent, '应返回 agent 快照')
})
