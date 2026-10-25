# SKILL · 给 Mio 桌宠加一个插件（通用开发规则）

> 本文是「一切皆插件」的**唯一权威操作手册**。
> 目标：新增一个 Agent/功能插件时，**不改通用代码**，只加自己的目录与声明，
> 天然满足「插件之间零依赖、即插即用、可独立启停」。
>
> 参考实现（照抄即可）：`澪Agent应用/dist/plugins/feiyu/`（大肥鱼）、
> `澪Agent应用/dist/plugins/dsh/`（DSH）。

---

## 0. 一句话架构

```
kernel/plugin-registry.js   插件注册表（纯聚合，不认识任何具体插件）
kernel/plugin-nav.js        左侧导航 + 设置页 tab 的挂载器（同样不认识具体插件）
plugins/<name>/manifest.js  插件自报家门：我是谁、我要哪些入口
plugins/<name>/<name>-panel.js  插件自己的界面与数据访问
```

**kernel 只做三件事**：收集 manifest、按可见性显隐、把面板塞进宿主容器。
它**永远不 import 任何插件的代码**，插件也**永远不 import kernel 的内部实现**。

### 0.1 两类插件：可热插拔 vs 内置

| 类型 | manifest 标记 | 可见性 | 例子 |
|---|---|---|---|
| **可热插拔** | 默认 | 跟随后端 `/agents` 的 enabled；停用后入口整体消失 | `dsh`、`feiyu` |
| **内置（宿主本体）** | `builtin: true` | **恒可见**，不看 enabled，不提供启停入口 | `pet`（桌宠本体）|

内置插件的意义：桌宠这个项目**本身就是桌宠**，桌宠不能"被卸载"。
但它在形态上仍是一个标准插件（有 manifest、panel、走同一套挂载流程），
将来要换一个桌宠形态，只需替换这个 `builtin` 插件，kernel 一行都不用改。

判断可见性**统一走 `__mioPluginRegistry.visible(id)`**，不要在别处自己写一套：

```js
visible(id) => isBuiltin(id) ? true : enabled[id] === true
```

---

## 1. 最小插件 = 2 个文件 + 2 行 HTML

> **用户原话（2026-10-25）**：「新增插件步骤：左侧新增功能页面，设置页新增设置页面 tab，这个意思」
>
> 所以一个插件最多做**两件事**，各自独立、可只做其一：
> 1. **左侧新增功能页** → 在 `manifest.nav.keywords` 声明，并由自己的 panel 注入一个 `nav` 按钮；
> 2. **设置页新增设置 tab** → 在 `manifest.settingsTab` 声明（会追加到**最右侧**）。
>
> 两处都**不需要改 kernel、不需要改通用设置面板**。

### 1.1 `plugins/<name>/manifest.js`

```js
window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['<agent_id>'] = {
  agentId: '<agent_id>',        // ★ 必须等于后端 /api/companion/agents 的 agent_id
  name: '显示名',

  // ① 左侧功能页 —— 三种合法形态，按需选一种：
  //   nav: null                            不参与左侧导航（桌宠本体就这样）
  //   nav: { keywords: [...], mode:'own' }  插件自己 append 导航按钮（DSH）
  //   nav: { keywords: [...], mode:'host' } 导航按钮由原版 Vue 硬编码渲染，
  //                                          插件只声明 keywords 让 kernel 控制显隐（大肥鱼）
  nav: { keywords: ['显示名'], mode: 'own' },

  // ② 设置页 tab（不做设置页就整段省略）
  settingsTab: { id: '<name>', label: '显示名', order: 100, panel: '<name>-panel' },
}
```

**`nav.mode` 的区别很重要**：

| mode | 谁创建按钮 | 适用 |
|---|---|---|
| `own` | 插件 panel 里 `nav.appendChild(navBtn)` | 全新插件（原版没有这个入口）|
| `host` | 原版 Vue 渲染（如大肥鱼的 navItems） | 该功能本来就是应用内置页面，只是要能随插件停用而隐藏 |

选 `own` 却同时存在原版同名按钮 ⇒ **会出现两个入口**；
选 `host` 却在 panel 里再 append ⇒ 同样重复。
契约检查脚本 `check_plugin_contract.cjs` 会断言两者的匹配关系。

### 1.2 `plugins/<name>/<name>-panel.js`

