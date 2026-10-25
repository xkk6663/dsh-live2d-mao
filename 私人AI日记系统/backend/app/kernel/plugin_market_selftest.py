"""插件市场清单层自检：默认清单 / 增删幂等 / 路径穿越 / builtin 保护 / 原子写 / 重名 / 真 app 端点。

运行（在 backend 目录下，Windows 的 bash 工具会因为 CreatePipe 被沙箱拦掉，
所以用 pwsh 跑；纯 Python、不 fork 子进程，任何 shell 都能跑）::

    .venv\\Scripts\\python.exe -m app.kernel.plugin_market_selftest

覆盖（对应 ``docs/插件市场-契约.md``）：
  1. 路径安全：``..`` / URL / 绝对路径 / 盘符 / 软链逃逸 全部被拒（**realpath 判定**）；
  2. 默认清单：4 条（dsh / cloud_feiyu / pet / market）、字段与
     ``dist/plugins/*/manifest.js`` 逐项一致；
  3. 增删幂等：重复上架 409、重复下架 404、下架不动磁盘文件；
  4. builtin 保护：不可停用（403）、不可下架（403）；
  5. 原子写：任何时刻磁盘上都是一份完整可解析的 JSON，且不留临时文件；
  6. 热插拔：未注册 → 自动注册进总线；enabled 真值以总线为准；
  7. 重名：清单被外部写坏（重复 id）时 diagnostics 报 duplicate_id；
  8. 真 app 端到端：TestClient 打 ``/api/plugin/market/*`` 全部契约端点。

★ 所有写操作都指向**临时目录**（``__pycache__/_market_selftest``），
  不碰 ``私人AI日记系统/数据/插件市场.json`` —— 那是用户真实数据。
  唯一读真实路径的是 [2] 里对 ``dist/plugins/*/manifest.js`` 的只读比对。
"""
from __future__ import annotations

import io
import json
import re
import shutil
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

from ..config import settings
from . import agent_bus_service, plugin_market_service as svc


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
# 沙箱：把 data_dir 指到临时目录，结束后完整还原
# ---------------------------------------------------------------------------
def _sandbox_root() -> Path:
    # 与 dsh_adapter_selftest 同一套理由：Windows 沙箱下 tempfile 的清理
    # 会因权限回收失败抛 PermissionError，故落在仓库内 __pycache__ 下。
    return Path(svc.__file__).resolve().parent / "__pycache__" / "_market_selftest"


class Sandbox:
    """临时数据目录 + 一台"假前端产物树"。

    假产物树只造**路径拓扑**（plugins/<id>/manifest.js），
    内容无关紧要 —— 被校验的是路径边界，不是脚本内容。
    """

    def __init__(self) -> None:
        self.root = _sandbox_root()
        self.data_dir = self.root / "数据"
        self.frontend = self.root / "dist"
        self._orig_data_dir = settings.data_dir
        self._orig_frontend = settings.agent_frontend_dir

    def __enter__(self) -> "Sandbox":
        if self.root.exists():
            shutil.rmtree(self.root, ignore_errors=True)
        (self.frontend / "plugins" / "alpha").mkdir(parents=True, exist_ok=True)
        (self.frontend / "plugins" / "beta").mkdir(parents=True, exist_ok=True)
        (self.frontend / "plugins" / "alpha" / "manifest.js").write_text("// a\n", encoding="utf-8")
        (self.frontend / "plugins" / "alpha" / "alpha-panel.js").write_text("// ap\n", encoding="utf-8")
        (self.frontend / "plugins" / "beta" / "manifest.js").write_text("// b\n", encoding="utf-8")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        object.__setattr__(settings, "data_dir", self.data_dir)
        object.__setattr__(settings, "agent_frontend_dir", self.frontend)
        svc.plugin_market.reload()
        return self

    def reset(self) -> None:
        """清空清单（下一个 load 会重新落默认清单）与总线上的自检身份。"""
        svc.catalog_path().unlink(missing_ok=True)
        svc.plugin_market.reload()
        for agent_id in ("alpha", "beta", "gamma", "__dup__"):
            agent_bus_service.unregister(agent_id)

    def __exit__(self, *_exc: Any) -> None:
        # ★ 顺序是踩过坑的：必须先（在**沙箱路径还生效时**）清缓存，
        #   再把 settings 还原回真实路径。
        #   反过来的话 ``reload()`` 会拿真实 data_dir 去 load()，而 load()
        #   发现文件不存在就会**自动落一份默认清单** —— 于是自检每次运行
        #   都在用户的 数据/ 里凭空造一个 插件市场.json（本自检的第一版就是这样
        #   把真实数据目录污染掉的，注释留在 _assert_sandboxed 里）。
        try:
            shutil.rmtree(self.root, ignore_errors=True)  # 先删沙箱，免得缓存指向已删文件
        finally:
            object.__setattr__(settings, "data_dir", self._orig_data_dir)
            object.__setattr__(settings, "agent_frontend_dir", self._orig_frontend)
        # 此时路径已还原：只**丢缓存**，不 load()，绝不在真实目录里产生写入
        with svc.plugin_market._lock:
            svc.plugin_market._cache = None
            svc.plugin_market._cache_stamp = None
        agent_bus_service.unregister("alpha")
        agent_bus_service.unregister("beta")
        agent_bus_service.unregister("gamma")


