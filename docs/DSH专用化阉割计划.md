# DSH 专用化阉割计划（可执行版）

> 生成日：2026-10-17 ｜ 仓库：`C:\Users\xiao1\Mao-dsh-pet`（DSH 插件线独立仓库）
> 决策来源：用户裁决 —— 「上游项目定位是一切皆插件的跨 Agent 平台，但该项目是 DSH 专用，
> 所以其余插件（小智、Octop 等）都可以阉割掉：从后端源码到前端 UI 都阉割，
> 仅保留 DSH 加强插件的核心能力，突出其 DSH 专用化项目」
> 加上「首次进入的质检 UI 六步全删，进桌宠环境直达主界面」

---

## 0. 目标与验收口径

| # | 目标 | 验收 |
|---|---|---|
| **A** | 首次进入**直达主界面**，不再出现六步质检流程 | 全新数据目录启动 → 直接进桌宠管理页，无 onboarding 拦截 |
| **B** | 非 DSH 插件**后端源码阉割** | `app/agents/{xiaozhi,octop}` 移除；`main.py` 不再 import/挂载它们；DshAdapter 不再引用 |
| **C** | 非 DSH 插件**前端 UI 阉割** | `dist/plugins/{xiaozhi,octop}` 移除；导航/观察 tab/体检条目/气泡音频等入口消失 |
| **D** | **保留并强化 DSH 能力** | 12 态总线、逐 token 流式、横条、审批/提问应答、摄入端点全部照常；门禁全绿 |
| **E** | 不留悬空引用 | `npm run guard` 全 0；后端自检全过；无 import 死链 |

**核心纪律**：每一步都**先删引用、再删实现**，每步跑门禁。不做"一次性大删除"。

---

## 1. 现状测绘（已完成，结论如下）

### 1.1 首次进入质检 UI（目标 A）

| 层 | 文件 | 规模 | 作用 |
|---|---|---|---|
| 前端 | `澪Agent应用/src/components/OnboardingPage.vue` | 18.3 KB | 六步向导 UI |
| 前端 | `澪Agent应用/src/services/onboardingApi.js` | 1.0 KB | `/api/onboarding/*` 调用 |
| 前端 | `澪Agent应用/src/onboardingGates.js` | 0.4 KB | 每步可继续判定 |
| 前端 | `澪Agent应用/src/onboardingGates.test.js` | 0.9 KB | 单测 |
| 前端 | `src/components/DependencyCenter.vue`（被 step0 内嵌） | — | 依赖中心面板 |
| 后端 | `app/routes/onboarding.py` | 0.9 KB | 3 个端点 |
| 后端 | `app/onboarding_service.py` | — | 状态/完成逻辑 |
| 后端 | `app/environment_check_service.py` | — | 环境检查 |

**拦截点（关键，只此一处）**：`src/App.vue:2502-2510`
```js
const onboarding = await loadOnboardingStatus()
if (onboarding?.completed === false) {
  bootstrap.value = { onboarding, models: [] }
  ...
  await syncActiveViewState('onboarding')   // ← 切到 onboarding 视图
  markAppReady()
  return                                    // ← 不再 loadBootstrap()
}
```
模板侧：`App.vue:2646` `<OnboardingPage v-else-if="bootstrap && bootstrap.onboarding?.completed === false" />`

**六步实际内容**（用户说"空 UI"，实测**不是全空**，需纠正认知）：
| step | 标题 | 实际内容 | DSH 专用化后是否需要 |
|---|---|---|---|
| 0 | 检查这台电脑 | 内存/磁盘/显卡 + 必需环境 + 依赖中心 | ❌ 不需要 |
| 1 | 欢迎使用 Mio | 三条隐私说明卡（纯文案） | ❌ 不需要 |
| 2 | 彼此怎么称呼 | 角色名 + 称呼输入 | ❌ 不需要（设置页可改） |
| 3 | 模型服务 | **供应商/API Key/发现模型/真实测试** | ❌ 不需要（DSH 自带模型配置） |
| 4 | 敏感能力 | 4 个开关（联网/主动联系/自动日记/QQ） | ❌ 不需要 |
| 5 | 准备完成 | 完成文案 | ❌ 不需要 |

⇒ 六步对 **DSH 专用**形态**全部无意义**，整条链路（前端 + 后端 + 服务）都可移除。

### 1.2 非 DSH 插件（目标 B/C）

| 插件 | 后端 | 前端 | DSH 线是否需要 |
|---|---|---|---|
| **xiaozhi**（小智） | `app/agents/xiaozhi/routes.py` **124.7 KB**（含 TTS/语音/MCP/对话） | `dist/plugins/xiaozhi/{chat-inject,mcp-panel,manifest}.js` 12.3+13.6+1.0 KB | ❌ 砍（D1 已裁决砍小智 TTS） |
| **octop** | `app/agents/octop/*` 4.8 KB | `dist/plugins/octop/manifest.js` 0.5 KB | ❌ 砍（默认停用、无导航） |
| **dsh**（保留） | `app/agents/dsh/*` 22 文件 | `dist/plugins/dsh/{dsh-panel,manifest}.js` | ✅ **保留并强化** |

