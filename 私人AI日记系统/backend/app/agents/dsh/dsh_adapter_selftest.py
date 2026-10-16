"""DSH 适配器自检 / 单元测试：facts 折叠 + phase 映射 + 边车解码全链路。

运行（在 backend 目录下）：:

    .venv\\Scripts\\python.exe -m app.dsh_adapter_selftest

覆盖：
  1. 边车解码真实 DSH 会话日志 → facts（含 zstd 多帧、状态折叠）；
  2. DSH 全部可显示工作状态（10 phase）逐一构造并断言映射正确；
  3. 单事件映射 parse_dsh_event 的关键分支；
  4. 配置/路径/node 探测等工具函数；
  5. 总线集成（注册 + 12 phase 广播 + 快照）；
  6. 前端契约（phase 标签/工作态口径）；
  7. 插件包自足性（路由契约 / 独有信号 / 气泡身份色）；
  8. 逐 token 流式全链路（边车 emit → 适配器 → 总线 → 前端契约）。
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import dsh_adapter as dsh


PASS = 0
FAIL = 0
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [OK]   {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name} — {detail}")
        print(f"  [FAIL] {name}  {detail}")


def check_eq(name: str, got: Any, want: Any) -> None:
    check(name, got == want, f"got={got!r} want={want!r}")


# ---------------------------------------------------------------------------
# 1) facts → phase：DSH 全部可显示工作状态逐一验证
# ---------------------------------------------------------------------------
def test_phase_mapping() -> None:
    print("\n[1] facts → phase 映射（DSH 全部可显示工作状态）")

    base = {
        "in_turn": True, "turn": 1, "step": 3, "last_tool": "", "tool_calls": 0,
        "active_tools": 0, "approvals_pending": 0, "awaiting_user": False,
        "voice_active": False, "retrying": False, "errored": False,
        "last_event_failed": False, "turn_end_reason": "", "last_error": "",
        "text_chars": 0, "reason_chars": 0, "last_assistant_has_text": False,
        "last_assistant_has_reason": False, "last_message_text_only": False,
        "plan_intent": False, "voice_intent": False, "todo_count": 0, "goal_operation": "",
        "last_event": "step/start", "user_turns": 1,
    }

    def facts(**over: Any) -> dict[str, Any]:
        f = dict(base)
        f.update(over)
        return f

    # --- 工作细分状态（7 个，桌宠会显示徽标）---
    # planning：轮次刚开始（plan_intent 由 turn/start 置位）
    p, s = dsh.phase_for_facts(facts(last_event="turn/start", plan_intent=True))
    check_eq("planning（轮次开始）", p, "planning")

    # planning：规划类工具已调完、当前没工具在跑 → 规划态
    p, s = dsh.phase_for_facts(facts(plan_intent=True, active_tools=0,
                                     last_tool="todo_write", todo_count=5, last_event="todo/write"))
    check_eq("planning（规划意图，无工具在跑）", p, "planning")
    check_eq("  └ state.todos 透传", s.get("todos"), 5)

    # 规划意图与工具执行同时存在时，以工具执行为准——与总线
    # PHASE_PRIORITY（executing_tool=2 高于 planning=3）保持同一口径
    p, _ = dsh.phase_for_facts(facts(plan_intent=True, active_tools=1,
                                     last_tool="todo_write", tool_calls=1, last_event="tool/call"))
    check_eq("planning 让位于 executing_tool（同总线优先级）", p, "executing_tool")

    # thinking：步骤推进中（纯推理）
    p, _ = dsh.phase_for_facts(facts(last_assistant_has_reason=True, last_event="assistant/message"))
    check_eq("thinking（纯推理）", p, "thinking")

    # executing_tool：工具在跑
    p, s = dsh.phase_for_facts(facts(active_tools=1, last_tool="read", tool_calls=2, last_event="tool/call"))
    check_eq("executing_tool（工具进行中）", p, "executing_tool")
    check_eq("  └ state.tool 透传", s.get("tool"), "read")

    # streaming：助手产出纯文字正文（无 tool-call 块）
    p, _ = dsh.phase_for_facts(facts(last_message_text_only=True,
                                     last_assistant_has_text=True, last_event="assistant/message"))
    check_eq("streaming（正文输出）", p, "streaming")

    # 反例（真实数据 335/377 条如此）：assistant/message 同时含 text + tool-call
    # 时不是 streaming，而是"要调工具"
    p, _ = dsh.phase_for_facts(facts(last_message_text_only=False,
                                     last_assistant_has_text=True,
                                     last_assistant_has_reason=True,
                                     active_tools=1, last_event="assistant/message"))
    check_eq("含 tool-call 的 assistant/message 不是 streaming", p, "executing_tool")

    p, _ = dsh.phase_for_facts(facts(last_message_text_only=False,
                                     last_assistant_has_text=True,
                                     last_assistant_has_reason=True,
                                     active_tools=0, last_event="assistant/message"))
    check_eq("推理+文字但无工具 → thinking", p, "thinking")

    # waiting_input：等待用户工具在跑
    p, s = dsh.phase_for_facts(facts(awaiting_user=True, active_tools=1,
                                     last_tool="ask_user_question", last_event="tool/call"))
    check_eq("waiting_input（等待用户）", p, "waiting_input")

    # voice：语音工具在跑
    p, _ = dsh.phase_for_facts(facts(voice_active=True, active_tools=1,
                                     last_tool="speak", last_event="tool/call"))
    check_eq("voice（语音播报）", p, "voice")

    # awaiting_approval：审批挂起
    p, _ = dsh.phase_for_facts(facts(approvals_pending=1, last_event="approval/asked"))
    check_eq("awaiting_approval（等待审批）", p, "awaiting_approval")

    # --- 非工作状态（5 个）---
    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end", turn_end_reason="completed"))
    check_eq("complete（轮次完成）", p, "complete")

    p, s = dsh.phase_for_facts(facts(last_event_failed=True, last_error="tool boom",
                                     last_event="tool/result"))
    check_eq("error（失败当下）", p, "error")
    check_eq("  └ state.error 透传", s.get("error"), "tool boom")

    p, _ = dsh.phase_for_facts(facts(in_turn=False, turn_end_reason="error"))
    check_eq("error（轮次异常结束）", p, "error")

    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end", turn_end_reason="aborted"))
    check_eq("idle（轮次被中止）", p, "idle")

    # blocked：preStep 被 hook 拒绝 → 等用户换输入（对齐 DSH 官方桌宠投影）
    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end", turn_end_reason="blocked"))
    check_eq("waiting_input（轮次被 hook 拦下）", p, "waiting_input")

    # forked：轮次延续到子会话，不该挂在工作态
    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end", turn_end_reason="forked"))
    check_eq("idle（轮次 fork 到子会话）", p, "idle")

    # 未知的 turn 结束原因（TurnEndReasonMap 可被 merge 扩展）：不得挂在工作态
    p, _ = dsh.phase_for_facts(facts(in_turn=False, last_event="turn/end",
                                     turn_end_reason="brand-new-reason"))
    check_eq("idle（未知结束原因）", p, "idle")

    p, _ = dsh.phase_for_facts({})
    check_eq("idle（空 facts）", p, "idle")

    # --- 优先级顺序验证 ---
    p, _ = dsh.phase_for_facts(facts(approvals_pending=1, active_tools=3, awaiting_user=True,
                                     last_event_failed=True, last_event="approval/asked"))
    check_eq("优先级：审批 > 其他", p, "awaiting_approval")

    p, _ = dsh.phase_for_facts(facts(active_tools=1, awaiting_user=True, last_event_failed=True))
    check_eq("优先级：等待用户 > 错误", p, "waiting_input")

    p, _ = dsh.phase_for_facts(facts(active_tools=1, voice_active=True, last_event_failed=True))
    check_eq("优先级：语音 > 错误", p, "voice")

    p, _ = dsh.phase_for_facts(facts(active_tools=2, last_event_failed=True, last_event="tool/call"))
    check_eq("优先级：错误 > 工具进行中", p, "error")

    # --- 失败不粘轮：后续进展事件恢复工作态 ---
    p, _ = dsh.phase_for_facts(facts(errored=True, last_event_failed=False, active_tools=1,
                                     last_event="tool/call"))
    check_eq("失败不粘轮（errored=True 但已恢复）", p, "executing_tool")

    # --- retrying → thinking ---
    p, _ = dsh.phase_for_facts(facts(retrying=True, last_event="llm/retry"))
    check_eq("thinking（LLM 重试中）", p, "thinking")

    # --- phase 集合口径 ---
    check_eq("工作态 7 个", len(dsh.DSH_WORK_PHASES), 7)
    check_eq("非工作态 4 个", len(dsh.DSH_IDLE_PHASES), 4)
    check_eq("注册 phase 共 12 个（含 heartbeat）", len(dsh.DSH_PHASES), 12)
    check_eq("facts 可产出 10 个 phase", len(dsh.DSH_FACT_PHASES), 10)
    check("工作态与总线枚举一致",
          all(p in dsh.agent_bus_service.PHASES for p in dsh.DSH_WORK_PHASES))
    check("全部注册 phase 都在总线枚举内",
          all(p in dsh.agent_bus_service.PHASES for p in dsh.DSH_PHASES))
    check("含 heartbeat", "heartbeat" in dsh.DSH_PHASES)
    check("is_work_phase 判定正确",
          dsh.is_work_phase("thinking") and not dsh.is_work_phase("complete"))

    # 可达性口径必须诚实：phase_for_facts 只能产出 DSH_FACT_PHASES；
    # paused 由连接中断分支 emit，heartbeat 只走总线 heartbeat()（不作 phase emit）。
    reachable: set[str] = set()
    grid_combos = [
        {"in_turn": t, "active_tools": a, "approvals_pending": ap, "awaiting_user": au,
         "voice_active": v, "last_event_failed": f, "turn_end_reason": r,
         "last_message_text_only": tx, "retrying": ry, "last_event": le, "plan_intent": pi}
        for t in (True, False)
        for a in (0, 1)
        for ap in (0, 1)
        for au in (True, False)
        for v in (True, False)
        for f in (True, False)
        for r in ("", "completed", "error", "max-tokens", "interrupted", "aborted", "blocked", "forked")
        for tx in (True, False)
        for ry in (True, False)
        for le in ("turn/start", "step/start", "tool/call", "assistant/message", "tool/result")
        for pi in (True, False)
    ]
    for combo in grid_combos:
        reachable.add(dsh.phase_for_facts(combo)[0])
    check("phase_for_facts 产出集合 == DSH_FACT_PHASES",
          reachable == set(dsh.DSH_FACT_PHASES),
          f"reachable={sorted(reachable)} declared={sorted(dsh.DSH_FACT_PHASES)}")
    check("paused 不由 facts 产出（走连接中断分支）",
          "paused" not in reachable, f"reachable={sorted(reachable)}")
    check("heartbeat 不作 phase emit（只走总线 heartbeat）",
          "heartbeat" not in reachable, f"reachable={sorted(reachable)}")


# ---------------------------------------------------------------------------
# 2) 单事件映射（parse_dsh_event）
# ---------------------------------------------------------------------------
def test_parse_event() -> None:
    print("\n[2] 单事件映射 parse_dsh_event")

    cases: list[tuple[dict[str, Any], str]] = [
        ({"type": "turn/start", "data": {"turn": 1}}, "planning"),
        ({"type": "step/start", "data": {"step": 2}}, "thinking"),
        ({"type": "tool/call", "data": {"name": "read"}}, "executing_tool"),
        ({"type": "tool/call", "data": {"name": "ask_user_question"}}, "waiting_input"),
        ({"type": "tool/call", "data": {"name": "todo_write"}}, "planning"),
        ({"type": "tool/call", "data": {"name": "speak"}}, "voice"),
        ({"type": "tool/result", "data": {"message": {"isError": True}}}, "error"),
        ({"type": "tool/result", "data": {"message": {"isError": False}}}, "thinking"),
        ({"type": "tool/result", "data": {"message": {}, "error": {"code": "TOOL_TIMEOUT"}}}, "error"),
        ({"type": "assistant/message", "data": {"message": {"content": [{"type": "text", "text": "hi"}]}}}, "streaming"),
        ({"type": "assistant/message", "data": {"message": {"content": [{"type": "reasoning", "text": "r"}]}}}, "thinking"),
        ({"type": "assistant/message", "data": {"message": {"content": [{"type": "tool-call"}]}}}, "executing_tool"),
        ({"type": "approval/asked", "data": {"toolName": "pwsh"}}, "awaiting_approval"),
        ({"type": "llm/retry", "data": {"retry": 1}}, "error"),
        ({"type": "llm/retry-started", "data": {"retry": 1}}, "error"),
        ({"type": "turn/end", "data": {"reason": {"kind": "completed"}}}, "complete"),
        ({"type": "turn/end", "data": {"reason": {"kind": "error"}}}, "error"),
        ({"type": "turn/end", "data": {"reason": {"kind": "max-tokens"}}}, "error"),
        ({"type": "turn/end", "data": {"reason": {"kind": "interrupted"}}}, "error"),
        ({"type": "turn/end", "data": {"reason": {"kind": "aborted"}}}, "idle"),
        ({"type": "user/message", "data": {"source": {"kind": "user"}}}, "thinking"),
        ({"type": "user/message", "data": {"source": {"kind": "voice"}}}, "waiting_input"),
        ({"type": "session/start", "data": {}}, "idle"),
    ]
    for ev, want in cases:
        got = dsh.parse_dsh_event(ev)
        check_eq(f"parse_dsh_event {ev['type']}", got[0] if got else None, want)

    for junk in [None, {}, {"type": "unknown/thing"}, {"type": "step/end", "data": {}}]:
        check(f"未知事件返回 None ({junk})", dsh.parse_dsh_event(junk) is None)


# ---------------------------------------------------------------------------
# 3) 边车真实日志解码（端到端：zstd 多帧 → facts）
# ---------------------------------------------------------------------------
def test_sidecar_real_log() -> None:
    print("\n[3] 边车解码真实 DSH 会话日志")

    node = dsh.resolve_node({})
    check("探测到 node 可执行文件", bool(node), f"node={node}")
    if not node:
        return
    script = Path(dsh.__file__).with_name(dsh.SIDECAR_NAME)
    check("边车脚本存在", script.exists(), str(script))
    if not script.exists():
        return

    sessions_root = dsh.default_sessions_root()
    check("DSH 会话根目录存在", sessions_root.exists(), str(sessions_root))

    proc = subprocess.run(
        [node, str(script), "--once", "--workspace", dsh.default_workspace(),
         "--sessions-root", str(sessions_root)],
        capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    check_eq("边车 --once 退出码", proc.returncode, 0)
    if proc.returncode != 0:
        print(f"      stderr: {proc.stderr[:500]}")
        return

    msgs = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    kinds = [m.get("kind") for m in msgs]
    print(f"      边车输出：{kinds}")
    if "offline" in kinds:
        print("      （当前无活跃 DSH 会话，跳过解码断言）")
        return

    ready = next(m for m in msgs if m.get("kind") == "ready")
    facts_msg = next(m for m in msgs if m.get("kind") == "facts")
    check("ready 带 session", bool(ready.get("session")), str(ready))
    check("ready 带真实 cwd", bool(ready.get("cwd")), str(ready))
    check("重放事件数 > 0", int(ready.get("events_replayed") or 0) > 0,
          f"replayed={ready.get('events_replayed')}")
    check("delegation_depth 为 0（主会话）", ready.get("delegation_depth") == 0,
          f"depth={ready.get('delegation_depth')}")

    f = facts_msg.get("facts") or {}
    print(f"      facts: {json.dumps({k: v for k, v in f.items() if k not in ('reason_chars','text_chars')}, ensure_ascii=False)[:400]}")
    for key in ("in_turn", "turn", "tool_calls", "approvals_pending", "last_event"):
        check(f"facts 含字段 {key}", key in f, f"keys={list(f)}")

    # 折叠出的事实必须能映射到合法 phase
    phase, state = dsh.phase_for_facts(f)
    check(f"真实 facts → 合法 phase（得到 {phase}）", phase in dsh.agent_bus_service.PHASES)
    check("phase 属于 DSH 注册集合", phase in dsh.DSH_PHASES, f"phase={phase}")


# ---------------------------------------------------------------------------
# 3.5) 真实事件回放：用从真实 DSH 日志抽取的片段驱动 phase 映射
# ---------------------------------------------------------------------------
def test_replay_real_events() -> None:
    """回放真实 DSH 事件片段，检查折叠与映射在真实数据上成立。

    夹具由 ``app.dsh_fixture_build`` 从真实会话日志抽取（原样事件，未手工构造）。
    这里复刻边车的折叠语义（同一套规则），逐事件喂入并断言：
      - 全程不抛异常；
      - 每个中间状态都落在合法 phase 枚举内；
      - 片段内出现过的关键状态确实被观察到（如审批 → awaiting_approval）。
    """
    print("\n[3.5] 真实事件回放（夹具来自真实 DSH 会话日志）")

    fixture_path = Path(dsh.__file__).with_name("dsh_events_fixture.json")
    if not fixture_path.exists():
        print(f"      未找到夹具 {fixture_path.name}，跳过（可运行 app.dsh_fixture_build 生成）")
        return

    try:
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        check("读取夹具", False, str(exc))
        return

    sequences = fixture.get("sequences") or []
    check("夹具含回放片段", len(sequences) > 0, f"n={len(sequences)}")
    counts = fixture.get("event_type_counts") or {}
    check("夹具覆盖 tool/call", counts.get("tool/call", 0) > 0,
          f"tool/call={counts.get('tool/call')}")
    print(f"      夹具事件类型数={len(counts)} 片段数={len(sequences)}")

    # 隐私回归：夹具必须是脱敏的（不含对话正文/工具参数内容）
    raw = fixture_path.read_text(encoding="utf-8")
    leaked = [k for k in ('"text": "', '"arguments"', '"objective"') if k in raw]
    check("夹具已脱敏（无对话正文/工具参数）", not leaked, f"leaked markers={leaked}")
    check("夹具体积受控（< 100KB）", len(raw.encode("utf-8")) < 100_000,
          f"size={len(raw.encode('utf-8'))}B")

    # 复刻边车 foldEvent 的语义（保持与 .mjs 一致；两边都改才算改对）。
    # 夹具条目是**脱敏**过的（正文换成 len、工具参数不留），故这里按脱敏字段读。
    def fold(prev: dict[str, Any], ev: dict[str, Any]) -> dict[str, Any]:
        f = dict(prev)
        f["last_event_failed"] = False
        # 与边车同语义：intent 类标记每事件清零，由当前事件置位
        f["plan_intent"] = False
        f["voice_intent"] = False
        t = str(ev.get("type") or "")
        d = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        d = d or {}
        f["last_event"] = t
        if t == "turn/start":
            f.update(in_turn=True, turn=d.get("turn"), step=None, last_tool="", tool_calls=0,
                     active_tools=0, approvals_pending=0, awaiting_user=False, voice_active=False,
                     retrying=False, errored=False, turn_end_reason="", last_error="",
                     text_chars=0, reason_chars=0,
                     last_assistant_has_text=False, last_assistant_has_reason=False,
                     last_message_text_only=False, plan_intent=True)
        elif t == "turn/end":
            reason = d.get("reason") if isinstance(d.get("reason"), dict) else {}
            kind = str((reason or {}).get("kind") or "")
            f.update(in_turn=False, turn=None, step=None, last_tool="", active_tools=0,
                     approvals_pending=0, awaiting_user=False, voice_active=False,
                     turn_end_reason=kind)
            if kind in {"error", "max-tokens", "interrupted"}:
                f.update(errored=True, last_event_failed=True)
        elif t == "step/start":
            f.update(step=d.get("step"), active_tools=0,
                     last_assistant_has_text=False, last_assistant_has_reason=False,
                     last_message_text_only=False)
        elif t == "assistant/message":
            # 脱敏后：content 里 text/reasoning 只留 len；tool-call 留 name
            content = (d.get("message") or {}).get("content") or []
            has_text = any(isinstance(c, dict) and c.get("type") == "text" for c in content)
            has_reason = any(isinstance(c, dict) and c.get("type") == "reasoning" for c in content)
            has_tool = any(isinstance(c, dict) and c.get("type") == "tool-call" for c in content)
            f.update(last_assistant_has_text=has_text, last_assistant_has_reason=has_reason,
                     last_message_text_only=bool(has_text and not has_tool))
            f["text_chars"] = f.get("text_chars", 0) + sum(
                int(c.get("len") or 0) for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
            f["reason_chars"] = f.get("reason_chars", 0) + sum(
                int(c.get("len") or 0) for c in content
                if isinstance(c, dict) and c.get("type") == "reasoning"
            )
        elif t == "assistant/attempt":
            for fin in d.get("stream_finishes") or []:
                if isinstance(fin, dict) and str(fin.get("kind")) == "error":
                    f.update(errored=True, last_event_failed=True)
        elif t == "tool/call":
            name = str(d.get("name") or "")
            f.update(last_tool=name, tool_calls=f.get("tool_calls", 0) + 1,
                     active_tools=f.get("active_tools", 0) + 1)
            lname = name.lower()
            if lname in {"ask_user_question", "ask_user", "askuserquestion"}:
                f["awaiting_user"] = True
            if lname in {"speak", "tts", "text_to_speech"}:
                f["voice_active"] = True
            if lname in {"todo_write", "todowrite", "create_goal", "update_goal", "exit_plan_mode"}:
                f["plan_intent"] = True
        elif t == "todo/write":
            f["plan_intent"] = True
            # 脱敏后 todos 是**数量**（int），不是列表
            try:
                f["todo_count"] = int(d.get("todos") or 0)
            except (TypeError, ValueError):
                f["todo_count"] = 0
        elif t == "goal/change":
            f["plan_intent"] = True
        elif t == "tool/result":
            msg = d.get("message") if isinstance(d.get("message"), dict) else {}
            f["active_tools"] = max(0, f.get("active_tools", 0) - 1)
            # 脱敏后仍是原始语义：isError 布尔 + data.error 是否存在
            if bool(msg.get("isError")) or d.get("has_error"):
                f.update(errored=True, last_event_failed=True)
            f["awaiting_user"] = False
        elif t == "approval/asked":
            f["approvals_pending"] = f.get("approvals_pending", 0) + 1
        elif t == "approval/decided":
            f["approvals_pending"] = max(0, f.get("approvals_pending", 0) - 1)
        elif t in {"llm/retry", "llm/retry-started"}:
            f["retrying"] = True
        return f

    base = {
        "in_turn": False, "turn": None, "step": None, "last_tool": "", "tool_calls": 0,
        "active_tools": 0, "approvals_pending": 0, "awaiting_user": False, "voice_active": False,
        "retrying": False, "errored": False, "last_event_failed": False, "turn_end_reason": "",
        "last_error": "", "text_chars": 0, "reason_chars": 0, "last_assistant_has_text": False,
        "last_assistant_has_reason": False, "last_message_text_only": False,
        "plan_intent": False, "voice_intent": False, "todo_count": 0, "goal_operation": "",
        "last_event": "", "user_turns": 0,
    }

    observed: set[str] = set()
    illegal: list[str] = []
    errors: list[str] = []
    total_steps = 0

    for seq in sequences:
        facts = dict(base)
        for ev_raw in seq.get("events") or []:
            if not isinstance(ev_raw, dict):
                continue
            if str(ev_raw.get("type")) == "session":
                continue
            try:
                facts = fold(facts, ev_raw)
                phase, _state = dsh.phase_for_facts(facts)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{seq.get('name')}@{ev_raw.get('type')}: {exc}")
                continue
            total_steps += 1
            observed.add(phase)
            if phase not in dsh.agent_bus_service.PHASES:
                illegal.append(f"{seq.get('name')}: {phase}")

    check(f"回放 {total_steps} 步无异常", not errors, "; ".join(errors[:3]))
    check("回放产出的 phase 全部合法", not illegal, "; ".join(illegal[:3]))
    check("回放确实观察到工作态", bool(observed & set(dsh.DSH_WORK_PHASES)),
          f"observed={sorted(observed)}")
    print(f"      回放观察到的 phase：{sorted(observed)}")

    # 真实数据里 tool/call 占多数，必须能看出「执行工具」
    check("回放观察到 executing_tool", "executing_tool" in observed,
          f"observed={sorted(observed)}")


# ---------------------------------------------------------------------------
# 4) 工具函数
# ---------------------------------------------------------------------------
def test_step_start_resets_output_flags() -> None:
    """回归：step/start 必须清掉上一轮的「纯文字」标记，否则 streaming 会粘到新步骤。

    这是两个独立验证者都报出的真实缺陷：README 写了「step/start 会重置该标记」，
    但代码只重置了 last_assistant_has_text/has_reason，漏了 last_message_text_only。
    后果：上一轮以纯文字收尾后，新步骤即使只在推理，桌宠仍显示「回复中」。

    这里用**边车的真实实现**跑一遍（不是复刻），直接验证 .mjs 的行为。
    """
    print("\n[7] 回归：step/start 重置输出标记（真实边车实现）")

    node = dsh.resolve_node({})
    script = Path(dsh.__file__).with_name(dsh.SIDECAR_NAME)
    if not node or not script.exists():
        print("      缺少 node 或边车脚本，跳过")
        return

    # 造一个最小合法 zstd 会话日志：纯文字 assistant/message → step/start。
    # 落盘位置用 __pycache__ 下的子目录（同仓库内、确定可写），不用系统 temp：
    # Windows 沙箱下 tempfile 的清理会因权限回收失败而抛 PermissionError。
    # 脚本用 `node -e` 内联传入，不落 .mjs 文件——仓库路径含中文，node 按路径
    # 加载脚本时会因 URL 编码解析失败（file:///…%E7%A7%81…）。
    root = Path(dsh.__file__).resolve().parent / "__pycache__" / "_dsh_regress"
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)

    probe_js = r"""
