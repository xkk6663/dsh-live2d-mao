// DSH 专用化：'chat'（小智对话页）已移除，遗留书签统一回落到 'companion'（桌宠管理页）。
export function normalizeAgentView(view) {
  if (['creation', 'creation-image', 'creation-video', 'chat'].includes(view)) return 'companion'
  return ['home', 'companion', 'tasks', 'settings'].includes(view) ? view : 'home'
}

export function filterConversationsForWorkspace(conversations, workspace) {
  const items = Array.isArray(conversations) ? conversations : []
  return items.filter((item) => (
    workspace === 'agent' ? item?.kind === 'agent' : item?.kind !== 'agent'
  ))
}