**耦合面（已实测，非常小 —— 这是可行的关键）**：
- `xiaozhi` 被引用于：`app/main.py`（import + include_router + prewarm_tts_cache）、`app/agents/dsh/dsh_adapter.py`（仅注释提及）
- `octop` 被引用于：`app/main.py`、`app/kernel/agent_bus_service.py`、`app/agents/dsh/{dsh_signals,routes}.py`
- 前端：`src/components/{ChatPage,CompanionPage}.vue`、`src/styles/chat.css`、`src/chatPage.test.js`

**共享但需保留的**（不要误删）：
- `app/companion/speech_text.py`、`app/screen/system_audio_service.py` —— 属桌宠主体能力，非小智私有
- `app/kernel/agent_bus_service.py` 的 **12 态总线** —— DSH 核心依赖，只摘掉 octop 的引用
- `app/agents/dsh/*` —— **全部保留**（这是本项目存在的意义）

### 1.3 规模合计

| 项 | 规模 |
|---|---|
| 后端 xiaozhi | 121.8 KB / 2 文件 |
| 后端 octop | 4.8 KB / 2 文件 |
| 前端插件 | 26.8 KB / 4 文件 |
| 前端 onboarding | 20 KB / 4 文件 |
| 后端 onboarding | 33.5 KB / 3 文件 |

---

## 2. 分步执行计划

> 每步结束都跑门禁；**任一门禁红就停下修好再进下一步**。
> 备份策略：动手前给整个仓库打一次 `git stash` 之外的**独立快照**（或确认工作区干净可回滚）。

### 阶段 0：准备（5 分钟）
- [ ] 0.1 确认工作区干净：`git status` 空
- [ ] 0.2 建分支：`git checkout -b dsh-only-slim`
- [ ] 0.3 记录基线门禁（跑一遍全部，存档输出）

### 阶段 1：删「首次进入质检」（目标 A）
> 顺序：**先前端拦截 → 再前端组件 → 再后端**（先断入口，避免"组件还在但没人调"的中间态报错）

- [ ] 1.1 `App.vue`：移除 `loadOnboardingStatus()` 拦截分支（2502-2510），改成直接 `loadBootstrap()`
- [ ] 1.2 `App.vue`：移除 `<OnboardingPage>` 模板分支（2646 附近）与 `import OnboardingPage`
- [ ] 1.3 `App.vue`：清理 onboarding 相关 ref/函数/emit（`onboardingBusy/Error/Environment*`、`completeOnboarding`、`refreshOnboardingEnvironment`）
- [ ] 1.4 删除组件：`src/components/OnboardingPage.vue`
- [ ] 1.5 删除服务：`src/services/onboardingApi.js`
- [ ] 1.6 删除 gates：`src/onboardingGates.js` + `src/onboardingGates.test.js`
- [ ] 1.7 `activeViewState.js`：移除 `'onboarding'` 视图态（及其测试引用）
- [ ] 1.8 后端：删 `app/routes/onboarding.py`，`main.py` 去掉 include
- [ ] 1.9 后端：删 `app/onboarding_service.py`；评估 `environment_check_service.py` 是否还有别处用（**有则保留**）
- [ ] 1.10 **`DependencyCenter` 归属判定**：它原本内嵌在 step0；若只被 onboarding 用则一并删，否则保留
- [ ] 1.11 门禁：`npm run test`（Vue 单测）+ `npm run guard` + 后端自检
- [ ] 1.12 起一个**全新数据目录**验证：直接进主界面（关键验收）

### 阶段 2：后端阉割非 DSH 插件（目标 B）
> 顺序：**先摘引用（保证可跑）→ 再删目录**（避免 import 崩）

- [ ] 2.1 `app/main.py`：移除 `from .agents.octop import octop_adapter`、`from .agents.xiaozhi import routes as xiaozhi`
- [ ] 2.2 `app/main.py`：移除 `octop_adapter_task` 注册、`asyncio.create_task(xiaozhi.prewarm_tts_cache())`、`app.include_router(xiaozhi.router)`
- [ ] 2.3 `app/kernel/agent_bus_service.py`：移除 octop 引用（保留 12 态总线不动）
- [ ] 2.4 `app/agents/dsh/dsh_signals.py`、`dsh/routes.py`：移除 octop 提及（多为注释/枚举，逐个确认）
- [ ] 2.5 `app/agents/dsh/dsh_adapter.py`：移除/改写 xiaozhi 注释
- [ ] 2.6 删除 `app/agents/xiaozhi/`、`app/agents/octop/`
- [ ] 2.7 全局搜残留：`xiaozhi|octop|小智|Octop`（py 文件），逐个判定
- [ ] 2.8 门禁：`dsh_adapter_selftest` + `ingest_selftest` + 起后端确认无 import 错
- [ ] 2.9 **DSH 能力回归**：`POST /api/plugin/dsh/{ingest,strip}` 仍 200/422；12 态仍可达

