from __future__ import annotations

import asyncio
import base64
import binascii
import ctypes
import functools
import hashlib
import zipfile
from ctypes import wintypes
from array import array
from datetime import datetime
from difflib import SequenceMatcher
import json
import logging
import math
import os
import re
import shutil
import subprocess
import struct
import sys
import threading
import time
import uuid
import wave
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

import httpx
import yaml
from PIL import Image

from ..screen import system_audio_service
from ..config import settings
from .companion_observation_service import GameObserver, WindowObserver, cleanup_legacy_preview


logger = logging.getLogger(__name__)


SHOW_EVENT_NAME = "Local\\MioAgentDesktopShow-7C53C273"
PET_CHAT_EVENT_NAME = "Local\\MioAgentDesktopPetChat-7C53C273"
PET_CHAT_ANCHOR_PATH = settings.data_dir / "桌宠聊天位置请求.json"


def pet_chat_anchor() -> dict[str, object]:
    try:
        payload = json.loads(PET_CHAT_ANCHOR_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    try:
        return {
            "anchor_x": int(payload["anchor_x"]),
            "anchor_y": int(payload["anchor_y"]),
            "recorded_at": str(payload.get("recorded_at") or ""),
        }
    except (KeyError, TypeError, ValueError):
        return {}


DEFAULT_CONFIG: dict[str, Any] = {
    "config_schema_version": 2,
    "voice_enabled": True,
    "pet_call_asr_engine": "auto",
    "pet_call_input_language": "zh",
    "pet_call_silence_ms": 650,
    "pet_call_voice_threshold": 0.018,
    "pet_call_min_speech_ms": 280,
    "pet_call_max_turn_seconds": 18,
    "voice_volume": 85,
    # ★ 2026-10-23：大肥鱼发来音频（点歌 / 语音）时是否**自动出声**。
    #   渲染端 playAgentAudio() 早就认这个键（false = 只在气泡提示、不出声），
    #   但既没有默认值也没有设置入口 ⇒ 永远"自动播放且找不到关的地方"（用户报障）。
    #   现在：补默认 true（保持原行为）+ 设置页「语音」tab 新增开关。
    "audio_autoplay": True,
    "voice_streaming_enabled": True,
    "pet_speech_language": "zh",
    "speak_screen_observations": True,
    "speak_game_observations": True,
    "screen_ai_enabled": True,
    "screen_audio_enabled": True,
    "screen_audio_model": "base",
    "screen_audio_language": "auto",
    "screen_audio_chunk_seconds": 5,
    # ★ 2026-10-24：桌宠跟着**系统扬声器输出**呼吸/摆动（纯本地，不联网、不耗额度）
    #   渲染端用 Electron getDisplayMedia(audio:loopback) 采回环，参数驱动 Live2D。
    "audio_react_enabled": True,
    # ★ 2026-10-24 用户裁决：桌宠端不需要任何模型 API，识图全走云端大肥鱼
    "screen_vision_route": "feiyu",
    "screen_vision_model_id": "auto-fast",
    "screen_direct_voice_enabled": True,
    "screen_change_threshold": 4.0,
    "screen_analysis_interval_seconds": 5,
    # 2026-10-24 用户裁决（m02056）：随机长间隔触发（默认 60~120 分钟看一眼）
    "screen_trigger_random_enabled": True,
    "screen_trigger_min_minutes": 60,
    "screen_trigger_max_minutes": 120,
    # 观察结果转语音：做成开关（有语音就都带文字），概率保留作扩展位
    "screen_observation_voice_enabled": True,
    "screen_observation_voice_probability": 1.0,
    "screen_observation_prompt": "",
    "screen_request_timeout_seconds": 25,
    "screen_voice_cooldown_seconds": 5,
    "screen_minimum_importance": 0.62,
    "screen_daily_cost_limit_yuan": 5.0,
    "bubble_seconds": 9,
    "pet_size_percent": 150,
    "pet_renderer": "live2d",
    "live2d_model_id": "whale-deepseek",
    "live2d_scale": 1.0,
    "live2d_vertical_offset": 0.0,
    "live2d_follow_cursor": True,
    "live2d_idle_motion": True,
    "live2d_click_motion": True,
    "live2d_smart_passthrough": True,
    "live2d_click_through_locked": False,
    "live2d_speech_bubble_enabled": True,
    "live2d_keep_visible": False,
    "live2d_always_on_top": True,
    "live2d_disable_gpu": False,
    "live2d_motion_slots": {},
    "live2d_expression_slots": {},
    # 任务状态（phase）→ 表现绑定：{模型id: {phase: {motion: 槽名, expression: 槽名}}}。
    # 空 = 用渲染端内置默认（PHASE_MOTION_SLOT / PHASE_EMOTION）。
    "live2d_phase_slots": {},
    # 泡泡工坊：气泡皮肤 id + 点击互动（点桌宠随机语句/图片，复用说话气泡）
    "live2d_bubble_style": "default",
    "pet_click_talk_enabled": True,
    # M1 逐 token 流式：插件（如 DSH）交来的正文增量按上游节奏铺进气泡。
    # 与 live2d_speech_bubble_enabled 是**两层**开关：总开关关掉气泡全没了，
    # 这个只关"流式"（关掉后插件仍可用一次性文本气泡 announce）。
    "live2d_stream_text_enabled": True,
    # ★ 横条个性化（2026-10-17 用户需求）：默认宽度(px，0=自适应)、默认行数(1-5)、
    #   皮肤 id（为「横条 UI 可更换」预留）
    "live2d_strip_width": 0,
    "live2d_strip_rows": 1,
    "live2d_strip_style": "default",
    # ★ 桌宠交互打磨（2026-10-17）：不透明度 / 锁定位置 / SHIFT 拖动 / 拖拽惯性
    "live2d_pet_opacity": 100,
    "live2d_pet_locked": False,
    "live2d_pet_shift_drag": False,
    "live2d_pet_inertia": True,
    # ★ DSH 面板 12 态自定义颜色（存后端：管理窗 localStorage 会被清，不持久）
    "live2d_phase_colors": {},
    # 音效事件配置（clip 为空 = 用现场合成音；非空 = 播放 sounds/ 里的片段）
    "pet_sound_events": {},
    # 点击序列（first + queue；queue 为空则回退随机语句/图片）
    "pet_click_bubbles": {},
    # 图片池权重（bubble-imgs 文件名 → 权重，缺省 1）
    "pet_image_weights": {},
    # ---- A 档：桌宠"生命感"设置（自带默认值，缺省即开箱可用）----
    # 音效：按压/释放/切换 Agent 等交互反馈音（0-100 音量，总开关独立）
    "pet_sound_enabled": True,
    "pet_sound_volume": 70,
    # 空闲自语：长时间无人交互时按内容池随机说一句（权重 + 不连续重复）
    "pet_idle_talk_enabled": True,
    "pet_idle_talk_min_seconds": 90,
    "pet_idle_talk_max_seconds": 240,
    # 随机微表情节拍（M1/M2：不动它时随机换表情，不说话）
    "pet_idle_beat_enabled": True,
    "pet_idle_beat_min_seconds": 30,
    "pet_idle_beat_max_seconds": 90,
    # 模型专属台词库（quotes/<modelId>.json）：关掉则只用通用内容池
    "pet_quotes_enabled": True,
    # 话痨程度 0-100（个性化总旋钮）：一条滑块同时缩放"自语间隔"和"微表情节奏"，
    # 0 = 完全安静（不主动出声/不主动换表情），100 = 话痨。
    # 具体间隔由渲染端按曲线换算（见 live2d-pet.js talkativenessProfile），
    # 显式设了 pet_idle_talk_* / pet_idle_beat_* 时以显式值为准（高级覆写）。
    "pet_talkativeness": 45,
    # 连点彩蛋（L3-c）：短时间内反复戳桌宠 → 给"嫌弃→装死"的分级反应。
    # 每一级都复用现成的点击气泡通道（pet_click_bubbles），关掉即退回"每次都是害羞"。
    "pet_poke_enabled": True,
    # 全局 UI 主题 id（mist/clear/rose/forest/sakura/celadon/amber +
    # whale/miku/neuro/qwen/doubao（2026-10-19 AI 娘配色）/custom）：
    # 主界面与外层窗共用一套调色板；气泡/横条皮肤选 "theme" 时跟随它。
    "ui_theme": "mist",
    # 自定义主题三色（ui_theme === 'custom' 时桌宠皮肤跟随取色；configuration.py 校验 #rrggbb）
    "ui_theme_custom_bg": "#e9eef0",
    "ui_theme_custom_accent": "#4c8798",
    "ui_theme_custom_ink": "#20303a",
    # 按压 Q 弹反馈
    "pet_press_bounce_enabled": True,
    "position_x": 80,
    "position_y": 420,
}


def _builtin_live2d_models() -> tuple[dict[str, Any], ...]:
    """内置官方模型注册表：静态 Hiyori + 动态扫描 dist/live2d-pet/models，
    新增官方模型放入该目录后无需改代码即可出现在模型管理列表。"""
    models: list[dict[str, Any]] = [
        {
            "id": "hiyori",
            "name": "Hiyori Momose",
            "description": "Live2D 官方免费示例，包含完整待机与点击动作",
            "model_path": "models/Hiyori/Hiyori.model3.json",
            "preview_path": "models/Hiyori/preview.png",
            "preview_url": "/agent-app/live2d-pet/models/Hiyori/preview.png",
            "license": "Live2D Free Material License",
            "source": "Live2D/CubismWebSamples",
            "source_url": "https://github.com/Live2D/CubismWebSamples",
            "motion_count": 10,
        },
    ]
    builtin_root = settings.agent_frontend_dir / "live2d-pet" / "models"
    if builtin_root.is_dir():
        known_ids = {m["id"] for m in models}
        for entry in sorted(builtin_root.iterdir(), key=lambda p: p.name.lower()):
            if not entry.is_dir():
                continue
            model_file = next(
                (f for f in entry.iterdir() if f.name.lower().endswith(".model3.json")),
                None,
            )
            if model_file is None:
                continue
            mid = entry.name.lower()
            if mid in known_ids:
                continue
            known_ids.add(mid)
            preview_path = ""
            preview_url = ""
            preview_candidate = entry / "preview.png"
            if preview_candidate.is_file():
                preview_path = f"models/{entry.name}/preview.png"
                preview_url = f"/agent-app/live2d-pet/models/{entry.name}/preview.png"
            metadata: dict[str, Any] = {}
            meta_file = entry / "mio-model.json"
            if meta_file.is_file():
                try:
                    metadata = json.loads(meta_file.read_text(encoding="utf-8-sig")) or {}
                except (OSError, json.JSONDecodeError):
                    metadata = {}
            display_name = str(metadata.get("name") or entry.name)
            authorization = metadata.get("authorization") if isinstance(metadata.get("authorization"), dict) else {}
            license_text = str(authorization.get("notice") or "Live2D Free Material License")
            source_label = str(metadata.get("sourceLabel") or "Live2D/CubismWebSamples")
            is_official = "CubismWebSamples" in source_label
            capabilities = metadata.get("capabilities") if isinstance(metadata.get("capabilities"), dict) else {}
            models.append({
                "id": mid,
                "name": display_name,
                "description": "Live2D 官方免费示例，含待机与点击动作" if is_official else "项目内置模型，随仓库分发、克隆即用",
                "model_path": f"models/{entry.name}/{model_file.name}",
                "preview_path": preview_path,
                "preview_url": preview_url,
                "license": license_text,
                "source": source_label,
                "source_url": "https://github.com/Live2D/CubismWebSamples" if is_official else "",
                "motion_count": 0,
                "capabilities": capabilities,
            })
    return tuple(models)


LIVE2D_MOTION_SLOT_IDS = frozenset(
    {"idle", "touch", "think", "speak", "observe", "cheerful", "concerned", "alert", "attention", "shy", "listen"}
)
LIVE2D_EXPRESSION_SLOT_IDS = frozenset(
    {"neutral", "gentle", "cheerful", "concerned", "serious", "shy", "alert"}
)
# 任务状态白名单（heartbeat 不参与表现绑定）
LIVE2D_PHASE_IDS = frozenset(
    {
        "idle", "planning", "thinking", "executing_tool", "streaming", "waiting_input",
        "voice", "complete", "error", "paused", "awaiting_approval",
    }
)


_pet_process: subprocess.Popen | None = None
_pet_runtime_kind = ""
_pet_lock = threading.Lock()
_pet_activity_lock = threading.Lock()
_pet_activity_revision = 0
_pet_activity: dict[str, Any] = {
    "state": "idle",
    "emotion": "neutral",
    "source": "",
    "updated_at": 0.0,
    "expires_at": 0.0,
}
PET_SPRITE_FILES: dict[str, str] = {
    "idle": "待机.png",
    "blink": "眨眼.png",
    "speaking": "说话.png",
    "cheerful": "开心.png",
    "concerned": "担心.png",
    "shy": "害羞.png",
}
PET_ACTIVITY_LABELS: dict[str, str] = {
    "idle": "安静待机",
    "listening": "在听你说",
    "thinking": "正在想",
    "working": "正在处理",
    "responding": "准备回应",
    "speaking": "正在说话",
    "observing": "专注观察",
}
MAX_SPRITE_SHEET_BYTES = 24 * 1024 * 1024
MAX_SPRITE_SHEET_PIXELS = 40_000_000

# ★ 任务状态表情绑定失效回报（2026-10-24）：设置页现在直接列模型的 exp3 表情文件，
#   换模型后老绑定会指向不存在的表情。桌宠端把这类情况回传过来，这里只**记录**（内存态、
#   不看配置、不改配置），供设置页显示提示。为什么要落这里而不是直接改配置：
#   用户很多时候只是临时换模型看看，换回来还要用原绑定，自动删绑定是不可接受的破坏。
_phase_slot_invalid_lock = threading.Lock()
_phase_slot_invalid: dict[str, Any] = {}


def record_phase_slot_invalid(*, agent_id: str = "", model_id: str = "", message: str = "") -> None:
    """记一条「任务状态表情绑定失效」的实时回报（同一条消息只留最新一条）。"""
    text = str(message or "").strip()[:200]
    if not text:
        return
    with _phase_slot_invalid_lock:
        _phase_slot_invalid.clear()
        _phase_slot_invalid.update({
            "message": text,
            "agent_id": str(agent_id or "")[:40],
            "model_id": str(model_id or "")[:100],
            "at": time.time(),
        })


def phase_slot_invalid_snapshot() -> dict[str, Any]:
    """无条件返回最近一条失效回报（空 dict = 没有）。"""
    with _phase_slot_invalid_lock:
        return dict(_phase_slot_invalid)


def _electron_pet_command() -> list[str] | None:
    configured = os.getenv("MIO_LIVE2D_PET_EXE", "").strip()
    if configured:
        executable = Path(configured)
        return [str(executable)] if executable.is_file() else None
    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS", settings.agent_frontend_dir.parent))
        candidates = [
            bundle_root / "live2d_desktop" / "MioLive2D桌宠.exe",
            bundle_root / "live2d_desktop" / "澪Live2D桌宠.exe",
        ]
        executable = next((path for path in candidates if path.is_file()), None)
        return [str(executable)] if executable else None
    app_root = settings.source_workspace_root / "澪Agent应用" / "live2d-desktop"
    executable = app_root / "node_modules" / "electron" / "dist" / "electron.exe"
    if executable.is_file() and (app_root / "main.js").is_file():
        # --no-sandbox: 当前系统 Chromium 沙箱初始化崩溃（Win11 预览版），必须禁用
        return [str(executable), "--no-sandbox", str(app_root)]
    return None


def _pet_command() -> tuple[list[str], str]:
    if str(load_config().get("pet_renderer") or "classic") == "live2d":
        electron_command = _electron_pet_command()
        if electron_command:
            return electron_command, "electron_live2d"
    if getattr(sys, "frozen", False):
        return [sys.executable, "--desktop-pet"], "pywebview_fallback"
    return [sys.executable, "-m", "app.desktop_pet"], "python_fallback"


def _external_pet_renderer_connected() -> bool:
    try:
        from . import pet_event_service

        return pet_event_service.has_desktop_renderer()
    except (ImportError, RuntimeError):
        return False


def pet_running() -> bool:
    global _pet_process, _pet_runtime_kind
    with _pet_lock:
        if _pet_process is not None:
            if _pet_process.poll() is None:
                return True
            _pet_process = None
            _pet_runtime_kind = ""
    return str(load_config().get("pet_renderer") or "classic") == "live2d" and _external_pet_renderer_connected()


def start_pet() -> dict[str, Any]:
    global _pet_process, _pet_runtime_kind
    with _pet_lock:
        if _pet_process is not None and _pet_process.poll() is None:
            already_running = True
        elif str(load_config().get("pet_renderer") or "classic") == "live2d" and _external_pet_renderer_connected():
            already_running = True
        else:
            already_running = False
            env = os.environ.copy()
            # 宿主环境防御：若后端是从 WorkBuddy/VSCode 等宿主里启动的，会继承
            # ELECTRON_RUN_AS_NODE=1——它让 electron.exe 以纯 Node 模式运行，
            # 桌宠窗口瞬间退出且无任何日志（ICU 报错是并发症状）。这里强制剥掉。
            for poison in ("ELECTRON_RUN_AS_NODE",):
                env.pop(poison, None)
            env["MIO_RUNTIME_ROOT"] = str(settings.project_root)
            env["MIO_PET_API_BASE"] = os.getenv(
                "MIO_PET_API_BASE",
                f"http://127.0.0.1:{settings.app_port}",
            ).rstrip("/")
            configured_state_root = os.getenv("MIO_DESKTOP_STATE_DIR", "").strip()
            state_root = Path(configured_state_root) if configured_state_root else (
                # 默认迁到项目根 pet-data（ASCII、可写），避开 LOCALAPPDATA\MioAgent 受控目录的写入限制
                Path(settings.source_workspace_root) / "pet-data"
                if hasattr(settings, "source_workspace_root") and settings.source_workspace_root
                else Path(os.getenv("LOCALAPPDATA", str(Path.home()))) / "MioAgent"
            )
            env["MIO_PET_STATE_DIR"] = str(state_root / "Live2D桌宠")
            env["MIO_AGENT_PARENT_PID"] = str(os.getpid())
            env["MIO_PET_DISABLE_GPU"] = (
                "1" if load_config().get("live2d_disable_gpu", False) else "0"
            )
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            command, _pet_runtime_kind = _pet_command()
            _pet_process = subprocess.Popen(
                command,
                env=env,
                cwd=str(settings.backend_dir),
                creationflags=flags,
            )
    if already_running:
        return pet_status()
    time.sleep(0.35)
    return pet_status()


def stop_pet() -> dict[str, Any]:
    global _pet_process, _pet_runtime_kind
    external_renderer = _external_pet_renderer_connected()
    if external_renderer:
        from . import pet_event_service

        pet_event_service.publish("shutdown", {"reason": "stop_requested"})
    with _pet_lock:
        process = _pet_process
        _pet_process = None
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
    _pet_runtime_kind = ""
    return pet_status()


def restart_pet() -> dict[str, Any]:
    stop_pet()
    # 等待外部渲染器（Electron）真正退出、WebSocket 连接断开后再启动，
    # 否则 start_pet 的 already_running 短路会让桌宠停留在旧实例/旧模型上。
    for _ in range(24):
        if not _external_pet_renderer_connected():
            break
        time.sleep(0.25)
    return start_pet()


def _signal_desktop_event(name: str) -> bool:
    try:
        event_handle = ctypes.windll.kernel32.OpenEventW(0x0002, False, name)
    except (AttributeError, OSError):
        return False
    if not event_handle:
        return False
    try:
        return bool(ctypes.windll.kernel32.SetEvent(event_handle))
    finally:
        ctypes.windll.kernel32.CloseHandle(event_handle)


def signal_pet_chat_window(anchor: dict[str, object] | None = None) -> bool:
    if isinstance(anchor, dict):
        try:
            payload = {
                "anchor_x": int(float(anchor.get("anchor_x") or 0)),
                "anchor_y": int(float(anchor.get("anchor_y") or 0)),
                "recorded_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            }
            PET_CHAT_ANCHOR_PATH.parent.mkdir(parents=True, exist_ok=True)
            PET_CHAT_ANCHOR_PATH.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except (OSError, TypeError, ValueError):
            pass
    return _signal_desktop_event(PET_CHAT_EVENT_NAME) or _signal_desktop_event(SHOW_EVENT_NAME)


def signal_agent_window() -> bool:
    return _signal_desktop_event(SHOW_EVENT_NAME)


def show_agent_window() -> dict[str, Any]:
    if signal_agent_window():
        return {"ok": True, "method": "event"}

    configured = str(os.getenv("MIO_AGENT_EXE") or "").strip()
    candidates = [Path(configured)] if configured else []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable))
    candidates.extend([Path("D:/Mio/Mio.exe"), Path("D:/澪Agent/澪.exe")])
    executable = next((path for path in candidates if path.is_file()), None)
    if executable is None:
        return {"ok": False, "method": "unavailable"}

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        [str(executable)],
        cwd=str(executable.parent),
        close_fds=True,
        creationflags=creationflags,
    )
    return {"ok": True, "method": "launch", "path": str(executable)}


