// 对话界面「图片一闪就没」回归测试（2026-10-22）
//
// 真实时序（用户实测）：
//   ① WS 先推 agent_image（图片已落盘、给的是短 URL）
//   ② HTTP 最后才返回，而它的 attachments 经常是 []（图片走 WS 时后端不回填）
//   ③ 收尾时 loadHistory 又拉一遍历史，历史行只有正文、没有附件
//
// 三处都会把已经显示的图片冲掉，历史上至少出现过三种写法：
//   · hydrateFromLocalStore 用裸缓存重建整个列表
//   · appendHistoryRows 把无图的历史行追加到末尾（同一条回复变成两条）
//   · upsertReply 用 HTTP 的空 attachments 直接覆盖已有附件
//
// 本测试直接对这三条规则做断言（不依赖 Vue 运行时细节）。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, 'composables', 'useCompanionChat.js'), 'utf8')

test('★ upsertReply 的附件必须与已有附件【合并】，不能用 HTTP 的空数组覆盖', () => {
  // 必须能在源码里看到"取并集"的逻辑：base = existing.attachments
  assert.match(
    source,
    /const base = Array\.isArray\(existing\?\.attachments\) \? existing\.attachments : \[\]/,
    'upsertReply 必须先把已有附件取出来做并集，否则 WS 先到的图会被 HTTP 空 attachments 抹掉',
  )
  assert.match(source, /const extra = incomingAttachments\.filter/, '必须把 HTTP 附件作为增量合并进已有附件')
})


test('★ 所有消息都要带 ts，排序才有意义', () => {
  assert.match(source, /ts: Date\.parse\(row\?\.created_at\) \|\| 0/, '历史行必须带 ts')
  const nowCount = (source.match(/ts: Date\.now\(\)/g) || []).length
  assert.ok(nowCount >= 4, `新消息都应有 ts（实际 ${nowCount} 处）`)
})



test('★ 发送收尾不能清掉 WS 订阅（图片晚到会丢）', () => {
  const sendBlock = source.match(/async function send\([\s\S]*?\n  \}/)?.[0] || ''
  assert.ok(sendBlock, 'send 应存在')
  assert.doesNotMatch(sendBlock, /teardownStreamSubscription\(\)/, 'send 收尾不能拆除 WS 订阅')
  assert.match(source, /async function loadHistory[\s\S]{0,400}?ensureStreamSubscription\(\)/, 'loadHistory 应确保订阅常驻')
})

test('★ 收尾时空正文不得把占位消息标成"完成"（否则出现空壳气泡）', () => {
  const fn = source.match(/function upsertReply\(requestId, result\)[\s\S]*?\n  \}/)?.[0] || ''
  assert.ok(fn, 'upsertReply 应存在')
  // reply 与 attachments 都为空时必须直接 return false，不能去动 existing
  assert.match(
    fn,
    /if \(!reply && !attachments\.length\) return false/,
    '空正文+空附件时必须原样返回，否则占位消息会被标成完成、界面上只剩一个空壳',
  )
})

test('★ 图片只能挂在"本轮"消息上，绝不能挂到上一条已完成的回复', () => {
  const fn = source.match(/function attachToCurrentReply\(item\)[\s\S]*?\n  \}/)?.[0] || ''
  assert.ok(fn, 'attachToCurrentReply 应存在')
  assert.doesNotMatch(fn, /lastAssistant/, '不允许再回退到"最后一条 assistant"（会导致图片挂到旧消息，看起来反复出现）')
  assert.match(fn, /activeRequestId/, '应使用 activeRequestId 判定"本轮"')
})

test('★ 收尾后 activeRequestId 不能立刻清空（图片帧晚到）', () => {
  const sendBlock = source.match(/async function send\([\s\S]*?\n  \}/)?.[0] || ''
  assert.match(sendBlock, /finishedRequestId/, '应在 finally 里延后清空 activeRequestId')
  assert.match(sendBlock, /window\.setTimeout\(/, '需要延时清理，给晚到的图片帧留窗口')
})

test('★ WS 多帧图片必须挂到同一条消息上（否则同一张图显示两次）', () => {
  const fn = source.match(/function attachToCurrentReply\(item\)[\s\S]*?\n  \}/)?.[0] || ''
  assert.ok(fn, 'attachToCurrentReply 应存在')
  assert.match(fn, /lastAttachMessageId/, '必须用 lastAttachMessageId 记住承载图片的消息，逐帧新建会导致重复渲染')
  // 每轮开始要重置
  assert.match(source, /lastAttachMessageId = ''/, '每轮 send() 开始时应重置 lastAttachMessageId')
})

