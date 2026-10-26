<!--
  传输助手面板（大肥鱼界面内部 · 左侧可展开/折叠抽屉）· 2026-10-26
  ============================================================================
  电脑 ↔ 微信 的**零 token 直传通道**（不经 LLM，云端插件只做搬运）：
    · 打开时每 2s 轮询 GET /api/companion/relay/messages（微信→电脑 收件清单）
    · 发送走 POST /api/companion/relay/send（multipart: text + files，≤5 个/单文件 20MB）
    · 附件预览/下载走 GET /api/companion/relay/media?filename=<云端存储名>
    · 微信侧入口：发「#传 想说的话」（文字/图片/文件都会进收件清单）

  留底说明：云端只保留「微信→电脑」清单；电脑发出去的清单送完即删（.done），
  所以本机发送靠**本地回显 + localStorage 持久化**（key: feiyu-relay-sent-v1，
  只存元信息不存文件本体，历史里的本机图片重启后只剩文件名条目）。

  定位说明：本组件挂在 FeiyuChatPage 根（.xz-chat.chat-layout）内部 —— 它已有
  position:relative，absolute 锚定即"大肥鱼界面之内"，不会钉到整窗右缘
  （2026-10-26 用户实测 fixed 到视口右侧会被应用右栏裁掉，改为界面内左侧）。
  页内最高 z-index 是 30，本组件取 40 压在页内容之上、窗级弹窗之下。

  纪律：不碰核心桌宠 DOM（R1），全部类名 relay-* 自成作用域 + scoped 样式；
  数据自管（fetch + 定时器），不依赖 useCompanionChat（那是 LLM 会话的通道）。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FileText, Send, Upload, X } from '@lucide/vue'

const SENT_KEY = 'feiyu-relay-sent-v1'
const POLL_OPEN_MS = 2000
const POLL_CLOSED_MS = 6000
const MAX_FILES = 5
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_KEEP = 200

const open = ref(false)
const entries = ref([]) // 云端收件（from=wechat）：{id, ts, from, text, files:[{name,stored,kind}], failed?}
const sentLog = ref([]) // 本机发送留底（from=pc）：{id, ts, from, text, files:[{name,kind,size}]}
const draft = ref('')
const picked = ref([]) // {file, name, size, kind, preview_url?}
const sending = ref(false)
const errorText = ref('')
const hintText = ref('')
const unread = ref(0)
const listEl = ref(null)
const fileInputEl = ref(null)

let seenIds = new Set()
let timer = null

const merged = computed(() => {
  const all = [...sentLog.value, ...entries.value]
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  return all
})

/* ---------------- 本机留底 ----------------
   服务端持久化优先（/api/companion/relay/sent，跨窗口/重启可靠），
   localStorage 只作后端不在时的兜底缓存。 */
function stripLocalUrl(entries) {
  // localUrl 是本会话的 blob: 对象 URL，不能持久化（重载后回退为文件名条目）
  return entries.map((entry) => ({
    ...entry,
    files: (entry.files || []).map(({ localUrl, ...rest }) => rest),
  }))
}

function saveSent() {
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(stripLocalUrl(sentLog.value.slice(-MAX_KEEP))))
  } catch {
    /* 存储满时静默（留底是尽力而为） */
  }
  fetch('/api/companion/relay/sent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: stripLocalUrl(sentLog.value.slice(-MAX_KEEP)) }),
  }).catch(() => {
    /* 后端不在时静默，下次发送会再带上全量 */
  })
}

