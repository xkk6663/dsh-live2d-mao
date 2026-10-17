<script setup>
import { computed, inject, onMounted, ref } from 'vue'
import {
  Boxes, Gamepad2, ImagePlus, RefreshCw, Stethoscope,
} from '@lucide/vue'
import PetAppearancePanel from './PetAppearancePanel.vue'

const context = inject('mio-companion-page')
if (!context) throw new Error('桌宠页上下文未初始化')

// ---------------------------------------------------------------- 通用请求
async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url} -> ${response.status}`)
  return response.json()
}
async function request(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try { message = (await response.json()).detail || message } catch { /* 忽略解析失败 */ }
    throw new Error(message)
  }
  return response.json()
}

// ---------------------------------------------------------------- 模型管理
const models = ref([])
const currentModelId = ref('')
const schedule = ref({ enabled: false, time: '09:00', mode: 'random', last_switched: '' })
const modelMessage = ref('')
// 内置模型按 featured 降序（项目内置的 whale-deepseek / da-feiyu 排前面）
const sortedBuiltInModels = computed(() => [...models.value.filter((item) => !item.imported)]
  .sort((a, b) => Number(b.featured) - Number(a.featured)))
const importedModels = computed(() => models.value.filter((item) => item.imported))

// 面板「实时刷新」上抛的状态：合并进 provide 的 companionStatus（浅合并 + pet 深一层），
// 让桌宠管理页在面板自己拉完 /api/companion/status 后立刻拿到新数据。
function applyRefreshedStatus(data) {
  if (!data) return
  const current = context.companionStatus || {}
  context.companionStatus = {
    ...current,
    ...data,
    pet: { ...(current.pet || {}), ...(data.pet || {}) },
  }
}

async function refreshModels() {
  try {
    const [modelData, scheduleData] = await Promise.all([
      getJson('/api/companion/live2d/models'),
      getJson('/api/companion/live2d/schedule'),
    ])
    models.value = (modelData.models || []).map((model) => ({
      id: model.id,
      name: model.display_name || model.name || model.id,
      imported: Boolean(model.imported),
      featured: model.id === 'whale-deepseek' || model.id === 'da-feiyu',
    }))
    schedule.value = scheduleData || schedule.value
    try {
      const status = await getJson('/api/companion/status')
      currentModelId.value = ((status.live2d && status.live2d.runtime) || {}).model_id || ''
    } catch { /* 状态读取失败不影响模型列表 */ }
  } catch (error) {
    modelMessage.value = `读取模型失败：${error.message}`
  }
}

// 切换模型：PATCH 之后同步写回 provide 的 companionStatus，
// 否则桌宠管理页的「当前」标记会停在旧模型上（此前是手工注入 dist 的补丁）。
async function switchModel(id) {
  modelMessage.value = '正在切换…'
  try {
    await request('/api/companion/settings', 'PATCH', { live2d_model_id: id })
    try {
      const settings = context.companionStatus && context.companionStatus.pet && context.companionStatus.pet.settings
      if (settings) settings.live2d_model_id = id
    } catch { /* provide 不可写时忽略 */ }
    modelMessage.value = '✓ 已切换，桌宠正在换装'
    setTimeout(refreshModels, 2500)
  } catch (error) {
    modelMessage.value = `✗ 切换失败：${error.message}`
  }
}

async function saveSchedule() {
  try {
    await request('/api/companion/live2d/schedule', 'PATCH', {
      enabled: schedule.value.enabled,
      time: schedule.value.time || '09:00',
      mode: schedule.value.mode,
    })
    modelMessage.value = schedule.value.enabled
      ? `✓ 已保存（每天 ${schedule.value.time} 自动换）`
      : '✓ 已关闭自动更换'
    setTimeout(refreshModels, 1200)
  } catch (error) {
    modelMessage.value = `✗ 保存失败：${error.message}`
  }
}

function importModel() {
  if (!context.importLive2DModel) return
  context.importLive2DModel().then(refreshModels).catch((error) => {
    modelMessage.value = `导入失败：${error.message}`
  })
}
function replaceModelCover(id, event) {
  if (!context.replaceLive2DPreview) return
  context.replaceLive2DPreview(id, event).then(refreshModels).catch((error) => {
    modelMessage.value = `封面更换失败：${error.message}`
  })
}
function deleteModel(id) {
  if (!context.deleteLive2DModel) return
  context.deleteLive2DModel(id).then(refreshModels).catch((error) => {
    modelMessage.value = `删除失败：${error.message}`
  })
}

// ---------------------------------------------------------------- 屏幕观察：已移除
// DSH 专用化（2026-10-17 用户裁决）：整块「屏幕自动观察（冷不丁评价）」已删除。
// 它 100% 依赖小智：随机截屏 → 调小智视觉接口让小智评价屏幕，
// 并读写小智的 observe 开关（后端 xiaozhi 插件已整体阉割，这些接口不复存在）。
// 连带移除：OBSERVE_RANGES / matchObserveRange / observe / observeMessage /
// xiaozhiStatus / loadXiaozhiStatus / saveObserve / observeOnce / openScreenCrop，
// 以及左栏的「观察」tab 与 screen-panel 模板段。
//
// ⚠ 若将来要做"基于 DSH 的屏幕观察"，那是**新功能**（应走 DSH 自己的视觉能力），
//   不要把这套小智专用实现直接搬回来。

// ---------------------------------------------------------------- 体检
// 体检面板的正式 UI 由 core-inject/health-panel-inject.js 接管渲染（Agents/本体自检增强版），
// 它会整体替换 .health-simple-panel 的 innerHTML。这里**只渲染空壳 + 加载占位**：
// ① 旧版在这里渲染完整体检 UI，注入层接管前会闪现旧界面（"进体检先闪一下旧 UI"）；
// ② 旧模板的动态绑定会让 Vue 在注入层替换 innerHTML 之后仍试图 patch 已不存在的节点。
onMounted(() => {
  refreshModels()
})
</script>

<template>
  <section class="companion-hub">
    <div class="companion-main">
      <nav class="companion-tab-bar compact-companion-tabs" aria-label="桌宠功能">
        <button type="button" :class="{ active: context.activeCompanionSection === 'pet-panel' }" @click="context.activeCompanionSection = 'pet-panel'"><Gamepad2 :size="16" />桌宠</button>
        <!-- DSH 专用化：「观察」tab 已移除（整块依赖小智视觉，随小智插件阉割） -->
        <button type="button" :class="{ active: context.activeCompanionSection === 'model-panel' }" @click="context.activeCompanionSection = 'model-panel'"><Boxes :size="16" />模型</button>
        <button type="button" :class="{ active: context.activeCompanionSection === 'health-panel' }" @click="context.activeCompanionSection = 'health-panel'"><Stethoscope :size="16" />体检</button>
      </nav>

      <PetAppearancePanel
        v-if="context.activeCompanionSection === 'pet-panel'"
        :status="context.companionStatus"
        :avatar-url="context.companionAvatarUrl"
        :display-name="context.mioDisplayName"
        :busy="Boolean(context.companionBusy)"
        management-mode
        :feedback="context.settingsFeedback"
        @control="context.controlCompanion"
        @import-live2d="context.importLive2DModel"
        @delete-live2d="context.deleteLive2DModel"
        @replace-live2d-preview="context.replaceLive2DPreview"
        @preview-motion="context.previewLive2DMotion"
        @preview-expression="context.previewLive2DExpression"
        @select-live2d="switchModel"
        @save="context.saveCompanionSettings('pet')"
        @save-size="context.saveCompanionSize"
        @manage="context.openSettingsSection('pet')"
        @refresh-status="applyRefreshedStatus"
      />

      <!-- DSH 专用化：原 screen-panel（屏幕自动观察 / 立即观察 / 框选屏幕区域）已整段移除。
           该面板全部动作都打到小智接口（观察开关 + 小智视觉评价），随小智插件一并阉割。 -->

      <section v-else-if="context.activeCompanionSection === 'model-panel'" class="companion-simple-panel model-simple-panel">
        <header><div><Boxes :size="19" /><span><h2>Live2D 模型管理</h2><p>切换模型、导入与每天定时自动更换</p></span></div><button type="button" title="刷新" @click="refreshModels"><RefreshCw :size="15" /></button></header>
        <div class="model-actions" style="display:flex;gap:8px;margin-bottom:10px;">
          <button type="button" class="primary-button" style="flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 12px;border:none;border-radius:8px;background:#3370ff;color:#fff;font-size:13px;cursor:pointer;" @click="importModel"><ImagePlus :size="15" /><span>导入 Live2D 模型</span></button>
        </div>
        <div class="model-list">
          <div class="model-section" style="margin-bottom:10px;">
            <h4 style="margin:6px 0 6px;font-size:13px;color:#5f6670;">内置模型（随项目分发）</h4>
            <div v-for="item in sortedBuiltInModels" :key="item.id" class="model-item" :class="{ gold: item.featured }">
              <span class="model-name">{{ item.name }}</span><span class="model-id">{{ item.id }}</span>
              <span v-if="String(item.id) === String(currentModelId)" class="model-cur">当前</span>
              <button v-else type="button" class="model-switch" @click="switchModel(item.id)">切换</button>
            </div>
            <div v-if="!sortedBuiltInModels.length" class="model-empty">暂无内置模型</div>
          </div>
          <div class="model-section">
            <h4 style="margin:6px 0 6px;font-size:13px;color:#5f6670;">外部导入（仅本机）</h4>
            <div v-for="item in importedModels" :key="item.id" class="model-item">
              <span class="model-name">{{ item.name }}</span><span class="model-id">{{ item.id }}</span>
              <span v-if="String(item.id) === String(currentModelId)" class="model-cur">当前</span>
              <button v-else type="button" class="model-switch" @click="switchModel(item.id)">切换</button>
              <label class="model-cover" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#3370ff;cursor:pointer;margin-left:8px;"><input type="file" accept="image/*" style="display:none;" @change="replaceModelCover(item.id, $event)" /><span>封面</span></label>
              <button type="button" class="model-del" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#c0392b;cursor:pointer;margin-left:8px;border:none;background:transparent;" @click="deleteModel(item.id)">删除</button>
            </div>
            <div v-if="!importedModels.length" class="model-empty">暂无导入模型</div>
          </div>
        </div>
        <div class="voice-quick-settings">
          <label><span>自动更换</span><span class="switch-control"><input v-model="schedule.enabled" type="checkbox" @change="saveSchedule" /><i /></span></label>
          <label><span>时间</span><input v-model="schedule.time" type="time" @change="saveSchedule" /></label>
          <label><span>模式</span><select v-model="schedule.mode" @change="saveSchedule"><option value="random">随机</option><option value="sequential">顺序</option></select></label>
        </div>
        <div class="voice-runtime-summary"><strong>上次更换：{{ schedule.last_switched || '尚未更换' }}</strong></div>
        <p class="companion-panel-msg">{{ modelMessage }}</p>
      </section>

      <!-- 体检：只渲染空壳占位，正式 UI 由 core-inject/health-panel-inject.js 接管填充
           （避免旧版体检 UI 在接管前闪现；见 script 内注释） -->
      <section v-else class="companion-simple-panel health-simple-panel" aria-busy="true">
        <p class="companion-panel-msg">体检加载中…</p>
      </section>
    </div>
  </section>
</template>
