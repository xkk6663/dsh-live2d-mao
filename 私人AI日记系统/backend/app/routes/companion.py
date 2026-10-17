from __future__ import annotations

import asyncio
import base64
from difflib import SequenceMatcher
import logging
import random
import re
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import quote

logger = logging.getLogger("companion.routes")

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, WebSocket
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .. import (
    db,
)
from ..screen import local_vision_service, route_observation_service, screen_observation_service, system_audio_service, window_topology_service
from ..companion import audio_diag, call_session_service, companion_service, pet_event_service
from ..kernel import agent_bus_service
from ..agents.dsh import dsh_adapter
from ..auto_router import AutoRoute, build_task_profile, select_auto_route
from ..chat.chat_idempotency import (
    claim_request,
    content_fingerprint,
    normalize_error_detail,
    pending_error,
    request_fingerprint,
)
from ..kernel.agent_loop_service import abandon_deferred_final_response
from ..chat.chat_service import chat_with_ai, persist_generated_chat_result
from ..chat.conversation_runtime import ChatRunCancelledError, chat_run_coordinator
from ..config import settings
from ..llm import ModelRequestError, resolve_model_id
from ..image_service import image_attachment_from_data_url


router = APIRouter(prefix="/api/companion")
DESKTOP_PET_CONVERSATION_ID = "desktop_pet"
_pet_call_started_observer = False
_pet_call_previous_audio_model = ""
_pet_call_previous_audio_engine = ""
_pet_call_resource_owner = ""
CALL_ASR_MODEL = "large-v3-turbo"
PHONE_TOOL_INTENT_RE = re.compile(
    r"(查一下|搜索|联网|提醒|记住|写进|创建|删除|修改|打开|关闭|设置|"
    r"看(?:看|一下)?(?:屏幕|画面|窗口)|(?:看到|看见).*(?:什么|啥)|现在.*(?:状态|正常|能力)|"
    r"检查.*(?:状态|服务|语音|模型)|做一件|帮我做|替我)",
    re.IGNORECASE,
)


def _phone_turn_policy(transcript: str, configured_reasoning: str) -> tuple[bool, str]:
    needs_tools = bool(PHONE_TOOL_INTENT_RE.search(str(transcript or "")))
    if needs_tools:
        return True, configured_reasoning
    return False, "off"


def _route_metadata(route: AutoRoute | None) -> tuple[str, dict[str, object], tuple[dict[str, object], ...]]:
    if route is None:
        return "conversation", {}, ()
    task_profile = dict(getattr(route, "task_profile", {}) or {})
    candidates = tuple(getattr(route, "candidates", ()) or ())
    return str(task_profile.get("task_type") or "conversation"), task_profile, candidates


def _record_chat_route_failure(
    route: AutoRoute | None,
    *,
    source: str,
    request_id: str,
    selected_model_id: str,
    selected_reasoning_level: str,
    error_code: str,
) -> None:
    task_type, task_profile, candidates = _route_metadata(route)
    route_observation_service.record_failed_route(
        source=source,
        mode="automatic" if route is not None else "manual",
        request_id=request_id,
        selected_model_id=selected_model_id,
        selected_reasoning_level=selected_reasoning_level,
        actual_model_id=selected_model_id,
        difficulty=str(getattr(route, "difficulty", "")) if route is not None else "",
        reason=(
            str(getattr(route, "reason", "自动路由"))
            if route is not None
            else "桌宠或电话设置指定模型与思考档位"
        ),
        latency_budget_ms=int(getattr(route, "latency_budget_ms", 0) or 0) if route is not None else 0,
        error_code=error_code,
        task_type=task_type,
        task_profile=task_profile,
        candidates=candidates,
    )


def _record_chat_route_success(
    route: AutoRoute | None,
    *,
    source: str,
    request_id: str,
    selected_model_id: str,
    selected_reasoning_level: str,
    result: object,
) -> None:
    task_type, task_profile, candidates = _route_metadata(route)
    escalated_from = str(getattr(result, "route_escalated_from_model_id", "") or "")
    if route is not None and escalated_from:
        _record_chat_route_failure(
            route,
            source=source,
            request_id=request_id,
            selected_model_id=escalated_from,
            selected_reasoning_level=selected_reasoning_level,
            error_code="primary_model_failed_before_final_reply",
        )
    route_observation_service.record_completed_route(
        source=source,
        mode="automatic" if route is not None else "manual",
        request_id=request_id,
        selected_model_id=selected_model_id,
        selected_reasoning_level=str(getattr(result, "reasoning_level", selected_reasoning_level) or selected_reasoning_level),
        actual_model_id=str(getattr(result, "model_id", selected_model_id) or selected_model_id),
        connection_route=str(getattr(result, "route", "") or ""),
        difficulty=str(getattr(route, "difficulty", "")) if route is not None else "",
        reason=(
            str(getattr(route, "reason", "自动路由"))
            if route is not None
            else "桌宠或电话设置指定模型与思考档位"
        ),
        latency_budget_ms=int(getattr(route, "latency_budget_ms", 0) or 0) if route is not None else 0,
        first_token_latency_ms=getattr(result, "first_token_latency_ms", None),
        total_latency_ms=getattr(result, "total_latency_ms", None),
        request_cost_yuan=getattr(result, "request_cost_yuan", None),
        request_cost_source=str(getattr(result, "request_cost_source", "") or ""),
        task_type=task_type,
        task_profile=task_profile,
        candidates=candidates,
        escalated_from_model_id=escalated_from,
    )


@router.websocket("/ws")
async def companion_websocket(websocket: WebSocket):
    await pet_event_service.serve(websocket)


class CompanionSettingsRequest(BaseModel):
    voice_enabled: bool = True
    pet_call_asr_engine: str = Field(
        default="auto",
        pattern="^(auto|whisper|sensevoice|paraformer)$",
    )
    pet_call_input_language: str = Field(default="zh", pattern="^(auto|zh|ja)$")
    pet_call_silence_ms: int = Field(default=650, ge=350, le=1800)
    pet_call_voice_threshold: float = Field(default=0.018, ge=0.004, le=0.12)
    pet_call_min_speech_ms: int = Field(default=280, ge=150, le=1500)
    pet_call_max_turn_seconds: int = Field(default=18, ge=5, le=45)
    voice_volume: int = Field(default=85, ge=0, le=100)
    voice_streaming_enabled: bool = True
    pet_speech_language: str = Field(default="zh", pattern="^(zh|ja)$")
    speak_screen_observations: bool = True
    speak_game_observations: bool = True
    screen_ai_enabled: bool = True
    screen_audio_enabled: bool = True
    screen_audio_model: str = Field(default="base", pattern="^(tiny|base|small)$")
    screen_audio_language: str = Field(default="auto", pattern="^(auto|zh|ja|en)$")
    screen_audio_chunk_seconds: int = Field(default=5, ge=4, le=15)
    screen_vision_route: str = Field(default="local", pattern="^(local|cloud)$")
    screen_vision_model_id: str = Field(default="auto-fast", max_length=200)
    screen_direct_voice_enabled: bool = True
    screen_change_threshold: float = Field(default=8.0, ge=1.0, le=50.0)
    screen_analysis_interval_seconds: int = Field(default=5, ge=5, le=600)
    screen_request_timeout_seconds: int = Field(default=25, ge=5, le=60)
    screen_voice_cooldown_seconds: int = Field(default=5, ge=5, le=600)
    screen_minimum_importance: float = Field(default=0.62, ge=0.0, le=1.0)
    screen_daily_cost_limit_yuan: float = Field(default=5.0, ge=0.1, le=1000.0)
    bubble_seconds: int = Field(default=9, ge=3, le=30)
    pet_size_percent: int = Field(default=150, ge=80, le=240)
    pet_renderer: str = Field(default="live2d", pattern="^(classic|live2d)$")
    live2d_model_id: str = Field(default="hiyori", min_length=1, max_length=100)
    live2d_scale: float = Field(default=1.0, ge=0.65, le=1.55)
    live2d_vertical_offset: float = Field(default=0.0, ge=-0.35, le=0.35)
    live2d_follow_cursor: bool = True
    live2d_idle_motion: bool = True
    live2d_click_motion: bool = True
    live2d_smart_passthrough: bool = True
    live2d_click_through_locked: bool = False
    live2d_speech_bubble_enabled: bool = True
    live2d_keep_visible: bool = False
    live2d_always_on_top: bool = True
    live2d_disable_gpu: bool = False
    live2d_motion_slots: dict[str, dict[str, str]] = Field(default_factory=dict)
    live2d_expression_slots: dict[str, dict[str, str]] = Field(default_factory=dict)
    # 泡泡工坊：说话气泡皮肤 + 点击互动开关（Mio「泡泡」页管理，桌宠热应用）
    live2d_bubble_style: str = Field(default="default", max_length=40)
    pet_click_talk_enabled: bool = True
    # M1 逐 token 流式：插件正文增量按上游节奏铺进气泡（关掉后仍可用一次性文本气泡）
    live2d_stream_text_enabled: bool = True
    # ★ 横条个性化（2026-10-17 用户需求）：默认宽度(px，0=内容自适应)、默认行数(1-5)、
    #   皮肤 id（default/mono/navy/peach/matcha/note/terminal/comic，为「横条 UI 可更换」预留）
    live2d_strip_width: int = Field(default=0, ge=0, le=4000)
    live2d_strip_rows: int = Field(default=1, ge=1, le=5)
    live2d_strip_style: str = Field(default="default", max_length=40)
    # 音效事件配置：{press/release/switch/task_end/ask/approval/error:
    #   {enabled: bool, volume: 0-100, clip: '片段文件名或空(合成音)'}}
    pet_sound_events: dict = Field(default_factory=dict)
    # 点击序列：{first: '首次点击泡', queue: ['第2次','第3次',...]}（项支持 a|b 等权随机、{image} 随机图片）
    pet_click_bubbles: dict = Field(default_factory=dict)
    # 图片池权重：{文件名: 权重}
    pet_image_weights: dict = Field(default_factory=dict)
    # A 档：桌宠"生命感"设置。
    # ⚠️ 本模型就是**写入白名单**：未在此声明的键会被 model_dump(exclude_unset=True)
    # 静默丢弃（读得到、写不进，表现为"改了没反应"）。新增桌宠设置必须同时改
    # 这里与 companion_service.DEFAULT_CONFIG，缺一处就"保存无效"。
    pet_sound_enabled: bool = True
    pet_sound_volume: int = Field(default=70, ge=0, le=100)
    pet_idle_talk_enabled: bool = True
    pet_idle_talk_min_seconds: int = Field(default=90, ge=30, le=3600)
    pet_idle_talk_max_seconds: int = Field(default=240, ge=30, le=7200)
    pet_press_bounce_enabled: bool = True


