# SKILL：跨设备接入云端 AstrBot —— 一个灵魂，多个身体

> **这份文档要解决什么问题**
> 你已经在云端跑了一个 AstrBot，里面有一个"人"（persona + 记忆 + 工具）。
> 现在你希望这个"人"同时出现在微信、电脑桌宠、以后的新设备上 ——
> **同一个灵魂，不同的身体**：记忆共享、人格一致，但每台设备知道自己"在哪"。
>
> 本文基于**实测源码**（AstrBot v4.29.1）和**已经跑通的实现**（本仓库大肥鱼桌宠），
> 不是理论推演。所有结论都带文件路径 + 行号。
>
> **重要**：本文第 2 节专门列出了「容易搞错的假设」。那些是我实际踩过的坑，
> 其中 3 条推翻了最初的设计判断 —— 建议先读那一节。

---

## 1. 架构全景（六层，一张图看懂）

```
┌─【1 消息来源层】"身体"们的入口 ─────────────────────────────────────┐
│  微信客户端 ──→ 腾讯服务器 ──→ [weixin_oc 适配器]                   │
│  电脑桌宠   ──→ HTTP ────────→ [/api/v1/chat] ──→ [webchat 适配器]  │
│  未来新设备 ──→ HTTP ────────→ [/api/v1/chat] ──→ [webchat 适配器]  │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌─【2 平台适配器层】core/platform/sources/<name>/*_adapter.py ────────┐
│  把原始消息包成 AstrBotMessage，并分配 session_id                    │
│  · webchat   → session_id = "webchat!{username}!{cid}"              │
│  · weixin_oc → session_id = 裸 from_user_id（无前缀！）              │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌─【3 事件层】AstrMessageEvent ───────────────────────────────────────┐
│  UMO = platform_id : message_type : session_id                      │
│  桌宠例: webchat : FriendMessage : webchat!xiao1!d93c5ca6-…         │
│  微信例: weixin_personal_mgwh : FriendMessage : o9cq…@im.wechat     │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌─【4 核心管线】event_bus → conversation_mgr → LLM provider ──────────┐
│  on_llm_request 钩子在这里插入（livingmemory 按 persona+scope 检索） │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌─【5 人格层】persona 333（大肥鱼）───────────────────────────────────┐
│  system_prompt + 工具集 + 记忆作用域                                 │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌─【6 回流】provider → 各适配器 send_by_session() → 送回"身体" ────────┐
│  context.send_message(umo, chain) 可以**跨平台**主动发消息           │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. ⚠️ 先读这个：8 个容易搞错的假设

这些是**实测推翻**的，写在这里免得你再踩：

| # | 直觉上的做法 | 实际情况 | 证据 |
|---|---|---|---|
| 1 | 微信 session_id 也是 `weixin_oc!...` 这种带前缀格式 | ❌ **就是裸 `from_user_id`**，没有任何前缀 | `weixin_oc_adapter.py:1561` |
| 2 | UMO 的 platform 段写平台类型 `weixin_oc` | ❌ **写的是实例 id**，本机是 `weixin_personal_mgwh` | `astr_message_event.py:71` + `weixin_oc_adapter.py:158` |
| 3 | 基类叫 `PlatformAdapter` | ❌ **叫 `Platform`**（`abc.ABC`）；`PlatformAdapter` 这个类不存在 | `core/platform/platform.py:38` |
| 4 | 基类的 `send_by_session` 能直接发消息 | ❌ **基类只打点上报，什么都不发**；18 个子类各自覆写 | `platform.py:143-145` |
| 5 | SSE 结束时会有 `complete` 帧 | ❌ **服务端不向外发 `complete`**；它以 `message_saved` + 连接关闭收尾 | `chat_service.py:1194-1222` |
| 6 | `enable_streaming: false` 会返回普通 JSON | ❌ **永远返回 `text/event-stream`**，只影响 LLM 是否逐 token | `open_api.py:68-76` |
| 7 | `enable_streaming` 传字符串 `"false"` 也行 | ❌ **只有真 bool 才生效**，字符串会被忽略并回落默认 `True` | `request_flags.py:28-30` |
| 8 | `/api/v1/chat` 是绕开适配器的后门 | ❌ **它就是 webchat 适配器的 HTTP 外壳**：灌队列 → `convert_message()` → 同一条 pipeline | `chat_service.py:1356-1375` |

> 第 8 条是好消息：**桌宠没有走旁路**，它和微信用的是同一套人格、同一套记忆、同一套工具。

---

## 3. 最小接入方案：**不写适配器**

### 3.1 结论

**新增一个设备，最小改动 = 零代码。**

只要这个设备能发 HTTP，就用 `/api/v1/chat`，**复用 webchat 适配器**，
靠 `username` 和 `session_id` 区分出不同的"身体"。

而且对本机部署来说**连启用都不用做** —— webchat 实例在 `manager.py:115-117` 是
**无条件创建**的：它不读 `platform[]` 配置、不看 `enable` 开关，永远注册。

### 3.2 请求怎么写

```http
POST /api/v1/chat
Authorization: Bearer abk_xxx        # 需要 chat scope
Content-Type: application/json