```js
(function () {
  if (window.__mioMyPanelLoaded) return   // 幂等，防重复注入
  window.__mioMyPanelLoaded = true

  function renderInto(host) {
    host.innerHTML = ''                   // 每次先清空
    /* 自己造 DOM、自己拉自己的接口 */
  }

  // ★★ 导出名必须与 manifest.settingsTab.panel 完全一致（R7）
  window['<name>-panel'] = { renderInto }
})()
```

### 1.3 `dist/index.html` 加两行

```html
<!-- manifest 必须晚于 kernel/plugin-registry.js -->
<script defer src="./plugins/<name>/manifest.js?v=YYYYMMDD-x1"></script>
<!-- panel 只要晚于 manifest 即可 -->
<script defer src="./plugins/<name>/<name>-panel.js?v=YYYYMMDD-x1"></script>
```

**加载顺序是硬约束**：
`plugin-registry.js` → `plugins/*/manifest.js` → `kernel/plugin-nav.js` → `plugins/*/*-panel.js`

---

## 1.4 设置页 tab 的挂载契约（kernel 侧）

通用设置面板的真实 DOM 结构（由 `settings-panel-inject.js` 的 `buildTabs()` 产生）：

| 元素 | 用途 |
|---|---|
| `#mioSetTabs` | tab 按钮容器（原生按钮带 `data-tab`）|
| `#mioSetBody` | 内容区 |

kernel 的行为：

1. 找 `#mioSetTabs`；**不存在就 500ms 重试**（面板首次打开时才创建）；
2. 为每个声明了 `settingsTab` 且 panel 可用的插件建一个按钮，**`appendChild` 追加到最右侧**；
3. 样式与原生 tab 完全一致（内联同一套 CSS 变量）；
4. 点击 → 隐藏 `#mioSetBody` 里的原生内容 → 把插件面板塞进一个独立 `div` 并 `renderInto`；
5. 点原生 tab → 收起插件面板、恢复原生内容；
6. 可见性统一走 `__mioPluginRegistry.visible(id)`（内置插件恒可见）。

---

## 2. 六条铁律（违反必踩坑）

| # | 规则 | 为什么 |
|---|---|---|
| **R1** | **agentId 必须与后端 agent_id 完全一致** | 写错 ⇒ enabled 永远 false ⇒ tab 和导航**永久隐藏**，表现为"插件装了但什么都不出现"（大肥鱼实测踩过：后端是 `cloud_feiyu` 不是 `feiyu`）|
| **R2** | **只调自己的接口** | 插件读别人的 API 会形成隐式耦合，别人一改你就崩 |
| **R3** | **只写自己的设置键** | 提交 `PATCH /api/companion/settings` 时只带自己的键；带了别人的键会覆盖别人的值 |
| **R4** | **DOM 自愈** | Vue 重渲染会**删掉**手动 append 的导航按钮。必须用 `MutationObserver` + 兜底 `setInterval` 检测并补回（见 `feiyu-panel.js` 末尾）|
| **R5** | **气泡配色各不相同** | `bubble.accent` 是插件在聊天界面/气泡的身份识别色，重复了就分不清谁在说话 |
| **R6** | **幂等可重入** | `if (window.__xxxLoaded) return`；`renderInto` 每次先 `host.innerHTML = ''` |
| **R7** | **导出名 = manifest.panel** | manifest 写 `panel: 'feiyu-panel'`，panel 就必须 `window['feiyu-panel'] = {...}`。名字对不上 ⇒ kernel 找不到面板 ⇒ **tab 永不出现**（大肥鱼实测踩过：只挂了 `__mioFeiyuPanel`）|
| **R8** | **tab 追加到最右侧** | 插件 tab 一律 `appendChild`，排在原生 tab（资料/桌宠/个性化/主题）之后；不要抢最左边。`order` 只决定插件之间的相对次序 |
| **R9** | **导航入口只能有一个** | 原版 Vue 已经硬编码的入口（如 `feiyu-chat`）必须用 `nav.mode:'host'`，**不许**在 panel 里再 append 一个；原版没有的入口才用 `mode:'own'` 自己建。选错 = 左侧出现两个同名入口 |

---

## 3. 启停联动怎么生效

1. 用户在「对话页右侧 rail → Agent 工具」勾选/取消某个插件；
2. 前端 `POST /api/companion/agents/<agent_id>/enabled`；
3. `kernel/plugin-nav.js` 每 8s（或被事件触发）拉 `/api/companion/agents`；
4. 按 `manifest.nav.keywords` 显隐左侧导航；
5. 按 `manifest.settingsTab` 显隐设置页 tab。