class AvatarRequest(BaseModel):
    data_url: str


class SpriteSheetRequest(BaseModel):
    data_url: str


class Live2DModelImportRequest(BaseModel):
    source_path: str = Field(min_length=1, max_length=2000)
    display_name: str = Field(default="", max_length=100)


class Live2DPreviewRequest(BaseModel):
    data_url: str


class CompanionChatImageRequest(BaseModel):
    name: str = Field(default="粘贴的图片.png", max_length=120)
    data_url: str


class CompanionChatRequest(BaseModel):
    message: str = Field(default="", max_length=4000)
    model_id: str = Field(default="auto", max_length=200)
    reasoning_level: str = Field(default="auto", max_length=50)
    images: list[CompanionChatImageRequest] = Field(default_factory=list, max_length=5)
    client_request_id: str = Field(default="", max_length=80, pattern=r"^[A-Za-z0-9._:-]*$")


class CompanionChatCancelRequest(BaseModel):
    client_request_id: str = Field(default="", max_length=80, pattern=r"^[A-Za-z0-9._:-]*$")


class CompanionCallTurnRequest(BaseModel):
    wav_base64: str = Field(min_length=20, max_length=8_000_000)
    language: str = Field(default="zh", pattern="^(auto|zh|ja)$")
    call_session_id: str = Field(default="", max_length=80)
    turn_id: int = Field(default=0, ge=0, le=1_000_000)


class CompanionCallControlRequest(BaseModel):
    call_session_id: str = Field(default="", max_length=80)
    response_id: str = Field(default="", max_length=160)


class CompanionCallDeviceRequest(BaseModel):
    call_session_id: str = Field(min_length=1, max_length=80)
    device_id: str = Field(default="", max_length=500)
    label: str = Field(default="", max_length=500)
    sample_rate: int = Field(default=0, ge=0, le=384000)
    channel_count: int = Field(default=0, ge=0, le=32)
    echo_cancellation: bool | None = None
    noise_suppression: bool | None = None
    auto_gain_control: bool | None = None


class CompanionPositionRequest(BaseModel):
    x: int = Field(ge=-10000, le=10000)
    y: int = Field(ge=-10000, le=10000)


class CompanionSizeRequest(BaseModel):
    percent: int = Field(ge=80, le=240)


class CompanionChatWindowStateRequest(BaseModel):
    open: bool


class WindowTopologyEventRequest(BaseModel):
    source: str = Field(min_length=1, max_length=100)
    runtime: str = Field(min_length=1, max_length=80)
    window_id: str = Field(min_length=1, max_length=100)
    pid: int = Field(default=0, ge=0)
    action: str = Field(min_length=1, max_length=80)
    correlation_id: str = Field(min_length=1, max_length=120)
    visible: bool = False
    focused: bool = False
    bounds: dict[str, int] = Field(default_factory=dict)


class Live2DMotionPreviewRequest(BaseModel):
    group: str = Field(min_length=1, max_length=120)
    index: int | None = Field(default=None, ge=0, le=100)


class Live2DExpressionPreviewRequest(BaseModel):
    expression: str = Field(min_length=1, max_length=120)


class GameWindowRequest(BaseModel):
    hwnd: int


class WindowObservationRequest(BaseModel):
    interval_ms: int = Field(default=1000, ge=500, le=5000)
    capture_only: bool = False


class ScreenObservationRequest(WindowObservationRequest):
    scope: str = Field(default="primary", pattern="^(primary|all)$")


def _status_payload() -> dict[str, object]:
    window_status = companion_service.window_observer.status()
    return {
        "pet": companion_service.pet_status(),
        "screen": window_status,
        "screen_analysis": screen_observation_service.status(),
        "system_audio": system_audio_service.status(),
        "window": window_status,
        "game": window_status,
        "call": call_runtime_status(),
        "window_topology": window_topology_service.snapshot(),
    }


def call_runtime_status() -> dict[str, object]:
    return {
        **call_session_service.manager.status(),
        "started_observer": _pet_call_started_observer,
        "previous_audio_model": _pet_call_previous_audio_model,
        "asr": system_audio_service.status(),
    }


def _primary_conversation_id() -> str:
    if settings.qq_allowed_user_ids:
        return f"qq_private_{settings.qq_allowed_user_ids[0]}"
    return "default"


def _desktop_pet_conversation_id() -> str:
    return DESKTOP_PET_CONVERSATION_ID


def _pet_call_screen_context() -> str:
    observation = screen_observation_service.status()
    foreground = pet_event_service.status().get("foreground") or {}
    parts = [
        "【电话模式的当前电脑上下文】",
        "这是系统私下提供的环境信息，不要复述标签，也不要声称看到了这里没有的信息。",
    ]
    title = str(foreground.get("title") or "").strip()
    process_name = str(foreground.get("process_name") or "").strip()
    if title or process_name:
        parts.append(f"当前前台窗口：{title or '标题未知'}（{process_name or '程序未知'}）")
    summary = str(observation.get("last_event_summary") or "").strip()
    if summary:
        parts.append(f"最近画面摘要：{summary}")
    game_state = observation.get("game_state")
    if isinstance(game_state, dict) and game_state:
        compact_state = ", ".join(
            f"{key}={value}" for key, value in list(game_state.items())[:8]
            if value is not None and value != "" and value != [] and value != {}
        )
        if compact_state:
            parts.append(f"最近画面状态：{compact_state}")
    last_analyzed_at = str(observation.get("last_analyzed_at") or "").strip()
    if last_analyzed_at:
        parts.append(f"画面摘要时间：{last_analyzed_at}")
    parts.append("像电话聊天一样直接回答，优先一到三句自然短句。只有与当前话题有关时才提到屏幕内容。")
    return "\n".join(parts)


def _ensure_call_asr_ready() -> dict[str, object]:
    config = companion_service.load_config()
    requested_engine = str(config.get("pet_call_asr_engine") or "auto").strip().lower()
    resolved_engine = "whisper" if requested_engine == "auto" else requested_engine
    if resolved_engine == "paraformer" and config.get("pet_call_input_language") == "ja":
        return {
            **system_audio_service.status(),
            "ready": False,
            "last_error": "Paraformer 中文模型不支持日语电话识别，请改用自动、Faster-Whisper 或 SenseVoice。",
        }
    forced = dict(config)
    forced["screen_audio_enabled"] = True
    forced["asr_engine"] = resolved_engine
    if resolved_engine == "whisper":
        forced["asr_model"] = CALL_ASR_MODEL
    current = system_audio_service.start(forced)
    return current


def _release_call_resources_sync(call_session_id: str = "") -> None:
    global _pet_call_started_observer, _pet_call_previous_audio_model
    global _pet_call_previous_audio_engine, _pet_call_resource_owner

    if (
        call_session_id
        and _pet_call_resource_owner
        and call_session_id != _pet_call_resource_owner
    ):
        return

    if _pet_call_started_observer:
        companion_service.window_observer.stop()
        screen_observation_service.end_session()
    _pet_call_started_observer = False

    config = companion_service.load_config()
    if not companion_service.window_observer.status().get("running") or not config.get("screen_audio_enabled", True):
        system_audio_service.stop()
    else:
        restored = dict(config)
        restored["asr_engine"] = _pet_call_previous_audio_engine or "whisper"
        if _pet_call_previous_audio_model in {"tiny", "base", "small"}:
            restored["screen_audio_model"] = _pet_call_previous_audio_model
        system_audio_service.start(restored)
    _pet_call_previous_audio_model = ""
    _pet_call_previous_audio_engine = ""
    _pet_call_resource_owner = ""


async def _release_call_resources(call_session_id: str = "") -> None:
    await asyncio.to_thread(_release_call_resources_sync, call_session_id)


