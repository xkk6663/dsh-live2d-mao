#!/usr/bin/env node
/**
 * dsh_log_stream.mjs —— DSH 会话事件日志 → NDJSON 实时事实流（零依赖 Node 边车进程）
 *
 * 为什么需要它
 * ------------
 * DSH 把会话事件持久化为**拼接式 Zstandard 帧**的 JSONL 文件：
 *   <DSH_HOME>/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd
 * 每个追加批次是一个独立的 zstd 帧（因此不能用一次性解压：只能逐帧解）。
 * Node 自带 zstd 解码（node:zlib `zstdDecompressSync`），而后端 venv 没有 zstd
 * 绑定，所以解码交给本进程，Python 只消费 NDJSON。
 *
 * 职责边界（重要）
 * ---------------
 *   本进程 = DSH 协议侧：解码 zstd 帧、解析事件、把事件**折叠成客观事实(facts)**。
 *   dsh_adapter.py = 策略侧：facts → 统一 phase（桌宠只认 phase）。
 *   折叠逻辑只在本文件实现一次，Python 不重复实现，避免两处规则漂移。
 *
 * 输出（stdout，每行一个 JSON）
 * ---------------------------
 *   {"kind":"ready",   "session","log","cwd","delegation_depth","events_replayed"}
 *   {"kind":"facts",   "facts":{...}}                     附着时的当前事实快照
 *   {"kind":"event",   "type","seq","time","data","facts"} 实时增量事件 + 折叠后事实
 *   {"kind":"stream",  "session","turn","step","seq",...}  assistant 正文的**逐 token 增量**
 *   {"kind":"switch",  "session","log","from"}             活跃会话切换
 *   {"kind":"offline", "reason"}                           DSH 未运行 / 无会话可跟
 *   {"kind":"ping",    "ts"}                               保活心跳（5s）
 *   {"kind":"error",   "message"}                          内部错误（不退出）
 *
 * 关于 kind:"stream"（逐 token 流式）——**实测语义，别想当然**
 * ----------------------------------------------------------
 * DSH 的 ``assistant/message`` / ``assistant/attempt`` 事件携带 ``data.stream[]``，
 * 其中 ``text-chunks`` 帧是真·逐 token 增量且**自带时基**::
 *
 *   {"type":"text-chunks","time0":<epoch_ms>,"index":0,
 *    "dt":[41,0,0,15,...], "texts":["I","'ll"," look",...]}
 *
 * ``dt[i]`` = 第 i 块与第 i+1 块之间的毫秒间隔 ⇒ 可**按 DSH 原始节奏回放**。
 * 同事件内的 ``block-end`` 帧带该 block 的**权威完整文本**（用于最终校正）。
 *
 * ⚠ 关键限制（实测 2 个会话、1131 个 stream 事件）：**整条 assistant/message
 * 只落在同一个 zstd 追加帧里**（与紧随其后的 ``tool/call`` 同帧），也就是说
 * 文本是**消息生成完成后**才落盘的，日志通道**拿不到"边生成边出字"**。
 * 因此这里发的是「事后按原始节奏回放」，而不是实时增量。
 * 真·实时增量只能走 Host WS ``/api/remote.mux`` → ``session/follow``
 * （需凭据 cookie + 临时端口发现，见 dsh_adapter.py 模块文档"实测选型"）。
 * 本进程只提供日志通道的事实；渲染端拿到的仍是同一条 agent_stream 消息，
 * 后续换源不需要改渲染端。
 *
 * 另外：**只在增量跟随（poll）路径发 stream**，附着时的历史重放（attach）不发——
 * 否则每次连上桌宠都会把几百条旧正文当实时流刷一遍。
 *
 * 用法
 * ----
 *   node dsh_log_stream.mjs [--sessions-root <dir>] [--workspace <cwd>] [--session-id <id>]
 *                          [--poll-ms 150] [--stale-takeover-ms 2500] [--once]
 *   --once 只输出当前 facts 后退出（探测/自检用）。
 *
 * 设计约束
 * -------
 *   - **只读**：绝不写 DSH 的 session 目录；
 *   - 附着时**不回放全部历史事件**（否则桌宠会把几百条旧事件当实时状态闪一遍）：
 *     内部重放折叠出“当前事实”，只发一条 facts，再从文件末尾增量跟随；
 *   - 会话选择带**迟滞**，且优先“本工作区的主会话（delegationDepth=0）”，
 *     避免跟随 subagent 子会话或两个会话来回抖动；
 *   - 任何异常都降级为 error/offline 消息，进程存活等待恢复（绝不崩溃退出）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 (LE)
const DECODE_CHUNK = 1024 * 1024
const PING_MS = 5000
const HEADER_PROBE_BYTES = 64 * 1024
const DEFAULT_TAKEOVER_MS = 2500
// ★ 2026-10-24：切换会话的两个时间窗（见 pickTarget 注释）
//   ACTIVE_WINDOW_MS —— "最近这段时间被写过"就算活跃会话。用户切工作区后
//     发第一条消息时，新会话立刻进入活跃、旧会话不再活跃 → 立即接管。
//     取 120s：够宽松（一次思考+工具循环可能十几秒不写日志），又不至于
//     把几十分钟前动过的旧会话误判成"正在用"。
//   STALE_WINDOW_MS —— 超过这么久没动过，视为"用户已经离开了"。
//     取 5min：覆盖正常发呆/看文档的停顿，但不至于把挂着不管的旧会话
//     一直当成当前工作区。
const ACTIVE_WINDOW_MS = 120 * 1000
const STALE_WINDOW_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    sessionsRoot: '',
    workspace: '',
    sessionId: '',
    pollMs: 150,
    takeoverMs: DEFAULT_TAKEOVER_MS,
    activeWindowMs: ACTIVE_WINDOW_MS,
    staleWindowMs: STALE_WINDOW_MS,
    once: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sessions-root') out.sessionsRoot = argv[++i] || ''
    else if (a === '--workspace') out.workspace = argv[++i] || ''
    else if (a === '--session-id') out.sessionId = argv[++i] || ''
    else if (a === '--poll-ms') out.pollMs = Math.max(100, Number(argv[++i]) || 150)
    else if (a === '--stale-takeover-ms') out.takeoverMs = Math.max(0, Number(argv[++i]) || 0)
    // ★ 2026-10-24：切工作区时的接管灵敏度（见 pickTarget 注释）
    else if (a === '--active-window-ms') out.activeWindowMs = Math.max(1000, Number(argv[++i]) || ACTIVE_WINDOW_MS)
    else if (a === '--stale-window-ms') out.staleWindowMs = Math.max(1000, Number(argv[++i]) || STALE_WINDOW_MS)
    else if (a === '--once') out.once = true
  }
  if (!out.sessionsRoot) {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    out.sessionsRoot = path.join(home, 'sessions')
  }
  return out
}

const ARGS = parseArgs(process.argv.slice(2))

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch (_) {
    /* stdout 已关闭（父进程退出）：忽略，由退出逻辑收尾 */
  }
}

