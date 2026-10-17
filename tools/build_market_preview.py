"""生成 catalog 展示页的本地预览（模拟 awesome-dsh-plugin 的 /p/<owner>/<repo>/ 页面结构）。

用途：让作者在提 PR 前看到「我们的项目在那个页面上长什么样」。
真实页面结构（已抓取 A8Chann 页确认）：
  标题区（名字 / star / 下载 / 分类 / npm）
  → 安装（自动生成）
  → README 渲染
  → 链接 / 同类插件
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
OUT = ROOT / "docs" / "dsh-market-preview.html"

# catalog 条目信息（与我们投稿 YAML 保持一致）
META = {
    "name": "xkk6663/dsh-live2d-mao",
    "category": "fun",
    "category_zh": "娱乐",
    "npm": "dsh-live2d-mao",
    "desc_zh": "DSH 专用 Live2D 桌宠：PixiJS + Cubism 4 真实骨骼动画，住在独立的 Electron 桌宠窗口里，"
               "通过 12 态语义总线实时映射 DeepSeek Harness 的工作状态。",
}

CSS = """
:root { --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --accent:#4F6BED; --bg:#ffffff; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #f7f8fa; color: var(--ink);
  font-family: "Microsoft YaHei", "PingFang SC", -apple-system, system-ui, sans-serif;
  line-height: 1.75; font-size: 15px;
}
.wrap { max-width: 880px; margin: 0 auto; padding: 0 20px 80px; }
.crumb { padding: 18px 0 6px; font-size: 13px; color: var(--muted); }
.crumb a { color: var(--muted); text-decoration: none; }
.card { background: var(--bg); border: 1px solid var(--line); border-radius: 14px; padding: 26px 30px; margin-bottom: 22px; }
h1 { font-size: 27px; margin: 0 0 14px; font-weight: 700; letter-spacing: -0.2px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 13px; color: var(--muted); margin-bottom: 16px; }
.meta b { color: var(--ink); font-weight: 600; }
.tag { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px;
       background: #eef2ff; color: var(--accent); font-weight: 600; }
.summary { font-size: 14.5px; color: #374151; margin: 0 0 20px; }
.install { background: #f9fafb; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 8px; }
.install .label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.install code { font-family: ui-monospace, Consolas, monospace; font-size: 13px; color: #111827; }
h2 { font-size: 20px; margin: 30px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--line); font-weight: 700; }
h3 { font-size: 16.5px; margin: 24px 0 10px; font-weight: 700; }
.readme img { max-width: 100%; height: auto; border-radius: 10px; border: 1px solid var(--line); margin: 10px 0; }
.readme table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 14px; }
.readme th, .readme td { border: 1px solid var(--line); padding: 9px 12px; text-align: left; vertical-align: top; }
.readme th { background: #f9fafb; font-weight: 600; }
.readme code { background: #f3f4f6; padding: 1.5px 5px; border-radius: 4px;
               font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; }
.readme pre { background: #1f2937; color: #e5e7eb; padding: 14px 16px; border-radius: 10px; overflow-x: auto; }
.readme pre code { background: none; color: inherit; padding: 0; }
.readme blockquote { margin: 14px 0; padding: 2px 16px; border-left: 3px solid var(--accent);
                     background: #f8faff; color: #4b5563; border-radius: 0 6px 6px 0; }
.readme a { color: var(--accent); }
.readme hr { border: none; border-top: 1px solid var(--line); margin: 26px 0; }
.readme ul, .readme ol { padding-left: 24px; }
.banner-note { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px;
               padding: 12px 16px; font-size: 13px; color: #92400e; margin-bottom: 18px; }
"""

# 把 README 里的相对图片路径改成本地可打开（预览用）
def fix_img_paths(text: str) -> str:
    def repl(m: re.Match[str]) -> str:
        alt, src = m.group(1), m.group(2)
        if src.startswith(("http://", "https://", "data:")):
            return m.group(0)
        abs_path = (ROOT / src).resolve()
        uri = abs_path.as_uri() if abs_path.exists() else src
        return f"![{alt}]({uri})"
    return re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", repl, text)


def main() -> int:
    if not README.exists():
        print(f"README 不存在: {README}", file=sys.stderr)
        return 1

    raw = README.read_text(encoding="utf-8")
    # 页面主体是 README，但标题区已单独渲染 → 去掉 README 顶部的居中徽章块和一级标题。
    # 注意三件事（实测各踩过一次）：
    #   1. 正则要带 re.S，否则多行 div 匹配不上；
    #   2. 结尾要吃掉空行，否则卡片顶部留白；
    #   3. 徽章块后面紧跟的那个 `---`（hr）必须一起去掉，否则正文开头横着一条线。
    body_md = re.sub(r"\A<div align=\"center\">[\s\S]*?</div>\s*", "", raw)
    body_md = re.sub(r"\A# [^\n]*\n+", "", body_md)
    body_md = re.sub(r"\A-{3,}\s*\n+", "", body_md)   # 孤立 hr
    body_md = body_md.lstrip("\n")
    body_md = fix_img_paths(body_md)

    body_html = markdown.markdown(
        body_md,
        extensions=["tables", "fenced_code", "nl2br", "toc", "sane_lists"],
    )

    banner = ROOT / "docs" / "images" / "hero-dsh-desktop.jpg"
    banner_uri = banner.as_uri() if banner.exists() else ""

    html = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{META['name']} — dsh 插件 · {META['category_zh']}</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="crumb"><a href="#">awesome-dsh-plugin</a> / <a href="#">{META['category_zh']}</a> / {META['name']}</div>

  <div class="card">
    <h1>{META['name']}</h1>
    <div class="meta">
      <span class="tag">{META['category_zh']}</span>
      <span>npm <b>{META['npm']}</b></span>
      <span>收录于 <b>2026-10-18</b></span>
    </div>
    <p class="summary">{META['desc_zh']}</p>
    <div class="install">
      <div class="label">npm 包（推荐）</div>
      <code>dsh plugin --profile web add {META['npm']}</code>
    </div>
    <div class="install">
      <div class="label">GitHub 源码</div>
      <code>dsh plugin --profile web add github:xkk6663/dsh-live2d-mao</code>
    </div>
  </div>

  <div class="banner-note">
    预览说明：真实页面主体就是本仓库 README.md 的渲染结果。此处已把相对图片路径转成本地绝对路径，方便离线查看。<br>
    screenshots.json 的 5 张图<b>不会</b>出现在网页展示页上（那是给 dsh-market 客户端 GUI 用的），网页只认 README 里的图。
  </div>

  <div class="card readme">
    {body_html}
  </div>
</div>
</body>
</html>
"""

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    size_kb = OUT.stat().st_size / 1024
    print(f"已生成: {OUT}")
    print(f"大小: {size_kb:.1f} KB")
    print(f"README 正文字数: {len(raw)}")
    if banner_uri:
        print(f"README 头图: {banner.name} ({banner.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
