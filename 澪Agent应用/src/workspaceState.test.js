import assert from 'node:assert/strict'
import test from 'node:test'

import { filterConversationsForWorkspace, normalizeAgentView } from './workspaceState.js'

test('removed creation bookmarks resume in the pet view and task view survives restart', () => {
  // DSH 专用化：'chat' 已移除（那是小智对话页），遗留书签统一回落到 'companion'（桌宠管理页）
  for (const view of ['creation', 'creation-image', 'creation-video', 'chat']) {
    assert.equal(normalizeAgentView(view), 'companion')
  }
  assert.equal(normalizeAgentView('tasks'), 'tasks')
  assert.equal(normalizeAgentView('companion'), 'companion')
  assert.equal(normalizeAgentView('unknown'), 'home')
})

const conversations = [
  { id: 'desktop_main', kind: 'desktop' },
  { id: 'desktop_agent_one', kind: 'agent' },
  { id: 'desktop_pet', kind: 'pet' },
  { id: 'qq_private', kind: 'qq' },
]

test('Agent workspace keeps only Agent conversations', () => {
  assert.deepEqual(
    filterConversationsForWorkspace(conversations, 'agent').map((item) => item.id),
    ['desktop_agent_one'],
  )
})

test('main workspace excludes Agent conversations', () => {
  assert.deepEqual(
    filterConversationsForWorkspace(conversations, 'main').map((item) => item.id),
    ['desktop_main', 'desktop_pet', 'qq_private'],
  )
})

test('workspace filtering tolerates a missing conversation list', () => {
  assert.deepEqual(filterConversationsForWorkspace(undefined, 'agent'), [])
})
