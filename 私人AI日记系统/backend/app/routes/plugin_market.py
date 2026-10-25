"""插件市场 · HTTP 面（``/api/plugin/market``）。

契约：``docs/插件市场-契约.md`` §2。本文件是**唯一实现对外的门**，
业务规则全部在 ``app/kernel/plugin_market_service.py`` 里，路由只做三件事：

1. 收参数（Pydantic 模型，缺字段由 FastAPI 自动回 422）；
2. 调 service；
3. 把 service 抛的**领域异常**翻译成 HTTP 状态码。

为什么异常翻译不写在每个端点的 try 里：那样 8 个端点各写一遍，
将来加一个异常类型就要改 8 处，必漏。
这里在 router 上挂一个异常处理器，一处覆盖全部（见 ``_install_error_handlers``）。

安全：**不在这里造鉴权**。写端点靠全站 ``LocalControlMiddleware``
（``app/local_security.py``：只接受回环 Host + 同源 Origin + 拒 cross-site），
与 ``/api/plugin/dsh/*`` 是同一把锁。重复实现只会让两处口径漂移。

前缀刻意独立于 ``/api/plugin/dsh``：``dsh_adapter_selftest`` 里有一条**硬断言**
的路由白名单（只覆盖 ``/api/plugin/dsh/*``），独立前缀保证本模块的增删
永远不会让那条断言无辜变红。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Body, Response
from fastapi.responses import JSONResponse

from ..kernel import plugin_market_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugin/market", tags=["plugin:market"])


# ---------------------------------------------------------------------------
# 异常 → HTTP 状态码（单一落点）
# ---------------------------------------------------------------------------
def _error_response(exc: plugin_market_service.PluginMarketError) -> JSONResponse:
    """领域异常 → JSON 错误响应。

    返回体形状刻意与 FastAPI 的 ``{"detail": ...}`` 对齐：前端市场面板有一套
    "把 detail 原样回显到表单下方"的逻辑，多一种形状就得多一个 if 分支。
    契约要求"错误信息里带具体路径，前端直接回显"，所以 detail 是**人话**。
    """
    return JSONResponse(status_code=exc.status, content={"detail": str(exc)})


@router.get("/catalog")
async def market_catalog() -> dict[str, Any]:
    """全量清单 + 每个条目的实时状态（契约 §2.1 的 ``Entry+State``）。

    这是插件加载器的**唯一入口**：``kernel/plugin-loader.js`` 与
    ``live2d-pet/plugin-bus.js`` 都从这里拿"该加载谁"。因此本端点必须是
    **只读、幂等、可任意并发调用**的——不做任何副作用。

    首次调用时（磁盘上还没有清单）会自动落一份默认清单，
    所以前端拿到的第一个响应就已经是 3 条完整数据，不需要额外的"初始化"步骤。
    """
    try:
        return await asyncio.to_thread(plugin_market_service.snapshot_with_state)
    except plugin_market_service.PluginMarketError as exc:
        return _error_response(exc)


@router.get("/plugins/{agentId}")
async def market_plugin(agentId: str) -> Response:
    """单条（含实时状态）。不存在 → 404。

    用 ``Response`` 返回而不是 dict，是因为要在这里给出 404 ——
    返回值类型写成 dict 时 FastAPI 会把 JSONResponse 当成"响应体"序列化。
    """
    try:
        entry = await asyncio.to_thread(plugin_market_service.get, agentId)
    except plugin_market_service.PluginMarketError as exc:
        return _error_response(exc)
    if entry is None:
        return JSONResponse(status_code=404, content={"detail": f"插件不存在：{agentId}"})
    return JSONResponse(content={"ok": True, "plugin": entry})


@router.post("/plugins")
async def market_add(payload: dict[str, Any] = Body(...)) -> Response:
    """上架：登记一个**已经放在 ``dist/plugins/`` 里**的插件。

    成功 200 + ``{ok, plugin}``；重名 409（契约）；校验失败 400（含**具体路径**）。

    为什么用裸 ``dict`` 而不是 Pydantic 模型：
    契约把校验规则（agentId 正则、路径边界、重名）全放在后端 service 里，
    那才是唯一出处。这里再写一份模型，就会出现"Pydantic 先报 422、
    service 永远不报 400"的口径分裂，而前端只认 400 里的路径提示。
    （缺 body 仍然由 FastAPI 自动回 422，那一条不需要模型。）
    """
    try:
        entry = await asyncio.to_thread(plugin_market_service.add, payload)
    except plugin_market_service.PluginMarketError as exc:
        return _error_response(exc)
    return JSONResponse(status_code=200, content={"ok": True, "plugin": entry})


@router.patch("/plugins/{agentId}")
async def market_patch(agentId: str, payload: dict[str, Any] = Body(...)) -> Response:
    """改元数据：name/version/author/accent/description/category/enabled。

    **不可改** agentId / entry / builtin（契约 §2），传了就 400 ——
    静默忽略会让用户以为改生效了。
    """
    try:
        entry = await asyncio.to_thread(plugin_market_service.patch, agentId, payload)
    except plugin_market_service.PluginMarketError as exc:
        return _error_response(exc)
    return JSONResponse(status_code=200, content={"ok": True, "plugin": entry})


@router.delete("/plugins/{agentId}")
async def market_remove(agentId: str) -> Response:
    """下架：**只移除清单条目，不动磁盘文件**。

    返回 ``{ok, removed, files_kept: true}`` —— ``files_kept`` 是给用户的
    明示承诺（契约 §2 点名要求），前端据此提示"文件还在，随时可以重新上架"。
    builtin → 403。
    """
    try:
        result = await asyncio.to_thread(plugin_market_service.remove, agentId)
    except plugin_market_service.PluginMarketError as exc:
        return _error_response(exc)
    return JSONResponse(status_code=200, content=result)


@router.post("/plugins/{agentId}/enable")
async def market_enable(agentId: str, payload: dict[str, Any] = Body(...)) -> Response:
    """热插拔：``{enabled: bool}``。

    - 内置（builtin）→ 403（它没有启停入口，契约 §2）；
    - 清单里有但**总线未注册** → 自动 ``register`` 再拨开关。
      这一步是必须的：``agent_bus_service.set_enabled`` 对未注册 id 返回 False，
      纯 UI 插件于是"点了启用没反应"。

    返回里的 ``enabled`` 是**总线上的真值**，不是请求值 ——
    前端据它渲染开关状态，才不会出现"按下去了但实际没变"。
    """
    enabled = payload.get("enabled") if isinstance(payload, dict) else None
    if not isinstance(enabled, bool):
        return JSONResponse(
            status_code=400,
            content={"detail": "请求体必须是 {\"enabled\": true|false}"},
        )
    try:
        result = await asyncio.to_thread(plugin_market_service.set_enabled, agentId, enabled)
    except plugin_market_service.PluginMarketError as exc:
        return _error_response(exc)
    return JSONResponse(status_code=200, content=result)


@router.post("/reload")
async def market_reload() -> Response:
    """通告前端重扫 + 返回当前清单。

    服务端唯一的动作是**丢掉内存缓存重新读盘**：清单文件可能被外部工具
    （安装脚本、用户手改）动过，缓存不失效的话市场面板会一直显示旧数据。
    "重扫前端"这件事本身是前端的活（收到响应后调 ``__mioPluginLoader.reload()``），
    后端不越界去驱动前端生命周期。
    """
    try:
        await asyncio.to_thread(plugin_market_service.reload)
        snapshot = await asyncio.to_thread(plugin_market_service.snapshot_with_state)
    except plugin_market_service.PluginMarketError as exc:
        return _error_response(exc)
    return JSONResponse(
        status_code=200,
        content={"ok": True, "plugins": snapshot.get("plugins", [])},
    )


@router.get("/diagnostics")
async def market_diagnostics() -> dict[str, Any]:
    """清单健康度：缺失文件 / 路径越界 / 重名 / 总线未注册。

    逐条穷举（不是只报第一个），前端市场面板一次列全，用户一轮就能修完。
    只读、不做修复——修复是用户的决定。
    """
    try:
        return await asyncio.to_thread(plugin_market_service.diagnostics)
    except plugin_market_service.PluginMarketError as exc:
        # 诊断端点连自己都炸了，说明清单层彻底不可用；这里仍按契约返回结构，
        # 但把 ok 置 False 并带上原因，比 500 更有助于排障。
        logger.exception("插件市场诊断失败")
        return {"ok": False, "checks": [], "error": str(exc)}