// ---------------------------------------------------------------------------
// zstd 拼接帧：按帧结构步进扫描边界
// （不靠 magic 搜索——压缩块内可能恰好出现相同 4 字节序列，会误判）
// ---------------------------------------------------------------------------
/** 逐个步进 zstd 帧，返回完整帧范围与可能的“撕裂尾帧”起点。 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (blockHeader & 1) === 1
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payload = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payload) return { frames, tornStart: start }
      offset += payload
      if (last) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 解码单个 zstd 帧（可能跨多块）。 */
function decodeFrame(buf) {
  return zlib.zstdDecompressSync(buf, { chunkSize: DECODE_CHUNK }).toString('utf8')
}

/** 逐行解析 JSONL，跳过空行与半行。 */
function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object') out.push(o)
    } catch (_) {
      /* 跳过半行/脏行 */
    }
  }
  return out
}

/** 整文件解码（逐帧），返回 {events, torn}。单帧损坏跳过而不整体失败。 */
function decodeWholeLog(raw) {
  const { frames, tornStart } = scanZstdFrames(raw)
  let text = ''
  for (const f of frames) {
    try {
      text += decodeFrame(raw.subarray(f.start, f.end))
    } catch (_) {
      /* 单帧损坏：保留其余可解内容 */
    }
  }
  return {
    events: parseLines(text),
    torn: tornStart === undefined ? Buffer.alloc(0) : Buffer.from(raw.subarray(tornStart)),
  }
}

// ---------------------------------------------------------------------------
// 会话发现
// ---------------------------------------------------------------------------
/**
 * 读取会话日志头部（第一帧就是 header 行），拿到 DSH 自报的真实 cwd 与
 * delegationDepth —— 比从目录名反推路径可靠，也用于“优先主会话”。
 */
function readHeader(logPath) {
  let fd
  try {
    fd = fs.openSync(logPath, 'r')
    const size = Math.min(fs.fstatSync(fd).size, HEADER_PROBE_BYTES)
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, 0)
    const { frames } = scanZstdFrames(buf)
    if (!frames.length) return {}
    const events = parseLines(decodeFrame(buf.subarray(frames[0].start, frames[0].end)))
    const header = events.find((e) => e.type === 'session') || {}
    return {
      id: header.id,
      cwd: header.cwd || '',
      delegationDepth: Number.isInteger(header.delegationDepth) ? header.delegationDepth : 0,
      agentPreset: header.agentPreset || '',
      createdAt: header.createdAt,
    }
  } catch (_) {
    return {}
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (_) {}
    }
  }
}

/**
 * 轻量探测：这个会话**当前是否正在 turn 中**。
 *
 * 只读日志尾部 PROBE_BYTES 字节，找最后一个 turn/start 与 turn/end，
 * 若最后出现的是 turn/start → 正在跑；turn/end → 已结束。
 *
 * ★★ 为什么需要它（2026-10-25 用户反复反馈后定位到的真问题）：
 *   pickTarget 原来纯按 mtime 排。"代理人自己的会话"每几秒就写一次日志
 *   （每次工具调用都追加），于是它**永远比另一个窗口的会话新**，
 *   另一个窗口的会话哪怕真的在跑任务也抢不过来。
 *   用户要的是「识别哪个在跑，自动跟随」——判据必须是**语义上的在跑**，
 *   而不是"谁的文件被摸得更勤"。
 */
