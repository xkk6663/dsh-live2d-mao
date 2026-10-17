# DSH 专用 Live2D 桌宠插件 · 技术分析与实施步骤（v3.0）

> ## ⚠ 阅读前必读：本文是 **2026-10-15 的历史方案稿**，不是现状说明书
>
> 截至 **2026-10-17**，本文 Phase 0~4 已全部走完一轮，**其中若干条已被后续裁决推翻**：
>
> | 本文原计划 | 现状 |
> |---|---|
> | Phase 0.1 spike「宿主侧起 BrowserWindow」 | ❌ **已否决**（`ELECTRON_RUN_AS_NODE=1` 下 `require('electron')` 无 BrowserWindow，见 `M5-Phase0.1-spike-结论.md`）⇒ 改为「独立 Electron 壳 + 插件只推事件」，即裁决 **D4** |
> | Phase 1 `dsh-connector` 最小可跑 | ✅ 已落地，实际包名 `packages/mao-pet` |
> | Phase 2.1 逐 token 流式 | ✅ 已落地（走 `agent/assistant-stream` → 横条） |
> | Phase 2.2/2.3 审批/提问应答 | ⛔ **已阉割**（用户裁决 2026-10-17：DSH 审批策略为 `never` 时用不上；需要审批直接开 DSH 界面，从桌宠点按钮属绕远路） |
> | Phase 2.4 多 session 气泡栈 | ✅ 已接线（`bubble-stack.js` 驱动工具状态气泡） |
> | Phase 3 桌宠渲染层增强（A 档） | ✅ 已完成 |
> | Phase 4 发布（npm + icon + PROVENANCE） | ❌ **仍未做** |
>
> **当前权威文档**：`AGENTS.md`（工程纪律/红线）、`SRC-MAP-源码地图.md`（改哪里）、
> `docs/DSH专用化阉割记录.md`（做了什么/为什么）、`docs/后续开发方向.md`（还差什么）。
> 本文保留价值：**各能力的接口契约、踩坑结论、能力边界**（§三 仍准确）。

> 版本：v3.0 · 2026-10-15 · **A 档落地版**
> 相比 v2.0 的变更：
> 1. **A 档（桌宠渲染层增强）已实现并验证**：泡泡工坊（皮肤 / 点击序列 / 图片素材库 / 音效事件 + 片段库 + 波形裁剪）+ **M1 逐 token 流式**；见 §三.3 与 §六 Phase 3。
> 2. **逐 token 流式走的是"日志通道 + 按原始节奏回放"**，不是"边生成边出字"——真因见 §三.4（实测证据：1131 个 stream 事件全部单帧落盘）。这是一条**必须知道的上限**，不要再按"实时增量"对外承诺。
> 3. **泡泡不再做成浮窗模块卡**（用户裁决）：状态栏已由徽标承担，随机语句/图片改为**点击桌宠触发**并复用同一个说话气泡框。whale 的"模块化泡泡系统"我们**差异化实现**而非照抄。
> 4. **泡泡/点击互动/音效全部归桌宠主体**，只经核心 API `window.__mioPetBubble` 暴露给插件——插件关掉后泡泡仍在（踩过一次真实回归，见 §三.5）。
>
> 仓库定位不变：**即插即用的跨 Agent 桌宠项目**；后续做插件时**只拿出 DSH 连接插件**融合进 dsh-market，桌宠主体保持独立可用。

---

## 目录

