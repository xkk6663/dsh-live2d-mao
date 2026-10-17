// UI 契约测试（原 chatPage.test.js 的精简版）
//
// 背景：原 chatPage.test.js 大半在断言 ChatPage.vue（小智对话页）。
// DSH 专用化阉割小智后 ChatPage 已删除，故：
//   - 依赖 ChatPage.vue 的断言（会话抽屉 / QQ 清理 / xiaozhi 历史轮询与 WS /
//     小智消息列表与输入区 / chat.css 里小智专属样式）**整体移除** —— 页面没了，
//     再断言它只会永远失败；
//   - 与 ChatPage 无关的 UI 契约断言**保留**（Live2D 面板接线、桌宠 busy 自愈），
//     它们是仍在使用的能力，值得继续守住。
// 文件名一并改为 uiContract.test.js，避免"名为 chatPage 实则与它无关"的误导。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

const appSource = read('App.vue')
const conversationSource = read('composables', 'useConversations.js')
const companionPageSource = read('components', 'CompanionPage.vue')
const petAppearanceSource = read('components', 'PetAppearancePanel.vue')
const settingsPageSource = read('components', 'SettingsPage.vue')

// ── 保留：普通对话不暴露 Agent 执行回执、也不能开创作工具 ────────────────
// 这两条约束与"哪个页面渲染"无关，属协议/开关层契约，继续守。
test('ordinary chat hides Agent execution receipts and cannot enable creation tools', () => {
  assert.match(conversationSource, /creation_tools_enabled:\s*deps\.isAgentWorkspace/)
  assert.match(conversationSource, /mode:\s*deps\.isAgentWorkspace \? 'agent' : 'companion'/)
  assert.doesNotMatch(appSource, /isAgentWorkspace \|\| creationToolsEnabled/)
})

test('Live2D management panel wires refresh and model actions through its page context', () => {
  for (const event of ['select-live2d', 'refresh-status', 'import-live2d', 'delete-live2d', 'replace-live2d-preview', 'preview-motion', 'preview-expression']) {
    assert.match(petAppearanceSource, new RegExp(`['\"]${event}['\"]`))
  }
  assert.match(companionPageSource, /management-mode/)
  assert.match(companionPageSource, /@refresh-status="applyRefreshedStatus"/)
  assert.match(companionPageSource, /@select-live2d="switchModel"/)
  assert.match(settingsPageSource, /@refresh-status="applyRefreshedStatus"/)
  assert.match(settingsPageSource, /applyRefreshedStatus\(data\)/)
  assert.match(appSource, /provide\('mio-companion-page',[\s\S]*?importLive2DModel,[\s\S]*?deleteLive2DModel,[\s\S]*?replaceLive2DPreview,/)
})

test('companion busy and status-loading flags recover from stale requests', () => {
  assert.match(appSource, /Date\.now\(\) - companionBusySince > 10_000/)
  assert.match(appSource, /window\.setTimeout\([\s\S]*?10_050\)/)
  assert.match(appSource, /Date\.now\(\) - companionStatusLoadingSince > 8_000/)
})

// ── 新增：DSH 专用化的阉割不可被改回（回归守卫）────────────────────────
test('★ 小智对话页已彻底移除（ChatPage.vue 不存在，且无任何引用）', () => {
  assert.equal(
    fs.existsSync(path.join(root, 'components', 'ChatPage.vue')),
    false,
    'ChatPage.vue 应已删除（它是小智对话页）',
  )
  // App.vue 不能再 import / 渲染它
  assert.doesNotMatch(appSource, /import\(['"]\.\/components\/ChatPage\.vue['"]\)/)
  assert.doesNotMatch(appSource, /<ChatPage\b/)
})

test('★ 主导航不含「对话」（小智入口），默认落在桌宠管理页', () => {
  // 导航项里不能再有 id: 'chat'
  assert.doesNotMatch(appSource, /\{\s*id:\s*'chat'/)
  // 默认打开页是 companion（桌宠管理页）
  assert.match(appSource, /default_open_page:\s*'companion'/)
  // 'chat' 不再是合法视图（否则 activeViewState 会抛错）
  const viewState = read('activeViewState.js')
  assert.doesNotMatch(viewState, /^\s*'chat',/m)
})

test('★ 前端不再请求小智后端接口（/api/xiaozhi/*）', () => {
  const vueFiles = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(vue|js)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) vueFiles.push(full)
    }
  }
  walk(root)
  const offenders = vueFiles.filter((file) => fs.readFileSync(file, 'utf8').includes('/api/xiaozhi/'))
  assert.deepEqual(
    offenders.map((f) => path.relative(root, f)),
    [],
    '以下文件仍在请求小智接口，应随小智插件一并清除',
  )
})
