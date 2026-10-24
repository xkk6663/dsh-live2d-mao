<script setup>
import { computed, ref } from 'vue'
import { Check, Gamepad2, ImagePlus, Play, Plus, Power, RefreshCw, RotateCw, Trash2, Volume2 } from '@lucide/vue'

const props = defineProps({
  status: { type: Object, required: true },
  avatarUrl: { type: String, required: true },
  busy: { type: Boolean, default: false },
  controlMode: { type: Boolean, default: false },
  managementMode: { type: Boolean, default: false },
  feedback: { type: Object, default: null },
})
const emit = defineEmits([
  'control',
  'delete-live2d',
  'import-live2d',
  'preview-expression',
  'preview-motion',
  'refresh-status',
  'replace-live2d-preview',
  'manage',
  'save',
  'save-size',
  'select-live2d',
])
const pet = computed(() => props.status.pet || { settings: {} })
const settings = computed(() => pet.value.settings || {})
const live2d = computed(() => pet.value.live2d || {})
const appAssetBase = window.location.pathname.startsWith('/agent-app') ? '/agent-app' : ''

// 项目内置模型（随仓库分发，打 featured 标）——「内置/外部导入」分区管理的前提
const FEATURED_MODEL_IDS = ['whale-deepseek', 'da-feiyu']
const appearanceItems = computed(() => [
  ...(live2d.value.models || []).map((model) => ({
    id: model.id,
    name: model.name,
    type: 'Live2D',
    preview: model.preview_url
      ? `${model.preview_url}?v=${encodeURIComponent(model.id)}`
      : model.preview_path
        ? `${appAssetBase}/live2d-pet/${model.preview_path}`
        : props.avatarUrl,
    imported: Boolean(model.imported),
    capabilities: model.capabilities || {},
    featured: FEATURED_MODEL_IDS.includes(model.id),
  })),
])
// 内置模型按 featured 降序（项目内置排前面），并算出每个分组的标题（DSH专用 / 官方免费）
const builtInGroups = computed(() => {
  const list = appearanceItems.value
    .filter((item) => !item.imported)
    .sort((a, b) => Number(b.featured) - Number(a.featured))
  let previous = null
  return list.map((item) => {
    const title = item.featured === previous ? '' : item.featured ? 'DSH专用模型' : 'Live2D官方免费模型'
    previous = item.featured
    return { item, title }
  })
})
const importedItems = computed(() => appearanceItems.value.filter((item) => item.imported))

const selectedLive2D = computed(() => {
  if (settings.value.pet_renderer !== 'live2d') return null
  return appearanceItems.value.find((item) => item.id === settings.value.live2d_model_id) || null
})
const motionLabels = {
  idle: '待机', touch: '触碰', think: '思考', speak: '说话', observe: '观察',
  cheerful: '开心', concerned: '担心', alert: '警觉', attention: '注意', shy: '害羞', listen: '聆听',
}
const expressionLabels = {
  neutral: '自然', gentle: '温柔', cheerful: '开心', concerned: '担心', serious: '认真', shy: '害羞', alert: '警觉',
}
// 任务状态（phase）→ 表现绑定：每个状态可选「自动 / 某个动作槽 / 某个表情槽」。
// 存的是**槽名**（不是具体动作名），换模型不用重配。
const phaseLabels = {
  idle: '待机', planning: '规划', thinking: '思考', executing_tool: '执行工具',
  streaming: '回复中', waiting_input: '聆听', voice: '语音', complete: '完成',
  error: '出错', paused: '暂停', awaiting_approval: '待确认',
}
const selectedMotions = computed(() => selectedLive2D.value?.capabilities?.motions || [])
const selectedExpressions = computed(() => selectedLive2D.value?.capabilities?.expressions || [])
const currentMotionSlots = computed(() => {
  if (!selectedLive2D.value) return {}
  settings.value.live2d_motion_slots ||= {}
  settings.value.live2d_motion_slots[selectedLive2D.value.id] ||= {}
  return settings.value.live2d_motion_slots[selectedLive2D.value.id]
})
const currentExpressionSlots = computed(() => {
  if (!selectedLive2D.value) return {}
  settings.value.live2d_expression_slots ||= {}
  settings.value.live2d_expression_slots[selectedLive2D.value.id] ||= {}
  return settings.value.live2d_expression_slots[selectedLive2D.value.id]
})
// 任务状态绑定：每个 phase 固定补一个 {motion:'', expression:''} 对象，
// 否则 v-model 写不进不存在的键（Vue 3 对 undefined 嵌套写入会静默丢）。
const currentPhaseSlots = computed(() => {
  if (!selectedLive2D.value) return {}
  settings.value.live2d_phase_slots ||= {}
  const perModel = settings.value.live2d_phase_slots[selectedLive2D.value.id] ||= {}
  Object.keys(phaseLabels).forEach((phase) => {
    const binding = perModel[phase]
    if (!binding || typeof binding !== 'object') {
      perModel[phase] = { motion: '', expression: '' }
      return
    }
    // ★ 2026-10-24：显式给键 —— 后端返回的绑定只带"填过的键"（没选动作就没有 motion），
    //   v-model 往缺键上写会被 Vue 3 静默丢掉，表现为"选了动作/表情，一保存就没了"。
    if (typeof binding.motion !== 'string') binding.motion = ''
    if (typeof binding.expression !== 'string') binding.expression = ''
  })
  return perModel
})

