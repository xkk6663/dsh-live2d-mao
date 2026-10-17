import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTIVE_VIEW_HEARTBEAT_MS, buildActiveViewReport } from './activeViewState.js'

test('active view heartbeat heals a restarted backend promptly without a tight loop', () => {
  assert.equal(ACTIVE_VIEW_HEARTBEAT_MS, 5000)
})

test('active view report keeps only settings sections', () => {
  assert.deepEqual(buildActiveViewReport('settings', 'models'), {
    view_id: 'settings',
    section_id: 'models',
    visible: true,
  })
  // DSH 专用化：'chat' 已从合法视图移除，改用 'companion'（桌宠管理页）覆盖同一分支
  assert.deepEqual(buildActiveViewReport('companion', 'models', false), {
    view_id: 'companion',
    section_id: '',
    visible: false,
  })
  assert.deepEqual(buildActiveViewReport('creation-image'), {
    view_id: 'creation-image',
    section_id: '',
    visible: true,
  })
  assert.deepEqual(buildActiveViewReport('creation-video'), {
    view_id: 'creation-video',
    section_id: '',
    visible: true,
  })
})

test('active view report rejects unknown views and settings sections', () => {
  assert.throws(() => buildActiveViewReport('private-page'), /不支持的主应用页面/)
  assert.throws(() => buildActiveViewReport('settings', 'private-section'), /不支持的设置分区/)
})
