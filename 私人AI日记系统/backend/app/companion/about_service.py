"""桌宠插件包 · 关于/自检 + 更新检查（A5，本插件自足）。

设计要点
--------
- **只读**：本模块不写任何配置（配置写入归 companion 域的 responsibility）；
- **脱敏**：所有路径在返回前统一经过 ``mask_path``，把家目录压成 ``%USERPROFILE%``、
  项目根压成 ``%MIO_ROOT%``；**绝不回传** token / API key / 会话内容。
  这是照抄 whale-widget 的做法（它为此单独写了 aboutPayload() 便于审计）。
- **不擅自联网**：更新检查只在用户**主动点击**时才发起，"关于"面板本身不发请求。
"""
from __future__ import annotations

import json
import os
import platform
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# 路径根：**不手数 parents**（域分层搬迁会让它静默算错，本仓库已踩过两次），
# 改用 config.settings 里已定义的权威根。取不到时才回退到按文件位置上溯。
_APP_DIR = Path(__file__).resolve().parents[1]        # backend/app
_BACKEND_DIR = _APP_DIR.parent                        # backend
try:
    from ..config import settings as _settings
    _REPO_ROOT = Path(_settings.source_workspace_root).resolve()
    _COMPANION_DIR = Path(_settings.project_root).resolve()
except Exception:  # noqa: BLE001
    _REPO_ROOT = _BACKEND_DIR.parent
    _COMPANION_DIR = _BACKEND_DIR

_MASK_PAIRS: list[tuple[str, str]] = [
    (str(_REPO_ROOT), "%MIO_ROOT%"),
    (os.path.expanduser("~"), "%USERPROFILE%"),
]


def mask_path(value: Any) -> str:
    """把路径里的家目录/项目根替换为占位符，避免回传真实用户名。

    顺序要紧：**先替换更长的、更具体的**项目根，再替换家目录。
    反过来的话 ``C:\\Users\\x\\.dsh\\...`` 会先被压成 ``%USERPROFILE%\\.dsh\\...``，
    项目根就再也匹配不到了。
    """
    text = str(value if value is not None else "")
    for raw, token in _MASK_PAIRS:
        if not raw:
            continue
        text = text.replace(raw, token)
        text = text.replace(raw.replace("\\", "/"), token)
    return text


def read_mio_version() -> str:
    """从 CHANGELOG.md 顶部读最新版本号（唯一版本源，避免两处写死不同步）。"""
    changelog = _REPO_ROOT / "CHANGELOG.md"
    try:
        for line in changelog.read_text(encoding="utf-8", errors="replace").splitlines():
            s = line.strip()
            if s.startswith("## ") and "v" in s:
                # 形如 "## v3.5（2026-10-15）· 说明" → 取 v3.5
                token = s[3:].strip()
                for sep in ("（", "(", " ", "·"):
                    idx = token.find(sep)
                    if idx > 0:
                        token = token[:idx]
                return token.strip() or "未知"
    except OSError:
        pass
    return "未知"


def about_payload() -> dict[str, Any]:
    """「关于 / 自检」面板数据。**字段白名单**，路径全部脱敏。"""
    # 注意是 `from .`（同域）而不是 `from ..`：
    # 域分层后 pet_event_service 已迁入 companion 域，写成 app 顶层会 ImportError。
    # （configuration.py 里踩过一模一样的一次，这里引以为戒。）
    from . import pet_event_service
    repo = _REPO_ROOT

    files = []
    for rel in ("README.md", "CHANGELOG.md"):
        p = repo / rel
        try:
            st = p.stat()
            files.append({"name": rel, "bytes": st.st_size, "mtime": int(st.st_mtime)})
        except OSError:
            files.append({"name": rel, "bytes": 0, "mtime": 0})

    return {
        "ok": True,
        "about": {
            # ★ 2026-10-17：产品更名 —— 本仓库已从「Mio 私人AI日记系统」阉割为
            #   DSH 专用 Live2D 桌宠，产品名与版本语义都应以桌宠为准。
            "product": "Mao-pet · DSH 专用 Live2D 桌宠",
            "version": read_mio_version(),
            "python": platform.python_version(),
            "platform": f"{platform.system()} {platform.release()}",
            "arch": platform.machine(),
            "frozen": bool(getattr(sys, "frozen", False)),
        },
        "paths": {
            # 全部经 mask_path：这是"绝不回传真实用户名"的落点
            "repo_root": mask_path(repo),
            "backend_dir": mask_path(_BACKEND_DIR),
            "config": mask_path(_COMPANION_DIR / "dsh_config.json"),
            "pet_data": mask_path(repo / "pet-data"),
            "log": mask_path(repo / "backend_err.log"),
        },
        "files": files,
        "runtime": {
            "pid": os.getpid(),
            # 用 pet_event_service 的公开 status()，不猜内部字段名
            "pet_ws": _pet_ws_status(pet_event_service),
        },
        "privacy": "本面板只包含白名单字段；路径已脱敏；不含任何密钥或会话内容。",
    }


