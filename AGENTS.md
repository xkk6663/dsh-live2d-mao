# AGENTS.md · 工程纪律权威出处

> 本文件是 **dsh-live2d-mao**（DSH 专用 Live2D 桌宠，2026-10-17 起从 Mao 桌宠 fork 后专用化）仓库的**工程纪律权威出处**。
> 改任何代码前先读本文件；本文件与其它文档冲突时，**以本文件为准**。

---

## 1. 仓库定位（一句话）

DSH 专用 Live2D 桌宠：桌宠本体只认统一状态总线上的 12 态 phase，`packages/dsh-live2d-mao` 插件
把 DSH 会话事件映射成 phase/流式/横条/审批提问。**不是跨 Agent 平台，不是陪伴型桌宠。**

---

## 2. 三条架构红线（机器守卫，违反 = 测试失败）

> 这些红线由 `packages/dsh-live2d-mao/test/architecture.test.js` **机器守卫**，
> 不是靠注释和自觉。改动后跑 `packages/dsh-live2d-mao; npm run test:fast` 必须全绿。

| # | 红线 | 守卫方式 | 理由 |
|---|---|---|---|
| **R1** | **插件不碰核心 DOM**：`packages/dsh-live2d-mao/lib/**` 不得出现 `#speech-bubble` / `#activity-indicator` / `#pet-strip` 等核心元素选择器 | 扫描 lib 源码字符串 | 核心 UI 归桌宠主体；插件只能经 `window.__mioPetStrip` / `__mioPetBubble` 说话。踩过真实回归：插件越界改核心 DOM → 关掉插件泡泡就没了 |
| **R2** | **12 态词汇不删不改**：`phases.js` 的 `PHASES` 必须恰为 12 态，含 `voice`（D1 预留态） | 断言数组内容 | 12 态是总线契约；`voice` 虽无 TTS 也要留（未来 DSH 语音的插座） |
| **R3** | **D5 命名**：npm 名与 cordis id 必须全小写 `dsh-live2d-mao`，显示名 `DSH-Live2D-Mao` | 断言 package.json / cordis.patch.yml / pusher.js | npm 禁大写；id 与包名不一致会导致插件装不上 |

---

## 3. 变更纪律

1. **改前端注入层**（`dist/core-inject`/`kernel`/`plugins`/`live2d-pet`）：直接改 + 升 `?v=` 版本参数（`dist/index.html` 与 `dist/live2d-pet/index.html`）。
2. **改 Vue 源码**（`澪Agent应用/src/`）：改完 `npm run build:dist` 重建，`npm run guard` 必须 exit 0。
3. **改后端**：`python -m py_compile` 校验 + `dsh_adapter_selftest` + `ingest_selftest`。
4. **改插件**（`packages/dsh-live2d-mao/lib/**`）：`npm run test:fast` + `npm run test:e2e`。
5. **提交前跑门禁**（四条必跑，见 §6）。

---

## 4. Context pointers（改哪块先读哪份文档）

| 改这块 | 先读 |
|---|---|
| 桌宠渲染端 `live2d-pet.js` / `live2d-pet.css` | `SRC-MAP-源码地图.md` §2、§6（手改压缩产物必知：block patch 跳过） |
| 横条 `#pet-strip` / `__mioPetStrip` | `docs/M7-7.6-横条通道契约.md` + `SRC-MAP` §2.1 |
| **插件市场 / 热插拔 / 上架下架** | ★ **`docs/插件市场-契约.md`**（清单格式 + `/api/plugin/market/*` + loader 加载协议 + 事件名；前端/后端/渲染端三方实现的**唯一出处**） |
| 插件 `packages/dsh-live2d-mao/lib/**` | `docs/M7-协议测绘-源码级.md`（事件→phase 映射）+ `docs/DSH专用化阉割计划.md` |
| 后端 `app/agents/dsh/**` | `dsh_adapter.py` 头部注释 + `dsh_adapter_selftest.py` |
| 桌宠外壳 `live2d-desktop/main.js` | `docs/DSH专用化阉割记录.md` §7.4（**外壳起不来三层真根因**：ELECTRON_RUN_AS_NODE / pet-instance 锁 / 工作目录回落 Mao） |
| 设置页 / 泡泡页 | `settings-panel-inject.js` / `bubble-panel-inject.js` 头部注释 |
| **要发版 / 上架市场** | ★ **`docs/SKILL-发布与版本迭代.md`**（门禁 → 版本号同步 → npm publish → 实机验证 → 市场 PR 全流程 + 故障速查） |
| 项目独立性 / Electron 权限 | `docs/项目独立性-技术分析.md`（AppContainer 沙箱、ACL 继承、方案 B） |
| **大肥鱼对话页** `FeiyuChatPage.vue` / `useCompanionChat.js` | ★ **`docs/大肥鱼功能总览.md`**（消息模型、排序铁律、去重规则）+ `docs/大肥鱼多模态桥接-协议与修复.md`（协议与踩过的坑） |
| **大肥鱼后端** `app/cloud_feiyu/**`、`routes/companion.py` | `docs/大肥鱼聊天-后端契约审计.md`（**契约陷阱**：chat-settings 不存在 / cancel 无效 / 一轮问答共用 request_id） |
| 气泡 & 状态徽标配色 | `docs/大肥鱼功能总览.md` §5（**身份色与状态色必须并存**；曾用 `!important` 把 12 态色全盖掉） |
| **接新设备到云端 AstrBot**（一个灵魂多个身体） | ★ **`docs/SKILL-跨设备接入云端AstrBot.md`**（六层架构 + **8 个易错假设** + 最小接入=零代码 + 记忆共享策略 + 多模态附件流转 + 安全红线） |

