"""跨平台传输收件箱轮询器 —— 微信端大肥鱼发来的图片/文件在桌宠端落地。

时序（2026-10-26 与云端插件 astrbot_plugin_crosssend v2 配套）：
  1. 用户在微信里对大肥鱼说「发到电脑上」→ 她调 send_to_pet 工具；
  2. 云端插件把传输记录追加进 /AstrBot/data/attachments/crosssend_pet_inbox.json
     （附件本体本来就在云端 attachments 目录，记录里只放文件名）；
  3. 本模块每 4 秒用现有 file-scope API 拉一次清单，对比本地游标找出新条目；
  4. 逐个下载字节 → 复用 _save_agent_media 落盘（内容哈希名，绕开 WS 1MB 上限）
     → WS 推 agent_image / agent_file / agent_bubble，桌宠当场显示。

为什么不用 webchat 会话推（实测 2026-10-26）：
  webchat 适配器 send_by_session 每次都新建随机会话、推送内容不进 conversation
  history，没有稳定的"收件箱"可轮询；JSON 清单 + 附件文件名是最短可信通路。
  游标存本地 state 目录，后端重启不会重复投递旧传输。

云→桌宠方向的文件本体也可以直接用 `GET /api/v1/files/content?filename=<stored>`
取字节（file scope，现有 abk key 就够），不依赖 `data` scope。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from urllib.parse import quote

logger = logging.getLogger("cloud_feiyu.transfer")

MANIFEST_FILENAME = "crosssend_pet_inbox.json"
POLL_INTERVAL_SECONDS = 4.0
MANIFEST_MAX_ENTRIES = 50

_CURSOR_FILENAME = "crosssend_cursor.json"


def _cursor_path() -> Path:
    from ..companion import companion_service

    return Path(companion_service.live2d_state_dir()) / _CURSOR_FILENAME


def _load_processed_ids() -> set[str]:
    try:
        data = json.loads(_cursor_path().read_text(encoding="utf-8"))
        if isinstance(data, list):
            return {str(x) for x in data}
    except FileNotFoundError:
        pass
    except Exception:
        logger.debug("传输游标读取失败，按空处理", exc_info=True)
    return set()


def _save_processed_ids(ids: set[str]) -> None:
    try:
        # 只留最近 200 个，防止无限增长
        keep = sorted(ids)[-200:]
        _cursor_path().write_text(json.dumps(keep, ensure_ascii=False), encoding="utf-8")
    except Exception:
        logger.debug("传输游标写入失败", exc_info=True)


def _extract_entry_ids(manifest: object) -> list[dict]:
    """容错地取出清单里的条目列表；清单损坏时返回空（不丢游标）。"""
    if isinstance(manifest, dict):
        entries = manifest.get("entries")
    elif isinstance(manifest, list):
        entries = manifest
    else:
        entries = None
    if not isinstance(entries, list):
        return []
    return [e for e in entries if isinstance(e, dict) and str(e.get("id") or "").strip()]


async def _deliver_entry(entry: dict) -> None:
    """把一条传输记录的附件下载落盘并推给桌宠。任何一步失败都只记日志。"""
    from ..routes.companion import (
        FEIYU_AGENT_ID,
        FEIYU_BUBBLE_ACCENT,
        _desktop_pet_conversation_id,
        _save_agent_media,
        db,
    )
    from . import get_client as get_feiyu_client

    client = get_feiyu_client()
    entry_id = str(entry.get("id") or "")
    entry_text = str(entry.get("text") or "").strip()
    source = str(entry.get("from") or "wechat")
    files = entry.get("files") if isinstance(entry.get("files"), list) else []

    saved_items: list[tuple[str, dict]] = []  # (media_kind, saved_meta)
    failed: list[str] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        stored = str(item.get("stored") or "").strip()
        display = str(item.get("name") or stored or "").strip() or "文件"
        if not stored:
            continue
        media_kind = "image" if str(item.get("kind") or "") == "image" else "file"
        att = await client.fetch_attachment(stored, kind=media_kind, display=display)
        if getattr(att, "error", "") or not getattr(att, "data_url", ""):
            failed.append(display)
            logger.warning("[crosssend] 附件下载失败 %s: %s", display, att.error)
            continue
        meta = await asyncio.to_thread(
            _save_agent_media,
            {
                "data_url": att.data_url,
                "display": display,
                "filename": display,
            },
            media_kind,
        )
        if meta is None:
            failed.append(display)
            logger.warning("[crosssend] 附件落盘失败（超限或解码失败）：%s", display)
            continue
        saved_items.append((media_kind, meta))

    # pet_event_service 是函数模块（publish/has_clients...），不是单例对象
    from ..companion import pet_event_service

    # 文件卡片（非图片）——即使没有图片也要让用户知道有东西传过来
    note = entry_text or f"大肥鱼从{'微信' if source == 'wechat' else source}传来了 {len(saved_items)} 个文件"
    for media_kind, meta in saved_items:
        if media_kind == "image":
            pet_event_service.publish("agent_image", {
                "url": meta["url"],
                "filename": meta.get("filename") or "",
                "display": meta.get("display") or "",
                "mime_type": meta.get("mime_type") or "",
                "size": meta.get("size") or 0,
                "agent_id": FEIYU_AGENT_ID,
                "accent": FEIYU_BUBBLE_ACCENT,
                # 独立 response_id：渲染端据此按"Agent 图片"长驻处理，不当随机图 3 秒自毁
                "response_id": f"crosssend-{entry_id}",
                "hold_ms": 8000,
                "text": note,
            })
        else:
            pet_event_service.publish("agent_file", {
                "display": meta.get("display") or "文件",
                "filename": meta.get("filename") or "",
                "mime_type": meta.get("mime_type") or "",
                "size": meta.get("size") or 0,
                "agent_id": FEIYU_AGENT_ID,
                "accent": FEIYU_BUBBLE_ACCENT,
            })
            pet_event_service.publish("agent_bubble", {
                "text": note,
                "agent_id": FEIYU_AGENT_ID,
                "accent": FEIYU_BUBBLE_ACCENT,
                "duration_ms": 6000,
            })
    if failed:
        pet_event_service.publish("agent_bubble", {
            "text": f"有 {len(failed)} 个文件没传成功：{'、'.join(failed[:3])}",
            "agent_id": FEIYU_AGENT_ID,
            "accent": FEIYU_BUBBLE_ACCENT,
            "duration_ms": 6000,
        })
    logger.info("[crosssend] 投递完成 %s: %d 成功 / %d 失败", entry_id, len(saved_items), len(failed))

    # ★★ 2026-10-29 修「桌宠气泡看得到图、聊天页看不到」：
    #   投递此前**只走 WS 广播**，一次性的 —— 聊天页那一瞬间不在线（没开/刚刷新/
    #   断线重连中）就永远错过，而 cloud_feiyu 直通分支又不写本地消息表，
    #   历史（/chat/history）里也没有 → 聊天页怎么刷都补不回来。
    #   现在投递成功就写一条 assistant 消息进 desktop_pet 会话：
    #   · 聊天页不在线 → 下次轮询 loadHistory 从历史补到；
    #   · 聊天页在线（WS 已建 text=note 的附件消息）→ 前端 appendHistoryRows 按
    #     内容指纹（同文本+10min 窗口）合并进同一条，附件按 url 去重，不会出双份。
    try:
        import json as _json

        attachments_payload = [
            {
                "media": media_kind,
                "kind": media_kind,
                "url": meta.get("url") or "",
                "display": meta.get("display") or meta.get("filename") or "",
                "filename": meta.get("filename") or "",
                "mime_type": meta.get("mime_type") or "",
                "size": meta.get("size") or 0,
            }
            for media_kind, meta in saved_items
        ]
        has_files_in_entry = bool(files)
        # 成功投了附件 → 落库；清单条目只有文字没有附件 → 也落（此前文字传输是黑洞）
        if saved_items or (not has_files_in_entry and note):
            db.save_message(
                "assistant",
                note,
                source="desktop_pet",
                conversation_id=_desktop_pet_conversation_id(),
                request_id=f"crosssend-{entry_id}",
                model_id="cloud_feiyu",
                provider_model="crosssend",
                reasoning_level="off",
                attachments_json=_json.dumps(attachments_payload, ensure_ascii=False),
            )
    except Exception:
        logger.exception("[crosssend] 投递历史落库失败：%s", entry_id)


async def transfer_poll_loop() -> None:
    """后台任务：轮询云端传输清单，把新条目投递到桌宠。"""
    from . import get_client as get_feiyu_client

    logger.info("跨平台传输轮询器启动（清单=%s，间隔=%.0fs）", MANIFEST_FILENAME, POLL_INTERVAL_SECONDS)
    while True:
        try:
            client = get_feiyu_client()
            if client.is_configured:
                att = await client.fetch_attachment(MANIFEST_FILENAME, kind="file", display="传输清单")
                if not getattr(att, "error", "") and getattr(att, "data_url", ""):
                    # data_url = data:application/json;base64,...
                    _, _, payload = att.data_url.partition(",")
                    import base64

                    raw = base64.b64decode(payload, validate=False)
                    manifest = json.loads(raw.decode("utf-8", "replace"))
                    entries = _extract_entry_ids(manifest)
                    processed = _load_processed_ids()
                    fresh = [e for e in entries if str(e.get("id")) not in processed]
                    if fresh:
                        logger.info("[crosssend] 发现 %d 条新传输", len(fresh))
                        for entry in fresh:
                            try:
                                await _deliver_entry(entry)
                            except Exception:
                                logger.exception("[crosssend] 投递单条失败：%s", entry.get("id"))
                            processed.add(str(entry.get("id")))
                        _save_processed_ids(processed)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("传输轮询一轮失败", exc_info=True)
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
