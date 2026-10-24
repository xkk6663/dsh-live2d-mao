from __future__ import annotations

import asyncio
import base64
import json
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from . import local_vision_service, system_audio_service
from .. import db
from ..companion import companion_service
from ..companion import pet_event_service
from ..auto_router import select_auto_route
from ..chat.chat_service import ChatResult, replies_for_source
from ..config import settings
from ..model_runtime import operation, OperationStopped
from ..cost_reconciliation_service import queue_cost_reconciliation
from ..llm import (
    CompletionResult,
    call_chat_completion_result,
)
from ..model_registry import ModelProfile, list_model_profiles
from ..companion.mio_profile import load_mio_profile
from .screen_behavior_service import (
    BehaviorDecision,
    Observation,
    decide_behavior,
    game_state_summary,
    is_duplicate_summary,
    is_new_event_occurrence,
    normalize_event_type,
    update_game_state,
)
from .screen_frame_processor import process_frame


_state_lock = threading.Lock()
_last_analyzed_frame_id = 0
_last_analysis_monotonic = 0.0
_last_analyzed_at = ""
_last_reply = ""
_last_error = ""
_last_model = ""
_last_reaction_model = ""
_last_cost_yuan: float | None = None
_last_event_type = ""
_last_event_summary = ""
_last_event_priority = 0.0
_last_event_confidence = 0.0
_last_emotion = "neutral"
_last_game_state: dict[str, Any] = {}
_last_pipeline_timings: dict[str, float | str | bool] = {}
_last_spoken_monotonic = 0.0
_capture_only = False
_in_progress = False
_session_started_at = db.now_iso()
_session_request_count = 0
_session_generation_count = 0
_session_cost_yuan = 0.0
_session_unknown_cost_count = 0
_session_attempt_count = 0
_session_failure_count = 0
_cloud_profile_health: dict[str, dict[str, Any]] = {}
# 2026-10-24 用户裁决（m02056）：屏幕观察从"画面一变就分析"改成"可设最短/最长间隔、
# 区间内均匀随机的定时触发"（典型是 1~2 小时看一眼）。这里保存下一次该在什么时候观察，
# 以及它落在哪个区间里 —— 给设置页显示倒计时，也避免每次轮询都重新掷骰子。
_trigger_next_monotonic = 0.0
_trigger_span_seconds = 0
_trigger_last_fire_monotonic = 0.0
_trigger_last_span_seconds = 0
CLOUD_PROFILE_BASE_COOLDOWN_SECONDS = 30.0
CLOUD_PROFILE_MAX_COOLDOWN_SECONDS = 300.0
DESKTOP_PET_CONVERSATION_ID = "desktop_pet"
# 云端大肥鱼这条路在状态面板里借用健康度表展示（它不是本地 llm 的 ModelProfile）
FEIYU_VISION_HEALTH_ID = "cloud_feiyu"
# 云端识图：跟 routes/companion.py 的直通式对话一样，给大肥鱼的正文前加一枚设备前缀，
# 让她知道这是哪台电脑在看屏幕（多设备共用一个灵魂时的识别依据）。
FEIYU_SCREEN_DEVICE_TAG = "电脑桌宠"
# 游戏窗口需要比整屏观察更敏感：对白框、选项和立绘变化通常只占画面一小块。
# 这只影响“何时送视觉请求”，不会让普通桌面整屏观察变成高频上传。
GAME_WINDOW_CHANGE_FACTOR = 0.6
GAME_WINDOW_MIN_CHANGE_THRESHOLD = 2.0
GAME_EVENT_REPLY_TYPES = {
    "activity_progress",
    "interesting_content",
    "progress",
    "victory",
    "achievement",
    "rare_reward",
    "match_result",
    "death",
    "failure",
    "boss_battle",
    "boss_phase",
    "low_health",
    "danger",
    "warning",
    "error",
    "stuck",
    "dialogue_choice",
    "cutscene_turn",
}
GAME_EVENT_TYPES = {
    "gameplay",
    "movement",
    "exploration",
    "death",
    "failure",
    "victory",
    "boss_battle",
    "boss_phase",
    "low_health",
    "danger",
    "rare_reward",
    "achievement",
    "match_result",
    "dialogue_choice",
    "cutscene_turn",
}
# ★ 2026-10-24 用户反馈「自然语言触发不了屏幕观察」。
#   原来这里是一串写死的短语（现在呢/再看看/屏幕呢…），必须**整句完全等于**其中之一
#   （下面用的是 fullmatch），用户换个说法就失效。现在改成**要素组合**：
#     动作词（看/瞅/瞧…）+ 可选的"现在/当前/一下" + 对象词（屏幕/画面/桌面）
#   这样「看一下现在的屏幕」「看下我这屏幕」「帮我瞅瞅画面」「屏幕上是啥」都能命中，
#   而「看看这个视频」这种带具体内容的不会被误判（对象词必须是屏幕类）。
_SCREEN_ACTION = r"(?:帮\s*我\s*|给\s*我\s*|你\s*)?(?:看|瞅|瞧|瞄|扫)(?:一|了)?(?:下|看|眼)?"
_SCREEN_OBJECT = r"(?:屏幕|画面|桌面|电脑|显示器)"
SCREEN_FOLLOW_UP_RE = re.compile(
    r"^(?:"
    # ① 纯指示语（靠上下文判断）：现在呢 / 然后呢 / 再看看 / 这个呢
    r"(?:现在|然后|接下来|这个|那个|屏幕|画面|视觉功能)(?:呢|怎么样|怎么了|有啥|有什么)?|"
    r"(?:再|重新)?(?:看|瞅|瞧)(?:一下|看|一眼)?|"
    # ② 动作 + 对象：看/瞅/瞧 + (现在/当前/一下) + 屏幕/画面/桌面
    rf"{_SCREEN_ACTION}(?:现在|当前|一下)?(?:的)?(?:电脑)?{_SCREEN_OBJECT}(?:上|里|中)?(?:是|有|在|显示|变成)?(?:啥|什么|干嘛|做什么|什么情况|怎么样|呢)?|"
    # ③ 对象打头：屏幕上是什么 / 画面里是啥 / 桌面现在什么样 / 屏幕呢
    rf"(?:我的?|这|那)?{_SCREEN_OBJECT}(?:上|里|中)?(?:现在|此刻)?(?:是|有|在|显示|变成|什么样|怎么样)?(?:啥|什么|干嘛|做什么|什么情况|怎么样|呢)?|"
    # ④ 别的说法：现在能看到吗 / 看得到吗 / 有画面吗
    r"现在(?:能)?看到(?:了)?吗|看得到(?:屏幕|画面)?吗|有画面吗|还是看不见|还能看到吗"
    r")[\uFF0C\u3002\uFF01\uFF1F!?/\\\s]*$"
)
SCREEN_CONTEXT_INTENT_RE = re.compile(
    # ★ 同一反馈：原来只认"看屏幕/屏幕是/你看现在"几种固定写法，
    #   「我屏幕上现在有啥」「桌面现在什么样」漏了。放宽成"动作+对象"或"对象+问词"。
    #   注意对象词包含"桌面"——用户说"桌面"时说的就是屏幕，不是桌面文件夹。
    rf"(?:{_SCREEN_ACTION}[^。！？\n]{{0,6}}?{_SCREEN_OBJECT})|"
    rf"(?:{_SCREEN_OBJECT}(?:上|里|中)?[^。！？\n]{{0,8}}?(?:是|有|显示|变成|怎么样|什么样|干嘛|做什么))|"
    r"你在看我|看看我在干嘛|看看我在做什么|现在在干嘛|视觉功能|画面识别|屏幕观察"
)
SCREEN_FOLLOW_UP_CONTEXT_SECONDS = 5 * 60
# A screen follow-up is an explicit user request about what is visible now.
# Never answer it from an old preview or from the ordinary text-chat model.
MAX_SCREEN_FOLLOW_UP_FRAME_AGE_SECONDS = 8.0
LOCAL_SCREEN_SAFE_SUMMARIES = {
    "activity_change": "用户切换了当前活动",
    "activity_progress": "用户当前做的事情有了新的进展",
    "activity_pause": "用户当前做的事情暂时停了下来",
    "interesting_content": "用户当前屏幕出现了值得随口回应的内容",
    "watching_game_video": "用户正在观看游戏相关视频",
    "watching_video": "用户正在观看视频内容",
    "watching_movie": "用户正在观看电影、番剧或剧情内容",
    "coding": "用户正在编写或调试代码",
    "writing": "用户正在写作或编辑文档",
    "reading": "用户正在阅读内容",
    "browsing": "用户正在浏览网页",
    "gameplay": "用户正在进行一段普通游戏过程",
    "progress": "用户当前正在做的事情有了进展",
    "notable_scene": "用户屏幕上出现了值得回应的变化",
    "warning": "用户当前使用的程序出现了提醒",
    "error": "用户当前使用的程序似乎遇到了问题",
    "loading": "用户正在等待内容加载",
}


def _screen_persona_context() -> str:
    try:
        profile = load_mio_profile()
    except Exception:
        return "Mio 与用户的关系和称呼由本机属性定义；自然、直接地回应，不编造共同经历。"
    identity = profile.get("identity") if isinstance(profile.get("identity"), dict) else {}
    speaking = profile.get("speaking_style") if isinstance(profile.get("speaking_style"), dict) else {}
    preferences = profile.get("preferences") if isinstance(profile.get("preferences"), dict) else {}
    parts = [
        f"身份：{str(identity.get('core') or '').strip()}",
        f"语气：{str(speaking.get('tone') or '').strip()}",
        f"用户称呼：{str(preferences.get('user_address') or '').strip()}",
        f"关系距离：{str(preferences.get('relationship_distance') or '').strip()}",
    ]
    return "\n".join(part for part in parts if not part.endswith("："))[:1800]


@dataclass(frozen=True)
class CombinedVisionResult:
    observation: Observation
    should_reply: bool
    importance: float
    emotion: str
    reply: str
    reason: str


def _vision_routes(config: dict[str, Any]) -> set[str]:
    """当前允许的识图通路。

    ★ 2026-10-24 用户裁决：**桌宠端完全不需要任何模型 API，模型全部走云端服务器。**
      所以这里恒为 {"feiyu"}（云端大肥鱼直连：一帧图 + 一段自然语言提示词发 AstrBot）。
      原来还有两条需要本机持有模型的路，按裁决移除：
        · "local" —— 本机 Ollama 跑 qwen2.5-vl（要下载模型、要占显存）
        · "cloud" —— 本机拼一大段 JSON 指令发某个云端 VL 模型，再解析 JSON
      老配置里写了 local/cloud 的，一律按 feiyu 处理，保证升级后行为一致。

    config 参数保留：调用点都传了，且将来若真的要多通路，这里是唯一开关。
    """
    _ = config
    return {"feiyu"}


def _uses_feiyu_vision(config: dict[str, Any]) -> bool:
    return "feiyu" in _vision_routes(config)


def _feiyu_unavailable_reason() -> str:
    """云端大肥鱼没配好时给用户的明确原因（不要把"没配 key"说成"网络错误"）。"""
    try:
        from ..cloud_feiyu import get_client as get_feiyu_client

        client = get_feiyu_client()
    except Exception as exc:  # noqa: BLE001 - 导入/初始化失败都按"不可用"处理
        return f"云端大肥鱼客户端初始化失败：{exc}"
    if not client.is_configured:
        return "云端大肥鱼未配置：在 backend/.env 里设置 ASTRBOT_API_KEY（不要写进源码）"
    return ""


def _feiyu_screen_prompt(
    *,
    custom_prompt: str,
    is_window: bool,
    frame: dict[str, Any],
    persona_context: str,
    recent_context: str,
    audio_context: str,
    foreground: dict[str, Any],
) -> str:
    """交给云端大肥鱼的提示词：**一张图 + 一句话**，不要 JSON。

    和本地/普通云视觉那条链路最大的区别：
      · 不要求模型输出结构化 JSON —— 大肥鱼是人格化对话，硬要 JSON 会把她答成"识图接口"；
      · 屏幕观察要的"识别 + 判断该不该说"由本机完成（观测记录照样落库），
        云端只负责用她自己的性格看图说话；
      · 有用户自定义提示词时直接交给她，本机不预先替她决定口径。
    """
    scope = "用户指定的单个窗口" if is_window else "用户此刻的整个电脑屏幕"
    title = str(frame.get("title") or "").strip()
    custom = str(custom_prompt or "").strip()
    if custom:
        request = (
            "用户对你这次看屏幕有明确要求，按这个要求回答（不要解释你在遵守要求）：\n"
            f"{custom[:2000]}"
        )
    else:
        request = (
            "自然地说一句 1-2 句短话：可以是对的吐槽、感受、关心或随口反应。"
            "不要播报画面、不要复述用户在做什么、不要说「我看到了」，不要提问式追问。"
        )
    lines = [
        f"这是{scope}的一瞬间截图。",
    ]
    if title:
        lines.append(f"窗口标题：{title[:120]}")
    if foreground.get("process_name"):
        lines.append(f"前台应用：{foreground.get('process_name')}（{foreground.get('kind') or '未知类型'}）")
    if audio_context:
        lines.append(f"你刚听到的声音台词（只作画面补充，不要当成用户在跟你说话）：{audio_context[:240]}")
    if persona_context:
        lines.append(f"你的身份与语气：{persona_context[:600]}")
    if recent_context:
        lines.append(f"最近这段对话（别重复已说过的话）：\n{recent_context[:600]}")
    lines.append("")
    lines.append(request)
    lines.append("直接输出要对用户说的话，不要 Markdown，不要情绪标签。")
    return "\n".join(lines)


