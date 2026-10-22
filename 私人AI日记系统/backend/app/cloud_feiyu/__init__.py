"""云端大肥鱼（AstrBot）客户端模块。

让本地桌宠接入云端 AstrBot 的大肥鱼 persona，
共享同一人格、长期记忆和插件能力。
"""

from .client import CloudFeiyuClient, FeiyuMessage, get_client
from .device import build_device_context, get_device_caps, get_dsh_status, get_system_info
from .devices import notify_device_online, notify_device_offline

__all__ = [
    "CloudFeiyuClient",
    "FeiyuMessage",
    "get_client",
    "build_device_context",
    "get_device_caps",
    "get_dsh_status",
    "get_system_info",
    "notify_device_online",
    "notify_device_offline",
]
