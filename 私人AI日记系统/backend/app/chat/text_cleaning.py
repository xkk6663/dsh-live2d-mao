"""桌宠正文通用文本清洗（v1.4.0 起归主体，随桌宠分发）。

从 cloud_feiyu/client.py 抽出：剥设备上下文前缀、剥工具调用载荷、密钥擦除。
这三件事在 /chat/history 等桌宠核心链路也要用，不能依赖大肥鱼插件
（mao-plugin-feiyu）是否安装。逻辑与 cloud_feiyu 侧保持一致，阶段 3 后
cloud_feiyu 将反向 import 本模块。
"""

from __future__ import annotations

import json
import re
from typing import Any

def strip_device_prefix(text: str) -> str:
    """剥掉"设备上下文 / 用户说："这类**注入前缀**，防止她把它复述进正文。

    桌宠每轮都会在消息前拼：
        [电脑桌宠] [设备上下文] 当前你在桌宠设备上：LAPTOP-XXX (Windows 11)。时间：…可用工具：…
        用户说：<用户原话>
    她偶尔会把这串东西当正文念回来（用户看到的就是"气泡里出现了我的提问"）。
    这里在**出气泡之前**把整段前缀去掉；正文里正常提到"用户说"不会被误伤
    （要求必须是从行首开始的完整前缀形态）。
    """
    if not text:
        return text
    out = text
    # ① 完整形态：[电脑桌宠] ... 用户说：
    out = re.sub(
        r"^\s*\[电脑桌宠\][^\n]*?用户说：\s*",
        "",
        out,
        flags=re.S,
    )
    # ② 只有设备上下文（她只复述了前半段）
    out = re.sub(r"^\s*\[电脑桌宠\][^\n]*?\n", "", out)
    out = re.sub(r"^\s*\[设备上下文\][^\n]*?\n", "", out)
    # ③ 单行里夹着的 "[设备上下文] … 时间：… 可用工具：…"
    out = re.sub(r"\[设备上下文\][^。\n]*。(\s*时间：[^。\n]*。)?(\s*可用工具：[^。\n]*。)?", "", out)
    # ④ 残留的"用户说："
    out = re.sub(r"^\s*用户说：\s*", "", out)
    return out.strip()


# ★ 2026-10-24：正文里"没闭合的 JSON 载荷尾部"的强信号。
#   真实事故：`{"body":{…"response_format":"wav"})\ncmd=['curl','-s', …]` —— 引号没配对、
#   花括号没闭合，json.loads 解不开，旧实现直接整段放过（还带着 Bearer sk-… 密钥）。
#   只看明显不属于人话、却只会出现在载荷里的特征：
#   `\n` 字面量 + `cmd=[`/`command=[`/`subprocess.` + http 动词 + python 代码痕迹。
_TOOL_TAIL_RE = re.compile(
    r"(?:\\ncmd\s*=\s*\[|\\ncommand\s*=\s*\[|\\nsubprocess\.|\"cmd\"\s*:\s*\[|"
    r"\bsubprocess\.Popen\(|\\nprint\((?:'|\")go|"
    r"['\"]-X['\"]\s*,\s*['\"](?:POST|GET|PUT|DELETE)['\"]|"
    r"['\"]Authorization:\s*Bearer\s|"
    r"['\"]--max-time['\"]|\\nstart_new_session\s*=)",
    re.IGNORECASE,
)

# ★★ 2026-10-24 第二轮实拍（更严重）：她手搓 python -c 调 TTS 时，载荷**没有 `{` 开头**，
#   而且密钥被输出成 `Bearer sk-***` 擦除后的样子，正文长这样：
#     语音自检通过。'},ensure_ascii=False)\nfor i in range(3):\n    f='/AstrBot/data/temp/sc%d.mp3'…
#     r=subprocess.run([… 'https://api.siliconflow.cn/v1/audio/speech' …],capture_output=True)
#     print('rc',r.returncode,…)\n""}, "ts": 1792813233.1964512}语音已发送。
#   → 这才是"整段载荷残留"的**标准形态**：`'},ensure_ascii=False)` / `\n` 字面量 /
#     `subprocess.run(` / python 缩进。一律从这里到 `"ts": <数字>}` 整块切掉。
_CODE_PAYLOAD_RE = re.compile(
    r"(?:'?\}\s*,\s*ensure_ascii\s*=|\"ts\"\s*:\s*\d|\},\s*ensure_ascii)",
    re.IGNORECASE,
)
_PY_FRAGMENT_RE = re.compile(
    r"(?:\\n|\n)\s*(?:for\s+\w+\s+in\s+range|if\s+os\.path|if\s+sz|r\s*=\s*subprocess\.|"
    r"subprocess\.|print\(|import\s+os|import\s+sys|f\s*=\s*['\"]/|body\s*=\s*json\.)"
)