def set_pet_activity(
    state: str,
    *,
    emotion: str = "neutral",
    source: str = "",
    ttl_seconds: float = 12,
) -> dict[str, Any]:
    global _pet_activity_revision
    normalized_state = str(state or "idle").strip().lower()
    if normalized_state not in PET_ACTIVITY_LABELS:
        normalized_state = "idle"
    normalized_emotion = str(emotion or "neutral").strip().lower()
    if normalized_emotion not in SPEECH_EMOTION_LABELS:
        normalized_emotion = "neutral"
    now = time.monotonic()
    ttl = max(0.0, min(180.0, float(ttl_seconds or 0)))
    with _pet_activity_lock:
        _pet_activity_revision += 1
        _pet_activity.update(
            {
                "state": normalized_state,
                "emotion": normalized_emotion,
                "source": str(source or "")[:40],
                "updated_at": now,
                "expires_at": now + ttl if normalized_state != "idle" and ttl > 0 else 0.0,
            }
        )
    result = pet_activity_status()
    from . import pet_event_service

    pet_event_service.publish("activity", result)
    return result


def pet_activity_status() -> dict[str, Any]:
    now = time.monotonic()
    with _pet_activity_lock:
        state = str(_pet_activity.get("state") or "idle")
        expires_at = float(_pet_activity.get("expires_at") or 0.0)
        if state != "idle" and expires_at and now >= expires_at:
            state = "idle"
            emotion = "neutral"
            source = ""
            remaining_ms = 0
        else:
            emotion = str(_pet_activity.get("emotion") or "neutral")
            source = str(_pet_activity.get("source") or "")
            remaining_ms = max(0, round((expires_at - now) * 1000)) if expires_at else 0
        return {
            "state": state,
            "label": PET_ACTIVITY_LABELS.get(state, PET_ACTIVITY_LABELS["idle"]),
            "emotion": emotion,
            "emotion_label": SPEECH_EMOTION_LABELS.get(emotion, SPEECH_EMOTION_LABELS["neutral"]),
            "source": source,
            "remaining_ms": remaining_ms,
            "revision": _pet_activity_revision,
        }


