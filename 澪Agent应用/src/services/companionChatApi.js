/**
 * 大肥鱼聊天 · 后端接口封装（桌宠共享会话）
 *
 * 契约来源：私人AI日记系统/backend/app/routes/companion.py
 *   POST /api/companion/chat            → { reply, replies, model_id, provider_model, request_id, client_request_id, ... }
 *   POST /api/companion/chat/cancel     → { cancelled, conversation_id, client_request_id }
 *   GET  /api/companion/chat/history    → { conversation_id, messages: [{ id, role, content, source, created_at, ... }] }
 *
 * ★ 与 /api/agent/chat 的区别（别混用）：
 *   桌宠会话是**一条固定的共享会话**（后端 _desktop_pet_conversation_id() 硬编码 'desktop_pet'），
 *   历史里混有微信/QQ/桌宠/主动消息各种来源 —— 这正是"和微信里的我是同一个我"的产品承诺。
 *   所以这里的 source 是只读展示信息，不参与过滤。
 *
 * ★ 三个**必须知道的契约坑**（详见 docs/大肥鱼聊天-后端契约审计.md）：
 *   1. `model_id` 只能是 `cloud_feiyu`。传空 / 'auto' 会回落到 config.pet_chat_model_id
 *      （该键不在后端白名单里）→ 走本地模型路由，**大肥鱼人格与长期记忆直接消失**。
 *      cloud_feiyu 分支还会强制 reasoning_level='off'，所以思考档位参数对这条支路无效。
 *   2. **cloud_feiyu 分支不落库**（companion.py:1464-1553 全段没有 db.save_message），
 *      所以 GET /chat/history 往往拿不到"刚才那一轮"。回答只能从 HTTP 响应的 reply 取。
 *   3. `/chat/cancel` 走的是 chat_run_coordinator，而 cloud_feiyu 绕过了 coordinator →
 *      后端取消对它无效，前端只能 abort fetch（见 useCompanionChat.cancel）。
 */
import { apiRequest } from './api.js'

/** 后端内置的云端大肥鱼直通模型 id（跳过本地模型路由，直连 AstrBot 人格）。旧聊天页就用它。 */
export const FEIYU_CLOUD_MODEL_ID = 'cloud_feiyu'

/** 后端硬约束：单条消息上限 4000 字、图片最多 5 张（companion.py:281/284） */
export const FEIYU_MESSAGE_MAX_CHARS = 4000
export const FEIYU_IMAGE_MAX_COUNT = 5

/**
 * 发送一条消息到大肥鱼。
 * @param {object} payload
 * @param {string} payload.message           消息正文（可空，但必须至少有图）
 * @param {Array}  [payload.images]          [{ name, data_url }]，后端上限 5 张
 * @param {string} [payload.model_id]        默认 cloud_feiyu（别传 auto，见文件头坑 1）
 * @param {string} [payload.reasoning_level] 默认 auto（cloud_feiyu 分支会强制 off）
 * @param {string} payload.client_request_id 幂等键（同 id 但消息/图片变了 → 后端 400，必须换新 id）
 * @param {AbortSignal} [signal]
 *
 * 响应里除 reply 外还有：
 *   attachments: [{kind, filename, display, mime_type, size, data_url, error}]
 *   images:      [data: URL]  ← 与 attachments 里 kind=image 的 data_url 同源
 * 详见 docs/大肥鱼聊天-后端契约审计.md 与 cloud_feiyu/client.py 头部注释。
 */
export const sendCompanionChat = (payload, signal) => apiRequest('/api/companion/chat', {
  method: 'POST',
  body: JSON.stringify({
    message: String(payload.message || '').slice(0, FEIYU_MESSAGE_MAX_CHARS),
    images: (payload.images || []).slice(0, FEIYU_IMAGE_MAX_COUNT),
    model_id: payload.model_id || FEIYU_CLOUD_MODEL_ID,
    reasoning_level: payload.reasoning_level || 'auto',
    client_request_id: payload.client_request_id || '',
  }),
  signal,
})

/**
 * 取消当前正在跑的那一轮。
 * ⚠ 对 cloud_feiyu 直通分支**无效**（它不在 coordinator 里）。保留它是因为：
 *   ① 前端切到本地模型时这条路仍然有效；② 让后端知道用户点了停止，便于将来对齐。
 *   真正的"停下"由调用方 AbortController.abort() 完成。
 */
export const cancelCompanionChat = (clientRequestId) => apiRequest('/api/companion/chat/cancel', {
  method: 'POST',
  body: JSON.stringify({ client_request_id: clientRequestId || '' }),
})

/**
 * 拉桌宠共享会话的历史消息（单会话，后端上限 500）。
 * ⚠ 返回里**没有图片字段**，纯图片轮次也在库里只存文本占位。
 */
export const loadCompanionChatHistory = (limit = 200) => apiRequest(
  `/api/companion/chat/history?limit=${encodeURIComponent(String(Math.min(500, Math.max(1, Number(limit) || 200))))}`,
)

/**
 * 读取聊天共享设置（模型 / 思考档位 / 语音语言）。
 *
 * ★ 这个端点是**可选增强**：仓库里的后端（routes/companion.py）目前并没有实现
 *   /api/companion/chat-settings（全仓 grep 无此路由），前端 useChatInteraction 早已把它
 *   包在 try/catch 里兜底。所以这里一律 **静默降级**：失败（404 / 网络）返回 null，
 *   调用方据此退回"云端大肥鱼直通"默认策略，绝不弹错。
 */
export async function loadChatSettings({ quiet = true } = {}) {
  try {
    return await apiRequest('/api/companion/chat-settings')
  } catch (error) {
    if (!quiet) throw error
    return null
  }
}