test('★ 同一张图绝不能复制多份（全局 url 去重，跨消息生效）', () => {
  const fn = source.match(/function attachToCurrentReply\(item\)[\s\S]*?\n  \}/)?.[0] || ''
  assert.ok(fn, 'attachToCurrentReply 应存在')
  assert.match(fn, /attachedUrls/, '必须有全局 url 集合，不能只在单条消息内去重')
  assert.match(fn, /if \(attachedUrls\.has\(url\)\) return/, '已挂过的 url 必须直接丢弃')
  assert.match(source, /attachedUrls\.clear\(\)/, '每轮开始要清空集合（在 send() 里）')
  // 兜底扫描：即使集合失效也不能重复
  assert.match(fn, /alreadyAnywhere/, '应有全量扫描兜底')
})

test('★ 所有消息写入都必须经过排序入口（流式期间也不许乱序）', () => {
  // 用户连报三次"图片/回复跑到提问上面"，且"刷新后正常" ——
  // 根因是 sortByTime 只在读缓存时调用，流式期间各路 append 完全不排序。
  // 这条测试是守卫：除 setMessages 内部与 reset() 外，禁止直接给 messages.value 赋值。
  // 逐行过滤注释（行首 * 或 // 都不是代码），否则注释里的代码片段会被误判
  const codeLines = source.split(/\r?\n/).filter((line) => {
    const t = line.trim()
    return !t.startsWith('*') && !t.startsWith('//')
  })
  const offenders = codeLines
    .map((line) => {
      const m = line.match(/messages\.value = (.+)/)
      return m ? m[1].trim() : null
    })
    .filter(Boolean)
    .filter((rhs) => !rhs.startsWith('sortByTime(') && !rhs.startsWith('[]'))
  assert.deepEqual(offenders, [], `这些写入绕过了排序：${JSON.stringify(offenders)}`)
  // 必须存在统一入口
  assert.match(source, /function setMessages\(next\)/, '必须有 setMessages 统一入口')
  assert.match(source, /function updateMessages\(fn\)/, '必须有 updateMessages 局部更新入口')
  // setMessages 内部必须排序
  const setFn = source.match(/function setMessages\(next\)[\s\S]*?\n  \}/)?.[0] || ''
  assert.match(setFn, /sortByTime\(/, 'setMessages 必须调用 sortByTime')
})

test('★ 前端必须兜底剥掉工具调用裸 JSON（否则一条回复被拆成两条、顺序错乱）', () => {
  assert.match(source, /function stripToolJsonBlocks/, '必须有 stripToolJsonBlocks 前端兜底')
  const fn = source.match(/function stripToolJsonBlocks\(input\)[\s\S]*?\n\}/)?.[0] || ''
  assert.match(fn, /tool_calls/, '识别工具特征键')
  assert.match(fn, /parseBlock/, '必须做括号配对解析，而不是简单正则')
  // sanitizeAssistantReply 里必须真的调用它
  const sanitizeFn = source.match(/export function sanitizeAssistantReply\(raw\)[\s\S]*?\n\}/)?.[0] || ''
  assert.match(sanitizeFn, /stripToolJsonBlocks\(/, 'sanitizeAssistantReply 必须调用它')
})
test('★ 消息身份只能用 id，绝不能用 role+text（同一句话会重复说很多次）', () => {
  const fn = source.match(/function appendHistoryRows\(rows\)[\s\S]*?\n  \}/)?.[0] || ''
  assert.ok(fn, 'appendHistoryRows 应存在')
  // 必须按 id 判重
  assert.match(fn, /existingIds/, '必须按 id 判断是否已存在')
  // 禁止再用 role+text 组合键做去重
  assert.doesNotMatch(fn, /normalizeKey\(item\.text\)/, '禁止用 role+text 当消息身份（"发个表情包"重复 22 次会被吃掉）')
  assert.doesNotMatch(fn, /localKeys/, '禁止 localKeys 文本去重')
  // 本地消息一律保留，只补 id 没见过且不属于已在屏轮次的历史行
  assert.match(fn, /localRequestIds/, '应按 request_id 避免重复补同一轮')
  assert.match(fn, /incomingIds\.has\(item\.id\)/, '只移除 id 完全相同的历史行')
})

test('★ 本地缓存只在列表为空或补更早整段时使用（不做文本去重）', () => {
  const fn = source.match(/function hydrateFromLocalStore\(\)[\s\S]*?\n  \}/)?.[0] || ''
  assert.ok(fn, 'hydrateFromLocalStore 应存在')
  assert.match(fn, /messages\.value\.length === 0/, '列表为空时才用缓存铺底')
  assert.match(fn, /olderOnly/, '有历史时只补"更早的整段"')
  assert.doesNotMatch(fn, /normalizeKey/, '禁止文本去重')
})

test('★ 带附件的本地消息永远不能被历史覆盖', () => {
  const fn = source.match(/function appendHistoryRows\(rows\)[\s\S]*?\n  \}/)?.[0] || ''
  // 新实现里本地消息一律保留（除非 id 完全相同）
  assert.match(fn, /const kept = messages\.value\.filter\(\(item\) => !incomingIds\.has\(item\.id\)\)/, '本地消息默认全部保留')
})