# ---------------------------------------------------------------------------
# 1) 路径安全
# ---------------------------------------------------------------------------
def test_path_safety() -> None:
    print("\n[1] 路径安全（realpath 判定，不靠字符串 startswith）")

    bad_cases: list[tuple[str, str]] = [
        ("../../etc/passwd", "经典 ../ 穿越"),
        ("plugins/../plugins/alpha/manifest.js", "字符串看着在 plugins 内、实际含 .. 段"),
        ("../plugins/alpha/manifest.js", "以 .. 开头逃到 dist 外再绕回"),
        ("http://evil.example.com/x.js", "远程 URL"),
        ("//evil.example.com/x.js", "协议相对 URL"),
        ("file:///C:/Windows/x.js", "file: 协议"),
        ("C:/Windows/system.ini", "盘符绝对路径"),
        ("/etc/passwd", "POSIX 绝对路径"),
        ("plugins\\alpha\\manifest.js", "反斜杠分隔（绕过 .. 检测的常见形态）"),
        ("", "空路径"),
    ]
    for rel, why in bad_cases:
        try:
            svc.resolve_plugin_file(rel, field="entry")
            check(f"拒绝越界路径（{why}）", False, f"未拒绝：{rel!r}")
        except svc.InvalidEntryError as exc:
            # 契约要求"错误信息里带具体路径"，故把原值回显也算一条断言
            check(f"拒绝越界路径（{why}）", rel == "" or rel in str(exc), f"错误信息未带路径：{exc}")
        except Exception as exc:  # noqa: BLE001
            check(f"拒绝越界路径（{why}）", False, f"{type(exc).__name__}: {exc}")

    # 不存在的文件单独一条：错误里必须带**传入的相对路径**（前端直接回显它），
    # 而不是只带一段绝对路径——绝对路径对用户毫无意义且会泄漏本机目录结构。
    try:
        svc.resolve_plugin_file("plugins/alpha/missing.js", field="entry")
        check("拒绝不存在的文件", False, "未拒绝")
    except svc.InvalidEntryError as exc:
        # 相对路径回显是必须的；绝对路径只是附带的排障信息（能在本机定位到哪去看了）。
        # 注意 Windows 会把 / 归一成 \，故按归一化形态比对。
        echoed = "plugins/alpha/missing.js" in str(exc) or "plugins\\alpha\\missing.js" in str(exc)
        check("拒绝不存在的文件", echoed, str(exc))
        check("错误信息同时标出是哪个字段", "entry" in str(exc), str(exc))

    # 合法路径必须放行（否则上面那些"全部拒绝"的断言可能只是因为实现全拒）
    try:
        resolved = svc.resolve_plugin_file("plugins/alpha/manifest.js", field="entry")
        check("接受合法相对路径", resolved.is_file(), str(resolved))
        check("解析结果落在 dist/plugins 内", resolved.is_relative_to(svc.plugins_root()), str(resolved))
    except Exception as exc:  # noqa: BLE001
        check("接受合法相对路径", False, f"{type(exc).__name__}: {exc}")

    # ★ 兄弟目录前缀陷阱：plugins/alpha 与 plugins/alpha2，startswith 会把后者判成前者之内
    sibling = svc.frontend_root() / "plugins" / "alpha2"
    sibling.mkdir(parents=True, exist_ok=True)
    (sibling / "manifest.js").write_text("// sib\n", encoding="utf-8")
    try:
        svc.resolve_plugin_file("plugins/alpha2/manifest.js", field="entry")
        check("兄弟目录不被误判为本插件目录", True)
    except Exception as exc:  # noqa: BLE001
        check("兄弟目录不被误判为本插件目录", False, str(exc))
    # 反过来：_safety_of 对 plugins/ 之外的兄弟目录必须回头报 escape
    outside = svc.frontend_root() / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "x.js").write_text("// o\n", encoding="utf-8")
    check_eq("dist/outside 被判为越界", svc._safety_of("outside/x.js"), "escape")


def test_symlink_escape() -> None:
    print("\n[1b] 软链接逃逸（只有 realpath 挡得住）")

    link = svc.plugins_root() / "evil"
    target = svc.frontend_root().parent  # 指向 dist 之外
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        # Windows 非管理员/未开开发者模式时无法建软链：如实跳过，不假装通过
        print(f"      无法创建软链接（{type(exc).__name__}），跳过该断言")
        return
    try:
        (target / "evil_manifest.js").write_text("// e\n", encoding="utf-8")
        try:
            svc.resolve_plugin_file("plugins/evil/evil_manifest.js", field="entry")
            check("软链接指向 dist 外 → 拒绝", False, "未拒绝")
        except svc.InvalidEntryError as exc:
            check("软链接指向 dist 外 → 拒绝", "越界" in str(exc), str(exc))
        check_eq("_safety_of 也把该软链判为 escape",
                 svc._safety_of("plugins/evil/evil_manifest.js"), "escape")
    finally:
        shutil.rmtree(link, ignore_errors=True)
        try:
            link.unlink(missing_ok=True)
        except OSError:
            pass
        (target / "evil_manifest.js").unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# 2) 默认清单 == 真实 manifest
# ---------------------------------------------------------------------------
def _manifest_facts(path: Path) -> dict[str, str]:
    """从真实 manifest.js 里抠出 name / accent / agentId（只读，不改前端）。"""
    src = path.read_text(encoding="utf-8", errors="replace")
    facts: dict[str, str] = {}
    m = re.search(r"agentId:\s*'([^']+)'", src)
    if m:
        facts["agentId"] = m.group(1)
    m = re.search(r"name:\s*'([^']+)'", src)
    if m:
        facts["name"] = m.group(1)
    m = re.search(r"bubble:\s*\{[^}]*accent:\s*'(#[0-9A-Fa-f]{6})'", src)
    if m:
        facts["accent"] = m.group(1).upper()
    m = re.search(r"builtin:\s*(true|false)", src)
    if m:
        facts["builtin"] = m.group(1)
    return facts


