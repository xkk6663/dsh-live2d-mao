// 大肥鱼回复清洗（sanitizeAssistantReply）回归测试
//
// 来源：用户实机截图（2026-10-22）——助手把模型的英文思考过程当正文念出来：
//   `Could be a test of "你是谁，我在哪" — maybe they're drunk? No. Just answer.大肥鱼。你在自己电脑前…`
// 后端 routes/companion.py:1520-1533 的"首行不含中文就丢弃"对**中英粘在同一行**完全无效，
// 所以这道清洗放在前端，并且历史 / 实时回复两条路径都要走它。
import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeAssistantReply } from './composables/useCompanionChat.js'

test('★ 粘连且引用中文原话：剥掉英文思考，但**正文必须留住**', () => {
  // 真实形状：后端把整段回复拼成**一个长字符串**，英文思考、引号内引用、中文正文全在一行。
  // 早期实现直接整行丢弃 → 界面上去掉英文思考后连中文正文也不见了。
  const raw = 'Could be a test of "你是谁，我在哪" — maybe they\'re drunk? No. Just answer.大肥鱼。你在自己电脑前，桌宠那边，LAPTOP-F653OM69。'
  const out = sanitizeAssistantReply(raw)
  assert.ok(!/drunk|Just answer|Could be a test/.test(out), `英文思考不能漏：${out}`)
  assert.ok(out.includes('大肥鱼'), `中文正文不能丢：${out}`)
  assert.ok(out.includes('LAPTOP-F653OM69'), `正文里的设备名不能丢：${out}`)
})

test('★ 整行只有英文思考（没有正文）→ 丢弃', () => {
  const raw = 'Could be a test of "随便说点什么" — maybe they are drunk? No. Just answer.'
  assert.equal(sanitizeAssistantReply(raw), '')
})

test('★ 不带引号的粘连可以切开，正文保留', () => {
  const raw = 'No. Just answer.大肥鱼。你在自己电脑前，桌宠那边，LAPTOP-F653OM69。'
  assert.equal(sanitizeAssistantReply(raw), '大肥鱼。你在自己电脑前，桌宠那边，LAPTOP-F653OM69。')
})

test('★ 多行版本：引用型英文思考整行丢弃，粘连行切开', () => {
  const raw = [
    'Could be a test of "你是谁，我在哪" — maybe they\'re drunk?',
    'No. Just answer.大肥鱼。你在自己电脑前。',
  ].join('\n')
  assert.equal(sanitizeAssistantReply(raw), '大肥鱼。你在自己电脑前。')
})

test('★ 纯英文的思考行整行丢弃，正常中文行保留', () => {
  const raw = [
    'Could be a test of something — maybe they are drunk?',
    'No. Just answer.',
    '哥你要是真迷糊，就把电脑关了睡一觉。',
  ].join('\n')
  assert.equal(sanitizeAssistantReply(raw), '哥你要是真迷糊，就把电脑关了睡一觉。')
})

test('控制标记清零：&&表情&& 与 ⟦MODE⟧', () => {
  const raw = '&&happy&&你好呀⟦MODE:chat⟧今天想聊点什么？'
  assert.equal(sanitizeAssistantReply(raw), '你好呀今天想聊点什么？')
})

test('正常中文回答原样保留（不误伤）', () => {
  const samples = [
    '早上好呀，今天想聊点什么？',
    '云层挺厚的，下午大概会下雨。',
    '第一行\n第二行也没问题。',
    '好的 OK，那就这样吧。',
    '我看了下，你这个问题有三点：\n\n1. 第一点\n2. 第二点',
  ]
  for (const sample of samples) {
    assert.equal(sanitizeAssistantReply(sample), sample, `被误伤了：${sample}`)
  }
})

test('英文专有名词/型号不会被当成思考切掉（没有句点+空格的不动）', () => {
  for (const sample of ['我用的是 GPT-4o 模型。', '文件在 LAPTOP-F653OM69 上。', '这个词是 hello world 的意思。']) {
    assert.equal(sanitizeAssistantReply(sample), sample, `被误伤了：${sample}`)
  }
})

test('空值/纯空白安全', () => {
  assert.equal(sanitizeAssistantReply(''), '')
  assert.equal(sanitizeAssistantReply(null), '')
  assert.equal(sanitizeAssistantReply(undefined), '')
  assert.equal(sanitizeAssistantReply('   \n  '), '')
})
