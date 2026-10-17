/**
 * 安全栅栏三层 —— 移植蓝本
 * `~/.dsh/profiles/desktop/node_modules/dsh-whale-widget/lib/index.js:749-874`
 *
 * 为什么必须照抄而不是"简化一下"：whale-widget 这三层是 issue #92 / #136 的
 * **两次真实安全事件**换来的，每一层都对应一条实测攻击路径：
 *
 *   ① selfRejection      —— 插件自己的轻量校验（永远先跑）。防 DNS 重绑定伪造 Host
 *                           读写、防普通跨站 POST 直接写配置。
 *   ② connection 委托    —— 宿主栅栏可用则委托（它里面还有一层浏览器鉴权 401），
 *                           返回码照用；**它抛异常则按拒绝处理**（旧实现在这条路径上
 *                           静默放行，且连 warn 都没有 —— #136 的第二条路径）。
 *   ③ writeRejection     —— 写请求（POST/PUT/PATCH/DELETE）必须来自**本机回环**。
 *                           理由：任意持有 DSH Web 会话的人都能改配置，等于决定
 *                           "把凭据发往哪里"，必须与"坐在这台机器前"绑定。
 *
 * 三条通用原则（比具体代码更重要）：
 *   - **fail-closed**：任何一层自身抛异常 → 拒绝，绝不"没被拒就放行"；
 *   - **不重写宿主语义**：委托时只透传它给的返回码，不自己发明策略；
 *   - **只认回环**：`*.localhost` / `127.0.0.0/8`（逐段校验，防 `127.0.0.1.evil.com`
 *     这类相似域名）/ `::1`。
 *
 * 本模块是纯函数集合（不碰 ctx），便于单测直接构造 req 断言返回码。
 */

/** 只有这些方法算"写"。读请求（GET/HEAD）不受第三层限制。 */
export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 只认回环主机名。
 *
 * 逐段校验 IPv4 是刻意的：`127.0.0.1.evil.com` 是**域名**不是 IP，
 * 正则必须锚定整串，否则相似域名会被当成本机放行。
 */
export function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

/** 解析逗号分隔的权威列表（环境变量）。 */
export function parseAuthorities(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** 权威是否命中列表：带端口比 authority，不带端口比 hostname。 */
export function authorityListed(list, authority, hostname) {
  return list.some((e) => (e.indexOf(':') >= 0 ? e === authority.toLowerCase() : e === hostname.toLowerCase()))
}

/**
 * 第一层：插件自校验。通过 → `null`；否则返回应当拒绝的状态码。
 *
 * @param {object} req  Node http IncomingMessage 形状（只需 headers）
 * @param {object} ctx2 `{ trustedAuthorities, fenceAvailable }`
 *   - `fenceAvailable`：宿主栅栏此刻可用时，**非回环 Host 交给它判** ——
 *     它知道 dsh 自己的 `--trusted-host` 声明了谁；我们只在"确实没有栅栏"时
 *     才回落到环境变量声明的信任列表。
 *     （历史教训：把自校验放在委托之前，导致宿主已信任的权威在插件这边被 403。）
 */
export function selfRejection(req, ctx2 = {}) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try {
      hostUrl = new URL('http://' + String(headers.host || ''))
    } catch (err) {
      return 403 // 缺 Host / 畸形 → 拒
    }
    const hostname = hostUrl.hostname
    const authority = hostUrl.host

    const trusted = ctx2.trustedAuthorities || []
    if (!isLoopbackHostname(hostname)) {
      const listed = authorityListed(trusted, authority, hostname)
      if (!listed && !ctx2.fenceAvailable) return 403
    }

    // 下面两条与"信任列表"无关，任何情况下都执行：跨站标记、Origin 与 Host 不同源。
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return 403

    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originUrl = null
      try {
        originUrl = new URL(origin)
      } catch (err) {
        return 403
      }
      if (originUrl.host.toLowerCase() !== authority.toLowerCase()) return 403
    }
    return null
  } catch (err) {
    return 403 // 校验器自身出错 → 拒绝（fail-closed）
  }
}

/**
 * 第三层：写请求必须来自本机回环。通过 → `null`；否则返回 403。
 *
 * @param {object} req        Node http IncomingMessage 形状
 * @param {string[]} adminAuthorities 运维显式声明的管理主机（缺省空 = 只能本机）
 */
