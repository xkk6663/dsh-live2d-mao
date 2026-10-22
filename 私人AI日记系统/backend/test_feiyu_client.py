"""云端大肥鱼客户端测试脚本。

运行：
    python test_feiyu_client.py
"""

import asyncio
import os
import sys

# 设置 API Key
os.environ.setdefault("ASTRBOT_API_KEY", "")  # 从 .env 或环境变量提供，切勿硬编码
os.environ.setdefault("ASTRBOT_BASE_URL", "http://127.0.0.1:6185")

# 添加后端路径
sys.path.insert(0, os.path.dirname(__file__))

from app.cloud_feiyu import get_client, build_device_context


async def test_chat():
    client = get_client()
    print(f"配置: base_url={client.base_url}")
    print(f"session_id={client.session_id}")
    print(f"configured={client.is_configured}")
    print()

    print("=== 设备上下文 ===")
    print(build_device_context())
    print()

    print("=== 发送消息测试 ===")
    print("发送：你好，我是桌宠")
    print("等待回复...")
    reply = await client.chat("你好，我是桌宠")
    print(f"\n大肥鱼回复：{reply.content}")
    print(f"\n（原始 chunks 数: {reply.raw.get('chunks', 0)}）")


if __name__ == "__main__":
    asyncio.run(test_chat())
