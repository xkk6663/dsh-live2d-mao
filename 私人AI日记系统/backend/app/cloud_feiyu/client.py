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
        strong = {"tool_calls", "function", "arguments", "args", "result", "call_id"}
        if keys & strong:
            return True
        # 回执形态：只有 id/ts/result 这类键、没有自然语言正文
        return {"id", "ts"} <= keys and len(keys) <= 6

    def balanced_json_at(s: str, start: int) -> str | None:
        """从 s[start] == '{' 起，找配对 '}' 的位置（考虑字符串与转义）。"""
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(s)):
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
                if depth == 0:
                    return s[start:i + 1]
        return None

    # 扫描全文：把"可解析且判定为工具载荷"的 JSON 对象整块剥掉，
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
    return "".join(out)


def mime_for_filename(filename: str) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    return _EXT_MIME.get(ext, "application/octet-stream")


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
        ASTRBOT_BASE_URL   默认 http://127.0.0.1:6185
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
        self.base_url = (base_url or os.getenv("ASTRBOT_BASE_URL", "http://127.0.0.1:6185")).rstrip("/")
        # ★ 安全：这里**不写默认 API Key**。
        #   以前这里硬编码了 abk_ 开头的完整密钥，等于把云端机器人凭据写进源码
        #   （这个文件一旦入库，密钥就跟着进 git 历史，撤不干净）。
        #   现在只从「参数 → 环境变量 → 后端 .env」三处取；取不到就 is_configured=False，
        #   调用方会给出明确报错而不是静默打不通。
        self.api_key = (api_key or os.getenv("ASTRBOT_API_KEY", "") or "").strip()
        self.persona_id = persona_id or os.getenv("ASTRBOT_PERSONA_ID", "333")
        self.username = username or os.getenv("ASTRBOT_USERNAME", "xiao1")
        self.platform_id = platform_id or os.getenv("ASTRBOT_PLATFORM", "mao-pet")
        # 默认用微信会话的 conversation_id，实现记忆共享
        self.session_id = session_id or os.getenv(
            "ASTRBOT_SESSION_ID",
            "d93c5ca6-c3d8-47a0-a9ea-124334bcde70",
        )
        self.timeout = timeout

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

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
                # 图片用单独的小上限（不需要把 20MB 的图塞进 data: URL），
                # 其它类型（歌曲/语音/文件）走大上限。
                limit = MAX_IMAGE_BYTES if att.kind == "image" else MAX_ATTACHMENT_BYTES
                if len(raw) > limit:
                    att.error = f"附件过大（{len(raw) / 1048576:.1f}MB，上限 {limit / 1048576:.0f}MB）"
                    att.size = len(raw)
                    return att

                ctype = (resp.headers.get("content-type") or "").split(";")[0].strip()
                # 云端有时给 application/octet-stream，此时用扩展名猜的 MIME 更准
                if ctype and ctype not in ("application/octet-stream", "text/plain"):
                    att.mime_type = ctype
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
            raise RuntimeError("ASTRBOT_API_KEY 未配置")
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
            raise RuntimeError("ASTRBOT_API_KEY 未配置")

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
            raise RuntimeError("ASTRBOT_API_KEY 未配置")

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

    async def chat_stream_full(
        self,
        message: str,
        session_id: str | None = None,
        *,
        config_id: str | None = None,
        images: list[str] | None = None,
        session_out: dict[str, Any] | None = None,
    ) -> AsyncGenerator[tuple[str, list[str]], None]:
        """流式对话，逐段 yield (文本增量, 附件原始字节列表)。

        ★ 这里 yield 的第二个元素以前是"图片 URL"，现在是 **data: URL（真实字节）**，
          因为这正是桌宠前端 `<img src>` 能直接用的形状。
          下载在关键帧处做：attachment_saved 帧到达、或流结束时统一补齐，
          这样"文本先到、图后到"的时序不会让图丢掉。

        session_out 可选：传入 dict 时，结束时写入 {"attachments": [...]}，
        方便调用方在流结束后拿到结构化附件（不依赖 yield 的第二个元素）。
        """
        if not self.is_configured:
            raise RuntimeError("ASTRBOT_API_KEY 未配置")

        url = f"{self.base_url}/api/v1/chat"
        payload = self._build_payload(
            message,
            session_id or self.session_id,
            config_id=config_id,
            images=images,
            stream=True,
        )

        pending: list[tuple[str, str, str]] = []
        current_attachment_id = ""
        all_ready: list[FeiyuAttachment] = []
        # ★ 去重：AstrBot 先逐 token 推 `plain`，最后再推一个 `complete` 帧，
        #   而 complete 的 data 是**整段文本**（实测：15 个 plain 增量 + 1 个 complete 全文）。
        #   如果两边都累加，正文就变成"XXX…XXX…"。策略：
        #     · 出现过 plain 增量 → 只认 plain；complete 帧只在需要时用于校验/兜底；
        #     · 全程没有 plain（短回答可能只发 complete）→ 用 complete 的文本。
        streamed_text = ""
        complete_text = ""

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
                session_out["attachments"] = [a.to_dict(inline_payload=False) for a in all_ready]
                session_out["_raw_attachments"] = all_ready
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
                        if pending:
                            ready = await _flush()
                            if ready:
                                yield "", ready
                        continue

                    if dtype == "plain" and text:
                        streamed_text += text
                        yield text, []

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
            return strip_control_markers(str(frame.get("data") or ""))
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