export function writeRejection(req, adminAuthorities = []) {
  try {
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (!WRITE_METHODS.has(method)) return null // 只读接口不受影响

    const headers = (req && req.headers) || {}
    let hostUrl = null
    try {
      hostUrl = new URL('http://' + String(headers.host || ''))
    } catch (err) {
      return 403
    }
    if (isLoopbackHostname(hostUrl.hostname)) return null

    const authority = hostUrl.host.toLowerCase()
    const hostname = hostUrl.hostname.toLowerCase()
    if (authorityListed(adminAuthorities, authority, hostname)) return null
    return 403
  } catch (err) {
    return 403 // 自身出错 → 拒绝（fail-closed）
  }
}

/**
 * 三层裁决器工厂：把三层合成一个 `rejected(req, res)`。
 *
 * @param {object} opts
 * @param {Function|null} opts.connectionFence  `() => conn | null`（取宿主 connection 服务）
 * @param {Function} [opts.warn]                日志钩子
 * @param {object}   [opts.env]                 环境变量源（测试注入；缺省 process.env）
 */
export function createRejectionGate(opts = {}) {
  const env = opts.env || process.env
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  const getConn = typeof opts.connectionFence === 'function' ? opts.connectionFence : () => null

  const trustedAuthorities = parseAuthorities(env.DSHW_TRUSTED_HOSTS || env.MAO_PET_TRUSTED_HOSTS)
  const adminAuthorities = parseAuthorities(env.DSHW_ADMIN_HOSTS || env.MAO_PET_ADMIN_HOSTS)

  // 宿主栅栏不可用 → **在插件加载时**就打一条醒目 warn（不是等第一次请求才打）
  if (!getConn()) {
    warn('[dsh-live2d-mao] 宿主信任栅栏不可用（connection.requestRejection 缺失）：已启用插件自带的'
      + ' 回环/同源校验，所有路由（含写接口）仍受它保护；若本机 dsh 部署在非回环地址'
      + '（反代/局域网），请用环境变量 MAO_PET_TRUSTED_HOSTS 声明允许的 Host（逗号分隔，可带端口）。')
  }

  // 每条警告只打一次，避免被刷爆
  const warned = { fenceThrew: false, writeDenied: false }
  let lastDeniedHost = ''

  /**
   * @returns {boolean} true = 已拒绝（响应已结束），调用方必须直接 return
   */
  function rejected(req, res) {
    const deny = (code) => {
      try {
        res.statusCode = code || 403
        res.end()
      } catch (err) {}
      return true
    }

    const conn = getConn()

    // ① 先算栅栏可用性，再自校验：非回环 Host 在"栅栏可用"时交给栅栏判
    const self = selfRejection(req, { trustedAuthorities, fenceAvailable: Boolean(conn) })
    if (self !== null) return deny(self)

    // ③ 写请求必须来自本机
    const write = writeRejection(req, adminAuthorities)
    if (write !== null) {
      if (!warned.writeDenied) {
        warned.writeDenied = true
        const host = String(((req && req.headers) || {}).host || '')
        lastDeniedHost = host
        warn('[dsh-live2d-mao] 已拒绝一个来自非本机的**写请求**（Host=' + host + '）。'
          + '配置与凭据的改动只能在**本机**（回环地址）打开界面进行。'
          + '确需远端管理，请用环境变量 MAO_PET_ADMIN_HOSTS 声明允许的管理主机。')
      }
      return deny(write)
    }

    // ② 委托宿主栅栏（它知道 dsh 自己的 --trusted-host 与浏览器鉴权）
    if (!conn) return false // 已通过自校验；加载时已 warn
    let code
    try {
      code = conn.requestRejection(req)
    } catch (err) {
      // 旧实现这里是 `return false`：栅栏自己抛异常被当成"没被拒"而静默放行（#136 第二条路径）
      if (!warned.fenceThrew) {
        warned.fenceThrew = true
        warn('[dsh-live2d-mao] 信任栅栏抛异常，已按拒绝处理：' + String((err && err.message) || err))
      }
      return deny(403)
    }
    if (code === undefined || code === null || code === false) return false
    return deny(typeof code === 'number' ? code : 403)
  }

  return {
    rejected,
    trustedAuthorities,
    adminAuthorities,
    /** 诊断用（只读）。 */
    snapshot() {
      return { trustedAuthorities, adminAuthorities, lastDeniedHost, warned: { ...warned } }
    },
  }
}
