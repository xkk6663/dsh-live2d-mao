"""插件宿主隔离区（插件市场远程安装 · 阶段 B 后端模块挂载协议）。

契约：``docs/插件市场-契约.md`` §8.6（本文件是挂载机制的**唯一实现出处**）。

═══ 职责 ═══

远程安装的插件后端 Python 模块落在 ``app/plugins_host/<插件id>/``（隔离区，
不与本体混放）。本包在 ``app/main.py`` **最顶部**被调用（:func:`mount_installed`），
把各插件声明提供的模块"别名"进 ``app.*`` 命名空间，让本体既有的 try-import
降级点（main.py / routes/companion.py / model_registry …）零改动地拿到真实现。

═══ 关键语义（阶段 B 的两条铁律）═══

1. **宿主优先**：``app/<dotted>`` 在本体里已存在（文件在位）→ 跳过挂载。
   本机保活副本（v1.4.0 拆分时保留的本地运行副本）永远压过插件安装副本。
2. **别名挂到 app.* 命名空间**，不是 plugins_host.* —— 插件模块里的相对
   import（如 cover_service 的 ``from .. import db``）必须解析到**宿主**
   的兄弟模块，这是挂载协议存在的意义。坏一个插件不影响其余（逐个 try）。

═══ 安全边界 ═══

· 本包**只做模块别名**，不执行安装、不做网络、不写文件；
· provides 条目在清单校验（plugin_source_service.validate_manifest）时已过
  格式关（小写 Python 标识符路径），这里不再信任清单以外的东西；
· 隔离区目录内容全部来自远程安装（.gitignore 排除），删掉目录即卸载。
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

MANIFEST_NAME = "mao-plugin.json"
_APP_PACKAGE = "app"


def _real_module_exists(dotted: str) -> bool:
    """宿主本体里这个模块路径是否已真实在位（只查文件，不 import、无副作用）。

    查 ``app/<dotted 带斜杠>``：目录含 __init__.py（包）或同名 .py（模块）。
    """
    base = Path(__file__).resolve().parent.parent          # app/
    phys = base.joinpath(*dotted.split("."))
    if phys.is_dir() and (phys / "__init__.py").is_file():
        return True
    return phys.with_suffix(".py").is_file()


def _alias_module(plugin_dir: Path, dotted: str) -> ModuleType | None:
    """把 ``plugins_host/<插件>/`` 里的模块以 ``app.<dotted>`` 之名挂进 sys.modules。

    · 包（目录含 __init__.py）→ spec 带 submodule_search_locations，
      包内 ``from .x import y`` 由标准查找器按 __path__ 解析；
    · 单模块（.py）→ 直接 file spec；
    · 父链（如 ``app.companion``）必须是宿主真实包——插件模块的 ``..`` 相对
      import 正是靠它解析到宿主兄弟模块。父链缺失 → 放弃该条目。
    """
    parts = dotted.split(".")
    full = f"{_APP_PACKAGE}.{dotted}"
    phys = plugin_dir.joinpath(*parts)

    if phys.is_dir() and (phys / "__init__.py").is_file():
        spec = importlib.util.spec_from_file_location(
            full, phys / "__init__.py", submodule_search_locations=[str(phys)])
    elif phys.with_suffix(".py").is_file():
        spec = importlib.util.spec_from_file_location(full, phys.with_suffix(".py"))
    else:
        return None
    if spec is None or spec.loader is None:
        return None

    # 父链逐级 import（只可能有宿主真实包，否则 return None）
    parent = importlib.import_module(_APP_PACKAGE)
    prefix = _APP_PACKAGE
    for seg in parts[:-1]:
        prefix += "." + seg
        try:
            parent = importlib.import_module(prefix)
        except ImportError:
            return None

    mod = importlib.util.module_from_spec(spec)
    sys.modules[full] = mod          # 先注册再执行（循环 import 场景的标准姿势）
    try:
        spec.loader.exec_module(mod)
    except Exception:
        sys.modules.pop(full, None)
        raise
    setattr(parent, parts[-1], mod)  # 让 `from 包 import 名` 在 getattr 阶段也命中
    return mod


def mount_installed(*, base: Path | None = None) -> list[str]:
    """扫描隔离区，把已装插件 provides 的缺失模块别名挂进 app.* 命名空间。

    返回实际挂载的模块全名列表（``app.xxx``）。幂等：真实在位的一律跳过，
    已在 sys.modules 里的也跳过（重复调用安全）。
    """
    root = Path(__file__).resolve().parent if base is None else Path(base)
    mounted: list[str] = []
    if not root.is_dir():
        return mounted
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith(("_", ".")):
            continue
        try:
            data: Any = json.loads((d / MANIFEST_NAME).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        backend = data.get("backend") if isinstance(data, dict) else None
        provides = backend.get("provides") if isinstance(backend, dict) else None
        if not isinstance(provides, list):
            continue
        for dotted in provides:
            if not isinstance(dotted, str) or not dotted:
                continue
            full = f"{_APP_PACKAGE}.{dotted}"
            if full in sys.modules or _real_module_exists(dotted):
                continue                     # 铁律 1：宿主优先
            try:
                mod = _alias_module(d, dotted)
            except Exception:
                continue                     # 铁律 2：坏一个插件不连坐
            if mod is not None:
                mounted.append(full)
    return mounted
