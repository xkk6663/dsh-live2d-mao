"""向桌宠 WS 推一条测试气泡，判断「气泡不显示」卡在哪一段。

它做的只有一件事：调 pet_event_service.publish('agent_bubble', {...})，
和真实链路完全同一条通道（同一个 hub、同一个 broadcast、同一个渲染端）。
然后回读 hub 状态，看有没有连着的渲染端。

用法（在 backend 目录）：
    .venv/Scripts/python.exe tools/diag/bubble_live_probe.py ["测试文字"]
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings  # noqa: E402,F401
from app.companion import pet_event_service  # noqa: E402


def main() -> int:
    text = sys.argv[1] if len(sys.argv) > 1 else "气泡自检：如果你看到这句话，说明通道是通的。"
    hub = pet_event_service.hub

    status = hub.status()
    print("=== hub 状态 ===")
    print(json.dumps(status, ensure_ascii=False, indent=2)[:1200])

    clients = len(getattr(hub, "_clients", []) or [])
    loop = getattr(hub, "_loop", None)
    print(f"\n渲染端连接数 = {clients}")
    print(f"事件循环     = {loop}")

    # publish() 在没有 loop / 没有客户端时会**静默 return**，这正是"气泡没出现"最常见的原因
    payload = {
        "text": text,
        "agent_id": "screen",
        "source": "screen",
        "request_id": f"probe-{int(time.time())}",
        "accent": "#2B6CB0",
        "hold_ms": 8000,
    }
    print(f"\n发送 agent_bubble: {payload['text']!r}")
    delivered = pet_event_service.publish_deliverable("agent_bubble", payload)
    print(f"publish_deliverable 返回 = {delivered}  （False = 没有渲染端连着，气泡发不出去）")
    return 0 if delivered else 1


if __name__ == "__main__":
    raise SystemExit(main())
