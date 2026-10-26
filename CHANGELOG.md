# CHANGELOG · DSH-Live2D-Mao 桌宠

> 本仓库从「Mao 桌宠（跨 Agent 平台）」fork 后，专用化为 **DSH 专用 Live2D 桌宠**。
> 插件名 `dsh-live2d-mao`，本文件顶部版本号是 DSH 面板「关于」页的**唯一版本源**（`about_service.read_mio_version()` 读这里）。

---

## v1.2.0（2026-10-26）· **大肥鱼桌宠对话：多模态互通 + 记忆打通 + 渲染稳定性**

新增一个桌面端页签「大肥鱼」，接云端 AstrBot persona 333，与微信端是同一个人格。
功能总览见 [`docs/大肥鱼功能总览.md`](./docs/大肥鱼功能总览.md)，协议与踩坑见
[`docs/大肥鱼多模态桥接-协议与修复.md`](./docs/大肥鱼多模态桥接-协议与修复.md)。

### 新增能力

- **图像双向**：她发表情包 → 后端下载落盘 → 短 URL 经 WS `agent_image` + HTTP `attachments`
  双通道送达；桌面发图 → 上传为 AstrBot attachment 再进对话。
- **音频（点歌）**：`点歌 晴天 1` → 云端音乐插件回 `[FILE]xxx.mp3` → 下载落盘 →
  WS `agent_audio` → 对话页 `<audio>`（支持 Range 拖动进度）+ 桌宠气泡播放。
- **跨会话记忆**：AstrBot livingmemory 的 `memory_scope_mode` 由 `legacy` 改为 **`user`**，
  并迁移 `1070 条`记忆到 `livingmemory:user:webchat:xiao1`（含微信侧 814 条）。
  验证：在桌宠端提问，她答出"凌晨一点多问我睡了没""嫌广州三十度冷"等微信侧内容。
- **对话历史落库**：`cloud_feiyu` 直通分支此前**从不写本地消息表**，导致刷新即丢；
  现写入 `desktop_pet` 会话，历史接口回传正文 + 附件 URL。

### 关键修复（每一条都有实机证据）

| 问题 | 根因 |
|---|---|
| 气泡满屏英文思考 | AstrBot 的思考帧是 `plain` 但带 `chain_type:"reasoning"`，被当正文推了 |
| 气泡里出现"我的提问" | 每轮注入的设备上下文前缀被她复述 → 出气泡前剥掉 |
| 偶发回一段裸 JSON | 工具调用轮次的 `complete.data` 是原始工具载荷 → 后端 + 前端双层剥离 |
| 对话界面图片一闪就没 | ① HTTP `attachments` 未回填 url ② WS 订阅只在发送窗口期存在 ③ 本地缓存重建列表时丢了附件 |
| 刷新后图片整条消失 | 落库只存 `{kind,name}`、**没存 url**；历史接口也不返回附件 |
| 同一张表情复制多份 | 去重只在单条消息内生效；承载消息被重建后每帧新建一条 → 改为**全局 url 集合** |
| 图片/回复跑到提问上面 | 消息身份用了 `role+text`（「发个表情包」重复 22 次）；且 `sortByTime` 只在读缓存时调用 |
| 气泡 3 秒不消失 | `stopSpeech` 把 3 秒重置成 `settings.bubble_seconds`（默认 9 秒） |
| 图文只显示图 | CSS `.image-mode span{display:none}` 把文字藏了；`fallbackText` 传进来却没用 |
| 徽标颜色永不变化 | 身份色写成 `background: … !important`，把 12 态状态色全盖掉 |
| 设置随机保存失败 500 | Windows `os.replace` 被 `PermissionError WinError 32` 打断；写入 `.tmp` 那步也没重试 |
| 日志明文泄露 API Key | 每轮对话 `logger.warning("[DEBUG] feiyu api_key: …")`，已删除该行 |

### 安全

- `.gitignore` 增补：一次性探针脚本、抓包配置样本（**含真实 key / Cookie**）、浏览器截图、`pet-data/`。
- 清理工作区 **119 个**调试废料（30 个根目录探测脚本 + 31 个 Playwright 探针 + 17 个 backend 脚本 +
  截图 + `old_chat_page.vue`），清理前已确认**无一进入过 git 历史**。
- `test_feiyu_client.py` 里硬编码的 ASTRBOT key 改为从环境变量读取。
- **建议轮换 ASTRBOT API Key**：它曾以明文反复写入后端日志。

### 测试

- 前端 `npm test` 114 条全绿（新增图片去重、消息排序、气泡图文并存等回归守卫）。
- 新增 3 个守卫测试专门防复发：
  - 所有 `messages` 写入必须经过 `setMessages()`（禁止直接赋值）
  - 消息身份只能按 `id`（禁止 `role+text`）
  - 工具 JSON 必须在前后端各剥一次

### 10-23 后续（发布日并入 v1.2.0）

- **多会话徽标**：每个在跑的 DSH 会话一枚独立徽标，纵向排列、显示工作区名；同工作区多会话加短号区分；完成态徽标 10 秒自动消失。
- **多会话并发仲裁**：两个会话都在跑时按「事件时间」选谁；会话全部平级（取消主/子分层），子会话不再当作独立插件（`is_sub` 标记，rail 过滤）。
- **插件市场回归测试入仓库**：`澪Agent应用/tests/market/run-all.cjs` 一键全跑（真浏览器 160+ 项），克隆即可执行。
- **安全脱敏**：云端 AstrBot 服务器 IP 从源码默认值、测试脚本、`.env.example`、3 份 docs 共 7 处清除；`ASTRBOT_BASE_URL` 改为必填环境变量（缺任一配置则功能明确报 502，不静默打不通）。

---

## 未发布（2026-10-20）· **拖拽回弹修复 + 上下文占用可见化**

- **★ 修「桌宠拖到别的位置，过一会自动回到默认位置」（2026-10-20 用户报障）**
  根因是 B2 workArea clamp 接入时引入的**未声明变量解构赋值**：
  `finishPointerInteraction()` 里写成 `;({ x: nextX, y: nextY } = clampPositionToWorkarea(...))`，
  外层作用域根本没有 `nextX/nextY`，严格模式下抛 `ReferenceError: nextX is not defined`。
  它落在 async 函数里变成一条 unhandled rejection（`desktop-pet.log` 里
  `renderer.console [level=3] Uncaught (in promise) ReferenceError: nextX is not defined`
  可以逐条对上），后果是一串连锁：
  ① `settings.position_x/y` 没更新；② `PATCH /api/companion/position` 从未发出（位置没存盘）；
  ③ `sendSocket('dragged')` 没发；④ 拖拽惯性整段被跳过。
  而拖动过程中 `model.x/y` 已经实时改过 ⇒ 视觉上"已经拖过去了"，等下一轮 `pollStatus`（5s）
  的 `fitModel()` 按 `settings` 里**没更新的旧位置**重算 ⇒ 表现为"过一会自动回到默认位置"。
  - 修法：改用局部 `const next = clampPositionToWorkarea(...)`，与 B2 之前的语义逐字等价。
  - 同类的 `fitModel()` 那处 `;({ x: posX, y: posY } = ...)` **不是** bug（`posX/posY` 是 `let` 声明的局部变量），
    已复核保留。
- **★ 上下文占用改为「独立常挂小球」（2026-10-20 用户二次裁决）**
  第一版是 chip **内部**的文字药丸，用户实测后反馈两点：**太占位置**、**一直在闪**。改为：
  状态 chip 右侧一颗独立圆球（`#agent-badge` 是 flex，小球作 chip 的**兄弟节点**，`gap:4px` 隔开），
  环形进度用 `conic-gradient` 画，占位恒定 24px —— 百分比变化只改环的角度，**盒模型完全不变**，
  因此不会抖动/闪烁；数字用 `font-variant-numeric: tabular-nums` 防字宽跳变。
  - **刻意零动画**：删掉了第一版的 `ctx-meter-pulse` 脉冲（用户明确要求"不要一直闪"），只靠颜色分档：
    青绿（宽裕）/ 琥珀 ≥45% / 珊瑚红 ≥70%。
  - 数值缺失（老宿主无投影服务）时整个球不渲染，保持旧观感；多 agent 时取当前最大值。
  - 开关沿用右键菜单「隐藏/显示上下文占用」（`mio_ctx_meter_enabled`）。
  - 可视化验收：用 Edge headless 渲染真实 CSS 变量出图确认（15/32/48/71/93 五档占位完全一致）。
- **★ 插件端 A2 代码此前从未安装到本机 DSH（本轮一并修掉）**
  排查发现 `~/.dsh/profiles/desktop/node_modules/dsh-live2d-mao` 的副本 `lib/events.js` 里
  `ctx_pressure` / `summarizeContextPressure` **一次都不出现** —— 2026-10-19 的 A2 改动只进了仓库，
  从未装进 DSH，所以无论渲染端怎么改都拿不到数值。已同步 `lib/events.js`（+25 行）
  与 `lib/index.js`（投影服务惰性 getter），并逐文件 SHA256 与仓库比对一致。
  实测确认链路打通：诊断日志 `hasCtxGet=function svc=OBJ stateOf=function`，总线 `ctx_pressure=15 plugin_owned=True`。
  诊断探针与临时中间件**已全部移除**（`_projdiag.log` 已删，`main.py` 已还原到零 diff）。
  ⚠ 这是本机直装，未发 npm；下次 `dsh plugin update` 会覆盖回旧版，正式发版需走
  `docs/SKILL-发布与版本迭代.md` 升版本号（1.1.0 → 1.1.1）。
- **★ 上下文小球三修：小一点 + 透明玻璃 + 修「工作状态变化时偶发丢失」（2026-10-20 用户三次反馈）**
  - **丢失根因（三条独立路径，都已修）**：小球原先挂在 `#agent-badge` 里由 `renderAgentBadge()` 重建，
    而该函数会在下列情况整条清空/隐藏，球就跟着没了：
    ① `status === 'offline'` 直接 `return` —— 网络抖动、后端 30s 心跳超时（`HEARTBEAT_TIMEOUT_MS`）、
       WS 重连窗口都可能瞬间命中；
    ② `renderAgentBadge()` 开头 `badge.replaceChildren()` 全量重建；
    ③ **`applyAgentStatus()` 重建 state 时没继承 `ctx_pressure`** —— 任何一次 `agent_status`
       广播（上线/离线/启停）都会把已有数值抹掉。
  - **修法：彻底解耦**。小球改为 body 下独立节点 `#ctx-orb`，只由新函数 `renderCtxOrb()` 更新；
    位置由 `updateCtxOrbPosition()` 贴徽标右缘计算（`position:fixed`），徽标移动时同步跟随。
    另外三处兜底：`lastCtxPct` 记住最后一次数值（瞬时空值不清球）、
    `lastCtxOrbPos` 记住最后位置（徽标宽高为 0 时不跳回左上角）、
    `applyAgentStatus` 补上 `ctx_pressure` 继承。
  - **视觉**：24px → **20px**；实心色块改**透明玻璃**（半透明 conic 环 + `backdrop-filter: blur(7px)` +
    内高光 + 细描边，整体 `opacity: .72`）；球心数字移除（20px 放三位数必糊），精确值走 tooltip
    与 `aria-label`。仍然**零 animation**。
  - **验收**：Edge headless 跑真实 DOM 场景测试全绿 —— offline+chip 清空时节点保留、
    连续 20 次状态变化后仍只有一个球、徽标空时位置不跳、47% 正确进琥珀档。
- **★ 球心加回上下文数字（2026-10-20 用户四修要求）**
  上一版为压尺寸把数字删了，用户要求"小球里面应该要有上下文数字"。现在：
  - 尺寸 20px → **26px**（20px 放不下三位数，必糊；26px 仍属"小"），玻璃质感保留
    （`opacity` .72 → .82、球心加一层 46% 深色径向底，保证数字压在环上也读得清）；
  - 球心显示 `15%`：两位数 10px、三位数 8.5px 自动收字号（`data-long`），
    `tabular-nums` 保证 9% → 10% 字宽不变；
  - 数字 `z-index:1` 压在 `::after` 高光之上，加四向 `text-shadow` 深色晕，
    浅色壁纸 / 浅色环上都可读；
  - 精确值仍同步到 `title` 与 `aria-label`。
  - 验收：Edge headless 真实 DOM 测试 —— `15%` / `7%` / `100%`（三位数正确打 `data-long` 收字号）/
    切回 `93%` 时标记正确清除、`aria-label` 同步、始终只有 1 个球节点。
- 缓存戳：`live2d-pet.js` / `live2d-pet.css` → `?v=20261020-orbnum`（index.html 两处 + main.js loadURL 一处）。

---

## 未发布（2026-10-19）· **A2 上下文压力全链路 + 陈旧测试修复**

- **A2 上下文压力接通**（后续开发方向 A1/A2 里最后一块）：插件 connector 惰性读宿主
  `sessionProjections` 的 `contextPressure` 投影，state 附带整数 `ctx_pressure`
  （后端白名单 `ingest.py` 原已放行 int；服务缺失/未注册/抛异常三重兜底不伤主链路）；
  桌宠徽标 chip 的 tooltip 显示「上下文 N%」（hover 可见，不占横条文字），
  `applyAgentPhase` 与全量快照两条路径都落值，拿不到继承旧值防 tooltip 忽有忽无。
  缓存戳 `live2d-pet.js?v=20261019-ctx1`（index.html + main.js 两处）。
