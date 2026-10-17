# Mao-pet（DSH 专用）· 源码地图（SRC-MAP）

> 本仓库的界面导航手册。**改哪个界面，先查这张表。**
> 更新日期：2026-10-17（DSH 专用化收口 + 残留清理）

---

## 1. 项目定位（一句话）

把开源桌宠 Mao（原 Mio）从「跨 Agent 平台」改造为 **DSH 专用形态**：桌宠本体只认统一状态总线上的 12 个标准 phase，DSH 插件线（`packages/mao-pet` + 后端 `app/agents/dsh`）把 DSH 会话的实时状态映射成桌宠动画/徽标/气泡/横条。小智、Octop 已整体阉割。

---

## 2. 界面导航（最重要，先看这里）

现在**在用的界面只有两类**：**桌宠本体**（含横条 + 对话横条）和 **MIO 管理窗口**（桌宠管理 / 设置 / DSH 面板）。

### 2.1 桌宠本体（桌面上的 Live2D 看板娘）

| 项 | 位置 |
|---|---|
| 页面入口 | `澪Agent应用\dist\live2d-pet\index.html` |
| 主逻辑 | `澪Agent应用\dist\live2d-pet\live2d-pet.js`（右键菜单/拖拽/模型加载/phase 映射/状态栏/视线跟随/**横条 `__mioPetStrip`**） |
| 样式 | `澪Agent应用\dist\live2d-pet\live2d-pet.css`（含徽标 12 态专属色 + **横条 + 内联代码药丸 + 拉伸手柄**） |
| 表情工具 | `澪Agent应用\dist\live2d-pet\expression-utils.js` |
| 渲染库 | `dist\live2d-pet\libs\`（pixi / cubism4 / live2dcubismcore） |
| 模型库 | `dist\live2d-pet\models\`（内置：官方 6 + 项目内置 DeepSeek娘(`whale-deepseek`)/大肥鱼(`da-feiyu`)，随 git 分发；外部导入放 `pet-data\Live2D桌宠\models\`，仅本机） |
| 辅助脚本 | `pet-sound.js`（音效）/ `pet-idle-talk.js`（空闲自语）/ `pet-gallery.js`（图库）/ `pet-bubble-styles.js`（皮肤）/ `pet-random-image.js` / `plugin-bus.js` |
| Electron 窗口 | `澪Agent应用\live2d-desktop\main.js` 中 `mainWindow`（穿透判定 + 16Hz 鼠标推送） |

> ⚠ **横条 `#pet-strip` 是核心 UI**：插件只能经 `window.__mioPetStrip`（`show/append/hide/isVisible/isDismissed/setEnabled/applyStyle/info`）访问，不得直接改 DOM。横条承载 DSH 流式正文，支持左右拉伸、拖动、✕ 关闭，内联代码（`` `code` `` / ``` 围栏 ```）渲染成药丸。

### 2.2 对话横条（点桌宠弹出）

| 项 | 位置 |
|---|---|
| 页面 | `澪Agent应用\dist\live2d-pet\chat-bar\pet-chat-bar.html` + `pet-chat-bar.js` |
| Electron 窗口 | `main.js` 中 `chatWindow`（preload: `pet-chat-preload.js`） |
| 后端接口 | `POST /api/companion/chat`（走桌宠自有通路，**非**小智 `/api/xiaozhi/*`） |

### 2.3 MIO 管理窗口（右键桌宠 →「打开 MIO」）

| 项 | 位置 |
|---|---|
| URL | `http://127.0.0.1:8000/agent-app/?workspace=main&v=...` |
| 入口 HTML | `澪Agent应用\dist\index.html`（加载 assets 分片 + 注入 script 标签，均带 `?v=`） |
| 桌宠管理页 | `澪Agent应用\dist\assets\CompanionPage-*.js` + `PetAppearancePanel-*.js`（模型管理 / 保存反馈 / 实时刷新） |
| DSH 面板 | `dist\plugins\dsh\dsh-panel.js` + `manifest.js`（DSH 状态面板 + 导航注入） |
| 前端微内核 | `dist\kernel\plugin-registry.js`（注册表）/ `plugin-nav.js`（导航注入） |
| 核心注入层 | `dist\core-inject\`（settings-panel-inject / bubble-panel-inject / agent-switch-inject / health-panel-inject 等） |
| Electron 窗口 | `main.js` 中 `petAdminWindow` |

> ⚠ **DSH 专用化（2026-10-17）**：`dist/plugins/` 现在**只剩 `dsh/`**（xiaozhi/octop 已删）；导航只剩「桌宠 / 设置 / DSH」三项；`ChatPage`（小智对话页）、`OnboardingPage`（六步质检）、「观察」tab、「截图提问」均已移除。

### 2.4 辅助文件（Electron 进程侧）

| 文件 | 用途 |
|---|---|
| `live2d-desktop\main.js` | **Electron 主进程**：窗口/托盘/副屏边界/穿透轮询 |
| `live2d-desktop\preload.js` | 桌宠窗口 preload（安全桥） |
| `live2d-desktop\pet-chat-preload.js` | 对话横条 preload |
| `live2d-desktop\lock-control-preload.js` / `lock-control.html` | 锁定控制窗 |

---

## 3. 后端导航（FastAPI，端口 8000）

**入口**：`私人AI日记系统\backend\app\main.py`

### 3.1 DSH 插件包（本项目主战场）

目录：`私人AI日记系统\backend\app\agents\dsh\`

| 文件 | 用途 |
|---|---|
| `dsh_adapter.py` | ★ DSH 适配器：会话日志 → facts → phase 映射；零依赖 Node 边车管理 |
| `dsh_log_stream.mjs` | ★ DSH 边车（Node 零依赖）：逐帧解 zstd 会话日志 → 折叠 facts → NDJSON |
| `dsh_signals.py` | DSH 信号判定（纯文字 / 审批等待 / 提问等待） |
| `ingest.py` | ★ 插件推送端点逻辑（HTTP → `agent_bus_service.emit`） |
| `routes.py` | ★ HTTP 面：`POST /api/plugin/dsh/ingest`（phase）、`POST /api/plugin/dsh/strip`（横条）+ 只读 status/diagnostics |
| `dsh_adapter_selftest.py` | ★ 适配器自检（201 项） |
| `ingest_selftest.py` | ★ 摄入端点自检（63 项） |
| `dsh_acceptance.py` / `dsh_adapter_e2e.py` | 验收 / 端到端验证 |
| `dsh_fixture_build.py` / `dsh_latency.py` / `dsh_stats.py` / `dsh_gap_analysis.py` / `dsh_ws_check.py` | 运维/测绘脚本 |

### 3.2 跨 Agent 状态总线

| 文件 | 用途 |
|---|---|
| `app\kernel\agent_bus_service.py` | ★ **统一总线**：12 phase 枚举、活跃聚焦调度、心跳、WS 广播、`strip()`、`announce()` |

> ⚠ 本总线原为跨 Agent 设计（小智/DSH/Octop 都接），**DSH 专用化后只剩 DSH 一个 Agent 源**。12 态词汇**不删**（`voice` 保留为预留态，D1 裁决）。

### 3.3 桌宠配套

| 文件 | 用途 |
|---|---|
| `routes\companion.py` | 桌宠状态/设置/agents/素材库 + Agent 总线接口（`/agents`、`/agents/{id}/enabled`、`/agents/{id}/inspect`） |
| `companion\live2d_assets.py` | 桌宠数据目录解析（`MIO_PET_STATE_DIR`）+ 模型清单 |
| `companion\audio_diag.py` | ⚠ 音频设备枚举（**已被 `.gitignore` 白名单放回 git**，勿再忽略） |

### 3.4 敏感配置（已 gitignore，不入库）

| 文件 | 用途 |
|---|---|
| `私人AI日记系统\dsh_config.json` | DSH 接入配置（`enabled` + `sessions_root`）；缺省 `enabled=False` → DSH 显示「未启用」 |
| `私人AI日记系统\agent_bus_config.json` | 总线启用状态持久化（Agent 页开关） |

---

## 4. 插件本体（packages/mao-pet）

> ★ **DSH 插件本体**：Cordis 插件，npm 名与 cordis id 均为小写 `mao-pet`（D5 裁决），显示名 `Mao-pet`。

| 目录/文件 | 用途 |
|---|---|
| `lib\index.js` | 插件入口（register / 生命周期） |
| `lib\phases.js` / `phase-map.js` / `facts.js` / `events.js` | 12 态枚举、facts→phase 映射、事件折叠 |
| `lib\stream.js` | 逐 token 流式（`text-chunks` 帧 + dt 时基） |
| `lib\approval.js` / `questions.js` | 审批 / 提问应答 |
| `lib\bubble-stack.js` / `projections.js` | 气泡栈 / 投影 |
| `lib\strip.js` | 横条窗位客户端 |
| `lib\push\pusher.js` + `transports\` + `strip-remote.js` | 推送层（HTTP 到后端 `/api/plugin/dsh/*`） |
| `lib\security\fence.js` | 安全栅栏 |
| `test\`（9 套件） | 单测（`test:fast`）+ E2E（`test:e2e`，打真实后端 TestClient） |

**关键约束**：
- **D1**：不引入任何 TTS 依赖；`voice` phase 保留为「预留态」，将来做 DSH 语音走新通路。
- **D5**：npm 名与 cordis id 必须小写 `mao-pet`。

---

## 5. 启动 / 日志 / 自检

| 项 | 位置 |
|---|---|
| 一键启动 | `start_mio.ps1`（后端 + Electron，幂等） |
| 一键重启 | `restart_mio.ps1`（先 `taskkill /T /F` 停树再拉起，解决旧进程占 8000 端口） |
| 桌宠数据目录 | `pet-data\Live2D桌宠`（后端与 Electron 经 `MIO_PET_STATE_DIR` 统一） |
| 副屏边界 | `phys_bounds.ps1`（**被 main.js 引用，勿移**） |
| DSH 自检 | `cd 私人AI日记系统\backend` → `.venv\Scripts\python.exe -m app.agents.dsh.dsh_adapter_selftest` |
| 摄入自检 | `.venv\Scripts\python.exe -m app.agents.dsh.ingest_selftest` |
| DSH 边车手测 | `node 私人AI日记系统\backend\app\agents\dsh\dsh_log_stream.mjs --once` |

---

## 6. 修改守则（每次改前看一遍）

1. **改界面** → 先查第 2 节表，确定改哪个文件。`dist\assets\` 是 Vue 构建产物（`CompanionPage`/`PetAppearancePanel` 例外，可直接改 + `node --check`）。
   ⚠ **手改压缩产物必知**：往 Vue 编译产物里手工新增动态节点，若落在 `(openBlock(), createBlock(...))` 区块内会被 `patchBlockChildren` 索引式 patch 整体跳过（render 跑了但 DOM 不变）。解法：去掉 block 包裹走完整 children diff。**验证纪律：改完必须无头浏览器实测 DOM，不能只看 render 是否执行。**
2. **改后端** → 改 `app\` 下对应文件，`python -m py_compile` 校验。
3. **改完必做**：`node --check`（JS）+ `python -m py_compile`（py）+ **git commit**。
4. **前端文件带 `?v=` 版本参数**（`dist\index.html` 与 `dist\live2d-pet\index.html`）——改了哪个文件就升它自己的 `?v=`，否则缓存不刷新。
5. **重启方式**：`restart_mio.ps1`（会先停旧进程再拉起）。
6. **git 仓库**：本仓 `C:\Users\xiao1\Mao-dsh-pet`（分支 `dsh-only-slim`）。**Mao 主仓库 `C:\Users\xiao1\Mao` 保持 v4.2.1 原样，绝不污染。**

---

## 7. 已删除 / 已阉割（DSH 专用化 + 本次收口）

以下内容已删除（git 历史可回溯），别再去找：

| 内容 | 说明 |
|---|---|
| `app/agents/xiaozhi/` / `app/agents/octop/` | 小智/Octop 后端源码整体阉割 |
| `dist/plugins/xiaozhi/` / `dist/plugins/octop/` | 前端插件目录删除 |
| `src/components/{ChatPage,OnboardingPage}.vue` + `services/onboardingApi.js` + `onboardingGates.js` | 小智对话页 + 六步质检流程 |
| `dist/live2d-pet/overlay.html` | 截图提问覆盖层（依赖 `/api/xiaozhi/vision-bubble`） |
| `xiaozhi_observe.json` / `xiaozhi_prompts.json`（根 + backend） | 小智屏幕观察提示词 |
| 8 份上游遗留旧文档 | 音频链路分析 / 接管方案 / 保存BUG诊断 / 性能根因 / dist对照表 / fork检查单 / Vue回仓评估 / 小智历史回写规范 |

**本次收口额外修复**：
- `.gitignore` 白名单放回 `app/companion/audio_diag.py`（原被 `*_diag*.py` 误伤 → 新 clone ImportError）
- 精简 `.gitignore` 失效的小智/octop/诊断规则
- 删除 `preload.js` / `pet-chat-preload.js` 中 4 个死 IPC（`openXiaozhi`/`openScreenCrop`/`sendXiaozhiBubble`/`onXiaozhiBubble`）