# ★ 2026-10-24：载荷字段特征（出现任意一个就说明正文里混进了工具载荷）。
#   之所以需要它：实拍的那段载荷**没有开头的 `{`**（正文先说了十遍"我是大肥鱼"，
#   JSON 头被模型吞掉了，只剩 `','response_format':'wav'})\ncmd=[…` 这半截），
#   "花括号扫描"根本触发不到，于是那种"半截残片"清理必须另走一条路。
_TOOL_FIELD_RE = re.compile(
    r"response_format|\",?\s*ensure_ascii|\}\s*,\s*ensure_ascii|\\ncmd\s*=|\\nsubprocess\.|"
    r"\bsubprocess\.(?:Popen|run)\(|--max-time|\\nprint\(|\\nstart_new_session\s*=",
    re.IGNORECASE,
)
# 命中 _TOOL_FIELD_RE 之后，按这些形态把残片切掉（顺序有讲究：先长后短）
_TOOL_FRAGMENT_RE = re.compile(
    r"\\n(?:cmd|command|subprocess|print|start_new_session)[^\n]*?(?=\\n|\"|\}|$)"
    r"|['\"]?[,\s]*(?:response_format|\"body\"|'body'|'cmd'|\"cmd\"|'ts'|\"ts\")[^\n]*?"
    r"(?=\}[\"']?\s*,\s*\"ts\"|[\u4e00-\u9fff]|$)",
    re.IGNORECASE | re.DOTALL,
)

# ★★ 2026-10-24 用户实拍（截图）：JSON 头被模型吞了，只剩一段**反序列化残渣**：
#     「随机二次元图片 涩图"}, "ts": 1792833795.098908}哼，没卡，我在翻图呢…
#   特征非常干净：`"},` 或 `"}` 收尾的引号 + 一个 `"ts": <数字>}` 时间戳。
#   上面的 _TOOL_FIELD_RE 只认 response_format/subprocess 这些字段名，**认不出 ts**，
#   于是整段残渣（连同上一条工具调用的参数）上了屏。
#   这条规则只看形状不看字段名，所以对"随机图片/搜索/发消息"任何工具都通用。
#
#   安全性（宁可少吞不可误伤）：
#     · 必须同时出现「右引号收尾的残片」**和**「`"ts": 数字`」，缺一不切；
#     · 只在文本**靠前**（第一个中文字符之前，或整段前 200 字符内）命中才算 ——
#       用户/角色正常说话里几乎不会连续出现 `"}, "ts": 1792833795.098908}` 这种串；
#     · 切完若把正文切空了，回退到原文（交给后面的段落处理），不会吐空。
_TS_RESIDUE_RE = re.compile(r"\"\}\s*,\s*\"ts\"\s*:\s*[\d.eE+-]+\s*\}")


def scrub_secrets(text: str) -> str:
    """把泄漏进正文的密钥/令牌擦成 `sk-***`。

    ★ 2026-10-24 用户实拍事故：她为了做 TTS 自己手搓 curl，
      整段 `Authorization: Bearer sk-kbmvfnt…` 被当成普通文字显示在对话界面里。
      这是**真实可用的密钥**，必须保证无论载荷剥没剥干净，它都不会出现在界面上。
    """
    if not text:
        return text
    out = re.sub(r"(Bearer\s+)([A-Za-z0-9_\-\.]{12,})", r"\1sk-***", text)
    out = re.sub(r"\b(sk|ak|abk)-[A-Za-z0-9_\-]{12,}", r"\1-***", out)
    out = re.sub(r"\b(api[_-]?key|token|secret)(\s*[\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9_\-]{16,})",
                 r"\1\2***", out, flags=re.IGNORECASE)
    return out