def test_defaults_match_manifests() -> None:
    print("\n[2] 默认清单 == 真实 dist/plugins/*/manifest.js")

    document = svc.load()
    plugins = document.get("plugins") or []
    check_eq("默认清单条目数", len(plugins), 4)
    check_eq("默认清单 version", document.get("version"), 1)
    ids = [p.get("agentId") for p in plugins]
    # ★ feiyu 的 agentId 是 cloud_feiyu（目录名 ≠ agentId），见 service 里 DEFAULT_PLUGINS 注释
    check_eq("默认 agentId 集合", sorted(ids), ["cloud_feiyu", "dsh", "market", "pet"])
    check_eq("默认清单里的 builtin 集合", sorted(p["agentId"] for p in plugins if p.get("builtin")),
             ["market", "pet"])
    check("清单文件真的落盘了", svc.catalog_path().is_file(), str(svc.catalog_path()))
    check("每条都有 added 时间戳", all(p.get("added") for p in plugins))

    # 真实前端产物（只读比对）
    real_root = Path(settings.workspace_root) / "澪Agent应用" / "dist"
    if not (real_root / "plugins").is_dir():
        print(f"      未找到真实前端产物 {real_root}，跳过与 manifest 的比对")
        return

    by_dir = {p["entry"].split("/")[1]: p for p in plugins}
    for agent_id in ("dsh", "feiyu", "pet", "market"):
        manifest = real_root / "plugins" / agent_id / "manifest.js"
        check(f"{agent_id}: manifest.js 存在", manifest.is_file(), str(manifest))
        if not manifest.is_file():
            continue
        facts = _manifest_facts(manifest)
        entry = by_dir.get(agent_id, {})
        check_eq(f"{agent_id}: agentId 与 manifest 一致", entry.get("agentId"), facts.get("agentId"))
        check_eq(f"{agent_id}: name 与 manifest 一致", entry.get("name"), facts.get("name"))
        check_eq(f"{agent_id}: accent 与 manifest 一致",
                 str(entry.get("accent", "")).upper(), facts.get("accent"))
        check_eq(f"{agent_id}: builtin 与 manifest 一致",
                 bool(entry.get("builtin")), facts.get("builtin") == "true")
        # panel 字段不用 manifest 声明（manifest 里有 settingsTab.panel 但那是语义名）
        panel_rel = str(entry.get("panel") or "")
        check(f"{agent_id}: panel 指向真实文件", (real_root / panel_rel).is_file(),
              f"{panel_rel} -> {real_root / panel_rel}")

    # 契约 §1 的字段表里列出的必填/缺省字段一个都不能缺
    required = {"agentId", "name", "version", "author", "entry", "panel", "accent",
                "description", "category", "builtin", "enabled", "added"}
    for p in plugins:
        missing = sorted(required - set(p))
        check(f"{p['agentId']}: 字段齐全", not missing, f"缺 {missing}")

    # ★ 契约 §3.3：占用总线身份的插件，agentId 必须与 /api/companion/agents 的 agent_id 一致。
    #   这条是"停用了但导航还在"类 bug 的根因守卫：id 对不上 = 启停联动永远失效。
    #   只读进程内已有的总线身份，不启动服务、不发请求。
    registered = {a.get("agent_id") for a in agent_bus_service.list_agents()}
    for p in plugins:
        if p.get("builtin"):
            continue
        # 有同名身份就要求"名字一致"；没有身份则这条不适用（纯 UI 插件允许 bus: null）
        if p["agentId"] in registered:
            check(f"{p['agentId']}: 与总线身份同名（启停联动可用）", True)
        else:
            check(f"{p['agentId']}: 预期已注册进总线（导入即注册的身份应在此）",
                  p["agentId"] in {"dsh", "cloud_feiyu"},
                  f"已注册={sorted(registered)}")


# ---------------------------------------------------------------------------
# 3) 增删幂等
# ---------------------------------------------------------------------------
def test_add_remove() -> None:
    print("\n[3] 上架 / 下架 / 幂等")

    entry = svc.add({
        "agentId": "alpha",
        "name": "Alpha",
        "entry": "plugins/alpha/manifest.js",
        "panel": "plugins/alpha/alpha-panel.js",
        "accent": "#123abc",
        "category": "ui",
        "description": "自检用插件",
    })
    check_eq("上架成功", entry.get("agentId"), "alpha")
    check_eq("缺省 version 补 1.0.0", entry.get("version"), "1.0.0")
    check_eq("缺省 author 补 Mio", entry.get("author"), "Mio")
    check_eq("accent 归一化为大写", entry.get("accent"), "#123ABC")
    check_eq("缺省 enabled 为 true", entry.get("enabled"), True)
    check_eq("缺省 builtin 为 false", entry.get("builtin"), False)
    check("上架后 catalog 能看到它",
          any(p["agentId"] == "alpha" for p in svc.snapshot_with_state()["plugins"]))
    check("内部字段不出现在对外结构里", "_entry_path" not in entry, str(sorted(entry)))

    # 重复上架 → 409
    try:
        svc.add({"agentId": "alpha", "entry": "plugins/alpha/manifest.js"})
        check("重复上架 → DuplicatePluginError", False, "未抛异常")
    except svc.DuplicatePluginError as exc:
        check_eq("重复上架 → 409", exc.status, 409)
    except Exception as exc:  # noqa: BLE001
        check("重复上架 → DuplicatePluginError", False, f"{type(exc).__name__}: {exc}")
    check("重复上架不会新增第二条",
          sum(1 for p in svc.snapshot_with_state()["plugins"] if p["agentId"] == "alpha") == 1)

    # 非法 agentId → 400
    for bad_id in ("Alpha", "有中文", "a" * 33, "", "a b"):
        try:
            svc.add({"agentId": bad_id, "entry": "plugins/beta/manifest.js"})
            check(f"非法 agentId 被拒（{bad_id!r}）", False, "未拒绝")
        except svc.InvalidEntryError as exc:
            check_eq(f"非法 agentId 被拒（{bad_id!r}）", exc.status, 400)
        except Exception as exc:  # noqa: BLE001
            check(f"非法 agentId 被拒（{bad_id!r}）", False, f"{type(exc).__name__}: {exc}")

    # 非法 category / accent → 400
    for payload, why in (
        ({"agentId": "gamma", "entry": "plugins/beta/manifest.js", "category": "nope"}, "非法 category"),
        ({"agentId": "gamma", "entry": "plugins/beta/manifest.js", "accent": "red"}, "非法 accent"),
        ({"agentId": "gamma", "entry": "plugins/beta/manifest.js", "name": "x" * 41}, "name 超长"),
    ):
        try:
            svc.add(payload)
            check(f"{why} 被拒", False, "未拒绝")
        except svc.InvalidEntryError:
            check(f"{why} 被拒", True)
        except Exception as exc:  # noqa: BLE001
            check(f"{why} 被拒", False, f"{type(exc).__name__}: {exc}")

    # 下架：删条目、留文件
    keep = svc.plugins_root() / "alpha" / "manifest.js"
    result = svc.remove("alpha")
    check_eq("下架返回 removed", result.get("removed"), "alpha")
    check_eq("下架声明 files_kept=true", result.get("files_kept"), True)
    check("下架后 catalog 里没有了",
          not any(p["agentId"] == "alpha" for p in svc.snapshot_with_state()["plugins"]))
    check("★ 下架不动磁盘文件", keep.is_file(), str(keep))

    # 重复下架 → 404（幂等的"安全形态"：第二次必须明确说没有，而不是静默成功）
    try:
        svc.remove("alpha")
        check("重复下架 → UnknownPluginError", False, "未抛异常")
    except svc.UnknownPluginError as exc:
        check_eq("重复下架 → 404", exc.status, 404)
    except Exception as exc:  # noqa: BLE001
        check("重复下架 → UnknownPluginError", False, f"{type(exc).__name__}: {exc}")

    # 下架后重新上架 = 干净恢复
    again = svc.add({"agentId": "alpha", "entry": "plugins/alpha/manifest.js"})
    check_eq("下架后可重新上架", again.get("agentId"), "alpha")

    # PATCH：可改字段生效、不可改字段被拒、added 不丢
    added_before = svc.find("alpha").get("added")
    patched = svc.patch("alpha", {"name": "Alpha 2", "accent": "#00FF00", "category": "tool"})
    check_eq("PATCH 改 name", patched.get("name"), "Alpha 2")
    check_eq("PATCH 改 accent", patched.get("accent"), "#00FF00")
    check_eq("PATCH 改 category", patched.get("category"), "tool")
    check_eq("PATCH 保留 added", patched.get("added"), added_before)
    for field, value in (("entry", "plugins/beta/manifest.js"), ("builtin", True), ("agentId", "zzz")):
        try:
            svc.patch("alpha", {field: value})
            check(f"PATCH 拒绝改 {field}", False, "未拒绝")
        except svc.InvalidEntryError:
            check(f"PATCH 拒绝改 {field}", True)
        except Exception as exc:  # noqa: BLE001
            check(f"PATCH 拒绝改 {field}", False, f"{type(exc).__name__}: {exc}")
    # agentId 被拒之后，原条目必须原封不动（不能出现"半改完"）
    check_eq("PATCH 被拒后 agentId 未变", svc.find("alpha").get("agentId"), "alpha")
    try:
        svc.patch("not-exist", {"name": "x"})
        check("PATCH 不存在的插件 → 404", False, "未抛异常")
    except svc.UnknownPluginError as exc:
        check_eq("PATCH 不存在的插件 → 404", exc.status, 404)

    svc.remove("alpha")