def _pet_ws_status(pet_event_service: Any) -> dict[str, Any]:
    """桌宠 WS 连接概况（只取计数，不回传任何客户端标识）。"""
    try:
        raw = pet_event_service.status() or {}
    except Exception:  # noqa: BLE001
        return {"connected": False}
    out: dict[str, Any] = {"connected": bool(pet_event_service.has_clients())}
    for key in ("clients", "subscribers", "count", "renderers"):
        value = raw.get(key)
        if isinstance(value, int):
            out[key] = value
        elif isinstance(value, (list, tuple)):
            out[key] = len(value)
    return out


def check_update(current: str, *, timeout: float = 6.0) -> dict[str, Any]:
    """检查更新（**只在用户主动点击时调用**；不联网时不产生任何请求）。

    数据源（2026-10-17 改）：npm 上的 ``dsh-live2d-mao``。
    本项目是 DSH 插件，发布/更新统一走 npm（dshmarket 市场也盯 npm 的 latest dist-tag），
    故版本源收敛到 npm，与市场、`dsh plugin add` 三者一致。
    原实现查 PyPI 的 ``mio-companion``（Mao 时代的旧包名，从未发布），
    永远返回"未接入"，等于失效 —— 已移除。
    """
    pkg = "dsh-live2d-mao"
    url = f"https://registry.npmjs.org/{pkg}/latest"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "dsh-live2d-mao/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            data = json.loads(resp.read().decode("utf-8"))
        latest = str((data or {}).get("version") or "").strip()
        if not latest:
            return {"ok": True, "checked": True, "source": "npm", "current": current,
                    "latest": "", "has_update": False, "note": "npm 未返回版本号"}
        return {
            "ok": True,
            "checked": True,
            "source": "npm",
            "current": current,
            "latest": latest,
            "has_update": _is_newer(latest, current),
            "note": "",
        }
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"ok": True, "checked": True, "source": "npm", "current": current,
                    "latest": "", "has_update": False,
                    "note": "npm 上未找到 dsh-live2d-mao，更新检查未接入（不影响使用）"}
        return {"ok": False, "checked": True, "note": f"上游返回 HTTP {exc.code}"}
    except Exception as exc:  # noqa: BLE001
        # 网络不可用是**正常情况**（离线/内网），不是错误，故 ok=True 但注明未检查
        return {"ok": True, "checked": False, "source": "npm", "current": current,
                "latest": "", "has_update": False,
                "note": f"网络不可用，已跳过：{type(exc).__name__}"}


def _is_newer(latest: str, current: str) -> bool:
    """宽松版本比较：逐段数字比大小，非数字段忽略（v3.5 / 3.5.1 都吃得下）。"""
    def parts(v: str) -> list[int]:
        out: list[int] = []
        for seg in str(v or "").replace("v", "").split("."):
            digits = "".join(ch for ch in seg if ch.isdigit())
            out.append(int(digits) if digits else 0)
        return out
    a, b = parts(latest), parts(current)
    n = max(len(a), len(b))
    a += [0] * (n - len(a))
    b += [0] * (n - len(b))
    return a > b
