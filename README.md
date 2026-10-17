<div align="center">

# 🐳 Mao-pet · DSH 专用 Live2D 桌宠

> **DeepSeek Harness（DSH）的桌面"脸"** —— 把开源桌宠 Mao（原 Mio）深度改造为 DSH 专用形态：
> 桌宠本体无状态、只认统一状态总线上的标准 phase；DSH 插件线把 DSH 会话的
> 思考/执行工具/流式/审批/提问等实时状态，实时映射成桌宠的动画、徽标、气泡与横条。
> **小智 / Octop 等其它 Agent 已整体阉割（后端源码 + 前端 UI），本仓只保留 DSH 加强插件。**

[![platform](https://img.shields.io/badge/platform-Windows-0078D6)](#)
[![version](https://img.shields.io/badge/version-v4.2.1--dsh-1a2b4a)](#)
[![agent](https://img.shields.io/badge/agent-DSH%20only-orange)](#)
[![Live2D](https://img.shields.io/badge/Live2D-Cubism-ff69b4)](#)
[![frontend](https://img.shields.io/badge/frontend-Electron%20%2B%20PixiJS-9cf)](#)
[![backend](https://img.shields.io/badge/backend-FastAPI-2ca02c)](#)

</div>

---

## 一句话定位

> 本仓库是从 **Mao v4.2.1（`93c133d4`）** fork 出的**独立 DSH 插件线仓库**。
> 它不再是一个「跨 Agent 平台」，而是 **DSH 专用**的桌宠前端 + DSH 插件本体 + 后端总线接入层。
> 上游 Mao 主仓库（`C:\Users\xiao1\Mao`）保持 v4.2.1 原样、未被污染。

**三条边界（纪律，勿违反）**：
1. 小智 / Octop 已整体阉割（后端源码 + 前端 UI），**不要复活**——将来若要做 DSH 语音，走**新的 DSH 插件通路**，不碰旧的小智实现。
2. 首次进入**直达主界面**（桌宠管理页），不再有六步质检流程。
3. 桌宠状态分三条**独立**通路，各自菜单开关独立显示/隐藏：说话气泡 / 流式提示（横条）/ 状态徽标。

---

## 核心特性

| 关键词 | 能力 |
|---|---|
| 🐳 **DSH 专用** | 只保留 DSH 加强插件；小智/Octop 从后端源码到前端 UI 全部阉割，突出 DSH 专用化 |
| 🧩 **插件本体** | `packages/mao-pet`：Cordis 插件（npm 名 `mao-pet`），把 DSH 会话事件推成桌宠 phase/流式/横条 |
| 📡 **12 态状态总线** | 后端 `agent_bus_service` 统一 12 phase（idle/planning/thinking/executing_tool/streaming/waiting_input/voice/complete/error/paused/awaiting_approval/heartbeat） |
| ⚡ **逐 token 流式** | DSH 正文按上游**原始节奏**逐块铺进桌宠**横条**（不是整段弹出），收尾权威全文校正，零丢字零重复 |
| 🗂️ **横条窗位** | `#pet-strip` 专属窗位：DSH 流式正文（含内联代码药丸着色 + 单行滚动字幕）+ 左右无限拉伸 + 可拖动 + ✕ 可关；默认宽度/行数/皮肤可在设置页「横条」tab 个性化 |
| 👧 **Live2D 桌宠** | PixiJS + Cubism 渲染；内置模型分区管理、切换写穿服务端持久化、视线跟随、自由拖拽 |
| 🎨 **泡泡工坊** | 8 款气泡皮肤 + 点击互动序列 + 图片素材库 + 音效事件（波形裁剪），均归桌宠主体、插件只经 `window.__mioPetBubble` 说话 |
| ✅ **审批 / 提问应答** | `awaiting_approval` / `waiting_input` phase 驱动桌宠动画与徽标；插件侧 `approval` / `questions` 模块 |

### 三条独立通路（用户裁决，勿合并）

| 通路 | 承载 | 菜单开关 | 说明 |
|---|---|---|---|
| **说话气泡** `#speech-bubble` | 工具状态、插件喊话、点击互动 | 「隐藏/显示说话气泡」 | `live2d_speech_bubble_enabled` |
| **流式横条** `#pet-strip` | DSH 下发的流式正文（逐 token 铺开） | 「隐藏/显示流式提示」 | `live2d_stream_text_enabled` + 横条自身 dismissed 态 |
| **状态徽标** `#activity-indicator` | 工作细分 phase（4 秒淡出） | 「隐藏/显示状态徽标」 | 连接/断连/待机不显示 |

> 流式正文走**横条**，气泡只显示工具状态——这是用户二次对齐后的最终语义，勿再揉回同一个框。

---

## 架构

```
┌──────────────────────────── 本地（你的电脑） ────────────────────────────┐
│  Electron 前端（桌宠 = DSH 的脸）                                        │
│    live2d-pet：PixiJS+Cubism 渲染，只认 phase → 动作/表情/徽标           │
│    #pet-strip 横条：DSH 流式正文（内联代码着色 + 拉伸/拖动/关闭）          │
│    对话横条 chat-bar + MIO 管理窗（桌宠管理 / 设置 / DSH 面板）           │
│                              ▲ HTTP / WebSocket                          │
│  FastAPI 后端（端口 8000）                                               │
│    agent_bus_service ── 12 phase 统一状态总线（注册/上报/调度/心跳/广播）  │
│        ▲ register / emit / heartbeat / set_status / strip               │
│    app/agents/dsh ── DSH 适配器 + 边车 + ingest/strip 摄入端点            │
│        ▲ POST /api/plugin/dsh/{ingest,strip}                            │
│    packages/mao-pet（Cordis 插件）── 事件→phase 映射 + 推送               │
└───────────────────────────────────────────────────────────────────────────┘
        │ DSH 会话日志 session.v4.jsonl.zstd（零依赖 Node 边车逐帧解码）
        ▼
┌──────────────────── DeepSeek Harness（DSH）──────────────────────┐
│  会话事件流（turn/step/tool/assistant-message/approval/…）        │
│  → facts 折叠 → phase 映射 → 桌宠动画/徽标/横条                   │
└──────────────────────────────────────────────────────────────────┘
```

**核心设计（踩坑定型的架构决策）**：

1. **桌宠无状态，只认 phase**：DSH 适配器 / 插件是唯一接触 DSH 私有协议的代码；换数据源不需要动渲染端。
2. **活跃聚焦调度**：按 phase 优先级决定「谁占据桌宠身体」（voice 最高、idle 最低）；同 phase 300ms 节流。
3. **音频归桌宠本体**：对话窗只收文本，音频由桌宠播放，从根上避免多窗口叠声。（注：DSH 本版无 TTS，`voice` phase 为预留态。）
4. **穿透交互架构**：主进程轮询鼠标 + 渲染层上报模型区域/UI 状态驱动穿透（仅状态翻转才调 `setIgnoreMouseEvents`）。
5. **气泡/横条归桌宠主体**：插件只经核心 API（`window.__mioPetBubble` / `window.__mioPetStrip`）操作，不直接改 DOM。
6. **逐 token 流式是独立 WS 链路**：`agent_stream` 只喂横条，不参与 phase 计算、不抢桌宠「身体」。

---

## 快速开始

```powershell
# 1. 首次安装依赖（Python venv + Node + Electron）
pwsh -NoProfile -ExecutionPolicy Bypass -File 安装依赖.ps1

# 2. 启动桌宠（后端 + Electron 一次拉起）
pwsh -NoProfile -ExecutionPolicy Bypass -File start_mio.ps1
# 或一键重启（先停树再拉起，解决旧进程占 8000 端口）
pwsh -NoProfile -ExecutionPolicy Bypass -File restart_mio.ps1
```

- **环境要求**：Windows 10/11 x64 · PowerShell 7（pwsh）· Python 3.10+ · Node.js 18+
- 首次进入**直达桌宠管理主界面**（无质检流程）
- DSH 接入配置 `dsh_config.json`（项目根，已 gitignore）：`enabled: true` + `sessions_root` 指向 `C:\Users\xiao1\.dsh\sessions`

---

## 目录结构（主干）

```
Mao-dsh-pet
├── packages\mao-pet\                # ★ DSH 插件本体（Cordis，npm 名 mao-pet）
│   ├── lib\                         #   17 模块：phases/phase-map/facts/events/stream/
│   │                                #   approval/questions/bubble-stack/projections/strip/util
│   ├── lib\push\                    #   推送层（pusher + transports + strip-remote）
│   ├── lib\security\fence.js        #   安全栅栏
│   ├── test\                        #   9 套件（含 e2e-ingest / m7-protocol）
│   └── cordis.patch.yml             #   Cordis 插件清单（id=npm 名=mao-pet，小写）
├── 澪Agent应用\
│   ├── src\                         # ★ Vue 源码（dist/assets 的构建源）
│   ├── dist\live2d-pet\             # ★ 桌宠本体（live2d-pet.js/css + 横条 + models/ + libs/）
│   ├── dist\live2d-pet\chat-bar\    #    对话横条（pet-chat-bar，走 /api/companion/chat）
│   ├── dist\plugins\dsh\            #    DSH 面板（dsh-panel.js + manifest.js）
│   ├── dist\core-inject\ kernel\    #    MIO 管理窗注入层（手写，受保护）
│   ├── live2d-desktop\main.js       #    Electron 主进程（窗口/托盘/穿透/副屏边界）
│   ├── scripts\                     #    构建管线（clean-build/compose-dist/trim-pages/clean-dist）
│   └── tests\e2e_stream_pet.cjs     # ★ 渲染端 E2E
├── 私人AI日记系统\backend\
│   ├── app\kernel\agent_bus_service.py   # ★ 12 态统一状态总线（含 strip()）
│   ├── app\agents\dsh\                   # ★ DSH 插件包（adapter + 边车 + ingest/strip + 自检）
│   └── app\companion\ / app\routes\      #    桌宠主体 + HTTP API
├── docs\                            # 项目文档（见下）
├── start_mio.ps1 / restart_mio.ps1 / 安装依赖.ps1 / 打包发布.ps1
└── CHANGELOG.md / SRC-MAP-源码地图.md
```

---

## 门禁（自检）

```powershell
cd C:\Users\xiao1\Mao-dsh-pet

# 前端守卫 + E2E
cd 澪Agent应用; npm run guard
node tests\e2e_stream_pet.cjs

# 插件测试
cd ..\packages\mao-pet; npm run test:fast; npm run test:e2e

# 后端自检（需 backend\.venv）
cd ..\..\私人AI日记系统\backend
.venv\Scripts\python.exe -m app.agents.dsh.dsh_adapter_selftest
.venv\Scripts\python.exe -m app.agents.dsh.ingest_selftest

# 装插件（真机联调时）
dsh plugin --profile desktop add link:C:\Users\xiao1\Mao-dsh-pet\packages\mao-pet
```

---

## 文档索引

| 文档 | 内容 |
|---|---|
| `docs/DSH插件线交接单.md` | 原始需求与交接口径（M5 spike → M6 → M7 的 DoD） |
| `docs/DSH专用化阉割计划.md` | 阉割小智/Octop + 删质检流程的执行计划与验收口径 |
| `docs/DSH专用化阉割记录.md` | ★ 本次收口的完整执行记录（删了什么、为什么、怎么验） |
| `docs/新仓库落地记录.md` | 为什么独立成仓、本仓相对 v4.2.1 的全部改动 |
| `docs/M5-Phase0.1-spike-结论.md` | M5 技术 spike 结论（DSH 事件源选型） |
| `docs/M6-完成报告.md` | M6 插件本体落地（12 态总线接入 + 横条窗位） |
| `docs/M7-协议测绘-源码级.md` | M7 协议测绘（源码级，DSH 事件→phase 映射） |
| `docs/M7-7.6-横条通道契约.md` / `M7-7.6-实现报告.md` | 横条「最后一公里」契约与实现 |

**更新记录**：DSH 专用化系列提交见 `git log`（`dsh-only-slim` 分支）：7.6 横条接通 → DSH 插件线 v0.1 → 三条通路独立 → 阶段1 删质检 → 阶段2 后端阉割 → 阶段3 前端阉割 → DSH 面板+设置修复 → 流式对齐 → 方案A 删净小智资源 → 收口清理 → 横条三修（区域命中/无限拉伸/代码着色）→ 滚动字幕 → 双击 DSH + dsh_config 模板 + E2E 回执 → 外壳三层真根因修复 → 横条个性化设置。

**开发守则**：改界面先查 `SRC-MAP-源码地图.md`。Vue 源码改 `src/` 后 `npm run build:dist` 重建；手写注入层（`dist/core-inject`/`kernel`/`plugins`/`live2d-pet`）直接改并升 `?v=`。改后端 `python -m py_compile` 校验。
