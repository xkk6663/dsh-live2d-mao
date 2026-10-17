/**
 * 架构红线机器守卫。
 *
 * 把「插件不碰核心 DOM」「12 态不删」「D5 命名」三条铁律从注释变成测试断言，
 * 防止后续改动无声退化（这些曾经都是靠注释和自觉守的，踩过真实回归）。
 *
 * 依据：AGENTS.md §2 三条架构红线。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')
const rootDir = join(here, '..')

/** 递归收集 lib/ 下所有 .js 源码内容（字符串）。 */
function libSources() {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.js') || name.endsWith('.mjs')) {
        out.push({ path: p, text: readFileSync(p, 'utf8') })
      }
    }
  }
  walk(libDir)
  return out
}

/** 剥掉注释，只留可执行代码（避免把"契约说明注释"里的选择器误判为越界）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')       // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')   // 行注释（避开 http://）
}

test('R1 · 插件不碰核心 DOM（只经 __mioPetStrip/__mioPetBubble 说话）', () => {
  const sources = libSources()
  // 核心元素选择器：桌宠主体的私有 UI，插件不得在**可执行代码**里直接引用
  const forbidden = ['#speech-bubble', '#activity-indicator', '#pet-strip', '#pet-strip-text']
  const offenders = []
  for (const { path, text } of sources) {
    const code = stripComments(text)
    for (const sel of forbidden) {
      if (code.includes(sel)) offenders.push(`${path}:${sel}`)
    }
  }
  assert.deepEqual(offenders, [],
    '插件 lib 的可执行代码不得出现核心元素选择器：' + offenders.join(', '))
})

test('R1b · 插件通过核心 API 访问横条/气泡（契约名存在）', () => {
  const text = libSources().map((s) => s.text).join('\n')
  // 插件必须经这些核心 API 名访问主体，而不是直接改 DOM
  assert.ok(text.includes('__mioPetStrip'), '插件应引用核心 API __mioPetStrip')
  assert.ok(text.includes('__mioPetBubble') || text.includes('pushBubble'),
    '插件应经 pushBubble/__mioPetBubble 说气泡')
})

test('R2 · 12 态词汇不删不改（含 voice 预留态）', async () => {
  const { PHASES } = await import('../lib/phases.js')
  const expected = [
    'idle', 'planning', 'thinking', 'executing_tool', 'streaming',
    'waiting_input', 'voice', 'complete', 'error', 'paused',
    'awaiting_approval', 'heartbeat',
  ]
  assert.deepEqual([...PHASES].sort(), [...expected].sort(),
    '12 态词汇是总线契约，不得增删；voice 是 D1 预留态必须保留')
})

test('R3 · D5 命名：npm 名与 cordis id 全小写 dsh-live2d-mao', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-live2d-mao', 'npm 包名必须全小写 dsh-live2d-mao')

  const patch = readFileSync(join(rootDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('id: dsh-live2d-mao'), 'cordis.patch.yml 的 id 必须为 dsh-live2d-mao')
  // id 必须是全小写；name 字段与注释里的显示名 dsh-live2d-mao 是允许的
  assert.ok(/id:\s*dsh-live2d-mao\b/.test(patch), 'cordis id 必须全小写 dsh-live2d-mao（不含大写）')

  // 显示名是 dsh-live2d-mao（允许大写），但只出现在 description，不进入 id
  assert.ok(pkg.description.includes('dsh-live2d-mao') || pkg.description.includes('桌宠'),
    'description 应有显示名/用途说明')
})

test('R4 · 插件无 TTS 依赖（D1）', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const forbidden = Object.keys(deps).filter((d) => /tts|speak|edge-tts|say/i.test(d))
  assert.deepEqual(forbidden, [], 'D1：插件不引入 TTS 相关依赖')
})