---

## 5. 关键决策（用户裁决，不可回退）

| 裁决 | 内容 |
|---|---|
| **D1** | 不引入 TTS 依赖；`voice` phase 保留为预留态，将来 DSH 语音走新通路，**不复活 `pet-xz-audio.js`** |
| **D4** | 桌宠主体（独立 Electron 壳）不动；插件只推事件 |
| **D5** | npm 名 + cordis id 全小写 `dsh-live2d-mao`（v1.0.0 改名；总线 agent_id 是 `dsh`，见 CHANGELOG v1.0.0「合并身份」） |
| **三通道独立** | 说话气泡 / 流式横条 / 状态徽标 各自菜单开关独立显示隐藏 |
| **横条=流式正文** | 流式正文走横条，气泡只显示工具状态（用户二次对齐） |
| **两仓库隔离** | 本仓库 `Mao-dsh-pet` 独立；`C:\Users\xiao1\Mao` 保持 v4.2.1 原样，绝不污染 |
| **插件清单化**（2026-10-25） | 插件不再写死在 `dist/index.html`，改由 `数据/插件市场.json` 清单驱动动态加载；**市场本身内置（builtin）** —— 它若可停用，点一下就会把"重新启用"的入口一起关掉（自我锁死）。清单格式见 `docs/插件市场-契约.md` |

---

## 6. 提交前门禁（四条必跑）

```powershell
cd C:\Users\xiao1\Mao-dsh-pet

# 1. 前端守卫
cd 澪Agent应用; npm run guard
node tests\e2e_stream_pet.cjs

# 2. 插件（含架构红线守卫）
cd ..\packages/dsh-live2d-mao; npm run test:fast; npm run test:e2e

# 3. 后端
cd ..\..\私人AI日记系统\backend
.venv\Scripts\python.exe -m app.agents.dsh.dsh_adapter_selftest
.venv\Scripts\python.exe -m app.agents.dsh.ingest_selftest
# 插件市场清单层（改 market / loader / catalog 后必跑）
.venv\Scripts\python.exe -m app.kernel.plugin_market_selftest

# 4. 插件契约 + 市场面板（改 plugins/** 或 kernel/** 后必跑）
cd ..\..\私人AI日记系统\backend\probe_tmp
node check_plugin_contract.cjs          # R7 / nav 一致性 / kernel 无 agentId 字面量

# 5. 插件市场回归（真浏览器，需后端在跑）—— 脚本已入仓库
cd ..\..\澪Agent应用\tests\market
node run-all.cjs                        # 一键跑全部（含 harness 假 DOM 单测）
#   找不到 playwright 时：NODE_PATH=<repo>\澪Agent应用\node_modules node run-all.cjs
#   浏览器不在默认位置时：PET_CHROME=<chrome.exe 路径>
```

---

## 7. 目录速查

| 目录 | 职责 |
|---|---|
| `packages/dsh-live2d-mao/` | DSH 插件本体（Cordis，只推事件） |
| `澪Agent应用/dist/live2d-pet/` | 桌宠渲染端（核心 UI + 横条 + Live2D） |
| `澪Agent应用/dist/core-inject/` `kernel/` `plugins/` | MIO 管理窗注入层（手写，受保护）。**`kernel/plugin-loader.js` = 清单加载器**（按 `数据/插件市场.json` 动态插 `<script>`），`kernel/plugin-registry.js` = 注册表 |
| `澪Agent应用/dist/plugins/market/` | **插件市场本体**（内置 builtin）：卡片网格 / 启停 / 上架 / 下架，只调 `/api/plugin/market/*` |
| `澪Agent应用/tests/market/` | **插件市场回归测试**（真浏览器）：`run-all.cjs` 一键全跑；`_config.cjs` 负责浏览器探测与路径（可移植，已入仓库） |
| `澪Agent应用/live2d-desktop/` | Electron 主进程（窗口/穿透/托盘） |
| `私人AI日记系统/backend/app/kernel/` | 12 态统一状态总线 + **`plugin_market_service.py`（插件清单层）** |
| `私人AI日记系统/backend/app/routes/plugin_market.py` | 插件市场 HTTP 面（`/api/plugin/market/*`） |
| `私人AI日记系统/数据/插件市场.json` | **插件清单（运行时数据，不进仓库）**：上架/下架写的就是它 |
| `私人AI日记系统/backend/app/agents/dsh/` | DSH 适配器 + 边车 + 摄入端点 |
| `docs/` | 文档（见 `docs/INDEX.md` 若有） |
