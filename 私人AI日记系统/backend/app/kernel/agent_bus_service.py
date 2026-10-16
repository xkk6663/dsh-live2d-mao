"""Agent 统一状态总线：让桌宠成为 Agent 工作状态的"脸"。

架构：
  渲染端(Electron/Live2D) ← WS agent_phase 事件 ← 本总线 ← 适配器层 ← Agent 源(DSH)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DSH 专用化说明（2026-10-17）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
上游本总线是**跨 Agent**设计（小智/DSH/Octop 都接进来）。本仓是 **DSH 专用**仓库，
已阉割 xiaozhi 与 octop 两个插件，故当前实际接入的 Agent 源**只有 DSH**。

⚠ 但**总线的多 Agent 骨架刻意保留不动**：
  - 注册表 / 活跃聚焦优先级 / inbox / heartbeat 都是**通用机制**，不是为某个插件写的；
  - 两条 DSH 链路（日志边车 `dsh_adapter` 与插件推送 `mao-pet_adapter`）**同时**在册，
    本身就用了多 Agent 调度（谁优先显示）；
  - 将来接入第二个 Agent 时无需重写总线。
  删掉这套骨架只会让代码更难用，不会让项目"更 DSH"—— 故不删。

职责：
- 统一 phase 枚举（10 基础 + 2 扩展），所有适配器输出必须落在枚举内；
- Agent 注册表：id / name / adapter / status / capabilities / last_seen；
- 活跃聚焦调度：按 phase 优先级决定"谁显示"，同 phase 节流，非活跃静默回退；
- inbox 队列：每个 agent 一个队列，保证事件有序消费；
- heartbeat：适配器定期上报存活，总线据此判断 agent 是否在线；
- 快照：/api/companion/agents 返回全部 agent 状态与当前活跃者；
- 广播：复用 pet_event_service 的 WS 通道，事件类型 agent_phase，渲染端零连接层改动。

设计原则：桌宠无状态，只认 phase；总线不感知任何 Agent 私有协议；
适配器是唯一接触原生协议的代码。新增 Agent 只需注册一个适配器。
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Deque

from ..companion import pet_event_service

# ---------------------------------------------------------------------------
# 统一 phase 枚举（10 基础 + 2 扩展）
# ---------------------------------------------------------------------------
PHASES: tuple[str, ...] = (
    "idle",              # 待机
    "planning",          # 规划任务
    "thinking",          # 思考中
    "executing_tool",    # 正在调用工具/执行动作
    "streaming",         # 文本流式输出
    "waiting_input",     # 等待用户输入（聆听）
    "voice",             # 语音播报中
    "complete",          # 单轮完成
    "error",             # 出错
    "paused",            # 暂停/断线待恢复
    "awaiting_approval", # 等待审批（借鉴 Paperclip）
    "heartbeat",         # 存活心跳（不改变动画）
)

# 活跃聚焦优先级：数值越小越优先占据"身体"（voice 最占注意力，idle 最低）
PHASE_PRIORITY: dict[str, int] = {
    "voice": 1,
    "executing_tool": 2,
    "awaiting_approval": 2,
    "thinking": 3,
    "planning": 3,
    "streaming": 4,
    "waiting_input": 4,
    "complete": 5,
    "error": 5,
    "paused": 5,
    "heartbeat": 5,
    "idle": 6,
}

# 同 agent 同 phase 节流（毫秒）：防止高频事件刷爆渲染端
THROTTLE_MS = 300
# 非活跃 agent 静默超过该时长后，调度器才允许让位给其他 pending 高优先级任务
STALE_MS = 8000
# 心跳超时：超过该时长未上报视为离线
HEARTBEAT_TIMEOUT_MS = 30_000
# 活跃 agent 完成（complete/idle）后保留显示该"身份"的时长，避免闪烁
ACTIVE_HOLD_MS = 1500

DEFAULT_CAPABILITIES: dict[str, Any] = {
    "voice": False,
    "text": True,
    "screen": False,
    "mcp": False,
    "observe": False,
}


class AgentState:
    """单个 Agent 源在总线上的投影。"""

    __slots__ = (
        "agent_id", "name", "adapter", "status", "enabled",
        "phase", "state", "meta", "seq", "capabilities", "accent",
        "last_phase_at", "last_seen", "last_heartbeat_at",
        "inbox", "active", "error",
    )

    def __init__(
        self,
        agent_id: str,
        name: str,
        adapter: str,
        capabilities: dict[str, Any] | None = None,
        enabled: bool = True,
        accent: str = "",
    ) -> None:
        self.agent_id = agent_id
        self.name = name
        self.adapter = adapter
        self.status = "offline"       # offline / connecting / online / error
        self.enabled = enabled
        self.phase = "idle"
        self.state: dict[str, Any] = {}
        self.meta: dict[str, Any] = {}
        self.seq = 0
        self.capabilities = {**DEFAULT_CAPABILITIES, **(capabilities or {})}
        now = time.monotonic()
        self.last_phase_at = 0.0
        self.last_seen = now
        self.last_heartbeat_at = 0.0
        self.inbox: Deque[dict[str, Any]] = deque(maxlen=200)
        self.active = False
        self.error = ""
        # 插件自声明的身份色（空 = 未声明，渲染端回落默认配色）
        self.accent = accent

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "name": self.name,
            "adapter": self.adapter,
            "status": self.status,
            "enabled": self.enabled,
            "phase": self.phase,
            "state": dict(self.state),
            "meta": dict(self.meta),
            "seq": self.seq,
            "capabilities": dict(self.capabilities),
            "accent": self.accent,
            "active": self.active,
            "last_seen": datetime.fromtimestamp(time.time()).astimezone().isoformat(timespec="seconds"),
            "error": self.error[:300],
        }


class AgentBus:
    """跨 Agent 统一状态总线。"""

    def __init__(self) -> None:
        self._agents: dict[str, AgentState] = {}
        self._active_agent_id: str | None = None
        self._lock = threading.Lock()
        self._config_path: Path | None = None
        self._last_broadcast_at: dict[tuple[str, str], float] = {}

    # ------------------------------------------------------------------
    # 注册与配置
    # ------------------------------------------------------------------
    def configure(self, config_path: Path) -> None:
        self._config_path = Path(config_path)
        self._load_enabled()

    def _load_enabled(self) -> None:
        if not self._config_path or not self._config_path.exists():
            return
        try:
            data = json.loads(self._config_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return
        enabled_map = data.get("agents") if isinstance(data, dict) else None
        if not isinstance(enabled_map, dict):
            return
        with self._lock:
            for agent_id, info in enabled_map.items():
                if agent_id in self._agents:
                    if isinstance(info, dict):
                        self._agents[agent_id].enabled = bool(info.get("enabled", True))

    def _persist_enabled(self) -> None:
        if not self._config_path:
            return
        try:
            with self._lock:
                enabled_map = {
                    aid: {"enabled": agent.enabled, "name": agent.name, "adapter": agent.adapter}
                    for aid, agent in self._agents.items()
                }
            data = {"version": 1, "agents": enabled_map}
            tmp = self._config_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self._config_path)
        except Exception:  # noqa: BLE001
            pass

    def register(
        self,
        agent_id: str,
        name: str,
        adapter: str,
        capabilities: dict[str, Any] | None = None,
        enabled: bool | None = None,
        accent: str = "",
    ) -> AgentState:
        """注册 Agent。

        ``accent`` 是**插件自己声明的身份色**（如 DSH 的靛蓝）。总线只是存下来
        并随 ``agent_phase`` / ``agent_bubble`` 透传给渲染端——这样桌宠窗口
        无需加载管理页的插件注册表也能拿到色值（两个窗口是不同 HTML 页面，
        早期实现因此拿不到色值，气泡不变蓝）。
        """
        with self._lock:
            existing = self._agents.get(agent_id)
            if existing is not None:
                existing.name = name or existing.name
                existing.adapter = adapter or existing.adapter
                if capabilities:
                    existing.capabilities = {**DEFAULT_CAPABILITIES, **capabilities}
                if enabled is not None:
                    existing.enabled = enabled
                if accent:
                    existing.accent = accent
                return existing
            state = AgentState(
                agent_id=agent_id,
                name=name,
                adapter=adapter,
                capabilities=capabilities,
                enabled=True if enabled is None else enabled,
                accent=accent,
            )
            self._agents[agent_id] = state
            return state

    def unregister(self, agent_id: str) -> None:
        with self._lock:
            self._agents.pop(agent_id, None)
            if self._active_agent_id == agent_id:
                self._active_agent_id = None

    def get(self, agent_id: str) -> AgentState | None:
        with self._lock:
            return self._agents.get(agent_id)

    def set_status(self, agent_id: str, status: str, *, error: str | None = None) -> None:
        agent = self.get(agent_id)
        if agent is None:
            return
        with self._lock:
            agent.status = status
            # error 显式传入才更新（含空串=清除）；不传则保留旧值，避免覆盖适配器细节
            if error is not None:
                agent.error = str(error)[:300]
            agent.last_seen = time.monotonic()
        self._maybe_broadcast_status(agent_id)

    def set_enabled(self, agent_id: str, enabled: bool) -> bool:
        agent = self.get(agent_id)
        if agent is None:
            return False
        with self._lock:
            agent.enabled = bool(enabled)
            if not enabled:
                agent.phase = "idle"
                agent.state = {}
                # 停用必须立即释放"身体"（README 6.3/6.9 的约定）：
                # 否则停用后该 agent 仍带 active=True，快照的 active_agent 会
                # 继续把它当成"当前显示者"，桌宠看着像没停用。
                agent.active = False
                if self._active_agent_id == agent_id:
                    self._active_agent_id = None
                    # 让位给其它已启用的 agent（下一轮事件会重新认领；这里
                    # 先把最近有活动的已启用者顶上，避免身体空置）
                    candidates = [a for a in self._agents.values() if a.enabled and a is not agent]
                    if candidates:
                        nxt = max(candidates, key=lambda a: a.last_phase_at)
                        self._active_agent_id = nxt.agent_id
                        nxt.active = True
        self._persist_enabled()
        self._broadcast_snapshot()
        return True

    def heartbeat(self, agent_id: str) -> None:
        agent = self.get(agent_id)
        if agent is None:
            return
        now = time.monotonic()
        with self._lock:
            agent.last_heartbeat_at = now
            agent.last_seen = now
            if agent.status == "offline":
                agent.status = "online"

    # ------------------------------------------------------------------
    # 核心：事件注入
    # ------------------------------------------------------------------
    def emit(
        self,
        agent_id: str,
        phase: str,
        state: dict[str, Any] | None = None,
        meta: dict[str, Any] | None = None,
        *,
        force: bool = False,
    ) -> None:
        """适配器向总线注入一个 phase 事件。

        - 节流：同 agent 同 phase 300ms 内重复丢弃（force 可绕过）；
        - 活跃聚焦：按优先级决定是否切换"谁显示"；
        - 广播：agent_phase 事件带 active 标志，渲染端据此驱动动画。
        """
        if phase not in PHASES:
            raise ValueError(f"未知 phase: {phase}")
        agent = self.get(agent_id)
        if agent is None:
            raise KeyError(f"未注册的 agent: {agent_id}")
        now = time.monotonic()
        key = (agent_id, phase)
        last = self._last_broadcast_at.get(key, 0.0)
        if not force and phase != "heartbeat" and (now - last) * 1000 < THROTTLE_MS:
            return
        self._last_broadcast_at[key] = now

        with self._lock:
            agent.phase = phase
            agent.seq += 1
            agent.last_phase_at = now
            agent.last_seen = now
            if state is not None:
                agent.state = dict(state)
            if meta is not None:
                agent.meta = dict(meta)
            self._decide_active_locked(agent, phase, now)

        if phase != "heartbeat":
            pet_event_service.publish(
                "agent_phase",
                {
                    "agent_id": agent_id,
                    "agent_name": agent.name,
                    "adapter": agent.adapter,
                    "phase": phase,
                    "state": dict(agent.state),
                    "meta": dict(agent.meta),
                    "seq": agent.seq,
                    "accent": agent.accent,
                    "active": agent.active,
                    "active_agent_id": self._active_agent_id,
                    "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
                },
            )

    def announce(self, agent_id: str, text: str, *, duration_ms: int = 0) -> bool:
        """插件向桌宠发**一条文本气泡**（不改 phase，不抢"身体"）。

        与 ``emit`` 的分工：``emit`` 表达"我在干什么"（驱动动画/徽标），
        ``announce`` 表达"我想说一句话"（只出气泡）。二者互不覆盖。

        颜色区分：气泡带 ``accent``（插件在 register 时自己声明的身份色），
        渲染端直接套用——**总线不认识任何具体插件**，只是把插件给的色值透传下去。

        返回 False 表示未广播（插件停用/文本为空）。
        """
        body = str(text or "").strip()
        if not body:
            return False
        with self._lock:
            agent = self._agents.get(agent_id)
            if agent is None or not agent.enabled:
                return False
            name = agent.name
            accent = agent.accent
        pet_event_service.publish(
            "agent_bubble",
            {
                "agent_id": agent_id,
                "agent_name": name,
                "accent": accent,
                "text": body,
                "duration_ms": max(0, int(duration_ms or 0)),
                "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
            },
        )
        return True

    def stream(self, agent_id: str, payload: dict[str, Any]) -> bool:
        """插件 → 桌宠**逐 token 流式文本**（增量追加渲染，按插件身份色显示）。

        与 ``announce`` 的分工：``announce`` 是"一次性说一句完整的话"（桌宠自己按
        字数做打字机）；``stream`` 是"把模型逐 token 的增量交给气泡"，由渲染端按
        上游节奏增量追加，因此比 announce 多带了 ``dt``（块间毫秒间隔）与
        ``final_text``（权威全文，用于收尾校正）。

        总线依旧**不认识任何具体插件**：``payload`` 由插件自定，总线只补
        ``agent_id`` / ``agent_name`` / ``accent`` 三个身份字段后透传。

        返回 False 表示未广播（插件停用/未注册/无正文）。
        """
        if not isinstance(payload, dict):
            return False
        texts = payload.get("texts")
        has_chunks = isinstance(texts, list) and any(str(t or "") for t in texts)
        if not has_chunks and not str(payload.get("final_text") or "").strip():
            return False
        with self._lock:
            agent = self._agents.get(agent_id)
            if agent is None or not agent.enabled:
                return False
            name = agent.name
            accent = agent.accent
            phase = agent.phase
            seq = agent.seq
        body = {
            "agent_id": agent_id,
            "agent_name": name,
            "accent": accent,
            # 渲染端据此判断"边车给的是不是我当前正在看的那条消息"
            "phase": phase,
            "bus_seq": seq,
            "ts": datetime.now().astimezone().isoformat(timespec="milliseconds"),
        }
        body.update(payload)
        pet_event_service.publish("agent_stream", body)
        return True

    def strip(self, agent_id: str, payload: dict[str, Any]) -> bool:
        """插件 → 桌宠**横条窗位**（7.6：DSH 流式提示专用窗）。

        为什么单独一条通道，而不是复用 ``stream`` / ``announce``：

          ============ ========================================== ==================
          通道         语义                                        渲染位置
          ============ ========================================== ==================
          ``announce`` "说一句完整的话"（按字数打字机）              说话气泡
          ``stream``   逐 token 正文，按上游节奏铺开                  说话气泡（流式）
          ``strip``    流式/提示的**横条窗位**，可拖动、可 ✕、可换肤   横条
          ============ ========================================== ==================

        三者是**独立管理**的三条通路（用户裁决）：关掉说话气泡不该影响横条，
        关掉横条也不该影响气泡。渲染端各认各的开关。

        ``payload.kind`` 决定横条动作：
          - ``"show"``   ：整段文本上屏（``text`` 必填），可选 ``durationMs``/``sticky``
          - ``"append"`` ：追加一段（``text`` 必填）—— 流式逐 token 用这个
          - ``"hide"``   ：收起内容（**不改**"用户已关闭"状态）
          - ``"style"``  ：应用皮肤（``styleId`` 必填）

        总线依旧**不认识任何具体插件**：``payload`` 由插件自定，总线只补身份字段后透传。
        返回 False 表示未广播（插件停用/未注册/kind 非法/内容为空）。
        """
        if not isinstance(payload, dict):
            return False
        kind = str(payload.get("kind") or "").strip().lower()
        if kind not in {"show", "append", "hide", "style"}:
            return False
        # show/append 必须有正文；hide/style 不需要
        if kind in {"show", "append"} and not str(payload.get("text") or "").strip():
            return False
        if kind == "style" and not str(payload.get("styleId") or "").strip():
            return False
        with self._lock:
            agent = self._agents.get(agent_id)
            if agent is None or not agent.enabled:
                return False
            name = agent.name
            accent = agent.accent
            seq = agent.seq
        body = {
            "agent_id": agent_id,
            "agent_name": name,
            "accent": accent,
            "bus_seq": seq,
            "ts": datetime.now().astimezone().isoformat(timespec="milliseconds"),
        }
        body.update(payload)
        pet_event_service.publish("agent_strip", body)
        return True

    def _decide_active_locked(self, agent: AgentState, phase: str, now: float) -> None:
        """活跃聚焦：谁有资格占据桌宠的"身体"。"""
        new_priority = PHASE_PRIORITY.get(phase, 6)
        current = self._active_agent_id
        current_agent = self._agents.get(current) if current else None

        if phase == "heartbeat":
            # 心跳不参与抢显示
            return

        # 已停用的 agent 绝不能占据"身体"（停用=立即释放，文档契约）
        if not agent.enabled:
            agent.active = False
            if self._active_agent_id == agent.agent_id:
                self._active_agent_id = None
            return

        # 事件源自己就是活跃者：直接更新
        if current == agent.agent_id:
            agent.active = True
            return

        # 当前活跃者不存在或已离线/被禁用：让位
        if current_agent is None or not current_agent.enabled:
            self._active_agent_id = agent.agent_id
            agent.active = True
            if current_agent is not None:
                current_agent.active = False
            return

        # 当前活跃者停在完成态且新事件优先级更高：让位
        current_priority = PHASE_PRIORITY.get(current_agent.phase, 6)
        if current_priority > new_priority:
            self._active_agent_id = agent.agent_id
            agent.active = True
            current_agent.active = False
            return

        # 当前活跃者静默超时：允许更高优先级的 pending 抢占
        if new_priority < current_priority and (now - current_agent.last_phase_at) * 1000 > STALE_MS:
            self._active_agent_id = agent.agent_id
            agent.active = True
            current_agent.active = False
            return

        # 同优先级：新事件覆盖旧事件源（后发优先，模拟"最近说话者"）
        if new_priority == current_priority and phase != "idle":
            if (now - current_agent.last_phase_at) * 1000 > THROTTLE_MS:
                self._active_agent_id = agent.agent_id
                agent.active = True
                current_agent.active = False

    # ------------------------------------------------------------------
    # 心跳扫描：离线检测
    # ------------------------------------------------------------------
    def _scan_heartbeats(self) -> None:
        now = time.monotonic()
        changed = False
        with self._lock:
            for agent in self._agents.values():
                if not agent.enabled:
                    continue
                if agent.last_heartbeat_at and (now - agent.last_heartbeat_at) * 1000 > HEARTBEAT_TIMEOUT_MS:
                    if agent.status not in {"offline", "error"}:
                        agent.status = "offline"
                        changed = True
        if changed:
            self._broadcast_snapshot()

    async def heartbeat_loop(self) -> None:
        while True:
            try:
                self._scan_heartbeats()
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(10)

    # ------------------------------------------------------------------
    # 查询与快照
    # ------------------------------------------------------------------
    def list_agents(self) -> list[dict[str, Any]]:
        with self._lock:
            return [agent.to_dict() for agent in self._agents.values()]

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            active_agent = None
            if self._active_agent_id in self._agents:
                candidate = self._agents[self._active_agent_id]
                if candidate.active:
                    active_agent = candidate.to_dict()
            return {
                "active_agent_id": self._active_agent_id if active_agent else None,
                "active_agent": active_agent,
                "agents": [agent.to_dict() for agent in self._agents.values()],
                "phase_priority": dict(PHASE_PRIORITY),
                "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
            }

    def _maybe_broadcast_status(self, agent_id: str) -> None:
        agent = self.get(agent_id)
        if agent is None:
            return
        pet_event_service.publish(
            "agent_status",
            {
                "agent_id": agent_id,
                "agent_name": agent.name,
                "status": agent.status,
                "enabled": agent.enabled,
                "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
            },
        )

    def _broadcast_snapshot(self) -> None:
        pet_event_service.publish("agents_snapshot", self.snapshot())


bus = AgentBus()


def register(
    agent_id: str,
    name: str,
    adapter: str,
    capabilities: dict[str, Any] | None = None,
    enabled: bool | None = None,
    accent: str = "",
) -> AgentState:
    """注册 Agent。``accent`` = 插件自己声明的身份色（见 ``AgentBus.register``）。"""
    return bus.register(agent_id, name, adapter, capabilities, enabled=enabled, accent=accent)


def unregister(agent_id: str) -> None:
    bus.unregister(agent_id)


def emit(agent_id: str, phase: str, state: dict[str, Any] | None = None, meta: dict[str, Any] | None = None, *, force: bool = False) -> None:
    bus.emit(agent_id, phase, state, meta, force=force)


def heartbeat(agent_id: str) -> None:
    bus.heartbeat(agent_id)


def announce(agent_id: str, text: str, *, duration_ms: int = 0) -> bool:
    """插件 → 桌宠文本气泡（按插件身份色显示）。见 ``AgentBus.announce``。"""
    return bus.announce(agent_id, text, duration_ms=duration_ms)


def stream(agent_id: str, payload: dict[str, Any]) -> bool:
    """插件 → 桌宠逐 token 流式文本（增量追加）。见 ``AgentBus.stream``。"""
    return bus.stream(agent_id, payload)


def strip(agent_id: str, payload: dict[str, Any]) -> bool:
    """插件 → 桌宠横条窗位（7.6：DSH 流式提示专用窗）。见 ``AgentBus.strip``。"""
    return bus.strip(agent_id, payload)


def set_status(agent_id: str, status: str, *, error: str | None = None) -> None:
    bus.set_status(agent_id, status, error=error)


def set_enabled(agent_id: str, enabled: bool) -> bool:
    return bus.set_enabled(agent_id, enabled)


def snapshot() -> dict[str, Any]:
    return bus.snapshot()


def list_agents() -> list[dict[str, Any]]:
    return bus.list_agents()


def get(agent_id: str) -> AgentState | None:
    return bus.get(agent_id)


def heartbeat_loop() -> None:
    return bus.heartbeat_loop()