def _preview_response(not_found_detail: str) -> Response:
    content = companion_service.window_observer.take_preview()
    if content is None:
        raise HTTPException(status_code=404, detail=not_found_detail)
    return Response(content=content, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/status")
async def companion_status():
    payload = await asyncio.to_thread(_status_payload)
    payload["agents"] = agent_bus_service.snapshot()
    return payload


@router.get("/agents")
async def companion_agents():
    """跨 Agent 总线快照：全部 Agent 状态 + 当前活跃者。"""
    return agent_bus_service.snapshot()


@router.get("/agents/{agent_id}/inspect")
async def companion_agent_inspect(agent_id: str):
    """单个 Agent 的诊断快照（脱离总线也能看内部细节）。

    比 ``/agents`` 快照更深：对 DSH 会返回边车存活/错误、DSH 进程是否在跑、最近折叠出的
    facts，以及本适配器注册的 phase 词汇。排障时先看这里。
    """
    if agent_id == dsh_adapter.AGENT_ID:
        return dsh_adapter.inspect_current()
    agent = agent_bus_service.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"未知的 agent: {agent_id}")
    return agent.to_dict()


class AgentEnableRequest(BaseModel):
    enabled: bool


@router.post("/agents/{agent_id}/enabled")
async def companion_agent_enabled(agent_id: str, payload: AgentEnableRequest):
    """启用/停用某个 Agent 适配器（即换即用：停用立即释放"身体"，启用立即可接收事件）。"""
    changed = agent_bus_service.set_enabled(agent_id, payload.enabled)
    if not changed:
        raise HTTPException(status_code=404, detail=f"未知的 agent: {agent_id}")
    return {"ok": True, "agent_id": agent_id, "enabled": payload.enabled}


@router.get("/chat-anchor")
async def companion_chat_anchor():
    return {"anchor": companion_service.pet_chat_anchor()}


@router.post("/chat-window/state")
async def companion_chat_window_state(payload: CompanionChatWindowStateRequest):
    pet_event_service.publish("chat_window_state", {"open": payload.open})
    return {"ok": True, "open": payload.open}


@router.get("/window-topology")
async def companion_window_topology():
    return window_topology_service.snapshot()


@router.post("/window-topology/events")
async def companion_window_topology_event(payload: WindowTopologyEventRequest):
    try:
        event = window_topology_service.record(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"recorded": True, "event": event}


@router.post("/agent/show")
async def companion_agent_show():
    result = companion_service.show_agent_window()
    if not result["ok"]:
        raise HTTPException(status_code=503, detail="没有找到正在运行或已安装的 Mio。")
    return result


@router.get("/audio/devices")
async def companion_audio_devices():
    """枚举系统音频输出设备（体检用）。"""
    return audio_diag.enumerate_output_devices()


@router.post("/audio/test")
async def companion_audio_test(payload: dict | None = None):
    """用系统 API 播放测试音到默认设备（体检用）。"""
    payload = payload or {}
    return audio_diag.play_system_test_tone(
        freq=int(payload.get("freq", 440)),
        seconds=float(payload.get("seconds", 1.2)),
    )


@router.get("/version")
async def companion_version():
    """后端版本信息（桌宠管理页展示用）。"""
    import platform
    data = {
        "name": "Mio 私人AI日记系统 · 桌宠后端",
        "python": platform.python_version(),
    }
    try:
        import av
        data["av"] = av.__version__
    except Exception:  # noqa: BLE001
        data["av"] = "-"
    return {"ok": True, "data": data}


async def _wake_pet_from_screen() -> None:
    try:
        await screen_observation_service.analyze_once(force=True, wake=True)
    finally:
        if companion_service.pet_running():
            companion_service.set_pet_activity(
                "idle",
                source="desktop_pet_wake",
                ttl_seconds=0,
            )


def _start_pet_with_screen_observation() -> bool:
    screen_observation_service.set_capture_only(False)
    companion_service.window_observer.select_screen("primary")
    companion_service.window_observer.start(1000)
    companion_service.save_config({"screen_audio_enabled": True})
    system_audio_service.start(companion_service.load_config())
    companion_service.set_pet_activity(
        "thinking",
        emotion="gentle",
        source="desktop_pet_wake",
        ttl_seconds=120,
    )
    return bool(companion_service.load_config().get("voice_enabled", True))


def _start_companion_runtime() -> tuple[dict[str, object], bool]:
    was_running = companion_service.pet_running()
    companion_service.start_pet()
    should_wake = not was_running
    if should_wake:
        _start_pet_with_screen_observation()
    return _status_payload(), should_wake


def _stop_companion_runtime() -> None:
    companion_service.stop_pet()
    companion_service.window_observer.stop()
    screen_observation_service.end_session()
    companion_service.save_config({"screen_audio_enabled": False})
    system_audio_service.stop()


def _restart_companion_runtime() -> tuple[dict[str, object], bool]:
    _stop_companion_runtime()
    companion_service.start_pet()
    _start_pet_with_screen_observation()
    return _status_payload(), True


def _apply_companion_settings(changes: dict[str, object]) -> None:
    was_running = companion_service.pet_running()
    if "screen_audio_enabled" in changes:
        # 系统声音观察是视觉观察的一部分，不再接受独立开关状态。
        changes["screen_audio_enabled"] = bool(
            companion_service.window_observer.status().get("running")
        )
    previous_model_id = str(companion_service.load_config().get("live2d_model_id") or "hiyori")
    selected_model_id = str(changes.get("live2d_model_id") or "")
    if selected_model_id:
        companion_service.select_live2d_model(selected_model_id)
    companion_service.save_config(changes)
    # 模型切换不再重启桌宠进程：save_config 已向在线渲染器推送 settings_changed，
    # 渲染器侧 applySettings 会检测 live2d_model_id 变化并原地 loadModel 热切换，
    # 桌宠窗口保持不闪退、切换即时。桌宠离线时保存即可，下次启动按新模型加载。
    audio_settings_changed = bool(
        {"screen_audio_enabled", "screen_audio_model", "screen_audio_language", "screen_audio_chunk_seconds"}
        & changes.keys()
    )
    if audio_settings_changed and companion_service.window_observer.status().get("running"):
        system_audio_service.stop()
        saved_config = companion_service.load_config()
        if saved_config["screen_audio_enabled"]:
            system_audio_service.start(saved_config)


def _start_observation_runtime(
    *,
    interval_ms: int,
    capture_only: bool,
    hwnd: int | None = None,
    screen_scope: str = "",
) -> dict[str, object]:
    screen_observation_service.set_capture_only(capture_only)
    observer = companion_service.window_observer
    if screen_scope:
        observer.select_screen(screen_scope)
    elif hwnd:
        observer.select(hwnd)
    result = observer.start(interval_ms)
    if not capture_only:
        companion_service.save_config({"screen_audio_enabled": True})
        if not _pet_call_resource_owner:
            system_audio_service.start(companion_service.load_config())
    return result


def _stop_observation_runtime() -> dict[str, object]:
    result = companion_service.window_observer.stop()
    screen_observation_service.end_session()
    companion_service.save_config({"screen_audio_enabled": False})
    if not _pet_call_resource_owner:
        system_audio_service.stop()
    return result


def _prepare_call_runtime(call_session_id: str) -> dict[str, object]:
    global _pet_call_started_observer, _pet_call_previous_audio_model
    global _pet_call_previous_audio_engine, _pet_call_resource_owner
    audio_status = system_audio_service.status()
    _pet_call_resource_owner = call_session_id
    _pet_call_previous_audio_model = (
        str(audio_status.get("model") or "") if audio_status.get("running") else ""
    )
    previous_engine = str(audio_status.get("requested_engine") or audio_status.get("engine") or "")
    _pet_call_previous_audio_engine = {
        "faster-whisper": "whisper",
        "sensevoice-small": "sensevoice",
        "paraformer-zh": "paraformer",
    }.get(previous_engine, previous_engine)
    observer_was_running = bool(companion_service.window_observer.status().get("running"))
    _pet_call_started_observer = not observer_was_running
    if _pet_call_started_observer:
        companion_service.window_observer.select_screen("primary")
        companion_service.window_observer.start(1000)
        screen_observation_service.set_capture_only(False)
    return audio_status


def _normalized_echo_text(text: str) -> str:
    return re.sub(r"[^0-9A-Za-z\u3040-\u30ff\u3400-\u9fff]+", "", str(text or "")).lower()


def _is_recent_playback_echo(transcript: str, reference: str) -> tuple[bool, float]:
    heard = _normalized_echo_text(transcript)
    spoken = _normalized_echo_text(reference)
    if len(heard) < 3 or len(spoken) < 3:
        return False, 0.0
    similarity = SequenceMatcher(None, heard, spoken).ratio()
    contained = len(heard) >= 4 and heard in spoken
    coverage = len(heard) / max(1, len(spoken))
    is_echo = contained and coverage >= 0.18 or similarity >= 0.72
    return is_echo, round(similarity, 4)


@router.post("/start")
async def companion_start(background_tasks: BackgroundTasks):
    try:
        status, should_wake = await asyncio.to_thread(_start_companion_runtime)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"桌宠启动失败：{exc}") from exc
    except (ValueError, RuntimeError) as exc:
        await asyncio.to_thread(companion_service.stop_pet)
        raise HTTPException(status_code=500, detail=f"桌宠启动后无法观察屏幕：{exc}") from exc
    if should_wake:
        background_tasks.add_task(_wake_pet_from_screen)
    return status


@router.post("/stop")
async def companion_stop():
    await asyncio.to_thread(_stop_companion_runtime)
    await asyncio.to_thread(local_vision_service.unload_model)
    return await asyncio.to_thread(_status_payload)