function probeInTurn(logPath) {
  let fd
  try {
    const size = fs.statSync(logPath).size
    // 尾部最多回看 256KB：正常一轮的事件量远小于这个尺度，
    // 够覆盖到最近的 turn 边界，又不至于每次都把 7MB 日志读完。
    const PROBE_BYTES = 256 * 1024
    const start = Math.max(0, size - PROBE_BYTES)
    fd = fs.openSync(logPath, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const { frames } = scanZstdFrames(buf)
    let sawStart = false
    let sawEnd = false
    let turnNo = null
    for (const fr of frames) {
      let lines
      try {
        lines = parseLines(decodeFrame(buf.subarray(fr.start, fr.end)))
      } catch (_) {
        continue
      }
      for (const ev of lines) {
        if (!ev || !ev.type) continue
        if (ev.type === 'turn/start') {
          sawStart = true
          sawEnd = false
          if (Number.isInteger(ev.turn)) turnNo = ev.turn
        } else if (ev.type === 'turn/end') {
          sawEnd = true
          sawStart = false
        }
      }
    }
    return { inTurn: sawStart && !sawEnd, turn: turnNo }
  } catch (_) {
    return { inTurn: false, turn: null }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (_) {}
    }
  }
}

/** 目录 mtime（失败返回 0，绝不让它影响主流程）。 */
function dirMtimeMs(dir) {
  try {
    return fs.statSync(dir).mtimeMs || 0
  } catch (_) {
    return 0
  }
}

/** 枚举候选会话日志。 */
function listCandidates() {
  const out = []
  let slugs
  try {
    slugs = fs.readdirSync(ARGS.sessionsRoot, { withFileTypes: true })
  } catch (_) {
    return out
  }
  const wantCwd = ARGS.workspace ? path.resolve(ARGS.workspace).toLowerCase() : ''
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const slugDir = path.join(ARGS.sessionsRoot, slug.name)
    let sessions
    try {
      sessions = fs.readdirSync(slugDir, { withFileTypes: true })
    } catch (_) {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      if (ARGS.sessionId && s.name !== ARGS.sessionId) continue
      const dir = path.join(slugDir, s.name)
      let files
      try {
        files = fs.readdirSync(dir)
      } catch (_) {
        continue
      }
      const logs = files.filter((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f))
      if (!logs.length) continue
      // 取格式版本最高的那个（当前为 v4）
      logs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      const logPath = path.join(dir, logs[0])
      let st
      try {
        st = fs.statSync(logPath)
      } catch (_) {
        continue
      }
      const header = readHeader(logPath)
      const cwd = header.cwd || ''
      // ★ 2026-10-24：cwd 为空时不能用 `path.resolve('.')` —— 那会解析成**边车进程
      //   自己所在的目录**（backend/app/agents/dsh），拿它跟目标工作区比必然不等，
      //   而且是个毫无意义的路径。空就当作"没有工作区信息"，inWorkspace=false。
      const cwdResolved = cwd ? path.resolve(cwd).toLowerCase() : ''
      const touchedMs = Math.max(st.mtimeMs, dirMtimeMs(dir))
      // ★ 2026-10-25：只有"最近被碰过"的候选才值得探测 turn 状态
      //   （探测要读尾部 256KB，对全部 45 个历史会话都读会拖慢每轮轮询）。
      //   超过 ACTIVE_WINDOW 没动静的会话不可能在跑任务，直接判 false。
      const freshEnough = Date.now() - touchedMs <= ACTIVE_WINDOW_MS
      const turnInfo = freshEnough ? probeInTurn(logPath) : { inTurn: false, turn: null }
      out.push({
        logPath,
        sessionId: s.name,
        cwd,
        delegationDepth: header.delegationDepth || 0,
        agentPreset: header.agentPreset || '',
        mtimeMs: st.mtimeMs,
        size: st.size,
        inWorkspace: Boolean(wantCwd && cwdResolved) && cwdResolved === wantCwd,
        // ★ 2026-10-24：会话**目录**的 mtime 也是"用户刚动过这里"的信号。
        //   日志文件在 turn 中途会持续追加（mtime 一直新），turn 结束后就静止；
        //   而 DSH 新建会话 / 写附属文件时会更新目录 mtime。
        //   两者取最大，作为"这个会话最近被碰过"的时间。
        touchedMs,
        // ★ 2026-10-25：是否**真的正在跑任务**（语义判据，见 probeInTurn 注释）
        inTurn: turnInfo.inTurn,
        turnNo: turnInfo.turn,
      })
    }
  }
  // 排序优先级：**正在跑任务** > 本工作区 > 主会话(depth=0) > 最近被碰过
  //
  // ★ 2026-10-25 用户裁决：「识别哪个在跑，自动跟随」。
  //   把 inTurn 提到第一位是本轮的核心修复：
  //   代理自己的会话每几秒就写一次日志（每次工具调用），纯按 mtime 排序时
  //   它**永远**比另一个窗口的会话新 → 另一个窗口哪怕真在跑任务也抢不过来。
  //   现在只要对方 inTurn=true 而我们 false，对方直接排第一，
  //   pickTarget 的 cands[0] 就是它。
  // ★ 2026-10-24：末位判据从"日志 mtime"改成 touchedMs（日志与目录取最大）。
  //   用户切到另一个 GUI 工作区时，DSH 会在那边写日志/建文件；
  //   只比日志 mtime 时，若旧工作区上一轮的日志刚写完、新工作区那条才几个字节，
  //   旧的可能仍然更"新"，于是永远排第一 → 边车不切 → 桌宠卡在旧状态。
  out.sort((a, b) => {
    if (a.inTurn !== b.inTurn) return a.inTurn ? -1 : 1
    if (a.inWorkspace !== b.inWorkspace) return a.inWorkspace ? -1 : 1
    if (a.delegationDepth !== b.delegationDepth) return a.delegationDepth - b.delegationDepth
    return b.touchedMs - a.touchedMs
  })
  return out
}

