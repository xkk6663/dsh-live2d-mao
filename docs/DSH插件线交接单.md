# DSH 插件线交接单（fork 后开发起点）

> 生成日：2026-10-16 ｜ 交接基线：**v4.2.1**（commit `93c133d4`，tag 已推 GitHub）
> 用途：DSH 侧（创造模式会话）fork 本仓库后，按此单从零开始开发 DSH 桌宠插件。
> 上游文档：`docs/项目接管执行方案.md`（§0 决策 + M5~M7）、`docs/DSH桌宠深度融合技术方案.md`、`docs/fork就绪检查单-v4.1.md`。

---

## 1. 交接分界线

| 侧 | 负责范围 | 状态 |
|---|---|---|
| **WorkBuddy 侧（本仓库主线）** | 仓库线 M0~M4（收口/回仓/管线加固/v4.0 发布）+ 壳侧 12-phase 状态总线与核心 API 稳定 + 交接文档 | ✅ 已完成（v4.2.1） |
| **DSH 侧（fork 后，本文档）** | M5 Phase 0.1 spike → M6 `packages/mao-pet` 最小可跑 → M7 B 档能力 | ⬅ 从这里开始 |

**Fork 基线**：从 `v4.2.1` tag 切出（含全部修复；D2 裁决的 v4.0 fork 起点已被后续修复覆盖，勿从旧 tag 切）。

---

## 2. 开工顺序

### 第 0 步 · 恢复对标物（前置，必须先做）

- ⚠ `_dsh_src/` 目录**已不在本机**——重新抽取 DSH 源码；
- 重新获取 **dsh-whale-widget** 插件源码：其 `lib/index.js:749-774`（安全栅栏三层）是 M6 步骤 4 的照抄蓝本；
- 本仓库侧的移植参照（**只读，不改**）：
  - `agent_bus_service.py:34-47` —— 12 态 phase 推导（12-phase 状态总线，已稳定运行）；
  - `dsh_adapter.py` —— DSH 事件 → phase 映射；
  - `dist/core-inject/` + `window.__mioPetBubble` 等核心 API —— 插件访问桌宠的唯一合法通道。

### 第 1 步 · M5 Phase 0.1 spike（0.5 天，拿二元结论）

| # | 动作 | 验收 |
|---|---|---|
| 5.1 | 用 whale-widget 范式写 20 行最小插件：`apply(root)` **第一件事注册注入行**，再 `new BrowserWindow({transparent:true, frame:false, alwaysOnTop:true, skipTaskbar:true})` | 看到置顶穿透窗口 = 通过 |
| 5.2 | 结论记入 `docs/` 与开发日志 | 可复现 |

- **先验偏不通**（原取证：本机 6 个已装插件的 `electron`/`BrowserWindow`/`webContents` 命中全为 0；`dsh-plugin-wallpaper-engine` README 写明「要壳侧配合，插件侧改不动」）；
- **但结论不影响桌宠主体**（裁决 D4）：主体固定「独立 Electron 壳 + 插件只推事件」。spike 只决定**插件侧能不能省掉壳**，不通就直接进 M6 走事件推送路线，无阻塞。

### 第 2 步 · M6 dsh-connector 最小可跑（3-5 天）

| # | 任务 | 验收 |
|---|---|---|
| 6.1 | 建 `packages/mao-pet`（`package.json` name=`mao-pet`、`cordis.patch.yml`、`lib/index.js`）；显示名 `Mao-pet` | `dsh plugin --profile web add link:...` 装得上 |
| 6.2 | `ctx.on('session/event')`，移植 `dsh_adapter.py` 的事件→phase 映射 | DSH 一说话，控制台打出 phase 变化 |
| 6.3 | 12 态 phase 推导（移植 `agent_bus_service.py:34-47`） | 12 态全部可达，单测覆盖 |
| 6.4 | 安全栅栏三层（照抄 whale-widget `lib/index.js:749-774`） | 裸 curl 返回 401/403，浏览器里 200 |
| 6.5 | 推给桌宠（先 HTTP 轮询跑通，再上 WS） | 桌宠收到 phase 并切换动画 |

**★ 按 D1：此处才做「砍小智 TTS」**——只在 `packages/mao-pet` 范围内不引入 TTS 相关依赖；仓库主链路 `routes/xiaozhi.py` / `pet-xz-audio.js` / `voice` phase 完整保留。

### 第 3 步 · M7 Phase 2：B 档能力（5-7 天）

