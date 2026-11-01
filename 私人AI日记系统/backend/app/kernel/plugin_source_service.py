"""插件市场 · 远程插件源（GitHub 托管社区插件的搜索与安装，2026-11-01 阶段 A）。

契约：``docs/插件市场-契约.md`` §8（远程安装，本文件 + routes/plugin_market.py
``/api/plugin/market/remote/*`` 是唯一实现出处）。

═══ 三层设计（用户裁决 2026-11-01：混合索引 + 阶段 A 纯前端插件）═══

1. **包规范**：社区插件仓库根目录放 ``mao-plugin.json``（schema 见
   ``_validate_manifest``）。大肥鱼仓（mao-plugin-feiyu）是第一个样板。
2. **索引**：混合模式 ——
   · 主索引 = GitHub Topic 自动发现（``topic: mao-plugin-market``），零人工维护；
   · 叠加可选"精选清单" = ``registry_repo`` 仓库根的 ``registry.json``（PR 评审制）；
   · 信任分层：作者在 ``verified_authors`` 里 → verified；否则"社区·未审核"。
   · 搜索结果落本地缓存（TTL ``cache_hours``），离线可用、省 API 配额。
3. **安装**：从 ``api.github.com`` 拉 zipball（★ 本机 github.com:443 被墙、
   代理常死，api.github.com 是被实战验证的可靠通道）→ 白名单路径落盘 →
   走 :mod:`plugin_market_service` 的 ``add()`` 登记上架（复用全部既有校验）。

═══ 安全红线（远程装代码 ≠ 随便装）═══

· 落盘路径白名单：前端件只允许写 ``dist/``（前端根）；后端模块只允许写
  ``app/plugins_host/<插件id>/``（阶段 B 隔离区）。zip 成员逐条过
  "无 ``..``、无盘符、无绝对路径"检查（手法与契约 §1 的 realpath 五步防护同源）；
· 后端 Python 模块（阶段 B）= 任意代码执行 → 落到隔离区后**不自动执行**，
  由 ``app/plugins_host`` 挂载协议在**重启后端**时按 provides 别名挂载
  （宿主已有同名模块时宿主优先），安装响应带 ``needs_restart`` 提示；
· 体积上限：zip 解压总量 ≤ 200MB、文件数 ≤ 3000、单文件 ≤ 100MB；
· 清单强校验：schema 版本、id/agentId 格式与目录一致性、backend.provides 格式；
· 未验证作者安装时前端弹确认（后端返回 verified 标记，UI 决定要不要拦）。

═══ 配置与缓存文件（运行时数据，不进仓库）═══

· ``数据/插件市场-远程.json``   配置：verified_authors / registry_repo / topic / token
· ``数据/插件市场-远程缓存.json`` 搜索缓存：``{at, items}``
"""
from __future__ import annotations

import io
import json
import re
import time
import zipfile
from pathlib import Path
from typing import Any

import httpx

from ..config import settings
from . import plugin_market_service

GITHUB_API = "https://api.github.com"
MANIFEST_NAME = "mao-plugin.json"
DEFAULT_TOPIC = "mao-plugin-market"
MAX_TOTAL_BYTES = 200 * 1024 * 1024   # zip 解压总量上限
MAX_FILE_BYTES = 100 * 1024 * 1024    # 单文件上限
MAX_MEMBERS = 3000                    # 文件数上限
SEARCH_LIMIT = 20                     # 单次搜索最多回读多少个仓库的清单

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
REF_RE = re.compile(r"^[A-Za-z0-9._/\-]{1,128}$")


class RemoteSourceError(plugin_market_service.PluginMarketError):
    """远程插件源领域异常（沿用市场的 status/detail 形状，前端零适配）。

    ``PluginMarketError`` 的 ``status`` 是类属性，而远程源的 status 是**逐次**决定
    的（404 仓库不存在 / 429 配额 / 409 已装 …），所以这里改成实例属性。
    """

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = int(status)


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
def _config_path() -> Path:
    return Path(settings.data_dir) / "插件市场-远程.json"