1. [执行摘要](#一执行摘要)
2. [对标物深度分析：dsh-whale-widget](#二对标物深度分析dsh-whale-widget)
3. [能力对标与超越清单](#三能力对标与超越清单)
4. [架构选型与三个决策的影响](#四架构选型与三个决策的影响)
5. [推荐架构](#五推荐架构)
6. [分阶段实施步骤](#六分阶段实施步骤)
7. [风险与未验证点](#七风险与未验证点)
8. [附录](#八附录)

---

## 一、执行摘要

### 1.1 一句话结论

**以 `dsh-whale-widget` 为工程范式（MIT 许可、DSH bundle 插件、宿主侧 + 前端本体双轨），把本仓库已有的「12 态 phase 总线 + zstd 会话日志解码 + Live2D 渲染」三块资产，重写为「DSH 进程内 Cordis 插件」形态，砍掉小智 TTS 依赖，保留独立置顶穿透窗口作为可选项。**

### 1.2 与 v1.0 的差异

| 维度 | v1.0 | v2.0（本版） |
|---|---|---|
| 对标物 | `@linxin666/dsh-pet`（Live2D 桌宠插件，**已下架**，源码从 pnpm store 还原） | **`dsh-whale-widget` v0.4.2（在架、活跃维护、MIT）** |
| 小智 TTS | 列为"最大能力损失"，建议外部服务兜底 | **直接砍掉**（用户决策：插件不依赖插件） |
| 独立窗口 | 未验证点 #1 | **本版给出证据链与两条实现路径**，降级为"可选项" |
| 仓库定位 | fork 成纯插件 | **fork 后：桌宠主体独立 + DSH 连接插件单独抽出来进 dsh-market** |

### 1.3 三个必须知道的结论

| # | 结论 | 证据 |
|---|---|---|
| 1 | **whale-widget 的工程范式完全可复用**：`cordis.patch.yml` 只有 3 行有效内容，宿主侧 `apply(root)` + `root.inject(['webServer','credentials','connection'], cb)`，前端走 `webserver/index-inject` 结构化注入行 | `dsh-whale-widget/cordis.patch.yml:13-15`、`lib/index.js:731-749` |
| 2 | **独立置顶穿透窗口在插件形态下没有先例**，但技术上有一条未走通的路：宿主侧 `require('electron')` 起 `BrowserWindow` | `_research/pet/**` 搜 `BrowserWindow` = 0 命中；`dsh-plugin-wallpaper-engine/README.en.md:342` 反向证明插件改不动壳侧窗口 |
| 3 | **本仓库已有资产比 whale-widget 更强的部分**：12 态 phase 总线（whale 只有 4 态等待态）、并发工具追踪、真实事件回放测试（131 项） | `agent_bus_service.py:34-47`、`dsh_adapter_selftest.py` |

---

## 二、对标物深度分析：dsh-whale-widget

### 2.1 基本档案

| 项 | 值 |
|---|---|
| 包名 | `dsh-whale-widget`（无 scope） |
| 版本 | 0.4.2 |
| 仓库 | `github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget` |
| **代码许可** | **MIT** |
| **素材许可** | **不适用 MIT**（as-is，仅供运行本插件，不授予再许可） |
| 代码规模 | 宿主侧 259.2 KB + 记账内核 13.4 KB + 前端 1,115.8 KB ≈ **1.39 MB** |
| 路由数 | 26 个 `/dsh-whale/*` |
| 运行时数据 | 8 个 `.dshw-*.json` + 3 个资源目录，全在 `$DSH_HOME` |

**证据**：`dsh-whale-widget/package.json:1-37`、`PROVENANCE.md:5-11`、`README.md:142-154`

### 2.2 插件工程范式（可直接照抄）

#### 2.2.1 package.json 关键字段

```jsonc
{
  "name": "dsh-whale-widget",
  "version": "0.4.2",
  "type": "module",
  "main": "lib/index.js",
  "icon": "./icon.png",                    // 必须正方形 256×256 含透明
  "files": ["lib", "assets", "icon.png", "cordis.patch.yml", "README.md", "PROVENANCE.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "license": "MIT"
}
```

**证据**：`dsh-whale-widget/package.json:1-37`

#### 2.2.2 cordis.patch.yml 全部内容

```yaml
- insert:
    - id: dsh-whale-widget
      name: dsh-whale-widget
```

**证据**：`dsh-whale-widget/cordis.patch.yml:13-15`

> **这是整个挂载声明**。对比 `@linxin666/dsh-pet` 还要在 profile 层写 config（`visible/size/right/bottom/petId`），whale-widget 把配置全放自己的 `.dshw-size.json`，**profile patch 零配置**。这是我们该抄的做法。

#### 2.2.3 宿主侧入口范式

```js
export default {
  name: 'whale-balance-widget',
  apply(root) {
    // ① 立刻注册注入行（不等任何服务）—— 桌面端唯一的注入通道
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'body', text: DESKTOP_WIDGET_ROW_TEXT })
    }))
    // ② 等齐三个服务后再跑主逻辑
    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
      // 路由注册、事件订阅、记账…
    })
  }
}
```

**证据**：`dsh-whale-widget/lib/index.js:723-749`

**三个工程细节（都是踩坑后的结论，直接继承）：**

| 细节 | 原因 |
|---|---|
| **不要用对象级 `inject: ['webServer',...]`** | 会把 apply() 推迟到服务就绪；而桌面端注入表是宿主启动时**一次性收集**，晚于那次收集就永远进不了表 |
| **注入行用 `kind:'script'` 内联，不要用 `script-src`** | 页面侧解释器对 `script-src` 是 `await loadScript()`，失败会 reject 整个 boot ⇒ 应用起不来（issue #154） |
| **前端文件由宿主按 mtime 热读取** | 改前端硬刷新即可，改宿主才要重启 |

**证据**：`lib/index.js:725-730`、`706-717`、`README.md:456-457`

### 2.3 它订阅了哪些 DSH 事件（这是我们要超越的部分）

| 事件 | 用途 | 代码位置 |
|---|---|---|
| `session/event`（全量） | 按 sessionId 分桶，`assistant/message` 聚合 usage 算钱 | `lib/index.js:1128` |
| `session/event` → `turn/end` | 结算本轮，写 `last-turn.json` | `lib/index.js:949-951` |
| `session/event` → `tool/call`{name:'ask_user_question'} | 标记"等待回答"挂起 | `lib/index.js:1063-1066` |
| `session/event` → `tool/result` | 按 callId 解除挂起 | `lib/index.js:1067-1073` |
| `session/event` → `approval/asked` | 标记"等待授权"挂起 | `lib/index.js:1074-1077` |
| `session/event` → `approval/*` | 解除授权挂起 | `lib/index.js:1078-1084` |
| `session/event` → `session/title` | 取对话名 | `lib/index.js:1050-1053` |
| `subagent/start` / `subagent/end` | 记住子会话 id，完成时提示 | `lib/index.js:1124-1125` |
| `session/disposed` | 清理聚合防泄漏 | `lib/index.js:1134-1136` |

**它没做的（我们的机会）：**
- ❌ **没有 phase 概念**——只有 4 种"等待态"（question/approval/任务结束/余额预警），没有 thinking/tool/streaming/planning
- ❌ **没有 Live2D**——是静态 PNG + 代码画气泡
- ❌ **没有 `agent/assistant-stream`**——不订阅逐 token 流
- ❌ **没有多 session 气泡栈**——只保留最新一条挂起（`README` 明说"子代理不允许提问，授权并发极少"）
- ❌ **没有对话名以外的上下文投影**（goal/todos/contextPressure）

**证据**：`lib/index.js:998-1000`、`README.md:66`（"同一个未回答的提问只响一次"）

### 2.4 安全设计（必须继承，这是它的硬功夫）

| 层 | 做法 |
|---|---|
| 浏览器信任栅栏 | 委托宿主 `connection.requestRejection(req)`；**宿主栅栏抛异常按拒绝处理**（旧实现静默放行） |
| 自有轻量校验 | Host 必须是回环（`127.0.0.0/8` 逐段校验，防 `127.0.0.1.evil.com`）；`Sec-Fetch-Site: cross-site` 一律拒；带 Origin 必须同源 |
| 写操作限本机 | `POST/PUT/PATCH/DELETE` 非回环来源一律 403；远端管理用 `DSHW_ADMIN_HOSTS` 显式声明 |
| 凭据不落配置 | 密钥写 DSH 凭据服务，配置只存凭据名 |
| 凭据只发内置端点 | 自定义地址默认不送凭据，需按模型勾选"允许" |
| 诊断信息脱敏 | `maskPath()` 把 `$DSH_HOME`→`$DSH_HOME`、家目录→`%USERPROFILE%`；白名单字段，绝不含 key |

**证据**：`lib/index.js:749-774`、`README.md:332-343`、`lib/index.js:60-79`

---

## 三、能力对标与超越清单

### 3.1 对标表（whale-widget 有 / 我们有没有）

| # | whale-widget 能力 | 我们有吗 | 移植工作量 |
|---|---|---|---|
| 1 | 常驻自启（bundle 插件） | ❌ 需插件化 | 小 |
| 2 | 26 个 HTTP 路由 | ❌ | 小（照抄 `registerRoute`） |
| 3 | 桌面端结构化注入行 | ❌ | 小（照抄 3 行） |
| 4 | 按 mtime 热读取前端 | ❌ | 小 |
| 5 | 拖拽 + 吸附 + 翻转 | ✅（Electron 主进程） | 中 |
| 6 | 按压 Q 弹 | ✅（A 档：`press`/`release` 反馈音 + 点击互动） | 小 |
| 7 | 模块化泡泡系统（6 类模块 / 逐模块样式 / 拖拽排版 / 模块库） | ✅ **差异化实现**（见 §3.3） | **大** |
| 8 | 随机语句 / 随机图片（带权重不连续重复） | ✅（点击触发 + 权重 + 不连重） | 中 |
| 9 | 音效系统（音效组 / 片段裁剪 / 每事件独立音量 / 试听） | ✅（7 事件 × 开关/音量/片段 + 波形裁剪） | **大** |
| 10 | 自定义角色图库 | ✅（8 模型切换） | 中 |
| 11 | 泡泡图库 | ✅（`bubble-imgs` 上传 / 删除 / 权重） | 小 |
| 12 | 余额 / 今日已用 / 峰谷定价 | ❌ | 中（`accounting.mjs` 13KB 可直接借鉴） |
| 13 | 34 个厂商模板 + 自定义 API | ❌ | 大 |
| 14 | Codex 本地会话统计 | ❌ | 中 |
| 15 | 余额预警 / 今日预算 / 每轮消耗提示 | ❌ | 中 |
| 16 | 提问/授权等待提示（音 + 泡） | ✅（`awaiting_approval`/`waiting_input` + 徽标 + 气泡 + 音效） | 小 |
| 17 | 更新检查 + 关于/自检面板 | ❌ | 小 |
| 18 | 移动端适配（触摸拖拽 / 长按） | ❌ | 中 |
| 19 | 安全栅栏三层 | ❌ | 小 |
| 20 | **Live2D 渲染** | ✅ | **我们有它没有的** |
| 21 | **12 态 phase 总线** | ✅ | **我们有它没有的** |
| 22 | **逐 token 流式** | ✅ **日志通道按原始节奏回放**（见 §3.4） | 中 |
| 23 | **多 session 气泡栈** | ❌（M2 待做） | 中 |
| 24 | **131 项自检 + 真实事件回放** | ✅（已扩到 184 项，含流式全链路） | **我们有它没有的** |

### 3.3 A 档落地记录（泡泡与音效，2026-10-15）

**做了什么**（对应上表 #6~#9、#11、#16）

| 能力 | 实现位置 | 关键设计 |
|---|---|---|
| 气泡皮肤（8 款） | `pet-bubble-styles.js` + 管理页「泡泡」tab | 插件身份色（如 DSH 蓝）**优先于**皮肤——气泡颜色跟"谁在说话"走 |
| 点击互动（序列 + 随机） | `live2d-pet.js:showClickTalk()` | 点桌宠按「第 1 次 → 第 2 次 → … → 循环」推进；单项语法 `a\|b\|c` 等权随机、`{image}` 抽图；气泡 **3s** 自动消失 |
| 图片素材库 | `POST/GET/DELETE /api/companion/bubble-images` | ≤5MB、后缀白名单、路径逃逸拒绝；每张图可设**抽取权重** |
| 音效事件（7 类） | `pet-sound.js` | `press/release/switch/task_end/ask/approval/error` 每事件独立 `{enabled, volume, clip}`；无片段走**现场合成音**（零素材依赖） |
| 音效片段库 + 裁剪 | `POST/GET/DELETE /api/companion/sounds` + 管理页波形拖选 | 纯前端 `decodeAudioData → OfflineAudioContext → 手写 WAV 编码 → 上传`，**不引入 ffmpeg** |
| 音频格式要求 | 管理页说明块 + 上传前预校验 | 白名单对齐**浏览器解码能力**：`wav/mp3/ogg/opus/m4a/aac/flac/webm`；明确不支持 WMA/APE/AMR/AIFF/MIDI |

**关键决策：不做浮窗模块卡**（与 whale-widget 分道扬镳）

whale 的 6 类浮窗模块泡泡我们**没有照抄**，理由（用户裁决，三条独立缺陷）：

1. 「Agent 状态」模块与**桌面徽标**信息重复（徽标已实现，且带 4s 淡出与颜色区分）；
2. 「随机语句 / 随机图片」本该是**点击桌宠触发的互动**，而不是常驻浮窗；且应显示在**复用小智的说话气泡框**里（同框/同尾巴/同位置/同打字机节奏）；
3. 浮窗右上角 ✕ 在穿透策略下点不到（悬浮卡片的命中测试与主进程白名单不同步）。

因此 A 档的"泡泡系统"= **一个说话气泡框 + 三种内容形态**（文本 / 图片 / 逐 token 流），
而不是"多浮窗卡片"。这也是"一切皆插件"的必然结果：气泡是**桌宠主体能力**，不该由某个插件自带一套窗口。

### 3.4 M1 逐 token 流式：能力边界（实测，必须知道的限制）

**链路**

```
DSH 会话日志 assistant/message.data.stream[]
   └─ text-chunks 帧（真增量 + 毫秒时基）
        └─ dsh_log_stream.mjs  kind:"stream"       ← 只走增量跟随，历史重放不发
             └─ dsh_adapter.py  _publish_stream()
                  └─ agent_bus_service.stream()  → WS agent_stream
                       └─ 桌宠气泡按 dt 逐块追加 + 收尾用 block-end 权威全文校正
```

**载荷**（实测自真实日志，`texts` 是真逐 token 增量、`dt` 是块间毫秒间隔）

```json
{"type":"text-chunks","time0":1791981757968,"index":0,
 "dt":[41,0,0,0,0,0,0,0,0,15,15,0,13],
 "texts":["I","'ll"," start"," by"," recording"," the"," frozen"," revision"," facts"," before"," doing"," anything"," else","."]}
```

**上限（★ 这条决定对外承诺口径）**

| 事实 | 证据 |
|---|---|
| `assistant/message` **与紧随其后的 `tool/call` 落在同一个 zstd 追加帧** | 2 个会话、3533 个追加帧、**1131 个 stream 事件全部只跨 1 帧**（直方图 `{"1":1131}`） |
| `block-end` 帧带该 block 的**权威完整文本**（用于零丢字校正） | `{"type":"block-end","index":0,"block":{"type":"text","text":"…"}}` |
| `time0` 是首块时间，`ev.time`（事件时间）通常晚 `lead = 1.4s(p50)` | 故文本是**消息生成完成后**才落盘的 |
| 日志通道**没有**任何"边生成边追加"的事件类型 | 全事件类型枚举：`turn/start`、`step/start`、`assistant/message`、`assistant/attempt`、`tool/call`… 无增量文本事件 |

⇒ 结论：**日志通道能做的是"事后按 DSH 原始节奏回放"，不是"边生成边出字"**。
真·实时增量只能走 Host WS `session/follow`（§四"实测选型"表，p90 78ms，需凭据 cookie + 临时端口发现）。
渲染端消费的都是同一条 `agent_stream`，**将来换源不需要动前端**——这是当初把它设计成独立 WS 消息的原因。

**渲染端的三个工程约束**（都有踩坑理由）

1. **节奏下限** `STREAM_MIN_STEP_MS=24`：上游常把几十个 token 一次性 flush（实测 `dt` 多为 0），
   照抄会"啪"地全段出现、等于没有流式感 → 每块间隔取 `max(dt, 下限)`（**只垫高不压低**，真慢就跟着慢）。
2. **总时长封顶** `STREAM_MAX_TOTAL_MS=30s`：防病态日志（实测有单帧 `dt` 累计 30s）把气泡一直挂住；
   超了等比例压缩，保留相对节奏。
3. **收尾校正**：块间拼接可能因上游丢块/重复而与权威全文不一致 → 用 `block-end` 文本覆盖一次，保证**零丢字、零重复**；
   只给了权威全文而没给增量（老日志/丢帧）时，把它当"一整块"直接上屏，**绝不把 `undefined` 写上气泡**。

**只认 `frame === 'text-chunks'`**：`reasoning-chunks`（模型推理草稿）与 `tool-call-chunks`（工具参数分片）
在边车侧就不发；渲染端另有一道 `frame` 白名单兜底——**推理草稿进桌宠气泡是明确的越界**。

### 3.5 踩坑回归：泡泡曾被挂到插件名下

**症状**：停用小智插件后，桌宠的说话气泡**整个消失**。
**根因**（两处，都是"插件越界改核心 DOM"）：

- `xiaozhi-plugin.js` 的 `setXiaozhiUi()` 往核心元素 `#speech-bubble` / `#activity-indicator` 上加了 `.plugin-off`；
- `pet-xz-audio.js` 直接持有 `bubbleEl` / `bubbleTextEl` / `bubbleHideTimer` 自己操作气泡。

**修法**：删掉 `setXiaozhiUi()`，并给核心暴露**唯一入口** `window.__mioPetBubble = { show, hide, isVisible, setEnabled }`；
插件只能经它说话（`xiaozhi` 与小智语音气泡均已改道）。
**验证**：无头浏览器里**停用小智插件后 dump DOM**，断言 `.plugin-off` 计数为 0，且插件唤起气泡仍正常。

**教训**：核心 UI（说话气泡、活动指示器）属于桌宠主体；插件**只能**经核心 API 访问，
不得直接改核心 DOM——否则"关掉某个插件泡泡就没了"会在任何一次插件重构后复发。

---

### 3.2 超越点（我们更强的地方）

| 我们的能力 | whale-widget | 说明 |
|---|---|---|
| **Live2D 骨骼动画** | 静态 PNG | pixi + Cubism 4，可做动作/表情/口型 |
| **12 态语义总线** | 4 种等待态 | `agent_bus_service.py:34-47`；whale 只有 question/approval/结束/预警 |
| **并发工具追踪** | 无 | `active_tools` 计数器，实测峰值并发 6 |
| **多 Agent 汇聚** | 单 Agent（DSH） | 我们的总线本来就是跨 Agent 设计 |
| **真实事件回放测试** | 无 | 131 项自检守住的映射正确性 |
| **子会话识别** | 部分（记住 id 不提示） | 我们用 `delegationDepth=0` 选主会话，whale 无此概念 |

---

## 四、架构选型与三个决策的影响

### 4.1 决策一：砍掉小智 TTS

**影响评估**：

| 项 | 影响 |
|---|---|
| 代码删除 | `routes/xiaozhi.py` 121KB、`system_audio_service.py` 22KB、`pet-xz-audio.js` 口型同步、本地 TTS 兜底 |
| 失去的能力 | 桌宠语音播报、说话口型动画（`voice` phase） |
| **保留的能力** | `voice` phase 本身不删——它降级为"预留态"，未来若有 TTS 插件接入即生效 |
| 需要新增 | 一个 `voice` phase 的"静默降级"策略：有 TTS 源才驱动，无则跳过 |

**落地要求**：
- `agent_bus_service.py` 的 12 态**不删**（`voice` 保留）
- 桌宠渲染层 `PHASE_TO_ACTIVITY` 的 `voice → speaking` **保留**
- 文档明确写："本插件不含 TTS；接入第三方 TTS 后 voice phase 自动生效"
- 这是"插件不依赖插件"的代价，且**可逆**（未来做独立 TTS 插件即可）

### 4.2 决策二：坚持独立置顶穿透窗口

**证据链（三层，从强到弱）**：

| 层 | 证据 | 结论 |
|---|---|---|
| 1. 官方先例 | `_research/pet/**` 全文搜 `BrowserWindow|require('electron')` = **0 命中** | 官方 Live2D 桌宠插件**不建自有窗口**，它接受"Web GUI 内 portal" |
| 2. 官方承认的限制 | `dsh-plugin-wallpaper-engine/README.en.md:342`："That one needs the shell side — the plugin cannot change it" | 官方级插件明确说**改不动壳侧窗口属性** |
| 3. 技术可能性 | DSH 宿主是 Electron 应用，插件跑在其 Node 侧，**理论上**能 `require('electron')` | 【推断】未验证 |

**结论：这不是"能不能"的问题，是"付不付得起"的问题。**

| 路径 | 做法 | 代价 |
|---|---|---|
| **A. 宿主侧起 BrowserWindow** | 插件宿主侧 `require('electron')`，`new BrowserWindow({transparent:true, frame:false, alwaysOnTop:true, skipTaskbar:true})` | **未验证**。若不成立，桌宠降级为 portal，整个"独立窗口"产品定义作废 |
| **B. 保留 Electron 副进程** | fork 的桌宠仍是独立 Electron 应用，但通过 DSH 插件拿事件 | **架构变复杂**：两个进程 + 一个插件，违背"即插即用" |
| **C. Web GUI 内 portal** | 桌宠变成 DSH 窗口右下角的 React portal | 与 whale-widget 同形态；**失去置顶穿透**（不能放到桌面任意位置） |

**我的建议：先做 A 的 spike（半天），不成立就降级 C，但把"独立窗口"作为 v2 目标而非 v1 阻塞项。**

### 4.3 决策三：只抽 DSH 连接插件进 dsh-market

这是仓库定位，影响分包策略：

```
fork 后的仓库结构（建议）：
├── packages/
│   ├── desktop-pet/          # 桌宠主体（独立 Electron 应用，保持现状）
│   └── dsh-connector/        # ★ 只这个进 dsh-market
│       ├── lib/index.js      # 宿主侧：订阅 DSH 事件 → 推给桌宠
│       ├── cordis.patch.yml
│       └── package.json      # "dsh": { "bundle": { "patch": ... } }
├── backend/                  # 桌宠后端（保留，供独立形态用）
└── docs/
```

**`dsh-connector` 的职责边界（关键设计）**：

| 做 | 不做 |
|---|---|
| 订阅 DSH 事件（session/event、assistant-stream、approval、questions） | 不渲染任何 UI（那是桌宠的事） |
| 把事件翻译成标准 phase 词汇 | 不依赖桌宠后端（不 import 它的代码） |
| 通过 WS/HTTP 把 phase 推给桌宠 | 不依赖小智/其它插件 |
| 提供 `/api/dsh-connector/*` 只读接口 | 不做 TTS/记账/余额 |

**证据/依据**：用户明确要求"不同插件之间不应该存在依赖关系，应该是完全独立的"。

---

## 五、推荐架构

### 5.1 总体（两个形态共存）

```
【形态一：独立桌宠（保持现状，立即可用）】
   Electron 桌宠 ←WS→ FastAPI(8000) ←Node边车 tail zstd日志← DSH 会话日志
                                    ←（未来）dsh-connector 推送

【形态二：DSH 插件（本次要做的）】
   ┌──────────────── DSH 进程 ────────────────┐
   │  dsh-connector 插件（宿主侧）             │
   │    ├─ ctx.on('session/event')            │  ← 零解码、零轮询
   │    ├─ ctx.on('agent/assistant-stream')   │  ← 逐 token（新能力）
   │    ├─ ctx.on('approval/request')         │  ← 应答（新能力）
   │    ├─ ctx.on('user-questions/request')   │  ← 应答（新能力）
   │    └─ 12 态 phase 推导（移植本仓库映射）  │
   │            │                              │
   │            └── WS/HTTP 推送 ──┐           │
   └───────────────────────────────┼───────────┘
                                   ▼
                         Electron 桌宠（渲染层）
                         或 DSH Web GUI portal
```

### 5.2 为什么这样分

| 问题 | 答案 |
|---|---|
| 为什么不把桌宠整个做成插件？ | 因为"独立置顶穿透窗口"未验证。做成插件就**放弃**了这个可能 |
| 为什么不只做插件？ | 因为桌宠主体要"即插即用"——没有 DSH 也能跑 |
| `dsh-connector` 依赖桌宠吗？ | **不依赖**。它只输出标准 phase 词汇，任何渲染端都能接 |
| 桌宠依赖 `dsh-connector` 吗？ | **不依赖**。没有它时走 zstd 日志边车（现有链路） |

---

## 六、分阶段实施步骤

### 6.0 进度快照（2026-10-15）

| Phase | 目标 | 状态 | 前置/阻塞 |
|---|---|---|---|
| **Phase 0** | spike：插件宿主侧起 BrowserWindow；定分包结构；删小智 TTS 主链路 | ❌ **未开始** | 无。**0.1 半天，且决定"独立置顶穿透窗口"这个形态能不能成立** |
| **Phase 1** | `packages/dsh-connector` 最小可跑（Cordis 插件 + 事件→phase + 三层栅栏 + 推给桌宠） | ❌ **未开始** | 依赖 0.1（形态定不下来就不该动手） |
| **Phase 2** | B 档：`approval/request` 应答、`user-questions` 选项、**多 session 气泡栈（M2）**、`session/follow` 拿 projections | ❌ **未开始** | 依赖 Phase 1；未验证点 #2~#4 需实跑 |
| **Phase 3** | 桌宠渲染层增强（A 档） | ✅ **已完成**（2026-10-15） | — |
| **Phase 4** | 发布（npm + Electron 安装包 + PROVENANCE） | ❌ **未开始** | 依赖 1/2/3 |

**已落在仓库、不依赖插件形态的资产**（形态一变也照样能用）：

- 日志 tail 摄取链：`dsh_log_stream.mjs`（zstd 逐帧解 + `kind:"stream"`）→ `dsh_adapter.py`（事件→12 态 phase，另开一路 `agent_stream`）→ `agent_bus_service.py`（`announce` / `stream` 透传）→ 桌宠气泡。**12 态 phase 词汇在 `app/kernel/agent_bus_service.py:34`。**
- 验证线：后端 **184 项**（`python -m app.agents.dsh.dsh_adapter_selftest`）+ 渲染端 **15 项**（`node 澪Agent应用/tests/e2e_stream_pet.cjs`）。
- 完整性守卫：`澪Agent应用/scripts/clean-dist.mjs`（默认只核查、退出码可当门禁）。

**下一动作建议**：先只做 **Phase 0.1 的 spike**（半天），拿到"宿主侧能不能起置顶穿透窗口"这个二元结论——它决定后面是走"插件形态"还是退回"独立 Electron 壳 + portal"（§五形态二）。这一步不通的话，Phase 1/2 的具体实现方式要重排，但上面那批已落地的资产不受影响。

### Phase 0：spike 与准备（1 天）

| # | 任务 | 验收标准 |
|---|---|---|
| 0.1 | **spike：DSH 插件宿主侧能否起 BrowserWindow** | 写 20 行最小插件，宿主侧 `require('electron')` + `new BrowserWindow({transparent:true,frame:false,alwaysOnTop:true})`，**看到置顶穿透窗口即成功** |
| 0.2 | 读 `whale-widget-prompt.md`（完整规格，npm 包里没有，需从仓库取） | 输出"哪些规格要继承"清单 |
| 0.3 | 定分包结构（monorepo or 两个目录） | `packages/dsh-connector` 可独立 `pnpm publish --dry-run` |
| 0.4 | 删小智 TTS 相关代码（决策一） | `routes/xiaozhi.py` 移出主链路；`voice` phase 保留但标注"预留" |

> ⚠️ **0.1 不通过就走"形态二的 portal 路径"**，不要卡住后续。

### Phase 1：dsh-connector 最小可跑（3-5 天）

| # | 任务 | 验收标准 |
|---|---|---|
| 1.1 | 按 whale-widget 范式建 `packages/dsh-connector`（package.json + cordis.patch.yml + lib/index.js） | `dsh plugin --profile web add link:...` 装得上 |
| 1.2 | 订阅 `ctx.on('session/event')`，移植本仓库 `event-projection` 映射 | DSH 一说话，控制台打出 phase 变化 |
| 1.3 | 实现 12 态 phase 推导（移植 `agent_bus_service.py:34-47` 词汇 + `phase_for_facts` 逻辑） | 12 态全部可达，单测覆盖 |
| 1.4 | 加安全栅栏三层（照抄 whale-widget:749-774） | 裸 curl 返回 401/403，浏览器里 200 |
| 1.5 | 推送给桌宠（WS 或 HTTP 轮询，先用轮询跑通） | 桌宠能收到 phase 并切换动画 |

### Phase 2：B 档能力（5-7 天，插件化才有的）

| # | 任务 | 验收标准 |
|---|---|---|
| 2.1 | `ctx.on('agent/assistant-stream')`，逐 token 推送 | 桌宠打字机效果，延迟 < 100ms |
| 2.2 | `ctx.on('approval/request')`，桌宠弹允许/拒绝 | 点按钮后 DSH 收到 `allowed-once`/`rejected` |
| 2.3 | `ctx.on('user-questions/request')`，桌宠弹选项 | 选项回传 `{answers:[...]}` |
| 2.4 | 多 session 气泡栈（`MAX_SESSION_BUBBLES=12`） | 3 个 session 并发分别显示 |
| 2.5 | `session/follow` Remote 拿 projections | 气泡显示 contextPressure |

### Phase 3：桌宠渲染层增强（5-7 天）—— **A 档已完成（2026-10-15）**

| # | 任务 | 验收标准 | 状态 |
|---|---|---|---|
| 3.1 | 泡泡系统 | ~~6 类模块 + 逐模块样式 + 拖拽排版~~ → **改为**：气泡皮肤 8 款 + 点击序列 + 图片素材库（含权重） | ✅ 差异化实现（见 §3.3） |
| 3.2 | 随机语句/随机图片（带权重不连续重复） | 与 whale-widget 体验对齐 | ✅ 点击桌宠触发、3s 自动消失、权重可调 |
| 3.3 | 自定义角色图库 + 泡泡图库 | 目录式注册 | ✅ 角色 8 模型；图片库上传/删除/权重 |
| 3.4 | 按压 Q 弹 + 音效系统 | 与 whale-widget 对齐 | ✅ 7 事件独立开关/音量/片段 + 波形裁剪（纯前端） |
| 3.5 | **Live2D 动作/表情映射到 12 态** | 这是我们对 whale-widget 的**代差优势** | ✅ 已有 |
| 3.6 | **M1 逐 token 流式** | 气泡按上游节奏逐块追加 + 收尾零丢字校正 | ✅ 日志通道回放（能力上限见 §3.4） |

**验证方式（两套，都在仓库里可复跑）**

| 层 | 命令 | 覆盖 |
|---|---|---|
| 协议/后端 | `python -m app.agents.dsh.dsh_adapter_selftest` | 184 项，含 [9a] 边车 emit（增量发/历史不发、`dt` 截断、reasoning 不外泄）、[9b] 适配器→总线字段与门控、[9c] 前端契约 |
| 渲染端 | `node 澪Agent应用/tests/e2e_stream_pet.cjs`（Playwright + 注入 WS 桩 + mioDesktop 桩；需后端在跑，`PET_CHROME`/`PET_BASE_URL` 可覆盖） | 15 项：逐块追加采样、节奏、最终校正、新流替换、兜底、frame 白名单、他源接管、自动消失、开关 |

> ⚠ E2E 有一个**必须保留**的 harness 设计：渲染端静态资源**直连磁盘**绕开浏览器缓存。
> 踩过的坑：同一 `?v=` 下改了文件却仍被 Chromium 用缓存，连续 4 次改动都测的是首版代码，
> 表现为"随机失败"，极易误判成产品缺陷。

### Phase 4：发布（2-3 天）

| # | 任务 | 验收标准 |
|---|---|---|
| 4.1 | `pnpm publish` dsh-connector | npm 上可 `dsh plugin add` |
| 4.2 | 更新检查 + 关于/自检面板（照抄 whale-widget） | 版本/路径脱敏 |
| 4.3 | 写 README + PROVENANCE.md | **素材许可如实标注**（whale-widget 的做法值得抄） |
| 4.4 | 桌宠主体独立发布（Electron 安装包） | 无 DSH 也能跑 |

---

## 七、风险与未验证点

### 7.1 未验证点（按危险度）

| # | 未验证点 | 影响 | 怎么验 |
|---|---|---|---|
| **1** | **插件宿主侧能否 `require('electron')` 起 BrowserWindow** | 决定"独立置顶穿透窗口"能否成立 | Phase 0.1 spike，**半天**。⚠ **先验已强烈偏向"不行"**，见下方补证 |
| 2 | `agent/assistant-stream` 的帧结构在本机 DSH 版本上是否一致 | 决定逐 token 能否做 | 已读过源码（`_dsh_src/dsh-llm/lib/types/assistant-stream.js:43-110`），但需实跑验证 |
| 3 | `approval/request` waterfall 的应答协议 | 决定审批应答能否做 | 源码已读（`_dsh_src/dsh-user-approval/lib/index.js:176`），需实跑 |
| 4 | 多 session 时 DSH 事件是否都推给插件 | 决定多气泡栈 | 源码已读（`session/event` 监听全会话） |

#### 7.1.1 未验证点 #1 的本地补证（2026-10-16，读已装插件源码）

本机 DSH profile（`C:\Users\xiao1\.dsh\profiles\desktop\`）已装 6 个第三方插件，可直接取证：

| 插件 | `electron` | `BrowserWindow` | `webContents` | 说明 |
|---|---|---|---|---|
| `dsh-whale-widget` 0.4.2 | 0 | 0 | 0 | 纯 web 层（26 路由 + 注入行） |
| `dsh-better-sidebar` 0.26.0 | 0 | 0 | 0 | 同上，另暴露 sidebar 注册服务 |
| `dsh-plugin-wallpaper-engine` 1.3.2 | 0 | **仅 README 正文 2 处** | 0 | 见下 |

`dsh-plugin-wallpaper-engine/README.md:320` 原文（中文版）：

> 桌面端最小化 / 还原时仍可能有极短的白帧（壳侧）……但窗口**一帧都没有可提交**的那一瞬，露出的是桌面壳的窗口底板（Windows 上 `BrowserWindow` 用的是默认底板色 = 白……）。**这一条要壳侧配合，插件侧改不动。**

⇒ **已装插件的共同工作面 = `webserver` 路由 + `webserver/index-inject` 前端注入行，没有任何一个插件碰过原生窗口。**
结合 §1.3 结论 2（`_research/pet/**` 搜 `BrowserWindow` = 0 命中）。

**结论**：Phase 0.1 的期望值应设为「**大概率不通**」。spike 仍值得跑（半小时能拿到确定答案），但
**Phase 1 的形态不该押在它上面**——按「形态二：独立 Electron 壳 + portal」设计，把插件形态当"如果 spike 意外通过则更优"的加分项。

> ⚠ 顺带发现一条**待清理的悬空配置**：`cordis.patch.yml` 里仍有 `- id: pet / name: "@linxin666/dsh-pet"`（`visible: true, petId: whale-girl`），
> 但 `node_modules/@linxin666/` **目录已空**（2026-10-14 21:35 被清），只剩孤儿状态文件 `.dsh/pet.json`（`lastPetAt` = 2026-10-14 11:49 UTC）。
> 对本案的直接影响：**我们的插件 id 不要用 `pet`**（会和这条残留撞），建议用 `mio-pet` 之类。

### 7.2 已知风险

| 风险 | 缓解 |
|---|---|
| **⚠ fork 出去也改不动前端**（**最高优先**） | `澪Agent应用/` 无 `src`，全仓 `.vue` 计数 = 0；`dist` 由外部源码树构建后拷入，历史修复靠**直接在压缩 bundle 上打补丁**（于是留下 `*.bak` / 旧 hash chunk / 悬空引用——即 `scripts/clean-dist.mjs` 要守的那几类）。**fork 前必须把 Vue 源码回仓并恢复 `vite build` 能力**，否则接手方只能改 minified 产物、还得自己重算 `__vite__mapDeps` 下标 |
| **砍掉 TTS 后 `voice` phase 永不触发** | 文档明确标注"预留态"；渲染层保留映射，不删代码 |
| **DSH 升级破坏插件** | `dsh.engines` 声明最低版本；只用公开 Remote/事件 |
| **whale-widget 是"无 scope"包名** | 我们用 `@scope/name` 避免冲突；发布前查 npm 名可用性 |
| **素材许可** | **代码 MIT 可自由 fork**；素材照抄 whale-widget 的 PROVENANCE 做法，如实标注 as-is |
| **两个形态的配置不同步** | `dsh-connector` 只输出 phase，不持有配置；配置归桌宠 |

### 7.3 whale-widget 踩过的坑（直接继承对策）

| 坑 | 对策 |
|---|---|
| 桌面端注入表只收集一次，插件后加载就进不去 | apply() 第一件事就注册注入行，不等服务 |
| `script-src` 加载失败 reject 整个 boot | 用 `kind:'script'` 内联行，自己吞 onerror |
| 写请求被任意来源调用会外带凭据 | 三层栅栏 + 写操作限回环 |
| 前端改了不生效 | 宿主按 mtime 热读取 + 文档写清"改前端硬刷新、改宿主重启" |
| 诊断信息泄露路径/key | `maskPath()` + 白名单字段 |

---

## 八、附录

### 8.1 whale-widget 与本仓库规模对比

| | whale-widget | 本仓库（ fork 起点） |
|---|---|---|
| 宿主侧 | 259.2 KB | dsh_adapter.py 43.2 KB + agent_bus_service.py 18.3 KB |
| 前端 | 1,115.8 KB | live2d-pet.js 127.9 KB |
| 渲染 | 静态 PNG | Live2D（pixi + Cubism 4） |
| 事件源 | 进程内（插件原生） | Node 边车 tail zstd 日志 |
| phase 词汇 | 4 种等待态 | **12 态** |
| 测试 | 无 | **184 项 + 15 项渲染端 E2E** |
| dist 完整性守卫 | 无 | **`scripts/clean-dist.mjs`（5 类残留 + mapDeps 下标自洽）** |

### 8.2 关键源码位置速查

| 想找什么 | 去哪 |
|---|---|
| 插件挂载声明 | `C:\Users\xiao1\.dsh\profiles\desktop\node_modules\dsh-whale-widget\cordis.patch.yml:13-15` |
| 宿主侧入口范式 | `.../dsh-whale-widget/lib/index.js:723-749` |
| 桌面端注入行 | `.../lib/index.js:706-721` |
| 安全栅栏三层 | `.../lib/index.js:749-774` |
| 事件订阅全量 | `.../lib/index.js:1128-1136` |
| 等待态跟踪 | `.../lib/index.js:1039-1087` |
| 定价表 | `.../lib/index.js` 顶部 `PRICING` |
| assistant-stream 帧结构 | `_dsh_src\dsh-llm\lib\types\assistant-stream.js:43-110` ⚠ **该目录已不在本机，需重新抽取 DSH 源码** |
| approval 应答协议 | `...\dsh-user-approval\lib\index.js:30-35,176` ⚠ 同上 |
| 我们的 12 态词汇 | `私人AI日记系统\backend\app\kernel\agent_bus_service.py:34-47` |
| 我们的事件→phase 映射 | `...\backend\app\agents\dsh\dsh_adapter.py` + 184 项自检 |

### 8.3 环境实测快照（2026-10-14）

| 项 | 状态 |
|---|---|
| 麦克风 | 2 个 ACTIVE（可用） |
| 扬声器 | 注册表 3 个 ACTIVE，SAPI 报 0（**已用 edge-tts 绕过**） |
| SenseVoice 模型 | 本地已有（228MB） |
| 后端 onnxruntime | **未装**（若要本地 ASR 需补装） |
| Electron | 43.3.0，Chromium API 可用 |
| 桌宠窗口 | **需用户手动跑 `start_mio.ps1`**（DSH 沙箱会污染子进程） |

---

## 结语：四句话

1. **照抄 whale-widget 的工程范式**（MIT、3 行 patch、宿主+前端双轨、三层安全栅栏），别自己发明。
2. **先花半天做 spike**：插件宿主侧能否起 BrowserWindow。这一条决定你是做"独立置顶穿透桌宠"还是"DSH 窗口内的 portal"。
3. **砍掉小智 TTS 是对的**——插件不依赖插件；但 `voice` phase 的代码和映射**留着别删**，那是给未来 TTS 插件留的插座。
4. **我们真正的代差优势是 Live2D + 12 态总线 + 131 项测试**，whale-widget 是静态图 + 4 种等待态 + 无测试。别在"记账/音效/泡泡"上和它拼功能密度，那是它的护城河；要在**"桌宠随 DSH 工作状态活起来"**上做到它做不到的。
