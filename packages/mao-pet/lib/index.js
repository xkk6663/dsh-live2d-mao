/**
 * Mao-pet —— DSH 桌宠连接器（Cordis 插件宿主侧入口）
 *
 * 形态（裁决 D4，且经 M5 spike 源码级确证）：**插件只推事件，不持有窗口**。
 * 插件宿主跑在 `ELECTRON_RUN_AS_NODE=1` 的子进程里，`require('electron')`
 * 拿到的是 Node 兼容层（无 BrowserWindow），且宿主与 Electron 之间只有
 * 白名单 IPC —— **没有任何通道能让插件申请开窗**。所以桌宠渲染固定在
 * 独立 Electron 壳（`start_mio.ps1` 手动启动），插件只负责"把 DSH 在干什么"推出去。
 *
 * 三条踩坑结论（whale-widget 教训，必须继承）：
 *   ① `apply()` **第一件事就注册注入行** —— 宿主只在启动时收集一次，
 *      晚了整个会话拿不到（这就是 whale #152/#153 那个无法稳定复现的竞态）；
 *   ② 注入行用 `kind:'script'` **内联**，不要 `script-src` —— 后者失败会
 *      reject 掉 `__DSH_BOOT_READY__`，**整个应用起不来**（issue #154）；
 *   ③ 前端文件由宿主**按 mtime 热读取**（改完即生效，无需重启宿主）。
 */

import { createConnector } from './events.js'
import { PHASES, WORK_PHASES, FACT_PHASES } from './phases.js'
import { createPusher, AGENT_ID, AGENT_NAME, AGENT_ACCENT } from './push/pusher.js'
import { createHttpTransport } from './push/transports/http.js'
import { createStripRemote } from './push/strip-remote.js'
import { createRejectionGate } from './security/fence.js'
import { createStreamAssembler, parseStreamFrame } from './stream.js'
import { createApprovalDecider, describeApproval, GRANT, REJECT, CANCELLED } from './approval.js'
import { createQuestionAnswerer, pendingQuestions, describeQuestions } from './questions.js'
import { summarizeAll, readProjection } from './projections.js'
import { createBubbleStack, isSubSession, sessionIdOf, MAX_SESSION_BUBBLES } from './bubble-stack.js'
import { createStripController, STRIP_STYLE_KEYS } from './strip.js'
import { safeCall } from './util.js'

/**
 * 桌面端结构化注入行的内联脚本文本。
 *
 * 为什么是"我们自己建 <script> 并**吞掉** onerror"，而不是让宿主去 load：
 * 宿主把这张表在**宿主启动时收集一次**后缓存，**没有任何刷新路径**。
 * 插件在运行期被关掉时表里仍留着这一行，而我们注册的 `/mao-pet/*` 路由
 * 已注销 → 加载 404。内联行 + 吞掉 onerror 让我们**永远不会因为自己的
 * 前端资源缺失而把宿主拖挂**（whale #154 的原始致命错误就是这条）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * ⚠ 这条注入行的定位（2026-10-16 定稿，避免后人误以为它是功能主路径）
 * ────────────────────────────────────────────────────────────────────────
 * 它**不是**横条/气泡的投递通道。DSH GUI 窗口里**没有** `window.__mioPetStrip`
 * （那是**桌宠窗口**的核心 API），所以在这里注入脚本无论如何也够不到桌宠。
 * 真正的链路是宿主侧的：::
 *
 *   插件(宿主) → POST /api/plugin/dsh/{ingest,strip} → 总线 → WS → 桌宠窗口
 *
 * 那这条行还有什么用？**它验证 whale 的两条致命踩坑结论**：
 *   ① `apply()` 第一件事就注册注入行（晚了宿主就收集不到）；
 *   ② 注入行必须用 `kind:'script'` **内联**，不能用 `script-src`
 *      （后者失败会 reject 整个 boot，应用起不来）。
 * 这两条是「插件形态能不能用」的地基，值得留一条**真实生效**的注入行来守住它。
 *
 * 因此 `/mao-pet/bridge.js` 现在由本插件**真的提供**（见下方 registerRoute），
 * 内容是一个极小的探针：挂 `window.__maoPetBridge` 并回传一次握手。
 * 这样"注入行是否真的进了页面"**可被验证**，而不是靠一个 404 猜。
 * 它**只做自证**，不参与任何业务投递 —— 桌宠连接完全不依赖它。
 */