def strip_tool_payload(text: str) -> str:
    """去掉正文里夹带的**工具调用原始载荷**。

    真实事故（2026-10-22，多次复现）：
      她调用工具的那一轮，`complete.data` 会把工具调用和回执直接混进正文，形如：
        {"id": "call_00_Xspb…", "name": "send_message_to_user", "args": {...}, "ts": …}
        又怎么了，接着。
        {"id": "call_00_Xspb…", "ts": …, "result": "Message sent to session webchat:…"}
        一张一张地要，你是要把我图库搬空啊。喏，这张拿去。

    也就是说：**整段是纯 JSON** 的情况很少，更常见的是"JSON 和正文交替出现"。
    以前的实现只处理"整段就是一个 JSON"，所以漏了。

    现在的策略（保守，宁可少吞不可误伤）：
      逐行处理，**丢弃"整行是一个完整 JSON 对象/数组、且含工具特征键"的行**；
      其余行原样保留。这样"又怎么了，接着。"这种正常正文仍在。
    """
    if not text:
        return text

    def is_tool_payload(data: Any) -> bool:
        keys: set[str] = set()

        def collect(node, depth=0):
            if depth > 3:
                return
            if isinstance(node, dict):
                keys.update(str(k).lower() for k in node.keys())
                for v in node.values():
                    collect(v, depth + 1)
            elif isinstance(node, list):
                for v in node[:5]:
                    collect(v, depth + 1)

        collect(data)
        strong = {"tool_calls", "function", "arguments", "args", "result", "call_id",
                  # ★ 2026-10-24 实测：她**自己手搓 shell 命令**调 TTS 的那一轮（用
                  #   siliconflow /audio/speech 生成 fish10.wav），载荷整段是
                  #   {"body": {"input":"我是大肥鱼。…","response_format":"wav"},
                  #    "cmd": ["curl","-s","--max-time","90","-X","POST", …],
                  #    "ts": 1792812592.36}
                  #   只有一个 `body`+`cmd`+`ts`，上面这些强特征键一个都没有 →
                  #   整段裸 JSON 漏进了对话界面（用户实拍，一大段 sk- 密钥暴露在屏幕上）。
                  "cmd", "cmdline", "command", "shell", "exec", "script",
                  "stdout", "stderr", "body", "headers", "url", "endpoint"}
        if keys & strong:
            return True
        # 回执形态：只有 id/ts/result 这类键、没有自然语言正文
        if {"id", "ts"} <= keys and len(keys) <= 6:
            return True
        # 执行型载荷：cmd / body / command 之一 + 没有一段像人话的正文
        if keys & {"cmd", "body", "command", "script", "exec"}:
            has_prose = False

            def find_prose(node, depth=0):
                nonlocal has_prose
                if has_prose or depth > 3:
                    return
                if isinstance(node, dict):
                    for v in node.values():
                        find_prose(v, depth + 1)
                elif isinstance(node, list):
                    for v in node[:8]:
                        find_prose(v, depth + 1)
                elif isinstance(node, str):
                    # 有十几个字以上、且不是路径/命令行/URL 的字符串，才当作"人话"。
                    # ★ 注意 JSON 是**反斜杠转义原始文本**时解不开（`\ncmd=[...`），
                    #   这时整段会被当普通字符；下面的"未闭合 JSON"兜底负责这种情况。
                    s = node.strip()
                    if (len(s) >= 12 and not s.startswith(("/", "http", "-", "curl", "python"))
                            and not re.match(r"^[\w./:-]+$", s)
                            and not s.endswith((".wav", ".mp3", ".json"))):
                        has_prose = True

            find_prose(data)
            return not has_prose
        return False

    def balanced_json_at(s: str, start: int) -> str | None:
        """从 s[start] == '{' 起，找配对 '}' 的位置。

        ★ 2026-10-24 放宽了两点（都是为了实拍的那个未闭合载荷）：
          ① 深度回到 0 时**不要求**它恰好是字符串外 —— 载荷里的引号本身就不配对
             （`{'response_format':'wav'})` 会让 `in_str` 一直是 True，永远等不到闭合）；
          ② 扫描上限 8000 字符，避免在一大段正文里白跑。
        """
        depth = 0
        in_str = False
        esc = False
        limit = min(len(s), start + 8000)
        for i in range(start, limit):
            ch = s[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth <= 0:
                    return s[start:i + 1]
        return None

    # 第 1 段：`{…}` 扫描 —— 能解析且判定为工具载荷的 JSON 整块剥掉，
    # 其余全部原样保留（这样「又怎么了，接着。」和「喏，这张拿去。」都还在）。
    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "{":
            block = balanced_json_at(text, i)
            if block:
                try:
                    data = json.loads(block)
                except Exception:
                    data = None
                if data is not None and is_tool_payload(data):
                    i += len(block)
                    continue
        out.append(ch)
        i += 1
    joined = "".join(out)

    # 第 2 段 ★★ 2026-10-24 两次实拍：**载荷不一定以 `{` 开头**。
    #   模型把 JSON 头吞了，正文里只剩下半截：
    #     我是大肥鱼。'},ensure_ascii=False)\nfor i in range(3):\n    f='/AstrBot/…'
    #   或者 `','response_format':'wav'})\ncmd=['curl',…]`
    #   花括号扫描对它完全无效（一次 `{` 都没遇到），于是整段（含 Bearer 密钥）上了屏。
    #   现在的做法：只要正文里出现**载荷字段特征**，就把从特征处（及其前面的引号残片）
    #   到 `"ts": <数字>}` 之间整块切掉；找不到收尾标记就切到下一个空白行。
    if not joined.strip():
        return scrub_secrets(joined)

    # ★★ 第 2.5 段：反序列化残渣（JSON 头丢了，只剩 `…"}, "ts": 1792833795.098908}`）。
    #   放在字段特征清理**之前**：这种残渣没有 `{` 也没有已知字段名，前面两条都抓不到。
    #   命中位置必须在正文靠前（前 200 字内），避免误伤正文里偶然出现的类似串。
    m_res = _TS_RESIDUE_RE.search(joined)
    if m_res and m_res.start() <= 200:
        head, tail_text = joined[: m_res.start()], joined[m_res.end() :]
        # ★ 残渣左边往往挂着半个开引号：`「随机二次元图片 涩图"}, …`
        #   那是**工具参数值**的起始引号（`"tag": "随机二次元图片 涩图"`），
        #   它连同参数名一起被模型吞掉了，只剩内容和这个孤零零的左引号。
        #   不处理就会留下 `「随机二次元图片 涩图哼，没卡…` 这种粘在一起的东西。
        #   只在这种"左引号后面到残渣之间没有右引号闭合"的形态下才吞，避免误伤正常引用。
        opened = re.search(r"[\"'\u300c\u300e\u201c]([^\"'\u300d\u300f\u201d]*)$", head)
        if opened:
            head = head[: opened.start()]
        candidate = (head + tail_text).strip()
        # 切完不能把话切空；只剩标点碎屑也算"切空"，宁可保留原文让下面几段继续处理
        if re.search(r"[\u4e00-\u9fffA-Za-z]", candidate):
            candidate = re.sub(r"^[\s\"'`\u300d\u300f\u201d]+", "", candidate)
            joined = candidate

    # 第 2 段 ★★ 2026-10-24 两次实拍：**载荷不一定以 `{` 开头**。
    #   模型把 JSON 头吞了，正文里只剩下半截：
    #     我是大肥鱼。'},ensure_ascii=False)\nfor i in range(3):\n    f='/AstrBot/…'
    #   或者 `','response_format':'wav'})\ncmd=['curl',…]`
    #   花括号扫描对它完全无效（一次 `{` 都没遇到），于是整段（含 Bearer 密钥）上了屏。
    #   现在的做法：只要正文里出现**载荷字段特征**，就把从特征处（及其前面的引号残片）
    #   到 `"ts": <数字>}` 之间整块切掉；找不到收尾标记就切到下一个空白行。
    m_field = _TOOL_FIELD_RE.search(joined)
    if m_field:
        start = m_field.start()
        # 往前吃掉紧邻的引号/逗号残片（`','`、`'` 这种），别在正文里留渣
        while start > 0 and joined[start - 1] in " \t\"',)]}:[({":
            start -= 1
        tail = joined[start:]
        m_ts = re.search(r"\"ts\"\s*:\s*\d[\d.eE+-]*\s*\}", tail)
        end = start + m_ts.end() if m_ts else (joined.find("\n\n", start) if joined.find("\n\n", start) >= 0 else len(joined))
        joined = joined[:start] + joined[end:]

    # 第 3 段：python 代码残片（`for i in range(3):` / `r=subprocess.run(` / `print(` …）
    if _PY_FRAGMENT_RE.search(joined):
        joined = re.sub(r"(?:\\n|\n)\s*(?:for\s+\w+\s+in\s+range|if\s+os\.path|if\s+sz|"
                        r"r\s*=\s*subprocess\.|subprocess\.|print\(|import\s+os|import\s+sys|"
                        r"f\s*=\s*['\"]/|body\s*=\s*json\.)[^\n]*?(?=\\n|\n|$)",
                        "", joined)

    # 第 4 段：切完之后常留下 `',}` 这种标点碎屑 → 清掉。
    #   ★ 只在"确实切过载荷"时做：正常的 `{笑}` / `{'a': 1}` 不能被误伤（回归测试里有）。
    if _TOOL_FIELD_RE.search("".join(out)) or _TS_RESIDUE_RE.search(text):
        joined = re.sub(r"[\s,'\"{}()\[\]]{2,}(?=[\u4e00-\u9fff])", " ", joined)
        joined = re.sub(r"^[\s,'\"{}()\[\]\\]+", "", joined)
        # ★ 2026-10-24：整段都是载荷时，清完会剩下 `tag":` 这类孤立键名残片。
        #   只在"确实切过载荷"的分支里做，且只删**末尾**的裸键名形态，正常正文不受影响。
        joined = re.sub(r"[\"'`]?\b(?:tag|id|name|args|ts|type|value|query)\b[\"'`]?\s*:\s*$",
                        "", joined).strip()
    # 第 5 段：最后一道保险 —— 密钥/令牌一律不进界面
    joined = scrub_secrets(joined)
    # ★ 2026-10-24 兜底：整段都是工具载荷、连一句话都没剩下时（`{"tag":` 这种残渣），
    #   宁可**返回空串**（上层就不会发气泡）也不要让半截 JSON 上屏。
    #   判据很保守：清完之后没有任何中文/正常英文单词，只剩下标点和极短残片。
    if not re.search(r"[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}", joined):
        return ""
    return joined
