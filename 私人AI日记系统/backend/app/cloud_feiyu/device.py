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


# ────────────────────────── 插件命令识别（2026-10-24）──────────────────────────
# AstrBot 的命令匹配是**纯字符串**判断（core/star/filter/command.py:202）：
#     if message_str.startswith(f"{full_cmd} ") or message_str == full_cmd
# 也就是说命令必须出现在消息**最开头**。
#
# 而桌宠原来每条消息都拼成 `[电脑桌宠] [设备上下文] … 用户说：{原文}`，
# 于是 /setu_file、/p、/余额、/签到 这些**永远不在开头** → 全部被当成闲聊交给 LLM，
# 她只好编一段"好，就这张：xxx.png"冒充执行结果（用户实拍，WiFi 监听里只有 speak、
# 一个 agent_image 都没有）。这就是「云端插件全用不了」的真根因。
#
# 修复：命令类消息**原样发送**（不加任何前缀），闲聊才带设备上下文。
# 命令本来就由插件直接处理、不经过 LLM 判断，丢掉设备上下文没有损失。
_PLUGIN_COMMANDS = (
    "setu_now", "setu_file", "setu",
    "p", "签到", "签到状态", "签到成就", "签到日历", "刷新背景", "签到帮助",
    "余额", "birthday_now", "reset", "help", "帮助",
    "启用api", "禁用api", "开启解析", "关闭解析", "lmem", "表情管理",
    "点歌", "画",
)


def is_plugin_command(message: str) -> bool:
    """这条消息是不是发给 AstrBot 插件的命令。

    判据（任一即算）：
      1. 以 `/` 或 `！`/`!` 开头 —— AstrBot 的标准命令前缀；
      2. 以表格里登记的插件命令名开头（覆盖「来3张千恋万花」「听听茉子」这类
         **自然语言命令**：它们的 filter 是 regex/关键词，同样要求出现在开头）。
    """
    text = str(message or "").strip()
    if not text:
        return False
    if text[0] in "/!！":
        return True
    lowered = text.lower()
    for name in _PLUGIN_COMMANDS:
        token = name.lower()
        if lowered == token or lowered.startswith(token + " "):
            return True
        # 中文命令后面直接跟数字/标点（`来3张千恋万花` 这种把数字夹在中间的另算）
        if lowered.startswith(token) and len(token) > 1 and not token.isascii():
            return True
    # 「来3张千恋万花」「听听茉子」这类：动词 + 数量/角色名，交给关键词兜底
    if any(key in text for key in ("千恋万花", "听听茉子", "听听小春", "听听蕾娜",
                                   "听听丛雨", "听听芦花", "听听芳乃")):
        return True
    return False