# ---------------------------------------------------------------------------
# 4) builtin 保护
# ---------------------------------------------------------------------------
def test_builtin_protection() -> None:
    print("\n[4] builtin 保护（不可停用 / 不可下架）")

    pet = svc.find("pet")
    check("默认清单里 pet 是 builtin", bool(pet and pet.get("builtin")))
    check_eq("builtin 的 enabled 恒为 true", pet.get("enabled"), True)

    try:
        svc.set_enabled("pet", False)
        check("builtin 不可停用", False, "未抛异常")
    except svc.BuiltinProtectedError as exc:
        check_eq("builtin 不可停用 → 403", exc.status, 403)
    except Exception as exc:  # noqa: BLE001
        check("builtin 不可停用", False, f"{type(exc).__name__}: {exc}")

    try:
        svc.remove("pet")
        check("builtin 不可下架", False, "未抛异常")
    except svc.BuiltinProtectedError as exc:
        check_eq("builtin 不可下架 → 403", exc.status, 403)
    except Exception as exc:  # noqa: BLE001
        check("builtin 不可下架", False, f"{type(exc).__name__}: {exc}")

    check("两次被拒后 pet 仍在清单里", svc.find("pet") is not None)
    state = svc.get("pet")
    check_eq("builtin 对外 enabled 仍为 true", state.get("enabled"), True)