async function loadSent() {
  // 服务器与本地缓存**按 id 合并**（服务器返回空数组不代表本地没有，
  // 反之亦然）；后端不在时全靠本地。
  let serverEntries = null
  try {
    const resp = await fetch('/api/companion/relay/sent')
    if (resp.ok) {
      const data = await resp.json()
      if (data && data.ok && Array.isArray(data.entries)) serverEntries = data.entries
    }
  } catch {
    /* 后端不在，全靠本地 */
  }
  let localEntries = null
  try {
    const raw = JSON.parse(localStorage.getItem(SENT_KEY) || '[]')
    if (Array.isArray(raw)) localEntries = raw
  } catch {
    localEntries = null
  }
  const merged = new Map()
  for (const entry of [...(serverEntries || []), ...(localEntries || [])]) {
    const id = String((entry && entry.id) || '')
    if (id && !merged.has(id)) merged.set(id, entry)
  }
  sentLog.value = [...merged.values()]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(-MAX_KEEP)
  for (const item of sentLog.value) seenIds.add(item.id)
  // 服务器还没留底而本地有历史 → 顺手迁移上服务器
  if (serverEntries && !serverEntries.length && sentLog.value.length) saveSent()
}

/* ---------------- 轮询 ---------------- */
async function poll() {
  try {
    const resp = await fetch('/api/companion/relay/messages')
    if (!resp.ok) return
    const data = await resp.json()
    if (!data || !data.ok || !Array.isArray(data.entries)) return
    const fresh = data.entries.filter((item) => item && item.id && !seenIds.has(item.id))
    if (!fresh.length) return
    for (const item of fresh) seenIds.add(item.id)
    entries.value.push(...fresh)
    if (entries.value.length > MAX_KEEP) entries.value = entries.value.slice(-MAX_KEEP)
    if (!open.value) {
      unread.value += fresh.length
    } else {
      nextTick(scrollBottom)
    }
  } catch {
    /* 后端不在/离线时静默，下轮再试 */
  }
}

function startPolling() {
  stopPolling()
  timer = setInterval(poll, open.value ? POLL_OPEN_MS : POLL_CLOSED_MS)
}

function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
}

watch(open, async (value) => {
  errorText.value = ''
  startPolling()
  if (value) {
    unread.value = 0
    await poll()
    nextTick(scrollBottom)
  }
})

/* ---------------- 发送 ---------------- */
async function send() {
  if (sending.value) return
  const text = draft.value.trim()
  if (!text && !picked.value.length) return
  sending.value = true
  errorText.value = ''
  try {
    const fd = new FormData()
    fd.append('text', text)
    for (const p of picked.value) fd.append('files', p.file, p.name)
    const resp = await fetch('/api/companion/relay/send', { method: 'POST', body: fd })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok || !data.ok) throw new Error(data.detail || `发送失败（${resp.status}）`)
    // 本机回显：图片/音频挂 blob URL（localUrl），仅本会话有效、不进 localStorage。
    // 微信个人号通道（weixin_oc）不支持文件段 → 非 image 类到微信端只会收到文件名通知
    // （云端插件 v3.2.0 会补发通知），所以这里不回收已发送的 preview_url。
    sentLog.value.push({
      id: data.id || `local-${Date.now()}`,
      ts: data.ts || Math.floor(Date.now() / 1000),
      from: 'pc',
      text,
      files: picked.value.map((p) => ({
        name: p.name,
        kind: p.kind,
        size: p.size,
        localUrl: p.kind === 'image' || p.kind === 'audio' ? p.preview_url : '',
      })),
    })
    if (sentLog.value.length > MAX_KEEP) sentLog.value = sentLog.value.slice(-MAX_KEEP)
    saveSent()
    picked.value = []
    draft.value = ''
    hintText.value = ''
    nextTick(scrollBottom)
  } catch (err) {
    errorText.value = String(err.message || err)
  } finally {
    sending.value = false
  }
}

function onKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send()
  }
}

