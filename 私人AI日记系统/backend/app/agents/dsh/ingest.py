"""DSH 插件包 · 事件摄入端点（M6 6.5：插件 → 桌宠总线的唯一写入口）。

为什么需要这个模块
------------------
``agents/dsh/routes.py`` 原本**只有 5 个只读 GET**（status/phases/diagnostics/about/update-check），
即"DshAdapter 读日志边车 → 总线 → 桌宠"这条**单向**链路。而插件形态（``packages/mao-pet``）
是**反向**的：插件跑在 DSH 宿主进程内，直接拿到了实时事件，需要把 phase **推进**桌宠总线。
两条链路互不冲突、可并存：

  ==================== ============================== ==========================
  来源                  通道                            适用
  ==================== ============================== ==========================
  日志边车（既有）      ``dsh_adapter`` → ``emit``      独立桌宠形态，无插件也能跑
  插件推送（本模块）    ``POST /ingest`` → ``emit``     DSH 插件形态，实时且更细
  ==================== ============================== ==========================

设计约束（与仓库既有分层保持一致）
----------------------------------
1. **不另立一套总线语义**：本模块只是"HTTP → ``agent_bus_service``"的适配层。
   节流（300ms 同 phase）、活跃聚焦优先级、WS ``agent_phase`` 广播**全部在 ``emit`` 内部**，
   这里一行都不重写——否则会出现两套口径，这正是仓库多次踩过的坑。
2. **不认识的 agent 自动注册**：``emit`` 对未注册 agent 会 ``raise KeyError``
   （``agent_bus_service.py:310``），故首见即 ``register`` 一次，之后只 ``set_status``。
3. **安全**：本端点**不自己写栅栏**。后端已装 ``LocalControlMiddleware``
   （``app/local_security.py``，挂载于 ``main.py``），全站强制回环 + 同源 +
   拒 ``Sec-Fetch-Site: cross-site``。写操作因此自动被限制在本机——不要在这里重复实现，
   否则两处口径会漂移（whale-widget 的 ``requestRejection`` 教训）。
4. **phase 必须落在词汇内**：``emit`` 自己会 ``raise ValueError``；本模块在入口先校验，
   以便返回 400 而不是 500（对外语义更清楚）。
"""
from __future__ import annotations

from typing import Any

from ...kernel import agent_bus_service

# 缺省身份（与 packages/mao-pet 的声明一致；D5：全小写 mao-pet，显示名 Mao-pet）
DEFAULT_AGENT_ID = "mao-pet"
DEFAULT_AGENT_NAME = "Mao-pet"
# 插件身份色：沿用 DSH 的靛蓝（与 dsh_adapter.DSH_ACCENT / 前端 manifest 同值），
# 桌宠气泡/徽标据此把"Mao-pet 说的话"与其它来源区分开。
DEFAULT_ACCENT = "#4F6BED"
# 适配器标识：总线快照里区分"事件从哪条链路来"（日志边车 = dsh_adapter，插件 = mao-pet_adapter）
ADAPTER = "mao-pet_adapter"

# 插件自声明的能力。voice 如实报 False：
# 本版 DSH 无任何 TTS/语音合成服务，voice phase 仅在用户自行部署 speak/tts 类工具时才可达
# （与 dsh_adapter.run() 的口径一致，见 dsh_adapter.py:890-899）。
CAPABILITIES: dict[str, Any] = {
    "voice": False,
    "text": True,
    "screen": False,
    "mcp": True,
    "observe": False,
}

# 已知 phase 词汇（延迟到调用时读取，避免与 kernel 的模块级常量形成导入时序耦合）
def known_phases() -> tuple[str, ...]:
    return tuple(agent_bus_service.PHASES)


def _as_text(value: Any, limit: int) -> str:
    """把任意值收敛成有长度上限的字符串（透传给桌宠的字段一律短字段）。"""
    if value is None:
        return ""
    text = str(value).strip()
    return text[:limit]


def _sanitize_state(raw: Any) -> dict[str, Any]:
    """只放**短且 JSON 安全**的字段进 state。

    桌宠的 state 会随 ``agent_phase`` 广播到渲染端并可能显示在气泡/徽标上，
    因此不能把插件给的任意深结构原样透传（既可能撑爆广播，也可能把
    会话内容意外暴露到渲染层）。这里只收已知的短标量字段。
    """
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}

    tool = _as_text(raw.get("tool"), 60)
    if tool:
        out["tool"] = tool

    err = _as_text(raw.get("error"), 200)
    if err:
        out["error"] = err

    goal = _as_text(raw.get("goal"), 40)
    if goal:
        out["goal"] = goal

    session = _as_text(raw.get("session"), 120)
    if session:
        out["session"] = session

    for key in ("turn", "step", "tool_calls", "todos", "ctx_pressure"):
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            out[key] = value
        elif isinstance(value, float) and value.is_integer():
            out[key] = int(value)

    return out


def ensure_registered(agent_id: str, name: str, accent: str) -> None:
    """首见即注册（幂等）；已存在时只补身份信息，不重置运行态。

    为什么每次请求都调：``register`` 对已存在的 agent 是**更新语义**（``agent_bus_service.py:206-217``），
    幂等且很便宜；这样即便进程重启、总线被重建，插件下一条事件也能自动把身份补回来。
    """
    agent_bus_service.register(
        agent_id,
        name or DEFAULT_AGENT_NAME,
        ADAPTER,
        capabilities=dict(CAPABILITIES),
        accent=accent or DEFAULT_ACCENT,
    )