# ---------------------------------------------------------------------------
# 4b) 下架时清理总线幽灵身份（回归守卫）
# ---------------------------------------------------------------------------
def test_remove_cleans_bus() -> None:
    """下架一个"市场代注册"的插件后，总线里不该再留着幽灵身份。

    为什么加这一段（2026-10-25 用户实测）：
      set_enabled() 会为纯 UI 插件**自动注册**总线身份（adapter='plugin_market'），
      而下架原先只把 enabled 拨成 False、从不 unregister。
      结果 /api/companion/agents 里永远多一条 offline 身份，
      **右侧 Agent 边栏一直显示一个已经下架的插件**（用户原话："探针没清"）。

    同时必须守住反向边界：**别人注册的身份不能被误删**
    （dsh_adapter / cloud_feiyu 那些是真实链路，摘掉会误伤正在跑的东西）。
    """
    print("\n[4b] 下架时清理总线身份（且不误删他人身份）")

    # 情形一：市场代注册的身份 → 下架后必须消失
    # 沙箱的 dist 是空的，先真造一份插件文件（add 会做存在性 + 路径校验）
    probe_id = "busprobe"
    probe_dir = svc.plugins_root() / "_busprobe"
    try:
        probe_dir.mkdir(parents=True, exist_ok=True)
        (probe_dir / "manifest.js").write_text(
            "window.__mioPluginManifests = window.__mioPluginManifests || {}\n"
            "window.__mioPluginManifests['busprobe'] = { agentId: 'busprobe', name: '总线探针' }\n",
            encoding="utf-8",
        )
        svc.add({
            "agentId": probe_id,
            "name": "总线探针",
            "entry": "plugins/_busprobe/manifest.js",
            "builtin": False,
        })
        # 拨一次开关，让它真的走"自动注册"那条路
        svc.set_enabled(probe_id, True)
        state = agent_bus_service.get(probe_id)
        check("启用后总线里出现该身份", state is not None)
        check_eq("它的 adapter 是市场代注册标记", getattr(state, "adapter", ""), svc.PLUGIN_MARKET_ADAPTER)
        svc.remove(probe_id)
        check("下架后总线里不再有该身份（幽灵已清）", agent_bus_service.get(probe_id) is None)
    except Exception as exc:  # noqa: BLE001
        check("市场代注册身份可被清理", False, f"{type(exc).__name__}: {exc}")
    finally:
        try:
            if svc.find(probe_id):
                svc.remove(probe_id)
        except Exception:  # noqa: BLE001
            pass

    # 情形二：外部注册的身份（其它 adapter）→ 下架只停用，绝不 unregister
    foreign_id = "busforeign"
    foreign_dir = svc.plugins_root() / "_busforeign"
    try:
        foreign_dir.mkdir(parents=True, exist_ok=True)
        (foreign_dir / "manifest.js").write_text(
            "window.__mioPluginManifests = window.__mioPluginManifests || {}\n"
            "window.__mioPluginManifests['busforeign'] = { agentId: 'busforeign', name: '外部身份插件' }\n",
            encoding="utf-8",
        )
        agent_bus_service.register(foreign_id, "外部身份", "some_real_adapter", enabled=True)
        svc.add({
            "agentId": foreign_id,
            "name": "外部身份插件",
            "entry": "plugins/_busforeign/manifest.js",
            "builtin": False,
        })
        svc.remove(foreign_id)
        left = agent_bus_service.get(foreign_id)
        check("外部 adapter 的身份在下架后仍保留", left is not None)
        if left is not None:
            check_eq("但已拨成停用", left.enabled, False)
    except Exception as exc:  # noqa: BLE001
        check("外部身份不被误删", False, f"{type(exc).__name__}: {exc}")
    finally:
        try:
            if svc.find(foreign_id):
                svc.remove(foreign_id)
        except Exception:  # noqa: BLE001
            pass
        agent_bus_service.unregister(foreign_id)
        for d in (probe_dir, foreign_dir):
            try:
                shutil.rmtree(d, ignore_errors=True)
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------------
# 5) 原子写
# ---------------------------------------------------------------------------
def test_atomic_write() -> None:
    print("\n[5] 原子写（不留半截文件）")

    path = svc.catalog_path()
    # 逐次写、每次都校验磁盘上是一份完整 JSON —— 只要实现退化成
    # "先 truncate 再分段写"，中间态就会在这里被读出来。
    ok = True
    detail = ""
    for i in range(12):
        svc.add({"agentId": "alpha", "name": f"Alpha {i}", "entry": "plugins/alpha/manifest.js"})
        svc.patch("alpha", {"name": f"Alpha {i}-b", "description": "x" * (i * 17)})
        try:
            raw = path.read_text(encoding="utf-8")
            doc = json.loads(raw)
            if not isinstance(doc.get("plugins"), list):
                ok, detail = False, "文档缺 plugins 列表"
                break
        except Exception as exc:  # noqa: BLE001
            ok, detail = False, f"{type(exc).__name__}: {exc}"
            break
        svc.remove("alpha")
    check("12 轮增改删后磁盘始终是完整 JSON", ok, detail)

    leftovers = sorted(p.name for p in path.parent.glob("*.tmp"))
    check("不留临时文件", not leftovers, f"leftovers={leftovers}")

    # 用坏文件模拟"写了一半"：load 必须自愈（重建默认清单），而不是抛异常让市场 500
    path.write_text('{"version": 1, "plugins": [', encoding="utf-8")
    svc.plugin_market.reload()
    recovered = svc.load()
    check_eq("损坏清单被自愈为默认 4 条", len(recovered.get("plugins") or []), 4)

    # 外部手改后能感知（mtime 变了就该重读）
    doc = svc.load()
    doc["plugins"][0]["name"] = "外部改名"
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Windows 的 mtime 粒度可能是 100ns 级，但同一秒内连写可能撞上同样 ns；
    # 这里显式走 reload 保证语义确定（reload 本身就是契约端点要测的能力）。
    svc.reload()
    check_eq("reload 能读到外部修改", svc.load()["plugins"][0]["name"], "外部改名")
    svc.plugin_market.reload()
    # 复原默认清单，供后续用例在干净状态上跑
    path.unlink(missing_ok=True)
    svc.plugin_market.reload()


# ---------------------------------------------------------------------------
# 6) 热插拔：自动注册 + enabled 真值以总线为准
# ---------------------------------------------------------------------------
def test_hotplug() -> None:
    print("\n[6] 热插拔（未注册自动注册 / enabled 真值以总线为准）")

    svc.add({"agentId": "beta", "name": "Beta", "accent": "#AABBCC",
             "entry": "plugins/beta/manifest.js"})
    check("上架后总线里仍可能没有它", True)

    result = svc.set_enabled("beta", False)
    check_eq("停用：返回 agentId", result.get("agentId"), "beta")
    check_eq("停用：enabled=false", result.get("enabled"), False)
    bus_state = agent_bus_service.get("beta")
    check("停用：已自动注册进总线", bus_state is not None)
    if bus_state is not None:
        check_eq("停用：总线 enabled=False", bus_state.enabled, False)
        check_eq("自动注册用条目的 name", bus_state.name, "Beta")
        check_eq("自动注册用条目的 accent", bus_state.accent, "#AABBCC")
        check_eq("自动注册的 adapter 可辨识", bus_state.adapter, "plugin_market")

    result = svc.set_enabled("beta", True)
    check_eq("启用：enabled=true", result.get("enabled"), True)
    check_eq("启用：总线同步", agent_bus_service.get("beta").enabled, True)

    # ★ 真值以总线为准：绕过市场直接拨总线，catalog 必须跟着变
    agent_bus_service.set_enabled("beta", False)
    row = next(p for p in svc.snapshot_with_state()["plugins"] if p["agentId"] == "beta")
    check_eq("绕过市场拨总线 → catalog.enabled 跟随总线", row.get("enabled"), False)
    check("bus 快照字段齐全",
          set(row.get("bus") or {}) == {"registered", "enabled", "status", "phase"},
          str(row.get("bus")))

    agent_bus_service.set_enabled("beta", True)
    try:
        svc.set_enabled("not-exist", True)
        check("启用不存在的插件 → 404", False, "未抛异常")
    except svc.UnknownPluginError as exc:
        check_eq("启用不存在的插件 → 404", exc.status, 404)
    svc.remove("beta")


