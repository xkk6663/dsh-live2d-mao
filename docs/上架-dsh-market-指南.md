# 上架 dsh market 指南

> 目标：让 `dsh-live2d-mao` 出现在 DSH 可视化插件市场（dshmarket）的「Discover」里，
> 用户点一下就能装。

---

## 0. 机制（已源码级确证）

dshmarket 读一个**人工精选的 catalog**（不是自动扫 npm）：

- catalog 权威源 = `github.com/awesome-dsh-plugin/awesome-dsh-plugin` 仓库的 `plugins.json`
- 该 catalog 同时发布成 npm 包 `dsh-plugin-catalog`（国内镜像走它）
- **上架 = 向那个仓库提 PR，在 plugins 里加一条**

所以「上架」和「npm 发布」是**两件事**：
- npm 发布（已完成）→ 用户 `dsh plugin add dsh-live2d-mao` 能装
- catalog 上架（本指南）→ 用户能在市场里**搜到**、点一下装

---

## 1. 登记条目（已按 catalog 格式生成，直接复制）

```json
{
  "name": "dsh-live2d-mao",
  "owner": "xkk6663",
  "url": "https://github.com/xkk6663/dsh-live2d-mao",
  "page": "https://awesome-dsh-plugin.com/p/xkk6663/dsh-live2d-mao/",
  "category": "fun",
  "description": {
    "en": "A DSH-specialized Live2D desktop pet: a real-time skeletal Live2D model (PixiJS + Cubism 4) that lives on your desktop and mirrors DeepSeek Harness's work state through a 12-phase semantic bus — planning / thinking / executing-tool / streaming / waiting-input / awaiting-approval / complete / error. It shows a tool-status bubble (\"working with read…\"), a streaming strip for token-by-token replies, head-badge phase indicator, drag inertia, lock position, Shift-drag, opacity, and 8 built-in models (including the da-feiyu fish). The plugin only pushes events; the pet window itself runs as a companion program.",
    "zh": "DSH 专用 Live2D 桌宠：一只住在桌面上的 Live2D 看板娘（PixiJS + Cubism 4 骨骼动画），通过 12 态语义总线实时映射 DeepSeek Harness 的工作状态——规划 / 思考中 / 执行工具 / 回复中 / 聆听中 / 待确认 / 完成 / 出错。工具状态气泡（「正在用 read 干活…」）、逐 token 流式横条、头顶 phase 徽标、拖拽惯性、锁定位置、Shift 防误拖、不透明度可调、8 款内置形象（含「大肥鱼」）。插件只推事件；桌宠窗口由配套程序提供。"
  },
  "npm": "dsh-live2d-mao",
  "version": "1.0.0",
  "stars": null,
  "downloads": null,
  "downloadsStart": null,
  "downloadsEnd": null,
  "downloadsCheckedAt": null,
  "capabilities": [
    "fs-read",
    "network"
  ],
  "capabilityRedLines": [],
  "capabilityCheckedAt": null,
  "install": "dsh plugin --profile web add dsh-live2d-mao",
  "added": "2026-10-17",
  "screenshots": [
    "https://raw.githubusercontent.com/xkk6663/dsh-live2d-mao/HEAD/docs/images/hero-dsh-desktop.jpg",
    "https://raw.githubusercontent.com/xkk6663/dsh-live2d-mao/HEAD/docs/images/tool-bubble.jpg",
    "https://raw.githubusercontent.com/xkk6663/dsh-live2d-mao/HEAD/docs/images/motion-expression.jpg"
  ]
}
```

### 字段说明（提交前核对）

| 字段 | 值 | 说明 |
|---|---|---|
| `name` | `dsh-live2d-mao` | 插件名（与 npm 包名一致） |
| `owner` | `xkk6663` | GitHub 用户名（你的） |
| `url` | `https://github.com/xkk6663/dsh-live2d-mao` | 仓库地址 |
| `category` | `fun` | 桌宠类都归「娱乐」（对标 dsh-pet-live2d、dsh-whale-musume） |
| `npm` | `dsh-live2d-mao` | 已发布的包名 |
| `version` | `1.0.0` | 已发布版本 |
| `capabilities` | `fs-read`, `network` | 插件实际能力：读 DSH 会话事件 + HTTP 推送到桌宠后端（不写文件、不 shell） |
| `install` | `dsh plugin --profile web add dsh-live2d-mao` | 一键安装命令 |
| `screenshots` | 3 张 | 指向我们仓库 `docs/images/` 的图 |

> ⚠ `stars`/`downloads` 等统计字段填 `null`——这些是 catalog 侧每日探测自动填的，提交时留空即可（看 catalog 里其他新条目都是 `null`）。

---

## 2. 提交步骤（需要你在 GitHub 上操作）

我没有 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库的写权限，这一步必须你来：

1. **Fork** `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
2. 在 fork 里找到 **`plugins.json`**（或 catalog 源文件，可能是分目录，找桌宠类 `fun` 分类）
3. 在 `plugins` 数组里加**上面的条目**（按 name 字母序插入到合适位置）
4. 提交 + 提 **PR** 到上游
5. PR 标题建议：`Add dsh-live2d-mao (DSH-specialized Live2D desktop pet)`

> 参考：catalog 里有几十个 `dsh-pet` 类条目，说明这类 PR 是常规操作，merge 门槛不高。
> 可先看一个同类 PR（搜 `dsh-pet-live2d` 或 `dsh-whale-musume` 的历史 PR）照抄格式。

---

## 3. 验证（merge 后）

catalog 是每日构建的，merge 后**最多 24 小时**生效。生效后：

1. 打开 DSH → 设置 → Plugin Market → Discover
2. 搜 `dsh-live2d-mao` 或「桌宠」
3. 应能看到我们的卡片（含大肥鱼截图 + 一键安装按钮）

---

## 4. 备选：如果不想走 PR

如果 PR 流程太慢，还有一个**立即生效**的临时方案（不推荐长期用）：

- 用户仍可用 `dsh plugin --profile web add dsh-live2d-mao` 直接装（已可用）
- 只是市场里「搜不到」，需要用户知道包名

所以 **npm 发布已经保证了「能装」**，上架只是「能被搜到」的加分项。