/* ---------------- 附件 ---------------- */
function onPickFiles(event) {
  errorText.value = ''
  hintText.value = ''
  for (const file of Array.from(event.target.files || [])) {
    if (picked.value.length >= MAX_FILES) {
      errorText.value = `一条最多带 ${MAX_FILES} 个文件`
      break
    }
    if (file.size > MAX_FILE_BYTES) {
      errorText.value = `${file.name} 超过 20MB 上限`
      continue
    }
    const type = file.type || ''
    const kind = type.startsWith('image/') ? 'image' : type.startsWith('audio/') ? 'audio' : 'file'
    picked.value.push({
      file,
      name: file.name,
      size: file.size,
      kind,
      preview_url: kind === 'image' || kind === 'audio' ? URL.createObjectURL(file) : '',
    })
  }
  if (picked.value.some((p) => p.kind === 'file')) {
    hintText.value = '微信个人号通道暂不支持文件直发：这类文件在微信端只会收到文件名通知，图片/文字不受影响'
  }
  event.target.value = ''
}

function removePick(index) {
  const [item] = picked.value.splice(index, 1)
  revokePick(item)
}

function revokePick(item) {
  if (item && item.preview_url) URL.revokeObjectURL(item.preview_url)
}

/* ---------------- 渲染辅助 ---------------- */
function mediaUrl(stored) {
  return `/api/companion/relay/media?filename=${encodeURIComponent(stored)}`
}