@router.post("/restart")
async def companion_restart(background_tasks: BackgroundTasks):
    try:
        status, _ = await asyncio.to_thread(_restart_companion_runtime)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"桌宠重启失败：{exc}") from exc
    except (ValueError, RuntimeError) as exc:
        await asyncio.to_thread(companion_service.stop_pet)
        raise HTTPException(status_code=500, detail=f"桌宠重启后无法观察屏幕：{exc}") from exc
    background_tasks.add_task(_wake_pet_from_screen)
    return status


@router.patch("/settings")
async def companion_settings(
    payload: CompanionSettingsRequest,
    background_tasks: BackgroundTasks = None,
):
    changes = payload.model_dump(exclude_unset=True)
    try:
        await asyncio.to_thread(_apply_companion_settings, changes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if changes.get("screen_vision_route") == "cloud":
        await asyncio.to_thread(local_vision_service.unload_model)
    return await asyncio.to_thread(_status_payload)


@router.get("/live2d/models")
async def companion_live2d_models():
    return {"models": await asyncio.to_thread(companion_service.available_live2d_models)}


# ---- 桌宠随机图片池（A组 3.2：把图片放进 bubble-imgs 目录即生效，无需重启）----
# 目录 = 桌宠数据目录（与 Electron 共享的 Live2D桌宠/）下的 bubble-imgs/。
# 设计与 whale-widget 的"随机图片"对齐：池子里随机抽、不连续重复；权重先不做
# （文件名级元数据没有落点，后续需要时再以 <name>.weight.json 扩展）。
_BUBBLE_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


def _bubble_images_dir() -> Path:
    directory = companion_service.live2d_state_dir() / "bubble-imgs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


@router.get("/bubble-images")
async def companion_bubble_images():
    def _list() -> list[dict[str, object]]:
        root = _bubble_images_dir().resolve()
        items: list[dict[str, object]] = []
        for f in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if not f.is_file() or f.suffix.lower() not in _BUBBLE_IMAGE_EXTENSIONS:
                continue
            stat = f.stat()
            items.append(
                {
                    "name": f.name,
                    "url": f"/api/companion/bubble-images/{quote(f.name)}",
                    "bytes": stat.st_size,
                    "mtime": int(stat.st_mtime),
                }
            )
        return items

    return {"images": await asyncio.to_thread(_list)}


@router.get("/bubble-images/{name}")
async def companion_bubble_image(name: str):
    # 安全校验与 live2d_assets 的 _safe_child 同思路：文件名白名单 + 越界拒绝
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="文件名无效。")
    if Path(name).suffix.lower() not in _BUBBLE_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的图片格式。")
    root = _bubble_images_dir().resolve()
    path = (root / name).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="路径越界。") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="图片不存在。")
    return FileResponse(path)


class BubbleImageUploadRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    data_url: str = Field(min_length=16, max_length=8_000_000)

@router.post("/bubble-images/upload")
async def companion_bubble_image_upload(payload: BubbleImageUploadRequest):
    """泡泡工坊素材上传：data_url 落盘到 bubble-imgs/（5MB 上限，扩展名白名单）。"""
    import base64
    import re

    name = str(payload.name or "").strip()
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="文件名无效。")
    suffix = Path(name).suffix.lower()
    if suffix not in _BUBBLE_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="仅支持 PNG/JPG/GIF/WebP。")
    match = re.match(r"^data:image/(png|jpeg|gif|webp);base64,(.+)$", payload.data_url, re.S)
    if not match:
        raise HTTPException(status_code=400, detail="data_url 必须是 base64 图片。")
    try:
        blob = base64.b64decode(match.group(2), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="base64 解码失败。") from exc
    if len(blob) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="图片不能超过 5MB。")
    root = _bubble_images_dir().resolve()
    target = (root / name).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="路径越界。") from exc
    target.write_bytes(blob)
    return {"ok": True, "name": name, "bytes": len(blob)}


@router.delete("/bubble-images/{name}")
async def companion_bubble_image_delete(name: str):
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="文件名无效。")
    if Path(name).suffix.lower() not in _BUBBLE_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的图片格式。")
    root = _bubble_images_dir().resolve()
    path = (root / name).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="路径越界。") from exc
    if path.is_file():
        path.unlink()
    return {"ok": True}


# ---- 桌宠音效片段素材库（点击音/结束音/提示音可替换为自定义音频）----
# 目录 = 桌宠数据目录下 sounds/；裁剪在管理页前端完成（OfflineAudioContext + WAV 编码），
# 后端只负责"存/列/取/删"，不引入音频处理依赖（无 ffmpeg 要求）。
# 白名单必须与**浏览器解码能力**对齐：试听/裁剪/桌宠播放都走 Web Audio
# decodeAudioData，Chromium 只认这些容器+编码（WMA/APE/AMR/AIFF/MIDI 等解不开）。
_SOUND_EXTENSIONS = {".wav", ".mp3", ".ogg", ".opus", ".m4a", ".aac", ".flac", ".webm"}


def _sounds_dir() -> Path:
    directory = companion_service.live2d_state_dir() / "sounds"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _safe_sound_path(name: str) -> Path:
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="文件名无效。")
    if Path(name).suffix.lower() not in _SOUND_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的音频格式。")
    root = _sounds_dir().resolve()
    path = (root / name).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="路径越界。") from exc
    return path


@router.get("/sounds")
async def companion_sounds():
    def _list() -> list[dict[str, object]]:
        root = _sounds_dir().resolve()
        items: list[dict[str, object]] = []
        for f in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if not f.is_file() or f.suffix.lower() not in _SOUND_EXTENSIONS:
                continue
            stat = f.stat()
            items.append(
                {
                    "name": f.name,
                    "url": f"/api/companion/sounds/{quote(f.name)}",
                    "bytes": stat.st_size,
                    "mtime": int(stat.st_mtime),
                }
            )
        return items

    return {"sounds": await asyncio.to_thread(_list)}


@router.get("/sounds/{name}")
async def companion_sound_file(name: str):
    path = _safe_sound_path(name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="片段不存在。")
    return FileResponse(path)


class SoundUploadRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    data_url: str = Field(min_length=16, max_length=20_000_000)


@router.post("/sounds/upload")
async def companion_sound_upload(payload: SoundUploadRequest):
    """音效片段上传：data_url 落盘到 sounds/（10MB 上限，音频扩展名白名单）。"""
    import base64
    import re

    name = str(payload.name or "").strip()
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="文件名无效。")
    if Path(name).suffix.lower() not in _SOUND_EXTENSIONS:
        raise HTTPException(status_code=400, detail="仅支持 WAV/MP3/OGG/Opus/M4A/AAC/FLAC/WebM（需浏览器可解码）。")
    match = re.match(r"^data:audio/[a-z0-9.+-]+;base64,(.+)$", payload.data_url, re.S)
    if not match:
        raise HTTPException(status_code=400, detail="data_url 必须是 base64 音频。")
    try:
        blob = base64.b64decode(match.group(1), validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="base64 解码失败。") from exc
    if len(blob) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="音频不能超过 10MB。")
    target = _safe_sound_path(name)
    target.write_bytes(blob)
    return {"ok": True, "name": name, "bytes": len(blob)}


@router.delete("/sounds/{name}")
async def companion_sound_delete(name: str):
    path = _safe_sound_path(name)
    if path.is_file():
        path.unlink()
    return {"ok": True}


# ---- Live2D 模型定时自动更换 ----
_model_schedule_task: asyncio.Task | None = None
_model_schedule_lock = asyncio.Lock()
_last_model_switch_day = ""


class Live2dScheduleRequest(BaseModel):
    enabled: bool | None = None
    time: str | None = None  # "HH:MM"
    mode: str | None = None  # random / sequential


def _model_schedule_config() -> dict:
    cfg = companion_service.load_config()
    s = cfg.get("live2d_model_schedule") or {}
    return {
        "enabled": bool(s.get("enabled", False)),
        "time": str(s.get("time") or "09:00"),
        "mode": str(s.get("mode") or "random"),
        "last_switched": str(s.get("last_switched") or ""),
    }


def _pick_next_model(current_id: str, model_ids: list[str], mode: str) -> str:
    if not model_ids:
        return current_id
    if str(mode) == "sequential":
        try:
            idx = model_ids.index(current_id)
        except ValueError:
            idx = -1
        return model_ids[(idx + 1) % len(model_ids)]
    others = [m for m in model_ids if m != current_id]
    pool = others or model_ids
    return random.choice(pool)