async def _feiyu_vision_call(
    *,
    frame: dict[str, Any],
    prompt: str,
    timeout_seconds: float,
) -> CompletionResult:
    """把这一帧 + 提示词丢给云端 AstrBot，拿回她的原话。

    为什么不用 `client.chat()`：
      · `chat()` 解析正文时**从不读 `complete` 帧**，而云端模型非流式时只发 complete
        → 实测拿到空正文（client 层的既有 bug，这里不顺手改，避免影响大肥鱼聊天主链路）；
      · 观察链路也不需要云端回传的图片/语音字节，所以用 `chat_text_diagnosed()`：
        只取正文，但把帧级诊断带出来（本次是 plain 还是 complete 回的、云端 stats 是什么）。
    """
    from ..cloud_feiyu import get_client as get_feiyu_client
    from ..cloud_feiyu.device import build_device_context

    client = get_feiyu_client()
    reason = _feiyu_unavailable_reason()
    if reason:
        raise RuntimeError(reason)

    image_data_url = "data:image/jpeg;base64," + base64.b64encode(frame["content"]).decode("ascii")
    # 出站多模态：AstrBot 只收 attachment_id，data URL 必须先上传换 id
    attachment_id = await client.upload_attachment(image_data_url, filename="screen_observe.jpg")
    try:
        device_ctx = build_device_context()
    except Exception:  # noqa: BLE001 - 设备上下文是锦上添花
        device_ctx = ""
    message = f"[{FEIYU_SCREEN_DEVICE_TAG}] {device_ctx}\n\n{prompt}" if device_ctx else prompt

    started = time.monotonic()
    text, diagnostics = await client.chat_text_diagnosed(
        message,
        session_id=client.session_id,
        images=[attachment_id],
    )
    elapsed_ms = round((time.monotonic() - started) * 1000, 1)
    stats = diagnostics.get("agent_stats") if isinstance(diagnostics, dict) else None
    first_token_ms = None
    if isinstance(stats, dict):
        try:
            first_token_ms = round(float(stats.get("time_to_first_token") or 0) * 1000, 1)
        except (TypeError, ValueError):
            first_token_ms = None
    if not str(text or "").strip():
        # 帧级诊断直接进报错文案：用户看到的是"云端这轮没吐正文"而不是笼统的网络错误
        seen = ""
        record_hint = ""
        if isinstance(diagnostics, dict):
            frames = diagnostics.get("frames") or []
            seen = "、".join(str(item) for item in list(frames)[:12]) or "无"
            if int(diagnostics.get("record_frames") or 0) > 0:
                record_hint = "；她这轮把回复转成了语音（record 帧），文字没有随帧下发"
        raise RuntimeError(
            "云端大肥鱼这轮没有返回正文"
            f"（plain 帧 {diagnostics.get('plain_frames', 0)} 个 / "
            f"complete 帧 {diagnostics.get('complete_frames', 0)} 个{record_hint}；"
            f"本次收到的帧序列：{seen}）"
            if isinstance(diagnostics, dict)
            else "云端大肥鱼这轮没有返回正文"
        )
    return CompletionResult(
        content=str(text),
        model="cloud_feiyu",
        prompt_tokens=0,
        cached_prompt_tokens=0,
        completion_tokens=0,
        reasoning_tokens=0,
        # 云端按人统计费用，这里拿不到单价 → 记"未知"，不计入本机预算，也不假装是 0 元
        cost_yuan=None,
        cost_source="cloud_feiyu_unmetered",
        first_token_latency_ms=(first_token_ms if first_token_ms else None),
        total_latency_ms=elapsed_ms,
        provider_id=FEIYU_VISION_HEALTH_ID,
        provider_name="大肥鱼（云端）",
    )


def _fallback_reaction(observation: Observation) -> str:
    replies = {
        "victory": "赢下来了，刚才那一下挺漂亮的",
        "match_result": "这一局结束了，先缓口气吧",
        "failure": "差一点，缓一下再来",
        "death": "没事，下一次会更顺一点",
        "warning": "画面好像在提醒什么，先看一眼吧",
        "error": "好像出了点问题，先看看提示吧",
        "loading": "还在加载，我陪你等一下",
        "boss_battle": "这段要认真一点了",
        "dialogue_choice": "这个选择得想一下",
        "progress": "有进展了，继续吧",
        "activity_progress": "有进展了，刚才那一步挺顺的",
        "activity_pause": "先停一下也好，别把自己绷得太紧",
        "interesting_content": "这个还挺有意思的",
        "watching_game_video": "这段操作还挺稳的",
        "watching_video": "这个片段还挺有意思的",
        "watching_movie": "这段气氛一下子起来了",
        "coding": "这一步跑通了，顺多了",
        "writing": "这一段比刚才顺多了",
        "reading": "这段好像挺值得慢慢看的",
        "browsing": "这个页面还挺有意思的",
        "menu": "准备好就出发吧",
    }
    return replies.get(observation.event_type, "我看到了，继续吧")


def _desktop_pet_conversation_id() -> str:
    return DESKTOP_PET_CONVERSATION_ID


def _recent_context(conversation_id: str, *, limit: int = 8, max_chars: int = 220) -> str:
    rows = db.get_recent_messages(limit=max(1, min(8, int(limit))), conversation_id=conversation_id)
    lines: list[str] = []
    for row in rows:
        role = "用户" if str(row["role"] or "") == "user" else "Mio"
        content = " ".join(str(row["content"] or "").split()).strip()
        if content:
            lines.append(f"{role}：{content[:max(40, min(220, int(max_chars)))]}")
    return "\n".join(lines) or "最近没有对话。"


def _configured_profiles():
    return [profile for profile in list_model_profiles() if profile.base_urls and profile.api_key]


def _vision_profiles():
    return [profile for profile in _configured_profiles() if profile.supports_vision]


def _vision_latency_rank(profile: ModelProfile) -> tuple[int, float, str]:
    name = f"{getattr(profile, 'model', '')} {getattr(profile, 'variant_name', '')}".lower()
    marker_rank = 4
    for marker, rank in (
        ("flash", 0),
        ("luna", 1),
        ("mini", 2),
        ("turbo", 2),
        ("sol", 5),
        ("pro", 6),
    ):
        if marker in name:
            marker_rank = rank
            break
    price = float(getattr(profile, "input_price_cny_per_million", 0) or 0) + float(
        getattr(profile, "output_price_cny_per_million", 0) or 0
    )
    return marker_rank, price if price > 0 else 1_000_000.0, str(profile.id)


def _selected_vision_profile(config: dict[str, Any], profiles: list[ModelProfile]) -> ModelProfile:
    requested = str(config.get("screen_vision_model_id") or "auto-fast").strip()
    if requested not in {"", "auto", "auto-fast"}:
        selected = next((profile for profile in profiles if profile.id == requested), None)
        if selected is not None:
            return selected
    if not profiles:
        raise ValueError("没有配置可识图的模型。")
    return min(profiles, key=_vision_latency_rank)


def _ordered_vision_profiles(config: dict[str, Any], profiles: list[ModelProfile]) -> list[ModelProfile]:
    if not profiles:
        return []
    primary = _selected_vision_profile(config, profiles)
    remaining = sorted(
        (profile for profile in profiles if profile.id != primary.id),
        key=_vision_latency_rank,
    )
    return [primary, *remaining]


def _healthy_vision_profile(
    config: dict[str, Any],
    profiles: list[ModelProfile],
    *,
    now: float | None = None,
) -> ModelProfile | None:
    checked_at = time.monotonic() if now is None else float(now)
    with _state_lock:
        cooldowns = {
            profile_id: float(state.get("cooldown_until") or 0.0)
            for profile_id, state in _cloud_profile_health.items()
        }
    return next(
        (
            profile
            for profile in _ordered_vision_profiles(config, profiles)
            if cooldowns.get(profile.id, 0.0) <= checked_at
        ),
        None,
    )


def _mark_cloud_profile_success(profile_id: str) -> None:
    if not profile_id:
        return
    with _state_lock:
        _cloud_profile_health[profile_id] = {
            "consecutive_failures": 0,
            "cooldown_until": 0.0,
            "last_error": "",
            "last_success_at": db.now_iso(),
        }


def _mark_cloud_profile_failure(profile_id: str, error: str) -> float:
    if not profile_id:
        return 0.0
    now = time.monotonic()
    with _state_lock:
        previous = dict(_cloud_profile_health.get(profile_id) or {})
        failures = max(0, int(previous.get("consecutive_failures") or 0)) + 1
        cooldown = min(
            CLOUD_PROFILE_MAX_COOLDOWN_SECONDS,
            CLOUD_PROFILE_BASE_COOLDOWN_SECONDS * (2 ** min(3, failures - 1)),
        )
        previous.update(
            {
                "consecutive_failures": failures,
                "cooldown_until": now + cooldown,
                "last_error": " ".join(str(error or "视觉请求失败").split())[:500],
                "last_failure_at": db.now_iso(),
            }
        )
        _cloud_profile_health[profile_id] = previous
    return cooldown


def _cloud_health_status(profiles: list[ModelProfile]) -> list[dict[str, Any]]:
    now = time.monotonic()
    with _state_lock:
        states = {key: dict(value) for key, value in _cloud_profile_health.items()}
    rows: list[dict[str, Any]] = []
    for profile in profiles:
        state = states.get(profile.id) or {}
        cooldown_remaining = max(0.0, float(state.get("cooldown_until") or 0.0) - now)
        rows.append(
            {
                "id": profile.id,
                "label": str(getattr(profile, "display_name", "") or getattr(profile, "model", "") or profile.id),
                "consecutive_failures": max(0, int(state.get("consecutive_failures") or 0)),
                "cooldown_remaining_seconds": round(cooldown_remaining, 1),
                "available_now": cooldown_remaining <= 0,
                "last_error": str(state.get("last_error") or ""),
                "last_failure_at": str(state.get("last_failure_at") or ""),
                "last_success_at": str(state.get("last_success_at") or ""),
            }
        )
    return rows