- **陈旧测试修复**：`src/integratedLayout.test.js:72` 断言的 `workspace-title-switch` /
  `window-controls` 是 pywebview 时代的标题栏结构（窗口三键已按用户裁决移除，
  见 `integrated.css:58` 注释），按现行设计重写断言（shell-toggle 的 v-if、
  设置视图拖拽区单列、window-controls 禁止回流）——`npm test` 83/84 → **84/84**。
- **插件测试 +3**：push.test.js 覆盖 ctx_pressure 的整数化 / 惰性 getter / 异常兜底，
  插件全量 220 → **223**/223。
- **文档同步**：AGENTS.md 三处旧包名 `mao-pet` → `dsh-live2d-mao`（调查时修）；
  后续开发方向.md A1/A2 转完成留档；SKILL-发布与版本迭代.md 门禁计数 220 → 223。

---

## v1.1.0（2026-10-19）· **工作状态驱动动作/表情：四条断链修复 + 活人感 + 个性化页**

> 现象：DSH 的 phase 明明在变（徽标实时刷新），桌宠本体既不换表情、也没有对应动作。
> 调查结论是**四层独立断点叠加**，逐层修掉（只改渲染端 + 模型清单，后端零改动）。

### ① 前置根因：Electron 下发内置模型时把能力清单清空了 ★
- `main.js` 的 `modelCatalog()` 扫 `dist/live2d-pet/models` 发现内置模型时，`capabilities` 一律给 `{}`；
  渲染端 `mergeImportedModels()` 早先**无脑覆盖** ⇒ `builtInModels` 里写死的动作组/表情表/槽位表
  在 Electron 运行时全部失效（`semanticMotion` 恒返空、`expressionForEmotion` 因 `names=[]`
  连**用户配好的表情槽**都校验不过）。
- 规则改为：内置模型以渲染端清单为准（主进程只提供 URL/来源），导入模型仍以 `mio-model.json` 为准。
- 单独取证：`mio-desktop:get-state` 返回的 `models` 就是 `modelCatalog()`，内置项 `capabilities` 为空对象。

### ② 表情：phase 链路根本不存在
- `applyAgentPhase()` 只改 `currentActivity` + 动作，**从不调用 `applyEmotion`**；DSH 的
  `phase_for_facts()` 也不透传 emotion。新增 `PHASE_EMOTION`（planning/thinking/executing_tool→serious、
  streaming/waiting_input→gentle、awaiting_approval/error→concerned、complete→cheerful），
  只在**相位真的变化**时打一次（4.2s），`voice` 期间跳过（避免抢说话链路的表情）。

### ③ 动作：解析结果恒等于 idle
- whale-deepseek 的 `motionSlots` 把 think/observe/attention 全指向 `idle` ⇒ 4 种工作态长得一样。
  按 manifest 语义重分配：think→`bubble`（吹泡泡）、observe→`ketchup`（挤番茄酱）、attention→`openLid`（开盖）；
  `mio-model.json` 同步。
- 新增判据：**解析结果等于待机动作时不播 motion**（播 idle 等于没播），改走程序化动作 ——
  官方模型（hiyori/mao/mark/rice/wanko 只有 Idle/TapBody）因此也重新有了可见动作。
- 去抖改为相位感知：相位变化时 `force` 允许打断（1.2s / 同组 3.5s 门限不再是"吞动作"的黑洞），
  同相位 2s 重发一律不重播。

### ④ 参数写入时序：ticker(-50) 写参数会被每帧回滚
- 库的每帧顺序是 `motionManager.update → saveParameters → 表情/眨眼/视线/呼吸/物理 → coreModel.update
  → loadParameters`。在 ticker 里写的参数要么被 motion 按权重覆盖，要么被 `saveParameters` 吞进
  下一帧基线（`addParameter` 型会跨帧累积到参数钳位）。
- 参数写入统一收进 `applyFrameParameters()`，由 `internalModel.on('beforeModelUpdate')` 驱动
  （模型加载时 `bindFrameParameterHook()` 重挂）；钩子挂不上时退回 ticker 兜底。

### 第二轮（同日，用户指定）：表现绑定可配置化
- **完成→开心槽 / 出错→担心槽**：`PHASE_MOTION_SLOT` 补 `complete: 'cheerful'`、`error: 'concerned'`，
  表情侧同步 `complete/error → cheerful/concerned`（原来这两个状态既不播动作也不换表情）。
- **点击桌宠→害羞槽**：由 `touch 动作 + gentle 情绪` 改为 `shy 槽`（表情 + 动作）；
  socket 的 `clicked.emotion` 一并改成 `shy`，否则后端 `set_pet_activity` 广播的 activity 会在
  3 秒内把害羞表情盖回 gentle。
- **「聆听」拆成独立动作槽**：新增 `listen` 槽（原 `listening` 只能复用 `attention`）。
  `semanticMotion(hint)` 拆成 `motionForSlot(槽名)` + 别名表，相位与情绪都走同一套槽位解析。
- **「警觉」表情槽可绑**：`LIVE2D_EXPRESSION_SLOT_IDS` 补 `alert`，界面表情下拉新增「警觉」。
- **大肥鱼有了可绑的动作**：它没有 `motion3.json`，把 12 个表情登记成 `kind: 'expression'` 的"动作"，
  `playMotion()` 检测到该 kind 就直接播表情（3.8s 后自动回自然脸）。
  界面「动作」区块因此不再对它隐身，`motionSlots` 也按表情重新配了一遍。
- **任务状态可在界面绑定**：新增设置 `live2d_phase_slots`
  （`{模型id: {phase: {motion: 槽名, expression: 槽名}}}`），管理面板新增「任务状态」区块，
  11 个状态各带「动作槽 / 表情槽」两个下拉，选「自动」即用内置默认。
  后端：`CompanionSettingsRequest` 加字段 + `configuration.py` 归一化（词表校验，非法值丢弃）+ 默认配置项。
- **保存白名单补齐**：`App.vue` 的 `companionSettingKeys.pet` 漏了 `live2d_phase_slots`，
  界面上的「任务状态」绑定保存时会被快照过滤掉（选了不生效）。已补上并重建。
- **下拉选项口径修正**：任务状态的「动作」下拉原本列的是**具体动作名**，而渲染端 `motionForSlot()`
  按**槽名**解析 ⇒ 选了会掉进 idle 兜底。改为与「动作」区块一致的槽名下拉（换模型不用重配）；
  同时在解析器里加「精确动作名直通」兜底，手写/老配置直接写动作名也不再被吞。
- **构建**：`npm run build:dist` 重建（trim-pages 被沙箱批量删除守卫拦住，手工移出 3 个被裁页残留后
  `npm run guard` 全绿：A/B/C/D 全 0，mapDeps 自洽）。

**改动文件**：`澪Agent应用/dist/live2d-pet/live2d-pet.js`、`models/whale-deepseek/mio-model.json`、
`dist/live2d-pet/index.html`（`?v=20261019-slots2`）、`src/components/PetAppearancePanel.vue`、
`src/App.vue`（保存白名单）、`src/styles/companion.css`、`live2d-desktop/main.js`（窗载版本号）、
`dist/assets/*`（重建）、`backend/app/companion/configuration.py`、
`backend/app/companion/companion_service.py`、`backend/app/routes/companion.py`。

### 同日追加：活人感 L3 + 皮肤切换修复 + 设置页重组

- **活人感 L3**：台词库升级为 9 场景词表（any/idle/busy/night/lonely/late/dawn/poke/grind），
  大肥鱼台词 48→77 条、默认台词 15→24 条；新增**长任务提醒**（同一 phase 卡超 25 分钟说一句，
  `since` 计时在三条更新路径上保持粘性）与**连点彩蛋**（3 秒内戳 3 次→嫌弃、6 次→装死 60 秒，
  `pet_poke_enabled` 开关端到端接通）。
- **皮肤切换修复**：切换气泡/横条皮肤后 UI 不动的两层根因——缓存戳漏 bump + 旧版
  `pet-bubble-styles.setStyle()` 收到数组抛 TypeError 被共享 `try/catch` 静默吞掉。
  修复为四段独立 try + `console.warn` + 版本握手（`typeof bs.applyTo === 'function'`）。
- **设置页重组**：新增与「主题」并列的**个性化** tab（资料/桌宠/语音/个性化/主题），
  活人感、交互打磨、模型自动更换、逐 token 流式、点击互动、图片素材库、音效事件、音效片段
  八块全部归位；气泡卡片改为注册表 + 分组注入（`CARD_RENDER`/`PART_CARDS`），卡片只写一遍。
- **身份契约测试修正**：插件 e2e 的 agent_id 断言从 `dsh-live2d-mao` 改为 `dsh`
  （v1.0.0「合并身份」后总线身份是 `dsh`，`dsh_adapter._plugin_owns_bus()` 以它为让位判据），
  后端 docstring 同步；e2e 9/11 → 11/11。
- **回归探针**（不进 npm 包，仓库内 `.workbuddy/probes/`）：tab 拆分 19、桌宠页 31、
  皮肤三方契约 10、L3 状态机 21、表情引用 59，共 140 条断言全绿。

**门禁**：插件 220/220 · adapter 201/201 · ingest 63/63 · guard 全绿 · E2E 18/18 ·
`npm pack --dry-run` 25 文件（含 5 截图，无 mock.js/test）。

---

## v1.0.1（2026-10-17）· **市场展示资源**：5 张实拍截图 + screenshots.json

- **市场展示**：新增 `screenshots.json` + `assets/` 5 张实拍截图（桌宠界面展示 / 12 态面板 / 动作表情 / 主题设置 / 模型库），
  供 dsh-market 以 AppStore 风格画廊展示；`files` 清单补 `screenshots.json` + `assets`
- **署名更正**（法律相关）：`whale-deepseek` 模型即 **DS 鲸鱼娘**，作者 B站 **@氵六青**，
  许可 **CC BY-NC-SA 4.0**；角色版权链 **上善无形**（原作 OC「溟月」）→ **ZipZipPipe**（DeepSeek 女仆二创）→ **氵六青**（本模型）。
  `PROVENANCE.md` 同步更正——icon.png 实际由鲸鱼娘待机画面裁切（属「改编」，须按 SA 共享），原写作「大肥鱼立绘」有误
- **README 致谢**：补 A8Chann/dsh-pet-live2d（架构参考 + 模型分发致谢）
- **更新检查修复**：`check_update` 数据源从 PyPI 旧包名 `mio-companion`（从未发布，恒显「未接入」）改为 **npm `dsh-live2d-mao`**
- **GitHub**：推送至 `xkk6663/dsh-live2d-mao`，topics 加 `dsh-plugin`（市场上架硬性要求）

## v1.0.0（2026-10-17）· **DSH 专用化正式版**：插件改名 + 合并身份 + 发布就绪

- **插件更名**：`mao-pet` → `dsh-live2d-mao`（npm 包名 + cordis id + 目录名），显示名 DSH-Live2D-Mao
- **合并身份**：插件推送复用日志边车的 `agent_id="dsh"`，桌宠上只显示一个 DSH（不再有 Mao-pet / DSH 两个徽标抢镜头）
- **发布就绪**：去 `private:true`、补 icon.png / README / PROVENANCE、`files` 精确清单（排除测试 mock transport）
- **交互打磨**：不透明度（Cubism renderer.setModelColor，两轮源码级取证）、锁定位置、SHIFT 拖动、拖拽惯性
- **12 态颜色可自定义**（存后端 settings，管理窗 localStorage 不持久）
- **主题页合并**：原「泡泡」「横条」合并为「主题」
- **审批/提问回传阉割**（用户裁决：DSH 策略 never 用不上，需要审批直接开 DSH 界面）

---

## v4.2.1（2026-10-16）· **形象切换弹回真根因**：IPC 时序差 + 宽限期劫持（二次修复）

**用户报障原文**：
> 菜单切换形象后快速弹回的BUG并未修复，你找到弹回的根因了吗？

v4.2 的一版修复在验证环境 10/10，线上却依旧弹回。用**照抄真实 Electron 时序**的 mock 复测
才暴露第三层根因——**验证 mock 的 IPC 时序与真实主进程不一致**。

### 真根因（接 v4.2 根因①②的最后一层）

主进程在 `ipcMain.handle` 内**同步** `sendModelsChanged()` ⇒ `models-changed` 广播**先于**
`selectModel` 的 invoke 回包到达渲染进程 ⇒ `onModelsChanged` 回调先于 `switchModel` 后续代码
执行，此刻 `settings.live2d_model_id` 还是**旧值** ⇒ 广播回调发起 `loadModel(旧)`。

而 v4.2 一版用 `pendingModelId`（loadModel 发起即记）做切换宽限期判据，被这次「广播加载旧
模型」污染 ⇒ 10s 宽限期**反向劫持**成「10s 内强行锁回旧形象」。真实时序 mock 复现出
`loads=[da-feiyu, da-feiyu, hiyori, hiyori]`（应只有 `[hiyori]`）。

### 修法（`dist/live2d-pet/live2d-pet.js`，`?v=20261016-modelswitch2`）

**状态分离，勿合并**（接替 `pendingModelId`，全文件残留 0）：

1. `modelSwitchTarget/At` —— **用户切换意图**，仅在 `switchModel()` 里赋值，且必须在
   `await selectModel` **之前**（广播回调会先执行）。`applySettings` 的宽限判据改用它；
2. `lastLoad{gen,target,done}` —— 最近一次 loadModel 的**在途状态**，`applySettings` 重载
   判据改用它：大模型（大肥鱼 28MB）加载数秒期间轮询不重复发起；失败置 `done=true`
   保留轮询自愈；
