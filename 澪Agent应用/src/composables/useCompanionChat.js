/**
 * 大肥鱼聊天 · 数据层（历史 / 发送 / 取消 / 附件 / 对齐轮询）
 *
 * 设计原则（照 AGENTS.md「改前端源码」纪律）：
 *   1. 只注入依赖（getter），不读全局可变状态 —— 与 useConversations 等既有 composable 同构。
 *   2. 不碰 DOM、不碰核心桌宠元素（R1）：所有视觉都在 FeiyuChatPage.vue 里。
 *   3. 只走桌宠自己的接口：/api/companion/chat*（**不是** /api/agent/*，那条路的前端页已被 DSH 专用化移除）。
 *
 * 消息统一成 UI 层好用的形状：
 *   { id, role: 'user'|'assistant'|'system', text, images: [dataUrl], timeLabel, sourceLabel, pending? }
 */
import { nextTick, ref } from 'vue'
import {
  FEIYU_CLOUD_MODEL_ID,
  cancelCompanionChat,
  loadChatSettings,
  loadCompanionChatHistory,
  sendCompanionChat,
} from '../services/companionChatApi.js'

/** 后端历史里的 source → 给用户看的小标签（让"和微信是同一个我"这件事可见） */
const SOURCE_LABELS = {
  desktop_pet: '电脑',
  desktop_pet_wake: '电脑',
  qq: 'QQ',
  wechat: '微信',
  proactive: '主动',
  startup: '启动',
  screen: '画面',
  game: '游戏',
  system: '系统',
}

export function chatSourceLabel(source) {
  return SOURCE_LABELS[String(source || '')] || ''
}

export function formatChatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/** 后端 role 只有 user/assistant/system 三种，其余一律按 assistant（移植文档 6.2） */
function normalizeRole(role) {
  const value = String(role || '').toLowerCase()
  if (value === 'user' || value === 'system') return value
  return 'assistant'
}

/**
 * 把后端历史行映射成 UI 消息。
 * 历史行形如 { id, role, content, source, created_at, ... }（companion.py:2048 chat/history）。
 * 注意历史里**没有**图片字段，所以只还原文本；纯图片轮次后端存的是 `[图片]` 之类占位。
 */
export function mapHistoryRow(row) {
  // 历史行也要过同一道清洗：后端库里可能已经存进了带英文思考的内容，
  // 前端两条路径（历史 / 直接 reply）必须表现一致，否则"刷新前正常、刷新后冒出鬼话"。
  const text = sanitizeAssistantReply(row?.content)
  return {
    id: `h-${row?.id ?? `${row?.created_at || ''}-${text.slice(0, 12)}`}`,
    role: normalizeRole(row?.role),
    text,
    images: [],
    // ★★ 2026-10-22 修「刷新后图片整条消失」：
    //   历史接口现在会带回 attachments（图片/音频的 url），必须挂上；
    //   否则刷新后那条带图的回复只剩文字（用户用两张截图对比确认）。
    attachments: normalizeAttachments(row?.attachments, row?.images),
    // 本轮请求 id：用于"这一轮已经在屏上了就不再补无图历史副本"
    requestId: String(row?.request_id || ''),
    // ★ 排序用：历史行的真实时间（毫秒）。没有它，历史与本地缓存混排时会错乱
    //   （用户实测：20:12 的消息跑到了 22:52 下面）。
    ts: Date.parse(row?.created_at) || 0,
    timeLabel: formatChatTime(row?.created_at),
    sourceLabel: chatSourceLabel(row?.source),
    raw: row,
  }
}

/** 用户一次点发送时选中的附件 → 后端 images[] 需要的 { name, data_url } */
function toBackendImages(attachments) {
  return (attachments || [])
    .filter((item) => item?.kind === 'image' && item?.data_url)
    .slice(0, 5)
    .map((item) => ({ name: item.name || '图片.png', data_url: item.data_url }))
}

/**
 * 把大肥鱼回复里"没用的东西"洗掉。
 *
 * 真实症状（用户截图 2026-10-22）：助手说出来的第一行是
 *   `Could be a test of "你是谁，我在哪" — maybe they're drunk? No. Just answer.大肥鱼。你在自己电脑前…`
 * 也就是把模型自己的**英文思考过程**当成正文念出来了。
 * 后端（routes/companion.py:1520-1533）只剥"第一行不含中文就丢"，但这里英文和中文
 * **粘在同一行**，所以那套行级过滤完全失效 —— 用户看到的就是这段鬼话。
 *
 * 前端这道清洗只做"安全可判定"的部分，宁可不剥也别误伤正文：
 *   1. 去掉 `&&表情&&`、`⟦MODE:xxx⟧` 这类控制标记（后端也去，双保险）；
 *   2. 逐行处理：整行是纯 ASCII（含少量标点）且以 `?` / `.` / `!` 结尾 → 判定为思考残句，丢弃；
 *   3. 行内"英文思考"后紧贴中文的粘连（`No. Just answer.大肥鱼。你在…`）：
 *      在第一个中文字符之前的英文片段，若长得像"句子/指令"（含空格且有句点或问号）→ 整段切掉，
 *      但保留紧跟其后的中文正文。副作用可控：正常中文回答里基本不会出现这种形状。
 *   4. 收尾去掉因此产生的空行。
 */
/**
 * 从正文里切掉"整块可解析的工具调用 JSON"（前端兜底，与后端 strip_tool_payload 同策略）。
 *
 * 真实事故（2026-10-22 抓到的流式现场）：
 *   流式过程中会冒出 `{"id": "call_00_xxx", "name": "send_message_to_user", ...}`，
 *   它不含中文、不以标点结尾 → 行级英文过滤拦不住，
 *   于是同一条回复被拆成两条消息，渲染时"图片/文字跑到提问上面"。
 *
 * 做法与后端一致：扫描 `{`，尝试括号配对解析；若解析结果带工具特征键 → 整块丢弃，
 * 否则原样保留（正常的 `{"a":1}` 引用不会被误吞）。
 */
