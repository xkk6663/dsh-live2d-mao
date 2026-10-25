# 插件市场 · 回归测试

真浏览器 + 真后端，验证插件市场的**用户可见行为**：
装载、启停、上架、下架、内置保护、两种 nav 模式的显隐。

## 跑法

后端必须先起着（仓库根的 `启动桌宠.cmd` 或 `restart_mio.ps1`）：

```bash
# 在仓库根执行
NODE_PATH=<repo>/澪Agent应用/node_modules node 澪Agent应用/tests/market/run-all.cjs
```

`NODE_PATH` 指向装了 playwright 的 `node_modules`。若 playwright 装在别处，
先 `npm i playwright` 到任意目录再指过去；`run-all.cjs` 会给出明确提示。

## 脚本清单

| 文件 | 项数 | 需要 | 说明 |
|---|---|---|---|
| `run-all.cjs` | — | 后端 | **推荐入口**：顺序跑全部并汇总 |
| `market_panel_harness.cjs` | 113 | 无 | 假 DOM 单测，**不需要**浏览器和后端 |
| `ui_closure.cjs` | 23 | 后端+浏览器 | UI 闭环：装载 → 停用/启用 → 上架/下架 → 内置保护 |
| `nav_modes.cjs` | 12 | 后端+浏览器 | `own` / `host` 两种 nav 模式的停用↔启用往返 |
| `ui_form.cjs` | 6 | 后端+浏览器 | 真实填写「上架插件」表单并提交 |
| `pet_bus.cjs` | 10 | 后端+浏览器 | 桌宠渲染端 plugin-bus 热插拔 |
| `_config.cjs` | — | — | 共享配置（浏览器探测 / BASE / dist 路径 / 清理） |
| `_market_fixtures/` | — | — | harness 用的真实载荷快照 |

## 环境变量（都可省略）

| 变量 | 缺省 | 用途 |
|---|---|---|
| `PET_CHROME` | 自动探测 Chrome / Edge / Chromium | 浏览器可执行文件 |
| `PET_BASE_URL` | `http://127.0.0.1:8000` | 后端地址 |
| `MIO_DIST` | `<repo>/澪Agent应用/dist` | 前端产物目录 |

## 注意

- 这几个测试会**真的**启停你的插件、并临时上架 `_uiprobe` / `_formprobe` 两个探针插件。
  探针目录在 `dist/plugins/_*`，**无论成功失败都会自动删除**（`cleanupOnExit`）。
  若某次异常中断留下残留，直接删掉 `dist/plugins/_` 开头的目录即可。
- 截图落在本目录 `.screenshots/`（已 gitignore）。
- 测试结束后插件启用状态会恢复（`cloud_feiyu` / `dsh` 各自回到启用）。
