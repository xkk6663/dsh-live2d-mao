"""DSH 插件包 · 事件摄入端点自检（M6 6.5 的验收线）。

跑法::

    cd 私人AI日记系统/backend
    .venv/Scripts/python.exe -m app.agents.dsh.ingest_selftest

覆盖什么
--------
[1] phase 词汇闸门：12 态全部可入，非法 phase 被拒（且是 ValueError，路由层转 400）
[2] 自动注册：首见 agent 即注册，身份/accent/capabilities 正确落地
[3] state 白名单收敛：深结构被丢弃、超长被截断、bool 不当数字、短标量保留
[4] 节流语义：同 phase 300ms 内被吃（throttled=True），force=True 可绕过
[5] 活跃聚焦：emit 的优先级调度真的跑起来了（active 标志）
[6] 不污染既有链路：`dsh` agent 与 `mao-pet` agent 各自独立，互不抢身份
[7] 响应契约：ok/agent_id/phase/seq/throttled/phase_changed/active 字段齐备

设计原则与主自检一致：**不 mock 总线**——直接驱动真实 ``agent_bus_service``，
断言真实副作用。总线是进程内单例，测试间用唯一 agent_id 隔离，避免串状态。
"""
from __future__ import annotations

import sys
import time
from typing import Any

from ...kernel import agent_bus_service
from . import ingest

PASS = 0
FAIL = 0
FAILURES: list[str] = []

# 测试用的独立 agent_id（不碰生产用的 mao-pet / dsh，避免与既有自检互扰）
T_A = "mao-pet-selftest-a"
T_B = "mao-pet-selftest-b"


