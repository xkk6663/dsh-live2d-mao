<!--
  大肥鱼对话页 · 纯 UI 层
  ============================================================================
  移植来源：`C:\Users\xiao1\Mao\xiaozhi-chat-ui\src\components\XiaoZhiChat.vue`
  （小智对话界面的 UI 提取包，基线 = 原项目 澪Agent应用 v3.5 的 ChatPage）。

  移植原则（与提取包一致）：
    1. 纯 UI：组件内 **不 fetch / 不建 WebSocket / 不碰 AudioContext / 不 inject 宿主 context**。
       数据走 props，动作走 emits，宿主（App.vue）自己接后端。
    2. 样式外置：视觉全部来自 `src/styles/feiyu-chat.css`（= 提取包 chat-ui.css 的移植，
       作用域 `.xz-chat`）。本组件不含 <style> 块，避免 scoped 样式盖掉那套"最终裁决"。
    3. 类名照抄提取包（`.chat-layout` / `.message-bubble` / `.composer` …），
       因为 CSS 里所有规则都挂在 `.xz-chat` + 这些类名上。

  与原版（小智）的差异 —— 都是 DSH 专用化后的必要调整，不是随意的改动：
    · 助手名/头像/占位文案可配，默认「大肥鱼」+ /api/companion/avatar；
    · 不再有 QQ 清理模式（那是小智插件的能力，本仓库后端 /api/agent/* 已阉割）；
    · 顶部「新对话」改由父级 class 隐藏（桌宠会话是**单一固定会话**，刷历史而不是开会话）；
    · 连接状态文案「大肥鱼已连接 / 连接中…」；
    · 助手回答按行拆段渲染（`.message-text`，不放引号），避免多行长文被「」包成一坨；
      **单段短回复仍然落在 `.message-bubble` 上**，`「」` 引号体视觉与提取包一致；
    · 保留发送/停止、附件暂存条、粘贴上传、拖拽投放、自动滚动跟随、会话抽屉（多会话时自动出现）。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  FileText,
  ImageOff,
  MessageSquareText,
  Pin,
  Plus,
  Send,
  SquarePen,
  Trash2,
  Upload,
  UserRound,
  X,
} from '@lucide/vue'

const props = defineProps({
  /* ---------------- 数据 ---------------- */
  /**
   * 消息列表：{ id?, role: 'user'|'assistant'|'system', text,
   *            images?: string[]（本地选中的图，data URL）,
   *            attachments?: Array<{kind, filename, display, mime_type, size, data_url, error}>
   *              （大肥鱼发回来的附件；图片带 data_url，其它类型只有元信息）,
   *            timeLabel?, sourceLabel? }[]
   */
  messages: { type: Array, default: () => [] },
  /** 会话列表：{ id, title, preview?, kind?, updated_at? }[]（桌宠只有一条会话时留空即可） */
  conversations: { type: Array, default: () => [] },
  selectedConversationId: { type: [String, Number], default: null },
  /** 待发送的附件：{ id, kind: 'image'|'file', name, size, preview_url? }[] */
  attachments: { type: Array, default: () => [] },
  /** 助手名（默认「大肥鱼」） */
  assistantName: { type: String, default: '大肥鱼' },
  /** 助手头像 URL；留空时显示首字母圆形占位 */
  avatarUrl: { type: String, default: '' },
  /** 输入框草稿（受控）。传 null 则组件内部自管。 */
  draft: { type: String, default: null },
  /** 连接状态：true 显示绿点「已连接」，false 显示黄点「连接中…」 */
  connected: { type: Boolean, default: false },
  /** 状态点在连接中时显示的文案 */
  connectingLabel: { type: String, default: '大肥鱼连接中…' },
  /** 状态点在已连接时显示的文案 */
  connectedLabel: { type: String, default: '大肥鱼已连接' },
  /** 助手是否正在思考（显示三点动画行） */
  thinking: { type: Boolean, default: false },
  /** 发送中（禁用发送键与会话操作；同时把发送键换成「停止」） */
  sending: { type: Boolean, default: false },
  /** 当前模型是否支持识图（false 时图片附件下方出提示） */
  visionSupported: { type: Boolean, default: true },
  /** 拖拽文件进入中（由宿主维护，用于显示投放遮罩） */
  fileDragging: { type: Boolean, default: false },
  /** 空会话时的提示语 */
  emptyTitle: { type: String, default: '我在这里' },
  emptyHint: { type: String, default: '现在想说什么？' },
  /** 输入框 placeholder */
  placeholder: { type: String, default: '和大肥鱼聊点什么...' },
  /** 自定义背景：CSS 变量对象，如 { '--chat-background-image': 'url(...)' } */
  backgroundStyle: { type: Object, default: () => ({}) },
  /** 左侧会话抽屉是否默认展开 / 固定 */
  drawerDefaultOpen: { type: Boolean, default: false },
  drawerDefaultPinned: { type: Boolean, default: false },
  /** 是否显示左侧会话抽屉（桌宠只有一条共享会话，默认关掉） */
  showDrawer: { type: Boolean, default: false },
  /** 是否自动跟随滚动到底部 */
  followDefault: { type: Boolean, default: true },
})
const emit = defineEmits([
  /** 发送文本（附带当前附件，宿主负责清空） */
  'send',
  /** 请求停止当前回复 */
  'stop',
  'create-conversation',
  'select-conversation',
  'rename-conversation',
  'delete-conversation',
  'files-selected',
  'remove-attachment',
  'preview-image',
  'drag-enter',
  'drag-over',
  'drag-leave',
  'drop',
  'update:draft',
  /** 滚动容器就绪（宿主据此做强制滚到底） */
  'scroll-ready',
])

