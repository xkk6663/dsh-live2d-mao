# DSH 专用化阉割记录（阶段 4 收口）

> 生成日：2026-10-17 ｜ 仓库：`C:\Users\xiao1\Mao-dsh-pet`（分支 `dsh-only-slim`）
> 依据：`docs/DSH专用化阉割计划.md` 的「阶段 4：收口与文档」
> 记录：本次「清理残留 + 更新文档 + 汇报进度」的完整执行与验收。

---

## 0. 一句话结论

DSH 专用化的**代码阉割**（阶段 1~3）已在此前提交完成；本次是**阶段 4 收口**：
清理了遗漏的残留产物（小智 json / 死 IPC / 孤儿 overlay / 运行时垃圾 / 旧文档），
修复了一个「新 clone 即坏」的 `.gitignore` 误伤，并把 README / SRC-MAP 从「跨 Agent 平台」
改写成「DSH 专用」现状。

---

## 1. 残留清理清单（本次）

### 1.1 小智残留文件（已 `git rm`）

| 文件 | 说明 |
|---|---|
| `xiaozhi_observe.json`（根） | 小智屏幕观察配置（观察 tab 已阉割） |
| `xiaozhi_prompts.json`（根） | 小智图片/观察提示词 |
| `私人AI日记系统/xiaozhi_prompts.json` | 同上，backend 副本 |
| `澪Agent应用/dist/live2d-pet/overlay.html` | 截图提问覆盖层（依赖已删的 `/api/xiaozhi/vision-bubble`，孤儿文件） |

### 1.2 死 IPC（已删，preload 桥暴露但主进程无 handler）

| 位置 | 删除项 |
|---|---|
| `live2d-desktop/preload.js` | `openXiaozhi` / `openScreenCrop` / `sendXiaozhiBubble` / `onXiaozhiBubble` |
| `live2d-desktop/pet-chat-preload.js` | `sendXiaozhiBubble` |

> 核实：`live2d-pet.js` 已不调用任何上述方法；`pet-chat-bar.js` 只用 `mioDesktop.toggleChatWindow`。删除后 `node --check` 通过。

### 1.3 脚本/文案残留

| 文件 | 改动 |
|---|---|
| `打包发布.ps1` | 移除 `xiaozhi_prompts.json` 打包项 + `xiaozhi_device.json`/`xiaozhi_chat_history.json` 排除项 |
| `安装依赖.ps1` | 移除「到小智控制台绑定」的过时提示，改为 DSH 专用版说明 |

### 1.4 运行时垃圾（已删，均被 gitignore、不污染 git status）

