"""系统音频频谱采集 worker —— 让桌宠跟着扬声器输出呼吸/摆动。

★ 为什么是独立进程（不是后端里的线程）：
  soundcard 的 WASAPI 回环在某些设备/驱动下会**阻塞**（record() 不返回）。
  放在后端线程里会拖死整个服务（连带聊天、观察、WS 全卡）。
  独立进程的话，最坏情况只是"这部分没数据"，后端照常工作。

★ 为什么自己算 FFT 而不把原始音频推给前端：
  44.1kHz 立体声原始流约 1.7MB/s，走 JSON/WS 完全不现实。
  这里在本地算出「四段能量 + 少量频谱」再用极小的 JSON 推出去（约 200 字节/次）。

★ 常驻的三件事（缺一就容易"过一会儿就没反应了"）：
  1. 断流自动重连：拔耳机/切蓝牙/设备休眠都会让端点失效，必须循环重开；
  2. 静音不空转：没声音时降低采样节奏，避免持续满负荷；
  3. 绝不因为一次异常退出：所有异常都吞掉并重试，日志限流。

输出：stdout 每行一个 JSON（NDJSON），由后端逐行读取。
  {"type":"bands","level":0.42,"low":0.61,"mid":0.28,"high":0.09, ...}
  {"type":"speaker","name":"..."}
  {"type":"error","message":"..."}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from typing import Any

# 采样参数：44.1kHz 才能覆盖到 8kHz 以上的"高频细节"（镲片/齿音）
# 16kHz（转写链路用的那个）只有 8kHz 带宽，高频段会完全空白。
SAMPLE_RATE = 44100
CHANNELS = 2
# 每次读取的帧数：1024 帧 @44.1k ≈ 23ms，配合推送间隔 ~33ms(30fps) 足够细腻
BLOCK_FRAMES = 1024
# 推送间隔：30fps 与 Live2D 渲染同频，避免"分析比渲染快"造成的抖动
EMIT_INTERVAL = 1.0 / 30

# 频段划分（Hz）：低=鼓/贝斯，中=人声/主旋律，高=镲片/齿音
BAND_LOW = (40, 250)
BAND_MID = (250, 2500)
BAND_HIGH = (2500, 9000)
# 静音判定：连续这么久低于阈值就进入"低功耗轮询"
SILENCE_RMS = 0.004
SILENCE_HOLD_SECONDS = 3.0


def _emit(payload: dict[str, Any]) -> None:
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        # 父进程没了：安静退出，别刷一堆异常
        raise SystemExit(0)


def _band_energy(magnitudes, freqs, low_hz: float, high_hz: float) -> float:
    """某频段的能量（0~1）。

    ★ 2026-10-24 实测修正：原来用 `mean()`，结果一段很响的测试音只得到 0.003。
      原因：真实音乐的频谱能量集中在少数峰值 bin 上，**平均到整段几百个 bin**
      会被严重稀释（一半以上是噪声底）。改成 **RMS（均方根）** 后再做对数压缩：
         · RMS 对峰值敏感、对大片噪声底不敏感，更贴近"听感响度"；
         · `log` 压缩把 0.001~0.2 这种跨度拉到 0~1，小音量也看得见、大音量不爆表。
    """
    import numpy as np

    mask = (freqs >= low_hz) & (freqs < high_hz)
    if not mask.any():
        return 0.0
    band = magnitudes[mask]
    rms = float(np.sqrt(np.mean(band ** 2)))
    if rms <= 1e-6:
        return 0.0
    # 对数压缩：-70dB(1e-3.5) → 0，-10dB(1e-0.5) → 1
    db = 20.0 * np.log10(max(rms, 1e-6))
    value = (db + 70.0) / 60.0
    return float(max(0.0, min(1.0, value)))


def _pick_loopback(sc, device_name: str = ""):
    """挑一个**真正的 Loopback 端点**。

    ★ 2026-10-24 实测踩坑（这段是本次最关键的一处）：
      用 `sc.get_microphone(id=str(speaker.name), include_loopback=True)` 拿到的
      **不一定是 Loopback**。实测在 HECATE G2 无线耳机上，它返回的是
      `<Microphone 耳机 (2- HECATE G2无线版) (1 channels)>` —— 一个**真麦克风**，
      录出来的全是 0（因为麦克风没在收音）。
      必须从 `all_microphones(include_loopback=True)` 里筛出名字带 `Loopback` 的那些，
      它们才是"声卡输出端点的回环"。
    """
    loops = [m for m in sc.all_microphones(include_loopback=True) if "Loopback" in str(m)]
    if not loops:
        return None
    if device_name:
        want = device_name.lower()
        for m in loops:
            if want in str(m).lower():
                return m
    # 没指定 / 没匹配上：优先与**默认扬声器**同名的回环（用户此刻在听的那个）
    try:
        default_name = str(sc.default_speaker().name).lower()
        for m in loops:
            if default_name and default_name in str(m).lower():
                return m
    except Exception:  # noqa: BLE001
        pass
    return loops[0]


def run(device_name: str = "") -> int:
    """主循环：永不返回（除非 stdout 断开）。"""
    import warnings

    import numpy as np
    import soundcard as sc

    # ★ WASAPI 回环在静音/设备切换时会高频抛 "data discontinuity in recording"。
    #   它只是提示"这一块数据不连续"，对我们做频谱能量毫无影响，但每秒几十条
    #   会污染 stderr 并拖慢管道。这里定向静音，其它警告照常。
    warnings.filterwarnings("ignore", message=".*data discontinuity.*")

    last_error = ""
    recent_rms: list[float] = []
    quiet_since = 0.0
    last_emit = 0.0
    # 平滑状态：与前端一致的三段能量（避免前端再从零开始缓动）
    smooth = {"low": 0.0, "mid": 0.0, "high": 0.0, "level": 0.0}

    while True:
        try:
            mic = _pick_loopback(sc, device_name)
            if mic is None:
                if last_error != "no-loopback":
                    _emit({"type": "error", "message": "没有找到任何 Loopback 端点（声卡不支持回环？）"})
                    last_error = "no-loopback"
                time.sleep(2.0)
                continue

            _emit({"type": "speaker", "name": str(mic), "device": str(mic)})
            last_error = ""

            with mic.recorder(samplerate=SAMPLE_RATE, channels=CHANNELS, blocksize=BLOCK_FRAMES) as rec:
                # 汉宁窗：减少频谱泄漏，让低频判定更干净
                window = np.hanning(BLOCK_FRAMES)
                freqs = np.fft.rfftfreq(BLOCK_FRAMES, 1.0 / SAMPLE_RATE)
                while True:
                    data = rec.record(numframes=BLOCK_FRAMES)
                    if data is None or len(data) == 0:
                        continue
                    mono = data[:, 0] if data.ndim > 1 else data
                    rms = float(np.sqrt(np.mean(mono ** 2)))

                    # 静音：降频（40ms→120ms），省 CPU；有声音立刻回到 30fps
                    now = time.monotonic()
                    if rms < SILENCE_RMS:
                        recent_rms.append(rms)
                        if len(recent_rms) > 30:
                            recent_rms.pop(0)
                        if quiet_since == 0.0:
                            quiet_since = now
                        if now - quiet_since > SILENCE_HOLD_SECONDS:
                            time.sleep(0.09)
                    else:
                        recent_rms.clear()
                        quiet_since = 0.0

                    if now - last_emit < EMIT_INTERVAL:
                        continue
                    last_emit = now

                    spectrum = np.abs(np.fft.rfft(mono * window)) / (BLOCK_FRAMES / 2.0)
                    low = _band_energy(spectrum, freqs, *BAND_LOW)
                    mid = _band_energy(spectrum, freqs, *BAND_MID)
                    high = _band_energy(spectrum, freqs, *BAND_HIGH)
                    level = max(low, mid, high)

                    # 服务端也做一次缓动：上行快、下行慢 = 跟得住节拍又不抽搐
                    for key, target, up, down in (
                        ("low", low, 0.45, 0.10),
                        ("mid", mid, 0.38, 0.085),
                        ("high", high, 0.30, 0.065),
                        ("level", level, 0.42, 0.09),
                    ):
                        cur = smooth[key]
                        k = up if target > cur else down
                        smooth[key] = cur + (target - cur) * k

                    _emit({
                        "type": "bands",
                        "ts": round(time.time() * 1000, 1),
                        "sample_rate": SAMPLE_RATE,
                        "level": round(smooth["level"], 4),
                        "low": round(smooth["low"], 4),
                        "mid": round(smooth["mid"], 4),
                        "high": round(smooth["high"], 4),
                        "rms": round(rms, 6),
                        "silent": rms < SILENCE_RMS,
                    })
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001 —— 常驻进程不能因任何异常退出
            message = f"{type(exc).__name__}: {exc}"[:300]
            if message != last_error:
                _emit({"type": "error", "message": message})
                last_error = message
            # 端点失效（拔耳机/换设备）时重开；退避避免疯狂重试
            time.sleep(2.0)


def main() -> int:
    parser = argparse.ArgumentParser(description="系统音频频谱采集（WASAPI 回环）")
    parser.add_argument("--device", default="", help="指定扬声器名（模糊匹配）；留空用默认输出设备")
    args = parser.parse_args()
    try:
        return run(args.device)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
