"""DSH（DeepSeek Harness）适配器：把 DSH 实时工作状态翻译成统一 phase。

接入方式（真实事件摄取，非占位框架）
------------------------------------
DSH 是 Electron + Node 的单 Agent 运行时。它的工作状态有两个可编程面：

1. **会话事件日志（本适配器采用）**——DSH 把每个会话的完整事件流持久化为
   拼接式 Zstandard 帧的 JSONL 文件::

       <DSH_HOME>/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd

   事件词汇是稳定的官方 ``SessionEvent`` 词汇（``turn/start``、``step/start``、
   ``tool/call``、``tool/result``、``assistant/message``、``approval/asked``、
   ``llm/retry``、``turn/end`` …），粒度最细，且**不需要 token/握手**。

2. **Host Cordis 事件流**（``ws://127.0.0.1:<port>/api/remote.mux``，``$events``）
   ——实时推送 ``api-session/status``、``api-session/error`` 等粗粒度事件，但需要
   browser-session 凭据签名 cookie，且**不含 per-turn/step/tool 粒度**。

本适配器走 (1)：由零依赖 Node 边车 ``dsh_log_stream.mjs`` 解码 zstd 帧并把事件
折叠成**客观事实(facts)**，Python 侧只做 facts → phase 的策略映射。这样
DSH 协议细节（帧格式、事件字段）全部隔离在边车里，总线与桌宠只认 phase。

进程拓扑::

    DSH 会话日志(.jsonl.zstd)
        └─ node dsh_log_stream.mjs        （协议侧：解码 + 折叠 facts）
              └─ NDJSON over stdout
                    └─ dsh_adapter.py      （策略侧：facts → phase → 总线）
                          └─ agent_bus_service → WS agent_phase → 桌宠

两条并行上报链路（互不耦合）
----------------------------
  ============= ========================== ==============================
  链路          边车 kind                 → WS 事件 → 桌宠效果
  ============= ========================== ==============================
  状态（主）     ``event`` / ``facts``      ``agent_phase``  徽标 + 动画
  正文（M1）     ``stream``                 ``agent_stream`` 气泡逐 token 追加
  ============= ========================== ==============================

正文链路**不参与 phase 计算**：一条 ``assistant/message`` 既会让 phase 变成
``streaming``（驱动"打字中"的动作），也会让正文按原始节奏逐块进气泡；两者
各自独立，任一失效都不影响另一条。

**逐 token 的真实来源与限制（实测，别想当然）**：会话日志里
``assistant/message`` 的 ``data.stream[]`` 含 ``text-chunks`` 帧（真增量 + 毫秒
时基 + 权威全文），但它**与紧随其后的 ``tool/call`` 同帧落盘**——即日志拿到
文本时该消息已经生成完毕（实测 2 个会话、1131 个 stream 事件全部单帧完整）。
所以当前实现是「**事后按 DSH 原始节奏回放**」，不是"边生成边出字"。
真·实时增量只能走下方"实测选型"表里的 Host WS ``session/follow`` 快通道；
渲染端消费的都是同一条 ``agent_stream``，将来换源不需要动前端。

phase 映射（facts → 12 个标准 phase 中 DSH 能显示的那些）
--------------------------------------------------------
DSH 原生能真实驱动的 phase（本适配器全部注册）：

  ==================== ============================================
  phase                触发条件
  ==================== ============================================
  ``planning``         轮次开始；或规划类工具（todo_write/create_goal）
  ``thinking``         步骤开始；工具结果返回后继续推理；LLM 重试中
  ``executing_tool``   工具调用进行中（``active_tools > 0``）
  ``streaming``        助手产出正文文本（``assistant/message`` 含 text）
  ``waiting_input``    等待用户交互（``ask_user_question`` 工具在跑）
  ``awaiting_approval`` ``approval/asked`` 后尚未 ``approval/decided``
  ``complete``         ``turn/end`` 且 ``reason.kind == "completed"``
  ``error``            工具失败 / ``turn/end`` 异常结束 / ``llm/retry``
  ``paused``           DSH 进程退出但日志仍在（连接中断）
  ``idle``             DSH 在线且当前无工作
  ``heartbeat``        保活（不改变桌宠动画）
  ==================== ============================================

**关于 ``voice``（前向兼容，非 DSH 原生）**：本版 DSH 没有任何 TTS/语音合成
服务（asar 内无 tts 包；官方 README 明确 "no speech synthesis"），语音输入
（STT）的转写结果只进输入框草稿，提交后与打字产生的 ``user/message`` 完全
不可区分，因此**录音/播报状态在 DSH 侧不可观测**。本适配器仍保留 ``voice``
phase 与 ``VOICE_TOOLS`` 映射：一旦部署了名为 ``speak``/``tts`` 的工具，
桌宠即自动按"说话中"呈现，无需改代码。``capabilities.voice`` 如实报 False。

**关于事件摄取通道（实测选型）**：DSH 有两个可编程面，均在本机实测过：

  ===================================== ========== ==========================
  通道                                  实测延迟   取舍
  ===================================== ========== ==========================
  会话日志 ``session.v4.jsonl.zstd``    p50 215ms  **本适配器采用**：无需鉴权、
    （拼接 zstd 帧）                     p90 237ms  无需发现端口、DSH 重启不失效
  Host WS ``/api/remote.mux``           p50 10ms   latency 更低且能拿到
    → ``session/follow``                 p90 78ms   assistant-stream 增量，
                                                    但需凭据 cookie 签名 + 端口发现
                                                    （端口是临时分配的，未持久化）
  ===================================== ========== ==========================

两者都能拿到全部 12 个事件（实测同一段时间各 12 条、seq 完全一致）。状态类
展示 215ms 已远优于 300ms 节流窗口与人眼感知，而日志通道在 DSH 重启/换端口/
无 GUI 时都不失效，故取日志为主通道；WS 快通道留作后续可选加速项。

配置（项目根 ``dsh_config.json``，已入 .gitignore）::

    {
      "enabled": true,
      "sessions_root": "",          # 留空 = <DSH_HOME>/sessions
      "workspace": "",              # 留空 = 本项目根（只跟随本项目会话）
      "session_id": "",             # 留空 = 自动选活跃会话（优先主会话）
      "node_path": "",              # 留空 = 自动探测 node
      "poll_ms": 400
    }
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from ...kernel import agent_bus_service
from . import dsh_signals

logger = logging.getLogger(__name__)

AGENT_ID = "dsh"
AGENT_NAME = "DSH"

# 本插件的身份色（靛蓝）：桌宠气泡/徽标用它区分"这条消息来自 DSH"。
# 与前端 ``plugins/dsh/manifest.js`` 的 bubble.accent、插件 routes.py 的
# plugin.accent 是**同一个值**——三处由自检断言保持一致，改一处不改另两处会报错。
DSH_ACCENT = "#4F6BED"

# DSH 的 12 phase 中，DSH 原生事件能真实驱动的“工作细分状态”。
# 桌宠徽标只展示这些 phase（与前端 WORK_PHASES 一致）。
#
# 逐项对应 DSH 真实事件（均经真实会话日志验证）：
#   planning          ← turn/start；todo_write / create_goal / update_goal
#   thinking          ← step/start；tool/result 之后继续推理；llm/retry(-started)
#   executing_tool    ← tool/call（active_tools > 0，即调用尚未返回）
#   streaming         ← assistant/message 且为**纯文字**（无 tool-call 块）
#   waiting_input     ← ask_user_question 工具在跑（DSH 真实存在的工具，见 dsh-tool-ask-user）
#   awaiting_approval ← approval/asked 后未 approval/decided（真实审批流，
#                        本机日志已观测到 asked→decided 配对）
#   voice             ← 仅当部署了 speak/tts 类工具时（DSH 本版无 TTS，见模块文档）
DSH_WORK_PHASES: tuple[str, ...] = (
    "planning",
    "thinking",
    "executing_tool",
    "streaming",
    "waiting_input",
    "voice",
    "awaiting_approval",
)
# 非工作态（不显示徽标，但仍驱动桌宠回到待机等基础动画）。
DSH_IDLE_PHASES: tuple[str, ...] = ("idle", "complete", "error", "paused")
# 本适配器在总线上的完整 phase 词汇（12 个）。
#
# 注意"注册"与"可达路径"是两件事，别混：
#   - 10 个由 ``phase_for_facts`` 从实时事件产出（见 DSH_WORK_PHASES + idle/complete/error）；
#   - ``paused`` 不走 facts——它由「DSH 进程还在但会话不可用」的连接中断分支直接 emit；
#   - ``heartbeat`` 刻意**不**作为 phase emit：总线的 ``emit()`` 对 heartbeat 不广播
#     agent_phase，且会把 agent.phase 写成 "heartbeat" 污染 Agent 页显示；保活一律走
#     ``agent_bus_service.heartbeat()``（这正是它存在的意义）。
DSH_PHASES: tuple[str, ...] = DSH_WORK_PHASES + DSH_IDLE_PHASES + ("heartbeat",)
# 可由实时事件（facts）直接产出的 phase 集合。
DSH_FACT_PHASES: tuple[str, ...] = DSH_WORK_PHASES + ("idle", "complete", "error")

# 边车脚本（与本体同目录）
SIDECAR_NAME = "dsh_log_stream.mjs"


def _resolve_sidecar_script() -> Path | None:
    """定位边车脚本，兼容两种布局（插件目录化前后）。

    历史：后端分层重构（P1）把适配器从 ``app/`` 迁到 ``app/agents/dsh/``，
    但边车脚本当时留在 ``app/``。硬编码 ``Path(__file__).with_name(...)``
    会因搬迁而静默失效——表现为"DSH 在线但状态永远 idle"。

    查找顺序：
      1. 与本模块同目录（插件包自足的期望位置）；
      2. 上两级（``app/``，搬迁前的历史位置）。

    找到即返回；都没有则返回 None，由调用方给出明确错误。
    """
    candidates = [
        Path(__file__).with_name(SIDECAR_NAME),
        Path(__file__).resolve().parents[2] / SIDECAR_NAME,
    ]
    for path in candidates:
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None

# DSH 进程名（用于在线/离线判定与 paused 上报）
DSH_PROCESS_NAMES = ("DeepSeek Harness.exe", "dsh.exe")

# 事件驱动的节流：phase 变化才上报；同一 phase 最长这么久补一次事件。
#
# 为什么要周期补发（而不是"变了才发"）：桌宠渲染端的动作/表情是有时限的
# （`live2d-pet.js`：speaking 4s、其余 2.6s 后回落到待机）。DSH 单次工具调用
# 可能持续几十秒（本机实测有 33s 的 pwsh 调用），这期间**没有任何新事件**；
# 若只在事件到达时上报，桌宠会在工具还在跑时就变回待机——看着像 DSH 停工了。
# 故把补发间隔压到桌宠活动窗口以内（2s < 2.6s），让"一直在干活"持续可见。
REEMIT_MS = 2000
# ★ 插件让位窗口（2026-10-17 合并身份）：插件推送带 plugin_owned 标记，
#   标记在最近这么多秒内 ⇒ 边车让位（插件是实时源）。超过则视为插件已停/崩，
#   边车自动恢复驱动 —— 不装插件、插件崩溃都不会让桌宠失去状态。
PLUGIN_OWN_TTL_SEC = 15.0
# 边车静默超过该时长视为异常，重启边车
SIDECAR_STALE_MS = 20_000
# ── 多会话徽标（2026-10-26 用户裁决）────────────────────────────────────────
# 只有这么多秒内被写过的会话才可能"正在跑"，才值得为它挂徽标。
ACTIVE_WINDOW_SECONDS = 180
# 同时最多跟踪多少个会话（每个要起一次 --once 子进程，别让它在极端情况下拖慢循环）。
MAX_TRACKED_SESSIONS = 4
# 多会话扫描的周期（毫秒）。比主 phase 上报慢一档：它要起子进程、开销更大，
# 而"另一个项目开始干活"晚 3 秒被看到完全可接受。
MULTI_SCAN_MS = 3000
# 读取超时（等待边车首行）
STARTUP_TIMEOUT_S = 20.0


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
def config_search_paths() -> list[Path]:
    """``dsh_config.json`` 的候选位置（按优先级）。

    本项目有两层"根"：``settings.project_root``（子项目 ``私人AI日记系统``，
    与 ``agent_bus_config.json`` 同级）和 ``settings.workspace_root``（仓库根，
    ``README.md`` / ``xiaozhi_device.json`` 所在）。两种叫法都有人用，故两处都找。
    """
    from ...config import settings

    paths: list[Path] = []
    for base in (
        getattr(settings, "project_root", None),
        getattr(settings, "workspace_root", None),
    ):
        if base is None:
            continue
        cand = Path(base) / "dsh_config.json"
        if cand not in paths:
            paths.append(cand)
    return paths


def dsh_config_path() -> Path:
    """实际生效的配置文件路径：已存在的优先，否则返回首选写入位置。"""
    paths = config_search_paths()
    for p in paths:
        try:
            if p.exists():
                return p
        except OSError:
            continue
    return paths[0]


def default_sessions_root() -> Path:
    """DSH 会话根目录：DSH_HOME 或 ~/.dsh 下的 sessions/。"""
    dsh_home = os.environ.get("DSH_HOME") or os.environ.get("MAO_DSH_HOME")
    base = Path(dsh_home) if dsh_home else Path.home() / ".dsh"
    return base / "sessions"


def default_workspace() -> str:
    r"""默认关注的工作区。

    ★★ 2026-10-25 两次修订的最终结论（用户两次反馈推动了它）：

    第一次（用户：换工作区后跟错会话）：
        原来这里恒返回 ""，边车 inWorkspace 恒 false → 纯 mtime 排序 →
        被**其它工作区更新的会话**带走。当时我改成"钉死本仓库根"，
        确实修好了跟错，但引入了新问题 ↓

    第二次（用户：另一个会话在跑，却只识别得到你这一个）：
        钉死 workspace 后，边车**只看本工作区**。用户同时在
        C:\Users\xiao1\Mao 开另一个 DSH 窗口跑任务时，桌宠完全感知不到 ——
        而 DSH 允许开多个窗口，这是常态用法。

    最终策略：**不限定工作区**（返回空串），把"别被陈旧会话带走"的责任
        交给边车的时间窗判据（dsh_log_stream.mjs 的 pickTarget）：
          · ACTIVE_WINDOW 内被写入 = 正在工作 → 优先跟随；
          · 多个都活跃时取**最近被写入**的（用户刚操作过的那个）；
          · 都不活跃就保持当前，不乱跳。
        这符合用户原话「让她自己寻找正在工作的会话」——
        不管那个会话在哪个工作区。

    想强制锁定某个目录时，在 dsh_config.json 显式配 workspace，
    或设 MIO_DSH_WORKSPACE 环境变量；适配器会原样透传。
    """
    import os

    return os.getenv("MIO_DSH_WORKSPACE", "").strip()


def _autodetect_enabled(sessions_root: str) -> bool:
    """没有 dsh_config.json 时，判断是否该自动启用（2026-10-18 通用性改造）。

    背景：`enabled` 默认 False，导致**新用户 clone 后必须手写配置**才能用 ——
    但绝大多数情况下 DSH 就在标准位置（`%USERPROFILE%\\.dsh\\sessions`），
    完全没必要让用户配。

    判据（保守，宁可不启用也不误启用）：
      · `DSH_HOME` 或 `~/.dsh/sessions` 目录**存在且非空**（真的有会话记录）
    ⇒ 说明这台机器装过并用过 DSH，直接启用即可开箱即用。
    用户仍可在 dsh_config.json 里写 `"enabled": false` 显式关掉（显式优先）。
    """
    try:
        root = Path(sessions_root) if sessions_root else default_sessions_root()
        if not root.is_dir():
            return False
        # 目录里至少有一个条目才算"用过 DSH"（空目录可能是刚装还没跑过）
        for _ in root.iterdir():
            return True
        return False
    except OSError:
        return False


def load_config() -> dict[str, Any]:
    default: dict[str, Any] = {
        "enabled": False,
        "sessions_root": "",
        "workspace": "",
        "session_id": "",
        "node_path": "",
        # 边车日志尾随轮询间隔。150ms 是"我方唯一能控的延迟项"：
        # 端到端延迟主要由 DSH 自身写盘节奏决定，但这一项纯属我方开销，越小越跟手。
        # 代价是空闲时每秒多读几次文件（stat + 只在变化时读增量，可忽略）。
        "poll_ms": 150,
        "base_url": "",
        "api_key": "",
        "ws_url": "",
    }
    path = dsh_config_path()
    explicit = False
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                default.update({k: v for k, v in data.items() if k in default})
                explicit = "enabled" in data      # 用户显式写了 enabled 就以他为准
        except Exception:  # noqa: BLE001
            logger.warning("读取 dsh_config.json 失败，使用默认配置")

    # ★ 2026-10-18 通用性改造：没写 enabled 时自动探测，换来"克隆即可用"。
    #   不填 sessions_root 也自动落到 ~/.dsh/sessions（default_sessions_root 已支持）。
    if not explicit and not default.get("enabled"):
        root = str(default.get("sessions_root") or "").strip() or str(default_sessions_root())
        if _autodetect_enabled(root):
            default["enabled"] = True
            if not str(default.get("sessions_root") or "").strip():
                default["sessions_root"] = root
            logger.info("检测到本机 DSH 会话目录，已自动启用 DSH 适配器：%s", root)
    return default


def resolve_node(config: dict[str, Any]) -> str | None:
    """定位 node 可执行文件：配置 > PATH > DSH 自带 runtime > 常见安装位置。"""
    configured = str(config.get("node_path") or "").strip()
    if configured:
        p = Path(configured)
        return str(p) if p.exists() else None

    found = shutil.which("node")
    if found:
        return found

    candidates: list[Path] = []
    dsh_home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    runtime_root = Path(dsh_home) / "dsh-runtimes"
    if runtime_root.exists():
        try:
            for child in runtime_root.iterdir():
                candidates.append(child / "dependencies" / "node" / "bin" / "node.exe")
                candidates.append(child / "dependencies" / "node" / "node.exe")
        except OSError:
            pass
    candidates.extend(
        [
            Path(r"C:\Program Files\nodejs\node.exe"),
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "node.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nodejs" / "node.exe",
        ]
    )
    for c in candidates:
        try:
            if c.is_file():
                return str(c)
        except OSError:
            continue
    return None


# ---------------------------------------------------------------------------
# DSH 进程检测（纯标准库 ctypes，零依赖）
# ---------------------------------------------------------------------------
def dsh_process_running() -> bool | None:
    """DSH 桌面进程是否在运行。None = 无法判定（非 Windows 或 API 不可用）。"""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260),
            ]

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]

        invalid = ctypes.c_void_p(-1).value
        snap = k32.CreateToolhelp32Snapshot(0x00000002, 0)
        if snap == invalid:
            return None
        wanted = {n.lower() for n in DSH_PROCESS_NAMES}
        try:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            ok = k32.Process32FirstW(snap, ctypes.byref(entry))
            while ok:
                if str(entry.szExeFile).lower() in wanted:
                    return True
                ok = k32.Process32NextW(snap, ctypes.byref(entry))
        finally:
            k32.CloseHandle(snap)
        return False
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# facts → phase（策略层：DSH 客观事实 → 桌宠统一 phase）
# ---------------------------------------------------------------------------
def phase_for_facts(facts: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """把边车折叠出的事实映射为 (phase, state)。

    ``state`` 是透传给桌宠的上下文（工具名、错误信息等），只放短字段。

    判定顺序即优先级：审批 > 等待用户 > 语音 > 错误 > 工具 > 流式 > 思考。
    """
    if not isinstance(facts, dict):
        return "idle", {}

    def _i(key: str) -> int:
        try:
            return int(facts.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    tool = str(facts.get("last_tool") or "")
    state: dict[str, Any] = {}
    if tool:
        state["tool"] = tool[:60]
    if _i("tool_calls"):
        state["tool_calls"] = _i("tool_calls")
    if facts.get("turn") is not None:
        state["turn"] = facts.get("turn")
    if facts.get("step") is not None:
        state["step"] = facts.get("step")
    if _i("todo_count"):
        state["todos"] = _i("todo_count")
    goal_op = str(facts.get("goal_operation") or "")
    if goal_op:
        state["goal"] = goal_op[:40]
    err = str(facts.get("last_error") or "")
    if err:
        state["error"] = err[:200]

    in_turn = bool(facts.get("in_turn"))

    # 1) 等待审批（桌宠表现：待确认）
    if _i("approvals_pending") > 0:
        return "awaiting_approval", state

    # 2) 等待用户交互 —— 工具在跑但语义是“等用户”
    if facts.get("awaiting_user"):
        return "waiting_input", state

    # 3) 语音播报
    if facts.get("voice_active"):
        return "voice", state

    # 4) 错误：仅“最近一个事件本身是失败”时进入 error，避免失败态粘住整轮
    if facts.get("last_event_failed"):
        return "error", state
    turn_reason = str(facts.get("turn_end_reason") or "")
    if turn_reason in {"error", "max-tokens", "interrupted"}:
        return "error", state

    # 5) 轮次结束
    if turn_reason == "completed":
        return "complete", state
    if turn_reason == "blocked":
        # preStep 被 hook 拒绝 → 提示词被拦下，系统在等用户换一个输入。
        # 与 DSH 官方桌宠投影一致（blocked → waiting），比归 idle 更准确。
        return "waiting_input", state
    if turn_reason in {"aborted", "forked"}:
        # aborted：会话被停；forked：轮次延续到子会话。都不该让桌宠挂在工作态。
        return "idle", state

    # 6) 轮次内工作态
    if in_turn:
        if _i("active_tools") > 0:
            return "executing_tool", state
        # 规划意图（轮次开始 / todo_write / goal/change / 规划类工具）优先于思考：
        # 它表达的是"正在梳理要做什么"，与"正在推理怎么做"是不同的桌宠表现。
        if facts.get("plan_intent"):
            return "planning", state
        # 「正在输出正文」= 最近一条 assistant/message 是**纯文字**（无 tool-call）。
        # 实测真实日志：335/377 条 assistant/message 同时含 tool-call 块，所以
        # 不能拿 has_text 当判据，否则会长期误报 streaming。
        if facts.get("last_message_text_only"):
            return "streaming", state
        if facts.get("retrying"):
            return "thinking", state
        return "thinking", state

    # 7) 轮次外：在线待机
    return "idle", state


def is_work_phase(phase: str) -> bool:
    """是否为「工作中」细分状态（决定是否显示桌宠头顶徽标）。"""
    return phase in DSH_WORK_PHASES


# ---------------------------------------------------------------------------
# 兼容旧接口：DSH 事件字典 → (phase, state)
# ---------------------------------------------------------------------------
def parse_dsh_event(event: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """把单个 DSH 会话事件映射为 (phase, state)。

    保留此函数用于**单事件**的粗粒度映射与测试；实时链路走 facts 折叠
    （``phase_for_facts``），因为单事件无法表达“审批是否已结束”“工具是否还在跑”
    这类跨事件的聚合语义。
    """
    if not isinstance(event, dict):
        return None
    etype = str(event.get("type") or "").lower()
    payload = event.get("data") if isinstance(event.get("data"), dict) else {}
    payload = payload or {}
    if etype == "turn/start":
        return "planning", {"turn": payload.get("turn")}
    if etype == "turn/end":
        reason = payload.get("reason") or {}
        kind = str(reason.get("kind") or "") if isinstance(reason, dict) else ""
        if kind == "completed":
            return "complete", {}
        if kind in {"error", "max-tokens", "interrupted"}:
            return "error", {"reason": kind}
        return "idle", {}
    if etype == "step/start":
        return "thinking", {"step": payload.get("step")}
    if etype in {"tool/call", "tool/start"}:
        name = str(payload.get("name") or "")
        lname = name.lower()
        if lname in {"ask_user_question", "ask_user", "askuserquestion"}:
            return "waiting_input", {"tool": name[:60]}
        if lname in {"todo_write", "create_goal", "update_goal"}:
            return "planning", {"tool": name[:60]}
        if lname in {"speak", "tts", "text_to_speech"}:
            return "voice", {"tool": name[:60]}
        return "executing_tool", {"tool": name[:60]}
    if etype == "tool/result":
        msg = payload.get("message") if isinstance(payload.get("message"), dict) else {}
        if payload.get("error") is not None or msg.get("isError") is True:
            return "error", {"tool_failed": True}
        return "thinking", {}
    if etype in {"text/stream", "stream/start"}:
        return "streaming", {"text": str(payload.get("text") or "")[:200]}
    if etype == "assistant/message":
        content = (payload.get("message") or {}).get("content") or []
        kinds = {str(c.get("type")) for c in content if isinstance(c, dict)}
        if "text" in kinds:
            return "streaming", {}
        if "reasoning" in kinds:
            return "thinking", {}
        if "tool-call" in kinds:
            return "executing_tool", {}
        return None
    if etype in {"approval/asked", "awaiting_approval", "approval/required"}:
        return "awaiting_approval", {"tool": str(payload.get("toolName") or "")[:60]}
    if etype == "approval/decided":
        return None
    if etype in {"llm/retry", "llm/retry-started"}:
        return "error", {"retrying": True}
    if etype == "user/message":
        kind = str((payload.get("source") or {}).get("kind") or "")
        return ("waiting_input" if kind == "voice" else "thinking"), {}
    if etype in {"session/start", "session/ready"}:
        return "idle", {}
    if etype.startswith("error"):
        return "error", {"message": str(payload)[:200]}
    return None


# ---------------------------------------------------------------------------
# 边车进程管理
# ---------------------------------------------------------------------------
class DshLogSidecar:
    """管理 ``node dsh_log_stream.mjs`` 子进程，逐行产出 NDJSON 消息。

    实现说明（跨平台踩坑记录）
    -------------------------
    Windows 上 ``asyncio.create_subprocess_exec`` 会用 **overlapped 命名管道**
    建立 stdio；在受限/隐藏窗口环境下会直接 ``PermissionError: [WinError 5]``
    （本机已实测复现）。而 ``subprocess.Popen`` + ``PIPE`` + 后台线程逐行读
    在同一环境下稳定可用，故这里用线程读取 + ``asyncio.Queue`` 桥接到事件循环：

        node 边车 stdout ──(后台线程 readline)──▶ asyncio.Queue ──▶ 适配器协程
    """

    def __init__(self, node_path: str, script: Path, args: list[str]) -> None:
        self.node_path = node_path
        self.script = script
        self.args = args
        self.proc: subprocess.Popen | None = None
        self._lines: "asyncio.Queue[str | None]" = asyncio.Queue(maxsize=2000)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._reader: threading.Thread | None = None
        self._stderr_reader: threading.Thread | None = None
        self._closing = threading.Event()
        self.last_message_at: float = 0.0
        self.ready = False
        self.info: dict[str, Any] = {}

    # -- 启动/停止 --------------------------------------------------------
    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """同步启动子进程（调用方在 to_thread 中执行，避免阻塞事件循环）。

        ``loop`` 由调用方（事件循环所在线程）显式传入：``start`` 跑在工作线程里，
        那里没有运行中的事件循环，读线程需要用它把行投递回 asyncio 队列。
        """
        creationflags = 0
        startupinfo = None
        if sys.platform == "win32":
            # 不弹控制台窗口（桌宠后端本身是隐藏窗口启动的）
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

        self._closing.clear()
        self.proc = subprocess.Popen(  # noqa: S603
            [self.node_path, str(self.script), *self.args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
            startupinfo=startupinfo,
        )
        self._loop = loop
        self.last_message_at = loop.time()
        self._reader = threading.Thread(target=self._read_stdout, name="dsh-sidecar-out", daemon=True)
        self._reader.start()
        self._stderr_reader = threading.Thread(target=self._read_stderr, name="dsh-sidecar-err", daemon=True)
        self._stderr_reader.start()

    def _publish(self, item: str | None) -> None:
        """线程侧投递一行到事件循环队列（丢行好过阻塞读取线程）。"""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._put_nowait, item)
        except RuntimeError:
            pass

    def _put_nowait(self, item: str | None) -> None:
        if self._closing.is_set():
            return
        try:
            self._lines.put_nowait(item)
        except asyncio.QueueFull:
            # 队列满：丢最旧的一行再放（保持实时性，绝不阻塞读取线程）
            try:
                self._lines.get_nowait()
            except Exception:  # noqa: BLE001
                pass
            try:
                self._lines.put_nowait(item)
            except Exception:  # noqa: BLE001
                pass

    def _read_stdout(self) -> None:
        proc = self.proc
        if proc is None or proc.stdout is None:
            self._publish(None)
            return
        try:
            for raw in proc.stdout:
                if self._closing.is_set():
                    break
                line = (raw or "").strip()
                if line:
                    self._publish(line)
        except Exception as exc:  # noqa: BLE001
            logger.debug("DSH 边车 stdout 读取结束：%s", exc)
        finally:
            self._publish(None)

    def _read_stderr(self) -> None:
        proc = self.proc
        if proc is None or proc.stderr is None:
            return
        try:
            for raw in proc.stderr:
                if self._closing.is_set():
                    break
                text = (raw or "").strip()
                if text:
                    logger.debug("[dsh-sidecar] %s", text[:400])
        except Exception:  # noqa: BLE001
            return

    async def next_message(self, timeout: float) -> str | None:
        """取下一行；超时返回 ''；进程结束返回 None。"""
        try:
            item = await asyncio.wait_for(self._lines.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return ""
        if item is not None:
            loop = asyncio.get_running_loop()
            self.last_message_at = loop.time()
        return item

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def returncode(self) -> int | None:
        return self.proc.poll() if self.proc is not None else None

    def stop(self) -> None:
        """同步停止（可用 to_thread 调用）；幂等。"""
        self._closing.set()
        proc, self.proc = self.proc, None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass
            try:
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        # 关掉管道，唤醒读取线程
        for stream in (getattr(proc, "stdout", None), getattr(proc, "stderr", None)):
            try:
                if stream is not None:
                    stream.close()
            except Exception:  # noqa: BLE001
                pass
        for thread in (self._reader, self._stderr_reader):
            if thread is not None and thread.is_alive() and thread is not threading.current_thread():
                thread.join(timeout=2)
        self._reader = None
        self._stderr_reader = None
        # 清空残留，避免下次启动读到旧行
        self._lines = asyncio.Queue(maxsize=2000)
        self.last_message_at = 0.0


# ---------------------------------------------------------------------------
# 适配器主循环
# ---------------------------------------------------------------------------
class DshAdapter:
    """DSH 状态适配器：边车事件 → facts → phase → 总线。"""

    def __init__(self) -> None:
        self.sidecar: DshLogSidecar | None = None
        self.facts: dict[str, Any] = {}
        self.last_phase = ""
        self.last_emit_at = 0.0
        self.session_id = ""
        self.sidecar_error = ""
        # 多会话徽标：上一轮上报过的子 agent（dsh:<短id>），用于把消失的标 offline
        self._known_session_agents: set[str] = set()
        self._last_multi_scan_at = 0.0
        # 主 agent 当前工作区名（只用于徽标显示，**不改** agent.name）
        self._main_workspace_name = ""

    # -- 生命周期 ---------------------------------------------------------
    async def _ensure_sidecar(self, config: dict[str, Any]) -> bool:
        node = resolve_node(config)
        if not node:
            self.sidecar_error = "未找到 node 可执行文件：请安装 Node.js 或配置 dsh_config.json 的 node_path"
            return False
        script = _resolve_sidecar_script()
        if script is None:
            self.sidecar_error = (
                f"缺少边车脚本 {SIDECAR_NAME}（已在插件目录与 app 目录查找）"
            )
            return False

        args: list[str] = []
        sessions_root = str(config.get("sessions_root") or "").strip()
        args += ["--sessions-root", sessions_root or str(default_sessions_root())]
        workspace = str(config.get("workspace") or "").strip() or default_workspace()
        args += ["--workspace", workspace]
        session_id = str(config.get("session_id") or "").strip()
        if session_id:
            args += ["--session-id", session_id]
        try:
            poll_ms = max(80, int(config.get("poll_ms") or 150))
        except (TypeError, ValueError):
            poll_ms = 150
        args += ["--poll-ms", str(poll_ms)]
        # ★ 2026-10-24 修「切到别的工作区后桌宠看不到工作状态」：
        #   边车靠 pickTarget() 决定「现在跟哪个会话」。它原来看的就两样：
        #   --workspace（适配器恒传空串 → 本工作区判据永远失效）+ mtime 差值 2500ms
        #   （用户在新工作区偶发一条消息时，差值到不了 → 永远切不过去）。
        #   现在把两个时间窗显式传下去，让"正在被写入的会话"能直接接管；
        #   默认值由边车定义（120s 活跃 / 5min 陈旧），这里只在用户显式配置时覆盖。
        for _key, _flag in (
            ("active_window_ms", "--active-window-ms"),
            ("stale_window_ms", "--stale-window-ms"),
            ("stale_takeover_ms", "--stale-takeover-ms"),
        ):
            _raw = config.get(_key)
            if _raw in (None, ""):
                continue
            try:
                _val = int(_raw)
            except (TypeError, ValueError):
                continue
            if _val >= 0:
                args.append(_flag)
                args.append(str(_val))

        if self.sidecar is not None and self.sidecar.alive():
            return True
        # 旧边车（若还在）先停干净，避免两个读取器抢同一份输出
        if self.sidecar is not None:
            await asyncio.to_thread(self.sidecar.stop)
            self.sidecar = None
        sidecar = DshLogSidecar(node, script, args)
        loop = asyncio.get_running_loop()
        try:
            await asyncio.to_thread(sidecar.start, loop)
        except Exception as exc:  # noqa: BLE001
            self.sidecar_error = f"边车启动失败：{exc}"
            try:
                await asyncio.to_thread(sidecar.stop)
            except Exception:  # noqa: BLE001
                pass
            return False
        self.sidecar = sidecar
        self.sidecar_error = ""
        return True

    def _online_lost(self) -> bool:
        """边车迟迟没有消息且进程也不在 → 视为 DSH 没在跑。"""
        if self.sidecar is None:
            return True
        if self.sidecar.alive():
            return False
        return True

    # -- 上报 -------------------------------------------------------------
    def _bus_enabled(self) -> bool:
        """总线上的启用开关（MIO 管理窗口 → Agent 页切换，持久化于 agent_bus_config.json）。

        与 ``dsh_config.json`` 的 ``enabled``（部署就绪开关）是两个不同层次：
        - ``dsh_config.json.enabled``：DSH 是否部署/接好（没接好就没必要跟）；
        - 总线 ``enabled``：用户是否让 DSH 显示在桌宠上（即换即用）。
        两者都为真才上报 phase，否则停用必须立即释放桌身。
        """
        try:
            state = agent_bus_service.get(AGENT_ID)
        except Exception:  # noqa: BLE001
            return True
        if state is None:
            return True
        return bool(state.enabled)

    def _plugin_owns_bus(self) -> bool:
        """插件（packages/dsh-live2d-mao）是否正在驱动总线上的 `dsh` 身份。

        ★ 2026-10-17 合并身份（用户裁决）：插件推送时复用 `agent_id="dsh"`，
          桌宠上只显示一个 DSH agent（不再有 Mao-pet / DSH 两个徽标抢镜头）。
          但两条链路（本边车 + 插件）都会 emit 同一个 agent，若同时推会互相覆盖
          造成 phase 抖动。故规则：**插件在线时边车让位**（插件是实时源、更新的更准）。

        判据：总线快照里 `dsh` 的最近状态带 `plugin_owned` 标记，且该标记在
        `PLUGIN_OWN_TTL_SEC` 内（插件崩溃/卸载后自动回落到边车驱动，不会永久让位）。
        """
        try:
            agent = agent_bus_service.get(AGENT_ID)
            if agent is None:
                return False
            state = getattr(agent, "state", None) or {}
            if not (isinstance(state, dict) and state.get("plugin_owned")):
                return False
            last_at = float(getattr(agent, "last_phase_at", 0) or 0)
            # last_phase_at 是 monotonic 秒（emit 内部用 time.monotonic() 写）
            age = time.monotonic() - last_at if last_at > 0 else 1e9
            return age <= PLUGIN_OWN_TTL_SEC
        except Exception:  # noqa: BLE001
            return False

    def _emit_phase(self, phase: str, state: dict[str, Any], *, force: bool = False) -> None:
        if not self._bus_enabled():
            # 已停用：不发任何 phase（避免停用后仍抢桌宠身体）
            self.last_phase = ""
            return
        # ★ 插件在线 → 边车让位（插件复用 dsh 身份且是实时源，见 _plugin_owns_bus）
        if self._plugin_owns_bus():
            self.last_phase = ""
            return
        now = asyncio.get_running_loop().time()
        changed = phase != self.last_phase
        stale = (now - self.last_emit_at) * 1000 > REEMIT_MS
        if not (changed or stale or force):
            return
        if not changed and not force and not is_work_phase(phase):
            # 非工作态不必周期性重复上报（避免刷屏）
            return
        try:
            # force=True：本函数已按 phase 变化 + REEMIT_MS 自行节流，
            # 总线的 300ms 同 phase 节流不该再吃掉我们的「立即恢复」语义。
            agent_bus_service.emit(AGENT_ID, phase, state=dict(state), force=True)
        except Exception as exc:  # noqa: BLE001
            logger.debug("DSH emit phase=%s 失败：%s", phase, exc)
            return
        self.last_phase = phase
        self.last_emit_at = now

    # -- 多会话扫描（多任务徽标）------------------------------------------------
    def _scan_all_sessions(self, config: dict[str, Any]) -> list[dict[str, Any]]:
        """扫描所有**正在跑任务**的 DSH 会话，让桌宠为每个挂一个徽标。

        ★ 2026-10-26 用户裁决：「会话锁死你这个任务进程了，要不就做多任务徽标吧，
          多任务时新增徽标显示正在工作的任务状态」。

        背景：一个 DSH 实例可以同时开多个工作区窗口，每个窗口一个会话。
          单会话跟随时（pickTarget 只选一个），另一个项目在跑就永远看不到 ——
          实测两个会话 in_turn 都是 true，切来切去总有一个被牺牲。
          改为**多徽标**：每个在跑的会话各自一个 agent 身份，
          桌宠的 renderAgentBadge 本来就是遍历 Map 渲染多个 chip，天然支持。

        实现：用边车 --session-id <id> --once 逐个取 facts（复用它的完整解析，
          不在这边重写 zstd/turn 折叠）。只扫 ACTIVE_WINDOW 内碰过的会话。

        返回 [{"session_id", "facts", "cwd", "mtime"}...]，按最后活动时间降序。
        """
        node = resolve_node(config)
        script = _resolve_sidecar_script()
        if not node or script is None:
            return []
        root = Path(str(config.get("sessions_root") or "").strip() or str(default_sessions_root()))
        if not root.is_dir():
            return []
        now = time.time()
        active: list[tuple[float, str, Path]] = []
        try:
            slugs = [d for d in root.iterdir() if d.is_dir()]
        except OSError:
            return []
        for slug_dir in slugs:
            try:
                sessions = [d for d in slug_dir.iterdir() if d.is_dir()]
            except OSError:
                continue
            for s in sessions:
                log = s / "session.v4.jsonl.zstd"
                if not log.is_file():
                    continue
                try:
                    mtime = log.stat().st_mtime
                except OSError:
                    continue
                if now - mtime <= ACTIVE_WINDOW_SECONDS:
                    active.append((mtime, s.name, log))
        active.sort(key=lambda x: -x[0])
        out: list[dict[str, Any]] = []
        for mtime, sid, log in active[:MAX_TRACKED_SESSIONS]:
            try:
                raw = subprocess.run(
                    [node, str(script), "--sessions-root", str(root), "--session-id", sid, "--once"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=25,
                )
            except (OSError, subprocess.SubprocessError):
                continue
            facts: dict[str, Any] = {}
            cwd = ""
            for line in (raw.stdout or "").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                kind = str(ev.get("kind") or "")
                if kind == "facts":
                    facts = ev.get("facts") or {}
                elif kind == "ready":
                    cwd = str(ev.get("cwd") or "")
            if not facts:
                continue
            out.append({"session_id": sid, "facts": facts, "cwd": cwd, "mtime": mtime})
        return out

    def _publish_multi_session_badges(self, config: dict[str, Any]) -> None:
        """为每个并行工作的会话注册一个**子身份** ``dsh:<短id>``，桌宠据此显示多徽标。

        ★★ 2026-10-26 架构口径（用户两次裁决后的定论）：

          用户先说：「这两个会话工作状态应该都是隶属 DSH 插件的吧」
          用户再说：「符合一切皆插件原则，dsh 插件不用动桌宠主体插件」

          两条合起来的意思是：
            · 桌宠主体是**通用多 agent 渲染器**（agentBadgeStates 是 Map，
              renderAgentBadge 遍历它画 chip）—— 它不认任何具体插件，
              所以**绝不能让桌宠去理解"DSH 的会话列表"这种插件私有结构**；
            · 会话的归属问题（"看起来像多装了插件"）应该在**插件自己这边**
              标记清楚，让插件列表类 UI 过滤掉，而不是改桌宠或改总线。

          所以这里的实现是：
            · 子身份仍然注册进总线（这是桌宠能画多徽标的**唯一**通用途径）；
            · 但 capabilities/state 里带 ``is_sub=True`` + ``parent_agent="dsh"``，
              明确声明"我是 DSH 的子会话，不是独立插件"；
            · 右侧工作栏 / 插件列表等 UI 读到这两个字段就过滤掉
              （见 rail-switch-inject.js 的 isSubAgent）；
            · 桌宠徽标照常显示（它就该显示所有活跃 agent）。
        """
        if not self._bus_enabled():
            return
        try:
            sessions = self._scan_all_sessions(config)
        except Exception as exc:  # noqa: BLE001
            logger.debug("多会话扫描失败：%s", exc)
            return

        # ★★ 2026-10-26 最终形态：**所有会话完全平级**。
        #   用户：「一定要分主会话和子会话吗？不能平等轮询平等前端展示会话状态吗？」
        #   —— 对，之前的主/子分层是实现路径留下的包袱，不是设计需要：
        #     · 主 agent(dsh) 由边车实时流驱动，子会话靠 3 秒轮询，
        #       两条链路两套代码，更新粒度和可靠性都不一样；
        #     · 前端还带「主」标签，看着像有主从关系。
        #   现在统一：**每个会话一律注册成 dsh:<短id>**，同一个循环、
        #   同一套字段、同一个刷新节奏，没有主/子之分。
        #   总线上另保留一个 dsh（插件本体，无 workspace 字段），
        #   它只代表"DSH 这个插件"，不代表某个会话 —— rail 里就显示它。
        alive_ids: set[str] = set()
        for item in sessions:
            sid = str(item["session_id"])
            facts = item["facts"] or {}
            # 只给**正在跑任务**的会话挂状态：已结束的不占视觉位置
            if not facts.get("in_turn"):
                continue
            short = sid.replace("session-", "")[:8]
            sess_agent_id = f"{AGENT_ID}:{short}"
            alive_ids.add(sess_agent_id)
            cwd = str(item.get("cwd") or "")
            label = Path(cwd).name if cwd else short
            try:
                agent_bus_service.register(
                    sess_agent_id,
                    # name 恒为 AGENT_NAME：它是"哪个插件"的身份（rail/市场读它）。
                    # 工作区名走 state.badge_name，只影响徽标文案。
                    AGENT_NAME,
                    "dsh_adapter",
                    capabilities={
                        "voice": False, "text": True, "screen": False,
                        "mcp": False, "observe": False,
                        # 会话身份（非独立插件）：插件列表类 UI 据此过滤。
                        "is_sub": True, "parent_agent": AGENT_ID,
                        # 平级标记：现在所有会话都是这个层级，没有主/子。
                        "session_level": True,
                    },
                    accent=DSH_ACCENT,
                    on_demand=True,
                )
                phase, state = phase_for_facts(facts)
                state = dict(state)
                state["session"] = sid
                state["workspace"] = label
                state["badge_name"] = label
                state["is_sub"] = True
                state["parent_agent"] = AGENT_ID
                state["session_level"] = True
                agent_bus_service.emit(sess_agent_id, phase, state=state, force=True)
                agent_bus_service.heartbeat(sess_agent_id)
            except Exception as exc:  # noqa: BLE001
                logger.debug("会话 %s 上报失败：%s", sess_agent_id, exc)

        # 收尾：已结束的会话身份直接注销（标 offline 会留垃圾记录）
        for known in list(self._known_session_agents):
            if known in alive_ids:
                continue
            try:
                agent_bus_service.unregister(known)
            except Exception:  # noqa: BLE001
                pass
        self._known_session_agents = alive_ids

    def _sync_main_agent_name(self, cwd: str) -> None:
        """记录当前工作区名，供**徽标**显示；但**不改 agent 的 name**。

        ★ 2026-10-26 两次裁决，最终口径：

          用户先说：「徽标前面的 DSH 显示成当前工作区名称」
          用户后说：「右侧插件状态栏和插件市场插件名称不一致」

          这两条看着矛盾，其实是两个不同的字段被我混用了：
            · agent.name 是**插件身份**，必须恒为 "DSH"，
              它要和插件清单（数据/插件市场.json 的 name）一致，
              rail、市场、设置页 tab 全都读它；
            · 徽标上想显示的是**当前会话的工作区名**，那是运行期信息，
              属于 state，不属于身份。

          上一版我直接把 agent.name 改成工作区目录名，导致 rail 显示
          "Mao-dsh-pet" 而市场显示 "DSH" —— 就是用户看到的名称不一致。
          现在改成写 state.badge_name：徽标优先读它，没有才回落 name。
          rail / 市场永远只认 name，两边从此不会再漂移。

          （2026-10-26 再修订：会话全部平级后，"主会话"这个概念只剩
            "边车当前跟随的是哪个"这层含义，仅用于派生 dsh 插件本体的
            phase 显示，不再影响任何会话身份。）
        """
        name = Path(cwd).name if cwd else ""
        self._main_workspace_name = name
        # 注意：这里**刻意不动** agent.name，也不调 register 改名。
        # 工作区名经 _publish_facts 的 state["badge_name"] 下发（见下）。

    def _publish_facts(self, facts: dict[str, Any], *, force: bool = False) -> None:
        self.facts = facts if isinstance(facts, dict) else {}
        phase, state = phase_for_facts(self.facts)
        # 透传关键上下文，便于 Agent 页/桌宠气泡展示
        for key in ("tool", "turn", "step", "tool_calls"):
            if key in self.facts and key not in state:
                state[key] = self.facts[key]
        err = str(self.facts.get("last_error") or "")
        if err and "error" not in state:
            state["error"] = err[:200]
        if self.session_id:
            state["session"] = self.session_id
        # ★ 2026-10-26 会话平级后的分工：
        #   · dsh（本条，插件本体）只代表"DSH 这个插件"，**不画会话徽标**。
        #     它带 plugin_self=True，桌宠渲染端据此跳过，避免与会话徽标重复。
        #   · 每个会话是 dsh:<短id>，各自画一条徽标（badge_name=工作区名）。
        #   rail / 插件市场只认 dsh 这条，所以列表里永远是"一个 DSH 插件"。
        state["plugin_self"] = True
        if self._main_workspace_name:
            state["workspace"] = self._main_workspace_name
        self._emit_phase(phase, state, force=force)
        # DSH 独有信号 → 桌宠气泡：审批/提问挂起时主动播报一句
        # （phase 已表达"在等"，气泡负责"主动叫你"，二者不重叠）
        # ★ 插件在线时同样让位（否则插件与边车会各冒一句，重复打扰）。
        try:
            if not self._plugin_owns_bus():
                dsh_signals.maybe_announce_waiting(AGENT_ID, self.facts)
        except Exception:  # noqa: BLE001
            logger.debug("DSH 等待播报失败（不影响主链路）", exc_info=True)

    def _publish_stream(self, msg: dict[str, Any]) -> None:
        """逐 token 流式：把边车给的一段正文增量交给总线（→ 桌宠气泡追加渲染）。

        与 phase 链路**完全解耦**：只出气泡，不改 phase、不抢桌宠"身体"
        （与 ``agent_bus_service.announce`` 同一分层）。

        门控两道，缺一不可：
        - 总线 ``enabled``：用户在 MIO 管理页停用 DSH 时不该继续冒泡；
        - 会话一致性：边车切会话后仍在飞的旧消息（``msg.session`` 与当前不符）
          直接丢掉，避免"上一个会话的正文"糊到新会话上。
        """
        if not self._bus_enabled():
            return
        session = str(msg.get("session") or "")
        if session and self.session_id and session != self.session_id:
            return
        texts = msg.get("texts")
        payload = {
            "session": session,
            "turn": msg.get("turn"),
            "step": msg.get("step"),
            "seq": msg.get("seq"),
            "index": msg.get("index"),
            "frame": str(msg.get("frame") or "text-chunks"),
            "time0": msg.get("time0"),
            "dt": msg.get("dt") if isinstance(msg.get("dt"), list) else [],
            "texts": texts if isinstance(texts, list) else [],
            "final_text": str(msg.get("final_text") or ""),
            "total_ms": msg.get("total_ms"),
        }
        try:
            agent_bus_service.stream(AGENT_ID, payload)
        except Exception as exc:  # noqa: BLE001
            logger.debug("DSH agent_stream 上报失败：%s", exc)

    # -- 主循环 -----------------------------------------------------------
    async def run(self) -> None:
        agent_bus_service.register(
            AGENT_ID,
            AGENT_NAME,
            "dsh_adapter",
            capabilities={
                # 如实上报：本版 DSH 无 TTS/语音合成服务，voice phase 只在
                # 用户自行部署 speak/tts 类工具时才可能被驱动。
                "voice": False,
                "text": True,
                "screen": False,
                # DSH 自带 MCP 客户端与 MCP 工具调用链路。
                "mcp": True,
                "observe": False,
            },
            # 本插件的身份色（气泡/徽标用）。
            # 由插件自己声明、经总线透传给渲染端，桌宠窗口因此**不需要**加载
            # 管理页的插件注册表也能拿到色值——早期实现正是漏了这一点，
            # 导致气泡明明是 DSH 发的却不变蓝。
            accent=DSH_ACCENT,
        )
        while True:
            try:
                await self._loop_once()
            except asyncio.CancelledError:
                await self._shutdown()
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("DSH 适配器循环异常：%s", exc)
                agent_bus_service.set_status(AGENT_ID, "error", error=str(exc)[:200])
                await asyncio.sleep(5)

    async def _shutdown(self) -> None:
        if self.sidecar is not None:
            await asyncio.to_thread(self.sidecar.stop)
            self.sidecar = None

    async def _loop_once(self) -> None:
        """一轮配置检查 + 边车驱动；配置变化或边车异常时返回重来。"""
        config = load_config()

        # 1) 未启用：注册在册但离线，并给出启用指引
        if not config.get("enabled"):
            await self._shutdown()
            self.facts = {}
            self.last_phase = ""
            agent_bus_service.set_status(
                AGENT_ID,
                "offline",
                error=(
                    "DSH 未启用：在项目根 dsh_config.json 设 \"enabled\": true "
                    "（或到 MIO 管理窗口 → Agent 页启用 DSH）"
                ),
            )
            await asyncio.sleep(8)
            return

        # 2) 已启用：检查 DSH 是否在运行
        running = dsh_process_running()
        if running is False:
            await self._shutdown()
            self.last_phase = ""
            agent_bus_service.set_status(
                AGENT_ID,
                "offline",
                error="DSH 未运行：请先启动 DeepSeek Harness 桌面应用",
            )
            await asyncio.sleep(5)
            return
        if running is None:
            # 无法判定进程（非 Windows）：靠边车输出来判断
            pass

        # 3) 拉起边车
        if not await self._ensure_sidecar(config):
            agent_bus_service.set_status(AGENT_ID, "error", error=self.sidecar_error[:200])
            await asyncio.sleep(8)
            return

        assert self.sidecar is not None
        agent_bus_service.set_status(AGENT_ID, "connecting", error="")

        # 4) 消费边车消息
        idle_rounds = 0
        was_enabled = self._bus_enabled()
        while True:
            config_now = load_config()
            if bool(config_now.get("enabled")) != bool(config.get("enabled")):
                return  # 启用状态变化：立刻重来
            # 重新启用（Agent 页开关）：立即用当前事实补发一次状态，
            # 不必等下一个 DSH 事件（否则会停在 idle 直到 DSH 动一下）
            now_enabled = self._bus_enabled()
            if now_enabled and not was_enabled:
                self.last_phase = ""
                if self.facts:
                    self._publish_facts(self.facts, force=True)
            was_enabled = now_enabled
            if not self.sidecar.alive():
                # 边车退出：DSH 还在就只是重启边车（connecting），DSH 没了才算离线
                code = self.sidecar.returncode()
                if dsh_process_running() is False:
                    await self._shutdown()
                    agent_bus_service.set_status(
                        AGENT_ID, "offline",
                        error="DSH 未运行：请先启动 DeepSeek Harness 桌面应用",
                    )
                else:
                    agent_bus_service.set_status(
                        AGENT_ID, "connecting",
                        error=self.sidecar_error or f"DSH 边车退出(rc={code})，正在重启",
                    )
                await asyncio.sleep(2)
                return

            raw = await self.sidecar.next_message(timeout=1.0)
            if raw is None:
                # 边车输出结束（进程可能刚退出）：交给下一轮 alive() 判定与重启
                await asyncio.sleep(1)
                return
            if raw == "":
                # 超时：心跳 + 检查边车是否卡死
                idle_rounds += 1
                now = asyncio.get_running_loop().time()
                if (now - self.sidecar.last_message_at) * 1000 > SIDECAR_STALE_MS:
                    logger.warning("DSH 边车静默超时，重启")
                    await asyncio.to_thread(self.sidecar.stop)
                    return
                agent_bus_service.heartbeat(AGENT_ID)
                # ★ 2026-10-26 多会话徽标：静默期按 MULTI_SCAN_MS 扫一遍
                #   所有活跃会话，给"正在跑"的每个挂独立徽标。
                #   放在这里而不是事件分支：它不依赖边车事件，
                #   另一个项目开跑时我们这边可能一直静默（自己的会话在等结果）。
                if now_enabled and (now - self._last_multi_scan_at) * 1000 >= MULTI_SCAN_MS:
                    self._last_multi_scan_at = now
                    try:
                        await asyncio.to_thread(self._publish_multi_session_badges, config_now)
                    except Exception as exc:  # noqa: BLE001
                        logger.debug("多会话徽标上报失败：%s", exc)
                # 静默期也要按 REEMIT_MS 补发当前工作态：DSH 单次工具调用可能持续
                # 几十秒（实测有 33s 的 pwsh），这期间无新事件；不补发的话桌宠会在
                # 工具还在跑时就变回待机——看着像停工。_emit_phase 内部自带节流。
                if self.facts and now_enabled:
                    self._publish_facts(self.facts)
                if idle_rounds % 10 == 0:
                    # 静默期间也确认一下 DSH 进程是否还在
                    if dsh_process_running() is False:
                        return
                continue
            idle_rounds = 0
            self._handle_message(raw)

    def _handle_message(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except Exception:  # noqa: BLE001
            return
        if not isinstance(msg, dict):
            return
        kind = str(msg.get("kind") or "")

        if kind == "ready":
            self.session_id = str(msg.get("session") or "")
            self.sidecar_error = ""
            # ★ 2026-10-26：主徽标的名字跟着当前会话的工作区走
            #   （「徽标前面的 DSH 显示成当前工作区名称」）
            self._sync_main_agent_name(str(msg.get("cwd") or ""))
            agent_bus_service.heartbeat(AGENT_ID)
            agent_bus_service.set_status(AGENT_ID, "online", error="")
            return

        if kind == "facts":
            agent_bus_service.heartbeat(AGENT_ID)
            agent_bus_service.set_status(AGENT_ID, "online", error="")
            self._publish_facts(msg.get("facts") or {})
            return

        if kind == "event":
            agent_bus_service.heartbeat(AGENT_ID)
            self._publish_facts(msg.get("facts") or {})
            return

        if kind == "stream":
            # 逐 token 流式（M1）：只喂气泡，不参与 facts/phase 计算
            agent_bus_service.heartbeat(AGENT_ID)
            self._publish_stream(msg)
            return

        if kind == "switch":
            self.session_id = str(msg.get("session") or "")
            self.last_phase = ""  # 新会话：允许立即上报
            # ★★ 2026-10-24 修「切工作区后桌宠看不到状态」：
            #   以前这里只换 session_id 就 return。但边车紧接着会推一条
            #   `facts(source=replay)` —— 那才是新会话折叠出来的事实。
            #   问题在**中间这段空窗**：_handle_message 对 switch 直接返回，
            #   而主循环在静默期会 `_publish_facts(self.facts)` 补发**上一个会话**的
            #   facts（见主循环 idle 分支）。于是切换后的一小段时间里，
            #   桌宠显示的仍是旧工作区的工具/进度。
            #   现在显式清空 facts，让切换后的第一次 publish 一定是新会话的。
            self.facts = {}
            logger.info("DSH 会话已切换：%s", self.session_id)
            return

        if kind == "offline":
            reason = str(msg.get("reason") or "DSH 会话不可用")
            agent_bus_service.set_status(AGENT_ID, "offline", error=reason[:200])
            # 进程还在但没会话：给一个 paused（断线待恢复）而不是 idle
            self._emit_phase("paused", {"reason": reason[:120]}, force=True)
            return

        if kind == "ping":
            agent_bus_service.heartbeat(AGENT_ID)
            return

        if kind == "error":
            self.sidecar_error = str(msg.get("message") or "边车错误")
            logger.debug("DSH 边车错误：%s", self.sidecar_error)


# 单实例（后台任务持有）
_adapter = DshAdapter()


async def dsh_adapter_loop() -> None:
    """后台任务入口：由 main.py 的 BACKGROUND_TASK_FACTORIES 挂载。"""
    await _adapter.run()


def inspect_current() -> dict[str, Any]:
    """诊断快照（供 ``GET /api/companion/agents/{id}/inspect`` 与自检使用）。

    故意不调用 ``asyncio.get_running_loop()``——它可能被同步代码在无事件循环的
    线程里调用（例如 FastAPI 的线程池），必须任意上下文可安全执行。
    """
    facts = dict(_adapter.facts)
    phase, state = phase_for_facts(facts)
    return {
        "agent_id": AGENT_ID,
        "enabled": bool(load_config().get("enabled")),
        "bus_enabled": _adapter._bus_enabled(),
        "session_id": _adapter.session_id,
        "phase": phase,
        "state": state,
        "facts": facts,
        "sidecar_alive": bool(_adapter.sidecar and _adapter.sidecar.alive()),
        "sidecar_error": _adapter.sidecar_error,
        "dsh_process_running": dsh_process_running(),
        "phases": list(DSH_PHASES),
        "work_phases": list(DSH_WORK_PHASES),
        "fact_phases": list(DSH_FACT_PHASES),
        "config_path": str(dsh_config_path()),
    }