3. `onModelsChanged` 新增守卫：用户切换在飞（<3s）跳过该次加载，消灭旧模型闪现
   （`switchModel` 自己会加载正确目标）。

### 验证

- `verify_gallery_switch.mjs` mock 改为**真实 IPC 时序**（emit 先于 resolve）后 **10/10**，
  内置项加载序列收敛为 `[hiyori]` 单次、导入项 `[biaoqiang-…]` 单次，2 个轮询周期零弹回；
- 回归：`verify_companion_persist` **16/16** · `verify_v42_ui` **7/7**，无 pageerror；
- 服务端 `live2d_model_id` 测试后还原 whale-deepseek。

**教训**（沉淀到工作区纪律）：mock 桥不仅要逐字段照抄主进程的目录构造（v4.2 教训），
还要**逐时序**照抄（emit 先于 resolve）；「宽限期 / 回写」类修复必须把「用户意图」与
「在途副作用」拆成两个独立状态，否则会被广播反向劫持。

### 版本

tag **v4.2.1**；`?v=`：live2d-pet → `20261016-modelswitch2`。

---

## v4.1（2026-10-16）· **Vue 源码回仓 + 构建管线恢复** ★ fork 起点

**主线**：把 `澪Agent应用` 的前端从「手改 minified 产物」拉回**正规工程化**——
恢复 Vue 源码、打通构建管线、把手工阉割改成脚本、补回 19 个提交的业务改动（含小智对话历史）。
这是项目**第一次可以按源码重建前端**，也是 fork 基线。

### 为什么必须做（v4.0 遗留的真实阻塞）

v4.0 的 `dist/assets/*.js` 是**手工改过的 minified 产物**，全仓 `.vue` 文件数为 **0**。
后果：任何前端改动都只能直接编辑压缩代码。M0 阶段就因此踩中一个极具迷惑性的 BUG——
往 `(openBlock(), createBlock('section',...))` 区块里手工插节点，更新走 `patchBlockChildren`
的**索引式 patch**，手改节点与 `dynamicChildren` 对不上 → **被整体跳过**。
症状是「render 函数确实跑了、返回值完全正确、分支判定也对，但 DOM 一个字节都不变」。
**根治法就是本次回仓**：编译器生成的动态节点能被正常 patch，手改 hack 不再需要。

### M1 · 打通构建管线 + G1 判定

- `src`（**108 文件 / 1.02 MB**）自 `eb520213^` 恢复，确认是当前 bundle 的**确切构建源**：
  `package.json` 逐字段吻合（vite 8.2.0 / vue 3.5.40 / plugin-vue 6.0.8 / node≥22.12.0）。
- **G1 判定：有条件通过** —— 新旧产物逐字节比对，**同名 chunk 8/8 = 100% 字节一致**，
  其中 vendor chunk `createLucideIcon`（61.68 kB）字节相同（同一工具链 + 同一源码才可能）；
  连建两次 **26/26 字节一致**。
- **踩坑（已写入流程）**：必须同时恢复 `package-lock.json`，且构建一律用 `npm ci`。
  漏掉时 `npm i` 会自造 lockfile → 传递依赖漂移（差 51 行）→ 分块归属对不上、判定被污染。

### M2 · 19 个提交的业务改动回写

| 批次 | 提交数 | 内容 |
|---|---|---|
| 2.1 小智对话历史 | 6 | `ChatPage` 首载 1000 + 3s 增量轮询、`seenIds`+`seenFp` 双去重、图片附带文本、逐句气泡、WS 只保留状态/音频 |
| 2.2 桌宠模型管理 UI | 8 | 体检页、管理模式、反馈与刷新回传、模型导入/删除/封面/预览、模型切换事件 |
| 2.3 busy 自愈 + emit | 4 | busy 10s 自愈、状态加载 8s 自愈、`select-live2d` 父子事件与模型 PATCH |
| 2.4 反馈文案 | — | App 层单一 `settingsFeedback` 通路，保存中/成功/失败三态 |

**小智对话历史（2.1）要点**：承载方式为「**接管**消息区与输入区」——
新增独立状态（消息表 / 输入框 / 思考态 / session / WS），模板层替换 `context.messageTurns`、
`context.draft`、`context.sending`，**保留**原版外壳（会话抽屉、跟随对话、清理模式、Agent 分支）。
四条去重/过滤规则逐条对齐既有实现：system 重连消息跳过、按 `id` 主去重、
assistant 临时分句与完整历史互为前缀跳过（消除"回复两遍"）、user 文本指纹去重（图片消息不参与）。
音频沿用原样：WS 二进制帧（`uint32` 采样率 + `uint32` 声道 + `float32` PCM 交错）→
独立 `AudioContext` 顺序队列播放。

### M3 · 构建管线加固（★ 本轮补齐最关键一环）

| 脚本 | 职责 |
|---|---|
| `scripts/index.template.html` | `dist/index.html` 模板：14 个手写注入 `<script>` 标签 + `?v=` 原样保留 |
| `scripts/compose-dist.mjs` | 清空 `dist/assets/` → 拷入产物 → 按模板重生成 `index.html`；**绝不触碰**注入层与 `live2d-pet/` |
| `scripts/trim-pages.mjs` | 5 页 + 2 CSS 脚本化阉割 → 重算 `__vite__mapDeps` → 生成 stub → **第二遍孤儿剪枝** |
| `scripts/clean-dist.mjs` | 完整性守卫：补丁备份 / 备份目录 / 无人引用 assets / 悬空引用 / mapDeps 自洽 |

- **`build.outDir: 'dist-build'`（最关键）**：vite 默认 `outDir` 是 `dist` 且构建前清空它，
  而 `dist/` 里住着 **257 个手写注入层文件**（`core-inject` 7 + `kernel` 2 + `plugins` 6 + `live2d-pet` 242）。
  裸跑 `vite build` 会一次性全毁。已设隔离输出 + `emptyOutDir`，实测构建前后 `dist` 278 → 278 不变。
- **`hiyori` 大小写修复**：代码引用 `./models/hiyori/...` 而实际目录名是 `Hiyori`。
  Windows 不敏感所以一直没暴露，**Linux 部署必 404**。修 3 处（`live2d-pet.js:12`、`companion_service.py:147/148`）。

### 工程化收益

- `npm run build:dist` 一条命令完成「构建 → 组装 → 阉割 → 守卫」，接手方可独立重建前端。
- `npm test`（源码单元测试）/ `npm run e2e`（渲染端 E2E）/ `npm run guard`（完整性守卫）。
- 前端门禁：单元测试 **88 项**、`clean-dist` **A/B/C/D 全 0**、后端自检 **184 项**、渲染端 E2E **15 项**。

### 已修复的既有问题

- `live2dExpression.test.js` 导入路径指向**不存在的** `public/live2d-pet/`（实际在 `dist/live2d-pet/`）→ 修正后测试全绿。
- E2E 用例 `[2] 气泡内容被新流替换` 偶发失败 —— **经二分法证明与本轮改动无关**
  （换入 `HEAD` 版渲染端后失败更严重：0/8），属渲染端既有不稳定，**不阻塞本版**。

### 文档

- 新增 `docs/Vue源码回仓可行性评估.md`（回仓可行性 + G1 取证）。
- 新增 `docs/桌宠保存反馈BUG-诊断与决策.md`、`docs/项目接管执行方案.md`（接管方案与各里程碑实跑记录）。
- 新增 `docs/M2-2.1-小智对话历史-回写规范.md`（反编译还原的逐项行为规范，供后续对照）。
- `README.md`：目录树补 `src/`、`vite.config.js`、`scripts/`；**新增「前端开发与构建」章节**
  （dist 双成分说明、构建四步、注入层改动纪律）。
- `SRC-MAP-源码地图.md`：更新注入脚本路径（迁入 `core-inject/`/`kernel/`/`plugins/`）、
  删已移除的 `xiaozhi-history-panel.js` 条目、新增 §6「手改压缩产物纪律」。

---

## v4.1.1（2026-10-16）· 对话页 / 标题栏 UI 精简（用户裁决）+ M2 缺口补记

### 本轮删改（按用户红框截图逐项落地）

| # | 位置 | 改动 | 依据 |
|---|---|---|---|
| 1 | 对话页输入区 | 删核心「添加图片或文件」回形针 | 红框 |
| 2 | 对话页输入区 | 删「上下文用量环」 | 红框 |
| 3 | 对话页输入区 | 删「模型 / 推理强度」下拉 | 红框 |
| 4 | 对话页输入区 | 删「模型与API设置」齿轮 | 红框 |
| 5 | 对话页内容区 | 删左上角「对话窗口」chip | 截图 2 |
| 6 | 标题栏 | 删「Mio Agent」工作台切换按钮 | 红框 |
| 7 | 标题栏 | 删窗口三键（最小化 / 最大化 / 关闭） | 红框 |

**输入区最终形态**：`小智连接状态（靠左）` + `小智插件 📷` + `发送`。

### 判据（先取证再改，不靠截图猜测）

- **窗口三键本来就是死按钮**：真浏览器实测 `window.pywebview === 'undefined'`；
  `controlDesktopWindow()`（`composables/useDesktopNavigation.js:79-86`）拿不到桥就直接 `return`。
  现壳是「独立 Electron 桌宠 + 浏览器/WebView 管理窗口」，pywebview 桥不存在。
  删掉后标题栏双击仍可最大化（`.window-drag-zone` 的 `dblclick`）。
- **「对话窗口」chip 是浮层**：`.conversation-drawer-trigger { position:absolute; top:10px; left:12px }`
  （`styles/integrated.css:280`）→ 直接压在消息区文字上。删掉后会话抽屉不再有打开入口
  （**用户已裁决**：不需要；抽屉代码保留在源码，随时可挂回）。
- **📷 挪位**：原插件注入用 `order:-1` + `insertBefore(firstChild)` 占输入区最左，
  导致「小智已连接」贴不到左边。改为插到 `.send-button` 之前（`dist/plugins/xiaozhi/chat-inject.js` 的 `ensureBtn`），
  锚点非直接子元素时回落 `appendChild`（避免 `insertBefore` 抛 `NotFoundError`）；
  `dist/index.html` 侧 `?v=` 升到 `20261016-imgbtn-right`（模板 `scripts/index.template.html` 同改）。
- **弹性布局坑**：`.composer-actions > span { flex: 1 }`（`styles/chat.css:997`）会把
  `.xz-link-status` 一并拉成弹性块 → 新增 `.composer-actions > .xz-link-status { flex: 0 0 auto }` 固定靠左。
- **标题栏 grid 收列**：从 `42px 1fr auto 42px auto` 收成 `42px 1fr 42px`，
  同步改 `styles/integrated.css:49/61/563`、媒体查询 `:494`、`styles/agent-workspace.css:11`。
  （只删元素不改列定义的话，`auto` 空列会让右栏开关不再贴边。）

### 验证

- `npm run build:dist`：守卫 **A 0 / B 0 / C 0 / D 0**，E `mapDeps` 自洽（数组 24 项｜调用 9 个｜占位 9 个）。
- 真浏览器（playwright-core 驱动本机 Chrome，1280×800）
  `workspace_patch/verify_chat_ui.mjs` **19 项全过**（含「状态距 composer 左边缘 13px」「右栏开关贴右边缘 1280」）；
  上一轮回归套件 `workspace_patch/verify_ui.mjs` **25 项全过**。
- 截图：`workspace_patch/shots/m5-{chat-page,titlebar,composer,settings-page}.png`。

### M2 缺口补记（上一轮修补，此前未入 CHANGELOG）

M2「19 个提交回写」只回写了 `.vue` 的**逻辑**，**CSS 改动整体丢失**：
旧 `index-CnRrRFJT.css` 有 **71 条**规则在新源码里没有，其中 **50 条仍被模板引用**。
直接表现为上一轮的三个前端 Bug：① 默认页不是桌宠；② 模型 tab 无样式（名称与 id 粘连、切换按钮退化成裸文字）；
③ 桌宠页「内置模型 / 外部导入 / 两个金色 DSH 模型」分组塌陷。

- 补法：`workspace_patch/gen_restore_css.mjs` 从旧构建 CSS 逐条抽取「旧有新无」规则（带 `@media` 上下文、
  剔除死类）→ `src/styles/restored-overrides.css`（50 条），在 `src/main.js` **最后**导入以复现原层叠顺序。
- 默认页迁移：`App.vue` 的 `DEFAULT_APP_PREFERENCES.default_open_page` 由 `home` 改 `companion`，
  并加一次性迁移（`mio_default_open_page_migrated_v41`）——只改默认值对老用户无效（localStorage 已存 `home`）。
- **纪律固化**：凡「回仓 / 回写」类工作，**CSS 与 markup 必须一起核对**，
  方法把旧构建 CSS 按「选择器 → 声明集合」比对，**不能比字符串**（压缩器会重排声明顺序、把 `rgba()` 转 `#hex8`）。
- **纪律固化**：改前端一律改 `src/`，`npm run build:dist` 重建；不再手改 `dist/assets/*`。

---

## v4.1.2（2026-10-16）· **「设置保存后失效」三层根因**（桌宠页 / 观察页 / 表情）

**用户报障原文**：
> 桌宠和观察的功能实际上不可用，我调整里面的选项后，再次打开恢复默认值，桌宠也是，调完表情点击保存后再次打开还是空的。

