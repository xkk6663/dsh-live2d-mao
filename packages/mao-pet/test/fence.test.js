/**
 * 6.4 验收：安全栅栏三层。
 *
 * 验收标准（交接单）："裸 curl 返回 401/403，浏览器里 200"。
 * 本文件用**构造的 req/res** 把三层逐条钉死，包括最容易回退的两条：
 *   - 宿主栅栏**抛异常**必须按拒绝处理（曾经是静默放行）；
 *   - 校验器**自身出错**必须 fail-closed。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isLoopbackHostname,
  parseAuthorities,
  authorityListed,
  selfRejection,
  writeRejection,
  createRejectionGate,
  WRITE_METHODS,
} from '../lib/security/fence.js'

/** 构造一个极简 req（fence 只读 method / headers）。 */
function req(method, headers) {
  return { method, headers: headers || {} }
}

/** 构造一个记录状态码的 res。 */
function res() {
  const r = {
    statusCode: null,
    ended: false,
    setHeader() {},
    end() { r.ended = true },
  }
  return r
}

// ─────────────────────────────────────────────────────────────────────────────
// 回环判定：逐段校验（防 127.0.0.1.evil.com 这类相似域名）
// ─────────────────────────────────────────────────────────────────────────────

test('6.4 · isLoopbackHostname 只认真回环', () => {
  // 该放行的
  for (const h of ['localhost', 'LOCALHOST', 'foo.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
    assert.equal(isLoopbackHostname(h), true, `${h} 应视为回环`)
  }
  // 必须拒绝的相似域名 / 非回环
  for (const h of [
    '127.0.0.1.evil.com',   // ★ 关键：相似域名
    'evil.com',
    'localhost.evil.com',   // ★ 关键：不能因为 endsWith('localhost') 之外的前缀骗过
    '128.0.0.1',
    '10.0.0.1',
    '0.0.0.0',
    '127.0.0.999',          // 超范围
    '',
    null,
    undefined,
  ]) {
    assert.equal(isLoopbackHostname(h), false, `${h} 不该视为回环`)
  }
})

test('6.4 · localhost.evil.com 必须被拒（endsWith 方向不能写反）', () => {
  // endsWith('.localhost') 是正确方向；'localhost.evil.com'.endsWith('localhost') 才是 bug
  assert.equal(isLoopbackHostname('localhost.evil.com'), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 第一层：selfRejection
// ─────────────────────────────────────────────────────────────────────────────

test('6.4 · ① 回环 + 同源 → 放行（null）', () => {
  assert.equal(selfRejection(req('GET', { host: '127.0.0.1:19387' }), {}), null)
  assert.equal(selfRejection(req('GET', { host: 'localhost:8000' }), {}), null)
})

test('6.4 · ① 缺 Host / 畸形 Host → 403（fail-closed）', () => {
  assert.equal(selfRejection(req('GET', {}), {}), 403)
  assert.equal(selfRejection(req('GET', { host: '' }), {}), 403)
})

test('6.4 · ① 非回环 Host 且无宿主栅栏 → 403（DNS 重绑定防线）', () => {
  assert.equal(selfRejection(req('GET', { host: 'evil.com' }), { fenceAvailable: false }), 403)
})

test('6.4 · ① 非回环 Host 但宿主栅栏可用 → 交给栅栏判（不自己 403）', () => {
  // whale issue #136 的教训：自校验放在委托之前，会把宿主已信任的权威打成 403
  assert.equal(selfRejection(req('GET', { host: 'dsh.internal:8000' }), { fenceAvailable: true }), null)
})

test('6.4 · ① 环境变量声明的信任权威 → 放行', () => {
  const trusted = parseAuthorities('dsh.internal:8000, other.lan')
  assert.equal(selfRejection(req('GET', { host: 'dsh.internal:8000' }), {
    trustedAuthorities: trusted, fenceAvailable: false,
  }), null)
  // 带端口的条目必须连端口一起比 —— 只给 hostname 不算命中
  assert.equal(selfRejection(req('GET', { host: 'dsh.internal:9999' }), {
    trustedAuthorities: trusted, fenceAvailable: false,
  }), 403)
})

test('6.4 · ① Sec-Fetch-Site: cross-site 一律拒（与信任列表无关）', () => {
  assert.equal(selfRejection(req('GET', {
    host: '127.0.0.1:8000', 'sec-fetch-site': 'cross-site',
  }), {}), 403)
  // 即便 Host 在信任列表里也要拒
  assert.equal(selfRejection(req('GET', {
    host: 'other.lan', 'sec-fetch-site': 'cross-site',
  }), { trustedAuthorities: parseAuthorities('other.lan'), fenceAvailable: true }), 403)
})

test('6.4 · ① 带 Origin 时必须与 Host 同源', () => {
  assert.equal(selfRejection(req('GET', {
    host: '127.0.0.1:8000', origin: 'http://127.0.0.1:8000',
  }), {}), null)
  assert.equal(selfRejection(req('GET', {
    host: '127.0.0.1:8000', origin: 'http://evil.com',
  }), {}), 403)
  // Origin: null（沙箱 iframe / file://）显式放行 —— 与蓝本一致
  assert.equal(selfRejection(req('GET', {
    host: '127.0.0.1:8000', origin: 'null',
  }), {}), null)
  // 畸形 Origin → 拒
  assert.equal(selfRejection(req('GET', {
    host: '127.0.0.1:8000', origin: 'not-a-url',
  }), {}), 403)
})

// ─────────────────────────────────────────────────────────────────────────────
// 第三层：writeRejection
// ─────────────────────────────────────────────────────────────────────────────

test('6.4 · ③ 读请求不受写栅栏限制（局域网仍能看）', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(writeRejection(req(m, { host: 'evil.com' }), []), null, `${m} 不该被写栅栏拦`)
  }
})

test('6.4 · ③ 写请求来自非回环 → 403', () => {
  for (const m of WRITE_METHODS) {
    assert.equal(writeRejection(req(m, { host: 'evil.com' }), []), 403, `${m} 应被拦`)
  }
})

test('6.4 · ③ 写请求来自回环 → 放行', () => {
  assert.equal(writeRejection(req('POST', { host: '127.0.0.1:8000' }), []), null)
  assert.equal(writeRejection(req('DELETE', { host: 'localhost:8000' }), []), null)
})

test('6.4 · ③ 运维显式声明的管理主机可写', () => {
  const admin = parseAuthorities('ops.lan:8000')
  assert.equal(writeRejection(req('POST', { host: 'ops.lan:8000' }), admin), null)
  assert.equal(writeRejection(req('POST', { host: 'ops.lan:9000' }), admin), 403)
})

test('6.4 · ③ 缺 Host 的写请求 → 403', () => {
  assert.equal(writeRejection(req('POST', {}), []), 403)
})

// ─────────────────────────────────────────────────────────────────────────────
// 三层合成：createRejectionGate
// ─────────────────────────────────────────────────────────────────────────────

test('6.4 · 栅栏可用时委托宿主，透传它给的返回码', () => {
  const gate = createRejectionGate({
    connectionFence: () => ({ requestRejection: () => 401 }),
    warn: () => {},
    env: {},
  })
  const r = res()
  assert.equal(gate.rejected(req('GET', { host: '127.0.0.1:8000' }), r), true, '应被拒')
  assert.equal(r.statusCode, 401, '应透传宿主的 401，而不是自己写 403')
})

test('6.4 · ★ 宿主栅栏抛异常 → 按拒绝处理（#136 第二条路径，曾经静默放行）', () => {
  const warnings = []
  const gate = createRejectionGate({
    connectionFence: () => ({ requestRejection: () => { throw new Error('fence boom') } }),
    warn: (m) => warnings.push(m),
    env: {},
  })
  const r = res()
  assert.equal(gate.rejected(req('GET', { host: '127.0.0.1:8000' }), r), true, '抛异常必须按拒绝')
  assert.equal(r.statusCode, 403)
  assert.ok(warnings.some((w) => w.includes('抛异常')), '应打出警告')
})

test('6.4 · 栅栏返回 null/undefined/false → 放行', () => {
  for (const ret of [null, undefined, false]) {
    const gate = createRejectionGate({
      connectionFence: () => ({ requestRejection: () => ret }),
      warn: () => {}, env: {},
    })
    const r = res()
    assert.equal(gate.rejected(req('GET', { host: '127.0.0.1:8000' }), r), false, `${ret} 应放行`)
    assert.equal(r.ended, false)
  }
})

test('6.4 · 宿主栅栏缺失 → 回落自校验，且在**构造时**就 warn（不是等首次请求）', () => {
  const warnings = []
  createRejectionGate({ connectionFence: () => null, warn: (m) => warnings.push(m), env: {} })
  assert.equal(warnings.length, 1, '构造时即应打一条醒目 warn')
  assert.ok(warnings[0].includes('宿主信任栅栏不可用'))
  assert.ok(warnings[0].includes('MAO_PET_TRUSTED_HOSTS'), '应告知兜底手段')
})

test('6.4 · 宿主栅栏缺失时，非回环 Host 仍被自校验拒（不能变成 fail-open）', () => {
  const gate = createRejectionGate({ connectionFence: () => null, warn: () => {}, env: {} })
  const r = res()
  assert.equal(gate.rejected(req('GET', { host: 'evil.com' }), r), true)
  assert.equal(r.statusCode, 403)
})

test('6.4 · ★ 验收：裸 curl 伪造 Host 在有栅栏时交宿主判、无栅栏时插件自己拒；浏览器同源 200', () => {
  // 情形 A：**宿主栅栏不可用**（较老 dsh / 服务未就绪）。
  // 这是插件自校验真正**独立承担**防线的场景，也是必须 fail-closed 的场景：
  // 裸 curl 默认不带 Origin/Sec-Fetch-Site，只能靠回环 Host 判定拦住。
  const gateNoFence = createRejectionGate({ connectionFence: () => null, warn: () => {}, env: {} })
  const r1 = res()
  assert.equal(
    gateNoFence.rejected(req('GET', { host: 'attacker.example.com' }), r1), true,
    '无宿主栅栏时，裸 curl 伪造非回环 Host 必须被插件拒',
  )
  assert.equal(r1.statusCode, 403)

  // 情形 B：**宿主栅栏可用且正常工作** —— 非回环 Host 交给它判（whale #136 的教训：
  // 插件不得抢在它前面 403，否则宿主用 --trusted-host 信任的权威会被误杀）。
  // 这里模拟栅栏按自己的策略返回 401。
  const gateWithFence = createRejectionGate({
    connectionFence: () => ({
      requestRejection: (r) => (isLoopbackHostname(new URL('http://' + r.headers.host).hostname) ? null : 401),
    }),
    warn: () => {},
    env: {},
  })
  const r2 = res()
  assert.equal(
    gateWithFence.rejected(req('GET', { host: 'attacker.example.com' }), r2), true,
    '栅栏负责拦下它',
  )
  assert.equal(r2.statusCode, 401, '透传栅栏的状态码')

  // 情形 C：浏览器里正常访问 → 放行，交回业务 handler（= 最终 200）
  const browser = req('GET', {
    host: '127.0.0.1:19387',
    origin: 'http://127.0.0.1:19387',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0',
  })
  for (const gate of [gateNoFence, gateWithFence]) {
    const r = res()
    assert.equal(gate.rejected(browser, r), false, '浏览器同源请求应放行')
    assert.equal(r.ended, false)
  }
})

test('6.4 · 写栅栏先于委托：非回环写请求即使宿主放行也必须拒', () => {
  const gate = createRejectionGate({
    // 一个有 bug 的宿主栅栏：什么都放行
    connectionFence: () => ({ requestRejection: () => null }),
    warn: () => {},
    env: { MAO_PET_TRUSTED_HOSTS: 'lan.host:8000' }, // 读接口信任它
  })
  const r = res()
  // lan.host 在**读**信任列表里 → 第一层放行，但第三层必须拦下**写**
  assert.equal(gate.rejected(req('POST', { host: 'lan.host:8000' }), r), true, '非本机写请求必须拒')
  assert.equal(r.statusCode, 403)

  // 同一主机读请求应放行
  const r2 = res()
  assert.equal(gate.rejected(req('GET', { host: 'lan.host:8000' }), r2), false)
})

test('6.4 · 未处理的 REQUEST 方法大小写不敏感', () => {
  assert.equal(writeRejection(req('post', { host: 'evil.com' }), []), 403)
  assert.equal(writeRejection(req('Post', { host: '127.0.0.1' }), []), null)
})

test('6.4 · 缺 method 默认按 GET（只读）处理 → 不被写栅栏拦', () => {
  assert.equal(writeRejection({ headers: { host: 'evil.com' } }, []), null)
})

test('6.4 · parseAuthorities 容错空白与空串', () => {
  assert.deepEqual(parseAuthorities('  A:1 , , b  '), ['a:1', 'b'])
  assert.deepEqual(parseAuthorities(''), [])
  assert.deepEqual(parseAuthorities(null), [])
  assert.equal(authorityListed(['a:1'], 'A:1', 'a'), true)
  assert.equal(authorityListed(['a'], 'a:1', 'a'), true, '不带端口比 hostname')
})