// ---------------------------------------------------------------------------
// 事实折叠：DSH 会话事件 → 客观事实 facts
// （事实是“发生了什么”的客观描述；它到 phase 的映射属于 Python 适配器的策略）
// ---------------------------------------------------------------------------
/** 会“等待用户”的工具名（调用即进入聆听态，结果返回才结束）。 */
const ASK_TOOLS = new Set(['ask_user_question', 'ask_user', 'askuserquestion', 'user_questions'])
/** 规划类工具名（映射到 planning）。 */
const PLAN_TOOLS = new Set(['todo_write', 'todowrite', 'create_goal', 'update_goal', 'exit_plan_mode'])
/** 语音播报类工具名（DSH 默认无 TTS；若部署了此类工具即可驱动 voice）。 */
const VOICE_TOOLS = new Set(['speak', 'tts', 'text_to_speech', 'say'])

function initialFacts() {
  return {
    // 轮次 / 步骤
    in_turn: false,
    turn: null,
    step: null,
    // 工具
    last_tool: '',
    tool_calls: 0,
    active_tools: 0,
    // 等待类
    approvals_pending: 0,
    awaiting_user: false,
    voice_active: false,
    // DSH 独有的两类"在等你"信号（比 awaiting_user 更精确，驱动桌宠气泡播报）：
    //   awaiting_approval —— approval/asked 之后尚未 approval/decided
    //   awaiting_question —— ask_user_question 工具在飞（模型等你选）
    awaiting_approval: false,
    approval_tool: '',
    awaiting_question: false,
    question_text: '',
    // “本事件本身表明的意图”（每事件清零后由当前事件置位，
    // 与 last_event_failed 同一套语义，避免意图粘住整轮）
    plan_intent: false,
    voice_intent: false,
    todo_count: 0,
    goal_operation: '',
    // 异常 / 重试
    retrying: false,
    errored: false,
    // 仅当“最近一个事件”本身是失败时为 true（进展事件会立即清零）——
    // 用于把 error phase 精确限定在失败当下，而不是让失败态粘住整轮
    last_event_failed: false,
    turn_end_reason: '',
    last_error: '',
    // 输出规模
    text_chars: 0,
    reason_chars: 0,
    last_assistant_has_text: false,
    last_assistant_has_reason: false,
    // 最近一条 assistant/message 是否**只有文字、没有工具调用**。
    // 实测真实日志：335/377 条 assistant/message 同时含 tool-call 块，只有
    // 「纯文字」才代表"正在输出正文"（streaming）；带 tool-call 的是"要调工具"
    // （executing_tool），不能拿 has_text 当 streaming 的判据。
    last_message_text_only: false,
    // 事件溯源
    last_event: '',
    user_turns: 0,
    updated_at: 0,
  }
}

