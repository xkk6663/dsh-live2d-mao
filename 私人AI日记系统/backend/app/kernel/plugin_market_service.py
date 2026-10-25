"""插件市场清单层：让 `dist/plugins/` 下的插件目录成为**可枚举、可热插拔的数据**。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
它到底解决什么问题
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
在此之前，插件是**写死在 ``dist/index.html`` 里的 ``<script>`` 标签**：

  · 装了才有、卸了还在 —— 增删一个插件要手改 index.html；
  · 改了要重启 —— 版本号（``?v=``）也是硬编码在标签里；
  · 两个窗口（管理窗 / 桌宠窗口）各建一套清单，迟早对不上。

本模块引入它们中间的「清单层」（落盘 ``settings.data_dir/插件市场.json``）::

    内核不懂任何具体插件，只读清单，按清单里的 entry 去加载。

  kernel/plugin-loader.js（管理窗）   ─┐
                                       ├─ GET /api/plugin/market/catalog ─→ 本模块
  live2d-pet/plugin-bus.js（桌宠窗）  ─┘

契约出处：``docs/插件市场-契约.md``（冻结版 v1）。**本文只实现后端那一半**，
前端加载协议、事件名都不归本模块管，也不在这里复述第二份。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
三条边界（为什么不把逻辑写得"更聪明"）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. **不认识具体插件**：默认清单只在"首次启动"时生成一次，之后一切以磁盘上的
   JSON 为准。本文件里出现的 ``dsh`` / ``feiyu`` / ``pet`` 是**出厂默认值**，
   不是 if-else 分支 —— 删掉任何一个都不会让代码走另一条路。
2. **不动磁盘文件**：下架（remove）只删清单条目，**绝不删 ``dist/plugins/`` 里的文件**。
   插件是前端产物，归前端仓库管；后端删了会变成"改一次市场就丢一次插件"。
3. **启用态不自己造真值**：占用总线身份的插件，``enabled`` 真值以
   ``agent_bus_service`` 为准（契约 §3.3）。清单里的 ``enabled`` 只是"期望态"，
   给没占总线身份的纯 UI 插件用。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
路径安全（★ 硬约束，别改成字符串 startswith）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
``entry`` / ``panel`` 是**相对 ``dist/`` 的路径**，且 resolve 之后必须仍在
``dist/plugins/`` 之内。判据一律用 ``Path.resolve()``（= realpath）后
``is_relative_to``，**不用** ``str.startswith``：

  · ``"plugins/../plugins/x"`` 这类字符串看着像没越界，startswith 会放行；
  · Windows 上 ``dist/plugins/dsh`` 与 ``dist/plugins/dsh2`` 是**兄弟目录**，
    startswith 会把后者误判成在前者之内；
  · 软链接（``dist/plugins/evil -> C:\\Windows``）只有 resolve 才追得出来。

字符串前缀在这些场景上全部失效，而它们恰恰是越界攻击的常用形态。
"""
from __future__ import annotations

import json
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from ..config import settings
from . import agent_bus_service

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
# 清单文件名（契约 §1 冻结）。放 data_dir 而不是 backend 目录：
# 它是**运行时用户数据**，升级/重装程序不该把它带走。
CATALOG_FILENAME = "插件市场.json"
CATALOG_VERSION = 1

# agentId 规则来自契约 §1（必须等于 /api/companion/agents 的 agent_id）
AGENT_ID_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
# 身份色：只接受 6 位十六进制，前端会直接塞进 CSS，宽松解析等于给注入开口子
ACCENT_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
CATEGORIES = ("agent", "ui", "pet", "tool", "other")

# 市场**代注册**总线身份时使用的 adapter 名。
# 它是"这个身份归谁"的判据：下架/清理时，只有 adapter == 本值的身份才允许 unregister，
# 其它被真适配器（dsh_adapter / cloud_feiyu …）注册的身份一律保留。
# 提成常量而不是散落字面量：register 与 remove 两处必须用同一个值，写岔了就会
# "下架时不清理"或"误删别人的身份"。
PLUGIN_MARKET_ADAPTER = "plugin_market"

# health.problems 的取值集合（契约 §2.1 逐个列死，前端按它渲染角标）
PROBLEM_MISSING_ENTRY = "missing_entry"
PROBLEM_MISSING_PANEL = "missing_panel"
PROBLEM_PATH_ESCAPE = "path_escape"
PROBLEM_DUPLICATE_ID = "duplicate_id"
PROBLEM_NOT_REGISTERED = "not_registered"

