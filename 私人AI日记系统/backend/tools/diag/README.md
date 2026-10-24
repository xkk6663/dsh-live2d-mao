# tools/diag —— 云端对接诊断脚本

跨设备对接云端 AstrBot 时用来「看见真相」的小工具。
对应 `docs/SKILL-跨设备接入云端AstrBot.md` §13 的联调方法论。

**共同前提**：在 `私人AI日记系统/backend/` 目录下运行（要能 import `app.*` 与读到 `.env`）。

| 脚本 | 用途 | 对应 Skill 章节 |
|---|---|---|
| `ws_listen.py [秒数]` | 连上桌宠 WS，持续打印后端广播的每一帧 | §13.2 |
| `bubble_live_probe.py ["文字"]` | 发一条测试气泡并回读 hub 状态 | §13.2 |
| `setu_frame_dump.py ["/setu_file 3"]` | 把一轮命令的 SSE 原始帧逐条打出来 | §13.1 |
| `feiyu_vision_e2e.py [--custom "..."]` | 截图 → 云端大肥鱼 → 回话，绕过 UI | §13.1 |

## 什么时候用哪个

```
怀疑"插件没执行"     → setu_frame_dump.py   看云端到底发了什么帧
怀疑"请求没到云端"   → 看响应里的 model_id / route（不必跑脚本）
怀疑"气泡不显示"     → ws_listen.py         看后端有没有广播 agent_bubble
怀疑"渲染端丢了"     → ws_listen.py 有帧但界面没有 → 去查 §12
只想确认送达通道     → bubble_live_probe.py 返回 False 就是没渲染端连着
```

## 注意

- 这些脚本**不写业务库**、不推业务气泡（`bubble_live_probe` 除外，它刻意推一条测试气泡）。
- `setu_frame_dump.py` / `feiyu_vision_e2e.py` 会**真实调用云端**，会消耗云端额度。
- 输出里的路径/密钥一律不要贴进 issue 或聊天。
