"""大肥鱼传输面板 HTTP 面（零 token 中继，2026-10-26）。

GET  /api/companion/relay/messages   拉微信→电脑中继清单（全量，前端按 id 去重）
POST /api/companion/relay/send       面板消息发往微信（multipart: text + files）
GET  /api/companion/relay/media      取中继附件字节（filename=云端存储名）
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import Response

# ★ 2026-11-01 v1.4.0 拆分：relay_service 随大肥鱼插件分发（mao-plugin-feiyu）。
#   未安装时占位对象让各端点统一走"未安装"降级（本机装了则行为不变）。
try:
    from ..cloud_feiyu import relay_service
except ImportError:

    class _RelayServiceUnavailable:
        def __getattr__(self, name):
            def _unavailable(*args, **kwargs):
                raise RuntimeError("大肥鱼插件未安装（mao-plugin-feiyu）")

            return _unavailable

    relay_service = _RelayServiceUnavailable()

logger = logging.getLogger("routes.relay")

router = APIRouter(prefix="/api/companion/relay")

_MAX_FILES_PER_MESSAGE = 5
_MAX_FILE_BYTES = 20 * 1024 * 1024


@router.get("/messages")
async def relay_messages():
    try:
        return await relay_service.poll_messages()
    except Exception as exc:  # noqa: BLE001
        logger.exception("中继清单拉取失败")
        raise HTTPException(status_code=502, detail=f"中继清单拉取失败：{exc}") from exc


@router.post("/send")
async def relay_send(text: str = Form(""), files: list[UploadFile] | None = None):
    payload: list[tuple[str, bytes, str]] = []
    for upload in (files or [])[:_MAX_FILES_PER_MESSAGE]:
        raw = await upload.read()
        if not raw:
            continue
        if len(raw) > _MAX_FILE_BYTES:
            raise HTTPException(status_code=400, detail=f"{upload.filename} 超过 20MB 上限。")
        mime = upload.content_type or "application/octet-stream"
        payload.append((upload.filename or "file", raw, mime))
    try:
        return await relay_service.send_text_files(text, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("中继发送失败")
        raise HTTPException(status_code=502, detail=f"发送失败：{exc}") from exc


@router.get("/sent")
async def relay_sent_history():
    """面板发送留底（服务端持久化，跨窗口/重启可靠）。"""
    try:
        return {"ok": True, "entries": await asyncio.to_thread(relay_service.load_sent_history)}
    except Exception as exc:  # noqa: BLE001
        logger.exception("发送留底读取失败")
        raise HTTPException(status_code=500, detail=f"留底读取失败：{exc}") from exc


@router.post("/sent")
async def relay_sent_save(payload: dict):
    """全量覆盖保存面板发送留底（面板是唯一写者）。"""
    entries = (payload or {}).get("entries")
    if not isinstance(entries, list):
        raise HTTPException(status_code=400, detail="entries 必须是数组")
    try:
        return await asyncio.to_thread(relay_service.save_sent_history, entries)
    except Exception as exc:  # noqa: BLE001
        logger.exception("发送留底保存失败")
        raise HTTPException(status_code=500, detail=f"留底保存失败：{exc}") from exc


@router.get("/media")
async def relay_media(filename: str):
    """面板 <img>/<audio> 直接引这个 URL 拿中继附件字节。"""
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="文件名无效。")
    try:
        from ..cloud_feiyu import get_client as get_feiyu_client
    except ImportError:
        raise HTTPException(status_code=503, detail="大肥鱼插件未安装（mao-plugin-feiyu）。")
    client = get_feiyu_client()
    if not client.is_configured:
        raise HTTPException(status_code=503, detail="云端大肥鱼未配置。")
    att = await client.fetch_attachment(filename, kind="file", display=filename)
    if getattr(att, "error", "") or not getattr(att, "data_url", ""):
        raise HTTPException(status_code=404, detail=f"附件取不到：{att.error or '空内容'}")
    import base64

    _, _, payload = att.data_url.partition(",")
    raw = base64.b64decode(payload, validate=False)
    mime = att.mime_type or "application/octet-stream"
    return Response(
        content=raw,
        media_type=mime,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
