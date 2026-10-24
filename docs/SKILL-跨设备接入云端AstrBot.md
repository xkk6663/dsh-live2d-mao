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
>
> **2026-10-24 大改版说明**：这次为桌宠做了完整的"云端插件对接"，
> 暴露出**协议通了 ≠ 能用**。新增/重写：
> - §2 假设表从 8 条扩到 **15 条**（9–15 是接上之后才会撞的第二批坑）
> - §3.4 **推翻**了原「复用微信 session_id」的推荐（副作用太大）
> - **§5 插件生态**（全新）：命令前缀污染、`File` 组件、定时 vs 手动分工、模型路由
> - **§12 显示层五连坑**（全新）：语音/气泡时序、`interrupted` 清屏、停留时长收口
> - **§13 联调方法论**（全新）：三个"看见真相"的手段 + 排查顺序图
> - **§14 取舍原则 P1–P7**（全新）：可直接复用的七条铁律

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

## 2. ⚠️ 先读这个：15 个容易搞错的假设

这些是**实测推翻**的，写在这里免得你再踩（1–8 是协议层，9–15 是接上之后才会撞的第二批坑）：

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

**以下 9–15 是"接入成功之后"才会撞上的**，本次跨设备改造全部踩过：

| # | 直觉上的做法 | 实际情况 | 证据 |
|---|---|---|---|
| 9 | 给消息加设备前缀是"锦上添花"，无副作用 | ❌ **会废掉所有插件命令**。命令匹配是 `message_str.startswith(full_cmd)`，前缀一加，`/setu_file`、`/p`、`/余额` 全都不在开头 → 全部交给 LLM 闲聊 | `star/filter/command.py:202` |
| 10 | 插件用 `File` 组件发图，设备端自然能收到图 | ❌ **`File` 发的是 `file` 帧，不是 `image` 帧**。只认 `image`/`record` 的客户端会把整批图**静默丢弃** | `components.py:770` |
| 11 | `enable_streaming: false` 更省事、更稳定 | ❌ **非流式请求可能一个正文帧都不给**：云端 TTS 把回复转成语音时只发 `record`，`plain`/`complete` 全无 → 拿到空正文。**必须走流式** | 实测 2/2 vs 0/2 |
| 12 | 同一会话 = 记忆共享，是好事 | ⚠️ **双刃**：副作用是插件里写死的推送目标也会"跟着当前会话跑"，/setu_file 的图会发到微信 | `timed_setu/main.py:31` |
| 13 | 设备端只需配好模型就能工作 | ❌ 本机聊天走哪个模型由 `pet_chat_model_id` 决定；**这个键不在默认配置里**，读不到就回落 `auto` → 自动路由到本地直连模型，**云端插件全部"失效"** | 见 §5.5 |
| 14 | 语音和文字可以按任意顺序发 | ❌ **先合成语音再发文字**会让气泡永远不出现：TTS 要几秒~十几秒，气泡 3~8 秒就自动收起 | 见 §12.2 |
| 15 | 同一身份的气泡可以随便互相顶 | ❌ **音频开场就 `stopSpeech('interrupted')`，而它默认清空气泡** → 每来一条语音就把正在显示的文字/表情包抹掉 | 见 §12.3 |


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
| **共享长期记忆但上下文独立** | 同 `session_id` + livingmemory 作用域调 `user` | 见 §6，但**注意 §3.4 的陷阱** |

> 桌宠当前就是第三种：`session_id` 复用微信那条，靠 livingmemory 的 `memory_scope_mode`
> 把"长期记忆"合并、"上下文链"保持独立。

### 3.4 ⚠️ **复用微信 session_id 的副作用比想象中大（2026-10-24 修正）**

早期本文档把"复用微信 session_id"当作推荐做法（为了记忆共享）。
实测发现代价很大，**现在改为默认用设备自己的 session_id**：

| 复用微信 session_id 的实际后果 | 说明 |
|---|---|
| 插件推送目标跟着跑 | `event.chain_result()` 回给"当前会话"= 微信 → 设备手动发的 `/setu_file` **图跑到手机上** |
| 设备与微信上下文混在一条会话 | 记忆/人格互相污染，排查问题时分不清是哪台设备说的话 |
| 云端日志里无法区分设备 | 全部显示为 `webchat:FriendMessage:webchat!xiao1!<微信cid>` |