def _observation_lines(rows: list[Any]) -> str:
    lines: list[str] = []
    for row in rows:
        try:
            summary = " ".join(str(row["summary"] or "").split())
            event_type = str(row["event_type"] or "unknown")
            confidence = float(row["confidence"] or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if summary:
            lines.append(f"- {event_type}（{confidence:.0%}）：{summary[:160]}")
    return "\n".join(lines) or "- 暂无"


def _foreground_details() -> dict[str, Any]:
    try:
        foreground = pet_event_service.status().get("foreground") or {}
    except (AttributeError, RuntimeError, TypeError):
        return {"title": "", "process_name": "", "process_id": 0}
    return {
        "title": " ".join(str(foreground.get("title") or "").split())[:300],
        "process_name": " ".join(str(foreground.get("process_name") or "").split())[:260],
        "process_id": int(foreground.get("process_id") or 0),
    }


def _foreground_context() -> str:
    foreground = _foreground_details()
    title = str(foreground["title"] or "")
    process_name = str(foreground["process_name"] or "")
    if process_name and title:
        return f"{process_name} | {title}"
    return process_name or title or "未记录"


_SELF_PROCESS_NAMES = {"mio.exe", "mioagent.exe"}
_SELF_WINDOW_MARKERS = ("mio agent", "mio", "澪", "桌宠")


def _is_self_ui_foreground(frame: dict[str, Any] | None = None) -> bool:
    """Return whether full-screen observation is currently looking at Mio itself."""
    foreground = _foreground_details()
    process_name = str(foreground.get("process_name") or "").strip().casefold()
    title = " ".join(str(foreground.get("title") or "").split()).casefold()
    frame_title = " ".join(str((frame or {}).get("title") or "").split()).casefold()
    if process_name in _SELF_PROCESS_NAMES:
        return True
    combined = f"{title} {frame_title}".strip()
    return any(marker.casefold() in combined for marker in _SELF_WINDOW_MARKERS)


def _audio_context() -> str:
    transcript = system_audio_service.recent_transcript(max_age_seconds=24)
    return transcript or "最近没有识别到清晰台词或系统声音"


BROWSER_PROCESSES = {
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe",
}
VIDEO_PLATFORM_MARKERS = (
    "哔哩哔哩", "bilibili", "youtube", "腾讯视频", "爱奇艺", "优酷", "芒果tv",
    "netflix", "disney+", "prime video",
)
MEDIA_PLAYER_PROCESSES = {
    "potplayermini64.exe", "potplayer.exe", "vlc.exe", "mpv.exe", "mpc-hc64.exe",
    "moviesandtv.exe", "wmplayer.exe",
}
CODE_EDITOR_MARKERS = (
    "code.exe", "devenv.exe", "idea64.exe", "pycharm64.exe", "rider64.exe", "unity.exe",
    "visual studio code", "visual studio", "pycharm", "intellij idea", "cursor",
)
DOCUMENT_EDITOR_MARKERS = (
    "winword.exe", "wps.exe", "et.exe", "powerpnt.exe", "notepad.exe", "notepad++.exe",
    "microsoft word", "wps office", "obsidian", "typora",
)
GAME_EVENTS = {
    "gameplay", "movement", "exploration", "death", "failure", "victory", "progress",
    "boss_battle", "boss_phase", "low_health", "danger", "rare_reward", "achievement",
    "match_result", "stuck", "dialogue_choice", "cutscene_turn",
}


def _activity_context(frame: dict[str, Any] | None = None) -> dict[str, str]:
    foreground = _foreground_details()
    process_name = str(foreground["process_name"] or "").casefold()
    foreground_title = str(foreground["title"] or "")
    frame_title = " ".join(str((frame or {}).get("title") or "").split())[:300]
    combined = f"{process_name} {foreground_title} {frame_title}".casefold()
    kind = "application"
    guidance = "结合前台应用和画面共同判断当前活动，不要只根据画面中的内容下结论。"
    if any(marker.casefold() in combined for marker in VIDEO_PLATFORM_MARKERS):
        kind = "video_platform"
        guidance = (
            "当前是视频网站或视频应用。即使画面里出现游戏，也应判断为用户在看游戏视频，"
            "不能说成用户正在玩；电影、番剧或剧情视频应判断为观看剧情内容。"
        )
    elif process_name in MEDIA_PLAYER_PROCESSES:
        kind = "media_player"
        guidance = (
            "当前是本地媒体播放器。画面中的游戏通常是录播，人物和场景通常是影片内容；"
            "除非有明确交互证据，否则不要判断为用户正在玩游戏。"
        )
    elif process_name in BROWSER_PROCESSES:
        kind = "browser"
        guidance = (
            "当前是浏览器。先判断用户是在浏览网页、看视频、阅读还是使用网页工具；"
            "仅凭网页里出现游戏画面，不能判断用户正在玩游戏。"
        )
    elif any(marker in combined for marker in CODE_EDITOR_MARKERS):
        kind = "code_editor"
        guidance = "当前是代码或开发工具，优先识别编写代码、调试、运行和报错等活动。"
    elif any(marker in combined for marker in DOCUMENT_EDITOR_MARKERS):
        kind = "document_editor"
        guidance = "当前是文档或写作工具，优先识别写作、编辑、整理和阅读等活动。"
    return {
        "kind": kind,
        "process_name": str(foreground["process_name"] or ""),
        "foreground_title": foreground_title,
        "frame_title": frame_title,
        "guidance": guidance,
    }


def _correct_observation_for_activity(
    observation: Observation,
    frame: dict[str, Any],
) -> Observation:
    context = _activity_context(frame)
    if context["kind"] not in {"video_platform", "media_player"}:
        return observation
    text = f"{observation.summary} {' '.join(observation.tags)}".casefold()
    movie_markers = ("电影", "影片", "剧情", "角色", "番剧", "动漫", "电视剧", "镜头")
    if observation.event_type in GAME_EVENTS or observation.game_name:
        event_type = "watching_game_video"
        summary = "用户正在视频应用中观看包含游戏画面的内容"
    elif any(marker in text for marker in movie_markers):
        event_type = "watching_movie"
        summary = observation.summary
    elif observation.event_type in {"idle", "unknown", "notable_scene", "interesting_content"}:
        event_type = "watching_video"
        summary = observation.summary
    else:
        return observation
    details = dict(observation.details)
    details["activity_kind"] = context["kind"]
    return Observation(
        event_type=event_type,
        summary=summary,
        confidence=observation.confidence,
        game_name="",
        details=details,
        tags=observation.tags,
    )


def _cursor_prompt_context(frame: dict[str, Any]) -> str:
    cursor = frame.get("cursor")
    if not isinstance(cursor, dict) or not cursor.get("available"):
        return "当前鼠标位置：未获取"
    if str(frame.get("mode") or "") != "window":
        return "当前鼠标位置：已获取系统坐标，但整屏观察不据此推断操作结果"
    if not cursor.get("inside_capture"):
        return "当前鼠标位置：在所选窗口外"
    try:
        x_percent = max(0, min(100, round(float(cursor.get("relative_x")) * 100)))
        y_percent = max(0, min(100, round(float(cursor.get("relative_y")) * 100)))
    except (TypeError, ValueError):
        return "当前鼠标位置：位于所选窗口内，具体位置不可用"
    return (
        f"当前鼠标位置：所选窗口内横向约 {x_percent}%，纵向约 {y_percent}%。"
        "这只是用户关注或操作区域的弱证据，不能单独推断点击结果；"
        "如果游戏使用画面内自绘光标，以视觉内容为准。"
    )


def _compact_combined_prompt(
    frame: dict[str, Any],
    recent_observations: list[Any],
    state: dict[str, Any],
    frame_metadata: dict[str, Any],
    conversation_id: str,
    *,
    seconds_since_last_speech: float,
) -> str:
    is_window = str(frame.get("mode") or "") == "window"
    activity = _activity_context(frame)
    activity_rule = (
        "这是用户指定的单个窗口，先判断是游戏、工作、学习、创作、阅读、视频还是普通软件；游戏按低频陪玩处理，不要把指定窗口一律当成游戏。"
        if is_window
        else "这是日常桌面陪伴，用户可能在工作、学习、写作、画画、编程、阅读、看视频或使用普通软件。"
    )
    privacy_rule = (
        "云端整屏识别不得转录聊天、通知、账号、文件名、路径、网址、密钥或验证码，只概括活动和事件。"
        if not is_window
        else "不要转录与当前活动无关的隐私文字。"
    )
    return f"""你负责看懂当前画面，并替 Mio 决定此刻是否自然开口。一次完成识别与回复判断，只返回 JSON。
Mio 的身份与语气：{_screen_persona_context()[:600]}
画面：{'指定窗口' if is_window else '整个屏幕'}；标题：{frame.get('title') or '未记录'}；变化：{float(frame.get('change_percent') or 0):.1f}%；尺寸：{frame_metadata.get('width', '?')}x{frame_metadata.get('height', '?')}
前台应用：{activity['process_name'] or '未记录'}；前台窗口：{activity['foreground_title'] or frame.get('title') or '未记录'}；应用类型：{activity['kind']}
应用判断：{activity['guidance'][:320]}
{_cursor_prompt_context(frame)}
当前状态：{game_state_summary(state)[:500]}
最近观察：{_observation_lines(recent_observations[-4:])[:600]}
最近对话：{_recent_context(conversation_id, limit=4, max_chars=120)[:650]}
最近系统声音台词：{_audio_context()[:240]}
距离上次开口：约 {max(0, int(seconds_since_last_speech))} 秒

规则：
1. {activity_rule} 先判断用户正在操作什么应用，再解释画面内容。
2. 浏览器或播放器里的游戏画面是 watching_game_video，不是用户正在玩；电影和剧情视频是 watching_movie。不要把视频台词当成用户对你说话。
3. 只选一个可确认事件，不猜游戏名、结果或剧情。重复画面、普通移动和无具体内容时保持安静。
4. 指定游戏窗口中，新的对白、对白选项、立绘/镜头推进、剧情进展、胜负、危险或卡住都属于值得回应的事件；这类事件应设置 should_reply=true，并给出 1-2 句短口语。普通移动和连续相同画面仍保持安静。
5. 其他应用只有在新进展、卡住、警告、错误、结果或确实值得回应的内容出现时 should_reply=true。不要播报画面，不说“我看到”。
5. {privacy_rule}

输出字段必须完整：
{{"event":"idle|movement|exploration|gameplay|activity_change|activity_progress|activity_pause|interesting_content|watching_game_video|watching_video|watching_movie|coding|writing|reading|browsing|menu|loading|death|failure|victory|progress|boss_battle|boss_phase|low_health|danger|rare_reward|achievement|match_result|stuck|dialogue_choice|cutscene_turn|error|warning|notable_scene|unknown","summary":"最多50字","confidence":0.0,"game":"","state":{{"boss":"","location":"","phase":"","objective":"","mode":"","outcome":"","health_status":""}},"tags":[],"should_reply":false,"importance":0.0,"emotion":"neutral|gentle|cheerful|concerned|serious|shy","reply":"无需说话时为空","reason":"简短原因"}}"""


def _combined_analysis_messages(
    frame: dict[str, Any],
    recent_observations: list[Any],
    state: dict[str, Any],
    frame_metadata: dict[str, Any],
    conversation_id: str,
    *,
    wake: bool = False,
    interactive: bool = False,
    seconds_since_last_speech: float = 1_000_000,
) -> list[dict[str, Any]]:
    image_url = "data:image/jpeg;base64," + base64.b64encode(frame["content"]).decode("ascii")
    cursor_context = _cursor_prompt_context(frame)
    is_window = str(frame.get("mode") or "") == "window"
    observation_kind = "指定窗口" if is_window else "整个屏幕"
    privacy_rule = ""
    if not is_window:
        privacy_rule = (
            "这是用户主动选择的云端整屏识别。不要转录聊天、通知、账号、文件名、路径、网址、"
            "密钥、验证码或其他原文，只概括活动和可回应事件。"
        )
    wake_rule = (
        "这是桌宠刚启动后的第一次观察。只要画面可辨识，就自然说一句简短问候或随口反应。"
        if wake
        else (
            "用户刚刚用‘现在呢’一类短句明确追问当前画面。必须根据这一次的新画面直接回答，"
            "should_reply=true，reply 不得为空；不要回答看不到，也不要要求用户重新开启观察。"
            if interactive
            else "重复画面或没有具体可说内容时保持安静，不要为了达到频率硬找话题。"
        )
    )
    activity = _activity_context(frame)
    self_ui_rule = (
        "The foreground may be Mio's own chat or pet window. Ignore Mio's old chat text, bubbles, subtitles, and pet content; never treat them as the user's current activity."
        if _is_self_ui_foreground(frame)
        else "If Mio's own interface appears in the image, treat it only as an overlay and never use its historical text as current activity."
    )
    rhythm_rule = (
        (
            "这是用户指定的单个窗口，可能是游戏，也可能是工作、学习、创作、阅读、视频或普通软件。"
            "先根据画面主体判断活动类型：游戏按低频陪玩处理，非游戏按日常桌面陪伴处理。"
            "有明确的新步骤、进展、卡住、等待或值得回应的内容时，可以自然说一句；不要把指定窗口一律当成游戏。"
        )
        if is_window
        else (
            "这是日常桌面陪伴，不只是在陪用户玩游戏。用户可能在工作、学习、写作、画画、"
            "写代码、整理文件、看视频、阅读或使用普通软件。出现新的步骤、进展、卡住、等待、"
            "有趣内容或明显任务切换时，可以自然说一句；不要把非游戏活动一律判成无需回复。"
        )
    )
    game_reply_rule = (
        "指定游戏窗口的对白、选项、立绘或镜头推进、剧情进展、胜负、危险和卡住都应视为可回应的新事件；"
        "只要当前帧能确认，就设置 should_reply=true 并给出 1-2 句短口语。普通移动、待机和重复画面仍保持安静。"
        if is_window
        else "整屏观察继续保持克制，只有明确的新进展、错误、结果或值得回应的内容才开口。"
    )
    persona_context = _screen_persona_context()
    detailed_prompt = f"""你同时负责看懂画面，并替 Mio 决定此刻是否自然开口。一次完成，不要再把任务交给另一个模型。

Mio 当前属性摘要：
{persona_context}

画面类型：{observation_kind}
窗口标题：{frame.get('title') or observation_kind}
捕获时间：{frame.get('captured_at') or '刚刚'}
自上次分析后的最大变化：{float(frame.get('change_percent') or 0):.1f}%
处理后尺寸：{frame_metadata.get('width', '?')}x{frame_metadata.get('height', '?')}

当前状态：
{game_state_summary(state)}

当前前台应用：{activity['process_name'] or '未记录'}
当前前台窗口：{activity['foreground_title'] or frame.get('title') or '未记录'}
        {self_ui_rule}
        {cursor_context}
应用类型判断：{activity['kind']}
应用判断提示：{activity['guidance']}
最近系统声音台词：{_audio_context()}
距离上次开口：约 {max(0, int(seconds_since_last_speech))} 秒

最近观察：
{_observation_lines(recent_observations)}

最近对话：
{_recent_context(conversation_id)}

{privacy_rule}
{wake_rule}
{rhythm_rule}
{game_reply_rule}

先客观识别一个明确的事件，再根据 Mio 当前属性判断她此刻是否真的会说话。
必须先判断用户当前是在操作什么应用，再解释画面内容。浏览器、哔哩哔哩、视频网站或播放器里出现游戏画面时，
优先判断为 watching_game_video，不能说成用户正在玩游戏；电影、番剧和剧情视频使用 watching_movie。
用户确实在运行原生游戏并操作时才使用 gameplay 等游戏事件。写代码、写作、阅读和浏览分别使用 coding、writing、reading、browsing。
系统声音台词只作为画面的补充证据：结合前台应用和画面理解人物正在说什么，不要把视频台词当成用户对你说话。
台词中可能混入 Mio 刚刚播放的语音；与最近对话中 Mio 的话相同或近似时忽略它。
Mio 要按当前属性里定义的关系和语气回应用户，不是旁白、客服或攻略机器人。不要播报画面，不要说截图、识图、模型或内部判断。
需要回应时只说 1-2 句短口语，每句尽量不超过 28 个字；不要复述用户正在做什么，不要用“我看到了”“我注意到”。
观看电影或番剧时，可以只围绕当前明确的剧情、角色行为、镜头或气氛讨论一句；不要剧透，不要猜没有出现的情节。
不确定游戏名、Boss、位置和结果时留空，不要猜。情绪只能使用 neutral、gentle、cheerful、concerned、serious、shy。

只输出一个 JSON 对象，不要代码块，字段必须完整：
{{
  "event": "idle、movement、exploration、gameplay、activity_change、activity_progress、activity_pause、interesting_content、watching_game_video、watching_video、watching_movie、coding、writing、reading、browsing、menu、loading、death、failure、victory、progress、boss_battle、boss_phase、low_health、danger、rare_reward、achievement、match_result、stuck、dialogue_choice、cutscene_turn、error、warning、notable_scene 或 unknown",
  "summary": "客观画面摘要，最多 60 字",
  "confidence": 0.0,
  "game": "能确认时填写，否则空字符串",
  "state": {{"boss":"","location":"","phase":"","objective":"","mode":"","outcome":"","health_status":""}},
  "tags": [],
  "should_reply": false,
  "importance": 0.0,
  "emotion": "neutral",
  "reply": "不需要说话时为空字符串",
  "reason": "一句简短原因"
}}"""
    prompt = detailed_prompt if (wake or interactive) else _compact_combined_prompt(
        frame,
        recent_observations,
        state,
        frame_metadata,
        conversation_id,
        seconds_since_last_speech=seconds_since_last_speech,
    )
    return [
        {
            "role": "system",
            "content": (
                "你是 Mio 的低延迟多模态感知与反应核心。你必须在一次响应中完成客观识别、"
                "开口判断和自然短回复，并严格返回 JSON。"
            ),
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_url, "detail": "low"}},
            ],
        },
    ]


