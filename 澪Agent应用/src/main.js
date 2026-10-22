import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import './styles/integrated.css'
import './styles/refinements.css'
// 必须最后导入：回仓补回的后置覆盖样式（原规则在 v4.0 构建产物末尾，靠层叠覆盖前面的定义）
import './styles/restored-overrides.css'
// 大肥鱼对话页（视觉移植自 xiaozhi-chat-ui 提取包）。
// ⚠ 顺序有讲究：必须晚于 styles.css / integrated.css —— 它第 5 节是"最终渲染值校准"，
//   靠后置 + `.xz-chat` 前缀压过 integrated.css 里同名的 .composer/.message-* 规则。
import './styles/feiyu-chat.css'

createApp(App).mount('#app')