**推荐配置**：

```ini
# 设备端用自己的会话（默认行为）
ASTRBOT_SESSION_ID=mao-pet-desktop

# 确实想要记忆共享时，再显式写微信那条 —— 这是明确选择，不该是默认
# ASTRBOT_SESSION_ID=d93c5ca6-c3d8-47a0-a9ea-124334bcde70
```

> 想要"长期记忆共享 + 上下文独立"，正确做法是**各自的 session_id + livingmemory `user` 作用域**（§6），
> 而不是复用同一个 session_id。


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

## 5. ★ 插件生态：接上设备之后的真实战场（2026-10-24 实测）

这一节是本文档**最重要的补充**。前面 §3/§4 讲的是"消息能通"，
但真实需求是"云端 17 个插件在设备上也能用"。这一节全是那次对接的踩坑。

### 5.1 铁律：命令类消息**绝不能加设备前缀**

AstrBot 的命令匹配是**纯字符串前缀判断**（`star/filter/command.py:202`）：

```python
if message_str.startswith(f"{full_cmd} ") or message_str == full_cmd:
```

而 §4.1 建议的"每条消息注入设备上下文"，实际写法往往长这样：

```
[电脑桌宠] [设备上下文] 当前你在桌宠设备上：LAPTOP-XXX (Windows 11)。时间：… 用户说：/setu_file 3
```

**结果：所有插件命令永久失效**，被当成普通闲聊丢给 LLM。
更糟的是 LLM 会**编造执行结果**（"好，就这张：xxx.png"），用户以为插件坏了。

**正确做法**：识别命令类消息，**原样发送**（一个字符都不加）：

```python
if is_plugin_command(message):
    full_message = message          # 命令：原样，不加任何前缀
else:
    full_message = f"[电脑桌宠] {device_ctx}\n\n用户说：{message}"   # 闲聊：带上下文
```

命令本来就由插件直接处理、不经过 LLM，丢掉设备上下文**没有任何损失**。

### 5.2 怎么识别"命令类消息"

不能只看 `/` 开头 —— 大量插件用的是**自然语言命令**（`来3张千恋万花`、`听听茉子`、`点歌 晴天`）。
判据应当是三层：

```python
def is_plugin_command(message: str) -> bool:
    text = message.strip()
    if text[0] in "/!！":                 # ① 标准命令前缀
        return True
    lowered = text.lower()
    for name in COMMAND_TABLE:            # ② 登记过的命令名（含中文命令）
        if lowered == name or lowered.startswith(name + " "):
            return True
    return any(k in text for k in KEYWORDS)  # ③ 关键词兜底（角色名、作品名…）
```

> **命令表要跟着插件走**：装了新插件就补登记，否则新命令又会掉进闲聊。
> 本仓库实现在 `backend/app/cloud_feiyu/device.py` 的 `_PLUGIN_COMMANDS`。

### 5.3 两条路的分工：定时推送走微信，手动命令走设备

这是用户明确要求的形态，也是**应该抄的范式**：

| 场景 | 由谁发起 | 发送目标 | 是否受设备接入影响 |
|---|---|---|---|
| 定时主动推送（谷时涩图、生日祝福） | 插件自己的 `while` 循环 | **写死的 `SESSION_ID`（微信）** | ❌ 完全不受影响 |
| 用户手动发命令（`/setu_file`、`/p`） | `event.chain_result()` | **当前会话**（= 发起命令的设备） | ✅ 跟着会话走 |

```python
# 定时：插件自己维护状态，跟事件无关 → 永远发微信
SESSION_ID = "weixin_personal_mgwh:FriendMessage:o9cq...@im.wechat"
await self.context.send_message(SESSION_ID, MessageChain(chain=chain))

# 手动：回给"当前会话" → 谁发的回到谁那儿
yield event.chain_result([File(name=..., file=p) for p in paths])
```

**所以设备端只要用自己的 `session_id`，手动命令的图就落在设备上，不会串到微信。**

### 5.4 `File` 组件：设备端必须同时认 `file` 帧

