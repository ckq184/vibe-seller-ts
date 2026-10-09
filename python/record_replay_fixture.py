"""录制流量回放契约测试的 fixture（批次 4.7.2）。

用参考仓库 venv 运行（本仓库不带 Python 运行时）：

    D:/CKQ/workplace/_reference/vibe-seller-src/.venv/Scripts/python.exe python/record_replay_fixture.py

进程内拉起**原 FastAPI app**（httpx ASGITransport + lifespan，模式取自原仓库
tests/workflow/conftest.py），按「路由家族 × 成功/错误形状」走一条固定序列，
把每步 {name, method, path, body, status, json} 写入
packages/server/test/fixtures/replay/traffic.jsonl（提交进仓库）。

环境隔离（与回放侧共有的确定性来源）：
  - 全新 tmp VIBE_HOME / LOG_DIR（幂等：每次运行全新目录，绝不碰真实 ~/.vibe-seller）；
  - VIBE_SELLER_TELEMETRY=0（telemetry.init 不建客户端，不发真网）；
  - 固定 JWT_SECRET（Fernet 加密字段虽不进响应，仍避免随机性）；
  - 已知 ADMIN_USERNAME/ADMIN_PASSWORD；清除全部 CI 变量（门控链行为分叉源）。

录制期 monkeypatch（只关「排除面」，不改任何端点契约，见 PRD §4.1 排除清单）：
  - knowledge/skills 本地包同步 → no-op。原实现从 pip 源树拷贝 knowledge/skills
    文件进 workspace，TS 运行时没有源树（诚实 synced:false）——这是打包环境差异
    而非 API 契约，记录期对齐成 TS 的现实（无本地包），workspace 树/同步端点才可比。
  - workspace.ensure_shared_venv → no-op（后台 uv 子进程与 API 契约无关）。
  - schedule_or_run → no-op：agent 执行类与 SSE 长流排除录制（PRD §4.1）。
    任务创建统一 defer_start=true；schedule 创建的规划任务因此停在 PENDING
    （不设计、不 fire——seed 用 interval 10080 分钟的远期触发同样保证窗口内不 fire）。

占位符约定：序列中的 path/body 直接写 {{逻辑名}}；capture 字段声明
「逻辑名 → 响应 JSON 里的取值路径」；回放侧（replay.test.ts）用 TS 自己的响应
按同一 capture 路径解析填充。响应 JSON 原样保存，占位符只出现在请求里。
"""

from __future__ import annotations

import asyncio
from datetime import datetime
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / 'packages' / 'server' / 'test' / 'fixtures' / 'replay' / 'traffic.jsonl'

# ── 环境隔离：必须在 import app.* 之前设置（app.config 在 import 时读 env） ──

_TMP = Path(tempfile.mkdtemp(prefix='vibe-record-'))
(VIBE_HOME := _TMP / 'home').mkdir()
(LOG_DIR := _TMP / 'logs').mkdir()