# 「出厂即装的 3 个插件」。字段必须与 dist/plugins/*/manifest.js 里声明的**逐个对齐**：
#   agentId ← manifest 的 agentId
#   name    ← manifest 的 name
#   entry   ← 目录名下的 manifest.js
#   panel   ← 目录名下的 *-panel.js（三个目录都有）
#   accent  ← manifest 的 bubble.accent
#   category/builtin ← 本契约 §1 的分类与宿主标记
#
# ★ 目录名 ≠ agentId，两者都必须各自与 manifest 对齐：
#   · feiyu 的目录是 plugins/feiyu/，但 manifest 声明的 agentId 是 **cloud_feiyu**
#     （见 dist/plugins/feiyu/manifest.js 顶部注释：必须与后端 /api/companion/agents
#      的 agent_id 完全一致，写错会导致启停联动永远对不上）；
#   · pet / dsh 的目录名与 agentId 恰好相同，容易让人误以为"目录名就是 id"。
#   所以 entry/panel 用**目录**拼路径，agentId 取 manifest 的值——两者分开写。
DEFAULT_PLUGINS: tuple[dict[str, Any], ...] = (
    {
        "agentId": "dsh",
        "name": "DSH",
        "entry": "plugins/dsh/manifest.js",
        "panel": "plugins/dsh/dsh-panel.js",
        "accent": "#4F6BED",
        "description": "DSH 实时工作状态页 + 12 态图例 + 体检条目",
        "category": "agent",
        "builtin": False,
    },
    {
        "agentId": "cloud_feiyu",
        "name": "大肥鱼",
        "entry": "plugins/feiyu/manifest.js",
        "panel": "plugins/feiyu/feiyu-panel.js",
        "accent": "#E08A9B",
        "description": "大肥鱼屏幕观察 / 语音 / 设置 tab",
        "category": "agent",
        "builtin": False,
    },
    {
        "agentId": "pet",
        "name": "桌宠",
        "entry": "plugins/pet/manifest.js",
        "panel": "plugins/pet/pet-panel.js",
        "accent": "#4C8798",
        "description": "桌宠本体：形象 / 外观 / 行为 / 横条 / 泡泡",
        "category": "pet",
        "builtin": True,
    },
    # ★ 市场本身也必须在默认清单里，而且必须是 builtin。
    #
    #   为什么不能靠"用户自己上架一次"：市场是**所有插件的管理入口**，
    #   干净环境下如果市场条目要等下一个人手动 POST 才出现，那用户第一次装完
    #   打开界面根本没有"插件市场"这个 tab —— 他会以为功能没做。
    #   一个自我引导的插件市场，它的存在不能依赖它自己。
    #
    #   为什么 builtin=true（而不是普通可停用插件）：
    #   这不是偷懒的保护主义，而是**防止把自己锁在门外**。
    #   若 market 可停用/可下架，用户点一下"停用"→ loader 立刻卸载它的 manifest 与面板
    #   → 市场上所有插件的管理入口全部消失 → 而"重新启用"这个动作恰好也只在市场里
    #   → 除非手改 data/插件市场.json 或重装，否则**永远回不来**。
    #   这跟 AGENTS.md / SKILL 里对 pet 的裁决是同一条原则：
    #   "停用它等于把宿主拆了"的插件，一律 builtin。
    #
    #   注意 builtin 只影响"启停与下架"，不影响它作为插件参与市场列表：
    #   它照样出现在卡片网格里，只是启停/下架按钮是灰的。
    {
        "agentId": "market",
        "name": "插件市场",
        "entry": "plugins/market/manifest.js",
        "panel": "plugins/market/market-panel.js",
        "accent": "#8B5CF6",
        "description": "插件市场：查看 / 启停 / 上架 / 下架全部插件（内置管理入口）",
        "category": "ui",
        "builtin": True,
    },
)


# ---------------------------------------------------------------------------
# 异常：用"类型"表达 HTTP 语义，路由层只做搬运，不重新判断
# ---------------------------------------------------------------------------
class PluginMarketError(ValueError):
    """清单操作的基类异常。``status`` 是建议的 HTTP 状态码，路由直接采用。"""

    status = 400


class InvalidEntryError(PluginMarketError):
    """字段校验失败 / 文件不存在 / 路径越界（→ 400）。"""

    status = 400


class DuplicatePluginError(PluginMarketError):
    """agentId 已经在清单里（→ 409）。"""

    status = 409


class UnknownPluginError(PluginMarketError):
    """agentId 不在清单里（→ 404）。"""

    status = 404


class BuiltinProtectedError(PluginMarketError):
    """试图停用/下架 builtin 插件（→ 403）。"""

    status = 403