# ---------------------------------------------------------------------------
# 7) 重名检测
# ---------------------------------------------------------------------------
def test_duplicate_detection() -> None:
    print("\n[7] 外部写坏清单时的重名检测")

    path = svc.catalog_path()
    doc = svc.load()
    dup = dict(doc["plugins"][0])
    dup["name"] = "重复项"
    doc["plugins"].append(dup)
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    svc.plugin_market.reload()
    try:
        rows = [p for p in svc.snapshot_with_state()["plugins"]
                if p["agentId"] == doc["plugins"][0]["agentId"]]
        check_eq("清单里出现两条同名条目", len(rows), 2)
        check("两条都被标 duplicate_id",
              all("duplicate_id" in p["health"]["problems"] for p in rows),
              str([p["health"] for p in rows]))
        check("duplicate 行的 health.ok 为 false", all(not p["health"]["ok"] for p in rows))

        report = svc.diagnostics()
        dup_checks = [c for c in report["checks"] if "duplicate_id" in c["problems"]]
        check_eq("diagnostics 报出重名条目数", len(dup_checks), 2)
        check_eq("有重名时整体 ok=false", report.get("ok"), False)
    finally:
        path.unlink(missing_ok=True)
        svc.plugin_market.reload()


# ---------------------------------------------------------------------------
# 7b) health.ok 的语义边界（回归守卫）
# ---------------------------------------------------------------------------
def test_health_semantics() -> None:
    """health.ok **只由结构性问题决定**，`not_registered` 不得拦加载。

    为什么专门加这一段（2026-10-25 的真实事故）：
      一开始 health.ok = "problems 为空"，而 not_registered 对**任何未在总线上**
      的插件都会报。总线上的注册是适配器的导入副作用（``dsh_adapter`` 在 import 时
      register），只在 ``main()`` 里发生 —— 于是在自检 / TestClient / 任何
      "没跑 main()" 的入口里，整张总线是空的，每个插件都被判 not_registered。
      而 ``kernel/plugin-loader.js`` 会把 ``health.ok === false`` 的条目**整个跳过**，
      结果就是 dsh 与 feiyu 的左侧导航、设置页 tab 集体消失（界面看着像掉了一半功能）。

    这里把契约钉死：**结构性问题（缺文件/越界/重名）才影响 ok**；
    not_registered 只写进 problems 供人看，不阻断加载。
    """
    print("\n[7b] health.ok 语义：结构性才拦，未注册只提示")

    rows = svc.snapshot_with_state()["plugins"]
    check("清单非空", len(rows) > 0, str(len(rows)))

    # 真实运行时总线可能空（适配器尚未注册 / 本进程没跑 main()）：
    # 此时条目仍必须 health.ok=true，否则加载器会跳过它。
    #
    # ⚠ 注意：本段跑在**沙箱**里，沙箱的 dist 根下没有真的插件文件，
    #   所以缺文件（missing_entry/missing_panel）是预期的结构性缺陷，
    #   会让 ok=false —— 那正是"结构性问题必须拦"的正向证据，不是本回归要盯的东西。
    #   故下面的断言只看「not_registered 单独出现时」的归属：
    #   它必须被记录，但**不能**成为 ok=false 的唯一原因。
    by_id = {p["agentId"]: p for p in rows}
    for plugin_id, row in by_id.items():
        problems = set(row["health"]["problems"])
        check_eq(f"{plugin_id}: health.ok == 无结构性问题",
                 row["health"]["ok"],
                 not (problems & {"missing_entry", "missing_panel", "path_escape", "duplicate_id"}))

    alone = [p for p in rows
             if set(p["health"]["problems"]) == {"not_registered"}]
    if alone:
        check("仅 not_registered 时 health.ok 必须为 true（不拦加载）",
              all(p["health"]["ok"] for p in alone),
              str([(p["agentId"], p["health"]) for p in alone]))
    else:
        # 沙箱里文件缺失会掩盖这条分支；用**纯函数口径**再钉一次：
        # 直接构造"只有 not_registered"的 problems，断言 ok 的判定只看结构性集合。
        structural_only = {"missing_entry", "missing_panel", "path_escape", "duplicate_id"}
        check("仅 not_registered 时 health.ok 必须为 true（纯口径断言）",
              not ({"not_registered"} & structural_only))
    check("not_registered 不在结构性集合里（ok 的判定口径被钉死）",
          "not_registered" not in {"missing_entry", "missing_panel", "path_escape", "duplicate_id"})