function stripToolJsonBlocks(input) {
  const s = String(input || '')
  if (!s.includes('{')) return s
  const parseBlock = (start) => {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) return s.slice(start, i + 1)
      }
    }
    return null
  }
  const isToolPayload = (data) => {
    const keys = new Set()
    const collect = (node, depth = 0) => {
      if (depth > 3 || !node || typeof node !== 'object') return
      if (Array.isArray(node)) { node.slice(0, 5).forEach((v) => collect(v, depth + 1)); return }
      Object.keys(node).forEach((k) => {
        keys.add(String(k).toLowerCase())
        collect(node[k], depth + 1)
      })
    }
    collect(data)
    const strong = ['tool_calls', 'function', 'arguments', 'args', 'result', 'call_id']
    if (strong.some((k) => keys.has(k))) return true
    return keys.has('id') && keys.has('ts') && keys.size <= 6
  }
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '{') {
      const block = parseBlock(i)
      if (block) {
        try {
          const data = JSON.parse(block)
          if (data && isToolPayload(data)) {
            i += block.length
            continue
          }
        } catch {
          /* 解析失败 → 当普通文本 */
        }
      }
    }
    out += s[i]
    i += 1
  }
  return out
}

export function sanitizeAssistantReply(raw) {
  let text = String(raw || '')
  if (!text) return ''
  text = text
    .replace(/&&\w+&&/g, '')
    .replace(/⟦[^⟧]*⟧/g, '')
    .replace(/\r\n/g, '\n')

  // ★★★ 2026-10-22 修「思考完秒切顺序颠倒」的真凶之一：
  //   流式期间会冒出一整段**工具调用裸 JSON**（`{"id": "call_00_xxx", ...}`）——
  //   它不含中文、也不以 ?/./! 结尾，所以下面的行级过滤完全不拦，
  //   结果是同一条回复被拆成两条消息（JSON 一条 + 正文一条），
  //   渲染出来就是"图片/文字跑到提问上面、顺序颠倒"。
  //   后端已修（strip_tool_payload），这里是**前端兜底**：从任意位置切掉"整块可解析的
  //   工具载荷 JSON"，其余原文保留。
  text = stripToolJsonBlocks(text)

  const lines = text.split('\n')
  const kept = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      kept.push('')
      continue
    }
    const hasCjk = /[\u3040-\u30ff\u4e00-\u9fff]/.test(trimmed)
    // ① 整行只有英文（含少量标点/符号，没有任何中日韩字符）且像一句思考 → 丢弃。
    //    用"整行是否全英文"判定，而不是"有没有中文"：像 `1. 第一点` 这种有序列表
    //    前面有个 "1."，按"第一个中文字符之前全切"会误伤成"第一点"（已用测试钉住）。
    const asciiOnly = !hasCjk && /^[\x20-\x7E\u2018-\u201F\u2013-\u2014]+$/.test(trimmed)
    if (asciiOnly && /[?.!]$/.test(trimmed)) continue

    // ② 英文思考与中文粘连：切掉第一个中文字符之前的英文片段（仅当它像句子）
    //    例外：`1. 第一点` 这种有序列表 —— 前缀只是个序号，不能当成思考切掉；
    //          `Could be a test of "你是谁，我在哪" — …` 这种"英文句子里引用了中文原话"的思考，
    //          第一个中文字符落在引号内，只从它开始保留会把半句英文留下。
    const firstCjk = trimmed.search(/[\u3040-\u30ff\u4e00-\u9fff]/)
    if (firstCjk > 0) {
      const head = trimmed.slice(0, firstCjk)
      const isListMarker = /^\s*(\d+[.)、]|[-*•]|[A-Za-z][.)])\s*$/.test(head)
      // 英文思考的形状：head 里有英文单词（≥2 个字母的连续片段）且不止一个词
      const looksLikeEnglishProse = /[A-Za-z]{2,}/.test(head) && head.trim().split(/\s+/).length >= 2
      if (looksLikeEnglishProse && !isListMarker) {
        const opensQuote = /["'“「]\s*$/.test(head)
        if (!opensQuote) {
          // ②a 普通粘连（`No. Just answer.大肥鱼。`）→ 从中文字符起保留正文
          kept.push(trimmed.slice(firstCjk))
          continue
        }
        // ②b 英文句子在引号里引用了中文原话（head 末尾引号未闭合）。
        //     这时第一个中文在引号内，不能从它开始留。原实现是**整行丢弃**，
        //     结果把"整条回复只有一行"的情况洗成空串 —— 真实症状：界面上去掉英文思考后
        //     连中文正文也一并不见了（只写"主界面裁剪"这一轮真踩到过）。
        //     现在改为：跳过引号内的中文，找到**引号闭合之后的第一段中英文混合正文**保留。
        const afterQuote = findTextAfterClosingQuote(trimmed, firstCjk)
        if (afterQuote) {
          kept.push(afterQuote)
          continue
        }
        // 实在找不到正文（整行都是思考）才丢
        continue
      }
    }
    kept.push(trimmed)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 在一行里"引号内的中文引用"之后，找回正文起点。
 *
 * 例：`Could be a test of "你是谁，我在哪" — maybe they're drunk? No. Just answer.大肥鱼。你在…`
 *   → 从引号闭合处往后找，跳过后续英文思考，落在 `大肥鱼。` 上并返回它开始的子串。
 * 找不到"像正文的中文段"就返回空串（调用方丢弃整行）。
 */
