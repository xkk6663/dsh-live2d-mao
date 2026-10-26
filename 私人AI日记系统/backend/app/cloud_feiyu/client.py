"""AstrBot Open API 客户端 —— 对接云端大肥鱼 persona。

用法:
    client = CloudFeiyuClient()
    reply = await client.chat("你好", images=["data:image/png;base64,xxx"])
    # 流式:
    async for chunk in client.chat_stream("你好"):
        print(chunk, end="")

──────────────────────────────────────────────────────────────────────────────
多模态协议（2026-10-22 云端实测锁定，v4.29.1；改这里之前先读完）
──────────────────────────────────────────────────────────────────────────────
AstrBot `POST /api/v1/chat` 返回 SSE，每帧是 `data: {json}`。与附件相关的帧：

    {"type":"image",  "data":"[IMAGE]20261022185913674_abe8.png", "streaming":false}
    {"type":"record", "data":"[RECORD]20261022185913674_ab12.wav", "streaming":false}
    {"type":"file",   "data":"[FILE]20261022185913674_cd34.pdf|原始文件名.pdf", "streaming":false}
    {"type":"attachment_saved","data":{"id":"946e7ab2-…","type":"image"}}
    {"type":"complete","data":"正文…","reasoning":"模型的思考过程…"}      ← 注意 reasoning 字段

★ 关键坑（旧实现全踩了）：
  1. `data` 里的 `[IMAGE]xxx.png` **不是图片 URL**，是云端附件目录里的**文件名**。
     旧代码把它当 URL 直接塞给前端 → 前端 `<img src="[IMAGE]xxx.png">` → 必然裂图。
  2. 真正的字节要用 Open API 取：
       GET /api/v1/files/content?filename=<文件名>      ← 推荐，只要 file scope
       GET /api/v1/files/<attachment_id>/content         ← 也行，需要 attachment_saved 帧的 id
     两者都返回 octet-stream，实测 PNG 魔数 89 50 4E 47 正确。
  3. `complete` 帧带 `reasoning` 字段（模型思考过程）。旧实现只取 `data`，
     思考过程会被别的插件/管道拼进正文 —— 现在由调用方显式丢弃 reasoning。
  4. 附件可能是一条**独立消息**（先 plain、再 image、再 end），所以不能"收到文本就收工"：
     必须读到 `end` 帧或流结束，否则会漏掉跟在文本后面的图。

★ 本客户端只负责"把文件名换成真实字节"，不解释语义。上层（companion.py）把结果交给桌宠。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from typing import AsyncGenerator, Any

import httpx

# AstrBot 附件占位符：[IMAGE]a.png / [RECORD]a.wav / [FILE]a.pdf|原名.pdf / [VIDEO]a.mp4
_ATTACH_RE = re.compile(r"^\[(IMAGE|RECORD|FILE|VIDEO)\](.+)$", re.IGNORECASE)

# 云端附件类型 → 猜测的 MIME（下载响应头若给了 Content-Type 以响应头为准）
_EXT_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".silk": "audio/silk",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
}

# 单文件下载上限。图片/语音很小，但**歌曲 mp3 动辄 8~12MB**（实测一首 10.6MB），
# 用 8MB 会把点歌结果直接判失败。这里提到 24MB：够放一整首歌，
# 又不至于让内存被一个坏链接撑爆。超过上限仍然安全跳过（前端会显示"取不到"）。
MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024
# 图片单独的上限：图片不需要那么大，超过就没必要塞进 data: URL 了
MAX_IMAGE_BYTES = 8 * 1024 * 1024


@dataclass
class FeiyuAttachment:
    """云端大肥鱼发来的一个附件（图片/语音/文件/视频）。

    filename   云端附件目录里的真实文件名（取自 [IMAGE]/[FILE] 占位符）
    kind       image / record / file / video（占位符类型，小写）
    display    给用户看的名字（[FILE] 里 `|` 后面的原名；图片用文件名）
    mime_type  下载时响应头给的，或按扩展名猜的
    data_url   `data:<mime>;base64,…`，前端可直接 <img src>；下载失败时为 ""
    error      下载失败原因（成功时为空）
    """

    filename: str = ""
    kind: str = "file"
    display: str = ""
    mime_type: str = ""
    size: int = 0
    data_url: str = ""
    error: str = ""

    @property
    def is_image(self) -> bool:
        return self.kind == "image" and bool(self.data_url)

    def to_dict(self, *, inline_payload: bool = True) -> dict[str, Any]:
        """给前端/路由用的安全形状（不含超大 base64 之外的多余字段）。

        `inline_payload=False` 时**不内联音频和图片的 base64**：
          · 一首歌 10MB+，base64 后约 15MB；
          · 云端表情包/封面图动辄 3.6MB，base64 后 14MB！
        WebSocket 单帧上限 1MB，实测这种帧会让连接直接
        `sent 1009 message too big` 断线（连聊天都一起断）。
        所以非内联模式下只给元信息，真正的字节由上层落盘、用 HTTP URL 回传。
        """
        media = attachment_media_kind(self.kind, self.mime_type, self.filename)
        data_url = self.data_url
        if media in ("audio", "image") and not inline_payload:
            data_url = ""
        return {
            "kind": self.kind,
            "filename": self.filename,
            "display": self.display or self.filename,
            "mime_type": self.mime_type,
            "size": self.size,
            "data_url": data_url,
            "error": self.error,
            # 内容分类：图片 <img>、歌曲/语音 <audio>、其它文件给下载卡片。
            # 单独给一个字段而不是让前端自己猜 mime：点歌回来的是 `type=file` 的 mp3，
            # 前端如果只看 kind 只会拿到 "file"，不知道它其实能播。
            "media": media,
        }


def attachment_media_kind(kind: str, mime_type: str, filename: str) -> str:
    """把附件归一成前端好用的三类：image / audio / other。

    为什么要单独判断：AstrBot 点歌发的是 `[FILE]xxx.mp3`（kind=file），
    但它是**能直接播放的音频**；只看 kind 会把它当普通文件给一个下载链接。

    ★★ 2026-10-24 云端排查（`/setu_file` 在电脑端不出图、微信正常）：
      AstrBot 的 `timed_setu` 插件用 **`File` 组件**发图（为了绕微信图片审核），
      帧类型是 `file` 而不是 `image`，且 File 组件通常**不带 mime**。
      旧实现只认 kind=="image" / mime 以 image/ 开头 → 这几张图被判成 "other"，
      调用方（routes/companion.py）只收 image/audio → **整批静默丢弃**。
      微信能收到，是因为微信适配器直接吃 File 消息，不走这条分类。
      现在补上：`file` 类型若扩展名是图片格式，按图片处理（内容真伪由数据头魔数复核）。
    """
    mime = str(mime_type or "").lower()
    name = str(filename or "").lower()
    k = str(kind or "").lower()
    if k == "image" or mime.startswith("image/"):
        return "image"
    if k == "record" or mime.startswith("audio/"):
        return "audio"
    # 云端常把 mp3 标成 application/octet-stream，用扩展名兜底
    if any(name.endswith(ext) for ext in (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".webm")):
        return "audio"
    # file/video 占位符但其实是图片（File 组件发图 / 云端没给 mime）→ 仍按图片
    if k in ("file", "video") and any(
        name.endswith(ext)
        for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".jfif")
    ):
        return "image"
    return "other"


def parse_attachment_placeholder(data: Any) -> tuple[str, str] | None:
    """解析 SSE 附件占位符。

    `"[IMAGE]a.png"`        → ("image", "a.png")
    `"[FILE]a.pdf|原名.pdf"` → ("file", "原名.pdf")   ← 第二个值是**显示名**，取文件用第一个
    返回 (kind, raw_payload)。非占位符返回 None。
    """
    if not isinstance(data, str):
        return None
    m = _ATTACH_RE.match(data.strip())
    if not m:
        return None
    kind = m.group(1).lower()
    return kind, m.group(2)


def split_attachment_payload(kind: str, payload: str) -> tuple[str, str]:
    """把 `[FILE]存储名|原始名` 拆成 (云端文件名, 显示名)。"""
    if "|" in payload:
        stored, display = payload.split("|", 1)
        return stored.strip(), (display.strip() or stored.strip())
    name = payload.strip()
    return name, name


def strip_control_markers(text: str) -> str:
    """去掉大肥鱼回复里的控制标记：`&&happy&&` 表情、`⟦MODE:chat⟧` 模式指令。

    为什么要在 client 层就剥：上层 companion.py 只在**流结束后**清洗一次，
    但流式期间每个 chunk 都被 `agent_stream` 推给桌宠气泡了 —— 用户会看到
    `⟦MODE:chat⟧` 这种内部标记闪现在气泡里。在源头剥掉，边流的文本就已经是干净的。
    """
    if not text:
        return text
    text = re.sub(r"&&\w+&&", "", text)
    text = re.sub(r"⟦[^⟧]*⟧", "", text)
    return text


def strip_reasoning_prefix(text: str) -> str:
    """去掉"模型思考"混进正文的部分（按行处理）。

    AstrBot 有时会把 reasoning 拼进正文（它的 `complete` 帧也带一个独立 `reasoning` 字段，
    但直连自部署版本会在正文开头漏出思考）。两类要处理：
      ① 纯粹的英文思考行（整行没有任何中日韩字符）→ 丢；
      ② 英文思考与中文正文**粘在同一行**（`No. Just answer.大肥鱼。你在…`）→ 只保留中文起头那段；
         若思考里引用了中文原话（`Could be a test of "你是谁，我在哪" …`），跳过引号内中文找正文。
    宁少勿滥：只动"明显是英文句子"的形状，正常中文行一律原样保留。
    """
    if not text:
        return text
    cjk = re.compile(r"[\u3040-\u30ff\u4e00-\u9fff]")
    kept: list[str] = []
    for line in text.split("\n"):
        s = line.strip()
        if not s:
            kept.append("")
            continue
        if not cjk.search(s):
            # ① 整行没有中文：像句子的英文思考 → 丢
            if re.search(r"[A-Za-z]{2,}", s):
                continue
            kept.append(s)
            continue
        # ② 第一个中文字符之前若有"英文句子"，说明是连贯思考
        idx = cjk.search(s).start()
        head = s[:idx]
        is_list_marker = re.fullmatch(r"\s*(\d+[.)、]|[-*•]|[A-Za-z][.)])\s*", head) is not None
        english_prose = bool(re.search(r"[A-Za-z]{2,}", head)) and len(head.split()) >= 2
        if english_prose and not is_list_marker:
            if re.search(r'["“「]\s*$', head):
                # 引号内是中文引用 → 跳过引用，找回引号闭合后的正文
                recovered = _text_after_quote(s, idx)
                if recovered:
                    kept.append(recovered)
                continue
            kept.append(s[idx:])
            continue
        kept.append(s)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def _text_after_quote(line: str, from_index: int) -> str:
    """从"引号内中文引用"之后找回正文起点；找不到返回空串。"""
    rest = line[from_index:]
    close = re.search(r'["“”「」]', rest)
    cursor = rest[close.end():] if close else rest
    for _ in range(12):
        m = re.search(r"[\u3040-\u30ff\u4e00-\u9fff]", cursor)
        if not m:
            return ""
        before = cursor[: m.start()].rstrip(" \t—–-:：,，、")
        if re.search(r'[.?!。！？]["\'\u201c\u201d\u300c\u300d]?$', before):
            return cursor[m.start():].strip()
        boundary = re.search(r'[.?!。！？]["\'\u201c\u201d\u300c\u300d\s]', cursor[m.start():])
        if not boundary:
            return ""
        cursor = cursor[m.start() + boundary.end():]
    return ""


def strip_device_prefix(text: str) -> str:
    """剥掉"设备上下文 / 用户说："这类**注入前缀**，防止她把它复述进正文。

    桌宠每轮都会在消息前拼：
        [电脑桌宠] [设备上下文] 当前你在桌宠设备上：LAPTOP-XXX (Windows 11)。时间：…可用工具：…
        用户说：<用户原话>
    她偶尔会把这串东西当正文念回来（用户看到的就是"气泡里出现了我的提问"）。
    这里在**出气泡之前**把整段前缀去掉；正文里正常提到"用户说"不会被误伤
    （要求必须是从行首开始的完整前缀形态）。
    """
    if not text:
        return text
    out = text
    # ① 完整形态：[电脑桌宠] ... 用户说：
    out = re.sub(
        r"^\s*\[电脑桌宠\][^\n]*?用户说：\s*",
        "",
        out,
        flags=re.S,
    )
    # ② 只有设备上下文（她只复述了前半段）
    out = re.sub(r"^\s*\[电脑桌宠\][^\n]*?\n", "", out)
    out = re.sub(r"^\s*\[设备上下文\][^\n]*?\n", "", out)
    # ③ 单行里夹着的 "[设备上下文] … 时间：… 可用工具：…"
    out = re.sub(r"\[设备上下文\][^。\n]*。(\s*时间：[^。\n]*。)?(\s*可用工具：[^。\n]*。)?", "", out)
    # ④ 残留的"用户说："
    out = re.sub(r"^\s*用户说：\s*", "", out)
    return out.strip()


# ★ 2026-10-24：正文里"没闭合的 JSON 载荷尾部"的强信号。
#   真实事故：`{"body":{…"response_format":"wav"})\ncmd=['curl','-s', …]` —— 引号没配对、
#   花括号没闭合，json.loads 解不开，旧实现直接整段放过（还带着 Bearer sk-… 密钥）。
#   只看明显不属于人话、却只会出现在载荷里的特征：
#   `\n` 字面量 + `cmd=[`/`command=[`/`subprocess.` + http 动词 + python 代码痕迹。
_TOOL_TAIL_RE = re.compile(
    r"(?:\\ncmd\s*=\s*\[|\\ncommand\s*=\s*\[|\\nsubprocess\.|\"cmd\"\s*:\s*\[|"
    r"\bsubprocess\.Popen\(|\\nprint\((?:'|\")go|"
    r"['\"]-X['\"]\s*,\s*['\"](?:POST|GET|PUT|DELETE)['\"]|"
    r"['\"]Authorization:\s*Bearer\s|"
    r"['\"]--max-time['\"]|\\nstart_new_session\s*=)",
    re.IGNORECASE,
)

# ★★ 2026-10-24 第二轮实拍（更严重）：她手搓 python -c 调 TTS 时，载荷**没有 `{` 开头**，
#   而且密钥被输出成 `Bearer sk-***` 擦除后的样子，正文长这样：
#     语音自检通过。'},ensure_ascii=False)\nfor i in range(3):\n    f='/AstrBot/data/temp/sc%d.mp3'…
#     r=subprocess.run([… 'https://api.siliconflow.cn/v1/audio/speech' …],capture_output=True)
#     print('rc',r.returncode,…)\n""}, "ts": 1792813233.1964512}语音已发送。
#   → 这才是"整段载荷残留"的**标准形态**：`'},ensure_ascii=False)` / `\n` 字面量 /
#     `subprocess.run(` / python 缩进。一律从这里到 `"ts": <数字>}` 整块切掉。
_CODE_PAYLOAD_RE = re.compile(
    r"(?:'?\}\s*,\s*ensure_ascii\s*=|\"ts\"\s*:\s*\d|\},\s*ensure_ascii)",
    re.IGNORECASE,
)
_PY_FRAGMENT_RE = re.compile(
    r"(?:\\n|\n)\s*(?:for\s+\w+\s+in\s+range|if\s+os\.path|if\s+sz|r\s*=\s*subprocess\.|"
    r"subprocess\.|print\(|import\s+os|import\s+sys|f\s*=\s*['\"]/|body\s*=\s*json\.)"
)


# ★ 2026-10-24：载荷字段特征（出现任意一个就说明正文里混进了工具载荷）。
#   之所以需要它：实拍的那段载荷**没有开头的 `{`**（正文先说了十遍"我是大肥鱼"，
#   JSON 头被模型吞掉了，只剩 `','response_format':'wav'})\ncmd=[…` 这半截），
#   "花括号扫描"根本触发不到，于是那种"半截残片"清理必须另走一条路。
_TOOL_FIELD_RE = re.compile(
    r"response_format|\",?\s*ensure_ascii|\}\s*,\s*ensure_ascii|\\ncmd\s*=|\\nsubprocess\.|"
    r"\bsubprocess\.(?:Popen|run)\(|--max-time|\\nprint\(|\\nstart_new_session\s*=",
    re.IGNORECASE,
)
# 命中 _TOOL_FIELD_RE 之后，按这些形态把残片切掉（顺序有讲究：先长后短）
_TOOL_FRAGMENT_RE = re.compile(
    r"\\n(?:cmd|command|subprocess|print|start_new_session)[^\n]*?(?=\\n|\"|\}|$)"
    r"|['\"]?[,\s]*(?:response_format|\"body\"|'body'|'cmd'|\"cmd\"|'ts'|\"ts\")[^\n]*?"
    r"(?=\}[\"']?\s*,\s*\"ts\"|[\u4e00-\u9fff]|$)",
    re.IGNORECASE | re.DOTALL,
)

# ★★ 2026-10-24 用户实拍（截图）：JSON 头被模型吞了，只剩一段**反序列化残渣**：
#     「随机二次元图片 涩图"}, "ts": 1792833795.098908}哼，没卡，我在翻图呢…
#   特征非常干净：`"},` 或 `"}` 收尾的引号 + 一个 `"ts": <数字>}` 时间戳。
#   上面的 _TOOL_FIELD_RE 只认 response_format/subprocess 这些字段名，**认不出 ts**，
#   于是整段残渣（连同上一条工具调用的参数）上了屏。
#   这条规则只看形状不看字段名，所以对"随机图片/搜索/发消息"任何工具都通用。
#
#   安全性（宁可少吞不可误伤）：
#     · 必须同时出现「右引号收尾的残片」**和**「`"ts": 数字`」，缺一不切；
#     · 只在文本**靠前**（第一个中文字符之前，或整段前 200 字符内）命中才算 ——
#       用户/角色正常说话里几乎不会连续出现 `"}, "ts": 1792833795.098908}` 这种串；
#     · 切完若把正文切空了，回退到原文（交给后面的段落处理），不会吐空。
_TS_RESIDUE_RE = re.compile(r"\"\}\s*,\s*\"ts\"\s*:\s*[\d.eE+-]+\s*\}")


def scrub_secrets(text: str) -> str:
    """把泄漏进正文的密钥/令牌擦成 `sk-***`。

    ★ 2026-10-24 用户实拍事故：她为了做 TTS 自己手搓 curl，
      整段 `Authorization: Bearer sk-kbmvfnt…` 被当成普通文字显示在对话界面里。
      这是**真实可用的密钥**，必须保证无论载荷剥没剥干净，它都不会出现在界面上。
    """
    if not text:
        return text
    out = re.sub(r"(Bearer\s+)([A-Za-z0-9_\-\.]{12,})", r"\1sk-***", text)
    out = re.sub(r"\b(sk|ak|abk)-[A-Za-z0-9_\-]{12,}", r"\1-***", out)
    out = re.sub(r"\b(api[_-]?key|token|secret)(\s*[\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9_\-]{16,})",
                 r"\1\2***", out, flags=re.IGNORECASE)
    return out


def strip_tool_payload(text: str) -> str:
    """去掉正文里夹带的**工具调用原始载荷**。

    真实事故（2026-10-22，多次复现）：
      她调用工具的那一轮，`complete.data` 会把工具调用和回执直接混进正文，形如：
        {"id": "call_00_Xspb…", "name": "send_message_to_user", "args": {...}, "ts": …}
        又怎么了，接着。
        {"id": "call_00_Xspb…", "ts": …, "result": "Message sent to session webchat:…"}
        一张一张地要，你是要把我图库搬空啊。喏，这张拿去。

    也就是说：**整段是纯 JSON** 的情况很少，更常见的是"JSON 和正文交替出现"。
    以前的实现只处理"整段就是一个 JSON"，所以漏了。

    现在的策略（保守，宁可少吞不可误伤）：
      逐行处理，**丢弃"整行是一个完整 JSON 对象/数组、且含工具特征键"的行**；
      其余行原样保留。这样"又怎么了，接着。"这种正常正文仍在。
    """
    if not text:
        return text

    def is_tool_payload(data: Any) -> bool:
        keys: set[str] = set()

        def collect(node, depth=0):
            if depth > 3:
                return
            if isinstance(node, dict):
                keys.update(str(k).lower() for k in node.keys())
                for v in node.values():
                    collect(v, depth + 1)
            elif isinstance(node, list):
                for v in node[:5]:
                    collect(v, depth + 1)

        collect(data)
        strong = {"tool_calls", "function", "arguments", "args", "result", "call_id",
                  # ★ 2026-10-24 实测：她**自己手搓 shell 命令**调 TTS 的那一轮（用
                  #   siliconflow /audio/speech 生成 fish10.wav），载荷整段是
                  #   {"body": {"input":"我是大肥鱼。…","response_format":"wav"},
                  #    "cmd": ["curl","-s","--max-time","90","-X","POST", …],
                  #    "ts": 1792812592.36}
                  #   只有一个 `body`+`cmd`+`ts`，上面这些强特征键一个都没有 →
                  #   整段裸 JSON 漏进了对话界面（用户实拍，一大段 sk- 密钥暴露在屏幕上）。
                  "cmd", "cmdline", "command", "shell", "exec", "script",
                  "stdout", "stderr", "body", "headers", "url", "endpoint"}
        if keys & strong:
            return True
        # 回执形态：只有 id/ts/result 这类键、没有自然语言正文
        if {"id", "ts"} <= keys and len(keys) <= 6:
            return True
        # 执行型载荷：cmd / body / command 之一 + 没有一段像人话的正文
        if keys & {"cmd", "body", "command", "script", "exec"}:
            has_prose = False

            def find_prose(node, depth=0):
                nonlocal has_prose
                if has_prose or depth > 3:
                    return
                if isinstance(node, dict):
                    for v in node.values():
                        find_prose(v, depth + 1)
                elif isinstance(node, list):
                    for v in node[:8]:
                        find_prose(v, depth + 1)
                elif isinstance(node, str):
                    # 有十几个字以上、且不是路径/命令行/URL 的字符串，才当作"人话"。
                    # ★ 注意 JSON 是**反斜杠转义原始文本**时解不开（`\ncmd=[...`），
                    #   这时整段会被当普通字符；下面的"未闭合 JSON"兜底负责这种情况。
                    s = node.strip()
                    if (len(s) >= 12 and not s.startswith(("/", "http", "-", "curl", "python"))
                            and not re.match(r"^[\w./:-]+$", s)
                            and not s.endswith((".wav", ".mp3", ".json"))):
                        has_prose = True

            find_prose(data)
            return not has_prose
        return False

    def balanced_json_at(s: str, start: int) -> str | None:
        """从 s[start] == '{' 起，找配对 '}' 的位置。

        ★ 2026-10-24 放宽了两点（都是为了实拍的那个未闭合载荷）：
          ① 深度回到 0 时**不要求**它恰好是字符串外 —— 载荷里的引号本身就不配对
             （`{'response_format':'wav'})` 会让 `in_str` 一直是 True，永远等不到闭合）；
          ② 扫描上限 8000 字符，避免在一大段正文里白跑。
        """
        depth = 0
        in_str = False
        esc = False
        limit = min(len(s), start + 8000)
        for i in range(start, limit):
            ch = s[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth <= 0:
                    return s[start:i + 1]
        return None

    # 第 1 段：`{…}` 扫描 —— 能解析且判定为工具载荷的 JSON 整块剥掉，
    # 其余全部原样保留（这样「又怎么了，接着。」和「喏，这张拿去。」都还在）。
    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "{":
            block = balanced_json_at(text, i)
            if block:
                try:
                    data = json.loads(block)
                except Exception:
                    data = None
                if data is not None and is_tool_payload(data):
                    i += len(block)
                    continue
        out.append(ch)
        i += 1
    joined = "".join(out)

    # 第 2 段 ★★ 2026-10-24 两次实拍：**载荷不一定以 `{` 开头**。
    #   模型把 JSON 头吞了，正文里只剩下半截：
    #     我是大肥鱼。'},ensure_ascii=False)\nfor i in range(3):\n    f='/AstrBot/…'
    #   或者 `','response_format':'wav'})\ncmd=['curl',…]`
    #   花括号扫描对它完全无效（一次 `{` 都没遇到），于是整段（含 Bearer 密钥）上了屏。
    #   现在的做法：只要正文里出现**载荷字段特征**，就把从特征处（及其前面的引号残片）
    #   到 `"ts": <数字>}` 之间整块切掉；找不到收尾标记就切到下一个空白行。
    if not joined.strip():
        return scrub_secrets(joined)

    # ★★ 第 2.5 段：反序列化残渣（JSON 头丢了，只剩 `…"}, "ts": 1792833795.098908}`）。
    #   放在字段特征清理**之前**：这种残渣没有 `{` 也没有已知字段名，前面两条都抓不到。
    #   命中位置必须在正文靠前（前 200 字内），避免误伤正文里偶然出现的类似串。
    m_res = _TS_RESIDUE_RE.search(joined)
    if m_res and m_res.start() <= 200:
        head, tail_text = joined[: m_res.start()], joined[m_res.end() :]
        # ★ 残渣左边往往挂着半个开引号：`「随机二次元图片 涩图"}, …`
        #   那是**工具参数值**的起始引号（`"tag": "随机二次元图片 涩图"`），
        #   它连同参数名一起被模型吞掉了，只剩内容和这个孤零零的左引号。
        #   不处理就会留下 `「随机二次元图片 涩图哼，没卡…` 这种粘在一起的东西。
        #   只在这种"左引号后面到残渣之间没有右引号闭合"的形态下才吞，避免误伤正常引用。
        opened = re.search(r"[\"'\u300c\u300e\u201c]([^\"'\u300d\u300f\u201d]*)$", head)
        if opened:
            head = head[: opened.start()]
        candidate = (head + tail_text).strip()
        # 切完不能把话切空；只剩标点碎屑也算"切空"，宁可保留原文让下面几段继续处理
        if re.search(r"[\u4e00-\u9fffA-Za-z]", candidate):
            candidate = re.sub(r"^[\s\"'`\u300d\u300f\u201d]+", "", candidate)
            joined = candidate

    # 第 2 段 ★★ 2026-10-24 两次实拍：**载荷不一定以 `{` 开头**。
    #   模型把 JSON 头吞了，正文里只剩下半截：
    #     我是大肥鱼。'},ensure_ascii=False)\nfor i in range(3):\n    f='/AstrBot/…'
    #   或者 `','response_format':'wav'})\ncmd=['curl',…]`
    #   花括号扫描对它完全无效（一次 `{` 都没遇到），于是整段（含 Bearer 密钥）上了屏。
    #   现在的做法：只要正文里出现**载荷字段特征**，就把从特征处（及其前面的引号残片）
    #   到 `"ts": <数字>}` 之间整块切掉；找不到收尾标记就切到下一个空白行。
    m_field = _TOOL_FIELD_RE.search(joined)
    if m_field:
        start = m_field.start()
        # 往前吃掉紧邻的引号/逗号残片（`','`、`'` 这种），别在正文里留渣
        while start > 0 and joined[start - 1] in " \t\"',)]}:[({":
            start -= 1
        tail = joined[start:]
        m_ts = re.search(r"\"ts\"\s*:\s*\d[\d.eE+-]*\s*\}", tail)
        end = start + m_ts.end() if m_ts else (joined.find("\n\n", start) if joined.find("\n\n", start) >= 0 else len(joined))
        joined = joined[:start] + joined[end:]

    # 第 3 段：python 代码残片（`for i in range(3):` / `r=subprocess.run(` / `print(` …）
    if _PY_FRAGMENT_RE.search(joined):
        joined = re.sub(r"(?:\\n|\n)\s*(?:for\s+\w+\s+in\s+range|if\s+os\.path|if\s+sz|"
                        r"r\s*=\s*subprocess\.|subprocess\.|print\(|import\s+os|import\s+sys|"
                        r"f\s*=\s*['\"]/|body\s*=\s*json\.)[^\n]*?(?=\\n|\n|$)",
                        "", joined)

    # 第 4 段：切完之后常留下 `',}` 这种标点碎屑 → 清掉。
    #   ★ 只在"确实切过载荷"时做：正常的 `{笑}` / `{'a': 1}` 不能被误伤（回归测试里有）。
    if _TOOL_FIELD_RE.search("".join(out)) or _TS_RESIDUE_RE.search(text):
        joined = re.sub(r"[\s,'\"{}()\[\]]{2,}(?=[\u4e00-\u9fff])", " ", joined)
        joined = re.sub(r"^[\s,'\"{}()\[\]\\]+", "", joined)
        # ★ 2026-10-24：整段都是载荷时，清完会剩下 `tag":` 这类孤立键名残片。
        #   只在"确实切过载荷"的分支里做，且只删**末尾**的裸键名形态，正常正文不受影响。
        joined = re.sub(r"[\"'`]?\b(?:tag|id|name|args|ts|type|value|query)\b[\"'`]?\s*:\s*$",
                        "", joined).strip()
    # 第 5 段：最后一道保险 —— 密钥/令牌一律不进界面
    joined = scrub_secrets(joined)
    # ★ 2026-10-24 兜底：整段都是工具载荷、连一句话都没剩下时（`{"tag":` 这种残渣），
    #   宁可**返回空串**（上层就不会发气泡）也不要让半截 JSON 上屏。
    #   判据很保守：清完之后没有任何中文/正常英文单词，只剩下标点和极短残片。
    if not re.search(r"[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}", joined):
        return ""
    return joined


def mime_for_filename(filename: str) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    return _EXT_MIME.get(ext, "application/octet-stream")


# ★ 2026-10-24：附件"真实类型"判据。
#   云端语音插件会把语音当成**图文本体**发下来，SSE 里 record 帧后面紧跟着的
#   attachment_saved 往往属于下一张表情图，于是"占位符类型"和"下载回来的字节类型"
#   会错位：`[RECORD]xxx.wav` 实际下到一张 GIF、`[IMAGE]xxx.gif` 实际下到一段语音。
#   只看占位符 → 用户收到"语音"却显示成图片气泡、点开是 .wav。
#   这里改为**相信真实字节**：数据头魔数 → 其次 MIME → 最后才看扩展名/占位符。
_BINARY_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
    (b"OggS", "audio/ogg"),
    (b"fLaC", "audio/flac"),
    (b"ID3", "audio/mpeg"),
    (b"\x1aE\xdf\xa3", "audio/webm"),
)


def sniff_media_mime(data: bytes) -> str:
    """按文件头判断真实 MIME（认不出返回空串，交给调用方再用 MIME/扩展名兜底）。"""
    if not data or len(data) < 4:
        return ""
    for magic, mime in _BINARY_MAGIC:
        if data.startswith(magic):
            return mime
    if data[:4] == b"RIFF" and len(data) >= 12:
        # RIFF 容器：WAVE=音频、WEBP=图片（实测表情包里 .gif/.webp/.wav 都有）
        form = data[8:12]
        if form == b"WAVE":
            return "audio/wav"
        if form == b"WEBP":
            return "image/webp"
    if data[:2] == b"\xff\xfb" or data[:2] == b"\xff\xf3" or data[:2] == b"\xff\xf2":
        return "audio/mpeg"
    return ""


def media_kind_from_bytes(data: bytes, fallback_mime: str = "", fallback_name: str = "",
                          fallback_kind: str = "") -> str:
    """把一份**已下载的字节**归成 image / audio / other（真实字节优先）。"""
    real_mime = sniff_media_mime(data)
    if real_mime:
        return attachment_media_kind("", real_mime, "")
    return attachment_media_kind(fallback_kind, fallback_mime, fallback_name)


def _collapse_exact_doubling(text: str) -> str:
    """把"整段文字精确重复两次"压成一次。

    ★ 2026-10-24 实测：云端 `provider_tts_settings.dual_output = true` 时，
      AstrBot 会为同一句话推送**两轮 plain 帧**（一轮给 TTS、一轮给文字），
      拼起来就是 `测完就去睡觉，别熬了测完就去睡觉，别熬了`（周期 10）。
      观察链路直接把拼接结果当气泡正文，用户会看到每句话都说两遍。

    只处理"前后完全相同的整段重复"，不做任何模糊匹配 ——
    正常的叠词（"看看""慢慢"）和复读机式的循环不会误伤。
    重复 3 次以上也一并去掉（取一份）。
    """
    if not text:
        return text
    for period in range(1, len(text) // 2 + 1):
        unit = text[:period]
        if text == unit * (len(text) // period):
            return unit
    return text


@dataclass
class FeiyuMessage:
    """大肥鱼返回的消息。"""
    content: str = ""
    images: list[str] = field(default_factory=list)
    provider: str = "cloud_feiyu"
    model: str = "astrbot:333"
    raw: dict[str, Any] = field(default_factory=dict)
    # 结构化附件（含 data_url），由 routing 层的 _fetch_feiyu_attachment 填充
    attachments: list[FeiyuAttachment] = field(default_factory=list)


class CloudFeiyuClient:
    """云端 AstrBot Open API 客户端。

    配置走环境变量：
        ASTRBOT_BASE_URL   必填（云端 AstrBot 地址，http://<host>:<port>）
        ASTRBOT_API_KEY    必填（abk_ 开头）
        ASTRBOT_PERSONA_ID 默认 333（大肥鱼）
        ASTRBOT_USERNAME   默认 xiao1
        ASTRBOT_PLATFORM   默认 mao-pet
        ASTRBOT_SESSION_ID 默认微信会话 conversation_id（共享记忆）
    """

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        persona_id: str | None = None,
        username: str | None = None,
        platform_id: str | None = None,
        session_id: str | None = None,
        timeout: float = 120.0,
    ) -> None:
        # ★ 安全：base_url 同样**不写默认值**（以前默认值是真实云端服务器 IP，
        #   入库等于把自家服务器地址公开给全网扫描）。
        #   只从「参数 → 环境变量 → 后端 .env」三处取；取不到就 is_configured=False。
        self.base_url = (base_url or os.getenv("ASTRBOT_BASE_URL", "") or "").rstrip("/")
        # ★ 安全：这里**不写默认 API Key**。
        #   以前这里硬编码了 abk_ 开头的完整密钥，等于把云端机器人凭据写进源码
        #   （这个文件一旦入库，密钥就跟着进 git 历史，撤不干净）。
        #   现在只从「参数 → 环境变量 → 后端 .env」三处取；取不到就 is_configured=False，
        #   调用方会给出明确报错而不是静默打不通。
        self.api_key = (api_key or os.getenv("ASTRBOT_API_KEY", "") or "").strip()
        self.persona_id = persona_id or os.getenv("ASTRBOT_PERSONA_ID", "333")
        self.username = username or os.getenv("ASTRBOT_USERNAME", "xiao1")
        self.platform_id = platform_id or os.getenv("ASTRBOT_PLATFORM", "mao-pet")
        # ★★ 2026-10-24 云端排查：原来默认值是**微信会话的 conversation_id**，
        #   理由是"实现记忆共享"。实测代价远大于收益：
        #     · 桌宠每一轮都进入 `webchat:FriendMessage:webchat!xiao1!<微信会话>`，
        #       云端分不清"这是微信还是桌宠"，插件里写死的推送目标也不会因此变，
        #       反而把桌宠的 /setu_file 结果送去了微信（用户实拍：手机上收到图）。
        #     · 两边上下文混在一条会话里，记忆/人格互相污染。
        #   现在默认用**桌宠自己的**会话 ID（可用 ASTRBOT_SESSION_ID 覆盖）。
        #   想共享记忆请显式设 ASTRBOT_SESSION_ID=微信那个 id —— 那是明确选择，不是默认。
        self.session_id = session_id or os.getenv(
            "ASTRBOT_SESSION_ID",
            "mao-pet-desktop",
        )
        self.timeout = timeout

    @property
    def is_configured(self) -> bool:
        # base_url 与 api_key 缺一不可：只有 key 没 url 会打出畸形请求
        return bool(self.api_key) and bool(self.base_url)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    # ────────────────────────── 附件下载 ──────────────────────────
    async def fetch_attachment(
        self,
        filename: str,
        *,
        kind: str = "file",
        display: str = "",
        attachment_id: str = "",
    ) -> FeiyuAttachment:
        """把云端附件名换成真实字节（`data:` URL）。

        优先按 filename 走 `/api/v1/files/content`（只要 file scope）；
        filename 取不到时退回 attachment_id（`/api/v1/files/<id>/content`）。
        任何失败都不抛异常 —— 附件是增强，不能让整条回复失败。
        """
        att = FeiyuAttachment(
            filename=filename or "",
            kind=(kind or "file").lower(),
            display=display or filename or "",
            mime_type=mime_for_filename(filename),
        )
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            async with httpx.AsyncClient(timeout=min(self.timeout, 60.0), follow_redirects=True) as client:
                resp = None
                if filename:
                    resp = await client.get(
                        f"{self.base_url}/api/v1/files/content",
                        params={"filename": filename},
                        headers=headers,
                    )
                if (resp is None or resp.status_code != 200) and attachment_id:
                    resp = await client.get(
                        f"{self.base_url}/api/v1/files/{attachment_id}/content",
                        headers=headers,
                    )
                if resp is None:
                    att.error = "缺少 filename / attachment_id"
                    return att
                if resp.status_code != 200:
                    # 云端用 JSON 返回错误（如 {"status":"error","message":"File access error"}）
                    att.error = f"HTTP {resp.status_code}"
                    try:
                        body = resp.json()
                        if isinstance(body, dict) and body.get("message"):
                            att.error = f"HTTP {resp.status_code}: {body['message']}"
                    except Exception:
                        pass
                    return att

                raw = resp.content or b""
                if not raw:
                    att.error = "云端返回空文件"
                    return att

                # ★★ 2026-10-24：先按数据头认出**真实类型**，再决定上限和 MIME。
                #   错位场景下占位符写 record、字节却是 1.6MB 的 GIF；
                #   旧代码按占位符 kind 选上限，会把大表情图当"音频"放过 MAX_IMAGE_BYTES 检查。
                real_mime = sniff_media_mime(raw)
                real_kind = media_kind_from_bytes(raw, mime_for_filename(filename), filename, kind)
                if real_kind in ("image", "audio"):
                    att.kind = real_kind
                ctype = (resp.headers.get("content-type") or "").split(";")[0].strip()
                if real_mime:
                    # 魔数比"响应头"和"占位符"都可信；响应头常被云端随手写成 octet-stream
                    att.mime_type = real_mime
                elif ctype and ctype not in ("application/octet-stream", "text/plain"):
                    att.mime_type = ctype

                # 图片用单独的小上限（不需要把 20MB 的图塞进 data: URL），
                # 其它类型（歌曲/语音/文件）走大上限。
                limit = MAX_IMAGE_BYTES if att.kind == "image" else MAX_ATTACHMENT_BYTES
                if len(raw) > limit:
                    att.error = f"附件过大（{len(raw) / 1048576:.1f}MB，上限 {limit / 1048576:.0f}MB）"
                    att.size = len(raw)
                    return att

                b64 = base64.b64encode(raw).decode("ascii")
                att.size = len(raw)
                att.data_url = f"data:{att.mime_type};base64,{b64}"
                return att
        except Exception as exc:  # 网络/超时/解析：一律降级为"附件取不到"
            att.error = f"{type(exc).__name__}: {exc}"
            return att

    async def fetch_attachments(
        self,
        items: list[tuple[str, str, str]],
    ) -> list[FeiyuAttachment]:
        """批量下载。items = [(kind, raw_payload, attachment_id)]，内部自己拆显示名。"""
        results: list[FeiyuAttachment] = []
        for kind, payload, attachment_id in items:
            if not payload:
                continue
            stored, display = split_attachment_payload(kind, payload)
            results.append(
                await self.fetch_attachment(
                    stored,
                    kind=kind,
                    display=display,
                    attachment_id=attachment_id,
                )
            )
        return results

    def _build_payload(
        self,
        message: str,
        session_id: str,
        *,
        config_id: str | None = None,
        images: list[str] | None = None,
        stream: bool = False,
    ) -> dict[str, Any]:
        """构造请求体。

        ★ 多模态入站（本机→云端）：AstrBot 的 `message` 接受**消息段数组**，
          图片段长这样：{"type": "image", "attachment_id": "<先用 /api/v1/file 上传拿到的 id>"}。
          所以 `images` 里的 data URL **不能直接塞进 message**，必须先调 upload_attachment() 换成
          attachment_id。这里只做"已经拿到 attachment_id 时的拼装"，上传逻辑在上层（要 await）。
        """
        payload: dict[str, Any] = {
            "username": self.username,
            "platform_id": self.platform_id,
            "enable_streaming": stream,
        }
        # 不传 config_id，用 session 关联的默认配置（大肥鱼 persona）
        if config_id:
            payload["config_id"] = config_id

        segments: list[dict[str, Any]] = []
        if message:
            segments.append({"type": "plain", "text": message})
        for item in images or []:
            # 已经是 attachment_id（上传后）→ 直接拼段；仍是 data URL 的说明上层漏了上传，
            # 宁可报错也不要静默丢图（静默丢图正是这次要修的病灶）。
            if isinstance(item, str) and item.startswith("data:"):
                raise RuntimeError(
                    "图片必须先经 upload_attachment() 换成 attachment_id 再发送"
                )
            if isinstance(item, str) and item:
                segments.append({"type": "image", "attachment_id": item})

        if segments and any(seg["type"] != "plain" for seg in segments):
            payload["message"] = segments
        else:
            payload["message"] = message
        # 会话放在最后，保持与旧请求体字段顺序一致（便于比对日志）
        payload["session_id"] = session_id
        return payload

    # ────────────────────────── 附件上传（本机 → 云端）──────────────────────────
    async def upload_attachment(self, data_url: str, *, filename: str = "image.png") -> str:
        """把一张 data URL 图片上传到 AstrBot，返回 attachment_id。

        `POST /api/v1/file`（multipart，字段名 `file`），HTTP 200 返回 json，
        我们从常见字段里取 id；取不到就抛错（调用方会把错误回传给用户）。
        """
        if not self.api_key:
            raise RuntimeError("ASTRBOT_API_KEY / ASTRBOT_BASE_URL 未配置")
        if not isinstance(data_url, str) or not data_url.startswith("data:"):
            raise RuntimeError("upload_attachment 需要 data: URL")
        header, _, b64 = data_url.partition(",")
        mime = header[5:].split(";")[0] or "image/png"
        try:
            raw = base64.b64decode(b64, validate=False)
        except Exception as exc:
            raise RuntimeError(f"图片 data URL 解码失败：{exc}") from exc
        if not raw:
            raise RuntimeError("图片内容为空")
        if len(raw) > MAX_ATTACHMENT_BYTES:
            raise RuntimeError(f"图片过大（{len(raw) / 1048576:.1f}MB）")

        async with httpx.AsyncClient(timeout=min(self.timeout, 90.0)) as client:
            resp = await client.post(
                f"{self.base_url}/api/v1/file",
                headers={"Authorization": f"Bearer {self.api_key}"},
                files={"file": (filename, raw, mime)},
            )
            if resp.status_code != 200:
                detail = ""
                try:
                    detail = str(resp.json())
                except Exception:
                    detail = resp.text[:200]
                raise RuntimeError(f"上传失败 HTTP {resp.status_code}: {detail}")
            body = resp.json() if resp.content else {}
        # 兼容几种返回形状：{"data": {...}} / {"data": "id"} / 顶层字段
        node = body.get("data") if isinstance(body, dict) and "data" in body else body
        attachment_id = ""
        if isinstance(node, str):
            attachment_id = node
        elif isinstance(node, dict):
            attachment_id = str(
                node.get("attachment_id") or node.get("id") or node.get("file_id") or ""
            )
        if not attachment_id:
            raise RuntimeError(f"上传成功但没拿到 attachment_id：{str(body)[:200]}")
        return attachment_id

    async def chat(
        self,
        message: str,
        session_id: str | None = None,
        *,
        config_id: str | None = None,
        images: list[str] | None = None,
    ) -> FeiyuMessage:
        """非流式对话，返回完整回复。"""
        if not self.is_configured:
            raise RuntimeError("ASTRBOT_API_KEY / ASTRBOT_BASE_URL 未配置")

        url = f"{self.base_url}/api/v1/chat"
        payload = self._build_payload(
            message,
            session_id or self.session_id,
            config_id=config_id,
            images=images,
            stream=False,
        )

        # AstrBot 即使非流式也返回 SSE 文本流，需要逐行解析拼接
        # ★ 去重规则与 chat_stream_full 一致：plain 增量与 complete 全文**二选一**，
        #   两路都拼会把正文写两遍（实测症状：同一句话重复出现）。
        collected: list[str] = []
        complete_text = ""
        _seen_names: set[str] = set()
        placeholders: list[tuple[str, str, str]] = []
        current_attachment_id = ""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream("POST", url, headers=self._headers(), json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    frame = self._parse_sse_event(line)
                    if frame is None:
                        continue
                    dtype = str(frame.get("type") or "")
                    # attachment_saved 帧给出下一个附件的 attachment_id（下载兜底用）
                    if dtype == "attachment_saved":
                        info = frame.get("data") or {}
                        if isinstance(info, dict):
                            current_attachment_id = str(info.get("id") or "")
                        continue
                    if dtype == "complete":
                        complete_text = self._frame_text(frame)
                        continue
                    if dtype == "plain":
                        text = self._frame_text(frame)
                        if text:
                            collected.append(text)
                        continue
                    parsed = self._frame_attachment(frame)
                    if parsed:
                        # 2026-10-24：同一条附件会在流式帧 + complete 全文里各出现一次，
                        # 按云端存储名去重，避免下载/播放两遍。
                        stored_name = split_attachment_payload(parsed[0], parsed[1])[0].strip()
                        if not stored_name or stored_name not in _seen_names:
                            if stored_name:
                                _seen_names.add(stored_name)
                            placeholders.append((parsed[0], parsed[1], current_attachment_id))
                        current_attachment_id = ""

        content = "".join(collected)
        if not content.strip() and complete_text.strip():
            content = complete_text
        # 有的部署把附件放在 complete.chain 里，兜底再扫一遍全文占位符
        if not placeholders:
            for m in _ATTACH_RE.finditer(content):
                placeholders.append((m.group(1).lower(), m.group(2), ""))
            if placeholders:
                content = "\n".join(
                    line for line in content.split("\n")
                    if not _ATTACH_RE.match(line.strip())
                ).strip()
        attachments = await self.fetch_attachments(placeholders)
        return FeiyuMessage(
            content=content,
            images=[a.data_url for a in attachments if a.is_image],
            attachments=attachments,
            raw={"chunks": len(collected), "attachments": len(attachments)},
        )

    async def chat_stream(
        self,
        message: str,
        session_id: str | None = None,
        *,
        config_id: str | None = None,
        images: list[str] | None = None,
    ) -> AsyncGenerator[str, None]:
        """流式对话，逐段 yield 文本增量。"""
        if not self.is_configured:
            raise RuntimeError("ASTRBOT_API_KEY / ASTRBOT_BASE_URL 未配置")

        url = f"{self.base_url}/api/v1/chat"
        payload = self._build_payload(
            message,
            session_id or self.session_id,
            config_id=config_id,
            images=images,
            stream=True,
        )

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream("POST", url, headers=self._headers(), json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    chunk = self._parse_sse_line(line)
                    if chunk:
                        yield chunk

    async def chat_text_diagnosed(
        self,
        message: str,
        session_id: str | None = None,
        *,
        images: list[str] | None = None,
    ) -> tuple[str, dict[str, Any]]:
        """只要正文，但把帧级诊断一起带出来（不下载附件、不碰助手气泡）。

        用途：屏幕观察这类"图 + 一句话 → 要一句完整回话"的调用方。
        与 chat_stream_full 的差别：这里**不下载**云端回传的图片/语音（观察链路用不上，
        下载一堆附件纯属浪费带宽），但同样认 plain 增量 + complete 兜底。

        ★★ 必须 `enable_streaming: true`（2026-10-24 实测对比，各跑 2 次）：
          · stream=false → **0/2 有正文**，帧序列只有 agent_stats + record（语音）+ image；
            云端 TTS 插件在大肥鱼这轮改成"语音输出"时，正文就整个不进 SSE 了。
          · stream=true  → **2/2 有正文**，逐 token 的 plain 增量齐全，complete 也有全文。
          即：只有流式请求能稳定拿到她的文字。这也是大肥鱼聊天主链路一直用
          chat_stream_full(stream=True) 的原因 —— 它从没踩到"只有语音没字"。
        """
        if not self.is_configured:
            raise RuntimeError("ASTRBOT_API_KEY / ASTRBOT_BASE_URL 未配置")
        payload = self._build_payload(
            message,
            session_id or self.session_id,
            images=images,
            stream=True,
        )
        plain_frames = 0
        complete_frames = 0
        streamed_text = ""
        complete_text = ""
        agent_stats: dict[str, Any] = {}
        frames_seen: list[str] = []
        record_frames = 0
        record_files: list[str] = []
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream(
                "POST", f"{self.base_url}/api/v1/chat", headers=self._headers(), json=payload
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    frame = self._parse_sse_event(line)
                    if frame is None:
                        continue
                    dtype = str(frame.get("type") or "")
                    # ★ 只记**帧种类**（不含正文），用于排查"云端到底回了什么"。
                    #   实测过：一轮里只来 agent_stats / record / image，一个正文帧都没有。
                    if len(frames_seen) < 40:
                        frames_seen.append(dtype or "?")
                    if dtype == "plain":
                        text = self._frame_text(frame)
                        if text:
                            streamed_text += text
                            plain_frames += 1
                        continue
                    if dtype == "complete":
                        complete_text = self._frame_text(frame)
                        complete_frames += 1
                        continue
                    if dtype == "agent_stats":
                        info = frame.get("data")
                        if isinstance(info, dict):
                            agent_stats = info
                        continue
                    if dtype == "record":
                        # 云端把她这轮的话转成了语音：说明"她确实说了话，只是文字没以帧下发"
                        record_frames += 1
                        # ★ 2026-10-25：把 record 的文件名留下来。
                        #   云端 TTS 一旦开启，每次回复都会合成 wav（实测 545~666KB / 11~14 秒），
                        #   桌宠要放这段语音只需按文件名去 /api/v1/files/content 取字节 ——
                        #   本地不需要任何 TTS 代码，也不用再调一次合成接口。
                        rec_name = str(frame.get("data") or "").strip()
                        rec_name = rec_name.replace("[RECORD]", "").strip()
                        if rec_name and rec_name not in record_files:
                            record_files.append(rec_name)
        content = streamed_text
        if not content.strip() and complete_text.strip():
            content = complete_text
        content = _collapse_exact_doubling(strip_tool_payload(strip_reasoning_prefix(content)).strip())
        return content, {
            "plain_frames": plain_frames,
            "complete_frames": complete_frames,
            "record_frames": record_frames,
            "record_files": record_files,
            "agent_stats": agent_stats,
            "frames": frames_seen,
        }

    async def chat_stream_full(
        self,
        message: str,
        session_id: str | None = None,
        *,
        config_id: str | None = None,
        images: list[str] | None = None,
        session_out: dict[str, Any] | None = None,
        force_streaming: bool = True,
    ) -> AsyncGenerator[tuple[str, list[str]], None]:
        """流式对话，逐段 yield (文本增量, 附件原始字节列表)。

        ★ 这里 yield 的第二个元素以前是"图片 URL"，现在是 **data: URL（真实字节）**，
          因为这正是桌宠前端 `<img src>` 能直接用的形状。
          下载在关键帧处做：attachment_saved 帧到达、或流结束时统一补齐，
          这样"文本先到、图后到"的时序不会让图丢掉。

        session_out 可选：传入 dict 时，结束时写入 {"attachments": [...]}，
        方便调用方在流结束后拿到结构化附件（不依赖 yield 的第二个元素）。

        force_streaming=False：向云端要**非**流式回复（`enable_streaming: false`）。
          ★ 2026-10-24 实测：云端 persona 绑的模型是**非流式**时，AstrBot 只回一个
          `complete` 帧、一个 `plain` 增量都没有，短回复尤其常见；而这条入口的正文只认
          `plain` 增量（complete 只在"全程没有 plain"时兜底，见下方 streamed_text 注释）。
          只要前面混进一个非空的 plain 帧，整段正文就会被丢光 —— 屏幕观察这种
          "要一句完整结论"的调用方必须能显式要非流式，才拿得到正文。
          函数名仍叫 stream_*：SSE 这条传输没变，只是云端不再逐 token 推。
        """
        if not self.is_configured:
            raise RuntimeError("ASTRBOT_API_KEY / ASTRBOT_BASE_URL 未配置")

        url = f"{self.base_url}/api/v1/chat"
        payload = self._build_payload(
            message,
            session_id or self.session_id,
            config_id=config_id,
            images=images,
            stream=bool(force_streaming),
        )

        pending: list[tuple[str, str, str]] = []
        current_attachment_id = ""
        all_ready: list[FeiyuAttachment] = []
        # ★★ 2026-10-24 修「对话界面出现两条一模一样的语音」。
        #   AstrBot 同一条占位符会**发两次**：一次在流式增量里、一次在最后的 complete
        #   全文里（`complete.chain` 也带着 `[RECORD]xxx.wav`）。旧实现每次 `_frame_attachment`
        #   命中就 append + 立即下载，于是同一份字节被下载两遍、落盘成同一个哈希文件，
        #   前端拿到两条 url 完全相同的 agent_audio —— 用户看到就是两个播放器。
        #   这里按占位符的**云端存储名**去重（同一轮里同名即同一份文件）。
        _seen_placeholders: set[str] = set()

        def _is_duplicate(parsed: tuple[str, str]) -> bool:
            stored = split_attachment_payload(parsed[0], parsed[1])[0].strip()
            if not stored:
                return False
            if stored in _seen_placeholders:
                return True
            _seen_placeholders.add(stored)
            return False

        # ★ 去重：AstrBot 先逐 token 推 `plain`，最后再推一个 `complete` 帧，
        #   而 complete 的 data 是**整段文本**（实测：15 个 plain 增量 + 1 个 complete 全文）。
        #   如果两边都累加，正文就变成"XXX…XXX…"。策略：
        #     · 出现过 plain 增量 → 只认 plain；complete 帧只在需要时用于校验/兜底；
        #     · 全程没有 plain（短回答可能只发 complete）→ 用 complete 的文本。
        streamed_text = ""
        complete_text = ""
        plain_frames = 0
        complete_frames = 0
        last_agent_stats: dict[str, Any] = {}

        async def _flush() -> list[str]:
            """把攒下的占位符下载成 data URL，yield 用的就是它的返回。"""
            nonlocal pending
            if not pending:
                return []
            fetched = await self.fetch_attachments(pending)
            pending = []
            all_ready.extend(fetched)
            if session_out is not None:
                # ★ 音频不内联（inline_audio=False）：见 to_dict 注释。
                #   这里给的是**元信息**，真正的字节由上层落盘成 /api/companion/agent-media/xxx。
                #   同时留一份带字节的完整对象（下划线前缀 = 内部字段），
                #   给上层落盘用；**绝不能**直接塞进 HTTP 响应或 WS 帧。
                # ★★ 2026-10-24 修「语音在这条链路上时有时无」：
                #   一次回复里可能先后到两张附件（实测：先用图片帧回表情，再用
                #   record 帧结尾回语音）。旧实现每次 flush 都**整份覆盖**这两个字段，
                #   后到的那批会把先到的整批顶掉 —— 表现就是"云端明明合成了语音、
                #   云端日志也写了 Prepare to send [Record]，对话界面却一张音频都没有"。
                #   这里改成覆盖式重算（从 all_ready 全量重建）：
                #   字符串键仍然每次刷新，内部字节对象用新列表整体替换，
                #   上层拿到的永远是"到目前为止全部附件"，不会丢也不会重复。
                session_out["attachments"] = [a.to_dict(inline_payload=False) for a in all_ready]
                session_out["_raw_attachments"] = list(all_ready)
            # ★ 第二个返回值只给**图片**：调用方把它当 <img> 的 src 用。
            #   以前把所有附件都塞进来，点歌的 mp3 就被当成图片发了出去
            #   （实测前端收到 `agent_image`，url 却是 `data:audio/mpeg;base64,...`）。
            #   音频/文件请读 session_out["attachments"] / ["_raw_attachments"]。
            return [
                a.data_url for a in fetched
                if a.data_url and attachment_media_kind(a.kind, a.mime_type, a.filename) == "image"
            ]

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream("POST", url, headers=self._headers(), json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    frame = self._parse_sse_event(line)
                    if frame is None:
                        continue
                    dtype = str(frame.get("type") or "")

                    if dtype == "attachment_saved":
                        info = frame.get("data") or {}
                        if isinstance(info, dict):
                            current_attachment_id = str(info.get("id") or "")
                        # 附件此刻已落盘，立即下载（此时 file scope 一定取得到）
                        if pending:
                            ready = await _flush()
                            if ready:
                                yield "", ready
                        continue

                    text = self._frame_text(frame)
                    parsed = self._frame_attachment(frame)
                    if parsed:
                        if _is_duplicate(parsed):
                            # 同一条附件在 complete 全文里又出现了一次：不再下载第二份
                            continue
                        pending.append((parsed[0], parsed[1], current_attachment_id))
                        current_attachment_id = ""
                        # 有的部署不发 attachment_saved，收到占位符就尝试下载
                        ready = await _flush()
                        if ready:
                            yield "", ready
                        continue

                    if dtype == "complete":
                        # 完整文本帧：不直接 yield（前面 plain 已经推过同样内容了），
                        # 留到流结束时决定要不要用它兜底。
                        complete_text = text
                        complete_frames += 1
                        if pending:
                            ready = await _flush()
                            if ready:
                                yield "", ready
                        continue

                    if dtype == "plain" and text:
                        streamed_text += text
                        plain_frames += 1
                        yield text, []

                    if dtype == "agent_stats":
                        info = frame.get("data")
                        if isinstance(info, dict):
                            last_agent_stats = info

                    if dtype == "end" and pending:
                        ready = await _flush()
                        if ready:
                            yield "", ready

        # 收尾：一路没有 plain（或 plain 全是空白）时才用 complete 的全文兜底。
        # 注意这里不能"追加"，只能"补"——两边都拼就是文本重复。
        if not streamed_text.strip() and complete_text.strip():
            streamed_text = complete_text
            yield complete_text, []
        # ★ 思考泄漏清理：流式期间是逐 token 推的，没法在增量上判断"这句是不是英文思考"，
        #   只能在全文到齐后再做一次行级清洗。清洗结果与原文不同时，把差异通过
        #   `text_replace` 告诉上层（它会把桌宠气泡里的内容整体替换成干净文本），
        #   避免"气泡里挂着英文、聊天页里却是干净的"两套文本不一致。
        cleaned = strip_reasoning_prefix(streamed_text)
        if cleaned != streamed_text:
            streamed_text = cleaned
            yield "", []  # 占位保证生成器非空语义不变
        # 偶发：工具调用轮次的 complete.data 是裸 JSON（见 strip_tool_payload 注释）
        without_tool = strip_tool_payload(streamed_text)
        if without_tool != streamed_text:
            streamed_text = without_tool
            yield "", []
        if session_out is not None:
            session_out["text"] = streamed_text
            # ★ 2026-10-24：把**正文帧**的诊断信息留给调用方。真实事故：一轮里只收到
            #   agent_stats + record 帧、一个 plain/complete 都没有 → 正文空，而不是"她没说话"。
            #   调用方（屏幕观察）要能区分"云端没回文字"和"网络/解析出错"，才好给用户交代。
            session_out["frames"] = {
                "plain_frames": plain_frames,
                "complete_frames": complete_frames,
                "agent_stats": last_agent_stats,
            }

        # 流结束收尾：理论上不会剩，兜底一次
        ready = await _flush()
        if ready:
            yield "", ready

    def _extract_content(self, data: dict[str, Any]) -> tuple[str, list[str]]:
        """从响应中提取文本和图片 URL。"""
        if isinstance(data, str):
            return data, []
        if not isinstance(data, dict):
            return str(data), []

        images: list[str] = []

        # AstrBot SSE 格式：type=plain 的 data 字段是回复正文
        if data.get("type") == "plain":
            content = str(data.get("data", ""))
            return content, images

        # 常见字段路径提取文本
        content = ""
        for key in ("content", "message", "reply", "text"):
            val = data.get(key)
            if isinstance(val, str) and val:
                content = val
                break
            if isinstance(val, dict):
                for sub in ("content", "text", "message"):
                    if isinstance(val.get(sub), str):
                        content = val[sub]
                        break
                if content:
                    break

        # 提取图片
        for key in ("images", "image_urls", "attachments"):
            val = data.get(key)
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, str):
                        images.append(item)
                    elif isinstance(item, dict):
                        url = item.get("url") or item.get("image_url")
                        if url:
                            images.append(url)

        return content or json.dumps(data, ensure_ascii=False), images

    def _parse_sse_event(self, line: str) -> dict[str, Any] | None:
        """把一行 SSE 解析成帧 dict。非 data 行（如 `: heartbeat`）返回 None。"""
        line = line.strip()
        if not line or line.startswith(":"):
            return None
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line == "[DONE]":
            return None
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            # 非 JSON 的 data 行：当作纯文本增量
            return {"type": "plain", "data": line}
        return data if isinstance(data, dict) else {"type": "plain", "data": str(data)}

    @staticmethod
    def _frame_text(frame: dict[str, Any]) -> str:
        """从帧里取**正文**文本（思考过程一律丢弃）。

        ★ 决定性的字段：`chain_type`
            实测 AstrBot v4.29.1 会把模型的思考过程也当成 `plain` 帧逐 token 推下来，
            但带 `"chain_type": "reasoning"`：
                {"type":"plain","data":"He","chain_type":"reasoning",...}
                {"type":"plain","data":" asks","chain_type":"reasoning",...}
            正文字段则是 `plain` 且 `chain_type` 为 null，或者 `complete` 帧的 `data`。
            旧实现不看 chain_type → **思考过程直接进了桌宠气泡**（用户看到满屏英文思考）。

        次选：`complete` 帧带一个独立的 `reasoning` 字段，也**绝不读**。
        """
        dtype = str(frame.get("type") or "")
        # 思考帧：直接丢弃（不参与正文拼接）
        chain_type = str(frame.get("chain_type") or "").lower()
        if chain_type in ("reasoning", "think", "thinking"):
            return ""
        if dtype in ("plain", "complete"):
            # 在拉流阶段就把控制标记剥掉（见 strip_control_markers 注释）
            # ★ 2026-10-24：密钥/令牌擦除必须在**拉流阶段**就做 —— 桌宠横条
            #   (`agent_stream`) 是逐帧推的，收尾清洗只能修气泡和聊天页，
            #   早已推出去的帧改不回来。用户那轮就是横条里先出现 sk-…
            return scrub_secrets(strip_control_markers(str(frame.get("data") or "")))
        choices = frame.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            delta = choices[0].get("delta") or {}
            return str(delta.get("content") or "")
        return ""

    @staticmethod
    def _frame_attachment(frame: dict[str, Any]) -> tuple[str, str] | None:
        """从帧里取附件占位符 → (kind, raw_payload)。"""
        parsed = parse_attachment_placeholder(frame.get("data"))
        if parsed:
            return parsed
        # 兼容 OpenAI 风格帧里夹带的 image_url / images
        choices = frame.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            delta = choices[0].get("delta") or {}
            for key in ("image_url", "images"):
                val = delta.get(key)
                if isinstance(val, str) and val:
                    return "image", val
                if isinstance(val, list):
                    for item in val:
                        if isinstance(item, str) and item:
                            return "image", item
                        if isinstance(item, dict) and item.get("url"):
                            return "image", str(item["url"])
        return None

    def _parse_sse_line(self, line: str) -> str:
        """解析 SSE 一行，返回增量文本（附件帧返回空串）。"""
        frame = self._parse_sse_event(line)
        if frame is None:
            return ""
        return self._frame_text(frame)

    def _parse_sse_line_full(self, line: str) -> tuple[str, list[str]]:
        """解析 SSE 一行 → (文本增量, 附件占位符原始串列表)。

        ★ 注意返回值第二项的语义已修正：以前是"当成图片 URL 的占位符"，
          现在原样返回 `[IMAGE]xxx.png` 这类占位符，**由调用方下载成真实字节**。
          历史调用方若直接拿它当 URL 用，现在会拿到 `[IMAGE]…`（可被识别）。
        """
        frame = self._parse_sse_event(line)
        if frame is None:
            return "", []
        attachments: list[str] = []
        parsed = self._frame_attachment(frame)
        if parsed:
            attachments.append(parsed[1])
        return self._frame_text(frame), attachments



# 单例
_default_client: CloudFeiyuClient | None = None


def get_client() -> CloudFeiyuClient:
    global _default_client
    if _default_client is None:
        _default_client = CloudFeiyuClient()
    return _default_client
