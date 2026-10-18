"""Mode strategies and factual operation/usage views shared by the desktop modes."""
from datetime import datetime, timedelta
from contextlib import closing
import math
import os
import signal
import threading
import time

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import db, model_runtime as runtime
from ..config import SettingsConflictError

router = APIRouter(prefix="/api/runtime", tags=["runtime"])


class PolicyChange(BaseModel):
    revision: int = Field(ge=0)
    selection: str
    model_id: str = Field(default="", max_length=200)
    reasoning_level: str = Field(default="inherit", max_length=40)
    enabled: bool = True


@router.get("/policies")
async def policies():
    return {"policies": [runtime.model_policy(mode) for mode in runtime.MODES]}


@router.put("/policies/{mode}")
async def update_policy(mode: str, payload: PolicyChange):
    try:
        values = payload.model_dump(exclude={"revision"})
        return runtime.save_model_policy(mode, values, expected_revision=payload.revision)
    except SettingsConflictError as exc:
        raise HTTPException(409, {"code": "settings_conflict", "message": str(exc)}) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/operations")
async def operations(mode: str = "", conversation_id: str = "", task_id: str = "", request_id: str = "",
                     limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    clauses, parameters = [], []
    for key, value in {"mode": mode, "conversation_id": conversation_id, "task_id": task_id, "request_id": request_id}.items():
        if value:
            clauses.append(f"{key}=?"); parameters.append(value)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with closing(db.get_conn()) as conn:
        rows = conn.execute("SELECT * FROM runtime_operations" + where + " ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?", (*parameters, limit+1, offset)).fetchall()
        result = []
        for row in rows[:limit]:
            item = dict(row)
            item["calls"] = [dict(call) for call in conn.execute("SELECT * FROM runtime_model_calls WHERE operation_id=? ORDER BY started_at,id", (row["id"],))]
            result.append(item)
    return {"operations": result, "has_more": len(rows)>limit, "active": runtime.live_operations()}


@router.get("/usage")
async def usage(days: int = Query(30, ge=1, le=365)):
    start = (datetime.fromisoformat(db.now_iso()) - timedelta(days=days)).isoformat(timespec="seconds")
    with closing(db.get_conn()) as conn:
        rows = conn.execute("SELECT mode,status,prompt_tokens,completion_tokens,cost_yuan,cost_source,duration_ms FROM runtime_model_calls WHERE started_at>=?", (start,)).fetchall()
    modes = []
    for mode in runtime.MODES:
        selected = [row for row in rows if row["mode"] == mode]
        durations = sorted(row["duration_ms"] for row in selected if row["duration_ms"] is not None)
        known = [row for row in selected if row["cost_yuan"] is not None]
        modes.append({"mode": mode, "calls": len(selected), "failed": sum(row["status"] == "failed" for row in selected),
                      "prompt_tokens": sum(row["prompt_tokens"] for row in selected),
                      "completion_tokens": sum(row["completion_tokens"] for row in selected),
                      "known_cost_yuan": sum(row["cost_yuan"] for row in known),
                      "provider_reported_cost_yuan": sum(row["cost_yuan"] for row in known if row["cost_source"] == "provider_reported"),
                      "unknown_cost_calls": len(selected)-len(known),
                      "p95_duration_ms": durations[math.ceil(len(durations)*.95)-1] if durations else None})
    return {"days": days, "modes": modes, "scope": "模型运行时启用后的请求"}


# ─────────────────────────────────────────────────────────────────────────────
# 自关闭（2026-10-18 修 bug：退出桌宠不彻底，只结束 UI 没结束后端）
#
# 背景：后端由 start_mio.ps1 用 Start-Process 起成**独立隐藏进程**，与 Electron
#   桌宠没有任何父子关系。桌宠点「退出」只走 app.quit()，后端继续占着 :8000；
#   下次 DSH 升级换 host 端口时就会撞上「端口被占」。
#
# 修法：桌宠在 before-quit 里先 POST 本端点 → 后端**走正常 lifespan 清理**再退出
#   （而不是被强杀），桌宠侧若调用失败再回退到「按端口 + 命令行精确匹配」杀进程。
#
# 安全：只接受**本机回环**请求（127.0.0.1 / ::1）。这个进程只监听 127.0.0.1，
#   但显式再校验一次 —— 一个能关掉后端的端点不该有任何被外部触达的可能。
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/self-shutdown")
async def self_shutdown(request: Request):
    client_host = (request.client.host if request.client else "") or ""
    if client_host not in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}:
        raise HTTPException(status_code=403, detail="只接受本机回环请求。")

    def _die() -> None:
        # 留一点时间把响应写回去，再给主进程发 SIGTERM —— uvicorn 收到后
        # 正常走 lifespan.shutdown（关边车、存状态），不是硬杀。
        time.sleep(0.4)
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=_die, name="self-shutdown", daemon=True).start()
    return {"ok": True, "message": "后端正在关闭"}