{
  "username": "xiao1",               // 会话宿主（决定"是谁在说话"）
  "session_id": "d93c5ca6-...",      // 就是 cid → 决定"哪条话题线"
  "message": [{"type": "plain", "text": "你好"}],
  "enable_streaming": true           // 必须是真 bool
}
```

返回 UMO 恒定为：

```
webchat:FriendMessage:webchat!{username}!{session_id}
```

### 3.3 三个维度的取舍

| 你想让新设备… | 怎么改 | 效果 |
|---|---|---|
| **共享记忆**（同一个灵魂） | `session_id` 用**同一个值** | 两边看到同一段记忆与上下文 |
| **独立记忆**（各聊各的） | `session_id` 用**不同值** | 完全隔离 |
| **共享长期记忆但上下文独立** | 同 `session_id` + livingmemory 作用域调 `user` | ✅ **本仓库采用**（见 §5） |

> 桌宠当前就是第三种：`session_id` 复用微信那条，靠 livingmemory 的 `memory_scope_mode`
> 把"长期记忆"合并、"上下文链"保持独立。

---

## 4. 真正需要写插件的三种情况

**注意：写的是「插件」，不是「适配器」。** 插件约 50 行，适配器是重工程。

### 4.1 注入设备上下文（"每台设备知道自己在哪"）

```python
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star

class DeviceAwarePlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)          # 无需 @register

    @filter.on_llm_request()
    async def inject_device(self, event: AstrMessageEvent, req) -> None:
        umo = event.unified_msg_origin
        if umo.startswith("webchat:"):
            req.system_prompt += "\n你当前在用户的电脑桌宠上。"
```

- 钩子注册在 `star_handler.py:433-453`，官方用法就是往 `req.system_prompt` 追加。
- **桌宠的实现方式不同**：它没写这个插件，而是每条消息自带
  `[电脑桌宠] [设备上下文] 当前你在桌宠设备上：…` 前缀。
  副作用是被问到时会复述这串前缀 —— 所以后端加了 `strip_device_prefix()` 兜底。

### 4.2 跨设备桥接（"桌宠让微信说话"）

这是**完全可以做到的**，而且不需要 hack：

```python
await self.context.send_message(
    "weixin_personal_mgwh:FriendMessage:<wxid>",
    MessageChain().message("桌宠说：该喝水了"),
)
```

机制（`core/star/context.py:650-679`）：按 UMO 里的 **platform_id** 精确匹配实例，
再调它的 `send_by_session()`。所以一个调用既能发微信也能发 webchat。

> ⚠️ `platform.meta().id == session.platform_name` 是**精确匹配 id**。
> 写 `weixin_oc` 会匹配失败并**静默返回 False**（不报错，很难查）。

### 4.3 HTTP 方式主动推送（不写插件也行）

```http
POST /api/v1/im/messages
Authorization: Bearer abk_xxx        # 需要 im scope（注意不是 chat scope）

{"umo": "webchat:FriendMessage:webchat!xiao1!pet-dev-01", "message": {...}}
```

---

## 5. 记忆层：怎么做到"记忆共享但上下文不串味"

### 5.1 存储位置（只有一个文件）

```
/opt/astrbot/data/plugin_data/astrbot_plugin_livingmemory/livingmemory.db
```

所有设备读写**同一个文件**，隔离靠 `session_id` 字段分桶。

### 5.2 作用域模式（`filtering_settings.memory_scope_mode`）

| 模式 | 行为 | 适用 |
|---|---|---|
| `legacy` / `session` | 每会话独立，互相看不见 | 默认值，会导致"记不住别的设备" |
| **`user`** | 同一用户跨会话共享长期记忆 | ✅ **推荐：一个灵魂多个身体** |
| `global` | 所有人共享 | ✗ 多用户会污染 |

切换到 `user` 后需要跑迁移，否则旧记忆留在原作用域召回不到：

```python
from astrbot_plugin_livingmemory.core.managers.scope_migrator import ScopeMigrator
import aiosqlite