const DESKTOP_BRIDGE_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="/mao-pet/bridge.js";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/** 注入行去重标记。 */
const BRIDGE_SRC_MARK = '/mao-pet/bridge.js'

/**
 * `bridge.js` 的响应体：一个**只做自证**的极小探针。
 *
 * 不碰 DOM、不碰业务、不依赖任何核心 API —— 只为回答一个问题：
 * "注入行到底有没有进到 DSH GUI 页面里"。
 * 排障时在 DSH GUI 的 devtools 里看 `window.__maoPetBridge` 即可。
 */
const BRIDGE_JS_BODY = `/* Mao-pet bridge (self-check beacon only) */
(function () {
  try {
    window.__maoPetBridge = {
      plugin: 'mao-pet',
      at: Date.now(),
      // 供排障：确认注入行确实进了本窗口
      note: 'injection row OK; pet delivery is host-side (HTTP -> bus -> WS)',
    }
  } catch (e) {}
})()
`

export default {
  name: 'mao-pet',

  /**
   * ⚠ 有意**不用对象级 `inject: [...]`**（whale v758 的教训）：
   * 对象级 inject 会把整个 `apply()` 推迟到那些服务就绪之后；而桌面端的注入表是
   * **宿主启动时一次性收集**的 —— 订阅一旦晚于那次收集，这一行就永远进不了表，
   * 表现为"桌宠前端完全不出现"且无法稳定复现。
   *
   * 所以：`apply()` 立刻执行，**第一件事就是注册注入行**（它不依赖任何服务），
   * 其余逻辑放进 `root.inject([...], cb)` 局部等待 —— 语义等价，但行的注册不再被推迟。
   */
  apply(root) {
    // ────────────────────────────────────────────────────────────────
    // ① 第一件事：注册注入行（不依赖任何服务，必须在 apply 同步段内完成）
    // ────────────────────────────────────────────────────────────────
    const rowDisposers = []
    safeCall(() => root.effect(() => () => {
      for (const d of rowDisposers) safeCall(d)
    }))

    safeCall(() => {
      rowDisposers.push(root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          // 去重：旧版本可能推过（script-src 或内联），不要重复插
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === BRIDGE_SRC_MARK) return
            if (row.kind === 'script' && typeof row.text === 'string'
              && row.text.indexOf(BRIDGE_SRC_MARK) >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: DESKTOP_BRIDGE_ROW_TEXT })
        } catch (err) {}
      }))
    })

    // ────────────────────────────────────────────────────────────────
    // ② 其余逻辑：等齐服务后再跑（等价于对象级 inject，但不再挡住 ①）
    // ────────────────────────────────────────────────────────────────
    root.inject(['webServer'], (ctx) => {
      const logger = makeLogger()

      // ── 推送层：传输无关（HTTP 优先；WS 为可选降级，见 transports/ws.js 注释）──
      const transport = createHttpTransport({})
      const pusher = createPusher({ transport, logger })
      const connector = createConnector({ pusher, logger })

      // ── 6.2 事件订阅：DSH session 事件 → facts → phase ──
      // ⚠ 首参是 session、第二个才是 event（源码三处一致，见 docs/M7-协议测绘-源码级.md §1）。
      // ⚠ `{global:true}`：不加只能拿到本插件作用域内的事件，多 session 收不全（M7 7.4 必须）。
      const disposers = []
      safeCall(() => {
        disposers.push(ctx.on('session/event', (session, event) => {
          safeCall(() => connector.handleSessionEvent(session, event))
        }, { global: true }))
      })

      // ── 6.5 推送：定时器（同 phase 补发 + 心跳）──
      const stopTimers = connector.startTimers()
      disposers.push(stopTimers)

      // ══════════════════════════════════════════════════════════════════
      // M7 · B 档能力（7.1~7.6）
      // 每项都**独立兜底**：任一能力初始化失败都不影响主链路（phase 推送）。
      // ══════════════════════════════════════════════════════════════════

      // ── 7.1 逐 token：`agent/assistant-stream` ──
      // 帧结构见 lib/stream.js 头部注释（含"不需要 session/follow"的修正说明）。
      const assembler = createStreamAssembler()
      safeCall(() => {
        disposers.push(ctx.on('agent/assistant-stream', (payload) => {
          safeCall(() => {
            const frame = payload && payload.frame ? payload.frame : payload
            const parsed = parseStreamFrame(frame, { session: sessionIdOf(payload && payload.session) })
            // parseStreamFrame 已把 reasoning-chunks / tool-call-chunks 挡掉；
            // 返回 null 即"本帧不外发"，直接丢。
            if (!parsed) return
            assembler.push(parsed)
            // 流式正文走**横条**（7.6 ①），不走气泡 —— 与说话气泡互斥
            strip.pushStream(parsed.final_text, {
              sessionId: parsed.session, append: true, sticky: true,
            })
          })
        }, { global: true }))
      })

      // ── 7.2 审批应答：`approval/request` ──
      // ⚠ 联调前置：本会话策略当前是 `never`，`dsh-user-approval:175` 会在派发 waterfall
      // **之前**短路返回 "rejected"，插件根本收不到。**要联调必须先把策略切回 `ask`**。
      // 代码本身已按契约写好（返回值恒落在 OUTCOMES 内）。
      const approval = createApprovalDecider({
        // 桌宠侧的作答入口：默认"无人应答"→ cancelled（fail-closed，绝不放行）。
        // 主体 UI 就绪后，替换为把描述推给横条/气泡并等待点击的实现。
        askUser: async (req) => {
          const desc = describeApproval(req)
          logger.info?.('[Mao-pet] 收到审批请求：' + JSON.stringify(desc) + '（等待桌宠作答）')
          return null // → cancelled
        },
        logger,
      })
      safeCall(() => {
        disposers.push(ctx.on('approval/request', (req, next) => {
          return safeCall(() => approval.decide(req, next), CANCELLED)
        }))
      })

      // ── 7.3 提问应答：`ctx.userQuestions.answer` ──
      const questions = createQuestionAnswerer({
        service: safeCall(() => ctx.get?.('userQuestions') || ctx.userQuestions, null),
        logger,
      })

      // ── 7.4 多 session 气泡栈（上限 12）──
      const bubbles = createBubbleStack({ logger, max: MAX_SESSION_BUBBLES })

      // ── 7.6 横条编排 ──
      // ⚠ 关键：**宿主侧没有 `window.__mioPetStrip`**（那是桌宠窗口的 API）。
      //   故必须传 `remote` 代理，否则横条内容永远送不出去、只会降级成气泡，
      //   7.6 的"横条"形态等于没落地（这是本仓库补上的最后一公里）。
      //   链路：本代理 → POST /api/plugin/dsh/strip → 总线 → WS agent_strip
      //         → 桌宠窗口 applyAgentStrip() → window.__mioPetStrip
      const stripRemote = createStripRemote({ logger })
      const strip = createStripController({
        win: (typeof globalThis !== 'undefined' ? globalThis : {}),
        remote: stripRemote,
        logger,
      })

      // ── 7.5 projections：直读宿主服务，不用 session/follow ──
      const projectionService = safeCall(
        () => ctx.get?.('sessionProjections') || ctx.sessionProjections, null)
      const readProjectionsFor = (session) => safeCall(
        () => summarizeAll(projectionService, session), {})

      // 热重载/卸载时必须清干净：否则定时器与监听器泄漏到下一次 apply
      safeCall(() => root.effect(() => () => {
        for (const d of disposers) safeCall(d)
      }))

      // ── 6.4 安全栅栏三层 + 路由注册 ──
      const gate = createRejectionGate({
        connectionFence: () => {
          // 宿主栅栏：较老 dsh 上可能不存在（whale #136）。缺失时回落到 ①+③，
          // 且 createRejectionGate 在构造时就会打warn（不是等第一次请求）。
          return safeCall(() => {
            const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : null) || ctx.connection
            return conn && typeof conn.requestRejection === 'function' ? conn : null
          }, null)
        },
        warn: (msg) => safeCall(() => logger.warn(msg)),
      })

      /** 统一注册入口：所有路由自动套上信任栅栏（照抄 whale `registerRoute`）。 */
      function registerRoute(route) {
        const inner = route && route.handler
        const wrapped = Object.assign({}, route, {
          handler: async (req, res) => {
            if (gate.rejected(req, res)) return
            return inner(req, res)
          },
        })
        return ctx.webServer.register(wrapped)
      }

      const json = (res, code, body) => {
        try {
          res.statusCode = code
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(body))
        } catch (err) {}
      }

      // 注入行加载的前端资源：一个**自证用**的极小探针（不参与业务投递）。
      // 提供真实响应而不是让它 404 —— 否则"注入行到底进没进页面"无从验证，
      // 而且 404 会在 DSH GUI devtools 里刷红，看着像插件坏了。
      safeCall(() => registerRoute({
        method: 'GET',
        path: '/mao-pet/bridge.js',
        handler: async (req, res) => {
          try {
            res.statusCode = 200
            res.setHeader('content-type', 'application/javascript; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(BRIDGE_JS_BODY)
          } catch (err) {}
        },
      }))

      // 只读诊断：桌宠连接器当前状态（排障主入口）
      safeCall(() => registerRoute({
        method: 'GET',
        path: '/mao-pet/status',
        handler: async (req, res) => json(res, 200, {
          ok: true,
          plugin: { id: AGENT_ID, name: AGENT_NAME, accent: AGENT_ACCENT },
          connector: connector.snapshot(),
          push: pusher.diagnostics(),
          fence: gate.snapshot(),
        }),
      }))

      // 只读：本插件声明的 12 态词汇
      safeCall(() => registerRoute({
        method: 'GET',
        path: '/mao-pet/phases',
        handler: async (req, res) => json(res, 200, {
          ok: true,
          phases: PHASES,
          work_phases: WORK_PHASES,
          fact_phases: FACT_PHASES,
          count: PHASES.length,
        }),
      }))

      safeCall(() => logger.info(
        '[Mao-pet] 连接器已就绪：' + AGENT_NAME + ' (' + AGENT_ID + ') → 桌宠总线'
        + ' ｜ 12 态词汇已加载 ｜ 路由 /mao-pet/status /mao-pet/phases /mao-pet/capabilities',
      ))

      // 只读：M7 B 档能力清单与运行时状态（如实标注可用性，便于排障）
      safeCall(() => registerRoute({
        method: 'GET',
        path: '/mao-pet/capabilities',
        handler: async (req, res) => json(res, 200, {
          ok: true,
          agent: { id: AGENT_ID, name: AGENT_NAME, accent: AGENT_ACCENT },
          m7: {
            '7.1_stream': {
              available: true,
              event: 'agent/assistant-stream',
              note: '进程内实时 dispatch，不需要 session/follow（见 lib/stream.js 注释）',
              sessions: assembler.snapshot(),
            },
            '7.2_approval': {
              available: true,
              event: 'approval/request',
              stats: approval.diagnostics(),
              // ★ 这条必须暴露：否则下一个人会以为插件没生效
              caveat: '本会话审批策略为 never 时，dsh-user-approval:175 会在派发前短路，'
                + '插件收不到请求。联调需先把策略切回 ask。',
            },
            '7.3_questions': {
              available: safeCall(() => Boolean(projectionService), false),
              service: 'userQuestions',
            },
            '7.4_bubble_stack': {
              available: true,
              max: MAX_SESSION_BUBBLES,
              stack: bubbles.snapshot(),
            },
            '7.5_projections': {
              available: projectionService !== null,
              service: 'sessionProjections',
              note: '直读宿主服务；stateOf 对未注册 key 返回 undefined，已兜底',
            },
            '7.6_strip': {
              style_key: STRIP_STYLE_KEYS[0],
              style_keys: [...STRIP_STYLE_KEYS],
              plugin_side: strip.diagnostics(),
              subject_side: '__mioPetStrip',
              note: '插件侧编排已就绪；主体侧通道由 Lead 实现（契约见 lib/strip.js 头部）',
            },
          },
        }),
      }))
    })
  },
}

/**
 * 日志包装：**绝不因为日志本身把宿主拖挂**（console 在宿主里被重定向过，
 * 某些环境下写入会抛）。所有输出都走 safeCall。
 */
function makeLogger() {
  return {
    info: (...a) => safeCall(() => console.info(...a)),
    warn: (...a) => safeCall(() => console.warn(...a)),
    debug: (...a) => safeCall(() => {
      if (process.env.MAO_PET_DEBUG) console.debug(...a)
    }),
  }
}
