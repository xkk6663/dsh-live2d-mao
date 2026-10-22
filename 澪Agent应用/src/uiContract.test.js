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

// ── 大肥鱼对话页（视觉移植自 xiaozhi-chat-ui 提取包）─────────────────────
// 这一页的坑都很隐蔽（视图白名单漏登记 / 切会话把用户弹回桌宠页 / 只换视觉不接历史），
// 所以逐条钉住，防止下一次重构时又悄悄退化。
const feiyuChatSource = read('components', 'FeiyuChatPage.vue')
const feiyuCssSource = read('styles', 'feiyu-chat.css')
const feiyuApiSource = read('services', 'companionChatApi.js')
const feiyuChatStoreSource = read('composables', 'useCompanionChat.js')
const desktopNavSource = read('composables', 'useDesktopNavigation.js')
const viewStateSource = read('activeViewState.js')
const mainSource = read('main.js')

test('★ 大肥鱼视图在「前端白名单 + 后端自报白名单」里都登记了', () => {
  // 只登记一边 = 能用一半：前端能渲染，但心跳上报会 throw / 设置页返回被弹回 home
  assert.match(appSource, /validInitialViews = new Set\(\[[^\]]*FEIYU_CHAT_VIEW_ID/)
  assert.match(viewStateSource, /'feiyu-chat'/)
  // 导航里有入口，且模板渲染的是移植版组件
  assert.match(appSource, /\{ id: FEIYU_CHAT_VIEW_ID, label: '大肥鱼'/)
  assert.match(appSource, /<FeiyuChatPage[\s\S]*?activeView === FEIYU_CHAT_VIEW_ID/)
  // Vue 3 SFC 里 v-model:draft 必须写成 kebab-case（写成 v-model:draft 对应 prop `draft` 才成立）
  assert.match(appSource, /v-model:draft="feiyuDraft"/)
})

test('★ 切会话不得改 activeView（否则从对话页点会话会被弹回桌宠页）', () => {
  const selectFn = conversationSource.match(/async function selectConversation\([\s\S]*?\n  \}/)?.[0] || ''
  const createFn = conversationSource.match(/async function createNewConversation\([\s\S]*?\n  \}/)?.[0] || ''
  assert.ok(selectFn, 'selectConversation 应存在')
  assert.ok(createFn, 'createNewConversation 应存在')
  assert.doesNotMatch(selectFn, /deps\.activeView\.value\s*=/, 'selectConversation 不能再写 activeView')
  assert.doesNotMatch(createFn, /deps\.activeView\.value\s*=/, 'createNewConversation 不能再写 activeView')
  // 需要"切完跳对话页"的场景由导航层负责
  assert.match(desktopNavSource, /focusDesktopPetChat[\s\S]*?deps\.activeView\.value = 'feiyu-chat'|deps\.activeView\.value = 'feiyu-chat'/)
})

test('★ 大肥鱼页走桌宠接口，不碰已阉割的 /api/agent/*', () => {
  assert.match(feiyuApiSource, /\/api\/companion\/chat'/)
  assert.match(feiyuApiSource, /\/api\/companion\/chat\/history/)
  // 模型必须钉死云端大肥鱼：传 auto 会掉进本地模型路由，人格与记忆直接消失
  assert.match(feiyuApiSource, /FEIYU_CLOUD_MODEL_ID = 'cloud_feiyu'/)
  // 只看**代码**里的字符串字面量调用，不看注释（注释里解释"为什么不走 /api/agent/*"是合法的）
  const codeOnly = feiyuChatStoreSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(codeOnly, /['"`]\/api\/agent\//)
})

test('★ cloud_feiyu 不落库 → 回答必须从 reply 兜底 + 本机缓存续命', () => {
  // 只依赖 history 会"发完看不到回答 / 切页就丢干净"
  assert.match(feiyuChatStoreSource, /upsertReply\(/)
  assert.match(feiyuChatStoreSource, /result\?\.reply/)
  // 本机缓存键（切页/刷新后还能看到刚才的对话）
  assert.match(feiyuChatStoreSource, /mio_feiyu_local_turns/)
})

test('★ 大肥鱼页视觉层：作用域收在 .xz-chat，且保留「」引号体 / 竖线 / 16px 卡片', () => {
  // 样式必须被 main.js 引入，且晚于 integrated.css（靠后置压过宿主的同名规则）
  const styleOrder = mainSource.indexOf("./styles/feiyu-chat.css")
  assert.ok(styleOrder > mainSource.indexOf("./styles/integrated.css"), 'feiyu-chat.css 必须在 integrated.css 之后引入')
  // 「」引号体 + 用户竖线 + 圆角 16px 毛玻璃卡片（提取文档第 3 章的三条"最关键视觉"）
  assert.match(feiyuCssSource, /content: '「'|content: "「"/)
  assert.match(feiyuCssSource, /--mist-blue/)
  assert.match(feiyuCssSource, /border-radius: 16px/)
  // 组件不写 scoped 样式（否则会盖掉那套"最终裁决"）
  // 只认行首的 <style 标签：文件头注释里出现"不含 <style> 块"这句话不算违规
  assert.doesNotMatch(feiyuChatSource, /^\s*<style\b/m)
})

test('★★ 多段正文必须纵向堆叠（不能继承 .message-part 的 flex row 并排成两列）', () => {
  // 真实事故（2026-10-22）：多段回复被渲染成左右两列，一句被劈开。
  // 根因：`.message-part { display:flex }` 默认 row，模板里的 <p class="message-text">
  // 作为 flex 子项就并排了。修复靠给容器显式 display:block，这条钉住它。
  assert.match(
    feiyuCssSource,
    /\.xz-chat \.message-part\.message-text-list\s*\{[^}]*display:\s*block;/,
    '.message-part.message-text-list 必须 display:block，否则多段会并排成两列',
  )
  // 段落自己不能带默认外边距（会把段间距叠成一大块）
  assert.match(
    feiyuCssSource,
    /\.xz-chat \.message-body \.message-text\s*\{[^}]*margin:\s*0;/,
    '.message-text 需要 margin:0，段间距统一由 .message-text + .message-text 控制',
  )
  // 模板确实用了这个容器类，否则 CSS 那条规则是死的
  assert.match(feiyuChatSource, /class="message-part message-text-list"/)
})

test('★★ 不篡改项目配置：代码里出现的 service 必须带契约注释', () => {
  // 本轮真实踩坑：appearance 里误把 `--gap: 1rem` 当成"1rem 的间隙"读，改完找不到效果。
  // 这条只守着「改配置前先读契约」的旁证：companionChatApi 顶部必须写清 model_id 的取值语义。
  const apiSource = feiyuApiSource
  assert.match(apiSource, /cloud_feiyu/)
  assert.match(apiSource, /不落库|chat-settings/)
})

// ── 构建管线：dist/index.html 是唯一入口，任何"未被引用的入口 bundle"都要拦住 ──
// 真实事故（2026-10-22）：改完前端后 `npm run build:dist` 在 clean-dist 一步退出 1，
// 于是 compose-dist 已经写好的新 index.html 留在了 dist 里，而 dist/assets 下
// **同时躺着旧入口 bundle**（index-<旧hash>.js）和它引用的全部旧 chunk。
// 因为 compose-dist 只"清空并拷贝 vitE 产物"，不删 dist/assets 下的历史文件，
// 旧 bundle 就一直躺在 dist/ 里 —— 谁只要手动访问一次 ./assets/index-<旧hash>.js，
// 看到的就是**上一版界面**（本轮就靠这个坑白排查了一轮"新 UI 没生效"）。
test('★ dist 里的入口 bundle 必须与 index.html 唯一对应（不留旧入口）', () => {
  const distDir = path.join(root, '..', 'dist')
  const indexHtml = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexHtml)) return // dist 未构建时跳过（CI 只跑 src 的情况）
  const html = fs.readFileSync(indexHtml, 'utf8')
  const entry = /src="\.\/assets\/(index-[^"?]+\.js)/.exec(html)?.[1]
  assert.ok(entry, 'dist/index.html 应引用一个 assets/index-<hash>.js 入口')
  const entries = fs.readdirSync(path.join(distDir, 'assets')).filter((name) => /^index-.*\.js$/.test(name))
  assert.deepEqual(
    entries.filter((name) => name !== entry),
    [],
    `dist/assets 下存在不被 index.html 引用的旧入口 bundle（${entry} 是当前入口）。`
    + '\n★ 注意：重跑 `npm run build:dist` **修不掉**这个问题 —— compose-dist 只清空并拷贝 vite 产物，'
    + '不删 dist/assets 下的历史文件，旧入口会一直躺着（谁访问到就渲染上一版界面）。'
    + '\n正确做法：手动删掉这些旧 index-*.js，再跑 `npm run clean-dist -- --apply`（可能要跑两遍）'
    + '把随之变成孤儿的旧 chunk 一并回收，最后确认 `npm run guard` exit 0。',
  )
})
