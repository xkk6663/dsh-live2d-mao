/**
 * 12 态 phase 词汇 + 优先级 —— 移植源
 * `私人AI日记系统/backend/app/kernel/agent_bus_service.py:34-72`
 *
 * 这份词汇是桌宠渲染端（Electron/Live2D）与总线之间**已稳定运行**的契约，
 * 插件侧必须逐字对齐：多一个少一个都会让渲染端认不出的 phase 落进兜底分支。
 *
 * 为什么不从后端 import：插件跑在 DSH 宿主进程（纯 Node，见 M5 spike 结论），
 * 与 Python 后端**不在同一进程**，也没有共享模块系统。这里是**受控复制**，
 * 由 test/phases.test.js 断言两边词表一致（防止漂移）。
 */

/** 统一 phase 枚举（10 基础 + 2 扩展），顺序与后端 PHASES 一致。 */
export const PHASES = Object.freeze([
  'idle',              // 待机
  'planning',          // 规划任务
  'thinking',          // 思考中
  'executing_tool',    // 正在调用工具/执行动作
  'streaming',         // 文本流式输出
  'waiting_input',     // 等待用户输入（聆听）
  'voice',             // 语音播报中
  'complete',          // 单轮完成
  'error',             // 出错
  'paused',            // 暂停/断线待恢复
  'awaiting_approval', // 等待审批（借鉴 Paperclip）
  'heartbeat',         // 存活心跳（不改变动画）
])

/**
 * 活跃聚焦优先级：数值越小越优先占据"身体"。
 * 移植 `agent_bus_service.py:50-63` PHASE_PRIORITY。
 *
 * 注意：这只是**插件侧的预判**，用于本地调试输出与"是否值得上报"的取舍；
 * 真正的抢焦点裁决在后端 `_decide_active_locked`，插件不得越俎代庖（D4）。
 */
export const PHASE_PRIORITY = Object.freeze({
  voice: 1,
  executing_tool: 2,
  awaiting_approval: 2,
  thinking: 3,
  planning: 3,
  streaming: 4,
  waiting_input: 4,
  complete: 5,
  error: 5,
  paused: 5,
  heartbeat: 5,
  idle: 6,
})

/** 工作细分状态（桌宠头顶显示徽标）。移植 `DSH_WORK_PHASES`。 */
export const WORK_PHASES = Object.freeze([
  'planning',
  'thinking',
  'executing_tool',
  'streaming',
  'waiting_input',
  'voice',
  'awaiting_approval',
])

/** 非工作态（不显示徽标，但仍驱动桌宠回到待机等基础动画）。 */
export const IDLE_PHASES = Object.freeze(['idle', 'complete', 'error', 'paused'])

/**
 * 可由实时事件（facts）直接产出的 phase 集合。移植 `DSH_FACT_PHASES`。
 *
 * ⚠ 「已注册」与「可达」是两件事，别混（后端同款注释）：
 *   - 10 个由 facts 产出（WORK_PHASES + idle/complete/error）；
 *   - `paused` **不走 facts** —— 它由「DSH 进程还在但会话不可用」的连接中断分支直接发出；
 *   - `heartbeat` 刻意**不**作为 phase 发出：总线的 `emit()` 对 heartbeat 不广播
 *     `agent_phase`，且会把 agent.phase 写成 "heartbeat" 污染 Agent 页显示。
 *     保活走独立的 `heartbeat()` 通道（见 push/transport 的 kind:'heartbeat'）。
 *     **但 heartbeat 仍在 PHASES 里**（12 态之一，渲染端认识它）。
 */
export const FACT_PHASES = Object.freeze([...WORK_PHASES, 'idle', 'complete', 'error'])

/** phase 是否合法（后端 `emit()` 会用 `raise ValueError` 做同一校验）。 */
export function isKnownPhase(phase) {
  return PHASES.includes(phase)
}

/** 是否为「工作中」细分状态（决定是否显示桌宠头顶徽标）。 */
export function isWorkPhase(phase) {
  return WORK_PHASES.includes(phase)
}