async def _model_schedule_loop() -> None:
    global _last_model_switch_day
    while True:
        try:
            cfg = _model_schedule_config()
            today = time.strftime("%Y-%m-%d")
            if (
                cfg["enabled"]
                and cfg["last_switched"] != today
                and time.strftime("%H:%M") >= cfg["time"]
            ):
                models = await companion_live2d_models()
                model_ids = [str(m["id"]) for m in models.get("models", []) if m.get("id")]
                if model_ids:
                    current = str(companion_service.load_config().get("live2d_model_id") or "")
                    if current not in model_ids:
                        current = model_ids[0]
                    next_id = _pick_next_model(current, model_ids, cfg["mode"])
                    if next_id and next_id != current:
                        await asyncio.to_thread(
                            companion_service.save_config,
                            {"live2d_model_id": next_id},
                        )
                    cfg_data = companion_service.load_config()
                    schedule = dict(cfg_data.get("live2d_model_schedule") or {})
                    schedule["last_switched"] = today
                    await asyncio.to_thread(
                        companion_service.save_config,
                        {"live2d_model_schedule": schedule},
                    )
                    _last_model_switch_day = today
                    logger.info("每日定时换模型: %s -> %s", current, next_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("定时换模型任务异常: %s", exc)
        await asyncio.sleep(30)


async def _ensure_model_schedule_task() -> None:
    global _model_schedule_task
    async with _model_schedule_lock:
        if _model_schedule_task is None or _model_schedule_task.done():
            _model_schedule_task = asyncio.create_task(_model_schedule_loop())


@router.get("/live2d/schedule")
async def companion_live2d_schedule_get():
    await _ensure_model_schedule_task()
    return _model_schedule_config()


@router.patch("/live2d/schedule")
async def companion_live2d_schedule_patch(payload: Live2dScheduleRequest):
    cfg = companion_service.load_config()
    schedule = dict(cfg.get("live2d_model_schedule") or {})
    changes = payload.model_dump(exclude_none=True)
    for key, value in changes.items():
        if key == "enabled":
            schedule["enabled"] = bool(value)
        elif key == "time":
            schedule["time"] = str(value)[:5]
        elif key == "mode":
            schedule["mode"] = str(value) if str(value) in {"random", "sequential"} else "random"
    await asyncio.to_thread(
        companion_service.save_config,
        {"live2d_model_schedule": schedule},
    )
    await _ensure_model_schedule_task()
    return _model_schedule_config()


@router.post("/live2d/models/import")
async def companion_live2d_model_import(payload: Live2DModelImportRequest):
    try:
        model = await asyncio.to_thread(
            companion_service.import_live2d_model_directory,
            payload.source_path,
            payload.display_name,
        )
        await asyncio.to_thread(
            companion_service.save_config,
            {"pet_renderer": "live2d", "live2d_model_id": model["id"]},
        )
        if await asyncio.to_thread(companion_service.pet_running):
            await asyncio.to_thread(companion_service.restart_pet)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"saved": True, "model": model, **(await asyncio.to_thread(_status_payload))}


@router.delete("/live2d/models/{model_id}")
async def companion_live2d_model_delete(model_id: str):
    was_running = await asyncio.to_thread(companion_service.pet_running)
    try:
        deleted = await asyncio.to_thread(companion_service.delete_live2d_model, model_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="没有找到这个自定义 Live2D 模型。")
    if was_running:
        await asyncio.to_thread(companion_service.restart_pet)
    return {"deleted": True, **(await asyncio.to_thread(_status_payload))}


@router.get("/live2d/models/{model_id}/assets/{asset_path:path}")
async def companion_live2d_model_asset(model_id: str, asset_path: str):
    """模型文件服务：model3/moc3/纹理/动作 等资源（Live2D 加载器按 model3.json 相对路径解析）。"""
    root = companion_service.live2d_model_root(model_id)
    if root is None:
        raise HTTPException(status_code=404, detail="没有找到这个 Live2D 模型。")
    if not asset_path:
        raise HTTPException(status_code=400, detail="非法资源路径。")
    requested = (root / asset_path).resolve()
    root_resolved = root.resolve()
    if not requested.is_relative_to(root_resolved) or not requested.is_file():
        raise HTTPException(status_code=404, detail="模型资源不存在。")
    suffix = requested.suffix.lower()
    media_type = {
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".moc3": "application/octet-stream",
        ".motion3.json": "application/json",
        ".physics3.json": "application/json",
        ".pose3.json": "application/json",
        ".userdata3.json": "application/json",
        ".cdi3.json": "application/json",
    }.get(suffix, "application/octet-stream")
    return FileResponse(requested, media_type=media_type, headers={"Cache-Control": "no-store"})


@router.get("/live2d/models/{model_id}/preview")
async def companion_live2d_model_preview(model_id: str):
    path = companion_service.live2d_model_preview_path(model_id)
    if path is None:
        raise HTTPException(status_code=404, detail="这个模型没有预览图。")
    media_type = "image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store"})


@router.post("/live2d/models/{model_id}/preview")
async def companion_live2d_model_preview_save(model_id: str, payload: Live2DPreviewRequest):
    try:
        path = await asyncio.to_thread(
            companion_service.save_live2d_model_preview_data_url,
            model_id,
            payload.data_url,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "saved": True,
        "preview_url": f"/api/companion/live2d/models/{model_id}/preview?v={path.stat().st_mtime_ns}",
        **(await asyncio.to_thread(_status_payload)),
    }


@router.post("/live2d/motion/preview")
async def companion_live2d_motion_preview(payload: Live2DMotionPreviewRequest):
    if not pet_event_service.has_desktop_renderer():
        raise HTTPException(status_code=409, detail="请先启动 Live2D 桌宠。")
    event = {"group": payload.group.strip(), "index": payload.index if payload.index is not None else 0}
    _preview_diag_log("motion_preview REQUEST", event)
    pet_event_service.publish("motion_preview", event)
    _preview_diag_log("motion_preview PUBLISHED", event)
    return {"ok": True, **event}


@router.post("/live2d/expression/preview")
async def companion_live2d_expression_preview(payload: Live2DExpressionPreviewRequest):
    if not pet_event_service.has_desktop_renderer():
        raise HTTPException(status_code=409, detail="请先启动 Live2D 桌宠。")
    event = {"expression": payload.expression.strip()}
    _preview_diag_log("expression_preview REQUEST", event)
    pet_event_service.publish("expression_preview", event)
    _preview_diag_log("expression_preview PUBLISHED", event)
    return {"ok": True, **event}


@router.post("/preview-feedback")
async def companion_preview_feedback(payload: dict):
    """桌宠端播放回执（临时诊断：确认预览消息是否到达桌宠并播放）。"""
    _preview_diag_log("PET FEEDBACK", payload)
    return {"ok": True}


_PREVIEW_DIAG_FILE = r"C:\Users\xiao1\Mao\preview_diag.log"


def _preview_diag_log(tag: str, data) -> None:
    try:
        import json as _json
        with open(_PREVIEW_DIAG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{__import__('time').strftime('%H:%M:%S')}] {tag} {_json.dumps(data, ensure_ascii=False)}\n")
    except Exception:  # noqa: BLE001
        pass


@router.post("/app-ready")
async def companion_app_ready():
    return {"ok": True, "released": False}


@router.get("/avatar")
async def companion_avatar():
    path = companion_service.default_avatar_path()
    if path is None:
        raise HTTPException(status_code=404, detail="还没有可用的桌宠头像。")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.get("/sprite/{state}")
async def companion_sprite(state: str):
    path = companion_service.pet_sprite_path(state)
    if path is None:
        raise HTTPException(status_code=404, detail="这个桌宠动作还没有素材。")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.post("/avatar")