function fmtTime(ts) {
  const d = new Date((Number(ts) || 0) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function fmtSize(bytes) {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function scrollBottom() {
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

onMounted(() => {
  loadSent()
  startPolling()
  poll()
})

onBeforeUnmount(() => {
  stopPolling()
  for (const p of picked.value) revokePick(p)
})
</script>

<template>
  <div :class="['relay-root', { open }]">
    <!-- 折叠态：右缘把手（有未读时显示角标） -->
    <button class="relay-handle" type="button" title="打开传输助手" @click="open = true">
      <span class="relay-handle-icon"><Send :size="14" /></span>
      <span class="relay-handle-text">传输助手</span>
      <i v-if="unread && !open" class="relay-badge">{{ unread > 99 ? '99+' : unread }}</i>
    </button>

    <!-- 展开抽屉 -->
    <aside class="relay-drawer">
      <header class="relay-head">
        <div class="relay-head-titles">
          <strong>传输助手</strong>
          <small>电脑 ↔ 微信 · 直传不烧 token</small>
        </div>
        <button class="relay-icon-btn" type="button" title="收起" @click="open = false">
          <X :size="15" />
        </button>
      </header>

      <div ref="listEl" class="relay-list">
        <p v-if="!merged.length" class="relay-empty">
          微信里发「#传 想说的话」就会出现在这里；<br />
          下面输入框发出去的，直接到微信。
        </p>
        <div
          v-for="item in merged"
          :key="item.id"
          :class="['relay-row', item.from === 'wechat' ? 'them' : item.from === 'system' ? 'sys' : 'me']"
        >
          <span class="relay-meta">
            {{ item.from === 'wechat' ? '微信' : item.from === 'system' ? '提醒' : '我' }} · {{ fmtTime(item.ts) }}
          </span>
          <div class="relay-bubble">
            <template v-if="item.files && item.files.length">
              <template v-for="(f, fi) in item.files" :key="`${item.id}-f-${fi}`">
                <!-- 图片：云端来的有 stored（走 /media），本机发的有 localUrl（本会话 blob） -->
                <a
                  v-if="f.kind === 'image' && (f.stored || f.localUrl)"
                  class="relay-img"
                  :href="f.stored ? mediaUrl(f.stored) : f.localUrl"
                  target="_blank"
                  rel="noopener"
                  :title="f.name || '查看图片'"
                >
                  <img :src="f.stored ? mediaUrl(f.stored) : f.localUrl" :alt="f.name || '图片'" loading="lazy" />
                </a>
                <!-- 音频：直接给播放条 -->
                <audio
                  v-else-if="f.kind === 'audio' && (f.stored || f.localUrl)"
                  class="relay-audio"
                  :src="f.stored ? mediaUrl(f.stored) : f.localUrl"
                  controls
                  preload="none"
                  :title="f.name || '音频'"
                />
                <a
                  v-else
                  class="relay-file"
                  :href="f.stored ? mediaUrl(f.stored) : '#'"
                  :download="f.name || '附件'"
                  rel="noopener"
                >
                  <FileText :size="14" />
                  <span>{{ f.name || '附件' }}</span>
                  <em v-if="f.size">{{ fmtSize(f.size) }}</em>
                </a>
              </template>
            </template>
            <p v-if="item.text" class="relay-text">{{ item.text }}</p>
            <p v-if="item.failed && item.failed.length" class="relay-failed">
              有 {{ item.failed.length }} 个资源微信端取不到
            </p>
          </div>
        </div>
      </div>

      <footer class="relay-composer">
        <div v-if="picked.length" class="relay-picked">
          <span v-for="(p, pi) in picked" :key="`${p.name}-${pi}`" class="relay-chip">
            <img v-if="p.preview_url" :src="p.preview_url" alt="" />
            <FileText v-else :size="12" />
            <em>{{ p.name }}</em>
            <button type="button" title="移除" @click="removePick(pi)"><X :size="11" /></button>
          </span>
        </div>
        <p v-if="errorText" class="relay-error">{{ errorText }}</p>
        <p v-if="hintText && !errorText" class="relay-hint">{{ hintText }}</p>
        <div class="relay-input-row">
          <textarea
            v-model="draft"
            class="relay-input"
            rows="1"
            placeholder="发给微信…（Enter 发送）"
            @keydown="onKeydown"
          />
          <input ref="fileInputEl" class="relay-file-input" type="file" multiple @change="onPickFiles" />
          <button class="relay-icon-btn" type="button" title="添加图片或文件" @click="fileInputEl?.click()">
            <Upload :size="15" />
          </button>
          <button
            class="relay-send-btn"
            type="button"
            title="发送"
            :disabled="sending || (!draft.trim() && !picked.length)"
            @click="send"
          >
            <Send :size="14" />
          </button>
        </div>
      </footer>
    </aside>
  </div>
</template>

<style scoped>
/* 锚定在大肥鱼界面（.xz-chat.chat-layout，relative）内部左侧；根容器不拦点击 */
.relay-root {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 0;
  z-index: 40;
  pointer-events: none;
  font-family: inherit;
}

/* ---------- 折叠态把手（左缘） ---------- */
.relay-handle {
  pointer-events: auto;
  position: absolute;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 7px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-left: none;
  border-radius: 0 10px 10px 0;
  background: rgba(24, 27, 36, 0.9);
  color: rgba(235, 238, 245, 0.88);
  cursor: pointer;
  backdrop-filter: blur(8px);
  transition: background 0.2s;
}
.relay-handle:hover {
  background: rgba(36, 40, 52, 0.95);
}
.relay-handle-icon {
  display: grid;
  place-items: center;
}
.relay-handle-text {
  writing-mode: vertical-rl;
  letter-spacing: 3px;
  font-size: 12px;
}
.relay-badge {
  position: absolute;
  top: -6px;
  right: -8px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: #e5534b;
  color: #fff;
  font-size: 10px;
  font-style: normal;
  line-height: 17px;
  text-align: center;
  font-weight: 600;
}

/* ---------- 抽屉（从左滑出） ---------- */
.relay-drawer {
  pointer-events: auto;
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 330px;
  display: flex;
  flex-direction: column;
  background: rgba(18, 20, 26, 0.95);
  backdrop-filter: blur(12px);
  border-right: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 12px 0 32px rgba(0, 0, 0, 0.35);
  transform: translateX(-102%);
  transition: transform 0.24s ease;
}
.relay-root.open .relay-drawer {
  transform: translateX(0);
}
.relay-root.open .relay-handle {
  display: none;
}

.relay-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.relay-head-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.relay-head-titles strong {
  font-size: 14px;
  color: #edf0f6;
}
.relay-head-titles small {
  font-size: 11px;
  color: rgba(235, 238, 245, 0.5);
}

.relay-icon-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: rgba(235, 238, 245, 0.7);
  cursor: pointer;
}
.relay-icon-btn:hover {
  background: rgba(255, 255, 255, 0.09);
  color: #fff;
}

/* ---------- 消息列表 ---------- */
.relay-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.relay-empty {
  margin: auto;
  text-align: center;
  font-size: 12px;
  line-height: 1.9;
  color: rgba(235, 238, 245, 0.45);
}
.relay-row {
  display: flex;
  flex-direction: column;
  max-width: 88%;
}
.relay-row.me {
  align-self: flex-end;
  align-items: flex-end;
}
.relay-row.them {
  align-self: flex-start;
  align-items: flex-start;
}
.relay-meta {
  font-size: 10px;
  color: rgba(235, 238, 245, 0.4);
  margin-bottom: 4px;
  padding: 0 2px;
}
.relay-bubble {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 11px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}
.relay-row.them .relay-bubble {
  background: rgba(7, 193, 96, 0.16); /* 微信绿 */
  border: 1px solid rgba(7, 193, 96, 0.25);
  color: #e6f7ec;
  border-top-left-radius: 4px;
}
.relay-row.me .relay-bubble {
  background: rgba(77, 140, 255, 0.18); /* 电脑端蓝 */
  border: 1px solid rgba(77, 140, 255, 0.28);
  color: #e7eefc;
  border-top-right-radius: 4px;
}
/* 系统提醒（云端投递失败等）：居中窄条 */
.relay-row.sys {
  align-self: center;
  align-items: center;
  max-width: 96%;
}
.relay-row.sys .relay-bubble {
  background: rgba(229, 169, 90, 0.12);
  border: 1px solid rgba(229, 169, 90, 0.35);
  color: #ecd9b0;
  border-radius: 10px;
  font-size: 12px;
}
.relay-text {
  margin: 0;
  white-space: pre-wrap;
}
.relay-text + .relay-text {
  margin-top: 2px;
}
.relay-img {
  display: block;
  border-radius: 8px;
  overflow: hidden;
  max-width: 100%;
}
.relay-img img {
  display: block;
  max-width: 100%;
  max-height: 180px;
  object-fit: contain;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.25);
}
.relay-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.07);
  color: #dfe5f0;
  text-decoration: none;
  font-size: 12px;
  max-width: 100%;
}
.relay-file:hover {
  background: rgba(255, 255, 255, 0.12);
}
.relay-file span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.relay-file em {
  font-style: normal;
  font-size: 10px;
  color: rgba(235, 238, 245, 0.45);
  flex-shrink: 0;
}
.relay-failed {
  margin: 0;
  font-size: 11px;
  color: #e5a05a;
}