| 项 | 说明 |
|---|---|
| 根目录 `*.log` / `*.log.prev` / `start_mio.log` | 运行日志（`backend_err.log`/`backend_out.log` 被在跑后端进程锁定，留待下次重启轮转） |
| `.dist-cleanup-safety-2026-10-16/17` | 构建清理的安全备份（~760KB） |
| `本地视觉\`（空） | 后端运行时工作目录（`MIO_LOCAL_VISION_DIR`，后端会按需重建，gitignored） |

### 1.5 上游遗留旧文档（已 `git rm`，8 份）

| 文档 | 删除理由 |
|---|---|
| 技术需求与现状分析-桌宠音频对话链路.md | 小智音频链路历史分析，功能已阉割 |
| 项目接管执行方案.md | 上游 Mao 接管方案，非 DSH 专项 |
| 桌宠保存反馈BUG-诊断与决策.md | 上游一次性 BUG 取证 |
| 桌宠性能根因分析.html | 上游一次性性能取证 |
| dist变化对照表-v4.1.md | 上游 v4.1 回仓对照 |
| fork就绪检查单-v4.1.md | 上游 fork 检查单 |
| Vue源码回仓可行性评估.md | 上游回仓评估 |
| M2-2.1-小智对话历史-回写规范.md | 小智对话历史规范，功能已阉割 |

> 保留的 DSH 专项文档：交接单 / 阉割计划 / 落地记录 / M5 spike / M6 / M7 协议测绘 / M7-7.6 契约与实现 / DSH桌宠深度融合技术方案。

---

## 2. `.gitignore` 修复与瘦身

### 2.1 修复「新 clone 即坏」的真 bug

`app/companion/audio_diag.py` 被 `.gitignore` 的 `*_diag*.py` 规则误伤 → 未入库，
但它是 `routes/companion.py:25` 真实 import 的模块（音频设备枚举），
任何新 clone 都会 `ImportError: cannot import name 'audio_diag'`。

**修复**：在 `*_diag*.py` 后加白名单 `!私人AI日记系统/backend/app/companion/audio_diag.py`，
并把该文件 `git add` 入仓。已用 `git check-ignore` 验证白名单生效。

### 2.2 精简失效规则

| 删除规则 | 原因 |
|---|---|
| `xiaozhi_*_test.py` / `xiaozhi_android_style.py` / `xiaozhi_render.md` / `xiaozhi_downlink_probe.py` / `xiaozhi_vision_mp*.py` | 小智诊断脚本，插件已阉割 |
| `xiaozhi_chat_history.json` / `xiaozhi_mcp_tools.json` / `xiaozhi_memo.json` | 小智运行数据 |
| `octop_config.json` | Octop 已阉割 |
| `私人AI日记系统/xiaozhi_observe.json` | 文件已删 |

**保留**：`agent_bus_config.json` / `dsh_config.json`（仍在使用）、`xiaozhi_device.json`（敏感兜底）、通用诊断规则、模型/运行时数据/日志/备份等宽网。

---

## 3. 文档更新

| 文档 | 改动 |
|---|---|
| `README.md` | 全量重写：从「跨 Agent 平台（小智/DSH/Octop）」改为「DSH 专用」；更新架构图、目录结构、三条独立通路、门禁、文档索引 |
| `SRC-MAP-源码地图.md` | 全量重写：删除小智/Octop/overlay/质检导航，补 DSH 插件包与 `packages/dsh-live2d-mao` 结构，记录本次清理与修复 |
| `docs/DSH专用化阉割记录.md`（本文件） | 阶段 4 收口记录 |

---

## 4. 验收对照（DSH专用化阉割计划 §5 DoD）

| 验收项 | 状态 |
|---|---|
| 全新数据目录启动 → 直达主界面，无六步质检 | ✅（阶段 1 已提交 `dd47771a`） |
| `app/agents/{xiaozhi,octop}` 不存在 | ✅（阶段 2 `495ce307`；`app/agents/` 只剩 `dsh/`） |
| `dist/plugins/` 只剩 `dsh/` | ✅（阶段 3 `e4e829ca`） |
| 前端导航/观察 tab/体检无小智/Octop 入口 | ✅（导航 = 桌宠/设置/DSH） |
| DSH 能力全绿（12 态 / 流式 / 横条 / 审批提问 / 摄入端点） | ✅（本次门禁复跑，见 §5） |
| `npm run guard` exit 0 | ✅ |
| Vue 单测全过 | ✅（83/84，1 项上游既有失败，非本次引入） |
| `dsh_adapter_selftest` 全过 | ✅ 201/201 |
| `ingest_selftest` 全过 | ✅ 63/63 |
| `e2e_stream_pet.cjs` exit 0 | ✅ 18/18 |
| 文档已更新（README / SRC-MAP / 阉割记录） | ✅ 本次 |

---

## 5. 门禁复跑（本次收口后）

> 详见最终提交时的门禁输出。关键结果：guard exit 0、adapter 201/201、ingest 63/63、插件 232/232、E2E 18/18。

---

## 6. 后续开发方向（建议，待用户裁决）

1. **DSH 语音通路**（新功能，非复活小智）：当前 `voice` phase 为预留态。若要做 DSH 语音，走**新的 DSH 插件通路**（如 DSH 侧 TTS 事件 → 总线 → 桌宠口型），不碰旧 `pet-xz-audio.js`。
2. ~~**dsh_config.example.json 模板**~~ ✅ 已补（`私人AI日记系统/dsh_config.example.json`，新 clone 照抄改名即可）。
3. ~~**测试 harness 投递确认**~~ ✅ 已根治（push 改为「页面回执确认」，连跑 5/5 全绿，豁免降级为安全网）。
4. **`audio_diag.py` 上游归因**：本次只在**本仓**加了白名单；上游 Mao 的 `.gitignore` 仍有同样的 `*_diag*.py` 误伤，若需可在 Mao 侧同步修（但不污染 Mao 仓库，需用户另行裁决）。

---

## 7. 阶段 4 之后的迭代（2026-10-17 下午）

> 收口之后又按用户反馈做了多轮 UI 与启动修复，这里补记，避免后续接手重复踩坑。

### 7.1 横条三修（`1bc40b2`）

用户报三个横条 BUG，逐个修：

| 问题 | 根因 | 修法 |
|---|---|---|
| 必须右键才能拖/关 | 横条可见时 `setInteractive(true)` 是**整窗**开关，被 mousemove 翻回穿透；只有右键菜单打开（menuOpen=true）才保持交互 | 照抄 modelBounds 的**区域命中**机制：渲染层上报横条矩形 `mio-desktop:strip-bounds`，主进程只在鼠标落进横条矩形时关穿透 |
| 整屏被挡（B站播不了） | `setInteractive(true)` 让全屏透明窗口整体可交互，挡住横条后面整块屏幕 | 同上：区域命中代替整窗交互，横条之外照常穿透 |
| 文字截断/拉长不铺满 | `#pet-strip-text` 写死 `max-width:260px; max-height:3.2em` | 去上限、flex:1 铺满、去掉内部滚动 |