插件为了绕微信图片审核，常用 `File` 组件发图（`components.py:770`），
SSE 里出来的是 **`"type": "file"`**，不是 `image`：

```
{"type":"file","data":"[FILE]2026..._960c.jpg|白发斗篷少女_20261023.jpg"}
{"type":"file","data":"[FILE]2026..._360b.png|鲸鱼娘_海边_20261023.png"}
```

如果客户端只按 `kind == "image"` 或 `mime.startswith("image/")` 分类，
`File` 组件**通常不带 mime**，就会判成 `"other"` → 被调用方直接丢弃（**静默，无日志**）。

**修法**：`file`/`video` 占位符 + 图片扩展名 → 仍按图片处理：

```python
if k in ("file", "video") and any(
    name.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".jfif")
):
    return "image"
```

> 注意：有 `image_mode` 图集模式，因此同时会收到同名的 `file` 和 `image` 帧，
> 要按「云端存储名」去重，否则同一张图落盘两次。

### 5.5 云端模型用哪家，设备端必须**显式**指定

本次最隐蔽的坑：设备端一切"正常"，插件"全部失效"。
排查到最后发现**请求根本没到云端** —— 本机有一个 `select_auto_route()` 兜底路由，
配置键（本仓库是 `pet_chat_model_id`）读不到就回落 `"auto"`，
自动选到本机直连的第三方模型（实测 `qwen3-vl-plus` → `dashscope.aliyuncs.com`）。

**判断依据**：看响应里的 `model_id` / `route` / `provider_name`：

```
model_id = cloud_feiyu                      ← 对的
route    = 直连 https://dashscope...        ← 错的（说明没走云端）
```

**修法**：显式写入 `pet_chat_model_id = "cloud_feiyu"`，不要依赖默认值。
> 推论：**"设备端不需要任何模型 API"这句话要靠代码保证**——
> 把所有"本机跑模型"的分支删掉（或恒定短路），别留默认回落。

### 5.6 非流式请求可能拿不到正文（必须用流式）

实测对比，同样的"图 + 提示词 → 云端"：

| 请求方式 | 拿到文字 | 帧序列 |
|---|---|---|
| `enable_streaming: false` | **0/2** | 只有 `agent_stats` + `record`(语音) + `image` |
| `enable_streaming: true` | **2/2** | `plain` 逐 token + `complete` 全文齐全 |

原因：云端 persona 的 TTS 插件会在某些轮次把回复整轮转成语音，
此时**非流式只发 `record`，正文一个文本帧都没有**。

**修法**：凡是"要一句完整回话"的调用，一律 `enable_streaming: true`，
正文取 `plain` 增量拼接、`complete` 兜底。

> 顺带：`chat()`（非流式入口）在 AstrBot 里解析正文时**不读 `complete` 帧**，
> 纯靠它拿正文会在"只有 complete 帧"的轮次失明。这是既有实现坑，换入口前先确认。



---

## 6. 记忆层：怎么做到"记忆共享但上下文不串味"

### 6.1 存储位置（只有一个文件）

```
/opt/astrbot/data/plugin_data/astrbot_plugin_livingmemory/livingmemory.db
```

所有设备读写**同一个文件**，隔离靠 `session_id` 字段分桶。

### 6.2 作用域模式（`filtering_settings.memory_scope_mode`）

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

### 6.3 为什么不能把记忆放云网盘（AList）

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

## 7. 多模态：附件怎么在两台设备间流动

### 7.1 云端 → 设备（收图）

SSE 帧里的 `[IMAGE]xxx.png` **不是 URL，是文件名**：

```
{"type":"image","data":"[IMAGE]20261022185913674_abe8.png"}
```

真正的字节要再取一次：

```http
GET /api/v1/files/content?filename=<文件名>     ← 推荐，只要 file scope
GET /api/v1/files/<attachment_id>/content        ← 也行，需 attachment_saved 帧的 id
```

### 7.2 设备 → 云端（发图）

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

### 7.3 ⚠️ WebSocket 1MB 单帧上限（踩过）

如果你还开了一条 WS 推流通道给渲染端，**任何体积不可控的二进制都不能进 WS**：