/** 把单个 DSH 事件折叠进 facts（纯函数：返回新对象）。 */
function foldEvent(prev, ev) {
  const f = { ...prev, updated_at: ev.time || Date.now() }
  const t = ev.type
  const d = ev.data || {}
  // 默认清零：只有“本事件本身是失败”才置 true，避免失败态粘住整轮
  f.last_event_failed = false
  // 同理：planning/voice 这类“本事件本身表明的意图”每轮先清零，由本事件决定
  f.plan_intent = false
  f.voice_intent = false

  switch (t) {
    case 'turn/start':
      f.in_turn = true
      f.turn = d.turn ?? f.turn
      f.step = null
      f.last_tool = ''
      f.tool_calls = 0
      f.active_tools = 0
      f.approvals_pending = 0
      f.awaiting_user = false
      f.awaiting_approval = false
      f.approval_tool = ''
      f.voice_active = false
      f.retrying = false
      f.errored = false
      f.turn_end_reason = ''
      f.last_error = ''
      f.text_chars = 0
      f.reason_chars = 0
      f.last_assistant_has_text = false
      f.last_assistant_has_reason = false
      f.last_message_text_only = false
      // 轮次开始本身即“规划中”意图
      f.plan_intent = true
      break

    case 'turn/end': {
      const kind = String((d.reason && d.reason.kind) || '')
      f.in_turn = false
      f.turn = null
      f.step = null
      f.last_tool = ''
      f.active_tools = 0
      f.approvals_pending = 0
      f.awaiting_user = false
      f.awaiting_approval = false
      f.approval_tool = ''
      f.awaiting_question = false
      f.question_text = ''
      f.voice_active = false
      f.turn_end_reason = kind
      if (kind === 'error' || kind === 'max-tokens' || kind === 'interrupted') {
        f.errored = true
        f.last_event_failed = true
        const msg = d.reason && d.reason.failure && d.reason.failure.message
        if (msg) f.last_error = String(msg).slice(0, 200)
      }
      break
    }

    case 'step/start':
      f.step = d.step ?? f.step
      // 与 DSH 官方桌宠投影一致：新步骤清空“本步骤内的运行中工具”
      f.active_tools = 0
      // 新步骤 = 新一轮推理：上一轮的输出标记（含「纯文字」判定）不再代表当下。
      // 漏掉 last_message_text_only 会让上一轮的 streaming 粘到新步骤上——
      // 界面上表现为"明明在思考却一直显示回复中"。
      f.last_assistant_has_text = false
      f.last_assistant_has_reason = false
      f.last_message_text_only = false
      break

    case 'step/end':
      // 步骤边界本身不改变工作性质；下一 step/start 或事件会接管
      break

    case 'assistant/message': {
      const content = (d.message && d.message.content) || []
      let hasText = false
      let hasReason = false
      let hasToolCall = false
      for (const c of content) {
        if (!c) continue
        if (c.type === 'text') {
          hasText = true
          f.text_chars += String(c.text || '').length
        } else if (c.type === 'reasoning') {
          hasReason = true
          f.reason_chars += String(c.text || '').length
        } else if (c.type === 'tool-call') {
          hasToolCall = true
        }
      }
      f.last_assistant_has_text = hasText
      f.last_assistant_has_reason = hasReason
      // 纯文字（有 text、无 tool-call）才代表"正在输出正文"
      f.last_message_text_only = hasText && !hasToolCall
      break
    }

    case 'assistant/attempt': {
      // 尝试流里可能直接以 error finish 结束（重试前的失败尝试）
      const stream = Array.isArray(d.stream) ? d.stream : []
      for (const item of stream) {
        const chunk = item && item.chunk
        if (!chunk) continue
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          f.errored = true
          f.last_event_failed = true
          const msg = chunk.reason.failure && chunk.reason.failure.message
          if (msg) f.last_error = String(msg).slice(0, 200)
        }
      }
      break
    }

    case 'tool/call': {
      const name = String(d.name || '')
      const callId = String(d.callId || '')
      f.tool_calls += 1
      f.last_tool = name
      f.active_tools += 1
      const lname = name.toLowerCase()
      if (ASK_TOOLS.has(lname)) {
        f.awaiting_user = true
        f.awaiting_question = true
        f._askCalls = (prev._askCalls || []).concat([callId])
      }
      // 规划类工具（todo_write/create_goal/update_goal）＝本轮在做规划
      if (PLAN_TOOLS.has(lname)) f.plan_intent = true
      if (VOICE_TOOLS.has(lname)) {
        f.voice_active = true
        f.voice_intent = true
      }
      break
    }

    case 'todo/write': {
      // 待办清单被写入 = 规划动作（真实日志里独立于 tool/call 出现）
      f.plan_intent = true
      const todos = Array.isArray(d.todos) ? d.todos : []
      f.todo_count = todos.length
      break
    }

    case 'goal/change': {
      // 目标创建/更新 = 规划动作
      f.plan_intent = true
      const op = String(d.operation || '')
      if (op) f.goal_operation = op
      break
    }

    case 'tool/result': {
      const msg = d.message || {}
      const callId = String(msg.toolCallId || '')
      f.active_tools = Math.max(0, f.active_tools - 1)
      const failed = d.error !== undefined || msg.isError === true
      if (failed) {
        f.errored = true
        f.last_event_failed = true
        const name = d.error && d.error.name
        const text = (msg.content || []).map((c) => (c && c.text) || '').join(' ').trim()
        f.last_error = String(text || name || 'tool failed').slice(0, 200)
      }
      const asks = (prev._askCalls || []).filter((x) => x !== callId)
      f._askCalls = asks
      if (asks.length === 0) {
        f.awaiting_user = false
        f.awaiting_question = false
        f.question_text = ''
      }
      if (prev.voice_active) {
        // 只有当前工具是语音工具时才结束语音态（粗粒度但足够）
        f.voice_active = false
      }
      break
    }

    case 'approval/asked': {
      f.approvals_pending += 1
      const tool = String(d.toolName || '')
      f.last_tool = String(tool || f.last_tool)
      // DSH 独有：正在等用户授权（渲染端据此弹"待确认"气泡）
      if (f.approvals_pending > 0) {
        f.awaiting_approval = true
        f.approval_tool = tool
      }
      break
    }

    case 'approval/decided': {
      f.approvals_pending = Math.max(0, f.approvals_pending - 1)
      if (f.approvals_pending === 0) {
        f.awaiting_approval = false
        f.approval_tool = ''
      }
      break
    }

    case 'llm/retry':
    case 'llm/retry-started': {
      f.retrying = true
      const msg = d.failure && d.failure.message
      if (msg) f.last_error = String(msg).slice(0, 200)
      break
    }

    case 'user/message':
      f.user_turns += 1
      break

    case 'error':
      f.errored = true
      f.last_event_failed = true
      f.last_error = String((d && (d.message || d.error)) || t).slice(0, 200)
      break

    default:
      break
  }

  f.last_event = t
  return f
}

/** 事件序列 → facts。 */
function foldEvents(events) {
  let f = initialFacts()
  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string' || ev.type === 'session') continue
    f = foldEvent(f, ev)
  }
  return f
}

// ---------------------------------------------------------------------------
// 逐 token 流式：从 assistant 事件的 stream[] 里抽出「增量 + 时基 + 权威全文」
// ---------------------------------------------------------------------------
/** 单个 zstd 追加帧内允许回放的最大块数（防病态日志把气泡拖死）。 */
const STREAM_MAX_CHUNKS = 2000

/**
 * 从一个事件里抽出可回放的正文流。
 *
 * 返回 ``[{index, time0, dt, texts, finalText, totalMs}]``（可能为空数组）。
 * 只认 ``text-chunks``（正文）：``reasoning-chunks`` 是模型的推理草稿，桌宠气泡
 * 不该播它；``tool-call-chunks`` 是工具参数分片，更不该。
 */
