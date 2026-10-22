"""桌宠 MCP 工具端点 —— 让云端大肥鱼能调用本地设备能力。

参考标准 MCP 协议，简化版实现：
- GET  /api/feiyu/mcp/tools   列出可用工具
- POST /api/feiyu/mcp/call    调用工具

后续可升级为标准 streamable_http MCP server。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .device import get_dsh_status, get_system_info, get_device_caps

logger = logging.getLogger("cloud_feiyu.mcp")

router = APIRouter(prefix="/api/feiyu/mcp", tags=["feiyu-mcp"])


# 设备注册表（内存）
_online_devices: dict[str, dict[str, Any]] = {}


def register_device(device_id: str, name: str, os: str, last_seen: datetime | None = None):
    """注册一个在线设备。"""
    _online_devices[device_id] = {
        "device_id": device_id,
        "name": name,
        "os": os,
        "online": True,
        "last_seen": (last_seen or datetime.now()).isoformat(),
    }


def unregister_device(device_id: str):
    """注销一个设备。"""
    if device_id in _online_devices:
        _online_devices[device_id]["online"] = False
        _online_devices[device_id]["last_seen"] = datetime.now().isoformat()


def get_online_devices() -> list[dict[str, Any]]:
    """获取所有在线设备列表。"""
    # 自动注册本机
    caps = get_device_caps()
    register_device("mao-pet", "电脑桌宠", caps.os)
    # 微信默认在线
    if "weixin" not in _online_devices:
        _online_devices["weixin"] = {
            "device_id": "weixin",
            "name": "手机微信",
            "os": "iOS/Android",
            "online": True,
            "last_seen": datetime.now().isoformat(),
        }
    return [d for d in _online_devices.values() if d["online"]]


# 工具注册表
TOOLS: dict[str, dict[str, Any]] = {
    "get_dsh_status": {
        "name": "get_dsh_status",
        "description": "查询 DSH（DeepSeek Harness）当前工作状态，包括 phase、任务进度等",
        "parameters": {"type": "object", "properties": {}},
        "handler": get_dsh_status,
    },
    "get_system_info": {
        "name": "get_system_info",
        "description": "获取当前桌宠设备的系统信息（操作系统、主机名等）",
        "parameters": {"type": "object", "properties": {}},
        "handler": get_system_info,
    },
    "get_online_devices": {
        "name": "get_online_devices",
        "description": "查询当前所有连着大肥鱼的在线设备列表（微信、桌宠、ESP32 等）",
        "parameters": {"type": "object", "properties": {}},
        "handler": get_online_devices,
    },
}


class ToolCallRequest(BaseModel):
    name: str
    arguments: dict[str, Any] = {}


@router.get("/tools")
async def list_tools():
    """列出所有可用工具。"""
    return {
        "tools": [
            {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            }
            for t in TOOLS.values()
        ]
    }


@router.post("/call")
async def call_tool(req: ToolCallRequest):
    """调用指定工具。"""
    tool = TOOLS.get(req.name)
    if not tool:
        raise HTTPException(status_code=404, detail=f"工具不存在: {req.name}")

    handler = tool["handler"]
    try:
        result = handler(**req.arguments) if req.arguments else handler()
        return {"ok": True, "result": result}
    except Exception as exc:
        logger.exception("工具调用失败: %s", req.name)
        return {"ok": False, "error": str(exc)}


@router.get("/device")
async def device_info():
    """获取设备能力清单。"""
    caps = get_device_caps()
    return {
        "device_name": caps.device_name,
        "os": caps.os,
        "has_screen": caps.has_screen,
        "has_tts": caps.has_tts,
        "has_live2d": caps.has_live2d,
        "tools": caps.tools,
    }