/* ---------------------------------------------------------------------------
 * 内部状态
 * ------------------------------------------------------------------------- */
const drawerOpen = ref(props.drawerDefaultOpen)
const drawerPinned = ref(props.drawerDefaultPinned)
const fileInput = ref(null)
const chatScroll = ref(null)
const followChat = ref(props.followDefault)
const innerDraft = ref('')

// 草稿：受控 / 非受控两用
const draftValue = computed({
  get: () => (props.draft === null ? innerDraft.value : props.draft),
  set: (value) => {
    innerDraft.value = value
    emit('update:draft', value)
  },
})

const hasBackground = computed(() => Boolean(props.backgroundStyle?.['--chat-background-image']))

const activeConversation = computed(
  () => props.conversations.find((item) => item.id === props.selectedConversationId) || null,
)

// 桌宠会话是单一固定会话 → 会话列表为空时不渲染抽屉（也就不占栅格列）
const drawerVisible = computed(() => props.showDrawer && props.conversations.length > 0)

/**
 * 最后一条消息是不是"流式占位中"的助手消息（还没有字）。
 * 用来避免和 thinking 那条独立"正在思考"行重复渲染（见模板注释）。
 */
const hasStreamingPlaceholder = computed(() => {
  const last = props.messages[props.messages.length - 1]
  return Boolean(last && last.role === 'assistant' && last.streaming && !String(last.text || '').trim())
})

const classList = computed(() => [
  // ★ 三个类缺一不可：
  //   .xz-chat              —— feiyu-chat.css 的全部规则都以它为作用域前缀
  //   .chat-layout          —— 栅格骨架规则是 `.xz-chat.chat-layout`
  //   .integrated-chat-layout —— 集成外壳的尺寸/边框规则都挂这个类
  'xz-chat',
  'chat-layout',
  'integrated-chat-layout',
  {
    'xz-drawer-pinned': drawerPinned.value && drawerVisible.value,
    'has-custom-background': hasBackground.value,
    'file-drag-active': props.fileDragging,
    'xz-no-drawer': !drawerVisible.value,
  },
])

/* ---------------------------------------------------------------------------
 * 滚动跟随
 * ------------------------------------------------------------------------- */
function scrollToBottom() {
  const el = chatScroll.value
  if (el) el.scrollTop = el.scrollHeight
}

function onScroll() {
  // 用户手动上滑即暂停跟随，滑回底部恢复
  const el = chatScroll.value
  if (!el) return
  followChat.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

watch(
  () => [props.messages.length, props.thinking],
  () => {
    if (followChat.value) nextTick(scrollToBottom)
  },
  { flush: 'post' },
)

/* ---------------------------------------------------------------------------
 * 发送 / 停止
 * ------------------------------------------------------------------------- */
function submit() {
  const text = draftValue.value.trim()
  if ((!text && !props.attachments.length) || props.sending) return
  emit('send', text, props.attachments)
  draftValue.value = ''
}

function onSendClick() {
  if (props.sending) {
    emit('stop')
    return
  }
  submit()
}

function onKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    submit()
    event.preventDefault()
  }
}

/* ---------------------------------------------------------------------------
 * 附件
 * ------------------------------------------------------------------------- */
function pickFiles() {
  fileInput.value?.click()
}

