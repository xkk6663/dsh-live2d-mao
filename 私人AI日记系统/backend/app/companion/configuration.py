"""Companion configuration; dependencies are explicitly injected."""
from __future__ import annotations

from typing import Any, Callable
from pathlib import Path
import json
import re
import time


class ConfigurationService:
    """Domain implementation; constructor callbacks preserve facade test seams."""

    def __init__(self, *,
                 dep_DEFAULT_CONFIG: Callable[..., Any],
                 dep_LIVE2D_EXPRESSION_SLOT_IDS: Callable[..., Any],
                 dep_LIVE2D_MOTION_SLOT_IDS: Callable[..., Any],
                 dep_LIVE2D_PHASE_IDS: Callable[..., Any],
                 dep__live2d_model_ids: Callable[..., Any],
                 dep_settings: Callable[..., Any],
                 ) -> None:
        self._dep_DEFAULT_CONFIG = dep_DEFAULT_CONFIG
        self._dep_LIVE2D_EXPRESSION_SLOT_IDS = dep_LIVE2D_EXPRESSION_SLOT_IDS
        self._dep_LIVE2D_MOTION_SLOT_IDS = dep_LIVE2D_MOTION_SLOT_IDS
        self._dep_LIVE2D_PHASE_IDS = dep_LIVE2D_PHASE_IDS
        self._dep__live2d_model_ids = dep__live2d_model_ids
        self._dep_settings = dep_settings

    def _migrate_config(self, data: dict[str, Any]) -> dict[str, Any]:
        migrated = dict(data)
        try:
            schema_version = int(migrated.get("config_schema_version") or 1)
        except (TypeError, ValueError):
            schema_version = 1
        if schema_version < 2:
            try:
                legacy_screen_timeout = int(migrated.get("screen_request_timeout_seconds", 12))
            except (TypeError, ValueError):
                legacy_screen_timeout = 12
            if legacy_screen_timeout == 12:
                migrated["screen_request_timeout_seconds"] = 25
        migrated["config_schema_version"] = 2
        return migrated

    def _normalize_live2d_motion_slots(self, value: object) -> dict[str, dict[str, str]]:
        if not isinstance(value, dict):
            return {}
        normalized: dict[str, dict[str, str]] = {}
        for raw_model_id, raw_slots in list(value.items())[:30]:
            model_id = str(raw_model_id or "").strip()[:100]
            if not model_id or not isinstance(raw_slots, dict):
                continue
            slots: dict[str, str] = {}
            for raw_slot, raw_group in raw_slots.items():
                slot = str(raw_slot or "").strip().lower()
                group = str(raw_group or "").strip()[:120]
                if slot in self._dep_LIVE2D_MOTION_SLOT_IDS() and group:
                    slots[slot] = group
            if slots:
                normalized[model_id] = slots
        return normalized

    def _normalize_ui_theme(self, value: object) -> str:
        """全局 UI 主题 id 白名单。

        必须与前端 `App.vue` 的 `THEME_OPTIONS` 以及 `companion.css` 的
        `.app-shell.theme-*` 三处保持一致：这里拦掉脏值，前端才不会挂上一个
        不存在的 class（表现为"主题保存了但没生效"，很难查）。
        """
        allowed = {
            "mist", "clear", "rose", "forest", "sakura", "celadon", "amber",
            # ★ 2026-10-19 AI 娘配色五款 + 自定义（与 App.vue THEME_OPTIONS 同步）
            "whale", "miku", "neuro", "qwen", "doubao", "custom",
        }
        theme = str(value or "").strip().lower()
        return theme if theme in allowed else "mist"

    @staticmethod
    def _normalize_hex_color(value: object, fallback: str) -> str:
        """自定义主题三色的十六进制校验（#rrggbb）。脏值回落默认，不让前端挂上非法 CSS。"""
        text = str(value or "").strip()
        return text if re.fullmatch(r"#[0-9a-fA-F]{6}", text) else fallback

    def _normalize_live2d_expression_slots(self, value: object) -> dict[str, dict[str, str]]:
        if not isinstance(value, dict):
            return {}
        normalized: dict[str, dict[str, str]] = {}
        for raw_model_id, raw_slots in list(value.items())[:30]:
            model_id = str(raw_model_id or "").strip()[:100]
            if not model_id or not isinstance(raw_slots, dict):
                continue
            slots: dict[str, str] = {}
            for raw_slot, raw_expression in raw_slots.items():
                slot = str(raw_slot or "").strip().lower()
                expression = str(raw_expression or "").strip()[:120]
                if slot in self._dep_LIVE2D_EXPRESSION_SLOT_IDS() and expression:
                    slots[slot] = expression
            if slots:
                normalized[model_id] = slots
        return normalized

    def _normalize_live2d_phase_slots(self, value: object) -> dict[str, dict[str, dict[str, str]]]:
        """任务状态（phase）→ 表现绑定：{模型id: {phase: {"motion": 槽名, "expression": 槽名}}}。

        与 motion/expression 槽位的区别：这里存的是**槽名**而不是具体动作/表情名。
        这样同一个状态换模型时不用重配，且渲染端仍然走槽位解析（模型级默认 → 用户覆盖）。
        """
        if not isinstance(value, dict):
            return {}
        motion_slots = self._dep_LIVE2D_MOTION_SLOT_IDS()
        expression_slots = self._dep_LIVE2D_EXPRESSION_SLOT_IDS()
        phases = self._dep_LIVE2D_PHASE_IDS()
        normalized: dict[str, dict[str, dict[str, str]]] = {}
        for raw_model_id, raw_phases in list(value.items())[:30]:
            model_id = str(raw_model_id or "").strip()[:100]
            if not model_id or not isinstance(raw_phases, dict):
                continue
            per_model: dict[str, dict[str, str]] = {}
            for raw_phase, raw_binding in list(raw_phases.items())[:20]:
                phase = str(raw_phase or "").strip().lower()
                if phase not in phases or not isinstance(raw_binding, dict):
                    continue
                motion = str(raw_binding.get("motion") or "").strip().lower()[:60]
                expression = str(raw_binding.get("expression") or "").strip().lower()[:60]
                binding: dict[str, str] = {}
                if motion in motion_slots:
                    binding["motion"] = motion
                if expression in expression_slots:
                    binding["expression"] = expression
                if binding:
                    per_model[phase] = binding
            if per_model:
                normalized[model_id] = per_model
        return normalized

    def load_config(self) -> dict[str, Any]:
        data = dict(self._dep_DEFAULT_CONFIG())
        try:
            saved = json.loads(self._dep_settings().companion_config_path.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                data.update(self._migrate_config(saved))
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        data["voice_enabled"] = bool(data.get("voice_enabled", True))
        data["voice_volume"] = max(0, min(100, int(data.get("voice_volume", 85))))
        data["voice_streaming_enabled"] = bool(data.get("voice_streaming_enabled", True))
        pet_speech_language = str(data.get("pet_speech_language") or "zh").strip().lower()
        data["pet_speech_language"] = pet_speech_language if pet_speech_language in {"zh", "ja"} else "zh"
        data["speak_screen_observations"] = bool(data.get("speak_screen_observations", True))
        data["speak_game_observations"] = bool(data.get("speak_game_observations", True))
        data["screen_ai_enabled"] = bool(data.get("screen_ai_enabled", True))
        data["screen_audio_enabled"] = bool(data.get("screen_audio_enabled", True))
        screen_audio_model = str(data.get("screen_audio_model") or "base").strip().lower()
        data["screen_audio_model"] = screen_audio_model if screen_audio_model in {"tiny", "base", "small"} else "base"
        screen_audio_language = str(data.get("screen_audio_language") or "auto").strip().lower()
        data["screen_audio_language"] = screen_audio_language if screen_audio_language in {"auto", "zh", "ja", "en"} else "auto"
        data["screen_audio_chunk_seconds"] = max(4, min(15, int(data.get("screen_audio_chunk_seconds", 5))))
        screen_vision_route = str(data.get("screen_vision_route") or "local").strip().lower()
        data["screen_vision_route"] = screen_vision_route if screen_vision_route in {"local", "cloud"} else "local"
        data["screen_vision_model_id"] = (
            str(data.get("screen_vision_model_id") or "auto-fast").strip()[:200] or "auto-fast"
        )
        data["screen_direct_voice_enabled"] = bool(data.get("screen_direct_voice_enabled", True))
        data["screen_change_threshold"] = max(1.0, min(50.0, float(data.get("screen_change_threshold", 4.0))))
        data["screen_analysis_interval_seconds"] = max(5, min(600, int(data.get("screen_analysis_interval_seconds", 5))))
        data["screen_request_timeout_seconds"] = max(5, min(60, int(data.get("screen_request_timeout_seconds", 25))))
        data["screen_voice_cooldown_seconds"] = max(5, min(600, int(data.get("screen_voice_cooldown_seconds", 5))))
        data["screen_minimum_importance"] = max(0.1, min(1.0, float(data.get("screen_minimum_importance", 0.62))))
        data["screen_daily_cost_limit_yuan"] = max(0.1, min(1000.0, float(data.get("screen_daily_cost_limit_yuan", 5.0))))
        call_asr_engine = str(data.get("pet_call_asr_engine") or "auto").strip().lower()
        data["pet_call_asr_engine"] = (
            call_asr_engine if call_asr_engine in {"auto", "whisper", "sensevoice", "paraformer"} else "auto"
        )
        call_language = str(data.get("pet_call_input_language") or "zh").strip().lower()
        data["pet_call_input_language"] = "ja" if call_language == "ja" else "zh"
        data["pet_call_silence_ms"] = max(350, min(1800, int(data.get("pet_call_silence_ms", 650))))
        data["pet_call_voice_threshold"] = max(0.004, min(0.12, float(data.get("pet_call_voice_threshold", 0.018))))
        data["pet_call_min_speech_ms"] = max(150, min(1500, int(data.get("pet_call_min_speech_ms", 280))))
        data["pet_call_max_turn_seconds"] = max(5, min(45, int(data.get("pet_call_max_turn_seconds", 18))))
        data["bubble_seconds"] = max(3, min(30, int(data.get("bubble_seconds", 9))))
        data["pet_size_percent"] = max(80, min(240, int(data.get("pet_size_percent", 150))))
        # 公开版只保留 Live2D 桌宠形象：历史数据里的静态立绘模式统一迁移。
        pet_renderer = str(data.get("pet_renderer") or "live2d").strip().lower()
        data["pet_renderer"] = "live2d" if pet_renderer in {"classic", "live2d"} else "live2d"
        live2d_model_id = str(data.get("live2d_model_id") or "hiyori").strip().lower()
        available_model_ids = self._dep__live2d_model_ids()
        data["live2d_model_id"] = live2d_model_id if live2d_model_id in available_model_ids else "hiyori"
        data["live2d_scale"] = max(0.65, min(1.55, float(data.get("live2d_scale", 1.0))))
        data["live2d_vertical_offset"] = max(-0.35, min(0.35, float(data.get("live2d_vertical_offset", 0.0))))
        data["live2d_follow_cursor"] = bool(data.get("live2d_follow_cursor", True))
        data["live2d_idle_motion"] = bool(data.get("live2d_idle_motion", True))
        data["live2d_click_motion"] = bool(data.get("live2d_click_motion", True))
        data["live2d_smart_passthrough"] = bool(data.get("live2d_smart_passthrough", True))
        data["live2d_click_through_locked"] = bool(data.get("live2d_click_through_locked", False))
        data["live2d_speech_bubble_enabled"] = bool(data.get("live2d_speech_bubble_enabled", True))
        data["live2d_keep_visible"] = bool(data.get("live2d_keep_visible", False))
        data["live2d_clamp_to_workarea"] = bool(data.get("live2d_clamp_to_workarea", False))
        data["live2d_always_on_top"] = bool(data.get("live2d_always_on_top", True))
        data["live2d_disable_gpu"] = bool(data.get("live2d_disable_gpu", False))
        data["live2d_motion_slots"] = self._normalize_live2d_motion_slots(data.get("live2d_motion_slots"))
        data["live2d_expression_slots"] = self._normalize_live2d_expression_slots(data.get("live2d_expression_slots"))
        data["live2d_phase_slots"] = self._normalize_live2d_phase_slots(data.get("live2d_phase_slots"))
        # A 档：桌宠"生命感"设置（区间收敛，防脏值把桌宠刷屏/静音）
        data["pet_sound_enabled"] = bool(data.get("pet_sound_enabled", True))
        data["pet_sound_volume"] = max(0, min(100, int(data.get("pet_sound_volume", 70))))
        data["pet_idle_talk_enabled"] = bool(data.get("pet_idle_talk_enabled", True))
        data["pet_idle_talk_min_seconds"] = max(30, min(3600, int(data.get("pet_idle_talk_min_seconds", 90))))
        data["pet_idle_talk_max_seconds"] = max(30, min(7200, int(data.get("pet_idle_talk_max_seconds", 240))))
        data["pet_idle_beat_enabled"] = bool(data.get("pet_idle_beat_enabled", True))
        data["pet_idle_beat_min_seconds"] = max(8, min(1800, int(data.get("pet_idle_beat_min_seconds", 30))))
        data["pet_idle_beat_max_seconds"] = max(8, min(3600, int(data.get("pet_idle_beat_max_seconds", 90))))
        data["pet_quotes_enabled"] = bool(data.get("pet_quotes_enabled", True))
        data["pet_talkativeness"] = max(0, min(100, int(data.get("pet_talkativeness", 45))))
        data["pet_poke_enabled"] = bool(data.get("pet_poke_enabled", True))
        data["ui_theme"] = self._normalize_ui_theme(data.get("ui_theme"))
        # 自定义主题三色（theme === 'custom' 时桌宠皮肤「跟随主题」的取色来源）
        data["ui_theme_custom_bg"] = self._normalize_hex_color(data.get("ui_theme_custom_bg"), "#e9eef0")
        data["ui_theme_custom_accent"] = self._normalize_hex_color(data.get("ui_theme_custom_accent"), "#4c8798")
        data["ui_theme_custom_ink"] = self._normalize_hex_color(data.get("ui_theme_custom_ink"), "#20303a")
        # 上下限防倒挂：max 必须 >= min，否则随机区间会抛错
        if data["pet_idle_talk_max_seconds"] < data["pet_idle_talk_min_seconds"]:
            data["pet_idle_talk_max_seconds"] = data["pet_idle_talk_min_seconds"]
        if data["pet_idle_beat_max_seconds"] < data["pet_idle_beat_min_seconds"]:
            data["pet_idle_beat_max_seconds"] = data["pet_idle_beat_min_seconds"]
        data["pet_press_bounce_enabled"] = bool(data.get("pet_press_bounce_enabled", True))
        data["position_x"] = max(-10000, min(10000, int(data.get("position_x", 80))))
        data["position_y"] = max(-10000, min(10000, int(data.get("position_y", 420))))
        return data

    def save_config(self, changes: dict[str, Any]) -> dict[str, Any]:
        data = self.load_config()
        for key in self._dep_DEFAULT_CONFIG():
            if key in changes:
                data[key] = changes[key]
        # 额外业务字段（如 live2d_model_schedule）不在默认配置键表，也必须写入，
        # 否则"自动更换/时间/模式"等设置保存后会被静默丢弃、回默认值
        for key in changes:
            if key not in self._dep_DEFAULT_CONFIG():
                data[key] = changes[key]
        normalized = self.load_normalized_config(data)
        known_keys = set(self._dep_DEFAULT_CONFIG())
        # 保留默认配置键 + 配置中已存在的额外键（如 live2d_model_schedule），
        # 避免新增业务字段在保存时被过滤器丢弃导致"设置保存不了、回默认值"
        extra_keys = {key for key in data if key not in known_keys}
        data = {
            key: value
            for key, value in normalized.items()
            if key in known_keys or key in extra_keys
        }
        self._dep_settings().companion_dir.mkdir(parents=True, exist_ok=True)
        target = self._dep_settings().companion_config_path
        payload = json.dumps(data, ensure_ascii=False, indent=2)

        # ★ Windows 文件占用问题（2026-10-22 后端日志两轮踩到）：
        #   ① `temporary.write_text(...)`  → PermissionError [Errno 13] Permission denied
        #   ② `temporary.replace(target)`   → PermissionError [WinError 32] 另一个程序正在使用此文件
        #   杀毒/搜索索引器/编辑器持有句柄时都会这样，且**随机出现**，
        #   表现为"改设置偶尔失败 500"，界面上完全看不出是文件锁。
        #   所以：**写入、替换、回退直写 三步全部带重试**，任何一步都能扛过一次瞬时占用。
        def _retry(fn, attempts: int = 8):
            last: Exception | None = None
            for i in range(attempts):
                try:
                    return fn()
                except OSError as exc:  # PermissionError 是 OSError 子类
                    last = exc
                    time.sleep(0.04 * (i + 1))
            raise last  # type: ignore[misc]

        def _atomic_write() -> None:
            temporary = target.with_suffix(".tmp")
            # 写临时文件也要重试（否则一次占用就整条保存失败）
            _retry(lambda: temporary.write_text(payload, encoding="utf-8"))
            # 替换：仍被占用就删掉临时文件直接写目标（牺牲原子性，但必须能存下）
            try:
                _retry(lambda: temporary.replace(target))
            except OSError:
                _retry(lambda: target.write_text(payload, encoding="utf-8"))
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

        _atomic_write()
        # 域分层后 pet_event_service 与配置同属 companion 域，
        # 旧的 `from .. import pet_event_service`（按"还在 app/ 顶层"写的）会
        # ImportError —— 表现为**所有设置写入都 500**，但读取正常，很难一眼看出。
        from . import pet_event_service

        pet_event_service.publish("settings_changed", data)
        return data

    def load_normalized_config(self, data: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(self._dep_DEFAULT_CONFIG())
        normalized.update(self._migrate_config(data))
        normalized["voice_enabled"] = bool(normalized.get("voice_enabled", True))
        normalized["voice_volume"] = max(0, min(100, int(normalized.get("voice_volume", 85))))
        normalized["voice_streaming_enabled"] = bool(normalized.get("voice_streaming_enabled", True))
        pet_speech_language = str(normalized.get("pet_speech_language") or "zh").strip().lower()
        normalized["pet_speech_language"] = pet_speech_language if pet_speech_language in {"zh", "ja"} else "zh"
        normalized["speak_screen_observations"] = bool(normalized.get("speak_screen_observations", True))
        normalized["speak_game_observations"] = bool(normalized.get("speak_game_observations", True))
        normalized["screen_ai_enabled"] = bool(normalized.get("screen_ai_enabled", True))
        normalized["screen_audio_enabled"] = bool(normalized.get("screen_audio_enabled", True))
        screen_audio_model = str(normalized.get("screen_audio_model") or "base").strip().lower()
        normalized["screen_audio_model"] = screen_audio_model if screen_audio_model in {"tiny", "base", "small"} else "base"
        screen_audio_language = str(normalized.get("screen_audio_language") or "auto").strip().lower()
        normalized["screen_audio_language"] = screen_audio_language if screen_audio_language in {"auto", "zh", "ja", "en"} else "auto"
        normalized["screen_audio_chunk_seconds"] = max(4, min(15, int(normalized.get("screen_audio_chunk_seconds", 5))))
        screen_vision_route = str(normalized.get("screen_vision_route") or "local").strip().lower()
        normalized["screen_vision_route"] = screen_vision_route if screen_vision_route in {"local", "cloud"} else "local"
        normalized["screen_vision_model_id"] = (
            str(normalized.get("screen_vision_model_id") or "auto-fast").strip()[:200] or "auto-fast"
        )
        normalized["screen_direct_voice_enabled"] = bool(normalized.get("screen_direct_voice_enabled", True))
        normalized["screen_change_threshold"] = max(1.0, min(50.0, float(normalized.get("screen_change_threshold", 4.0))))
        normalized["screen_analysis_interval_seconds"] = max(5, min(600, int(normalized.get("screen_analysis_interval_seconds", 5))))
        normalized["screen_request_timeout_seconds"] = max(5, min(60, int(normalized.get("screen_request_timeout_seconds", 25))))
        normalized["screen_voice_cooldown_seconds"] = max(5, min(600, int(normalized.get("screen_voice_cooldown_seconds", 5))))
        normalized["screen_minimum_importance"] = max(0.1, min(1.0, float(normalized.get("screen_minimum_importance", 0.62))))
        normalized["screen_daily_cost_limit_yuan"] = max(0.1, min(1000.0, float(normalized.get("screen_daily_cost_limit_yuan", 5.0))))
        call_asr_engine = str(normalized.get("pet_call_asr_engine") or "auto").strip().lower()
        normalized["pet_call_asr_engine"] = (
            call_asr_engine if call_asr_engine in {"auto", "whisper", "sensevoice", "paraformer"} else "auto"
        )
        call_language = str(normalized.get("pet_call_input_language") or "zh").strip().lower()
        normalized["pet_call_input_language"] = "ja" if call_language == "ja" else "zh"
        normalized["pet_call_silence_ms"] = max(350, min(1800, int(normalized.get("pet_call_silence_ms", 650))))
        normalized["pet_call_voice_threshold"] = max(0.004, min(0.12, float(normalized.get("pet_call_voice_threshold", 0.018))))
        normalized["pet_call_min_speech_ms"] = max(150, min(1500, int(normalized.get("pet_call_min_speech_ms", 280))))
        normalized["pet_call_max_turn_seconds"] = max(5, min(45, int(normalized.get("pet_call_max_turn_seconds", 18))))
        normalized["bubble_seconds"] = max(3, min(30, int(normalized.get("bubble_seconds", 9))))
        normalized["pet_size_percent"] = max(80, min(240, int(normalized.get("pet_size_percent", 150))))
        pet_renderer = str(normalized.get("pet_renderer") or "live2d").strip().lower()
        normalized["pet_renderer"] = "live2d" if pet_renderer in {"classic", "live2d"} else "live2d"
        live2d_model_id = str(normalized.get("live2d_model_id") or "hiyori").strip().lower()
        available_model_ids = self._dep__live2d_model_ids()
        normalized["live2d_model_id"] = live2d_model_id if live2d_model_id in available_model_ids else "hiyori"
        normalized["live2d_scale"] = max(0.65, min(1.55, float(normalized.get("live2d_scale", 1.0))))
        normalized["live2d_vertical_offset"] = max(-0.35, min(0.35, float(normalized.get("live2d_vertical_offset", 0.0))))
        normalized["live2d_follow_cursor"] = bool(normalized.get("live2d_follow_cursor", True))
        normalized["live2d_idle_motion"] = bool(normalized.get("live2d_idle_motion", True))
        normalized["live2d_click_motion"] = bool(normalized.get("live2d_click_motion", True))
        normalized["live2d_smart_passthrough"] = bool(normalized.get("live2d_smart_passthrough", True))
        normalized["live2d_click_through_locked"] = bool(normalized.get("live2d_click_through_locked", False))
        normalized["live2d_speech_bubble_enabled"] = bool(normalized.get("live2d_speech_bubble_enabled", True))
        normalized["live2d_keep_visible"] = bool(normalized.get("live2d_keep_visible", False))
        normalized["live2d_clamp_to_workarea"] = bool(normalized.get("live2d_clamp_to_workarea", False))
        normalized["live2d_always_on_top"] = bool(normalized.get("live2d_always_on_top", True))
        normalized["live2d_disable_gpu"] = bool(normalized.get("live2d_disable_gpu", False))
        normalized["live2d_motion_slots"] = self._normalize_live2d_motion_slots(normalized.get("live2d_motion_slots"))
        normalized["live2d_expression_slots"] = self._normalize_live2d_expression_slots(normalized.get("live2d_expression_slots"))
        normalized["live2d_phase_slots"] = self._normalize_live2d_phase_slots(normalized.get("live2d_phase_slots"))
        normalized["pet_sound_enabled"] = bool(normalized.get("pet_sound_enabled", True))
        normalized["pet_sound_volume"] = max(0, min(100, int(normalized.get("pet_sound_volume", 70))))
        normalized["pet_idle_talk_enabled"] = bool(normalized.get("pet_idle_talk_enabled", True))
        normalized["pet_idle_talk_min_seconds"] = max(30, min(3600, int(normalized.get("pet_idle_talk_min_seconds", 90))))
        normalized["pet_idle_talk_max_seconds"] = max(30, min(7200, int(normalized.get("pet_idle_talk_max_seconds", 240))))
        normalized["pet_idle_beat_enabled"] = bool(normalized.get("pet_idle_beat_enabled", True))
        normalized["pet_idle_beat_min_seconds"] = max(8, min(1800, int(normalized.get("pet_idle_beat_min_seconds", 30))))
        normalized["pet_idle_beat_max_seconds"] = max(8, min(3600, int(normalized.get("pet_idle_beat_max_seconds", 90))))
        normalized["pet_quotes_enabled"] = bool(normalized.get("pet_quotes_enabled", True))
        normalized["pet_talkativeness"] = max(0, min(100, int(normalized.get("pet_talkativeness", 45))))
        normalized["pet_poke_enabled"] = bool(normalized.get("pet_poke_enabled", True))
        normalized["ui_theme"] = self._normalize_ui_theme(normalized.get("ui_theme"))
        normalized["ui_theme_custom_bg"] = self._normalize_hex_color(normalized.get("ui_theme_custom_bg"), "#e9eef0")
        normalized["ui_theme_custom_accent"] = self._normalize_hex_color(normalized.get("ui_theme_custom_accent"), "#4c8798")
        normalized["ui_theme_custom_ink"] = self._normalize_hex_color(normalized.get("ui_theme_custom_ink"), "#20303a")
        if normalized["pet_idle_talk_max_seconds"] < normalized["pet_idle_talk_min_seconds"]:
            normalized["pet_idle_talk_max_seconds"] = normalized["pet_idle_talk_min_seconds"]
        if normalized["pet_idle_beat_max_seconds"] < normalized["pet_idle_beat_min_seconds"]:
            normalized["pet_idle_beat_max_seconds"] = normalized["pet_idle_beat_min_seconds"]
        normalized["pet_press_bounce_enabled"] = bool(normalized.get("pet_press_bounce_enabled", True))
        normalized["position_x"] = max(-10000, min(10000, int(normalized.get("position_x", 80))))
        normalized["position_y"] = max(-10000, min(10000, int(normalized.get("position_y", 420))))
        return normalized

    def save_pet_position(self, x: int, y: int) -> dict[str, Any]:
        return self.save_config({"position_x": x, "position_y": y})

    def save_pet_size(self, percent: int) -> dict[str, Any]:
        return self.save_config({"pet_size_percent": percent})