后端全程**无责**：`GET /api/companion/status` 200/0.4s，`pet.settings` 65 键齐全，
`PATCH /settings`、`PATCH /size` 均 200 且落盘 `数据/桌宠/设置.json`。
三个症状是**前端的三个独立缺陷叠加**，逐个取证分离如下。

### 根因 ① 桌宠页**永不水合** → 服务端配置被硬编码默认值永久固化

- **现象**：打开桌宠页，桌宠大小永远显示 `150`（App 里的硬编码默认），而服务端存的是 `80/83`。
- **机制**：`App.vue` 的 `companionStatus` 初始值是**硬编码的**（`pet_size_percent:150` 等）；
  而 `loadCompanionStatus({ preserveSettings: true })` 的语义是「保留本地草稿、服务端值不覆盖」。
  默认页已改为「桌宠」⇒ `watch(activeView)` **不为初始值触发** ⇒ 页面上唯一的加载器就是
  **3s 轮询**那条带 `preserveSettings` 的路径 ⇒ 默认值被当成「用户正在编辑的草稿」，
  一次次盖回服务端数据 —— 于是改了保存、重开还是默认值。
- **铁证**（`workspace_patch/probe_companion_save.mjs`）：`PATCH /size` 设 205 **成功后**，
  3 个并发的 `GET /status` 仍返回 `pet_size_percent:80`；而 `PATCH /settings` 正确发出了 `205`。
  → 是**前端状态被旧默认值固化**，不是后端没存。
- **修法**：`useCompanion.js` 的 `loadCompanionStatus` 给 preserve 加门禁
  `const canPreserve = preserveSettings && deps.companionStatusReady.value && editingSettings`
  （只有**成功水合过一次之后**才允许保留草稿）；同时 `App.vue` 启动时**无条件水合一次**
  （原先只在 `activeView === 'home'` 时加载）。

### 根因 ② 观察页三处独立缺陷

- **2a 改了从不保存**：模板里「间隔(分)」的 `<select>` **漏了 `@change="saveObserve"`** ——
  纯 UI 状态，永远没进过后端。
- **2b 回读静默回默认**：旧回读逻辑要求 `(min,max)` **精确等于**三个预设配对之一；
  服务端实际存成 `(1800,2000)` 这种非配对值 ⇒ 三个分支全不命中 ⇒ `observe.range`
  静默保持默认 `'5-15'`。
  修法：抽出 `OBSERVE_RANGES` 单一真相 + `matchObserveRange(min)`，**只按 `min` 匹配**
  （`min` 是三预设的区分因子），非精确值按最近邻兜底。
- **2c 加载失败把开关刷成默认**：`loadXiaozhiStatus` 用 `.catch(() => ({ enabled: false }))`
  把请求失败当成「服务端说关闭」⇒ 一次网络抖动就把用户的开关抹平。
  修法：`.catch(() => null)` + 保留上次值，仅在有回执时才写状态。
- 另外 `saveObserve` 改为**用服务端回执回填**（`enabled` / `min_seconds`），保证
  「界面上看到的 = 服务端存的」。

### 根因 ③ 改「桌宠大小」会冲掉**尚未保存**的表情编辑 ★

- **现象**：调完 6 个表情槽 → 点保存 → 重开仍是空的。
- **机制**：`PetAppearancePanel` 是**直接 `v-model` 到 store 的 `pet.settings` 对象**上的
  （动作/表情槽位、三个开关、桌宠大小都写在同一个对象里）。而「桌宠大小」是
  `@change` **立即** `PATCH /size` 并把响应**整体替换** `companionStatus` —— 服务端响应带回的是
  **旧 settings 副本**，于是刚填的表情被一起冲掉。之后再点保存，服务端存到的仍是旧值。
  用户操作顺序「调表情 → 顺手拖一下大小 → 点保存」正好命中，观感就是「保存了但重开还是空的」。
- **铁证**（`workspace_patch/probe_expr_save.mjs` vs `verify_companion_persist.mjs` 的差异）：
  表情改动**单独走保存能落盘**（`cheerful: 02 龇牙 → 01 口型切换` 持久化成功，PATCH body 43 键）；
  但只要流程里**先拖了大小滑块**，服务端就存不到新表情。
- **修法**：新增 `assignStatus(next, { preserveSettings, editing, serverKeys })` 作为
  **整体替换 `companionStatus` 的唯一入口**：
  - `editing`：`saveCompanionSize` **在请求发出前**捕获草稿对象，响应回来后用草稿覆盖 `next.pet.settings`；
  - `serverKeys`：`saveCompanionSettings` 等「保存某个分组」的场景，**只让本次提交的键以服务端回执为准**
    （这样才能反映后端白名单过滤与它自动维护的 `live2d_model_id`），**未提交分组的草稿保留**——
    避免「保存桌宠分组」顺手清掉「观察分组」里刚改还没保存的选项；
  - 顺带把 `controlCompanion`（启动/停止/重启）、`uploadVoiceReference`、音色包导入、换精灵图
    四处裸替换一并收敛（仅换精灵图改顶层 `pet.sprite_version`，不动 settings）。
- 另将 `saveCompanionSettings` 中「桌宠状态尚未加载完成就点保存」的**静默 return** 改为显式错误提示
  （原来点保存毫无反应，极易被误判为「保存了但不生效」）。

### 验证（真浏览器，playwright-core 驱动本机 Chrome）

- `npm run build:dist`：守卫 **A 0 / B 0 / C 0 / D 0**，入口 `assets/index-BK_-Fz8x.js`。
- 新增 `workspace_patch/verify_companion_persist.mjs`（16 项）**全过**：
  - 冷启即显示**服务端**大小 83（不再是默认 150）、「始终置顶」为服务端值、表情下拉已回填 6 个；
  - 保存后服务端写入新大小 190 与新表情 `01 口型切换`；**重载后**大小仍是 190、表情仍是新值、下拉非空；
  - 观察「间隔」回填按 `min` 匹配（`10-30` ↔ serverMin 600）、改 `5-15` 真正写入 `[300,900]`、
    开关 `true → false` 持久化、**重载后两者都保持**；
  - 脚本自还原，不留脏数据。
- 回归：`verify_chat_ui.mjs` **19/19**、`verify_ui.mjs` **25/25**。
- 已知遗留（非本轮引入，旧 bundle 同样存在）：`/api/companion/chat-settings`、
  `/api/companion/startup-greeting`、`/api/companion/qq-startup` 三个端点 **404**。

---

## v4.2（2026-10-16）· **桌宠形象切换持久化** + 体检页接管提速 + 右侧栏收起态

### 1 · 右键菜单「更换形象」切换后被弹回（桌宠主体，`dist/live2d-pet/live2d-pet.js`）

**用户报障原文**：
> 右键桌宠打开菜单里面的快速切换形象不可用，切换目标形象后又快速变回原来的桌宠形象了。

后端无责（`PATCH /api/companion/settings` 对 `live2d_model_id` 落盘正常，实测回读一致）。
根因是**前端两处叠加**，调用栈实证（hook `PIXI.live2d.Live2DModel.from`）：

- **根因 ①** `mergeImportedModels()` 把主进程目录里**所有**模型（含 `source:'built_in'` 的内置模型）
  都写死 `source:'imported'` ⇒ `switchModel()` 的内置分支（`selectModel('')` + **PATCH 服务端**）
  **永远走不到**，任何切换都只写 Electron 主进程的 runtime state（`selectedModelId`），服务端
  `live2d_model_id` 保持旧值；
- **根因 ②** `applySettings()` 见到 settings 里带 `live2d_model_id` 就清空桌面侧覆盖
  `desktopSelectedModelId` ⇒ 而每 5s 的 `pollStatus()` 都带这个键 ⇒ 切换后最多 5s 就被
  轮询打回服务端旧值，表现为「切过去 → 很快变回去」。

**修法**（均在 `dist/live2d-pet/live2d-pet.js`）：
1. `switchModel()` **统一写穿服务端**：内置形象清桌面覆盖、导入形象设覆盖，随后一律
   `PATCH /api/companion/settings`（`live2d_model_id` 是当前形象的唯一持久真相）；
2. `mergeImportedModels()` 尊重 `entry.source === 'built_in'`；`selectedModelId` 尊重**显式空串**
   （原 `||` 粘住旧覆盖值）；
3. 新增 `pendingModelId`/`pendingModelIdAt`（loadModel **发起即记**，不等加载完成）：
   - `applySettings` 的重载判据加 `pendingModelId !== nextModel`——大模型（大肥鱼 8192/28MB）
     加载要数秒，只看 `currentModelId` 会让每次 5s 轮询都误判"还没切过去"而反复重载；
   - **切换宽限期（10s）**：PATCH 之前已在途的旧 `/status` 响应会把 `live2d_model_id` 盖回旧值
     （调用栈实证：`loadModel(旧) ← applySettings ← pollStatus`），宽限期内强行以本地目标为准；
   - 加载失败清空 `pendingModelId`，轮询仍会重试（保留原有失败自愈）；
4. `switchModel` 末尾的 `loadModel` 去重（`onModelsChanged` 广播已发起同目标加载就不再加载，
   28MB 大模型的重复解析省一半）。

**验证** `workspace_patch/verify_gallery_switch.mjs`（10 项）**10/10**：内置（hiyori）与导入
（biaoqiang）两条路径都断言「PATCH 发出 + 服务端落盘 + 2 个轮询周期内零异模型加载」；
切换后加载序列干净（各 1 次）。跑完自还原。
⚠ 取证过程中的重要教训：验证用的 mock 桥拼模型 URL 时写成了 `./models/ + model_path`
（`model_path` 本身已带 `models/` 前缀）⇒ 子资源 404 ⇒ 所有加载 "Network error" ⇒
`pendingModelId` 被清空 ⇒ 出现一整批**假象**。真实 Electron 主进程拼的是 `./models/<目录>/<文件>`。
**mock 必须逐字段照抄主进程的目录构造**，否则整条验证链路都被污染。

### 2 · 进「体检」页闪现旧版体检 UI（`src/components/CompanionPage.vue` + `dist/core-inject/health-panel-inject.js`）

旧 Vue 壳渲染完整体检 UI（设备/小智连接/版本行），注入层接管后再整体替换 `innerHTML`
——接管前的取数周期（几百 ms）里旧 UI 裸露，且旧模板动态绑定会让 Vue 在 innerHTML 被
替换后仍试图 patch 已不存在的节点。
**修法**：① Vue 只渲染**空壳 + 「体检加载中…」占位**，删除 `loadHealth`/`testSystemAudio`/
`testWebAudio`/`health`/`healthMessage` 死代码与 `Volume2` 导入（正式 UI 一直由注入层承载）；
② 注入层 `takeOver()` **先用缓存数据同步渲染一次**再异步刷新（render 对空数据全字段兜底），
消灭裸露窗口。`?v=` → `20261016-health`。
**验证** `workspace_patch/verify_v42_ui.mjs`（7 项）**7/7**：切走切回体检 72 次高频采样，
旧版标记（`health-banner`/`health-device`/旧副标题等**旧壳独有**项）出现 **0 次**；
注入版标记（`data-hp-msg`）始终在。产物中 `体检读取失败`/`healthMessage` 残留 **0**。

### 3 · 右侧栏收起态首行（`dist/core-inject/rail-switch-inject.js`）

**用户原话**：右侧栏收起状态时第一行删掉图片符号，直接显示 agent 就行。
原首行是 lucide **image 图标**（`ICON_AGENT`：rect+圆+山形，看起来像图片）+ 状态点 + 箭头。
**修法**：删 `ICON_AGENT`，收起态改显 `Agent` 文本标签（`.mio-rail-agentlabel`，accent 色、
仅收起态显示）；展开态仍是「Agent 工具」。`?v=` → `20261016-rail`。

### 4 · 构建守卫降噪（`scripts/clean-dist.mjs`）

`D'` 每次构建都误报 `live2d-pet/expressions/love.exp3.json` 悬空——实际该引用相对
**模型目录**（真实位置 `live2d-pet/models/whale-deepseek/expressions/`，HTTP 200）。
新增 `D''` 类：`live2d-pet/` 下悬空引用若能在 `live2d-pet/models/*/` 同名相对路径命中，
按「模型目录清单」解析，不再计入。现 `D' = 0`。

### 5 · 需求登记（用户 idea，随 M6/M7 DSH 插件线做）

桌宠「可拖动、可关闭横条」复用为 **DSH 下发的流式提示窗口**（与说话气泡互斥、
支持泡泡界面自定义主题/颜色，工作量在 DSH 插件内）——已登记
`docs/项目接管执行方案.md` §18（M7 新增条目 7.6）。

### 门禁与回归

| 项 | 结果 |
|---|---|
| `npm run build:dist` 守卫 | A 0 / B 0 / C 0 / D 0，D' 0，D''（模型相对路径解析）1，mapDeps 自洽；入口 `assets/index-CaMCoE3e.js` |
| `verify_gallery_switch.mjs`（新，10 项） | **10/10** |
| `verify_v42_ui.mjs`（新，7 项） | **7/7** |
| 回归 `verify_companion_persist.mjs` | **16/16** |
| 回归 `verify_chat_ui.mjs` | **19/19** |
| 回归 `verify_ui.mjs` | **25/25** |

### 仓库整理

- `workspace_patch/` 一次性诊断脚本归档至 `workspace_patch/archive/`（git-ignored，不影响仓库）；
  保留 5 个回归验证脚本 + 2 个取证探针（CHANGELOG 引用其路径）。
