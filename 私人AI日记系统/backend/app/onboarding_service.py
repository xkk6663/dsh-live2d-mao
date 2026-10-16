"""首次启动的安全默认值 —— **六步质检向导已移除，本模块只剩这一件事**。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DSH 专用化说明（2026-10-17 用户裁决）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
上游把「首次进入」做成了一套六步向导（环境体检 / 隐私说明 / 称呼 /
模型供应商 / 敏感能力开关 / 完成）。那套向导面向**跨 Agent 平台的新用户**
（要选模型供应商、要逐项决定敏感能力），对 **DSH 专用**形态全部无意义 ——
DSH 自带模型与审批策略，能力边界由 DSH 插件线决定。

⇒ 本模块**已删除**的东西（连同对应的入口）：
  - `onboarding_status()` / `complete_onboarding()`（向导的状态与提交）
  - `record_model_verification()` / `_require_verified_model()`（向导的模型验证）
  - `_existing_user_evidence()` / `_load_saved_state()` / `_state_path()`
    / `_write_state()` 与 `首次启动.json` 那套状态文件
  - 路由 `routes/onboarding.py`（`/api/onboarding/*` 三个端点）
  - 前端 `OnboardingPage.vue` / `onboardingApi.js` / `onboardingGates.js`

⇒ **刻意保留**：`prepare_first_launch_defaults()`
  它**不是"向导的一步"**，而是一条**安全默认值**：全新安装时主动关掉
  屏幕观察 / 系统声音 / 游戏观察 / 直接语音，避免"装完就默认偷看屏幕"。

  ⚠ 保留它与本任务目标**不冲突**：用户要删的是"拦路的六步 UI"，
    不是"首次启动的安全兜底"。删掉它会让新装环境**默认开启**屏幕观察，
    那是明显的安全回退。故保留，并维持原语义。
"""
from __future__ import annotations

from .config import settings


def prepare_first_launch_defaults() -> None:
    """全新、未配置的安装 → 把观察类能力默认关掉（安全默认）。

    「全新且未配置」的判据：`companion_config.json` 不存在。

    ⚠ 与上游的差异（有意为之，已核对语义等价）：
      上游判据是 `companion_config_path.exists() or onboarding_status()["completed"]`。
      向导状态文件已删，故这里**只看配置文件是否存在**：
        - 用户配过一次 → 文件在 → 不动他的设置（与上游"completed 就不动"一致）；
        - 全新安装 → 文件不在 → 关掉观察能力（与上游"新用户"分支一致）。
      两种情形行为与上游**完全一致**，只是不再需要一个额外的状态文件。
    """
    if settings.companion_config_path.exists():
        return
    from .companion import companion_service

    companion_service.save_config(
        {
            "screen_ai_enabled": False,
            "screen_audio_enabled": False,
            "screen_direct_voice_enabled": False,
            "speak_screen_observations": False,
            "speak_game_observations": False,
        }
    )