def _analysis_messages(
    frame: dict[str, Any],
    recent_observations: list[Any] | None = None,
    state: dict[str, Any] | None = None,
    frame_metadata: dict[str, Any] | None = None,
    *,
    local_vision: bool = True,
) -> list[dict[str, Any]]:
    image_url = "data:image/jpeg;base64," + base64.b64encode(frame["content"]).decode("ascii")
    cursor_context = _cursor_prompt_context(frame)
    is_window = str(frame.get("mode") or "") == "window"
    observation_kind = "指定窗口" if is_window else "整个屏幕"
    privacy_rule = ""
    if not is_window:
        privacy_rule = (
            ("这是本地隐私识别。" if local_vision else "这是用户主动选择的云端整屏识别。")
            + "不要转录屏幕上的聊天、通知、账号、文件名、路径、网址、密钥、验证码或其他原文；"
            "只概括用户活动和可回应事件。"
        )
    self_ui_rule = (
        "The foreground may be Mio's own chat or pet window. Ignore Mio's old chat text, bubbles, subtitles, and pet content; never treat them as the user's current activity."
        if _is_self_ui_foreground(frame)
        else "If Mio's own interface appears in the image, treat it only as an overlay and never use its historical text as current activity."
    )
    event_examples = (
        "idle、movement、exploration、gameplay、activity_change、activity_progress、activity_pause、"
        "interesting_content、watching_game_video、watching_video、watching_movie、coding、writing、"
        "reading、browsing、menu、loading、death、failure、"
        "victory、progress、boss_battle、boss_phase、low_health、danger、rare_reward、achievement、"
        "match_result、stuck、dialogue_choice、cutscene_turn、error、warning、notable_scene、unknown"
    )
    event_examples = self_ui_rule + "\n" + event_examples
    metadata = frame_metadata or {}
    activity = _activity_context(frame)
    prompt = f"""识别当前画面最明确的一件事，只返回 JSON。
画面：{observation_kind}；标题：{frame.get('title') or observation_kind}；变化：{float(frame.get('change_percent') or 0):.1f}%；尺寸：{metadata.get('width', '?')}x{metadata.get('height', '?')}
前台：{activity['process_name'] or '未记录'} / {activity['foreground_title'] or frame.get('title') or '未记录'}；类型：{activity['kind']}
{cursor_context}
状态：{game_state_summary(state or {})[:360]}
最近：{_observation_lines((recent_observations or [])[-3:])[:360]}
声音：{_audio_context()[:180]}

规则：
1. 先判断应用，再判断内容。原生游戏才用 gameplay；网页或播放器中的游戏用 watching_game_video，番剧/剧情视频用 watching_movie。
2. Galgame 对白或立绘推进属于 gameplay/cutscene_turn；出现可选项用 dialogue_choice。普通移动、静止或只有小动画用 movement/idle。
3. 工作成果用 activity_progress；等待或卡住用 activity_pause；代码、写作、阅读、网页分别用 coding、writing、reading、browsing。
4. 系统声音只作辅助，不能当用户对 Mio 说话。不要猜游戏名、剧情、结果。{privacy_rule}

事件可选：{event_examples}
JSON：{{"event":"idle","summary":"最多60字","confidence":0.0,"game":"","state":{{"boss":"","location":"","phase":"","objective":"","mode":"","outcome":"","health_status":""}},"tags":[]}}"""
    return [
        {
            "role": "system",
            "content": (
                "你是严格的视觉事件识别器。只描述可确认的事实，返回结构化 JSON。"
                "你不扮演角色，不输出建议，不决定是否回应用户。"
            ),
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        },
    ]


def _local_analysis_parts(messages: list[dict[str, Any]]) -> tuple[str, str]:
    system_prompt = str(messages[0].get("content") or "")
    user_content = messages[1].get("content")
    if not isinstance(user_content, list):
        raise ValueError("本地视觉提示词格式不正确")
    text_item = next(
        (item for item in user_content if isinstance(item, dict) and item.get("type") == "text"),
        None,
    )
    if not isinstance(text_item, dict):
        raise ValueError("本地视觉提示词缺少文字内容")
    return system_prompt, str(text_item.get("text") or "")


def _safe_observation_for_cloud(observation: Observation) -> Observation:
    return Observation(
        event_type=observation.event_type,
        summary=LOCAL_SCREEN_SAFE_SUMMARIES.get(
            observation.event_type,
            "用户当前屏幕出现了一处值得回应的变化",
        ),
        confidence=observation.confidence,
        game_name="",
        details={},
        tags=(),
    )


def _clean_reply(content: str) -> str:
    clean = str(content or "").strip()
    clean = re.sub(r"```(?:text)?|```", "", clean, flags=re.IGNORECASE).strip()
    if not clean or re.fullmatch(r"(?:NO_REPLY|不回复|无需回复)[。.!！\s]*", clean, re.IGNORECASE):
        return ""
    return clean


