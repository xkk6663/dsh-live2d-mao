"""连上桌宠 WS，并**持续保持**，同时打印后端广播给我们的每一帧。

用来区分两种可能：
  A) 后端根本没有广播（publish 时 hub._clients 为空）→ 这里什么都收不到；
  B) 后端广播了、但渲染端没显示 → 这里能收到帧。

用法（在 backend 目录，保持运行）：
    .venv/Scripts/python.exe tools/diag/ws_listen.py 30
"""

from __future__ import annotations

import asyncio
import json
import sys

import websockets


async def main(seconds: float = 30.0) -> int:
    url = "ws://127.0.0.1:8000/api/companion/ws"
    async with websockets.connect(url) as ws:
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        print(f"已连接，收到 ready（protocol={(ready.get('payload') or {}).get('protocol_version')}）")
        print(f"接下来 {seconds:.0f} 秒内收到的所有帧都会打印：")
        count = 0
        loop = asyncio.get_running_loop()
        deadline = loop.time() + seconds
        while loop.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.5, deadline - loop.time()))
            except asyncio.TimeoutError:
                break
            count += 1
            try:
                frame = json.loads(raw)
            except Exception:
                print(f"  [非JSON] {str(raw)[:120]}")
                continue
            ftype = frame.get("type")
            payload = frame.get("payload") or {}
            brief = ""
            if ftype in ("agent_bubble", "agent_stream", "speak"):
                brief = str(payload.get("text") or "")[:60]
            elif ftype in ("agent_image", "agent_audio"):
                brief = str(payload.get("url") or "")[:60]
            print(f"  [{count}] {ftype} {brief}")
        print(f"\n共收到 {count} 帧")
    return 0


if __name__ == "__main__":
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
    raise SystemExit(asyncio.run(main(secs)))