async def companion_avatar_save(payload: AvatarRequest):
    try:
        await asyncio.to_thread(companion_service.save_avatar_data_url, payload.data_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if await asyncio.to_thread(companion_service.pet_running):
        await asyncio.to_thread(companion_service.restart_pet)
    return await asyncio.to_thread(_status_payload)


@router.post("/spritesheet")
async def companion_sprite_sheet_save(payload: SpriteSheetRequest):
    try:
        await asyncio.to_thread(companion_service.save_sprite_sheet_data_url, payload.data_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await asyncio.to_thread(_status_payload)


@router.post("/chat")
async def companion_chat(payload: CompanionChatRequest):
    message = payload.message.strip()
    conversation_id = _desktop_pet_conversation_id()
    try:
        claim = claim_request(
            payload.client_request_id,
            request_fingerprint({
                "channel": "companion_chat",
                "conversation_id": conversation_id,
                "message": message,
                "model_id": payload.model_id,
                "reasoning_level": payload.reasoning_level,
                "images": [
                    {"name": item.name, "content_hash": content_fingerprint(item.data_url)}
                    for item in payload.images
                ],
            }),
            conversation_id=conversation_id,
            source="desktop_pet",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not claim.created:
        if claim.status == "succeeded":
            return claim.response
        if claim.status == "failed":
            raise HTTPException(status_code=claim.http_status or 500, detail=claim.error)
        raise HTTPException(status_code=409, detail=pending_error(claim))

    try:
        images = [
            image_attachment_from_data_url(item.data_url, source=item.name)
            for item in payload.images
        ]
    except (RuntimeError, ValueError) as exc:
        detail = normalize_error_detail(
            f"图片无法读取：{exc}",
            code="invalid_chat_image",
            request_id=claim.client_request_id,
        )
        db.fail_chat_request(claim.client_request_id, http_status=400, error=detail)
        raise HTTPException(status_code=400, detail=detail) from exc
    if not message and not images:
        detail = normalize_error_detail(
            "消息或图片不能为空。",
            code="invalid_chat_request",
            request_id=claim.client_request_id,
        )
        db.fail_chat_request(claim.client_request_id, http_status=400, error=detail)
        raise HTTPException(status_code=400, detail=detail)
    config = companion_service.load_config()
    routing_history = list(
        db.get_recent_messages(limit=12, conversation_id=conversation_id)
    )
    screen_follow_up = bool(
        not images
        and screen_observation_service.is_screen_chat_follow_up(message, routing_history)
    )
    requested_model = payload.model_id.strip()
    requested_reasoning = payload.reasoning_level.strip()
    route = None
    try:
        if screen_follow_up:
            result = await screen_observation_service.analyze_screen_chat_follow_up(
                message,
                conversation_id=conversation_id,
                request_id=claim.client_request_id,
                source="desktop_pet",
            )
            selected_model = result.model_id
            selected_reasoning = result.reasoning_level
        else:
            task_profile = build_task_profile(
                message,
                history_rows=routing_history,
                image_count=len(images),
            )
            if not requested_model or requested_model == "auto":
                requested_model = str(config.get("pet_chat_model_id") or "auto").strip() or "auto"
                requested_reasoning = (
                    str(config.get("pet_chat_reasoning_level") or "auto").strip() or "auto"
                )
            if requested_model == "auto":
                route = select_auto_route(
                    message,
                    history_rows=routing_history,
                    image_count=len(images),
                )
                selected_model = route.model_id
                selected_reasoning = route.reasoning_level
            else:
                selected_model = resolve_model_id(requested_model)
                selected_reasoning = requested_reasoning
            use_fast_chat = bool(
                not task_profile.requires_tools
                and task_profile.task_type in {"conversation", "analysis"}
                and not images
            )
            if use_fast_chat and selected_reasoning in {"", "auto", "off", "low"}:
                selected_reasoning = "off"
            result = await chat_with_ai(
                message,
                conversation_id=conversation_id,
                source="desktop_pet",
                image_attachments=images,
                reasoning_level=selected_reasoning,
                model_id=selected_model,
                fallback_model_id=str(getattr(route, "fallback_model_id", "") or ""),
                fallback_reasoning_level=str(getattr(route, "fallback_reasoning_level", "") or ""),
                capture_follow_ups=True,
                request_id=claim.client_request_id,
                agent_tools_enabled=False,
                fast_path=use_fast_chat,
                handoff_enabled=True,
            )
    except ValueError as exc:
        detail = normalize_error_detail(
            str(exc),
            code="invalid_chat_request",
            request_id=claim.client_request_id,
        )
        db.fail_chat_request(claim.client_request_id, http_status=400, error=detail)
        raise HTTPException(status_code=400, detail=detail) from exc
    except ChatRunCancelledError as exc:
        detail = normalize_error_detail(
            f"回复已取消：{exc}",
            code="request_cancelled",
            request_id=claim.client_request_id,
        )
        db.fail_chat_request(claim.client_request_id, http_status=409, error=detail)
        raise HTTPException(status_code=409, detail=detail) from exc
    except ModelRequestError as exc:
        _record_chat_route_failure(
            route,
            source="desktop_pet",
            request_id=claim.client_request_id,
            selected_model_id=selected_model,
            selected_reasoning_level=selected_reasoning,
            error_code="model_request_failed",
        )
        detail = exc.public_detail()
        detail["request_id"] = claim.client_request_id
        db.fail_chat_request(claim.client_request_id, http_status=502, error=detail)
        raise HTTPException(status_code=502, detail=detail) from exc
    except Exception as exc:
        _record_chat_route_failure(
            route,
            source="desktop_pet",
            request_id=claim.client_request_id,
            selected_model_id=selected_model,
            selected_reasoning_level=selected_reasoning,
            error_code="model_request_failed",
        )
        detail = normalize_error_detail(
            f"Mio 暂时没有回复：{exc}",
            code="model_request_failed",
            request_id=claim.client_request_id,
        )
        db.fail_chat_request(claim.client_request_id, http_status=502, error=detail)
        raise HTTPException(status_code=502, detail=detail) from exc
    # Agent 面板的桌宠会话由后端直接触发本机语音，关闭桌宠窗口时也能听到。
    # 桌宠进程的消息轮询会跳过同一 source，避免重复播放。
    voice_attempted = bool(
        result.replies
        and companion_service.load_config().get("voice_enabled", True)
    )
    spoken = False
    voice_delegated = bool(voice_attempted and pet_event_service.has_clients())
    voice_error = ""
    if voice_attempted and not voice_delegated:
        speech_text = "\n".join(result.replies)
        speech_emotion = getattr(result, "speech_emotion", "") or companion_service.infer_speech_emotion(
            speech_text,
            message,
        )
        companion_service.set_pet_activity(
            "speaking",
            emotion=speech_emotion,
            source="desktop_pet",
            ttl_seconds=max(15, min(90, len(speech_text) / 3 + 12)),
        )
        companion_service.set_pet_activity(
            "responding",
            emotion=speech_emotion,
            source="desktop_pet",
            ttl_seconds=5,
        )
    elif voice_delegated:
        speech_text = "\n".join(result.replies)
        speech_emotion = getattr(result, "speech_emotion", "") or companion_service.infer_speech_emotion(
            speech_text,
            message,
        )
        companion_service.set_pet_activity(
            "responding",
            emotion=speech_emotion,
            source="desktop_pet",
            ttl_seconds=max(8, min(45, len(speech_text) / 4 + 8)),
        )
    response = {
        "reply": result.reply,
        "replies": result.replies,
        "voice_attempted": voice_attempted,
        "spoken": spoken,
        "voice_delegated": voice_delegated,
        "voice_error": voice_error,
        "speech_emotion": getattr(result, "speech_emotion", "") or (
            speech_emotion if voice_attempted else ""
        ),
        "request_id": result.request_id,
        "client_request_id": claim.client_request_id,
        "model_id": result.model_id,
        "provider_id": getattr(result, "provider_id", ""),
        "provider_name": getattr(result, "provider_name", ""),
        "provider_model": getattr(result, "provider_model", ""),
        "provider_request_id": getattr(result, "provider_request_id", ""),
        "route": getattr(result, "route", ""),
        "http_status": getattr(result, "http_status", 0),
        "reasoning_level": result.reasoning_level,
        "agent_run_id": getattr(result, "agent_run_id", ""),
        "agent_run_status": getattr(result, "agent_run_status", ""),
        "tool_receipts": list(getattr(result, "tool_receipts", ()) or ()),
        "route_candidate_model_ids": list(getattr(result, "route_candidate_model_ids", ()) or ()),
        "route_escalated_from_model_id": str(getattr(result, "route_escalated_from_model_id", "") or ""),
        "task_handoff": dict(getattr(result, "task_handoff", {}) or {}),
    }
    db.complete_chat_request(claim.client_request_id, response)
    if not screen_follow_up:
        _record_chat_route_success(
            route,
            source="desktop_pet",
            request_id=claim.client_request_id,
            selected_model_id=selected_model,
            selected_reasoning_level=selected_reasoning,
            result=result,
        )
    return response


@router.post("/chat/cancel")
async def cancel_companion_chat(payload: CompanionChatCancelRequest):
    cancelled = await chat_run_coordinator.cancel(
        DESKTOP_PET_CONVERSATION_ID,
        source="desktop_pet",
        reason=f"user_cancelled:{payload.client_request_id or 'unknown'}",
    )
    return {
        "cancelled": cancelled,
        "conversation_id": DESKTOP_PET_CONVERSATION_ID,
        "client_request_id": payload.client_request_id,
    }


@router.post("/call/start")
async def companion_call_start():
    previous = call_session_service.manager.status()
    if previous.get("active"):
        previous_response_id = str(previous.get("current_response_id") or "")
        call_session_service.manager.stop(
            str(previous.get("call_session_id") or ""),
            reason="call_replaced",
        )
        await chat_run_coordinator.cancel(
            DESKTOP_PET_CONVERSATION_ID,
            source="desktop_pet_call",
            reason="call_replaced",
        )
        if previous_response_id:
            pet_event_service.publish(
                "speech_interrupt",
                {"reason": "call_ended", "response_id": previous_response_id},
            )
        await _release_call_resources(str(previous.get("call_session_id") or ""))
    session = call_session_service.manager.start()
    call_session_id = str(session["call_session_id"])
    await asyncio.to_thread(_prepare_call_runtime, call_session_id)
    if not call_session_service.manager.is_active_session(call_session_id):
        raise HTTPException(status_code=409, detail="电话会话在启动期间已被新会话替换。")
    asyncio.create_task(screen_observation_service.analyze_once(force=True))
    asr = await asyncio.to_thread(_ensure_call_asr_ready)
    deadline = time.monotonic() + 25
    while not asr.get("ready") and asr.get("running") and time.monotonic() < deadline:
        await asyncio.sleep(0.1)
        asr = system_audio_service.status()
    if not call_session_service.manager.is_active_session(call_session_id):
        raise HTTPException(status_code=409, detail="电话会话在语音识别加载期间已被新会话替换。")
    if not asr.get("ready"):
        reason = str(asr.get("last_error") or "本地语音识别加载超时")
        if call_session_service.manager.fail_start(call_session_id, reason):
            await _release_call_resources(call_session_id)
        raise HTTPException(status_code=503, detail=f"语音识别启动失败：{reason}")
    call_config = await asyncio.to_thread(companion_service.load_config)
    if not call_session_service.manager.mark_listening(call_session_id):
        raise HTTPException(status_code=409, detail="电话会话在接通前已被替换。")
    return {
        "active": True,
        "call_session_id": call_session_id,
        "next_turn_id": 1,
        "asr": asr,
        "settings": {
            key: call_config[key]
            for key in (
                "pet_call_input_language",
                "pet_call_asr_engine",
                "pet_call_silence_ms",
                "pet_call_voice_threshold",
                "pet_call_min_speech_ms",
                "pet_call_max_turn_seconds",
            )
        },
    }


@router.post("/call/stop")
async def companion_call_stop(payload: CompanionCallControlRequest | None = None):
    current = call_session_service.manager.status()
    requested_session_id = str(payload.call_session_id if payload else "")
    response_id = str(current.get("current_response_id") or "")
    stopped = call_session_service.manager.stop(requested_session_id, reason="call_ended")
    if not stopped:
        return {
            "active": bool(current.get("active")),
            "stopped": False,
            "call_session_id": str(current.get("call_session_id") or ""),
        }
    await chat_run_coordinator.cancel(
        DESKTOP_PET_CONVERSATION_ID,
        source="desktop_pet_call",
        reason="call_ended",
    )
    if response_id:
        pet_event_service.publish(
            "speech_interrupt",
            {"reason": "call_ended", "response_id": response_id},
        )
    await _release_call_resources(str(current.get("call_session_id") or ""))
    return {
        "active": False,
        "stopped": True,
        "call_session_id": str(current.get("call_session_id") or ""),
    }


@router.post("/call/interrupt")
async def companion_call_interrupt(payload: CompanionCallControlRequest | None = None):
    response_id = call_session_service.manager.interrupt(
        str(payload.call_session_id if payload else ""),
        str(payload.response_id if payload else ""),
    )
    if response_id:
        pet_event_service.publish(
            "speech_interrupt",
            {"reason": "user_started_speaking", "response_id": response_id},
        )
    return {"interrupted": bool(response_id), "response_id": response_id}


@router.post("/call/device")
async def companion_call_device(payload: CompanionCallDeviceRequest):
    saved = call_session_service.manager.set_device(
        payload.call_session_id,
        {
            "device_id": payload.device_id,
            "label": payload.label,
            "sample_rate": payload.sample_rate,
            "channel_count": payload.channel_count,
            "echo_cancellation": payload.echo_cancellation,
            "noise_suppression": payload.noise_suppression,
            "auto_gain_control": payload.auto_gain_control,
            "actual_gain": "browser_not_exposed",
        },
    )
    if not saved:
        raise HTTPException(status_code=409, detail="电话会话已经变化，设备信息未写入。")
    return {"saved": True, "call_session_id": payload.call_session_id}


@router.get("/call/status")
async def companion_call_status():
    return call_runtime_status()


@router.post("/call/turn")
async def companion_call_turn(payload: CompanionCallTurnRequest):
    current_call = call_session_service.manager.status()
    if not current_call.get("active"):
        raise HTTPException(status_code=409, detail="电话尚未接通。")
    if payload.call_session_id and payload.call_session_id != current_call.get("call_session_id"):
        raise HTTPException(status_code=409, detail="电话会话已经变化，请忽略这段旧录音。")
    request_started = time.monotonic()
    try:
        wav_content = base64.b64decode(payload.wav_base64, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail="麦克风音频无法读取。") from exc
    if len(wav_content) < 48 or not wav_content.startswith(b"RIFF") or wav_content[8:12] != b"WAVE":
        raise HTTPException(status_code=400, detail="麦克风音频不是有效的 WAV。")
    try:
        turn = call_session_service.manager.begin_turn(payload.call_session_id, payload.turn_id)
    except call_session_service.CallSessionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    asr_started = time.monotonic()
    asr_status = system_audio_service.status()
    if not asr_status.get("ready"):
        await asyncio.to_thread(_ensure_call_asr_ready)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not system_audio_service.status().get("ready"):
            await asyncio.sleep(0.1)
        asr_status = system_audio_service.status()
    # Phone chat is predominantly Chinese. Keep the system-audio observer's
    # language setting independent so short microphone turns cannot drift into
    # unrelated languages when Whisper auto-detection has too little context.
    call_language = payload.language if payload.language in {"zh", "ja"} else "zh"
    transcript_result = await asyncio.to_thread(
        system_audio_service.transcribe_wav_for_quality,
        wav_content,
        language=call_language,
        purpose="phone",
        timeout_seconds=18.0,
    )
    asr_ms = (time.monotonic() - asr_started) * 1000
    try:
        call_session_service.manager.require_current(turn)
    except call_session_service.CallSessionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not transcript_result:
        raise HTTPException(status_code=503, detail="本地语音识别尚未准备好。")
    if transcript_result.get("error"):
        raise HTTPException(status_code=502, detail=f"语音识别失败：{transcript_result['error']}")
    if transcript_result.get("accepted") is False:
        asr_diagnostics = {
            "audio": dict(transcript_result.get("audio") or {}),
            "asr": dict(transcript_result.get("asr") or {}),
        }
        call_session_service.manager.update_turn(
            turn,
            "listening",
            asr=asr_diagnostics,
        )
        return {
            "heard": False,
            "active": True,
            "call_session_id": turn.call_session_id,
            "turn_id": turn.turn_id,
            "response_id": turn.response_id,
            "rejection_reason": str(transcript_result.get("rejection_reason") or "unreliable_transcript"),
            "diagnostics": asr_diagnostics,
            "timings": {"asr_ms": round(asr_ms, 1)},
        }
    transcript = " ".join(str(transcript_result.get("text") or "").split()).strip()
    if not transcript:
        call_session_service.manager.update_turn(turn, "listening")
        return {
            "heard": False,
            "active": True,
            "call_session_id": turn.call_session_id,
            "turn_id": turn.turn_id,
            "response_id": turn.response_id,
            "timings": {"asr_ms": round(asr_ms, 1)},
        }

    echo_reference = call_session_service.manager.echo_reference(turn)
    is_echo, echo_similarity = _is_recent_playback_echo(transcript, echo_reference)
    if is_echo:
        diagnostics = {
            "audio": dict(transcript_result.get("audio") or {}),
            "asr": dict(transcript_result.get("asr") or {}),
            "echo_similarity": echo_similarity,
        }
        call_session_service.manager.update_turn(turn, "listening", asr=diagnostics)
        return {
            "heard": False,
            "active": True,
            "call_session_id": turn.call_session_id,
            "turn_id": turn.turn_id,
            "response_id": turn.response_id,
            "rejection_reason": "playback_echo",
            "diagnostics": diagnostics,
            "timings": {"asr_ms": round(asr_ms, 1)},
        }

    call_session_service.manager.update_turn(
        turn,
        "model",
        transcript=transcript,
        asr={
            "audio": dict(transcript_result.get("audio") or {}),
            "asr": dict(transcript_result.get("asr") or {}),
            "engine": str(transcript_result.get("engine") or asr_status.get("engine") or ""),
            "language": str(transcript_result.get("language") or ""),
        },
    )

    config = companion_service.load_config()
    requested_model = str(config.get("pet_chat_model_id") or "auto").strip() or "auto"
    requested_reasoning = str(config.get("pet_chat_reasoning_level") or "auto").strip() or "auto"
    route = None
    if requested_model == "auto":
        route = select_auto_route(
            transcript,
            history_rows=db.get_recent_messages(limit=12, conversation_id=DESKTOP_PET_CONVERSATION_ID),
            image_count=0,
        )
        selected_model = route.model_id
        selected_reasoning = route.reasoning_level
    else:
        selected_model = resolve_model_id(requested_model)
        selected_reasoning = requested_reasoning
    agent_tools_enabled, selected_reasoning = _phone_turn_policy(
        transcript,
        selected_reasoning,
    )

    model_started = time.monotonic()
    try:
        result = await chat_with_ai(
            transcript,
            conversation_id=DESKTOP_PET_CONVERSATION_ID,
            source="desktop_pet_call",
            reasoning_level=selected_reasoning,
            model_id=selected_model,
            fallback_model_id=str(getattr(route, "fallback_model_id", "") or ""),
            fallback_reasoning_level=str(getattr(route, "fallback_reasoning_level", "") or ""),
            voice_reply_requested=True,
            capture_follow_ups=False,
            extra_system_context=_pet_call_screen_context(),
            request_id=turn.response_id,
            persist=False,
            agent_tools_enabled=agent_tools_enabled,
        )
    except ChatRunCancelledError as exc:
        raise HTTPException(status_code=409, detail=f"电话会话已取消：{exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _record_chat_route_failure(
            route,
            source="desktop_pet_call",
            request_id=turn.response_id,
            selected_model_id=selected_model,
            selected_reasoning_level=selected_reasoning,
            error_code="model_request_failed",
        )
        raise HTTPException(status_code=502, detail=f"Mio 暂时没有回复：{exc}") from exc
    model_ms = (time.monotonic() - model_started) * 1000
    try:
        call_session_service.manager.update_turn(turn, "committing", reply=result.reply)
        call_session_service.manager.commit_if_current(
            turn,
            lambda: persist_generated_chat_result(
                transcript,
                result,
                conversation_id=DESKTOP_PET_CONVERSATION_ID,
                source="desktop_pet_call",
                voice_reply_requested=True,
            ),
        )
    except call_session_service.CallSessionConflict as exc:
        abandon_deferred_final_response(
            str(getattr(result, "agent_run_id", "") or ""),
            error="电话会话已结束，暂存回复未提交。",
        )
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    _record_chat_route_success(
        route,
        source="desktop_pet_call",
        request_id=turn.response_id,
        selected_model_id=selected_model,
        selected_reasoning_level=selected_reasoning,
        result=result,
    )
    return {
        "active": True,
        "heard": True,
        "call_session_id": turn.call_session_id,
        "turn_id": turn.turn_id,
        "response_id": turn.response_id,
        "voice_state": "awaiting_voice",
        "transcript": transcript,
        "reply": result.reply,
        "replies": result.replies,
        "request_id": result.request_id,
        "model_id": result.model_id,
        "reasoning_level": result.reasoning_level,
        "timings": {
            "asr_ms": round(asr_ms, 1),
            "model_ms": round(model_ms, 1),
            "model_first_token_ms": result.first_token_latency_ms,
            "server_total_ms": round((time.monotonic() - request_started) * 1000, 1),
        },
    }


@router.get("/chat/history")
async def companion_chat_history(limit: int = Query(default=120, ge=1, le=500)):
    conversation_id = _desktop_pet_conversation_id()
    rows = db.get_recent_messages(limit=limit, conversation_id=conversation_id)
    return {
        "conversation_id": conversation_id,
        "messages": [
            {
                "id": int(row["id"]),
                "role": str(row["role"] or ""),
                "content": str(row["content"] or ""),
                "source": str(row["source"] or ""),
                "created_at": str(row["created_at"] or ""),
                "request_id": str(row["request_id"] or ""),
                "model_id": str(row["model_id"] or ""),
                "provider_model": str(row["provider_model"] or ""),
                "reasoning_level": str(row["reasoning_level"] or ""),
            }
            for row in rows
        ],
    }



@router.patch("/position")
async def companion_position(payload: CompanionPositionRequest):
    await asyncio.to_thread(companion_service.save_pet_position, payload.x, payload.y)
    return await asyncio.to_thread(_status_payload)


@router.patch("/size")
async def companion_size(payload: CompanionSizeRequest):
    await asyncio.to_thread(companion_service.save_pet_size, payload.percent)
    return await asyncio.to_thread(_status_payload)


@router.get("/feed")
async def companion_feed(after_id: int | None = Query(default=None, ge=0)):
    conversation_id = _desktop_pet_conversation_id()
    latest = db.get_latest_message_id(role="assistant", conversation_id=conversation_id)
    if after_id is None:
        return {"latest_id": latest, "conversation_id": conversation_id, "messages": []}
    rows = db.get_messages_after_id(
        after_id,
        role="assistant",
        limit=20,
        conversation_id=conversation_id,
    )
    return {
        "latest_id": int(rows[-1]["id"]) if rows else latest,
        "conversation_id": conversation_id,
        "messages": [
            {
                "id": int(row["id"]),
                "content": str(row["content"] or ""),
                "source": str(row["source"] or ""),
                "created_at": str(row["created_at"] or ""),
                "request_id": str(row["request_id"] or ""),
                "emotion": str(
                    row["emotion"]
                    or companion_service.speech_emotion_info(str(row["content"] or ""))["id"]
                ),
            }
            for row in rows
        ],
    }


@router.get("/windows")
async def companion_windows():
    try:
        return await asyncio.to_thread(companion_service.window_observer.list_windows)
    except (OSError, RuntimeError, TimeoutError) as exc:
        raise HTTPException(status_code=500, detail=f"读取窗口列表失败：{exc}") from exc


@router.post("/game/select")
async def companion_game_select(payload: GameWindowRequest):
    try:
        await asyncio.to_thread(local_vision_service.unload_model)
        return await asyncio.to_thread(companion_service.game_observer.select, payload.hwnd)
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/window/select")
async def companion_window_select(payload: GameWindowRequest):
    try:
        return await asyncio.to_thread(companion_service.window_observer.select, payload.hwnd)
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/game/capture")
async def companion_game_capture():
    try:
        return await asyncio.to_thread(companion_service.game_observer.capture)
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/window/capture")
async def companion_window_capture():
    try:
        return await asyncio.to_thread(companion_service.window_observer.capture)
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/game/start")
async def companion_game_start(payload: WindowObservationRequest):
    try:
        await asyncio.to_thread(local_vision_service.unload_model)
        status = companion_service.game_observer.status()
        return await asyncio.to_thread(
            _start_observation_runtime,
            interval_ms=payload.interval_ms,
            capture_only=payload.capture_only,
            hwnd=int(status.get("hwnd") or 0),
        )
    except ValueError as exc:
        screen_observation_service.set_capture_only(False)
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/window/start")
async def companion_window_start(payload: WindowObservationRequest):
    try:
        status = companion_service.window_observer.status()
        return await asyncio.to_thread(
            _start_observation_runtime,
            interval_ms=payload.interval_ms,
            capture_only=payload.capture_only,
            hwnd=int(status.get("hwnd") or 0),
        )
    except ValueError as exc:
        screen_observation_service.set_capture_only(False)
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/game/stop")
async def companion_game_stop():
    result = await asyncio.to_thread(_stop_observation_runtime)
    await asyncio.to_thread(local_vision_service.unload_model)
    return result


@router.post("/window/stop")
async def companion_window_stop():
    result = await asyncio.to_thread(_stop_observation_runtime)
    await asyncio.to_thread(local_vision_service.unload_model)
    return result


@router.get("/game/preview")
async def companion_game_preview():
    return _preview_response("还没有画面预览。")


@router.post("/game/analyze")
async def companion_game_analyze():
    status = companion_service.game_observer.status()
    if status.get("mode") != "window" or not status.get("hwnd"):
        raise HTTPException(status_code=400, detail="请先选择要观察的游戏窗口。")
    was_running = bool(status.get("running"))
    try:
        replied = await screen_observation_service.analyze_once(force=True)
    finally:
        if not was_running:
            await asyncio.to_thread(companion_service.game_observer.stop)
            await asyncio.to_thread(screen_observation_service.end_session)
    return {"replied": replied, "analysis": await asyncio.to_thread(screen_observation_service.status)}


@router.get("/window/preview")
async def companion_window_preview():
    return _preview_response("还没有窗口画面预览。")


@router.post("/screen/start")
async def companion_screen_start(payload: ScreenObservationRequest):
    try:
        if not payload.capture_only:
            route = str(companion_service.load_config().get("screen_vision_route") or "local")
            if route == "local":
                await local_vision_service.ensure_ready()
            else:
                await asyncio.to_thread(local_vision_service.unload_model)
        return await asyncio.to_thread(
            _start_observation_runtime,
            interval_ms=payload.interval_ms,
            capture_only=payload.capture_only,
            screen_scope=payload.scope,
        )
    except (ValueError, RuntimeError, OSError) as exc:
        screen_observation_service.set_capture_only(False)
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/screen/capture")
async def companion_screen_capture(payload: ScreenObservationRequest):
    try:
        return await asyncio.to_thread(companion_service.window_observer.select_screen, payload.scope)
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/screen/analyze")
async def companion_screen_analyze(payload: ScreenObservationRequest):
    was_running = bool(companion_service.window_observer.status().get("running"))
    previous_capture_only = bool(
        (await asyncio.to_thread(screen_observation_service.status)).get("capture_only")
    )
    try:
        if not bool(companion_service.load_config().get("screen_ai_enabled", True)) and not payload.capture_only:
            raise HTTPException(status_code=409, detail="屏幕 AI 已关闭；请先在桌宠设置中启用后再分析。")
        if not payload.capture_only:
            route = str(companion_service.load_config().get("screen_vision_route") or "local")
            if route == "local":
                await local_vision_service.ensure_ready()
            else:
                await asyncio.to_thread(local_vision_service.unload_model)
        await asyncio.to_thread(screen_observation_service.set_capture_only, payload.capture_only)
        await asyncio.to_thread(companion_service.window_observer.select_screen, payload.scope)
        replied = await screen_observation_service.analyze_once(force=True)
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if not was_running:
            await asyncio.to_thread(companion_service.window_observer.stop)
            await asyncio.to_thread(screen_observation_service.end_session)
        else:
            await asyncio.to_thread(screen_observation_service.set_capture_only, previous_capture_only)
    return {"replied": replied, "analysis": await asyncio.to_thread(screen_observation_service.status)}


@router.post("/screen/stop")
async def companion_screen_stop():
    result = await asyncio.to_thread(_stop_observation_runtime)
    await asyncio.to_thread(local_vision_service.unload_model)
    return result


@router.get("/screen/preview")
async def companion_screen_preview():
    return _preview_response("还没有屏幕画面预览。")


class ScreenShotRequest(BaseModel):
    bbox: list[int] | None = None  # [x, y, w, h] 虚拟桌面绝对坐标


@router.post("/screen-shot")
async def companion_screen_shot(payload: ScreenShotRequest | None = None):
    """全屏截图（JPEG base64）；bbox 存在时截取指定区域。返回虚拟桌面完整尺寸供坐标映射。"""
    import io

    from ..screen.screen_capture import MssCapture

    def _shot(bbox: list[int] | None) -> tuple[str, int, int]:
        cap = MssCapture()
        img = cap.capture(all_screens=True).convert("RGB")
        full_w, full_h = img.size
        if bbox and len(bbox) == 4:
            x, y, w, h = (int(v) for v in bbox)
            if w > 0 and h > 0:
                img = img.crop((x, y, x + w, y + h))
        img.thumbnail((1920, 1080))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=88)
        return base64.b64encode(buf.getvalue()).decode(), full_w, full_h

    try:
        bbox = (payload or ScreenShotRequest()).bbox
        image_base64, full_w, full_h = await asyncio.to_thread(_shot, bbox)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"截图失败: {exc}") from exc
    return {"ok": True, "image_base64": image_base64, "width": full_w, "height": full_h, "bbox": bbox}


@router.post("/local-vision/runtime/{action}")
async def companion_local_vision_runtime(action: str):
    handlers = {
        "start": local_vision_service.start_server,
        "stop": local_vision_service.stop_server,
        "restart": local_vision_service.restart_server,
        "unload": local_vision_service.unload_model,
    }
    handler = handlers.get(action)
    if handler is None:
        raise HTTPException(status_code=404, detail="不支持的本地视觉操作。")
    try:
        return await asyncio.to_thread(handler)
    except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/local-vision/model/pull")
async def companion_local_vision_model_pull():
    try:
        return await asyncio.to_thread(local_vision_service.start_model_pull)
    except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
