# -*- coding: utf-8 -*-
"""发布版瘦身核查：前端 dist 实际 API 调用 vs 后端 routes/service 引用。"""
import io, os, re, sys, collections, ast

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
# ★ 独立性（2026-10-19）：原值硬编码为上游 Mao 仓库的绝对路径，换机器即失效。
#   改为根据本文件位置反推项目根（backend/_apicheck.py → 项目根）。
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIST = os.path.join(_PROJECT_ROOT, '澪Agent应用', 'dist')
APP = os.path.join(_PROJECT_ROOT, '私人AI日记系统', 'backend', 'app')

# 1) 前端 dist 所有 API 调用
api_calls = collections.Counter()
for root, dirs, files in os.walk(DIST):
    if 'live2d-pet' in root:
        continue  # 桌宠本体前端单独统计
    for fn in files:
        if fn.endswith(('.js', '.html')):
            p = os.path.join(root, fn)
            try:
                txt = io.open(p, encoding='utf-8', errors='replace').read()
            except Exception:
                continue
            for m in re.finditer(r'["\'`](/api/[A-Za-z0-9_\-/\.]+)', txt):
                api_calls[m.group(1)] += 1
            # 相对拼接形式（前段是 apiBase/API_BASE）
            for m in re.finditer(r'["\'`](/[a-z0-9_\-/]+)["\'`]', txt):
                u = m.group(1)
                if u.startswith('/api/'):
                    api_calls[u] += 1
print('== 前端 dist(非桌宠) 调用 API 集合 ==')
for u, c in sorted(api_calls.items()):
    print('  %4d  %s' % (c, u))

# 桌宠前端单独
pet_calls = collections.Counter()
pet_root = os.path.join(DIST, 'live2d-pet')
for root, dirs, files in os.walk(pet_root):
    for fn in files:
        if fn.endswith(('.js', '.html')):
            p = os.path.join(root, fn)
            try:
                txt = io.open(p, encoding='utf-8', errors='replace').read()
            except Exception:
                continue
            for m in re.finditer(r'["\'`](/api/[A-Za-z0-9_\-/\.]+)', txt):
                pet_calls[m.group(1)] += 1
print()
print('== 桌宠前端(live2d-pet) 调用 API 集合 ==')
for u, c in sorted(pet_calls.items()):
    print('  %4d  %s' % (c, u))
