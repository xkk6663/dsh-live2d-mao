"""系统音频频谱服务：把 worker 推送的能量转发给桌宠渲染端。

架构（和 system_audio_service 一致的"常驻子进程 + 逐行 NDJSON"模式）：

    后端 (本模块)  ──spawn──▶  tools/audio_spectrum_worker.py
         ▲                          │  stdout: {"type":"bands", low,mid,high,...}
         │                          ▼
         └──── WebSocket ────▶  桌宠渲染端（驱动 Live2D 参数）

为什么单独一个模块而不塞进 system_audio_service：
  那个服务负责"语音转写"（faster-whisper + 6 秒窗），重且慢；
  这里要的是 30fps 的轻量频谱，两者生命周期、开关、资源占用都不同。
  混在一起会导致"想关转写却把摆动也关了"。

★ 设计要点（都是踩坑后确定的）：
  1. **绝不阻塞**：worker 在独立进程，读线程只做"取行→解析→publish"，不做计算；
  2. **断了自动重启**：worker 崩溃/设备切换 → 退避后重启，不能让桌宠"动一下就不动了"；
  3. **开关即时生效**：set_enabled(False) 立刻 kill 子进程，不残留；
  4. **状态可查**：status() 给出 running / device / 最近错误 / 当前能量，
     排障时直接看 /api/companion/renderer 就够了。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

_lock = threading.RLock()
_process: subprocess.Popen[str] | None = None
_reader: threading.Thread | None = None
_stop_requested = False
_enabled = False
_device = ""
_last_error = ""
_last_bands: dict[str, Any] = {}
_last_emit_at = 0.0
_started_at = 0.0
_restart_count = 0
# 推送给渲染端的最小间隔（秒）。worker 本身 30fps，这里再加一道，
# 避免后端忙时把 WS 灌满。
FORWARD_INTERVAL = 1.0 / 30


def _worker_script() -> Path:
    """定位 tools/audio_spectrum_worker.py。

    本文件在 `<backend>/app/companion/`，往上三层才是 backend 根：
        audio_spectrum_service.py → companion → app → backend
    """
    return Path(__file__).resolve().parents[2] / "tools" / "audio_spectrum_worker.py"


def _python_executable() -> Path:
    """用**运行后端的这个解释器**（它已经装好 soundcard/numpy）。

    不要去找 .voice-env —— 那是转写链路的独立环境，方案 A 不需要它。
    """
    return Path(sys.executable)


def _publish_bands(payload: dict[str, Any]) -> None:
    """把一段能量推给桌宠（WS 事件 audio_bands）。"""
    global _last_bands, _last_emit_at, _last_error
    now = time.monotonic()
    if now - _last_emit_at < FORWARD_INTERVAL:
        return
    _last_emit_at = now
    bands = {
        "level": float(payload.get("level") or 0.0),
        "low": float(payload.get("low") or 0.0),
        "mid": float(payload.get("mid") or 0.0),
        "high": float(payload.get("high") or 0.0),
        "silent": bool(payload.get("silent")),
    }
    with _lock:
        _last_bands = bands
    try:
        from ..companion import pet_event_service

        pet_event_service.publish("audio_bands", bands)
    except Exception as exc:  # noqa: BLE001 —— 推送失败不能影响采集
        with _lock:
            _last_error = f"推送失败：{explain_short(exc)}"


def explain_short(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:200]


def _read_loop(process: subprocess.Popen[str]) -> None:
    """逐行读 worker 输出，直到进程结束或要求停止。"""
    global _last_error, _device
    assert process.stdout is not None
    try:
        for raw in process.stdout:
            line = raw.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = str(payload.get("type") or "")
            if kind == "bands":
                _publish_bands(payload)
            elif kind == "speaker":
                with _lock:
                    _device = str(payload.get("name") or "")[:200]
                    _last_error = ""
            elif kind == "error":
                with _lock:
                    _last_error = str(payload.get("message") or "")[:300]
    except (ValueError, OSError):
        # 进程被 kill 时读 stdout 会抛 ValueError（closed file）
        pass
    finally:
        try:
            process.stdout.close()
        except Exception:  # noqa: BLE001
            pass


def _supervise() -> None:
    """常驻监督：worker 退出了就按退避重启，直到 set_enabled(False)。"""
    global _process, _reader, _restart_count, _last_error
    backoff = 1.0
    while True:
        with _lock:
            if _stop_requested or not _enabled:
                return
        script = _worker_script()
        if not script.is_file():
            with _lock:
                _last_error = f"找不到频谱 worker：{script}"
            return
        args = [str(_python_executable()), str(script)]
        if _device:
            args += ["--device", _device]
        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            process = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                creationflags=creationflags,
            )
        except OSError as exc:
            with _lock:
                _last_error = f"启动频谱 worker 失败：{explain_short(exc)}"
            time.sleep(backoff)
            backoff = min(15.0, backoff * 2)
            continue
        with _lock:
            _process = process
        _reader = threading.Thread(
            target=_read_loop,
            args=(process,),
            name="mio-audio-bands",
            daemon=True,
        )
        _reader.start()
        # 等它自己退出（或我们主动 kill）
        process.wait()
        with _lock:
            _process = None
            alive = _enabled and not _stop_requested
            if alive:
                _restart_count += 1
                if not _last_error:
                    _last_error = f"频谱 worker 退出(rc={process.returncode})，正在重启"
        if not alive:
            return
        time.sleep(backoff)
        backoff = min(15.0, backoff * 2)


def set_enabled(enabled: bool, *, device: str = "") -> dict[str, Any]:
    """开/关常驻采集。幂等：重复调用不会起两个 worker。"""
    global _enabled, _stop_requested, _device, _started_at, _restart_count
    want = bool(enabled)
    with _lock:
        if want == _enabled and (not want or (_process is not None)):
            if device:
                _device = device
            return status()
        _enabled = want
        _stop_requested = not want
        if device:
            _device = device
        process = _process
        if want:
            _started_at = time.time()
            _restart_count = 0
    if not want:
        if process is not None:
            try:
                process.terminate()
            except Exception:  # noqa: BLE001
                pass
        # 重新开时要把 stop 标志复位
        with _lock:
            _stop_requested = False
            _enabled = False
        return status()
    threading.Thread(target=_supervise, name="mio-audio-supervisor", daemon=True).start()
    return status()


def status() -> dict[str, Any]:
    with _lock:
        process = _process
        return {
            "enabled": _enabled,
            "running": bool(process is not None and process.poll() is None),
            "device": _device,
            "last_error": _last_error,
            "restart_count": _restart_count,
            "started_at": _started_at,
            "bands": dict(_last_bands),
        }


def stop_all() -> None:
    set_enabled(False)