def pet_status() -> dict[str, Any]:
    from . import pet_event_service

    running = pet_running()
    sprites = pet_sprite_manifest()
    external_renderer = running and _pet_process is None
    return {
        "running": running,
        "pid": _pet_process.pid if running and _pet_process is not None else None,
        "runtime_kind": _pet_runtime_kind if _pet_process is not None else ("external_renderer" if external_renderer else ""),
        "electron_available": _electron_pet_command() is not None,
        "avatar_available": default_avatar_path() is not None,
        "sprite_states": sprites["states"],
        "sprite_set_ready": sprites["ready"],
        "sprite_expected_count": sprites["expected_count"],
        "sprite_version": sprites["version"],
        "activity": pet_activity_status(),
        "settings": load_config(),
        "live2d": {
            "available": (settings.agent_frontend_dir / "live2d-pet" / "index.html").is_file(),
            "models": available_live2d_models(),
            "notices_url": "/agent-app/live2d-pet/THIRD_PARTY_NOTICES.html",
            "runtime": pet_event_service.status(),
        },
    }


SPEECH_EMOTION_LABELS: dict[str, str] = {
    "neutral": "自然",
    "gentle": "轻柔",
    "cheerful": "开心",
    "concerned": "担心",
    "serious": "认真",
    "shy": "害羞",
}