function extractStreams(ev) {
  const d = ev && ev.data
  const stream = d && Array.isArray(d.stream) ? d.stream : null
  if (!stream || !stream.length) return []
  const chunks = new Map() // index -> text-chunks 帧
  const finals = new Map() // index -> block-end 的权威文本
  for (const item of stream) {
    const c = (item && item.chunk) || item
    if (!c || typeof c.type !== 'string') continue
    if (c.type === 'text-chunks') {
      const texts = Array.isArray(c.texts) ? c.texts.map((t) => String(t ?? '')) : []
      if (!texts.length) continue
      chunks.set(Number(c.index) || 0, { time0: Number(c.time0) || 0, dt: Array.isArray(c.dt) ? c.dt : [], texts })
    } else if (c.type === 'block-end' && c.block && c.block.type === 'text') {
      finals.set(Number(c.index) || 0, String(c.block.text ?? ''))
    }
  }
  const out = []
  for (const [index, ch] of chunks) {
    let texts = ch.texts
    // 封顶：超出部分合并为最后一块（宁可少几次重绘，也不能把气泡挂死）
    if (texts.length > STREAM_MAX_CHUNKS) {
      const head = texts.slice(0, STREAM_MAX_CHUNKS - 1)
      head.push(texts.slice(STREAM_MAX_CHUNKS - 1).join(''))
      texts = head
    }
    const dt = ch.dt.slice(0, Math.max(0, texts.length - 1)).map((v) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 0
    })
    let totalMs = 0
    for (const v of dt) totalMs += v
    out.push({
      index,
      time0: ch.time0,
      dt,
      texts,
      finalText: finals.has(index) ? finals.get(index) : '',
      totalMs,
    })
  }
  return out
}

/** 对外暴露的 facts（去掉内部下划线字段）。 */
function publicFacts(f) {
  const out = {}
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith('_')) continue
    out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// 跟随器
// ---------------------------------------------------------------------------
class Follower {
  constructor() {
    this.reset()
  }

  reset() {
    this.logPath = ''
    this.sessionId = ''
    this.cwd = ''
    this.delegationDepth = 0
    this.offset = 0
    this.partial = Buffer.alloc(0) // 没收完的 JSONL 行（原始字节）
    this.pending = Buffer.alloc(0) // 没扫完的 zstd 字节（撕裂尾帧）
    this.facts = initialFacts()
    this.attached = false
    this.replayed = 0
    // 已发过 stream 的事件 seq（防日志截断/重读时同一段正文被回放两次）
    this.streamSeqs = new Set()
  }

  /** 附着到候选日志：重放折叠出当前事实 → 发 ready + facts → 从 EOF 增量跟随。 */
  attach(cand) {
    let raw
    try {
      raw = fs.readFileSync(cand.logPath)
    } catch (e) {
      emitErrorOnce(`read failed: ${e.message} @ ${cand.logPath}`)
      return false
    }
    let decoded
    try {
      decoded = decodeWholeLog(raw)
    } catch (e) {
      // 结构性坏日志（帧头非法等）：隔离它，别再反复附着刷屏
      quarantined.add(cand.logPath)
      emitErrorOnce(`decode failed: ${e.message} @ ${cand.logPath}（已隔离该日志，跳过）`)
      return false
    }

    this.logPath = cand.logPath
    this.sessionId = cand.sessionId
    this.cwd = cand.cwd
    this.delegationDepth = cand.delegationDepth
    this.offset = raw.length
    this.pending = decoded.torn // 撕裂尾帧留给下一轮补齐
    this.partial = Buffer.alloc(0)
    this.facts = foldEvents(decoded.events)
    this.replayed = decoded.events.length
    this.attached = true
    // 附着时历史重放不发 stream（offset 直接落到 EOF，历史事件不会二次读到）；
    // 这里清空去重集合，属于新附着的新起点。
    this.streamSeqs = new Set()
    // 附着期间出现过的解码错误：用于识别"这个日志本身是坏的"
    this.sawDecodeError = false

    emit({
      kind: 'ready',
      session: this.sessionId,
      log: this.logPath,
      cwd: this.cwd,
      delegation_depth: this.delegationDepth,
      agent_preset: cand.agentPreset || '',
      events_replayed: this.replayed,
    })
    emit({ kind: 'facts', session: this.sessionId, facts: publicFacts(this.facts), source: 'replay' })
    return true
  }

  /** 增量：读新增字节 → 解完整帧 → 逐行解析 → 逐事件发 event + facts。 */
  poll() {
    if (!this.attached) return
    let st
    try {
      st = fs.statSync(this.logPath)
    } catch (_) {
      this.attached = false
      emit({ kind: 'offline', reason: 'log disappeared', log: this.logPath })
      return
    }
    if (st.size < this.offset) {
      // 日志被截断或轮转：交回主循环重新附着
      this.attached = false
      return
    }
    if (st.size === this.offset) return

    const len = st.size - this.offset
    let chunk
    let fd
    try {
      fd = fs.openSync(this.logPath, 'r')
      chunk = Buffer.alloc(len)
      fs.readSync(fd, chunk, 0, len, this.offset)
    } catch (e) {
      emitErrorOnce(`tail read failed: ${e.message} @ ${this.logPath}`)
      return
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch (_) {}
      }
    }
    this.offset = st.size

    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    let frames = []
    let tornStart
    try {
      const scanned = scanZstdFrames(buf)
      frames = scanned.frames
      tornStart = scanned.tornStart
    } catch (e) {
      // 帧头非法 = 日志结构性损坏：隔离并停止跟随（主循环会改附其它会话）
      quarantined.add(this.logPath)
      emitErrorOnce(`frame scan failed: ${e.message} @ ${this.logPath}（已隔离该日志，跳过）`)
      this.pending = Buffer.alloc(0)
      this.attached = false
      return
    }