# ---------------------------------------------------------------------------
# 路径与时间小工具
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    """本地时区的 ISO8601（带偏移），与仓库里其它时间戳口径一致。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def frontend_root() -> Path:
    """前端产物根（``澪Agent应用/dist``）。

    每次都从 ``settings.agent_frontend_dir`` 现取，**不缓存成模块常量**：
    自检脚本要能把这里临时指到别处跑，缓存会把自检变成"只测了真实目录"。
    """
    return Path(settings.agent_frontend_dir).resolve()


def plugins_root() -> Path:
    """插件的唯一合法落点：``dist/plugins``（同样不缓存，理由同上）。"""
    return (frontend_root() / "plugins").resolve()


def catalog_path() -> Path:
    """清单文件绝对路径（``settings.data_dir/插件市场.json``）。"""
    return Path(settings.data_dir) / CATALOG_FILENAME


def resolve_plugin_file(rel_path: str, *, field: str) -> Path:
    """把清单里的相对路径解析成**已通过边界校验**的绝对路径。

    校验顺序是刻意的，每条都对应一类真实攻击/事故：

    1. 非空字符串 —— 空串会让 ``dist / ""`` 变成 ``dist`` 自己；
    2. 拒绝 ``http://`` / ``//`` / 绝对路径 —— 否则前端插进去的是**外部脚本**，
       等于把整个管理窗交给第三方域名；
    3. 拒绝含 ``..`` 的段 —— 提前给出人话错误（真正的兜底是第 5 步的 realpath）；
    4. 拒绝盘符/UNC 形态（Windows 上 ``C:x`` 一类"相对盘符"不会被 ``is_absolute`` 抓到）；
    5. **realpath 后必须仍在 ``dist/plugins`` 之内** —— 字符串前缀在这里被彻底淘汰，
       软链接逃逸（``plugins/evil -> C:\\Windows``）也只有这一步能挡住；
    6. 必须是已存在的**文件**（目录不算，否则前端拿到的是 404 页面而不是脚本）。

    失败一律抛 :class:`InvalidEntryError`，消息里带**具体路径**——
    契约要求"前端直接回显"，所以这里写的是给用户看的话，不是给日志看的。
    """
    raw = str(rel_path or "").strip()
    if not raw:
        raise InvalidEntryError(f"{field} 不能为空")
    lowered = raw.lower()
    if lowered.startswith(("http://", "https://", "//", "file:")):
        raise InvalidEntryError(f"{field} 必须是相对 dist/ 的本地路径，不接受 URL：{raw}")
    if "\\" in raw:
        # 统一用 / 写，避免前端拼 URL 时出现 %5C；也避免 Windows 路径分隔符绕过 .. 检测
        raise InvalidEntryError(f"{field} 请使用 / 分隔的路径：{raw}")
    parts = [p for p in raw.split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        raise InvalidEntryError(f"{field} 路径越界（不允许 ..）：{raw}")
    if re.match(r"^[a-zA-Z]:", raw):
        raise InvalidEntryError(f"{field} 必须是相对路径，不接受盘符：{raw}")

    root = frontend_root()
    plugin_root = plugins_root()
    # 先拼再 resolve：resolve 会跟随每一级软链接，这才是真实的落点
    target = (root / raw).resolve()
    if not target.is_relative_to(plugin_root):
        raise InvalidEntryError(
            f"{field} 路径越界：{raw} 解析到 {target}，超出允许目录 {plugin_root}"
        )
    if not target.is_file():
        # 回显**传入的相对路径**而不是拼出来的绝对路径：契约要求"前端直接回显它"，
        # 绝对路径对用户没意义，还会把本机目录结构泄漏进浏览器。
        raise InvalidEntryError(f"{field} 指向的文件不存在：{raw}")
    return target


def _safety_of(rel_path: str) -> str:
    """只做**只读**的越界判定，用于 health/diagnostics（缺失文件不算越界）。

    返回 ``"ok"`` / ``"escape"`` / ``"missing"``。
    与 :func:`resolve_plugin_file` 分开是因为诊断需要区分"文件没了"和
    "路径跑到 plugins 外了"——前者是装错了，后者是清单被改了，处置完全不同。
    """
    raw = str(rel_path or "").strip()
    if not raw or lowered_is_remote(raw):
        return "escape"
    parts = [p for p in raw.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or ".." in parts or re.match(r"^[a-zA-Z]:", raw):
        return "escape"
    try:
        target = (frontend_root() / raw).resolve()
    except (OSError, RuntimeError):
        return "escape"
    if not target.is_relative_to(plugins_root()):
        return "escape"
    return "ok" if target.is_file() else "missing"


def lowered_is_remote(raw: str) -> bool:
    return raw.lower().startswith(("http://", "https://", "//", "file:"))


# ---------------------------------------------------------------------------
# 字段归一化（单一实现，add 与 patch 共用，避免两处口径漂移）
# ---------------------------------------------------------------------------
def normalize_field_names(payload: dict[str, Any]) -> dict[str, Any]:
    """把 ``agent_id`` / ``agentID`` 之类的别名统一成契约里的 ``agentId``。

    前端 Vue 侧习惯下划线，契约侧是驼峰；两边都不改的话，
    用户填了 ``agent_id`` 会得到一条"缺字段"的报错，而他明明填了。
    """
    aliases = {"agent_id": "agentId", "agentID": "agentId", "id": "agentId"}
    out = dict(payload)
    for src, dst in aliases.items():
        if src in out and dst not in out:
            out[dst] = out.pop(src)
    return out


def _clean_id(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise InvalidEntryError("agentId 不能为空")
    if not AGENT_ID_RE.match(raw):
        raise InvalidEntryError(
            f"agentId 不合法：{raw!r}（只允许小写字母、数字、下划线、短横线，1-32 位）"
        )
    return raw


def _clean_text(value: Any, *, field: str, limit: int, default: str = "") -> str:
    text = str(value if value is not None else "").strip() or default
    if len(text) > limit:
        raise InvalidEntryError(f"{field} 超过 {limit} 字上限")
    return text


def _clean_accent(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if not ACCENT_RE.match(raw):
        raise InvalidEntryError(f"accent 必须是 #RRGGBB 形式：{raw!r}")
    return raw.upper()


def _clean_category(value: Any) -> str:
    raw = str(value or "").strip().lower() or "other"
    if raw not in CATEGORIES:
        raise InvalidEntryError(f"category 只能是 {'/'.join(CATEGORIES)} 之一：{raw!r}")
    return raw


def build_entry(payload: dict[str, Any], *, existing: dict[str, Any] | None = None) -> dict[str, Any]:
    """把一份（可能不完整的）声明归一化成契约 §1 的完整条目。

    ``existing`` 非空时按"打补丁"处理：未提供的字段沿用旧值。
    这样 PATCH 可以只带 ``{"accent": "#FFFFFF"}``，且不会把 ``added`` 冲掉。
    """
    data = normalize_field_names(payload)
    base: dict[str, Any] = dict(existing or {})

    agent_id = _clean_id(data.get("agentId", base.get("agentId", "")))
    name = _clean_text(
        data.get("name", base.get("name")), field="name", limit=40,
        default=agent_id,
    )

    entry_rel = str(data.get("entry", base.get("entry", "")) or "").strip()
    if not entry_rel:
        raise InvalidEntryError("entry 不能为空（manifest 脚本相对 dist/ 的路径）")
    # panel 允许缺省（"缺省不加载"），但给了就必须真的存在
    panel_rel = str(data.get("panel", base.get("panel", "")) or "").strip()

    entry_path = resolve_plugin_file(entry_rel, field="entry")
    if panel_rel:
        resolve_plugin_file(panel_rel, field="panel")

    version = _clean_text(data.get("version", base.get("version")), field="version",
                          limit=32, default="1.0.0")
    author = _clean_text(data.get("author", base.get("author")), field="author",
                         limit=40, default="Mio")
    description = _clean_text(data.get("description", base.get("description")),
                              field="description", limit=200)
    accent = _clean_accent(data.get("accent", base.get("accent", "")))
    category = _clean_category(data.get("category", base.get("category", "other")))

    # builtin 只在**新建**时可由调用方声明；PATCH 不许改（契约 §2：不可改 builtin）
    if existing is None:
        builtin = bool(data.get("builtin", False))
    else:
        builtin = bool(base.get("builtin", False))

    enabled = data.get("enabled", base.get("enabled", True))
    enabled = True if enabled is None else bool(enabled)
    if builtin:
        # builtin 恒可见（契约 §3.3）：清单里也钉死 true，免得前端读到 false 又把它藏了
        enabled = True

    entry = {
        "agentId": agent_id,
        "name": name,
        "version": version,
        "author": author,
        "entry": entry_rel,
        "panel": panel_rel,
        "accent": accent,
        "description": description,
        "category": category,
        "builtin": builtin,
        "enabled": enabled,
        "added": str(base.get("added") or _now_iso()),
    }
    # 记录解析结果供调用方（add）使用，不必二次解析
    entry["_entry_path"] = str(entry_path)
    return entry


# ---------------------------------------------------------------------------
# 清单本体
# ---------------------------------------------------------------------------
class PluginMarket:
    """插件清单的读写与热插拔。整个进程共用一个实例（见底部 ``plugin_market``）。

    为什么用 ``threading.RLock`` 而不是 asyncio 锁：
    路由层都是 ``def``（同步函数，跑在线程池里），且热插拔会回调**同步**的总线 API。
    用 asyncio 锁只会让锁和真实并发边界错位；这里要防的是"两个请求同时写同一个 JSON"。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._cache: dict[str, Any] | None = None
        # 缓存失效判据：文件 mtime_ns + size。外部手改 JSON 时能自动重载，
        # 又不需要每个请求都真的读盘（catalog 是前端启动路径上的热点）。
        self._cache_stamp: tuple[int, int, int] | None = None

    # ---------------- 磁盘读写 ----------------
    def _stamp(self) -> tuple[int, int, int] | None:
        path = catalog_path()
        try:
            st = path.stat()
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_size, id(path))

    def _default_document(self) -> dict[str, Any]:
        now = _now_iso()
        plugins: list[dict[str, Any]] = []
        for spec in DEFAULT_PLUGINS:
            entry = dict(spec)
            entry.setdefault("version", "1.0.0")
            entry.setdefault("author", "Mio")
            entry.setdefault("enabled", True)
            entry["added"] = now
            plugins.append(entry)
        return {"version": CATALOG_VERSION, "updated": now, "plugins": plugins}

    def load(self) -> dict[str, Any]:
        """读清单。文件不存在 / 损坏时自动落一份默认清单并返回。

        "损坏时自动重建"是刻意的：清单是**派生数据**（权威声明在
        ``dist/plugins/*/manifest.js``），为了一个坏 JSON 让整个市场面板 500，
        用户除了手删文件没有别的自救路径。重建至少让界面还能打开。
        """
        with self._lock:
            stamp = self._stamp()
            if self._cache is not None and stamp is not None and stamp == self._cache_stamp:
                return self._cache

            path = catalog_path()
            document: dict[str, Any] | None = None
            if path.exists():
                try:
                    raw = json.loads(path.read_text(encoding="utf-8-sig"))
                    document = _coerce_document(raw)
                except (OSError, ValueError, json.JSONDecodeError):
                    document = None

            if document is None:
                document = self._default_document()
                self._write(document)
            else:
                self._cache = document
                self._cache_stamp = self._stamp()
            return document

    def _write(self, document: dict[str, Any]) -> None:
        """原子写：先写同目录临时文件再 ``replace``。

        照抄 ``agent_bus_service._persist_enabled`` 的做法，理由也一样：
        直接 ``write_text`` 期间如果断电/被杀，留下的是**半截 JSON**，
        下次启动读不出来就等于整份清单（用户装过的所有插件）全丢。
        ``os.replace`` 在同一分区上是原子的：读者要么看到旧全文，要么看到新全文。

        写失败不吞异常（与总线的配置写入不同）：市场端点的语义就是"改清单"，
        写不进去必须让用户知道，否则界面显示成功、重启后全没了。
        """
        path = catalog_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        document["version"] = CATALOG_VERSION
        tmp = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
        body = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        try:
            tmp.write_text(body, encoding="utf-8", newline="\n")
            tmp.replace(path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
        self._cache = document
        self._cache_stamp = self._stamp()

    def reload(self) -> dict[str, Any]:
        """丢掉内存缓存，强制重新读盘（外部手改过 JSON 时用）。"""
        with self._lock:
            self._cache = None
            self._cache_stamp = None
            return self.load()

    # ---------------- 查询 ----------------
    def _plugins(self, document: dict[str, Any]) -> list[dict[str, Any]]:
        plugins = document.get("plugins")
        return plugins if isinstance(plugins, list) else []

    @staticmethod
    def _public(entry: dict[str, Any]) -> dict[str, Any]:
        """对外输出前剥掉内部字段（``_entry_path`` 等下划线前缀的解析缓存）。"""
        return {k: v for k, v in entry.items() if not str(k).startswith("_")}

    def find(self, agent_id: str) -> dict[str, Any] | None:
        with self._lock:
            document = self.load()
            for entry in self._plugins(document):
                if entry.get("agentId") == agent_id:
                    return entry
        return None

    def get(self, agent_id: str) -> dict[str, Any] | None:
        """单条 + 实时状态（契约 §2.1 的 ``Entry+State``）。"""
        entry = self.find(agent_id)
        return None if entry is None else self._with_state(entry)

    def list_entries(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._public(e) for e in self._plugins(self.load())]

    def snapshot(self) -> dict[str, Any]:
        """``GET /catalog`` 的载荷（契约 §2：``{ok, version, plugins:[Entry+State]}``）。"""
        with self._lock:
            document = self.load()
            plugins = [self._with_state(e) for e in self._plugins(document)]
            version = document.get("version", CATALOG_VERSION)
            updated = document.get("updated", "")
        return {"ok": True, "version": version, "updated": updated, "plugins": plugins}

    # 别名：契约文档里点名的 API 名，保留两个名字让调用方的语义更直白
    def snapshot_with_state(self) -> dict[str, Any]:
        return self.snapshot()

    # ---------------- 状态与健康度 ----------------
    def _bus_state(self, agent_id: str) -> dict[str, Any] | None:
        """总线实时快照；未注册返回 None（纯 UI 插件允许 ``bus: null``）。"""
        state = agent_bus_service.get(agent_id)
        if state is None:
            return None
        return {
            "registered": True,
            "enabled": bool(state.enabled),
            "status": state.status,
            "phase": state.phase,
        }

    def _health(self, entry: dict[str, Any], *, duplicate_ids: set[str]) -> dict[str, Any]:
        problems: list[str] = []
        for field in ("entry", "panel"):
            rel = str(entry.get(field) or "").strip()
            if not rel:
                if field == "entry":
                    problems.append(PROBLEM_MISSING_ENTRY)
                continue
            verdict = _safety_of(rel)
            if verdict == "escape":
                problems.append(PROBLEM_PATH_ESCAPE)
            elif verdict == "missing":
                problems.append(PROBLEM_MISSING_ENTRY if field == "entry" else PROBLEM_MISSING_PANEL)

        if str(entry.get("agentId") or "") in duplicate_ids:
            problems.append(PROBLEM_DUPLICATE_ID)
        # not_registered 只对**期望启用**且声称占总线身份的插件报：
        # 停用中的插件不在总线上是正常状态，报出来只会变成噪音。
        if not entry.get("builtin") and entry.get("enabled", True):
            if agent_bus_service.get(str(entry.get("agentId") or "")) is None:
                problems.append(PROBLEM_NOT_REGISTERED)

        # ★★ health.ok 只由**结构性**问题决定（文件缺失/路径越界/重名）。
        #   ``not_registered`` 刻意**不计入 ok**，这是踩过之后改的：
        #   总线上的注册是**适配器的导入副作用**（dsh_adapter 在 import 时 register），
        #   而 App 工厂只在 main() 里跑 —— 于是任何不走 main() 的入口
        #   （自检脚本、TestClient、另一个进程里的探针）看到的都是一张**空总线**，
        #   每个插件都被判 not_registered → health.ok=false。
        #   而 plugin-loader.js 会把 health.ok=false 的条目**整个跳过**，
        #   结果就是 dsh/feiyu 的导航与设置 tab 集体消失。
        #   更糟的是它在真实运行里也会误伤：进程启动后、适配器尚未完成注册的那一小段窗口，
        #   前端恰好在这时拉清单就会把插件永久丢掉。
        #   结论：not_registered 属于"总线还没就绪"的运行时观测，写进 problems 供人看，
        #   但**不允许它阻断加载**——加载器要的是"文件在不在、路径越没越界"。
        structural = {
            PROBLEM_MISSING_ENTRY,
            PROBLEM_MISSING_PANEL,
            PROBLEM_PATH_ESCAPE,
            PROBLEM_DUPLICATE_ID,
        }
        ok = not any(p in structural for p in problems)
        return {"ok": ok, "problems": problems}

    def _with_state(self, entry: dict[str, Any]) -> dict[str, Any]:
        public = self._public(entry)
        ids = [str(e.get("agentId") or "") for e in self._plugins(self.load())]
        duplicates = {i for i in ids if ids.count(i) > 1}
        public["bus"] = self._bus_state(public["agentId"])
        public["health"] = self._health(public, duplicate_ids=duplicates)
        # ★ 启用态真值（契约 §3.3）：
        #   builtin            → 永远 true（恒可见，不看 enabled）
        #   占总线身份         → 以总线为准
        #   不占总线（bus:null）→ 以清单 enabled 为准
        if public.get("builtin"):
            public["enabled"] = True
        elif public["bus"] is not None:
            public["enabled"] = bool(public["bus"]["enabled"])
        else:
            public["enabled"] = bool(public.get("enabled", True))
        return public

    # ---------------- 写操作 ----------------
    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        """上架：把**已经放在 ``dist/plugins/`` 里**的插件登记进清单。

        幂等语义：同一个 agentId 再来一次 → 409（契约 §2）。
        故意的——用户点两次"上架"应该看到"已经有了"，而不是悄悄覆盖掉
        他上次改过的 name/accent。
        """
        with self._lock:
            document = self.load()
            entry = build_entry(payload)
            entry.pop("_entry_path", None)
            plugins = self._plugins(document)
            if any(e.get("agentId") == entry["agentId"] for e in plugins):
                raise DuplicatePluginError(
                    f"插件 {entry['agentId']} 已在清单中（如需修改请用 PATCH，不要重复上架）"
                )
            plugins.append(entry)
            document["plugins"] = plugins
            document["updated"] = _now_iso()
            self._write(document)
            # 新上架的插件若声明了「期望启用」且已占总线身份，顺手把总线拨到一致，
            # 否则市场卡片会显示"已启用"但导航/settingsTab 还是旧的。
            if entry.get("enabled", True):
                self._sync_bus(entry)
            return self._with_state(entry)

    # PATCH 可改字段（契约 §2 逐个列死）。agentId / entry / builtin 不可改：
    #   entry 可改 = 任何人都能把一个已加载的插件指向任意脚本（配合 reload 就是任意代码执行）；
    #   agentId 可改 = 清单主键漂移，前端已注入的 script 标签对不上，只能重启。
    PATCHABLE = frozenset({
        "name", "version", "author", "accent", "description", "category", "enabled",
    })

    def patch(self, agent_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """改元数据。允许改的字段见 :attr:`PATCHABLE`，其余一律 400。

        为什么"多余字段就报错"而不是静默忽略：
        前端上架表单/编辑框会把整条记录回传，若静默忽略，用户会以为自己
        改了 entry 并且生效了。
        """
        data = normalize_field_names(payload)
        # agentId 是清单主键，**不可改**（契约 §2）：改它等于"把条目挪到另一行"，
        # 前端已注入的 <script data-mio-plugin="旧id"> 会永远孤儿化。
        # 这里显式拒绝而不是静默丢掉 —— 前端会把整条记录回传，
        # 静默忽略会让用户以为自己改了 agentId 并且生效了。
        if "agentId" in payload or "agent_id" in payload or "agentID" in payload:
            raise InvalidEntryError(
                "agentId 是清单主键，不可修改；需要换 id 请先下架再用新 id 上架"
            )
        data.pop("agentId", None)
        forbidden = sorted(set(data) - self.PATCHABLE)
        if forbidden:
            raise InvalidEntryError(
                f"不允许修改字段：{', '.join(forbidden)}（可改：{', '.join(sorted(self.PATCHABLE))}）"
            )
        with self._lock:
            document = self.load()
            plugins = self._plugins(document)
            index = next(
                (i for i, e in enumerate(plugins) if e.get("agentId") == agent_id), None
            )
            if index is None:
                raise UnknownPluginError(f"插件不存在：{agent_id}")
            current = plugins[index]
            merged = dict(current)
            merged.update({k: v for k, v in data.items() if v is not None})
            # 走同一条归一化路径（name/version/accent 等仍需长度与格式校验）
            rebuilt = build_entry(merged, existing=current)
            rebuilt.pop("_entry_path", None)
            if current.get("builtin"):
                rebuilt["builtin"] = True
                rebuilt["enabled"] = True
            plugins[index] = rebuilt
            document["plugins"] = plugins
            document["updated"] = _now_iso()
            self._write(document)

            # enabled 是唯一有副作用的字段：只改清单等于"界面说关掉了，插件照跑"，
            # 必须同步拨总线（builtin 除外——它没有启停入口）。
            if "enabled" in data and not rebuilt.get("builtin"):
                self._set_bus_enabled(rebuilt, bool(rebuilt.get("enabled", True)))
            return self._with_state(rebuilt)

    def remove(self, agent_id: str) -> dict[str, Any]:
        """下架：**只移除清单条目，不动磁盘文件**（契约 §2，返回 ``files_kept: true``）。

        为什么必须留文件：``dist/plugins/`` 是前端仓库的产物目录，
        这里删了等于"点一下下架，插件文件就没了，得重新构建才装得回来"。
        前端 loader 是照清单注入 ``<script>`` 的，条目没了脚本自然不会加载。
        """
        with self._lock:
            document = self.load()
            plugins = self._plugins(document)
            target = next((e for e in plugins if e.get("agentId") == agent_id), None)
            if target is None:
                raise UnknownPluginError(f"插件不存在：{agent_id}")
            if target.get("builtin"):
                raise BuiltinProtectedError(
                    f"「{target.get('name') or agent_id}」是宿主本体（builtin），不可下架"
                )
            document["plugins"] = [e for e in plugins if e.get("agentId") != agent_id]
            document["updated"] = _now_iso()
            self._write(document)

            # ★★ 2026-10-25 用户实测反馈：「下架后右侧 Agent 边栏还留着那个探针」。
            #   根因：set_enabled() 会为纯 UI 插件**自动注册**总线身份，
            #   而下架只把 enabled 拨成 False、从不 unregister，
            #   于是 /api/companion/agents 里永远多一条 offline 的幽灵身份，
            #   右侧 Agent 边栏就一直显示它（用户看到的是"探针没清"）。
            #
            #   这里按**身份归属**决定要不要摘：
            #     · adapter == 'plugin_market' → 这个身份是本模块自己替它建的，
            #       下架就该一起摘掉（否则永远清理不干净）；
            #     · 其它 adapter（DSH 适配器、大肥鱼云端…）→ **保留**，
            #       那些是别家链路注册的真实身份，摘掉会误伤正在跑的东西。
            state = agent_bus_service.get(agent_id)
            if state is not None:
                if str(getattr(state, "adapter", "") or "") == PLUGIN_MARKET_ADAPTER:
                    agent_bus_service.unregister(agent_id)
                elif state.enabled:
                    # 不是我们建的身份：只拨停用，保留身份
                    agent_bus_service.set_enabled(agent_id, False)
            return {"ok": True, "removed": agent_id, "files_kept": True}

    def set_enabled(self, agent_id: str, enabled: bool) -> dict[str, Any]:
        """热插拔：内置 → 403；不在总线上的插件**自动注册**后再拨开关。

        ★ 本方法就是契约 §2 里"不存在的插件自动注册进总线"的落点。
        为什么必须自动注册：``agent_bus_service.set_enabled`` 对未注册的 id
        直接返回 False（它没法给"不存在的东西"设开关）。而纯 UI 插件
        根本没参加 ``agent_bus_service.register``，于是"启用"按钮会静默失效。
        这里用清单条目的 name/accent 补注册，身份色也就一起带进气泡了。
        """
        with self._lock:
            entry = self.find(agent_id)
            if entry is None:
                raise UnknownPluginError(f"插件不存在：{agent_id}")
            if entry.get("builtin"):
                raise BuiltinProtectedError(
                    f"「{entry.get('name') or agent_id}」是宿主本体（builtin），不可停用"
                )
            bus = self._set_bus_enabled(entry, bool(enabled))
            document = self.load()
            for row in self._plugins(document):
                if row.get("agentId") == agent_id:
                    row["enabled"] = bool(enabled)
                    break
            document["updated"] = _now_iso()
            self._write(document)
            return {
                "ok": True,
                "agentId": agent_id,
                "enabled": bool(bus.get("enabled")),
                "bus": bus,
            }

    # ---------------- 总线联动 ----------------
    def _sync_bus(self, entry: dict[str, Any]) -> dict[str, Any]:
        """把条目的期望态推到总线（未注册则先注册）。"""
        return self._set_bus_enabled(entry, bool(entry.get("enabled", True)))

    def _set_bus_enabled(self, entry: dict[str, Any], enabled: bool) -> dict[str, Any]:
        agent_id = str(entry.get("agentId") or "")
        state = agent_bus_service.get(agent_id)
        if state is None:
            # adapter 名固定成 "plugin_market"：一眼看出这个身份是市场代注册的，
            # 而不是某个真适配器在跑（排障时这个区别很关键）。
            agent_bus_service.register(
                agent_id,
                str(entry.get("name") or agent_id),
                PLUGIN_MARKET_ADAPTER,
                enabled=enabled,
                accent=str(entry.get("accent") or ""),
            )
        else:
            agent_bus_service.set_enabled(agent_id, enabled)
        return self._bus_state(agent_id) or {"registered": False, "enabled": enabled}

    # ---------------- 诊断 ----------------
    def diagnostics(self) -> dict[str, Any]:
        """清单健康度（契约 §2 ``GET /diagnostics``）。

        逐项**穷举检查**，而不是只报第一个错误：市场面板要一次性告诉用户
        "这几条都有问题"，而不是修一条重开一次。
        """
        checks: list[dict[str, Any]] = []
        with self._lock:
            document = self.load()
            plugins = self._plugins(document)
            ids = [str(e.get("agentId") or "") for e in plugins]
            duplicates = {i for i in ids if ids.count(i) > 1}

            for entry in plugins:
                agent_id = str(entry.get("agentId") or "")
                problems: list[str] = []
                # 1) id 规则
                if not AGENT_ID_RE.match(agent_id):
                    problems.append("invalid_agent_id")
                # 2) 文件与越界（entry / panel 分开报，前端要能精确指出来）
                for field in ("entry", "panel"):
                    rel = str(entry.get(field) or "").strip()
                    if not rel:
                        if field == "entry":
                            problems.append(PROBLEM_MISSING_ENTRY)
                        continue
                    verdict = _safety_of(rel)
                    if verdict == "escape":
                        problems.append(f"{field}_path_escape")
                    elif verdict == "missing":
                        problems.append(f"{field}_{PROBLEM_MISSING_ENTRY if field == 'entry' else PROBLEM_MISSING_PANEL}")
                # 3) 重名
                if agent_id in duplicates:
                    problems.append(PROBLEM_DUPLICATE_ID)
                # 4) 总线未注册（只对期望启用的非 builtin 有意义）
                registered = agent_bus_service.get(agent_id) is not None
                if not entry.get("builtin") and entry.get("enabled", True) and not registered:
                    problems.append(PROBLEM_NOT_REGISTERED)

                checks.append({
                    "agentId": agent_id,
                    "name": entry.get("name") or agent_id,
                    "ok": not problems,
                    "problems": problems,
                    "builtin": bool(entry.get("builtin")),
                    "registered": registered,
                })

        return {
            "ok": all(c["ok"] for c in checks),
            "catalog_path": str(catalog_path()),
            "frontend_root": str(frontend_root()),
            "plugins_root": str(plugins_root()),
            "count": len(checks),
            "checks": checks,
        }


def _coerce_document(raw: Any) -> dict[str, Any] | None:
    """把磁盘上的 JSON 收敛成合法文档形状；无法修复时返回 None（由调用方重建）。

    这里**不丢条目**：字段缺失的条目照样保留，让 ``health``/``diagnostics``
    把它标红——用户能看见"这条坏了"，比它神秘消失强得多。
    """
    if not isinstance(raw, dict):
        return None
    plugins = raw.get("plugins")
    if not isinstance(plugins, list):
        return None
    cleaned: list[dict[str, Any]] = []
    for item in plugins:
        if not isinstance(item, dict):
            continue
        entry = dict(item)
        entry.pop("_entry_path", None)
        entry.setdefault("version", "1.0.0")
        entry.setdefault("author", "Mio")
        entry.setdefault("category", "other")
        entry.setdefault("builtin", False)
        entry.setdefault("enabled", True)
        entry.setdefault("accent", "")
        entry.setdefault("description", "")
        entry.setdefault("panel", "")
        cleaned.append(entry)
    return {
        "version": int(raw.get("version") or CATALOG_VERSION),
        "updated": str(raw.get("updated") or _now_iso()),
        "plugins": cleaned,
    }


# 进程级单例：清单是全局状态，多实例会导致缓存各自为政、写操作互相覆盖
plugin_market = PluginMarket()


# ---------------------------------------------------------------------------
# 模块级门面（与 agent_bus_service 同一风格：函数级 API 便于测试与调用）
# ---------------------------------------------------------------------------
def load() -> dict[str, Any]:
    return plugin_market.load()


def snapshot_with_state() -> dict[str, Any]:
    return plugin_market.snapshot_with_state()


def get(agent_id: str) -> dict[str, Any] | None:
    return plugin_market.get(agent_id)


def find(agent_id: str) -> dict[str, Any] | None:
    """只取**清单条目本身**（不含实时状态），内部逻辑与排障时用。"""
    return plugin_market.find(agent_id)


def list_entries() -> list[dict[str, Any]]:
    return plugin_market.list_entries()


def add(payload: dict[str, Any]) -> dict[str, Any]:
    return plugin_market.add(payload)


def patch(agent_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return plugin_market.patch(agent_id, payload)


def remove(agent_id: str) -> dict[str, Any]:
    return plugin_market.remove(agent_id)


def set_enabled(agent_id: str, enabled: bool) -> dict[str, Any]:
    return plugin_market.set_enabled(agent_id, enabled)


def diagnostics() -> dict[str, Any]:
    return plugin_market.diagnostics()


def reload() -> dict[str, Any]:
    return plugin_market.reload()