| 来源 | 原始 | base64 后 |
|---|---|---|
| 一首 mp3 | 11.1 MB | ≈15 MB |
| 一张表情包 | 3.6 MB | **14.2 MB** |

超过 1 MB 直接 `sent 1009 (message too big)`，**整条连接被踢掉，连聊天一起断**。

**正确做法**：落盘 → 短 URL → WS 只推 URL → 渲染端用 `<img>`/`<audio>` 走 HTTP。
附带好处：`<audio>` 拿到支持 Range 的 URL（`206 Partial Content`），能拖进度条。

---

## 8. 人格与配置速查

`.env`（**不要硬编码进源码**）：

```ini
ASTRBOT_BASE_URL=http://<host>:6185
ASTRBOT_API_KEY=abk_xxx          # 建议轮换，见 §10
ASTRBOT_PERSONA_ID=333
ASTRBOT_USERNAME=xiao1
ASTRBOT_PLATFORM=mao-pet
ASTRBOT_SESSION_ID=mao-pet-desktop   # ★ 2026-10-24 改为设备独立（见 §3.4）
```

> 设备端还有**一个自己的**配置项必须显式写，它不在云端：
> `pet_chat_model_id = cloud_feiyu`（见 §5.5）。漏了它 → 请求根本不会发到云端。

本机现状（`/AstrBot/data/cmd_config.json`）：

```
id=weixin_personal_mgwh  type=weixin_oc  enable=True    ← 唯一的 IM 实例
webchat 不在 platform[] 里，但永远可用（manager.py:115-117 无条件创建）
```

---

## 9. 新设备接入检查清单

按顺序做，每步都有可验证的产物。
**1–8 是协议层（能通），9–15 是实战层（能用）** —— 只过前 8 条，用户仍会说"没法用"：

### 协议层：消息能通

- [ ] **1. 拿到 chat scope 的 API key** → `POST /api/v1/chat` 返回 200
- [ ] **2. 定 `session_id` 策略** → 默认用**设备自己的**值（§3.4），别复用微信
- [ ] **3. 跑通一问一答** → 能收到 `plain` 帧和 `message_saved`
- [ ] **4. 确认 UMO** → 应该是 `webchat:FriendMessage:webchat!{user}!{sid}`
- [ ] **5. 验证记忆** → 按需调 `memory_scope_mode=user`（§6）
- [ ] **6. 收图跑通** → `[IMAGE]` 帧 → `/api/v1/files/content` → 拿到正确魔数
- [ ] **7. 发图跑通** → `POST /api/v1/file` → `attachment_id` → 消息段数组
- [ ] **8. 强流式** → `enable_streaming: true`（§5.6，非流式可能无正文）

### 实战层：插件能用

- [ ] **9. 请求确实走云端** → 响应 `model_id` 是云端入口、`route` 不是本机直连（§5.5）
- [ ] **10. 命令原样转发** → 云端日志 `preview='setu_file 1'`，**不是**带设备前缀（§5.1）
- [ ] **11. 自然语言命令** → `来3张千恋万花`、`听听茉子` 也能触发（§5.2 命令表）
- [ ] **12. `File` 帧认成图片** → `kind=file` + 图片扩展名 → 归一到 `image`（§5.4）
- [ ] **13. 定时推送不串台** → 定时用的 UMO 是写死的微信，手动命令回到设备（§5.3）
- [ ] **14. 文字气泡先发** → 日志里 `agent_bubble` 早于 `agent_audio`（§12.2）
- [ ] **15. 音频不清空气泡** → 来一条语音后，文字/表情包仍在（§12.3）

### 收尾确认

- [ ] **16. 用 §13.2 旁路监听**：完整跑一轮，确认帧序列里有 `agent_bubble` + `agent_image`
- [ ] **17. 气泡停留 6~8 秒**且**音频不显示"正在播放"**（§12.4/12.5）
- [ ] **18. 说一句「看一下现在的屏幕」** → 不依赖历史也能触发（§12.6）

---

## 10. 安全红线

