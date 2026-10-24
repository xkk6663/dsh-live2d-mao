"""端到端验证：截图 → 云端大肥鱼 → 回话（不经过桌宠 UI）。

只调 screen_observation_service 里新加的两个函数：
    _feiyu_screen_prompt / _feiyu_vision_call
不写观察库、不动触发状态机，免得把随机的下一次观察时间打乱。

用法（在 backend 目录）：
    .venv/Scripts/python.exe tools/diag/feiyu_vision_e2e.py [--custom "锐评一下此刻的电脑屏幕画面"]
"""

from __future__ import annotations

import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings  # noqa: E402,F401  —— 触发 .env 加载
from app.companion import companion_service  # noqa: E402
from app.screen import screen_observation_service as svc  # noqa: E402
from app.screen.screen_frame_processor import process_frame  # noqa: E402


def _grab_frame() -> dict:
    observer = companion_service.window_observer
    try:
        observer.select_screen("primary")
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] select_screen 失败（继续用现有目标）：{exc}")
    status = observer.capture() or {}
    if status.get("last_error"):
        print(f"[warn] capture 报告：{status.get('last_error')}")
    # capture() 返回的是 status dict，真实字节在 claim_analysis_frame() 里
    for _ in range(3):
        frame = observer.claim_analysis_frame(0)
        if frame and frame.get("content"):
            return frame
        time.sleep(0.3)
    return {}


async def main() -> int:
    custom = ""
    if "--custom" in sys.argv:
        custom = sys.argv[sys.argv.index("--custom") + 1]

    frame = _grab_frame()
    content = frame.get("content") or b""
    if not content:
        print("截图失败：没有拿到画面字节")
        return 2
    processed = process_frame(bytes(content), max_width=640, max_height=360, jpeg_quality=64)
    frame["content"] = processed.content
    print(f"截图 OK：{processed.width}x{processed.height}，{len(processed.content)} 字节")
    print(f"mode={frame.get('mode')} title={frame.get('title') or '-'}")

    prompt = svc._feiyu_screen_prompt(
        custom_prompt=custom,
        is_window=str(frame.get("mode")) == "window",
        frame=frame,
        persona_context=svc._screen_persona_context(),
        recent_context=svc._recent_context("desktop_pet", limit=4, max_chars=100),
        audio_context="",
        foreground=svc._activity_context(frame),
    )
    print("---- 发给云端的提示词 ----")
    print(prompt[:1200])
    print("--------------------------")

    result = await svc._feiyu_vision_call(
        frame=frame,
        prompt=prompt,
        timeout_seconds=60.0,
    )
    print("---- 大肥鱼的回复 ----")
    print(result.content)
    print("----------------------")
    print(f"model={result.model} cost_source={result.cost_source} "
          f"first_token_ms={result.first_token_latency_ms} total_ms={result.total_latency_ms}")
    return 0 if result.content.strip() else 3


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
