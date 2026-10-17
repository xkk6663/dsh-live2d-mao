"""DSH 插件包 · 专属 HTTP 路由（插件内自足，不越界到其它插件）。

设计约束（遵循「一切皆插件 + 插件零相互依赖」）
------------------------------------------------
本文件是 ``agents/dsh/`` 插件包里**唯一**对外的 HTTP 面。它只做两件事：

1. **读**：把本插件自己持有的 DSH 状态摘要暴露给前端（左侧栏 DSH 面板用）；
2. **探**：暴露自检/诊断数据，供体检面板与排障使用。

它**不做**：
- 不 import 其它插件的路由/服务（小智、Octop、桌宠渲染层都不碰）；
- 不改总线（总线在 kernel 层，本插件只读快照）；
- 不碰桌宠窗口/设置（那是 companion 域的事）。

挂载方式：由 ``routes/companion.py`` 以 ``include_router`` 方式挂到主应用，
挂载点是 kernel 的装配职责（main.py 只装配），插件自己不抢装配权。
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ...companion import about_service
from . import dsh_adapter, ingest

router = APIRouter(prefix="/api/plugin/dsh", tags=["plugin:dsh"])


class IngestPayload(BaseModel):
    """插件推送的 phase 事件（``packages/mao-pet`` → 桌宠总线）。

    字段全部可选（除 ``phase``），缺省走 ``ingest`` 里的默认身份，
    这样插件可以只发 `{"phase":"thinking"}` 这种最小体。
    """

    phase: str = Field(..., description="总线 12 态词汇之一")
    agent_id: str = Field("", description="缺省 mao-pet")
    name: str = Field("", description="缺省 Mao-pet")
    accent: str = Field("", description="身份色，缺省 #4F6BED")
    state: dict[str, Any] = Field(default_factory=dict, description="短字段上下文")
    force: bool = Field(False, description="绕过 300ms 同 phase 节流（phase 变化时建议 true）")

# 本插件对外声明的能力与状态语义（前端面板据此渲染，无需硬编码）
PHASE_META: dict[str, dict[str, str]] = {
    "planning": {"label": "规划", "hint": "思考动画", "badge": "规划"},
    "thinking": {"label": "思考中", "hint": "思考动画", "badge": "思考中"},
    "executing_tool": {"label": "执行工具", "hint": "观察动作", "badge": "执行工具"},
    "streaming": {"label": "回复中", "hint": "回应动画", "badge": "回复中"},
    "waiting_input": {"label": "聆听中", "hint": "聆听动作", "badge": "聆听中"},
    "voice": {"label": "说话中", "hint": "说话口型", "badge": "说话中"},
    "awaiting_approval": {"label": "待确认", "hint": "回应动作", "badge": "待确认"},
    "idle": {"label": "待机", "hint": "待机动画", "badge": ""},
    "complete": {"label": "完成", "hint": "待机动画", "badge": ""},
    "error": {"label": "出错", "hint": "待机动画", "badge": ""},
    "paused": {"label": "暂停", "hint": "待机动画", "badge": ""},
    "heartbeat": {"label": "在线", "hint": "无", "badge": ""},
}


@router.get("/status")
async def plugin_status() -> dict[str, Any]:
    """DSH 插件状态摘要（前端 DSH 面板的主数据源）。

    只读、幂等、任意上下文可安全调用（不依赖事件循环）。
    """
    info = dsh_adapter.inspect_current()
    facts = info.get("facts") or {}
    return {
        "ok": True,
        "plugin": {
            "agent_id": dsh_adapter.AGENT_ID,
            "name": dsh_adapter.AGENT_NAME,
            "adapter": "dsh_adapter",
            # 前端用这个决定左侧导航项显隐之外的颜色/标识
            "accent": "#4F6BED",
            "color_key": "dsh",
        },
        "runtime": {
            "enabled": info.get("enabled"),
            "bus_enabled": info.get("bus_enabled"),
            "status": _bus_status(info),
            "phase": info.get("phase"),
            "phase_label": PHASE_META.get(str(info.get("phase") or ""), {}).get("label", ""),
            "state": info.get("state") or {},
            "session_id": info.get("session_id"),
            "sidecar_alive": info.get("sidecar_alive"),
            "sidecar_error": info.get("sidecar_error") or "",
            "dsh_process_running": info.get("dsh_process_running"),
        },
        "facts": {
            "in_turn": bool(facts.get("in_turn")),
            "turn": facts.get("turn"),
            "step": facts.get("step"),
            "tool_calls": facts.get("tool_calls") or 0,
            "active_tools": facts.get("active_tools") or 0,
            "last_tool": facts.get("last_tool") or "",
            "last_event": facts.get("last_event") or "",
            "retrying": bool(facts.get("retrying")),
            "errored": bool(facts.get("errored")),
            "todos": facts.get("todo_count") or 0,
        },
        "capabilities": {
            "phases": list(dsh_adapter.DSH_PHASES),
            "work_phases": list(dsh_adapter.DSH_WORK_PHASES),
            "fact_phases": list(dsh_adapter.DSH_FACT_PHASES),
            "source": "session-log-tail",
        },
    }


@router.get("/phases")
async def plugin_phases() -> dict[str, Any]:
    """本插件能下发给桌宠的全部 phase + 语义说明（前端图例/文档用）。"""
    return {
        "ok": True,
        "phases": [
            {
                "phase": p,
                "label": PHASE_META.get(p, {}).get("label", p),
                "hint": PHASE_META.get(p, {}).get("hint", ""),
                "badge": PHASE_META.get(p, {}).get("badge", ""),
                "work": p in dsh_adapter.DSH_WORK_PHASES,
                "fact_reachable": p in dsh_adapter.DSH_FACT_PHASES,
            }
            for p in dsh_adapter.DSH_PHASES
        ],
        "counts": {
            "registered": len(dsh_adapter.DSH_PHASES),
            "work": len(dsh_adapter.DSH_WORK_PHASES),
            "fact_reachable": len(dsh_adapter.DSH_FACT_PHASES),
        },
    }


@router.get("/diagnostics")
async def plugin_diagnostics() -> dict[str, Any]:
    """自检数据（体检面板条目数据源）。只读。"""
    info = dsh_adapter.inspect_current()
    running = info.get("dsh_process_running")
    sidecar = bool(info.get("sidecar_alive"))
    enabled = bool(info.get("enabled"))
    if not enabled:
        state, detail = "disabled", "DSH 未启用（dsh_config.json enabled=false）"
    elif running is False:
        state, detail = "offline", "DSH 未运行：请先启动 DeepSeek Harness"
    elif sidecar:
        state, detail = "ok", "边车在线，正在跟随会话事件"
    else:
        state, detail = "warn", info.get("sidecar_error") or "边车未就绪"
    return {
        "ok": True,
        "check": {
            "id": "dsh",
            "name": "DSH",
            "state": state,
            "detail": detail,
            "enabled": enabled,
            "sidecar_alive": sidecar,
            "dsh_process_running": running,
            "config_path": info.get("config_path") or "",
            "session_id": info.get("session_id") or "",
            "phase": info.get("phase") or "",
        },
    }


@router.get("/about")
async def plugin_about() -> dict[str, Any]:
    """「关于 / 自检」面板数据（A5）。

    复用 companion 域的 about_service（**不复制它的脱敏逻辑**）：
    脱敏与白名单只有一处实现，避免两边口径漂移。
    """
    payload = about_service.about_payload()
    # 补上本插件自己的信息
    payload["plugin"] = {
        "agent_id": dsh_adapter.AGENT_ID,
        "name": dsh_adapter.AGENT_NAME,
        "adapter": "dsh_adapter",
        "endpoints": [
            "/api/plugin/dsh/status",
            "/api/plugin/dsh/phases",
            "/api/plugin/dsh/diagnostics",
            "/api/plugin/dsh/about",
            "/api/plugin/dsh/update-check",
            # M6 6.5：插件形态的写入口（回环受限）+ 联调只读快照
            "POST /api/plugin/dsh/ingest",
            "/api/plugin/dsh/agent",
        ],
    }
    return payload


@router.get("/update-check")
async def plugin_update_check() -> dict[str, Any]:
    """更新检查。**只在用户点击时调用**（本端点不缓存、不轮询）。"""
    current = about_service.read_mio_version()
    return await asyncio.to_thread(about_service.check_update, current)


@router.post("/ingest")
async def plugin_ingest(payload: IngestPayload) -> dict[str, Any]:
    """插件（``packages/mao-pet``）把 phase 推进桌宠总线——本插件包**唯一的写入口**。

    链路::

        DSH 宿主进程内的 mao-pet 插件
          └─ POST /api/plugin/dsh/ingest        ← 本端点（回环受限，见下）
                └─ ingest.ingest()              ← 身份注册 + state 白名单收敛
                      └─ agent_bus_service.emit ← 节流/抢焦点/WS 广播都在这里
                            └─ WS agent_phase → 桌宠切动画

    **安全**：不在此处写栅栏——后端已装 ``LocalControlMiddleware``
    （``app/local_security.py``，挂载于 ``main.py``），全站强制"回环 Host + 同源 Origin +
    拒 ``Sec-Fetch-Site: cross-site``"，因此本写端点**自动**只接受本机来源。
    重复实现会让两处口径漂移，故有意留空。

    返回 400 表示 phase 不在总线词汇内（比让 ``emit`` 抛 ValueError 变成 500 更清楚）；
    422 由 FastAPI 对缺 ``phase`` 的请求体自动给出。
    """
    try:
        return await asyncio.to_thread(
            ingest.ingest,
            phase=payload.phase,
            agent_id=payload.agent_id,
            name=payload.name,
            accent=payload.accent,
            state=payload.state,
            force=payload.force,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class StripPayload(BaseModel):
    """插件推送的**横条动作**（7.6：DSH 流式提示专用窗位）。

    与 ``IngestPayload``（phase）分开建模，因为语义完全不同：
    一个是"我在干什么"（驱动动画/徽标），一个是"这条窗位显示什么"。
    """

    kind: str = Field(..., description="show / append / hide / style")
    text: str = Field("", description="show/append 必填")
    styleId: str = Field("", description="style 必填")
    sessionId: str = Field("", description="来源会话（可选）")
    durationMs: int = Field(0, description="自动隐藏时长，0=由主体决定")
    sticky: bool = Field(False, description="true=流式追加中，不排自动隐藏")
    agent_id: str = Field("", description="缺省 mao-pet")
    name: str = Field("", description="缺省 Mao-pet")
    accent: str = Field("", description="身份色，缺省 #4F6BED")


@router.post("/strip")
async def plugin_strip(payload: StripPayload) -> dict[str, Any]:
    """插件把**横条动作**推给桌宠（7.6 的最后一公里）。

    为什么需要这条：``__mioPetStrip`` 是**桌宠窗口**里的核心 API，
    而插件跑在 DSH 宿主进程、注入行所在的是 **DSH Web GUI 窗口** ——
    三者互不相通。所以横条内容必须走::

        插件 → 本端点 → 总线 → WS ``agent_strip`` → 桌宠窗口 → ``__mioPetStrip``

    **安全**：与 ``/ingest`` 同源，由后端全站 ``LocalControlMiddleware`` 兜底
    （回环 + 同源 + 拒 cross-site），此处不重复实现。
    """
    try:
        return await asyncio.to_thread(
            ingest.push_strip,
            kind=payload.kind,
            text=payload.text,
            style_id=payload.styleId,
            session_id=payload.sessionId,
            duration_ms=payload.durationMs,
            sticky=payload.sticky,
            agent_id=payload.agent_id,
            name=payload.name,
            accent=payload.accent,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/agent")
async def plugin_agent_snapshot(agent_id: str = "") -> dict[str, Any]:
    """该 agent 在总线上的当前快照（插件侧联调/自检用，只读）。"""
    return {"ok": True, "agent": ingest.snapshot_for(agent_id or ingest.DEFAULT_AGENT_ID)}


def _bus_status(info: dict[str, Any]) -> str:
    """从 inspect 快照推导对外状态词（online/offline/connecting/error/disabled）。"""
    if not info.get("enabled"):
        return "disabled"
    err = str(info.get("sidecar_error") or "")
    if err and not info.get("sidecar_alive"):
        return "error"
    if info.get("sidecar_alive"):
        return "online"
    if info.get("dsh_process_running") is False:
        return "offline"
    return "connecting"