- `发布/` 三个旧 zip（v1/v2/v3）维持 §3.3 决定：不随仓库提交。
- README 对齐：版本徽章 → v4.2；「开发守则」更新为「改 `src/` + `npm run build:dist`」
  （删除过时的「dist 即源码」表述与「改完必 git commit」）。

---

## v4.0（2026-10-15）· A 档收口：泡泡/音效能力归主体 + **M1 逐 token 流式**

**主线**：按《DSH桌宠深度融合技术方案》A 组（桌宠渲染层增强）补完最后一档——
点击互动收敛、音效素材管理整套、**逐 token 流式**；同时把"泡泡"从插件名下收回桌宠主体，
并做一次仓库清理与文档对齐。这是 M1 完成后的第一个大版本。

### M1 逐 token 流式（新增能力，独立链路）

- **边车**（`dsh_log_stream.mjs`）新增 `kind:"stream"`：从 `assistant/message` /
  `assistant/attempt` 的 `data.stream[]` 里抽 `text-chunks` 帧（真逐 token 增量 +
  `dt` 毫秒时基 + `block-end` 权威全文），**只在增量跟随路径发**——附着时的历史重放
  一律不发（否则每次连上桌宠都会把几百条旧正文当实时流刷一遍）。
  去重键 `session:seq`，防日志截断重读时同一段正文回放两次；`dt` 截断到"块数-1"。
- **适配器**（`dsh_adapter.py`）新增 `_publish_stream()`：与 phase 链路**完全解耦**
  （只出气泡，不改 phase、不抢桌宠"身体"）；两道门控——总线 `enabled`、
  以及"会话一致性"（切会话后仍在飞的旧消息直接丢，避免串台）。
- **总线**（`agent_bus_service.stream()`）与 `announce()` 同构：总线不认识任何具体插件，
  只补 `agent_id` / `agent_name` / `accent` 后以 WS `agent_stream` 透传。
- **渲染端**（`live2d-pet.js`）追加式渲染：首块立即上屏、按 `dt` 逐块铺、收尾用权威
  全文校正（**零丢字零重复**），播完按字数停留 3.5~12s 后自动消失。
  三个工程约束：节奏下限 24ms（上游一次性 flush 时也要有"逐块"感，**只垫高不压低**）、
  总时长封顶 30s（防病态日志挂住气泡）、只认 `frame='text-chunks'`
  （**推理草稿进气泡是明确越界**，另有渲染端白名单兜底）。
  开关 `live2d_stream_text_enabled`（泡泡页，默认开）。

> **能力边界（必须知道的限制）**：实测 2 个会话、1131 个 stream 事件，`assistant/message`
> **与紧随其后的 `tool/call` 落在同一个 zstd 追加帧**——即日志拿到文本时该消息已生成完毕。
> 所以本版是「**事后按 DSH 原始节奏回放**」，**不是**"边生成边出字"。
> 真·实时增量只能走 Host WS `session/follow`（需凭据 cookie + 临时端口发现）；
> 渲染端消费的同一条 `agent_stream`，将来换源**不需要动前端**。

### 泡泡 / 音效：能力归桌宠主体（架构回归修复）

- **修复真实回归**：停用小智插件后桌宠说话气泡整个消失。根因两处都在"插件越界改核心
  DOM"——`xiaozhi-plugin.js:setXiaozhiUi()` 往核心 `#speech-bubble` /
  `#activity-indicator` 加 `.plugin-off`；`pet-xz-audio.js` 直接持有气泡元素与定时器。
  修法：删掉 `setXiaozhiUi()`，核心暴露唯一入口
  `window.__mioPetBubble = { show, hide, isVisible, setEnabled }`，插件只能经它说话。
  验证：无头浏览器停用小智插件后 dump DOM，断言 `.plugin-off` 计数为 0。
- **点击互动三处收敛**（用户实测反馈）：点击弹出的气泡 **3s 自动消失**（原来一直挂着）；
  空闲自语 6s。
- **点击序列**：点桌宠按「第 1 次 → 第 2 次 → … → 循环」推进；单项支持
  `a|b|c`（等权随机）与 `{image}`（抽图）；未配置时走缺省随机。
- **图片素材库权重**：每张图可设抽取权重，抽中权重与"不连续重复"叠加。

### 音效素材管理整套（A 组音效组）

- **7 类事件**：`press / release / switch / task_end / ask / approval / error`，
  每类独立 `{enabled, volume, clip}`；未绑片段走**现场合成音**（零素材依赖）。
- **片段库 + 波形裁剪**：上传（≤10MB）/ 删除 / 试听；裁剪走
  `decodeAudioData → OfflineAudioContext → 手写 WAV 编码 → 上传`，
  **纯前端不引入 ffmpeg**；原片段保留。
- **格式要求前置说明**（用户要求）：白名单对齐**浏览器解码能力**
  （`wav/mp3/ogg/opus/m4a/aac/flac/webm`），并明确不支持 WMA/APE/AMR/AIFF/MIDI；
  上传前预校验 + 报错文案直接指向"转 WAV/MP3"。

### 仓库清理与 .gitignore

- **移走调试残留**：`pet-data/` 根目录 23 项中间产物（抓页快照 `srv_*` / `dom_check.html`、
  状态转储 `status*.json`、水印试验 `wm_diff*` `feiyu_*`、3 个 Edge 浏览器剖面 `.edge-prof*`）
  → 移到 `.workbuddy/_cleanup_2026-10-15/`（**可还原，未硬删**）。
- **.gitignore 三处修正**：
  1. 删掉一行编码损坏的规则（`私人AI日记系统/backend/????????`，实际无命中、会误伤 8 字符名文件）；
  2. **放宽浏览器剖面规则**：旧规则 `pet-data/.edge-prof*` 只匹配 `prof` 前缀，而实际目录名会变成
     `.edge-pA` / `.edge-pB` …（并发调试各开一个剖面）→ 改成 `pet-data/.edge-*/`。
     修正前 `git status` 挂着 **3232 个** Edge 缓存文件，修正后归零；
  3. **删掉 `**/dist/assets/`（含子目录同名规则）**：这条规则与实际跟踪状态**自相矛盾**——
     `dist/index.html` 以 hash 文件名引用 `assets/` 里的 bundle，两者必须同仓，否则新克隆白屏。
     规则留着只会让人误以为 assets 不入库，前端重建产出新 hash 时被静默忽略。
     现已改为"dist 整体入库"，把这个坑从根上拆掉（原 v4.0 草稿里的"遗留提示"随之作废）。
- **发布包移出索引**：`发布/*.zip`（Mao v2 / v3、Mio v1，共 17MB）从 git 索引移除
  （`git rm --cached`，**磁盘文件保留**），并新增 `发布/` 忽略规则。
  理由：`打包发布.ps1` 的输出目录就是这里，出一版 +6MB，源码仓库不该存二进制；
  历史版本仍可从 git 历史取回（`git log -- 发布/`）。
- **E2E harness 入库**：M1 的渲染端 E2E 原在 `.workbuddy/`（该目录按约定不入库），
  导致新克隆复跑不了这套验证 → 落到 `澪Agent应用/tests/e2e_stream_pet.cjs`，
  并把 `PET_CHROME` / `PET_BASE_URL` 提成环境变量（不再硬编码本机路径）。
  已在仓库内新位置**实跑 15 通过 / 0 失败**。
- **库文件入库审计**：Live2D 模型（217 个，含 `Haru.moc3` 等）、`libs/` 三件套
  （`pixi.min.js` / `live2dcubismcore.min.js` / `cubism4.min.js`）、`requirements.txt`
  均**未被忽略**，可正常入库（`**/models/*` 的 `!` 例外生效）。
  另查：`__pycache__` / `*.pyc` / `*.log` / `*.db` 在跟踪清单里计数为 **0**，无中间产物入库。
- **dist 上游阉割残留清理**：前端 Vue 源码不在本仓，`dist` 由外部源码树构建后拷入，
  上游页面被裁掉后留下了补丁备份、改名遗留的旧 hash chunk、以及入口 bundle 里对已删
  chunk 的悬空引用（触发时后端 SPA 兜底返回 index.html → `import()` 报 MIME 错）。
  清理后以 `_trimmed-stub.js/.css` 占位，**不增删 `__vite__mapDeps` 数组元素**（保持
  27 项与全部下标，避免静默串位）。实测 `?workspace=agent` 路径 MIME 错误 10 → 0、
  页面错误 15 → 5、渲染正文逐字不变。
- **新增守卫 `澪Agent应用/scripts/clean-dist.mjs`**：默认只核查（退出码 1，可当提交门禁），
  `--apply` 把残留移入 `.dist-cleanup-safety-<日期>/`（不硬删）。覆盖五类：补丁备份 /
  备份目录 / 无人引用的 assets / 悬空引用 / **mapDeps 结构自洽**。存在理由：这类残留
  每重新拷一次 dist 就会再来一轮，需要可重复的检查线而不是人肉发现。

### 验证

- **后端自检扩到 184 项**（原 131）：新增 `[9a]` 边车 emit（增量发 / 历史不发 / `dt` 截断 /
  reasoning 不外泄）、`[9b]` 适配器→总线（字段、归属色、跨会话丢弃、空载荷、停用门控、
  畸形载荷容忍）、`[9c]` 前端契约。
  跑法：`python -m app.agents.dsh.dsh_adapter_selftest`（184 通过 / 0 失败）。
- **新增渲染端 E2E 15 项**：`澪Agent应用/tests/e2e_stream_pet.cjs`（Playwright + WS 桩 + mioDesktop 桩），
  覆盖逐块追加采样、节奏、最终校正、新流替换、兜底、frame 白名单、他源接管、自动消失、开关。
  harness 两个必须保留的设计：**每个用例独立新开页面 + 独立就绪门闩**、
  **渲染端静态资源直连磁盘绕开浏览器缓存**（后者踩过坑：同 `?v=` 下改文件仍被缓存，
  连续多次改动都测的是首版代码，表现成"随机失败"）。

### 文档

- `README.md`：版本 v4.0；核心特性新增「泡泡工坊 / 音效系统 / 逐 token 流式」三行；
  新增「桌宠主体能力（泡泡工坊）」展示段；核心设计补第 8/9 条（气泡归主体、流式独立链路）；
  目录结构按插件化后的真实路径重写（`app/kernel/`、`app/agents/dsh/`）；常见问题补 3 条。
- `docs/DSH桌宠深度融合技术方案.md`：升 **v3.0（A 档落地版）**；§3.1 对标表更新 7 项状态；
  新增 §3.3（A 档落地记录 + 为什么不做浮窗模块卡）、§3.4（M1 能力边界与实测证据）、
  §3.5（泡泡曾被挂到插件名下的踩坑回归）；Phase 3 标记完成并附两套复跑命令。

---

## v3.12（2026-10-15）· 泡泡交互重构：浮窗卡撤除 → 点击桌宠触发（复用说话气泡框）

**主线**：按用户实测反馈重构——浮窗模块卡方案推翻（状态栏与徽标重复、随机语句/图片
应该是点击桌宠触发且显示在复用小智的说话气泡框里、浮窗 ✕ 无法点击）。

### 交互重构
- **撤除浮窗模块卡**：pet-bubble-modules.js 整个删除（6 类卡片/拖拽排版/模块库面板），
  ui-bounds 通道（渲染端+主进程）一并回退；「Agent 状态」与头顶徽标重复是直接动因。
- **点击互动**：点桌宠（非拖动）→ 素材库有图 45% 概率出**随机图片**，否则说一句
  **随机语句**（复用空闲自语内容池）——全部显示在**说话气泡框**里（同框/同尾巴/同
  位置；新增 `.image-mode` 图片变体，7s 自动消失）。开关 = `pet_click_talk_enabled`
  （泡泡工坊「点击互动」，默认开）。
- **泡泡工坊页**：模块管理区替换为「点击互动」开关；皮肤 + 素材库不变。
- 空闲自语回退为纯文本轮播（随机图片只由点击触发）。

### 保留
- 穿透修复的有效部分：`reportUiOpen` 纳入图库面板（A7 图库可点击）；
- 素材库上传/删除路由与 `live2d_bubble_style` 皮肤链路。

### 说明
- whale-deepseek 模型的"免费使用/禁止二传"水印是**烙在贴图里的授权水印**
  （无水印消除表达式参数），代码无法去除；用户已确认不处理。

---
## v3.11（2026-10-15）· 泡泡工坊迁入 Mio 管理页 + 穿透根因修复

**主线**：按用户裁决重构泡泡定制的入口——从桌宠右键迁到 **Mio 左侧导航「泡泡」功能页**
（皮肤配色 / 模块管理 / 图片素材库三合一）；同时根治穿透 bug 的**真正根因**
（a10 修复挂在死的事件通路上，本次改为对齐主进程轮询决策）。

### 泡泡工坊（Mio 左侧导航「泡泡」，core-inject/bubble-panel-inject.js）
- **气泡皮肤**：8 款卡点选 → `PATCH live2d_bubble_style` → settings_changed → 桌宠热应用；
- **模块化泡泡**：6 类模块开关 / 文本 / 倒计时目标 / 配色循环 → `PATCH live2d_bubble_modules`
  （扁平 map 形态，渲染端 `normalizeModules` 兼容两种结构）；
- **图片素材库**：上传（data_url ≤5MB、扩展名白名单）/ 预览 / 删除
  （`POST|DELETE /api/companion/bubble-images/...`）；
