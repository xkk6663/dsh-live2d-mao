# SKILL：插件发布与版本迭代全流程

> 版本：v1 ｜ 2026-10-19 ｜ 适用：`dsh-live2d-mao`（DSH 专用 Live2D 桌宠）
> 定位：**可照做的操作手册**。每一步都有命令、验收标准和踩坑记录。
> 前置阅读：`AGENTS.md`（工程纪律）、`docs/版本维护与迭代指南.md`（版本语义）

---

## 0. 全景：三条独立链路

发布一个插件版本，实际是**三条互不相干**的链路，必须分别完成：

```
① npm 发布 ──────────→ 用户 `dsh plugin add dsh-live2d-mao` 能装
   （必需）              市场里「检查更新」也能看到新版

② GitHub 推送 ───────→ 仓库首页、README 展示页、源码可见性
   （必需）              https://github.com/xkk6663/dsh-live2d-mao

③ dsh market 上架 ───→ 用户在可视化市场里**搜到**、点一下装
   （只有首次需要）      https://awesome-dsh-plugin.com
```

**关键认知**：
- ①② 每次发版都要做
- ③ **只有首次上架需要提 PR**；之后版本更新由 catalog 每日探测自动跟踪，不用再提 PR
- 完成 ① 之后，插件就已经「可用」了；③ 只影响「可发现性」

---

## 1. 发布前检查（Gate）

在动手发版前，四条门禁必须全绿。**任何一条红都不许发。**

```powershell
cd C:\Users\xiao1\Mao-dsh-pet

# ① 插件测试（223 项）
cd packages\dsh-live2d-mao
node --test test/architecture.test.js test/bubble-stack.test.js test/entry.test.js `
  test/fence.test.js test/m7-protocol.test.js test/phases.test.js test/push.test.js `
  test/stream.test.js test/strip-remote.test.js test/strip.test.js
# 期望：tests 223 / pass 223 / fail 0

# ② 后端自检（201 + 63 项）
cd ..\..\私人AI日记系统\backend
.venv\Scripts\python.exe -m app.agents.dsh.dsh_adapter_selftest    # 期望 201/201
.venv\Scripts\python.exe -m app.agents.dsh.ingest_selftest         # 期望 63/63

# ③ 前端门禁 + E2E（18 项）
cd ..\..\澪Agent应用
npm run guard                                                      # 期望「全部通过」
node tests/e2e_stream_pet.cjs                                      # 期望 18/18

# ④ 打包内容校验（不进仓库，只看清单）
cd ..\packages\dsh-live2d-mao
npm pack --dry-run
```

### `npm pack --dry-run` 验收标准

必须满足：
- ✅ `total files` 在 19~25 之间（含 5 张截图时 25）
- ✅ **不含** `lib/push/transports/mock.js`（测试专用，已在 `files` 里用 `!` 排除）
- ✅ **不含** `test/` 目录
- ✅ **包含** `screenshots.json` + `assets/`（5 张截图，市场展示用）
- ✅ `package.json` 里 `dsh.bundle.patch` 指向 `./cordis.patch.yml`

> ⚠️ **E2E 偶发失败**：整脚本连跑时 `[2] 气泡内容被新流替换` 约 1/3 概率失败（harness 投递竞争）。
> 判定方法：**连跑 3 次**，若 2 次以上全绿则视为通过；若稳定失败才是真回归。

---

## 2. 版本号：两个地方要同步

这是**最容易漏**的一步。项目有两个独立的「版本」概念：

| 版本源 | 文件 | 用途 | 谁读它 |
|---|---|---|---|
| **npm 包版本** | `packages/dsh-live2d-mao/package.json` 的 `version` | npm 发布、市场更新检测 | npm、dshmarket |
| **项目版本** | `CHANGELOG.md` 顶部 `## vX.Y.Z（日期）` | 显示在 DSH 面板「关于」页 | `about_service.read_mio_version()` |

**规则**：发版时**两个都要改，且保持一致**。

