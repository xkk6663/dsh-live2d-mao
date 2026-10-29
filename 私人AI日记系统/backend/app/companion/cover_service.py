"""本地翻唱任务服务：用户说"翻唱《歌名》"→ 自动找音源 → WSL 本地 RVC → 音频回桌宠。

管线（2026-10-27 实测全部打通，5.20AM 首验）：
  1. music_proxy（云端 docker :8080，与 AstrBot 同机）搜歌 → 取第一个结果
  2. 拿 320kbps 直链下载 mp3
  3. wsl.exe 调 ~/feiyu-rvc-bundle/cover_pipeline.sh：
     UVR-MDX-NET Karaoke 分离（CPU ~50s）→ FeiyuVoice-RVC 换声（CPU ~6min/3min歌）
     → ffmpeg amix 混音 → 成品 192kbps mp3
  4. 成品落盘 agent_media → publish("agent_audio")，复用点歌通路（前端零改动）

设计约束（踩过的坑）：
  - WSL 虚拟机命令间隙会自动关机：/tmp 不持久、nohup 必死。所有中间件放
    Windows 侧 tmp（/mnt/c 可达）+ WSL 家目录，长任务用阻塞 subprocess（worker 线程里）。
  - WS 单帧上限 1MB：音频绝不 base64 进 WS，一律落盘 + 短 URL（companion.py 同款纪律）。
  - 云端服务器地址不进源码（安全红线）：music_proxy 主机从 ASTRBOT_BASE_URL 推导。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
import logging
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx

from .. import db
from ..companion import pet_event_service
from ..kernel import agent_bus_service

logger = logging.getLogger("companion.cover")

# 翻唱任务在 WS/聊天页上的身份：必须用 cloud_feiyu —— 聊天页 useCompanionChat
# 的 agent_audio/agent_bubble 白名单只认 cloud_feiyu/screen（585 行），用这个
# agent_id 前端零改动。
FEIYU_AGENT_ID = "cloud_feiyu"
FEIYU_BUBBLE_ACCENT = "#2B6CB0"

# WSL 发行版与管线脚本位置（脚本本体由 .workbuddy/tmp/feiyu-rvc/cover_smart.sh 部署）
WSL_DISTRO = os.getenv("COVER_WSL_DISTRO", "Ubuntu-24.04")
# v2 管线（2026-10-27 裁决固化）：一次分离→二次主唱/和声分离→只转主唱→三轨混音。
# 双声部只转女声部、男声保持原曲；独唱时 backing 是同一人的混响/和声垫，同样原样保留。
WSL_SCRIPT = "/home/xwk/feiyu-rvc-bundle/cover_smart.sh"
# Windows 侧任务工作目录：音源下载 / 成品中转（WSL 经 /mnt/c 读写）
# parents: [0]companion [1]app [2]backend [3]私人AI日记系统 [4]仓库根
_COVER_TMP = Path(__file__).resolve().parents[4] / ".workbuddy" / "tmp" / "covers"

# 男声源 → 肥鱼（女声）必须 +12 半音；女声源 0。2026-10-27 实测结论（demo 试听）。
_DEFAULT_PITCH = 0

# RVC 特征检索比率：0.5 = 2026-10-28 三档 A/B 裁决（干物女 0.3/0.5/0.7 对比，
# 用户："都差不多，统一选 0.5"——0.7 偏沙哑/电音，0.3 肥鱼味偏淡，取中间档）。
_COVER_INDEX_RATE = os.getenv("COVER_INDEX_RATE", "0.5")

# 双声部歌单：歌名命中（大小写不敏感子串）走 mode=lead（只转主唱，男声/和声
# 保持原曲）；其余默认 mode=full（整条人声转肥鱼——独唱的混响/和声垫也一起
# 换声，否则"原版味太重"（2026-10-28 用户裁决）。
# 能量自动检测实测不可行（独唱混响垫与双声部和声能量相当），所以靠这张人工清单。
# 运行时数据放 数据/翻唱双声部歌单.json（不进仓库），格式：{"双声部": ["Sweet Day"]}
# parents: [0]companion [1]app [2]backend [3]私人AI日记系统 → 数据/ 在 [3] 下
_DUAL_VOCAL_LIST_PATH = Path(__file__).resolve().parents[3] / "数据" / "翻唱双声部歌单.json"


def _cover_mode_for(title: str) -> str:
    """full = 整条人声转换（独唱默认）；lead = 只转主唱（双声部歌）。"""
    needle = (title or "").strip().lower()
    if not needle:
        return "full"
    try:
        data = json.loads(_DUAL_VOCAL_LIST_PATH.read_text(encoding="utf-8"))
        keywords = data.get("双声部") or []
    except FileNotFoundError:
        return "full"
    except Exception:
        logger.exception("[cover] dual-vocal list unreadable, fallback to full")
        return "full"
    for kw in keywords:
        kw = str(kw).strip().lower()
        if kw and kw in needle:
            return "lead"
    return "full"


def _music_proxy_base() -> str:
    """music_proxy 地址：显式 env > 从云端 AstrBot 地址推导同主机 :8080 > 本地兜底。

    为什么不写死 IP：云端 AstrBot 服务器 IP 曾因泄漏风险做过全历史清除
    （见 ASTRBOT_BASE_URL 纪律），新代码一律经配置推导，不落源码。
    """
    explicit = (os.getenv("MUSIC_PROXY_BASE") or "").strip()
    if explicit:
        return explicit.rstrip("/")
    astrbot = (os.getenv("ASTRBOT_BASE_URL") or "").strip()
    if astrbot:
        host = urlsplit(astrbot).hostname
        if host:
            return f"http://{host}:8080"
    return "http://127.0.0.1:8080"


def _music_proxy_token() -> str:
    return (os.getenv("MUSIC_PROXY_TOKEN") or "").strip()


# ---- 请求解析 ---------------------------------------------------------------

# 强模式匹配：明确动词性用法才拦截，避免聊天里随口提到"翻唱"误触发。
#   支持：翻唱《X》 / 翻唱一下《X》 / 给我翻唱个X / 来一首X的翻唱 / 翻唱X
_COVER_TITLE_BRACKETS = re.compile(r"[《【\u201c\u300c]([^《》【】\u201d\u300d]{1,40})[》】\u201d\u300d]")
_COVER_AFTER = re.compile(
    r"翻唱[一]?[个首下]?\s*([^\s《》【】\u201c\u201d\u300c\u300d，。！？!?、]{1,40})"
)
_COVER_BEFORE = re.compile(
    r"([^\s《》【】\u201c\u201d\u300c\u300d，。！？!?、]{1,40}?)的?翻唱[一]?[下个]?\s*[版吗呢吧？]?\s*$"
)
# 动词性前缀（"给我翻唱个X" / "来一首X的翻唱"），匹配前先剥掉
_COVER_PREFIX = re.compile(r"^[请烦]?[给来帮]?[我你]?(?:一首|一支|个|支|下|来)?\s*")
# 闲聊排除："你翻唱过什么歌" / "我喜欢听翻唱版本的歌" —— 捕获以这些词开头一律不是歌名
_COVER_TITLE_BLACKLIST = re.compile(r"^(?:过|的|版本|水平|技巧|实力|吗|呢|吧|么|什么)")


def bracket_title(text: str) -> str | None:
    """只取《【“「书名号里的歌名；没有书名号返回 None（供上传音源路径用）。"""
    match = _COVER_TITLE_BRACKETS.search((text or "").strip())
    return match.group(1).strip() if match else None


# 文本解析出来的"歌名"若是这些代词/量词，说明用户没给歌名（如"翻唱一下"），
# 宁可不触发也别拿垃圾歌名去搜歌（2026-10-29 实测"翻唱一下，大肥鱼"抠出"下"）。
_GENERIC_TITLES = {"这个", "它", "这首", "这首歌", "一下", "她", "他", "下", "个", "首", "歌", "一首", "一个"}


def try_parse_cover_request(text: str) -> dict | None:
    """识别翻唱请求，返回 {"title": 歌名}；不是翻唱指令返回 None。"""
    message = (text or "").strip()
    if not message or len(message) > 60 or "翻唱" not in message:
        return None
    # 1) 书名号优先（最可靠）：歌名取书名号内文本
    bracket = _COVER_TITLE_BRACKETS.search(message)
    if bracket:
        return {"title": bracket.group(1).strip()}
    # 2) 无书名号：剥动词前缀后取"翻唱"后面 / 前面的歌名
    stripped = _COVER_PREFIX.sub("", message)
    for pattern in (_COVER_AFTER, _COVER_BEFORE):
        match = pattern.search(stripped)
        if match:
            title = match.group(1).strip(" 　")
            if title and not _COVER_TITLE_BLACKLIST.match(title) and title not in _GENERIC_TITLES:
                return {"title": title}
    return None


# ---- music_proxy 客户端 -----------------------------------------------------


def _music_client() -> httpx.Client:
    return httpx.Client(trust_env=False, timeout=30.0)


def _search_song(client: httpx.Client, title: str) -> dict | None:
    """搜歌取第一个结果。music_proxy 返回 {code, data:[{id,name,artist,...}]}。"""
    response = client.get(
        f"{_music_proxy_base()}/v1/search",
        params={"q": title, "limit": 5},
        headers={"X-Music-Token": _music_proxy_token()},
    )
    response.raise_for_status()
    payload = response.json()
    if int(payload.get("code", -1)) != 0:
        return None
    items = payload.get("data") or []
    return items[0] if items else None


def _fetch_song_url(client: httpx.Client, song_id: str) -> str | None:
    response = client.get(
        f"{_music_proxy_base()}/v1/url",
        params={"id": song_id},
        headers={"X-Music-Token": _music_proxy_token()},
    )
    response.raise_for_status()
    payload = response.json()
    if int(payload.get("code", -1)) != 0:
        return None
    return (payload.get("data") or {}).get("url") or None


# ---- 落盘与推送（复用点歌通路形态，companion.py:1247/2092 同款纪律）--------

_MEDIA_EXT_WHITELIST = {".mp3", ".wav", ".m4a", ".flac", ".ogg"}


def _agent_media_dir() -> Path:
    # companion_service.live2d_state_dir() 的同款目录（companion.py:1223），
    # /api/companion/agent-media/{name} 直接 serve 这里。
    from ..companion import companion_service

    directory = companion_service.live2d_state_dir() / "agent_media"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _save_cover_media(blob: bytes, display: str) -> dict:
    """成品 mp3 落盘 agent_media，返回与点歌通路同形状的短 URL 元信息。"""
    digest = hashlib.sha256(blob).hexdigest()[:16]
    safe_name = f"{digest}.mp3"
    target = _agent_media_dir() / safe_name
    if not target.is_file() or target.stat().st_size != len(blob):
        target.write_bytes(blob)
    return {
        "url": f"/api/companion/agent-media/{quote(safe_name)}",
        "filename": safe_name,
        "display": display,
        "mime_type": "audio/mpeg",
        "size": len(blob),
    }


def _publish_bubble(text: str) -> None:
    pet_event_service.publish(
        "agent_bubble",
        {
            "text": text,
            "agent_id": FEIYU_AGENT_ID,
            "accent": FEIYU_BUBBLE_ACCENT,
            "duration_ms": 6000,
        },
    )


def _publish_audio(meta: dict, response_id: str, text: str) -> None:
    pet_event_service.publish(
        "agent_audio",
        {
            "url": meta["url"],
            "filename": meta["filename"],
            "display": meta["display"],
            "mime_type": meta["mime_type"],
            "size": meta["size"],
            "agent_id": FEIYU_AGENT_ID,
            "accent": FEIYU_BUBBLE_ACCENT,
            "response_id": response_id,
            # 单条音频，正文挂这一条上（前端把 text 当"这一轮说什么"）
            "text": text,
        },
    )


def _save_history(text: str, meta: dict, request_id: str, conversation_id: str) -> None:
    """成品落库（复用点歌通路的 attachments 形状，刷新后历史可恢复）。"""
    try:
        db.save_message(
            "assistant",
            text,
            source="desktop_pet",
            conversation_id=conversation_id,
            request_id=request_id,
            model_id=FEIYU_AGENT_ID,
            attachments_json=json.dumps(
                [
                    {
                        "media": "audio",
                        "kind": "audio",
                        "url": meta["url"],
                        "display": meta["display"],
                        "filename": meta["filename"],
                        "mime_type": meta["mime_type"],
                        "size": meta["size"],
                    }
                ],
                ensure_ascii=False,
            ),
        )
    except Exception:
        logger.exception("[cover] save history failed")


# ---- WSL 管线调用 -----------------------------------------------------------


def _slugify(title: str) -> str:
    slug = re.sub(r"[^0-9A-Za-z]+", "_", title).strip("_").lower()
    return (slug or "song")[:40]


def _decode_proc_output(raw: bytes) -> str:
    """wsl.exe 的启动错误消息是 UTF-16LE（如 'Wsl/E_ACCESSDENIED'），按 utf-8 解
    会得到乱码（2026-10-29 每日翻唱失败气泡全问号的教训）。粗判：含 NUL 字节
    → 按 utf-16le 解；否则按 utf-8 解。管线内 bash 的输出是无 NUL 的 utf-8，
    两种情况都能正确落字。"""
    if not raw:
        return ""
    if b"\x00" in raw:
        try:
            return raw.decode("utf-16-le", errors="replace")
        except Exception:
            pass
    return raw.decode("utf-8", errors="replace")


# wsl.exe 冷启动竞态（与 Docker Desktop 抢 WSL VM）会报 Wsl/E_ACCESSDENIED、
# exit=0xFFFFFFFF（4294967295）——瞬时故障，等待重试即可自愈（2026-10-29 实测）。
_TRANSIENT_WSL_MARKERS = (
    "E_ACCESSDENIED",
    "ACCESSDENIED",
    "Wsl/",
    "连接尝试失败",
    "远程过程调用失败",
)


def _run_pipeline(source_mp3: Path, slug: str, pitch: int, mode: str = "full") -> bytes:
    """阻塞跑 WSL 翻唱管线，返回成品 mp3 字节。worker 线程调用，允许跑 10-15 分钟。

    mode: full=整条人声转换（独唱默认）| lead=只转主唱（双声部歌，见 _cover_mode_for）。
    瞬时 WSL 故障（exit=0xFFFFFFFF / E_ACCESSDENIED）自动重试，最多 3 次、间隔 30s。

    ★ 流式进度（2026-10-29 用户诉求"判断卡住还是在跑"）：旧实现 subprocess.run(
      capture_output=True) 跑完才有输出，中途前端全靠猜。改 Popen 逐行读 stderr ——
      cover_smart.sh 的 log() 把阶段标记（separating/rvc converting/mixing/done）
      打到 stderr，解析后实时写 _task_status 供 /cover/status 轮询。
    """
    out_mp3 = source_mp3.parent / f"cover_{slug}_{int(time.time())}.mp3"
    # 路径换算：C:\... → /mnt/c/...（subprocess 直接传 list 参数，无 shell 转义问题）
    def to_wsl(path: Path) -> str:
        resolved = str(path.resolve())
        drive = resolved[0].lower()
        return f"/mnt/{drive}" + resolved[2:].replace("\\", "/")

    command = [
        "wsl.exe", "-d", WSL_DISTRO, "--",
        "bash", WSL_SCRIPT,
        to_wsl(source_mp3), slug, str(pitch), to_wsl(out_mp3),
        _COVER_INDEX_RATE, mode,
    ]
    # 脚本 log() 标记 → 人话阶段名（顺序即管线顺序；最耗时的换声排最长）
    stage_map = (
        ("second-pass: split", "二次分离主唱/和声"),
        ("separating vocals", "分离伴奏和人声"),
        ("rvc converting", "换肥鱼音色（最久的一步）"),
        ("rvc done", "换声完成，准备混音"),
        ("mixing", "混音中"),
    )

    def _stage_from_line(line: str):
        for marker, label in stage_map:
            if marker in line:
                return label
        return None

    last_tail = ""
    returncode = None
    for attempt in range(1, 4):
        started = time.monotonic()
        stderr_lines: list[str] = []
        stdout_lines: list[str] = []
        try:
            proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            # 两个流都必须持续排空，否则缓冲写满子进程会 block。
            # stderr 是阶段标记主通道；stdout 只有最后 echo 的成品路径。
            def _drain(stream, sink):
                with stream:
                    for raw in iter(stream.readline, b""):
                        sink.append(_decode_proc_output(raw).rstrip())

            t_err = threading.Thread(target=_drain, args=(proc.stderr, stderr_lines), daemon=True)
            t_out = threading.Thread(target=_drain, args=(proc.stdout, stdout_lines), daemon=True)
            t_err.start()
            t_out.start()
            prev_stage = None
            while True:
                try:
                    proc.wait(timeout=5)
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() - started > 1800:
                        proc.kill()
                        raise RuntimeError("翻唱管线超时（30 分钟无输出）") from None
                    new_stage = None
                    for line in reversed(stderr_lines):
                        st = _stage_from_line(line)
                        if st:
                            new_stage = st
                            break
                    if new_stage and new_stage != prev_stage:
                        prev_stage = new_stage
                        _status_update(stage=new_stage, stage_at=time.time())
                        logger.info("[cover] stage: %s", new_stage)
            t_err.join(timeout=5)
            t_out.join(timeout=5)
            returncode = proc.returncode
        except RuntimeError:
            raise
        except Exception as exc:
            returncode = -1
            stderr_lines.append(f"wsl launch failed: {exc}")
        elapsed = time.monotonic() - started
        logger.warning("[cover] pipeline attempt %d finished in %.1fs (exit=%s)", attempt, elapsed, returncode)
        if returncode not in (0,) and returncode != 0:
            logger.warning("[cover] command=%s", " ".join(command))
            logger.warning("[cover] stderr_tail=%r", "\n".join(stderr_lines[-8:]))
            logger.warning("[cover] stdout_tail=%r", "\n".join(stdout_lines[-4:]))
        if returncode == 0 and out_mp3.is_file():
            _status_update(stage="唱完了，正在发给你", stage_at=time.time())
            return out_mp3.read_bytes()
        blob = "\n".join(stderr_lines[-12:]) or "\n".join(stdout_lines[-12:])
        last_tail = blob
        transient = returncode in (0xFFFFFFFF, -1) or any(m in blob for m in _TRANSIENT_WSL_MARKERS)
        if not transient or attempt == 3:
            break
        logger.warning("[cover] transient wsl failure (exit=%s), retrying in 30s", returncode)
        _status_update(stage="WSL 打了个嗝，30 秒后自动重试", stage_at=time.time())
        time.sleep(30)
    raise RuntimeError(f"翻唱管线失败（exit={returncode}）：{last_tail}")


# ---- 任务编排 ---------------------------------------------------------------

# 单飞开关：同一时刻只跑一个翻唱任务（WSL CPU 管线 8-10 分钟，排队没有意义，
# 直接告诉用户"正忙着唱上一首"）。
_cover_busy = False

# ---- 进度可视化（2026-10-29 用户诉求"判断卡住还是在跑，缓解等待焦虑"）--------
# 任务状态快照：前端聊天页轮询 GET /cover/status 显示"正在唱《X》· 第几步 · 已等 y 分钟"。
# 只存内存（单进程消费，重启清零无所谓）；管线各阶段由 stderr 流式日志驱动。
_task_status: dict = {}
_STATUS_LOCK = threading.Lock()


def _status_update(**fields) -> None:
    with _STATUS_LOCK:
        _task_status.update(fields)
        _task_status["updated_at"] = time.time()


def _status_clear() -> None:
    with _STATUS_LOCK:
        _task_status.clear()


def current_status() -> dict:
    with _STATUS_LOCK:
        snap = dict(_task_status)
    if snap:
        snap["elapsed_sec"] = int(time.time() - snap.get("started_at", time.time()))
    return snap


def is_busy() -> bool:
    return _cover_busy


def start_cover_task(
    title: str,
    *,
    request_id: str,
    conversation_id: str = "desktop_pet",
) -> bool:
    """起后台翻唱任务（非阻塞）。返回 False 表示正忙（此时不重复起任务）。"""
    global _cover_busy
    if _cover_busy:
        _publish_bubble("等我唱完手上这首再来点歌嘛～一次只能唱一首哦")
        return False
    _cover_busy = True
    _status_update(title=title, stage="准备音源", started_at=time.time(), stage_at=time.time())

    def worker() -> None:
        global _cover_busy
        try:
            _run_cover_task(title, request_id=request_id, conversation_id=conversation_id)
        except Exception as exc:  # 任务失败也要让用户看到，不能静默
            logger.exception("[cover] task failed: %s", title)
            try:
                _publish_bubble(f"呜……《{title}》没唱成：{exc}")
                db.save_message(
                    "assistant",
                    f"（翻唱《{title}》失败：{exc}）",
                    source="desktop_pet",
                    conversation_id=conversation_id,
                    request_id=request_id,
                    model_id=FEIYU_AGENT_ID,
                )
            except Exception:
                logger.exception("[cover] failure notice also failed")
        finally:
            _cover_busy = False
            _status_clear()

    threading.Thread(target=worker, name=f"cover-{_slugify(title)}", daemon=True).start()
    return True


def save_upload_source(data_url: str, filename: str) -> Path | None:
    """把用户上传的音频 data_url 解码落盘到翻唱临时目录，返回路径；不合法返回 None。"""
    import base64

    data_url = str(data_url or "")
    if not data_url.startswith("data:"):
        return None
    _, _, payload = data_url.partition(",")
    if not payload:
        return None
    try:
        blob = base64.b64decode(payload, validate=False)
    except Exception:
        return None
    # 100KB ~ 25MB：太小说明没传全，太大超出常见歌曲体量（前端限 20MB，这里放宽一点）
    if len(blob) < 100_000 or len(blob) > 25_000_000:
        return None
    _COVER_TMP.mkdir(parents=True, exist_ok=True)
    target = _COVER_TMP / f"src_upload_{int(time.time())}.mp3"
    try:
        target.write_bytes(blob)
    except OSError:
        return None
    return target


def upload_title_from(filename: str, fallback: str = "你发的歌") -> str:
    """从上传文件名推断展示歌名（去扩展名、清理、截断）。"""
    stem = Path(str(filename or "")).stem.strip()
    stem = re.sub(r"[\r\n\t]", " ", stem).strip(" 　-_")
    if not stem:
        return fallback
    return stem[:40]


def start_cover_task_from_source(
    source_mp3: Path,
    title: str,
    *,
    request_id: str,
    conversation_id: str = "desktop_pet",
) -> bool:
    """用户在聊天页直接发音频文件请求翻唱：跳过搜歌，直接用上传的音源开跑。

    与 start_cover_task 同款单飞开关/异常兜底；返回 False 表示正忙。
    """
    global _cover_busy
    if _cover_busy:
        _publish_bubble("等我唱完手上这首再来点歌嘛～一次只能唱一首哦")
        return False
    if not source_mp3.is_file() or source_mp3.stat().st_size < 100_000:
        _publish_bubble("这个音频文件好像没传完整，再发一次试试？")
        return False
    _cover_busy = True
    _status_update(title=title, stage="接收音频", started_at=time.time(), stage_at=time.time())

    def worker() -> None:
        global _cover_busy
        try:
            _run_cover_task_from_source(
                title, source_mp3, request_id=request_id, conversation_id=conversation_id
            )
        except Exception as exc:  # 任务失败也要让用户看到，不能静默
            logger.exception("[cover] uploaded-source task failed: %s", title)
            try:
                _publish_bubble(f"呜……《{title}》没唱成：{exc}")
                db.save_message(
                    "assistant",
                    f"（翻唱上传音源《{title}》失败：{exc}）",
                    source="desktop_pet",
                    conversation_id=conversation_id,
                    request_id=request_id,
                    model_id=FEIYU_AGENT_ID,
                )
            except Exception:
                logger.exception("[cover] failure notice also failed")
        finally:
            _cover_busy = False
            _status_clear()

    threading.Thread(target=worker, name=f"cover-up-{_slugify(title)}", daemon=True).start()
    return True


def _run_cover_task_from_source(
    title: str,
    source_mp3: Path,
    *,
    request_id: str,
    conversation_id: str,
) -> None:
    """对用户上传的音源跑翻唱管线（跳过搜歌/下载，其余与 _run_cover_task 相同）。"""
    started = time.monotonic()
    try:
        agent_bus_service.emit(FEIYU_AGENT_ID, "voice", {"label": f"翻唱《{title}》"}, force=True)
    except Exception:
        pass  # 总线注册缺失只影响动画，不影响唱歌

    slug = _slugify(title) or "upload"
    mode = _cover_mode_for(title)
    cached = _cache_path(title, mode)
    if cached.is_file() and cached.stat().st_size > 100_000:
        blob = cached.read_bytes()
        meta = _save_cover_media(blob, f"《{title}》大肥鱼翻唱")
        bubble_text = f"你发的这首《{title}》我唱过啦，再放一遍～"
        _publish_audio(meta, response_id=request_id, text=bubble_text)
        _save_history(bubble_text, meta, request_id, conversation_id)
        return
    _publish_bubble(f"收到你发的《{title}》！我去练歌，唱好叫你～")
    blob = _run_pipeline(source_mp3, slug, _DEFAULT_PITCH, mode)
    try:
        _cache_path(title, mode).write_bytes(blob)  # 成品缓存，下次秒回
    except OSError:
        pass
    meta = _save_cover_media(blob, f"《{title}》大肥鱼翻唱")
    bubble_text = f"唱好啦！这是用你发的音源翻唱的《{title}》，听听看～"
    _publish_audio(meta, response_id=request_id, text=bubble_text)
    _save_history(bubble_text, meta, request_id, conversation_id)
    try:
        agent_bus_service.emit(FEIYU_AGENT_ID, "complete", force=True)
    except Exception:
        pass
    logger.info("[cover] uploaded《%s》 finished in %.1fs", title, time.monotonic() - started)


def _cache_path(title: str, mode: str = "full") -> Path:
    """成品缓存：同首歌唱过一次就不再重跑 10-15 分钟的 RVC 管线。

    键用标题哈希而不是 slugify —— 中文歌名 slugify 后是空串（全变下划线），
    会把不同歌唱成同一键。前缀含管线版本（v3）与 mode：换代或换策略后旧
    成品全部失效，避免回放旧音色（v1=整体转换 index0.3 / v2=一律主唱路径）。
    """
    digest = hashlib.sha1(f"v3:{mode}:{_COVER_INDEX_RATE}:{title}".encode("utf-8")).hexdigest()[:12]
    return _COVER_TMP / f"cover_{digest}.mp3"


def _run_cover_task(title: str, *, request_id: str, conversation_id: str) -> None:
    started = time.monotonic()
    try:
        agent_bus_service.emit(FEIYU_AGENT_ID, "voice", {"label": f"翻唱《{title}》"}, force=True)
    except Exception:
        pass  # 总线注册缺失只影响动画，不影响唱歌

    _COVER_TMP.mkdir(parents=True, exist_ok=True)
    slug = _slugify(title)
    mode = _cover_mode_for(title)
    cached = _cache_path(title, mode)
    if cached.is_file() and cached.stat().st_size > 100_000:
        blob = cached.read_bytes()
        meta = _save_cover_media(blob, f"《{title}》大肥鱼翻唱")
        bubble_text = f"《{title}》我唱过啦，再给你放一遍～（想听新歌就点别的哦）"
        _publish_audio(meta, response_id=request_id, text=bubble_text)
        _save_history(bubble_text, meta, request_id, conversation_id)
        return
    with _music_client() as client:
        _status_update(stage="在音源库里搜歌")
        song = _search_song(client, title)
        if not song:
            _publish_bubble(f"音源库里没找到《{title}》，换个歌名试试？")
            return
        song_name = str(song.get("name") or title)
        artist = str(song.get("artist") or "")
        display_song = f"{song_name}({artist})" if artist else song_name
        direct_url = _fetch_song_url(client, str(song.get("id") or ""))
        if not direct_url:
            _publish_bubble(f"《{display_song}》这首歌没有直链（可能要 VIP），换首试试？")
            return
        _publish_bubble(f"找到《{display_song}》了！我去练歌，唱好叫你～")
        _status_update(stage="下载原曲")
        source_mp3 = _COVER_TMP / f"src_{slug}_{int(time.time())}.mp3"
        with client.stream("GET", direct_url, timeout=120.0) as stream:
            stream.raise_for_status()
            with source_mp3.open("wb") as handle:
                for chunk in stream.iter_bytes(64 * 1024):
                    handle.write(chunk)
    if not source_mp3.is_file() or source_mp3.stat().st_size < 100_000:
        raise RuntimeError("音源下载不完整")

    pitch = _DEFAULT_PITCH
    blob = _run_pipeline(source_mp3, slug, pitch, mode)
    try:
        _cache_path(title, mode).write_bytes(blob)  # 成品缓存，下次秒回
    except OSError:
        pass
    meta = _save_cover_media(blob, f"《{title}》大肥鱼翻唱")
    bubble_text = f"唱好啦！这是我翻唱的《{display_song}》，听听看～"
    _publish_audio(meta, response_id=request_id, text=bubble_text)
    _save_history(bubble_text, meta, request_id, conversation_id)
    try:
        agent_bus_service.emit(FEIYU_AGENT_ID, "complete", force=True)
    except Exception:
        pass
    logger.info("[cover] 《%s》 finished in %.1fs", title, time.monotonic() - started)


# ---- 每日自动翻唱（桌宠上线 30 分钟后，从云端 alist 云盘《音乐》夹挑一首）----
#
# 2026-10-27 用户裁决：
#   · 触发时机 = 桌宠（电脑端）上线后 30 分钟，每天最多一次，不在线顺延；
#   · 库存（未唱的歌）不足 3 首时气泡提醒去云盘加歌，不闷头重复唱；
#   · 云盘音乐夹在服务器本地 /opt/alist/音乐（alist 挂载根 = 容器 /opt/alist/data
#     → 宿主机 /opt/alist），列表/下载走 SSH（alist 游客已禁用，token 自签没过校验，
#     SSH 直读是最稳路径），主机同样从 ASTRBOT_BASE_URL 推导，不落源码。

_COVER_SSH_USER = os.getenv("COVER_SSH_USER", "root")
_COVER_SSH_KEY = os.getenv("COVER_SSH_KEY") or str(Path.home() / "Downloads" / "_xkk_3.pem")
_COVER_MUSIC_DIR = os.getenv("COVER_MUSIC_DIR", "/opt/alist/音乐")
_DAILY_DELAY_MINUTES = int(os.getenv("COVER_DAILY_DELAY_MINUTES", "30"))
_MIN_STOCK_REMAIN = 3


def _ssh_host() -> str:
    explicit = (os.getenv("COVER_SSH_HOST") or "").strip()
    if explicit:
        return explicit
    astrbot = (os.getenv("ASTRBOT_BASE_URL") or "").strip()
    if astrbot:
        host = urlsplit(astrbot).hostname
        if host:
            return host
    return "127.0.0.1"


def _ssh_base_args() -> list[str]:
    return [
        "ssh",
        "-i", _COVER_SSH_KEY,
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=no",
        f"{_COVER_SSH_USER}@{_ssh_host()}",
    ]


def _ssh_quote(path: str) -> str:
    return "'" + path.replace("'", "'\\''") + "'"


def _cloud_cache_dir() -> Path:
    directory = _COVER_TMP / "cloud"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _sung_path() -> Path:
    return _COVER_TMP / "cloud_sung.json"


# ---- 网易云兜底（2026-10-29 用户裁决：云盘连不上/没歌/全唱完 → 网易云挑歌）----
# 兜底歌单放 数据/翻唱兜底歌单.json（不进仓库，用户可自己改），
# 格式 {"兜底歌单": ["歌名", ...]}；文件缺失/为空用内置默认池。
_NETEASE_POOL_PATH = Path(__file__).resolve().parents[3] / "数据" / "翻唱兜底歌单.json"
_NETEASE_SUNG_PREFIX = "netease:"     # sung 列表里网易云歌的键前缀（与云盘文件名区分）
_NETEASE_FALLBACK_TRIES = 3           # 随机挑歌最多试几首（VIP 无直链/搜不到就换下一首）
_DEFAULT_NETEASE_POOL = [
    "起风了", "追光者", "体面", "说散就散", "光年之外", "小幸运",
    "后来", "成都", "平凡之路", "突然好想你", "小情歌", "温柔",
    "遇见", "童话镇", "芒种", "世间美好与你环环相扣",
]


def _netease_pool() -> list[str]:
    try:
        data = json.loads(_NETEASE_POOL_PATH.read_text(encoding="utf-8"))
        items = data.get("兜底歌单") if isinstance(data, dict) else None
        cleaned = [str(x).strip() for x in (items or []) if str(x).strip()]
        if cleaned:
            return cleaned
    except FileNotFoundError:
        pass
    except Exception:
        logger.exception("[daily-cover] load netease pool failed, use defaults")
    return list(_DEFAULT_NETEASE_POOL)


def _download_netease_song(title: str) -> tuple[bytes, str]:
    """网易云搜歌并下载音源，返回 (音源字节, 展示名「歌名(歌手)」)。

    复用聊天点歌的 music_proxy 链路（_search_song / _fetch_song_url）。
    搜不到 / 无直链（VIP）/ 下载不完整 → 抛 RuntimeError，由调用方换下一首。
    """
    with _music_client() as client:
        song = _search_song(client, title)
        if not song:
            raise RuntimeError(f"网易云没搜到《{title}》")
        song_name = str(song.get("name") or title)
        artist = str(song.get("artist") or "")
        display = f"{song_name}({artist})" if artist else song_name
        direct_url = _fetch_song_url(client, str(song.get("id") or ""))
        if not direct_url:
            raise RuntimeError(f"《{display}》没有直链（可能要 VIP）")
        with client.stream("GET", direct_url, timeout=120.0) as stream:
            stream.raise_for_status()
            buffer = bytearray()
            for chunk in stream.iter_bytes(64 * 1024):
                buffer.extend(chunk)
    if len(buffer) < 100_000:
        raise RuntimeError(f"《{display}》音源下载不完整")
    return bytes(buffer), display


def _netease_fallback_source(sung: list[str]) -> tuple[str, str, bytes] | None:
    """网易云兜底选歌：从兜底歌单随机挑（跳过已唱），最多试 3 首。

    返回 (歌名, 展示名, 音源字节)；全军覆没返回 None（调用方走"云盘重置一轮"）。
    """
    pool = [t for t in _netease_pool() if f"{_NETEASE_SUNG_PREFIX}{t}" not in sung]
    random.shuffle(pool)
    for title in pool[:_NETEASE_FALLBACK_TRIES]:
        try:
            blob, display = _download_netease_song(title)
            return title, display, blob
        except Exception as exc:
            logger.warning("[daily-cover] netease fallback 《%s》 failed: %s", title, exc)
    return None


def _load_sung() -> list[str]:
    try:
        return list(json.loads(_sung_path().read_text(encoding="utf-8")))
    except Exception:
        return []


def _save_sung(items: list[str]) -> None:
    try:
        _sung_path().write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        logger.exception("[daily-cover] save sung list failed")


def _list_remote_songs() -> list[str]:
    """列云盘音乐夹里的 mp3（返回纯文件名）。"""
    command = [*_ssh_base_args(), f"ls -1 {_ssh_quote(_COVER_MUSIC_DIR)}/*.mp3 2>/dev/null"]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    if completed.returncode != 0:
        raise RuntimeError(f"云盘列表失败：{(completed.stderr or '').strip()[:200]}")
    names = []
    for line in (completed.stdout or "").splitlines():
        name = line.strip().rsplit("/", 1)[-1]
        if name.lower().endswith(".mp3"):
            names.append(name)
    return names


def _download_remote_song(name: str) -> bytes:
    command = [*_ssh_base_args(), f"cat {_ssh_quote(f'{_COVER_MUSIC_DIR}/{name}')}"]
    completed = subprocess.run(command, capture_output=True, timeout=300)
    if completed.returncode != 0 or not completed.stdout:
        raise RuntimeError(f"云盘下载失败：{(completed.stderr or b'').decode('utf-8', 'replace')[:200]}")
    return completed.stdout


def _daily_state_path() -> Path:
    return _COVER_TMP / "daily_cover_state.json"


def _load_daily_state() -> dict:
    try:
        return json.loads(_daily_state_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_daily_state(state: dict) -> None:
    try:
        _daily_state_path().write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    except OSError:
        logger.exception("[daily-cover] save state failed")


def _has_sung_today_in_db(today: str) -> bool:
    """查本地消息库：今天是否已经推送过每日翻唱（request_id=daily-cover-<date>）。

    为什么不只信 state 文件（2026-10-27 实战教训）：手动触发/状态回滚会绕过
    state.done，导致一天唱两首。消息库是"实际推送过"的最终事实，作第二道闸。
    """
    try:
        rows = db.get_recent_messages(limit=100, conversation_id="desktop_pet")
    except Exception:
        logger.exception("[daily-cover] db check failed, fall back to state only")
        return False
    marker = f"daily-cover-{today}"
    for row in rows:
        try:
            rid = str(row["request_id"] or "")
        except (IndexError, KeyError, TypeError):
            continue
        if rid == marker:
            return True
    return False


def _run_daily_cover() -> None:
    """挑一首云盘歌 → 下载 → 走翻唱管线 → 推送。worker 线程调用。

    ★ 开工前最后一道闸：哪怕 state/手动触发路径漏了，只要今天已经推送过
      每日翻唱（消息库有记录），这里直接放弃 —— 保证一天只翻一首。
    """
    started = time.monotonic()
    if _has_sung_today_in_db(today_str()):
        logger.info("[daily-cover] already sung today (db), skip duplicate run")
        return
    try:
        agent_bus_service.emit(FEIYU_AGENT_ID, "voice", {"label": "每日翻唱"}, force=True)
    except Exception:
        pass
    # ---- 选歌：云盘优先；不可达/没歌/全唱完 → 网易云兜底（2026-10-29 用户裁决）----
    songs: list[str] = []
    cloud_error = ""
    try:
        songs = _list_remote_songs()
    except Exception as exc:
        cloud_error = str(exc)[:120]
        logger.warning("[daily-cover] cloud list failed: %s", exc)
    sung = _load_sung()

    def _cloud_display(name: str) -> str:
        return name.rsplit(".", 1)[0].replace("_", " ").strip()

    reset_round = False
    low_stock = False
    source = "cloud"
    pick = ""
    display = ""
    blob = b""
    remaining_cloud = [s for s in songs if s not in sung]

    if songs and remaining_cloud:
        # 云盘还有没唱过的歌：正常路径（库存提醒逻辑不变）
        low_stock = len(remaining_cloud) < _MIN_STOCK_REMAIN
        pick = random.choice(remaining_cloud)
        display = _cloud_display(pick)
    else:
        fallback = _netease_fallback_source(sung)
        if fallback:
            source = "netease"
            pick, display, blob = fallback
            if cloud_error:
                _publish_bubble(f"云盘这会儿连不上（{cloud_error}），我去网易云挑了《{display}》顶上，开练～")
            elif songs:
                _publish_bubble(f"云盘的歌全被我唱完一轮啦，去网易云挑了《{display}》续上～")
            else:
                _publish_bubble(f"云盘《音乐》文件夹还空着，先去网易云挑了《{display}》唱～")
        elif songs:
            # 网易云兜底也全军覆没 → 云盘重置一轮（老行为）
            reset_round = True
            pick = random.choice(songs)
            display = _cloud_display(pick)
        else:
            _publish_bubble("云盘《音乐》文件夹一首歌都没有，网易云兜底歌单也唱完了，快丢几首进云盘让我唱～")
            return

    try:
        agent_bus_service.emit(FEIYU_AGENT_ID, "voice", {"label": f"翻唱《{display}》"}, force=True)
    except Exception:
        pass

    if source == "cloud":
        cache = _cloud_cache_dir() / (hashlib.sha1(pick.encode("utf-8")).hexdigest()[:12] + ".mp3")
        if cache.is_file() and cache.stat().st_size > 100_000:
            blob = cache.read_bytes()
        else:
            _publish_bubble(f"今天去云盘挑了《{display}》，先把伴奏下下来练一练…")
            blob = _download_remote_song(pick)
            try:
                cache.write_bytes(blob)
            except OSError:
                pass
    else:
        # 网易云音源同样做本地缓存（键带 netease: 前缀，与云盘缓存区分）
        cache = _cloud_cache_dir() / ("n" + hashlib.sha1(f"netease:{pick}".encode("utf-8")).hexdigest()[:11] + ".mp3")
        try:
            cache.write_bytes(blob)
        except OSError:
            pass
    source_mp3 = _COVER_TMP / f"daily_{int(time.time())}.mp3"
    source_mp3.write_bytes(blob)

    try:
        cover_blob = _run_pipeline(source_mp3, "daily", _DEFAULT_PITCH, _cover_mode_for(display))
    except Exception as exc:
        logger.exception("[daily-cover] pipeline failed")
        # 失败不直接放弃：瞬时故障（如冷开机 WSL 竞态）30 分钟后自动重试，一天最多 3 次。
        # done 在 tick 里是先写 True 防并发重复触发，这里回滚以重新武装；attempts 防死循环。
        state = _load_daily_state()
        attempts = int(state.get("attempts") or 0) + 1
        from datetime import datetime as _dt
        state["attempts"] = attempts
        if attempts >= 3:
            state["done"] = True
            _save_daily_state(state)
            _publish_bubble(f"今天这首《{display}》唱砸了（{str(exc)[:120]}），明天再战！")
        else:
            state["done"] = False
            state["online_since"] = _dt.now().astimezone().isoformat(timespec="seconds")
            _save_daily_state(state)
            _publish_bubble(f"今天这首《{display}》出了点小状况，我歇 30 分钟再试一次～（第 {attempts}/3 次重试）")
        return

    meta = _save_cover_media(cover_blob, f"{display} · 大肥鱼每日翻唱")
    if low_stock:
        left = len(remaining_cloud) - 1
        bubble_text = f"今天的歌来啦～我翻唱了《{display}》！对了，云盘歌快被我唱完啦（还剩 {left} 首），记得去《音乐》文件夹加歌哦～"
    elif reset_round:
        bubble_text = f"云盘歌全唱完一轮啦，我重新从第一首开始——今天翻唱《{display}》！也可以往《音乐》文件夹丢新歌给我～"
    else:
        bubble_text = f"今天的新歌来啦～我翻唱了《{display}》，听听看！"
    _publish_audio(meta, response_id=f"daily-cover-{today_str()}", text=bubble_text)
    _save_history(bubble_text, meta, f"daily-cover-{today_str()}", "desktop_pet")

    # 已唱去重：云盘记文件名，网易云记 "netease:歌名"（与云盘条目互不干扰）
    sung.append(pick if source == "cloud" else f"{_NETEASE_SUNG_PREFIX}{pick}")
    _save_sung(sung)
    state = _load_daily_state()
    if state.get("date") == today_str():
        state["attempts"] = 0  # 成功即清零重试计数
        _save_daily_state(state)
    try:
        agent_bus_service.emit(FEIYU_AGENT_ID, "complete", force=True)
    except Exception:
        pass
    logger.info("[daily-cover] finished %s in %.0fs", pick, time.monotonic() - started)


def today_str() -> str:
    from datetime import date
    return date.today().isoformat()


def _daily_cover_tick() -> None:
    """每 60s 一拍：桌宠上线满 30 分钟且今天还没唱 → 开唱。"""
    state = _load_daily_state()
    today = today_str()
    if state.get("date") != today:
        state = {"date": today, "online_since": None, "done": False, "attempts": 0}
    if state.get("done"):
        return
    online = pet_event_service.has_desktop_renderer()
    if not online:
        if state.get("online_since"):
            state["online_since"] = None
            _save_daily_state(state)
        return
    if is_busy():
        return
    since = state.get("online_since")
    if not since:
        from datetime import datetime as _dt
        state["online_since"] = _dt.now().astimezone().isoformat(timespec="seconds")
        _save_daily_state(state)
        return
    from datetime import datetime as _dt
    elapsed_min = (_dt.now().astimezone() - _dt.fromisoformat(since)).total_seconds() / 60
    if elapsed_min < _DAILY_DELAY_MINUTES:
        return
    # ★ 第二道闸：消息库里今天已推送过每日翻唱 → 补写 done 并放弃（防手动触发
    #   /状态回滚导致一天两唱，2026-10-27 实战教训）。
    if _has_sung_today_in_db(today):
        state["done"] = True
        _save_daily_state(state)
        logger.info("[daily-cover] db says already sung today, skip trigger")
        return
    state["done"] = True
    _save_daily_state(state)
    logger.info("[daily-cover] trigger (online since %s)", since)
    _publish_bubble("桌宠上线满半小时啦～我去挑首歌翻唱，唱好发你！")
    threading.Thread(target=_run_daily_cover, name="daily-cover", daemon=True).start()


async def daily_cover_loop() -> None:
    while True:
        try:
            _daily_cover_tick()
        except Exception:  # noqa: BLE001 - 常驻循环不能死
            logger.exception("[daily-cover] tick failed")
        await asyncio.sleep(60)
