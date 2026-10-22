from __future__ import annotations

import asyncio
import json
import base64
from difflib import SequenceMatcher
import logging
import os
import random
import re
import subprocess
import uuid
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
from ..cloud_feiyu import get_client as get_feiyu_client
from ..cloud_feiyu.client import attachment_media_kind, strip_device_prefix, strip_tool_payload
from ..cloud_feiyu.device import build_device_context
from ..config import settings
from ..llm import ModelRequestError, resolve_model_id
from ..image_service import image_attachment_from_data_url


router = APIRouter(prefix="/api/companion")
DESKTOP_PET_CONVERSATION_ID = "desktop_pet"

# 云端大肥鱼（鲸鱼娘）在桌宠气泡 / 横条上的**专属身份色**。
# 深蓝（鲸鱼蓝），与 DSH 的靛蓝 #4F6BED、Mio 本体默认青蓝都不同，
# 一眼就能分清"这句是谁说的"。前端渲染层不硬编码任何身份，只吃这个 accent。
FEIYU_BUBBLE_ACCENT = "#2B6CB0"
FEIYU_AGENT_ID = "cloud_feiyu"
FEIYU_AGENT_NAME = "大肥鱼"


def _register_feiyu_agent() -> None:
    """把云端大肥鱼注册进跨 Agent 总线，让她的气泡/徽标拿到**专属身份色**。

    为什么必须注册而不是只在 payload 里塞 accent：
      · 渲染端 `applyBubbleAgentAccent()` 的取值顺序是 payload.accent > 插件注册表；
        但**徽标**（agent-badge）和 `/api/companion/agents` 快照只认总线里的 accent。
      · DSH 插件当初也踩过同样的坑（没注册 → 气泡不变蓝），注释写在 dsh_adapter.py:972。
    幂等：总线 register 对已存在的 agent 只会更新字段，重复调用安全。
    """
    try:
        from ..kernel import agent_bus_service
        agent_bus_service.register(
            FEIYU_AGENT_ID,
            FEIYU_AGENT_NAME,
            "cloud_feiyu",
            capabilities={"voice": True, "text": True, "screen": False, "mcp": False, "observe": False},
            accent=FEIYU_BUBBLE_ACCENT,
        )
    except Exception:  # 总线不可用不该影响聊天
        pass


_register_feiyu_agent()
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
    # 任务状态（phase）→ 表现绑定：{模型id: {phase: {motion: 槽名, expression: 槽名}}}
    live2d_phase_slots: dict[str, dict[str, dict[str, str]]] = Field(default_factory=dict)
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
    # ★ 桌宠交互打磨（2026-10-17 对标 dsh-pet-indesktop）：不透明度 / 锁定位置 / SHIFT 拖动 / 拖拽惯性
    live2d_pet_opacity: int = Field(default=100, ge=10, le=100)
    live2d_pet_locked: bool = False
    live2d_pet_shift_drag: bool = False
    live2d_pet_inertia: bool = True
    # ★ DSH 面板 12 态自定义颜色（2026-10-17）：{phase: '#rrggbb'}。
    #   存后端而非 localStorage——管理窗每次创建会 clearStorageData()，localStorage 不持久。
    live2d_phase_colors: dict = Field(default_factory=dict)
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
    pet_idle_beat_enabled: bool = True
    pet_idle_beat_min_seconds: int = Field(default=30, ge=8, le=1800)
    pet_idle_beat_max_seconds: int = Field(default=90, ge=8, le=3600)
    pet_quotes_enabled: bool = True
    pet_talkativeness: int = Field(default=45, ge=0, le=100)
    # ★ L3-c 连点彩蛋（2026-10-19）：短时间内反复戳桌宠 → 分级嫌弃/装死。
    #   关掉即退回"每次点击都是害羞+随机一句"的老行为。
    pet_poke_enabled: bool = True
    ui_theme: str = ''
    # ★ 自定义主题三色（ui_theme === 'custom' 时生效；configuration.py 做 #rrggbb 校验）
    ui_theme_custom_bg: str = ''
    ui_theme_custom_accent: str = ''
    ui_theme_custom_ink: str = ''
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


