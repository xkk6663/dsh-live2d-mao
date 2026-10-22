const VALID_VIEW_IDS = new Set([
  // DSH 专用化：'onboarding' 已移除（首次进入不再有六步质检流程）
  // DSH 专用化：'chat' 已移除（那是小智对话页 ChatPage，随小智插件一并阉割）
  'home',
  'diaries',
  'memory',
  'tasks',
  'companion',
  // 大肥鱼对话页（桌宠共享会话 /api/companion/chat*）。它**不是**已删除的 'chat'：
  // 那页是小智对话（小智插件那套接口，已整体阉割），这页视觉移植自 xiaozhi-chat-ui
  // 提取包、数据走桌宠自己的接口。不加进白名单 buildActiveViewReport() 会抛错。
  'feiyu-chat',
  'creation',
  'creation-image',
  'creation-video',
  'settings',
  'stats',
])

const VALID_SETTINGS_SECTION_IDS = new Set([
  'general',
  'appearance',
  'profile',
  'conversation',
  'diary',
  'models',
  'qq',
  'pet',
  'data',
  'advanced',
])

export const ACTIVE_VIEW_HEARTBEAT_MS = 5000

export function buildActiveViewReport(viewId, sectionId = '', visible = true) {
  const view = String(viewId || '').trim().toLowerCase()
  if (!VALID_VIEW_IDS.has(view)) throw new Error(`不支持的主应用页面：${view || '空'}`)
  const section = view === 'settings' ? String(sectionId || '').trim().toLowerCase() : ''
  if (section && !VALID_SETTINGS_SECTION_IDS.has(section)) {
    throw new Error(`不支持的设置分区：${section}`)
  }
  return {
    view_id: view,
    section_id: section,
    visible: Boolean(visible),
  }
}