// 实时刷新该桌宠管理界面：面板自己拉一次状态，把结果上抛给父层写回 store。
// 为什么不让面板直接改 store：面板在「桌宠管理页」和「设置→桌宠」两处都被渲染，
// 只有前者有 provide 上下文；上抛 emit 让两处都能各自处理，且保持单向数据流。
const refreshBusy = ref(false)
const refreshTip = ref('')
async function refreshPanel() {
  if (refreshBusy.value) return
  refreshBusy.value = true
  refreshTip.value = ''
  try {
    const response = await fetch(`/api/companion/status?t=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    emit('refresh-status', data)
    refreshTip.value = '✓ 已刷新'
  } catch (error) {
    refreshTip.value = `✗ 刷新失败：${error?.message || error}`
  } finally {
    refreshBusy.value = false
    setTimeout(() => { refreshTip.value = '' }, 2500)
  }
}

function isSelected(item) {
  return settings.value.pet_renderer === 'live2d' && settings.value.live2d_model_id === item.id
}

function selectAppearance(item) {
  settings.value.pet_renderer = 'live2d'
  settings.value.live2d_model_id = item.id
  emit('select-live2d', item.id)
}

function rangeInputStyle(value, minimum, maximum) {
  const min = Number(minimum)
  const max = Number(maximum)
  const current = Number(value)
  const percent = max > min ? Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100)) : 0
  return { '--range-progress': `${percent}%` }
}

// ★ B3 任务状态联动试演（2026-10-19）：合成一条 agent_phase 走既有 WS 广播，
// 桌宠端 applyAgentPhase 原样消费——动作/表情/徽标音效全链路真实联动，零额外链路。
const phasePreviewBusy = ref(false)
const phasePreviewTip = ref('')
async function previewPhase(phase) {
  if (phasePreviewBusy.value) return
  phasePreviewBusy.value = true
  try {
    // ★ 2026-10-24：把**当前页面上的选择**一起送过去。
    //   原来只传 { phase }：桌宠端只能拿"已经保存过"的 settings 去播，
    //   于是用户刚在下拉里换了个表情、还没来得及保存（或保存了但桌宠 5s 轮询还没刷到），
    //   点「试演」播出来的还是上一张脸 —— 用户报的就是这个「切换表情后试演不对应」。
    //   动作列是槽位语义，表情列是表达式真名，两列各送各的，后端按 model_id 解析。
    const binding = currentPhaseSlots.value?.[phase] || {}
    const response = await fetch('/api/companion/live2d/phase/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phase,
        model_id: String(settings.value?.live2d_model_id || ''),
        motion: String(binding.motion || ''),
        expression: String(binding.expression || ''),
      }),
    })
    const detail = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(detail.detail || `HTTP ${response.status}`))
    // 后端如实回报"送没送出去"，别再一律显示 ✓ 让用户以为播了
    if (detail.ok === false) {
      phasePreviewTip.value = `✗ ${detail.detail || '试演没有送达'}`
      return
    }
    const resolved = detail.expression || {}
    if (resolved.kind === 'missing') {
      phasePreviewTip.value = `✗ 表情「${resolved.expression}」不在当前模型里`
      return
    }
    phasePreviewTip.value = `✓ 已试演「${resolved.expression || '自动'}」`
  } catch (error) {
    phasePreviewTip.value = `✗ ${error?.message || error}`
  } finally {
    phasePreviewBusy.value = false
    setTimeout(() => { phasePreviewTip.value = '' }, 2500)
  }
}

// ★ 2026-10-24 任务状态「表情」列改为**真实表情文件**（用户裁决）：
//   原来这一列只有 7 个抽象情绪槽（自然/温柔/开心/担心/认真/害羞/警觉），用户选不到
//   模型里实际存在的「05 O O」「07 流口水」这类 exp3 表情文件，只能碰运气靠语义正则匹配。
//   现在直接列模型 capabilities.expressions 里的每一条，选项 value 就是表达式真名
//   （大小写敏感，后端只做 trim/slice(120)，不再小写化）。
//   动作列保持槽位语义不变（一条状态只能播一个表情，两列都填文件名会互相覆盖）。
const phaseExpressionChoices = computed(() => {
  const seen = new Set()
  return selectedExpressions.value
    .map((expression) => String(expression?.Name || expression?.name || ''))
    .filter(Boolean)
    .filter((name) => (seen.has(name) ? false : seen.add(name)))
})
const PHASE_EXPRESSION_SLOT_LABELS = expressionLabels
// 老配置里存的是情绪槽名（neutral/gentle/...）。下拉里也要能看见它，否则
// v-model 找不到匹配选项 ⇒ 显示空白，用户会以为"绑错了"。
function phaseExpressionOptionsFor(value) {
  const name = String(value || '')
  if (!name || phaseExpressionChoices.value.includes(name)) return ''
  return PHASE_EXPRESSION_SLOT_LABELS[name] || ''
}
// 换了模型 / 模型重新导入后，老绑定可能指向不存在的表情。静默失效是最坑的体验
// （"明明选了「07 流口水」，桌宠却毫无反应"），所以这里把每一行标出来。
function phaseExpressionMissing(phase) {
  const name = String(currentPhaseSlots.value[phase]?.expression || '')
  if (!name) return false
  if (name in PHASE_EXPRESSION_SLOT_LABELS) return false
  return !phaseExpressionChoices.value.includes(name)
}
// ★ 2026-10-24：选「自动表情」时也把**实际会播的那张脸**写在选项里。
//   原来是光秃秃一个「自动表情」，用户点试演看到表情变了，却不知道那张脸是哪来的、
//   更不知道"我明明没选"——这正是「切换表情后试演不对应」的一半困惑来源。
//   与渲染端 PHASE_EMOTION / 后端 PHASE_DEFAULT_EMOTION 同一张表（2026-10-24 已补齐 11 态）。
const PHASE_DEFAULT_EMOTION_SLOT = {
  idle: 'gentle',
  thinking: 'serious',
  replying: 'gentle',
  voice: 'gentle',
  error: 'concerned',
  awaiting: 'gentle',
  planning: 'gentle',
  executing: 'serious',
  listening: 'gentle',
  done: 'cheerful',
  paused: 'gentle',
}
function phaseDefaultExpressionLabel(phase) {
  const slot = PHASE_DEFAULT_EMOTION_SLOT[phase] || ''
  if (!selectedMotions.value.length && !selectedExpressions.value.length) return '内置默认'
  return PHASE_EXPRESSION_SLOT_LABELS[slot] || slot || '内置默认'
}
</script>

<template>
  <section class="pet-appearance-panel simplified-pet-panel">
    <header class="pet-appearance-heading"><div><Gamepad2 :size="18" /><strong>桌宠</strong></div><span :class="['connection-label', { online: pet.running }]">{{ pet.running ? '运行中' : '未启动' }}</span></header>
    <div class="appearance-unified-list">
      <h4 class="appearance-section-title">内置模型（随项目分发）</h4>
      <template v-for="group in builtInGroups" :key="group.item.id">
        <h5 v-if="group.title" :class="['appearance-group-title', { gold: group.item.featured }]">{{ group.title }}</h5>
        <div class="appearance-item-wrap" :class="{ gold: group.item.featured }">
          <button type="button" :class="{ active: isSelected(group.item) }" @click="selectAppearance(group.item)"><img :src="group.item.preview" :alt="group.item.name" /><span><strong>{{ group.item.name }}</strong><small>{{ group.item.type }}</small></span><Check v-if="isSelected(group.item)" class="appearance-selected-mark" :size="15" /></button>
        </div>
      </template>
      <h4 class="appearance-section-title">外部导入（仅本机）</h4>
      <div v-for="item in importedItems" :key="item.id" class="appearance-item-wrap">
        <button type="button" :class="{ active: isSelected(item) }" @click="selectAppearance(item)"><img :src="item.preview" :alt="item.name" /><span><strong>{{ item.name }}</strong><small>{{ item.type }}</small></span><Check v-if="isSelected(item)" class="appearance-selected-mark" :size="15" /></button>
        <span v-if="managementMode && item.imported" class="appearance-card-actions"><label :title="`更换 ${item.name} 的封面`"><input type="file" accept="image/*" @change="emit('replace-live2d-preview', item, $event)" /><ImagePlus :size="14" /></label><button class="appearance-delete" type="button" :title="`删除 ${item.name}`" :disabled="busy" @click.stop="emit('delete-live2d', item)"><Trash2 :size="14" /></button></span>
      </div>
      <template v-if="managementMode">
        <button class="appearance-add" type="button" :disabled="busy" @click="emit('import-live2d')"><Plus :size="19" /><span><strong>导入 Live2D</strong><small>选择包含 model3.json 的目录</small></span></button>
      </template>
      <button v-else class="appearance-add" type="button" @click="emit('manage')"><Plus :size="19" /><span><strong>添加形象</strong><small>前往形象管理</small></span></button>
    </div>
    <div v-if="managementMode && selectedLive2D" class="live2d-resource-manager">
      <header><strong>{{ selectedLive2D.name }} 的动作与表情</strong><small>说话时会按语义和情绪自动使用；也可以手动指定</small></header>
      <div v-if="selectedMotions.length" class="live2d-resource-section"><h3>动作</h3><div class="live2d-resource-grid"><label v-for="(label, slot) in motionLabels" :key="slot"><span>{{ label }}</span><select v-model="currentMotionSlots[slot]"><option value="">自动判断</option><option v-for="motion in selectedMotions" :key="motion.name" :value="motion.name">{{ motion.name }}（{{ motion.count || 0 }}）</option></select><button type="button" title="预览动作" :disabled="!currentMotionSlots[slot] || busy" @click="emit('preview-motion', currentMotionSlots[slot])"><Play :size="13" /></button></label></div></div>
      <div v-if="selectedExpressions.length" class="live2d-resource-section">
        <div class="live2d-expression-head">
          <h3>表情</h3>
          <button type="button" class="live2d-panel-refresh" title="实时刷新该桌宠管理界面" aria-label="刷新" :disabled="refreshBusy" @click="refreshPanel"><RefreshCw :size="13" :class="{ spin: refreshBusy }" /></button>
          <small v-if="refreshTip" class="live2d-panel-refresh-tip">{{ refreshTip }}</small>
        </div>
        <div class="live2d-resource-grid"><label v-for="(label, slot) in expressionLabels" :key="slot"><span>{{ label }}</span><select v-model="currentExpressionSlots[slot]"><option value="">自动判断</option><option v-for="expression in selectedExpressions" :key="expression.Name || expression.name" :value="expression.Name || expression.name">{{ expression.Name || expression.name }}</option></select><button type="button" title="预览表情" :disabled="!currentExpressionSlots[slot] || busy" @click="emit('preview-expression', currentExpressionSlots[slot])"><Volume2 :size="13" /></button></label></div>
      </div>
      <div v-if="selectedMotions.length || selectedExpressions.length" class="live2d-resource-section">
        <h3>任务状态</h3>
        <small class="live2d-resource-tip">动作列选「自动」= 用内置默认动作槽；表情列直接列这个模型里真实的 exp3 表情文件，选哪个状态就亮哪张脸。点「试演」桌宠会立刻按该状态真实联动一次（动作+表情+音效），不落库不影响配置</small>
        <div class="live2d-phase-grid">
          <label v-for="(label, phase) in phaseLabels" :key="phase" :class="{ 'phase-row-missing': phaseExpressionMissing(phase) }">
            <span>{{ label }}</span>
            <select v-model="currentPhaseSlots[phase].motion" title="动作槽"><option value="">自动动作</option><option v-for="(slotLabel, slot) in motionLabels" :key="'pm-' + slot" :value="slot">{{ slotLabel }}</option></select>
            <select v-model="currentPhaseSlots[phase].expression" :title="phaseExpressionMissing(phase) ? `绑定的表情不在当前模型中：${currentPhaseSlots[phase].expression}` : '表情文件'">
              <option value="">自动表情（{{ phaseDefaultExpressionLabel(phase) }}）</option>
              <option v-if="phaseExpressionOptionsFor(currentPhaseSlots[phase].expression)" :value="currentPhaseSlots[phase].expression">{{ phaseExpressionOptionsFor(currentPhaseSlots[phase].expression) }}（旧情绪槽）</option>
              <option v-if="phaseExpressionMissing(phase)" :value="currentPhaseSlots[phase].expression">⚠ {{ currentPhaseSlots[phase].expression }}（当前模型没有）</option>
              <option v-for="expressionName in phaseExpressionChoices" :key="'pe-' + expressionName" :value="expressionName">{{ expressionName }}</option>
            </select>
            <button type="button" class="phase-preview-btn" :title="`按当前绑定试演「${label}」`" :disabled="phasePreviewBusy" @click.prevent="previewPhase(phase)">试演</button>
          </label>
        </div>
        <small v-if="phasePreviewTip" class="live2d-resource-tip">{{ phasePreviewTip }}</small>
      </div>
      <p v-if="!selectedMotions.length && !selectedExpressions.length">模型配置中没有登记动作或表情</p>
    </div>
    <div class="pet-quick-controls">
      <div class="settings-row settings-range-row"><div><strong>桌宠大小</strong><small>保存后同步到桌面</small></div><input v-model.number="settings.pet_size_percent" type="range" min="80" max="240" step="1" :style="rangeInputStyle(settings.pet_size_percent, 80, 240)" @change="emit('save-size')" /><b>{{ settings.pet_size_percent }}%</b></div>
      <div class="pet-toggle-grid"><label><span>固定并穿透</span><span class="switch-control"><input v-model="settings.live2d_click_through_locked" type="checkbox" /><i /></span></label><label><span>始终置顶</span><span class="switch-control"><input v-model="settings.live2d_always_on_top" type="checkbox" /><i /></span></label><label><span>说话气泡</span><span class="switch-control"><input v-model="settings.live2d_speech_bubble_enabled" type="checkbox" /><i /></span></label><label><span>拖拽限位</span><span class="switch-control"><input v-model="settings.live2d_clamp_to_workarea" type="checkbox" /><i /></span></label></div>
    </div>
    <div class="pet-runtime-actions">
      <button class="primary-button" type="button" :disabled="busy" @click="emit('save')"><Check :size="15" />保存</button>
    </div>
    <!-- 保存反馈：常驻节点 + display 切换（不做 v-if 分支翻转，避免动态节点位置漂移） -->
    <div
      class="pet-save-feedback"
      :style="{
        display: (busy || (feedback && feedback.section === 'pet')) ? '' : 'none',
        color: (busy || !(feedback && feedback.type)) ? '#8a8f98' : (feedback.type === 'success' ? '#2e7d32' : '#c62828'),
      }"
    ><span>{{ busy ? '保存中…' : ((feedback && feedback.message) || '') }}</span></div>
  </section>
</template>
