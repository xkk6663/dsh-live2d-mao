"""设备在线状态管理 —— 桌宠上线/下线时本地显示通知。

原理：不调用云端 IM API 注入聊天历史（避免污染大肥鱼上下文、浪费 token），
只通过本地 WebSocket 推送给桌宠气泡显示"电脑端大肥鱼上线了/下线了"。
"""

from __future__ import annotations

import logging

from .client import CloudFeiyuClient

logger = logging.getLogger("cloud_feiyu.devices")


# 已知设备列表（后续可扩展）
KNOWN_DEVICES = {
    "weixin": "手机微信",
    "mao-pet": "电脑桌宠",
    "esp32": "ESP32 硬件屏",
}


async def notify_device_online(client: CloudFeiyuClient, device_id: str = "mao-pet") -> bool:
    """本地显示：桌宠已上线。"""
    message = "电脑端大肥鱼上线了"
    return await _send_local_notification(message)


async def notify_device_offline(client: CloudFeiyuClient, device_id: str = "mao-pet") -> bool:
    """本地显示：桌宠已下线。"""
    message = "电脑端大肥鱼下线了"
    return await _send_local_notification(message)


async def _send_local_notification(message: str) -> bool:
    """通过本地 WebSocket 推送系统消息到桌宠气泡。"""
    try:
        from ...services.pet_event_service import pet_event_service
        pet_event_service.publish("agent_stream", {
            "text": message,
            "agent_id": "system",
        })
        logger.info("本地推送设备状态通知: %s", message)
        return True
    except Exception as exc:
        logger.warning("本地设备状态推送失败: %s", exc)
        return False