```powershell
# 改 npm 版本（自动写 package.json）
cd packages\dsh-live2d-mao
npm version patch    # 1.0.1 → 1.0.2（修 bug）
# npm version minor  # 1.1.0（加功能，向后兼容）
# npm version major  # 2.0.0（破坏性改动）
```

> ⚠️ 用 `npm version` 会**自动打 git tag + commit**。若想在 CHANGELOG 一起提交，
> 用 `npm version patch --no-git-tag-version`，然后手动 commit + tag。

然后**手动编辑 `CHANGELOG.md`**，在 `---` 之后、上一个版本之前插入：

```markdown
## vX.Y.Z（YYYY-MM-DD）· **一句话标题**

- **改动点**：具体做了什么
- **影响面**：影响哪些功能/文件
- **验证**：怎么验证的
```

---

## 3. 提交与推送（链路 ②）

```powershell
cd C:\Users\xiao1\Mao-dsh-pet

# ⚠️ 关键：确认当前分支是 dsh-only-slim（不是 main！）
git branch --show-current
# 若不是，切回来：
# git checkout dsh-only-slim

git add -A
git commit -m "vX.Y.Z: 一句话说明" -m "详细说明（改了什么、为什么、怎么验证）"

# 推送到 GitHub 的 main 分支（本地分支叫 dsh-only-slim）
git push origin dsh-only-slim:main

# 打 tag（可选但推荐）
git tag -a vX.Y.Z -m "vX.Y.Z 说明"
git push origin vX.Y.Z
```

### 🚨 分支陷阱（真实踩过）

**本项目本地分支是 `dsh-only-slim`，GitHub 上是 `main`。** 两者通过
`dsh-only-slim:main` 映射推送。

**症状**：某次操作把当前分支切到了 `main`（v4.2.1 基线），
结果所有新文档/代码「凭空消失」，实际是切到了旧分支。

**发布前必查**：
```powershell
git branch --show-current   # 必须是 dsh-only-slim
git log --oneline -3        # 确认最新提交是你要发的
```

**如果发现文件"消失"**：先查分支，别急着找文件。

---

## 4. npm 发布（链路 ①）

### 4.1 凭证配置（一次性，永久生效）

npm 账号开了 2FA，需要 **bypass 2FA 的 granular token**。
配置一次后永久有效：

```powershell
# 写入 git 凭证存储（GCM），之后 git push 免交互
$tok = "npm_xxxxxxxx"   # 从 npm 网站创建的 Granular Access Token
"protocol=https`nhost=github.com`nusername=xkk6663`npassword=$tok`n`n" | git credential approve
```

**创建正确 token 的要点**（在 https://www.npmjs.com/settings/xkk6663/tokens）：
1. Token type 选 **Granular Access Token**（不是 Classic）
2. Permissions 选 **Packages and scopes → Read and write**（必须含 write）
3. 生成后复制完整的 `npm_...` 字符串

> ⚠️ **踩过的坑**：
> - Classic token 发布会被 403 拒绝（`Two-factor authentication or granular access token with bypass 2fa enabled is required`）
> - `NODE_AUTH_TOKEN` 环境变量对 `npm publish` **无效**，必须写进 `.npmrc` 或命令行参数
> - 用户级 `~/.npmrc` 里的旧 token 会**优先于**命令行参数，冲突时要先更新 `.npmrc`

### 4.2 执行发布

```powershell
cd C:\Users\xiao1\Mao-dsh-pet\packages\dsh-live2d-mao
npm publish
```

**成功标志**：
```
+ dsh-live2d-mao@X.Y.Z
```

### 4.3 ⚠️ 首次发布特有的「假失败」

新包名首次发布时，npm 返回 **HTTP 202（异步受理）**，
registry 会先放一个 **`0.0.0-stage` 占位符**：

```json
{
  "description": "Temporary package placeholder for staged publishing",
  "versions": ["0.0.0-stage"]
}
```

**这不是失败**，是真版本还在处理中（约 30 秒~几分钟）。

**验证方法**（等待后重查）：
```powershell
npm view dsh-live2d-mao versions --json
# 等到同时出现 "0.0.0-stage" 和 "1.0.0" 两个版本即成功

