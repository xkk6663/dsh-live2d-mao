"""从 styles.css 中精确删除 onboarding 相关的 CSS 规则块（一次性脚本）。

为什么不用「按行 grep 删」：onboarding 的选择器常以多行组出现
（`.a,\n.b,\n.onboarding-x { ... }`），按行删会留下孤立的选择器残片或多余的 `}`，
把整个文件的大括号配对破坏掉（本次已踩过：{ 442 vs } 447）。

正确做法：按「规则块」为单位处理——
  1. 从文件里切出顶层规则（选择器 + { ... }），用大括号深度扫描，不依赖正则猜；
  2. 若某条规则的选择器**全部**是 .onboarding-* → 整块删；
  3. 若选择器组里**混有** .onboarding-* 与其它选择器 → 只把 .onboarding-* 那几项从组里摘掉；
  4. 媒体查询（@media … { 内层规则 }）递归同样处理；
  5. 删完校验大括号配对，不配对就报错退出（不写盘）。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

CSS = Path(__file__).resolve().parents[1] / "澪Agent应用" / "src" / "styles.css"
MARK = "onboarding"


def split_rules(body: str) -> list[tuple[str, str]]:
    """把一段 CSS 切成 [(prelude, block)]，block 含外层的 '{' 与 '}'。

    用大括号深度扫描，正确处理嵌套（@media 里的规则）与字符串里的花括号。
    """
    rules: list[tuple[str, str]] = []
    i = 0
    n = len(body)
    while i < n:
        # 跳过空白与注释
        while i < n and body[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        if body.startswith("/*", i):
            end = body.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        # 读 prelude 直到 '{'
        start = i
        depth_quote: str | None = None
        while i < n:
            ch = body[i]
            if depth_quote:
                if ch == "\\":
                    i += 1
                elif ch == depth_quote:
                    depth_quote = None
            elif ch in "\"'":
                depth_quote = ch
            elif ch == "{":
                break
            i += 1
        if i >= n:
            break
        prelude = body[start:i]
        # 读 block（含 {' '}'）
        block_start = i
        depth = 0
        depth_quote = None
        while i < n:
            ch = body[i]
            if depth_quote:
                if ch == "\\":
                    i += 1
                elif ch == depth_quote:
                    depth_quote = None
            elif ch in "\"'":
                depth_quote = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            i += 1
        block = body[block_start:i]
        rules.append((prelude, block))
    return rules


def prune_prelude(prelude: str) -> str | None:
    """从多行选择器组里摘掉 .onboarding-* 项；全被摘光返回 None。"""
    # 以逗号分隔的选择器列表（保留换行与缩进风格）
    parts = prelude.split(",")
    kept = [p for p in parts if MARK not in p]
    if not kept:
        return None
    if len(kept) == len(parts):
        return prelude              # 无需改动
    # 重新拼：保留原来的缩进感（用 ",\n" 连接，并保持首行的前导空白）
    head = re.match(r"\s*", prelude).group(0)
    joined = ",".join(kept)
    return joined


def process(body: str, removable: list[str]) -> str:
    out: list[str] = []
    for prelude, block in split_rules(body):
        stripped = prelude.strip()
        if stripped.startswith("@media") or stripped.startswith("@supports"):
            # 递归处理内层
            inner_start = block.index("{") + 1
            inner = block[inner_start:-1]
            new_inner = process(inner, removable)
            if new_inner.strip():
                out.append(f"{prelude}{{{new_inner}}}")
            continue
        if MARK in prelude:
            pruned = prune_prelude(prelude)
            if pruned is None:
                removable.append(stripped[:60])
                continue                     # 整条规则删除
            out.append(f"{pruned}{block}")
            continue
        out.append(f"{prelude}{block}")
    return "\n".join(out)


def main() -> int:
    original = CSS.read_text(encoding="utf-8")
    before_open = original.count("{")
    before_close = original.count("}")

    # 保留文件头注释
    removed: list[str] = []
    new_body = process(original, removed)

    if new_body.count("{") != new_body.count("}"):
        print(f"❌ 大括号不配对（{new_body.count('{')} vs {new_body.count('}')}），未写盘", file=sys.stderr)
        return 1
    if MARK in new_body:
        left = [ln for ln in new_body.splitlines() if MARK in ln]
        print(f"❌ 仍有 {len(left)} 处残留，未写盘：", file=sys.stderr)
        for ln in left[:5]:
            print("   ", ln.strip(), file=sys.stderr)
        return 1

    CSS.write_text(new_body, encoding="utf-8")
    print(f"原始: {{ {before_open} }} {before_close}")
    print(f"结果: {{ {new_body.count('{')} }} {new_body.count('}')} 配对 OK")
    print(f"删除规则块: {len(removed)} 条")
    for r in removed:
        print("   -", " ".join(r.split())[:70])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