class Live2DPhasePreviewRequest(BaseModel):
    phase: str = Field(min_length=1, max_length=60)


# B3 试演 nonce：每次试演 +1，桌宠端用它区分"同一相位的重播请求"
_phase_preview_nonce = 0


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


def _parse_attachments_json(raw: str) -> list[dict[str, Any]]:
    """把库里存的 attachments_json 解析成前端能直接渲染的附件数组。

    存的形状（落库时写入）：`[{"media","kind","url","display","filename","mime_type","size"}]`
    老数据可能是 `[{"kind","name"}]`（没有 url）—— 这种没有地址，渲染不出图，
    直接过滤掉，避免前端显示"加载失败的破图占位"。
    """
    try:
        parsed = json.loads(raw or "[]")
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    out: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "")
        display = str(item.get("display") or item.get("name") or item.get("filename") or "")
        # 没有 url 的老数据无法渲染，跳过
        if not url:
            continue
        media = str(item.get("media") or item.get("kind") or "")
        out.append({
            "media": media,
            "kind": media,
            "url": url,
            "display": display,
            "filename": str(item.get("filename") or ""),
            "mime_type": str(item.get("mime_type") or ""),
            "size": int(item.get("size") or 0),
        })
    return out


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


def _easter_eggs_dir() -> Path:
    """彩蛋图目录（随仓库分发，不是运行时目录）。

    ★ 2026-10-18 彩蛋功能：放这里的图**不进管理界面**，只参与桌宠点击时的随机抽取。
    路径固定在 `澪Agent应用/dist/live2d-pet/easter-eggs/`（与本 backend 是兄弟目录），随 git 入库。

    层级：companion.py → routes → app → backend → 私人AI日记系统 → 仓库根
           parents[0]   parents[1] parents[2] parents[3]  parents[4]
    所以仓库根 = parents[4]，不是 parents[3]（这里踩过一次，实测才确认）。
    """
    repo_root = Path(__file__).resolve().parents[4]
    return repo_root / "澪Agent应用" / "dist" / "live2d-pet" / "easter-eggs"


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
        # ★ 彩蛋池：与用户图池合并返回，但带 hidden=true ——
        #   管理界面（bubble-panel-inject.js）跳过 hidden 项，桌宠随机抽图照常参与。
        #   这样两边共用一个接口，不需要新增查询参数或第二个端点。
        eggs = _easter_eggs_dir()
        if eggs.is_dir():
            for f in sorted(eggs.iterdir(), key=lambda p: p.name.lower()):
                if not f.is_file() or f.suffix.lower() not in _BUBBLE_IMAGE_EXTENSIONS:
                    continue
                stat = f.stat()
                items.append(
                    {
                        "name": f.name,
                        "url": f"/api/companion/easter-eggs/{quote(f.name)}",
                        "bytes": stat.st_size,
                        "mtime": int(stat.st_mtime),
                        "hidden": True,
                        "easter": True,
                    }
                )
        return items

    return {"images": await asyncio.to_thread(_list)}


@router.get("/easter-eggs/{name}")
async def companion_easter_egg(name: str):
    """彩蛋图本体（只在随机抽中时被桌宠请求，管理界面不会碰）。"""
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="文件名无效。")
    if Path(name).suffix.lower() not in _BUBBLE_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的图片格式。")
    root = _easter_eggs_dir().resolve()
    path = (root / name).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="路径越界。") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="图片不存在。")
    return FileResponse(path)


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


# ---- Agent 音频（点歌 / 语音）落盘与回传 ----
# 为什么不把音频塞进 WS：WebSocket 单帧上限 1MB（实测 11MB 的 base64 歌直接把连接
# 以 1009 message too big 踢掉）。所以音频一律落盘 → WS 只推短 URL →
# 渲染端用 HTTP 拉（还能 Range 拖动进度）。
_AGENT_MEDIA_MAX_BYTES = 24 * 1024 * 1024
_AGENT_MEDIA_KEEP = 24          # 只保留最近 N 个，避免无限堆积
_AGENT_MEDIA_EXT = {
    ".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac", ".webm",       # 音频
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",                          # 图片
}


