/**
 * 退出桌宠 → 连带关闭后端 的端到端测试。
 *
 * 复刻 live2d-desktop/main.js 里 shutdownBackend() 的完整判定链：
 *   ① backendStillListening() 探测
 *   ② POST /api/runtime/self-shutdown 请求优雅退出
 *   ③ 轮询确认真的退出了
 *   ④ 未退出 → killBackendByPort() 精确兜底（端口 + 命令行双条件）
 *
 * 用法：node tools/test_quit_backend.cjs [--skip-graceful]
 *   --skip-graceful  跳过 ②（模拟自关闭端点不可用），直接验证 ④ 兜底路径
 */
const http = require('http')
const { execFileSync } = require('child_process')

const SKIP_GRACEFUL = process.argv.includes('--skip-graceful')
const PORT = 8000
const HOST = '127.0.0.1'

const say = (tag, msg) => console.log(`[${tag}] ${msg}`)

function backendStillListening() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: '/api/runtime/policies', method: 'GET', timeout: 700 },
      (res) => { res.resume(); resolve(true) },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

function askBackendShutdown() {
  return new Promise((resolve) => {
    const body = '{}'
    const req = http.request(
      `http://${HOST}:${PORT}/api/runtime/self-shutdown`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 1500,
      },
      (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300) },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.write(body)
    req.end()
  })
}

function listeningPids() {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique`],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
  )
  return String(out).split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
}

function cmdlineOf(pid) {
  try {
    return String(execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    ) || '')
  } catch { return '' }
}

function killBackendByPort() {
  const pids = listeningPids()
  say('fallback', `监听 ${PORT} 的 pid: ${pids.join(', ') || '(无)'}`)
  let killed = 0
  for (const pid of pids) {
    const cmd = cmdlineOf(pid)
    if (!/uvicorn/i.test(cmd) || !/app\.main:app/i.test(cmd)) {
      say('fallback', `pid=${pid} 命令行不匹配（不是本项目后端），跳过`)
      continue
    }
    try { process.kill(pid, 'SIGTERM'); killed += 1; say('fallback', `已 SIGTERM pid=${pid}`) } catch (e) {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true }); killed += 1; say('fallback', `已 taskkill pid=${pid}`) } catch (_) {}
    }
  }
  return killed
}

async function main() {
  const before = await backendStillListening()
  say('probe', `后端在跑: ${before}`)
  if (!before) { say('FATAL', '后端没在跑，先启动它再测'); process.exit(1) }

  const pidsBefore = listeningPids()
  say('probe', `后端 pid: ${pidsBefore.join(', ')}`)

  if (!SKIP_GRACEFUL) {
    const accepted = await askBackendShutdown()
    say('graceful', `POST /api/runtime/self-shutdown → ${accepted ? '已受理' : '失败/不��用'}`)
  } else {
    say('graceful', '已跳过（--skip-graceful）')
  }

  let exited = false
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 200))
    if (!(await backendStillListening())) { exited = true; say('graceful', `后端已退出（约 ${((i + 1) * 0.2).toFixed(1)}s）`); break }
  }

  if (!exited) {
    say('graceful', '后端仍在监听 → 走兜底精确清理')
    const killed = killBackendByPort()
    say('fallback', `清理了 ${killed} 个进程`)
    await new Promise((r) => setTimeout(r, 400))
    exited = !(await backendStillListening())
  }

  const left = listeningPids()
  say('final', `端口 ${PORT} 仍在监听的 pid: ${left.join(', ') || '(无)'}`)
  if (exited && left.length === 0) {
    say('PASS', '退出后端口已完全释放，不会再阻塞 DSH 换端口')
    return 0
  }
  say('FAIL', '后端/端口仍残留')
  return 1
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1) })
