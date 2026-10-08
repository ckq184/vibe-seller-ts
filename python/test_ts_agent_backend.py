"""TsAgentBackend × 真 TS bridge 跨语言契约测试（stdlib unittest）。

拉起 packages/bridge/dist/bridge.mjs（scripted 引擎，无网络、无密钥），
验证 docs/bridge-protocol.md v1 的 Python 侧语义：
事件翻译、活门问答、取消、重复启动、消息 fallback。

运行（仓库根目录）：
    python python/test_ts_agent_backend.py
前置：npm run bridge:build（生成 packages/bridge/dist/bridge.mjs）。
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BRIDGE = REPO_ROOT / 'packages' / 'bridge' / 'dist' / 'bridge.mjs'
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ts_agent_backend import TsAgentBackend, TsBackendHooks  # noqa: E402


class InMemoryHooks(TsBackendHooks):
    def __init__(self):
        super().__init__(emit=self._emit, persist_message=self._msg, save_result=self._res, persist_todos=self._todos)
        self.events: list = []
        self.messages: list = []
        self.results: list = []
        self.todos: list = []

    async def _emit(self, event_type, data):
        self.events.append((event_type, data))

    async def _msg(self, task_id, role, content):
        self.messages.append((task_id, role, content))

    async def _res(self, task_id, result_text):
        self.results.append((task_id, result_text))

    async def _todos(self, task_id, todos):
        self.todos.append((task_id, todos))


def free_port() -> int:
    import socket

    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class BridgeProc:
    """scripted 引擎的桥子进程（随机端口，health 轮询就绪）。"""

    def __init__(self, script: dict):
        self.script = script
        self.port = free_port()
        self.proc: subprocess.Popen = None
        self.tmp = tempfile.TemporaryDirectory()

    def start(self):
        script_path = Path(self.tmp.name) / 'script.json'
        script_path.write_text(json.dumps(self.script), encoding='utf-8')
        env = dict(
            os.environ,
            VIBE_BRIDGE_ENGINE='scripted',
            VIBE_BRIDGE_SCRIPT=str(script_path),
            VIBE_BRIDGE_PORT=str(self.port),
            VIBE_BRIDGE_DATA_DIR=str(Path(self.tmp.name) / 'data'),
        )
        self.proc = subprocess.Popen(
            ['node', str(BRIDGE)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        deadline = asyncio.get_event_loop().time() + 30
        while asyncio.get_event_loop().time() < deadline:
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/v1/health', timeout=2) as r:
                    if r.status == 200:
                        return self
            except Exception:
                pass
            if self.proc.poll() is not None:
                out = self.proc.stdout.read().decode('utf-8', 'replace')
                raise RuntimeError(f'bridge exited early:\n{out}')
            import time

            time.sleep(0.2)
        raise RuntimeError('bridge health timeout')

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.proc and self.proc.stdout:
            self.proc.stdout.close()
        self.tmp.cleanup()


HAPPY = {
    'tool_names': ['list_reports', 'download_report'],
    'decisions': [
        {'kind': 'call_tool', 'intent': {'name': 'list_reports', 'arguments': {'period': '2026-09'}}},
        {'kind': 'call_tool', 'intent': {'name': 'download_report', 'arguments': {'id': 'R-1001'}}},
        {'kind': 'respond', 'content': '报表 R-1001 已下载，42 行。'},
    ],
}

GATED = {
    'tool_names': ['update_price'],
    'gated_tools': ['update_price'],
    'decisions': [
        {'kind': 'call_tool', 'intent': {'name': 'update_price', 'arguments': {'sku': 'A-1', 'price': 9.9}}},
        {'kind': 'respond', 'content': '价格已更新。'},
    ],
}


async def wait_until(predicate, timeout=10.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    return False


class TestTsAgentBackend(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._bridges = []

    async def asyncTearDown(self):
        for b in self._bridges:
            b.stop()

    async def start(self, script):
        bridge = BridgeProc(script).start()
        self._bridges.append(bridge)
        hooks = InMemoryHooks()
        backend = TsAgentBackend(f'http://127.0.0.1:{bridge.port}', hooks)
        return backend, hooks

    async def test_happy_path_事件翻译与agent_done(self):
        backend, hooks = await self.start(HAPPY)
        started = await backend.run('task-happy', '拉 noon 报表')
        self.assertTrue(started)
        self.assertTrue(backend.is_running('task-happy'))

        handle = backend.get_session('task-happy')
        self.assertIsNotNone(handle)
        await asyncio.wait_for(handle.done.wait(), timeout=15)

        roles = [r for _t, r, _c in hooks.messages]
        self.assertEqual(roles.count('tool_use'), 2)
        self.assertEqual(roles[-1], 'result')
        self.assertIn('R-1001', hooks.messages[-1][2])
        self.assertTrue(hooks.results, 'result 必须落 transcript_tail')
        agent_done = [d for t, d in hooks.events if t == 'agent_done']
        self.assertEqual(len(agent_done), 1)
        self.assertEqual(agent_done[0]['return_code'], 0)
        self.assertFalse(backend.is_running('task-happy'))
        # session.done 事件语义：编排器 _wait_for_session_end 依赖
        self.assertTrue(handle.done.is_set())

    async def test_确认闸门_问答后完成(self):
        backend, hooks = await self.start(GATED)
        self.assertTrue(await backend.run('task-gate', '调价'))

        handle = backend.get_session('task-gate')
        self.assertTrue(
            await wait_until(lambda: backend.get_pending_questions('task-gate') is not None),
            '挂起时必须能查到待答问题',
        )
        pending = backend.get_pending_questions('task-gate')
        request_id = pending['request_id']
        questions_emitted = [d for t, d in hooks.events if t == 'task_questions']
        self.assertEqual(len(questions_emitted), 1)
        self.assertEqual(questions_emitted[0]['request_id'], request_id)

        self.assertTrue(await backend.submit_answer('task-gate', request_id, {'approved': True}))
        await asyncio.wait_for(handle.done.wait(), timeout=15)

        tool_uses = [c for _t, r, c in hooks.messages if r == 'tool_use']
        self.assertEqual(len(tool_uses), 1, '批准后工具恰好执行一次')
        self.assertEqual(hooks.messages[-1][2], '价格已更新。')
        agent_done = [d for t, d in hooks.events if t == 'agent_done']
        self.assertEqual(agent_done[0]['return_code'], 0)
        self.assertIsNone(backend.get_pending_questions('task-gate'))

    async def test_拒绝批复_工具不执行且任务非失败(self):
        backend, hooks = await self.start(GATED)
        self.assertTrue(await backend.run('task-deny', '调价'))
        handle = backend.get_session('task-deny')
        self.assertTrue(await wait_until(lambda: backend.get_pending_questions('task-deny') is not None))
        request_id = backend.get_pending_questions('task-deny')['request_id']

        self.assertTrue(await backend.submit_answer('task-deny', request_id, {'approved': False}))
        await asyncio.wait_for(handle.done.wait(), timeout=15)

        # tool_use 消息卡片在门拦截之前发出（CLI 同构）；执行证据看 observation
        observations = [
            json.loads(c)
            for _t, r, c in hooks.messages
            if r == 'agent_event' and c.startswith('{')
        ]
        self.assertFalse(
            [o for o in observations if o.get('tool') == 'update_price' and o.get('ok') == 'success'],
            '拒绝后绝不执行工具',
        )
        self.assertTrue(
            [o for o in observations if o.get('tool') == 'update_price' and o.get('ok') == 'denied'],
            '拒绝必须留下可见的 denied 诊断',
        )
        self.assertFalse(handle.interrupted)
        self.assertEqual(handle.return_code, 0)

    async def test_重复启动返回False_取消终局cancelled(self):
        backend, hooks = await self.start(GATED)
        self.assertTrue(await backend.run('task-dup', '调价'))
        self.assertFalse(await backend.run('task-dup', '再来'), '活 run 存在时必须拒绝重复启动')

        self.assertTrue(await backend.stop('task-dup'))
        handle = backend.get_session('task-dup')
        await asyncio.wait_for(handle.done.wait(), timeout=15)
        self.assertTrue(handle.interrupted)
        agent_done = [d for t, d in hooks.events if t == 'agent_done']
        self.assertEqual(len(agent_done), 1)
        self.assertEqual(agent_done[0]['return_code'], -1)
        self.assertFalse(await backend.stop('task-dup'), '已结束的 run 不能再 stop')
        self.assertFalse(backend.is_running('task-dup'))

    async def test_活会话消息恒False_路由fallback契约(self):
        backend, hooks = await self.start(HAPPY)
        self.assertTrue(await backend.run('task-msg', 'hi'))
        self.assertFalse(await backend.send_message('task-msg', '跟进'), 'v1 恒 False，由路由器 fallback')
        handle = backend.get_session('task-msg')
        await asyncio.wait_for(handle.done.wait(), timeout=15)

    async def test_plan模式_save_plan落库后plan_saved_event置位(self):
        backend, hooks = await self.start(HAPPY)

        plans: list = []

        async def save_plan(task_id, plan_text):
            plans.append((task_id, plan_text))
            return True

        hooks.save_plan = save_plan
        self.assertTrue(await backend.run('task-plan', '设计方案', mode='plan_then_execute'))
        handle = backend.get_session('task-plan')
        await asyncio.wait_for(handle.done.wait(), timeout=15)

        self.assertEqual(plans, [('task-plan', '报表 R-1001 已下载，42 行。')])
        self.assertTrue(handle.plan_saved_event.is_set(), '编排器 execute_planned_task 的会话结束等待依赖此事件')
        # plan 走 save_plan，不进 transcript_tail
        self.assertEqual(hooks.results, [])
        self.assertEqual(handle.return_code, 0)
        # 会话已死 → approve_plan False → execute_planned_task 走全新 execute 会话回退

    async def test_plan校验被拒_任务带plan_invalid失败(self):
        backend, hooks = await self.start(HAPPY)

        async def save_plan(task_id, plan_text):
            return False  # 如 fanout 结构违规

        hooks.save_plan = save_plan
        self.assertTrue(await backend.run('task-plan-bad', '设计方案', mode='plan_then_execute'))
        handle = backend.get_session('task-plan-bad')
        await asyncio.wait_for(handle.done.wait(), timeout=15)

        self.assertFalse(handle.plan_saved_event.is_set())
        self.assertEqual(handle.error_category, 'plan_invalid')
        self.assertEqual(handle.return_code, 1)

    async def test_plan模式_无save_plan钩子则拒绝(self):
        backend, _hooks = await self.start(HAPPY)
        with self.assertRaises(ValueError):
            await backend.run('task-plan-nohook', '设计方案', mode='plan_then_execute')

    async def test_profile透传与retry保留(self):
        backend, hooks = await self.start(HAPPY)
        self.assertTrue(await backend.run('task-prof', 'hi', profile_id='deepseek'))
        handle = backend.get_session('task-prof')
        self.assertEqual(handle.args['profile_id'], 'deepseek')
        await asyncio.wait_for(handle.done.wait(), timeout=15)

        self.assertTrue(await backend.retry_without_resume('task-prof'))
        handle2 = backend.get_session('task-prof')
        self.assertEqual(handle2.args['profile_id'], 'deepseek', '重试必须继承原 profile')
        await asyncio.wait_for(handle2.done.wait(), timeout=15)

    async def test_retry_without_resume_以原参数重启(self):
        backend, hooks = await self.start(HAPPY)
        self.assertTrue(await backend.run('task-retry', '第一次'))
        handle = backend.get_session('task-retry')
        await asyncio.wait_for(handle.done.wait(), timeout=15)
        n_before = len([m for m in hooks.messages if m[0] == 'task-retry'])

        self.assertTrue(await backend.retry_without_resume('task-retry'))
        handle2 = backend.get_session('task-retry')
        self.assertIsNotNone(handle2)
        self.assertNotEqual(handle2.run_id, handle.run_id, '重试必须是新 run')
        await asyncio.wait_for(handle2.done.wait(), timeout=15)
        n_after = len([m for m in hooks.messages if m[0] == 'task-retry'])
        self.assertGreater(n_after, n_before)


if __name__ == '__main__':
    if not BRIDGE.exists():
        print(f'缺少 {BRIDGE} —— 先运行 npm run bridge:build', file=sys.stderr)
        sys.exit(1)
    unittest.main(verbosity=2)