### 阶段 3：前端 UI 阉割（目标 C）
- [ ] 3.1 删 `dist/plugins/xiaozhi/`、`dist/plugins/octop/`
- [ ] 3.2 `index.html`：移除两个 manifest 的 `<script>` 引用
- [ ] 3.3 `kernel/plugin-registry.js` / `plugin-nav.js`：确认无硬编码小智/octop 关键词
- [ ] 3.4 `src/components/ChatPage.vue`、`CompanionPage.vue`：移除小智专属分支（`observeTab` 等）
- [ ] 3.5 `src/styles/chat.css`：移除小智专属样式（如有）
- [ ] 3.6 `src/chatPage.test.js`：移除/改写小智相关断言
- [ ] 3.7 桌宠渲染端：`xiaozhi-plugin.js`、`pet-xz-audio.js` 的**取舍裁决**
      - ⚠ 这是**桌宠主体**能力（宿主侧气泡/音频），不是"小智插件"本身
      - 建议：**保留音频能力、摘掉小智专有入口**，或按用户后续裁决整删
- [ ] 3.8 门禁：`guard` + `e2e_stream_pet` + 起桌宠确认无 404/js 报错

### 阶段 4：收口与文档
- [ ] 4.1 全局残留扫描（py/js/vue/html/css/json）：`xiaozhi|xz_|octop|onboarding|小智|Octop|质检`
- [ ] 4.2 更新 `README.md` / `SRC-MAP-源码地图.md` 的插件清单（去掉已删项）
- [ ] 4.3 写一份《DSH 专用化阉割记录》进 `docs/`
- [ ] 4.4 全门禁最终回归（6 项）
- [ ] 4.5 更新桌面启动脚本注释（如涉及）
- [ ] 4.6 提交（显式文件清单，不用 `git add -A`）

---

## 3. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | **删出 import 死链**：某模块被动引用 xiaozhi/octop 的函数 | 后端起不来 | 阶段 2 严格"先摘引用再删目录"；每步起一次后端 |
| R2 | **误删共享能力**：`speech_text`/`system_audio` 看着像小智的其实是桌宠主体的 | 语音/音频能力丢失 | 先查引用方；本计划 §1.2 已标注"保留"清单 |
| R3 | **`voice` phase 失去唯一来源** | D1 已裁决 voice 为"预留态" | 12 态词汇**不删**；`voice` 保留但如实报不可达 |
| R4 | **前端 dist 是构建产物**：手改 dist 会在下次 `build:dist` 被覆盖 | 改动丢失 | Vue 源改 `src/` 后跑 `npm run build:dist`；纯 `dist/plugins/*` 属 compose-dist 的 PROTECTED 手写层，直接改可持久（需确认） |
| R5 | `DependencyCenter` 等组件的**双重用途** | 删多了丢功能 | 先 grep 引用方，仅"仅被 onboarding 用"才删 |
| R6 | 用户桌宠窗口正在跑旧页面 | 看到的是旧 UI，误判"没生效" | 改完提示刷新窗口（Ctrl+R）；`restart_mio.ps1` 已含此提示 |
| R7 | **`/api/onboarding/status` 被别处调用** | 前端 404 | 全局搜 `onboarding` 确认只有 App.vue 用 |

---

## 4. 关键约束（不要违反）

1. **D4**：桌宠主体（独立 Electron 壳）不动；插件只推事件
2. **12 态总线不删**（`voice` 保留为预留态）
3. **`packages/mao-pet` 不动**（那是 DSH 插件本体，是保留项）
4. **Mao 主仓库不动**（本计划只在 `Mao-dsh-pet` 执行）
5. **不用 `git add -A`**，只用显式文件清单
6. **破坏性操作前备份并告知路径**（纪律⑥）

---

## 5. 验收清单（DoD）

- [ ] 全新数据目录启动 → **直接进主界面**，无六步流程
- [ ] `app/agents/{xiaozhi,octop}` 不存在；`grep -r "xiaozhi\|octop"` 在 py 中**无功能性残留**
- [ ] `dist/plugins/` 只剩 `dsh/`
- [ ] 前端导航/观察 tab/体检条目中**无小智/Octop 入口**
- [ ] **DSH 能力全绿**：12 态、逐 token、横条、审批/提问、摄入端点
- [ ] `npm run guard` exit 0
- [ ] Vue 单测全过
- [ ] `dsh_adapter_selftest` 全过
- [ ] `ingest_selftest` 全过
- [ ] `e2e_stream_pet.cjs` exit 0
- [ ] 文档已更新（README / SRC-MAP / 阉割记录）
