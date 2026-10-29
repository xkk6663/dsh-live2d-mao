// DSH 专用化：'chat'（小智对话页）已移除，遗留书签统一回落到 'companion'（桌宠管理页）。
// ★ 'feiyu-chat'（大肥鱼对话页）必须在白名单里（与 App.vue validInitialViews 对齐），
//   否则用户停留在大肥鱼页后，下次启动 localStorage 恢复视图会被这里强制打回 'home'。
export function normalizeAgentView(view) {
  if (['creation', 'creation-image', 'creation-video', 'chat'].includes(view)) return 'companion'
  return ['home', 'companion', 'tasks', 'settings', 'feiyu-chat'].includes(view) ? view : 'home'
}

export function filterConversationsForWorkspace(conversations, workspace) {
  const items = Array.isArray(conversations) ? conversations : []
  return items.filter((item) => (
    workspace === 'agent' ? item?.kind === 'agent' : item?.kind !== 'agent'
  ))
}