def _parse_observation(content: str) -> Observation:
    clean = str(content or "").strip()
    clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", clean, flags=re.IGNORECASE).strip()
    start = clean.find("{")
    end = clean.rfind("}")
    if start < 0 or end <= start:
        legacy = _clean_reply(clean)
        return Observation(
            event_type="notable_scene" if legacy else "idle",
            summary=legacy[:200] if legacy else "画面没有明确的新事件",
            confidence=0.75 if legacy else 0.9,
            game_name="",
            details={},
            tags=(),
        )
    try:
        payload = json.loads(clean[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("视觉模型返回的观察 JSON 无法读取") from exc
    if not isinstance(payload, dict):
        raise ValueError("视觉模型返回的观察不是对象")
    try:
        confidence = max(0.0, min(1.0, float(payload.get("confidence") or 0)))
    except (TypeError, ValueError):
        confidence = 0.0
    details = payload.get("state") if isinstance(payload.get("state"), dict) else {}
    tags = payload.get("tags") if isinstance(payload.get("tags"), list) else []
    event_type = normalize_event_type(str(payload.get("event") or "unknown"))
    summary = " ".join(str(payload.get("summary") or "画面事件不明确").split())[:240]
    return Observation(
        event_type=event_type,
        summary=summary,
        confidence=confidence,
        game_name=" ".join(str(payload.get("game") or "").split())[:160],
        details={str(key): value for key, value in details.items()},
        tags=tuple(" ".join(str(item).split())[:40] for item in tags[:5] if str(item).strip()),
    )


def _parse_combined_vision_result(content: str) -> CombinedVisionResult:
    clean = re.sub(
        r"^```(?:json)?\s*|\s*```$",
        "",
        str(content or "").strip(),
        flags=re.IGNORECASE,
    ).strip()
    start = clean.find("{")
    end = clean.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("多模态模型没有返回可读取的 JSON")
    try:
        payload = json.loads(clean[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("多模态模型返回的 JSON 无法读取") from exc
    if not isinstance(payload, dict):
        raise ValueError("多模态模型返回的结果不是对象")
    observation = _parse_observation(json.dumps(payload, ensure_ascii=False))
    try:
        importance = max(0.0, min(1.0, float(payload.get("importance") or 0)))
    except (TypeError, ValueError):
        importance = 0.0
    emotion = str(payload.get("emotion") or "neutral").strip().lower()
    if emotion not in {"neutral", "gentle", "cheerful", "concerned", "serious", "shy"}:
        emotion = "neutral"
    should_reply = payload.get("should_reply") is True
    reply = _clean_reply(str(payload.get("reply") or ""))
    return CombinedVisionResult(
        observation=observation,
        should_reply=should_reply and bool(reply),
        importance=importance,
        emotion=emotion,
        reply=reply,
        reason=" ".join(str(payload.get("reason") or "").split())[:160],
    )


def _custom_instruction_block() -> str:
    """用户自定义的观察提示词（设置页「观察提示词」）。

    空字符串返回空串，不往 prompt 里塞占位符 —— 默认行为保持原样。
    用户原话示例：「锐评一下此刻的电脑屏幕画面」。
    """
    try:
        config = companion_service.load_config()
    except Exception:  # noqa: BLE001 - 读配置失败不能拖垮整轮观察
        return ""
    raw = str(config.get("screen_observation_prompt") or "").strip()
    if not raw:
        return ""
    # 截断到合理长度，避免用户粘贴一整篇文档把上下文顶爆
    text = raw[:2000]
    return (
        "\n【用户对这次观察的专门要求，优先级高于上面的默认口吻】\n"
        f"{text}\n"
        "仍然只输出要对用户说的话（1-2 句短话），不要解释你在遵守这条要求。\n"
    )


def _reaction_messages(
    observation: Observation,
    decision: Any,
    state: dict[str, Any],
    conversation_id: str,
) -> list[dict[str, str]]:
    activity = _activity_context()
    persona_context = _screen_persona_context()
    prompt = f"""你正和用户待在一起，眼前刚发生了一件值得开口的事。

Mio 当前属性摘要：
{persona_context}

客观观察：{observation.summary}
事件类型：{observation.event_type}
可信度：{observation.confidence:.0%}
行为层决定：{decision.reason}
连续次数：{decision.repeat_count}
当前活动状态：{game_state_summary(state)}
当前前台应用：{activity['process_name'] or '未记录'}
当前前台窗口：{activity['foreground_title'] or '未记录'}
应用类型判断：{activity['kind']}
应用判断提示：{activity['guidance']}
最近系统声音台词：{_audio_context()}

最近对话：
{_recent_context(conversation_id)}

先想清楚：按 Mio 当前属性定义的关系，一个就在用户旁边的熟人此刻真的会说什么。只挑一个最自然的反应，不要总结整幅画面。
{_custom_instruction_block()}
可以是简短感受、轻微吐槽、关心、替用户高兴，或对眼前局面的随口反应；没有必要时不要追问。
只说 1-2 句短话，每句尽量不超过 28 个字。
不要报告截图、识图、事件类型、可信度或内部判断过程。
不要像攻略机器人逐项分析，不确定的玩法细节不要编造。
如果用户在看游戏视频，不得说成用户正在玩；如果在看电影或番剧，只讨论画面中已经明确出现的剧情、角色或气氛，不剧透也不猜后续。
可以结合刚听到的台词接剧情或人物反应，但不要逐句复读台词，也不要把视频中的话当成用户在和你说话。
不要用“我看到了”“看起来”“我注意到”“我会在旁边”“我会静静看着”“我会陪着你”来说明自己的功能或存在。
不要每次都先说“嗯”，不要复述“你正在做什么”。
只输出真正要对用户说的话，不要 Markdown，不要情绪标签。"""
    return [
        {
            "role": "system",
            "content": (
                "你是 Mio，具体身份、关系、称呼和语气以本轮提供的 Mio 当前属性摘要为准。"
                "你不是旁白、客服或攻略助手，像坐在用户旁边的人，只在值得开口时自然说一句。"
                "你不会对每个动作发表评论，也不会假装知道不确定的事情。"
            ),
        },
        {"role": "user", "content": prompt},
    ]


def _wake_reaction_messages(
    observation: Observation,
    state: dict[str, Any],
    conversation_id: str,
) -> list[dict[str, str]]:
    activity = _activity_context()
    persona_context = _screen_persona_context()
    prompt = f"""你刚刚随桌宠窗口一起醒来，第一眼看见了用户当前的电脑画面。

Mio 当前属性摘要：
{persona_context}

你看见的内容：{observation.summary}
当前画面状态：{game_state_summary(state)}
当前前台应用：{activity['process_name'] or '未记录'}
当前前台窗口：{activity['foreground_title'] or '未记录'}
应用类型判断：{activity['kind']}
应用判断提示：{activity['guidance']}
最近系统声音台词：{_audio_context()}

最近对话：
{_recent_context(conversation_id)}

先理解画面和时间感，再决定此刻最自然的一句话。优先回应眼前具体的细节，不要介绍自己的观察能力。
{_custom_instruction_block()}
像熟人刚坐到旁边那样开口，可以随口接一句、轻微吐槽或简单问候，不要做场景播报。
只说 1-2 句简短口语，每句尽量不超过 28 个字。普通桌面也要自然开口，不要强行找话题。
不要说截图、识图、模型、事件、可信度、分析或“我醒了”。
不要用“我看到了”“你正在……”“我会在旁边”“我会静静看着”“我会陪着你”这类模板句。
不要每次都以“嗯”开头，也不要承诺会一直做什么。
不要描述自己的思考过程，不要 Markdown，不要情绪标签。"""
    return [
        {
            "role": "system",
            "content": (
                "你是刚刚来到用户桌面的 Mio，具体身份、关系、称呼和语气以本轮提供的 Mio 当前属性摘要为准。"
                "你能直接看见当前电脑画面，像陪在用户旁边的人一样自然说话。"
            ),
        },
        {"role": "user", "content": prompt},
    ]


def _budget_state(config: dict[str, Any]) -> dict[str, Any]:
    daily = db.get_screen_analysis_usage()
    daily_cost_limit = float(config.get("screen_daily_cost_limit_yuan", 5.0))
    with _state_lock:
        session_count = _session_request_count
        generation_count = _session_generation_count
        attempt_count = _session_attempt_count
        failure_count = _session_failure_count
    session_costs = db.get_screen_analysis_costs_since(_session_started_at)
    session_pending = int(session_costs["pending_request_count"]) + max(
        0,
        session_count - int(session_costs["tracked_request_count"]),
    )
    paused_reason = ""
    if float(daily["budget_cost_yuan"]) >= daily_cost_limit:
        paused_reason = f"今天的屏幕观察费用已达到 ¥{daily_cost_limit:.2f} 上限"
    return {
        "paused": bool(paused_reason),
        "paused_reason": paused_reason,
        "session_started_at": _session_started_at,
        "session_request_count": session_count,
        "session_generation_count": generation_count,
        "session_attempt_count": attempt_count,
        "session_failure_count": failure_count,
        "session_cost_yuan": round(float(session_costs["confirmed_cost_yuan"]), 6),
        "session_confirmed_request_count": int(session_costs["confirmed_request_count"]),
        "session_unknown_cost_count": session_pending,
        "daily": daily,
        "daily_cost_limit_yuan": daily_cost_limit,
    }


def _record_completion_usage(completion: Any, *, analysis: bool) -> None:
    global _session_request_count, _session_generation_count
    global _session_cost_yuan, _session_unknown_cost_count
    request_id = uuid.uuid4().hex
    cost_references = tuple(getattr(completion, "cost_references", ()) or ())
    cost_source = (
        "provider_reconciliation_pending"
        if cost_references
        else str(getattr(completion, "cost_source", "") or "")
    )
    db.record_screen_analysis_usage(
        prompt_tokens=completion.prompt_tokens,
        completion_tokens=completion.completion_tokens + completion.reasoning_tokens,
        cost_yuan=completion.cost_yuan,
        request_id=request_id,
        request_kind="analysis" if analysis else "reaction",
        model_id=str(getattr(completion, "model", "") or ""),
        cost_source=cost_source,
    )
    queue_cost_reconciliation(
        request_id,
        f"screen_analysis:{db.today_string()}",
        cost_references,
    )
    with _state_lock:
        if analysis:
            _session_request_count += 1
        else:
            _session_generation_count += 1
        if cost_source == "provider_reported" and completion.cost_yuan is not None:
            _session_cost_yuan += max(0.0, float(completion.cost_yuan))
        elif cost_source in {"local", "local_fallback"}:
            pass
        elif cost_source == "cloud_feiyu_unmetered":
            # ★ 云端大肥鱼按人计费，本机拿不到单价：既不能算 0 元（会显得"免费"），
            #   也不能计入 _session_unknown_cost_count —— 那个计数是"本地预算未知花费"的
            #   信号，算进去会让设置页一直提示"有未知花费"。
            pass
        else:
            _session_unknown_cost_count += 1


def _combined_cost(*values: float | None) -> float | None:
    return sum(float(value) for value in values) if all(value is not None for value in values) else None


def _agent_media_dir() -> Path:
    """与 routes/companion.py 的 agent_media 同一目录：渲染端用同一个 URL 前缀拉。"""
    directory = companion_service.live2d_state_dir() / "agent_media"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _save_observation_voice(blob: bytes, *, emotion: str) -> dict[str, Any] | None:
    """把合成好的语音落盘，返回渲染端可拉的短 URL（形状与 agent_audio 一致）。"""
    import hashlib

    if not blob:
        return None
    ext = ".wav" if blob[:4] in (b"RIFF",) else ".mp3"
    digest = hashlib.sha256(blob).hexdigest()[:16]
    name = f"{digest}{ext}"
    target = _agent_media_dir() / name
    try:
        if not target.is_file() or target.stat().st_size != len(blob):
            target.write_bytes(blob)
    except OSError as exc:
        with _state_lock:
            _last_error = f"观察语音落盘失败：{exc}"
        return None
    return {
        "media": "audio",
        "url": f"/api/companion/agent-media/{name}",
        "filename": name,
        "mime_type": "audio/wav" if ext == ".wav" else "audio/mpeg",
        "size": len(blob),
        "emotion": emotion or "neutral",
    }


async def _deliver_observation(
    *,
    reply: str,
    emotion: str,
    request_id: str,
    config: dict[str, Any],
    source_is_game: bool,
    allow_direct_speech: bool | None,
) -> None:
    """把这一轮观察推到桌宠：文字进气泡，按开关再补一条语音。

    用户裁决（m02056）：语音做成开关而不是概率；有语音就都带文字，
    所以文字永远先发，语音只是叠加，不会把文字顶掉。
    """
    voice_on = bool(config.get("screen_observation_voice_enabled", True))
    speak_on = bool(config.get("voice_enabled", True)) and bool(
        config.get("speak_game_observations", True)
        if source_is_game
        else config.get("speak_screen_observations", False)
    )
    # 2026-10-24 修正：**不要把 allow_direct_speech 当语音总闸**。
    # 那个值来自旧的 screen_direct_voice_enabled（"直接语音"老开关，默认 false），
    # 它管的是「旧版本地 TTS 直接念」这条已经断掉的路，跟用户新要的
    # 「观察结果走云端 AstrBot 合成语音」是两回事。拿它当总闸会出现：
    # 用户明明打开了「观察语音播报」，语音却永远不响。
    # 这里只看两个新开关：观察语音开关 + 该来源的播报开关。
    want_voice = voice_on and speak_on
    _ = allow_direct_speech  # 保留形参兼容旧调用方，不再参与判定

    # 文字：走 agent_audio 同族的 agent_bubble 通道，让桌宠气泡即时说话
    # （pet_event_service 的 speak 事件只看 messages 表，观察已经落库，会自然跟上）
    payload: dict[str, Any] = {
        "text": reply,
        "agent_id": "screen",
        "source": "game" if source_is_game else "screen",
        "request_id": request_id,
        "emotion": emotion or "neutral",
        # ★ 2026-10-24 用户裁决：气泡停留 6~8 秒（原 3 秒看不清就没了）。
        #   这里按字数给 6000~8000；渲染端 bubbleHoldMs() 会再夹一次上下限。
        "hold_ms": max(6000, min(8000, len(reply) * 120)),
    }

    # ★★ 2026-10-24 用户实拍「文字气泡没出现」的真根因（这里）：
    #   原实现是「先 await 合成语音，成功了才发文字气泡」。云端 TTS 一次要几秒到十几秒，
    #   期间**文字气泡一帧都没发出去**；气泡本身 3~20 秒就会自动收起，等语音回来才发，
    #   用户看到的往往是"什么也没有"，或者文字挤在语音之后一闪而过。
    #   文档里写的是"文字永远先发，语音只是叠加"，实现却反着来 —— 现在按文档来：
    #     ① **立刻**发文字气泡（这一句和语音无关，任何情况下都该出现）；
    #     ② 语音合成放在后面**独立** try 里，成功就再补一帧 agent_audio。
    pet_event_service.publish("agent_bubble", payload)

    if not want_voice:
        return

    try:
        from ..cloud_feiyu import tts as cloud_tts

        blob = await cloud_tts.synthesize(reply)
    except Exception as exc:  # noqa: BLE001 - 语音是增强，失败不能吞掉文字
        # 文字上面已经发出去了，这里只记账，不再重复发气泡
        with _state_lock:
            _last_error = f"观察语音合成失败（文字气泡已正常发出）：{exc}"
        return

    saved = _save_observation_voice(blob, emotion=emotion)
    if not saved:
        # 语音落盘失败：文字气泡已发过，不重复
        return
    # 文字气泡上面已先发；这里只补语音（用户明确要"语音对应的文字也显示在气泡里"，
    # 而文字气泡此刻仍然挂在桌面上，不会被这条语音顶掉）
    pet_event_service.publish(
        "agent_audio",
        {
            **saved,
            "text": reply,
            "agent_id": "screen",
            "source": payload["source"],
            "request_id": request_id,
            "response_id": request_id,
        },
    )


def _trigger_bounds_seconds(config: dict[str, Any]) -> tuple[float, float]:
    """随机触发的区间（秒）。保证下限 <= 上限，否则配置写反会永远不触发。"""
    minimum = max(1, min(1440, int(config.get("screen_trigger_min_minutes", 60)))) * 60.0
    maximum = max(1, min(1440, int(config.get("screen_trigger_max_minutes", 120)))) * 60.0
    if maximum < minimum:
        minimum, maximum = maximum, minimum
    return minimum, maximum


def _schedule_next_trigger(config: dict[str, Any], *, now: float) -> None:
    """在 [min, max] 里均匀抽一个等待时长，安排下一次观察。"""
    global _trigger_next_monotonic, _trigger_span_seconds
    import random

    minimum, maximum = _trigger_bounds_seconds(config)
    span = random.uniform(minimum, maximum)
    with _state_lock:
        _trigger_span_seconds = int(round(span))
        _trigger_next_monotonic = now + span


def _trigger_status(config: dict[str, Any]) -> dict[str, Any]:
    """给设置页看的触发状态：开关、区间、下次倒计时、上次间隔。

    注意：`status()` 是在 `_state_lock` 里调用本函数的，所以这里**绝不能再加锁**
    （threading.Lock 不可重入，会直接把 /screen/preview 和 /status 挂死 —— 已踩过）。
    读的只是几个标量，不加锁读也不会读到撕裂值。
    """
    now = time.monotonic()
    minimum, maximum = _trigger_bounds_seconds(config)
    next_at = _trigger_next_monotonic
    span = _trigger_span_seconds
    last_fire = _trigger_last_fire_monotonic
    last_span = _trigger_last_span_seconds
    return {
        "random_enabled": bool(config.get("screen_trigger_random_enabled", True)),
        "min_minutes": int(minimum // 60),
        "max_minutes": int(maximum // 60),
        "next_span_seconds": span,
        "seconds_until_next": max(0, int(round(next_at - now))) if next_at else None,
        "last_fire_age_seconds": (
            max(0, int(round(now - last_fire))) if last_fire else None
        ),
        "last_span_seconds": last_span,
    }


def _trigger_due(config: dict[str, Any]) -> bool:
    """到点没有？顺手在需要时初始化/续约下一次触发。"""
    if not bool(config.get("screen_trigger_random_enabled", True)):
        return True
    now = time.monotonic()
    with _state_lock:
        next_at = _trigger_next_monotonic
    if next_at <= 0:
        _schedule_next_trigger(config, now=now)
        return False
    return now >= next_at


def reschedule_trigger() -> None:
    """用户在设置页改了触发区间/开关后，立刻按新区间重排下一次触发。

    不这么做的话旧的下一次时刻会一直挂着（实测把 60–120 分钟改成 1 分钟后，
    seconds_until_next 仍是 5464 秒），用户改完要等一个多小时才生效。
    """
    config = companion_service.load_config()
    _schedule_next_trigger(config, now=time.monotonic())


def _trigger_consumed(config: dict[str, Any]) -> None:
    """这一轮真的观察成功了，才安排下一次（失败不消耗，下一轮继续重试）。"""
    global _trigger_last_fire_monotonic, _trigger_last_span_seconds
    now = time.monotonic()
    with _state_lock:
        _trigger_last_fire_monotonic = now
        _trigger_last_span_seconds = _trigger_span_seconds
    _schedule_next_trigger(config, now=now)


def status() -> dict[str, Any]:
    config = companion_service.load_config()
    observer_status = companion_service.window_observer.status()
    is_window = str(observer_status.get("mode") or "screen") == "window"
    # ★ 2026-10-24 用户裁决：桌宠端不需要任何模型 API，识图恒走云端大肥鱼。
    #   这里不再探测本地视觉模型（Ollama）状态，也不再列出"可用的云端 VL 模型"——
    #   那两样都会让状态面板看起来像"本机需要配模型"。本地视觉只在关机清理时停一下服务，
    #   见 companion_service.shutdown 与 routes 里的 unload_model 调用。
    feiyu_reason = _feiyu_unavailable_reason()
    feiyu_client = None
    try:
        from ..cloud_feiyu import get_client as get_feiyu_client

        feiyu_client = get_feiyu_client()
    except Exception:  # noqa: BLE001 - 状态面板永远不该抛
        feiyu_client = None
    budget = _budget_state(config)
    cloud_health = _cloud_health_status(
        [
            ModelProfile(
                id=FEIYU_VISION_HEALTH_ID,
                provider_name="AstrBot",
                display_name="大肥鱼（云端）",
                model="astrbot",
                base_urls=(),
                api_key="",
            )
        ]
    )
    with _state_lock:
        return {
            "enabled": bool(config.get("screen_ai_enabled", True)),
            "capture_only": _capture_only,
            "capture": dict(observer_status),
            "vision_available": not feiyu_reason,
            # 这两项保留形状（前端仍在读），但内容只剩云端大肥鱼
            "vision_models": [FEIYU_VISION_HEALTH_ID],
            "vision_model_options": [
                {
                    "id": FEIYU_VISION_HEALTH_ID,
                    "label": "大肥鱼（云端）",
                    "model": "astrbot",
                    "low_latency_rank": 0,
                }
            ],
            "selected_vision_model_id": FEIYU_VISION_HEALTH_ID,
            "configured_vision_model_id": FEIYU_VISION_HEALTH_ID,
            "using_fallback_vision_model": False,
            "vision_route": "feiyu",
            "vision_route_label": "云端大肥鱼 · 图 + 提示词直接发云端，她亲自看图回话",
            # 云端大肥鱼没配好时的具体原因（status 面板直接展示，免得用户猜）
            "vision_unavailable_reason": feiyu_reason,
            "feiyu": (
                {
                    "base_url": getattr(feiyu_client, "base_url", ""),
                    "session_id": getattr(feiyu_client, "session_id", ""),
                    "configured": bool(getattr(feiyu_client, "is_configured", False)),
                },
            ),
            # 保留 local_vision 这个键（前端还在读），但明确告知"本机不跑视觉模型"
            "local_vision": {"enabled": False, "reason": "桌宠端不使用本地模型，识图全部走云端大肥鱼"},
            "cloud_profile_health": cloud_health,
            "in_progress": _in_progress,
            "last_analyzed_at": _last_analyzed_at,
            "last_reply": _last_reply,
            "last_error": _last_error,
            "capture_diagnostic": (
                "捕获进程未运行"
                if not bool(observer_status.get("running"))
                else str(observer_status.get("capture_health") or "捕获状态未知")
            ),
            "last_model": _last_model,
            "last_reaction_model": _last_reaction_model,
            "last_cost_yuan": _last_cost_yuan,
            "last_event_type": _last_event_type,
            "last_event_summary": _last_event_summary,
            "last_event_importance": _last_event_priority,
            "last_event_confidence": _last_event_confidence,
            "last_emotion": _last_emotion,
            "game_state": dict(_last_game_state),
            "pipeline_timings": dict(_last_pipeline_timings),
            "change_threshold": float(config.get("screen_change_threshold", 8.0)),
            "effective_change_threshold": round(
                _effective_change_threshold(config, observer_status),
                2,
            ),
            "minimum_interval_seconds": int(config.get("screen_analysis_interval_seconds", 5)),
            # 2026-10-24：随机长间隔触发状态（下次触发倒计时由 _trigger 状态机维护）
            "trigger": _trigger_status(config),
            "request_timeout_seconds": int(config.get("screen_request_timeout_seconds", 25)),
            "voice_cooldown_seconds": int(config.get("screen_voice_cooldown_seconds", 5)),
            "minimum_importance": float(config.get("screen_minimum_importance", 0.62)),
            "budget": budget,
        }


def runtime_health_status() -> dict[str, Any]:
    """Return observation health without model, file, or network probes."""
    config = companion_service.load_config()
    observer_status = companion_service.window_observer.status()
    with _state_lock:
        return {
            "enabled": bool(config.get("screen_ai_enabled", True)),
            "capture": observer_status,
            "analysis_in_progress": _in_progress,
            "last_analyzed_at": _last_analyzed_at,
            "last_error": _last_error,
            "last_model": _last_model,
            "last_pipeline_timings": dict(_last_pipeline_timings),
            "session_attempt_count": _session_attempt_count,
            "session_failure_count": _session_failure_count,
        }


def _newer_frame_supersedes(
    analyzed_frame_id: int,
    observer_status: dict[str, Any],
    *,
    change_threshold: float,
) -> bool:
    return bool(
        int(observer_status.get("frame_id") or 0) > int(analyzed_frame_id)
        and float(observer_status.get("pending_change_percent") or 0)
        >= max(float(change_threshold), GAME_WINDOW_MIN_CHANGE_THRESHOLD)
    )


def _effective_change_threshold(config: dict[str, Any], observer_status: dict[str, Any]) -> float:
    """Return the capture gate for the current scope.

    A selected game window uses a lower gate because a dialogue box or a
    character portrait can change without materially changing the whole
    frame.  Full-screen observation keeps the configured value to control
    upload frequency and cost.
    """
    configured = max(1.0, float(config.get("screen_change_threshold", 8.0)))
    if str(observer_status.get("mode") or "screen") == "window":
        return max(
            GAME_WINDOW_MIN_CHANGE_THRESHOLD,
            configured * GAME_WINDOW_CHANGE_FACTOR,
        )
    return configured


def _game_event_can_open(
    observation: Observation,
    decision: BehaviorDecision,
    *,
    event_is_new: bool,
    recent_summaries: list[str],
    seconds_since_last_speech: float,
    cooldown_seconds: int,
) -> bool:
    """Prevent a conservative multimodal should_reply flag from silencing a
    clearly new game event that already passed deterministic behavior gates.

    The model still supplies the wording; this only decides whether a
    qualifying event is allowed to use that wording (or the local fallback).
    """
    is_game = bool(observation.game_name) or observation.event_type in GAME_EVENT_TYPES
    if not is_game or not event_is_new or observation.event_type not in GAME_EVENT_REPLY_TYPES:
        return False
    if not decision.should_speak:
        return False
    if observation.confidence < 0.5 or decision.priority < 0.5:
        return False
    if is_duplicate_summary(observation.summary, recent_summaries):
        return False
    # Dialogue/choice/cutscene changes should feel responsive; major events
    # continue to use the regular event policy and cooldown.
    minimum_gap = 8.0 if observation.event_type in {"dialogue_choice", "cutscene_turn"} else 12.0
    return seconds_since_last_speech >= max(minimum_gap, float(cooldown_seconds))


@operation("vision", automatic=True, persist=False)
async def analyze_once(
    *,
    force: bool = False,
    wake: bool = False,
    interactive: bool = False,
    conversation_id: str = "",
    request_id: str = "",
    allow_direct_speech: bool | None = None,
    skip_self_ui_gate: bool = False,
) -> bool:
    global _in_progress, _last_analysis_monotonic, _last_analyzed_at
    global _last_analyzed_frame_id, _last_reply, _last_error, _last_model
    global _last_reaction_model, _last_cost_yuan, _last_event_type
    global _last_event_summary, _last_event_priority, _last_event_confidence
    global _last_emotion, _last_game_state, _last_spoken_monotonic
    global _last_pipeline_timings
    global _session_attempt_count, _session_failure_count

    pipeline_started = time.monotonic()
    config = companion_service.load_config()
    with _state_lock:
        capture_only = _capture_only
    if capture_only:
        return False
    # The privacy switch is authoritative even for explicit wake/manual calls.
    # A stale observation task must never turn a disabled cloud/local AI route
    # back into a model request after settings were changed.
    if not bool(config.get("screen_ai_enabled", True)):
        with _state_lock:
            _last_error = "屏幕 AI 已关闭；仅保留画面捕获，不会发起分析请求。"
        return False
    observer_status = companion_service.window_observer.status()
    if not force and not observer_status["running"]:
        return False
    budget = _budget_state(config)
    if budget["paused"]:
        with _state_lock:
            _last_error = f"AI 屏幕分析已暂停：{budget['paused_reason']}。本地画面接收仍在运行。"
        return False

    now = time.monotonic()
    minimum_interval = int(config.get("screen_analysis_interval_seconds", 5))
    # 2026-10-24 用户裁决（m02056）：随机长间隔模式下，「画面有没有变」不再是硬门槛 ——
    # 到点就该看一眼（1~2 小时才触发一次，静止画面也要能出观察结果）。
    # 秒级节流在随机模式下也不再适用，否则 60 分钟档位会被 5 秒节流反复拒绝。
    random_trigger = bool(config.get("screen_trigger_random_enabled", True))
    with _state_lock:
        if _in_progress:
            return False
        if not force and not random_trigger and now - _last_analysis_monotonic < minimum_interval:
            return False
        last_frame_id = _last_analyzed_frame_id
    if not force and random_trigger and not _trigger_due(config):
        return False
    pending_change = float(observer_status.get("pending_change_percent") or 0)
    change_threshold = _effective_change_threshold(config, observer_status)
    if not force and not random_trigger and last_frame_id > 0 and pending_change < change_threshold:
        return False

    # ★ 2026-10-24 用户裁决：桌宠端不需要任何模型 API，识图恒走云端大肥鱼。
    #   下面不再有 use_local_vision / 普通云端两个分支（连同它们要求的本机模型配置）。
    _ = _vision_routes(config)  # 保留唯一开关点：将来要加通路只改这里
    feiyu_reason = await asyncio.to_thread(_feiyu_unavailable_reason)
    if feiyu_reason:
        with _state_lock:
            _last_error = f"{feiyu_reason}。画面捕获仍在运行，本轮不发云端。"
        return False

    frame = companion_service.window_observer.claim_analysis_frame(last_frame_id)
    if frame is None:
        with _state_lock:
            _last_error = "当前没有取得有效的新画面；捕获器可能已过期、失败或目标窗口已最小化。"
            _last_pipeline_timings = {
                "frame_claimed": False,
                "frame_claim_failure": "no_fresh_frame",
            }
        return False
    frame_age_seconds = frame.get("frame_age_seconds")
    if frame_age_seconds is not None and float(frame_age_seconds) > MAX_SCREEN_FOLLOW_UP_FRAME_AGE_SECONDS:
        with _state_lock:
            _last_analyzed_frame_id = int(frame.get("frame_id") or 0)
            _last_error = (
                f"当前没有取得有效的新画面；最近一帧已过期 {float(frame_age_seconds):.1f} 秒。"
            )
            _last_pipeline_timings = {
                "frame_claimed": False,
                "frame_claim_failure": "stale_frame",
                "frame_age_seconds": round(float(frame_age_seconds), 3),
            }
        frame.clear()
        return False
    is_full_screen = str(frame.get("mode") or "screen") != "window"
    if is_full_screen and _is_self_ui_foreground(frame) and not (
        wake or interactive or skip_self_ui_gate
    ):
        # Full-screen capture includes Mio's own chat/WebView and Live2D windows.
        # Treating that UI as user activity feeds old chat text back into vision
        # and can cause stale story references and unsolicited speech.
        with _state_lock:
            _last_analyzed_frame_id = int(frame.get("frame_id") or 0)
            _last_analysis_monotonic = now
            _last_analyzed_at = str(frame.get("captured_at") or db.now_iso())
            _last_error = "已忽略 Mio 自身窗口；请切到要观察的应用"
            _last_pipeline_timings = {
                "self_ui_suppressed": True,
                "self_ui_process": _foreground_details().get("process_name", ""),
                "self_ui_title": _foreground_details().get("title", ""),
            }
        return False
    processed = process_frame(
        bytes(frame["content"]),
        # 只有云端一条路了：640x360 / q64 是当初给"上传到云端"定的体积档位
        max_width=640,
        max_height=360,
        jpeg_quality=64,
    )
    frame["content"] = processed.content
    vision_model_id = FEIYU_VISION_HEALTH_ID
    conversation_id = str(conversation_id or "").strip() or _desktop_pet_conversation_id()
    session_id = db.start_screen_session(
        str(frame.get("mode") or "screen"),
        str(frame.get("title") or ""),
        vision_model_id,
    )
    recent_observations = db.recent_observations(session_id)
    current_state = db.get_game_session_state(session_id)
    with _state_lock:
        _in_progress = True
        _last_error = ""
        _last_analysis_monotonic = now
        _last_pipeline_timings = {
            "started_at": db.now_iso(),
            "single_multimodal_call": True,
            "streamed_model": False,
            "transport_mode": "feiyu_sse",
            "vision_model_id": vision_model_id,
            "configured_vision_model_id": FEIYU_VISION_HEALTH_ID,
            # 只剩一条通路，不存在"回退到备用视觉模型"这个状态
            "using_fallback_vision_model": False,
            "image_width": processed.width,
            "image_height": processed.height,
            "image_encoded_bytes": len(processed.content),
        }

    cloud_result_ready = True
    try:
        request_timeout = max(5, int(config.get("screen_request_timeout_seconds", 25)))

        seconds_since_last_speech = (
            now - _last_spoken_monotonic if _last_spoken_monotonic else 1_000_000
        )
        with _state_lock:
            _session_attempt_count += 1
        # ★ 2026-10-24 用户裁决（m02071）：「图 + 提示词直接丢到云端，云端会回答」。
        #   原来云端这条路是"本机拼一大段 JSON 指令 → 云端模型吐 JSON → 本机再解析"，
        #   换成大肥鱼之后这条形状反而累赘：她本来就有人格和记忆，硬要 JSON 只会把
        #   她答成识图接口。现在只发一段自然语言指令 + 这一帧图，她的原话就是气泡内容。
        feiyu_started = time.monotonic()
        vision_completion = await asyncio.wait_for(
            _feiyu_vision_call(
                frame=frame,
                prompt=_feiyu_screen_prompt(
                    custom_prompt=str(config.get("screen_observation_prompt") or ""),
                    is_window=not is_full_screen,
                    frame=frame,
                    persona_context=_screen_persona_context(),
                    recent_context=_recent_context(conversation_id, limit=6, max_chars=120),
                    audio_context=_audio_context() if not is_full_screen else "",
                    foreground=_activity_context(frame),
                ),
                timeout_seconds=float(request_timeout),
            ),
            # 云端要上传图、跑多模态、还可能合成语音，25 秒的默认值对这条路偏紧
            timeout=max(float(request_timeout), 60.0),
        )
        with _state_lock:
            _last_pipeline_timings["feiyu_seconds"] = round(
                max(0.0, time.monotonic() - feiyu_started),
                3,
            )
        reply_text = _clean_reply(vision_completion.content)
        if not reply_text:
            raise RuntimeError("云端大肥鱼这次没有返回文字（可能只回了语音/图片）")
        # 本机只补一条"事件"记录（用于落库/状态面板/去重），不回传云端：
        # 云端已经看过图并给出了话，这里再做一次模型识别纯属重复花钱。
        observation = Observation(
            event_type="screen_observe",
            summary=" ".join(reply_text.split())[:200],
            confidence=0.8,
            game_name="",
            details={},
            tags=(),
        )
        combined_result = CombinedVisionResult(
            observation=observation,
            should_reply=True,
            importance=max(0.66, float(config.get("screen_minimum_importance", 0.62))),
            emotion="neutral",
            reply=reply_text,
            reason="云端大肥鱼直接看屏幕并回话",
        )
        with _state_lock:
            first_token_ms = getattr(vision_completion, "first_token_latency_ms", None)
            if first_token_ms is not None:
                _last_pipeline_timings["first_token_seconds"] = round(
                    max(0.0, float(first_token_ms)) / 1000,
                    3,
                )
            _last_pipeline_timings["vision_seconds"] = round(
                max(0.0, time.monotonic() - pipeline_started),
                3,
            )
        _record_completion_usage(vision_completion, analysis=True)
        observation = (
            combined_result.observation
            if combined_result is not None
            else _parse_observation(vision_completion.content)
        )
        # ★ 2026-10-24：原来这里会用"前台应用"去纠正模型给的事件类型，再把回复换成
        #   本地模板句（_fallback_reaction）。那套是给旧的"结构化 JSON 识别"分支准备的：
        #   模型只吐事件类型，本机再按类型套话。
        #   现在云端大肥鱼**自己看过图、自己写出的话**，拿模板句覆盖她等于把她的话丢了
        #   （实测：屏幕上明明是别的应用，她的原话被替换成「我看到了，继续吧」）。
        #   所以保留她自己的观察与回复，只纠正事件类型用于落库/统计。
        observation = _correct_observation_for_activity(observation, frame)
        if processed.nearly_blank and observation.event_type not in {"error", "warning"}:
            observation = Observation(
                event_type="black_screen",
                summary="画面接近全黑或没有可辨识内容",
                confidence=max(0.95, observation.confidence),
                game_name=observation.game_name,
                details=observation.details,
                tags=observation.tags,
            )

        occurred_at = str(frame.get("captured_at") or db.now_iso())
        event_is_new = is_new_event_occurrence(
            observation,
            recent_observations,
            occurred_at=occurred_at,
        )
        observation_id = db.save_observation(
            session_id=session_id,
            frame_id=int(frame["frame_id"]),
            game_name=observation.game_name,
            event_type=observation.event_type,
            summary=observation.summary,
            confidence=observation.confidence,
            details_json=json.dumps(
                {
                    "state": observation.details,
                    "tags": list(observation.tags),
                    "frame": processed.metadata(),
                    "event_is_new": event_is_new,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            source="vision",
            model_id=vision_completion.model,
            request_cost_yuan=vision_completion.cost_yuan,
            occurred_at=occurred_at,
        )
        updated_state = update_game_state(
            current_state,
            observation,
            count_occurrence=event_is_new,
        )
        db.upsert_game_session_state(
            session_id,
            str(updated_state.get("game_name") or observation.game_name),
            updated_state,
        )
        recent_summaries = [str(row["summary"] or "") for row in recent_observations]
        # 2026-10-24 用户裁决（m02056）：随机长间隔模式下，**到点这一刻就是要说话**。
        # 以前 exploration / idle / movement 这些事件全在 SILENT_EVENTS 里，到点了也被
        # decide_behavior 一句"普通画面变化，保持安静"拦下 → 观察结果只落库、气泡一直是空的。
        # 现在把"随机模式到点"等同于 force（用户主动让它看），交给 decide_behavior 的 force 分支：
        # 只要置信度够、不是黑屏，就开口。
        periodic_observation = bool(config.get("screen_trigger_random_enabled", True))
        speak_force = bool(force) or periodic_observation
        decision = decide_behavior(
            observation,
            updated_state,
            recent_summaries=recent_summaries,
            seconds_since_last_speech=seconds_since_last_speech,
            cooldown_seconds=int(config.get("screen_voice_cooldown_seconds", 5)),
            minimum_priority=float(config.get("screen_minimum_importance", 0.62)),
            event_is_new=event_is_new,
            force=speak_force,
        )
        if combined_result is not None:
            model_emotion = combined_result.emotion or decision.emotion
            model_priority = max(decision.priority, combined_result.importance)
            game_reply_override = _game_event_can_open(
                observation,
                decision,
                event_is_new=event_is_new,
                recent_summaries=recent_summaries,
                seconds_since_last_speech=seconds_since_last_speech,
                cooldown_seconds=int(config.get("screen_voice_cooldown_seconds", 5)),
            )
            ambient_reply = (
                is_full_screen
                and combined_result.should_reply
                and bool(combined_result.reply)
                and combined_result.importance >= float(config.get("screen_minimum_importance", 0.62))
                and observation.confidence >= 0.5
                and seconds_since_last_speech >= int(config.get("screen_voice_cooldown_seconds", 5))
                and not processed.nearly_blank
                and (
                    not is_duplicate_summary(observation.summary, recent_summaries)
                    or seconds_since_last_speech >= max(
                        45,
                        int(config.get("screen_voice_cooldown_seconds", 5)) * 6,
                    )
                )
            )
            decision = BehaviorDecision(
                should_speak=ambient_reply
                or speak_force  # 随机到点看一眼：到点就说，不再被模型的 should_reply 二次否决
                or (
                    decision.should_speak
                    and (
                        combined_result.should_reply
                        or (bool(combined_result.reply) and decision.priority >= 0.66)
                        or game_reply_override
                        or wake
                    )
                ),
                priority=model_priority,
                emotion=model_emotion,
                reason=combined_result.reason or decision.reason,
                repeat_count=decision.repeat_count,
            )
        if wake:
            decision = BehaviorDecision(
                should_speak=True,
                priority=max(0.65, observation.confidence, decision.priority),
                emotion=(combined_result.emotion if combined_result is not None else decision.emotion),
                reason="桌宠启动后第一次观察屏幕",
                repeat_count=decision.repeat_count,
            )
        elif interactive:
            decision = BehaviorDecision(
                should_speak=True,
                priority=max(0.65, observation.confidence, decision.priority),
                emotion=(combined_result.emotion if combined_result is not None else decision.emotion),
                reason="用户在近期屏幕对话中明确追问当前画面",
                repeat_count=decision.repeat_count,
            )
        event_id = db.save_screen_event(
            session_id=session_id,
            frame_id=int(frame["frame_id"]),
            event_type=observation.event_type,
            event_summary=observation.summary,
            importance=decision.priority,
            should_speak=decision.should_speak,
            emotion=decision.emotion,
            change_percent=float(frame.get("change_percent") or 0),
            model_id=vision_completion.model,
            request_cost_yuan=vision_completion.cost_yuan,
            occurred_at=occurred_at,
            observation_id=observation_id,
            conversation_id=conversation_id,
        )
        motion_hint = {
            "victory": "celebrate",
            "achievement": "celebrate",
            "success": "celebrate",
            "death": "concern",
            "defeat": "concern",
            "warning": "alert",
            "error": "alert",
            "activity_change": "attention",
            "activity_progress": "attention",
            "activity_pause": "attention",
            "interesting_content": "observe",
            "gameplay": "observe",
        }.get(observation.event_type, "observe")
        pet_event_service.publish(
            "visual_event",
            {
                "event_id": event_id,
                "observation_id": observation_id,
                "frame_id": int(frame["frame_id"]),
                "mode": str(frame.get("mode") or "screen"),
                "title": str(frame.get("title") or "")[:300],
                "event_type": observation.event_type,
                "summary": observation.summary[:500],
                "importance": round(float(decision.priority), 4),
                "confidence": round(float(observation.confidence), 4),
                "emotion": decision.emotion,
                "motion_hint": motion_hint,
                "should_speak": bool(decision.should_speak),
                "event_is_new": bool(event_is_new),
                "occurred_at": occurred_at,
            },
        )
        with _state_lock:
            _last_analyzed_frame_id = int(frame["frame_id"])
            _last_analyzed_at = occurred_at
            _last_model = vision_completion.model
            _last_reaction_model = ""
            _last_cost_yuan = vision_completion.cost_yuan
            _last_event_type = observation.event_type
            _last_event_summary = observation.summary
            _last_event_priority = decision.priority
            _last_event_confidence = observation.confidence
            _last_emotion = decision.emotion
            _last_game_state = dict(updated_state)
        if not decision.should_speak and not interactive:
            return False
        current_observer = companion_service.window_observer.status()
        if not force and not current_observer["running"]:
            return False
        if not force:
            pending_change = float(current_observer.get("pending_change_percent") or 0)
            if _newer_frame_supersedes(
                int(frame["frame_id"]),
                current_observer,
                change_threshold=_effective_change_threshold(config, current_observer),
            ):
                with _state_lock:
                    _last_pipeline_timings["superseded_by_newer_frame"] = True
                    _last_pipeline_timings["superseded_change_percent"] = round(pending_change, 3)
                return False
        if wake and not companion_service.pet_running():
            return False

        if combined_result is not None:
            reaction_completion = CompletionResult(
                content=combined_result.reply or _fallback_reaction(observation),
                model=vision_completion.model,
                prompt_tokens=0,
                cached_prompt_tokens=0,
                completion_tokens=0,
                reasoning_tokens=0,
                cost_yuan=0.0,
                cost_source="shared_multimodal_request",
            )
            reply = _clean_reply(combined_result.reply or _fallback_reaction(observation))
            with _state_lock:
                _last_pipeline_timings["reaction_seconds"] = 0.0
        else:
            reaction_route = select_auto_route(
                "分析当前情境和最近对话，生成一句自然、不机械的角色回应",
                profiles=_configured_profiles(),
            )
            reaction_observation = (
                _safe_observation_for_cloud(observation)
                if is_full_screen
                else observation
            )
            try:
                reaction_started = time.monotonic()
                reaction_completion = await asyncio.wait_for(
                    call_chat_completion_result(
                        (
                            _wake_reaction_messages(
                                reaction_observation,
                                {} if is_full_screen else updated_state,
                                conversation_id,
                            )
                            if wake
                            else _reaction_messages(
                                reaction_observation,
                                decision,
                                {} if is_full_screen else updated_state,
                                conversation_id,
                            )
                        ),
                        temperature=0.72,
                        model_id=reaction_route.model_id,
                        reasoning_level="low",
                    ),
                    timeout=max(5, settings.screen_reaction_timeout_seconds),
                )
                _record_completion_usage(reaction_completion, analysis=False)
                with _state_lock:
                    _last_pipeline_timings["reaction_seconds"] = round(
                        max(0.0, time.monotonic() - reaction_started),
                        3,
                    )
                    _last_error = ""
            except Exception as exc:
                reason = "生成屏幕回应超时" if isinstance(exc, asyncio.TimeoutError) else f"生成屏幕回应失败：{exc}"
                reaction_completion = CompletionResult(
                    content=_fallback_reaction(reaction_observation),
                    model="local-fallback",
                    prompt_tokens=0,
                    cached_prompt_tokens=0,
                    completion_tokens=0,
                    reasoning_tokens=0,
                    cost_yuan=0.0,
                    cost_source="local_fallback",
                )
                with _state_lock:
                    _last_pipeline_timings["reaction_seconds"] = round(
                        max(0.0, time.monotonic() - reaction_started),
                        3,
                    )
                    _last_error = f"{reason}，本轮已改用本地短回应；下一轮会继续尝试。"
            reply = _clean_reply(reaction_completion.content)
        if not reply:
            return False
        normalized = " ".join(reply.split())
        with _state_lock:
            if not wake and not interactive and normalized == " ".join(_last_reply.split()):
                return False
            _last_reply = reply

        total_cost = (
            vision_completion.cost_yuan
            if combined_result is not None
            else _combined_cost(vision_completion.cost_yuan, reaction_completion.cost_yuan)
        )
        request_id = str(request_id or "").strip() or uuid.uuid4().hex
        game_event_types = {
            "gameplay", "movement", "exploration", "death", "failure", "victory",
            "boss_battle", "boss_phase", "low_health", "danger", "rare_reward",
            "achievement", "match_result", "dialogue_choice", "cutscene_turn",
        }
        source_is_game = bool(observation.game_name) or observation.event_type in game_event_types
        message_source = (
            "desktop_pet_wake"
            if wake
            else ("game" if source_is_game else "screen")
        )
        parts = replies_for_source(reply, "desktop") or [reply]
        for index, part in enumerate(parts[:3]):
            db.save_message(
                "assistant",
                part,
                source=message_source,
                conversation_id=conversation_id,
                request_id=request_id,
                model_id=reaction_completion.model,
                reasoning_level=("off" if reaction_completion.model == "local-fallback" else "low"),
                prompt_tokens=(vision_completion.prompt_tokens + (0 if combined_result is not None else reaction_completion.prompt_tokens)) if index == 0 else 0,
                cached_prompt_tokens=(vision_completion.cached_prompt_tokens + (0 if combined_result is not None else reaction_completion.cached_prompt_tokens)) if index == 0 else 0,
                completion_tokens=(vision_completion.completion_tokens + (0 if combined_result is not None else reaction_completion.completion_tokens)) if index == 0 else 0,
                reasoning_tokens=(vision_completion.reasoning_tokens + (0 if combined_result is not None else reaction_completion.reasoning_tokens)) if index == 0 else 0,
                request_cost_yuan=total_cost if index == 0 else 0.0,
                request_cost_source=(reaction_completion.cost_source if index == 0 else "shared_request"),
                emotion=decision.emotion,
            )
        db.save_companion_reaction(
            screen_event_id=event_id,
            request_id=request_id,
            text=reply,
            emotion=decision.emotion,
            trigger_reason=decision.reason,
            model_id=reaction_completion.model,
            request_cost_yuan=reaction_completion.cost_yuan,
        )
        with _state_lock:
            _last_spoken_monotonic = now
            _last_reaction_model = reaction_completion.model
            _last_cost_yuan = total_cost
            _last_pipeline_timings["text_ready_seconds"] = round(
                max(0.0, time.monotonic() - pipeline_started),
                3,
            )

        direct_voice_enabled = bool(config.get("screen_direct_voice_enabled", True))
        should_direct_speak = bool(config.get("voice_enabled", True)) and direct_voice_enabled and (
            wake
            or (source_is_game and bool(config.get("speak_game_observations", True)))
            or (not source_is_game and bool(config.get("speak_screen_observations", False)))
        )
        if allow_direct_speech is not None:
            should_direct_speak = should_direct_speak and bool(allow_direct_speech)
        # 2026-10-24 用户裁决（m01961 / m02056）：观察结果必须真的出现在桌宠对话界面 ——
        # 以前算完 should_direct_speak 就 return True，结果文字只落了库、桌宠端收不到；
        # 语音那条更是完全没实现。现在统一在这里投递：文字进气泡，再按开关补语音。
        # 投递失败不能影响本轮观察结论（观察本身已经成功、已落库）。
        try:
            await _deliver_observation(
                reply=reply,
                emotion=decision.emotion,
                request_id=request_id,
                config=config,
                source_is_game=source_is_game,
                allow_direct_speech=should_direct_speak,
            )
        except Exception as exc:  # noqa: BLE001
            with _state_lock:
                _last_error = f"观察结果投递桌宠失败：{exc}"
        # 只有真正观察成功才消耗本次触发，安排下一次随机间隔
        if not force:
            _trigger_consumed(config)
        return True
    except Exception as exc:
        error_text = (
            f"视觉请求超过 {max(5, int(config.get('screen_request_timeout_seconds', 25)))} 秒，已跳过本轮"
            if isinstance(exc, asyncio.TimeoutError)
            else str(exc)
        )
        cooldown_seconds = 0.0
        # 只剩云端大肥鱼一条路：连续失败走同一套冷却，
        # 避免到点后每 5 秒重试一次把云端打爆
        if not cloud_result_ready:
            cooldown_seconds = _mark_cloud_profile_failure(FEIYU_VISION_HEALTH_ID, error_text)
            with _state_lock:
                _session_failure_count += 1
        with _state_lock:
            _last_analyzed_frame_id = int(frame["frame_id"])
            _last_pipeline_timings["failed_seconds"] = round(
                max(0.0, time.monotonic() - pipeline_started),
                3,
            )
            _last_pipeline_timings["timed_out"] = isinstance(exc, asyncio.TimeoutError)
            if cooldown_seconds:
                _last_pipeline_timings["profile_cooldown_seconds"] = round(cooldown_seconds, 1)
            _last_error = f"{error_text}。画面捕获会继续运行，下一观察周期会重试云端。"
        return False
    finally:
        frame.clear()
        with _state_lock:
            _in_progress = False


def is_screen_chat_follow_up(
    message: str,
    history_rows: list[Any] | tuple[Any, ...] = (),
    *,
    observation_status: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> bool:
    """Return true only when a short deictic message continues recent screen context."""
    status_payload = observation_status if observation_status is not None else status()
    normalized_message = re.sub(
        r"[\uFF0C\u3002\uFF01\uFF1F!?/\\\s]+$",
        "",
        str(message or "").strip(),
    )
    recent_screen_context = False
    for row in list(history_rows)[-10:]:
        try:
            role = str(row["role"] or "")
            source = str(row["source"] or "")
            content = str(row["content"] or "")
        except (KeyError, TypeError, IndexError):
            role = str(getattr(row, "role", "") or "")
            source = str(getattr(row, "source", "") or "")
            content = str(getattr(row, "content", "") or "")
        if role == "assistant" and source in {"screen", "game", "desktop_pet_wake"}:
            recent_screen_context = True
            break
        if role == "user" and SCREEN_CONTEXT_INTENT_RE.search(content):
            recent_screen_context = True
            break
    if recent_screen_context and normalized_message in {"", "？", "?"}:
        return True
    # ★★ 2026-10-24 用户反馈「自然语言触发不了屏幕观察」的第二层根因（这里）：
    #   原来即使句式命中（SCREEN_FOLLOW_UP_RE），还要再等下面那段
    #   "最近 5 分钟内观察过 / 历史里有屏幕记录"才肯返回 True。
    #   可用户明明已经**明说要看屏幕**（「看一下现在的屏幕」「屏幕上是什么」），
    #   桌面端刚开机、历史为空时这段判定必然失败 → 观察不触发，只有普通聊天回复。
    #   现在分两类：
    #     · 显式提到屏幕/画面的（SCREEN_CONTEXT_INTENT_RE）→ 直接触发，不依赖历史；
    #     · 纯指示语（「现在呢」「然后呢」）→ 仍要求有近期屏幕上下文，避免无意义截图。
    if SCREEN_CONTEXT_INTENT_RE.search(str(message or "")):
        return True
    if not SCREEN_FOLLOW_UP_RE.fullmatch(str(message or "").strip()):
        return False

    analyzed_at = str(status_payload.get("last_analyzed_at") or "").strip()
    if analyzed_at:
        try:
            analyzed_time = datetime.fromisoformat(analyzed_at)
            current_time = now or datetime.fromisoformat(db.now_iso())
            if analyzed_time.tzinfo is not None and current_time.tzinfo is None:
                current_time = current_time.replace(tzinfo=analyzed_time.tzinfo)
            elif analyzed_time.tzinfo is None and current_time.tzinfo is not None:
                analyzed_time = analyzed_time.replace(tzinfo=current_time.tzinfo)
            age_seconds = (current_time - analyzed_time).total_seconds()
            if 0 <= age_seconds <= SCREEN_FOLLOW_UP_CONTEXT_SECONDS:
                return True
        except ValueError:
            pass

    def history_id(row: Any) -> int:
        try:
            return int(row["id"] or 0)
        except (KeyError, TypeError, IndexError):
            return int(getattr(row, "id", 0) or 0)

    ordered_history = sorted(list(history_rows), key=history_id)
    for row in reversed(ordered_history[-8:]):
        try:
            source = str(row["source"] or "")
            role = str(row["role"] or "")
            content = str(row["content"] or "")
        except (KeyError, TypeError, IndexError):
            source = str(getattr(row, "source", "") or "")
            role = str(getattr(row, "role", "") or "")
            content = str(getattr(row, "content", "") or "")
        if role == "assistant" and source in {"screen", "game", "desktop_pet_wake"}:
            return True
        if role == "user" and SCREEN_CONTEXT_INTENT_RE.search(content):
            return True
    return False


def _screen_follow_up_failure_reply(analysis_status: dict[str, Any]) -> str:
    if not bool(analysis_status.get("enabled", True)):
        return "屏幕观察现在是关闭的，我没法重新看当前画面。"
    budget = analysis_status.get("budget") if isinstance(analysis_status.get("budget"), dict) else {}
    if bool(budget.get("paused")):
        return f"屏幕观察已暂停：{str(budget.get('paused_reason') or '今天的测试预算已用完')}。"
    if not bool(analysis_status.get("vision_available", False)):
        return "当前没有可用的视觉模型，我还不能重新看这张画面。"
    detail = str(analysis_status.get("last_error") or analysis_status.get("capture_diagnostic") or "").strip()
    return f"刚才没能取得新的画面：{detail or '屏幕捕获暂时不可用'}。"


async def analyze_screen_chat_follow_up(
    message: str,
    *,
    conversation_id: str,
    request_id: str,
    source: str,
) -> ChatResult:
    """Analyze one fresh frame for a chat follow-up without creating a second reply or TTS."""
    observer_status = await asyncio.to_thread(companion_service.window_observer.status)
    was_running = bool(observer_status.get("running"))
    analysis_before = await asyncio.to_thread(status)
    previous_capture_only = bool(analysis_before.get("capture_only"))
    started_at = time.monotonic()
    db.save_message(
        "user",
        str(message or "").strip(),
        source=source,
        conversation_id=conversation_id,
        request_id=request_id,
    )

    replied = False
    analysis_after: dict[str, Any] = {}
    try:
        if not bool(analysis_before.get("enabled", True)):
            raise RuntimeError("屏幕 AI 已关闭")
        budget = analysis_before.get("budget") if isinstance(analysis_before.get("budget"), dict) else {}
        if bool(budget.get("paused")):
            raise RuntimeError(str(budget.get("paused_reason") or "屏幕观察预算已暂停"))
        if not bool(analysis_before.get("vision_available", False)):
            raise RuntimeError("没有可用的视觉模型")
        capture_before = analysis_before.get("capture") if isinstance(analysis_before.get("capture"), dict) else {}
        if was_running and not bool(capture_before.get("running", True)):
            raise RuntimeError("屏幕捕获器没有运行")
        # ★ 2026-10-24：不再有本地视觉这条路，也就没有"先把 Ollama 拉起来"这一步。
        #   顺手把可能残留的本地视觉服务卸掉（它不该在本机占内存/显存）。
        await asyncio.to_thread(local_vision_service.unload_model)
        await asyncio.to_thread(set_capture_only, False)
        if not was_running:
            await asyncio.to_thread(companion_service.window_observer.select_screen, "primary")
        # Force one synchronous capture immediately before claiming a frame.
        # This prevents a previous preview from being mistaken for the answer
        # to “现在呢？” after the target window was closed, minimized, or
        # covered by another window.
        try:
            await asyncio.to_thread(companion_service.window_observer.capture)
        except (ValueError, RuntimeError, OSError) as exc:
            raise RuntimeError(f"无法取得当前新画面：{exc}") from exc
        replied = await analyze_once(
            force=True,
            interactive=True,
            conversation_id=conversation_id,
            request_id=request_id,
            allow_direct_speech=False,
        )
        analysis_after = await asyncio.to_thread(status)
    except (ValueError, RuntimeError, OSError):
        replied = False
        analysis_after = await asyncio.to_thread(status)
    finally:
        if not was_running:
            await asyncio.to_thread(companion_service.window_observer.stop)
            await asyncio.to_thread(end_session)
        else:
            await asyncio.to_thread(set_capture_only, previous_capture_only)

    if not analysis_after:
        analysis_after = await asyncio.to_thread(status)
    rows = [
        row
        for row in db.get_recent_messages(limit=12, conversation_id=conversation_id)
        if str(row["role"] or "") == "assistant" and str(row["request_id"] or "") == request_id
    ]
    if not replied or not rows:
        fallback = _screen_follow_up_failure_reply(analysis_after)
        db.save_message(
            "assistant",
            fallback,
            source="screen",
            conversation_id=conversation_id,
            request_id=request_id,
            model_id="local-status",
            reasoning_level="off",
            total_latency_ms=max(0.0, (time.monotonic() - started_at) * 1000),
        )
        return ChatResult(
            reply=fallback,
            replies=[fallback],
            request_id=request_id,
            model_id="local-status",
            reasoning_level="off",
            total_latency_ms=max(0.0, (time.monotonic() - started_at) * 1000),
        )

    replies = [str(row["content"] or "").strip() for row in rows if str(row["content"] or "").strip()]
    first = rows[0]
    timings = analysis_after.get("pipeline_timings") if isinstance(analysis_after.get("pipeline_timings"), dict) else {}
    return ChatResult(
        reply="\n\n".join(replies),
        replies=replies,
        speech_emotion=str(first["emotion"] or analysis_after.get("last_emotion") or ""),
        request_id=request_id,
        model_id=str(first["model_id"] or analysis_after.get("last_model") or ""),
        provider_model=str(analysis_after.get("last_model") or ""),
        reasoning_level=str(first["reasoning_level"] or "low"),
        prompt_tokens=int(first["prompt_tokens"] or 0),
        cached_prompt_tokens=int(first["cached_prompt_tokens"] or 0),
        completion_tokens=int(first["completion_tokens"] or 0),
        reasoning_tokens=int(first["reasoning_tokens"] or 0),
        request_cost_yuan=first["request_cost_yuan"],
        request_cost_source=str(first["request_cost_source"] or ""),
        first_token_latency_ms=(
            float(timings["first_token_seconds"]) * 1000
            if timings.get("first_token_seconds") is not None
            else None
        ),
        total_latency_ms=max(0.0, (time.monotonic() - started_at) * 1000),
    )


def _auto_start_capture_if_needed(config: dict[str, Any]) -> None:
    """随机触发开着、但捕获器没跑 → 自动把它拉起来。

    ★ 2026-10-24 用户排查出的真根因（一整晚没触发过一次）：
      `observation_loop` 只调 `analyze_once()`，而 `analyze_once` 的第一道门是
      `if not observer_status["running"]: return False`。
      `running` 只有 `POST /api/companion/screen/start` 能点亮，而那个接口只被前端
      `controlObservation()` 调用 —— 可那个函数**从来没有被任何界面元素绑定**，
      于是捕获器永远不启动、一帧都不会抓，随机触发逻辑再对也轮不到执行。
      之前每次验收都是手动调 start 把捕获器点起来，所以没暴露。

    这里补上"自愈"：只要用户把随机触发开着，就保证捕获器在跑，不依赖任何按钮。
    注意 capture_only 状态：若被显式设为只看不分析（比如语音通话占用资源），
    不要去启动，避免抢资源。
    """
    if not bool(config.get("screen_trigger_random_enabled", True)):
        return
    if not bool(config.get("screen_ai_enabled", True)):
        return
    with _state_lock:
        if _capture_only:
            return
    observer = companion_service.window_observer
    try:
        status = observer.status()
    except Exception:  # noqa: BLE001 - 状态取不到就当没跑，下面会尝试启动
        status = {}
    if bool(status.get("running")):
        return
    # 用户主动停过（desired_running 显式 false）就不再自作主张拉起：
    # 只有"从没启动过"（desired_running 也是 False 且 frame_id==0）或
    # 配置刚打开随机触发时才自动启动。
    interval_ms = max(500, int(config.get("screen_analysis_interval_seconds", 5)) * 1000)
    try:
        observer.select_screen("primary")
        observer.start(interval_ms)
        with _state_lock:
            _last_error = ""
    except Exception as exc:  # noqa: BLE001 - 启动失败只记录，不拖垮主循环
        with _state_lock:
            _last_error = f"自动启动屏幕捕获失败：{exc}"


async def observation_loop() -> None:
    global _last_error
    while True:
        try:
            _auto_start_capture_if_needed(companion_service.load_config())
            await analyze_once()
        except OperationStopped:
            pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            with _state_lock:
                _last_error = str(exc)
        # 外循环 5s：analyze_once 内部另有 screen_analysis_interval_seconds(默认5s) 节流，
        # 1s 轮询只是空转烧 CPU；手动 force 调用不受影响
        await asyncio.sleep(5.0)


def set_capture_only(enabled: bool) -> None:
    global _capture_only
    with _state_lock:
        _capture_only = bool(enabled)


def end_session() -> None:
    global _last_game_state, _capture_only, _last_pipeline_timings
    db.end_screen_sessions()
    with _state_lock:
        _last_game_state = {}
        _capture_only = False
        _last_pipeline_timings = {}