const fs=require('fs'),path=require('path'),zlib=require('node:zlib');
const outDir=process.argv[1];
const sid='session-regress';
const dir=path.join(outDir,'--C-Users-xiao1-Regress--',sid);
fs.mkdirSync(dir,{recursive:true});
const header={type:'session',version:4,id:sid,createdAt:Date.now(),cwd:'C:\\Users\\xiao1\\Regress',
  isSeeded:false,delegationDepth:0,agentPreset:'standard'};
const events=[
  {type:'turn/start',seq:0,time:Date.now(),data:{turn:1}},
  {type:'step/start',seq:1,time:Date.now(),data:{turn:1,step:1}},
  // 纯文字（无 tool-call）→ 应使 last_message_text_only=true
  {type:'assistant/message',seq:2,time:Date.now(),data:{turn:1,step:1,
    message:{role:'assistant',content:[{type:'text',text:'纯文字收尾'}]}}},
  {type:'step/start',seq:3,time:Date.now(),data:{turn:1,step:2}},
];
const lines=[JSON.stringify(header),...events.map(e=>JSON.stringify(e))].join('\n')+'\n';
fs.writeFileSync(path.join(dir,'session.v4.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(lines,'utf8')));
console.log('MADE');
"""
    try:
        try:
            made = subprocess.run([node, "-e", probe_js, str(root)], capture_output=True,
                                  text=True, encoding="utf-8", timeout=60)
        except Exception as exc:  # noqa: BLE001
            check("构造回归日志", False, str(exc))
            return
        if made.returncode != 0:
            check("构造回归日志", False, (made.stderr or "")[:300])
            return
        check("构造回归日志", "MADE" in (made.stdout or ""), (made.stdout or "")[:120])

        proc = subprocess.run(
            [node, str(script), "--once", "--sessions-root", str(root)],
            capture_output=True, text=True, encoding="utf-8", timeout=60,
        )
        check_eq("边车读取回归日志退出码", proc.returncode, 0)
        facts = {}
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if msg.get("kind") == "facts":
                facts = msg.get("facts") or {}
        check("拿到 facts", bool(facts), proc.stdout[:200])
        if not facts:
            return

        check_eq("最后事件是 step/start", facts.get("last_event"), "step/start")
        check("step/start 后 last_message_text_only 已清零（回归点）",
              facts.get("last_message_text_only") is False,
              f"got={facts.get('last_message_text_only')!r}")
        check("step/start 后 has_text 已清零",
              facts.get("last_assistant_has_text") is False,
              f"got={facts.get('last_assistant_has_text')!r}")
        # 该状态下不应再判为 streaming
        phase, _ = dsh.phase_for_facts(facts)
        check("新步骤不应判为 streaming", phase != "streaming", f"phase={phase}")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_frontend_contract() -> None:
    """前端契约：桌宠渲染端的 phase 映射必须覆盖本适配器会发出的每个 phase。

    README 6.8 承诺「接入新 Agent 时前端零改动——只要 phase 落在枚举内」。
    这条测试就是那句话的机器校验：解析 live2d-pet.js 里内嵌的 PHASE_LABELS 与
    WORK_PHASES，断言 DSH 会发出的 phase 全部有中文标签，且"工作态"口径一致。
    """
    print("\n[6] 前端契约（桌宠渲染端 phase 映射覆盖）")

    # 桌宠渲染端路径：插件目录化后本文件位于 app/agents/dsh/，
    # 到仓库根要上溯 4 级。旧代码写死 parents[3]（按"文件在 app/"算的层级），
    # 目录搬迁后会**静默跳过**整个前端契约检查——那等于这条断言白写了。
    # 故逐个层级探测，找到即用。
    _here = Path(dsh.__file__).resolve()
    pet_js = None
    for _up in (4, 3, 2, 5):
        if _up >= len(_here.parents):
            continue
        cand = _here.parents[_up] / "澪Agent应用" / "dist" / "live2d-pet" / "live2d-pet.js"
        if cand.exists():
            pet_js = cand
            break
    if pet_js is None:
        print("      未找到桌宠渲染端 live2d-pet.js，跳过前端契约检查")
        return

    src = pet_js.read_text(encoding="utf-8", errors="replace")
    m_labels = re.search(r"const PHASE_LABELS\s*=\s*\{(.*?)\}", src, re.S)
    m_work = re.search(r"const WORK_PHASES\s*=\s*new Set\(\[(.*?)\]\)", src, re.S)
    check("解析到 PHASE_LABELS", m_labels is not None, "未匹配到 PHASE_LABELS")
    check("解析到 WORK_PHASES", m_work is not None, "未匹配到 WORK_PHASES")
    if not (m_labels and m_work):
        return

    # 同时解析 key 与 **value**：只抓 key 会让"标签值被改成空串/英文"这类
    # 真实回归静默通过（只抓 key 的写法已被变异测试证明是空过）。
    pairs = re.findall(r"([A-Za-z_]+)\s*:\s*'([^']*)'", m_labels.group(1))
    labels = {k: v for k, v in pairs}
    keys = set(labels)
    work = set(re.findall(r"'([a-z_]+)'", m_work.group(1)))

    missing_label = [p for p in dsh.DSH_PHASES if p not in keys]
    check("桌宠对 DSH 全部 12 phase 都有中文标签", not missing_label,
          f"缺标签={missing_label}")

    # 值必须真的存在且为中文（catch 空串 / 未翻译 / 占位符）
    empty_vals = [k for k, v in labels.items() if not v.strip()]
    check("没有空标签值", not empty_vals, f"空值={empty_vals}")
    untranslated = [k for k in keys & set(dsh.DSH_PHASES)
                    if labels.get(k, "") and not any("\u4e00" <= ch <= "\u9fff" for ch in labels[k])]
    check("DSH 各 phase 的标签值含中文（非占位/未翻译）", not untranslated,
          f"未翻译={[(k, labels[k]) for k in untranslated]}")

    check("前端工作态口径与适配器一致（7 个）", work == set(dsh.DSH_WORK_PHASES),
          f"frontend={sorted(work)} adapter={sorted(dsh.DSH_WORK_PHASES)}")


def test_helpers() -> None:
    print("\n[4] 工具函数 / 配置")
    check("默认 sessions_root 指向 .dsh/sessions",
          "sessions" in str(dsh.default_sessions_root()))
    # 默认 workspace 留空 = 不限定，由边车选最近活跃的主会话
    check("默认 workspace 为空（不限定工作区）",
          dsh.default_workspace() == "",
          f"got={dsh.default_workspace()!r}")

    paths = dsh.config_search_paths()
    check("配置搜索路径非空", len(paths) > 0, f"paths={paths}")
    check("配置搜索路径都指向 dsh_config.json",
          all(p.name == "dsh_config.json" for p in paths), f"paths={paths}")

    cfg_path = dsh.dsh_config_path()
    check("生效配置路径在项目内", cfg_path.name == "dsh_config.json",
          f"path={cfg_path}")
    print(f"      配置搜索路径：{[str(p) for p in paths]}")
    print(f"      生效配置：{cfg_path}（存在={cfg_path.exists()}）")

    cfg = dsh.load_config()
    check("load_config 返回 dict", isinstance(cfg, dict))
    check("配置含 enabled", "enabled" in cfg)
    check("配置含 sessions_root", "sessions_root" in cfg)

    running = dsh.dsh_process_running()
    check("dsh_process_running 返回 bool|None", running in (True, False, None),
          f"got={running!r}")

    info = dsh.inspect_current()
    check("inspect_current 返回 dict", isinstance(info, dict))
    check("inspect_current 含 phase", info.get("phase") in dsh.agent_bus_service.PHASES)
    check("inspect_current 含 12 个 phase", len(info.get("phases") or []) == 12)


# ---------------------------------------------------------------------------
# 5) 总线注册与 phase 广播（在真实总线上跑一遍）
# ---------------------------------------------------------------------------
def test_bus_integration() -> None:
    print("\n[5] 总线集成：注册 + 全部工作 phase 广播")

    bus = dsh.agent_bus_service
    bus.register(dsh.AGENT_ID, dsh.AGENT_NAME, "dsh_adapter",
                 capabilities={"voice": True, "text": True, "screen": False,
                               "mcp": True, "observe": False})

    agent = bus.get(dsh.AGENT_ID)
    check("DSH 已注册进总线", agent is not None)
    check_eq("注册名", agent.name if agent else None, "DSH")

    # 逐一 emit DSH 能显示的每个 phase，断言总线接受且节流/优先级不报错
    for phase in dsh.DSH_PHASES:
        try:
            bus.emit(dsh.AGENT_ID, phase, state={"tool": "read"}, force=True)
            ok = True
            err = ""
        except Exception as exc:  # noqa: BLE001
            ok = False
            err = str(exc)
        check(f"总线接受 phase {phase}", ok, err)

    snap = bus.snapshot()
    ids = [a.get("agent_id") for a in snap.get("agents", [])]
    check("快照含 dsh", "dsh" in ids, f"agents={ids}")
    entry = next((a for a in snap["agents"] if a["agent_id"] == "dsh"), {})
    check("快照 phase 合法", entry.get("phase") in dsh.agent_bus_service.PHASES,
          f"phase={entry.get('phase')}")
    check("快照含 capabilities", isinstance(entry.get("capabilities"), dict))


# ---------------------------------------------------------------------------
# 9) 逐 token 流式（M1）全链路：边车 emit → 适配器 → 总线 → 前端契约
# ---------------------------------------------------------------------------
def _capture_published() -> tuple[list[dict[str, Any]], Any]:
    """挂一个假发布器捕获 WS 事件，返回 ``(捕获列表, 还原函数)``。

    总线发布走 ``pet_event_service.publish``（模块级函数）。测试里把它换成
    append 到列表，既能断言事件结构，又不需要真的连一个 WebSocket 客户端。
    """
    from ...companion import pet_event_service

    captured: list[dict[str, Any]] = []
    original = pet_event_service.publish

    def fake(event_type: str, payload: dict[str, Any]) -> None:
        captured.append({"type": event_type, "payload": payload})

    pet_event_service.publish = fake  # type: ignore[assignment]
    # 总线模块持有的是同一个模块对象，所以直接换属性即可全局生效
    return captured, original


def test_stream_sidecar() -> None:
    """[9a] 边车：增量跟随时发 kind:"stream"，附着历史重放**不发**。

    夹具仍在仓库内 ``__pycache__`` 下（与 [7] 同一套理由：Windows 沙箱下 tempfile
    清理会失败；且 node 无法按含中文的路径加载 .mjs 脚本，故一律用 ``node -e``
    内联 —— 另一处踩过的坑：Python 的 zlib **没有** zstd 压缩，只有 node 有）。
    """
    print("\n[9a] 逐 token 流式 · 边车 emit（增量发 / 历史不发）")

    node = dsh.resolve_node({})
    script = Path(dsh.__file__).with_name(dsh.SIDECAR_NAME)
    if not node or not script.exists():
        print("      无 node 或边车脚本，跳过")
        return

    root = Path(dsh.__file__).resolve().parent / "__pycache__" / "_dsh_stream"
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)
    log = root / "--C-Users-xiao1-Stream--" / "session-stream" / "session.v4.jsonl.zstd"

    # 一次 node 调用做两件事：写初始日志（历史） / 追加新帧（实时）。用 argv 区分。
    writer_js = r"""
const fs=require('fs'),path=require('path'),zlib=require('node:zlib');
const [mode,logPath]=process.argv.slice(1);
const now=Date.now();
const hist=[
  {type:'session',version:4,id:'session-stream',createdAt:now-9000,cwd:'C:\\Users\\xiao1\\Stream',
   isSeeded:false,delegationDepth:0,agentPreset:'standard'},
  {type:'turn/start',seq:1,time:now-8000,data:{turn:1}},
  // 历史里**已经存在**的一条 assistant/message：绝不能被当实时流发出
  {type:'assistant/message',seq:2,time:now-7000,data:{turn:1,step:1,stream:[
    {chunk:{type:'block-start',index:0,blockType:'text'}},
    {chunk:{type:'text-chunks',time0:now-7500,index:0,dt:[10],texts:['OLD','TEXT']}},
    {chunk:{type:'block-end',index:0,block:{type:'text',text:'OLDTEXT'}}},
  ]}},
];
const live=[
  {type:'assistant/message',seq:3,time:now,data:{turn:1,step:2,stream:[
    {chunk:{type:'block-start',index:0,blockType:'text'}},
    {chunk:{type:'text-chunks',time0:now-800,index:0,dt:[41,0,15,13,20,999],
            texts:['I',"'ll",' look',' at',' it','.']}},
    // 推理草稿：绝不能进正文流
    {chunk:{type:'reasoning-chunks',time0:now-900,index:0,dt:[5],texts:['SECRET-THOUGHT']}},
    {chunk:{type:'block-end',index:0,block:{type:'text',text:"I'll look at it."}}},
    {chunk:{type:'finish',reason:{kind:'stop'}}},
  ]}},
  {type:'tool/call',seq:4,time:now+1,data:{name:'pwsh',callId:'c1'}},
];
const events = mode==='init' ? hist : live;
const body = events.map(e=>JSON.stringify(e)).join('\n')+'\n';
const frame = zlib.zstdCompressSync(Buffer.from(body,'utf8'));
if (mode==='init') { fs.mkdirSync(path.dirname(logPath),{recursive:true}); fs.writeFileSync(logPath,frame) }
else { fs.appendFileSync(logPath,frame) }
console.log('WROTE-'+mode);
"""

    def write_log(mode: str) -> str:
        r = subprocess.run([node, "-e", writer_js, mode, str(log)],
                           capture_output=True, text=True, encoding="utf-8", timeout=60)
        return (r.stdout or "").strip() if r.returncode == 0 else f"ERR:{(r.stderr or '')[:200]}"

    try:
        check_eq("构造初始会话日志", write_log("init"), "WROTE-init")
        if not log.exists():
            return

        proc = subprocess.Popen(
            [node, str(script), "--sessions-root", str(root),
             "--session-id", "session-stream", "--poll-ms", "100"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        )
        out: list[str] = []

        def pump() -> None:
            if proc.stdout is None:
                return
            for line in proc.stdout:
                out.append(line)

        threading.Thread(target=pump, daemon=True).start()
        time.sleep(1.5)

        msgs = [json.loads(l) for l in out if l.strip()]
        check("边车进入 ready", any(m.get("kind") == "ready" for m in msgs),
              f"kinds={[m.get('kind') for m in msgs]}")
        check("附着历史重放不发 stream（应为 0）",
              len([m for m in msgs if m.get("kind") == "stream"]) == 0,
              f"got={[m.get('kind') for m in msgs]}")

        # 追加一段**新的** assistant/message（模拟实时产生）
        check_eq("追加实时帧", write_log("live"), "WROTE-live")
        time.sleep(1.2)

        msgs = [json.loads(l) for l in out if l.strip()]
        streams = [m for m in msgs if m.get("kind") == "stream"]
        check("增量跟随发 1 条 stream（历史那条不发）", len(streams) == 1,
              f"got={len(streams)} kinds={[m.get('kind') for m in msgs]}")
        if streams:
            s = streams[0]
            check_eq("stream 带 session", s.get("session"), "session-stream")
            check_eq("stream 带 turn", s.get("turn"), 1)
            # 源 dt 多给了 1 个（6 个 vs 需要的 5 个）：必须截断，不能把没用的尾间隔
            # 留在载荷里让渲染端多等一拍
            check_eq("stream.dt 截断到 块数-1", len(s.get("dt") or []), 5)
            check_eq("stream 增量拼接 == 权威全文",
                     "".join(s.get("texts") or []), "I'll look at it.")
            check_eq("stream.final_text 来自 block-end",
                     s.get("final_text"), "I'll look at it.")
            check_eq("stream.frame 标为 text-chunks", s.get("frame"), "text-chunks")
            check_eq("stream 带 time0 时基", isinstance(s.get("time0"), int), True)
        check("推理草稿（reasoning-chunks）绝不进正文流",
              not any("SECRET-THOUGHT" in "".join(m.get("texts") or [])
                      for m in msgs if m.get("kind") == "stream"))
        proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_stream_bus_and_adapter() -> None:
    """[9b] 适配器 → 总线：agent_stream 事件字段、门控与归属色。"""
    print("\n[9b] 逐 token 流式 · 适配器 → 总线（agent_stream）")

    captured, original = _capture_published()
    try:
        bus = dsh.agent_bus_service
        bus.register(dsh.AGENT_ID, dsh.AGENT_NAME, "dsh_adapter",
                     capabilities={"voice": True, "text": True, "screen": False,
                                   "mcp": True, "observe": False},
                     accent=dsh.DSH_ACCENT)
        adapter = dsh._adapter
        adapter.session_id = "s1"

        # 正常一条：正文增量 + 时基 + 权威全文
        adapter._publish_stream({
            "session": "s1", "turn": 3, "step": 7, "seq": 42, "index": 0,
            "frame": "text-chunks", "time0": 111, "dt": [10, 20],
            "texts": ["你", "好", "！"], "final_text": "你好！", "total_ms": 30,
        })
        evs = [e for e in captured if e["type"] == "agent_stream"]
        check("发布了 agent_stream", len(evs) == 1, f"got={[e['type'] for e in captured]}")
        if evs:
            p = evs[0]["payload"]
            check_eq("透传 agent_id", p.get("agent_id"), "dsh")
            check_eq("透传插件身份色", p.get("accent"), dsh.DSH_ACCENT)
            check_eq("透传 dt 时基", p.get("dt"), [10, 20])
            check_eq("透传 texts 增量", p.get("texts"), ["你", "好", "！"])
            check_eq("透传 final_text", p.get("final_text"), "你好！")
            check("agent_stream 不改 phase（与状态链路解耦）",
                  "phase" in p and p.get("phase") in bus.PHASES)

        # 会话不一致：边车已切会话，旧消息必须丢弃（否则串台）
        captured.clear()
        adapter._publish_stream({"session": "OTHER", "texts": ["旧"], "final_text": "旧"})
        check("跨会话的流被丢弃", not [e for e in captured if e["type"] == "agent_stream"],
              f"got={[e['type'] for e in captured]}")

        # 只有 final_text（增量缺失）也要能过——渲染端的兜底路径
        captured.clear()
        adapter._publish_stream({"session": "s1", "texts": [], "final_text": "兜底文本"})
        evs = [e for e in captured if e["type"] == "agent_stream"]
        check("只有 final_text 时仍发布（渲染端兜底）", len(evs) == 1, f"got={len(evs)}")

        # 空载荷不发布
        captured.clear()
        adapter._publish_stream({"session": "s1", "texts": [], "final_text": ""})
        check("空载荷不发布", not [e for e in captured if e["type"] == "agent_stream"])

        # 停用后不再冒泡
        captured.clear()
        bus.set_enabled(dsh.AGENT_ID, False)
        adapter._publish_stream({"session": "s1", "texts": ["x"], "final_text": "x"})
        check("总线停用后不再发布 agent_stream",
              not [e for e in captured if e["type"] == "agent_stream"])
        bus.set_enabled(dsh.AGENT_ID, True)

        # 未知 kind 容忍（B4）：总线 stream() 对畸形 payload 返回 False 而不是抛异常
        adapter.session_id = ""
        ok = True
        try:
            bus.stream(dsh.AGENT_ID, {"weird": 1})
            bus.stream(dsh.AGENT_ID, None)  # type: ignore[arg-type]
        except Exception as exc:  # noqa: BLE001
            ok = False
            print(f"      异常：{exc}")
        check("畸形/未知流载荷不抛异常（容忍降级）", ok)
    finally:
        dsh.agent_bus_service.pet_event_service.publish = original  # type: ignore[assignment]


def test_stream_frontend_contract() -> None:
    """[9c] 前端契约：桌宠渲染端必须真的接上 agent_stream。"""
    print("\n[9c] 逐 token 流式 · 前端契约")

    src = _pet_js_src()
    if not src:
        print("      未找到桌宠渲染端 live2d-pet.js，跳过")
        return
    check("分发 agent_stream 事件", "message.type === 'agent_stream'" in src
          or '"agent_stream"' in src)
    check("实现追加式渲染 applyAgentStream", "function applyAgentStream" in src)
    check("有可取消的流会话（新消息/隐藏时中断旧流）", "cancelAgentStream" in src)
    check("用最终文本校正（零丢字/零重复）", "finishAgentStream" in src)
    check("气泡被其他来源占用时会中断流", "cancelAgentStream()" in src.split("function showSpeechBubble")[1][:600]
          if "function showSpeechBubble" in src else False)
    check("流式受其自己的开关约束（live2d_stream_text_enabled）",
          "live2d_stream_text_enabled" in src)
    # ★ 2026-10-16 用户裁决：**三条通路独立管理**
    #   （说话气泡 / 流式气泡 / 横条 各自的菜单按钮独立显示隐藏）。
    #   原先 applyAgentStream 开头有一道 `live2d_speech_bubble_enabled === false` 就 return，
    #   会把流式连带关掉 —— 已移除。下面两条**防止它被改回去**。
    #
    #   ⚠ 必须**去掉注释再查**：这段函数上方有解释性注释也提到了旧开关名
    #     （说明"为什么不再依赖它"），直接搜字符串会误判成"代码里还在用"。
    #     这个坑本自检第一次跑就踩到了 —— 故这里先剥注释，只盯可执行代码。
    _stream_fn = src.split("function applyAgentStream")[1].split("\n  }")[0] if "function applyAgentStream" in src else ""
    _stream_code = re.sub(r"//[^\n]*", "", _stream_fn)          # 行注释
    _stream_code = re.sub(r"/\*.*?\*/", "", _stream_code, flags=re.S)  # 块注释
    check("★ 流式不再被说话气泡总开关挡（解耦未被改回）",
          "live2d_speech_bubble_enabled" not in _stream_code)
    check("★ 横条有独立的 WS 通路 applyAgentStrip",
          "function applyAgentStrip" in src and "agent_strip" in src)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def _pet_js_src() -> str:
    """读桌宠渲染端源码（找不到时返回空串，让调用方按"未找到"处理）。"""
    here = Path(dsh.__file__).resolve()
    for up in (4, 3, 2, 5):
        if up >= len(here.parents):
            continue
        cand = here.parents[up] / "澪Agent应用" / "dist" / "live2d-pet" / "live2d-pet.js"
        if cand.exists():
            return cand.read_text(encoding="utf-8", errors="replace")
    return ""


def test_plugin_api() -> None:
    """[8] 插件包自足性：路由契约 + 独有信号 + 气泡身份色。

    这节守的是"插件化"这件事本身：
      - 插件只暴露自己的前缀 /api/plugin/dsh/*
      - 独有信号（审批/提问）能产出气泡且带去重
      - 总线 announce 只透传 agent_id，不认识任何具体插件
    """
    print("\n[8] 插件包自足性（路由契约 / 独有信号 / 气泡身份色）")

    # ---- 身份色：插件声明 → 总线透传 → 渲染端套用 ----
    # 这条链路踩过两次坑，都是"看似写对了其实没生效"：
    #   ① AgentState.__init__ 收了 accent 参数却写死 self.accent = ""；
    #   ② 桌宠窗口与管理页是不同 HTML 页面，桌宠没加载插件注册表，
    #      所以只从注册表读色值在桌宠这边永远拿到空 → 气泡不变蓝。
    # 现在由插件在 register() 时声明色值，经 agent_phase / agent_bubble 透传。
    from ...kernel import agent_bus_service as _bus_mod
    from .dsh_adapter import DSH_ACCENT as _accent
    _bus_mod.bus.register("__selftest_accent__", "T", "t", accent=_accent)
    _snap = _bus_mod.bus.snapshot()
    _row = next((a for a in _snap["agents"] if a["agent_id"] == "__selftest_accent__"), None)
    check("快照里带插件身份色", bool(_row and _row.get("accent") == _accent),
          repr(_row and _row.get("accent")))
    _sent: list[tuple[str, dict]] = []
    _orig_publish = _bus_mod.pet_event_service.publish
    _bus_mod.pet_event_service.publish = lambda t, p: _sent.append((t, p))
    try:
        _bus_mod.bus.emit("__selftest_accent__", "executing_tool")
        _bus_mod.bus.announce("__selftest_accent__", "自检气泡", duration_ms=1000)
    finally:
        _bus_mod.pet_event_service.publish = _orig_publish
    _kinds = {k for k, _ in _sent}
    check("agent_phase 带身份色", any(p.get("accent") == _accent for k, p in _sent if k == "agent_phase"),
          repr([(k, p.get("accent")) for k, p in _sent]))
    check("agent_bubble 带身份色", any(p.get("accent") == _accent for k, p in _sent if k == "agent_bubble"),
          repr([(k, p.get("accent")) for k, p in _sent]))
    check("渲染端气泡走 payload.accent", "applyBubbleAgentAccent" in _pet_js_src(),
          "未在桌宠渲染端找到 applyBubbleAgentAccent")
    _bus_mod.bus.unregister("__selftest_accent__")

    try:
        from . import routes as plugin_routes
        from . import dsh_signals
    except Exception as exc:  # noqa: BLE001
        check("导入插件路由与信号模块", False, str(exc))
        return
    check("导入插件路由与信号模块", True)

    # 路由前缀必须是本插件专属，不得侵入其它插件命名空间
    check_eq("路由前缀专属", plugin_routes.router.prefix, "/api/plugin/dsh")
    paths = sorted({r.path for r in plugin_routes.router.routes})
    # 端点清单是**故意断言**的：新增端点必须同时更新这里，
    # 以免有人顺手加了个写接口却没人注意到"本插件只读"这条约束。
    #
    # 2026-10-16（M6 6.5）**受控放宽**：新增 `POST /ingest` —— 插件形态
    # （packages/mao-pet）跑在 DSH 宿主进程内，必须有一个**写入口**把 phase 推进总线；
    # 而日志边车链路是单向只读的，无法承担这个职责。
    # 这条约束没有被放弃，而是**改成"读接口只读 + 写接口逐个显式登记 + 有明确安全依据"**：
    #   - 写端点全部在此登记，职责在各 route 的 docstring 里写明；
    #   - 其安全由后端全站中间件 `LocalControlMiddleware` 兜底
    #     （app/local_security.py：回环 + 同源 + 拒 cross-site），
    #     故下面新增了一条"中间件确实已挂载且真的会拒绝"的断言来守住这条依据。
    #
    # 2026-10-16（M7 7.6）再增 `POST /strip`：横条窗位的投递末端。
    #   `window.__mioPetStrip` 只存在于**桌宠窗口**，而插件跑在宿主进程、
    #   注入行又在 DSH Web GUI 窗口 —— 三者互不相通，故横条内容必须经总线转发：
    #   插件 → /strip → 总线 strip() → WS agent_strip → 桌宠窗口 → __mioPetStrip。
    check_eq("暴露 6 个只读端点 + 2 个受控写端点", paths, [
        "/api/plugin/dsh/about",
        "/api/plugin/dsh/agent",
        "/api/plugin/dsh/diagnostics",
        "/api/plugin/dsh/ingest",
        "/api/plugin/dsh/phases",
        "/api/plugin/dsh/status",
        "/api/plugin/dsh/strip",
        "/api/plugin/dsh/update-check",
    ])
    methods = sorted({m for r in plugin_routes.router.routes for m in (r.methods or set())})
    # 比笼统的"全部只读"更守住意图：**写方法只允许 POST，且必须逐个登记**。
    # 将来有人加 DELETE/PUT 之类的写操作会被下面两条挡下。
    check_eq("只读端点均为 GET + 存在 POST 写端点", methods, ["GET", "POST"])
    _write_routes = sorted({
        r.path for r in plugin_routes.router.routes
        if {"POST", "PUT", "PATCH", "DELETE"} & set(r.methods or set())
    })
    check_eq("写端点仅 ingest + strip（新增写操作必须显式改这条）",
             _write_routes, ["/api/plugin/dsh/ingest", "/api/plugin/dsh/strip"])

    # ★ 写端点的安全**不靠插件自己**，而靠后端全站中间件。
    #   所以必须断言"那条中间件真的在、且真的会拒"，否则上面那条放宽就成了空头支票。
    #   这里直接打真实 app（TestClient），验证三类来源：本机放行、跨站拒绝、非回环拒绝。
    try:
        from fastapi.testclient import TestClient
        from ...main import app as _app
        with TestClient(_app, base_url="http://127.0.0.1:8000") as _client:
            _r_ok = _client.post("/api/plugin/dsh/ingest", json={"phase": "idle", "force": True})
            check_eq("ingest：本机来源可写", _r_ok.status_code, 200)
            _r_xs = _client.post("/api/plugin/dsh/ingest", json={"phase": "idle"},
                                 headers={"sec-fetch-site": "cross-site"})
            check_eq("ingest：跨站来源被拒（403）", _r_xs.status_code, 403)
            _r_host = _client.post("/api/plugin/dsh/ingest", json={"phase": "idle"},
                                   headers={"host": "evil.example.com"})
            check_eq("ingest：非回环 Host 被拒（403）", _r_host.status_code, 403)
            _r_bad = _client.post("/api/plugin/dsh/ingest", json={"phase": "not-a-phase"})
            check_eq("ingest：非法 phase 返回 400", _r_bad.status_code, 400)

            # /strip（7.6 横条投递末端）同样受中间件保护，逐条验
            _s_show = _client.post("/api/plugin/dsh/strip",
                                   json={"kind": "show", "text": "自检内容"})
            check_eq("strip：本机来源可写（show）", _s_show.status_code, 200)
            check_eq("strip：响应含 delivered", bool(_s_show.json().get("delivered")), True)
            _s_app = _client.post("/api/plugin/dsh/strip", json={"kind": "append", "text": "x"})
            check_eq("strip：append 可写", _s_app.status_code, 200)
            _s_hide = _client.post("/api/plugin/dsh/strip", json={"kind": "hide"})
            check_eq("strip：hide 可写（无需 text）", _s_hide.status_code, 200)
            _s_style = _client.post("/api/plugin/dsh/strip",
                                    json={"kind": "style", "styleId": "terminal"})
            check_eq("strip：style 可写", _s_style.status_code, 200)
            _s_kind = _client.post("/api/plugin/dsh/strip", json={"kind": "nonsense"})
            check_eq("strip：非法 kind 返回 400", _s_kind.status_code, 400)
            _s_notext = _client.post("/api/plugin/dsh/strip", json={"kind": "show"})
            check_eq("strip：show 缺 text 返回 400", _s_notext.status_code, 400)
            _s_422 = _client.post("/api/plugin/dsh/strip", json={})
            check_eq("strip：缺 kind 返回 422", _s_422.status_code, 422)
            _s_xs = _client.post("/api/plugin/dsh/strip", json={"kind": "hide"},
                                 headers={"sec-fetch-site": "cross-site"})
            check_eq("strip：跨站来源被拒（403）", _s_xs.status_code, 403)
            _s_host = _client.post("/api/plugin/dsh/strip", json={"kind": "hide"},
                                   headers={"host": "evil.example.com"})
            check_eq("strip：非回环 Host 被拒（403）", _s_host.status_code, 403)

            # 清掉本次自检在总线上留下的痕迹，避免污染后续断言/快照
            from ...kernel import agent_bus_service as _bus
            _bus.unregister("mao-pet")
    except Exception as exc:  # noqa: BLE001
        check("写端点安全栅栏端到端（中间件兜底）", False, f"{type(exc).__name__}: {exc}")

    # A5：关于面板必须脱敏（绝不回传真实用户名）
    try:
        about = plugin_routes.about_service.about_payload()
        import json as _json
        dumped = _json.dumps(about, ensure_ascii=False)
        check("关于面板不含真实用户名", "xiao1" not in dumped)
        check("关于面板带脱敏占位符", "%MIO_ROOT%" in dumped)
        check("关于面板能读到版本号", bool(about.get("about", {}).get("version")),
              repr(about.get("about", {}).get("version")))
        # 更新检查的版本比较（宽松、可预期）
        check("版本比较：新版>旧版", plugin_routes.about_service._is_newer("3.6", "3.5"))
        check("版本比较：同版不比新版大", not plugin_routes.about_service._is_newer("3.5", "3.5"))
        check("版本比较：旧版不比新版大", not plugin_routes.about_service._is_newer("3.4", "3.5"))
    except Exception as exc:  # noqa: BLE001
        check("关于面板自检", False, str(exc))

    # phase 语义表必须覆盖全部 12 态（缺一个前端就会显示英文原值）
    check("语义表覆盖全部 12 态",
          set(plugin_routes.PHASE_META) == set(dsh.DSH_PHASES),
          f"缺 {sorted(set(dsh.DSH_PHASES) - set(plugin_routes.PHASE_META))}")

    # ---- 独有信号：气泡播报 ----
    from ...kernel import agent_bus_service as bus
    captured: list[tuple[str, str]] = []
    original = bus.announce
    bus.announce = lambda aid, text, **kw: (captured.append((aid, text)), True)[1]
    try:
        dsh_signals.reset_announce_state()
        first = dsh_signals.maybe_announce_waiting("dsh", {"awaiting_approval": True, "approval_tool": "pwsh"})
        second = dsh_signals.maybe_announce_waiting("dsh", {"awaiting_approval": True, "approval_tool": "pwsh"})
        check("审批等待产出气泡", bool(first) and "授权" in first, repr(first))
        check("同一等待不重复播报（去重）", second == "", repr(second))

        dsh_signals.reset_announce_state()
        q = dsh_signals.maybe_announce_waiting("dsh", {"awaiting_question": True, "question_text": "要继续吗？"})
        check("提问等待产出气泡", q == "要继续吗？", repr(q))

        dsh_signals.reset_announce_state()
        none = dsh_signals.maybe_announce_waiting("dsh", {})
        check("无等待时不打扰", none == "", repr(none))

        # 工作节点播报：前两条只在"卡住等人"时才响，日常干活时桌宠一句话都不说，
        # 用户会误以为 DSH 气泡功能没生效。补上"正在用 X 干活"。
        dsh_signals.reset_announce_state()
        work = dsh_signals.maybe_announce_waiting("dsh", {"last_tool": "pwsh", "active_tools": 2})
        check("干活时播报工具名", "pwsh" in work, repr(work))
        again = dsh_signals.maybe_announce_waiting("dsh", {"last_tool": "pwsh", "active_tools": 2})
        check("同一工具不刷屏（去重）", again == "", repr(again))
        other = dsh_signals.maybe_announce_waiting("dsh", {"last_tool": "read", "active_tools": 1})
        check("换工具会重新播报", "read" in other, repr(other))
        dsh_signals.reset_announce_state()
        idle = dsh_signals.maybe_announce_waiting("dsh", {"last_tool": "pwsh", "active_tools": 0})
        check("无工具在跑时不播报", idle == "", repr(idle))

        check("播报都带本插件 agent_id",
              all(a == "dsh" for a, _ in captured),
              repr(captured))
    finally:
        bus.announce = original
        dsh_signals.reset_announce_state()

    # ---- 气泡身份色：色值归插件 manifest，总线只透传 id ----
    import json as _json
    from pathlib import Path as _Path
    pet_dir = None
    _here = _Path(dsh.__file__).resolve()
    for _up in (4, 3, 2, 5):
        if _up >= len(_here.parents):
            continue
        cand = _here.parents[_up] / "澪Agent应用" / "dist" / "plugins" / "dsh" / "manifest.js"
        if cand.exists():
            pet_dir = cand
            break
    if pet_dir is None:
        check("找到 dsh 插件 manifest.js", False, "未找到")
    else:
        check("找到 dsh 插件 manifest.js", True)
        src = pet_dir.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"accent:\s*'(#[0-9A-Fa-f]{6})'", src)
        check("manifest 声明了 accent 色", m is not None, "未匹配到 accent")
        if m:
            api_accent = plugin_routes.PHASE_META and None
            # 插件 API 里上报的 accent 必须与 manifest 一致（否则气泡/界面两套色）
            api_src = Path(__file__).with_name("routes.py").read_text(encoding="utf-8", errors="replace")
            m2 = re.search(r'"accent":\s*"(#[0-9A-Fa-f]{6})"', api_src)
            check("API 与 manifest 的 accent 一致",
                  m2 is not None and m2.group(1).lower() == m.group(1).lower(),
                  f"api={m2.group(1) if m2 else None} manifest={m.group(1)}")
        # 渲染端必须按 data 属性着色（不硬编码插件名）
        pet_js = None
        for _up in (4, 3, 2, 5):
            if _up >= len(_here.parents):
                continue
            cand = _here.parents[_up] / "澪Agent应用" / "dist" / "live2d-pet" / "live2d-pet.js"
            if cand.exists():
                pet_js = cand
                break
        if pet_js is not None:
            js = pet_js.read_text(encoding="utf-8", errors="replace")
            check("渲染端支持 agent_bubble 消息", "agent_bubble" in js)
            check("渲染端按插件身份着色（非硬编码 DSH）",
                  "applyBubbleAgentAccent" in js and "AGENT_ACCENTS" in js)
            check("渲染端不硬编码 dsh 字面量",
                  "'dsh'" not in js.split("function applyBubbleAgentAccent")[1].split("function showSpeechBubble")[0])


def main() -> int:
    print("=" * 68)
    print("DSH 适配器自检（app.agents.dsh.dsh_adapter_selftest）")
    print("=" * 68)
    test_phase_mapping()
    test_parse_event()
    test_sidecar_real_log()
    test_replay_real_events()
    test_helpers()
    test_bus_integration()
    test_step_start_resets_output_flags()
    test_frontend_contract()
    test_plugin_api()
    test_stream_sidecar()
    test_stream_bus_and_adapter()
    test_stream_frontend_contract()

    print("\n" + "=" * 68)
    print(f"结果：{PASS} 通过 / {FAIL} 失败")
    if FAILURES:
        print("失败项：")
        for f in FAILURES:
            print(f"  - {f}")
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
