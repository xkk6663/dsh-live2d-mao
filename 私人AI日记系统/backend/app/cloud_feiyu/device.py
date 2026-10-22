"""桌宠设备能力 —— 大肥鱼在桌宠端可用的工具和状态。

参考小智 ESP32 模式：设备端能力封装成工具，云端按需调用。
当前版本：先做状态注入（轻量），后续升级为标准 MCP server。
"""

from __future__ import annotations

import platform
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class DeviceCapabilities:
    """当前桌宠设备的能力清单。"""
    device_name: str = "windows-pc"
    os: str = ""
    has_screen: bool = True
    has_tts: bool = True
    has_live2d: bool = True
    has_dsh_monitor: bool = True
    tools: list[str] = field(default_factory=list)


def get_device_caps() -> DeviceCapabilities:
    """获取当前设备能力。"""
    return DeviceCapabilities(
        device_name=os.getenv("PET_DEVICE_NAME", platform.node() or "windows-pc"),
        os=f"{platform.system()} {platform.release()}",
        has_screen=True,
        has_tts=True,
        has_live2d=True,
        has_dsh_monitor=True,
        tools=[
            "get_dsh_status",      # 查询 DSH 工作状态
            "get_screen_state",    # 屏幕观察
            "get_system_info",     # 系统信息
            "send_notification",   # 发送桌宠通知
        ],
    )


def build_device_context() -> str:
    """构造设备上下文，注入到发给大肥鱼的消息前面。

    让大肥鱼知道自己当前在哪个设备上，有什么能力。
    """
    caps = get_device_caps()
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    return (
        f"[设备上下文] 当前你在桌宠设备上：{caps.device_name} ({caps.os})。"
        f" 时间：{now}。"
        f" 可用工具：{', '.join(caps.tools)}。"
        f" 你可以调用这些工具获取本地信息。"
    )


def get_dsh_status() -> dict[str, Any]:
    """查询 DSH 当前工作状态。"""
    # TODO: 接入 agent_bus_service 的 12 态
    return {
        "status": "idle",
        "phase": "idle",
        "message": "DSH 当前空闲",
    }


def get_system_info() -> dict[str, Any]:
    """获取系统信息。"""
    return {
        "os": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(),
        "processor": platform.processor(),
        "hostname": platform.node(),
    }