conn = await aiosqlite.connect("/AstrBot/data/plugin_data/astrbot_plugin_livingmemory/livingmemory.db")
migrator = ScopeMigrator(conn)
plan = await migrator.plan("livingmemory:user:webchat:xiao1")
await migrator.execute(plan, backup_path=".../livingmemory_before_scope.db")
```

> ⚠️ 别用 `/lmem migrate-scope` 命令 —— 它走消息管道，需要管理员身份，
> 通过 Open API 注入**无反应也无日志**。直接调 `ScopeMigrator` 是可靠做法。

### 5.3 为什么不能把记忆放云网盘（AList）

```
livingmemory.db        3.7 MB   SQLite 主库
livingmemory.db-wal    5.2 MB   ← WAL 预写日志
livingmemory.db-shm     32 KB   ← 共享内存索引
livingmemory.index     131 KB   ← FAISS 向量索引（mmap 打开）
```

三个硬障碍：
1. **WAL 模式需要文件锁 + 共享内存**，HTTP 文件服务提供不了 → SQLite 报错或损坏
2. **FAISS 索引用 mmap**，要求随机读写，网盘只能整份下载
3. **高频小事务**（每轮对话写记忆+更新索引），走 HTTP 秒级延迟会卡死对话

而且**没必要**：桌宠和微信本来就在同一台机器上读写同一个文件。

> AList 适合放**点歌的 mp3 缓存**（大文件、只读、支持 HTTP Range）。

---

## 6. 多模态：附件怎么在两台设备间流动

### 6.1 云端 → 设备（收图）

SSE 帧里的 `[IMAGE]xxx.png` **不是 URL，是文件名**：

```
{"type":"image","data":"[IMAGE]20261022185913674_abe8.png"}
```

真正的字节要再取一次：

```http
GET /api/v1/files/content?filename=<文件名>     ← 推荐，只要 file scope
GET /api/v1/files/<attachment_id>/content        ← 也行，需 attachment_saved 帧的 id
```

### 6.2 设备 → 云端（发图）

**不能**直接把 data URL 塞进 `message`，必须先上传换 id：

```http
POST /api/v1/file          ← multipart，字段名 file
→ {"attachment_id": "..."}
```

然后消息体用消息段数组：

```json
{"message": [
  {"type": "plain", "text": "看图"},
  {"type": "image", "attachment_id": "..."}
]}
```

### 6.3 ⚠️ WebSocket 1MB 单帧上限（踩过）

如果你还开了一条 WS 推流通道给渲染端，**任何体积不可控的二进制都不能进 WS**：

| 来源 | 原始 | base64 后 |
|---|---|---|
| 一首 mp3 | 11.1 MB | ≈15 MB |
| 一张表情包 | 3.6 MB | **14.2 MB** |

超过 1 MB 直接 `sent 1009 (message too big)`，**整条连接被踢掉，连聊天一起断**。

**正确做法**：落盘 → 短 URL → WS 只推 URL → 渲染端用 `<img>`/`<audio>` 走 HTTP。
附带好处：`<audio>` 拿到支持 Range 的 URL（`206 Partial Content`），能拖进度条。

---

## 7. 人格与配置速查

`.env`（**不要硬编码进源码**）：

```ini
ASTRBOT_BASE_URL=http://<host>:6185
ASTRBOT_API_KEY=abk_xxx          # 建议轮换，见 §9
ASTRBOT_PERSONA_ID=333
ASTRBOT_USERNAME=xiao1
ASTRBOT_PLATFORM=mao-pet
ASTRBOT_SESSION_ID=<复用微信那条，实现记忆共享>
```

本机现状（`/AstrBot/data/cmd_config.json`）：

```
id=weixin_personal_mgwh  type=weixin_oc  enable=True    ← 唯一的 IM 实例
webchat 不在 platform[] 里，但永远可用（manager.py:115-117 无条件创建）
```

---

## 8. 新设备接入检查清单

按顺序做，每步都有可验证的产物：

- [ ] **1. 拿到 chat scope 的 API key** → `POST /api/v1/chat` 返回 200
- [ ] **2. 定 `session_id` 策略** → 共享记忆 = 复用同一个值
- [ ] **3. 跑通一问一答** → 能收到 `plain` 帧和 `message_saved`
- [ ] **4. 确认 UMO** → 应该是 `webchat:FriendMessage:webchat!{user}!{sid}`
- [ ] **5. 验证记忆共享** → 在新设备问"我们之前聊过什么"，应能答出别处的内容
      （没答出来 → 检查 `memory_scope_mode` 是否为 `user` + 是否跑过迁移）
- [ ] **6. 收图跑通** → `[IMAGE]` 帧 → `/api/v1/files/content` → 拿到正确魔数
- [ ] **7. 发图跑通** → `POST /api/v1/file` → `attachment_id` → 消息段数组
- [ ] **8. 需要主动推送的话** → `POST /api/v1/im/messages`（im scope）+ 正确的 UMO

---

## 9. 安全红线

| 项 | 要求 |
|---|---|
| API Key | **只放 `.env`**，永不硬编码；`.gitignore` 覆盖 `**/.env` |
| 日志 | **禁止打印 key**（哪怕前几位）。本项目踩过：每轮对话 `logger.warning(f"[DEBUG] ... {api_key[:20]}")`，明文写进日志文件 |
| 抓包样本 | 从服务器拉下来的 `*_config.json` / `*.txt` 常含真实 key / Cookie / 密码，**一律 gitignore** |
| Key 轮换 | 一旦在日志/聊天里明文出现过，**立即去 WebUI 重建** |
| 附件大小 | 图片建议 8 MB、音频 24 MB 上限，超限要在上传前拦 |

---

## 10. 什么时候才真的需要新写适配器

只有**同时满足**以下情况才考虑（否则都是过度设计）：

1. 设备**跑不了 HTTP 客户端**（纯蓝牙 / 串口中继）
2. 需要**独立于 webchat 的会话身份或连接生命周期**
3. 需要**在 WebUI 平台列表里可见、可开关**

即便如此，也可以让**插件注册适配器**（`platform/register.py:11-63`），
热重载时会按 `module_path` 清理（`register.py:66-91`）。

---

## 11. 参考实现（本仓库）

| 文件 | 职责 |
|---|---|
| `私人AI日记系统/backend/app/cloud_feiyu/client.py` | AstrBot 客户端：SSE 解析、附件下载/上传、思考与工具载荷清洗 |
| `私人AI日记系统/backend/app/routes/companion.py` | 路由：直通云端、媒体落盘、消息落库、WS 推送 |
| `docs/大肥鱼多模态桥接-协议与修复.md` | 协议细节 + 20 多条踩坑记录 |
| `docs/大肥鱼功能总览.md` | 端上实现总览（消息模型、排序铁律、去重规则） |

---

## 附：源码索引（v4.29.1）

| 要找什么 | 路径 |
|---|---|
| 适配器目录（18 个） | `astrbot/core/platform/sources/<name>/` |
| webchat session_id 拼装 | `sources/webchat/webchat_adapter.py:213` |
| 微信 session_id（裸 ID） | `sources/weixin_oc/weixin_oc_adapter.py:1561` |
| UMO 定义 | `core/platform/astr_message_event.py:105-114` |
| UMO 字符串拼装 | `core/platform/message_session.py:18-19` |
| MessageType 枚举（仅 3 个） | `core/platform/message_type.py:4-7` |
| 适配器基类 `Platform` | `core/platform/platform.py:38` |
| 跨平台主动发送 | `core/star/context.py:650-679` |
| `/api/v1/chat` 路由 | `dashboard/api/open_api.py:173-188` |
| SSE 帧生成 | `dashboard/services/chat_service.py:972-1049`（心跳常量 L42） |
| 请求标志解析 | `sources/webchat/request_flags.py:3-31` |
| 钩子注册 | `core/star/register/star_handler.py:433-453` |
| EventType 全表（17 个） | `core/star/star_handler.py:219-241` |
| 插件加载规则 | `core/star/star_manager.py:294-310`（需 `main.py` + `metadata.yaml`） |
| webchat 无条件创建 | `core/platform/manager.py:104-117` |
| 插件注册适配器 | `core/platform/register.py:11-63` / 清理 `:66-91` |