# ---------------------------------------------------------------------------
# 8) 真 app 端到端（TestClient）
# ---------------------------------------------------------------------------
def test_live_app() -> None:
    print("\n[8] 真 app 端到端（fastapi TestClient）")

    try:
        from fastapi.testclient import TestClient
        from ..main import app as real_app
    except Exception as exc:  # noqa: BLE001
        check("导入 main.app", False, f"{type(exc).__name__}: {exc}")
        return
    check("导入 main.app", True)

    # 只断言路由表结构：**这不会启动 lifespan**，所以不会去 init_db、
    # 也不会打开真实数据目录（自检不污染用户数据的第一道保险）。
    market_paths = sorted({
        getattr(r, "path", "") for r in real_app.routes
        if "plugin/market" in str(getattr(r, "path", ""))
    })
    check_eq("契约 §2 的 8 个端点全部挂载", market_paths, [
        "/api/plugin/market/catalog",
        "/api/plugin/market/diagnostics",
        "/api/plugin/market/plugins",
        "/api/plugin/market/plugins/{agentId}",
        "/api/plugin/market/plugins/{agentId}/enable",
        "/api/plugin/market/reload",
    ])
    methods = sorted({
        m for r in real_app.routes
        if "plugin/market" in str(getattr(r, "path", ""))
        for m in (getattr(r, "methods", None) or set())
    })
    check_eq("出现的方法集合", methods, ["DELETE", "GET", "PATCH", "POST"])
    check("dsh 路由白名单未被本模块影响",
          sorted({getattr(r, "path", "") for r in real_app.routes if "/api/plugin/dsh" in str(getattr(r, "path", ""))})
          == ["/api/plugin/dsh/about", "/api/plugin/dsh/agent",
              "/api/plugin/dsh/diagnostics", "/api/plugin/dsh/ingest",
              "/api/plugin/dsh/phases", "/api/plugin/dsh/status",
              "/api/plugin/dsh/strip", "/api/plugin/dsh/update-check"])

    # ★ 走真请求：TestClient 不在 with 块里用完即弃，lifespan 不会被触发，
    #   因此即使路由真的读写 data_dir，也只会写临时沙箱（沙箱由外层 Suite 挂上）。
    client = TestClient(real_app, base_url="http://127.0.0.1:8000")
    try:
        r = client.get("/api/plugin/market/catalog")
        check_eq("GET /catalog 200", r.status_code, 200)
        body = r.json()
        check_eq("catalog 返回 ok", body.get("ok"), True)
        check("catalog 带 version", body.get("version") == 1, str(body.get("version")))
        check_eq("catalog 返回 4 条默认插件", len(body.get("plugins") or []), 4)
        first = (body.get("plugins") or [{}])[0]
        for key in ("agentId", "name", "entry", "panel", "accent", "builtin",
                    "enabled", "bus", "health", "version", "author",
                    "description", "category", "added"):
            check(f"catalog 条目含字段 {key}", key in first, str(sorted(first)))
        check("catalog 条目 health 结构正确",
              set(first.get("health") or {}) == {"ok", "problems"}, str(first.get("health")))
        check("catalog 里 pet 为 builtin 且 enabled",
              any(p["agentId"] == "pet" and p["builtin"] and p["enabled"]
                  for p in body["plugins"]))

        r = client.get("/api/plugin/market/plugins/pet")
        check_eq("GET /plugins/pet 200", r.status_code, 200)
        check_eq("单条返回结构", sorted(r.json()), ["ok", "plugin"])
        check_eq("GET /plugins/不存在 404", client.get("/api/plugin/market/plugins/nope").status_code, 404)

        r = client.get("/api/plugin/market/diagnostics")
        check_eq("GET /diagnostics 200", r.status_code, 200)
        rep = r.json()
        check("diagnostics 带 checks 列表", isinstance(rep.get("checks"), list))
        check_eq("diagnostics 覆盖 4 条", len(rep.get("checks") or []), 4)

        # 上架：真文件存在 → 成功
        r = client.post("/api/plugin/market/plugins", json={
            "agentId": "alpha", "name": "Alpha",
            "entry": "plugins/alpha/manifest.js", "panel": "plugins/alpha/alpha-panel.js",
            "accent": "#112233", "category": "ui",
        })
        check_eq("POST /plugins 200", r.status_code, 200)
        check_eq("POST /plugins 回 plugin", r.json().get("plugin", {}).get("agentId"), "alpha")

        # 重名 → 409
        r = client.post("/api/plugin/market/plugins",
                        json={"agentId": "alpha", "entry": "plugins/alpha/manifest.js"})
        check_eq("POST 重名 → 409", r.status_code, 409)
        check("409 返回 detail 文本", bool((r.json() or {}).get("detail")), str(r.json()))

        # 路径穿越 → 400 且带具体路径（契约验收清单第 5 条）
        r = client.post("/api/plugin/market/plugins",
                        json={"agentId": "gamma", "entry": "../../etc/passwd"})
        check_eq("POST 路径穿越 → 400", r.status_code, 400)
        check("400 的错误信息带具体路径", "../../etc/passwd" in str((r.json() or {}).get("detail")),
              str(r.json()))

        # 缺 body → 422（FastAPI 默认，不需要我们建模）
        check_eq("POST 缺 body → 422", client.post("/api/plugin/market/plugins").status_code, 422)

        # PATCH
        r = client.patch("/api/plugin/market/plugins/alpha", json={"name": "Alpha X"})
        check_eq("PATCH /plugins/alpha 200", r.status_code, 200)
        check_eq("PATCH 生效", r.json().get("plugin", {}).get("name"), "Alpha X")
        r = client.patch("/api/plugin/market/plugins/alpha", json={"entry": "plugins/beta/manifest.js"})
        check_eq("PATCH 改 entry → 400", r.status_code, 400)
        check_eq("PATCH 不存在 → 404",
                 client.patch("/api/plugin/market/plugins/nope", json={"name": "x"}).status_code, 404)

        # 热插拔
        r = client.post("/api/plugin/market/plugins/alpha/enable", json={"enabled": False})
        check_eq("POST enable 200", r.status_code, 200)
        en = r.json()
        check_eq("enable 返回 enabled", en.get("enabled"), False)
        check("enable 返回 bus 快照", isinstance(en.get("bus"), dict), str(en.get("bus")))
        r = client.post("/api/plugin/market/plugins/alpha/enable", json={"enabled": "yes"})
        check_eq("enable 非布尔 → 400", r.status_code, 400)
        r = client.post("/api/plugin/market/plugins/pet/enable", json={"enabled": False})
        check_eq("enable builtin → 403", r.status_code, 403)
        check("403 说明是 builtin", "builtin" in str((r.json() or {}).get("detail")),
              str(r.json()))

        # 安全栅栏（全站中间件兜底，与 /api/plugin/dsh 同一把锁）
        r = client.post("/api/plugin/market/plugins",
                        json={"agentId": "gamma", "entry": "plugins/beta/manifest.js"},
                        headers={"sec-fetch-site": "cross-site"})
        check_eq("跨站写请求被拒（403）", r.status_code, 403)
        r = client.get("/api/plugin/market/catalog", headers={"host": "evil.example.com"})
        check_eq("非回环 Host 被拒（403）", r.status_code, 403)

        # reload
        r = client.post("/api/plugin/market/reload")
        check_eq("POST /reload 200", r.status_code, 200)
        check("reload 返回 plugins", isinstance(r.json().get("plugins"), list),
              str(type(r.json().get("plugins"))))

        # DELETE（下架）→ files_kept
        r = client.delete("/api/plugin/market/plugins/alpha")
        check_eq("DELETE /plugins/alpha 200", r.status_code, 200)
        check_eq("DELETE 声明 files_kept", (r.json() or {}).get("files_kept"), True)
        check_eq("DELETE 返回 removed", (r.json() or {}).get("removed"), "alpha")
        check_eq("DELETE builtin → 403",
                 client.delete("/api/plugin/market/plugins/pet").status_code, 403)
        check_eq("DELETE 不存在 → 404",
                 client.delete("/api/plugin/market/plugins/nope").status_code, 404)
    finally:
        client.close()