**插件代码里的 enabled 判断不是必需的**——显隐由 kernel 统一负责。
如果插件有后台行为（如轮询），再自行判断一次 `__mioPluginRegistry.isEnabled(agentId)`。

---

## 4. 常见错误排查表

| 症状 | 最可能的原因 |
|---|---|
| **设置页完全没有我的 tab** | ① 导出名 ≠ `manifest.settingsTab.panel`（R7）；② panel 对象没有 `renderInto`；③ panel 脚本在 `defer` 里但 kernel 先跑了（轮询/500ms 重试应自动补上）|
| 设置页 tab 跑到最左边了 | 用了 `insertBefore(firstChild)` 而不是 `appendChild`（R8）|
| tab 有、点了空白 | `renderInto` 抛异常了；打开控制台看报错 |
| 左侧导航没有入口 | `manifest.nav.keywords` 与按钮文本对不上，或 agentId 不对导致被判定为 disabled |
| 入口偶尔消失 | 没做 R4 的自愈（Vue 重渲染删掉了节点）|
| 改了设置没生效 | 提交的键不在后端 `CompanionSettings` 白名单里（被 pydantic 静默丢弃）|
| 调接口 404 | 端点名是凭想象写的 —— **先 `grep @router` 确认真实路径再写**（踩过：`/control` 实际是 `/start`/`/stop`）|
| 两个插件互相影响 | 违反 R2/R3：读了别人的接口或写了别人的键 |

---

## 5. 后端侧配套（若插件需要新配置键）

新增一个设置键要**同步四处**，缺一处就表现为"改了没反应"：

1. `app/routes/companion.py` → `class CompanionSettings` 加 pydantic 字段
2. `app/companion/companion_service.py` → `DEFAULT_CONFIG` 加默认值
3. `app/companion/configuration.py` → **两处**归一化（`load_config()` 与 `normalize()` 各一段）
4. 插件自己的 `renderInto` 里加控件

---

## 6. 提交前门禁

```powershell
cd C:\Users\xiao1\Mao-dsh-pet\澪Agent应用

# 手写注入层改动：先用 node --check 过语法
node --check dist\plugins\<name>\<name>-panel.js
node --check dist\plugins\<name>\manifest.js
node --check dist\kernel\plugin-nav.js

# 清理孤儿产物（可能要多跑两次）后过守卫
node scripts/clean-dist.mjs --apply
npm run guard          # 必须 exit 0
```

改 Vue 源码时额外：`node_modules\.bin\vite build` → `compose-dist` → `trim-pages` → `clean-dist` → `guard`
（`npm run build:dist` 在某些环境下会 `spawn EPERM`，逐个跑更稳）。

---

## 7. 现有插件清单

| 插件 | 目录 | 类型 | 提供能力 | 强调色 |
|---|---|---|---|---|
| 桌宠 `pet` | `plugins/pet/` | **内置**（不可热插拔）| 设置页「桌宠」本体面板（**接管**原生同名 tab）：形象/外观/交互 + 与托盘右键菜单同源的操作 | `#4C8798` 青 |
| 大肥鱼 `feiyu` | `plugins/feiyu/` | 可热插拔 | **仅**设置页「大肥鱼」tab（观察/提示词/语音/成本）| `#E08A9B` 鲑鱼粉 |
| DSH `dsh` | `plugins/dsh/` | 可热插拔 | 左侧导航「DSH」实时状态页、体检条目 | `#4F6BED` 靛蓝 |

### 关于「左侧功能页」的现状

- **目前只有 DSH 建了左侧功能页**（`nav: { keywords: ['DSH'] }` + 自己的 nav 按钮）。
- **大肥鱼不建左侧页**（`nav: null`）：用户裁决「设置页新增设置页面 tab」——它只需要设置页 tab。
  历史上它曾往左侧 nav 插过「大肥鱼」按钮，已删除。
- **桌宠**左侧入口由原版 Vue 渲染（固定导航），插件只接管设置页。

> 契约检查脚本 `probe_tmp/check_plugin_contract.cjs` 会断言：
> 「声明了 nav ⇒ panel 必须真的建导航按钮；没声明 ⇒ 不许建」，
> 防止再出现「manifest 说没左侧页、panel 却偷偷插了一个」的漂移。

### 保存按钮的归属（重要）