os.environ['VIBE_HOME'] = str(VIBE_HOME)
os.environ['LOG_DIR'] = str(LOG_DIR)
os.environ['VIBE_SELLER_TELEMETRY'] = '0'
os.environ['JWT_SECRET'] = 'record-replay-fixed-secret'
os.environ['ADMIN_USERNAME'] = 'admin'
os.environ['ADMIN_EMAIL'] = 'admin@vibe-seller.local'
os.environ['ADMIN_PASSWORD'] = 'admin'
# 门控链的 CI 检测：任何一个非空都会让 telemetry 静默，录制与回放必须同态
for _ci in ('CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'GITLAB_CI', 'CIRCLECI', 'JENKINS_URL'):
    os.environ.pop(_ci, None)
# 隔离可能的本地开发环境变量
for _legacy in ('VIBE_DEMO_MODE', 'MOCK_CLI', 'BACKEND_PORT'):
    os.environ.pop(_legacy, None)
# 契约对齐决定：原实现首启 auth_required 种子跟随 VIBE_AUTH_REQUIRED env
# （默认 false → 无 token 落默认 admin）；TS 侧 seed 固定 'true'（契约测试钉死）。
# 录制采用 auth-on 环境与 TS 种子同态，且 401/403 守卫面才可比。
os.environ['VIBE_AUTH_REQUIRED'] = '1'

from httpx import ASGITransport, AsyncClient  # noqa: E402


async def _noop_async(*_args, **_kwargs):
    return None


async def _noop_sync_false(*_args, **_kwargs):
    return False


def _patch_for_recording() -> None:
    """只关排除面（agent 执行 / 打包环境差异），见模块 docstring。"""
    # 1) 本地包同步：原实现有 pip 源树会拷文件，TS 没有 → 记录期对齐 TS 现实
    from app.workspace.knowledge_sync import knowledge_sync
    from app.workspace.skills_sync import skills_sync

    async def _no_local_fetch(*_a, **_k):
        return {'synced': False, 'reason': 'No knowledge/ in installed package'}

    knowledge_sync.fetch = _no_local_fetch
    skills_sync.fetch = _no_local_fetch

    # 2) 共享 agent venv：后台 uv 子进程与 API 契约无关
    from app.workspace.manager import workspace_manager

    workspace_manager.ensure_shared_venv = _noop_async

    # 3) agent 执行排除：所有 schedule_or_run import 点 → no-op
    import app.routers.schedule_planning as schedule_planning
    import app.routers.schedules as schedules_mod
    import app.routers.tasks as tasks_mod
    import app.task_launch as task_launch

    task_launch.schedule_or_run = _noop_sync_false
    schedule_planning.schedule_or_run = _noop_sync_false
    schedules_mod.schedule_or_run = _noop_sync_false
    tasks_mod.schedule_or_run = _noop_sync_false

    # 4) 外部 ~/.claude/settings.json 覆盖检测：录制机的真实 ~/.claude 有
    #    ANTHROPIC_* 覆盖会让 profile 创建 409（external_config_override）。
    #    TS 运行时该路径不存在（external_config no-op，批次 4.5 已记录），
    #    记录期把检测路径指到空 tmp，与 TS 现实同态。
    import app.ai.external_config as external_config

    external_config.claude_settings_path = (
        lambda: VIBE_HOME / 'claude-settings-does-not-exist.json'
    )

    # 5) 同间隔系统作业的 next_run 平手次序：APScheduler 运行中 add_job 经事件
    #    循环异步落库，1 分钟组（stall/idle/finalize）两次录制顺序会翻转（实测）。
    #    给 interval 触发注入按注册序单调递增的 start_date，next_run 平手即按
    #    start_scheduler 的调用顺序稳定（cron.py:58-64）；TS 侧 insertion-order
    #    平手 + 相同注册顺序与之对齐。
    from datetime import timedelta, timezone as _tz

    import app.scheduler.cron as cron_mod

    _orig_add_job = cron_mod.scheduler.add_job
    _base = datetime.now(_tz.utc)
    _seq = {'n': 0}

    def _deterministic_add_job(*args, **kwargs):
        trigger = args[1] if len(args) > 1 else kwargs.get('trigger')
        if trigger == 'interval' and 'start_date' not in kwargs:
            kwargs['start_date'] = _base + timedelta(milliseconds=10 * _seq['n'])
            _seq['n'] += 1
        return _orig_add_job(*args, **kwargs)

    cron_mod.scheduler.add_job = _deterministic_add_job


from app.main import app  # noqa: E402

_patch_for_recording()

# ── 序列定义 ──
# auth: 'admin'（缺省，带 admin cookie）| 'member' | 'none' | 'bad'（坏 token）
# capture: {逻辑名: jsonpath}（jsonpath = 点分隔键 + 数组下标）
# settle_ms: 发送前等待（等后台异步落地，录制与回放两侧都执行同一等待）

FAKE = '00000000-0000-0000-0000-0000000000fa'  # 不存在的资源 id（404 守卫）

STEPS: list[dict] = [
    # ── main 直定义面 ──
    {'name': 'health', 'method': 'GET', 'path': '/api/health'},
    {'name': 'version', 'method': 'GET', 'path': '/api/version'},
    {'name': 'plugins', 'method': 'GET', 'path': '/api/plugins'},
    {'name': 'system_info', 'method': 'GET', 'path': '/api/system/info'},
    {'name': 'system_update_check', 'method': 'GET', 'path': '/api/system/update-check'},
    # ── auth 家族 ──
    {'name': 'auth_status_anon', 'method': 'GET', 'path': '/api/auth/status', 'auth': 'none'},
    {'name': 'login_wrong_password', 'method': 'POST', 'path': '/api/auth/login', 'auth': 'none',
     'body': {'identifier': 'admin', 'password': 'nope'}},
    {'name': 'login_ai_bot_rejected', 'method': 'POST', 'path': '/api/auth/login', 'auth': 'none',
     'body': {'identifier': 'ai_bot', 'password': 'x'}},
    {'name': 'me_no_token', 'method': 'GET', 'path': '/api/auth/me', 'auth': 'none'},
    {'name': 'me_bad_token', 'method': 'GET', 'path': '/api/auth/me', 'auth': 'bad'},
    {'name': 'login_admin', 'method': 'POST', 'path': '/api/auth/login', 'auth': 'none',
     'body': {'identifier': 'admin', 'password': 'admin'}, 'cookie_user': 'admin'},
    {'name': 'me_admin', 'method': 'GET', 'path': '/api/auth/me'},
    {'name': 'auth_refresh', 'method': 'POST', 'path': '/api/auth/refresh'},
    {'name': 'debug_mode_on', 'method': 'PATCH', 'path': '/api/auth/me/debug-mode',
     'body': {'debug_mode': True}},
    {'name': 'password_wrong_current', 'method': 'PATCH', 'path': '/api/auth/me/password',
     'body': {'current_password': 'wrong', 'new_password': 'admin2'}},
    {'name': 'password_missing_current_400', 'method': 'PATCH', 'path': '/api/auth/me/password',
     'body': {'new_password': 'admin2'}},
    {'name': 'profile_patch', 'method': 'PATCH', 'path': '/api/auth/me/profile',
     'body': {'plan_mode_default': True}},
    {'name': 'logout', 'method': 'POST', 'path': '/api/auth/logout', 'auth': 'none'},
    {'name': 'login_admin_again', 'method': 'POST', 'path': '/api/auth/login', 'auth': 'none',
     'body': {'identifier': 'admin', 'password': 'admin'}, 'cookie_user': 'admin'},
    # ── telemetry 家族 ──
    {'name': 'locale_zh', 'method': 'POST', 'path': '/api/telemetry/locale',
     'body': {'locale': 'zh'}},
    {'name': 'locale_unknown_coerced', 'method': 'POST', 'path': '/api/telemetry/locale',
     'body': {'locale': 'fr'}},
    {'name': 'locale_too_long_422', 'method': 'POST', 'path': '/api/telemetry/locale',
     'body': {'locale': 'x' * 20}},
    # ── settings 家族 ──
    {'name': 'settings_get_defaults', 'method': 'GET', 'path': '/api/settings'},
    {'name': 'settings_put_no_token', 'method': 'PUT', 'path': '/api/settings', 'auth': 'none',
     'body': {'max_agent_concurrency': 3}},
    {'name': 'settings_put_admin', 'method': 'PUT', 'path': '/api/settings',
     'body': {'max_agent_concurrency': 99, 'telemetry_enabled': True,
              'unknown_key': 'x', 'default_schedule_phase_mode': 'fanout'}},
    {'name': 'settings_get_after_put', 'method': 'GET', 'path': '/api/settings'},
    {'name': 'gws_status', 'method': 'GET', 'path': '/api/settings/google-workspace/status'},
    # ── users 家族 ──
    {'name': 'users_list_initial', 'method': 'GET', 'path': '/api/users'},
    {'name': 'user_create_member', 'method': 'POST', 'path': '/api/users',
     'body': {'username': 'replaymember', 'email': 'member@replay-test.com', 'password': 'memberpw'},
     'capture': {'user_1': 'id'}},
    {'name': 'user_create_duplicate', 'method': 'POST', 'path': '/api/users',
     'body': {'username': 'replaymember', 'password': 'pw2'}},
    {'name': 'user_update', 'method': 'PUT', 'path': '/api/users/{{user_1}}',
     'body': {'email': 'member2@replay-test.com'}},
    {'name': 'login_member', 'method': 'POST', 'path': '/api/auth/login', 'auth': 'none',
     'body': {'identifier': 'replaymember', 'password': 'memberpw'}, 'cookie_user': 'member'},
    {'name': 'users_list_as_member_403', 'method': 'GET', 'path': '/api/users', 'auth': 'member'},
    {'name': 'user_delete', 'method': 'DELETE', 'path': '/api/users/{{user_1}}'},
    {'name': 'user_delete_missing_404', 'method': 'DELETE', 'path': f'/api/users/{FAKE}'},
    {'name': 'user_delete_ai_bot_400', 'method': 'DELETE',
     'path': '/api/users/00000000-0000-0000-0000-000000000002'},
    {'name': 'user_delete_self_400', 'method': 'DELETE',
     'path': '/api/users/00000000-0000-0000-0000-000000000001'},
    # ── stores 家族 ──
    {'name': 'stores_list_empty', 'method': 'GET', 'path': '/api/stores'},
    {'name': 'store_create', 'method': 'POST', 'path': '/api/stores',
     'body': {'name': 'Replay Store', 'platforms': ['shopee'], 'countries': ['SG'],
              'platform_countries': {'shopee': ['SG']}},
     'capture': {'store_1': 'id'}},
    {'name': 'store_get', 'method': 'GET', 'path': '/api/stores/{{store_1}}'},
    {'name': 'store_get_missing_404', 'method': 'GET', 'path': f'/api/stores/{FAKE}'},
    {'name': 'store_update', 'method': 'PUT', 'path': '/api/stores/{{store_1}}',
     'body': {'name': 'Replay Store Renamed'}},
    {'name': 'store_bookmarks', 'method': 'GET', 'path': '/api/stores/{{store_1}}/bookmarks'},
    {'name': 'stores_list_after', 'method': 'GET', 'path': '/api/stores'},
    # ── tasks 家族（一律 defer_start，排除 agent 执行） ──
    {'name': 'tasks_list_empty', 'method': 'GET', 'path': '/api/tasks'},
    {'name': 'task_create_store', 'method': 'POST', 'path': '/api/tasks',
     'body': {'store_id': '{{store_1}}', 'title': 'Replay Task', 'description': 'replay body',
              'platform': 'shopee', 'country': 'SG', 'defer_start': True},
     'capture': {'task_1': 'id'}},
    {'name': 'task_create_store_missing_404', 'method': 'POST', 'path': '/api/tasks',
     'body': {'store_id': FAKE, 'title': 'x', 'defer_start': True}},
    {'name': 'task_create_no_store', 'method': 'POST', 'path': '/api/tasks',
     'body': {'title': 'Web Task', 'description': 'no-store task', 'defer_start': True},
     'capture': {'task_web': 'id'}},
    {'name': 'task_get', 'method': 'GET', 'path': '/api/tasks/{{task_1}}'},
    {'name': 'task_get_missing_404', 'method': 'GET', 'path': f'/api/tasks/{FAKE}'},
    {'name': 'task_steps_empty', 'method': 'GET', 'path': '/api/tasks/{{task_1}}/steps'},
    {'name': 'task_messages_empty', 'method': 'GET', 'path': '/api/tasks/{{task_1}}/messages'},
    {'name': 'task_questions_pending_none', 'method': 'GET', 'path': '/api/tasks/{{task_1}}/questions/pending'},
    {'name': 'task_message_empty_400', 'method': 'POST', 'path': '/api/tasks/{{task_1}}/messages',
     'body': {'content': '  '}},
    {'name': 'task_question_answer_409', 'method': 'POST', 'path': '/api/tasks/{{task_1}}/questions/answer',
     'body': {'request_id': 'req-1', 'answers': {}}},
    {'name': 'task_review_plan', 'method': 'PATCH', 'path': '/api/tasks/{{task_1}}/review-plan',
     'body': {}},
    {'name': 'task_delete_no_store', 'method': 'DELETE', 'path': '/api/tasks/{{task_web}}'},
    {'name': 'tasks_list_after_delete', 'method': 'GET', 'path': '/api/tasks'},
    {'name': 'task_ad_declarations_empty', 'method': 'GET', 'path': '/api/tasks/{{task_1}}/ad-declarations'},
    {'name': 'task_schedule_state_bad_key', 'method': 'PUT',
     'path': '/api/tasks/{{task_1}}/schedule-state/bad!key', 'body': {'value': 'v'}},
    {'name': 'task_schedule_state_unscheduled', 'method': 'GET',
     'path': '/api/tasks/{{task_1}}/schedule-state/email_watermark'},
    # ── events 家族 ──
    {'name': 'events_list_empty', 'method': 'GET', 'path': '/api/events'},
    {'name': 'event_create', 'method': 'POST', 'path': '/api/events',
     'body': {'title': 'Replay Event', 'description': 'from replay', 'platform': 'shopee',
              'event_date': '2027-01-01', 'priority': 2},
     'capture': {'event_1': 'id'}},
    {'name': 'event_get', 'method': 'GET', 'path': '/api/events/{{event_1}}'},
    {'name': 'event_get_missing_404', 'method': 'GET', 'path': f'/api/events/{FAKE}'},
    {'name': 'event_status_invalid_400', 'method': 'POST', 'path': '/api/events/{{event_1}}/status',
     'body': {'status': 'bogus'}},
    {'name': 'event_activity_add', 'method': 'POST', 'path': '/api/events/{{event_1}}/activities',
     'body': {'action': 'note_added', 'content': 'replay note'}},
    {'name': 'event_activities_list', 'method': 'GET', 'path': '/api/events/{{event_1}}/activities'},
    {'name': 'event_backends_list', 'method': 'GET', 'path': '/api/events/backends'},
    {'name': 'event_backend_unknown_400', 'method': 'POST', 'path': '/api/events/backends/configure',
     'body': {'backend': 'nope', 'config': {}}},
    {'name': 'event_delete', 'method': 'DELETE', 'path': '/api/events/{{event_1}}'},
    # ── channels 家族（不 poll / 不 send——那是真网端点） ──
    {'name': 'channels_types', 'method': 'GET', 'path': '/api/channels/types'},
    {'name': 'channel_configure', 'method': 'POST', 'path': '/api/channels/configure',
     'body': {'channel_type': 'wecom', 'config': {'webhook_url': 'http://127.0.0.1:9/hook'},
              'channel_id': 'replay-wecom'}},
    {'name': 'channel_configs', 'method': 'GET', 'path': '/api/channels/configs'},
    {'name': 'channel_active', 'method': 'GET', 'path': '/api/channels/active'},
    {'name': 'channel_delete', 'method': 'DELETE', 'path': '/api/channels/replay-wecom'},
    # ── wecom-bots 家族（建/查/改/删；send 需真网不录） ──
    {'name': 'wecom_list_empty', 'method': 'GET', 'path': '/api/wecom-bots'},
    {'name': 'wecom_create', 'method': 'POST', 'path': '/api/wecom-bots',
     'body': {'name': 'Replay Bot', 'webhook_url': 'http://127.0.0.1:9/hook'},
     'capture': {'bot_1': 'id'}},
    {'name': 'wecom_get', 'method': 'GET', 'path': '/api/wecom-bots/{{bot_1}}'},
    {'name': 'wecom_get_missing_404', 'method': 'GET', 'path': f'/api/wecom-bots/{FAKE}'},
    {'name': 'wecom_update', 'method': 'PUT', 'path': '/api/wecom-bots/{{bot_1}}',
     'body': {'name': 'Replay Bot 2'}},
    {'name': 'wecom_delete', 'method': 'DELETE', 'path': '/api/wecom-bots/{{bot_1}}'},
    # ── email-accounts 家族（显式 imap/smtp host，不触发 auto-discover / 不真连） ──
    {'name': 'email_list_empty', 'method': 'GET', 'path': '/api/email-accounts'},
    {'name': 'email_create', 'method': 'POST', 'path': '/api/email-accounts',
     'body': {'email': 'replay@test.local', 'password': 'pw', 'imap_host': '127.0.0.1',
              'imap_port': 1099, 'use_ssl': False, 'smtp_host': '127.0.0.1', 'smtp_port': 1099},
     'capture': {'email_1': 'id'}},
    {'name': 'email_create_duplicate_409', 'method': 'POST', 'path': '/api/email-accounts',
     'body': {'email': 'replay@test.local', 'password': 'pw', 'imap_host': '127.0.0.1'}},
    {'name': 'email_update', 'method': 'PUT', 'path': '/api/email-accounts/{{email_1}}',
     'body': {'imap_port': 1143}},
    {'name': 'email_links_empty', 'method': 'GET', 'path': '/api/email-accounts/{{email_1}}/links'},
    {'name': 'store_email_link', 'method': 'POST', 'path': '/api/stores/{{store_1}}/emails',
     'body': {'email_account_id': '{{email_1}}'},
     'capture': {'link_1': 'id'}},
    {'name': 'store_email_link_duplicate_409', 'method': 'POST', 'path': '/api/stores/{{store_1}}/emails',
     'body': {'email_account_id': '{{email_1}}'}},
    {'name': 'store_emails_list', 'method': 'GET', 'path': '/api/stores/{{store_1}}/emails'},
    {'name': 'store_email_unlink_wrong_id_404', 'method': 'DELETE',
     'path': '/api/stores/{{store_1}}/emails/{{email_1}}'},
    {'name': 'store_email_unlink', 'method': 'DELETE', 'path': '/api/stores/{{store_1}}/emails/{{link_1}}'},
    {'name': 'email_delete', 'method': 'DELETE', 'path': '/api/email-accounts/{{email_1}}'},
    # ── profiles 家族 ──
    {'name': 'profiles_list_empty', 'method': 'GET', 'path': '/api/profiles'},
    {'name': 'profile_create', 'method': 'POST', 'path': '/api/profiles',
     'body': {'id': 'replay-profile', 'name': 'Replay Profile',
              'env': {'ANTHROPIC_API_KEY': 'sk-replay'}, 'description': 'replay'},
     'capture': {'profile_1': 'id'}},
    {'name': 'profiles_presets', 'method': 'GET', 'path': '/api/profiles/presets'},
    {'name': 'profile_set_default', 'method': 'PATCH', 'path': '/api/profiles/{{profile_1}}/set-default'},
    {'name': 'profile_update', 'method': 'PUT', 'path': '/api/profiles/{{profile_1}}',
     'body': {'description': 'replay updated'}},
    {'name': 'profiles_list_after', 'method': 'GET', 'path': '/api/profiles'},
    {'name': 'profile_delete', 'method': 'DELETE', 'path': '/api/profiles/{{profile_1}}'},
    # ── workspace 家族（记录环境无本地知识/技能包，与 TS 运行时同态） ──
    {'name': 'workspace_file_missing_404', 'method': 'GET',
     'path': '/api/workspace/file?path=notes/missing.md'},
    {'name': 'workspace_file_write', 'method': 'PUT',
     'path': '/api/workspace/file?path=notes/replay.md',
     'body': {'content': '# replay\n'}},
    {'name': 'workspace_file_read', 'method': 'GET', 'path': '/api/workspace/file?path=notes/replay.md'},
    {'name': 'workspace_file_history', 'method': 'GET',
     'path': '/api/workspace/file/history?path=notes/replay.md'},
    {'name': 'workspace_skill_create', 'method': 'POST', 'path': '/api/workspace/skill',
     'body': {'name': 'replay-skill', 'description': 'temp skill'}},
    {'name': 'workspace_skill_delete', 'method': 'DELETE', 'path': '/api/workspace/skills/replay-skill'},
    # knowledge/skills 的 sync/sync-status/sync-meta 端点不录：本地包同步依赖
    # pip 源树（TS 无）、远端同步走 raw.githubusercontent.com（真网；PRD 允许
    # 指不可达端口，但错误文本含 OS 网络细节，跨语言不可字节对齐）。
    {'name': 'workspace_structured', 'method': 'GET', 'path': '/api/workspace/structured'},
    {'name': 'workspace_tree', 'method': 'GET', 'path': '/api/workspace/tree'},
    {'name': 'assistant_status', 'method': 'GET', 'path': '/api/workspace/assistant/status'},
    # ── vision 家族（generate 等真网端点不录；ref-proxy 取 SSRF 守卫形状） ──
    {'name': 'vision_config_get', 'method': 'GET', 'path': '/api/vision/config'},
    {'name': 'vision_config_put', 'method': 'PUT', 'path': '/api/vision/config',
     'body': {'provider': 'kie', 'api_key': 'k', 'model': 'm'}},
    {'name': 'vision_pending_none', 'method': 'GET', 'path': '/api/tasks/{{task_1}}/image/pending'},
    {'name': 'vision_pending_missing_task_404', 'method': 'GET', 'path': f'/api/tasks/{FAKE}/image/pending'},
    {'name': 'vision_ref_proxy_private_blocked', 'method': 'GET',
     'path': '/api/vision/ref-proxy?url=http://127.0.0.1:9/img.png'},
    # ── screenshots / attachments 错误分支 ──
    {'name': 'screenshot_missing_404', 'method': 'GET', 'path': f'/api/screenshots/{FAKE}'},
    {'name': 'attachments_list_empty', 'method': 'GET', 'path': '/api/attachments/{{task_1}}'},
    {'name': 'attachment_download_missing_404', 'method': 'GET', 'path': f'/api/attachments/file/{FAKE}'},
    # ── dida365 家族（OAuth 状态机，不触真网） ──
    {'name': 'dida365_status', 'method': 'GET', 'path': '/api/dida365/status'},
    {'name': 'dida365_projects_no_token', 'method': 'GET', 'path': '/api/dida365/projects'},
    {'name': 'dida365_callback_missing_params', 'method': 'GET', 'path': '/api/dida365/callback'},
    {'name': 'dida365_disconnect', 'method': 'DELETE', 'path': '/api/dida365/disconnect'},
    # ── ziniao 家族（探活失败的确定性错误形状是契约） ──
    {'name': 'ziniao_list_empty', 'method': 'GET', 'path': '/api/ziniao-accounts'},
    {'name': 'ziniao_create', 'method': 'POST', 'path': '/api/ziniao-accounts',
     'body': {'name': 'Replay Ziniao', 'company': 'Replay Co', 'username': 'zuser',
              'password': 'zpw', 'socket_port': 16851, 'client_path': 'ziniao'},
     'capture': {'zin_1': 'id'}},
    {'name': 'ziniao_browsers_probe_fail', 'method': 'GET',
     'path': '/api/ziniao-accounts/{{zin_1}}/browsers'},
    {'name': 'ziniao_browsers_missing_404', 'method': 'GET', 'path': f'/api/ziniao-accounts/{FAKE}/browsers'},
    {'name': 'ziniao_update', 'method': 'PUT', 'path': '/api/ziniao-accounts/{{zin_1}}',
     'body': {'name': 'Replay Ziniao 2'}},
    {'name': 'ziniao_delete', 'method': 'DELETE', 'path': '/api/ziniao-accounts/{{zin_1}}'},
    # ── cron 家族（'0 3 1 1 *' 下一个 fire 在来年 1 月 1 日——窗口内绝不触发；
    #     注意不能用永不触发的表达式（如 2 月 31 日）：APScheduler 会因
    #     next_run=None 把作业自动移出 jobstore，pause/delete 变成时序竞态） ──
    {'name': 'cron_list_empty', 'method': 'GET', 'path': '/api/cron/jobs'},
    {'name': 'cron_create', 'method': 'POST', 'path': '/api/cron/jobs',
     'body': {'job_id': 'replay-cron', 'task_title': 'Replay Cron',
              'cron_expression': '0 3 1 1 *', 'store_id': None},
     'capture': {'cron_1': 'job_id'}},
    {'name': 'cron_pause', 'method': 'POST', 'path': '/api/cron/jobs/{{cron_1}}/pause'},
    {'name': 'cron_resume', 'method': 'POST', 'path': '/api/cron/jobs/{{cron_1}}/resume'},
    {'name': 'cron_pause_missing_404', 'method': 'POST', 'path': f'/api/cron/jobs/{FAKE}/pause'},
    {'name': 'cron_delete', 'method': 'DELETE', 'path': '/api/cron/jobs/{{cron_1}}'},
    # ── schedules 家族（最后执行：创建会生成规划任务，后续步骤不再读全局任务列表；
    #     interval 10080 分钟保证录制窗口内绝不 fire） ──
    {'name': 'schedule_create_bad_type', 'method': 'POST', 'path': '/api/schedules',
     'body': {'title': 'x', 'schedule_type': 'yearly'}},
    {'name': 'schedule_create_bad_time', 'method': 'POST', 'path': '/api/schedules',
     'body': {'title': 'x', 'schedule_type': 'days', 'schedule_time': '25:00'}},
    {'name': 'schedule_create_bad_tz', 'method': 'POST', 'path': '/api/schedules',
     'body': {'title': 'x', 'schedule_type': 'days', 'timezone': 'Not/AZone'}},
    {'name': 'schedule_create_store_finalize_400', 'method': 'POST', 'path': '/api/schedules',
     'body': {'title': 'x', 'schedule_type': 'days', 'store_id': '{{store_1}}',
              'finalize_description': '汇总'}},
    {'name': 'schedules_list_empty', 'method': 'GET', 'path': '/api/schedules'},
    {'name': 'schedule_get_missing_404', 'method': 'GET', 'path': f'/api/schedules/{FAKE}'},
    {'name': 'schedule_trigger_missing_404', 'method': 'POST', 'path': f'/api/schedules/{FAKE}/trigger'},
    {'name': 'schedule_create', 'method': 'POST', 'path': '/api/schedules',
     'body': {'title': 'Replay Sched', 'description': 'replay prompt', 'schedule_type': 'minutes',
              'interval_value': 10080},
     'capture': {'sched_1': 'id'}, 'settle_ms': 300},
    {'name': 'schedule_get', 'method': 'GET', 'path': '/api/schedules/{{sched_1}}', 'settle_ms': 200},
    {'name': 'schedule_tasks_excludes_plan_only', 'method': 'GET',
     'path': '/api/schedules/{{sched_1}}/tasks'},
    {'name': 'schedule_trigger_plan_not_ready_409', 'method': 'POST',
     'path': '/api/schedules/{{sched_1}}/trigger'},
    {'name': 'schedule_pause', 'method': 'POST', 'path': '/api/schedules/{{sched_1}}/pause'},
    {'name': 'schedule_update_title', 'method': 'PUT', 'path': '/api/schedules/{{sched_1}}',
     'body': {'title': 'Replay Sched 2', 'plan_version': 0}},
    {'name': 'schedule_update_stale_version_412', 'method': 'PUT', 'path': '/api/schedules/{{sched_1}}',
     'body': {'title': 'Replay Sched 3', 'plan_version': 99}},
    {'name': 'schedules_list_after', 'method': 'GET', 'path': '/api/schedules'},
    {'name': 'schedule_delete', 'method': 'DELETE', 'path': '/api/schedules/{{sched_1}}'},
]

# ── 执行 ──

_PLACEHOLDER = re.compile(r'\{\{(\w+)\}\}')


def substitute(text: str, reg: dict[str, str]) -> str:
    def _repl(m: re.Match) -> str:
        key = m.group(1)
        if key not in reg:
            raise KeyError(f'占位符 {{{{{key}}}}} 未登记（步骤顺序错误）')
        return reg[key]

    return _PLACEHOLDER.sub(_repl, text)


def substitute_body(body, reg: dict[str, str]):
    if isinstance(body, str):
        return substitute(body, reg)
    if isinstance(body, list):
        return [substitute_body(x, reg) for x in body]
    if isinstance(body, dict):
        return {k: substitute_body(v, reg) for k, v in body.items()}
    return body


def jsonpath_get(data, path: str):
    cur = data
    for part in path.split('.'):
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur[part]
    return cur


async def main() -> int:
    # 幂等：fixture 每次全量重建
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if FIXTURE_PATH.exists():
        FIXTURE_PATH.unlink()

    cookies: dict[str, str] = {'admin': '', 'member': ''}
    reg: dict[str, str] = {}
    lines: list[str] = []

    lifecycle = app.router.lifespan_context(app)
    async with lifecycle:
        transport = ASGITransport(app=app)
        for i, step in enumerate(STEPS):
            mode = step.get('auth', 'admin')
            settle = step.get('settle_ms', 0) / 1000
            # 步间小等待：让后台（SSE 发射、事件写入）落地，录制与回放同规
            await asyncio.sleep(0.05 + settle)

            headers: dict[str, str] = {}
            if mode in ('admin', 'member') and cookies[mode]:
                headers['cookie'] = cookies[mode]
            elif mode == 'bad':
                headers['cookie'] = 'auth_token=garbage'

            path = substitute(step['path'], reg)
            body = step.get('body')
            method = step['method']
            kwargs: dict = {'method': method, 'headers': headers}
            if body is not None:
                kwargs['json'] = substitute_body(body, reg)

            # 每步独立 client：httpx 的 cookie jar 会把 set-cookie 自动带回到
            # 后续请求，破坏 'none'/member 步的语义；回放侧无 jar，必须同态。
            async with AsyncClient(transport=transport, base_url='http://record') as client:
                resp = await client.request(**kwargs, url=path)

            set_cookie = resp.headers.get('set-cookie')
            if set_cookie and method == 'POST' and path == '/api/auth/login' and resp.status_code == 200:
                cookies[step.get('cookie_user', 'admin')] = set_cookie.split(';')[0]

            try:
                payload = resp.json()
            except Exception:
                payload = None
                print(f'[{i}] {step["name"]}: 非 JSON 响应 {resp.status_code}', file=sys.stderr)

            for logical, jp in step.get('capture', {}).items():
                try:
                    reg[logical] = str(jsonpath_get(payload, jp))
                except Exception as e:
                    raise KeyError(
                        f'步骤 {step["name"]} capture {logical}<{jp}> 失败：'
                        f'status={resp.status_code} payload={json.dumps(payload, ensure_ascii=False)[:400]}'
                    ) from e

            record = {
                'name': step['name'],
                'method': method,
                'path': step['path'],  # 保留占位符原文
                'status': resp.status_code,
                'json': payload,
            }
            if body is not None:
                record['body'] = body
            if step.get('auth', 'admin') != 'admin':
                record['auth'] = step['auth']
            if step.get('cookie_user'):
                record['cookie_user'] = step['cookie_user']
            if step.get('capture'):
                record['capture'] = step['capture']
            if step.get('settle_ms'):
                record['settle_ms'] = step['settle_ms']
            lines.append(json.dumps(record, ensure_ascii=False))
            print(f'[{i:3}] {step["name"]:42} -> {resp.status_code}')

    FIXTURE_PATH.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'\n{len(lines)} steps -> {FIXTURE_PATH}')

    shutil.rmtree(_TMP, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