| 项 | 要求 |
|---|---|
| API Key | **只放 `.env`**，永不硬编码；`.gitignore` 覆盖 `**/.env` |
| 日志 | **禁止打印 key**（哪怕前几位）。本项目踩过：每轮对话 `logger.warning(f"[DEBUG] ... {api_key[:20]}")`，明文写进日志文件 |
| 抓包样本 | 从服务器拉下来的 `*_config.json` / `*.txt` 常含真实 key / Cookie / 密码，**一律 gitignore** |
| Key 轮换 | 一旦在日志/聊天里明文出现过，**立即去 WebUI 重建** |
| 附件大小 | 图片建议 8 MB、音频 24 MB 上限，超限要在上传前拦 |

---

## 11. 什么时候才真的需要新写适配器

只有**同时满足**以下情况才考虑（否则都是过度设计）：

1. 设备**跑不了 HTTP 客户端**（纯蓝牙 / 串口中继）
2. 需要**独立于 webchat 的会话身份或连接生命周期**
3. 需要**在 WebUI 平台列表里可见、可开关**

即便如此，也可以让**插件注册适配器**（`platform/register.py:11-63`），
热重载时会按 `module_path` 清理（`register.py:66-91`）。

---

## 12. 设备端显示层：五个"看起来没反应"的真根因（2026-10-24 实测）

协议通了、图也到了，用户看到的仍是"气泡不出现"。这一节全是**显示层**的坑，
每条都是实测定位，不是推测。

### 12.1 请求没走云端（最隐蔽）

见 §5.5。**先看响应的 `model_id` / `route`**，别急着查显示层。

### 12.2 语音合成排在文字前面 → 文字气泡永远来不及显示

```python
# ❌ 错误顺序（原实现）
if want_voice:
    blob = await tts.synthesize(reply)   # 几秒~十几秒
publish("agent_bubble", payload)         # 气泡 3~8 秒就自动收起了

# ✅ 正确顺序
publish("agent_bubble", payload)         # ① 文字立刻发，无条件
if want_voice:
    blob = await tts.synthesize(reply)   # ② 语音是增强
    publish("agent_audio", ...)          # ③ 成功再补
```

**判据**：如果日志里 `agent_bubble` 的时间戳总是紧跟在 `agent_audio` 之后（或干脆没有），
就是这个问题。**文字和语音必须解耦**，TTS 失败不能影响文字。

### 12.3 `stopSpeech('interrupted')` 会清空正在显示的气泡

音频播放函数开头通常是：

```js
if (currentAudio || streamPlaybackActive) stopSpeech('interrupted')
```

而 `stopSpeech()` 的收尾往往是二分法：

```js
if (['finished','error'].includes(reason)) { /* 3秒后收起 */ }
else { hideSpeechBubble() }        // ← interrupted 落到这里，直接清屏
```

**后果**：每来一条云端语音/点歌，就把桌面上正在显示的文字气泡和表情包**清空**。
用户看到的永远是"气泡从来不出现"。

**修法**：`interrupted` 的语义是"被新音频接管播放"，与"该不该清屏"无关。

```js
} else if (reason === 'interrupted') {
  // 保留现有气泡，让它按自己的计时器正常收起
  if (!speechBubble.hidden && !speechBubbleHideTimer) {
    speechBubbleHideTimer = setTimeout(hideSpeechBubble, bubbleHoldMs())
  }
} else {
  hideSpeechBubble()
}
```

### 12.4 "正在播放"气泡霸占同一个框

音乐/音频提示如果用 `showSpeechBubble(label, 0, ...)` 且 `0` 被兜底成 3 秒，
播放期间它会**反复重显**，一直占着气泡；再加上跨身份抢占保护，
她真正说的话就会被拒掉。

**修法（用户明确要求）**：音频播放**不出气泡**，只出声。

```js
// showSpeechBubble(`♪ 正在播放：${title}`, 0, ...)   ← 删掉
void audio.play().catch(() => finish())
```

### 12.5 气泡停留时长必须收口成常量

停留时长曾经散落在 6 处硬编码（`3000` / `4000` / `20000`…），改一处漏五处。
统一收口成一个函数，**带上下限**，别让任何调用方能突破：