SPEECH_EMOTION_PATTERNS: dict[str, tuple[str, ...]] = {
    "serious": (
        r"我不喜欢你这样", r"别再否定自己", r"不许", r"必须", r"认真听", r"停一下",
        r"先停下", r"不能再", r"我还是要提醒", r"别骗自己", r"说真的", r"不可以",
    ),
    "concerned": (
        r"难受", r"疼", r"痛", r"害怕", r"焦虑", r"担心", r"别硬撑", r"别撑着",
        r"不舒服", r"还好吗", r"没睡", r"失眠", r"生病", r"受伤", r"是不是累了",
        r"怎么了", r"没事吧", r"吃药", r"休息一会", r"哭", r"泪", r"呜呜",
    ),
    "cheerful": (
        r"太好了", r"太棒了", r"真棒", r"终于", r"做到了", r"好厉害", r"开心",
        r"恭喜", r"哈哈", r"嘿嘿", r"真好", r"好耶", r"喜欢", r"成功了", r"完成了",
    ),
    "shy": (
        r"害羞", r"别这样说", r"这个问题.{0,8}计算", r"不告诉你", r"先不说",
        r"不好意思", r"突然这么说", r"才没有", r"笨蛋", r"……",
    ),
    "gentle": (
        r"晚安", r"早点休息", r"睡吧", r"慢慢来", r"别急", r"陪着你", r"抱一下",
        r"抱抱", r"安心睡", r"轻一点", r"辛苦了", r"休息一下", r"今天很累", r"乖",
        r"没关系", r"我在", r"先缓一缓", r"照顾好自己",
    ),
}
SPEECH_EMOTION_PRIORITY = ("serious", "concerned", "cheerful", "shy", "gentle")

