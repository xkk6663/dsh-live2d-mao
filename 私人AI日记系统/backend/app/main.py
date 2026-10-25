from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import (
    db,
    maintenance_service,
    migration_service,
    onboarding_service,
    runtime_diagnostics,
    subservice_health,
)
from .companion import companion_service, pet_event_service
from .creation import creation_service
from .screen import screen_observation_service
from .kernel import agent_bus_service, agent_task_service
from .agents.dsh import dsh_adapter
from .agents.dsh import routes as dsh_plugin_routes
# 插件市场清单层（docs/插件市场-契约.md）：插件不再是 index.html 里写死的 script
from .routes import plugin_market as plugin_market_routes
# DSH 专用化：octop / xiaozhi 插件已整体移除（本仓只保留 DSH 加强插件）
from . import model_runtime
from .runtime_identity import runtime_identity
from .config import settings
from .companion.companion_action_service import backfill_explicit_structured_memories
from .creation.documents import load_manuals
from .local_security import LocalControlMiddleware, SecureAttachmentFiles
from .routes import (
    backup,
    chat,
    companion,
    conversations,
    creation,
    day,
    diary,
    memory,
    monthly,
    privacy,
    review,
    settings as settings_routes,
    stats,
    weekly,
)


logger = logging.getLogger(__name__)


# 后台任务：仅保留桌宠/小智链路所需（原版 QQ/日记/备份/周月报/费用对账等任务已随功能阉割移除）
BACKGROUND_TASK_FACTORIES = {
    "runtime_diagnostics_task": runtime_diagnostics.monitor_loop,
    "screen_observation_task": screen_observation_service.observation_loop,
    "pet_event_task": pet_event_service.event_loop,
    "agent_bus_task": agent_bus_service.heartbeat_loop,
    "dsh_adapter_task": dsh_adapter.dsh_adapter_loop,
    # DSH 专用化：octop_adapter_task 已移除（Octop 插件整体阉割）
}


def initialize_runtime() -> None:
    """Initialize persistent runtime state only when the application starts."""
    settings.ensure_directories()
    companion_service.cleanup_legacy_preview()
    db.init_db()
    model_runtime.initialize()
    from . import artifact_service
    artifact_service.initialize()
    migration_service.run_migrations()
    onboarding_service.prepare_first_launch_defaults()
    db.cleanup_screen_observation_history(
        retention_days=settings.screen_history_retention_days,
        max_rows_per_table=settings.screen_history_max_rows,
    )
    db.refresh_manual_memories(load_manuals())
    backfill_explicit_structured_memories()
    agent_bus_service.bus.configure(settings.project_root / "agent_bus_config.json")


async def _start_background_tasks(app: FastAPI, *, exclude: set[str] | None = None) -> None:
    excluded = exclude or set()
    for task_name, task_factory in BACKGROUND_TASK_FACTORIES.items():
        if task_name in excluded:
            continue
        current = getattr(app.state, task_name, None)
        if current is not None and not current.done():
            continue
        task = asyncio.create_task(task_factory(), name=task_name)
        setattr(app.state, task_name, task)
        runtime_diagnostics.register_background_task(task_name, task)


async def _stop_background_tasks(app: FastAPI, *, exclude: set[str] | None = None) -> None:
    excluded = exclude or set()
    tasks: list[tuple[str, asyncio.Task]] = []
    for task_name in BACKGROUND_TASK_FACTORIES:
        if task_name in excluded:
            continue
        task = getattr(app.state, task_name, None)
        if task is None:
            continue
        if not task.done():
            task.cancel()
        tasks.append((task_name, task))
    if tasks:
        results = await asyncio.gather(*(task for _, task in tasks), return_exceptions=True)
        for (task_name, _), result in zip(tasks, results):
            if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                logger.error("后台任务关闭时异常：%s: %s", task_name, result)
    for task_name, _ in tasks:
        runtime_diagnostics.unregister_background_task(task_name)
        setattr(app.state, task_name, None)