- 桌宠右键菜单移除「泡泡模块」「泡泡样式」两入口；渲染端 pet-bubble-styles.js /
  pet-bubble-modules.js 去面板化，纯应用器，配置以 settings 为准（localStorage 仅老配置迁移回退）。

### 穿透根因修复（a10 失败原因 + 正解）
- **a10 为什么无效**：主进程 `applyMainWindowMousePolicy` 的注释与实现都表明
  穿透模式下**渲染层收不到 mousemove（--no-sandbox 下 forward 不可靠）**——主进程
  自己轮询光标位置决策。a10 把命中检测挂在 `window mousemove` 上 = 死通路，从未执行。
- **正解（对齐主进程决策模型）**：
  1. `reportUiOpen` 纳入图库等模态面板（A7 图库的历史漏报一并修复）；
  2. 新增 `mio-desktop:ui-bounds` 通道：渲染层 500ms 上报**常驻可交互 UI**（模块卡片/
     图片泡泡/图库面板）的窗口矩形，主进程轮询加 `inUiRect` 判定——模块卡片常驻
     不能走 uiOpen（会把穿透永久关掉），必须按光标命中精确判定。

### 验证
- 上传/列表/删除/样式 PATCH 全链路 200 且 `设置.json` 正确落盘；测试素材已清理复原；
- 6 个 JS 文件 `node --check` 通过；`--dump-dom` 确认「泡泡」导航注入；
- start_mio 兜底链路 + 桌宠 restart 实测（`ELECTRON_RUN_AS_NODE` 防御生效，Popen 拉起成功）。

---


**主线**：DSH 融合方案 A 组（渲染层增强，对齐 whale-widget 体验）剩余三项全部落地；
顺带根治两个启动链路问题（venv 中文路径失效、宿主环境变量毒化桌宠进程）。

## v3.10（2026-10-15）· A组渲染增强收尾（随机图片 / 泡泡图库 / 模块化泡泡）+ 启动链路加固

**主线**：DSH 融合方案 A 组（渲染层增强，对齐 whale-widget 体验）剩余三项全部落地；
顺带根治两个启动链路问题（venv 中文路径失效、宿主环境变量毒化桌宠进程）。

### A组 3.2 剩余：随机图片（对标 whale-widget #8）
- **后端**（`routes/companion.py`）：新增 `GET /api/companion/bubble-images`（列表）与
  `GET /api/companion/bubble-images/{name}`（图片本体），数据源 = 桌宠数据目录下
  `bubble-imgs/`——**用户把图放进去即生效，无需重启**；文件名白名单（图片扩展名）+
  越界拒绝，与 live2d_assets 的 `_safe_child` 同思路。
- **渲染端**（新文件 `pet-random-image.js`）：加权随机 + 不连续重复（与空闲自语同一
  策略）；自足图片泡泡（桌宠头顶锚点，9s 自动消失）；空闲自语排期 35% 概率改为
  展示图片泡泡（池子为空自动回退文本）。

### A组 3.3 剩余：泡泡图库（对标 #11）
- 新文件 `pet-bubble-styles.js`：8 款气泡皮肤（默认白/墨黑/靛蓝/蜜桃粉/抹茶绿/
  便利贴/终端绿/漫画描边）。机制与 DSH `data-agent-accent` 完全一致——只覆盖
  调色板变量，框/尾巴/投影全复用；插件身份色优先于皮肤。localStorage 持久化，
  右键菜单「泡泡样式」即点即换。

### A组 3.1：模块化泡泡系统（对标 #7，最大项）
- 新文件 `pet-bubble-modules.js`：**6 类模块**（status=跨 Agent 总线状态摘要 /
  quote=随机语句 / image=随机图片 / text=自定义文本 / clock / countdown），
  每模块独立开关、独立 accent（6 色循环）、独立坐标（**拖拽排版**，双击复位）；
  配置 localStorage，默认全关（不打扰）。
- 模块库面板（右键菜单「泡泡模块」）：开关即生效；text/countdown 内联编辑；
  status 模块随徽标事件实时刷新（12 态词汇，whale-widget 只有 4 态等待态——
  这是方案的代差优势项）。
- 3.5（Live2D 动作/表情 × 12 态）审计结论：`PHASE_TO_ACTIVITY`/`PHASE_MOTION_HINT`/
  `emotionParameters`(30+ 情绪)/`semanticMotion`(槽位映射) 已完整覆盖，无需改动。

### 启动链路加固（本次实跑发现的两个真问题）
- **`start_mio.ps1` venv 兜底**：venv launcher 在含中文的项目路径下读不了
  `pyvenv.cfg`（窄字符 API 按 ANSI 解析，报 `Cannot read '...??AI????...'`），
  起的是没有 fastapi 的裸系统 Python——后端永远起不来。现 15s 就绪探测失败即
  自动改用「系统 Python + venv site-packages(PYTHONPATH)」重拉（实测通过）。
- **`companion_service.start_pet` 环境防御**：从 WorkBuddy/IDE 宿主里启动后端会继承
  `ELECTRON_RUN_AS_NODE=1`，它让桌宠 electron.exe 以纯 Node 模式运行、瞬间退出且
  无日志。启动子进程前强制剥除该变量。

### 验证
- 后端路由：列表/取图 200（中文文件名编码正确）、越界 404、非法扩展 400；
- 4 个渲染端文件 `node --check` 通过；headless 渲染整页正常（模型 + 徽标 + 新脚本）；
- start_mio.ps1 完整链路实测：venv 失败 → 兜底启动 → 后端就绪 → 桌宠 WMI 拉起。

## v3.9（2026-10-15）· 模型切换 UI 断链修复 + 水印消除加固 + 工作区清理

**主线**：修掉"前端 UI 切模型永远回到大肥鱼"的状态覆盖断链，加固大肥鱼启动水印消除时序，
并完成一次工作区中间产物大清理与文档归位。

### 修复 1：前端 UI 切换模型不生效 / 应用后回退大肥鱼
- **根因（证据链）**：模型卡片点击 → `CompanionPage.He` → `PATCH /api/companion/settings
  {live2d_model_id}` 本身是通的（curl 实测 config + runtime.json 均正确持久化）。断点在
  **切换成功后 store 的 `companionStatus.pet.settings` 从不回读**：
  1. 设置页 3s 轮询走 `Xn({preserveSettings:true})`，加载器用**内存里的旧 settings 对象**
     覆盖新 status 的 settings（`i.pet.settings=t`），过期值被永久冻结；
  2. 面板卡片高亮 `$e()` 以 `G.value.live2d_model_id`（=冻结的旧值）比对 → UI 永远高亮大肥鱼；
  3. 点"应用"→ `saveCompanionSettings('pet')` 按 `companionSettingKeys.pet`（**含
     `live2d_model_id`**）整包 PATCH 冻结的旧值 → 刚切好的模型被**热切换回大肥鱼**。
- **修复（两处独立兜底）**：
  - `CompanionPage-D7yDEAVz.js` `He()`：PATCH 成功后立即把新 model_id 写回
    `R.companionStatus.value.pet.settings.live2d_model_id`（store 上下文已确认暴露该 ref），
    卡片高亮即时纠正、后续"应用"不再携带过期值；
  - `index-BBVquePX.js` 保存函数：`t==='pet'` 分支在构建 payload 后**强制用服务端最新
    `live2d_model_id` 覆盖**（`await Ba()` 取 /api/companion/status）——即使还有第二条
    陈旧标签页等路径，"应用"也永远以服务端为准。
- **验证**：PATCH `mao-sakiko-10002` → config/runtime.json 双写正确；PATCH 回 `da-feiyu` 恢复；
  `node --check` 两个 bundle 通过；后端 API 全链路实测。

### 修复 2：大肥鱼初始化水印（时序加固）
- e9e3278f 已修相对 URL 解析抛错（headless 实测水印已消失）；本次消除**首帧竞态**：
  - `loadModel` 改为 `await applyWatermarkRemoval(definition)`——模型可见前水印参数已生效；
  - `applyWatermarkRemoval` 在构建参数表后**立即同步置参一次**（不再等下一帧 ticker /
    expression 淡入），`updateModelPerformance` 每帧保持逻辑不变；
  - `live2d-pet/index.html` 版本号 a7→a8。

### 附带：DSH 插件身份色（上一会话完成未提交的收尾）
- `agent_bus_service.py`：`AgentState`/`register` 支持 `accent`（插件自声明身份色），随
  `agent_phase`/`agent_bubble` 透传——桌宠窗口不加载插件注册表也能正确着色；
- `dsh_adapter.py`：DSH 声明靛蓝 `#4F6BED`；自检补 4 条 accent 链路断言
  （`dsh_adapter_selftest.py`）。

### 工作区清理 + 文档归位
- 移出仓库（可回收于 `C:/Users/xiao1/.workbuddy-trash/mao-v3.9-cleanup/`）：
  `_dsh_src/`(11M)、`_research/`(3.7M)、`workspace_patch/`(3.9M，仅剩 2 个活跃 uvicorn
  日志被占用保留)、pet-data 调试残留 30 个（rail_check*.html / srv_* / chat-dom*.txt /
  探针截图等）、`私人AI日记系统/backend/` 15 个 8 位随机名测试残留；
- `.gitignore` 新增：`pet-data/Live2D桌宠/`、`pet-data/pet-instance/`、backend 8 位随机
  临时文件、`xiaozhi_observe.json`、`uvicorn_v2*.log`——运行时数据留盘不入库；
- 文档归位 `docs/`：`桌宠性能根因分析.html`、`DSH桌宠深度融合技术方案.md`、
  `技术需求与现状分析-桌宠音频对话链路.md`；v3.5 引用路径同步更新。

---

## v3.5（2026-10-15）· 性能优化收尾 + 语音完整播放修复

**主线**：桌宠性能问题（跟随不灵敏、拖动卡顿漂移）的 P0 方案落地，同时根治两个体验问题——
Agent 面板覆盖不退出、小智语音"没讲完就结束"。

### 性能优化（P0 方案，穿透去重 + getBounds 收敛）
- **主进程穿透判定状态去重**（`live2d-desktop/main.js`）：新增 `setMainWindowIgnoreMouseEvents(ignore)`
  记录 `lastIgnoreMouseEvents`，**仅状态翻转时才调用** `setIgnoreMouseEvents`——根除此前
  "120ms 轮询 + 无条件调用"导致的**高频 hit-test 切换打断 pointer 事件流**（拖动时 `getBounds`
  高频刷新、鼠标流被反复打断是"拖动卡顿漂移"的直接原因）。
- **渲染层 getBounds 收敛**（`dist/live2d-pet/live2d-pet.js`）：三个每帧调用的 `getBounds()`
  加节流——`updateLockControlAnchor` 80ms、`updateSpeechBubblePosition` 100ms、
  `updateAgentBadgePosition` 80ms；新增 `force` 参数，只在**真正需要立刻刷新**的场景强制
  更新（fitModel / 打字机每字符 / 拖动结束 `finishPointerInteraction` / 徽标显隐 / 双击复位），
  拖动路径 `getBounds` 调用量从约 180 次/秒降到约 12 次/秒。
- **背景**：性能退化调查（2026-10-14 提交链 `8a9c5aa7`→`f2f51fd4`→`7581c6bc`→`c613bc80`）
  发现交互链路从"渲染层 mousemove 实时驱动"退化为"主进程 120ms 轮询 + 无条件穿透刷新"，
  详见 `docs/桌宠性能根因分析.html`（v3.9 起文档统一收进 `docs/`）。

### 修复
- **Agent 面板打开后按其他页面仍被覆盖**（`dist/agent-switch-inject.js`）：补齐与设置面板
  一致的"点击其他导航 `button.nav-item` 即收起"捕获监听——打开 Agent 页后点任意其他页面
  自动收起，不再需要手动点右上角 ✕。
- **小智语音"总是结束得很快、没讲完"**（`dist/live2d-pet/pet-xz-audio.js`）：
  - 根因：官方音频帧（PCM）与 `tts state=stop` 文本在同一 WS 保序到达，但前端 `pump()`
    会把到达的帧**排程到未来播放时刻**（批量/网络缓冲时超前更多），stop 一到就无条件
    `stopPlayback()` 把已排程未播完的尾部音频全部截断 →"没讲完"。
  - 修复：`tts stop` 改为 **drain 模式**——不再立即停止，等已排程音频自然播完后
    （`activeSources`/`playQueue` 清空）再停口型、复位说话状态；口型随 analyser 能量自然归零；
    新一段 `tts start` 仍立即打断旧音频（保证打断/换句正常，不串音）。
- **徽标状态更新延迟排查**（结论性诊断，未改代码）：全链路即时——渲染层 WS 事件直驱、
  后端 `publish→gather` 直推、总线 phase 变化即时发布（300ms 节流仅限同 agent 同 phase 重复）；
  用户感知的延迟主要来自 **DSH 徽标的会话日志尾随（架构性，实测约 200ms~1.5s，DSH 写盘节奏支配）**，
  小智徽标链路无延迟点。

