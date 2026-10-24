"""桌宠设备能力 —— 大肥鱼在桌宠端可用的工具和状态。

参考小智 ESP32 模式：设备端能力封装成工具，云端按需调用。
当前版本：先做状态注入（轻量），后续升级为标准 MCP server。
"""

from __future__ import annotations

import platform
import os
import re
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
#
# ★★ 2026-10-24 二次修正（用户反馈「来」「看」这两个关键词没进表）：
#   上一版只登记了 `/xxx` 形式和少数几个词，漏掉了最常用的两个**自然语言命令族**：
#     · 「来N张千恋万花」   —— koiuta 的 @filter.regex(r"来(\d+)?张千恋万花")
#     · 「看看色色/看看甜妹/看看腿…」 —— apis 插件按 parts[0] 精确查关键词表
#   两个族的判定规则**不同**，必须分开处理（详见 is_plugin_command 注释）。

# ① 斜杠命令（AstrBot 标准前缀，直接放行）
_SLASH_PREFIXES = ("/", "!", "！")

# ② 斜杠命令名（不含 `/`，用于 `!余额` 这类另一种前缀；也便于补登记新命令）
_PLUGIN_COMMANDS = (
    "setu_now", "setu_file", "setu",
    "p", "签到", "签到状态", "签到成就", "签到日历", "刷新背景", "签到帮助",
    "余额", "birthday_now", "reset", "help", "帮助", "查看api", "api列表",
    "启用api", "禁用api", "开启解析", "关闭解析", "lmem", "表情管理",
    "点歌",
)

# ③ 「来…」族之一：koiuta 资源包，regex `来(\d+)?张千恋万花`
_LAI_RESOURCE_RE = re.compile(r"来\s*\d*\s*张\s*千恋万花")

# ③b 「来…」族之二：**get_px 的 AUTO_TRIGGER_PATTERN**（这才是"来"字最常用的归属）
#     插件原文：`r"^/?(来\s*(.*?)(份|个|张|点))(.*?)(福利|色|瑟|涩|塞)?图$"`
#     覆盖：来张涩图 / 来一份图 / 来三张初音ミク图 / 来点色图 …
#     它是**用户实测"来张涩图"没响应的直接原因** —— 上一版只登记了千恋万花。
_LAI_IMAGE_RE = re.compile(
    r"^/?(?:来\s*(?:.*?)(?:份|个|张|点))(?:.*?)(?:福利|色|瑟|涩|塞)?图$"
)

# ④ 「听听XX」族：koiuta 的 @filter.regex(r"听听(茉子|小春|蕾娜|丛雨|芦花|芳乃)")
_LISTEN_RE = re.compile(r"听听\s*(?:茉子|小春|蕾娜|丛雨|芦花|芳乃)")

# ⑤ 「看看XX」族：apis 插件 `on_message` 取 `parts[0]`（**第一个空格前的一整段**）
#    去查关键词表（presets/api_pool_default.json，76 条）。
#    这些关键词本身就是完整词组（`看看色色`、`看看腿`、`看看甜心`…），
#    所以：**消息以某个「看看XX」开头、且该词组后面没有多余内容**才算命中。
#    注意「看看」后面的词必须是真实关键词之一，不能只凭"看看"两字就放行，
#    否则「看看这个视频」也会被当成命令。
_APIS_PEEK_RE = re.compile(
    r"^看看(?:色色|甜妹|小姐姐|腿|妞|女大|骚的|玉足|帅哥|腹肌|漫画|治愈|emo)"
    r"(?:\s+.*)?$",
    re.IGNORECASE,
)


def is_plugin_command(message: str) -> bool:
    """这条消息是不是发给 AstrBot 插件的命令。

    为什么必须识别准：
      · 判成**命令** → 原样发（不加设备前缀），插件才能命中；
      · 判成**闲聊** → 加设备上下文，让"一个灵魂多个身体"成立。
    两边判错都有代价，所以按各插件**真实 filter 规则**分别匹配，而不是靠猜关键词。

    判据（任一即算）：
      1. 以 `/`、`!`、`！` 开头（AstrBot 标准命令前缀）；
      2. 以登记过的命令名开头（`余额`、`签到`、`点歌`…）；
      3. 「来N张千恋万花」类资源拉取（koiuta regex）；
      4. 「听听茉子/小春/…」角色语音（koiuta regex）；
      5. 「看看XX」关键词表（apis 插件，XX 必须是真实关键词）。
    """
    text = str(message or "").strip()
    if not text:
        return False
    if text.startswith(_SLASH_PREFIXES):
        return True

    lowered = text.lower()
    for name in _PLUGIN_COMMANDS:
        token = name.lower()
        if lowered == token or lowered.startswith(token + " "):
            return True
        if not token.isascii() and lowered.startswith(token):
            return True

    if _LAI_RESOURCE_RE.search(text):
        return True
    if _LAI_IMAGE_RE.match(text):
        return True
    if _LISTEN_RE.search(text):
        return True
    if _APIS_PEEK_RE.match(text):
        return True
    return False