def load_config() -> dict[str, Any]:
    """读配置；缺文件/缺字段都回落默认值（首次运行零配置可用）。"""
    cfg: dict[str, Any] = {
        "topic": DEFAULT_TOPIC,
        "verified_authors": ["xkk6663"],
        "registry_repo": "",
        "cache_hours": 6,
        "token": "",
    }
    try:
        raw = json.loads(_config_path().read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            cfg.update({k: v for k, v in raw.items() if v is not None})
    except (OSError, ValueError):
        pass
    if not isinstance(cfg.get("verified_authors"), list):
        cfg["verified_authors"] = ["xkk6663"]
    return cfg


# ---------------------------------------------------------------------------
# GitHub 访问
# ---------------------------------------------------------------------------
def _headers(cfg: dict[str, Any]) -> dict[str, str]:
    h = {"User-Agent": "mao-pet-plugin-market",
         "Accept": "application/vnd.github+json"}
    if cfg.get("token"):
        h["Authorization"] = "Bearer " + str(cfg["token"])
    return h


def _http_get(url: str, headers: dict[str, str], timeout: float) -> httpx.Response:
    """直连优先的 GET：先关 trust_env 直连（本机 api.github.com 直连是被实战
    验证的可靠通道，而环境变量里的代理时好时坏、死代理会挂住连接）；
    直连网络层失败 → 再按环境（系统代理）重试一次。
    （契约 §8.5 网络通道。）"""
    try:
        return httpx.get(url, headers=headers, timeout=timeout,
                         follow_redirects=True, trust_env=False)
    except (httpx.ProxyError, httpx.ConnectError, httpx.ConnectTimeout):
        return httpx.get(url, headers=headers, timeout=timeout, follow_redirects=True)


def _api_get(cfg: dict[str, Any], path: str, *, timeout: float = 60.0) -> httpx.Response:
    """单次 GitHub API GET。403 + 配额耗尽 → 人话错误。"""
    r = _http_get(GITHUB_API + path, _headers(cfg), timeout)
    if r.status_code == 403 and r.headers.get("x-ratelimit-remaining") == "0":
        reset = int(r.headers.get("x-ratelimit-reset") or 0)
        wait = max(1, reset - int(time.time())) // 60 + 1
        raise RemoteSourceError(
            429, f"GitHub API 配额已用完（未登录 60 次/小时），约 {wait} 分钟后恢复；"
                 f"也可在 数据/插件市场-远程.json 里配 token 提额")
    if r.status_code == 404:
        raise RemoteSourceError(404, f"GitHub 上找不到：{path}（仓库/文件不存在，或为私有仓）")
    if r.status_code >= 400:
        raise RemoteSourceError(502, f"GitHub API 返回 {r.status_code}：{r.text[:200]}")
    return r


def _fetch_manifest(cfg: dict[str, Any], repo: str, ref: str | None) -> dict[str, Any] | None:
    """读仓库根的 mao-plugin.json；没有 → None（不视为错误）。"""
    q = f"?ref={ref}" if ref else ""
    try:
        r = _api_get(cfg, f"/repos/{repo}/contents/{MANIFEST_NAME}{q}")
        data = json.loads(base64_of(r.json()))
        return data if isinstance(data, dict) else None
    except RemoteSourceError as exc:
        if exc.status == 404:
            return None
        raise


def base64_of(contents_json: dict[str, Any]) -> bytes:
    import base64
    return base64.b64decode(contents_json.get("content") or "")


def backend_root() -> Path:
    """后端隔离区根 = app/ 目录（plugins_host 的宿主）。"""
    return Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------------------
# 清单校验（纯函数，selftest 直接覆盖）
# ---------------------------------------------------------------------------
def validate_manifest(data: Any) -> dict[str, Any]:
    """校验 mao-plugin.json；通过 → 返回归一化后的清单，不通过 → RemoteSourceError。"""
    if not isinstance(data, dict):
        raise RemoteSourceError(400, f"{MANIFEST_NAME} 必须是 JSON 对象")
    if data.get("schema") != 1:
        raise RemoteSourceError(400, f"{MANIFEST_NAME} 的 schema 必须是 1（当前：{data.get('schema')!r}）")
    pid = str(data.get("id") or "").strip()
    agent_id = str(data.get("agentId") or "").strip()
    if not plugin_market_service.AGENT_ID_RE.match(pid):
        raise RemoteSourceError(400, f"清单 id 不合法：{pid!r}（小写字母/数字/_/-，1-32 位）")
    if agent_id and not plugin_market_service.AGENT_ID_RE.match(agent_id):
        raise RemoteSourceError(400, f"清单 agentId 不合法：{agent_id!r}")
    if not str(data.get("name") or "").strip():
        raise RemoteSourceError(400, "清单缺少 name")
    fe = data.get("frontend")
    if not isinstance(fe, dict) or not str(fe.get("distPlugins") or "").strip():
        raise RemoteSourceError(400, "清单缺少 frontend.distPlugins（前端件必须自带）")
    # ★ 阶段 B：backend 字段合法化 —— {package: 仓库内后端目录, provides: [app.* 模块路径]}
    backend = data.get("backend")
    if backend is not None:
        if not isinstance(backend, dict):
            raise RemoteSourceError(400, "backend 必须是对象 {package, provides}")
        pkg = str(backend.get("package") or "").strip().strip("/")
        if (not pkg or ".." in pkg.split("/") or re.match(r"^[a-zA-Z]:", pkg)
                or pkg.startswith(("/", "\\"))):
            raise RemoteSourceError(400, f"backend.package 不安全（应为仓库内相对目录）：{pkg!r}")
        provides = backend.get("provides")
        seg = re.compile(r"^[a-z_][a-z0-9_]*$")
        if (not isinstance(provides, list) or not provides
                or not all(isinstance(p, str) and p for p in provides)):
            raise RemoteSourceError(400,
                "backend.provides 必须是非空字符串数组（挂载到 app.* 命名空间的模块路径）")
        for p in provides:
            parts = p.split(".")
            if not (1 <= len(parts) <= 6) or not all(seg.match(x) for x in parts):
                raise RemoteSourceError(400,
                    f"backend.provides 条目不合法（小写 Python 模块路径，如 cloud_feiyu"
                    f" 或 companion.cover_service）：{p!r}")
        out_backend = dict(backend)
        out_backend["package"] = pkg
        data = dict(data)
        data["backend"] = out_backend
    assets = data.get("assets") or []
    if not isinstance(assets, list):
        raise RemoteSourceError(400, "assets 必须是数组")
    for a in assets:
        if not (isinstance(a, dict) and str(a.get("src") or "").strip()
                and str(a.get("dest") or "").strip()):
            raise RemoteSourceError(400, f"assets 每项都要有 src 和 dest：{a!r}")
    out = dict(data)
    out["agentId"] = agent_id or pid
    out["id"] = pid
    return out


def safe_join(dest_root: Path, rel: str) -> Path:
    """zip 成员/清单 dest 的落盘路径解析：拒绝 ``..``、盘符、绝对路径；
    resolve 后必须在 ``dest_root`` 之内（与契约 §1 realpath 防护同源）。"""
    parts = [p for p in rel.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or ".." in parts or re.match(r"^[a-zA-Z]:", rel) or rel.startswith(("/", "\\")):
        raise RemoteSourceError(400, f"路径不安全（拒绝落盘）：{rel!r}")
    target = (dest_root.joinpath(*parts)).resolve()
    if not target.is_relative_to(dest_root.resolve()):
        raise RemoteSourceError(400, f"路径越界（拒绝落盘）：{rel!r}")
    return target


# ---------------------------------------------------------------------------
# 搜索（topic 自动发现 + 精选清单 + 缓存）
# ---------------------------------------------------------------------------
def _cache_path() -> Path:
    return Path(settings.data_dir) / "插件市场-远程缓存.json"


def _cache_load() -> dict[str, Any] | None:
    try:
        return json.loads(_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _cache_save(items: list[dict[str, Any]]) -> None:
    try:
        _cache_path().write_text(
            json.dumps({"at": time.time(), "items": items}, ensure_ascii=False, indent=1),
            encoding="utf-8")
    except OSError:
        pass


def _read_registry(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """精选清单：registry_repo 根的 registry.json。缺省/失败都静默返回空。"""
    repo = str(cfg.get("registry_repo") or "").strip()
    if not repo or not REPO_RE.match(repo):
        return []
    try:
        r = _api_get(cfg, f"/repos/{repo}/contents/registry.json")
        data = json.loads(base64_of(r.json()))
        return data.get("plugins", []) if isinstance(data, dict) else []
    except (RemoteSourceError, ValueError):
        return []


def _repo_manifest_entry(cfg: dict[str, Any], item: dict[str, Any], source: str) -> dict[str, Any] | None:
    """把一个 GitHub 仓库搜索结果 + 其 mao-plugin.json 组装成市场搜索条目。"""
    repo = item.get("full_name") or ""
    owner_obj = item.get("owner")
    owner = str(owner_obj.get("login") if isinstance(owner_obj, dict) and owner_obj.get("login")
                else repo.split("/")[0])
    mf = _fetch_manifest(cfg, repo, None)
    if mf is None:
        return None
    try:
        mf = validate_manifest(mf)
    except RemoteSourceError:
        return None   # 清单不合规 = 不进市场（但仓库仍占一次搜索结果）
    verified = owner in set(cfg.get("verified_authors") or [])
    return {
        "id": mf.get("id"),
        "agentId": mf.get("agentId"),
        "name": str(mf.get("name") or mf.get("id")),
        "version": str(mf.get("version") or "1.0.0"),
        "description": str(item.get("description") or mf.get("description") or ""),
        "author": owner,
        "verified": verified,
        "source": source,
        "repo": repo,
        "ref": str(item.get("default_branch") or "main"),
        "stars": int(item.get("stargazers_count") or 0),
        "pushed_at": str(item.get("pushed_at") or ""),
        "accent": str(mf.get("accent") or ""),
        "category": str(mf.get("category") or "other"),
    }


def merge_registry(items: list[dict[str, Any]], reg_items: list[Any],
                   verified: set[str]) -> list[dict[str, Any]]:
    """精选清单并入搜索结果（纯函数，selftest 直接覆盖；契约 §8.2/§8.7）。

    **同仓库去重**：registry 条目若与 topic 自动发现撞了同一个 repo，
    不出两张卡——把 ``curated: true`` 叠加到自动发现条目上（它带版本/星标/简介，
    信息更全；registry 侧通常只有 repo+id），registry 副本丢弃。
    未撞仓的 registry 条目照常追加（source=registry）。
    """
    by_repo = {str(i.get("repo") or ""): i for i in items}
    for it in reg_items:
        if not (isinstance(it, dict) and it.get("repo") and it.get("id")):
            continue
        existing = by_repo.get(str(it["repo"]))
        if existing is not None:
            existing["curated"] = True
            continue
        reg = dict(it)
        reg.setdefault("source", "registry")
        reg.setdefault("verified", str(it.get("author") or "") in verified)
        reg["curated"] = True
        by_repo[str(it["repo"])] = reg
        items.append(reg)
    return items


def dedupe_by_repo(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """同 repo 只留第一条（纯函数）：被丢的若是精选来源，把 curated 叠到保留条目。

    兜底用途：v1.6.0 及之前的搜索缓存里已存了"topic + registry 各一张卡"的
    重复条目——缓存命中路径也过一遍这里，旧缓存自愈，不必等 TTL 或强刷。
    """
    seen: dict[str, dict[str, Any]] = {}
    out: list[dict[str, Any]] = []
    for it in items:
        repo = str(it.get("repo") or "")
        kept = seen.get(repo)
        if kept is None:
            seen[repo] = it
            out.append(it)
            continue
        if it.get("source") == "registry" or it.get("curated"):
            kept["curated"] = True
        # 精选副本缺版本号（registry 侧只有 repo+id）→ 别把保留条目的版本弄丢
        if it.get("version") and not kept.get("version"):
            kept["version"] = it["version"]
    return out


def search(*, q: str = "", force: bool = False) -> dict[str, Any]:
    """远程插件搜索。缓存新鲜且非 force → 直接过滤缓存；否则回 GitHub 拉。"""
    cfg = load_config()
    cache = _cache_load()
    ttl = float(cfg.get("cache_hours") or 6) * 3600
    if not force and cache and (time.time() - cache.get("at", 0)) < ttl:
        items = dedupe_by_repo(cache.get("items", []))
        stale = False
    else:
        items, stale = [], True
    if stale:
        topic = str(cfg.get("topic") or DEFAULT_TOPIC).strip()
        r = _api_get(cfg, f"/search/repositories?q=topic:{topic}&per_page=50&sort=updated")
        repos = (r.json().get("items") or [])[:SEARCH_LIMIT]
        for it in repos:
            entry = _repo_manifest_entry(cfg, it, "topic")
            if entry:
                items.append(entry)
        merge_registry(items, _read_registry(cfg),
                       set(cfg.get("verified_authors") or []))
        items = dedupe_by_repo(items)
        _cache_save(items)
    needle = q.strip().lower()
    if needle:
        items = [i for i in items
                 if needle in json.dumps(i, ensure_ascii=False).lower()]
    return {"ok": True, "count": len(items), "cached": not stale, "items": items}


# ---------------------------------------------------------------------------
# zipball 下载与解包
# ---------------------------------------------------------------------------
def _download_zipball(cfg: dict[str, Any], repo: str, ref: str) -> bytes:
    # timeout=600：本机直连通道实测 ~100KB/s（28MB 约 5 分钟），300s 不够
    r = _http_get(f"{GITHUB_API}/repos/{repo}/zipball/{ref}", _headers(cfg), 600.0)
    if r.status_code == 403 and r.headers.get("x-ratelimit-remaining") == "0":
        raise RemoteSourceError(429, "GitHub API 配额已用完，稍后再试或配 token")
    if r.status_code >= 400:
        raise RemoteSourceError(502, f"下载 zipball 失败（{r.status_code}）：{repo}@{ref}")
    return r.content


def _open_zip(raw: bytes) -> zipfile.ZipFile:
    if len(raw) > MAX_TOTAL_BYTES:
        raise RemoteSourceError(400, f"插件包超过 {MAX_TOTAL_BYTES // 1024 // 1024}MB 上限，拒绝安装")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise RemoteSourceError(400, f"插件包不是合法 zip：{exc}") from exc
    names = zf.namelist()
    if len(names) > MAX_MEMBERS:
        raise RemoteSourceError(400, f"插件包文件数超过 {MAX_MEMBERS}，拒绝安装")
    total = sum(i.file_size for i in zf.infolist())
    if total > MAX_TOTAL_BYTES:
        raise RemoteSourceError(400, f"插件包解压后 {total // 1024 // 1024}MB，超上限")
    return zf


def _strip_top(name: str) -> str:
    """GitHub zipball 的成员都带 ``{repo}-{ref}/`` 顶层目录；剥掉它。"""
    parts = name.split("/", 1)
    return parts[1] if len(parts) == 2 and parts[1] else ""


def _read_manifest_from_zip(zf: zipfile.ZipFile) -> tuple[str, dict[str, Any]]:
    """在 zip 里找 mao-plugin.json（顶层目录剥掉后应恰在根）。"""
    for name in zf.namelist():
        rel = _strip_top(name)
        if rel == MANIFEST_NAME:
            try:
                data = json.loads(zf.read(name).decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as exc:
                raise RemoteSourceError(400, f"{MANIFEST_NAME} 不是合法 JSON：{exc}") from exc
            return name, validate_manifest(data)
    raise RemoteSourceError(400, f"插件包根目录缺少 {MANIFEST_NAME}（贡献规范见 docs/插件市场-契约.md §8）")


def _members_of(zf: zipfile.ZipFile) -> list[tuple[str, str]]:
    """[(zip成员名, 剥顶层后的相对路径), ...]，跳过目录条目。"""
    out = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        if info.file_size > MAX_FILE_BYTES:
            raise RemoteSourceError(400, f"单文件超上限（{info.file_size // 1024 // 1024}MB）：{info.filename}")
        rel = _strip_top(info.filename)
        if rel:
            out.append((info.filename, rel))
    return out


def _build_plan(zf: zipfile.ZipFile, mf: dict[str, Any]) -> list[dict[str, Any]]:
    members = _members_of(zf)
    fe = mf.get("frontend") or {}
    dist_plugins = str(fe.get("distPlugins") or "").strip("/")
    dist_assets = fe.get("distAssets") or []
    if isinstance(dist_assets, str):
        dist_assets = [dist_assets]

    plan: list[dict[str, Any]] = []
    sizes = {i.filename: i.file_size for i in zf.infolist()}

    def add_by_prefix(prefix: str, dest_prefix: str, area: str) -> None:
        prefix = prefix.strip("/") + "/"
        for member, rel in members:
            if rel.startswith(prefix):
                sub = rel[len(prefix):]
                plan.append({"zip_member": member,
                             "rel_dest": (dest_prefix + "/" + sub).replace("//", "/"),
                             "bytes": sizes.get(member, 0), "area": area})

    add_by_prefix(dist_plugins, "plugins", "dist")
    for src in dist_assets:
        add_by_prefix(str(src).strip("/"), "assets", "dist")
    for a in mf.get("assets") or []:
        src = str(a["src"]).strip("/")
        dest = str(a["dest"]).strip("/")
        if dest.startswith("plugins/") or dest == "plugins":
            raise RemoteSourceError(400, f"assets.dest 不允许写 plugins/（那是插件件专用）：{dest!r}")
        for member, rel in members:
            if rel == src:
                plan.append({"zip_member": member, "rel_dest": dest,
                             "bytes": sizes.get(member, 0), "area": "dist"})
            elif rel.startswith(src + "/"):
                plan.append({"zip_member": member,
                             "rel_dest": (dest + "/" + rel[len(src) + 1:]).replace("//", "/"),
                             "bytes": sizes.get(member, 0), "area": "dist"})

    # ★ 阶段 B：backend.<package> 整树 → app/plugins_host/<id>/（隔离区）。
    #   插件模块里的相对 import 靠挂载协议别名进 app.* 命名空间后解析到宿主。
    be = mf.get("backend")
    if isinstance(be, dict) and str(be.get("package") or "").strip():
        pkg = str(be["package"]).strip("/")
        pid = str(mf["id"])
        add_by_prefix(pkg, f"plugins_host/{pid}", "backend")

    if not plan:
        raise RemoteSourceError(400, "清单指向的目录里没有任何文件（检查 frontend.distPlugins 等路径是否正确）")

    # 落盘目标逐一过安全解析（安全 + 各自根下的坐标一并确定）
    dist_root = plugin_market_service.frontend_root()
    app_root = backend_root()
    backend_prefix = f"plugins_host/{str(mf['id'])}/"
    for item in plan:
        if item["area"] == "backend":
            # 后端只允许写进本插件自己的隔离区子目录（双保险：rel 已按前缀生成，
            # 这里再显式校验一次，防清单/成员路径花样）
            if not item["rel_dest"].startswith(backend_prefix):
                raise RemoteSourceError(400,
                    f"后端文件越出隔离区（只允许 plugins_host/{mf['id']}/）：{item['rel_dest']!r}")
            item["dest_abs"] = str(safe_join(app_root, item["rel_dest"]))
        else:
            item["dest_abs"] = str(safe_join(dist_root, item["rel_dest"]))
    # entry/panel 必须在计划里：manifest.js = distPlugins 下任意一层目录的根脚本
    mf_dir = None
    for item in plan:
        if item["rel_dest"].rsplit("/", 1)[-1] == "manifest.js":
            mf_dir = item["rel_dest"].rsplit("/", 1)[0]
            break
    if mf_dir is None:
        raise RemoteSourceError(400, f"前端件里没有 manifest.js（应在 {dist_plugins}/ 下）")
    return plan


# ---------------------------------------------------------------------------
# preview / install
# ---------------------------------------------------------------------------
def preview(repo: str, ref: str | None = None) -> dict[str, Any]:
    """安装前预览：拉包、解析清单、给出将落盘的文件计划。**零副作用**。"""
    repo = str(repo or "").strip()
    if not REPO_RE.match(repo):
        raise RemoteSourceError(400, f"仓库名不合法（应为 owner/repo）：{repo!r}")
    cfg = load_config()
    ref = (str(ref).strip() if ref else "") or ""
    if ref and not REF_RE.match(ref):
        raise RemoteSourceError(400, f"ref 不合法：{ref!r}")
    if not ref:
        info = _api_get(cfg, f"/repos/{repo}").json()
        ref = str(info.get("default_branch") or "main")
        owner = str(info.get("owner", {}).get("login") or repo.split("/")[0])
    else:
        owner = repo.split("/")[0]

    zf = _open_zip(_download_zipball(cfg, repo, ref))
    _, mf = _read_manifest_from_zip(zf)
    plan = _build_plan(zf, mf)
    total = sum(p["bytes"] for p in plan)
    be = mf.get("backend") if isinstance(mf.get("backend"), dict) else None
    return {
        "ok": True,
        "repo": repo, "ref": ref,
        "manifest": {k: mf.get(k) for k in
                     ("id", "agentId", "name", "version", "description",
                      "author", "accent", "category")},
        "owner": owner,
        "verified": owner in set(cfg.get("verified_authors") or []),
        "files": [{"dest": p["rel_dest"], "bytes": p["bytes"], "area": p["area"]}
                  for p in plan],
        "total_bytes": total,
        "backend": ({"package": be.get("package"),
                     "provides": list(be.get("provides") or [])} if be else None),
        "needs_restart": bool(be),
    }


def install(repo: str, ref: str | None = None, *, force: bool = False) -> dict[str, Any]:
    """远程安装：下载 → 校验 → 白名单落盘 → 走既有 add() 上架登记。"""
    repo = str(repo or "").strip()
    if not REPO_RE.match(repo):
        raise RemoteSourceError(400, f"仓库名不合法（应为 owner/repo）：{repo!r}")
    cfg = load_config()
    ref = (str(ref).strip() if ref else "") or ""
    if ref and not REF_RE.match(ref):
        raise RemoteSourceError(400, f"ref 不合法：{ref!r}")
    if not ref:
        info = _api_get(cfg, f"/repos/{repo}").json()
        ref = str(info.get("default_branch") or "main")
        owner = str(info.get("owner", {}).get("login") or repo.split("/")[0])
    else:
        owner = repo.split("/")[0]

    zf = _open_zip(_download_zipball(cfg, repo, ref))
    zip_manifest_name, mf = _read_manifest_from_zip(zf)
    plan = _build_plan(zf, mf)

    dist_root = plugin_market_service.frontend_root()
    app_root = backend_root()
    # ★ 阶段 B：隔离区升级语义 —— 本插件 id 的 plugins_host/<id>/ 先整目录清掉再写，
    #   避免旧版本 .py 残留（dist 文件同名覆盖即可，后端模块文件名会变）。
    be = mf.get("backend") if isinstance(mf.get("backend"), dict) else None
    if be:
        import shutil
        host_dir = app_root / "plugins_host" / str(mf["id"])
        if host_dir.is_dir():
            shutil.rmtree(host_dir)

    written: list[str] = []
    for item in plan:
        dest = Path(item["dest_abs"])
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(zf.read(item["zip_member"]))
        written.append(item["rel_dest"])

    # 隔离区里放一份清单副本：挂载协议（app/plugins_host.mount_installed）靠它读 provides
    if be:
        host_dir.mkdir(parents=True, exist_ok=True)
        (host_dir / MANIFEST_NAME).write_text(
            json.dumps(mf, ensure_ascii=False, indent=1), encoding="utf-8")

    # 从计划里定位 manifest / panel 的 dist 相对路径（契约 §1 的 entry/panel 坐标）
    manifest_rel = next(p["rel_dest"] for p in plan
                        if p["rel_dest"].endswith("manifest.js"))
    plugin_dir = manifest_rel.rsplit("/", 1)[0]
    panel_rel = next((p["rel_dest"] for p in plan
                      if p["rel_dest"].startswith(plugin_dir + "/")
                      and p["rel_dest"].endswith("-panel.js")), "")
    if plugin_market_service.lowered_is_remote(manifest_rel):
        raise RemoteSourceError(400, f"manifest 路径异常：{manifest_rel!r}")

    payload = {
        "agentId": mf.get("agentId"),
        "name": mf.get("name"),
        "version": mf.get("version") or "1.0.0",
        "author": mf.get("author") or owner,
        "entry": manifest_rel,
        "panel": panel_rel,
        "accent": mf.get("accent") or "",
        "description": mf.get("description") or "",
        "category": mf.get("category") or "other",
        "origin": {"repo": repo, "ref": ref, "version": mf.get("version") or "1.0.0",
                   "manifest": zip_manifest_name, "installed_at": plugin_market_service._now_iso(),
                   **({"backend": {"package": be.get("package"),
                                   "provides": list(be.get("provides") or [])}} if be else {})},
    }

    # agentId 已在清单 → 视为更新（先摘旧条目再登记；文件已覆盖）
    existing = plugin_market_service.get(str(payload["agentId"]))
    if existing is not None:
        if not force:
            raise RemoteSourceError(409,
                f"插件 {payload['agentId']} 已存在。带上 force=true 覆盖安装（升级）。")
        plugin_market_service.remove(str(payload["agentId"]))
    try:
        entry = plugin_market_service.add(payload)
    except plugin_market_service.PluginMarketError as exc:
        # 上架失败要把已写文件收回去吗？——不。文件无害（未被清单引用就不加载），
        # 保留它们便于用户排障后手动上架；这里只把错误如实上抛。
        raise
    return {"ok": True, "plugin": entry, "files_written": len(written),
            "total_bytes": sum(p["bytes"] for p in plan), "repo": repo, "ref": ref,
            "needs_restart": bool(be),
            "backend": ({"provides": list(be.get("provides") or [])} if be else None)}


# ---------------------------------------------------------------------------
# 检查更新（阶段 C，契约 §8.7）：origin 字段 + 远端清单版本比对
# ---------------------------------------------------------------------------
def compare_versions(a: str, b: str) -> int:
    """语义化版本比较（纯函数，selftest 直接覆盖）。

    剥 ``v`` 前缀 → 按 ``.`` 分段逐段比：数字段按数值、非数字段按字符串；
    段数不齐短侧补零（``1.2`` < ``1.2.0``）。返回 -1 / 0 / 1。
    """
    def segs(v: str) -> list[tuple[int, Any]]:
        parts: list[tuple[int, Any]] = []
        for raw in str(v or "").strip().lstrip("vV").split("."):
            digits = ""
            for ch in raw:
                if ch.isdigit():
                    digits += ch
                else:
                    break
            rest = raw[len(digits):]
            parts.append((1, int(digits), rest) if digits else (0, rest, ""))
        return parts

    sa, sb = segs(a), segs(b)
    n = max(len(sa), len(sb))
    pad = (0, "", "")
    sa += [pad] * (n - len(sa))
    sb += [pad] * (n - len(sb))
    for x, y in zip(sa, sb):
        if x != y:
            return -1 if x < y else 1
    return 0


def check_updates(entries: list[dict[str, Any]] | None = None,
                  cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """对每个带 ``origin.repo`` 的已上架插件，拉远端清单版本与本地比对。

    - 逐条目独立容错：单个仓库拉挂了标 ``status: error``，不影响其余；
    - 远端新增了后端模块（provides 有本地没有的）→ ``backend_added`` +
      ``needs_restart``，前端升级确认时要提示"重启生效"；
    - ``entries`` 参数供 selftest 离线注入（默认读市场上架清单）。
    """
    cfg = cfg if cfg is not None else load_config()
    if entries is None:
        entries = plugin_market_service.list_entries()
    items: list[dict[str, Any]] = []
    for entry in entries:
        origin = entry.get("origin") if isinstance(entry, dict) else None
        if not isinstance(origin, dict) or not str(origin.get("repo") or "").strip():
            continue
        repo = str(origin["repo"]).strip()
        ref = str(origin.get("ref") or "").strip()
        local_v = str(origin.get("version") or entry.get("version") or "")
        item: dict[str, Any] = {
            "agentId": entry.get("agentId"),
            "id": entry.get("id") or entry.get("agentId"),
            "name": entry.get("name"),
            "repo": repo, "ref": ref,
            "local_version": local_v, "remote_version": None,
            "status": "error", "note": "",
        }
        try:
            remote_mf = _fetch_manifest(cfg, repo, ref or None)
            if remote_mf is None:
                item["note"] = "远端仓库找不到 mao-plugin.json（仓库可能已删除或转私有）"
            else:
                remote_mf = validate_manifest(remote_mf)
                rv = str(remote_mf.get("version") or "")
                item["remote_version"] = rv
                item["status"] = ("update_available"
                                  if (rv and compare_versions(rv, local_v) > 0)
                                  else "up_to_date")
                be = remote_mf.get("backend")
                if isinstance(be, dict) and isinstance(be.get("provides"), list):
                    old = set((origin.get("backend") or {}).get("provides") or [])
                    added = [p for p in be["provides"] if p not in old]
                    if added:
                        item["backend_added"] = added
                        item["needs_restart"] = True
        except RemoteSourceError as exc:
            item["note"] = str(exc)
        items.append(item)
    return {"ok": True, "count": len(items),
            "updates": sum(1 for i in items if i["status"] == "update_available"),
            "items": items}