function findTextAfterClosingQuote(line, fromIndex) {
  const rest = line.slice(fromIndex)
  // 引号闭合位置（中英文引号都算）。
  // ⚠ 不能用 /["'“”「」]/ —— 英文里的撇号（they're / don't）也算单引号，
  //   会先命中撇号导致"闭合位置"找错（实测让这条路径整体失效）。
  //   英文思考里真正用到的引号是双引号，中文引用是 “” 「」。
  const closeMatch = /["“”「」]/.exec(rest)
  const afterClose = closeMatch ? rest.slice(closeMatch.index + 1) : rest
  // 在引号之后，逐个中文片段检查：它前面是否紧跟英文句子（那就是思考，跳到下一个）
  let cursor = afterClose
  for (let guard = 0; guard < 12; guard += 1) {
    const cjkIndex = cursor.search(/[\u3040-\u30ff\u4e00-\u9fff]/)
    if (cjkIndex < 0) return ''
    const before = cursor.slice(0, cjkIndex)
    const candidate = cursor.slice(cjkIndex)
    // 关键：`" — maybe they're drunk? …大肥鱼。` 这种，before（" — maybe they're drunk? No. Just answer."）
    // 里既有英文词也有问号，但**问号属于后面的英文思考，不属于这段中文的引导**。
    // 判据改为"这段中文前面是否紧贴一个英文分句的结尾"：
    //   · 如果 before 去掉空白/连接符后**以句读结尾**（如 "…Just answer."）→ 中文属于思考后的新句子 → 是正文；
    //   · 如果 before 是"半句还没说完"（如开头 `Could be a test of `）→ 中文在英文句子内部 → 仍是思考。
    // 换句话说：这里只需要判断"中文之前的那一小段英文是否已经收尾"。
    const trimmedBefore = before.replace(/[\s—–\-:：,，、]+$/u, '')
    const englishSentenceEnded = /[.?!。！？]["'“”」]?$/.test(trimmedBefore)
    if (englishSentenceEnded) return candidate.trim()
    // 英文句子还没收尾 → 这段中文属于思考，跳到下一个句子边界继续找
    const nextBoundary = candidate.search(/[.?!。！？]["'“”「」\s]/)
    cursor = nextBoundary >= 0 ? candidate.slice(nextBoundary + 1) : ''
    if (!cursor) return ''
  }
  return ''
}

/**
 * 把后端返回的附件整理成 UI 直接能用的形状。
 *
 * 后端 `attachments` 每项：{kind, filename, display, mime_type, size, data_url, error}
 * 兼容：后端若没给 attachments 只给了 images（纯 data URL），也还原成图片附件，
 * 这样"后端某个分支只填了 images"时图片不会丢。
 */
export function normalizeAttachments(rawAttachments, rawImages) {
  const list = []
  for (const item of Array.isArray(rawAttachments) ? rawAttachments : []) {
    if (!item || typeof item !== 'object') continue
    // ★ 2026-10-22 修「对话里的图片一闪就没了」：
    //   后端为绕开 WebSocket 1MB 帧限制，**不再内联 base64**，改为落盘 + 给短 URL：
    //       { media: "image", url: "/api/companion/agent-media/xxx.png", data_url: "" }
    //   而这里以前只读 data_url、且丢弃 media 字段 →
    //   图片要么被当成"加载失败"，要么被当成普通文件卡片。现在两路都收：
    //     · dataUrl 有了（老形状/真内联）
    //     · 否则用 url 拼成绝对地址（新形状）
    const dataUrl = String(item.data_url || '')
    const url = String(item.url || '')
    const src = dataUrl || (url ? absoluteMediaUrl(url) : '')
    const mime = String(item.mime_type || '')
    const media = String(
      item.media
      || (mime.startsWith('image/') ? 'image' : '')
      || (String(item.kind || '') === 'image' ? 'image' : '')
      || (mime.startsWith('audio/') ? 'audio' : '')
      || '',
    )
    list.push({
      kind: String(item.kind || (media === 'image' ? 'image' : 'file')),
      media,
      url: src,
      filename: String(item.filename || ''),
      display: String(item.display || item.filename || '附件'),
      mime_type: mime,
      size: Number(item.size || 0),
      data_url: src,
      error: String(item.error || ''),
      // 用于"同一事件重复投递"判重（见 attachToCurrentReply 注释）
      responseId: String(item.responseId || item.response_id || ''),
    })
  }
  // 兜底：只有 images、没有 attachments
  const covered = new Set(list.map((item) => item.data_url).filter(Boolean))
  for (const url of Array.isArray(rawImages) ? rawImages : []) {
    const dataUrl = String(url || '')
    if (!dataUrl || covered.has(dataUrl) || !dataUrl.startsWith('data:')) continue
    const mime = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png'
    list.push({
      kind: mime.startsWith('image/') ? 'image' : 'file',
      media: mime.startsWith('image/') ? 'image' : 'file',
      url: dataUrl,
      filename: '',
      display: '图片',
      mime_type: mime,
      size: 0,
      data_url: dataUrl,
      error: '',
    })
  }
  return list
}

/** 把后端给的相对媒体路径拼成当前 origin 的绝对地址（<img>/<audio> 直接可用） */
function absoluteMediaUrl(url) {
  const raw = String(url || '')
  if (!raw) return ''
  if (/^(data:|blob:|https?:)/i.test(raw)) return raw
  if (typeof window === 'undefined') return raw
  try {
    return new URL(raw, window.location.origin).toString()
  } catch {
    return raw
  }
}

function existingAttachmentsEqual(a, b) {
  const left = Array.isArray(a) ? a : []
  const right = Array.isArray(b) ? b : []
  if (left.length !== right.length) return false
  // 附件里 data_url 可能很长，只比"可判等的稳定字段"，避免每轮都做整串比较
  return left.every((item, i) => (
    item.filename === right[i].filename
    && item.kind === right[i].kind
    && item.size === right[i].size
  ))
}

function newClientRequestId() {  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  } catch {
    /* 老内核没有 randomUUID 时退回时间戳 */
  }
  return `feiyu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function useCompanionChat(deps) {
  const messages = ref([])
  const historyLoading = ref(false)
  const historyError = ref('')
  const chatModel = ref(FEIYU_CLOUD_MODEL_ID)
  const reasoningLevel = ref('auto')
  /** 组件把滚动容器交上来（DOM 归组件，宿主只是拿个引用做"新消息滚到底"） */
  const scrollEl = ref(null)

  let activeController = null
  let activeRequestId = ''
  let pollTimer = null
  /** 本轮正在流式输出的回答（桌宠气泡与聊天页共用同一条流） */
  let streamingRequestId = ''
  let streamingText = ''
  let streamingWs = null
  /**
   * 本轮"承载图片/音频的那条 assistant 消息"的 id。
   *
   * 为什么需要：WS 的 agent_image 是**逐帧**到达的，同一轮可能来 2~3 帧；如果每帧都新建消息，
   * 同一张图就会在界面上出现两三次（实测就是这个现象）。这里记住第一次选定的消息 id，
   * 后续帧一律挂到同一条上。每轮 send() 开始时重置。
   */
  let lastAttachMessageId = ''
  /**
   * 本轮已经挂上界面的附件 url 集合（**全局去重**，跨消息生效）。
   *
   * 为什么需要它：以前只在"单条消息内部"按 url 去重，一旦那条消息被历史重建/过滤移走，
   * 后续 WS 帧就每帧新建一条消息 → 同一张表情复制成 3 份（用户实拍 2x2 网格里三张一样）。
   * 每轮 send() 开始时清空。
   */
  const attachedUrls = new Set()
  /** WS 断线自动重连（图片/音频只走 WS，断了就永远收不到） */
  let streamReconnectTimer = null
  let streamReconnectAttempt = 0

  /**
   * 订阅桌宠事件总线，把**流式正文**搬进聊天页。
   *
   * 背景（2026-10-22 用户反馈）：
   *   · 「气泡里出现了英文思考过程、我的提问」→ 根因在后端（思考帧带 chain_type=reasoning
   *     被当正文推了），后端已修；
   *   · 「大肥鱼回复跑到气泡后，对话界面不显示」→ 聊天页当时**完全没有订阅 WS**，
   *     只能等 HTTP 返回后才渲染。而云端点歌/长回答时 HTTP 要等很久，
   *     中间那段时间聊天页就是空的，字全跑到气泡里去了。
   * 现在：收到本轮自己的 agent_stream 就实时写进"正在回复"那条消息里，
   * HTTP 返回后用权威 reply 覆盖收尾 —— 与气泡同源、不会再出现"只有气泡有字"。
   */
  /**
   * 把一条图片/音频挂到"当前最后一条助手回复"上。
   *
   * 为什么不能依赖 streamingRequestId：图片帧常常比 HTTP 响应**晚到**，
   * 那时 send() 已经收尾、streamingRequestId 被清空 → 图被丢掉（对话界面连占位都没有）。
   *
   * 落点规则（按优先级）：
   *   1) 还有 streamingRequestId → 挂到 `reply-<id>`（本轮回复）；
   *   2) 否则挂到最后一条 assistant 消息；
   *   3) 连 assistant 都没有 → 新建一条"只有附件"的回复（她只发了图不说话的情况）。
   * 去重规则：**按 url 去重**。
   *   WS 可能把同一张图投递两次（双端订阅/重连重放），同一条回复里同一 url 只留一张。
   *   （2026-10-22 曾误按 response_id 放宽，误解了需求 —— 用户要的是"云端表情库能重复选同一张"，
   *     不是"对话里要能连发同一张图"，已改回按 url。）
   */
  function attachToCurrentReply(item) {
    if (!item) return

    // ★★★ 2026-10-22 最终修「同一张表情复制成 3 份」（用户截图：2x2 网格里同一个 emoji 三张）。
    //   之前的去重只看"**单条消息内部**有没有同 url"，但一旦承载图片的那条消息被
    //   loadHistory 的过滤/排序移走（或 ws 帧在消息重建之后才到），findIndex 就返回 -1，
    //   于是每一帧都**新建一条消息** → 同图多份。刷新后历史里只有一份，所以"刷新就好"。
    //
    //   现在的铁律：**去重键是全局的**，以 url 为准（同一轮内同一 url 只允许存在一份）。
    //   为此维护 attachedUrls：本轮已经挂上的 url 集合，跨消息也生效。
    const url = String(item.url || '')
    if (!url) return
    if (attachedUrls.has(url)) return          // 已经挂过，直接丢弃（不管在哪条消息里）
    // 兜底：即使集合因异常丢了，也扫一遍现有消息里的全部附件
    const alreadyAnywhere = messages.value.some((m) => (
      (m.attachments || []).some((a) => String(a.url || '') === url)
    ))
    if (alreadyAnywhere) return

    const attach = (m) => ({ ...m, attachments: [...(m.attachments || []), item] })
    const list = messages.value
    const tryIds = [
      lastAttachMessageId,
      streamingRequestId ? `reply-${streamingRequestId}` : '',
      activeRequestId ? `reply-${activeRequestId}` : '',
    ].filter(Boolean)
    for (const id of tryIds) {
      const idx = list.findIndex((m) => m.id === id)
      if (idx >= 0) {
        lastAttachMessageId = id
        attachedUrls.add(url)
        setMessages(list.map((m, i) => (i === idx ? attach(m) : m)))
        void scroll()
        return
      }
    }
    // 本轮确实还没有承载图片的消息 → 建一条，并记住它（后续图都挂这条）
    const newId = `attach-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    lastAttachMessageId = newId
    attachedUrls.add(url)
    setMessages([...list, {
      id: newId,
      role: 'assistant',
      text: '',
      images: [],
      attachments: [item],
      ts: Date.now(),
      timeLabel: formatChatTime(new Date().toISOString()),
      sourceLabel: '',
      optimistic: true,
      // 标明属于哪一轮：收尾时依据它把正文合并进来，
      // 避免"图片一条消息、文字另一条消息"（用户看到图在上、字在下、还跑到提问上面）
      requestId: activeRequestId || '',
    }])
    void scroll()
  }

  function ensureStreamSubscription() {
    if (streamingWs || typeof window === 'undefined' || typeof WebSocket === 'undefined') return
    try {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      streamingWs = new WebSocket(`${scheme}//${window.location.host}/api/companion/ws`)
    } catch {
      streamingWs = null
      return
    }
    streamingWs.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      const payload = message.payload || {}
      // ★ 图片/音频**只走 WS**（后端 agent_image / agent_audio），HTTP 响应里没有。
      //   2026-10-22 修「对话里图片一闪就没了」的真凶：
      // 图片/音频**只走 WS**（后端 agent_image / agent_audio），HTTP 响应里的 attachments
      // 经常是空的（用户实测：气泡能显示图、对话界面完全没有）。
      // ★ 2026-10-22 修：以前这里要求 `streamingRequestId` 非空（= 正在发送中）才收，
      //   但图片帧常常比 HTTP 响应**晚到**，此时 send() 的 finally 已经清空了
      //   streamingRequestId → 图片被整条丢掉，对话界面于是"连占位都没有"。
      //   现在：不依赖 streamingRequestId —— 只要大肥鱼这个身份的图/音频到了，
      //   就挂到"当前最后一条助手回复"上（没有就新建一条）。
      if (message?.type === 'agent_image' || message?.type === 'agent_audio') {
        if (String(payload.agent_id || '') !== 'cloud_feiyu') return
        const item = normalizeAttachments([{
          media: message.type === 'agent_audio' ? 'audio' : 'image',
          url: payload.url,
          display: payload.display || payload.filename || (message.type === 'agent_audio' ? '音频' : '图片'),
          mime_type: payload.mime_type || '',
          size: payload.size || 0,
          // ★ 带上本轮 response_id：去重只拦"同一事件的重复投递"，
          //   她连发两次同一张表情时 response_id 不同 → 两张都会显示。
          responseId: String(payload.response_id || ''),
        }], [])[0]
        if (!item) return
        attachToCurrentReply(item)
        return
      }
      if (message?.type !== 'agent_stream') return
      // 只认本轮（大肥鱼发起的）流；别的 Agent 的流不进这张对话
      if (String(payload.agent_id || '') !== 'cloud_feiyu') return
      if (!streamingRequestId) return
      const piece = String(payload.text || '')
      if (!piece) return
      // replace=true：后端在流结束时用清洗后的全文覆盖（剥掉思考/标记）
      streamingText = payload.replace ? piece : streamingText + piece
      applyStreamingText()
    }
    streamingWs.onclose = () => {
      streamingWs = null
      // ★★ 2026-10-22 修「图片/音频根本收不到」的核心：
      //   后端日志多次出现 `connection closed`（应用重启、自关闭、网络抖动都会触发）。
      //   旧实现断线后**只能等下一次 send() 才重连** —— 而图片是"发完之后"才到的，
      //   此时连接已断，帧永远收不到，表现就是"气泡有时能显示、对话界面永远没图"。
      //   现在：断线后自动重连（带退避，避免风暴）。
      if (streamReconnectTimer) return
      streamReconnectAttempt += 1
      const delay = Math.min(10000, 500 * 2 ** Math.min(streamReconnectAttempt, 5))
      streamReconnectTimer = window.setTimeout(() => {
        streamReconnectTimer = null
        ensureStreamSubscription()
      }, delay)
    }
    streamingWs.onopen = () => {
      // 连上即重置退避，稳定链路不会累积延迟
      streamReconnectAttempt = 0
    }
  }

  function applyStreamingText() {
    if (!streamingRequestId) return
    const id = `reply-${streamingRequestId}`
    const text = sanitizeAssistantReply(streamingText)
    updateMessages((m) => m.map((item) => (
      item.id === id ? { ...item, text, streaming: true } : item
    )))
    void scroll()
  }

  function teardownStreamSubscription() {
    streamingRequestId = ''
    streamingText = ''
    if (streamingWs) {
      try {
        streamingWs.close()
      } catch {
        /* ignore */
      }
      streamingWs = null
    }
  }

  /**
   * 本地会话缓存。
   *
   * 为什么必须有它：后端的 cloud_feiyu 直通分支**不落库**（见文件头 / services/companionChatApi.js 坑 2），
   * 所以 GET /chat/history 永远是空的。如果这边不自己记，用户切到桌宠页再切回来，
   * 刚才聊的内容就蒸发了 —— 这是比"界面丑"更让人抓狂的行为退化。
   * 只缓存**本机发出的**轮次（role/text/时间），图片不缓存（data URL 太大，而且换页后无意义）。
   */
  const LOCAL_STORE_KEY = 'mio_feiyu_local_turns'
  const LOCAL_STORE_MAX = 120
  /**
   * 认不出时间的消息的兜底排序值。
   * 必须是**模块级常量**（进程内恒定）—— 用 Date.now() 每次比较都不同会破坏排序稳定性，
   * 历史踩过两次（消息乱跳 / ReferenceError）。取一个极大的常数，等价于"排在最后"。
   */
  const FALLBACK_TS = 8.64e15

  function readLocalTurns() {
    try {
      const raw = localStorage.getItem(LOCAL_STORE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.text) : []
    } catch {
      return []
    }
  }

  function writeLocalTurns(turns) {
    try {
      localStorage.setItem(LOCAL_STORE_KEY, JSON.stringify(turns.slice(-LOCAL_STORE_MAX)))
    } catch {
      // 配额满 / 隐私模式禁写：缓存是增强，不阻断聊天
    }
  }

  function rememberLocalTurns(entries) {
    if (!entries.length) return
    const existing = readLocalTurns()
    const keys = new Set(existing.map((item) => `${item.role}\u0000${item.text}`))
    const fresh = entries.filter((item) => {
      const key = `${item.role}\u0000${item.text}`
      if (keys.has(key)) return false
      keys.add(key)
      return true
    })
    if (fresh.length) writeLocalTurns([...existing, ...fresh])
  }

  /**
   * 修复「历史顺序错乱」（2026-10-22 用户截图：20:12 的消息跑到了 22:52 下面）。
   *
   * 根因：此前 `hydrateFromLocalStore` 用本地缓存**重建列表**，而缓存的顺序
   * 取决于 `rememberLocalTurns` 的写入顺序（按"轮次完成先后"），不是时间顺序；
   * 点击刷新/切页后，历史(h-*)与缓存(local-turn-*)被拼在一起 → 前后错乱。
   *
   * 现在的铁律（三层保障）：
   *   ① 缓存**只能补缺**，绝不替换/重排已有消息；
   *   ② 所有消息都带可排序的时间（`ts`），没有 `ts` 的按 id 里的时间戳兜底；
   *   ③ 组装完**统一按 ts 稳定排序**，保证"从旧到新"永远成立。
   */
  function messageTs(item) {
    if (!item) return 0
    if (Number(item.ts) > 0) return Number(item.ts)
    // 从 id 里捞时间戳：只认 13 位毫秒（attach-<13位>-<随机>）
    const m = String(item.id || '').match(/(?:^|[^\d])(1\d{12})(?:[^\d]|$)/)
    if (m) {
      const n = Number(m[1])
      // 只接受 2020-01-01 之后、现在的 1 天以内，避免把随机数当时间
      if (n > 1577836800000 && n <= Date.now() + 86400000) return n
    }
    // ★★ 认不出时间的消息（如 `reply-<uuid>` —— uuid 里没有 13 位数字）：
    //   必须给一个**稳定**的兜底值。
    //   历史两次踩坑：
    //     ① 早期用 `Date.now()+1000` → 每次比较都重新求值，同一条消息在两次 sort
    //        比较里拿到不同 ts，排序不稳定 → 消息乱跳（用户实测"回复跑到列表最顶部"）；
    //     ② 前一轮把 `const now` 写进了 if 块内、却在块外 return，直接 ReferenceError。
    //   现在用模块级常量 FALLBACK_TS：进程内恒定、且晚于所有真实时间（排在最后）。
    return FALLBACK_TS
  }

  function sortByTime(list) {
    // 稳定排序：ts 相同则保持原相对顺序（避免同一秒内的问答互换）
    return list
      .map((item, index) => ({ item, index, ts: messageTs(item) }))
      .sort((a, b) => (a.ts - b.ts) || (a.index - b.index))
      .map((entry) => entry.item)
  }

  /**
   * ★★★ 唯一允许写 messages 的入口：**写完立刻按时间排序**。
   *
   * 为什么必须有它（2026-10-22 用户连续三次反馈"图片/回复跑到我提问上面"，且"刷新后正常"）：
   *   之前 `sortByTime` 只在 hydrate（读本地缓存）时调用一次，
   *   而流式期间的每一步（新建占位、WS 图片挂载、HTTP 收尾、历史补齐）都是直接
   *   `messages.value = [...]` 追加或映射 —— **完全不排序**。
   *   于是流式期间的顺序取决于"哪条代码路径先跑"：
   *     · 图片帧先到 → 新建 attach 消息 append 到末尾（看起来在提问后面）
   *     · 但占位/收尾消息的 ts 可能更早 → 下一次排序（刷新时）就换了位置
   *   这就是"流式颠倒、刷新正常"的机制。
   *
   * 现在所有写入都走这里 → 任何时刻列表都是按 ts 单调递增。
   * 保留 `setMessages` 的第二个参数 `replace`（默认 true 排序；内部做局部 map 时也可用）。
   */
  function setMessages(next) {
    messages.value = sortByTime(Array.isArray(next) ? next : [])
  }

  /** 对现有列表做局部变更（map/filter）后仍然排序写回 */
  function updateMessages(fn) {
    setMessages(fn(messages.value))
  }

  function hydrateFromLocalStore() {
    const raw = readLocalTurns()
    if (!raw.length) return false
    const cached = raw.map((item, index) => ({
      id: `local-turn-${index}-${String(item.time || '').slice(-6)}`,
      role: normalizeRole(item.role),
      text: String(item.text || ''),
      images: [],
      attachments: [],
      ts: Date.parse(item.time) || 0,
      timeLabel: formatChatTime(item.time),
      sourceLabel: '',
      optimistic: true,
    }))
    // ★ 同样不能用 role+text 当身份（同一句话会重复说很多次）：
    //   只在"列表为空"时才用本地缓存铺底；有历史在屏上时，缓存只补**比最早一条更早**的整段。
    if (messages.value.length === 0) {
      setMessages(cached)
      return true
    }
    const earliest = Math.min(...messages.value.map((m) => messageTs(m)))
    const olderOnly = cached.filter((item) => item.ts > 0 && item.ts < earliest)
    if (!olderOnly.length) return false
    // 只补"早于当前最早一条"的缓存，且按 id 去重（id 含时间片，稳定的）
    const existingIds = new Set(messages.value.map((m) => m.id))
    const add = olderOnly.filter((item) => !existingIds.has(item.id))
    if (!add.length) return false
    setMessages([...messages.value, ...add])
    return true
  }

  const scroll = async () => {
    await nextTick()
    deps.scrollToBottom?.()
  }

  /**
   * 把历史行合并进列表。
   *
   * ★★★ 2026-10-22 根治「思考完秒切、顺序颠倒、跟以前完全一样」。
   *
   * 真凶：**用 `role+text` 当消息身份**。
   *   实测这个会话里「发个表情包」出现了 **22 次**、「发张图」7 次 —— 用户一直在测同一句话。
   *   而旧实现把"文本相同"当成"同一条消息"：
   *     · `fresh` 过滤把新历史行当成"本地已有了"丢掉；
   *     · `kept` 又把本地真实的那几条当成"已被历史覆盖"删掉。
   *   于是每次 loadHistory 都会**随机吃掉几条真实的 user 消息**、再补进几条别处的，
   *   列表总条数变化、顺序错位 —— 而且**刷新一次后数据重组刚好恢复正常**，
   *   所以现象永远像"流式时错、刷新后对"。
   *
   * 正确做法：消息身份只用 **id**（历史行 `h-<db id>`、本地行 `reply-<requestId>` /
   * `local-<requestId>` / `attach-*`），文本只用于**同一轮**的去重兜底（配对 request_id）。
   * 同一句话重复说 22 次是完全合法的，不能被合并。
   */
  function appendHistoryRows(rows) {
    const incoming = (rows || []).map(mapHistoryRow)
    if (!incoming.length) return false
    const existingIds = new Set(messages.value.map((item) => item.id))
    // 本轮"已由 HTTP reply 上屏"的 request_id：这些轮次不要再补一条无图历史副本
    const localRequestIds = new Set(
      messages.value.filter((m) => m.requestId).map((m) => String(m.requestId)),
    )
    // 1) 只补"id 没见过"且"不属于已在屏上的轮次"的历史行
    const fresh = incoming.filter((item) => {
      if (existingIds.has(item.id)) return false
      const rid = String(item.requestId || '')
      if (rid && localRequestIds.has(rid)) return false
      return true
    })
    // 2) 本地消息**一律保留**（除非 id 与某条历史行完全相同 → 视为同一行）
    const incomingIds = new Set(incoming.map((item) => item.id))
    const kept = messages.value.filter((item) => !incomingIds.has(item.id))
    // ⚠️ 注意：**不能按 requestId 去重**！同一轮的 user 与 assistant 共享同一个
    //   request_id（实测），按它去重会把每条提问都删掉（踩过一次：n 从 200 掉到 100）。
    //   重复上屏的正确判据是 id（h-<dbid> 唯一），已在上面按 existingIds 处理。
    const changed = kept.length !== messages.value.length || fresh.length > 0
    if (!changed) return false
    setMessages([...kept, ...fresh])
    return true
  }

  /**
   * 把本轮 HTTP 响应里的回答写到 UI（按 requestId 幂等，重复调用不会重复插入）。
   *
   * 为什么需要它：cloud_feiyu 直通分支不落库 → 历史接口拿不到这一轮，reply 才是唯一真相。
   * 同时 upsert 而非 push，是因为"历史恰好也返回了这条"时不能出现两条一样的回答。
   */
  function upsertReply(requestId, result) {
    // ★ 必须清洗：后端 cloud_feiyu 会把模型思考过程和正文一起塞进 reply（见 sanitizeAssistantReply 注释）
    const reply = sanitizeAssistantReply(result?.reply).trim()
    // 本轮 HTTP 返回的附件（可能为空 —— 图片走 WS 时这里经常是 []）
    const incomingAttachments = normalizeAttachments(result?.attachments, result?.images)
    const id = `reply-${requestId}`
    const existing = messages.value.find((item) => item.id === id)
    // ★★ 2026-10-22 三修「图一闪就没」的**最关键一处**：
    //   图片是经 WS（agent_image）先到的，挂在 `reply-<id>` 上；
    //   然后 HTTP 返回，如果它的 attachments 是空数组，
    //   旧代码用 `attachments` 直接覆盖 → **把 WS 刚写进去的图抹掉了**。
    //   现在：以"已有附件 + HTTP 附件"的**并集**为准（按 url 去重），
    //   HTTP 没给也不影响已经显示的图。
    const attachments = (() => {
      const base = Array.isArray(existing?.attachments) ? existing.attachments : []
      if (!base.length) return incomingAttachments
      // 去重键：url + filename（**不含 responseId**）——
      // HTTP 这条路的附件没有 response_id，而它和 WS 那条是**同一张图的两次投递**，
      // 必须合并成一条；同一张图"两次不同发送"后端已给不同 url，所以不会误合并。
      const keyOf = (a) => `${a.url || ''}\u0000${a.filename || ''}`
      const seen = new Set(base.map(keyOf))
      const extra = incomingAttachments.filter((a) => {
        const key = keyOf(a)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return extra.length ? [...base, ...extra] : base
    })()
    // 只有附件、没有正文的轮次（她只发了个表情包）也要显示，不能因 reply 为空就整条丢掉。
    // ★ 2026-10-22 修「收尾后出现空壳消息」：
    //   以前这里只要 existing 存在，就用 `{ ...item, attachments, streaming:false }` 收尾，
    //   于是**占位消息（text 为空、也没附件）被标成完成** → 界面上只剩「Mio 22:54」一个空壳，
    //   刷新后才被历史行替换成正常内容。
    //   现在：没有正文也没有附件时**不动它**（让下面的出错/兜底路径去清理），交给调用方处理。
    if (!reply && !attachments.length) return false
    if (existing) {
      // 分别判断：文字同、且附件也相同，才跳过（否则只更新附件/只更新文字的场景会被漏掉）
      const textSame = existing.text === reply
      const attSame = existingAttachmentsEqual(existing.attachments, attachments)
      if (textSame && attSame && existing.streaming !== true) return false
      updateMessages((m) => m.map((item) => (
        // 收尾：清掉 streaming 标记，否则"正在思考"三点会一直挂着
        item.id === id ? { ...item, text: reply, attachments, streaming: false } : item
      )))
      return true
    }
    // 历史里已经有一条一模一样的回答（真落了库的情况）→ 不重复插入
    const duplicated = messages.value.some((item) => (
      item.role === 'assistant' && !item.optimistic && item.text === reply && !attachments.length
    ))
    if (duplicated) return false
    setMessages([...messages.value, {
      id,
      role: 'assistant',
      text: reply,
      images: [],
      attachments,
      ts: Date.now(),
      timeLabel: formatChatTime(new Date().toISOString()),
      sourceLabel: '',
      // 标成 optimistic：不进历史去重池，但换页后由本地缓存（见 rememberLocalTurns）续命
      optimistic: true,
      requestId,
    }])
    return true
  }

  async function loadHistory({ quiet = false } = {}) {
    // 页面一打开就常驻订阅 WS：图片/音频**只走 WS**，
    // 而 `send()` 收尾时会拆掉订阅 → 之前只有"正在发送"的窗口能收到图，
    // 图晚到就丢（用户实测：气泡有图、对话界面没有）。
    ensureStreamSubscription()
    if (!quiet) {
      historyLoading.value = true
      historyError.value = ''
    }
    try {
      const data = await loadCompanionChatHistory(200)
      let grew = appendHistoryRows(data?.messages || [])
      // 服务端历史（通常为空，见 backend 不落库）补齐后，再把本机缓存里的轮次补回来
      grew = hydrateFromLocalStore() || grew
      if (grew) await scroll()
      return data
    } catch (error) {
      // 历史接口失败不该让整个聊天页白屏：留空状态 + 本机缓存照样能看
      if (!quiet) historyError.value = String(error?.message || error)
      if (hydrateFromLocalStore()) await scroll()
      return null
    } finally {
      historyLoading.value = false
    }
  }

  /** 聊天共享设置（模型 / 思考档位）。端点不存在时静默保持默认值。 */
  async function loadSettings() {
    const saved = await loadChatSettings({ quiet: true })
    if (!saved) return null
    if (saved.model_id) chatModel.value = saved.model_id
    if (saved.reasoning_level) reasoningLevel.value = saved.reasoning_level
    return saved
  }

  function startPolling(intervalMs = 8000) {
    stopPolling()
    pollTimer = window.setInterval(() => {
      // 正在发送时不轮询：避免把还没落库的本地消息冲掉；发送结束后 refreshMessages 会补一次
      if (deps.sending.value) return
      void loadHistory({ quiet: true })
    }, intervalMs)
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function send(text, attachments = []) {
    const content = String(text || '').trim()
    const images = toBackendImages(attachments)
    if ((!content && !images.length) || deps.sending.value) return false

    deps.sending.value = true
    deps.error.value = ''
    const requestId = newClientRequestId()
    activeRequestId = requestId

    // 乐观上屏
    setMessages([...messages.value, {
      id: `local-${requestId}`,
      role: 'user',
      text: content || '[图片]',
      images: (attachments || []).filter((item) => item?.kind === 'image' && item?.preview_url).map((item) => item.preview_url),
      ts: Date.now(),
      timeLabel: formatChatTime(new Date().toISOString()),
      sourceLabel: '',
      optimistic: true,
    }])
    // 先占一条"正在回复"的助手消息：流式增量到了就往里写，
    // 这样等待 HTTP 的那十几秒里聊天页不是空的。
    setMessages([...messages.value, {
      id: `reply-${requestId}`,
      role: 'assistant',
      text: '',
      images: [],
      ts: Date.now(),
      timeLabel: formatChatTime(new Date().toISOString()),
      sourceLabel: '',
      optimistic: true,
      streaming: true,
      // ★ 必须带 requestId：attachToCurrentReply / upsertReply 都靠它把
      //   "图片消息"和"正文消息"认成同一轮，否则会各建一条 → 末尾多一条 assistant
      //   （用户实测：流式时顺序颠倒、刷新后正常）。
      requestId,
    }])
    lastAttachMessageId = ''
    attachedUrls.clear()
    streamingRequestId = requestId
    streamingText = ''
    ensureStreamSubscription()
    await scroll()

    const controller = new AbortController()
    activeController = controller
    try {
      const result = await sendCompanionChat({
        message: content,
        images,
        model_id: chatModel.value || FEIYU_CLOUD_MODEL_ID,
        reasoning_level: reasoningLevel.value || 'auto',
        client_request_id: requestId,
      }, controller.signal)
      // ★ 为什么要"对齐历史之后还要拿 result.reply 再兜一层"：
      //   后端 cloud_feiyu 直通分支**根本不落库**（docs/大肥鱼聊天-后端契约审计.md 结论 4 /
      //   routes/companion.py:1464-1553 全段无 db.save_message），所以 loadHistory 经常
      //   压根拿不回这一轮问答。reply 是唯一的真相来源，必须在本地补上，否则用户发完消息
      //   就看不到回答（旧版 FeiyuChatPage 正是靠这个才"看起来能聊"）。
      //   同时也解释了为什么轮询不能"以服务端为准直接覆盖"——它只会一直在同一份旧历史上。
      // ★ 顺序很重要（2026-10-22 修「对话里图片不显示」）：
      //   以前是 loadHistory() → upsertReply()。而 loadHistory 会把**刚落的这轮**当成历史行插进来
      //   （历史行不带附件），并且它的"去重"逻辑把 WS 已经收到图片的 `reply-*` 占位消息
      //   当作"已被历史覆盖"删掉了 —— 结果正文有、图片没了。
      //   现在：先 upsertReply（用 HTTP 结果把正文和附件写进同一条消息），再拉历史补齐别的轮次。
      //   历史里如果有同一轮，appendHistoryRows 会按 role+text 去重，不会重复插入。
      upsertReply(requestId, result)
      await loadHistory({ quiet: true })
      // 落本机缓存：切页/进别的页面再回来还能看到（server 端 cloud_feiyu 不落库，
      // 历史接口取不到这一轮；这是"再次进入对话界面历史全没了"的关键修复）。
      // 存的是**清洗后**的文本，和屏幕上看到的保持一致。
      const replyForStore = sanitizeAssistantReply(result?.reply).trim()
        || sanitizeAssistantReply(streamingText).trim()
      rememberLocalTurns([
        { role: 'user', text: content || '[图片]', time: new Date().toISOString() },
        { role: 'assistant', text: replyForStore, time: new Date().toISOString() },
      ].filter((item) => item.text))
      await scroll()
      return true
    } catch (error) {
      if (error?.code === 'request_cancelled') {
        deps.error.value = '已停下这次回复'
      } else {
        deps.error.value = String(error?.message || error)
      }
      // 失败：撤掉悬空的乐观提问与空回复（保留已经说出来的部分），并把服务端可能写进去的补齐
      updateMessages((m) => m.filter((item) => (
        !(item.optimistic && item.role === 'user' && item.id === `local-${requestId}`)
        && !(item.id === `reply-${requestId}` && !String(item.text || '').trim())
      )))
      await loadHistory({ quiet: true })
      return false
    } finally {
      activeController = null
      // ★ 保留 activeRequestId 一小段时间（不立刻清空）：
      //   图片/音频帧常常比 HTTP 响应**晚到几百毫秒**，如果这里马上清空，
      //   attachToCurrentReply 就认不出"这轮是谁"，只能新建一条 → 同一条回复出现两个气泡。
      //   方案：清空延后到 8 秒后（若这期间又发了新消息，新 id 会覆盖它，无副作用）。
      const finishedRequestId = requestId
      window.setTimeout(() => {
        if (activeRequestId === finishedRequestId) activeRequestId = ''
      }, 8000)
      // ★ 不拆订阅：图片/音频只走 WS，拆了之后晚到的图就收不到（对话界面无图）。
      //   只清本轮流式标记，WS 连接保留（页面级常驻）。
      streamingRequestId = ''
      streamingText = ''
      // ★ 兜底清 streaming 标记：无论成功/失败/取消，本轮那条占位消息都不能再是"流式中"，
      //   否则「正在思考」三点会永久挂在对话里（用户实测：结束后两轮都卡着）。
      updateMessages((m) => m.map((item) => {
        if (item.id !== `reply-${requestId}`) return item
        if (!String(item.text || '').trim() && !(item.attachments || []).length) return item
        return item.streaming ? { ...item, streaming: false } : item
      }))
      // ★★ 2026-10-22 修「收尾后留下空壳气泡（只有 Mio + 时间，里面什么都没有）」：
      //   本轮如果**既没正文、也没图片/音频**（云端空回复 / 被清洗成空 / 请求失败），
      //   那条占位消息就是空壳，必须删掉，否则界面上永久留一个空白气泡。
      //   但只要它有附件（她只发图不说话）就必须留下。
      updateMessages((m) => m.filter((item) => {
        const isReply = item.id === `reply-${requestId}`
        const isAttach = String(item.id).startsWith('attach-')
        if (!isReply && !isAttach) return true
        const hasText = Boolean(String(item.text || '').trim())
        const hasAttach = (item.attachments || []).length > 0
        return hasText || hasAttach
      }))
      deps.sending.value = false
    }
  }

  async function cancel() {
    if (!deps.sending.value || !activeController) return
    // 先在前端断开：
    //   · cloud_feiyu 直通分支绕过了 chat_run_coordinator，后端的 /chat/cancel **对它无效**，
    //     abort fetch 是唯一真正"停下"的手段（后端会把已等到的 chunk 拼完，但结果不再被采用）；
    //   · 本地模型那条路仍能受益于 /chat/cancel，所以照样发一次（失败静默）。
    activeController.abort('user_cancelled')
    try {
      await cancelCompanionChat(activeRequestId)
    } catch {
      // 取消接口失败不影响前端已经停下的状态，不打扰用户
    }
  }

  function reset() {
    messages.value = []
    historyError.value = ''
  }

  return {
    messages,
    historyLoading,
    historyError,
    chatModel,
    reasoningLevel,
    scrollEl,
    loadHistory,
    loadSettings,
    send,
    cancel,
    reset,
    startPolling,
    stopPolling,
  }
}
