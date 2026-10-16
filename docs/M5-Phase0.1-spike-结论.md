# M5 · Phase 0.1 spike 结论：插件宿主侧能否起 BrowserWindow

> 执行日：2026-10-16 ｜ 基线：v4.2.1（`93c133d4`）
> 对应交接单 §2 第 1 步；对应技术方案 §7.1 未验证点 #1

## 一、二元结论

**不通（NOT VIABLE）。** DSH Cordis 插件宿主侧**不可能** `require('electron')` 起 `BrowserWindow`。

**判定依据不是"试了没成功"，而是源码级硬证据**：插件代码根本不在 Electron 进程里运行。

## 二、证据链（源码级，可复现）

### 2.1 宿主是 Electron 的**子进程**，且被强制降级为纯 Node

`resources/app.asar/lib/main.js:3674-3691`（Electron 主进程侧）：

```js
const child = spawn(this.node, [
    "--expose-internals",
    entry,                      // .../dsh-desktop-host/lib/index.js
    this.runtimeDir, this.projectDir, ...
], {
    cwd: this.projectDir,
    env: desktopNodeEnvironment(this.node, void 0, this.environment),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
});
```

而 `desktopNodeEnvironment`（同文件 `3529-3536`）**强制注入**：

```js
function desktopNodeEnvironment(executable, bin, environment) {
    return {
        ...environment,
        ELECTRON_RUN_AS_NODE: "1",          // ★ 关键：子进程按"纯 Node"启动
        ...bin === void 0 ? {} : {
            DSH_DESKTOP_NODE_EXECUTABLE: executable,
            PATH: `${bin}${delimiter}${environment.PATH ?? ""}`
        }
    };
}
```

`ELECTRON_RUN_AS_NODE=1` 是 Electron 的官方开关：**置位后该进程没有 `electron` 模块的窗口能力**，
`require('electron')` 拿到的是 Node 兼容层（无 `BrowserWindow`），不是主进程 API。

### 2.2 宿主与 Electron 之间只有 IPC，没有任何窗口通道

同一个 spawn 的 `stdio` 第 4 项是 `"ipc"`；两侧通信用的是 `process.send` / `process.on("message")`
（`dsh-desktop-host/lib/index.js:248-262` 与 `main.js:3698+`），消息类型是白名单枚举：
`ready` / `platform-session` / `shutdown` / `quit-inspection` / `update-tasks`（`main.js:3698-3709`）。

**没有任何一条 IPC 消息能让插件申请"给我开个窗口"**——这是设计上的封闭，不是遗漏。

### 2.3 交叉验证：本机 6 个已装插件的实测命中为 0

技术方案 §7.1.1 的取证（`BrowserWindow`/`webContents`/`electron` 命中全 0）与本结论一致，
且本次拿到了**机制解释**（此前只有现象）。`dsh-plugin-wallpaper-engine` README 说
"这一条要壳侧配合，插件侧改不动"——现在知道**为什么**改不动。

## 三、对方案的影响（依裁决 D4：无阻塞）

主体形态**固定**为「独立 Electron 壳 + 插件只推事件」——这正是技术方案 §五"形态二"、
也是交接单裁决 D4 已预设的路线。spike 的作用仅在于**排除掉"插件侧省掉壳"这个加分项**：

| 问题 | 结论 |
|---|---|
| 插件侧能不能省掉电子壳？ | **不能**。桌宠渲染必须留在独立 Electron 壳（或退化为 Web GUI 内 portal） |
| 桌宠主体受不受影响？ | **不受**。主体本来就是独立 Electron 应用，`start_mio.ps1` 手动启动 |
| M6/M7 是否阻塞？ | **不阻塞**。走「插件推事件 → 桌宠渲染」路线，本仓库已有 `agent_bus_service` 通道 |

**D4 由此从"裁决"升级为"源码级事实"**：不是"我们选择不并入插件形态"，而是
"DSH 的进程模型不允许插件持有窗口"。这条写进结论，后续不必再验。

## 四、复现方式

```powershell
# 1. 抽取 DSH 源码（_dsh_src 已按交接单第 0 步恢复）
node -e "<asar 解包脚本>"   # 见 docs/M5-Phase0.1-spike-结论.md 附录
# 2. 直接读两处证据
Select-String -Path _dsh_src\lib\main.js -Pattern "ELECTRON_RUN_AS_NODE"
Select-String -Path _dsh_src\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js -Pattern "ELECTRON_RUN_AS_NODE"
```

## 附录 · `_dsh_src` 恢复记录（交接单第 0 步）

- 源：`C:\Users\xiao1\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（121,348,951 bytes）
- 方法：读 asar header（`size` header 长度 = `UInt32LE(12)`，文件数据基址 = `16 + headerSize`），
  递归展开 `files` 树，跳过 `size===0` / 无 `offset` 的空条目
- 结果：**10,512 个文件 / 104.0 MB**（`.js/.mjs/.cjs/.json/.md/.ts/.yml/.yaml`）
- 落点：`C:\Users\xiao1\Mao\_dsh_src\`
- 关键参照物已就位：
  - `_dsh_src\dsh\node_modules\@deepseek-ai\dsh-llm\lib\types\assistant-stream.js` ✅（未验证点 #2）
  - `_dsh_src\dsh\node_modules\@deepseek-ai\dsh-user-approval\lib\index.js` ✅（未验证点 #3）
  - `_dsh_src\dsh\node_modules\@deepseek-ai\dsh-user-questions\lib\index.js` ✅
  - `_dsh_src\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js` ✅（事件发射点）