npm view dsh-live2d-mao dist-tags --json
# 期望：{ "latest": "1.0.0" }
```

> `0.0.0-stage` 会永久留在版本列表里，**无害，不要试图删除**。

---

## 5. 实机验证安装（发版必做）

发布成功 = registry 上有包，**不等于**用户能装上。
必须实机验证：

```powershell
$dsh = "C:\Users\xiao1\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# ① 清理旧版（模拟全新用户）
& $dsh plugin --profile web remove dsh-live2d-mao

# ② 清 pnpm 元数据缓存（否则可能装到旧版本！）
& $dsh plugin --profile web store prune

# ③ 安装
& $dsh plugin --profile web add dsh-live2d-mao

# ④ 验证装的是新版本
$p = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-live2d-mao"
(Get-Content "$p\package.json" -Raw | ConvertFrom-Json).version
Test-Path "$p\screenshots.json"    # 应为 True
```

### 验收标准

| 检查项 | 期望 |
|---|---|
| 安装命令 | 无报错，输出 `+ dsh-live2d-mao ^X.Y.Z` |
| 包目录 | `~/.dsh/profiles/web/node_modules/dsh-live2d-mao` 存在 |
| 版本 | 与刚发布的版本一致 |
| `screenshots.json` | 存在 |
| `assets/` | 5 张截图存在 |
| 进配置树 | `dsh --profile web --dump-config` 输出含 `- id: dsh-live2d-mao` |
| 运行时加载 | 启动 DSH 后访问 `/dsh-live2d-mao/status`，**404 表示未加载，401 表示已加载**（401 是安全栅栏正常拒绝匿名） |

### 🚨 pnpm 缓存陷阱（真实踩过）

装了旧版后，`dsh plugin add dsh-live2d-mao` 会报 **`Already up to date`** 而不升级。

**原因**：pnpm 的元数据缓存 + lockfile 锁死了旧版本。

**解法**（按顺序试）：
```powershell
# ① 指定确切版本
& $dsh plugin --profile web add "dsh-live2d-mao@1.0.2"