```js
const BUBBLE_HOLD_MIN_MS = 6000
const BUBBLE_HOLD_MAX_MS = 8000

function bubbleHoldMs(requested, charCount = 0) {
  const asked = Number(requested) > 0 ? Number(requested) : 0
  const byLength = MIN + Math.round(Math.min(1, Math.max(0, charCount) / 40) * (MAX - MIN))
  const value = asked > 0 ? Math.max(asked, byLength) : byLength
  return Math.min(MAX, Math.max(MIN, value))   // ← 夹死
}
```

> 用户实测反馈：3 秒"看不清就没了"，6~8 秒才够。
> 后端传 `3000` 会被抬到下限，传 `20000` 会被压到上限，永远不会失控。

### 12.6 自然语言触发：句式 + 门槛两层都会漏

设备端"用户说一句话让它看屏幕"通常有两个判定：

1. **句式判定** —— 早期写成固定短语表 + `fullmatch`（必须整句相等），
   用户换个说法就失效。改成**要素组合**正则：`动作(看/瞅/瞧) + 可选"现在" + 对象(屏幕/画面/桌面)`。
2. **上下文门槛** —— 命中句式后还要求"最近 N 分钟内观察过"或"历史里有屏幕记录"。
   设备刚开机、历史为空时必然失败 → **用户明说要看也看不成**。

**修法**：把两类分开

| 消息类型 | 例子 | 是否需要历史 |
|---|---|---|
| 显式提到屏幕/画面 | `看一下现在的屏幕`、`屏幕上是什么` | ❌ **不需要，直接触发** |
| 纯指示语 | `现在呢`、`再看看` | ✅ 需要近期屏幕上下文（避免无意义截图） |

---

## 13. 联调方法论：三个"看见真相"的手段

排查"云端插件全用不了"时，靠这三样才定位到根因。**照着做能省几十轮试错**：

### 13.1 抓 SSE 原始帧

不要只看客户端解析后的结果，**把每一帧原样打出来**。

现成工具（本仓库已入库，见 `backend/tools/diag/`）：

```bash
# 把 /setu_file 这一轮的 SSE 原始帧逐条打印（含附件占位符与归一类型）
.venv/Scripts/python.exe tools/diag/setu_frame_dump.py "/setu_file 3"

# 端到端验证「截图 → 云端 → 回话」，不经过 UI
.venv/Scripts/python.exe tools/diag/feiyu_vision_e2e.py
```

自己写的话核心就三行：

```python
async for line in resp.aiter_lines():
    frame = json.loads(line[5:])     # 去掉 "data: " 前缀
    print(f"[{frame['type']}]", str(frame.get('data'))[:120])
```

能立刻区分：是"云端没发"、还是"发了但本地丢掉了"。
实测靠这一步发现：`plain` 帧 0 个、`file` 帧没被认成图片、只来 `record` 没正文。

### 13.2 旁路监听设备通信通道

在设备和后端之间**另开一个客户端**，同步记录后端广播了什么：

```bash
# 连上桌宠 WS，持续打印后端广播的每一帧
.venv/Scripts/python.exe tools/diag/ws_listen.py 60
```

输出形如：

```
[10] agent_bubble 标题挂着「7000万到账，体验暴富人生」，画面里却只有一片海…
[29] agent_image /api/companion/agent-media/35c324593aca70ae.jpg
```

能一眼看出是"后端没广播"还是"广播了但渲染端没显示"。
本次靠它确认：修复前 44 帧里**一帧 `agent_bubble` 都没有**。

> 只想确认"推一条气泡走不走得通"，用 `tools/diag/bubble_live_probe.py`：
> 直接调 `publish_deliverable()` 并回读 hub 状态（返回 `False` = 没有渲染端连着）。

### 13.3 看云端的"收到原文"日志

插件命令失效时，先看云端**实际收到了什么**：

```bash
docker logs astrbot --since 10m 2>&1 | grep -iE "preview=|使用工具|Prepare to send"
```

- `preview='setu_file 1'` → 命令**干净**，会命中
- `preview='[电脑桌宠] … 用户说：/setu_file 1'` → **被前缀污染**，永远命中不了

> 一行日志差距，就是整个插件生态可用与不可用的分界。

### 13.4 一张图记住排查顺序