SPEECH_REQUESTED_EMOTION_PATTERNS: dict[str, tuple[str, ...]] = {
    "neutral": (
        r"(?:自然|正常|平常|普通)(?:一点|些|地|的)?(?:说|语气|口吻|声音|回复|回答)",
    ),
    "gentle": (
        r"(?:温柔|轻柔|柔和|轻一点|慢一点)(?:地|的|一点|些)?(?:说|语气|口吻|声音|回复|回答)?",
        r"哄(?:哄)?我",
    ),
    "cheerful": (
        r"(?:开心|高兴|活泼|兴奋|元气|笑)(?:一下|一点|些|地|的)?(?:说|语气|口吻|声音|回复|回答|嘛|吧)?",
    ),
    "concerned": (
        r"(?:担心|关心|安慰|心疼|哭|想哭|呜呜|呜|流泪|泪)(?:一下|一点|些|地|的)?(?:说|语气|口吻|声音|回复|回答|嘛|吧)?",
    ),
    "serious": (
        r"(?:认真|严肃|郑重|生气|不满|凶)(?:一下|一点|些|地|的)?(?:说|语气|口吻|声音|回复|回答|嘛|吧)?",
    ),
    "shy": (
        r"(?:害羞|羞涩|不好意思|脸红)(?:一下|一点|些|地|的)?(?:说|语气|口吻|声音|回复|回答|嘛|吧)?",
    ),
}