# ② 若仍不行，清缓存
& $dsh plugin --profile web store prune
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\pnpm-lock.yaml" -Force
& $dsh plugin --profile web add dsh-live2d-mao
```

---

## 6. dsh market 上架（链路 ③，仅首次）

### 6.1 机制（源码级确证）

dshmarket **不是自动扫 npm**，而是读一个**人工精选的 catalog**：

```
awesome-dsh-plugin 仓库的 data/plugins/*.yml（一个插件一个文件）
        ↓ 构建时聚合
plugins.json（发布到 GitHub Pages + npm 包 dsh-plugin-catalog）
        ↓
dshmarket 客户端读取
```

**上架 = 向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，新增一个 YAML 文件。**

### 6.2 前置硬门槛（缺一不可）

| 门槛 | 检查方式 | 说明 |
|---|---|---|
| `package.json` 声明 `dsh.bundle` | 自查 | 只有 `dsh.client` 不可安装，CI 会拒 |
| **仓库满 1 天** | `created_at` 距今 ≥ 24h | 新仓库要等，CI 自动复审 |
| **加 `dsh-plugin` topic** | GitHub 仓库页 ⚙️ About → Topics | 硬性要求 |

**加 topic 的命令**（用 token 调 API）：
```powershell
$h = @{ Authorization = "Bearer $env:GITHUB_TOKEN"; Accept = "application/vnd.github+json" }
Invoke-RestMethod -Uri "https://api.github.com/repos/xkk6663/dsh-live2d-mao/topics" `
  -Method Put -Headers $h -ContentType "application/json" `
  -Body (@{ names = @("dsh-plugin","live2d","desktop-pet") } | ConvertTo-Json)
```

### 6.3 投稿文件格式

文件路径：`data/plugins/<owner>__<repo>.yml`（**双下划线**）

**monorepo 子包的情况**（本项目就是）：
```yaml
# 文件名：xkk6663__dsh-live2d-mao--packages-dsh-live2d-mao.yml
url: https://github.com/xkk6663/dsh-live2d-mao/tree/main/packages/dsh-live2d-mao
name: xkk6663/dsh-live2d-mao#dsh-live2d-mao
category: fun
description:
  en: 'One-line description ending with a period.'
  zh: '一句话描述，以句号结尾。'
```

**字段规则**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `url` | ✅ | 必须与仓库**完全一致**；monorepo 指向子目录 |
| `name` | ✅ | `owner/repo`；monorepo 用 `owner/repo#subname` |
| `category` | ✅ | 见下方分类表 |
| `description.en` | ✅ | 一行、以句号结尾 |
| `description.zh` | 可选 | 写不了维护者会补；建议写 |

**❌ 绝对不能写的字段**（会被 CI 校验拒绝）：
- `npm:` / `version:` / `screenshots:` / `capabilities:`
- 这些**由构建脚本自动采集**，手写会冲突

**category 取值**（23 个）：
```
agi ui usage theme model identity session memory tools wsl browser vision
voice docs skill workflow git notify dev security remote market fun
```

> 桌宠类插件 → **`fun`**（娱乐）。参考 catalog 里 `dsh-pet-live2d`、`dsh-whale-musume` 都在 `fun`。

**⚠️ YAML 语法陷阱**：描述含 `: `（冒号+空格）**必须加单引号**，否则 YAML 会当嵌套键解析失败。

### 6.4 提 PR 流程

```powershell
# ① Fork（用 token 调 API）
$h = @{ Authorization = "Bearer $env:GITHUB_TOKEN"; Accept = "application/vnd.github+json" }
Invoke-RestMethod -Uri "https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/forks" `
  -Method Post -Headers $h -ContentType "application/json" -Body '{}'

# ② 在 fork 里创建 YAML 文件（内容 Base64 编码后 PUT）
$content = @"
url: https://github.com/xkk6663/dsh-live2d-mao/tree/main/packages/dsh-live2d-mao
name: xkk6663/dsh-live2d-mao#dsh-live2d-mao
category: fun
description:
  en: '...'
  zh: '...'
"@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($content))
$body = @{ message = "Add dsh-live2d-mao"; content = $b64; branch = "main" } | ConvertTo-Json
Invoke-RestMethod -Uri "https://api.github.com/repos/xkk6663/awesome-dsh-plugin/contents/data/plugins/xkk6663__dsh-live2d-mao--packages-dsh-live2d-mao.yml" `
  -Method Put -Headers $h -Body $body -ContentType "application/json"

# ③ 提 PR
$prBody = @{ title = "Add xkk6663/dsh-live2d-mao (DSH-specialized Live2D desktop pet)"
             head = "xkk6663:main"; base = "main"; body = "..." } | ConvertTo-Json
Invoke-RestMethod -Uri "https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls" `
  -Method Post -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes($prBody)) `
  -ContentType "application/json; charset=utf-8"
```

### 6.5 ⚠️ CI 的两条门槛与等待规则（本项目实测）

提交 PR 后会有两个 check：

| check | 内容 |
|---|---|
| `check` | 校验 YAML 格式、文件命名、仓库是否可访问 |
| `Submission gate` | 校验 `dsh.bundle` 存在、仓库年龄、是否已收录 |

**`Submission gate` 关于年龄的规则（源码级）**：

```js
const ageDays = (Date.now() - new Date(repo.created_at).getTime()) / 86400000
if (ageDays < 1) { 判定失败，提示"nothing to do，会自动清除" }
```

**自动复审机制**（`regate.yml`，每 6 小时一次）：

```js
const aged = gate?.conclusion === 'failure'
  && /days old|commit\(s\)/.test(gate.output?.summary ?? '')
  && (!ranAt || Date.now() - ranAt >= 24 * 3600 * 1000)   // ← 关键！≥24 小时
```

**这条 `>= 24h` 是隐藏门槛**：即使仓库已满 1 天，也要等 **gate 上次运行满 24 小时**才会被自动重跑。

**时间线推算**（本项目实例）：
```
gate 首次运行：10-18 09:35 UTC（当时仓库 0.8 天，失败）
仓库满 1 天：  10-18 13:53 UTC
gate 满 24h：  10-19 09:35 UTC  ← 从此刻起才允许 regate
下一个 regate：10-19 12:36 UTC  ← 实际转绿时间
```

**结论**：新上架 PR 从提交到变绿，**最长要等约 2 天**。

**不要做的事**（维护者明确劝阻）：
- ❌ 不要 close 再 reopen
- ❌ 不要推空提交强行触发
- ❌ 不要 force-push

**等待期间的替代方案**：npm 已发布 ⇒ 用户 `dsh plugin add dsh-live2d-mao` 已经能装，
只是市场里搜不到。**上架只影响可发现性，不影响可用性。**

### 6.6 上架后：版本更新不用再提 PR

catalog 里的 `version` / `downloads` / `stars` 字段由**每日探测自动刷新**。

版本更新流程 = **只需执行本文档第 2~5 节**（改版本号 → 推送 → npm publish → 实机验证）。

```powershell
# 市场自动跟上，无需任何 catalog 操作
npm version patch && npm publish
```

---

## 7. 发版检查清单（打印出来照着打勾）

```
□ 1. 分支确认：git branch --show-current == dsh-only-slim
□ 2. 门禁全绿：插件 223 / adapter 201 / ingest 63 / guard / E2E 18
□ 3. npm pack --dry-run：19~25 文件、无 mock.js、含 screenshots.json
□ 4. npm 版本号已改（package.json）
□ 5. CHANGELOG 顶部已加对应版本条目
□ 6. git commit + push origin dsh-only-slim:main
□ 7. git tag（可选）
□ 8. npm publish → 见到 + dsh-live2d-mao@X.Y.Z
□ 9. npm view 确认 dist-tags.latest == 新版本（等 30s~几分钟）
□ 10. 实机验证：remove → store prune → add → 检查版本与 screenshots.json
□ 11. 启动 DSH 验证插件加载（/dsh-live2d-mao/status 返回 401 而非 404）
□ 12. 若首次上架：确认 topic、仓库年龄、提 PR
```

---

## 8. 故障速查表

| 现象 | 原因 | 解法 |
|---|---|---|
| `npm publish` 报 403 2FA | token 不是 bypass-2FA 的 granular | 重新建 token，权限含 write |
| `npm view` 只看到 `0.0.0-stage` | 首次发布异步处理中 | 等 30s~几分钟再查 |
| `dsh plugin add` 说 `Already up to date` | pnpm 缓存/lockfile | `store prune` + 删 lockfile + 指定版本 |
| 插件路由返回 404 | 插件未加载 | 检查 profile 是否装对（web vs desktop） |
| PR 卡在 `days old` | 仓库<1天 或 gate<24h | 等；不要 reopen/推空提交 |
| PR 卡在 `dsh.bundle` | entry 指向仓库根但根 package.json 没声明 | 改 url 指向子包 + 文件名加 `--packages-xxx` |
| 文档/代码"消失" | 当前分支被切到 main | `git checkout dsh-only-slim` |
| git push 报 `Invalid username or token` | token 失效 | 重新配 `git credential approve` |
| 网络 `Connection was reset` | 临时网络问题 | 重试 |

---

## 9. 关键路径与账号速查

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/xkk6663/dsh-live2d-mao` |
| 本地分支 → 远程 | `dsh-only-slim` → `main` |
| npm 包 | `https://www.npmjs.com/package/dsh-live2d-mao` |
| npm 账号 | `xkk6663` |
| 插件目录 | `packages/dsh-live2d-mao/` |
| dsh CLI | `C:\Users\xiao1\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| profile 目录 | `~/.dsh/profiles/{web,desktop}/` |
| market 仓库 | `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin` |
| market 展示页 | `https://awesome-dsh-plugin.com/p/xkk6663/dsh-live2d-mao/` |
| 投稿文件（本地备份） | `docs/dsh-market-submission/xkk6663__dsh-live2d-mao.yml` |
