"""排查 `/setu_file`：把这一轮的 SSE 原始帧逐条打出来。

用来确认「云端到底发的 image 帧还是 file 帧、占位符叫什么、本机有没有下载成功」。
不写库、不推气泡。

用法（在 backend 目录）：
    .venv/Scripts/python.exe tools/diag/setu_frame_dump.py [/setu_file 3]
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402

from app.config import settings  # noqa: E402,F401
from app.cloud_feiyu import get_client  # noqa: E402
from app.cloud_feiyu.client import attachment_media_kind  # noqa: E402


async def main(command: str) -> int:
    client = get_client()
    payload = client._build_payload(command, client.session_id, stream=True)
    print(f"发送：{command!r}   session={client.session_id[:8]}…")
    frames: list[str] = []
    placeholders: list[tuple[str, str]] = []
    async with httpx.AsyncClient(timeout=180) as http:
        async with http.stream(
            "POST", f"{client.base_url}/api/v1/chat", headers=client._headers(), json=payload
        ) as resp:
            print(f"HTTP {resp.status_code}")
            async for line in resp.aiter_lines():
                if not line.strip() or line.strip() == ": heartbeat":
                    continue
                frame = client._parse_sse_event(line)
                if frame is None:
                    continue
                dtype = str(frame.get("type") or "")
                data = frame.get("data")
                if len(frames) < 60:
                    frames.append(dtype)
                parsed = client._frame_attachment(frame)
                if parsed:
                    placeholders.append(parsed)
                    shown = str(data)[:80]
                    print(f"  [附件帧] type={dtype} data={shown!r}")
                    print(f"           → kind={parsed[0]} 云端名={parsed[1][:60]}")
                    print(f"           → 归一类型: {attachment_media_kind(parsed[0], '', parsed[1])}")
                elif dtype in ("plain", "complete", "record", "image", "file", "end"):
                    text = str(data or "")
                    if text:
                        print(f"  [{dtype}] {text[:70]!r}")
    print(f"\n帧序列 = {frames}")
    print(f"附件占位符数 = {len(placeholders)}")
    for kind, name in placeholders:
        print(f"  {kind}  {name[:70]}")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "/setu_file 3"
    raise SystemExit(asyncio.run(main(cmd)))
