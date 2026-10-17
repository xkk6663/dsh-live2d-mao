/* pet-chat-bar.js — 桌宠对话横条（DSH 专用化重写版）
 *
 * ════════════════════════════════════════════════════════════════════════
 * 这个文件原来是 xiaozhi-chat.js（小智快速对话横条），只认小智协议：
 *   /api/xiaozhi/say   （官方语音通道注入）
 *   /api/xiaozhi/vision（小智官方云视觉）
 *   /api/xiaozhi/ws?role=chat（hello/tts/llm 小智专有事件）
 * 小智插件已随 DSH 专用化整体阉割，上述接口全部不存在，故整体重写为
 * **桌宠自己的对话通路**：
 *
 *   发送：POST /api/companion/chat  { message, images, client_request_id }
 *   回答：由后端经 WS 广播回桌宠窗口（agent_bubble / speak 等既有通路），
 *         本横条只负责"输入 + 状态提示"，**不自己渲染回答**（回答显示在桌宠气泡/横条里）。
 *
 * UI 与交互保持原样（胶囊横条：状态点 + 输入框 + 发图 + 发送 + 关闭），
 * 因为用户认可这条横条的形态；只把后端契约换成 DSH 专用化后的那一套。
 * ════════════════════════════════════════════════════════════════════════
 */
;(function () {
  var statusDot = document.getElementById('statusDot')
  var inputEl = document.getElementById('input')
  var sendBtn = document.getElementById('sendBtn')
  var closeBtn = document.getElementById('closeBtn')
  var imgBtn = document.getElementById('imgBtn')
  var fileInput = document.getElementById('fileInput')
  var hintEl = document.getElementById('hint')

  var busy = false

  function setStatus(state) {
    if (!statusDot) return
    statusDot.className = 'dot' + (state === 'connected' ? '' : ' ' + state)
  }
  function setHint(text, sticky) {
    if (!hintEl) return
    hintEl.textContent = text || ''
    if (!sticky) window.setTimeout(function () { if (hintEl.textContent === text) hintEl.textContent = '' }, 4000)
  }
  function setBusy(on) {
    busy = on
    if (sendBtn) sendBtn.disabled = on || !String(inputEl.value || '').trim()
  }

  // 就绪探测：桌宠后端在 = 可用。用 /api/companion/agents（纯读总线，稳定，
  // 不依赖 Live2D 资源与磁盘写入 —— 与 start_mio.ps1 的健康检查同一口径）。
  function probe() {
    setStatus('connecting')
    fetch('/api/companion/agents', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json() })
      .then(function () { setStatus('connected') })
      .catch(function () {
        setStatus('offline')
        window.setTimeout(probe, 3000)
      })
  }

  function clientRequestId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
    } catch (e) {}
    return 'req-' + Date.now() + '-' + Math.random().toString(16).slice(2)
  }

  function sendText() {
    var text = String(inputEl.value || '').trim()
    if (!text || busy) return
    inputEl.value = ''
    setBusy(true)
    setHint('正在发送…', true)
    fetch('/api/companion/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, images: [], client_request_id: clientRequestId() }),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        setBusy(false)
        if (j && j.ok === false) setHint('⚠ 发送失败：' + (j.detail || '未知错误'), true)
        else setHint('已发送，回答会显示在桌宠旁')
      })
      .catch(function () {
        setBusy(false)
        setHint('⚠ 网络错误，发送失败', true)
      })
  }

  function sendImage(file) {
    if (!file) return
    if (!/^image\//.test(file.type)) { setHint('⚠ 仅支持图片文件'); return }
    if (file.size > 4 * 1024 * 1024) { setHint('⚠ 图片过大（>4MB），请压缩后重试'); return }
    var reader = new FileReader()
    reader.onload = function () {
      var dataUrl = String(reader.result || '')
      var base64 = dataUrl.split(',')[1] || ''
      if (!base64) { setHint('⚠ 读取图片失败'); return }
      setBusy(true)
      setHint('正在发送图片…', true)
      // 图片随对话一起发给桌宠后端（与 usePetCall.sendPetChat 同一契约）
      fetch('/api/companion/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: String(inputEl.value || '').trim(),
          images: [base64],
          client_request_id: clientRequestId(),
        }),
      })
        .then(function (r) { return r.json() })
        .then(function (j) {
          setBusy(false)
          inputEl.value = ''
          if (j && j.ok === false) setHint('⚠ 图片发送失败：' + (j.detail || '未知错误'), true)
          else setHint('已发送图片，结果会显示在桌宠旁')
        })
        .catch(function () {
          setBusy(false)
          setHint('⚠ 网络错误，图片发送失败', true)
        })
    }
    reader.onerror = function () { setHint('⚠ 读取图片失败') }
    reader.readAsDataURL(file)
  }

  // ---------- 事件绑定 ----------
  if (inputEl) {
    inputEl.addEventListener('input', function () {
      if (sendBtn) sendBtn.disabled = busy || !String(inputEl.value || '').trim()
    })
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() }
      if (e.key === 'Escape') window.close()
    })
    // 拖入图片
    inputEl.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items
      if (!items) return
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          var f = items[i].getAsFile()
          if (f) { e.preventDefault(); sendImage(f); return }
        }
      }
    })
  }
  if (sendBtn) sendBtn.addEventListener('click', sendText)
  if (closeBtn) closeBtn.addEventListener('click', function () {
    if (window.mioDesktop && typeof window.mioDesktop.toggleChatWindow === 'function') {
      window.mioDesktop.toggleChatWindow()
    } else {
      window.close()
    }
  })
  if (imgBtn && fileInput) {
    imgBtn.addEventListener('click', function () { fileInput.click() })
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0]
      fileInput.value = ''
      sendImage(f)
    })
  }

  probe()
})()