    let text = ''
    for (const f of frames) {
      try {
        text += decodeFrame(buf.subarray(f.start, f.end))
      } catch (e) {
        emitErrorOnce(`frame decode failed at ${f.start}: ${e.message} @ ${this.logPath}`)
      }
    }
    this.pending = tornStart === undefined ? Buffer.alloc(0) : Buffer.from(buf.subarray(tornStart))
    if (!text) return

    // 按 0x0a 切行：0x0a 不会出现在 UTF-8 多字节序列内部，字节级切分安全
    const merged = this.partial.length
      ? Buffer.concat([this.partial, Buffer.from(text, 'utf8')])
      : Buffer.from(text, 'utf8')
    const lastNl = merged.lastIndexOf(0x0a)
    if (lastNl === -1) {
      this.partial = merged
      return
    }
    this.partial = Buffer.from(merged.subarray(lastNl + 1))
    const body = merged.subarray(0, lastNl).toString('utf8')

    for (const ev of parseLines(body)) {
      if (!ev || typeof ev.type !== 'string' || ev.type === 'session') continue
      this.facts = foldEvent(this.facts, ev)
      emit({
        kind: 'event',
        session: this.sessionId,
        type: ev.type,
        seq: ev.seq,
        time: ev.time,
        data: ev.data,
        facts: publicFacts(this.facts),
      })
      // 逐 token 流式：**只在这里**（增量跟随）发，历史重放不发（见文件头说明）
      if (ev.type === 'assistant/message' || ev.type === 'assistant/attempt') {
        const key = `${this.sessionId}:${ev.seq}`
        if (!this.streamSeqs.has(key)) {
          this.streamSeqs.add(key)
          if (this.streamSeqs.size > 500) this.streamSeqs.clear() // 防无限增长
          for (const s of extractStreams(ev)) {
            emit({
              kind: 'stream',
              session: this.sessionId,
              turn: this.facts.turn,
              step: this.facts.step,
              seq: ev.seq,
              time: ev.time,
              index: s.index,
              frame: 'text-chunks',
              time0: s.time0,
              dt: s.dt,
              texts: s.texts,
              final_text: s.finalText,
              total_ms: s.totalMs,
            })
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
const follower = new Follower()
let lastOfflineKey = ''
let pingAt = 0
// 错误消息去重：同一个错误串只发一次，避免坏日志每轮刷屏
const emittedErrors = new Set()
// 已被判定为"坏日志"的路径：不再反复附着（否则每 8 轮重试一次刷屏）
const quarantined = new Set()

/** 去重发射 error（同消息只报一次；返回是否为首次）。 */
function emitErrorOnce(message) {
  const key = String(message).slice(0, 200)
  if (emittedErrors.has(key)) return false
  emittedErrors.add(key)
  if (emittedErrors.size > 200) emittedErrors.clear() // 防无限增长
  emit({ kind: 'error', message: key })
  return true
}

/** 选目标会话（带迟滞）：避免频繁切换，但工作区/主会话更优时立即切换。 */
function pickTarget() {
  const cands = listCandidates().filter((c) => !quarantined.has(c.logPath))
  if (!cands.length) return null
  if (!follower.attached) return cands[0]
  const current = cands.find((c) => c.logPath === follower.logPath)
  if (!current) return cands[0] // 当前会话消失：立即改附
  const best = cands[0]
  if (best.logPath === current.logPath) return current

  // ★★ 2026-10-24 修「切到别的工作区后，桌宠就看不到工作状态」：
  //   旧逻辑只有三条切换路径：
  //     · betterScope —— 新候选在 --workspace 里；但适配器恒传空串，
  //       inWorkspace 永远 false，**这条永远不成立**；
  //     · betterDepth —— 还要 best.inWorkspace，同样永远不成立；
  //     · advantage > takeoverMs(2500) —— 唯一可能生效的路径。
  //   问题：advantage 是"两边 mtime 的差值"。用户在新工作区**偶尔**发一条消息时，
  //   差值只有几百毫秒~一两秒，永远达不到 2500ms；而每次轮询都会重新比较，
  //   只要旧会话不再更新、新会话也不再写，差值就冻结在那一刻 → **永远切不过去**。
  //   实测：切到 esp32 工作区后，桌宠一直显示上一个工作区的状态。
  //
  //   修复原则：**"谁正在被写入"优先，而不是"谁比谁新多少"**。
  //   新增两条判据（任一成立就切换）：
  //     ① best 在最近 ACTIVE_WINDOW_MS 内被写过，而 current 没有 → 说明用户
  //        已经在新工作区干活了，直接接管（不受 2500ms 差值限制）；
  //     ② current 已经 STALE_WINDOW_MS 没动过（用户显然离开它了），
  //        而 best 比它新 → 接管。
  //   保留原来的 advantage 判据作为第三条，三条并行，行为只放宽不收紧。
  const now = Date.now()
  const bestFresh = now - best.touchedMs <= ACTIVE_WINDOW_MS
  // ★★ 2026-10-25 用户裁决：「识别哪个在跑，自动跟随」。
  //   这是**最高优先级**的判据，必须排在所有 mtime 判据之前：
  //   best 真的在跑任务、而我们当前跟的已经 turn/end →
  //   立刻改附，不管两边 mtime 谁新谁旧。
  //   （代理自己的会话每几秒写一次日志，纯比 mtime 永远赢，
  //     这正是"另一个窗口在跑却切不过去"的根因。）
  if (best.inTurn && !current.inTurn) return best
  // 反向保护：当前会话正在跑、新候选没在跑 → 守住当前，别被"刚写了一下"的会话带走
  if (current.inTurn && !best.inTurn) return current
  const currentFresh = now - current.touchedMs <= ACTIVE_WINDOW_MS
  const currentStale = now - current.touchedMs >= STALE_WINDOW_MS
  const betterScope = best.inWorkspace && !current.inWorkspace
  const betterDepth = best.delegationDepth < current.delegationDepth && best.inWorkspace
  const advantage = best.touchedMs - current.touchedMs
  // ★★ 2026-10-25 用户实拍「换了工作区、发了消息，桌宠还是显示上一个工作区的 turn 数」：
  //   前三条判据在"两边都算活跃"时会僵持 —— 用户切了工作区，但旧会话的
  //   dirMtime 因为 DSH 收尾写文件也刚更新过，于是 currentFresh 仍为 true，
  //   判据① 的 !currentFresh 不成立；旧会话又没到 300s 陈旧线，判据② 也不成立；
  //   而 advantage 只有几百毫秒（两条消息间隔很短），判据③ 的 2.5s 也够不着。
  //   结果：**明明已经在新工作区干活了，边车就是不切**。
  //
  //   新增判据⓪（最强，优先于其它三条）：
  //     "谁最近 ACTIVE_WINDOW 内被写过、且比当前会话新" → 直接接管。
  //   与判据① 的区别：不再要求当前会话**不**活跃。
  //   DSH 是单实例的，"最近被写入的那个会话"就是用户此刻所在的会话 ——
  //   这条比任何基于 inWorkspace/深度 的推断都更接近真相。
  //   仍在 ACTIVE_WINDOW 内的旧会话即便也"活跃"，只要没被写过就会被比下去。
  if (bestFresh && advantage > 0) return best
  // ① 新候选是"活跃会话"，旧候选不是
  if (bestFresh && !currentFresh) return best
  // ② 旧候选早就没人写了，而新候选确实更新
  if (currentStale && advantage > 0) return best
  // ③ 原有判据：本工作区 / 主会话 / 明显更新
  if (betterScope || betterDepth || advantage > ARGS.takeoverMs) return best
  return current
}

function ensureAttached() {
  const target = pickTarget()
  if (!target) {
    if (lastOfflineKey !== 'no-session') {
      lastOfflineKey = 'no-session'
      emit({ kind: 'offline', reason: 'no DSH session log found', root: ARGS.sessionsRoot })
    }
    follower.attached = false
    return
  }
  if (follower.attached && follower.logPath === target.logPath) return
  const prev = follower.logPath
  if (follower.attach(target)) {
    lastOfflineKey = ''
    if (prev && prev !== target.logPath) {
      emit({ kind: 'switch', session: target.sessionId, log: target.logPath, from: prev })
    }
  }
}

function runOnce() {
  const target = pickTarget()
  if (!target) {
    emit({ kind: 'offline', reason: 'no active session', root: ARGS.sessionsRoot })
    return
  }
  let raw
  try {
    raw = fs.readFileSync(target.logPath)
  } catch (e) {
    emit({ kind: 'error', message: `read failed: ${e.message} @ ${target.logPath}` })
    return
  }
  let decoded
  try {
    decoded = decodeWholeLog(raw)
  } catch (e) {
    // 结构性坏日志：报错但**不**写 exits 码非零之外的状态，保持 --once 可被探测调用
    emit({ kind: 'error', message: `decode failed: ${e.message} @ ${target.logPath}` })
    emit({ kind: 'offline', reason: 'active session log is corrupt', log: target.logPath })
    return
  }
  const facts = foldEvents(decoded.events)
  emit({
    kind: 'ready',
    session: target.sessionId,
    log: target.logPath,
    cwd: target.cwd,
    delegation_depth: target.delegationDepth,
    events_replayed: decoded.events.length,
  })
  emit({ kind: 'facts', session: target.sessionId, facts: publicFacts(facts), source: 'once' })
}

function main() {
  if (ARGS.once) {
    runOnce()
    return
  }
  ensureAttached()

  let tick = 0
  setInterval(() => {
    try {
      follower.poll()
      tick += 1
      if (tick % 8 === 0) ensureAttached() // 每 ~8 轮检查会话切换
      const now = Date.now()
      if (now - pingAt >= PING_MS) {
        pingAt = now
        emit({ kind: 'ping', ts: now, attached: follower.attached, session: follower.sessionId })
      }
    } catch (e) {
      emit({ kind: 'error', message: String((e && e.message) || e) })
    }
  }, ARGS.pollMs)

  const bye = () => {
    try { process.exit(0) } catch (_) {}
  }
  process.on('SIGTERM', bye)
  process.on('SIGINT', bye)
  // 注意：**不要**监听 stdin 'end' 作为退出信号。父进程用 DEVNULL 起我们时
  // stdin 会立即 EOF，那样边车会刚启动就自杀。生命周期由父进程 terminate 掌控。
  process.stdin.on('error', () => {})
  process.stdout.on('error', () => {})
}

try {
  main()
} catch (e) {
  emit({ kind: 'error', message: `fatal: ${(e && e.message) || e}` })
  process.exitCode = 1
}