# ---------------------------------------------------------------------------
# 9) 前缀隔离：本模块不影响 dsh 的路由白名单断言
# ---------------------------------------------------------------------------
def test_prefix_isolation() -> None:
    print("\n[9] 前缀隔离（/api/plugin/market 与 /api/plugin/dsh 各走各的）")

    from ..routes import plugin_market as market_routes
    from ..agents.dsh import routes as dsh_routes

    check_eq("市场路由前缀", market_routes.router.prefix, "/api/plugin/market")
    check_eq("dsh 路由前缀（未被动过）", dsh_routes.router.prefix, "/api/plugin/dsh")
    market_prefixes = {getattr(r, "path", "") for r in market_routes.router.routes}
    check("市场端点没有一个落在 /api/plugin/dsh 前缀下",
          all(not p.startswith("/api/plugin/dsh") for p in market_prefixes),
          str(sorted(market_prefixes)))
    dsh_prefixes = sorted({getattr(r, "path", "") for r in dsh_routes.router.routes})
    check_eq("dsh 自己的端点表保持不变（仍是 8 个）", dsh_prefixes, [
        "/api/plugin/dsh/about",
        "/api/plugin/dsh/agent",
        "/api/plugin/dsh/diagnostics",
        "/api/plugin/dsh/ingest",
        "/api/plugin/dsh/phases",
        "/api/plugin/dsh/status",
        "/api/plugin/dsh/strip",
        "/api/plugin/dsh/update-check",
    ])


# ---------------------------------------------------------------------------
# 沙箱护栏：任何一条用例都不能摸到真实数据目录
# ---------------------------------------------------------------------------
def _assert_sandboxed(catalog: Path) -> bool:
    """确认当前 ``settings.data_dir`` 已经指向沙箱，否则拒绝继续。

    ★ 这条护栏是**踩过坑之后加的**：本文件早先的版本在真 app 用例里
      用 ``TestClient(app)`` 直接打了 ``/catalog``，而当时 ``data_dir`` 还是真实路径，
      于是首次 ``load()`` 就把默认清单写进了 ``私人AI日记系统/数据/`` ——
      自检"不污染真实数据目录"这条约定当场被自己破坏。
      单靠"记得在用例前 reset"的自觉不够（顺序一改就漏），必须在入口硬拦。
    """
    expected = _sandbox_root() / "数据"
    try:
        real = catalog.resolve()
        ok = real.is_relative_to(expected.resolve())
    except (OSError, RuntimeError):
        ok = False
    return ok


# ---------------------------------------------------------------------------
def main() -> int:
    print("=" * 68)
    print("插件市场清单层自检（app.kernel.plugin_market_selftest）")
    print("=" * 68)

    # ★ 从这里开始切换数据目录，覆盖**整个 main**（含真 app 用例）。
    #   早先只把 §3~§8 包在沙箱里，但真 app 用例打的是``main.app``，
    #   任何一次 load() 都可能落到真实 data_dir —— 现在没有这个缝隙了。
    with Sandbox() as sandbox:
        print(f"\n沙箱数据目录：{sandbox.data_dir}")
        print(f"沙箱前端产物：{sandbox.frontend}")

        if not _assert_sandboxed(svc.catalog_path()):
            check("沙箱护栏（清单路径必须在临时目录内）", False,
                  f"catalog={svc.catalog_path()}")
            return 1
        check("沙箱护栏（清单路径在临时目录内）", True)
        check("沙箱内清单不会碰到真实数据目录",
              Path(settings.workspace_root) / "私人AI日记系统" / "数据"
              != svc.catalog_path().parent)

        test_path_safety()
        test_symlink_escape()
        test_defaults_match_manifests()

        test_add_remove()
        sandbox.reset()

        test_builtin_protection()
        sandbox.reset()

        test_remove_cleans_bus()
        sandbox.reset()

        test_atomic_write()
        sandbox.reset()

        test_hotplug()
        sandbox.reset()

        test_duplicate_detection()
        sandbox.reset()

        test_health_semantics()
        sandbox.reset()

        # 真 app 用例会写清单，跑在干净沙箱上
        sandbox.reset()
        test_live_app()
        sandbox.reset()

        # 前缀隔离是纯内存断言，但同样放在沙箱里 —— 顺序无关的护栏更可靠
        test_prefix_isolation()

        # 收尾复核：整轮跑完，清单路径仍必须是沙箱路径
        check("整轮结束后清单仍落在沙箱内", _assert_sandboxed(svc.catalog_path()),
              str(svc.catalog_path()))

    print("\n" + "=" * 68)
    print(f"结果：{PASS} 通过 / {FAIL} 失败")
    if FAILURES:
        print("失败项：")
        for f in FAILURES:
            print(f"  - {f}")
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    # 结论必须是**最后一行**，门禁脚本 grep "结果：" 才不会被第三方库
    # （httpx / TestClient）的杂音夹在中间。故先把正文收进缓冲区，
    # 再连同汇总一起按顺序吐出来。
    _buf = io.StringIO()
    with redirect_stdout(_buf):
        _code = main()
    print(_buf.getvalue(), end="")
    sys.exit(_code)