function onFileChange(event) {
  const files = Array.from(event.target.files || [])
  if (files.length) emit('files-selected', files)
  event.target.value = ''
}

function onPaste(event) {
  const items = event.clipboardData?.items
  if (!items) return
  const files = []
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length) {
    event.preventDefault()
    emit('files-selected', files)
  }
}

/* ---------------------------------------------------------------------------
 * 会话抽屉
 * ------------------------------------------------------------------------- */
function openConversation(id) {
  emit('select-conversation', id)
  if (!drawerPinned.value) drawerOpen.value = false
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function avatarLetter() {
  return (props.assistantName || '?').slice(0, 1)
}

/** 助手长回答按空行拆段（每段成一个 .message-text），避免整篇被「」括成一块 */
function assistantParagraphs(message) {
  const text = String(message?.text || '')
  if (!text) return []
  return text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
}

function isMultiParagraph(message) {
  return assistantParagraphs(message).length > 1
}

onMounted(() => {
  if (followChat.value) nextTick(scrollToBottom)
})

onBeforeUnmount(() => {
  // 组件卸载时不需要做清理（无定时器、无 listener），保留钩子便于后续加
})

defineExpose({ scrollToBottom })

// 把滚动容器交给宿主：历史/轮询补齐后宿主可能想强制滚到底（用户手动上滑时不抢）。
watch(
  chatScroll,
  (el) => emit('scroll-ready', el || null),
  { immediate: true, flush: 'post' },
)
</script>

<template>
  <div :class="classList" :style="backgroundStyle || {}">
    <!-- ============ 左侧会话抽屉（桌宠单会话时自动隐藏） ============ -->
    <template v-if="drawerVisible">
      <button
        v-if="drawerOpen && !drawerPinned"
        class="conversation-drawer-backdrop"
        type="button"
        aria-label="关闭对话列表"
        @click="drawerOpen = false"
      />
      <aside v-if="drawerOpen || drawerPinned" class="conversation-drawer">
        <header>
          <div>
            <MessageSquareText :size="17" />
            <strong>对话窗口</strong>
            <span>{{ conversations.length }}</span>
          </div>
          <button
            type="button"
            :class="{ active: drawerPinned }"
            :title="drawerPinned ? '取消固定' : '固定抽屉'"
            @click="drawerPinned = !drawerPinned"
          >
            <Pin :size="14" />
          </button>
        </header>
        <button class="conversation-new-button" type="button" @click="emit('create-conversation')">
          <Plus :size="15" />新对话
        </button>
        <div class="conversation-drawer-list">
          <article
            v-for="conversation in conversations"
            :key="conversation.id"
            :class="{ active: selectedConversationId === conversation.id }"
          >
            <button type="button" @click="openConversation(conversation.id)">
              <span>
                <strong>{{ conversation.title }}</strong>
                <small>{{ conversation.preview || '还没有消息' }}</small>
              </span>
              <time>{{ conversation.time_label || '' }}</time>
            </button>
            <div class="conversation-drawer-actions">
              <button type="button" title="重命名" @click="emit('rename-conversation', conversation)">
                <SquarePen :size="13" />
              </button>
              <button type="button" title="删除" @click="emit('delete-conversation', conversation)">
                <Trash2 :size="13" />
              </button>
            </div>
          </article>
        </div>
      </aside>
      <button
        v-if="!drawerOpen && !drawerPinned"
        class="conversation-drawer-trigger"
        type="button"
        @click="drawerOpen = true"
      >
        <MessageSquareText :size="14" /><span>{{ activeConversation?.title || '对话窗口' }}</span>
      </button>
    </template>

    <!-- ============ 主聊天列 ============ -->
    <section
      class="xz-chat-column chat-column"
      @dragenter.prevent="emit('drag-enter', $event)"
      @dragover.prevent="emit('drag-over', $event)"
      @dragleave="emit('drag-leave', $event)"
      @drop.prevent="emit('drop', $event)"
    >
      <div v-if="fileDragging" class="file-drop-overlay">
        <Upload :size="25" /><strong>松开即可添加到对话</strong><span>图片、PDF、Word 和其他文件都可以</span>
      </div>

      <!-- 消息区 -->
      <div ref="chatScroll" class="message-scroll" @scroll.passive="onScroll">
        <div v-if="messages.length || thinking" class="message-list">
          <article
            v-for="(turn, index) in messages"
            :key="turn.id ?? `xz-${index}`"
            :class="['message-row', turn.role]"
          >
            <!-- 助手头像：有图用图，无图用首字母 -->
            <img
              v-if="turn.role === 'assistant' && avatarUrl"
              class="message-avatar assistant-avatar"
              :src="avatarUrl"
              :alt="assistantName"
            />
            <span
              v-else-if="turn.role === 'assistant'"
              class="message-avatar assistant-avatar avatar-fallback"
              :aria-label="assistantName"
              >{{ avatarLetter() }}</span
            >

            <div v-if="turn.role === 'system'" class="sys-msg">{{ turn.text }}</div>

            <div v-else class="message-body">
              <!-- ★ 名字行要占满 message-body 的宽度，再靠 align-self 对齐：
                   .message-row.user .message-body 是 flex-column + align-items:flex-end，
                   普通 flex 子项会被收缩成内容宽度（实测 47px）——那样"你 12:34"和正文各靠各的，
                   视觉上名字浮在消息中间（实机截图里就是这个毛病）。
                   助手侧同理：stretch 后名字/正文左边缘与头像一致，不会被正文宽度带偏。 -->
              <div class="message-heading">
                <strong>{{ turn.role === 'assistant' ? assistantName : '你' }}</strong>
                <span v-if="turn.sourceLabel && turn.role === 'assistant'" class="message-source">{{ turn.sourceLabel }}</span>
                <span v-else-if="turn.timeLabel" class="message-time">{{ turn.timeLabel }}</span>
              </div>

              <!-- 图片附件（本轮本地选中的图；用户消息走这里） -->
              <div v-if="turn.images && turn.images.length" class="message-part">
                <button
                  v-for="(image, imageIndex) in turn.images"
                  :key="`${turn.id}-img-${imageIndex}`"
                  type="button"
                  class="message-bubble message-bubble-image"
                  title="点击放大"
                  @click="emit('preview-image', { ...turn, url: image })"
                >
                  <img :src="image" :alt="'图片'" />
                </button>
              </div>

              <!-- ★ 大肥鱼发回来的附件（云端多模态 → 桌面端）
                   注意：后端**不内联 base64**（WebSocket 单帧上限 1MB），
                   图片/音频给的是短 URL（/api/companion/agent-media/xxx），
                   这里按 att.media 判断类型：image→<img>、audio→<audio>、其它→下载卡片。 -->
              <div v-if="turn.attachments && turn.attachments.length" class="message-part message-attachment-block">
                <template v-for="(att, attIndex) in turn.attachments" :key="`${turn.id}-att-${attIndex}`">
                  <button
                    v-if="att.media === 'image' && att.url"
                    type="button"
                    class="message-bubble message-bubble-image"
                    :title="att.display || '点击放大'"
                    @click="emit('preview-image', { ...turn, url: att.url, name: att.display })"
                  >
                    <img :src="att.url" :alt="att.display || '图片'" loading="lazy" />
                  </button>
                  <span v-else-if="att.media === 'image'" class="message-attachment-card is-broken" :title="att.error || '图片下载失败'">
                    <ImageOff :size="15" /><span>{{ att.display || '图片' }}</span><em>加载失败</em>
                  </span>
                  <!-- 语音/点歌的音频：直接在消息里给一个播放条（可拖动进度） -->
                  <audio
                    v-else-if="att.media === 'audio' && att.url"
                    class="message-audio-player"
                    :src="att.url"
                    controls
                    preload="none"
                    :title="att.display || '音频'"
                  />
                  <a
                    v-else-if="att.url"
                    class="message-attachment-card"
                    :href="att.url"
                    :download="att.display || att.filename || '附件'"
                    target="_blank"
                    rel="noopener"
                  >
                    <FileText :size="15" />
                    <span>{{ att.display || att.filename || '附件' }}</span>
                    <em v-if="att.size">{{ formatFileSize(att.size) }}</em>
                  </a>
                  <span v-else class="message-attachment-card is-broken" :title="att.error || ''">
                    <FileText :size="15" /><span>{{ att.display || att.filename || '附件' }}</span><em>取不到</em>
                  </span>
                </template>
              </div>

              <!-- ★ 流式等待中（已占位、还没有字）：显示「正在思考…」三点动画。
                   2026-10-22 修：占位消息的 text 初始为空串，直接套下面的
                   "空回复"分支 → 用户先看到一句「（这条回复没有可显示的内容）」，
                   等云端出字后再被替换，观感像"她先说没内容再说内容"。 -->
              <div v-if="turn.role === 'assistant' && turn.streaming && !turn.text" class="message-part">
                <div class="thinking-indicator"><i /><i /><i /></div>
              </div>
              <!-- 正文：单段走 .message-bubble（「」引号体），多段拆 .message-text -->
              <div v-else-if="turn.role === 'assistant' && isMultiParagraph(turn)" class="message-part message-text-list">
                <p v-for="(paragraph, pIndex) in assistantParagraphs(turn)" :key="pIndex" class="message-text">{{ paragraph }}</p>
              </div>
              <!-- ★ 这一行以前是 v-else-if="turn.text"，空串就不会渲染。
                   后果：万一清洗把回复整段判成"思考"（见 useCompanionChat.sanitizeAssistantReply），
                   界面上会出现「有头像和名字、但底下什么都没有」的幽灵气泡 —— 用户完全看不出
                   是"回复被过滤了"还是"没回复"。空回复必须显式告知，不能静默留白。
                   但"只发了图片/表情包、没有文字"是正常情况，不能补这句废话。 -->
              <div v-else-if="turn.text || !(turn.attachments && turn.attachments.length)" class="message-part">
                <div class="message-bubble">{{ turn.text || '（这条回复没有可显示的内容）' }}</div>
              </div>
            </div>

            <span v-if="turn.role === 'user'" class="message-avatar user-avatar" aria-label="你">
              <UserRound :size="18" />
            </span>
          </article>

          <!-- 思考中：★ 只有"没有流式占位消息"时才渲染这一条独立行。
               2026-10-22 修「发一次出现两轮正在思考」：
               以前 thinking prop 无条件渲染这一行，而宿主同时又会先插一条
               streaming 的占位助手消息（它自己也显示三点动画）→ 同一次发送出现两个气泡。
               现在以占位消息为准，只有宿主没插占位（thinking=true 但最后一条不是占位）时才兜底。 -->
          <article
            v-if="thinking && !hasStreamingPlaceholder"
            class="message-row assistant pending-message"
          >
            <img
              v-if="avatarUrl"
              class="message-avatar assistant-avatar"
              :src="avatarUrl"
              :alt="assistantName"
            />
            <span v-else class="message-avatar assistant-avatar avatar-fallback">{{ avatarLetter() }}</span>
            <div class="message-body">
              <div class="message-heading"><strong>{{ assistantName }}</strong><span>正在思考</span></div>
              <div class="thinking-indicator"><i /><i /><i /></div>
            </div>
          </article>
        </div>

        <!-- 空状态 -->
        <div v-else class="empty-chat">
          <img v-if="avatarUrl" class="empty-chat-avatar" :src="avatarUrl" :alt="assistantName" />
          <h2>{{ emptyTitle }}</h2>
          <p>{{ emptyHint }}</p>
        </div>
      </div>

      <!-- 底部输入区 -->
      <div class="composer-wrap">
        <div class="composer">
          <!-- 附件暂存条 -->
          <div v-if="attachments.length" class="attachment-preview-list">
            <div v-for="attachment in attachments" :key="attachment.id" class="attachment-preview">
              <img v-if="attachment.kind === 'image'" :src="attachment.preview_url" :alt="attachment.name" />
              <FileText v-else :size="19" />
              <span>
                <strong>{{ attachment.name }}</strong>
                <small>{{ formatFileSize(attachment.size) }}</small>
              </span>
              <button type="button" title="移除附件" @click="emit('remove-attachment', attachment.id)">
                <X :size="14" />
              </button>
            </div>
          </div>

          <p v-if="attachments.some((item) => item.kind === 'image') && !visionSupported" class="vision-warning">
            当前模型不支持识图，图片会保存在本地，但{{ assistantName }}无法读取内容
          </p>

          <textarea
            v-model="draftValue"
            class="composer-input"
            rows="1"
            :placeholder="placeholder"
            @keydown="onKeydown"
            @paste="onPaste"
          />

          <div class="composer-actions">
            <input ref="fileInput" class="file-input" type="file" multiple @change="onFileChange" />
            <button type="button" class="icon-button xz-attach-button" title="添加图片或文件" @click="pickFiles">
              <Upload :size="16" />
            </button>
            <span :class="['xz-link-status', { connected }]">{{ connected ? connectedLabel : connectingLabel }}</span>
            <span class="composer-flex-spacer" />
            <button
              type="button"
              :class="['send-button', { 'stop-button': sending }]"
              :title="sending ? '停止回复' : '发送'"
              :disabled="!sending && !draftValue.trim() && !attachments.length"
              @click="onSendClick"
            >
              <SquarePen v-if="sending" :size="15" />
              <Send v-else :size="17" />
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