/* ---------- 输入区 ---------- */
.relay-composer {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.relay-picked {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.relay-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.08);
  color: #dfe5f0;
  font-size: 11px;
  max-width: 100%;
}
.relay-chip img {
  width: 18px;
  height: 18px;
  object-fit: cover;
  border-radius: 4px;
}
.relay-chip em {
  font-style: normal;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.relay-chip button {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border: none;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  cursor: pointer;
}
.relay-chip button:hover {
  background: rgba(229, 83, 75, 0.8);
}
.relay-error {
  margin: 0;
  font-size: 11px;
  color: #ff8a80;
}
.relay-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #e5a05a;
}
.relay-audio {
  /* 固定宽：width:100% 会在 shrink-to-fit 气泡里塌缩成 0 宽（实测空泡泡） */
  width: 240px;
  max-width: 100%;
  height: 34px;
}
.relay-input-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.relay-input {
  flex: 1;
  resize: none;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: #edf0f6;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  padding: 7px 10px;
  max-height: 96px;
}
.relay-input:focus {
  outline: none;
  border-color: rgba(77, 140, 255, 0.55);
}
.relay-input::placeholder {
  color: rgba(235, 238, 245, 0.35);
}
.relay-file-input {
  display: none;
}
.relay-send-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: none;
  border-radius: 9px;
  background: #3f76e0;
  color: #fff;
  cursor: pointer;
}
.relay-send-btn:hover:not(:disabled) {
  background: #4d86ef;
}
.relay-send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