### 7.2 滚动字幕 + 外壳错仓库（`7f69090`）

- **滚动字幕**：横条限高一行、单行不换行，append 后滚到最右，新字右端出现、旧字被左边界裁掉滑出。
- **外壳错仓库**（双击/拖关不生效的真根因之一）：`restart_mio.ps1` 之前把 Electron 工作目录设成 electron.exe 所在仓库，本仓库 node_modules 缺失时回落到 **Mao 主仓库的 main.js**（没有区域命中/双击 DSH/strip-bounds 改动）。修正：工作目录固定指向本仓库 live2d-desktop。

### 7.3 双击 DSH + dsh_config 模板 + E2E 回执（`5dd09c8`）

- **双击桌宠直达 DSH 面板**：新 IPC `mio-desktop:open-dsh-panel` → 主进程打开管理窗并在其渲染层触发 `__mioDshPanel.show()`（带 6s 就绪重试）。
- **`dsh_config.example.json`**：新 clone 照抄改名即可。
- **E2E 回执确认**：`push` 改为「页面回执确认」投递，根治连跑偶发丢消息。

### 7.4 ★ 外壳起不来的三层真根因（`5ee97b7`，最坑，务必记录）

桌宠外壳改完 main.js 后**怎么都起不来**（electron 秒崩），逐层定位出三个叠加的根因：

1. **`ELECTRON_RUN_AS_NODE=1`**（DSH 宿主环境变量）继承给 electron.exe → 退化成 node 模式（`bad option: --no-sandbox`、`require('electron')` 返回空、`app` undefined）。两个启动脚本开头必须 `Remove-Item env:ELECTRON_RUN_AS_NODE`。
2. **本仓库 `pet-data/pet-instance` 无法创建 chromium 单实例锁**（`SingletonLock` Error 5）。Mao 目录有一条 AppContainer capability SID（`S-1-4-49512934-974561200`）的显式 Allow 规则，本仓库 git clone 缺失；`icacls`/`Set-Acl` 复制**无法稳定修复**。唯一可靠解：复用 Mao 主仓库的 `pet-data/pet-instance` 作为 electron userData（只存缓存/锁，不含源码，两仓库共享无害），状态数据仍走本仓库。
3. **Electron 工作目录回落到 Mao**（见 7.2），导致加载 Mao 的旧 main.js。

> 修复后验证：electron 的 `app-path` 指向本仓库 `Mao-dsh-pet\澪Agent应用\live2d-desktop`，5~6 进程稳定运行。
> **启动方式**：用户桌面 `重启后端+一键拉起桌宠.cmd` → 调 `restart_mio.ps1`；改外壳（main.js/preload.js）后要 `-ForcePet`。

### 7.5 横条个性化设置（`cd278fd9`）

设置页新增「横条」tab（资料/桌宠/语音/泡泡/**横条**），三个控件，值走 `PATCH /api/companion/settings` → `settings_changed` → 桌宠热应用：

| 键 | 控件 | 默认 | 说明 |
|---|---|---|---|
| `live2d_strip_width` | 宽度滑条 | 0 | 打开横条初始宽度；0=自适应，>0=固定像素 |
| `live2d_strip_rows` | 行数滑条 | 1 | 横条一次显示几行；1=滚动字幕，多行=换行铺满 |
| `live2d_strip_style` | 皮肤下拉 | default | 8 款配色，为「横条 UI 可更换」预留扩展点 |

后端三处同步：`routes/companion.py` 写入白名单模型 + `companion_service.py` DEFAULT_CONFIG + 前端 `settings-panel-inject.js` settingsKeys。