def _agent_media_dir() -> Path:
    directory = companion_service.live2d_state_dir() / "agent_media"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _safe_agent_media_path(name: str) -> Path:
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="文件名无效。")
    if Path(name).suffix.lower() not in _AGENT_MEDIA_EXT:
        raise HTTPException(status_code=400, detail="不支持的媒体格式。")
    root = _agent_media_dir().resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root):
        raise HTTPException(status_code=400, detail="文件名无效。")
    return path


_IMAGE_MIME_TO_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
    "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
}


def _save_agent_media(item: dict[str, Any], media_kind: str) -> dict[str, Any] | None:
    """把一条附件（图片/音频，带 data: URL）落盘，返回可回传给前端的短 URL 元信息。

    为什么音频和图片都要落盘（2026-10-22 实测）：
      云端表情包 3.6MB → base64 后 **14.2MB** 一帧；歌曲 10.6MB → 更大。
      WebSocket 单帧上限 1MB，这种帧会把连接直接 1009 掉线（连聊天一起断）。
      落盘 + HTTP URL 还能让 <audio> 支持 Range 拖动进度。
    """
    import base64
    import hashlib

    data_url = str(item.get("data_url") or "")
    if not data_url.startswith("data:"):
        return None
    header, _, payload = data_url.partition(",")
    if not payload:
        return None
    mime = header[5:].split(";")[0] or ("image/png" if media_kind == "image" else "audio/mpeg")
    try:
        blob = base64.b64decode(payload, validate=False)
    except Exception:
        return None
    if not blob or len(blob) > _AGENT_MEDIA_MAX_BYTES:
        return None

    display = str(item.get("display") or item.get("filename") or "").strip()
    if not display:
        display = "图片" if media_kind == "image" else "音频"
    ext = Path(display).suffix.lower()
    if ext not in _AGENT_MEDIA_EXT:
        ext = _IMAGE_MIME_TO_EXT.get(mime) if media_kind == "image" else None
        if not ext or ext not in _AGENT_MEDIA_EXT:
            ext = ".png" if media_kind == "image" else ".mp3"
    # 用内容哈希做文件名：同一首歌/同一张图重复发不会重复落盘，也避免中文名做路径参数。
    # （2026-10-22 曾一度加过唯一后缀，因为误解题意成了"要能连发同一张图"；
    #   实际需求是"云端表情库能重复选同一张"，与落盘去重无关 —— 已改回。）
    digest = hashlib.sha256(blob).hexdigest()[:16]
    safe_name = f"{digest}{ext}"
    target = _agent_media_dir() / safe_name
    try:
        if not target.is_file() or target.stat().st_size != len(blob):
            target.write_bytes(blob)
    except OSError:
        # 落盘失败不影响这一轮（前端拿不到图而已），不要让整条回复 500
        pass
    try:
        files = sorted(_agent_media_dir().glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
        for stale in files[_AGENT_MEDIA_KEEP:]:
            stale.unlink(missing_ok=True)
    except Exception:
        pass
    return {
        "url": f"/api/companion/agent-media/{quote(safe_name)}",
        "filename": safe_name,
        "display": display,
        "mime_type": mime,
        "size": len(blob),
    }


@router.get("/agent-media/{name}")
async def companion_agent_media(name: str):
    """Agent 发来的图片/音频文件（渲染端 <img>/<audio> 直接拉这个 URL，支持 Range）。"""
    path = _safe_agent_media_path(name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="媒体不存在。")
    return FileResponse(path)


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


@router.post("/live2d/phase/preview")
async def companion_live2d_phase_preview(payload: Live2DPhasePreviewRequest):
    """★ B3 任务状态联动试演（2026-10-19）：管理页点「试演」→ 合成一条 agent_phase
    走既有 WS 广播，桌宠端 applyAgentPhase 原样消费（动作/表情/徽标/音效全链路真实联动）。
    agent_id 固定 'phase-preview'、nonce 逐次递增——桌宠端 faceKey 含 nonce，
    连点同一状态也会重播表现（否则同相位重发会被去抖吞掉）。"""
    global _phase_preview_nonce
    if not pet_event_service.has_desktop_renderer():
        raise HTTPException(status_code=409, detail="请先启动 Live2D 桌宠。")
    _phase_preview_nonce += 1
    event = {
        "agent_id": "phase-preview",
        "agent_name": "试演",
        "phase": payload.phase.strip(),
        "active": True,
        "nonce": _phase_preview_nonce,
    }
    _preview_diag_log("phase_preview REQUEST", event)
    pet_event_service.publish("agent_phase", event)
    _preview_diag_log("phase_preview PUBLISHED", event)
    return {"ok": True, **event}


@router.post("/preview-feedback")
async def companion_preview_feedback(payload: dict):
    """桌宠端播放回执（临时诊断：确认预览消息是否到达桌宠并播放）。"""
    _preview_diag_log("PET FEEDBACK", payload)
    return {"ok": True}


from ..config import settings as _settings

# 预览链路诊断日志（临时诊断：确认预览消息是否到达桌宠并播放）。
# ★ 独立性（2026-10-19）：原值硬编码为上游 Mao 仓库的绝对路径
#   （C:\Users\xiao1\Mao\preview_diag.log），换机器/单独 clone 后该目录不存在，
#   且会把诊断写进**别的仓库**。改为项目根相对路径 + 环境变量覆盖。
_PREVIEW_DIAG_FILE = os.getenv("MIO_PREVIEW_DIAG_FILE", "").strip() or str(
    Path(_settings.project_root) / "preview_diag.log"
)


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
    # 多模态回执（只有 cloud_feiyu 分支会填）：
    #   attached_meta   结构化附件元信息（给前端判断类型/占位）
    #   collected_images 图片的真实 data: URL（给前端直接渲染）
    # 在函数入口初始化，保证任何分支走到 response 组装处都一定有这两个名字。
    attached_meta: list[dict] = []
    collected_images: list[str] = []
    # 气泡需要"文字 + 图片"按顺序呈现：这里按收到顺序记 (kind, data)，
    # 流结束后用一条 agent_bubble 事件交给桌宠渲染端（agent_bubble 只认文本，
    # 图片另走 agent_image；两者都由前端按同一 response_id 归到同一条气泡）。
    collected_bubble_items: list[tuple[str, str]] = []
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
                # 云端大肥鱼直通模式：跳过 resolve，直接用
                if requested_model == "cloud_feiyu":
                    selected_model = "cloud_feiyu"
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

            # 云端大肥鱼直通模式：不走本地 LLM，直接调 AstrBot Open API
            if selected_model == "cloud_feiyu":
                selected_reasoning = "off"
                feiyu = get_feiyu_client()
                # ⚠ 不要在这里打印 api_key（哪怕只打前几位）：
                #   以前有一行 `logger.warning(f"[DEBUG] feiyu api_key: {feiyu.api_key[:20]}...")`，
                #   每轮对话都把密钥前缀写进日志文件（实测已被写入）。日志会被收集/上报，
                #   等于把凭据泄漏到文件系统之外。这里只记录"有没有配"。
                if not feiyu.is_configured:
                    raise RuntimeError("云端大肥鱼未配置：请在 .env 里设置 ASTRBOT_API_KEY（不要写进源码）")
                # 注入设备上下文，让大肥鱼知道自己在桌宠上
                device_ctx = build_device_context()
                # 加设备前缀，让大肥鱼能分清当前是哪个设备在说话
                #
                # ★ 2026-10-22：设备上下文**只进上下文、不进气泡**（用户诉求：「气泡里不要出现我的提问」）。
                #   现实问题：同一会话里每条消息都带一长串 `[电脑桌宠] [设备上下文] 当前你在桌宠设备上…`，
                #   她偶尔会把这串前缀"复述"出来，看着就像把用户的话又念了一遍。
                #   处理：
                #     1) 前缀缩短，只保留识别设备所需的最少信息（能力清单挪到 system 侧，不每轮重复）；
                #     2) 万一她真的复述了，出气泡前用 strip_device_prefix 把整段剥掉。
                full_message = f"[电脑桌宠] {device_ctx}\n\n用户说：{message}"
                # 把图片转成 data URL 列表传给大肥鱼
                # ── 出站多模态：图片必须先上传换 attachment_id ──
                # AstrBot 的 message 字段收的是**消息段数组**（{"type":"image","attachment_id":..}），
                # 不接受 data URL。旧实现把 data URL 塞进 `images=`，而 client 的 _build_payload
                # 当时根本没把它写进请求体 → 桌面端发的图**从来没到过云端**。这里补上传环节。
                feiyu_attachment_ids: list[str] = []
                feiyu_upload_errors: list[str] = []
                for img in images:
                    data_url = getattr(img, "data_url", "") or ""
                    if not data_url:
                        continue
                    try:
                        feiyu_attachment_ids.append(
                            await feiyu.upload_attachment(
                                data_url,
                                filename=getattr(img, "name", "") or "image.png",
                            )
                        )
                    except Exception as exc:  # 单张图失败不阻断整轮对话
                        feiyu_upload_errors.append(str(exc))
                if feiyu_upload_errors:
                    logger.warning("[feiyu] 图片上传失败 %d 张：%s", len(feiyu_upload_errors), feiyu_upload_errors[0])

                # 流式接收：边收边推 WS 到桌宠气泡（和 DSH 横条分开）
                # 注意：collected_images / attached_meta 用**函数入口已初始化**的那两个，
                # 这里不再重复 `x: list = []`，否则会遮蔽外层变量导致回执永远是空列表。
                from ..companion import pet_event_service
                stream_side: dict = {}
                collected: list[str] = []
                async for chunk, imgs in feiyu.chat_stream_full(
                    full_message,
                    session_id=feiyu.session_id,
                    images=feiyu_attachment_ids or None,
                    session_out=stream_side,
                ):
                    if chunk:
                        collected.append(chunk)
                        # 保留 agent_stream：DSH 横条那条通路仍可复用（不回归）。
                        pet_event_service.publish("agent_stream", {
                            "text": chunk,
                            "agent_id": "cloud_feiyu",
                            "accent": FEIYU_BUBBLE_ACCENT,
                        })
                    if imgs:
                        # ★ 这里 imgs 是**真实图片字节的 data: URL**（客户端按 [IMAGE]xxx.png
                        #   占位符去 /api/v1/files/content 下载回来的）。
                        #
                        # ⚠️ 2026-10-22 移除了一段**旧的分支**，它在这里直接 `publish("agent_image",
                        #   {"url": img_url})` 把 base64 推给渲染端。两个严重后果：
                        #     ① 一张 3.6MB 的图 base64 后 ~14MB，**超过 WS 1MB 单帧上限**，
                        #        直接把连接踢掉（sent 1009 message too big，实测过一次）；
                        #     ② 同一张图会被推**两次** —— 一次是这里的 base64（没有 response_id），
                        #        一次是下面落盘后的短 URL → 前端看到"图片反复出现"（用户实拍）。
                        #   正确做法：图片只走下面"落盘 → 短 URL"那一条通道。
                        #   这里只保留 collected_images（HTTP 响应里给前端的 data URL）供气泡回落用。
                        collected_images.extend(imgs)
                        collected_bubble_items.extend(("image", url) for url in imgs)
                attached_meta = list(stream_side.get("attachments") or [])

                feiyu_content = "".join(collected)
                # ★ 流式期间推给气泡的是**逐 token 原文**，英文思考也一起推过去了。
                #   client 在收尾时做了行级清洗（strip_reasoning_prefix），并用
                #   session_out["text"] 给出干净全文。这里以干净全文为准。
                cleaned_stream = str(stream_side.get("text") or "")
                if cleaned_stream:
                    feiyu_content = cleaned_stream
                # 解析表情标记
                feiyu_emotion = ""
                for m in re.finditer(r"&&(\w+)&&", feiyu_content):
                    feiyu_emotion = m.group(1)
                    break
                clean_content = re.sub(r"&&\w+&&", "", feiyu_content).strip()
                # 去掉 ⟦MODE:xxx⟧ 这类标记
                clean_content = re.sub(r"⟦[^⟧]*⟧", "", clean_content).strip()
                # 去掉开头的英文思考过程/指令（直到遇到中文为止）
                lines = clean_content.split("\n")
                while lines:
                    first = lines[0].strip()
                    # 如果第一行是空的，跳过
                    if not first:
                        lines.pop(0)
                        continue
                    # 如果第一行包含中文，就停
                    if re.search(r"[\u4e00-\u9fff]", first):
                        break
                    # 否则删掉这行
                    lines.pop(0)
                clean_content = "\n".join(lines).strip()
                # ★ 工具调用载荷清理（2026-10-22）：她调工具那一轮，complete.data 会把
                #   {"id":"call_…","name":"send_message_to_user","args":{…}} 和回执直接混进正文。
                #   client 层已剥过一次，这里对**最终正文**再兜一次（两条落库/展示路径都要干净）。
                clean_content = strip_tool_payload(clean_content).strip()

                # ★★ 让大肥鱼的话真正出现在**桌宠气泡**里（2026-10-22 用户反馈"气泡显示不出文字和图片"）。
                #
                # 之前为什么是空的：渲染端把 `agent_stream` 定向到 **横条 #pet-strip**（用户 10-17 裁决：
                # 流式正文走横条），而这条链只发 agent_stream → 气泡永远收不到正文；
                # `agent_image` 又被前端 `showImageInBubble()` 当"点击互动的随机图"处理，3 秒后自动消失。
                # 现在改成发 `agent_bubble`（气泡专用通路）：
                #   · 文字整段进气泡（适合一句话对白，不需要逐字铺开）；
                #   · 图片用 agent_image，但带上 accent + response_id，按"大肥鱼自己的图"处理；
                #   · agent_stream 仍然保留，横条那条通路不受影响。
                bubble_text = strip_device_prefix(clean_content.strip())
                # 点歌/语音回来的是音频附件（AstrBot 点歌发 `[FILE]xxx.mp3`）。
                # ★ 图片和音频**都不走 WS 内联**（2026-10-22 实测）：
                #   云端表情包 3.6MB → base64 后 14.2MB 一帧；歌曲 10.6MB → 更大。
                #   WebSocket 单帧上限 1MB，这种帧会把连接直接 1009 掉线（连聊天一起断）。
                #   所以先落盘到 pet 状态目录下的 agent_media/，WS 只推短 URL，
                #   渲染端用 <img>/<audio> 走 HTTP 拉（音频还支持 Range 拖动进度）。
                raw_items = list(stream_side.get("_raw_attachments", []))
                saved_images: list[dict[str, Any]] = []
                songs: list[dict[str, Any]] = []
                for item in raw_items:
                    if item.error or not item.data_url:
                        continue
                    kind = attachment_media_kind(item.kind, item.mime_type, item.filename)
                    if kind not in ("image", "audio"):
                        continue
                    saved = await asyncio.to_thread(
                        _save_agent_media,
                        {
                            "data_url": item.data_url,
                            "display": item.display,
                            "filename": item.filename,
                            "mime_type": item.mime_type,
                        },
                        kind,
                    )
                    if not saved:
                        continue
                    if kind == "image":
                        saved_images.append(saved)
                    else:
                        songs.append(saved)
                # ★ 把落盘后的 URL **合并回 attached_meta**（2026-10-22 修）。
                #   之前只把 URL 放进了 saved_images、推给 WS 用，而 HTTP 响应的
                #   `attachments` 仍然是 client 那份**没有 url 的元信息**（data_url 还是空串）
                #   → 前端既拿不到图片地址，也只能显示"没有可显示的内容"。
                #
                #   注意**不能按 filename 匹配**：落盘用的是内容哈希名（`<sha16>.jpg`），
                #   而 meta 里是云端原名（`2026102221xxxx.jpg`），两边永远对不上。
                #   改为按顺序对齐：被落盘的条目顺序 == saved_images/songs 的顺序。
                _saved_queue = list(saved_images) + list(songs)
                for meta in attached_meta:
                    meta.setdefault("url", "")
                for meta in attached_meta:
                    if str(meta.get("media") or "") not in ("image", "audio"):
                        continue
                    if not _saved_queue:
                        break
                    saved = _saved_queue.pop(0)
                    meta["url"] = saved.get("url") or ""
                    meta["size"] = saved.get("size") or meta.get("size") or 0
                    meta["filename"] = saved.get("filename") or meta.get("filename") or ""
                # 非图片非音频的普通文件：只给前端一个下载卡片，不进播放器
                other_media = [
                    item for item in attached_meta
                    if str(item.get("media") or "") not in ("image", "audio")
                ]
                if bubble_text or collected_bubble_items or saved_images:
                    pet_event_service.publish("agent_bubble", {
                        "text": bubble_text,
                        "agent_id": FEIYU_AGENT_ID,
                        "accent": FEIYU_BUBBLE_ACCENT,
                        # 气泡停留 3 秒后自动消失（2026-10-22 用户裁决）。
                        # 以前按字数给 4~30s，长句子会一直挂在桌上挡视线。
                        "duration_ms": 3000,
                    })
                    # 图片：用落盘后的短 URL（不是 base64），帧只有几百字节
                    for image in saved_images:
                        pet_event_service.publish("agent_image", {
                            "url": image["url"],
                            "agent_id": FEIYU_AGENT_ID,
                            "accent": FEIYU_BUBBLE_ACCENT,
                            # 带 response_id → 渲染端不把它当"点击随机图"
                            "response_id": claim.client_request_id,
                            # 图也 3 秒收起，和文字气泡一致（用户裁决：气泡别一直挂着）
                            "hold_ms": 3000,
                            # 本轮正文：图展示完由渲染端接着把这句话说出来
                            # （否则"文字+表情包"的回复会卡在图上、话永远不出现）
                            "text": bubble_text,
                        })
                # ★ 音频：点歌/发语音 → 桌宠真正播出来（这是用户要的"点歌功能"）。
                #   走独立的 agent_audio 事件 + 短 URL，不塞进气泡也不塞进帧。
                for song in songs:
                    pet_event_service.publish("agent_audio", {
                        "url": song["url"],
                        "filename": song["filename"],
                        "display": song["display"],
                        "mime_type": song["mime_type"],
                        "size": song["size"],
                        "agent_id": FEIYU_AGENT_ID,
                        "accent": FEIYU_BUBBLE_ACCENT,
                        "response_id": claim.client_request_id,
                        "text": bubble_text,
                    })
                for item in other_media:
                    pet_event_service.publish("agent_file", {
                        "display": item.get("display") or item.get("filename") or "文件",
                        "filename": item.get("filename") or "",
                        "mime_type": item.get("mime_type") or "",
                        "size": item.get("size") or 0,
                        "agent_id": FEIYU_AGENT_ID,
                        "accent": FEIYU_BUBBLE_ACCENT,
                    })

                import types as _types
                result = _types.SimpleNamespace(
                    reply=clean_content,
                    replies=[clean_content],
                    request_id=claim.client_request_id,
                    model_id="cloud_feiyu",
                    reasoning_level="off",
                    provider_id="astrbot",
                    provider_name="云端大肥鱼",
                    provider_model=f"persona:{feiyu.persona_id}",
                    speech_emotion=feiyu_emotion,
                    tool_receipts=[],
                    agent_run_id="",
                    agent_run_status="",
                    route_candidate_model_ids=[],
                    route_escalated_from_model_id="",
                    task_handoff={},
                    http_status=200,
                )
                # ★★ 落库（2026-10-22 用户要求「历史写进本地数据库」）。
                #
                # 背景：cloud_feiyu 是**直通 AstrBot** 的分支，不经过本地 chat_with_ai，
                # 所以历史上它**从来不写本地消息表** —— 这直接导致：
                #   · 桌面端 /api/companion/chat/history 永远拿不到她的回复；
                #   · 换设备/清缓存就"历史全没了"（此前只能靠前端 localStorage 兜底）。
                # 现在把这一轮的问与答都写进 desktop_pet 会话，历史接口就能正常返回，
                # 前端也就不再依赖本地缓存。
                #
                # 只记**最终正文**（clean_content），不记思考过程、不记设备上下文前缀。
                try:
                    db.save_message(
                        "user",
                        message or ("[图片]" if images else "发送了附件"),
                        source="desktop_pet",
                        conversation_id=conversation_id,
                        request_id=claim.client_request_id,
                        model_id="cloud_feiyu",
                        reasoning_level="off",
                        attachments_json=(
                            '[{"kind":"image"}]' if images else "[]"
                        ),
                    )
                    db.save_message(
                        "assistant",
                        clean_content,
                        source="desktop_pet",
                        conversation_id=conversation_id,
                        request_id=claim.client_request_id,
                        model_id="cloud_feiyu",
                        provider_model=f"persona:{feiyu.persona_id}",
                        reasoning_level="off",
                        emotion=feiyu_emotion,
                        # ★★ 2026-10-22 修「刷新后图片消失」：
                        #   以前只存了 {"kind","name"}，**没存 url** ——
                        #   刷新后历史接口拿到的附件没有地址，前端渲染不出图片，
                        #   用户看到的就是"图片那条消息整个没了，只剩文字"。
                        #   现在存完整信息（url/media/display/filename/mime/size），
                        #   历史接口原样回给前端，配合 mapHistoryRow 就能恢复图片。
                        attachments_json=json.dumps(
                            [
                                {
                                    "media": a.get("media") or a.get("kind") or "",
                                    "kind": a.get("media") or a.get("kind") or "",
                                    "url": a.get("url") or "",
                                    "display": a.get("display") or a.get("filename") or "",
                                    "filename": a.get("filename") or "",
                                    "mime_type": a.get("mime_type") or "",
                                    "size": a.get("size") or 0,
                                }
                                for a in (attached_meta or [])
                                if a and not a.get("error") and (a.get("url") or a.get("display"))
                            ],
                            ensure_ascii=False,
                        ),
                    )
                except Exception as exc:  # 落库失败不能影响这一轮回复
                    logger.warning("[feiyu] 消息落库失败：%s", exc)
            else:
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
        # ★ 多模态回执：大肥鱼这一轮发来的附件（图片/语音/文件/视频）。
        #   图片条目带 data_url（真实字节），前端可直接 <img src>；
        #   其它类型只带元信息（filename/display/mime/size），前端按类型给占位。
        #   非 cloud_feiyu 走本地模型时恒为空列表，保持字段形状稳定。
        "attachments": attached_meta,
        "images": collected_images,
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
    # ★ 过滤空正文（2026-10-22）：清洗（思考/工具载荷/设备前缀）之后有些历史行只剩空串，
    #   前端会把它们渲染成一条空白的「（这条回复没有可显示的内容）」——
    #   对话里看着像她"说了话但内容是空的"。这里直接不返回这些行。
    #   注意：附件轮次（attachments_json 非空的）即使正文为空也要保留，
    #   否则"只发了一张图"的回复会整条消失在历史里。
    messages = []
    for row in rows:
        raw_content = str(row["content"] or "")
        # ★ 历史也要清洗（2026-10-22）：改造前落库的回复里混着工具调用 JSON
        #   （{"id":"call_…","name":"…","args":{…}}），前端拿到后整段剥成空串，
        #   于是历史里出现一条条「（这条回复没有可显示的内容）」。
        #   读的时候统一过一遍清洗，旧数据不用手工修也能正常显示。
        content = strip_tool_payload(strip_device_prefix(raw_content)).strip()
        # sqlite3.Row 没有 .get()，用 keys() 安全判断
        attachments_json = "[]"
        try:
            if "attachments_json" in row.keys():
                attachments_json = str(row["attachments_json"] or "[]")
        except Exception:
            attachments_json = "[]"
        has_attachment = attachments_json not in ("", "[]", "null")
        # 清洗后彻底没内容、也没有附件 → 不返回（否则又是一条空占位）
        if not content and not has_attachment:
            continue
        messages.append(
            {
                "id": int(row["id"]),
                "role": str(row["role"] or ""),
                "content": content,
                "source": str(row["source"] or ""),
                "created_at": str(row["created_at"] or ""),
                "request_id": str(row["request_id"] or ""),
                "model_id": str(row["model_id"] or ""),
                "provider_model": str(row["provider_model"] or ""),
                "reasoning_level": str(row["reasoning_level"] or ""),
                # ★ 附件必须一起回给前端（带 url），否则刷新后图片那条就没了
                "attachments": _parse_attachments_json(attachments_json),
            }
        )
    return {"conversation_id": conversation_id, "messages": messages}



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
