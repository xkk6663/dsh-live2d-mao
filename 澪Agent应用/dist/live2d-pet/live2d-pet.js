/*
 * Mio Live2D renderer. The Electron process owns desktop behavior while
 * FastAPI remains the single owner of persona, memory, speech and vision.
 */
(function () {
  'use strict'

  const builtInModels = {
    hiyori: {
      id: 'hiyori',
      name: 'Hiyori Momose',
      url: './models/Hiyori/Hiyori.model3.json',
      idleGroup: 'Idle',
      tapGroup: 'TapBody',
      source: 'built_in',
      capabilities: {
        motions: [{ name: 'Idle', count: 9 }, { name: 'TapBody', count: 1 }],
        expressions: [], physics: true, pose: true,
        lipSyncParameters: ['ParamMouthOpenY'], eyeBlinkParameters: ['ParamEyeLOpen', 'ParamEyeROpen'],
        idleGroup: 'Idle', tapGroup: 'TapBody',
        motionSlots: {
          idle: 'Idle', touch: 'TapBody', think: 'Idle', speak: 'Idle', observe: 'Idle',
          cheerful: 'TapBody', concerned: 'Idle', alert: 'TapBody', attention: 'Idle', shy: 'Idle',
        },
        unassignedMotions: [],
      },
    },
    haru: {
      id: 'haru',
      name: 'Haru（ハル）',
      url: './models/Haru/Haru.model3.json',
      idleGroup: 'Idle',
      tapGroup: 'TapBody',
      source: 'built_in',
      capabilities: {
        motions: [{ name: 'Idle', count: 2 }, { name: 'TapBody', count: 4 }],
        expressions: [], physics: true, pose: true,
        lipSyncParameters: ['ParamMouthOpenY'], eyeBlinkParameters: ['ParamEyeLOpen', 'ParamEyeROpen'],
        idleGroup: 'Idle', tapGroup: 'TapBody',
        motionSlots: {
          idle: 'Idle', touch: 'TapBody', think: 'Idle', speak: 'Idle', observe: 'Idle',
          cheerful: 'TapBody', concerned: 'Idle', alert: 'TapBody', attention: 'Idle', shy: 'Idle',
        },
        unassignedMotions: [],
      },
    },
    mao: {
      id: 'mao',
      name: 'Mao（まお）',
      url: './models/Mao/Mao.model3.json',
      idleGroup: 'Idle',
      tapGroup: 'TapBody',
      source: 'built_in',
      capabilities: {
        motions: [{ name: 'Idle', count: 2 }, { name: 'TapBody', count: 6 }],
        expressions: [], physics: true, pose: true,
        lipSyncParameters: ['ParamMouthOpenY'], eyeBlinkParameters: ['ParamEyeLOpen', 'ParamEyeROpen'],
        idleGroup: 'Idle', tapGroup: 'TapBody',
        motionSlots: {
          idle: 'Idle', touch: 'TapBody', think: 'Idle', speak: 'Idle', observe: 'Idle',
          cheerful: 'TapBody', concerned: 'Idle', alert: 'TapBody', attention: 'Idle', shy: 'Idle',
        },
        unassignedMotions: [],
      },
    },
    mark: {
      id: 'mark',
      name: 'Mark（マークくん）',
      url: './models/Mark/Mark.model3.json',
      idleGroup: 'Idle',
      tapGroup: 'Idle',
      source: 'built_in',
      capabilities: {
        motions: [{ name: 'Idle', count: 6 }],
        expressions: [], physics: true, pose: false,
        lipSyncParameters: ['ParamMouthOpenY'], eyeBlinkParameters: ['ParamEyeLOpen', 'ParamEyeROpen'],
        idleGroup: 'Idle', tapGroup: 'Idle',
        motionSlots: {
          idle: 'Idle', touch: 'Idle', think: 'Idle', speak: 'Idle', observe: 'Idle',
          cheerful: 'Idle', concerned: 'Idle', alert: 'Idle', attention: 'Idle', shy: 'Idle',
        },
        unassignedMotions: [],
      },
    },
    rice: {
      id: 'rice',
      name: 'Rice（ライス）',
      url: './models/Rice/Rice.model3.json',
      idleGroup: 'Idle',
      tapGroup: 'TapBody',
      source: 'built_in',
      capabilities: {
        motions: [{ name: 'Idle', count: 1 }, { name: 'TapBody', count: 3 }],
        expressions: [], physics: true, pose: false,
        lipSyncParameters: ['ParamMouthOpenY'], eyeBlinkParameters: ['ParamEyeLOpen', 'ParamEyeROpen'],
        idleGroup: 'Idle', tapGroup: 'TapBody',
        motionSlots: {
          idle: 'Idle', touch: 'TapBody', think: 'Idle', speak: 'Idle', observe: 'Idle',
          cheerful: 'TapBody', concerned: 'Idle', alert: 'TapBody', attention: 'Idle', shy: 'Idle',
        },
        unassignedMotions: [],
      },
    },
    wanko: {
      id: 'wanko',
      name: 'Wanko（わんころもち）',
      url: './models/Wanko/Wanko.model3.json',
      idleGroup: 'Idle',
      tapGroup: 'TapBody',
      source: 'built_in',
      capabilities: {
        motions: [{ name: 'Idle', count: 3 }, { name: 'TapBody', count: 2 }],
        expressions: [], physics: true, pose: false,
        lipSyncParameters: ['ParamMouthOpenY'], eyeBlinkParameters: ['ParamEyeLOpen', 'ParamEyeROpen'],
        idleGroup: 'Idle', tapGroup: 'TapBody',
        motionSlots: {
          idle: 'Idle', touch: 'TapBody', think: 'Idle', speak: 'Idle', observe: 'Idle',
          cheerful: 'TapBody', concerned: 'Idle', alert: 'TapBody', attention: 'Idle', shy: 'Idle',
        },
        unassignedMotions: [],
      },
    },
    'whale-deepseek': {
      id: 'whale-deepseek',
      name: 'DeepSeek娘(鲸鱼娘)',
      url: './models/whale-deepseek/c_0120.model3.json',
      idleGroup: 'idle',
      tapGroup: 'aidale',
      source: 'built_in',
      capabilities: {
        motions: [
          { name: 'idle', count: 1 }, { name: 'aidale', count: 1 }, { name: 'selfie', count: 1 },
          { name: 'selfieQuick', count: 1 }, { name: 'ketchup', count: 1 }, { name: 'openLid', count: 1 },
          { name: 'bubble', count: 1 }, { name: 'splash', count: 1 },
        ],
        expressions: [
          { Name: 'love', File: 'expressions/love.exp3.json' },
          { Name: '兔兔贴纸', File: 'expressions/兔兔贴纸.exp3.json' },
          { Name: '单边马尾', File: 'expressions/单边马尾.exp3.json' },
          { Name: '双手比耶', File: 'expressions/双手比耶.exp3.json' },
          { Name: '吐舌', File: 'expressions/吐舌.exp3.json' },
          { Name: '吐魂', File: 'expressions/吐魂.exp3.json' },
          { Name: '呆呆眼', File: 'expressions/呆呆眼.exp3.json' },
          { Name: '哭', File: 'expressions/哭.exp3.json' },
          { Name: '喵喵手~喵~动画', File: 'expressions/喵喵手~喵~动画.exp3.json' },
          { Name: '圆眼镜', File: 'expressions/圆眼镜.exp3.json' },
          { Name: '墨镜', File: 'expressions/墨镜.exp3.json' },
          { Name: '头箍', File: 'expressions/头箍.exp3.json' },
          { Name: '巴菲', File: 'expressions/巴菲.exp3.json' },
          { Name: '开心兴奋', File: 'expressions/开心兴奋.exp3.json' },
          { Name: '心跳', File: 'expressions/心跳.exp3.json' },
          { Name: '悲伤', File: 'expressions/悲伤.exp3.json' },
          { Name: '情绪花花', File: 'expressions/情绪花花.exp3.json' },
          { Name: '感叹号', File: 'expressions/感叹号.exp3.json' },
          { Name: '手机换色', File: 'expressions/手机换色.exp3.json' },
          { Name: '挤', File: 'expressions/挤.exp3.json' },
          { Name: '撤回', File: 'expressions/撤回.exp3.json' },
          { Name: '方眼镜', File: 'expressions/方眼镜.exp3.json' },
          { Name: '星星眼', File: 'expressions/星星眼.exp3.json' },
          { Name: '晕晕', File: 'expressions/晕晕.exp3.json' },
          { Name: '椭圆眼镜', File: 'expressions/椭圆眼镜.exp3.json' },
          { Name: '橡皮', File: 'expressions/橡皮.exp3.json' },
          { Name: '流汗', File: 'expressions/流汗.exp3.json' },
          { Name: '深色桌布', File: 'expressions/深色桌布.exp3.json' },
          { Name: '点菜按下', File: 'expressions/点菜按下.exp3.json' },
          { Name: '爱心眼', File: 'expressions/爱心眼.exp3.json' },
          { Name: '猫猫贴纸', File: 'expressions/猫猫贴纸.exp3.json' },
          { Name: '生气', File: 'expressions/生气.exp3.json' },
          { Name: '画笔', File: 'expressions/画笔.exp3.json' },
          { Name: '脸红', File: 'expressions/脸红.exp3.json' },
          { Name: '蛋包饭', File: 'expressions/蛋包饭.exp3.json' },
          { Name: '蝴蝶结贴纸', File: 'expressions/蝴蝶结贴纸.exp3.json' },
          { Name: '调皮', File: 'expressions/调皮.exp3.json' },
          { Name: '闭眼口水', File: 'expressions/闭眼口水.exp3.json' },
          { Name: '问号', File: 'expressions/问号.exp3.json' },
          { Name: '阴暗', File: 'expressions/阴暗.exp3.json' },
          { Name: '魔爪', File: 'expressions/魔爪.exp3.json' },
          { Name: '魔爪换色', File: 'expressions/魔爪换色.exp3.json' },
          { Name: '鲸鱼', File: 'expressions/鲸鱼.exp3.json' },
          { Name: '鲸鱼放桌上', File: 'expressions/鲸鱼放桌上.exp3.json' },
        ],
        physics: true, pose: false,
        lipSyncParameters: ['ParamMouthOpenY'], eyeBlinkParameters: ['ParamEyeLOpen', 'ParamEyeROpen'],
        idleGroup: 'idle', tapGroup: 'aidale',
        motionSlots: {
          idle: 'idle', touch: 'aidale', think: 'idle', speak: 'idle', observe: 'idle',
          cheerful: 'aidale', concerned: 'idle', alert: 'aidale', attention: 'idle', shy: 'idle',
        },
        unassignedMotions: ['selfie', 'selfieQuick', 'ketchup', 'openLid', 'bubble', 'splash'],
      },
    },
    'da-feiyu': {
      id: 'da-feiyu',
      name: '大肥鱼',
      url: './models/da-feiyu/大肥鱼.model3.json',
      idleGroup: '',
      tapGroup: '',
      source: 'built_in',
      capabilities: {
        motions: [],
        expressions: [
          { Name: '01 口型切换', File: 'EXP/01 口型切换.exp3.json' },
          { Name: '02 3嘴', File: 'EXP/02 3嘴.exp3.json' },
          { Name: '02 龇牙', File: 'EXP/02 龇牙.exp3.json' },
          { Name: '03 脸黑', File: 'EXP/03 脸黑.exp3.json' },
          { Name: '04 脸红', File: 'EXP/04 脸红.exp3.json' },
          { Name: '05 O O', File: 'EXP/05 O O.exp3.json' },
          { Name: '05 》《', File: 'EXP/05 》《.exp3.json' },
          { Name: '06 X X', File: 'EXP/06 X X.exp3.json' },
          { Name: '07 流口水', File: 'EXP/07 流口水.exp3.json' },
          { Name: '08 O嘴', File: 'EXP/08 O嘴.exp3.json' },
          { Name: '08 担心嘴', File: 'EXP/08 担心嘴.exp3.json' },
          { Name: '08 栗子嘴', File: 'EXP/08 栗子嘴.exp3.json' },
          { Name: '11 尾巴消失', File: 'EXP/11 尾巴消失.exp3.json' },
          { Name: '12 耳朵消失', File: 'EXP/12 耳朵消失.exp3.json' },
          { Name: '13 水印消除', File: 'EXP/13 水印消除.exp3.json' },
        ],
        physics: true, pose: false,
        lipSyncParameters: [], eyeBlinkParameters: [],
        idleGroup: '', tapGroup: '',
        motionSlots: {},
        unassignedMotions: [],
      },
    },
  }

  const requestedModelId = new URLSearchParams(window.location.search).get('model')
  const runtimeMode = new URLSearchParams(window.location.search).get('runtime')
  const electronRuntime = Boolean(window.mioDesktop)
  const root = document.getElementById('pet-root')
  const canvas = document.getElementById('live2d-canvas')
  const loading = document.getElementById('loading')
  const errorPanel = document.getElementById('error')
  const errorMessage = document.getElementById('error-message')
  const contextMenu = document.getElementById('context-menu')
  const activityIndicator = document.getElementById('activity-indicator')
  const speechBubbleButton = contextMenu.querySelector('[data-action="speech-bubble"]')
  // 流式气泡与横条各自独立的菜单项（用户裁决：任何气泡文本与流式气泡**独立管理**，
  // 两个不同按钮各自显示/隐藏，互不牵连）。
  const streamBubbleButton = contextMenu.querySelector('[data-action="stream-bubble"]')
  const stripButton = contextMenu.querySelector('[data-action="strip"]')
  // DSH 专用化：原 `speechLanguageButton`（右键菜单「截图提问」按钮引用）已随该功能移除
  const agentBadgeButton = contextMenu.querySelector('[data-action="agent-badge"]')
  const speechBubble = document.getElementById('speech-bubble')
  const speechBubbleText = document.getElementById('speech-bubble-text')
  const modelSelect = document.getElementById('model-select')
  const sizePanel = document.getElementById('size-panel')
  const sizeSlider = document.getElementById('size-slider')
  const sizeValue = document.getElementById('size-value')
  const opacityPanel = document.getElementById('opacity-panel')
  const opacitySlider = document.getElementById('opacity-slider')
  const opacityValue = document.getElementById('opacity-value')

  let app = null
  let model = null
  let currentModelId = ''
  // 窗口虚拟边界修正完成前保持模型隐藏，避免启动时先用旧坐标系定位再跳位
  let windowStable = false
  // 模型自带"水印消除"表达式时，加载后自动应用并在每帧保持（大肥鱼等商用模型默认去水印）
  let watermarkParamMap = null
  let watermarkExpressionName = ''
  let modelDefinitions = { ...builtInModels }
  let desktopState = { bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } }
  let desktopSelectedModelId = ''
  // ★ 形象切换的两个独立状态（v4.2 二次修复，勿合并）：
  // ① modelSwitchTarget/At —— **用户切换意图**，只在 switchModel() 里赋值。
  //    用途：切换宽限期。PATCH 之前已在途的旧 /status 响应会把 live2d_model_id 盖回旧值，
  //    宽限期内（10s）applySettings 强行以本地目标为准。
  //    ⚠ 不能用 loadModel 顺手赋值：真实 Electron 里主进程在 ipcMain.handle 内**同步**
  //    sendModelsChanged()，广播先于 invoke 回包到达 ⇒ onModelsChanged 回调先执行，
  //    此刻 settings 还是旧值 ⇒ 那次 loadModel(旧) 若也写"pending"，就会把宽限期劫持成
  //    "10s 内强行锁回旧形象"（v4.2 一版修复在线上弹回的真凶）。
  // ② lastLoad —— 最近一次 loadModel 的在途状态（gen/target/done）。
  //    用途：applySettings 重载判据。currentModelId 只在加载**完成**后才赋值，
  //    大模型（大肥鱼 8192/28MB）加载数秒，只看它会让每次 5s 轮询都重复加载。
  let modelSwitchTarget = ''
  let modelSwitchAt = 0
  let lastLoad = { gen: 0, target: '', done: true }
  let settings = {}
  let latestMessageId = null
  let lastStatusSuccess = Date.now()
  let activityRevision = -1
  let currentActivity = 'idle'
  let activityUntil = 0
  let currentEmotion = 'neutral'
  let emotionUntil = 0
  let speakingUntil = 0
  // 表情预览后自动恢复待机表情的定时器（防止预览表情卡住不回待机）
  let expressionPreviewResetTimer = null
  // 动作预览后恢复待机动作的定时器
  let motionPreviewResetTimer = null
  let nextIdleMotionAt = Date.now() + 9000
  // 空闲降帧：长时间无交互/无说话时降低渲染帧率，节省 GPU/CPU（长挂机友好）
  let lastPetActivityAt = performance.now()
  let petFpsDowngraded = false
  function markPetActivity() {
    lastPetActivityAt = performance.now()
    // 任何用户交互都算"被打扰过"，重置自语计时
    try { markPetInteraction() } catch (_) {}
    if (petFpsDowngraded && app && app.ticker) {
      app.ticker.maxFPS = 0  // 恢复默认（不限帧）
      petFpsDowngraded = false
    }
  }
  let lastSizePercent = 0
  let pointerDown = null
  let dragged = false
  let inertiaRaf = null   // 拖拽惯性 rAF 句柄（松手滑行循环）
  let modelLoadGeneration = 0
  let sizeCommitTimer = null
  let passThroughFrame = null
  let interactiveState = null
  let socket = null
  let socketRetry = 0
  let socketRetryTimer = null
  let socketPingTimer = null
  let backendOfflineSince = 0
  let backendOfflineTimer = null
  let audioContext = null
  let analyser = null
  let analyserData = null
  let currentAudio = null
  let currentAudioUrl = ''
  let currentSpeechAbort = null
  let streamGain = null
  let streamSources = new Set()
  let streamPlaybackActive = false
  let streamScheduledUntil = 0
  let streamPendingBuffers = []
  let streamPendingDuration = 0
  let streamHasStarted = false
  let streamSpeechToken = 0
  let voiceLifecycleActive = false
  let mouthLevel = 0
  let xzMouthAt = 0      // 最近一次外部口型事件时间（pet-xz-audio.js 音频能量分析）
  let xzMouthLevel = -1  // 最近一次外部口型幅度 0-1
  let speechStartCount = 0
  let speechEndCount = 0
  let speechInterruptCount = 0
  let speechFinishedCount = 0
  let speechQueuedCount = 0
  let speechDroppedCount = 0
  let speechRequestCount = 0
  let speechFailureCount = 0
  let speechLifecycleHistory = []
  let lastSpeechError = ''
  let maxMouthLevel = 0
  let lastSpeechStartedAt = ''
  let lastSpeechEndedAt = ''
  let lastVoiceEventSent = false
  let lastStreamMode = ''
  let streamFirstAudioLatencyMs = null
  let lastVisualEvent = null
  let lastForegroundTitle = ''
  let activeResponseId = ''
  let activeSpeechPriority = -1
  let speechQueue = []
  let speechDrainTimer = null
  let activeSpeechText = ''
  let speechBubbleTimer = null
  let speechBubbleHideTimer = null
  let speechBubbleCharacterCount = 0
  let speechBubbleVisibleCount = 0
  let speechBubbleResponseId = ''
  // 「说话气泡」总开关上一次**已生效**的值。用于识别"开着→关掉"的下降沿，
  // 避免 pollStatus 重复推送同一个假值（快照缺键 / 开关关闭态）时反复误隐气泡。
  // 初值用 null 表示「尚未建立基线」：首个快照只用来**记基线**，不算下降沿。
  // （若初值给 true，则启动那一刻 start() 里那次 await pollStatus 带回来的首个假值
  //   会被误判成"用户刚关掉开关"，正好落在流开始前后，把气泡提前打掉——实测复现。）
  // 真机上用户主动关开关发生在基线建立之后，仍会被正确识别为下降沿并立即隐藏。
  let speechBubbleEnabledApplied = null
  // 7.6：上一次已处理的"重新启用横条"令牌（防止轮询重复复位用户的 ✕ 决定）
  let stripResetTokenSeen = ''
  let streamFirstAudioTimer = null
  let lastMotionGroup = ''
  let lastMotionPlayedAt = 0
  let cursorFocusFrame = null
  let lastForegroundHandledAt = 0
  let lastHandledForegroundTitle = ''
  let lastAppliedExpressionEmotion = ''
  let rendererUpdateCount = 0
  let rendererUpdateWindowStartedAt = performance.now()
  let rendererMeasuredFps = 0
  let rendererLastFrameAt = performance.now()
  let playbackFrameTimes = []
  let playbackFpsSamples = []
  let playbackFrameWindowStartedAt = 0
  let playbackFrameWindowCount = 0
  let proceduralMotionHint = ''
  let proceduralMotionStartedAt = 0
  let proceduralMotionUntil = 0
  let proceduralMotionIntensity = 0
  let proceduralMotionStartCount = 0
  let proceduralMotionPeak = 0
  let visualPerformanceUntil = 0
  let visualFrameTimes = []
  let visualFpsSamples = []
  let visualFrameWindowStartedAt = 0
  let visualFrameWindowCount = 0

  const browserBridge = {
    begin_drag: async () => ({ ok: true }),
    drag_to: async () => ({ ok: true }),
    end_drag: async () => ({ ok: true }),
    resize_window: async (percent) => ({ ok: true, percent }),
    set_size: async (percent) => ({ ok: true, percent }),
    cursor_state: async () => ({ ok: false, x: 0, y: 0 }),
    open_chat: async () => ({ ok: false }),
    open_agent: async () => ({ ok: false }),
    say_hello: async () => ({ ok: false }),
    toggle_observation: async () => ({ ok: false, running: false }),
    close_pet: async () => ({ ok: false }),
  }

  const electronBridge = {
    begin_drag: async () => ({ ok: true }),
    drag_to: async () => ({ ok: true }),
    end_drag: async () => ({ ok: true }),
    resize_window: async (percent) => ({ ok: true, percent }),
    set_size: async (percent) => {
      await request('/api/companion/size', {
        method: 'PATCH',
        body: JSON.stringify({ percent }),
      })
      return { ok: true, percent }
    },
    cursor_state: async () => ({ ok: false, x: 0, y: 0 }),
    open_chat: async () => {
      const bounds = model?.getBounds?.()
      const anchorX = bounds
        ? Number(window.screenX || 0) + Number(bounds.x || 0) + Number(bounds.width || 0) / 2
        : Number(window.screenX || 0) + window.innerWidth / 2
      const anchorY = bounds
        ? Number(window.screenY || 0) + Number(bounds.y || 0)
        : Number(window.screenY || 0) + window.innerHeight / 2
      return window.mioDesktop.toggleChatWindow({
        anchorX: Math.round(anchorX),
        anchorY: Math.round(anchorY),
      })
    },
    open_agent: async () => {
      return window.mioDesktop.openAgent()
    },
    say_hello: async () => {
      await dispatchSpeech({ text: '我在这里', emotion: 'gentle', source: 'desktop_pet', priority: 100 })
      return { ok: true }
    },
    toggle_observation: async () => toggleObservation(),
    close_pet: async () => window.mioDesktop.close(),
  }

  const waitForBridge = () => new Promise((resolve) => {
    if (electronRuntime) {
      resolve(electronBridge)
      return
    }
    if (window.pywebview?.api) {
      resolve(window.pywebview.api)
      return
    }
    window.addEventListener('pywebviewready', () => resolve(window.pywebview.api), { once: true })
    window.setTimeout(() => resolve(window.pywebview?.api || browserBridge), 350)
  })

  async function request(path, options = {}) {
    // 全局超时：官方云断连时 say/vision 可能长时间阻塞，避免前端无限挂起（"卡住"）
    // 25s：vision 注入（SAPI 合成+发送）与官方回答链路的余量，避免"请求超时(12s)"误报
    const timeoutMs = options.timeoutMs || 25000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(path, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        signal: controller.signal,
        ...options,
      })
    } catch (err) {
      clearTimeout(timer)
      if (err.name === 'AbortError') throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's），可能小智官方云暂未响应')
      throw err
    }
    clearTimeout(timer)
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const detail = await response.json()
        message = String(detail.detail || message)
      } catch (_) {}
      throw new Error(message)
    }
    const contentType = response.headers.get('content-type') || ''
    return contentType.includes('application/json') ? response.json() : response
  }

  function createApplication() {
    app = new PIXI.Application({
      view: canvas,
      autoStart: true,
      resizeTo: root,
      transparent: true,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),  // 渲染采样上限 2x（清晰度优先；内存由空闲降帧/按需创建解锁窗控制）
    })
    app.stage.sortableChildren = true
    app.ticker.add(updateModelPerformance, undefined, -50)
    // 空闲降帧巡检：连续 8 秒无交互/无说话 → 降到 9fps；有活动立即恢复
    app.ticker.add(() => {
      if (currentActivity !== 'idle') { markPetActivity(); return }
      if (!petFpsDowngraded && performance.now() - lastPetActivityAt > 8000) {
        app.ticker.maxFPS = 9
        petFpsDowngraded = true
      }
    }, undefined, -40)
    // Agent 徽标跟随模型头顶（角色移动/点头时同步）
    app.ticker.add(() => {
      updateAgentBadgePosition()
      updatePressBounce()
    }, undefined, -30)
    // 上报模型区域/UI 状态给主进程（穿透策略）
    app.ticker.add(() => {
      reportModelBounds()
      reportUiOpen()
    }, undefined, -25)
  }

  function modelDefinition(modelId) {
    return modelDefinitions[modelId] || modelDefinitions.hiyori
  }

  function currentCapabilityPayload() {
    const definition = modelDefinition(currentModelId)
    const capabilities = definition?.capabilities || {}
    return {
      motions: Array.isArray(capabilities.motions) ? capabilities.motions : [],
      expressions: Array.isArray(capabilities.expressions) ? capabilities.expressions : [],
      physics: Boolean(capabilities.physics),
      pose: Boolean(capabilities.pose),
      lipSyncParameters: Array.isArray(capabilities.lipSyncParameters) ? capabilities.lipSyncParameters : [],
      eyeBlinkParameters: Array.isArray(capabilities.eyeBlinkParameters) ? capabilities.eyeBlinkParameters : [],
      idleGroup: String(definition?.idleGroup || capabilities.idleGroup || ''),
      tapGroup: String(definition?.tapGroup || capabilities.tapGroup || ''),
      motionSlots: capabilities.motionSlots && typeof capabilities.motionSlots === 'object'
        ? { ...capabilities.motionSlots }
        : {},
      expressionSlots: capabilities.expressionSlots && typeof capabilities.expressionSlots === 'object'
        ? { ...capabilities.expressionSlots }
        : {},
      unassignedMotions: Array.isArray(capabilities.unassignedMotions)
        ? capabilities.unassignedMotions.map(String)
        : [],
    }
  }

  function sendRendererReady() {
    const definition = modelDefinition(currentModelId)
    sendSocket('renderer_ready', {
      runtime: runtimeMode || (electronRuntime ? 'electron' : (window.pywebview ? 'pywebview' : 'browser')),
      model_id: currentModelId,
      model_name: String(definition?.name || currentModelId),
      capabilities: currentCapabilityPayload(),
    })
  }

  function selectedModelId() {
    if (requestedModelId && modelDefinitions[requestedModelId]) return requestedModelId
    if (desktopSelectedModelId && modelDefinitions[desktopSelectedModelId]) return desktopSelectedModelId
    return modelDefinitions[String(settings.live2d_model_id || '')]
      ? String(settings.live2d_model_id)
      : 'hiyori'
  }

  function populateModelSelect() {
    if (!modelSelect) return
    const selected = selectedModelId()
    modelSelect.replaceChildren()
    Object.values(modelDefinitions).forEach((definition) => {
      const option = document.createElement('option')
      option.value = definition.id
      option.textContent = definition.name
      option.selected = definition.id === selected
      modelSelect.appendChild(option)
    })
  }

  function mergeImportedModels(payload) {
    const imported = Array.isArray(payload?.models) ? payload.models : []
    modelDefinitions = { ...builtInModels }
    imported.forEach((entry) => {
      if (!entry?.id || !entry?.modelUrl) return
      modelDefinitions[String(entry.id)] = {
        id: String(entry.id),
        name: String(entry.name || entry.id),
        url: String(entry.modelUrl),
        idleGroup: String(entry.capabilities?.idleGroup || ''),
        tapGroup: String(entry.capabilities?.tapGroup || ''),
        // ★ 主进程目录里内置模型也带 modelUrl（source:'built_in'），不能一律当 imported：
        //   switchModel 靠 source 决定「给主进程设覆盖」还是「清掉覆盖」。
        //   早先写死 'imported' ⇒ 内置模型被误判 ⇒ 桌面侧覆盖永远不干净，
        //   而且那时内置分支（写服务端）永远走不到，形象切换后被 5s 轮询弹回。
        source: String(entry.source || '') === 'built_in' ? 'built_in' : 'imported',
        capabilities: entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {},
        authorization: entry.authorization && typeof entry.authorization === 'object' ? entry.authorization : {},
        renderOptimization: entry.renderOptimization && typeof entry.renderOptimization === 'object'
          ? { ...entry.renderOptimization }
          : {},
      }
    })
    // 尊重显式的空串：「没有桌面侧覆盖」也是有效状态，不能用 || 粘住上一个覆盖值
    // （否则切回内置形象时，旧导入覆盖会被粘住一会儿，出现一段无谓的回弹）。
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'selectedModelId')) {
      desktopSelectedModelId = String(payload.selectedModelId || '')
    }
    populateModelSelect()
  }

  /**
   * ★ 桌宠不透明度（2026-10-17）。
   *
   * ⚠ 真根因（用户实测"不透明度不可用"）：**`model.alpha`（PIXI Container 属性）
   * 对 Cubism 模型无效** —— pixi-live2d-display 的 Cubism 渲染走 internalModel 的
   * 自定义 WebGL 路径（打包库里 `\.alpha` 出现 0 次），绘制透明度由 Cubism 的
   * **ModelColor** 渲染参数控制，不乘 Container.alpha。
   * 正确 API：`model.internalModel.coreModel.setModelColor(r,g,b,a)`，第 4 参即整体透明度。
   * （Cubism 4 core 的 setModelColor 会把该颜色乘到所有 Drawable 上。）
   */
  function applyPetOpacity(pct) {
    const alpha = Math.max(0.1, Math.min(1, Number(pct) / 100))
    if (!model) return
    try {
      const core = model.internalModel && model.internalModel.coreModel
      if (core && typeof core.setModelColor === 'function') {
        core.setModelColor(1, 1, 1, alpha)
        return
      }
      // 兜底：非 Cubism 渲染路径（如旧版/其它实现）退回 PIXI alpha
      model.alpha = alpha
    } catch (_) {
      try { model.alpha = alpha } catch (_e) {}
    }
  }

  async function loadModel(modelId) {
    const definition = modelDefinition(modelId)
    const generation = ++modelLoadGeneration
    // 记录在途状态：applySettings 用它区分「目标已在加载中」与「需要重新发起」
    lastLoad = { gen: generation, target: definition.id, done: false }
    loading.hidden = false
    errorPanel.hidden = true
    let nextModel = null
    try {
      nextModel = await PIXI.live2d.Live2DModel.from(definition.url, { autoInteract: false })
      if (generation !== modelLoadGeneration) {
        nextModel.destroy({ children: true, texture: false, baseTexture: false })
        return
      }
      if (model) {
        app.stage.removeChild(model)
        model.destroy({ children: true, texture: false, baseTexture: false })
      }
      app.stage.children.slice().forEach((child) => {
        if (child?.internalModel && child !== nextModel) {
          app.stage.removeChild(child)
          child.destroy({ children: true, texture: false, baseTexture: false })
        }
      })
      model = nextModel
      model.anchor.set(0.5, 0.5)
      model.eventMode = 'none'
      app.stage.addChild(model)
      // Electron 启动时等窗口虚拟边界修正完成再显示，杜绝"先下方后上方"跳位
      model.visible = windowStable || !electronRuntime
      currentModelId = definition.id
      if (lastLoad.gen === generation) lastLoad.done = true
      lastAppliedExpressionEmotion = ''
      // 必须在模型可见前完成水印消除：await 保证第一帧可见时水印参数已生效
      // （Electron 侧 windowStable 会再延迟显示，双保险无冲突）
      await applyWatermarkRemoval(definition)
      fitModel()
      // ★ 不透明度（2026-10-17）：模型加载完成后立即应用持久化的透明度，
      //   否则重启/切模型后 alpha 回到 1.0（applySettings 是在加载前调用的）。
      try {
        const op = Number(settings.live2d_pet_opacity)
        if (Number.isFinite(op)) applyPetOpacity(op)
      } catch (_) {}
      nextIdleMotionAt = Date.now() + 3500
      if (windowStable || !electronRuntime) loading.hidden = true
      populateModelSelect()
      updateMousePassThrough(true)
      sendRendererReady()
    } catch (error) {
      if (generation !== modelLoadGeneration) {
        if (nextModel) nextModel.destroy({ children: true, texture: false, baseTexture: false })
        return
      }
      // 加载失败：标记在途结束，让下一次轮询仍能重试（保留原有失败自愈语义）
      if (lastLoad.gen === generation) lastLoad.done = true
      console.error('[MioLive2D] model load failed', error)
      loading.hidden = true
      errorPanel.hidden = false
      errorMessage.textContent = String(error?.message || error || '未知错误')
      sendSocket('renderer_error', { message: errorMessage.textContent, model_id: definition.id })
      setInteractive(true)
    }
  }

  function targetSize() {
    const percent = Number(settings.pet_size_percent || 150) / 100
    return { width: 280 * percent, height: 400 * percent }
  }

  function fitModel() {
    if (!model) return
    model.scale.set(1)
    const bounds = model.getLocalBounds()
    const target = targetSize()
    const baseScale = Math.min(
      target.width / Math.max(1, bounds.width),
      target.height / Math.max(1, bounds.height),
    )
    model.scale.set(baseScale * Number(settings.live2d_scale || 1))
    if (electronRuntime) {
      const virtual = desktopState.bounds || { x: 0, y: 0 }
      // 换屏/改分辨率后，保存的位置可能超出当前虚拟屏幕（例如 2K 屏右下角
      // 换到 1K 屏）。把位置限制在当前虚拟屏幕内，保证桌宠主体始终可见。
      let posX = Number(settings.position_x ?? 80)
      let posY = Number(settings.position_y ?? 420)
      const vw = Number(virtual.width) || window.innerWidth
      const vh = Number(virtual.height) || window.innerHeight
      const marginX = Math.min(72, Math.max(32, vw * 0.08))
      const marginY = Math.min(96, Math.max(48, vh * 0.1))
      // 位置原样恢复，不做任何限位（用户自由拖拽）
      posX = posX
      posY = posY
      model.x = posX - Number(virtual.x || 0) + target.width / 2
      model.y = posY - Number(virtual.y || 0) + target.height / 2
        + target.height * Number(settings.live2d_vertical_offset || 0)
    } else {
      model.x = window.innerWidth / 2
      model.y = window.innerHeight * (0.5 + Number(settings.live2d_vertical_offset || 0))
    }
    if (settings.live2d_keep_visible) clampModelToViewport()
    updateSpeechBubblePosition(true)
    updateLockControlAnchor(true)
    reportModelBounds()
  }

  // 底部可见下限：以屏幕高度（DIP）为准，而不是窗口高度——
  // 桌宠窗口是覆盖虚拟桌面的透明大画布（可能比屏幕高），模型 y 超过屏幕底对应坐标就会掉出物理屏
  function visibleBottomLimit() {
    const vh = Number(window.screen?.availHeight) || window.innerHeight
    return Math.round(Math.min(window.innerHeight, vh) * 0.65)
  }

  function clampModelToViewport() {
    // 用户要求完全自由拖拽：上下/水平均不做任何限位，此函数为空操作（保留入口以防历史调用）
    if (!model) return
  }

  function setParameter(id, value, weight = 1) {
    try {
      model?.internalModel?.coreModel?.setParameterValueById(id, value, weight)
    } catch (_) {}
  }

  // 模型自带"水印消除"表达式时：解析其参数表并立即应用一次；之后由
  // updateModelPerformance 每帧保持，避免表情/动作切换重置参数后水印复现。
  async function applyWatermarkRemoval(definition) {
    watermarkParamMap = null
    watermarkExpressionName = ''
    if (!definition || !model?.expression) return
    // 仅大肥鱼（da-feiyu）模型需要消除水印：写死参数映射（Paramcol_3=1，等价官方「13 水印消除」表情），
    // 初始化时直接置参，不依赖表达式文件网络 fetch——避免路径解析/请求失败导致水印残留
    if (String(definition.id || '') !== 'da-feiyu') return
    watermarkParamMap = { Paramcol_3: 1 }
    watermarkExpressionName = '13 水印消除'
    try {
      // 立即同步置参一次：不等下一帧 ticker，也不依赖 model.expression 的淡入时序，
      // 保证 applyWatermarkRemoval 返回时水印参数已经生效（初始化第一帧就无水印）
      for (const paramId in watermarkParamMap) setParameter(paramId, watermarkParamMap[paramId])
      Promise.resolve(model.expression(watermarkExpressionName)).catch(() => {})
    } catch (error) {
      console.debug('[MioLive2D] watermark expression load failed', error)
    }
  }

  function addParameter(id, value, weight = 1) {
    try {
      model?.internalModel?.coreModel?.addParameterValueById(id, value, weight)
    } catch (_) {}
  }

  function percentile(values, ratio) {
    if (!values.length) return 0
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
  }

  function visualPerformanceSnapshot() {
    return {
      sampleCount: visualFrameTimes.length,
      minFps: visualFpsSamples.length ? Number(Math.min(...visualFpsSamples).toFixed(1)) : 0,
      frameTimeP95Ms: Number(percentile(visualFrameTimes, 0.95).toFixed(2)),
      framesOver33Ms: visualFrameTimes.filter((value) => value > 33).length,
      framesOver50Ms: visualFrameTimes.filter((value) => value > 50).length,
    }
  }

  function rendererDiagnostics() {
    const renderer = app?.renderer
    const gl = renderer?.gl
    let graphicsRenderer = ''
    let graphicsVendor = ''
    try {
      const debugInfo = gl?.getExtension?.('WEBGL_debug_renderer_info')
      if (debugInfo) {
        graphicsRenderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '')
        graphicsVendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '')
      }
    } catch (_) {}
    return {
      type: Number(renderer?.type || 0),
      resolution: Number(renderer?.resolution || 0),
      width: Number(renderer?.width || 0),
      height: Number(renderer?.height || 0),
      graphicsRenderer,
      graphicsVendor,
    }
  }

  function startVisualPerformanceWindow(durationMs) {
    const now = performance.now()
    const wasActive = now < visualPerformanceUntil
    visualPerformanceUntil = Math.max(visualPerformanceUntil, now + Math.max(1000, Number(durationMs || 0)))
    if (!wasActive) {
      visualFrameWindowStartedAt = now
      visualFrameWindowCount = 0
    }
  }

  function startProceduralMotion(hint, importance = 0.5) {
    if (!model?.internalModel?.coreModel) return false
    const now = Date.now()
    const normalizedHint = String(hint || 'observe')
    if (
      now - lastMotionPlayedAt < 1200
      || (lastMotionGroup === `procedural:${normalizedHint}` && now - lastMotionPlayedAt < 3500)
    ) return false
    const duration = {
      celebrate: 2400,
      concern: 2100,
      alert: 1500,
      attention: 1700,
      observe: 2000,
      thinking: 2200,
      listening: 1800,
      shy: 2200,
    }[normalizedHint] || 1800
    proceduralMotionHint = normalizedHint
    proceduralMotionStartedAt = now
    proceduralMotionUntil = now + duration
    proceduralMotionIntensity = Math.max(0.35, Math.min(1, Number(importance || 0.5)))
    proceduralMotionStartCount += 1
    proceduralMotionPeak = 0
    lastMotionGroup = `procedural:${normalizedHint}`
    lastMotionPlayedAt = now
    startVisualPerformanceWindow(duration + 300)
    return true
  }

  function updateProceduralMotion() {
    const now = Date.now()
    if (!proceduralMotionHint || now >= proceduralMotionUntil) {
      proceduralMotionHint = ''
      proceduralMotionUntil = 0
      proceduralMotionIntensity = 0
      return
    }
    const duration = Math.max(1, proceduralMotionUntil - proceduralMotionStartedAt)
    const progress = Math.max(0, Math.min(1, (now - proceduralMotionStartedAt) / duration))
    const envelope = Math.sin(Math.PI * progress) * proceduralMotionIntensity
    const wave = Math.sin(progress * Math.PI * 2)
    const fastWave = Math.sin(progress * Math.PI * 4)
    let angleX = 0
    let angleY = 0
    let angleZ = 0
    let bodyX = 0
    let bodyY = 0
    let bodyZ = 0
    if (proceduralMotionHint === 'celebrate') {
      angleY = -7 * envelope
      angleZ = 5 * wave * envelope
      bodyY = 4 * Math.abs(fastWave) * envelope
    } else if (proceduralMotionHint === 'concern') {
      angleX = -4 * envelope
      angleY = 5 * envelope
      angleZ = -5 * envelope
      bodyX = -2.5 * envelope
    } else if (proceduralMotionHint === 'alert') {
      angleY = -8 * envelope
      bodyY = 4 * envelope
    } else if (proceduralMotionHint === 'attention' || proceduralMotionHint === 'listening') {
      angleX = 7 * wave * envelope
      angleY = -3 * envelope
      bodyX = 2 * wave * envelope
    } else if (proceduralMotionHint === 'thinking') {
      angleX = 5 * envelope
      angleZ = -6 * envelope
      bodyX = 2 * envelope
    } else if (proceduralMotionHint === 'shy') {
      angleX = -5 * envelope
      angleY = 4 * envelope
      angleZ = -6 * envelope
      bodyZ = -2 * envelope
    } else {
      angleX = 5 * wave * envelope
      angleY = -2 * envelope
      bodyX = 1.8 * wave * envelope
    }
    proceduralMotionPeak = Math.max(
      proceduralMotionPeak,
      Math.abs(angleX), Math.abs(angleY), Math.abs(angleZ),
      Math.abs(bodyX), Math.abs(bodyY), Math.abs(bodyZ),
    )
    addParameter('ParamAngleX', angleX, 0.85)
    addParameter('ParamAngleY', angleY, 0.85)
    addParameter('ParamAngleZ', angleZ, 0.7)
    addParameter('ParamBodyAngleX', bodyX, 0.75)
    addParameter('ParamBodyAngleY', bodyY, 0.75)
    addParameter('ParamBodyAngleZ', bodyZ, 0.75)
  }

  let lastLockAnchorAt = 0
  function updateLockControlAnchor(force = false) {
    if (!electronRuntime || !model || !model.visible) return
    // 节流：拖动路径每帧都会调用，getBounds 是全模型遍历重操作；
    // 80ms 节流（≈12Hz）足够锁定窗跟随，强制刷新留给定位/结束场景
    const now = performance.now()
    if (!force && now - lastLockAnchorAt < 80) return
    lastLockAnchorAt = now
    const bounds = model.getBounds()
    window.mioDesktop.setLockControlAnchor({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    })
  }

  function emotionParameters(emotion) {
    const em = String(emotion || '').toLowerCase()
    return {
      neutral: { mouth: 0, smile: 0, brow: 0, cheek: 0, angle: 0 },
      gentle: { mouth: 0.35, smile: 0.45, brow: 0.18, cheek: 0.12, angle: -2 },
      cheerful: { mouth: 0.82, smile: 0.95, brow: 0.35, cheek: 0.45, angle: 4 },
      concerned: { mouth: -0.45, smile: 0, brow: -0.38, cheek: 0, angle: -5 },
      serious: { mouth: -0.25, smile: 0, brow: -0.2, cheek: 0, angle: 1 },
      shy: { mouth: 0.18, smile: 0.25, brow: -0.08, cheek: 0.85, angle: -7 },
      // 小智官方 emotion 词表（llm.emotion 下发的值，官方文档 Emoji 对照表）
      happy: { mouth: 0.82, smile: 0.95, brow: 0.35, cheek: 0.45, angle: 4 },
      smile: { mouth: 0.35, smile: 0.6, brow: 0.18, cheek: 0.3, angle: 2 },
      laughing: { mouth: 0.9, smile: 1, brow: 0.3, cheek: 0.5, angle: 6 },
      funny: { mouth: 0.85, smile: 0.9, brow: 0.28, cheek: 0.48, angle: 5 },
      sad: { mouth: -0.45, smile: 0, brow: -0.38, cheek: 0, angle: -5 },
      angry: { mouth: -0.2, smile: 0, brow: -0.5, cheek: 0, angle: 0 },
      crying: { mouth: -0.5, smile: 0, brow: -0.45, cheek: 0, angle: -6 },
      loving: { mouth: 0.18, smile: 0.35, brow: -0.08, cheek: 0.85, angle: -4 },
      embarrassed: { mouth: 0.18, smile: 0.25, brow: -0.08, cheek: 0.85, angle: -7 },
      surprised: { mouth: 0.7, smile: 0.3, brow: 0.5, cheek: 0.15, angle: 0 },
      shocked: { mouth: 0.9, smile: 0.2, brow: 0.6, cheek: 0.2, angle: 0 },
      thinking: { mouth: -0.3, smile: 0, brow: -0.3, cheek: 0, angle: -3 },
      winking: { mouth: 0.3, smile: 0.7, brow: 0.2, cheek: 0.35, angle: 3 },
      cool: { mouth: 0.35, smile: 0.5, brow: 0.15, cheek: 0.2, angle: 1 },
      relaxed: { mouth: 0.2, smile: 0.3, brow: 0.05, cheek: 0.15, angle: 0 },
      delicious: { mouth: 0.5, smile: 0.6, brow: 0.2, cheek: 0.6, angle: 2 },
      kissy: { mouth: 0.5, smile: 0.5, brow: -0.1, cheek: 0.9, angle: -3 },
      confident: { mouth: 0.4, smile: 0.55, brow: 0.2, cheek: 0.2, angle: 1 },
      sleepy: { mouth: -0.1, smile: 0.05, brow: -0.15, cheek: 0, angle: -2 },
      silly: { mouth: 0.6, smile: 0.7, brow: 0.25, cheek: 0.5, angle: 5 },
      confused: { mouth: -0.25, smile: 0, brow: -0.35, cheek: 0, angle: -4 },
    }[em] || { mouth: 0, smile: 0, brow: 0, cheek: 0, angle: 0 }
  }

  function updateModelPerformance() {
    if (!model?.internalModel?.coreModel) return
    const measuredAt = performance.now()
    const frameTime = Math.max(0, measuredAt - rendererLastFrameAt)
    rendererLastFrameAt = measuredAt
    rendererUpdateCount += 1
    if (voiceLifecycleActive && frameTime > 0) {
      playbackFrameTimes.push(frameTime)
      if (playbackFrameTimes.length > 2400) playbackFrameTimes.shift()
      playbackFrameWindowCount += 1
      const playbackWindowMs = measuredAt - playbackFrameWindowStartedAt
      if (playbackWindowMs >= 500) {
        playbackFpsSamples.push(playbackFrameWindowCount * 1000 / playbackWindowMs)
        playbackFrameWindowStartedAt = measuredAt
        playbackFrameWindowCount = 0
      }
    }
    if (measuredAt < visualPerformanceUntil && frameTime > 0) {
      visualFrameTimes.push(frameTime)
      if (visualFrameTimes.length > 4800) visualFrameTimes.shift()
      visualFrameWindowCount += 1
      const visualWindowMs = measuredAt - visualFrameWindowStartedAt
      if (visualWindowMs >= 500) {
        visualFpsSamples.push(visualFrameWindowCount * 1000 / visualWindowMs)
        if (visualFpsSamples.length > 1200) visualFpsSamples.shift()
        visualFrameWindowStartedAt = measuredAt
        visualFrameWindowCount = 0
      }
    }
    const measuredWindow = measuredAt - rendererUpdateWindowStartedAt
    if (measuredWindow >= 1000) {
      rendererMeasuredFps = rendererUpdateCount * 1000 / measuredWindow
      rendererUpdateCount = 0
      rendererUpdateWindowStartedAt = measuredAt
    }
    if (activityUntil && Date.now() >= activityUntil && currentActivity !== 'speaking') {
      currentActivity = 'idle'
      activityUntil = 0
      activityIndicator.className = 'activity-indicator idle'
      activityIndicator.classList.remove('active')
    }
    if (Date.now() > emotionUntil && currentActivity === 'idle') {
      // 情绪到期：尝试恢复到自然（neutral）表情；模型表情命名匹配不到时
      // 重置回默认表情，避免任何表情被应用后永久卡住（如大肥鱼）
      if (currentEmotion !== 'neutral' && lastAppliedExpressionEmotion && lastAppliedExpressionEmotion !== 'neutral') {
        const restore = expressionForEmotion('neutral')
        if (restore) {
          Promise.resolve(model.expression(restore)).catch(() => {})
        } else {
          resetModelExpression()
        }
        lastAppliedExpressionEmotion = 'neutral'
      }
      currentEmotion = 'neutral'
    }
    const emotion = emotionParameters(currentEmotion)
    setParameter('ParamMouthForm', emotion.mouth, 0.38)
    setParameter('ParamEyeLSmile', emotion.smile, 0.45)
    setParameter('ParamEyeRSmile', emotion.smile, 0.45)
    setParameter('ParamBrowLY', emotion.brow, 0.35)
    setParameter('ParamBrowRY', emotion.brow, 0.35)
    setParameter('ParamCheek', emotion.cheek, 0.5)
    setParameter('ParamAngleZ', emotion.angle, 0.15)
    updateProceduralMotion()

    let nextMouth = 0
    if (Date.now() - xzMouthAt < 350 && xzMouthLevel >= 0) {
      // 小智语音真实口型（pet-xz-audio.js 音频能量分析派发，优先于本地播放/伪随机）
      nextMouth = xzMouthLevel
    } else if (analyser && analyserData && ((currentAudio && !currentAudio.paused) || streamPlaybackActive)) {
      analyser.getByteTimeDomainData(analyserData)
      let sum = 0
      for (const value of analyserData) {
        const normalized = (value - 128) / 128
        sum += normalized * normalized
      }
      nextMouth = Math.min(1, Math.sqrt(sum / analyserData.length) * 5.2)
    } else if (Date.now() < speakingUntil || currentActivity === 'speaking') {
      nextMouth = 0.12 + Math.abs(Math.sin(Date.now() / 95)) * 0.42
    }
    mouthLevel += (nextMouth - mouthLevel) * (nextMouth > mouthLevel ? 0.36 : 0.16)
    maxMouthLevel = Math.max(maxMouthLevel, mouthLevel)
    setParameter('ParamMouthOpenY', mouthLevel)
    // 保持水印消除参数：表情/动作切换会重置参数，这里每帧强制拉回（无水印模型时为空表，无开销）
    if (watermarkParamMap) {
      for (const paramId in watermarkParamMap) {
        setParameter(paramId, watermarkParamMap[paramId])
      }
    }
  }

  function playMotion(group, index, { force = false } = {}) {
    if (!model || !group) return false
    const now = Date.now()
    const normalizedGroup = String(group)
    if (!force && (now - lastMotionPlayedAt < 1200 || (normalizedGroup === lastMotionGroup && now - lastMotionPlayedAt < 3500))) return false
    try {
      model.motion(group, Number.isInteger(index) ? index : 0, 2)
      lastMotionGroup = normalizedGroup
      lastMotionPlayedAt = now
      return true
    } catch (error) {
      console.debug('[MioLive2D] motion unavailable', group, error)
      return false
    }
  }

  function availableMotionNames() {
    const motions = currentCapabilityPayload().motions
    return motions.map((entry) => String(entry?.name || '')).filter(Boolean)
  }

  function semanticMotion(hint) {
    const names = availableMotionNames()
    const slots = currentCapabilityPayload().motionSlots || {}
    const slotName = {
      celebrate: 'cheerful',
      concern: 'concerned',
      alert: 'alert',
      attention: 'attention',
      observe: 'observe',
      thinking: 'think',
      speaking: 'speak',
      listening: 'attention',
      touch: 'touch',
      shy: 'shy',
      idle: 'idle',
    }[hint] || hint
    const configured = settings.live2d_motion_slots?.[currentModelId]?.[slotName]
    if (configured && names.includes(String(configured))) return String(configured)
    if (slots[slotName] && names.includes(String(slots[slotName]))) return String(slots[slotName])
    const patterns = {
      celebrate: [/happy|joy|cheer|win|victory|success/i, /tap|touch/i],
      concern: [/sad|worry|concern|down|lose|defeat/i, /idle|wait/i],
      alert: [/alert|angry|serious|surprise|shock/i, /tap|touch/i],
      attention: [/look|attention|curious|question/i, /idle|wait/i],
      observe: [/look|watch|observe|idle|wait/i],
      thinking: [/think|question|ponder/i, /idle|wait/i],
      speaking: [/speak|talk|voice|mouth/i, /idle|wait/i],
      listening: [/attention|listen|curious|look/i, /idle|wait/i],
      touch: [/tap|touch|click|body/i],
      shy: [/shy|blush|embarrass/i, /idle|wait/i],
      idle: [/idle|wait|stand/i],
    }[hint] || [/idle|wait/i]
    return names.find((name) => patterns.some((pattern) => pattern.test(name)))
      || modelDefinition(currentModelId)?.idleGroup
      || names[0]
      || ''
  }

  function expressionForEmotion(emotion) {
    const cap = currentCapabilityPayload()
    const names = window.MioLive2DExpression.expressionNames(cap.expressions)
    const configured = settings.live2d_expression_slots?.[currentModelId]?.[emotion]
    if (configured && names.includes(String(configured))) return String(configured)
    const capSlot = cap.expressionSlots?.[emotion]
    if (capSlot && names.includes(String(capSlot))) return String(capSlot)
    return window.MioLive2DExpression.selectExpression(cap.expressions, emotion)
  }

  // 本地情绪扫描（后端 emotion 兜底）：从小智回复/上下文文本识别"哭/笑/生气/害羞"等指令
  function localInferEmotion(text) {
    const t = String(text || '')
    if (/(哭|泪|呜呜|想哭|难过|伤心|抽泣)/.test(t)) return 'concerned'
    if (/(生气|气死|凶|发火|愤怒|恼怒)/.test(t)) return 'serious'
    if (/(害羞|脸红|羞涩|不好意思)/.test(t)) return 'shy'
    if (/(开心|高兴|哈哈|嘿嘿|笑|好耶)/.test(t)) return 'cheerful'
    if (/(温柔|轻柔|抱抱|哄|抱一下)/.test(t)) return 'gentle'
    return ''
  }

  // 情绪 → 语义动作（供 speak/视觉气泡触发动作联动）
  const EMOTION_MOTION_HINT = {
    concerned: 'concern',
    cheerful: 'celebrate',
    serious: 'alert',
    shy: 'shy',
    gentle: 'touch',
  }

  // 说话文本到达：应用情绪 + 触发情绪动作
  function applySpeakEmotionAndMotion(text, emotion) {
    let effective = String(emotion || 'neutral').toLowerCase()
    const local = localInferEmotion(text)
    if (local && (effective === 'neutral' || effective === 'gentle')) effective = local
    applyEmotion(effective, Math.max(6000, text.length * 180))
    const hint = EMOTION_MOTION_HINT[effective]
    if (hint) {
      const group = semanticMotion(hint)
      const idleGroup = semanticMotion('idle')
      if (group && group !== idleGroup) playMotion(group, undefined, { force: true })
    }
    return effective
  }

  function applyModelExpression(emotion) {
    const expression = expressionForEmotion(emotion)
    if (!expression || !model?.expression) return false
    try {
      Promise.resolve(model.expression(expression)).catch(() => {})
      return true
    } catch (_) {
      return false
    }
  }

  // 表情恢复兜底：重置到模型默认表情（清除当前应用的表达式）。
  // 用于"情绪/预览表情找不到匹配的自然表情"时，防止表情永久卡住。
  function resetModelExpression() {
    const internal = model?.internalModel
    const manager = internal?.expressionManager
    if (manager && typeof manager.resetExpression === 'function') {
      try { manager.resetExpression() } catch (_) {}
    }
  }

  function applyEmotion(emotion, durationMs = 10000) {
    const nextEmotion = String(emotion || 'neutral')
    const expressionChanged = nextEmotion !== lastAppliedExpressionEmotion
    currentEmotion = nextEmotion
    emotionUntil = Date.now() + Math.max(2000, Number(durationMs || 10000))
    if (expressionChanged && applyModelExpression(currentEmotion)) {
      lastAppliedExpressionEmotion = currentEmotion
    }
  }

  function handleVisualEvent(event) {
    if (!event) return
    lastVisualEvent = { ...event }
    const emotion = String(event.emotion || 'gentle')
    const importance = Math.max(0, Math.min(1, Number(event.importance || 0)))
    currentActivity = 'observing'
    const visualDuration = Math.max(2500, 2500 + importance * 4500)
    activityUntil = Date.now() + visualDuration
    startVisualPerformanceWindow(visualDuration)
    applyEmotion(emotion, Math.max(4000, 4500 + importance * 5500))
    const motionHint = String(event.motion_hint || 'observe')
    const motionGroup = semanticMotion(motionHint)
    if (motionGroup) playMotion(motionGroup)
    else startProceduralMotion(motionHint, importance)
  }

  function handleForegroundChanged(event) {
    const title = String(event?.title || '').trim()
    lastForegroundTitle = title
    if (!title || ['speaking', 'responding'].includes(currentActivity)) return
    const now = Date.now()
    if (title === lastHandledForegroundTitle && now - lastForegroundHandledAt < 5000) return
    lastHandledForegroundTitle = title
    lastForegroundHandledAt = now
    currentActivity = 'observing'
    activityUntil = Date.now() + 2200
    startVisualPerformanceWindow(2200)
    if (!availableMotionNames().length) startProceduralMotion('attention', 0.35)
  }

  function applyActivity(activity) {
    if (!activity) return
    const revision = Number(activity.revision || 0)
    if (revision && revision === activityRevision) return
    if (revision) activityRevision = revision
    currentActivity = String(activity.state || 'idle')
    activityUntil = currentActivity === 'idle'
      ? 0
      : Date.now() + Math.max(500, Number(activity.remaining_ms || 5000))
    activityIndicator.className = `activity-indicator ${currentActivity}`
    activityIndicator.classList.toggle('active', currentActivity !== 'idle')
    activityIndicator.title = String(activity.label || 'Mio 当前状态')
    applyEmotion(activity.emotion || 'neutral', Number(activity.remaining_ms || 6000))
  }

  // ---- 跨 Agent 总线：统一 phase → 桌宠"脸"的映射（桌宠只认 phase） ----
  const PHASE_LABELS = {
    idle: '待机', planning: '规划', thinking: '思考中', executing_tool: '执行工具',
    streaming: '回复中', waiting_input: '聆听中', voice: '说话中', complete: '完成',
    error: '出错', paused: '暂停', awaiting_approval: '待确认', heartbeat: '在线',
  }
  const PHASE_TO_ACTIVITY = {
    voice: 'speaking',
    executing_tool: 'responding',
    awaiting_approval: 'responding',
    thinking: 'responding',
    planning: 'responding',
    streaming: 'responding',
    waiting_input: 'listening',
    complete: 'idle',
    error: 'idle',
    paused: 'idle',
    heartbeat: null,
    idle: 'idle',
  }
  const PHASE_MOTION_HINT = {
    executing_tool: 'observe',
    awaiting_approval: 'attention',
    thinking: 'thinking',
    planning: 'thinking',
    streaming: 'attention',
    waiting_input: 'listening',
  }

  // 徽标开关（菜单可切换，localStorage 持久化）：默认开，仅在状态变化时短暂显示
  const agentBadgeEnabled = () => localStorage.getItem('mio_agent_badge_enabled') !== '0'

  function ensureAgentBadge() {
    let badge = document.getElementById('agent-badge')
    if (badge) return badge
    badge = document.createElement('div')
    badge.id = 'agent-badge'
    badge.style.cssText = 'position:fixed;left:0;top:0;opacity:0;transition:opacity .25s;' +
      'cursor:grab;user-select:none;z-index:9999;'
    document.body.appendChild(badge)
    // 拖动：解锁状态下可任意移动并记住位置；拖动期间暂停每帧跟随，防止被拉回
    badge.addEventListener('pointerdown', (e) => {
      if (clickThroughLocked() || !agentBadgeEnabled()) return
      e.preventDefault()
      e.stopPropagation()
      badgeDragging = true
      const rect = badge.getBoundingClientRect()
      const offX = e.clientX - rect.left
      const offY = e.clientY - rect.top
      const move = (ev) => {
        badge.style.left = `${Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - offX))}px`
        badge.style.top = `${Math.max(0, Math.min(window.innerHeight - rect.height, ev.clientY - offY))}px`
      }
      const up = (ev) => {
        badgeDragging = false
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        const r = badge.getBoundingClientRect()
        localStorage.setItem('mio_agent_badge_manual_pos', JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }))
        badge.style.cursor = 'grab'
      }
      badge.style.cursor = 'grabbing'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })
    badge.addEventListener('dblclick', () => {
      // 双击恢复跟随桌宠头顶
      localStorage.removeItem('mio_agent_badge_manual_pos')
      updateAgentBadgePosition(true)
    })
    return badge
  }

  let lastAgentBadgePos = null
  let lastBadgePosAt = 0
  let badgeDragging = false

  // ---- 多 Agent 状态栏：每个 agent 一个状态 chip，实时并排显示 ----
  // 即插即用：注册/上线即出现；停用(enabled=false)或离线(offline)即移除。
  const agentBadgeStates = new Map()

  const AGENT_STATUS_LABELS = { online: '在线', connecting: '连接中', error: '异常', offline: '离线' }

  // ---- 插件身份色 ----
  // 优先级：**总线透传的 payload.accent** > 插件注册表 manifest.bubble.accent > 无（回落默认配色）
  // 为什么总线透传优先：桌宠窗口与管理页是**两个不同的 HTML 页面**，桌宠这边
  // 并没有加载 kernel/plugin-registry.js 与各插件 manifest，所以早先"从注册表
  // 读色值"的做法在桌宠窗口里永远拿到空串——气泡明明是 DSH 发的却不变蓝（实测踩过）。
  // 现在由插件在 register() 时声明自己的色值，经 agent_phase / agent_bubble
  // 透传下来，桌宠零额外依赖即可着色。
  function agentAccentOf(agentId, payloadAccent) {
    if (payloadAccent) return String(payloadAccent)
    try {
      const reg = window.__mioPluginRegistry
      const m = reg && reg.get ? reg.get(String(agentId)) : null
      if (m && m.bubble && m.bubble.accent) return String(m.bubble.accent)
    } catch (_) {}
    return ''
  }
  // 每次 render 时刷新（插件可能晚于桌宠注册）
  let AGENT_ACCENTS = {}
  function refreshAgentAccents() {
    const next = {}
    try {
      const reg = window.__mioPluginRegistry
      const ids = reg && reg.list ? reg.list() : []
      for (const id of ids) {
        const c = agentAccentOf(id, '')
        if (c) next[id] = c
      }
    } catch (_) {}
    AGENT_ACCENTS = next
  }
  refreshAgentAccents()

  // ---- A 档：交互反馈音 + 空闲自语 + 按压 Q 弹 ----
  // 三个能力都在 pet-sound.js / pet-idle-talk.js 里自足实现，这里只做**接线**：
  // 桌宠主文件不关心音色怎么合成、台词池有什么，只决定"何时触发"。

  // 播放交互音效（尊重桌面设置开关与音量；事件级配置由 settings 下发）
  function petSound(name) {
    try {
      const api = window.__mioPetSound
      if (!api) return false
      api.setEnabled(settings.pet_sound_enabled !== false)
      if (settings.pet_sound_volume !== undefined) api.setVolume(Number(settings.pet_sound_volume))
      return api.play(name)
    } catch (_) {
      return false
    }
  }

  // 按压反馈：**用动作+表情**而不是缩放形变。
  // 曾经试过改 model.scale.y 做"Q 弹"，但实测观感很怪（模型横向不变、纵向被压扁，
  // 看起来像渲染出错而非"被按扁"），且与 Live2D 自身的物理/动作系统打架。
  // 改为：点击走模型自带的 touch 动作（见 finishPointerInteraction），这里只留音效。
  function playPressBounce() {
    // 保留函数名以兼容既有调用点；视觉反馈已交给 motion，不再做形变。
    return false
  }

  // 空闲自语：长时间无交互时按内容池随机说一句
  // busy = 当前有 Agent 在工作（决定选哪个内容池，避免"干活时说闲着"）
  let idleTalkTimer = null
  let lastInteractionAt = Date.now()
  let lastActiveAgentId = ''

  function markPetInteraction() {
    lastInteractionAt = Date.now()
    // 有交互就重置计时，避免"刚点完又被自言自语打断"
    if (idleTalkTimer) {
      window.clearTimeout(idleTalkTimer)
      idleTalkTimer = null
    }
    scheduleIdleTalk()
  }

  function anyAgentBusy() {
    let busy = false
    agentBadgeStates.forEach((st) => {
      if (!st || st.enabled === false || st.status === 'offline') return
      const p = String(st.phase || 'idle')
      if (p && p !== 'idle' && p !== 'complete' && p !== 'heartbeat') busy = true
    })
    return busy
  }

  function scheduleIdleTalk() {
    if (settings.pet_idle_talk_enabled === false) return
    if (idleTalkTimer) window.clearTimeout(idleTalkTimer)
    const minS = Math.max(30, Number(settings.pet_idle_talk_min_seconds) || 90)
    const maxS = Math.max(minS, Number(settings.pet_idle_talk_max_seconds) || 240)
    const waitMs = (minS + Math.random() * (maxS - minS)) * 1000
    idleTalkTimer = window.setTimeout(() => {
      idleTalkTimer = null
      try {
        // 说话气泡被关掉 / 正在说话 → 本轮跳过，重新排期
        if (settings.live2d_speech_bubble_enabled === false || !speechBubble?.hidden) {
          scheduleIdleTalk()
          return
        }
        const api = window.__mioPetIdleTalk
        if (!api) { scheduleIdleTalk(); return }
        // 空闲自语同样 6s 自动消失（不一直挂着；打字机节奏随 6s 收敛）
        showSpeechBubble(api.pick(anyAgentBusy()), 6000, `idle-talk-${Date.now()}`)
      } catch (_) {}
      scheduleIdleTalk()
    }, waitMs)
  }

  // 按压形变已移除（见 playPressBounce 注释）；保留函数名避免 ticker 报错。
  function updatePressBounce() { /* no-op：视觉反馈交给模型动作系统 */ }

  function renderAgentBadge() {
    if (!agentBadgeEnabled()) {
      const badge = document.getElementById('agent-badge')
      if (badge) badge.style.opacity = '0'
      window.__lastAgentBadgeText = ''
      return
    }
    const badge = ensureAgentBadge()
    const chips = []
    agentBadgeStates.forEach((st, id) => {
      if (!st) return
      if (st.enabled === false) return          // 停用：状态栏一并停用
      if (st.status === 'offline') return       // 离线：即插即拔，不再展示
      // phase 全表 12 态各有专属色；连接中/异常覆盖为连接态色
      let phase = String(st.phase || 'idle')
      let label
      if (st.status === 'connecting') {
        phase = 'connecting'
        label = '连接中'
      } else if (st.status === 'error') {
        phase = 'error'
        label = '异常'
      } else {
        label = PHASE_LABELS[phase] || phase
      }
      chips.push({ id, name: String(st.name || id), label, phase, accent: st.accent || '' })
    })
    badge.replaceChildren()
    for (const chip of chips) {
      const el = document.createElement('span')
      el.className = `agent-badge-chip p-${chip.phase}`
      // 插件身份色：不同来源的 Agent 用各自专属色，一眼区分谁在工作。
      // 色值优先取总线随 agent_phase 透传的 payload.accent（桌宠窗口本身
      // 不加载插件注册表），其次回落 manifest 查询。
      const accent = chip.accent || AGENT_ACCENTS[chip.id] || ''
      if (accent) {
        el.classList.add('agent-accented')
        el.style.setProperty('--agent-accent', accent)
        el.style.borderColor = accent + '66'
      }
      el.textContent = `${chip.name} · ${chip.label}`
      el.title = `${chip.name} · ${chip.label}`
      badge.appendChild(el)
    }
    const visible = chips.length > 0
    badge.style.opacity = visible ? '1' : '0'
    if (visible) updateAgentBadgePosition(true)
    // 兼容旧引用（右键菜单重新开启徽标时恢复展示）
    window.__lastAgentBadgeText = chips.map((c) => `${c.name} · ${c.label}`).join('，')
  }

  // 徽标定位：手动拖动位置优先；否则锚定模型头顶上方居中。锁定时不可交互。
  function updateAgentBadgePosition(force = false) {
    const badge = document.getElementById('agent-badge')
    if (!badge || !model) return
    // 锁定桌宠时徽标不可交互（跟随头顶仅展示）；解锁后可拖动
    badge.style.pointerEvents = clickThroughLocked() ? 'none' : 'auto'
    // 拖动期间不参与每帧定位，避免把徽标拉回旧位置
    if (badgeDragging || !agentBadgeEnabled() || badge.style.opacity === '0') return
    // 节流：ticker 每帧调用，getBounds 是全模型遍历重操作；
    // 80ms 节流（≈12Hz）跟随足够，显隐/手动复位场景用 force 立即刷新
    const now = performance.now()
    if (!force && now - lastBadgePosAt < 80) return
    lastBadgePosAt = now
    let manual = null
    try {
      const saved = localStorage.getItem('mio_agent_badge_manual_pos')
      if (saved) manual = JSON.parse(saved)
    } catch (_) {}
    let bounds = null
    try { bounds = model.getBounds() } catch (_) {}
    const valid = bounds && bounds.width > 0 && bounds.height > 0
    if (manual && typeof manual.left === 'number' && typeof manual.top === 'number') {
      lastAgentBadgePos = { left: manual.left, top: manual.top }
    } else if (valid) {
      const rect = badge.getBoundingClientRect()
      const margin = 6
      const badgeW = Math.max(rect.width, 30)
      const badgeH = Math.max(rect.height, 18)
      const left = Math.max(
        margin,
        Math.min(window.innerWidth - badgeW - margin, bounds.x + bounds.width / 2 - badgeW / 2),
      )
      const top = Math.max(
        margin,
        Math.min(window.innerHeight - badgeH - margin, bounds.y - badgeH - 4),
      )
      lastAgentBadgePos = { left: Math.round(left), top: Math.round(top) }
    } else if (!lastAgentBadgePos) {
      return
    }
    badge.style.left = `${lastAgentBadgePos.left}px`
    badge.style.top = `${lastAgentBadgePos.top}px`
  }

  // 只展示"工作中"的细分状态；连接/断连/待机/完成等不打扰
  const WORK_PHASES = new Set([
    'voice', 'thinking', 'planning', 'executing_tool', 'streaming', 'waiting_input', 'awaiting_approval',
  ])

  function applyAgentPhase(payload) {
    if (!payload) return
    const agentId = String(payload.agent_id || '')
    const phase = String(payload.phase || 'idle')
    const agentName = String(payload.agent_name || payload.agent_id || 'Agent')
    const active = Boolean(payload.active)
    // 实时刷新对应 agent 的状态 chip（多 agent 各自更新，互不覆盖）
    let prevPhaseBefore = ''
    if (agentId) {
      const prev = agentBadgeStates.get(agentId) || {}
      prevPhaseBefore = String(prev.phase || '')
      agentBadgeStates.set(agentId, {
        name: payload.agent_name || prev.name || agentId,
        status: prev.status || 'online',
        enabled: prev.enabled !== false,
        phase,
        active,
        // 插件身份色（总线透传，见 agentAccentOf 注释）
        accent: payload.accent || prev.accent || '',
      })
    }
    renderAgentBadge()
    const label = PHASE_LABELS[phase] || phase
    if (active) {
      activityIndicator.title = `${agentName} · ${label}`
    }
    // A 档音效：Agent 交接（活跃者换人）时给一声"换人了"，只在真的换手时响
    if (active && lastActiveAgentId && agentId && lastActiveAgentId !== agentId) {
      petSound('switch')
    }
    // 音效事件：提问 / 授权 / 任务结束 / 异常（只在**相位真的变化**时响，避免重复轰炸）
    if (active) {
      const prevPhase = prevPhaseBefore
      const workPhases = ['thinking', 'planning', 'executing_tool', 'streaming', 'voice']
      if (phase === 'waiting_input' && prevPhase !== 'waiting_input') petSound('ask')
      else if (phase === 'awaiting_approval' && prevPhase !== 'awaiting_approval') petSound('approval')
      else if (phase === 'error' && prevPhase !== 'error') petSound('error')
      else if ((phase === 'complete' || phase === 'idle') && workPhases.includes(prevPhase)) petSound('task_end')
    }
    if (active && agentId) lastActiveAgentId = agentId
    // 多 agent 并行时，只有当前活跃者驱动桌宠"身体"（表情/动作），互不抢占
    if (!active) return
    const activity = PHASE_TO_ACTIVITY[phase]
    if (!activity) return   // heartbeat 等不改变动画
    currentActivity = activity
    activityUntil = Date.now() + (activity === 'speaking' ? 4000 : 2600)
    activityIndicator.className = `activity-indicator ${activity}`
    activityIndicator.classList.toggle('active', activity !== 'idle')
    const hint = PHASE_MOTION_HINT[phase]
    if (hint && phase !== 'voice') {
      const group = semanticMotion(hint)
      if (group) playMotion(group)
      else startProceduralMotion(hint, 0.5)
    }
  }

  function applyAgentStatus(payload) {
    // 连接/在线/离线/停用状态变化实时刷新状态栏：即插即用（上线即出现、停用/离线即移除）
    if (!payload) return
    // 插件总线增量同步：停用/启用 agent 时实时挂载/卸载对应插件
    try {
      if (window.__mioPluginBus && payload.enabled !== undefined) {
        window.__mioPluginBus.setAgentEnabled(payload.agent_id, payload.enabled !== false)
      }
    } catch (_) {}
    const agentId = String(payload.agent_id || '')
    const status = String(payload.status || 'offline')
    const agentName = String(payload.agent_name || payload.agent_id || 'Agent')
    if (agentId) {
      const prev = agentBadgeStates.get(agentId) || {}
      agentBadgeStates.set(agentId, {
        name: payload.agent_name || prev.name || agentId,
        status,
        enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : (prev.enabled !== false),
        phase: prev.phase || 'idle',
        active: prev.active || false,
        accent: prev.accent || '',
      })
    }
    renderAgentBadge()
    if (payload.active) {
      activityIndicator.title = `${agentName} · ${AGENT_STATUS_LABELS[status] || status}`
    }
  }

  async function fetchAgentsSnapshot() {
    try {
      const snapshot = await request('/api/companion/agents')
      const agents = snapshot.agents || []
      // 插件总线全量同步：agent enabled → 插件挂载/卸载（即插即用，以服务端 enabled 为准）
      try {
        if (window.__mioPluginBus) window.__mioPluginBus.updateAgents(agents)
      } catch (_) {}
      // 全量同步：以服务端快照为准，停用(enabled=false)/未注册的 agent 从状态栏移除
      const next = new Map()
      for (const a of agents) {
        if (!a || !a.agent_id) continue
        next.set(String(a.agent_id), {
          name: String(a.name || a.agent_id),
          status: String(a.status || 'offline'),
          enabled: a.enabled !== false,
          phase: String(a.phase || 'idle'),
          active: Boolean(a.active),
          // 插件身份色：来自总线快照（插件 register 时自己声明的）
          accent: String(a.accent || ''),
        })
      }
      agentBadgeStates.clear()
      next.forEach((value, key) => agentBadgeStates.set(key, value))
      renderAgentBadge()
      const active = snapshot.active_agent
      if (active) {
        const phase = String(active.phase || 'idle')
        const activity = PHASE_TO_ACTIVITY[phase]
        if (activity && phase !== 'heartbeat') {
          currentActivity = activity
          activityUntil = Date.now() + 2600
          activityIndicator.className = `activity-indicator ${activity}`
          activityIndicator.classList.toggle('active', activity !== 'idle')
        }
      }
    } catch (_) {}
  }

  async function applySettings(nextSettings) {
    // ★ 形象切换宽限期：PATCH /settings 之前已在途的旧 /status 响应（或晚到的 settings_changed）
    //   会把 live2d_model_id 盖回旧值，造成"切过去→闪回旧形象→再跳回来"。
    //   宽限期内（10s）只要存在**用户切换意图**（modelSwitchTarget，仅 switchModel 赋值），
    //   就强行以它为准；PATCH 完成后服务端值与之一致，这里自然不再改写。
    //   ⚠ 判据不能用 loadModel 里记的"在途目标"：真实 Electron 时序下广播先于 invoke 回包，
    //   onModelsChanged 会先 loadModel(旧) —— 那会把宽限期劫持成"锁回旧形象"。
    if (nextSettings && typeof nextSettings.live2d_model_id === 'string'
      && modelSwitchTarget && nextSettings.live2d_model_id !== modelSwitchTarget
      && Date.now() - modelSwitchAt < 10000) {
      nextSettings = { ...nextSettings, live2d_model_id: modelSwitchTarget }
    }
    const previousModel = selectedModelId()
    settings = { ...settings, ...(nextSettings || {}) }
    // 后端设置变更(settings_changed)以 settings.live2d_model_id 为准，清空桌面侧覆盖，避免热切换不触发
    if (nextSettings && Object.prototype.hasOwnProperty.call(nextSettings, 'live2d_model_id')) {
      desktopSelectedModelId = ''
    }
    // 泡泡工坊：皮肤热应用（配置在 Mio「泡泡」页，settings_changed 下发）
    try {
      const bs = window.__mioPetBubbleStyles
      if (bs && nextSettings && Object.prototype.hasOwnProperty.call(nextSettings, 'live2d_bubble_style')) {
        bs.setStyle(nextSettings.live2d_bubble_style, speechBubble)
      }
      // 7.6 横条主题：与泡泡皮肤同一条热应用通路（settings 下发 → 立即套类）。
      // 键名 `live2d_strip_style`；插件侧契约里的 `pet_strip_style` 是它的**别名**，
      // 两个键都认，避免插件与设置页各叫一套（历史上有过键名漂移的事故）。
      const stripApi = window.__mioPetStrip
      if (stripApi && nextSettings) {
        const key = Object.prototype.hasOwnProperty.call(nextSettings, 'live2d_strip_style')
          ? 'live2d_strip_style'
          : (Object.prototype.hasOwnProperty.call(nextSettings, 'pet_strip_style') ? 'pet_strip_style' : null)
        if (key) stripApi.applyStyle(nextSettings[key])
        // ★ 个性化默认值（2026-10-17 设置页）：默认宽度 / 行数热应用。
        if (Object.prototype.hasOwnProperty.call(nextSettings, 'live2d_strip_width')) {
          stripApi.setDefaultWidth(Number(nextSettings.live2d_strip_width) || 0)
        }
        if (Object.prototype.hasOwnProperty.call(nextSettings, 'live2d_strip_rows')) {
          stripApi.setRows(Number(nextSettings.live2d_strip_rows) || 1)
        }
        // 「重新启用横条」：设置页下发一个一次性 token，渲染端据此清掉"用户已拒绝"的持久记忆。
        // 用 token 变化（而不是布尔值）是为了让"再点一次"也能生效；同时记住已处理过的值，
        // 避免轮询反复拿到同一个 token 时重复复位（那会让用户刚 ✕ 掉的横条又被翻回来）。
        if (Object.prototype.hasOwnProperty.call(nextSettings, 'pet_strip_reset_token')) {
          const token = String(nextSettings.pet_strip_reset_token || '')
          if (token && token !== stripResetTokenSeen) {
            stripResetTokenSeen = token
            if (typeof stripApi.resetDismissed === 'function') stripApi.resetDismissed()
          }
        }
      }
      // 音效事件配置（每事件开关/音量/自定义片段）
      const snd = window.__mioPetSound
      if (snd && nextSettings && Object.prototype.hasOwnProperty.call(nextSettings, 'pet_sound_events')) {
        snd.setEvents(nextSettings.pet_sound_events)
      }
      // 图片池权重（点击随机图片按权重抽）
      const imgApi = window.__mioPetRandomImage
      if (imgApi && nextSettings && Object.prototype.hasOwnProperty.call(nextSettings, 'pet_image_weights')) {
        imgApi.setWeights(nextSettings.pet_image_weights)
      }
    } catch (_) {}
    if (electronRuntime) {
      window.mioDesktop.setAlwaysOnTop(Boolean(settings.live2d_always_on_top ?? true))
      window.mioDesktop.setClickThroughLocked(Boolean(settings.live2d_click_through_locked))
    }
    root.classList.toggle('click-through-locked', Boolean(settings.live2d_click_through_locked))
    // ★ 桌宠不透明度（2026-10-17 交互打磨）：控制模型 alpha（10-100%）。
    //   只作用于 Live2D 模型本体，不影响气泡/徽标/横条的清晰度。
    try {
      const op = Number(settings.live2d_pet_opacity)
      if (Number.isFinite(op)) applyPetOpacity(op)
    } catch (_) {}
    updateContextMenuLabels()
    // ★「关掉气泡就隐藏」只在**开关真的从开→关发生变化**、或**当前没有活跃流式会话**时才生效
    //   （2026-10-16 修回归：流式气泡被轮询打掉）。
    //   原写法 `if (!enabled) hideSpeechBubble()` 是无条件执行，而 applySettings 会被
    //   pollStatus() 在 start() 里 await 一次、之后每 5s（非 Electron 1.8s）再调：
    //       hideSpeechBubble ← applySettings ← pollStatus ← start
    //   hideSpeechBubble 内部第一件事就是 cancelAgentStream()，于是正在播的流式气泡
    //   被轮询直接清空+隐藏（实测：文本 635ms 播完后立刻被清，finishAgentStream 里
    //   hold max(3500ms, 字数×60ms) 的 holdTimer 从未有机会生效）。
    //   触发条件是快照里 `live2d_speech_bubble_enabled` 为假值——开关关闭态、或任一
    //   快照缺该键（E2E 桩 getState() 返回 {settings:{}} 即此情形）都会命中，属真实回归。
    //
    //   判据用「下降沿」而不是单独看 streamState，因为 pollStatus 是**在途异步**的：
    //   start() 里那次 await pollStatus 可能在流开始前就发出，回包落在流播放中途，
    //   此时 streamState 可能恰好为 null（上一段流刚收尾），只看 streamState 会漏判。
    //   记录上一次已生效的开关值 speechBubbleEnabledApplied，只有它从「非 false」变成
    //   false 的那一次才 hide —— 用户主动关开关仍立即隐藏，轮询重复推送同一假值不再误伤。
    const bubbleEnabledNow = settings.live2d_speech_bubble_enabled !== false
    const bubbleJustDisabled = speechBubbleEnabledApplied !== null && speechBubbleEnabledApplied && !bubbleEnabledNow
    speechBubbleEnabledApplied = bubbleEnabledNow
    if (bubbleJustDisabled && streamState === null) hideSpeechBubble()
    const nextModel = selectedModelId()
    // currentModelId 只在加载**完成**后才赋值：大模型加载要数秒，若只看它，
    // 每次 5s 轮询都会误判"还没切过去"而重新加载一遍（形象不停重载）。
    // 用 lastLoad（发起即记）判断「目标已在加载中」，跳过重复发起；
    // 加载失败时 lastLoad.done = true，轮询仍会重试（保留失败自愈）。
    if (!model || previousModel !== nextModel
      || (currentModelId !== nextModel && !(lastLoad.target === nextModel && !lastLoad.done))) {
      await loadModel(nextModel)
    } else {
      fitModel()
    }
    const percent = Number(settings.pet_size_percent || 150)
    sizeSlider.value = String(percent)
    sizeValue.value = `${percent}%`
    if (percent !== lastSizePercent && !electronRuntime && window.pywebview?.api) {
      lastSizePercent = percent
      try { await window.pywebview.api.resize_window(percent) } catch (_) {}
    }
    populateModelSelect()
    // A 档：设置变化后同步音效开关/音量（自语排期由 markPetInteraction 维护）
    try {
      const sound = window.__mioPetSound
      if (sound) {
        sound.setEnabled(settings.pet_sound_enabled !== false)
        sound.setVolume(Number(settings.pet_sound_volume ?? 70))
      }
    } catch (_) {}
  }

  async function pollStatus() {
    try {
      const status = await request('/api/companion/status')
      const pet = status.pet || {}
      await applySettings(pet.settings || {})
      applyActivity(pet.activity || {})
      if (status.agents) fetchAgentsSnapshot()
      lastStatusSuccess = Date.now()
    } catch (error) {
      if (Date.now() - lastStatusSuccess > 25000 && !electronRuntime && window.pywebview?.api) {
        try { await window.pywebview.api.close_pet() } catch (_) {}
      }
    }
  }

  function shouldSpeak(message) {
    if (typeof message.should_speak === 'boolean') return message.should_speak
    const source = String(message.source || '')
    if (!settings.voice_enabled) return false
    if (['proactive', 'desktop_proactive'].includes(source)) return Boolean(settings.speak_proactive)
    if (source === 'screen') return Boolean(settings.speak_screen_observations)
    if (['game', 'desktop_pet_wake'].includes(source)) return Boolean(settings.speak_game_observations)
    return true
  }

  function messagePriority(message) {
    const explicit = Number(message?.priority)
    if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, explicit))
    const source = String(message?.source || '').toLowerCase()
    if (source === 'desktop_pet') return 100
    if (['desktop', 'web', 'qq'].includes(source)) return 95
    if (source.startsWith('qq_group')) return 90
    if (source === 'startup') return 70
    if (source === 'desktop_pet_wake') return 68
    if (source === 'game') return 62
    if (source === 'screen') return 56
    if (['proactive', 'desktop_proactive'].includes(source)) return 35
    return 75
  }

  function messageResponseId(message) {
    return String(
      message?.response_id
      || message?.request_id
      || (message?.message_id ? `message-${message.message_id}` : ''),
    )
  }

  function recordSpeechLifecycle(responseId, event, details = {}) {
    const id = String(responseId || '')
    if (!id) return
    let entry = speechLifecycleHistory.find((item) => item.responseId === id)
    if (!entry) {
      entry = { responseId: id, status: 'requested', events: [] }
      speechLifecycleHistory.push(entry)
      if (speechLifecycleHistory.length > 80) speechLifecycleHistory.shift()
    }
    const at = new Date().toISOString()
    entry.status = event
    entry.events.push({ event, at })
    if (entry.events.length > 12) entry.events.shift()
    if (event === 'requested') entry.requestedAt = at
    if (event === 'queued') entry.queuedAt = at
    if (event === 'preparing') entry.preparingAt = at
    if (event === 'started') entry.startedAt = at
    if (['finished', 'failed', 'interrupted', 'dropped'].includes(event)) entry.endedAt = at
    if (details.mode) entry.mode = details.mode
    if (details.priority != null) entry.priority = Number(details.priority)
    if (details.firstAudioLatencyMs != null) entry.firstAudioLatencyMs = Number(details.firstAudioLatencyMs)
    if (details.error) entry.error = String(details.error)
    if (details.playbackMetrics) entry.playbackMetrics = details.playbackMetrics
  }

  function trackSpeechRequest(message) {
    if (message?.__speechRequestTracked) return message
    const existingId = messageResponseId(message)
    const responseId = existingId || `speech-${Date.now()}-${speechRequestCount + 1}`
    if (!speechLifecycleHistory.some((item) => item.responseId === responseId)) {
      speechRequestCount += 1
      recordSpeechLifecycle(responseId, 'requested', { priority: messagePriority(message) })
    }
    return { ...message, response_id: responseId, __speechRequestTracked: true }
  }

  function resetPlaybackPerformance() {
    playbackFrameTimes = []
    playbackFpsSamples = []
    playbackFrameWindowStartedAt = performance.now()
    playbackFrameWindowCount = 0
    rendererLastFrameAt = playbackFrameWindowStartedAt
  }

  function finalizePlaybackPerformance() {
    const measuredAt = performance.now()
    const partialWindowMs = measuredAt - playbackFrameWindowStartedAt
    if (playbackFrameWindowCount > 0 && partialWindowMs >= 250) {
      playbackFpsSamples.push(playbackFrameWindowCount * 1000 / partialWindowMs)
    }
    const sorted = [...playbackFrameTimes].sort((left, right) => left - right)
    const p95Index = sorted.length ? Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1) : -1
    return {
      frameCount: playbackFrameTimes.length,
      minimumFps: playbackFpsSamples.length
        ? Number(Math.min(...playbackFpsSamples).toFixed(1))
        : null,
      frameTimeP95Ms: p95Index >= 0 ? Number(sorted[p95Index].toFixed(2)) : null,
      maximumFrameTimeMs: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null,
      framesOver33Ms: playbackFrameTimes.filter((value) => value > 33).length,
      framesOver50Ms: playbackFrameTimes.filter((value) => value > 50).length,
      frameTimesMs: playbackFrameTimes.map((value) => Number(value.toFixed(3))),
    }
  }

  function speechInProgress() {
    return Boolean(currentSpeechAbort || voiceLifecycleActive || currentAudio || streamPlaybackActive)
  }

  function enqueueSpeech(message) {
    message = trackSpeechRequest(message)
    const responseId = messageResponseId(message)
    if (responseId && (responseId === activeResponseId || speechQueue.some((item) => messageResponseId(item) === responseId))) {
      return false
    }
    speechQueue.push({ ...message, priority: messagePriority(message), queued_at: Date.now() })
    speechQueuedCount += 1
    recordSpeechLifecycle(responseId, 'queued', { priority: messagePriority(message) })
    speechQueue.sort((left, right) => Number(right.priority) - Number(left.priority) || left.queued_at - right.queued_at)
    if (speechQueue.length > 20) {
      const dropped = speechQueue.slice(20)
      speechDroppedCount += dropped.length
      for (const item of dropped) recordSpeechLifecycle(messageResponseId(item), 'dropped', { error: 'queue-limit' })
      speechQueue = speechQueue.slice(0, 20)
    }
    return true
  }

  function scheduleSpeechDrain() {
    window.clearTimeout(speechDrainTimer)
    speechDrainTimer = window.setTimeout(() => {
      if (speechInProgress() || !speechQueue.length) return
      const next = speechQueue.shift()
      dispatchSpeech(next)
    }, 30)
  }

  async function dispatchSpeech(message) {
    const text = String(message?.text || message?.content || '').trim()
    if (!text || !shouldSpeak(message || {})) return false
    message = trackSpeechRequest(message)
    const priority = messagePriority(message)
    const responseId = messageResponseId(message)
    if (responseId && responseId === activeResponseId) return false
    if (speechInProgress()) {
      // A normal follow-up at the same priority belongs to the same flow and
      // waits its turn. Only a genuinely higher-priority event may preempt it.
      if (priority <= activeSpeechPriority) return enqueueSpeech({ ...message, text, priority, response_id: responseId })
      stopSpeech('interrupted')
    }
    showSpeechBubble(text, 0, responseId)
    activeResponseId = responseId
    activeSpeechPriority = priority
    recordSpeechLifecycle(responseId, 'preparing', { priority })
    await playSpeech({ ...message, text, priority, response_id: responseId })
    return true
  }

  function clearStreamingAudio() {
    for (const source of streamSources) {
      source.onended = null
      try { source.stop() } catch (_) {}
      try { source.disconnect() } catch (_) {}
    }
    streamSources.clear()
    streamPlaybackActive = false
    streamScheduledUntil = 0
    streamPendingBuffers = []
    streamPendingDuration = 0
    streamHasStarted = false
    if (streamGain) {
      try { streamGain.disconnect() } catch (_) {}
      streamGain = null
    }
  }

  function stopSpeech(reason = 'interrupted') {
    const hadSpeech = voiceLifecycleActive
    const endedResponseId = activeResponseId
    const endedPriority = activeSpeechPriority
    const playbackMetrics = hadSpeech ? finalizePlaybackPerformance() : null
    streamSpeechToken += 1
    window.clearTimeout(streamFirstAudioTimer)
    streamFirstAudioTimer = null
    if (currentSpeechAbort) currentSpeechAbort.abort()
    currentSpeechAbort = null
    if (currentAudio) {
      const audio = currentAudio
      currentAudio = null
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
    }
    clearStreamingAudio()
    if (analyser) {
      try { analyser.disconnect() } catch (_) {}
    }
    analyser = null
    analyserData = null
    mouthLevel = 0
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl)
    currentAudioUrl = ''
    activeResponseId = ''
    activeSpeechPriority = -1
    activeSpeechText = ''
    if (['finished', 'error'].includes(reason) && !speechBubble.hidden) {
      window.clearTimeout(speechBubbleHideTimer)
      speechBubbleHideTimer = window.setTimeout(
        hideSpeechBubble,
        Math.max(1000, Math.min(30000, Number(settings.bubble_seconds || 9) * 1000)),
      )
    } else {
      hideSpeechBubble()
    }
    if (reason && hadSpeech) {
      voiceLifecycleActive = false
      speechEndCount += 1
      if (reason === 'interrupted') speechInterruptCount += 1
      if (reason === 'finished') speechFinishedCount += 1
      if (reason === 'error') speechFailureCount += 1
      lastSpeechEndedAt = new Date().toISOString()
      lastVoiceEventSent = sendSocket('voice_ended', {
        reason,
        request_id: endedResponseId,
        response_id: endedResponseId,
        priority: endedPriority,
      })
      recordSpeechLifecycle(
        endedResponseId,
        reason === 'error' ? 'failed' : reason,
        { error: reason === 'error' ? lastSpeechError : '', playbackMetrics },
      )
    } else if (reason === 'error' && endedResponseId) {
      speechFailureCount += 1
      lastSpeechEndedAt = new Date().toISOString()
      recordSpeechLifecycle(endedResponseId, 'failed', { error: lastSpeechError })
    }
    if (reason === 'manual') {
      const dropped = speechQueue
      speechDroppedCount += dropped.length
      for (const item of dropped) recordSpeechLifecycle(messageResponseId(item), 'dropped', { error: 'manual-stop' })
      speechQueue = []
    }
    // Interrupting the active item must not discard follow-up replies. Drain
    // the retained queue once the current audio resources are released.
    if (reason && reason !== 'manual') scheduleSpeechDrain()
  }

  function beginVoiceLifecycle(message, text, mode, durationMs = 0) {
    if (voiceLifecycleActive) return
    voiceLifecycleActive = true
    currentActivity = 'speaking'
    speakingUntil = Date.now() + Math.max(3000, text.length * 190)
    speechStartCount += 1
    lastSpeechStartedAt = new Date().toISOString()
    lastStreamMode = mode
    activeSpeechText = text
    resetPlaybackPerformance()
    recordSpeechLifecycle(messageResponseId(message), 'started', {
      mode,
      priority: messagePriority(message),
      firstAudioLatencyMs: streamFirstAudioLatencyMs,
    })
    showSpeechBubble(text, durationMs, messageResponseId(message))
    lastVoiceEventSent = sendSocket('voice_started', {
      message_id: message.message_id || null,
      request_id: message.request_id || '',
      response_id: messageResponseId(message),
      priority: messagePriority(message),
      emotion: currentEmotion,
      mode,
      first_audio_latency_ms: streamFirstAudioLatencyMs,
    })
  }

  function appendBytes(left, right) {
    if (!left?.length) return new Uint8Array(right)
    const combined = new Uint8Array(left.length + right.length)
    combined.set(left, 0)
    combined.set(right, left.length)
    return combined
  }

  function asciiAt(bytes, offset, length) {
    let value = ''
    for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index])
    return value
  }

  function parseWavHeader(bytes) {
    if (bytes.length < 12) return null
    if (asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WAVE') {
      throw new Error('流式语音不是有效的 WAV 数据')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let position = 12
    let format = null
    while (position + 8 <= bytes.length) {
      const chunkId = asciiAt(bytes, position, 4)
      const chunkSize = view.getUint32(position + 4, true)
      const chunkStart = position + 8
      if (chunkId === 'fmt ') {
        if (bytes.length < chunkStart + Math.min(chunkSize, 16)) return null
        format = {
          tag: view.getUint16(chunkStart, true),
          channels: view.getUint16(chunkStart + 2, true),
          sampleRate: view.getUint32(chunkStart + 4, true),
          blockAlign: view.getUint16(chunkStart + 12, true),
          bitsPerSample: view.getUint16(chunkStart + 14, true),
        }
      } else if (chunkId === 'data') {
        if (!format) throw new Error('流式 WAV 缺少音频格式')
        return { format, dataOffset: chunkStart }
      }
      const next = chunkStart + chunkSize + (chunkSize % 2)
      if (next > bytes.length) return null
      position = next
    }
    return null
  }

  function sampleFromPcm(view, offset, format) {
    if (format.tag === 3 && format.bitsPerSample === 32) return view.getFloat32(offset, true)
    if (format.tag !== 1) throw new Error(`不支持的 WAV 编码：${format.tag}`)
    if (format.bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128
    if (format.bitsPerSample === 16) return view.getInt16(offset, true) / 32768
    if (format.bitsPerSample === 24) {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
      if (value & 0x800000) value |= 0xff000000
      return value / 8388608
    }
    if (format.bitsPerSample === 32) return view.getInt32(offset, true) / 2147483648
    throw new Error(`不支持的 WAV 位深：${format.bitsPerSample}`)
  }

  function audioBufferFromPcm(bytes, format) {
    const bytesPerSample = format.bitsPerSample / 8
    const frameCount = Math.floor(bytes.length / format.blockAlign)
    if (!frameCount || !Number.isFinite(bytesPerSample)) return null
    const output = audioContext.createBuffer(format.channels, frameCount, format.sampleRate)
    const view = new DataView(bytes.buffer, bytes.byteOffset, frameCount * format.blockAlign)
    for (let channel = 0; channel < format.channels; channel += 1) {
      const channelData = output.getChannelData(channel)
      for (let frame = 0; frame < frameCount; frame += 1) {
        const offset = frame * format.blockAlign + channel * bytesPerSample
        channelData[frame] = Math.max(-1, Math.min(1, sampleFromPcm(view, offset, format)))
      }
    }
    return output
  }

  function scheduleAudioBuffer(buffer, message, text, token, requestStartedAt) {
    if (!buffer || token !== streamSpeechToken) return false
    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(streamGain)
    const startsAt = Math.max(audioContext.currentTime + 0.035, streamScheduledUntil)
    streamScheduledUntil = startsAt + buffer.duration
    streamSources.add(source)
    source.onended = () => streamSources.delete(source)
    source.start(startsAt)
    if (!streamPlaybackActive) {
      window.clearTimeout(streamFirstAudioTimer)
      streamFirstAudioTimer = null
      streamPlaybackActive = true
      streamFirstAudioLatencyMs = Math.round(performance.now() - requestStartedAt)
      beginVoiceLifecycle(message, text, 'stream')
    }
    return true
  }

  function startPendingPcm(message, text, token, requestStartedAt) {
    if (streamHasStarted || !streamPendingBuffers.length || token !== streamSpeechToken) return false
    streamHasStarted = true
    const pending = streamPendingBuffers
    streamPendingBuffers = []
    streamPendingDuration = 0
    for (const buffer of pending) scheduleAudioBuffer(buffer, message, text, token, requestStartedAt)
    return streamPlaybackActive
  }

  function schedulePcm(bytes, format, message, text, token, requestStartedAt, forceStart = false) {
    if (!bytes.length || token !== streamSpeechToken) return false
    const buffer = audioBufferFromPcm(bytes, format)
    if (!buffer) return false
    if (!streamHasStarted) {
      streamPendingBuffers.push(buffer)
      streamPendingDuration += buffer.duration
      if (forceStart || streamPendingDuration >= 0.28) startPendingPcm(message, text, token, requestStartedAt)
      return true
    }
    return scheduleAudioBuffer(buffer, message, text, token, requestStartedAt)
  }

  async function playStreamingResponse(response, controller, message, text, token, requestStartedAt) {
    if (!response.body) throw new Error('浏览器没有收到可读取的流式音频')
    audioContext = audioContext || new AudioContext()
    if (audioContext.state === 'suspended') await audioContext.resume()
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.42
    analyserData = new Uint8Array(analyser.fftSize)
    streamGain = audioContext.createGain()
    streamGain.gain.value = Math.max(0, Math.min(1, Number(settings.voice_volume || 85) / 100))
    streamGain.connect(analyser)
    analyser.connect(audioContext.destination)

    const reader = response.body.getReader()
    let pending = new Uint8Array(0)
    let format = null
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (controller.signal.aborted || token !== streamSpeechToken) return false
        if (value?.length) pending = appendBytes(pending, value)
        if (!format) {
          const parsed = parseWavHeader(pending)
          if (parsed) {
            format = parsed.format
            if (!format.channels || !format.sampleRate || !format.blockAlign) {
              throw new Error('流式 WAV 的格式参数无效')
            }
            pending = pending.slice(parsed.dataOffset)
          }
        }
        if (format) {
          const aligned = pending.length - (pending.length % format.blockAlign)
          const minimum = done ? format.blockAlign : Math.max(format.blockAlign, Math.floor(format.sampleRate * 0.16) * format.blockAlign)
          if (aligned >= minimum) {
            schedulePcm(pending.slice(0, aligned), format, message, text, token, requestStartedAt)
            pending = pending.slice(aligned)
          }
        }
        if (done) break
      }
      if (format && pending.length >= format.blockAlign) {
        const aligned = pending.length - (pending.length % format.blockAlign)
        schedulePcm(pending.slice(0, aligned), format, message, text, token, requestStartedAt, true)
      }
      startPendingPcm(message, text, token, requestStartedAt)
      if (!streamPlaybackActive) throw new Error('流式响应没有可播放的 PCM 音频')
      while (!controller.signal.aborted && token === streamSpeechToken && audioContext.currentTime < streamScheduledUntil - 0.015) {
        await new Promise((resolve) => window.setTimeout(resolve, 20))
      }
      return !controller.signal.aborted && token === streamSpeechToken
    } finally {
      try { reader.releaseLock() } catch (_) {}
    }
  }

  async function playCompleteResponse(response, controller, message, text, token, mode = 'complete', requestStartedAt = 0) {
    const blob = await response.blob()
    if (controller.signal.aborted || token !== streamSpeechToken) return
    currentAudioUrl = URL.createObjectURL(blob)
    currentAudio = new Audio(currentAudioUrl)
    currentAudio.volume = Math.max(0, Math.min(1, Number(settings.voice_volume || 85) / 100))
    audioContext = audioContext || new AudioContext()
    if (audioContext.state === 'suspended') await audioContext.resume()
    const source = audioContext.createMediaElementSource(currentAudio)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.42
    analyserData = new Uint8Array(analyser.fftSize)
    source.connect(analyser)
    analyser.connect(audioContext.destination)
    currentAudio.onended = () => {
      if (token !== streamSpeechToken) return
      currentActivity = 'idle'
      stopSpeech('finished')
    }
    currentAudio.onerror = () => {
      if (token !== streamSpeechToken) return
      const mediaError = currentAudio?.error
      lastSpeechError = mediaError?.message || `音频错误代码 ${mediaError?.code || 0}`
      sendSocket('renderer_error', { message: `桌宠语音播放失败：${lastSpeechError}` })
      currentActivity = 'idle'
      stopSpeech('error')
    }
    await currentAudio.play()
    window.clearTimeout(streamFirstAudioTimer)
    streamFirstAudioTimer = null
    if (requestStartedAt) streamFirstAudioLatencyMs = Math.round(performance.now() - requestStartedAt)
    const durationMs = Number.isFinite(currentAudio.duration) ? currentAudio.duration * 1000 : 0
    beginVoiceLifecycle(message, text, mode, durationMs)
  }

  async function requestSpeechAudio(endpoint, text, message, controller, speechLanguage = '') {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        context: text,
        emotion: message.emotion || '',
        model_id: message.model_id || '',
        language: speechLanguage || message.speech_language || (settings.pet_speech_language === 'ja' ? 'ja' : 'zh'),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const payload = await response.json()
        detail = payload?.detail || detail
      } catch (_) {}
      throw new Error(`语音生成失败：${detail}`)
    }
    return response
  }

  async function playSpeech(message) {
    const text = String(message.text || message.content || '').trim()
    if (!text || !shouldSpeak(message)) return
    const controller = new AbortController()
    const token = ++streamSpeechToken
    currentSpeechAbort = controller
    lastSpeechError = ''
    lastStreamMode = ''
    streamFirstAudioLatencyMs = null
    maxMouthLevel = 0
    currentActivity = 'responding'
    applyEmotion(message.emotion || 'neutral', Math.max(6000, text.length * 180))
    const requestStartedAt = performance.now()
    streamFirstAudioTimer = window.setTimeout(() => {
      if (token === streamSpeechToken && !voiceLifecycleActive) controller.abort('first-audio-timeout')
    }, 12000)
    try {
      if (settings.voice_streaming_enabled !== false) {
        try {
          const streamResponse = await requestSpeechAudio('/api/companion/voice/stream', text, message, controller)
          const completed = await playStreamingResponse(streamResponse, controller, message, text, token, requestStartedAt)
          if (completed && token === streamSpeechToken) {
            currentActivity = 'idle'
            stopSpeech('finished')
          }
          return
        } catch (streamError) {
          if (token !== streamSpeechToken) return
          if (controller.signal.aborted) {
            if (controller.signal.reason === 'first-audio-timeout') throw streamError
            return
          }
          if (voiceLifecycleActive) throw streamError
          clearStreamingAudio()
          if (analyser) {
            try { analyser.disconnect() } catch (_) {}
          }
          analyser = null
          analyserData = null
          lastStreamMode = 'complete-fallback'
        }
      }
      const response = await requestSpeechAudio('/api/companion/voice/audio', text, message, controller)
      await playCompleteResponse(
        response,
        controller,
        message,
        text,
        token,
        lastStreamMode || 'complete',
        requestStartedAt,
      )
    } catch (error) {
      if (token !== streamSpeechToken) return
      const requestedLanguage = message.speech_language || settings.pet_speech_language
      currentActivity = 'idle'
      lastSpeechError = controller.signal.aborted
        ? (requestedLanguage === 'ja'
            ? '日语语音未能在 12 秒内开始，已停止；不会改说中文'
            : '语音未能在 12 秒内开始播放')
        : String(error?.message || error)
      showSpeechBubble(lastSpeechError, 0, messageResponseId(message))
      sendSocket('renderer_error', { message: lastSpeechError })
      stopSpeech('error')
    } finally {
      window.clearTimeout(streamFirstAudioTimer)
      streamFirstAudioTimer = null
      if (currentSpeechAbort === controller) currentSpeechAbort = null
    }
  }

  async function handleMessages(messages) {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const requestId = String(message.request_id || '')
      const chunks = [String(message.content || '').trim()].filter(Boolean)
      while (requestId && messages[index + 1] && String(messages[index + 1].request_id || '') === requestId) {
        index += 1
        const chunk = String(messages[index].content || '').trim()
        if (chunk) chunks.push(chunk)
      }
      const text = chunks.join('\n')
      if (!text) continue
      const payload = { ...message, text }
      applyEmotion(payload.emotion || 'neutral', Math.max(5000, text.length * 160))
      showSpeechBubble(text, 0, messageResponseId(payload))
      if (shouldSpeak(payload)) await dispatchSpeech(payload)
    }
  }

  async function pollFeed() {
    if (electronRuntime) return
    try {
      const query = latestMessageId === null ? '' : `?after_id=${latestMessageId}`
      const feed = await request(`/api/companion/feed${query}`)
      latestMessageId = Number(feed.latest_id || latestMessageId || 0)
      await handleMessages(Array.isArray(feed.messages) ? feed.messages : [])
    } catch (_) {}
  }

  function sendSocket(type, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify({ type, payload: payload || {} }))
    return true
  }

  function previewFeedback(data) {
    // 预览播放回执（诊断用）：确认后端广播的消息已到达桌宠并播放
    try {
      fetch('/api/companion/preview-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).catch(() => {})
    } catch (_) {}
  }

  function connectSocket() {
    if (!electronRuntime) return
    window.clearTimeout(socketRetryTimer)
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(`${scheme}//${window.location.host}/api/companion/ws`)
    socket.onopen = () => {
      socketRetry = 0
      backendOfflineSince = 0
      window.clearTimeout(backendOfflineTimer)
      backendOfflineTimer = null
      activityIndicator.classList.remove('offline')
      activityIndicator.title = 'Mio 当前状态'
      if (speechBubbleResponseId === 'agent-offline') hideSpeechBubble()
      sendRendererReady()
      window.clearInterval(socketPingTimer)
      socketPingTimer = window.setInterval(() => sendSocket('ping', {}), 15000)
    }
    socket.onmessage = async (event) => {
      let message
      try { message = JSON.parse(event.data) } catch (_) { return }
      const payload = message?.payload || {}
      // DSH 专用化（用户裁决 2026-10-17）：原有的 `xzPluginOn` gating 已删除 ——
      // 它只用于判断小智插件是否挂载，用来门控 speak / speech_interrupt /
      // visual_event / speech-bubble 这 4 个小智专用消息分支；这些分支已整体移除。
      if (message.type === 'ready') {
        await applySettings(payload.settings || {})
        applyActivity(payload.activity || {})
        fetchAgentsSnapshot()
      } else if (message.type === 'settings_changed') {
        await applySettings(payload)
      } else if (message.type === 'activity') {
        applyActivity(payload)
      } else if (message.type === 'agent_phase') {
        applyAgentPhase(payload)
      } else if (message.type === 'agent_status') {
        applyAgentStatus(payload)
      } else if (message.type === 'agents_snapshot') {
        fetchAgentsSnapshot()
      } else if (message.type === 'agent_bubble') {
        // 插件向桌宠发文本（走气泡）——按插件身份着色，与其它插件气泡区分。
        // 色值走 payload.accent（插件在 register 时声明、总线透传），
        // 这样桌宠窗口无需加载管理页的插件注册表也能正确着色。
        const text = String(payload.text || payload.content || '').trim()
        if (text) {
          showSpeechBubble(
            text,
            Number(payload.duration_ms) || 0,
            messageResponseId(payload),
            String(payload.agent_id || ''),
            String(payload.accent || ''),
          )
        }
      } else if (message.type === 'agent_stream') {
        // M1 逐 token 流式：插件的正文增量 → 气泡**追加式**渲染（不是一次性整段）。
        // 与 agent_bubble 的分工：agent_bubble = "说一句完整的话"（气泡自己按字均速
        // 打字机）；agent_stream = "把上游逐块交来的正文按上游节奏铺开"。
        applyAgentStream(payload)
      } else if (message.type === 'agent_strip') {
        // 7.6 横条（DSH 流式提示专用窗位）——**独立于气泡的第三条通路**。
        // 走核心 API `window.__mioPetStrip`，渲染端不直接改 DOM。
        // 与 agent_stream / agent_bubble 互不影响：横条被关掉时这里返回 false，
        // 气泡照常工作；反之亦然（用户裁决：三条通路独立管理）。
        applyAgentStrip(payload)
      // DSH 专用化（用户裁决 2026-10-17）：小智专用的 4 个消息分支已整体删除 ——
      //   'speak' / 'speech_interrupt' / 'visual_event' / 'speech-bubble'。
      //   它们全部由小智插件（xiaozhi-plugin.js / pet-xz-audio.js）驱动，
      //   而该插件与其后端 /api/xiaozhi/* 路由已阉割。将来做 DSH 语音请走新的 DSH 通路。
      } else if (message.type === 'foreground_changed') {
        handleForegroundChanged(payload)
      } else if (message.type === 'chat_window_state') {
        if (!electronRuntime) window.mioDesktop?.setChatWindowOpen?.(Boolean(payload.open))
      } else if (message.type === 'motion_preview') {
        // 用户主动预览动作：force 强制即时播放（绕过节流，避免连续点击/与待机动作撞车被吞）
        const _mpGroup = String(payload.group || '')
        const _mpIndex = Number.isInteger(payload.index) ? payload.index : undefined
        const _mpPlayed = playMotion(_mpGroup, _mpIndex, { force: true })
        previewFeedback({ kind: 'motion', group: _mpGroup, index: _mpIndex, played: _mpPlayed })
        // 动作预览 8s 后恢复待机动作（当前无其他活动时），防止动作播完不回待机
        window.clearTimeout(motionPreviewResetTimer)
        motionPreviewResetTimer = window.setTimeout(() => {
          if (!model || currentActivity !== 'idle') return
          playMotion(semanticMotion('idle'), undefined, { force: true })
        }, 8000)
      } else if (message.type === 'expression_preview') {
        if (payload.expression && model?.expression) {
          const previewExpression = String(payload.expression)
          Promise.resolve(model.expression(previewExpression))
            .then(() => previewFeedback({ kind: 'expression', expression: previewExpression, played: true }))
            .catch(() => previewFeedback({ kind: 'expression', expression: previewExpression, played: false }))
          // 预览表情 5.5s 后自动恢复当前情绪表情（小智联动/默认中性），防止表情卡住不回待机
          window.clearTimeout(expressionPreviewResetTimer)
          expressionPreviewResetTimer = window.setTimeout(() => {
            if (!model?.expression) return
            const restore = expressionForEmotion(currentEmotion)
            if (restore && restore !== previewExpression) {
              Promise.resolve(model.expression(restore)).catch(() => {})
            } else if (!restore) {
              // 找不到可恢复的自然表情 → 重置默认，防止预览表情卡住不回待机
              resetModelExpression()
            }
          }, 5500)
        }
      } else if (message.type === 'shutdown') {
        const bridge = await waitForBridge()
        await bridge.close_pet()
      }
    }
    socket.onclose = () => {
      window.clearInterval(socketPingTimer)
      if (!backendOfflineSince) backendOfflineSince = Date.now()
      activityIndicator.classList.add('offline')
      activityIndicator.title = 'Mio 已离线，正在重连'
      if (!backendOfflineTimer) {
        backendOfflineTimer = window.setTimeout(() => {
          backendOfflineTimer = null
          if (backendOfflineSince) showSpeechBubble('Agent 已离线，正在重连', 0, 'agent-offline')
        }, 1200)
      }
      const delay = Math.min(15000, 500 * (2 ** Math.min(socketRetry, 5))) + Math.random() * 300
      socketRetry += 1
      socketRetryTimer = window.setTimeout(connectSocket, delay)
    }
    socket.onerror = () => socket.close()
  }

  async function trackCursor() {
    if (!model || !settings.live2d_follow_cursor || electronRuntime || !window.pywebview?.api) return
    try {
      const cursor = await window.pywebview.api.cursor_state()
      if (cursor?.ok) model.focus(Number(cursor.x || 0), Number(cursor.y || 0))
    } catch (_) {}
  }

  function idleTick() {
    if (!model || !settings.live2d_idle_motion || Date.now() < nextIdleMotionAt) return
    playMotion(semanticMotion('idle'))
    nextIdleMotionAt = Date.now() + 45000 + Math.random() * 45000
  }

  function pointHitsModel(clientX, clientY) {
    if (!model || !model.visible) return false
    const bounds = model.getBounds()
    return clientX >= bounds.x && clientX <= bounds.x + bounds.width
      && clientY >= bounds.y && clientY <= bounds.y + bounds.height
  }

  function clickThroughLocked() {
    return electronRuntime && Boolean(settings.live2d_click_through_locked)
  }

  function updateContextMenuLabels() {
    if (speechBubbleButton) {
      speechBubbleButton.textContent = settings.live2d_speech_bubble_enabled === false
        ? '显示说话气泡'
        : '隐藏说话气泡'
    }
    // ★ 流式提示开关 —— 现在它控制的是**横条**（用户裁决：流式正文走横条、气泡只放工具状态）。
    //   判定同时看两个因素：
    //     - settings.live2d_stream_text_enabled（用户总开关）
    //     - 主体 localStorage 的 dismissed（用户点过 ✕）
    if (streamBubbleButton) {
      const streamOff = settings.live2d_stream_text_enabled === false
        || !!(window.__mioPetStrip && window.__mioPetStrip.isDismissed())
      streamBubbleButton.textContent = streamOff ? '显示流式提示' : '隐藏流式提示'
    }
    // 兼容：旧版菜单若还留着独立的「横条」按钮（data-action="strip"），让它与上面同源
    if (stripButton) {
      const stripOn = !(window.__mioPetStrip && window.__mioPetStrip.isDismissed())
      stripButton.textContent = stripOn ? '隐藏横条' : '显示横条'
    }
    // DSH 专用化：原「截图提问」按钮文案更新已随该功能移除
    if (agentBadgeButton) {
      agentBadgeButton.textContent = agentBadgeEnabled() ? '隐藏状态徽标' : '显示状态徽标'
    }
  }

  let lastBubblePos = null
  let lastBubblePosAt = 0
  function updateSpeechBubblePosition(force = false) {
    if (!model || speechBubble.hidden) return
    // 节流：拖动路径每帧调用，getBounds 是全模型遍历重操作；
    // 100ms 节流（≈10Hz）跟随足够，打字机/定位场景用 force 立即刷新
    const now = performance.now()
    if (!force && now - lastBubblePosAt < 100) return
    lastBubblePosAt = now
    const bounds = model.getBounds()
    const valid = bounds && bounds.width > 0 && bounds.height > 0
    if (!valid) {
      // 模型不可用（切换/加载中 getBounds 退化为 0,0）→ 保持上次位置，避免气泡飞到左上角
      if (!lastBubblePos) return
    } else {
      const bubbleBounds = speechBubble.getBoundingClientRect()
      const margin = 8
      const preferredLeft = bounds.x + bounds.width * 0.62
      const fallbackLeft = bounds.x - bubbleBounds.width + bounds.width * 0.38
      const useLeftSide = preferredLeft + bubbleBounds.width > window.innerWidth - margin
      const left = Math.max(
        margin,
        Math.min(window.innerWidth - bubbleBounds.width - margin, useLeftSide ? fallbackLeft : preferredLeft),
      )
      const top = Math.max(
        margin,
        Math.min(window.innerHeight - bubbleBounds.height - margin, bounds.y + bounds.height * 0.1 - bubbleBounds.height),
      )
      lastBubblePos = { left: Math.round(left), top: Math.round(top), useLeftSide }
    }
    speechBubble.style.left = `${lastBubblePos.left}px`
    speechBubble.style.top = `${lastBubblePos.top}px`
    speechBubble.classList.toggle('align-left', !lastBubblePos.useLeftSide)
  }

  // 气泡身份色：把插件声明的 accent 写到气泡上（CSS 按 data 属性套用）。
  // 未声明 accent 的插件/小智默认气泡 → 清掉标记，回到原样式。
  // accentFromPayload 是总线随 agent_bubble 透传下来的色值（优先级最高）。
  function applyBubbleAgentAccent(agentId, accentFromPayload) {
    if (!speechBubble) return
    const id = String(agentId || '')
    const accent = id ? agentAccentOf(id, accentFromPayload || AGENT_ACCENTS[id] || '') : ''
    if (accent) {
      speechBubble.dataset.agentId = id
      speechBubble.dataset.agentAccent = accent
      speechBubble.style.setProperty('--bubble-accent', accent)
    } else {
      delete speechBubble.dataset.agentAccent
      delete speechBubble.dataset.agentId
      speechBubble.style.removeProperty('--bubble-accent')
    }
  }

  function showSpeechBubble(text, durationMs = 0, responseId = '', agentId = '', accent = '') {
    if (settings.live2d_speech_bubble_enabled === false || !String(text || '').trim()) {
      hideSpeechBubble()
      return
    }
    // 别的来源（插件气泡/点击互动/唤醒词）要用这个框了：先中断流式会话，
    // 否则两套计时器会同时往 textContent 里写，出现"跳字/回退"。
    cancelAgentStream()
    // 气泡身份色：不同插件的气泡用各自专属色区分
    applyBubbleAgentAccent(agentId, accent)
    // 退出图片模式（点击互动的图片泡泡与文本共用同一个框）
    speechBubble.classList.remove('image-mode')
    const normalizedResponseId = String(responseId || '')
    const normalizedText = String(text).trim()
    if (!speechBubble.hidden && normalizedResponseId && normalizedResponseId === speechBubbleResponseId) {
      return
    }
    speechBubbleResponseId = normalizedResponseId
    window.clearTimeout(speechBubbleTimer)
    window.clearTimeout(speechBubbleHideTimer)
    speechBubbleHideTimer = null
    const characters = Array.from(normalizedText)
    speechBubbleCharacterCount = characters.length
    speechBubbleVisibleCount = 0
    speechBubble.style.width = ''
    speechBubble.style.visibility = 'hidden'
    speechBubbleText.textContent = characters.join('')
    speechBubble.hidden = false
    const measuredWidth = Math.ceil(speechBubble.getBoundingClientRect().width)
    speechBubble.style.width = `${Math.max(72, Math.min(260, measuredWidth))}px`
    speechBubbleText.textContent = ''
    speechBubble.style.visibility = ''
    const intervalMs = Number(durationMs) > 0
      ? Math.max(55, Math.min(240, Number(durationMs) * 0.92 / Math.max(1, characters.length)))
      : 180
    const revealNext = () => {
      if (speechBubble.hidden || settings.live2d_speech_bubble_enabled === false) return
      speechBubbleVisibleCount += 1
      speechBubbleText.textContent = characters.slice(0, speechBubbleVisibleCount).join('')
      speechBubbleText.scrollTop = speechBubbleText.scrollHeight
      updateSpeechBubblePosition(true)
      if (speechBubbleVisibleCount < characters.length) {
        speechBubbleTimer = window.setTimeout(revealNext, intervalMs)
      } else if (Number(durationMs) > 0) {
        speechBubbleHideTimer = window.setTimeout(hideSpeechBubble, Number(durationMs))
      }
    }
    revealNext()
  }

  function hideSpeechBubble() {
    cancelAgentStream()
    window.clearTimeout(speechBubbleTimer)
    window.clearTimeout(speechBubbleHideTimer)
    speechBubbleTimer = null
    speechBubbleHideTimer = null
    speechBubbleCharacterCount = 0
    speechBubbleVisibleCount = 0
    speechBubbleResponseId = ''
    speechBubble.hidden = true
    speechBubble.style.visibility = ''
    speechBubble.style.width = ''
    speechBubble.classList.remove('image-mode')
    speechBubbleText.textContent = ''
  }

  // -------------------------------------------------------------------------
  // M1 逐 token 流式：把插件（如 DSH）交来的正文增量，按**上游原始节奏**追加
  // -------------------------------------------------------------------------
  // 与 showSpeechBubble 的区别（这是两条独立路径，别合并）：
  //   showSpeechBubble：一端是"完整文本 + 期望总时长"，气泡自己算每字间隔；
  //   applyAgentStream：一端是"分块文本 + 每块之间的毫秒间隔(dt)"，气泡只负责
  //                     按时序把块贴上去——上游是快是慢，气泡就跟着是快是慢。
  //
  // 三个关键设计（都有踩坑理由）：
  //   1) **节奏下限** STREAM_MIN_STEP_MS：上游 provider 常把几十个 token 一次性
  //      flush（实测 dt 多为 0），直接照抄会"啪"地全段出现，等于没有流式感。
  //      故对每块间隔取 max(dt, 下限)——注意是**只垫高不压低**：真的慢就跟着慢。
  //   2) **总时长封顶** STREAM_MAX_TOTAL_MS：防病态日志（实测有单帧 dt 累计 30s）
  //      把气泡一直挂住；超了按比例压缩，保留相对节奏。
  //   3) **最终文本校正**：块间拼接可能因上游丢块/重复而与权威全文不一致，收尾
  //      时用 final_text 覆盖一次，保证"零丢字、零重复"。
  const STREAM_MIN_STEP_MS = 24
  const STREAM_MAX_STEP_MS = 1200
  const STREAM_MAX_TOTAL_MS = 30000
  let streamState = null

  /** 中断当前流（不隐藏气泡本身——由调用方决定后续动作）。 */
  function cancelAgentStream() {
    if (!streamState) return
    window.clearTimeout(streamState.timer)
    window.clearTimeout(streamState.holdTimer)
    streamState = null
  }

  /** 流播完：把权威全文校正上去，并按文本长度停留一会儿再消失。 */
  function finishAgentStream(responseId, finalText, rendered) {
    if (!streamState || streamState.responseId !== responseId) return
    const strip = window.__mioPetStrip
    const authoritative = String(finalText || '').trim()
    // 权威全文校正：块间拼接可能因上游丢块/重复而与 final_text 不一致。
    // 横条没有"直接设文本"的契约方法（show 会重开一段），故这里用 show 收尾：
    // 用权威全文覆盖一次，并给出停留时长 —— 语义等同气泡时代的"收尾校正 + hold"。
    const chars = Array.from(authoritative || String(rendered || '')).length
    const holdMs = Math.max(3500, Math.min(12000, chars * 60))
    if (strip) {
      strip.show(authoritative || String(rendered || ''), { durationMs: holdMs })
    }
    streamState.holdTimer = window.setTimeout(() => {
      if (streamState && streamState.responseId === responseId) {
        cancelAgentStream()
        // 到点收起横条内容（不改"用户已关闭"状态）
        if (strip) strip.hide()
      }
    }, holdMs + 200)
  }

  function applyAgentStream(payload) {
    if (!payload) return
    // ★★ 用户裁决（2026-10-17 二次对齐）：**流式正文走横条，不进气泡** ★★
    //
    // 三条通路各司其职（别再揉在一起）：
    //   ┌ 气泡 #speech-bubble   ← agent_bubble：**工具状态**，如「正在用 read 干活…」
    //   ├ 横条 #pet-strip       ← agent_stream：**DSH 下发的流式正文**（逐 token 铺开）
    //   └ （气泡与横条互斥使用，不再抢同一个框）
    //
    // 为什么这样分：用户原话「把 DSH 下发的流式状态放进横条里，气泡里只显示使用工具情况，
    //   流式话语用横条显示不在气泡显示」。此前把流式正文塞进气泡，会和工具状态气泡打架
    //   （一个要逐字铺、一个要整句停 4 秒），体验上互相打断。
    if (settings.live2d_stream_text_enabled === false) return
    const texts = Array.isArray(payload.texts) ? payload.texts.map((t) => String(t == null ? '' : t)) : []
    const finalText = String(payload.final_text || '')
    // 只认正文（text-chunks）。上游将来若新增 reasoning/tool-call 之类的流，
    // 缺了这道判断就会把**模型推理草稿**直接铺到横条上——那是明确的越界。
    const frame = String(payload.frame || 'text-chunks')
    if (frame !== 'text-chunks') return
    if (!texts.join('') && !finalText.trim()) return
    // B4 降级：上游只给了权威全文、没给增量（老日志/丢帧）时整块上屏。
    if (!texts.length) texts.push(finalText.trim())

    const strip = window.__mioPetStrip
    // 主体没有横条（旧版桌宠）→ 静默忽略。**不再回落到气泡** ——
    // 回落会让"流式又跑回气泡"，正是本次要消除的错位。
    if (!strip) return

    const responseId = [
      'agent-stream',
      String(payload.agent_id || ''),
      String(payload.session || ''),
      String(payload.turn == null ? '' : payload.turn),
      String(payload.step == null ? '' : payload.step),
      String(payload.index == null ? 0 : payload.index),
    ].join(':')
    // 同一条消息重复下发（例如边车重放）直接忽略：动画不该从头再来一遍
    if (streamState && streamState.responseId === responseId) return

    cancelAgentStream()
    streamState = { responseId, index: 0, timer: null, holdTimer: null }

    // 清空横条并以 sticky 模式开流：sticky = 不回自动隐藏计时，由收尾统一排期
    strip.show('', { sticky: true, sessionId: String(payload.session || '') })

    const dt = Array.isArray(payload.dt) ? payload.dt : []
    const steps = []
    for (let i = 0; i < texts.length - 1; i += 1) {
      const raw = Number(dt[i])
      const value = Number.isFinite(raw) && raw > 0 ? raw : 0
      steps.push(Math.min(STREAM_MAX_STEP_MS, Math.max(STREAM_MIN_STEP_MS, value)))
    }
    let total = steps.reduce((a, b) => a + b, 0)
    if (total > STREAM_MAX_TOTAL_MS) {
      const k = STREAM_MAX_TOTAL_MS / total
      for (let i = 0; i < steps.length; i += 1) steps[i] = Math.max(1, steps[i] * k)
      total = steps.reduce((a, b) => a + b, 0)
    }

    // ★ 流式正文铺到**横条**（不是气泡）。sticky 已在上面 show 时开启，
    //   这里只负责按上游 dt 节奏逐块 append。
    let shown = ''
    const step = () => {
      if (!streamState || streamState.responseId !== responseId) return
      // 只看流式自己的开关
      if (settings.live2d_stream_text_enabled === false) {
        // 用户在播放途中关掉流式开关：立即收尾，不留半截文本挂在横条上
        cancelAgentStream()
        if (strip) strip.hide()
        return
      }
      const chunk = texts[streamState.index]
      shown += chunk
      if (strip) strip.append(chunk, { sessionId: String(payload.session || '') })
      streamState.index += 1
      if (streamState.index < texts.length) {
        // 第 i 块之后等 steps[i-1]（dt 描述的是"块间间隔"）
        streamState.timer = window.setTimeout(step, steps[streamState.index - 1])
      } else {
        // ★ 最后一块贴完：把"下一步定时器"清成 null 再收尾。
        //   原来这里不清，`streamState.timer` 会永远留着一个**已失效的定时器 id**
        //   （truthy），于是流走完后内部状态自相矛盾：既"有 timer"又"有 hold"。
        //   这会让任何"是否仍在播"的判断都不可靠（本仓库 E2E 的偶发失败正是
        //   基于这个歧义状态做的推断）。清掉后语义明确：
        //     index <  texts.length  ⇒ timer 有值（正在播）
        //     index === texts.length ⇒ timer 为 null、holdTimer 有值（播完停留中）
        streamState.timer = null
        finishAgentStream(responseId, finalText, shown)
      }
    }
    // 首块立即上屏：流式的"首字延迟"取决于上游何时把第一块交来，气泡不额外引入延迟
    step()
  }

  // ---------------------------------------------------------------------------
  // 7.6 横条投递：WS `agent_strip` → 核心 API `window.__mioPetStrip`
  // ---------------------------------------------------------------------------
  // 为什么要有一条独立通路（而不是复用 agent_stream）：
  //   `__mioPetStrip` 是**桌宠窗口**的核心 API，而插件跑在 DSH 宿主进程、
  //   其注入行所在的又是 **DSH Web GUI 窗口** —— 三者互不相通。
  //   所以横条内容必须经后端总线转发：插件 → /api/plugin/dsh/strip → 总线
  //   → WS agent_strip → 这里 → __mioPetStrip。
  //
  // 与 agent_stream / agent_bubble 的**独立性**（用户裁决）：
  //   本函数只碰横条；横条被用户关掉时 `show/append` 会返回 false（静默忽略），
  //   气泡那两条通路完全不受影响。反过来也一样。
  function applyAgentStrip(payload) {
    if (!payload) return false
    const api = window.__mioPetStrip
    // 主体没实现横条（旧版桌宠）时静默忽略：不报错、不重试风暴。
    if (!api) return false
    const kind = String(payload.kind || '').toLowerCase()
    try {
      if (kind === 'show') {
        return api.show(String(payload.text || ''), {
          sessionId: String(payload.session || ''),
          sticky: Boolean(payload.sticky),
          durationMs: Number(payload.durationMs) || 0,
        }) === true
      }
      if (kind === 'append') {
        return api.append(String(payload.text || ''), {
          sessionId: String(payload.session || ''),
        }) === true
      }
      if (kind === 'hide') {
        api.hide()
        return true
      }
      if (kind === 'style') {
        // 皮肤由主体落地（插件不碰 DOM/CSS 类）
        api.applyStyle(String(payload.styleId || ''))
        return true
      }
      return false
    } catch (_) {
      // 契约要求主体任何方法都不得抛；这里再兜一层，绝不让一条坏消息带崩渲染循环
      return false
    }
  }

  async function persistCompanionSetting(key, value) {
    settings[key] = value
    await request('/api/companion/settings', {
      method: 'PATCH',
      body: JSON.stringify({ [key]: value }),
    })
  }

  // A组 点击互动：点桌宠 → 随机语句 / 随机图片，都显示在**说话气泡框**里
  // （复用小智消息的同一个气泡：同框/同尾巴/同位置/同打字机节奏的图片变体）。
  function showImageInBubble(entry) {
    if (settings.live2d_speech_bubble_enabled === false) return
    const imgEl = document.getElementById('speech-bubble-img')
    if (!imgEl || !entry?.url) return
    window.clearTimeout(speechBubbleTimer)
    window.clearTimeout(speechBubbleHideTimer)
    speechBubbleHideTimer = null
    speechBubbleResponseId = `click-image-${Date.now()}`
    speechBubble.classList.add('image-mode')
    imgEl.src = entry.url + '?v=' + String(entry.mtime || Date.now())
    speechBubble.style.width = '232px'
    speechBubble.hidden = false
    updateSpeechBubblePosition(true)
    // 点击触发的图片 3s 自动消失（用户裁决：不要一直挂着）
    speechBubbleHideTimer = window.setTimeout(hideSpeechBubble, 3000)
  }

  async function showClickTalk() {
    // 1) 点击序列模式：配置了 first/queue 就按序列推进（首次泡 → 队列 → 循环）
    const item = nextClickBubbleItem()
    if (item !== null) {
      const resolved = resolveBubbleItem(item)
      if (resolved && resolved.image) {
        const imgApi = window.__mioPetRandomImage
        if (imgApi) {
          const list = await imgApi.refresh()
          if (Array.isArray(list) && list.length) {
            const im = imgApi.pick()
            if (im) { showImageInBubble(im); return }
          }
        }
        showSpeechBubble('（素材库还没有图片）', 3000, `click-talk-${Date.now()}`)
        return
      }
      if (resolved && resolved.text) {
        showSpeechBubble(resolved.text, 3000, `click-talk-${Date.now()}`)
        return
      }
    }
    // 2) 缺省随机模式：素材库有图时 45% 概率出图片，否则出随机语句（复用空闲自语内容池）
    try {
      const imgApi = window.__mioPetRandomImage
      if (imgApi) {
        const list = await imgApi.refresh()
        if (Array.isArray(list) && list.length && Math.random() < 0.45) {
          const im = imgApi.pick()
          if (im) { showImageInBubble(im); return }
        }
      }
    } catch (_) {}
    const talk = window.__mioPetIdleTalk
    // 3s 自动消失（用户裁决：点击弹出的气泡不要一直挂着；打字机节奏随 3s 收敛）
    if (talk) showSpeechBubble(talk.pick(anyAgentBusy()), 3000, `click-talk-${Date.now()}`)
  }

  // ---- 点击序列（whale 的"首次点击泡 + 再次点击队列"）：配置在「泡泡 → 点击互动」----
  let clickSeqStep = 0
  function clickSequence() {
    const cfg = settings.pet_click_bubbles
    if (!cfg || typeof cfg !== 'object') return null
    const first = String(cfg.first || '').trim()
    const queue = Array.isArray(cfg.queue)
      ? cfg.queue.map((x) => String(x || '').trim()).filter(Boolean)
      : []
    if (!first && !queue.length) return null
    return { first, queue }
  }

  /** 返回本次点击应显示的项（'' 表示无内容）；未配置序列时返回 null（走随机模式）。 */
  function nextClickBubbleItem() {
    const seq = clickSequence()
    if (!seq) return null
    const total = (seq.first ? 1 : 0) + seq.queue.length
    const idx = clickSeqStep % total
    clickSeqStep = (clickSeqStep + 1) % total
    if (seq.first && idx === 0) return seq.first
    return seq.queue[idx - (seq.first ? 1 : 0)] || seq.first || ''
  }

  /** 项语法：`a|b|c` 等权随机；`{image}` 随机图片；其余按纯文本。 */
  function resolveBubbleItem(item) {
    const s = String(item || '').trim()
    if (!s) return null
    if (s === '{image}') return { image: true }
    if (s.indexOf('|') >= 0) {
      const parts = s.split('|').map((x) => x.trim()).filter(Boolean)
      if (parts.length) return { text: parts[Math.floor(Math.random() * parts.length)] }
    }
    return { text: s }
  }

  async function setClickThroughLocked(enabled, persist = true) {
    const locked = Boolean(enabled)
    settings.live2d_click_through_locked = locked
    root.classList.toggle('click-through-locked', locked)
    contextMenu.hidden = true
    sizePanel.hidden = true
    pointerDown = null
    dragged = false
    root.classList.remove('dragging')
    updateContextMenuLabels()
    if (electronRuntime) window.mioDesktop.setClickThroughLocked(locked)
    if (persist) {
      try { await persistCompanionSetting('live2d_click_through_locked', locked) } catch (_) {}
    }
    if (locked) setInteractive(false)
    else updateMousePassThrough(true)
  }

  function setInteractive(interactive) {
    if (!electronRuntime || interactiveState === interactive) return
    interactiveState = interactive
    window.mioDesktop.setInteractive(interactive)
  }

  // 主进程轮询鼠标位置驱动穿透/交互：上报模型可交互区域与 UI 打开状态（节流）
  let lastModelBoundsReport = 0
  function reportModelBounds() {
    if (!electronRuntime || !window.mioDesktop || !window.mioDesktop.setModelBounds) return
    const now = performance.now()
    if (now - lastModelBoundsReport < 100) return
    lastModelBoundsReport = now
    try {
      if (!model || !model.visible) return
      const b = model.getBounds()
      if (!b || b.width <= 0 || b.height <= 0) return
      window.mioDesktop.setModelBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
    } catch (_) {}
  }
  let lastUiOpenReport = null
  function reportUiOpen() {
    if (!electronRuntime || !window.mioDesktop || !window.mioDesktop.setUiOpen) return
    // UI 打开 = 任一模态面板可见（含 A7 角色图库 + 不透明度面板——历史漏报导致点击全穿透）
    let galleryOpen = false
    try {
      const g = document.getElementById('pet-gallery')
      galleryOpen = Boolean(g && !g.hidden)
    } catch (_) {}
    const opacityOpen = Boolean(opacityPanel && !opacityPanel.hidden)
    const open = !contextMenu.hidden || !sizePanel.hidden || galleryOpen || opacityOpen
    if (open === lastUiOpenReport) return
    lastUiOpenReport = open
    window.mioDesktop.setUiOpen(open)
  }

  function updateMousePassThrough(force = false, event = null) {
    if (clickThroughLocked()) {
      setInteractive(false)
      return
    }
    if (!electronRuntime || !settings.live2d_smart_passthrough) {
      if (electronRuntime) setInteractive(true)
      return
    }
    if (passThroughFrame && !force) return
    passThroughFrame = window.requestAnimationFrame(() => {
      passThroughFrame = null
      const menuOpen = !contextMenu.hidden || !sizePanel.hidden
      const x = Number(event?.clientX ?? -10000)
      const y = Number(event?.clientY ?? -10000)
      setInteractive(menuOpen || Boolean(pointerDown) || pointHitsModel(x, y))
    })
  }

  window.addEventListener('mousemove', (event) => {
    // 鼠标移动不标记为"活动"：否则空闲降帧（30s→12fps）永不触发，
    // 用户操作电脑时桌宠会一直 60fps 渲染大画布，拖慢整机
    if (model && settings.live2d_follow_cursor && !cursorFocusFrame) {
      const { clientX, clientY } = event
      cursorFocusFrame = window.requestAnimationFrame(() => {
        cursorFocusFrame = null
        if (model && settings.live2d_follow_cursor) model.focus(clientX, clientY)
      })
    }
    updateMousePassThrough(false, event)
  })

  canvas.addEventListener('pointerdown', async (event) => {
    markPetActivity()
    // 音频解锁必须在这个**用户手势的同步栈**里完成。
    // 放到 await 之后或首次播放时再做，Chromium 会拒绝启动 AudioContext，
    // 表现就是"点了完全没声音"。
    try { const s = window.__mioPetSound; if (s) { s.setEnabled(settings.pet_sound_enabled !== false); s.unlock() } } catch (_) {}
    if (clickThroughLocked() || event.button !== 0 || !pointHitsModel(event.clientX, event.clientY)) return
    // ★ 交互打磨（2026-10-17）：锁定位置 / SHIFT 拖动。
    //   两种都只禁止**拖动**，点击互动（音效/气泡/动作）照常。
    //   - 锁定：完全禁止拖动；
    //   - SHIFT 拖动：未按住 Shift 时禁止拖动（防误拖）。
    const shiftHeld = Boolean(event.shiftKey)
    const locked = Boolean(settings.live2d_pet_locked)
    const shiftDragMode = Boolean(settings.live2d_pet_shift_drag)
    const canDrag = !locked && (!shiftDragMode || shiftHeld)
    pointerDown = {
      x: event.clientX,
      y: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      modelX: model?.x || 0,
      modelY: model?.y || 0,
      positionX: Number(settings.position_x || 0),
      positionY: Number(settings.position_y || 0),
      time: Date.now(),
      pointerId: event.pointerId,
      canDrag,
      vx: 0,
      vy: 0,
      lastX: event.clientX,
      lastY: event.clientY,
      lastT: Date.now(),
    }
    dragged = false
    root.classList.add('dragging')
    canvas.setPointerCapture(event.pointerId)
    setInteractive(true)
    // A 档交互反馈：按压音 + Q 弹（点击模型本体，非拖动开始）
    petSound('press')
    playPressBounce()
    const bridge = await waitForBridge()
    await bridge.begin_drag(event.screenX, event.screenY)
  })

  canvas.addEventListener('pointermove', async (event) => {
    if (!pointerDown) return
    const dx = event.clientX - pointerDown.x
    const dy = event.clientY - pointerDown.y
    const distance = Math.hypot(dx, dy)
    if (distance > 6) {
      // ★ 锁定 / SHIFT 未按下时：标记为"想拖但被禁止"，不算拖动、不移动模型
      if (pointerDown.canDrag) dragged = true
    }
    // 记录速度（供松手惯性用）：最近一段位移/时间
    const now = Date.now()
    const dt = Math.max(1, now - pointerDown.lastT)
    if (pointerDown.canDrag) {
      pointerDown.vx = (event.clientX - pointerDown.lastX) / dt * 1000
      pointerDown.vy = (event.clientY - pointerDown.lastY) / dt * 1000
    }
    pointerDown.lastX = event.clientX
    pointerDown.lastY = event.clientY
    pointerDown.lastT = now
    if (electronRuntime && model) {
      if (pointerDown.canDrag) {
        model.x = pointerDown.modelX + dx
        model.y = pointerDown.modelY + dy
      }
      updateSpeechBubblePosition()
      updateLockControlAnchor()
    } else if (dragged && pointerDown.canDrag) {
      const bridge = await waitForBridge()
      await bridge.drag_to(event.screenX, event.screenY)
    }
  })

  async function finishPointerInteraction(event) {
    if (!pointerDown) return
    const interaction = pointerDown
    const wasDragged = dragged
    const dx = Number(event?.clientX ?? interaction.x) - interaction.x
    const dy = Number(event?.clientY ?? interaction.y) - interaction.y
    pointerDown = null
    dragged = false
    root.classList.remove('dragging')
    // A 档交互反馈：释放音（与按压音成对，构成"咔哒"手感）
    petSound('release')
    const bridge = await waitForBridge()
    await bridge.end_drag()
    if (electronRuntime && wasDragged) {
      const virtual = desktopState.bounds || { x: 0, y: 0 }
      const vw = Number(virtual.width) || window.innerWidth
      const vh = Number(virtual.height) || window.innerHeight
      const marginX = Math.min(72, Math.max(32, vw * 0.08))
      const marginY = Math.min(96, Math.max(48, vh * 0.1))
      // 完全放开上下与水平限位：位置原样保存，不做任何回弹
      const nextX = Math.round(interaction.positionX + dx)
      const nextY = Math.round(interaction.positionY + dy)
      settings.position_x = nextX
      settings.position_y = nextY
      request('/api/companion/position', {
        method: 'PATCH',
        body: JSON.stringify({ x: nextX, y: nextY }),
      }).catch(() => {})
      sendSocket('dragged', { distance: Math.round(Math.hypot(dx, dy)), x: nextX, y: nextY })
      // ★ 拖拽惯性（2026-10-17 交互打磨）：松手后按拖动末速度继续滑行，阻尼衰减到停。
      //   只在 Electron + 模型存在 + 惯性开关开启 + 速度够大时启动。
      if (settings.live2d_pet_inertia !== false && model && Math.hypot(interaction.vx || 0, interaction.vy || 0) > 120) {
        let vx = interaction.vx || 0
        let vy = interaction.vy || 0
        let last = Date.now()
        const damp = 0.92          // 每帧阻尼（越小停得越快）
        const minV = 30            // 低于此速度停止
        const step = () => {
          const now = Date.now()
          const dt = Math.max(1, Math.min(50, now - last)) / 1000   // 秒，钳制防跳帧
          last = now
          vx *= damp
          vy *= damp
          const mvx = vx * dt
          const mvy = vy * dt
          model.x = (model.x || 0) + mvx
          model.y = (model.y || 0) + mvy
          updateSpeechBubblePosition()
          updateLockControlAnchor()
          if (Math.hypot(vx, vy) > minV) {
            inertiaRaf = requestAnimationFrame(step)
          } else {
            // 停稳：把最终位置写回后端（覆盖上面"松手即存"的中间值）
            const fx = Math.round((interaction.positionX + (model.x - (interaction.modelX || 0))) || 0)
            const fy = Math.round((interaction.positionY + (model.y - (interaction.modelY || 0))) || 0)
            settings.position_x = fx
            settings.position_y = fy
            request('/api/companion/position', {
              method: 'PATCH',
              body: JSON.stringify({ x: fx, y: fy }),
            }).catch(() => {})
            inertiaRaf = null
          }
        }
        if (inertiaRaf) cancelAnimationFrame(inertiaRaf)
        inertiaRaf = requestAnimationFrame(step)
      }
    } else if (!wasDragged) {
      if (settings.live2d_click_motion) playMotion(semanticMotion('touch'), undefined, { force: true })
      sendSocket('clicked', { x: event?.screenX || 0, y: event?.screenY || 0, emotion: 'gentle' })
      // A组 点击互动：点桌宠 → 随机语句（复用说话气泡）或随机图片（气泡图片模式）
      if (settings.pet_click_talk_enabled !== false && speechBubble?.hidden) {
        showClickTalk()
      }
    }
    // 拖动/点击结束：强制刷新一次气泡与锁定锚点位置（拖动中走节流，收尾必须精确）
    updateSpeechBubblePosition(true)
    updateLockControlAnchor(true)
    updateMousePassThrough(true, event)
  }

  canvas.addEventListener('pointerup', finishPointerInteraction)
  canvas.addEventListener('pointercancel', finishPointerInteraction)

  canvas.addEventListener('dblclick', async (event) => {
    if (clickThroughLocked() || !pointHitsModel(event.clientX, event.clientY)) return
    // ★ DSH 专用化快捷操作（2026-10-17 用户要求）：双击桌宠直达 **DSH 面板**。
    //   主进程打开 MIO 管理窗并在其渲染层触发 __mioDshPanel.show()（带就绪重试）。
    //   Electron 桥缺失时（非宿主环境）回落到原行为（开对话横条）。
    event.preventDefault()
    sendSocket('double_clicked', { x: event.screenX, y: event.screenY })
    try {
      if (electronRuntime && window.mioDesktop?.openDshPanel) {
        window.mioDesktop.openDshPanel()
        return
      }
      if (electronRuntime && window.mioDesktop?.toggleChatWindow) {
        window.mioDesktop.toggleChatWindow()
      } else {
        const bridge = await waitForBridge()
        await bridge.open_chat()
      }
    } catch (_) { /* 打开失败不影响桌宠本体 */ }
  })

  document.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    if (clickThroughLocked()) return
    if (electronRuntime && !pointHitsModel(event.clientX, event.clientY)) return
    updateContextMenuLabels()
    // 插件化菜单：只显示"已挂载插件"声明的条目（小智未启用 → chat/截图提问/气泡入口不存在）
    if (window.__mioPluginBus) {
      const pluginItems = new Set(window.__mioPluginBus.getMenuItems().map((item) => item.action))
      contextMenu.querySelectorAll('button[data-action]').forEach((btn) => {
        const action = btn.dataset.action
        btn.hidden = window.__mioPluginBus.isPluginAction(action)
          ? !pluginItems.has(action)
          : false
      })
    }
    contextMenu.hidden = false
    contextMenu.style.visibility = 'hidden'
    contextMenu.style.left = '4px'
    contextMenu.style.top = '4px'
    reportUiOpen()
    const menuBounds = contextMenu.getBoundingClientRect()
    contextMenu.style.left = `${Math.max(4, Math.min(window.innerWidth - menuBounds.width - 4, event.clientX))}px`
    contextMenu.style.top = `${Math.max(4, Math.min(window.innerHeight - menuBounds.height - 4, event.clientY))}px`
    contextMenu.style.visibility = ''
    setInteractive(true)
  })

  document.addEventListener('pointerdown', (event) => {
    if (!contextMenu.contains(event.target)) contextMenu.hidden = true
    if (!sizePanel.contains(event.target) && event.target?.dataset?.action !== 'size') sizePanel.hidden = true
    // ★ 不透明度面板同样「点外部/点其它菜单项就收起」
    if (opacityPanel && !opacityPanel.contains(event.target) && event.target?.dataset?.action !== 'opacity') opacityPanel.hidden = true
  })

  // ★ 定位某个面板到点击位置旁（sizePanel / opacityPanel 复用）
  function positionSizePanelNear(event, panelEl) {
    const p = panelEl || sizePanel
    if (!p) return
    const rect = p.getBoundingClientRect()
    const px = Number(event?.clientX ?? window.innerWidth - rect.width - 16)
    const py = Number(event?.clientY ?? window.innerHeight - rect.height - 16)
    p.style.left = `${Math.max(8, Math.min(window.innerWidth - rect.width - 8, px))}px`
    p.style.top = `${Math.max(8, Math.min(window.innerHeight - rect.height - 8, py))}px`
  }

  // A7 角色图库：条目来自既有 models 接口（含 preview_url），本函数只做定位
  let galleryModels = []

  function positionGalleryNear(event) {
    const panelEl = document.getElementById('pet-gallery')
    if (!panelEl) return
    const rect = panelEl.getBoundingClientRect()
    const px = Number(event?.clientX ?? window.innerWidth - rect.width - 16)
    const py = Number(event?.clientY ?? window.innerHeight - rect.height - 16)
    panelEl.style.left = `${Math.max(8, Math.min(window.innerWidth - rect.width - 8, px))}px`
    panelEl.style.top = `${Math.max(8, Math.min(window.innerHeight - rect.height - 8, py))}px`
  }

  function initGallery() {
    const g = window.__mioPetGallery
    if (!g) return
    g.mount(root)
    // 选中即切模型；切完关掉面板，避免挡住角色
    g.onPick(async (id) => {
      try {
        const ok = await switchModel(id)
        if (!ok) showSpeechBubble('这个形象暂时用不了', 3000)
      } catch (err) {
        showSpeechBubble(`切换形象失败：${String(err && err.message || err)}`, 4000)
      }
      g.hide()
    })
  }

  // 图库数据源：既有 /api/companion/live2d/models（含 preview_url 与 imported 标记）。
  // 不新增接口、不在这里重复实现模型发现逻辑。
  async function refreshGalleryModels() {
    try {
      const data = await request('/api/companion/live2d/models')
      const list = Array.isArray(data?.models) ? data.models : []
      galleryModels = list
        .map((m) => ({
          id: String(m?.id || ''),
          name: String(m?.name || m?.id || ''),
          preview_url: String(m?.preview_url || ''),
          imported: Boolean(m?.imported),
        }))
        .filter((m) => m.id)
    } catch (_) {
      // 拿不到就沿用上次缓存；首次失败时图库显示"没有可用形象"，不弹错误打扰
    }
    return galleryModels
  }

  contextMenu.addEventListener('click', async (event) => {
    const action = event.target.closest('button')?.dataset.action
    if (!action) return
    contextMenu.hidden = true
    const bridge = await waitForBridge()
    if (action === 'chat') await bridge.open_chat()
    if (action === 'size') {
      sizePanel.hidden = false
      positionSizePanelNear(event)
    }
    if (action === 'opacity') {
      // ★ 调整不透明度（2026-10-17 复用「调整大小」面板逻辑）
      const cur = Number(settings.live2d_pet_opacity ?? 100)
      opacitySlider.value = String(Math.max(10, Math.min(100, cur)))
      opacityValue.value = `${opacitySlider.value}%`
      opacityPanel.hidden = false
      positionSizePanelNear(event, opacityPanel)
    }
    if (action === 'gallery') {
      // A7：桌宠内直接换形象（不必打开管理页）
      const g = window.__mioPetGallery
      if (g) {
        g.mount(root)
        g.setCurrent(selectedModelId())
        g.show()                       // 先打开（有缓存立即可用），再刷新列表
        positionGalleryNear(event)
        refreshGalleryModels().then(() => {
          g.setModels(galleryModels)
          g.setCurrent(selectedModelId())
          positionGalleryNear(event)   // 列表变长后重新定位，避免超出窗口
        })
      }
    }
    // DSH 专用化（用户裁决 2026-10-17）：「截图提问」已移除。
    //   它调用 /api/xiaozhi/vision（小智官方云视觉），该路由随小智插件阉割已删除。
    //   菜单项同时从 index.html 移除；将来若要做 DSH 侧屏幕问答，应走新的 DSH 视觉通路。
    if (action === 'speech-bubble') {
      const enabled = settings.live2d_speech_bubble_enabled === false
      try { await persistCompanionSetting('live2d_speech_bubble_enabled', enabled) } catch (_) {}
      updateContextMenuLabels()
      if (enabled && voiceLifecycleActive) showSpeechBubble(activeSpeechText)
      else if (!enabled) hideSpeechBubble()
    }
    // ★ 流式气泡独立开关：只影响"逐 token 流式"这条通路，不碰说话气泡，
    //   也不碰横条（三者各自独立管理 —— 用户裁决）。
    if (action === 'stream-bubble') {
      // ★ 用户裁决：流式正文走横条 ⇒ 这个开关**就是横条的开关**。
      //   开启/关闭需要同时处理两处状态：
      //     - settings.live2d_stream_text_enabled（总开关，重启后仍生效）
      //     - 主体 localStorage 的 dismissed（用户点过 ✕ 的持久记忆）
      //   否则会出现"菜单说开了、横条却不显示"（被 dismissed 挡着）的割裂。
      const stripApi = window.__mioPetStrip
      const nowOff = settings.live2d_stream_text_enabled === false
        || !!(stripApi && stripApi.isDismissed())
      const enabled = nowOff // 当前是关 → 点击后要开
      try { await persistCompanionSetting('live2d_stream_text_enabled', enabled) } catch (_) {}
      if (stripApi) {
        if (enabled) {
          // 重开：清掉"用户已拒绝"记忆，并展示一次让用户看到效果
          if (typeof stripApi.resetDismissed === 'function') stripApi.resetDismissed()
          stripApi.show('流式提示已开启', { durationMs: 2000 })
        } else {
          // 关闭：立即收尾（不留半截），并写入"已拒绝"持久态（与点 ✕ 同语义）
          cancelAgentStream()
          if (typeof stripApi.markDismissed === 'function') stripApi.markDismissed()
          else stripApi.hide()
        }
      }
      updateContextMenuLabels()
    }
    // ★ 横条独立开关：与两种气泡都无关。
    //   横条的"关闭态"持久在主体（localStorage），这里做"显示/隐藏"的双向切换。
    if (action === 'strip') {
      const api = window.__mioPetStrip
      if (api) {
        if (api.isDismissed()) {
          // 已关闭 → 重开：清掉持久记忆，并立即展示一次让用户看到效果
          if (typeof api.resetDismissed === 'function') api.resetDismissed()
          api.show('横条已开启', { durationMs: 2000 })
        } else {
          // 开启中 → 关闭：写"已拒绝"持久态（与点 ✕ 同一语义）
          if (typeof api.markDismissed === 'function') api.markDismissed()
          else if (typeof api.resetDismissed === 'function') {
            // 兼容：主体未暴露 markDismissed 时，退化为"隐藏 + 记为已关闭"
            api.hide()
          }
        }
        // 同步到服务端，让设置页与其它窗口看到一致状态（键与泡泡皮肤同族）
        try { await persistCompanionSetting('live2d_strip_enabled', !api.isDismissed()) } catch (_) {}
      }
      updateContextMenuLabels()
    }
    if (action === 'agent-badge') {
      // 显示/隐藏 Agent 状态徽标（localStorage 持久化；切换时立即生效）
      const nowEnabled = !agentBadgeEnabled()
      localStorage.setItem('mio_agent_badge_enabled', nowEnabled ? '1' : '0')
      updateContextMenuLabels()
      if (!nowEnabled) {
        const b = document.getElementById('agent-badge')
        if (b) b.style.opacity = '0'
      } else {
        renderAgentBadge()
      }
    }
    if (action === 'agent') await bridge.open_agent()
    if (action === 'close') await bridge.close_pet()
    updateMousePassThrough(true, event)
  })

  // 切换 Live2D 形象（下拉框与角色图库**共用同一个入口**，避免两处逻辑漂移）
  async function switchModel(modelId) {
    const id = String(modelId || '')
    if (!modelDefinitions[id]) return false
    const definition = modelDefinitions[id]
    // ★ 记录用户切换意图（宽限期判据）。必须在 await selectModel 之前：
    //   真实 Electron 里主进程在 ipcMain.handle 内同步 sendModelsChanged()，
    //   广播先于 invoke 回包到达 ⇒ onModelsChanged 回调先于本函数后续代码执行。
    modelSwitchTarget = id
    modelSwitchAt = Date.now()
    // 桌面侧：导入形象要让主进程把该模型目录设为当前资源目录；内置形象则清掉桌面侧覆盖，
    // 回到「以服务端 live2d_model_id 为准」。
    if (electronRuntime && window.mioDesktop && window.mioDesktop.selectModel) {
      const override = definition.source === 'imported' ? id : ''
      try {
        await window.mioDesktop.selectModel(override)
      } catch (_) { /* 主进程不可用时仍继续走服务端回写 */ }
      desktopSelectedModelId = override
    }
    // ★ 服务端 live2d_model_id 才是「当前形象」的唯一持久真相。
    //   pollStatus() 每 5s 拉一次 /api/companion/status，applySettings() 见到 settings 里带
    //   live2d_model_id 就会清空 desktopSelectedModelId（见 applySettings 注释），于是
    //   selectedModelId() 落回服务端值 —— 不回写服务端的话，形象会在下一次轮询（≤5s）
    //   被弹回原样，表现为「切换后很快又变回去」。
    //   注意：导入形象同样要回写（它不只是主进程 runtime state 的事）。
    settings.live2d_model_id = id
    await request('/api/companion/settings', {
      method: 'PATCH',
      body: JSON.stringify({ ...settings, live2d_model_id: id }),
    })
    // onModelsChanged 广播（selectModel 触发）已经发起/完成了同一目标的加载，
    // 这里就不必再加载一遍（大模型如大肥鱼 28MB，重复解析很可观）。
    // 广播那次若失败，lastLoad.done 已被置 true，这里仍会重试。
    if (currentModelId !== id && !(lastLoad.target === id && !lastLoad.done)) await loadModel(id)
    return true
  }

  modelSelect?.addEventListener('change', async () => {
    const modelId = String(modelSelect.value || '')
    await switchModel(modelId)
  })

  const sizePanelHeader = document.getElementById('size-panel-header')
  let panelDrag = null
  sizePanelHeader?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    panelDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: sizePanel.offsetLeft,
      top: sizePanel.offsetTop,
    }
    try { sizePanelHeader.setPointerCapture(event.pointerId) } catch (_) {}
  })
  sizePanelHeader?.addEventListener('pointermove', (event) => {
    if (!panelDrag || panelDrag.pointerId !== event.pointerId) return
    const dx = event.clientX - panelDrag.startX
    const dy = event.clientY - panelDrag.startY
    const rect = sizePanel.getBoundingClientRect()
    sizePanel.style.left = `${Math.max(4, Math.min(window.innerWidth - rect.width - 4, panelDrag.left + dx))}px`
    sizePanel.style.top = `${Math.max(4, Math.min(window.innerHeight - rect.height - 4, panelDrag.top + dy))}px`
  })
  const endPanelDrag = (event) => {
    if (panelDrag && panelDrag.pointerId === event.pointerId) panelDrag = null
  }
  sizePanelHeader?.addEventListener('pointerup', endPanelDrag)
  sizePanelHeader?.addEventListener('pointercancel', endPanelDrag)

  sizeSlider.addEventListener('pointerdown', (event) => {
    try { sizeSlider.setPointerCapture(event.pointerId) } catch (_) {}
  })
  sizeSlider.addEventListener('pointerup', (event) => {
    try { sizeSlider.releasePointerCapture(event.pointerId) } catch (_) {}
  })
  sizeSlider.addEventListener('input', async () => {
    const percent = Number(sizeSlider.value)
    sizeValue.value = `${percent}%`
    settings.pet_size_percent = percent
    if (electronRuntime) fitModel()
    else {
      const bridge = await waitForBridge()
      await bridge.resize_window(percent)
    }
    window.clearTimeout(sizeCommitTimer)
    sizeCommitTimer = window.setTimeout(async () => {
      const bridge = await waitForBridge()
      await bridge.set_size(percent)
    }, 140)
  })

  sizeSlider.addEventListener('change', async () => {
    window.clearTimeout(sizeCommitTimer)
    const bridge = await waitForBridge()
    await bridge.set_size(Number(sizeSlider.value))
  })

  // ★ 调整不透明度（2026-10-17 复用「调整大小」面板逻辑）：
  //   header 拖动 + slider 实时设模型 alpha + 防抖写回后端。
  let opacityCommitTimer = null
  const opacityHeader = document.getElementById('opacity-panel-header')
  let opacityDrag = null
  opacityHeader?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    opacityDrag = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      left: opacityPanel.offsetLeft, top: opacityPanel.offsetTop,
    }
    try { opacityHeader.setPointerCapture(event.pointerId) } catch (_) {}
  })
  opacityHeader?.addEventListener('pointermove', (event) => {
    if (!opacityDrag || opacityDrag.pointerId !== event.pointerId) return
    const dx = event.clientX - opacityDrag.startX
    const dy = event.clientY - opacityDrag.startY
    const rect = opacityPanel.getBoundingClientRect()
    opacityPanel.style.left = `${Math.max(4, Math.min(window.innerWidth - rect.width - 4, opacityDrag.left + dx))}px`
    opacityPanel.style.top = `${Math.max(4, Math.min(window.innerHeight - rect.height - 4, opacityDrag.top + dy))}px`
  })
  const endOpacityDrag = (event) => {
    if (opacityDrag && opacityDrag.pointerId === event.pointerId) opacityDrag = null
  }
  opacityHeader?.addEventListener('pointerup', endOpacityDrag)
  opacityHeader?.addEventListener('pointercancel', endOpacityDrag)

  opacitySlider.addEventListener('pointerdown', (event) => {
    try { opacitySlider.setPointerCapture(event.pointerId) } catch (_) {}
  })
  opacitySlider.addEventListener('pointerup', (event) => {
    try { opacitySlider.releasePointerCapture(event.pointerId) } catch (_) {}
  })
  opacitySlider.addEventListener('input', () => {
    const pct = Number(opacitySlider.value)
    opacityValue.value = `${pct}%`
    settings.live2d_pet_opacity = pct
    // 实时生效：只改模型透明度，气泡/徽标/横条不受影响
    applyPetOpacity(pct)
    window.clearTimeout(opacityCommitTimer)
    opacityCommitTimer = window.setTimeout(async () => {
      try { await persistCompanionSetting('live2d_pet_opacity', pct) } catch (_) {}
    }, 200)
  })
  opacitySlider.addEventListener('change', async () => {
    window.clearTimeout(opacityCommitTimer)
    try { await persistCompanionSetting('live2d_pet_opacity', Number(opacitySlider.value)) } catch (_) {}
  })

  window.addEventListener('resize', fitModel)
  // 口型驱动事件：说话期间驱动 ParamMouthOpenY + speaking 动作。
  //
  // ⚠ DSH 专用化说明（2026-10-17）：这个事件的**原驱动方 pet-xz-audio.js 已删除**
  //   （它连 /api/xiaozhi/ws，该路由随小智插件阉割）。事件名保留 `mio-xz-speaking`
  //   是为了**向后兼容**，但现在没有任何代码会派发它 —— 属"休眠插座"：
  //   将来做 DSH 语音时，只要新通路 dispatch 同名事件即可直接复用这套口型逻辑，
  //   无需改动渲染端。若届时改成新名字，记得同步这里。
  window.addEventListener('mio-xz-speaking', (e) => {
    const detail = (e && e.detail) || {}
    if (detail.active) {
      markPetActivity()
      speakingUntil = Date.now() + Math.max(3000, Number(detail.durationMs) || 5000)
      currentActivity = 'speaking'
      // 小智说话 → 播放 speaking 动作（有则动，无则保持待机）
      const speakingMotion = semanticMotion('speaking')
      const idleMotion = semanticMotion('idle')
      if (speakingMotion && speakingMotion !== idleMotion) playMotion(speakingMotion)
    } else if (currentActivity === 'speaking') {
      speakingUntil = 0
      currentActivity = 'idle'
    }
  })
  // 小智表情联动：llm/pet_text.emotion → 桌宠表情 + 情绪动作（支持"哭一下/笑一个"等指令）
  window.addEventListener('mio-xz-emotion', (e) => {
    const emo = ((e && e.detail && e.detail.emotion) || '').toLowerCase()
    if (emo) {
      applyEmotion(emo, 6000)
      const hint = EMOTION_MOTION_HINT[emo]
      if (hint) {
        const group = semanticMotion(hint)
        const idleGroup = semanticMotion('idle')
        if (group && group !== idleGroup) playMotion(group, undefined, { force: true })
      }
    }
  })
  // 小智语音真实口型：pet-xz-audio.js 音频能量分析高频派发 → 优先驱动 ParamMouthOpenY
  window.addEventListener('mio-xz-mouth', (e) => {
    const lv = Number((e && e.detail && e.detail.level) || 0)
    if (lv >= 0) { xzMouthAt = Date.now(); xzMouthLevel = Math.min(1, lv) }
  })
  window.addEventListener('beforeunload', () => {
    stopSpeech('')
    if (socket) socket.close()
  })

  async function start() {
    createApplication()
    await waitForBridge()
    if (electronRuntime) {
      desktopState = await window.mioDesktop.getState()
      mergeImportedModels(desktopState)
      window.mioDesktop.onModelsChanged(async (payload) => {
        mergeImportedModels(payload)
        // ★ 真实 Electron 时序：selectModel 的广播先于 switchModel 的 invoke 回包到达，
        //   此刻 settings.live2d_model_id 还是旧值 ⇒ selectedModelId() 返回旧目标。
        //   若用户切换在飞（<3s），跳过这次加载 —— switchModel 自己会加载正确目标，
        //   否则会先闪一下旧模型（"切换后快速变回原形象"的视觉来源之一）。
        if (modelSwitchTarget && Date.now() - modelSwitchAt < 3000) return
        await loadModel(selectedModelId())
      })
      window.mioDesktop.onClickThroughChanged(async (enabled) => {
        await setClickThroughLocked(enabled, true)
      })
      // Electron 穿透模式下渲染层收不到 mousemove：主进程高频推送全局鼠标位置，
      // 渲染层喂给 pixi-live2d 的视线聚焦。关键：把鼠标坐标压缩到模型周围区域再
      // focus——否则全屏坐标会映射成大幅转头/点头，看起来像"多动症"。
      window.mioDesktop.onMouseMove((pos) => {
        if (!settings.live2d_follow_cursor || !model) return
        const x = Number(pos?.x)
        const y = Number(pos?.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return
        const cx = model.x + model.width / 2
        const cy = model.y + model.height / 2
        const rangeX = Math.max(320, model.width * 1.1)
        const rangeY = Math.max(260, model.height * 1.3)
        const fx = Math.max(cx - rangeX, Math.min(cx + rangeX, x))
        const fy = Math.max(cy - rangeY, Math.min(cy + rangeY, y))
        model.focus(fx, fy)
      })
      // 窗口虚拟边界修正完成：用最终坐标系定位并显示模型（启动不跳位）
      window.mioDesktop.onWindowStable(() => {
        windowStable = true
        loading.hidden = true
        if (model) {
          model.visible = true
          fitModel()
          updateAgentBadgePosition(true)
        }
      })
      // 兜底：若窗口稳定事件早于本脚本注册而丢失，10 秒后仍用最终坐标系显示模型
      setTimeout(() => {
        if (!windowStable) {
          windowStable = true
          if (model) {
            model.visible = true
            fitModel()
            updateAgentBadgePosition(true)
          }
          loading.hidden = true
        }
      }, 10000)
      connectSocket()
    }
    await pollStatus()
    await pollFeed()
    setInterval(pollStatus, electronRuntime ? 5000 : 1800)
    if (!electronRuntime) setInterval(pollFeed, 900)
    setInterval(trackCursor, 80)
    setInterval(idleTick, 1000)
    // A 档：启动空闲自语排期（设置已由上面的 pollStatus 加载完成）
    scheduleIdleTalk()
    // A7：初始化角色图库（数据在首次打开时才拉，不占用启动时间）
    initGallery()
    // A组：随机图片（点击互动素材池）+ 气泡皮肤（配置在 Mio「泡泡」页，settings 下发热应用）
    try {
      window.__mioPetRandomImage && window.__mioPetRandomImage.mount(root)
      window.__mioPetBubbleStyles && window.__mioPetBubbleStyles.apply(speechBubble)
      // 音效片段列表预热（自定义片段播放前先拿到 URL/版本，避免首播延迟）
      window.__mioPetSound && window.__mioPetSound.refreshClips()
    } catch (_) {}
  }

  window.__mioPetDebug = {
    // A组 模块化泡泡系统需要的数据锚点：桌宠头顶坐标（图片泡泡/模块卡片落位）
    __anchor: () => {
      if (!model) return null
      return { x: model.x, y: model.y - model.height / 2 - 24 }
    },
    speak: (payload) => dispatchSpeech({
      source: 'runtime_verification',
      should_speak: true,
      priority: 100,
      ...(payload || {}),
    }),
    stopSpeech: (reason = 'interrupted') => stopSpeech(reason),
    resetSpeechDiagnostics: () => {
      if (speechInProgress()) return false
      speechStartCount = 0
      speechEndCount = 0
      speechInterruptCount = 0
      speechFinishedCount = 0
      speechQueuedCount = 0
      speechDroppedCount = 0
      speechRequestCount = 0
      speechFailureCount = 0
      speechLifecycleHistory = []
      lastSpeechError = ''
      return true
    },
    visualEvent: (payload = {}) => handleVisualEvent({
      emotion: 'gentle',
      importance: 0.7,
      motion_hint: 'observe',
      ...(payload || {}),
    }),
    proceduralMotion: (hint = 'observe', importance = 0.7) => (
      startProceduralMotion(hint, importance)
    ),
    resetVisualDiagnostics: () => {
      visualFrameTimes = []
      visualFpsSamples = []
      visualFrameWindowStartedAt = performance.now()
      visualFrameWindowCount = 0
      visualPerformanceUntil = 0
      rendererLastFrameAt = performance.now()
      proceduralMotionHint = ''
      proceduralMotionStartedAt = 0
      proceduralMotionUntil = 0
      proceduralMotionIntensity = 0
      if (String(lastMotionGroup).startsWith('procedural:')) {
        lastMotionGroup = ''
        lastMotionPlayedAt = 0
      }
      proceduralMotionStartCount = 0
      proceduralMotionPeak = 0
      return true
    },
    snapshot: (options = {}) => {
      const bounds = model?.getBounds?.()
      let alphaPixels = 0
      let sampledPixels = 0
      if (options?.includePixels) {
        try {
          const pixels = model && app?.renderer?.extract?.pixels(model)
          if (pixels) {
            const stride = Math.max(4, Math.floor(pixels.length / 40000 / 4) * 4)
            for (let index = 3; index < pixels.length; index += stride) {
              sampledPixels += 1
              if (pixels[index] > 8) alphaPixels += 1
            }
          }
        } catch (_) {}
      }
      return {
        electronRuntime,
        modelLoaded: Boolean(model),
        currentModelId,
        socketState: socket?.readyState ?? -1,
        activity: currentActivity,
        emotion: currentEmotion,
        audioPlaying: Boolean((currentAudio && !currentAudio.paused) || streamPlaybackActive),
        speechInProgress: speechInProgress(),
        mouthLevel: Number(mouthLevel.toFixed(4)),
        speechStartCount,
        speechEndCount,
        speechInterruptCount,
        speechFinishedCount,
        speechQueuedCount,
        speechDroppedCount,
        speechRequestCount,
        speechFailureCount,
        speechLifecycleHistory: speechLifecycleHistory.map((item) => ({
          ...item,
          events: item.events.map((event) => ({ ...event })),
          playbackMetrics: item.playbackMetrics ? { ...item.playbackMetrics } : undefined,
        })),
        lastSpeechError,
        maxMouthLevel: Number(maxMouthLevel.toFixed(4)),
        lastSpeechStartedAt,
        lastSpeechEndedAt,
        lastVoiceEventSent,
        lastStreamMode,
        streamFirstAudioLatencyMs,
        streamQueuedSources: streamSources.size,
        streamBufferSeconds: Number(streamPendingDuration.toFixed(3)),
        streamPlaybackUntil: streamScheduledUntil,
        rendererFps: Number(rendererMeasuredFps.toFixed(1)),
        activeResponseId,
        activeSpeechPriority,
        speechQueueLength: speechQueue.length,
        clickThroughLocked: clickThroughLocked(),
        speechBubbleEnabled: settings.live2d_speech_bubble_enabled !== false,
        speechBubbleVisible: !speechBubble.hidden,
        speechBubbleProgress: `${speechBubbleVisibleCount}/${speechBubbleCharacterCount}`,
        capabilities: currentCapabilityPayload(),
        renderOptimization: modelDefinition(currentModelId)?.renderOptimization || {},
        lastVisualEvent,
        lastForegroundTitle,
        proceduralMotion: {
          active: Boolean(proceduralMotionHint && Date.now() < proceduralMotionUntil),
          hint: proceduralMotionHint,
          startCount: proceduralMotionStartCount,
          peak: Number(proceduralMotionPeak.toFixed(2)),
        },
        visualPerformance: visualPerformanceSnapshot(),
        renderer: rendererDiagnostics(),
        modelBounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
        alphaPixels,
        sampledPixels,
        errorVisible: !errorPanel.hidden,
        errorMessage: errorMessage.textContent,
      }
    },
  }

  // A组 模块化泡泡系统 / 随机图片的宿主注入点：
  //   __mioPetAnchor         桌宠头顶坐标（模块卡片与图片泡泡落位）
  //   __mioPetStatusSnapshot 总线状态摘要（status 模块内容，空串=都在休息）
  window.__mioPetAnchor = () => (window.__mioPetDebug.__anchor ? window.__mioPetDebug.__anchor() : null)
  window.__mioPetStatusSnapshot = () => {
    if (!anyAgentBusy()) return ''
    const parts = []
    agentBadgeStates.forEach((st, id) => {
      if (!st || st.enabled === false || st.status === 'offline') return
      const p = String(st.phase || '')
      if (!p || p === 'idle' || p === 'heartbeat' || p === 'complete') return
      parts.push(`${st.name || id}·${PHASE_LABELS[p] || p}`)
    })
    return parts.join(' / ')
  }

  // 核心气泡 API：**插件访问说话气泡的唯一入口**（插件不得直接操作 DOM——
  // 否则核心 UI 的显隐/皮肤/定位会被插件绕过，形成"关掉插件泡泡就没了"的隐性依赖）。
  window.__mioPetBubble = {
    show: (text, opts) => {
      const o = opts || {}
      return showSpeechBubble(
        text,
        Number(o.durationMs ?? o.duration_ms) || 0,
        String(o.responseId || o.response_id || ''),
        String(o.agentId || o.agent_id || ''),
        String(o.accent || ''),
      )
    },
    hide: () => hideSpeechBubble(),
    isVisible: () => !speechBubble.hidden,
    setEnabled: (on) => { settings.live2d_speech_bubble_enabled = on !== false },
  }

  // ---------------------------------------------------------------------------
  // 7.6 横条（DSH 流式提示专用窗位）—— 主体侧实现
  // ---------------------------------------------------------------------------
  // 契约以 packages/mao-pet/lib/strip.js 头部 docstring 为准（**签名不得改**）。
  //
  // 为什么要这条通道：横条是**核心 UI 的第二个窗位**。按 §3.5 的教训，
  // 插件只能经 `window.__mioPet*` 访问核心 UI，**不得直接改 DOM**——
  // 否则"关掉某个插件横条就没了"会在任何一次插件重构后复发。
  // 文档（项目接管执行方案 §18）也是这么预设的："横条组件若需主体暴露，
  // 走 window.__mioPet* 通道，与 __mioPetBubble 同一模式。"
  //
  // 职责分界（与插件层刻意分工，别把状态放错边）：
  //   - **主体**（这里）：横条 DOM、**拖动位置**、**关闭态**、主题类应用 → 跨会话持久；
  //   - **插件**：何时推内容、何时抑制 → 会话内。插件热重载不该丢掉用户拖好的位置。
  //
  // 铁律：**任何方法都不得抛异常**（外部调用方是第三方插件，抛异常会把它们带崩）。
  // 所有实现体一律内部 try/catch 并返回安全值。
  window.__mioPetStrip = (function () {
    const KEY_STYLE = 'live2d_strip_style'
    const KEY_POS = 'mio-pet-strip-pos'
    const KEY_DISMISSED = 'mio-pet-strip-dismissed'

    const el = document.getElementById('pet-strip')
    const textEl = document.getElementById('pet-strip-text')
    const closeBtn = document.getElementById('pet-strip-close')
    const grips = el ? Array.from(el.querySelectorAll('[data-strip-grip]')) : []

    // ── 宽度持久化：用户拉伸过就记下来（跨会话保留），没拉伸过则按内容自适应 ──
    // ★ 用户裁决（2026-10-17）：**不设上限，任意拉长**。只保留一个小宽度下限，
    //   防止拉没了看不见；上限交给屏幕实际宽度（CSS max-width: 96vw 兜底）。
    const KEY_WIDTH = 'mio-pet-strip-width'
    const MIN_W = 150
    function clampWidth(px) {
      const maxW = Math.max(MIN_W, Math.floor(window.innerWidth * 0.96))
      return Math.max(MIN_W, Math.min(maxW, Math.round(px)))
    }
    function applyWidth(px) {
      if (!el) return
      const w = clampWidth(px)
      el.style.width = `${w}px`
      el.style.maxWidth = 'none'   // 显式宽度优先，避免被 max-width 再夹一次
      el.classList.add('resized')
    }
    // ★ 行数（个性化，2026-10-17 最终）：N = **可见窗口的固定行数**。
    //   文字按限制宽度正常换行、往下一直递增到结束；超出 N 行的部分
    //   由 textEl 的 overflow-y:auto 承载，右侧竖条滚动条浏览历史，
    //   新流式消息 append 后自动滚到底（最新在最下）。
    function applyRows(n) {
      if (!el) return
      const r = Math.max(1, Math.min(5, Math.round(Number(n) || 1)))
      // 横条本体固定 N 行高（文字容器自己滚动）
      el.style.height = `${r * 1.45 + 0.7}em`
      el.style.maxHeight = 'none'
      if (textEl) {
        textEl.style.height = `${r * 1.4}em`
        textEl.style.maxHeight = `${r * 1.4}em`
        textEl.style.overflowY = 'auto'   // 超出可滚动，右侧竖条
        textEl.style.overflowX = 'hidden'
      }
    }
    // 启动时**不再**从 localStorage 套用旧的手动拉伸值（2026-10-17 终版语义）：
    // 宽度由「设置页默认宽度 >0 → 固定；否则 CSS 默认 420px」决定，文字在框内换行。
    // 用户手动拉伸只在拖动会话内生效（临时），避免旧的疯长宽度一直残留。

    // 主题：与泡泡皮肤同一套 id（default/mono/navy/…），类名用 strip-style-*
    let styleId = 'default'
    let enabled = true
    let visible = false
    // ★ 个性化默认值（2026-10-17 用户需求）：默认宽度(px，0=自适应) + 默认行数(1-5)。
    //   来自后端 settings（live2d_strip_width/rows），设置页改、settings_changed 热应用。
    //   手动拉伸仍是临时覆盖（写 localStorage mio-pet-strip-width），但"默认值"优先。
    let defaultWidth = 0
    let rows = 1
    // 关闭态**跨会话持久**（localStorage）：用户 ✕ 掉之后不该下次启动又冒出来。
    // 注意与插件侧的"本会话抑制"是两层：这里是"用户已拒绝这个窗位"的长期记忆。
    let dismissed = false
    let hideTimer = null
    let buffer = ''

    function safe(fn, fallback) {
      try { return fn() } catch (_) { return fallback }
    }

    function readBool(key) {
      return safe(() => window.localStorage.getItem(key) === '1', false)
    }
    function writeBool(key, value) {
      safe(() => window.localStorage.setItem(key, value ? '1' : '0'))
    }

    dismissed = readBool(KEY_DISMISSED)
    safe(() => {
      const saved = window.localStorage.getItem(KEY_STYLE)
      if (saved) styleId = saved
    })
    // 拖动位置持久（主体拥有位置状态，插件热重载不受影响）
    safe(() => {
      const raw = window.localStorage.getItem(KEY_POS)
      if (!raw) return
      const pos = JSON.parse(raw)
      if (Number.isFinite(pos?.left) && Number.isFinite(pos?.top)) {
        el.style.left = `${pos.left}px`
        el.style.top = `${pos.top}px`
        el.style.right = 'auto'
        el.style.bottom = 'auto'
      }
    })

    function applyStyle(id) {
      const wanted = String(id || '').trim() || 'default'
      // 清掉既有 strip 皮肤类再挂新的（与 pet-bubble-styles.js 的 apply 同机制）
      Array.from(el.classList)
        .filter((c) => c.indexOf('strip-style-') === 0)
        .forEach((c) => el.classList.remove(c))
      if (wanted !== 'default') el.classList.add(`strip-style-${wanted}`)
      styleId = wanted
      safe(() => window.localStorage.setItem(KEY_STYLE, wanted))
      return styleId
    }

    function doHide() {
      visible = false
      el.hidden = true
      window.clearTimeout(hideTimer)
      hideTimer = null
      buffer = ''
      if (textEl) textEl.innerHTML = ''
      // 横条收起 ⇒ 先撤销命中区（鼠标策略立刻回到"仅模型区域可交互"），
      // 再交还交互权。不撤销的话主进程还按旧矩形放行一个空区域的命中。
      reportStripBounds()
      try { updateMousePassThrough(true) } catch (_) { setInteractive(false) }
    }

    function scheduleHide(durationMs) {
      window.clearTimeout(hideTimer)
      hideTimer = null
      const ms = Number(durationMs) || 0
      if (ms > 0) hideTimer = window.setTimeout(doHide, Math.max(600, ms))
    }

    // ★ 横条 Markdown 渲染（2026-10-17 用户反馈：`#`、`**` 原样显示）：
    //   极简、安全的一套——先整体 HTML 转义（杜绝注入），再依次处理
    //   代码围栏 ``` / 行内代码 ` / **粗体** / 行首标题 #。
    //   刻意不做：斜体 *x*（会误伤 3*4 这类算式）、链接、图片、列表。
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c])
    }
    function renderStripText(raw) {
      let s = escapeHtml(raw)
      // 先处理围栏代码块 ```...```（跨行），再处理行内 `` `...` ``（单段）
      s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<code>${code.replace(/^\n+|\n+$/g, '')}</code>`)
      s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
      // 粗体 **x**（与代码块互斥：代码段内的 ** 已被包进 <code>，
      // 但 <code> 内部文本仍可能被下面的粗体正则命中 —— 用占位符保护代码段）
      const codeSlots = []
      s = s.replace(/<code>[\s\S]*?<\/code>/g, (m) => {
        codeSlots.push(m)
        return `\u0000${codeSlots.length - 1}\u0000`
      })
      s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      // 行首标题 # / ## / ### → 粗体（横条里没有标题层级语义）
      s = s.replace(/(^|\n)#{1,6}\s+([^\n]+)/g, (_, nl, t) => `${nl}<strong>${t}</strong>`)
      // 还原代码段
      s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codeSlots[Number(i)] ?? '')
      return s
    }

    // ★ 横条命中区上报（2026-10-17 用户裁决）：横条是全屏透明窗口里的一个小元素。
    //   踩坑记录：第一版在横条可见时 setInteractive(true) —— interactive 是**整个窗口**
    //   级别的开关，结果横条显示期间桌宠窗口后面的整块屏幕（如 B 站视频）全被这层
    //   透明窗口挡住。正确做法是照抄 modelBounds 的**区域命中**机制：把横条的矩形
    //   上报给主进程（mio-desktop:strip-bounds），主进程只在鼠标落进这一小块时才
    //   关穿透 —— 横条随时可拖/可拉伸/可点✕，其余画面完全不受影响。
    function reportStripBounds() {
      if (!window.mioDesktop || typeof window.mioDesktop.setStripBounds !== 'function') return
      if (!visible || el.hidden) {
        window.mioDesktop.setStripBounds(null)
        return
      }
      const r = el.getBoundingClientRect()
      window.mioDesktop.setStripBounds({
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.ceil(r.width), height: Math.ceil(r.height),
      })
    }

    function render() {
      if (textEl) {
        // 用 innerHTML 才能让 <code> 生效；renderStripText 已整体转义，安全。
        textEl.innerHTML = renderStripText(buffer)
        // ★ 自动滚到底（2026-10-17）：新流式消息追加到最底部，最新在最下；
        //   超出可见行数的历史往上滚、由右侧竖条浏览。滚动要在 innerHTML 之后、
        //   且需要浏览器先排版，故下一帧再滚（否则 scrollHeight 还是旧值）。
        window.requestAnimationFrame(() => {
          if (textEl) textEl.scrollTop = textEl.scrollHeight
        })
      }
      el.hidden = false
      visible = true
      // ★ 宽度语义（终版）：设置页默认宽 >0 → 固定它；=0 → 清掉 inline 宽度，
      //   回 CSS 默认 420px（否则之前拉伸残留的 style.width 会一直占着）。
      if (defaultWidth > 0) applyWidth(defaultWidth)
      else safe(() => { el.style.width = ''; el.style.maxWidth = '' })
      if (rows > 0) applyRows(rows)
      // 横条可见 ⇒ 上报命中区（主进程按区域关穿透）。
      reportStripBounds()
    }

    /** 统一的"能不能显示"判定：禁用 / 用户已关 / 气泡总开关关闭 时都拒绝。 */
    function canShow() {
      if (!enabled) return false
      if (dismissed) return false
      return true
    }

    // 拖动：pointer 事件（与桌宠窗口拖动同一套思路，但作用在横条自身）
    safe(() => {
      let dragging = false
      let startX = 0
      let startY = 0
      let originLeft = 0
      let originTop = 0

      el.addEventListener('pointerdown', (ev) => {
        if (ev.target === closeBtn) return
        dragging = true
        const rect = el.getBoundingClientRect()
        originLeft = rect.left
        originTop = rect.top
        startX = ev.clientX
        startY = ev.clientY
        el.classList.add('dragging')
        safe(() => el.setPointerCapture(ev.pointerId))
      })

      el.addEventListener('pointermove', (ev) => {
        if (!dragging) return
        const left = originLeft + (ev.clientX - startX)
        const top = originTop + (ev.clientY - startY)
        el.style.left = `${left}px`
        el.style.top = `${top}px`
        el.style.right = 'auto'
        el.style.bottom = 'auto'
        // 拖动中矩形在变：同步命中区，否则鼠标策略按旧矩形放行
        reportStripBounds()
      })

      function endDrag(ev) {
        if (!dragging) return
        dragging = false
        el.classList.remove('dragging')
        safe(() => el.releasePointerCapture(ev.pointerId))
        const rect = el.getBoundingClientRect()
        safe(() => window.localStorage.setItem(
          KEY_POS, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }),
        ))
      }
      el.addEventListener('pointerup', endDrag)
      el.addEventListener('pointercancel', endDrag)
    })

    // ── 左右拉伸：用户要求"流式气泡的左右大小应该可手动拉伸"（2026-10-17）──
    //  两个贴边窄手柄各自独立拖：拖左手柄改左边位置+反算宽度，拖右手柄只改宽度。
    //  用 pointer capture 保证拖出手柄外仍跟手。
    //  ★ 终版语义：拉伸宽度是**本会话临时值**，不再写 localStorage 持久化——
    //    固定宽度交给设置页「默认宽度」（跨会话）；否则用 CSS 默认 420px 换行。
    safe(() => {
      grips.forEach((grip) => {
        const side = grip.getAttribute('data-strip-grip')
        grip.addEventListener('pointerdown', (ev) => {
          ev.preventDefault()
          ev.stopPropagation()   // 别触发横条整体拖动
          const rect = el.getBoundingClientRect()
          const startX = ev.clientX
          const startW = rect.width
          const startLeft = rect.left
          el.classList.add('resizing')
          safe(() => grip.setPointerCapture(ev.pointerId))

          function onMove(e2) {
            const dx = e2.clientX - startX
            if (side === 'right') {
              applyWidth(startW + dx)
            } else {
              // 左侧：宽度反向变化，同时左边缘跟着移动
              const w = clampWidth(startW - dx)
              applyWidth(w)
              el.style.left = `${startLeft + (startW - w)}px`
              el.style.right = 'auto'
            }
            // 宽度变了：退出滚动字幕态（下一帧 render 会重算是否溢出）
            el.classList.remove('marquee')
            // 拉伸中矩形在变：同步命中区
            reportStripBounds()
          }
          function onUp(e2) {
            el.classList.remove('resizing')
            safe(() => grip.releasePointerCapture(e2.pointerId))
            grip.removeEventListener('pointermove', onMove)
            grip.removeEventListener('pointerup', onUp)
            grip.removeEventListener('pointercancel', onUp)
            // ★ 双向同步（2026-10-17 用户要求）：手动拉伸的宽度**回写后端 settings**
            //   （live2d_strip_width = 默认宽度）。这样设置页「横条」tab 读到的
            //   永远是横条的实时宽度；反向（设置页改 → settings_changed →
            //   setDefaultWidth → 横条立即变宽）也已打通。回写走
            //   persistCompanionSetting（外层函数，函数声明提升可用）。
            //   注意：settings_changed 回来时值与本地已一致（幂等），不会回环。
            safe(() => {
              const w = Math.round(el.getBoundingClientRect().width)
              const px = clampWidth(w)
              void persistCompanionSetting('live2d_strip_width', px)
            })
          }
          grip.addEventListener('pointermove', onMove)
          grip.addEventListener('pointerup', onUp)
          grip.addEventListener('pointercancel', onUp)
        })
      })
    })

    // ✕：用户关闭 → 记住"已拒绝"（跨会话），并立刻隐藏
    /** ✕ 与右键菜单"隐藏横条"共用的关闭语义（只此一处，避免两条路不一致）。 */
    function dismiss() {
      dismissed = true
      writeBool(KEY_DISMISSED, true)
      doHide()
    }

    safe(() => {
      if (!closeBtn) return
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        dismiss()
      })
    })

    applyStyle(styleId)

    return {
      show(text, opts) {
        return safe(() => {
          if (!canShow()) return false
          const o = opts || {}
          buffer = String(text == null ? '' : text)
          render()
          if (o.sticky) scheduleHide(0)
          else scheduleHide(o.durationMs == null ? 5000 : o.durationMs)
          return true
        }, false)
      },
      append(token, _opts) {
        return safe(() => {
          if (!canShow()) return false
          buffer += String(token == null ? '' : token)
          render()
          scheduleHide(0)
          return true
        }, false)
      },
      hide() { safe(doHide) },
      isVisible() { return safe(() => visible && !el.hidden, false) },
      isDismissed() { return safe(() => dismissed, false) },
      setEnabled(on) {
        safe(() => {
          enabled = on !== false
          if (!enabled) doHide()
        })
      },
      applyStyle(id) { return safe(() => applyStyle(id), styleId) },
      // ★ 个性化默认值（2026-10-17 设置页热应用）：
      setDefaultWidth(px) {
        safe(() => {
          defaultWidth = Math.max(0, Math.round(Number(px) || 0))
          if (visible) {
            // 已显示：立即套用（默认宽>0 时覆盖手动值）
            if (defaultWidth > 0) applyWidth(defaultWidth)
            reportStripBounds()
          }
        })
      },
      setRows(n) {
        safe(() => {
          rows = Math.max(1, Math.min(5, Math.round(Number(n) || 1)))
          if (visible) { applyRows(rows); reportStripBounds() }
        })
      },
      info() {
        return safe(() => ({
          visible: visible && !el.hidden,
          dismissed,
          enabled,
          styleId,
          defaultWidth,
          rows,
        }), { visible: false, dismissed: false, enabled: false, styleId: 'default', defaultWidth: 0, rows: 1 })
      },
      // 非契约内的主体内部接口：供设置页"重新启用横条"用（清掉"已拒绝"记忆）
      resetDismissed() {
        safe(() => {
          dismissed = false
          writeBool(KEY_DISMISSED, false)
        })
      },
      // 非契约内的主体内部接口：供右键菜单"隐藏横条"用。
      // 复用 dismiss()（与点 ✕ 同一处实现），保证菜单与 ✕ 语义**完全一致**。
      markDismissed() {
        safe(dismiss)
      },
    }
  })()

  start().catch((error) => {
    loading.hidden = true
    errorPanel.hidden = false
    errorMessage.textContent = String(error?.message || error || '初始化失败')
    sendSocket('renderer_error', { message: errorMessage.textContent })
    setInteractive(true)
  })
})()