ADAPTIVE_QQ_VOICE_RE = re.compile(
    r"(?:想听(?:你|Mio|澪)(?:说话|的声音)|哄哄我|陪我说两句|念给我听|叫我起床|睡前说|晚安|我(?:有点)?难受|我(?:有点)?害怕)",
    re.IGNORECASE,
)
SPEECH_PREFIX_RE = re.compile(
    r"^\s*(?:(?:语音|音频)(?:消息)?"
    r"(?:[（(]\s*(?:约|大约)?\s*\d+(?:\.\d+)?\s*秒\s*[）)])?"
    r"(?:里)?(?:说|回复)?|(?:然后)?(?:轻轻|小声|认真|开心地|慢慢地)?"
    r"(?:笑了?(?:一声|一下)?|叹了?(?:一口气|一声)?|停顿了?(?:一下)?))\s*[：:]\s*"
)
SPEECH_STAGE_DIRECTION_RE = re.compile(
    r"[（(](?=[^（）()]{0,80}(?:声音|声线|语气|音量|音调|语速|停顿|沉默|轻轻|小声|轻声|低声|笑|叹气|深吸|呼吸|说到|听不见|看着|转开|抬头|摇头|点头|脸红|害羞|犹豫|眨眼))"
    r"[^（）()]{0,100}[）)]"
)
SPEECH_STAGE_DIRECTION_LINE_RE = re.compile(
    r"^\s*(?:声音|声线|语气|音量|语速|停顿|沉默|轻轻地?|小声地?|轻声地?|低声地?|笑了?|叹气|深吸一口气|呼吸|说到最后|几乎听不见).{0,80}\s*$"
)
SPEECH_META_RE = re.compile(
    r"^\s*[（(].*(?:这次|语音|声音|听到|听见|发出来|没问题).*[）)]\s*$"
)
SPEECH_CONTENT_RE = re.compile(r"[A-Za-z0-9\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
SPEECH_LATIN_RE = re.compile(r"[A-Za-z]+")
SPEECH_JAPANESE_RE = re.compile(r"[\u3040-\u30ff]")
SPEECH_HAN_RE = re.compile(r"[\u3400-\u9fff]")
SPEECH_TERM_PRONUNCIATIONS = {
    "ai": "人工智能",
    "qq": "扣扣",
    "gpt": "吉皮提",
    "api": "接口",
    "pdf": "批迪艾弗",
    "ui": "优艾",
    "unity": "尤尼蒂",
    "steam": "斯提姆",
    "deepseek": "迪普西克",
}
SPEECH_LETTER_PRONUNCIATIONS = {
    "a": "诶", "b": "比", "c": "西", "d": "迪", "e": "伊", "f": "艾弗", "g": "吉",
    "h": "艾尺", "i": "爱", "j": "杰", "k": "开", "l": "艾勒", "m": "艾姆", "n": "恩",
    "o": "欧", "p": "批", "q": "丘", "r": "阿尔", "s": "艾丝", "t": "提", "u": "优",
    "v": "维", "w": "达不溜", "x": "艾克斯", "y": "歪", "z": "贼德",
}





# Domain composition. Legacy imports remain supported; new code belongs in the domains.
from .configuration import ConfigurationService
_configuration_service = ConfigurationService(
    dep_DEFAULT_CONFIG=lambda: DEFAULT_CONFIG,
    dep_LIVE2D_EXPRESSION_SLOT_IDS=lambda: LIVE2D_EXPRESSION_SLOT_IDS,
    dep_LIVE2D_MOTION_SLOT_IDS=lambda: LIVE2D_MOTION_SLOT_IDS,
    dep_LIVE2D_PHASE_IDS=lambda: LIVE2D_PHASE_IDS,
    dep__live2d_model_ids=lambda *args, **kwargs: _live2d_model_ids(*args, **kwargs),
    dep_settings=lambda: settings,
)
_migrate_config = _configuration_service._migrate_config
_normalize_live2d_motion_slots = _configuration_service._normalize_live2d_motion_slots
_normalize_live2d_expression_slots = _configuration_service._normalize_live2d_expression_slots
load_config = _configuration_service.load_config
save_config = _configuration_service.save_config
load_normalized_config = _configuration_service.load_normalized_config
save_pet_position = _configuration_service.save_pet_position
save_pet_size = _configuration_service.save_pet_size

from .live2d_assets import Live2DAssetsService
_live2d_assets_service = Live2DAssetsService(
    dep_LIVE2D_MODELS=lambda: _builtin_live2d_models(),
    dep__decode_image_data_url=lambda *args, **kwargs: _decode_image_data_url(*args, **kwargs),
    dep_load_config=lambda *args, **kwargs: load_config(*args, **kwargs),
    dep_save_config=lambda *args, **kwargs: save_config(*args, **kwargs),
)
live2d_state_dir = _live2d_assets_service.live2d_state_dir
_live2d_models_dir = _live2d_assets_service._live2d_models_dir
_live2d_runtime_path = _live2d_assets_service._live2d_runtime_path
_read_json_object = _live2d_assets_service._read_json_object
_safe_child = _live2d_assets_service._safe_child
_live2d_capabilities = _live2d_assets_service._live2d_capabilities
_register_unlisted_live2d_expressions = _live2d_assets_service._register_unlisted_live2d_expressions
_live2d_preview_candidate = _live2d_assets_service._live2d_preview_candidate
_custom_live2d_models = _live2d_assets_service._custom_live2d_models
available_live2d_models = _live2d_assets_service.available_live2d_models
_live2d_model_ids = _live2d_assets_service._live2d_model_ids
_write_live2d_runtime_selected = _live2d_assets_service._write_live2d_runtime_selected
select_live2d_model = _live2d_assets_service.select_live2d_model
import_live2d_model_directory = _live2d_assets_service.import_live2d_model_directory
delete_live2d_model = _live2d_assets_service.delete_live2d_model
live2d_model_preview_path = _live2d_assets_service.live2d_model_preview_path
save_live2d_model_preview_data_url = _live2d_assets_service.save_live2d_model_preview_data_url
live2d_model_root = _live2d_assets_service.live2d_model_root

from .appearance import AppearanceService
_appearance_service = AppearanceService(
    dep_MAX_SPRITE_SHEET_BYTES=lambda: MAX_SPRITE_SHEET_BYTES,
    dep_MAX_SPRITE_SHEET_PIXELS=lambda: MAX_SPRITE_SHEET_PIXELS,
    dep_PET_SPRITE_FILES=lambda: PET_SPRITE_FILES,
    dep_settings=lambda: settings,
)
default_avatar_path = _appearance_service.default_avatar_path
profile_avatar_path = _appearance_service.profile_avatar_path
pet_sprite_path = _appearance_service.pet_sprite_path
pet_sprite_manifest = _appearance_service.pet_sprite_manifest
_decode_image_data_url = _appearance_service._decode_image_data_url
save_avatar_data_url = _appearance_service.save_avatar_data_url
save_profile_avatar_data_url = _appearance_service.save_profile_avatar_data_url
save_user_avatar_data_url = _appearance_service.save_user_avatar_data_url
save_chat_background_data_url = _appearance_service.save_chat_background_data_url
save_sprite_sheet_data_url = _appearance_service.save_sprite_sheet_data_url

from .speech_text import SpeechTextService
_speech_text_service = SpeechTextService(
    dep_ADAPTIVE_QQ_VOICE_RE=lambda: ADAPTIVE_QQ_VOICE_RE,
    dep_SPEECH_CONTENT_RE=lambda: SPEECH_CONTENT_RE,
    dep_SPEECH_EMOTION_LABELS=lambda: SPEECH_EMOTION_LABELS,
    dep_SPEECH_EMOTION_PATTERNS=lambda: SPEECH_EMOTION_PATTERNS,
    dep_SPEECH_EMOTION_PRIORITY=lambda: SPEECH_EMOTION_PRIORITY,
    dep_SPEECH_HAN_RE=lambda: SPEECH_HAN_RE,
    dep_SPEECH_JAPANESE_RE=lambda: SPEECH_JAPANESE_RE,
    dep_SPEECH_LATIN_RE=lambda: SPEECH_LATIN_RE,
    dep_SPEECH_LETTER_PRONUNCIATIONS=lambda: SPEECH_LETTER_PRONUNCIATIONS,
    dep_SPEECH_META_RE=lambda: SPEECH_META_RE,
    dep_SPEECH_PREFIX_RE=lambda: SPEECH_PREFIX_RE,
    dep_SPEECH_REQUESTED_EMOTION_PATTERNS=lambda: SPEECH_REQUESTED_EMOTION_PATTERNS,
    dep_SPEECH_STAGE_DIRECTION_LINE_RE=lambda: SPEECH_STAGE_DIRECTION_LINE_RE,
    dep_SPEECH_STAGE_DIRECTION_RE=lambda: SPEECH_STAGE_DIRECTION_RE,
    dep_SPEECH_TERM_PRONUNCIATIONS=lambda: SPEECH_TERM_PRONUNCIATIONS,
    dep_load_config=lambda *args, **kwargs: load_config(*args, **kwargs),
)
_speech_latin_pronunciation = _speech_text_service._speech_latin_pronunciation
clean_speech_text = _speech_text_service.clean_speech_text
speech_text_language = _speech_text_service.speech_text_language
_naturalize_short_speech_text = _speech_text_service._naturalize_short_speech_text
_requested_speech_emotion = _speech_text_service._requested_speech_emotion
infer_speech_emotion = _speech_text_service.infer_speech_emotion
prepare_speech_prosody = _speech_text_service.prepare_speech_prosody
speech_emotion_info = _speech_text_service.speech_emotion_info


def _create_window_observer():
    use_process = os.getenv("MIO_SCREEN_OBSERVER_PROCESS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    is_worker = os.getenv("MIO_SCREEN_OBSERVER_WORKER", "").strip() == "1"
    if use_process and not is_worker:
        from ..screen.screen_observer_process import ScreenObserverProcess

        return ScreenObserverProcess()
    return WindowObserver()


window_observer = _create_window_observer()
game_observer = window_observer


def shutdown() -> None:
    def run(label: str, callback) -> None:
        try:
            callback()
        except Exception:
            logger.exception("关闭 Mio 运行资源失败：%s", label)

    run("屏幕观察", window_observer.stop)
    close_observer = getattr(window_observer, "close", None)
    if callable(close_observer):
        run("屏幕观察进程", close_observer)
    run("系统声音", system_audio_service.stop)
    # ★ 2026-10-24：音频反应采集子进程（跟随系统扬声器呼吸/摆动）
    try:
        from . import audio_spectrum_service

        run("音频频谱采集", audio_spectrum_service.stop_all)
    except Exception:
        logger.exception("关闭音频频谱采集失败")
    run("临时预览", cleanup_legacy_preview)
    run("Live2D 桌宠", stop_pet)
    try:
        from ..screen import local_vision_service
    except Exception:
        logger.exception("加载本地视觉清理模块失败")
    else:
        run("本地视觉", local_vision_service.stop_server)