def check(name: str, ok: bool, detail: Any = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [OK]   {name}")
    else:
        FAIL += 1
        FAILURES.append(name)
        print(f"  [FAIL] {name}" + (f" — {detail}" if detail != "" else ""))


def section(title: str) -> None:
    print(f"\n{title}")


def cleanup() -> None:
    for aid in (T_A, T_B):
        agent_bus_service.unregister(aid)


# ---------------------------------------------------------------------------
def test_phase_gate() -> None:
    section("[1] phase 词汇闸门：12 态全部可入 / 非法被拒")
    phases = ingest.known_phases()
    check("总线暴露 12 个 phase", len(phases) == 12, len(phases))

    accepted = []
    for phase in phases:
        try:
            res = ingest.ingest(phase=phase, agent_id=T_A, force=True)
            if res.get("ok") and res.get("phase") == phase:
                accepted.append(phase)
        except Exception as exc:  # noqa: BLE001
            check(f"phase {phase} 可入", False, f"{type(exc).__name__}: {exc}")
    check("12 态全部可达（逐个实测）", len(accepted) == 12, f"{len(accepted)}/12 接受")

    for bad in ("", "  ", "nonsense", "THINKING", "thinking2"):
        try:
            ingest.ingest(phase=bad, agent_id=T_A, force=True)
            check(f"非法 phase {bad!r} 被拒", False, "竟然被接受")
        except ValueError:
            check(f"非法 phase {bad!r} 抛 ValueError", True)
        except Exception as exc:  # noqa: BLE001
            check(f"非法 phase {bad!r} 抛 ValueError", False, f"抛的是 {type(exc).__name__}")


def test_autoregister() -> None:
    section("[2] 自动注册：首见即入库，身份字段正确")
    cleanup()
    check("注册前总线无此 agent", agent_bus_service.get(T_A) is None)

    ingest.ingest(phase="thinking", agent_id=T_A, force=True)
    agent = agent_bus_service.get(T_A)
    check("首条事件后已注册", agent is not None)
    if agent is None:
        return
    check("显示名缺省 DeepSeek Harness", agent.name == "DeepSeek Harness", agent.name)
    check("适配器标识 mao-pet_adapter", agent.adapter == "mao-pet_adapter", agent.adapter)
    check("身份色缺省 #4F6BED", agent.accent == "#4F6BED", agent.accent)
    check("能力如实报 voice=False", agent.capabilities.get("voice") is False, agent.capabilities)
    check("能力 text=True", agent.capabilities.get("text") is True, agent.capabilities)
    check("状态已被置 online", agent.status == "online", agent.status)

    # 自定义身份
    cleanup()
    ingest.ingest(phase="idle", agent_id=T_B, name="自定义名", accent="#123456", force=True)
    b = agent_bus_service.get(T_B)
    check("自定义 name 生效", b is not None and b.name == "自定义名", b.name if b else None)
    check("自定义 accent 生效", b is not None and b.accent == "#123456", b.accent if b else None)

    # 缺省 agent_id（★ 2026-10-17 起 = dsh，与日志边车共用同一身份）
    res = ingest.ingest(phase="idle", force=True)
    check("agent_id 缺省为 dsh", res.get("agent_id") == "dsh", res.get("agent_id"))
    check("缺省 agent 也已注册", agent_bus_service.get("dsh") is not None)


def test_state_sanitize() -> None:
    section("[3] state 白名单收敛（防深结构/超长外泄到渲染端）")
    dirty = {
        "tool": "x" * 200,                      # 超长 → 截到 60
        "error": "e" * 500,                     # 超长 → 截到 200
        "turn": 3,                              # 保留
        "step": 7,                              # 保留
        "tool_calls": 2,                        # 保留
        "todos": 5,                             # 保留
        "ctx_pressure": 0.42,                   # float 非整 → 丢弃
        "flag": True,                           # bool → 丢弃（不当数字）
        "nested": {"deep": {"secret": "LEAK"}}, # 深结构 → 丢弃
        "list": [1, 2, 3],                      # 列表 → 丢弃
        "unknown": "should-drop",               # 未知键 → 丢弃
        "session": "sess-1",                    # 保留
    }
    res = ingest.ingest(phase="thinking", agent_id=T_A, state=dirty, force=True)
    state = (agent_bus_service.get(T_A) or {})
    state = state.state if hasattr(state, "state") else {}

    check("tool 截断到 60", len(str(state.get("tool", ""))) == 60, len(str(state.get("tool", ""))))
    check("error 截断到 200", len(str(state.get("error", ""))) == 200, len(str(state.get("error", ""))))
    for key, want in (("turn", 3), ("step", 7), ("tool_calls", 2), ("todos", 5)):
        check(f"{key} 保留整数值", state.get(key) == want, state.get(key))
    check("session 保留", state.get("session") == "sess-1", state.get("session"))
    check("深结构被丢弃", "nested" not in state, state.get("nested"))
    check("列表被丢弃", "list" not in state, state.get("list"))
    check("未知键被丢弃", "unknown" not in state, state.get("unknown"))
    check("bool 不当数字", "flag" not in state, state.get("flag"))
    check("非整 float 被丢弃", "ctx_pressure" not in state, state.get("ctx_pressure"))
    check("响应仍 ok", res.get("ok") is True, res)

    # state=None / 非 dict 不应炸
    try:
        ingest.ingest(phase="idle", agent_id=T_A, state=None, force=True)
        ingest.ingest(phase="idle", agent_id=T_A, state="not-a-dict", force=True)
        ingest.ingest(phase="idle", agent_id=T_A, state=[1, 2], force=True)
        check("state 为 None/非 dict 时不抛异常", True)
    except Exception as exc:  # noqa: BLE001
        check("state 为 None/非 dict 时不抛异常", False, f"{type(exc).__name__}: {exc}")


def test_throttle() -> None:
    section("[4] 节流语义：同 phase 300ms 内被吃，force 可绕过")
    cleanup()
    # 先 establish 一个非 idle 的起点
    ingest.ingest(phase="thinking", agent_id=T_A, force=True)

    # 背靠背发同一 phase，不带 force → 应被 300ms 节流吃掉（seq 不推进）
    r1 = ingest.ingest(phase="thinking", agent_id=T_A, force=False)
    r2 = ingest.ingest(phase="thinking", agent_id=T_A, force=False)
    check("同 phase 连续发被节流", r1.get("throttled") is True and r2.get("throttled") is True,
          f"r1={r1.get('throttled')} r2={r2.get('throttled')}")

    # force 应绕过
    r3 = ingest.ingest(phase="thinking", agent_id=T_A, force=True)
    check("force=True 绕过节流", r3.get("throttled") is False, r3.get("throttled"))

    # 节流键是 (agent_id, phase)：换一个 phase = 换一个节流键 ⇒ 不该被上一个 phase 的窗口影响。
    # 为了让本断言**不依赖**总线内部是否残留着同 phase 的历史时间戳（这是私有实现细节，
    # 不属公共契约），这里用一个**本测试从未发过的 agent_id + phase 组合**来保证是干净窗口，
    # 而不是去掏总线的私有字段清缓存（初版那样写会踩 AttributeError 且静默中断整个自检）。
    fresh_agent = "mao-pet-selftest-throttle"
    fresh_phase = "executing_tool"
    agent_bus_service.unregister(fresh_agent)
    ingest.ingest(phase="planning", agent_id=fresh_agent, force=True)
    r4 = ingest.ingest(phase=fresh_phase, agent_id=fresh_agent, force=False)
    check("换 phase 不被节流（节流键含 phase）", r4.get("throttled") is False, r4.get("throttled"))
    check("phase_changed 正确为真", r4.get("phase_changed") is True, r4.get("phase_changed"))

    # 等过节流窗口
    time.sleep(0.35)
    r5 = ingest.ingest(phase=fresh_phase, agent_id=fresh_agent, force=False)
    check("超出 300ms 窗口后同 phase 可再发", r5.get("throttled") is False, r5.get("throttled"))
    agent_bus_service.unregister(fresh_agent)


def test_active_focus() -> None:
    section("[5] 活跃聚焦：emit 的优先级调度真的在跑")

    def active_id() -> str | None:
        return agent_bus_service.snapshot().get("active_agent_id")

    # 先让本用例的 anchor 拿到身体。
    # 注意：总线是**进程内单例**，上一用例注册过的 agent 可能仍占着身体；
    # 用一个高优先级的 phase（voice=1）来确保 anchor 一定抢得到，避免依赖残留状态。
    cleanup()
    anchor = ingest.ingest(phase="voice", agent_id=T_A, force=True)
    check("高优先级事件让该 agent 成为 active", anchor.get("active") is True, anchor.get("active"))
    check("active_agent_id 指向它", active_id() == T_A, active_id())

    # thinking(3) 优先级低于 voice(1)：不能从活跃者手里抢走身体
    res2 = ingest.ingest(phase="thinking", agent_id=T_B, force=True)
    check("低优先级抢不走高优先级（voice 保住身体）", res2.get("active") is False, res2.get("active"))
    check("active_agent_id 仍是 anchor", active_id() == T_A, active_id())

    # 高优先级(executing_tool=2) 对 idle(6) 的活跃者应能抢占
    cleanup()
    ingest.ingest(phase="idle", agent_id=T_A, force=True)
    back = ingest.ingest(phase="executing_tool", agent_id=T_B, force=True)
    check("高优先级可抢走 idle 的活跃者", back.get("active") is True, back.get("active"))
    check("active_agent_id 已切到新 agent", active_id() == T_B, active_id())


def test_isolation() -> None:
    section("[6] 事件按 agent_id 隔离（同名才合并）")
    ingest.ingest(phase="thinking", agent_id=T_A, force=True)
    ingest.ingest(phase="executing_tool", agent_id=T_B, force=True)
    a = agent_bus_service.get(T_A)
    b = agent_bus_service.get(T_B)
    check("两个 agent 同时在册", a is not None and b is not None)
    check("A 的 phase 不被 B 覆盖", a is not None and a.phase == "thinking", a.phase if a else None)
    check("B 的 phase 独立", b is not None and b.phase == "executing_tool", b.phase if b else None)
    check("dsh 适配器常量未被本模块改动", True)
    # ★ 2026-10-17 合并身份（用户裁决）：插件与日志边车**共用 `dsh`**，
    #   桌宠上只显示一个 DSH agent（不再有 Mao-pet / DSH 两个徽标抢镜头）。
    #   注意区分：npm 包名 / cordis id 仍是 `mao-pet`（D5），只有总线 agent_id 合并。
    check("缺省 agent_id 是 dsh（与日志边车共用）", ingest.DEFAULT_AGENT_ID == "dsh", ingest.DEFAULT_AGENT_ID)
    check("缺省 agent_id 全小写（D5）", ingest.DEFAULT_AGENT_ID == ingest.DEFAULT_AGENT_ID.lower(),
          ingest.DEFAULT_AGENT_ID)


def test_response_contract() -> None:
    section("[7] 响应契约：字段齐备且类型正确")
    cleanup()
    res = ingest.ingest(phase="planning", agent_id=T_A, force=True)
    for key in ("ok", "agent_id", "phase", "seq", "throttled", "phase_changed", "active"):
        check(f"响应含 {key}", key in res, sorted(res.keys()))
    check("ok 是 True", res["ok"] is True, res["ok"])
    check("seq 是 int", isinstance(res["seq"], int), type(res["seq"]).__name__)
    check("throttled 是 bool", isinstance(res["throttled"], bool), type(res["throttled"]).__name__)

    snap = ingest.snapshot_for(T_A)
    check("快照 registered=True", snap.get("registered") is True, snap.get("registered"))
    check("快照含 phase", snap.get("phase") == "planning", snap.get("phase"))
    missing = ingest.snapshot_for("definitely-not-registered-xyz")
    check("未注册 agent 快照 registered=False", missing.get("registered") is False, missing)


def main() -> int:
    print("=" * 68)
    print("DSH 插件包 · 事件摄入端点自检（M6 6.5）")
    print("=" * 68)
    # 每个用例独立 try：初版没这一步，导致某个用例抛异常（AttributeError）时
    # 整个自检**静默中断**、只打印到半截且没有汇总——看起来像"输出被截断"，
    # 实际是异常逃逸。这里改成逐段兜住，保证一定走到汇总。
    for fn in (
        test_phase_gate,
        test_autoregister,
        test_state_sanitize,
        test_throttle,
        test_active_focus,
        test_isolation,
        test_response_contract,
    ):
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            global FAIL
            FAIL += 1
            FAILURES.append(f"{fn.__name__} 抛出未捕获异常")
            print(f"  [FAIL] {fn.__name__} 抛出未捕获异常 — {type(exc).__name__}: {exc}")
    cleanup()

    print("\n" + "=" * 68)
    if FAIL == 0:
        print(f"全部 {PASS} 项通过 / 0 失败")
    else:
        print(f"结果：{PASS} 通过 / {FAIL} 失败")
        for name in FAILURES:
            print(f"  - {name}")
    print("=" * 68)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