```
用户说"插件用不了"
  ↓
① 云端收到了什么？        → preview= 干净吗       (§13.3)
  ↓ 干净但仍不执行
② 请求走云端了吗？        → model_id = cloud_feiyu? (§5.5)
  ↓ 走了
③ 云端回什么帧？          → 有 file/image 帧吗？   (§13.1)
  ↓ 有
④ 本地收下了吗？          → kind 判成 image 了吗？ (§5.4)
  ↓ 收下了
⑤ 设备显示了吗？          → 广播里有 agent_bubble/image 吗？(§13.2)
  ↓ 广播了
⑥ 显示层问题              → §12.2~12.5 五连坑
```

---

## 14. 跨设备改造的取舍原则（本次确立）

| 原则 | 内容 | 原因 |
|---|---|---|
| **P1 设备端零模型** | 所有模型推理走云端；设备端只做采集 + 渲染 | 用户明确要求；也避免"本机模型配置遗漏"导致静默走错路由（§5.5） |
| **P2 命令不走前缀** | 命令类消息原样转发 | 命令匹配是纯前缀判断（§5.1） |
| **P3 会话各自独立** | 每台设备用自己的 session_id | 避免推送目标串台（§3.4） |
| **P4 定时用写死目标** | 主动推送用固定 UMO，不看当前会话 | 定时任务与"谁在说话"无关（§5.3） |
| **P5 文字先于语音** | 文字无条件立即发 | TTS 可能十几秒，气泡等不起（§12.2） |
| **P6 收口而非散落** | 时长/阈值/命令表都收成一个常量或函数 | 散落硬编码 = 改一处漏五处（§12.5） |
| **P7 失败要可见** | 被丢弃的附件、被跳过的帧都要记原因 | "静默丢弃"是最贵的 bug（§5.4 整批图无声消失） |

---

## 15. 参考实现（本仓库）

| 文件 | 职责 |
|---|---|
| `私人AI日记系统/backend/app/cloud_feiyu/client.py` | AstrBot 客户端：SSE 解析、附件下载/上传、思考与工具载荷清洗、`attachment_media_kind()` 类型归一 |
| `私人AI日记系统/backend/app/cloud_feiyu/device.py` | 设备上下文注入 + **`is_plugin_command()` 命令识别**（§5.2） |
| `私人AI日记系统/backend/app/routes/companion.py` | 路由：直通云端、命令原样转发、媒体落盘、消息落库、WS 推送 |
| `私人AI日记系统/backend/app/screen/screen_observation_service.py` | 屏幕观察：图+提示词直发云端、`SCREEN_FOLLOW_UP_RE` 自然语言判定（§12.6） |
| `澪Agent应用/dist/live2d-pet/live2d-pet.js` | 渲染端：`bubbleHoldMs()` 停留时长收口、`stopSpeech` 分类处理（§12.3~12.5） |
| `私人AI日记系统/backend/tools/diag/ws_listen.py` | 旁路监听 WS 广播（§13.2） |
| `私人AI日记系统/backend/tools/diag/setu_frame_dump.py` | 打印 `/setu_file` 的 SSE 原始帧（§13.1） |
| `私人AI日记系统/backend/tools/diag/feiyu_vision_e2e.py` | 截图→云端→回话 端到端验证，绕过 UI |
| `私人AI日记系统/backend/tools/diag/bubble_live_probe.py` | 气泡投递连通性自检 |
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

### 2026-10-24 新增索引（跨设备插件对接相关）

| 要找什么 | 路径 |
|---|---|
| **命令匹配判据（纯前缀）** | `core/star/filter/command.py:202` |
| `File` 组件定义 | `core/message/components.py:770` |
| open_api 帧分发（`plain`/`image`/`record`/`file`/`video`） | `dashboard/services/open_api_service.py:485-500` |
| open_api session 解析 | `dashboard/services/open_api_service.py:145-183` |
| `agent_stats` 帧（含 `time_to_first_token`） | `dashboard/services/open_api_service.py:473-481` |

> 插件侧（服务器上，不在 AstrBot 源码里）：
> - 定时推送目标：`/opt/astrbot/data/plugins/astrbot_plugin_timed_setu/main.py:31` 的 `SESSION_ID`
> - `setu_file` 用 `File` 组件：同文件 `:216-232`
> - 手动命令回当前会话：`yield event.chain_result([...])`


