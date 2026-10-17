# DSH-Live2D-Mao

DSH 专用 Live2D 桌宠连接器 —— 把 DeepSeek Harness 的实时工作状态，推给一只住在你桌面上的 Live2D 看板娘。

> ⚠ 本插件是**连接器**：它只负责「把 DSH 在干什么」推给桌宠，**不持有窗口**。
> 桌宠本体（Live2D 渲染窗口）由配套的桌宠程序提供，二者通过 12 态状态总线对接。

## 它做什么

- 订阅 DSH 会话事件（`session/event`、`agent/assistant-stream`）
- 折叠成 12 态 phase（规划 / 思考中 / 执行工具 / 回复中 / 聆听中 / 说话中 / 待确认 / 完成 / 出错 / 暂停 / 待机 / 在线）
- 经 HTTP 推送到桌宠总线（`POST /api/plugin/dsh/ingest`）

## 安装

```bash
dsh plugin --profile web add dsh-live2d-mao
```

## 依赖

- 一个在 `http://127.0.0.1:8000` 上运行、带 `/api/plugin/dsh/*` 路由的桌宠后端
- 桌宠窗口本身（配套程序，不随本插件分发）

## 许可

MIT。见仓库根 `LICENSE`。