@asynccontextmanager
async def app_lifespan(app: FastAPI):
    app.state.runtime_event_loop = asyncio.get_running_loop()
    maintenance_service.reset_runtime_state()
    initialize_runtime()
    agent_task_service.recover_interrupted()
    await creation_service.resume_active_jobs()
    await _start_background_tasks(app)
    # DSH 专用化：小智 TTS 预合成任务已移除（xiaozhi 插件整体阉割，符合裁决 D1）
    maintenance_lock = asyncio.Lock()

    async def enter_maintenance(reason: str) -> dict[str, object]:
        await maintenance_lock.acquire()
        maintenance_started = False
        try:
            maintenance_service.begin(reason)
            maintenance_started = True
            await model_runtime.cancel_operations(reason="maintenance")
            await creation_service.shutdown()
            await _stop_background_tasks(app, exclude={"runtime_diagnostics_task"})
            await asyncio.to_thread(maintenance_service.wait_for_quiescence, 30)
            return maintenance_service.status()
        except BaseException:
            if maintenance_started:
                maintenance_service.finish("maintenance_failed", keep_blocked=False)
                await creation_service.resume_active_jobs()
                await _start_background_tasks(app, exclude={"runtime_diagnostics_task"})
            if maintenance_lock.locked():
                maintenance_lock.release()
            raise

    async def finish_maintenance(status: str, *, resume: bool) -> dict[str, object]:
        try:
            maintenance_service.finish(status, keep_blocked=not resume)
            if resume:
                await creation_service.resume_active_jobs()
                await _start_background_tasks(app, exclude={"runtime_diagnostics_task"})
            return maintenance_service.status()
        finally:
            if maintenance_lock.locked():
                maintenance_lock.release()

    app.state.enter_maintenance = enter_maintenance
    app.state.finish_maintenance = finish_maintenance
    try:
        yield
    finally:
        # 通知云端大肥鱼：桌宠下线了
        try:
            from .cloud_feiyu import get_client as get_feiyu_client
            from .cloud_feiyu.devices import notify_device_offline
            feiyu = get_feiyu_client()
            if feiyu.is_configured:
                await notify_device_offline(feiyu)
                logger.info("已通知云端大肥鱼：桌宠下线")
        except Exception:
            logger.debug("通知云端下线失败", exc_info=True)
        await model_runtime.cancel_operations(reason="shutdown")
        await _stop_background_tasks(app)
        await creation_service.shutdown()
        try:
            companion_service.shutdown()
        except Exception:
            logger.exception("关闭后端时清理桌宠资源失败")
        maintenance_service.reset_runtime_state()