设置面板**底部已有统一保存条**（`#mioSetSave` / `#mioSetCancel`）。
插件面板**不要自带保存按钮** —— 否则页面里会出现两个「保存」，用户不知道该点哪个（已被实拍确认）。

插件端正解：控件走「输入即保存」（debounce 400ms），或依赖底部保存条。
如果插件的键不在底部保存条的白名单里，就必须自己做 debounce 保存。

### 设置页 tab 归属

账号 `agentId` 必须与后端 `/api/companion/agents` 的 agent_id 一致：
`pet`（本体，无 agents 记录）/ `cloud_feiyu`（大肥鱼）/ `dsh`。

| tab | 归属 |
|---|---|
| 资料 / 个性化 / 主题 / 泡泡 | 通用面板 `settings-panel-inject.js` |
| 桌宠 | `pet` 插件（**接管**原生同名 tab：隐藏原生、插回原位置）|
| 大肥鱼 | `feiyu` 插件（追加到最右侧）|
| ~~语音~~ | **已删除**（2026-10-25 用户裁决），配置归 `feiyu` |

### 与托盘右键菜单的对应

桌宠插件页的操作与 `live2d-desktop/main.js` 的 `updateTrayMenu()` **执行同一批后端接口**：

| 托盘菜单项 | 插件页对应 | 接口 |
|---|---|---|
| 显示桌宠 | 显示桌宠 | `PATCH /api/companion/position` |
| 固定并穿透 | 固定并穿透 | `PATCH /api/companion/settings` |
| 打开对话横条 | 对话横条 | `PATCH /api/companion/settings` |
| 导入 Live2D 模型 | 扫描模型目录 | `GET /api/companion/live2d/models` |
| 桌宠管理 | 打开管理页 | 切左侧「设置」导航 |
| 退出桌宠 | 启动/停止桌宠 | `POST /api/companion/start` · `/stop` |

⚠️ 注意 `live2d/models/import` 需要 `source_path`（Electron 目录选择器给的），
网页侧拿不到本地路径，所以只做"重新拉列表"。

---

## 8. 迁移进度备注

- ✅ 大肥鱼：观察/提示词/字数上限/语音/成本共 16 个键已迁入 `feiyu` 插件；左侧页已删。
- ✅ 桌宠本体：形象/外观/交互 + 右键菜单同源操作已迁入 `pet` 插件（builtin），并接管原生「桌宠」tab。
- ✅ 语音 tab：已从通用面板删除，配置归 `feiyu`。
- ⏳ 仍在通用面板（`settings-panel-inject.js`）的历史配置：
  泡泡工坊（`bubble-panel-inject.js`）、横条主题、资料/个性化。
  这些**应逐步按本文规则迁成独立插件**，通用面板最终只保留「资料」这类宿主级能力。

### 与托盘右键菜单的对应

桌宠插件页的操作与 `live2d-desktop/main.js` 的 `updateTrayMenu()` **执行同一批后端接口**：

| 托盘菜单项 | 插件页对应 | 接口 |
|---|---|---|
| 显示桌宠 | 显示桌宠 | `PATCH /api/companion/position` |
| 固定并穿透 | 固定并穿透 | `PATCH /api/companion/settings` |
| 打开对话横条 | 对话横条 | `PATCH /api/companion/settings` |
| 导入 Live2D 模型 | 扫描模型目录 | `GET /api/companion/live2d/models` |
| 桌宠管理 | 打开管理页 | 切左侧「设置」导航 |
| 退出桌宠 | 启动/停止桌宠 | `POST /api/companion/start` · `/stop` |

⚠️ 注意 `live2d/models/import` 需要 `source_path`（Electron 目录选择器给的），
网页侧拿不到本地路径，所以只做"重新拉列表"。

---

## 8. 迁移进度备注

- ✅ 大肥鱼：观察/提示词/字数上限/语音/成本共 15 个键已从通用面板迁入 `feiyu` 插件。
- ✅ 桌宠本体：形象/外观/交互 + 右键菜单同源操作已迁入 `pet` 插件（builtin）。
- ✅ 语音 tab：已从通用面板删除，配置归 `feiyu`。
- ⏳ 仍在通用面板（`settings-panel-inject.js`）的历史配置：
  泡泡工坊（`bubble-panel-inject.js`）、横条主题、资料/个性化。
  这些**应逐步按本文规则迁成独立插件**，通用面板最终只保留「资料」这类宿主级能力。
- 通用面板里给大肥鱼/语音留了**指引文案**，而不是硬删入口——避免用户找不到设置。
