"""零 token 中继服务 —— 大肥鱼传输面板的云端通道（2026-10-26 第二期）。

与 transfer_receiver（WS 投递）不同，本模块服务于聊天页右侧传输面板：
- poll_messages(): 拉云端 relay_inbox.json（微信「#传」经云端插件 stop_event 拦截后写入）
- send_text_files(): 把面板消息 upload 成 *relay_*.json 落在云端 attachments，
  云端插件扫描后 context.send_message 直推微信 —— 全程不经过任何 LLM。

零 token 的保证：两条路都不调 /api/v1/chat。
"""

from __future__ import annotations

import base64
import logging
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("cloud_feiyu.relay")

RELAY_INBOX_FILENAME = "relay_inbox.json"
SENT_HISTORY_FILENAME = "relay_sent_history.json"
SENT_HISTORY_MAX = 200

_IMAGE_MIME_PREFIX = "image/"


def _guess_kind(mime: str, name: str) -> str:
    mime = (mime or "").lower()
    if mime.startswith(_IMAGE_MIME_PREFIX):
        return "image"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in {"png", "jpg", "jpeg", "gif", "webp", "bmp"}:
        return "image"
    return "file"


async def poll_messages() -> dict[str, Any]:
    """拉取微信→电脑的中继清单（全量，容量上限 200 条，前端按 id 去重增量渲染）。"""
    from . import get_client as get_feiyu_client

    client = get_feiyu_client()
    if not client.is_configured:
        return {"ok": False, "error": "云端大肥鱼未配置", "entries": []}
    att = await client.fetch_attachment(RELAY_INBOX_FILENAME, kind="file", display="中继收件箱")
    if getattr(att, "error", ""):
        # 清单还不存在 = 还没有微信侧消息，属正常空态
        return {"ok": True, "entries": []}
    try:
        _, _, payload = att.data_url.partition(",")
        manifest = json_loads(base64.b64decode(payload).decode("utf-8", "replace"))
    except Exception:
        logger.warning("中继清单解析失败", exc_info=True)
        return {"ok": False, "error": "清单解析失败", "entries": []}
    entries = manifest.get("entries") if isinstance(manifest, dict) else None
    if not isinstance(entries, list):
        entries = []
    return {"ok": True, "entries": [e for e in entries if isinstance(e, dict)]}


def json_loads(raw: str) -> Any:
    import json

    return json.loads(raw)


async def send_text_files(
    text: str,
    files: list[tuple[str, bytes, str]],
) -> dict[str, Any]:
    """把面板的一条消息发往微信（零 token）。

    files: [(原始文件名, 字节, mime)]；附件先逐个上传换 stored 文件名，
    再把整条消息打包成 relay_*.json 上传，云端插件 2s 内扫描直推微信。
    """
    from . import get_client as get_feiyu_client

    client = get_feiyu_client()
    if not client.is_configured:
        raise RuntimeError("云端大肥鱼未配置（ASTRBOT_API_KEY / ASTRBOT_BASE_URL）")
    text = str(text or "").strip()
    if not text and not files:
        raise ValueError("消息为空")

    items: list[dict[str, str]] = []
    for name, raw, mime in files:
        name = str(name or "file").strip() or "file"
        # 附件文件名带上 relay_ 前缀没必要，中继 JSON 才需要被扫描匹配
        data_url = f"data:{mime or 'application/octet-stream'};base64," + base64.b64encode(raw).decode("ascii")
        info = await client.upload_attachment_full(data_url, filename=name)
        items.append({
            "name": name,
            "stored": info["stored"],
            "kind": _guess_kind(mime, name),
        })

    ts = int(time.time())
    entry = {
        "id": uuid.uuid4().hex[:12],
        "ts": ts,
        "from": "pc",
        "text": text,
        "files": items,
    }
    relay_name = f"relay_{ts}_{entry['id']}.json"
    relay_body = json_dumps({"text": text, "files": items})
    data_url = "data:application/json;base64," + base64.b64encode(relay_body.encode("utf-8")).decode("ascii")
    await client.upload_attachment_full(data_url, filename=relay_name)
    logger.info("[relay] 电脑→微信已入队: %d 附件 (id=%s)", len(items), entry["id"])
    return {"ok": True, "id": entry["id"], "ts": ts, "text": text, "files": items}


def json_dumps(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False)


# ---------------------------------------------------------------------------
# 发送留底（服务端持久化，2026-10-26 第三期）
# 面板发出的消息此前只存 localStorage，桌宠窗口的 WebView 存储不保证持久，
# "每次打开都是空的"。改存到桌宠状态目录（与 crosssend_cursor 同机制），
# 任何窗口、重启后都可靠。只存元信息，不存文件本体。
# ---------------------------------------------------------------------------

def _sent_history_path() -> Path:
    from ..companion import companion_service

    return Path(companion_service.live2d_state_dir()) / SENT_HISTORY_FILENAME


def _sanitize_sent_entry(entry: Any) -> dict[str, Any] | None:
    """清洗一条留底：只保留已知键、限长，防止脏数据/超长塞爆文件。"""
    if not isinstance(entry, dict):
        return None
    files_raw = entry.get("files") if isinstance(entry.get("files"), list) else []
    files: list[dict[str, Any]] = []
    for f in files_raw[:10]:
        if not isinstance(f, dict):
            continue
        item: dict[str, Any] = {
            "name": str(f.get("name") or "")[:255],
            "kind": str(f.get("kind") or "file")[:16],
            "size": int(f.get("size") or 0),
        }
        if f.get("stored"):
            item["stored"] = str(f["stored"])[:200]
        files.append(item)
    return {
        "id": str(entry.get("id") or "")[:40],
        "ts": int(entry.get("ts") or 0),
        "from": "pc",
        "text": str(entry.get("text") or "")[:4000],
        "files": files,
    }


def load_sent_history() -> list[dict[str, Any]]:
    try:
        raw = _sent_history_path().read_text(encoding="utf-8")
        data = json_loads(raw)
        if isinstance(data, list):
            cleaned = (_sanitize_sent_entry(x) for x in data[-SENT_HISTORY_MAX:])
            return [e for e in cleaned if e]
    except FileNotFoundError:
        pass
    except Exception:
        logger.warning("发送留底读取失败，按空处理", exc_info=True)
    return []


def save_sent_history(entries: list[Any]) -> dict[str, Any]:
    """全量覆盖式保存（面板是唯一写者，最后写者赢即可）。原子写防半截文件。"""
    clean = [e for e in (_sanitize_sent_entry(x) for x in list(entries)[-SENT_HISTORY_MAX:]) if e]
    path = _sent_history_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json_dumps(clean), encoding="utf-8")
    tmp.replace(path)
    logger.info("[relay] 发送留底已保存: %d 条", len(clean))
    return {"ok": True, "entries": clean}