def create_app() -> FastAPI:
    app = FastAPI(title="私人 AI 日记系统", lifespan=app_lifespan)
    from .routes.runtime import router as runtime_router
    app.include_router(runtime_router)
    from .routes.artifacts import router as artifacts_router
    app.include_router(artifacts_router)

    @app.exception_handler(model_runtime.OperationBlocked)
    async def operation_blocked(_request, error):
        return JSONResponse(status_code=409, content={"detail": {"code": "operation_blocked", "message": str(error)}})
    app.add_middleware(LocalControlMiddleware)

    @app.middleware("http")
    async def enforce_maintenance_mode(request, call_next):
        method = request.method.upper()
        path_parts = [part for part in request.url.path.rstrip("/").split("/") if part]
        is_restore_request = (
            method == "POST"
            and len(path_parts) == 4
            and path_parts[:2] == ["api", "backups"]
            and path_parts[-1] == "restore"
        )
        if method not in {"POST", "PUT", "PATCH", "DELETE"} or is_restore_request:
            return await call_next(request)
        try:
            with maintenance_service.mutation_scope():
                return await call_next(request)
        except maintenance_service.MaintenanceModeError as exc:
            return JSONResponse(
                status_code=503,
                headers={"Retry-After": "5"},
                content={
                    "detail": str(exc),
                    "maintenance": maintenance_service.status(),
                },
            )

    @app.middleware("http")
    async def collect_runtime_diagnostics(request, call_next):
        request_id = runtime_diagnostics.request_started(request.method, request.url.path)
        try:
            response = await call_next(request)
        except BaseException as exc:
            runtime_diagnostics.request_finished(
                request_id,
                status_code=None,
                error=type(exc).__name__,
            )
            raise
        runtime_diagnostics.request_finished(request_id, status_code=response.status_code)
        return response

    app.mount("/static", StaticFiles(directory=str(settings.static_dir)), name="static")
    app.mount("/local-site", StaticFiles(directory=str(settings.site_custom_dir), check_dir=False), name="local-site")
    app.mount("/photos", StaticFiles(directory=str(settings.photo_dir), check_dir=False), name="photos")
    app.mount(
        "/agent-files",
        SecureAttachmentFiles(directory=str(settings.agent_attachment_dir), check_dir=False),
        name="agent-files",
    )
    app.include_router(chat.router)
    app.include_router(backup.router)
    app.include_router(companion.router)
    app.include_router(conversations.router)
    app.include_router(creation.router)
    app.include_router(diary.router)
    app.include_router(day.router)
    app.include_router(memory.router)
    app.include_router(monthly.router)
    # DSH 专用化：onboarding 路由已移除（首次进入不再有六步质检流程）
    app.include_router(privacy.router)
    app.include_router(review.router)
    app.include_router(settings_routes.router)
    app.include_router(stats.router)
    app.include_router(weekly.router)
    # DSH 专用化：xiaozhi.router 已移除（小智插件整体阉割）
    # 插件包自带的 HTTP 面（装配职责留在 kernel/main，插件自己不抢装配权）。
    # 每个插件包对外只暴露自己的前缀，互不 import。
    app.include_router(dsh_plugin_routes.router)
    app.include_router(plugin_market_routes.router)
    # 云端大肥鱼 MCP 工具端点
    from .cloud_feiyu.mcp_routes import router as feiyu_mcp_router
    app.include_router(feiyu_mcp_router)

    # 启动时上报桌宠设备在线
    async def _notify_feiyu_online():
        from .cloud_feiyu import get_client, notify_device_online
        client = get_client()
        if client.is_configured:
            await notify_device_online(client, "mao-pet")
            logger.info("已通知云端大肥鱼：桌宠设备上线")

    # ★ 只有跑在事件循环里（uvicorn 启动 / lifespan）才能直接 create_task。
    #   裸 import app.main（自检、脚本、TestClient 之外的探测）时没有 running loop，
    #   asyncio.create_task 会抛 RuntimeError 把整个模块 import 炸掉——
    #   表现为「写端点安全栅栏端到端（中间件兜底） RuntimeError: no running event loop」。
    #   那就退一步用 sync startup 钩子：等服务真正启动时再交给循环。
    def _kickoff_feiyu_online():
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 不在循环里：注册一次性 startup 回调，服务起来那一刻再发
            app.add_event_handler("startup", _notify_feiyu_online)
            return
        loop.create_task(_notify_feiyu_online())

    _kickoff_feiyu_online()

    if settings.agent_frontend_dir.exists():
        agent_frontend_root = settings.agent_frontend_dir.resolve()

        @app.get("/agent-app", include_in_schema=False)
        async def agent_app_redirect():
            return RedirectResponse(url="/agent-app/")

        @app.get("/agent-app/{asset_path:path}", include_in_schema=False)
        async def agent_app(asset_path: str):
            requested = (agent_frontend_root / asset_path).resolve()
            if requested.is_relative_to(agent_frontend_root) and requested.is_file():
                relative_parts = requested.relative_to(agent_frontend_root).parts
                cache_control = (
                    "no-store"
                    if requested.name == "index.html" or "live2d-pet" in relative_parts
                    else "no-cache"
                )
                return FileResponse(requested, headers={"Cache-Control": cache_control})
            return FileResponse(
                agent_frontend_root / "index.html",
                headers={"Cache-Control": "no-store"},
            )

    @app.get("/")
    async def root():
        return RedirectResponse(url="/agent-app/")

    @app.get("/health")
    async def health():
        identity = runtime_identity()
        return {
            "ok": True,
            "project_root": str(settings.project_root),
            "db_path": str(settings.db_path),
            "diary_dir": str(settings.diary_dir),
            "exe_path": identity["exe_path"],
            "build_id": identity["build_id"],
            "runtime_root": identity["runtime_root"],
            "state_root": identity["state_root"],
            "database_path": identity["database_path"],
            "runtime_identity": identity,
            "runtime_diagnostics": runtime_diagnostics.snapshot(),
            "subservices": subservice_health.snapshot(),
            "maintenance": maintenance_service.status(),
        }

    return app


app = create_app()