### 模型内置改造（鲸鱼娘 / 大肥鱼 → 内置模型）
- **模型入库**：把「DeepSeek娘(鲸鱼娘)」（原外部导入 `model-1a11f9ad3f7`）与「大肥鱼」（原 `大肥鱼-2`）迁入内置目录
  `澪Agent应用\dist\live2d-pet\models\`（新目录 `whale-deepseek` / `da-feiyu`），随仓库 git 分发、克隆即用；
  迁移时剔除 `.mio-render-cache`、`items_pinned_to_model.json`、`.大肥鱼.mio-render-2048.model3.json`、
  `大肥鱼.vtube.json` 等运行时产物；旧外部导入副本已从 `pet-data\Live2D桌宠\models\` 移除（避免重复显示）。
- **默认模型**：`companion_service.py` 设置默认 `live2d_model_id` 由 `hiyori` 改为 `whale-deepseek`（DeepSeek娘）；
  本地 `runtime.json` 迁移为 `da-feiyu`（保持用户当前选择的大肥鱼）。
- **前端注册**：`live2d-pet.js` `builtInModels` 登记两个模型（含 44 / 15 个表达式、口型/眨眼参数、motionSlots、
  expressionSlots），大肥鱼"13 水印消除"表达式自动触发去水印；`index.html` 版本参数 bump 为 `v=20261015-models`。
- **后端识别**：`companion_service._builtin_live2d_models()` 扫描内置目录时读取 `mio-model.json`
  （name / preview / capabilities / 授权提示），内置模型显示正确中文名与来源；`live2d_assets._write_live2d_runtime_selected`
  放开为可用模型全集（含内置 id），内置模型切换后 runtime 记录不再落空。
- **分区显示**：桌宠管理页「模型」列表与桌宠页形象列表按 `imported` 分区为「内置模型（随项目分发）」与
  「外部导入（仅本机）」两区，内置区不显示删除/封面管理（不可删），外部导入区保留删除 / 换封面。

### 工程
- 前端文件版本参数统一为 `v=20261015-*`（live2d-pet.js `calmfocus`、pet-xz-audio.js `drain`、
  live2d-pet.css `phasecolors`）。

### 验证
- `node --check` 通过（main.js / live2d-pet.js / pet-xz-audio.js / agent-switch-inject.js）；
  文件 BOM（EF BB BF）与 CRLF 行尾保留；git diff 干净可追踪。

---

## v3.4（2026-10-15）· 语音引擎切换 + 桌宠表现强化

**主线**：本机 SAPI 语音引擎损坏导致语音全挂，切换 edge-tts 并做预合成缓存；同时强化桌宠
表现（视线跟随、表情兜底、徽标着色、启动定位稳定）。

### 语音引擎（SAPI → edge-tts）
- **fix(tts)**：本机 SAPI 引擎损坏（`0x80045040` 全语音失败，疑似 10/01 系统更新导致），
  改用 **edge-tts 微软在线 TTS（晓晓音色）**：合成 16k mono WAV + opus 转换测试通过，
  本地播放与官方 ASR 注入链路恢复，不再依赖损坏的 Windows 语音引擎。
- **perf(tts)**：**edge-tts 预合成缓存**——后端启动后台预热全部视觉/观察触发语（10 条），
  wav + opus 双层 LRU 缓存，触发语注入从 2-3s 降到 0ms；重复文本零合成延迟。

### 桌宠表现
- **鼠标视线跟随**：主进程 16Hz 推送鼠标位置（`mio-desktop:mouse-move`）+ 渲染层
  `model.focus()`——桌宠眼睛跟随鼠标移动；穿透模式下渲染层收不到 mousemove，必须由
  主进程高频喂数据。
- **视线跟随幅度压缩**：跟随范围限制在模型周围区域，消除大幅转头/"多动症"。
- **表情恢复兜底**：找不到自然表情时重置默认表情。
- **Agent 状态徽标 12 态专属着色**：按 phase 全表着色（思考蓝/工具橙/语音金/错误红/
  等待审批紫/连接中灰蓝等，深底白字），连接中/异常单独色。

### 稳定与工程
- **fix: 桌宠启动跳位根治**：窗口虚拟边界修正完成前隐藏模型，修正后统一 `fit` 定位显示
  （`window-stable` 协议）；窗口稳定事件丢失时 10 秒兜底显示模型。
- **桌宠数据目录统一**：新增 `MIO_PET_STATE_DIR` 环境变量，后端 `live2d_assets.py` 与
  Electron `main.js` 解析到**同一个** "Live2D桌宠" 目录——修复此前
  `MIO_PROJECT_ROOT/Mao/pet-data` 拼错导致的空目录（后端读不到自定义模型、切角色静默失败）。
- **start_mio.ps1**：就绪探测改用 `/api/companion/agents`（纯读总线，稳定），不再用
  依赖 Live2D 资源与磁盘写入的 `/api/companion/status`（资源异常时返回 500 会误判后端未运行）。

---

## v3.3（2026-10-14）· 桌宠交互与性能优化

**主线**：解决桌宠卡顿与交互失灵两大问题，并强化状态显示（多 Agent 状态栏、水印消除、调大小面板）。

### 性能与交互
- **perf: 桌宠卡顿优化**（渲染降帧 + 后端轮询降频）：空闲 8s 自动降帧到 9fps、mousemove
  不再标记活动（CPU 占用 95% → 21.5%）；代价是 hover 时帧率受限（v3.5 已用穿透去重缓解）。
- **fix(pet): 交互失灵根因**：`--no-sandbox` 下渲染层鼠标事件转发（`{forward:true}`）失效，
  窗口永久穿透；改为**主进程轮询鼠标位置 + 渲染层上报模型区域/UI 状态**驱动穿透判定，
  不再依赖 forward 转发。
- **fix(pet): 拖动/菜单期间保持可交互**：`rendererInteractive` 参与穿透判断，
  `pointerup` 后恢复穿透上报。
- **ui: 调整大小面板整体可拖动**（标题区手柄 + pointer capture）；滑块样式优化。

### 状态显示与模型
- **Agent 状态徽标升级为多 Agent 状态栏**：每个 agent 一个状态 chip 实时并排显示、
  即插即用、停用即移除（v3.5 再加 12 态专属着色）。
- **模型自带水印消除表达式默认自动应用并每帧保持**（大肥鱼去水印）。

---

## v3.2（2026-10-14）· DSH 实时工作状态接入（真实事件摄取）

**主线**：把 v3.1 里只是"配置就绪占位"的 DSH 适配器，改成**真实事件驱动**——DSH 真的在
干什么，桌宠就实时演什么。接入后 DSH 能显示 v3.1 全部 12 个标准 phase。

### DSH 事件摄取（dsh_log_stream.mjs + dsh_adapter.py）
- **发现真实事件源**：DSH 把会话完整事件流持久化为**拼接式 Zstandard 帧**的 JSONL
  （`~/.dsh/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`）。每个追加批次一个独立
  zstd 帧，**不能一次性解压**，只能逐帧解。
- **新增零依赖 Node 边车** `dsh_log_stream.mjs`：逐帧解 zstd（`node:zlib` 自带）→ 解析
  DSH 官方 `SessionEvent` → 折叠成**客观事实 facts** → NDJSON 输出。之所以放 Node 侧：
  本项目 Python venv 无 zstd 绑定。协议细节（帧格式/事件字段）全部隔离在边车里，
  Python 只做 facts → phase 的策略映射，两边规则不重复实现。
- **会话选择**：优先"最近活跃的**主**会话"（`delegationDepth=0`），避免跟到 subagent
  子会话；带迟滞（2.5s）防止两会话来回抖动；附着时不回放历史事件（只发一条推导出的
  facts），否则桌宠会把几百条旧事件当实时状态闪一遍。
- **12 个 phase 全部注册**（真实事件驱动）：
  `turn/start`→planning、`step/start`/`llm/retry`→thinking、`tool/call`→executing_tool、
  `assistant/message`(text)→streaming、`ask_user_question`→waiting_input、
  `approval/asked`→awaiting_approval（未 decided）、`turn/end{completed}`→complete、
  `tool/result{isError}`/`turn/end{error|max-tokens|interrupted}`→error、
  进程退出→paused、无工作→idle、保活→heartbeat。
- **失败识别口径修正**：DSH 的失败标记是 `tool/result.data.message.isError === true`，
  **不是** `data.error`（实测 330 条 tool/result 全部带 `isError` 布尔，仅 2 条带 `data.error`）。
  且 error 只在"最近一个事件本身失败"时进入，后续进展事件立即恢复工作态——**失败不粘轮**。
- **如实的能力声明**：本版 DSH 无 TTS/语音合成服务（asar 内无 tts 包，官方 README 明确
  "no speech synthesis"），STT 转写提交后与打字产生的 `user/message` 完全不可区分，故
  `voice`/录音状态在 DSH 侧**不可观测** → `capabilities.voice=False`。适配器仍保留
  `voice` phase 与 `speak`/`tts` 工具映射，日后部署了此类工具即自动生效，无需改代码。

### 通道选型（实测，不靠猜）
- A/B 实测同一段时间两条通道：**Host WS `/api/remote.mux` → `session/follow`**
  p50 **10ms** / p90 78ms（含 `assistant-stream` 增量，但需凭据 cookie 签名 + 端口发现，
  端口为临时分配未持久化）；**会话日志尾随** p50 **215ms** / p90 237ms（无需鉴权、无需端口、
  DSH 重启不失效）。两者拿到的事件**完全一致**（同期各 12 条、seq 相同）。
- **结论**：取日志为主通道——215ms 远优于 300ms 节流窗口与人眼感知，且在最无依赖、
  最不易失效的一侧。WS 快通道留作后续可选加速项。

### 修复
- **`agent_bus_service.set_enabled` 未真正释放"身体"**：停用某 Agent 后 `enabled=False`、
  `phase=idle`，但 `active` 仍为 `True`、`active_agent_id` 仍指向它——快照里它依旧是
  "当前显示者"，桌宠看着像没停用（与 README 6.3/6.9 的"停用立即释放"契约相悖）。
  现修正为：停用时清 `active`、清 `_active_agent_id`，并把身体让给最近有活动的其它已启用
  Agent；`_decide_active_locked` 增加"已停用者绝不能占据身体"的硬门。
- **停用后重新启用不立即恢复**：改用当前 facts 补发一次状态（`_publish_facts(force=True)`），
  不必等下一个 DSH 事件；否则会停在 idle 直到 DSH 动一下。

### 验证（可复现）
- **自检 122/122 通过** `python -m app.dsh_adapter_selftest`：phase 映射全覆盖（含优先级
  冲突组合）、单事件映射、边车真实日志解码、**真实事件回放**（夹具由
  `app.dsh_fixture_build` 从真实会话日志脱敏抽取，84 步回放无异常且 phase 全合法）、
  **可达性断言**（枚举事实网格，断言 `phase_for_facts` 恰好产出 `DSH_FACT_PHASES` 10 个，
  且 `paused`/`heartbeat` 不由 facts 产出）、总线集成、**前端契约**（解析 `live2d-pet.js`
  内嵌的 `PHASE_LABELS`/`WORK_PHASES`，断言 12 个 phase 都有中文标签且工作态口径一致；
  已用变异测试证明该断言非空过）。
- **端到端** `python -m app.dsh_adapter_e2e`：轮询总线观测 DSH `online` 110/110 采样、
  全程 `active=True` 且 `active_agent_id=dsh`，`state` 带真实 `tool/turn/step/session`。
- **WS 链路** `python -m app.dsh_ws_check`：确认 DSH 的 `agent_phase` 确实经桌宠消费的
  `/api/companion/ws` 推送（25s 窗口 8~12 条，与 HTTP 快照 `active_agent_id=dsh` 一致）。
- **边界行为实测**：停用 → `active=False` 且身体让给小智；重新启用 → 立即恢复工作 phase；
  杀掉边车进程 → 14s 内自动重启并恢复 online；结构性损坏日志 → 去重报错并隔离，不再刷屏。
- **事件覆盖缺口分析** `python -m app.dsh_gap_analysis`：对照真实事件类型与折叠逻辑，
  列出未处理类型（当前 18 种、169 条，均为协议元数据/子会话/标题等无关类型）。
  此工具先报出"planning 不可达"，从而暴露并修掉了 `todo_write → planning` 的接线缺失。
- **排障接口**：新增 `GET /api/companion/agents/{id}/inspect`（`phase`/`bus_enabled`/
  `sidecar_alive`/`dsh_process_running`/`facts`/`phases`/`fact_phases`/`config_path`）。

### 文档
- README 第六章重写 6.4/6.5：新增 **6.5.1 DSH 接入**（事件→phase 对照表、失败口径、
  `voice` 不可观测的原因、通道选型实测表、配置字段表、自检命令）；6.4 补两条实战经验
  （Windows 下不要用 `asyncio.create_subprocess_exec` 起边车——走 overlapped 命名管道会
  `WinError 5`，改用 `Popen`+线程；区分 `xx_config.json.enabled` 与总线 `enabled` 两个层次）。

---

## v3.1（2026-10-14）· 跨 Agent 桌宠迭代

**主线**：桌宠定位升级为**跨 Agent 的"脸"**——后端统一状态总线 + 可插拔适配器（小智/DSH/Octop），桌宠只认标准 phase，即换即用无需重启。

### 跨 Agent 统一状态总线（agent_bus_service.py）
- **12 个标准 phase**：idle/planning/thinking/executing_tool/streaming/waiting_input/voice/complete/error/paused/awaiting_approval/heartbeat
- **活跃聚焦调度**：按 phase 优先级决定"谁占据桌宠身体"（voice 最优先、idle 最低）；同 Agent 同 phase 300ms 节流；非活跃静默 8s 允许更高优先级抢占；`awaiting_approval` 借鉴 Paperclip 审批流
- **心跳在线检测**：适配器定期上报，超 30s 判离线并广播快照
- **启用状态持久化**：`agent_bus_config.json`（运行时生成，已 gitignore）

### 适配器层（可插拔，原生协议全部隔离）
- **小智插桩**（routes/xiaozhi.py）：`_xz_register/_xz_emit/_xz_status` 三 helper 全事件接入——hello→online+idle、goodbye→paused、MCP→executing_tool、STT→waiting_input、LLM→streaming、TTS→voice、TTS 结束→complete、断线→offline+paused；重连成功显式清除 error
- **DSH 适配器**（dsh_adapter.py）：DeepSeek Harness 事件 → phase 映射（turn/step/tool/text/approval 状态机），配置即启用（**v3.2 已升级为真实事件摄取**，见上）
- **Octop 适配器**（octop_adapter.py）：TencentCloud Octop WS 事件 → phase 映射，配置即启用

### 渲染端与前端
- **phase → 表现映射**（live2d-pet.js）：PHASE_LABELS / PHASE_TO_ACTIVITY（speaking/responding/listening/idle）/ PHASE_MOTION_HINT（表情动作提示词）
- **Agent 状态徽标**：工作细分状态（思考/执行工具/回复/说话等）在桌宠头顶短暂展示 4 秒自动淡出；**连接/断连不显示**（消除小智重连闪烁）；右键菜单可开关（localStorage `mio_agent_badge_enabled`）
- **Agent 管理页**（agent-switch-inject.js）：导航项 + 状态卡片 + 能力标签 + 启用开关；停用 Agent 只显示"未启用"+配置引导
- **agents API**：`GET /api/companion/agents`（总线快照）、`POST /api/companion/agents/{id}/enabled`（即换即用）

### 接入新 Agent 的最小改动
- 新建适配器文件（照 dsh_adapter 骨架）→ `main.py` 后台任务注册一行 → 项目根 `xx_config.json` + gitignore；前端零改动（详见 README 第六章「Agent 接入指南」）

---

## v3.0（2026-10-13）· 设置与工具管理重构版

**主线**：设置界面彻底重建（弃用原版 Mio 设置体系）+ 本地 MCP 工具集中管理 + 桌宠完全自由拖拽，发布版 v3.0。

### 设置页彻底重建
- **弃用原版 Mio 设置 UI**：基础与启动 / 云端语音 / 本地音色 / GPT-SoVITS 等已删功能的遗留界面全部移除，不再渲染
- **新建内嵌设置面板**（`settings-panel-inject.js`），与主界面其余三界面（对话/桌宠/小智工具）框架完全一致：**桌宠 / 语音 / 屏幕观察 / 提示词 / 小智** 5 个 tab
- 数据源全部为已验证后端接口（`GET/PATCH /api/companion/settings`、`GET/POST /api/xiaozhi/observe/*`、`GET/PUT /api/xiaozhi/prompts` 等），保存真实生效
- **根治注入脚本运行中断**：`MutationObserver.observe(document.body)` 在 body 未解析时抛 TypeError 导致整脚本中断（此前一直误判为缓存/Vue 事件问题）；导航"设置"按钮接管改为隐藏原版按钮 + 原位插入自有按钮 + 保活强制显示

### MCP 工具集中管理（小智工具页）
- **本地免费 MCP 工具配置化**：system / 网络 / 时间 / 天气 / 记事本等 15 项本地工具，开关持久化，`tools/list` 按开关过滤、`tools/call` 分发，按需使用
- **小智工具管理页**（`mcp-tools-panel.js`）：与主界面框架一致的内嵌面板，打开即用，不再覆盖式浮窗
- 官方视觉 MCP 链路保持：`tools/call` → 官方 `/vision/explain` → 文本回灌官方 LLM → 官方 TTS 音色播报

### 桌宠拖拽完全自由
- **移除全部上下/水平限位**：任何方向自由拖拽，不回弹、不拉回、不限位，位置原样保存、重启原样恢复
- **修复 `/api/companion/position` 路由装饰器丢失**：瘦身时误删 `@router.patch("/position")`，导致拖拽保存一直 404、状态轮询把旧位置弹回

### 稳定性与体验
- 注入防阻塞三层：`conn.send` 5s 超时 + 注入整体 30s 超时自动释放锁 + 半死连接主动重置重连
- 对话文字随语音**逐句显示**（tts 分句实时推送聊天列表，不再等整句或消失合并）
- 自动观察设置持久化（`xiaozhi_observe.json`），重启不恢复默认
- 图片消息在历史中同时显示图片与附带文本；历史上限 1000 条
- 桌宠渲染采样恢复 2x，点对点清晰（内存优化不牺牲清晰度）

---


**主线**：图像识别（发图/截图提问/立即观察）全链路稳定闭环——官方小智视觉识别 → 文本回灌 → 官方音色语音，不再反复唤醒、不再卡死。

### 打通官方视觉 MCP 工具链路
- **官方 MCP 工具协议**：设备侧实现 MCP server（`initialize` / `tools/list` / `tools/call`），官方视觉 API（`/vision/explain`）识别文本作为 `tools/result` 回灌官方 LLM，由官方 LLM + TTS 产出官方音色语音（对照 `xkk6663/Harness_ESP32S31` 端侧人脸识别项目的实现）
- **触发语改为用户可编辑提示词**（`xiaozhi_prompts.json` 的 `image_prompt` / `observe_prompt`，管理面板可改），不再写死
- **每次发图/观察前强制断开重连重置官方会话**：修复"重启后第一张图必通、第二张起全失败"——同一官方会话内第一次工具调用后 LLM 认为图片已在上下文、后续指令不再调工具

### 注入链路防阻塞（卡死根治）
- **根因**：官方连接"半死"（TCP 活、应用层无响应，官方禁心跳无法感知）时 `conn.send` 永久挂起，占用注入串行锁 → 卡住后所有对话/观察/截图提问排队阻塞
- **修复三层**：`conn.send` 加 5s 超时；注入整体 30s 超时自动释放锁；发送失败主动重置半死连接触发重连
- 所有注入路径（对话/发图/观察/截图提问/自动观察/分段注入）统一走 `_inject_say`，全覆盖受益

### 修复
- **快速连续发图识别旧图**（"这张跟刚才那张是一样的呀"）：设置新暂存图时作废旧图副本；前端清空输入框后派发 `input` 事件同步 Vue v-model
- **长触发语导致官方不调工具**：官方 ASR 对长文本识别乱码 → LLM 不调工具；改用短触发语（识别场景 8s STT 确认）
- **发图 PNG 转 JPEG 上传**，修复"连不上"与误用上一张图
- 回滚 vision 无条件 abort（实测导致识别触发语却不调工具），恢复仅 TTS 播放中才中断

### 桌宠清晰度
- **渲染分辨率 1.5x → 2x 恢复**：内存优化曾把渲染采样降到 1.5x 导致桌宠变糊；恢复 2x 后点对点达到屏幕物理清晰（175% 缩放屏 = 1.75x）

---

**主线**：对话历史完整化 + 实时体验稳定化。自 v2.0 后累计 7 项修复/优化，全部本地 git 可追溯。

### 修复
- **小智回复文字缺失 / 图片附带信息缺失 / 历史不完整**：
  - 根因 1：上游 llm 事件 text 只有表情碎片（如 `😊`），完整回复在 tts 分句里——改为 tts 分句累积、`tts stop` 时拼接完整回复写历史（含 `global` 声明缺失修复）
  - 根因 2：历史文件 id 冲突导致前端按 id 去重误吞新消息——加载时按序重建单调唯一 id
  - 前端 ChatPage：图片消息同时显示图片+附带文本；重连时回填去重集合防重复；历史上限 500→1000
- **自动观察设置重启后恢复默认值**：配置持久化到 `xiaozhi_observe.json`，启动时恢复
- **打开 MIO 误触发一次观察**：后端启动时首次排程硬编码 20 秒——改为按用户设置间隔随机排首次
- **文字随语音逐句出现却消失/合并成整句**：分句改为独立气泡保留（逐句显示、不消失）；轮询按文本前缀匹配跳过已逐句显示的回复完整条目（会话内看逐句、重开看完整历史）
- **气泡偶尔飞到屏幕左上角**：模型切换/加载中 `getBounds()` 退化为 0,0——增加有效性保护，模型不可用时保持上次位置

### 优化
- **对话延迟**：tts 分句实时推送到聊天列表，文字随语音逐句冒出（不再等语音说完才显示）
- ChatPage 无缝衔接原版 UI 框架（恢复左侧会话抽屉 + 右上角跟随对话按钮），完整展示小智对话历史

---

## v2.0（2026-10-12）· 发布版 2.0

**主线**：可发布、可复现、稳定长挂机。项目更名 Mao，推向独立远程仓库。

### 新增
- **小智对话记录面板**（`dist/xiaozhi-history-panel.js`）：打开 MIO 管理窗口即自动显示，覆盖原版消息区。
  - 加载 `/api/xiaozhi/chat-history` 全部历史（你/小智/系统消息 + 图片缩略图）
  - WS `role=chat` 实时追加（llm/tts/sysmsg/error 状态）
  - 可直接发送文字（`/say`）与图片（`/vision`，暂存 + 粘贴）
  - 右上角 ✕ 关闭，右下角"小智对话"悬浮按钮重开
- **发布版脚本**：`安装依赖.ps1`（一键装依赖）、`打包发布.ps1`（生成 zip）、`start_mio.ps1` 路径相对化（`$PSScriptRoot`）
- 开机自启动键名更新为 `Mao桌宠自启动`

### 修复
- **图片分析双发**：根因 = 面板与原版注入脚本的全局粘贴监听都会暂存同一张图（双暂存 → 双发两次 `/vision`）。
  修复：面板打开时置 `window.__mioXzChatInjectPaused` 暂停原版注入的暂存/发送拦截；面板发送加 busy 锁。
- **图片分析结果未显示在桌宠气泡**：`/vision` 返回前广播 `speech-bubble` → 分析文本显示在桌宠旁气泡（6s 自动消失）。
- **锁定桌宠按钮消失**：按需创建优化误删了"非锁定模式的锁定入口"，恢复按钮常驻。
- **清理双后端混乱**：杀掉系统 Python 残留（119MB）+ 僵尸实例，统一 `.venv`。

### 优化
- 内存：渲染分辨率 2x→1.5x（WebGL 纹理 -44%）；空闲 30s 无交互自动降帧 12fps（交互/说话即恢复 60fps）；
  Electron 总内存 790MB → 650MB。
- 横条对话窗恢复"单条胶囊"形态（460×66）：去掉标题条/状态行/暂存条/历史按钮，状态提示并入 placeholder。

---

## v1.0（2026-10-08 ~ 2026-10-11）· 首个可用版本

**主线**：把开源 Mio 桌宠改造为"本地免费 Live2D 看板娘 × 小智官方免费云"。

### 核心能力
- 小智接入：test-token 通道长连接、文字对话、官方音色语音（桌宠本体播放 + 口型同步）、免唤醒
- 图片识别 / 屏幕观察：官方视觉分析、提示词可配置（`xiaozhi_prompts.json`）、结果文本气泡
- 会话历史：`xiaozhi_chat_history.json` 持久化 + `/chat-history` 接口 + 截图提问/观察统一入历史
- UI 融合：原版私人空间对话页注入 📷 发图 + 粘贴暂存；左侧导航精简；桌宠管理页（模型管理/屏幕观察/体检）
- 全局快捷键 `Ctrl+Shift+S` 区域截图提问；沉浸式选区 overlay
- 模型：导入 Cubism 3/4 模型、切换形象、每日定时自动更换、口型/表情联动

### 修复（节选）
- 音频链路：官方视觉只返回文本（协议限制），改为文本气泡呈现，不本地 TTS
- 断连重连：禁用协议层 ping（官方无心跳），重连静默不进主聊天刷屏
- 角色解耦：官方 STT 回传不写"你说"历史，杜绝信息错乱
- 副屏显示、开机自启、横条输入等多项体验问题

---

## 上游对照

来源链：`ochiru520/Mio`（原始）→ `xkk6663/Mao`（跨 Agent 平台）→ `xkk6663/dsh-live2d-mao`（本项目，DSH 专用）

| 版本 | 说明 |
|---|---|
| ochiru520/Mio（原始上游） | 原版桌宠：Electron + Vue SPA + FastAPI，含 Agent 工作台/QQ 对话/付费模型等 |
| Mao v1.0 | 阉割原版无关功能，接入小智免费云（核心融合完成） |
| Mao v2.0 | 发布版：历史全可视化、双发/气泡修复、内存优化、更名 Mao、独立仓库 |
| Mao v3.0 | 设置与工具管理重构版：设置页重建、MCP 工具集中管理、完全自由拖拽 |
| Mao v3.1 | 跨 Agent 桌宠迭代：统一状态总线（12 phase）+ 小智/DSH/Octop 适配器 + Agent 管理页与状态徽标 |
| Mao v3.2 | DSH 实时工作状态接入（真实事件摄取，日志尾随通道 + Node 边车） |
| Mao v3.3 | 桌宠交互与性能优化：穿透架构根治、卡顿降帧、多 Agent 状态栏、水印消除 |
| Mao v3.4 | 语音引擎切换（edge-tts + 预合成缓存）、视线跟随、徽标 12 态着色、启动定位稳定 |
| Mao v3.5 | 性能优化收尾（穿透去重 + getBounds 收敛）、Agent 面板自动收起、小智语音完整播放修复 |
| **dsh-live2d-mao**（本项目） | 从 Mao v4.1 fork：阉割小智/Octop 等非 DSH 能力，插件改名 dsh-live2d-mao，12 态专用化，发布 npm 并上架市场 |