| # | 任务 | 验收 |
|---|---|---|
| 7.1 | `ctx.on('agent/assistant-stream')` 逐 token | 打字机延迟 < 100ms（⚠ 日志通道只能事后回放，真实时必须走 `session/follow`） |
| 7.2 | `approval/request` 应答（允许/拒绝） | 点按钮后 DSH 收到 `allowed-once`/`rejected` |
| 7.3 | `user-questions/request` 选项 | 回传 `{answers:[...]}` |
| 7.4 | 多 session 气泡栈（`MAX_SESSION_BUBBLES=12`） | 3 个 session 并发分别显示 |
| 7.5 | `session/follow` 拿 projections（contextPressure 等） | 气泡显示 |
| 7.6 | **横条复用为 DSH 流式提示窗口**（用户 idea，§18 登记）：把桌宠侧「可拖动 + 可关闭横条」抽为 DSH 流式 token/提示的专用窗位 | ① 流式提示显示在横条内、可拖动、✕ 可关；② 气泡与横条不同时弹同一内容；③ 横条主题/颜色可在「泡泡」界面自定义（复用 `live2d_bubble_style` 热应用通路）；④ 关闭后本次会话不再自动弹出 |

- ⚠ 7.1~7.3 有 **3 个未验证点**（assistant-stream 帧结构、approval 应答协议、多 session 事件推送），需实跑确认；
- ⚠ 7.6 工作量在**插件内**（插件经核心 API 挂载，不改主体 DOM）；横条若需主体暴露，走 `window.__mioPet*` 通道（与 `__mioPetBubble` 同模式）；主题配置存服务端 settings（`pet_bubble_*` 键位风格），桌宠侧热应用。

---

## 3. whale-widget 踩坑结论（三条必须继承）

1. `apply()` **第一件事就注册注入行**——宿主只在启动时收集一次，晚了整个会话拿不到；
2. 注入行用 `kind:'script'` **内联**，不要 `script-src`；
3. 前端文件由宿主**按 mtime 热读取**（改完即生效，无需重启宿主）。

---

## 4. 必须遵守的裁决与纪律（D1~D5）

| # | 裁决 | 落地含义 |
|---|---|---|
| D1 | 砍小智 TTS 只作用于 fork 目标 | 仅 `packages/mao-pet` 内不引 TTS 依赖；主链路不动 |
| D2 | v4.0 即 fork 起点 | 实际从 `v4.2.1` 切（见 §1） |
| D3 | 不动 DSH 悬空配置 | `~/.dsh` 的 `cordis.patch.yml - id: pet` 与孤儿 `pet.json` 保持原样 |
| D4 | 桌宠主体不并入插件形态 | 固定「独立 Electron 壳 + 插件只推事件」，插件不改主体 DOM/壳 |
| D5 | 命名 `Mao-pet` | 显示名 `Mao-pet`；npm 包名与 cordis id **必须全小写 `mao-pet`**（npm 禁大写包名） |

**协作纪律**：
- 与 WorkBuddy 会话并行改本仓库时，先 `git worktree` 隔离或一边停手（纪律⑤）；
- 破坏性操作前先备份并告知路径（纪律⑥）；
- 每完成一个阶段跑门禁（`npm run guard` 全 0 + 后端自检 184 项 + E2E 15 项），不通过不进下一阶段（纪律⑦）；
- 提交只用显式文件清单，不用 `git add -A`。

---

## 5. 环境速查（详见 fork就绪检查单-v4.1.md）

- Windows 10/11 x64 + **pwsh 7** + Node **≥22.12.0** + Python 3.10+；
- 首次跑通三步：`安装依赖.ps1` → `start_mio.ps1` → （改 Vue 源码时）`cd 澪Agent应用 && npm ci && npm run build:dist`；
- 健康检查用 `curl /api/companion/status`（期望 200）；`/api/health` **不存在（404）**；
- 桌宠 Electron 窗口由用户手动启动（`start_mio.ps1`），不要从 AI 工具会话代拉 GUI。

---

## 6. 完成定义（DoD）

- [ ] M5 spike 结论已记录（通/不通均可，主体不受影响）；
- [ ] `packages/mao-pet` 可安装、事件→phase 映射跑通、12 态可达、栅栏 401/403 生效、桌宠收得到 phase；
- [ ] M7 六项 B 档能力逐项验收（7.6 含横条/气泡互斥与泡泡界面主题自定义）；
- [ ] 全部门禁绿灯后打 tag（命名建议 `dsh-v0.1` 起步，与主线 v* 区分）。