def _active_agent_id() -> str | None:
    """当前占据桌宠"身体"的 agent id（读**公共** ``snapshot()``，不探私有属性）。

    踩坑记录：初版写的是 ``getattr(agent_bus_service, "_active_agent_id", None)``，
    恒为 ``None`` —— ``_active_agent_id`` 是 ``AgentBus`` **实例**的字段（``:146``），
    而模块层只是转发门面（``bus = AgentBus()``，``:538``），门面上没有这个属性。
    公共快照里已经有等价信息（``AgentBus.snapshot()`` 输出 ``active_agent_id``），
    走它既正确又不会因为内核改私有字段名而静默失效。
    """
    try:
        snap = agent_bus_service.snapshot()
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(snap, dict):
        return None
    value = snap.get("active_agent_id")
    return str(value) if value else None


def ingest(
    *,
    phase: str,
    agent_id: str = "",
    name: str = "",
    accent: str = "",
    state: Any = None,
    force: bool = False,
) -> dict[str, Any]:
    """把一个 phase 事件推入总线。返回对外响应体。

    ``force=True`` 绕过总线的 300ms 同 phase 节流。为什么要这个开关：
    ``emit`` 的节流会吃掉"立即恢复"语义——适配器侧的做法是先自行节流再 ``force=True``
    放行（见 ``dsh_adapter.py:812-827`` 的注释）。插件侧同理：phase **变化**时应 force，
    周期性补发时才需要被节流。

    :raises ValueError: phase 不在总线词汇内（路由层转 400）。
    """
    wanted = _as_text(phase, 40)
    if wanted not in known_phases():
        raise ValueError(
            f"未知 phase: {wanted!r}（可用：{', '.join(known_phases())}）"
        )

    aid = _as_text(agent_id, 60) or DEFAULT_AGENT_ID
    aname = _as_text(name, 60) or DEFAULT_AGENT_NAME
    aaccent = _as_text(accent, 20) or DEFAULT_ACCENT

    ensure_registered(aid, aname, aaccent)
    # 收到事件即视为在线：插件是推送方，能推就说明它还活着。
    # 离线由总线的心跳超时自己判定（HEARTBEAT_TIMEOUT_MS=30s），不在这里另造机制。
    agent_bus_service.set_status(aid, "online")
    agent_bus_service.heartbeat(aid)

    clean = _sanitize_state(state)
    before = agent_bus_service.get(aid)
    seq_before = int(before.seq) if before is not None else 0
    phase_before = str(before.phase) if before is not None else ""

    agent_bus_service.emit(aid, wanted, state=clean or None, force=bool(force))

    after = agent_bus_service.get(aid)
    seq_after = int(after.seq) if after is not None else seq_before
    return {
        "ok": True,
        "agent_id": aid,
        "phase": wanted,
        # seq 未推进 = 被 300ms 节流吃掉了（调用方据此判断是否真的广播了）
        "seq": seq_after,
        "throttled": seq_after == seq_before,
        "phase_changed": wanted != phase_before,
        "active": bool(after.active) if after is not None else False,
        "active_agent_id": _active_agent_id(),
    }


def push_strip(
    *,
    kind: str,
    text: str = "",
    style_id: str = "",
    session_id: str = "",
    duration_ms: int = 0,
    sticky: bool = False,
    agent_id: str = "",
    name: str = "",
    accent: str = "",
) -> dict[str, Any]:
    """把一条**横条动作**推给桌宠（7.6 的投递末端）。

    横条是**独立于气泡**的窗位（用户裁决：三条通路各自独立管理）。
    本函数只负责"把动作送进总线"，不做任何渲染决策 —— 与 ``ingest`` 同层。

    ``kind``：
      - ``show``   ：整段上屏（``text`` 必填）
      - ``append`` ：追加一段（``text`` 必填）—— 流式逐 token 用这个
      - ``hide``   ：收起内容（**不改**"用户已关闭"状态）
      - ``style``  ：应用皮肤（``style_id`` 必填）

    :raises ValueError: kind 非法或必填字段缺失（路由层转 400）。
    """
    wanted = _as_text(kind, 20).lower()
    if wanted not in {"show", "append", "hide", "style"}:
        raise ValueError(
            f"未知 kind: {wanted!r}（可用：show, append, hide, style）"
        )
    body_text = _as_text(text, 4000)
    if wanted in {"show", "append"} and not body_text:
        raise ValueError(f"kind={wanted} 需要非空 text")
    sid = _as_text(style_id, 40)
    if wanted == "style" and not sid:
        raise ValueError("kind=style 需要非空 styleId")

    aid = _as_text(agent_id, 60) or DEFAULT_AGENT_ID
    aname = _as_text(name, 60) or DEFAULT_AGENT_NAME
    aaccent = _as_text(accent, 20) or DEFAULT_ACCENT
    ensure_registered(aid, aname, aaccent)
    agent_bus_service.set_status(aid, "online")
    agent_bus_service.heartbeat(aid)

    payload: dict[str, Any] = {"kind": wanted}
    if body_text:
        payload["text"] = body_text
    if sid:
        payload["styleId"] = sid
    if session_id:
        payload["session"] = _as_text(session_id, 120)
    try:
        ms = int(duration_ms or 0)
    except (TypeError, ValueError):
        ms = 0
    if ms > 0:
        payload["durationMs"] = ms
    if sticky:
        payload["sticky"] = True

    delivered = agent_bus_service.strip(aid, payload)
    return {
        "ok": True,
        "agent_id": aid,
        "kind": wanted,
        # False = 未广播（插件被停用 / agent 未注册）
        "delivered": bool(delivered),
    }


def snapshot_for(agent_id: str) -> dict[str, Any]:
    """当前总线上的该 agent 快照（插件自检/联调用，只读）。"""
    agent = agent_bus_service.get(_as_text(agent_id, 60) or DEFAULT_AGENT_ID)
    if agent is None:
        return {"registered": False}
    data = agent.to_dict()
    data["registered"] = True
    return data
