"""TsAgentBackend —— vibe-seller 的 TS Agent Runtime 桥接后端。

实现 app/ai/base.py::AIAgentBackend 的 6 个方法，把 agent 执行代理到本机
TS bridge 服务（docs/bridge-protocol.md v1）。这是绞杀者迁移的 Python 侧
适配器：FastAPI / task_runner / orchestrator 零改动，CLI 后端与桥后端按任务并存。

设计约束：
- stdlib-only（asyncio + 手写 HTTP/SSE 解析），可在无 app 依赖的环境测试；
- 钩子对象注入事件总线与 DB 写入（生产接线见 default_hooks()），适配器本体
  不 import app.*，保证可独立测试与复用；
- 事件词汇与 ClaudeCodeBackend._emit_message/_save_result 逐字段对齐：
  task_message(role=...) / task_questions / task_todos / agent_done；
  结果落 transcript_tail（prose 永不自动成为交付物），状态迁移仍归编排器。
- Python 3.10+ 兼容。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

try:  # 原仓库内运行时才可用；独立测试环境走本地 ABC 兜底
    from app.ai.base import AIAgentBackend  # type: ignore
except Exception:  # pragma: no cover
    from abc import ABC, abstractmethod

    class AIAgentBackend(ABC):  # type: ignore
        """与 app.ai.base.AIAgentBackend 同构的本地兜底（仅测试用）。"""

        @abstractmethod
        async def run(self, *args: Any, **kwargs: Any) -> bool:
            ...

        @abstractmethod
        async def stop(self, task_id: str) -> bool:
            ...

        @abstractmethod
        async def submit_answer(self, task_id: str, request_id: str, answers: dict) -> bool:
            ...

        @abstractmethod
        async def send_message(self, task_id: str, message: str) -> bool:
            ...

        @abstractmethod
        async def approve_plan(self, task_id: str) -> bool:
            ...

        @abstractmethod
        async def reject_plan(self, task_id: str, feedback: str = '') -> bool:
            ...

        @abstractmethod
        def is_running(self, task_id: str) -> bool:
            ...


# ── 钩子：事件总线与持久化（生产接线注入真实现；测试注入内存假件） ──


@dataclass
class TsBackendHooks:
    """适配器对外界的副作用面。save_plan 可选：plan_then_execute 任务的 plan 落库
    （等价 CLI 的 _save_design_plan：plan_history + task.plan + PLANNED + task_update）。
    返回 False 表示 plan 校验被拒（如 fanout 结构违规），任务按 plan_invalid 失败。"""

    emit: Callable[[str, dict], Awaitable[None]]
    persist_message: Callable[[str, str, str], Awaitable[None]]
    save_result: Callable[[str, str], Awaitable[None]]
    persist_todos: Callable[[str, list], Awaitable[None]]
    save_plan: Optional[Callable[[str, str], Awaitable[bool]]] = None


# ── 会话句柄：编排器（_wait_for_session_end / WAITING 停靠）依赖的面 ──


@dataclass
class TsSessionHandle:
    task_id: str
    run_id: str = ''
    mode: str = 'execute'
    done: asyncio.Event = field(default_factory=asyncio.Event)
    plan_saved_event: asyncio.Event = field(default_factory=asyncio.Event)
    # CLI 会话兼容面（桥 v1 不做进程内续话，字段保留语义占位）
    session_id: Optional[str] = None
    resume_session_id: Optional[str] = None
    # 结果面（done 后可读）
    result_text: str = ''
    error_category: Optional[str] = None
    return_code: int = 0
    interrupted: bool = False
    # WAITING 停靠兼容： unanswered questions 快照（正常活门不需要，桥崩溃兜底）
    _last_pending_questions: dict = field(default_factory=dict)
    # 跨 run 任务级记忆（与 ClaudeCodeBackend 的 per-task 透传一致）
    _loaded_skills: set = field(default_factory=set)
    _catalog_read: bool = False
    # 启动参数快照（retry_without_resume 继承）
    args: dict = field(default_factory=dict)
    # 活门跟踪
    pending_questions: dict = field(default_factory=dict)
    finished: bool = False
    awaiting: bool = False
    task_dir: Any = None

    @property
    def running(self) -> bool:
        return not self.finished

    def snapshot(self) -> 'TsSessionHandle':
        return self


def default_hooks() -> TsBackendHooks:
    """生产接线：复刻 ClaudeCodeBackend 的 event_bus + DB 语义。

    懒 import —— 只有装进 vibe-seller 后才需要这些依赖。
    """
    from app.events.bus import event_bus  # type: ignore
    from app.ai.claude_backend_utils import parse_wait_condition  # type: ignore
    from app.database import async_session  # type: ignore
    from app.models.task import Task  # type: ignore
    from app.models.task_message import TaskMessage, get_next_seq  # type: ignore
    from app.task_outcome import apply_outcome, resolve_outcome  # type: ignore

    async def emit(event_type: str, data: dict) -> None:
        await event_bus.emit(event_type, data)

    async def persist_message(task_id: str, role: str, content: str) -> None:
        async with async_session() as db:
            seq = await get_next_seq(db, task_id)
            db.add(TaskMessage(task_id=task_id, role=role, content=content, seq=seq))
            await db.commit()

    async def save_result(task_id: str, result_text: str) -> None:
        # 红线：prose 只写 transcript_tail，绝不直接写 task.result
        async with async_session() as db:
            task = await db.get(Task, task_id)
            if task:
                task.transcript_tail = result_text
                apply_outcome(task, resolve_outcome(task))
                wait_cond = parse_wait_condition(result_text)
                if wait_cond:
                    task.wait_condition = json.dumps(wait_cond)
                await db.commit()

    async def persist_todos(task_id: str, todos: list) -> None:
        async with async_session() as db:
            task = await db.get(Task, task_id)
            if task:
                task.todos = json.dumps(todos, ensure_ascii=False)
                await db.commit()

    async def save_plan(task_id: str, plan_text: str) -> bool:
        # 复刻 _save_design_plan：plan_history 追加 + task.plan + PLANNED + task_update。
        # fanout 结构校验被拒时返回 False（任务按 plan_invalid 失败，编排器可重试）——
        # 与 CLI 在会话内拒绝重规划不同，桥的 plan run 已结束，这是最接近的终局语义。
        from datetime import datetime, timezone

        from app.ai.claude_backend_utils import validate_fanout_plan_text  # type: ignore
        from app.task_states import TaskStatus  # type: ignore

        violation = await validate_fanout_plan_text(task_id, plan_text)
        if violation:
            logger.warning('Plan validation rejected for task %s: %s', task_id[:8], violation)
            return False
        async with async_session() as db:
            task = await db.get(Task, task_id)
            if not task:
                return False
            try:
                history = json.loads(task.plan_history or '[]')
            except (json.JSONDecodeError, TypeError):
                history = []
            history.append({
                'version': len(history) + 1,
                'content': plan_text,
                'created_at': datetime.now(timezone.utc).isoformat(),
            })
            task.plan_history = json.dumps(history, ensure_ascii=False)
            task.plan = plan_text
            # plan-only（author-only 设计任务）：提交即完成 —— 等价原 is_plan_only 路径
            # （hook 提交 plan 后 DESIGNING/PLANNED → COMPLETED，不再进入执行阶段）
            if getattr(task, 'is_plan_only', False):
                task.status = TaskStatus.COMPLETED
            else:
                task.status = TaskStatus.PLANNED
            task.updated_at = datetime.now(timezone.utc).isoformat()
            await db.commit()
        await emit(
            'task_update',
            {'task_id': task_id, 'status': task.status, 'plan': plan_text, 'error': None},
        )
        return True

    return TsBackendHooks(
        emit=emit,
        persist_message=persist_message,
        save_result=save_result,
        persist_todos=persist_todos,
        save_plan=save_plan,
    )


# ── HTTP/SSE 客户端（stdlib） ──


class TsBridgeClient:
    def __init__(self, base_url: str, token: Optional[str] = None, timeout: float = 30.0):
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.timeout = timeout

    def _headers(self) -> dict:
        h = {'content-type': 'application/json', 'connection': 'close'}
        if self.token:
            h['authorization'] = f'Bearer {self.token}'
        return h

    def _post_sync(self, path: str, body: dict) -> tuple:
        req = urllib.request.Request(
            f'{self.base_url}{path}',
            data=json.dumps(body).encode('utf-8'),
            headers=self._headers(),
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read().decode('utf-8') or '{}')
                return resp.status, payload
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode('utf-8') or '{}')
            except Exception:
                payload = {}
            return e.code, payload

    def _get_sync(self, path: str) -> tuple:
        req = urllib.request.Request(f'{self.base_url}{path}', headers=self._headers(), method='GET')
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read().decode('utf-8') or '{}')
                return resp.status, payload
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode('utf-8') or '{}')
            except Exception:
                payload = {}
            return e.code, payload

    async def post(self, path: str, body: dict) -> tuple:
        return await asyncio.to_thread(self._post_sync, path, body)

    async def get(self, path: str) -> tuple:
        return await asyncio.to_thread(self._get_sync, path)

    async def stream_events(self, path: str, on_event: Callable[[str, dict], Awaitable[None]]) -> None:
        """HTTP/1.0 GET（无 chunked，close 定界）→ 逐帧回调，直到 done/EOF。"""
        reader, writer = await asyncio.open_connection('127.0.0.1', int(self.base_url.rsplit(':', 1)[1]))
        try:
            req = f'GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n'
            if self.token:
                req += f'Authorization: Bearer {self.token}\r\n'
            req += '\r\n'
            writer.write(req.encode('utf-8'))
            await writer.drain()
            # 丢弃响应头
            while True:
                line = await reader.readline()
                if line in (b'\r\n', b'\n', b''):
                    break
            # 解析 SSE 帧
            event_name = ''
            data_lines: list = []
            while not reader.at_eof():
                raw = await reader.readline()
                line = raw.decode('utf-8').rstrip('\r\n')
                if line == '':
                    if event_name and data_lines:
                        try:
                            data = json.loads('\n'.join(data_lines))
                        except json.JSONDecodeError:
                            data = {}
                        await on_event(event_name, data)
                    event_name = ''
                    data_lines = []
                    continue
                if line.startswith('event: '):
                    event_name = line[7:].strip()
                elif line.startswith('data: '):
                    data_lines.append(line[6:])
            if event_name and data_lines:  # EOF 前未收尾的帧
                try:
                    await on_event(event_name, json.loads('\n'.join(data_lines)))
                except json.JSONDecodeError:
                    pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


# ── 后端 ──


class TsAgentBackend(AIAgentBackend):
    """把 agent 执行代理到本机 TS bridge 的 AIAgentBackend 实现。"""

    def __init__(
        self,
        bridge_base_url: str,
        hooks: TsBackendHooks,
        token: Optional[str] = None,
        max_concurrent: int = 4,
    ):
        self.client = TsBridgeClient(bridge_base_url, token=token)
        self.hooks = hooks
        self._sessions: dict = {}
        self._lock = asyncio.Lock()

    # ── run ──

    async def run(
        self,
        task_id: str,
        prompt: str,
        system_extra: str = '',
        mode: str = 'execute',
        on_event: Optional[Callable] = None,
        profile_id: str = 'default',
        message_history: Optional[list] = None,
        no_store: bool = False,
        resume: bool = False,
        auto_approve_plan: bool = False,
        store_slug: Optional[str] = None,
        on_start: Optional[Callable] = None,
        skip_reflection: bool = True,
        persist_prompt: bool = True,
        workspace_dir: Optional[str] = None,
    ) -> bool:
        if mode == 'plan_then_execute' and self.hooks.save_plan is None:
            # plan 模式需要 save_plan 钩子落 plan（活会话审批由编排器的
            # dead-session 回退路径承担；无钩子则设计类任务必须留 CLI）
            raise ValueError('TsAgentBackend: plan_then_execute 需要注入 save_plan 钩子（否则由 CLI 后端承担）')
        async with self._lock:
            if self.is_running(task_id):
                return False
            if on_start is not None:
                if not await on_start():
                    return False
            body = {
                'task_id': task_id,
                'prompt': prompt,
                'system_extra': system_extra,
                'mode': mode if mode in ('execute', 'auto', 'chat', 'plan_then_execute') else 'execute',
                'message_history': message_history or [],
                'workspace_dir': workspace_dir,
                'persist_prompt': persist_prompt,
                'skip_reflection': skip_reflection,
                'resume': resume,
                'profile_id': profile_id,
            }
            status, payload = await self.client.post('/v1/runs', body)
            if status != 202:
                if status == 409:
                    return False
                raise RuntimeError(f'TsAgentBackend: bridge 启动失败 {status}: {payload}')
            handle = TsSessionHandle(
                task_id=task_id,
                run_id=payload['run_id'],
                mode=mode,
                session_id=payload.get('session_id'),
                resume_session_id=task_id if resume else None,
                args={
                    'prompt': prompt,
                    'system_extra': system_extra,
                    'mode': mode,
                    'message_history': list(message_history or []),
                    'no_store': no_store,
                    'auto_approve_plan': auto_approve_plan,
                    'store_slug': store_slug,
                    'skip_reflection': skip_reflection,
                    'workspace_dir': workspace_dir,
                    'profile_id': profile_id,
                },
            )
            self._sessions[task_id] = handle
        asyncio.create_task(self._watch(handle))
        return True

    async def _watch(self, handle: TsSessionHandle) -> None:
        """消费 SSE 并翻译进 event_bus / DB。结构对齐 ClaudeCodeBackend._stream_output。"""
        start = time.monotonic()
        try:
            await self.client.stream_events(
                f'/v1/runs/{handle.run_id}/events',
                lambda name, data: self._on_frame(handle, name, data),
            )
        except Exception as e:  # 连接崩溃：任务绝不能悬死
            logger.exception('[%s] bridge SSE lost: %s', handle.task_id[:8], e)
            handle.error_category = 'bridge_lost'
            handle.return_code = -1
            handle.finished = True
            handle.done.set()
            await self.hooks.emit(
                'agent_done',
                {'task_id': handle.task_id, 'return_code': -1, 'mode': handle.mode, 'interrupted': False},
            )
            return
        handle.finished = True
        handle.done.set()
        logger.info('[%s] bridge run finished in %.1fs (status=%s)', handle.task_id[:8], time.monotonic() - start, handle.error_category or 'ok')

    async def _on_frame(self, handle: TsSessionHandle, name: str, data: dict) -> None:
        if name == 'message':
            role = str(data.get('role', ''))
            content = str(data.get('content', ''))
            if role == 'delta':
                # 流式增量：只广播不落库（与 _emit_ephemeral 一致）
                await self.hooks.emit('task_message', {'task_id': handle.task_id, 'role': role, 'content': content})
                return
            await self.hooks.emit('task_message', {'task_id': handle.task_id, 'role': role, 'content': content})
            await self.hooks.persist_message(handle.task_id, role, content)
        elif name == 'questions':
            handle.pending_questions = {
                'request_id': data.get('request_id'),
                'questions': data.get('questions', []),
            }
            handle.awaiting = True
            await self.hooks.emit(
                'task_questions',
                {'task_id': handle.task_id, 'request_id': data.get('request_id'), 'questions': data.get('questions', [])},
            )
        elif name == 'todos':
            todos = data.get('todos', [])
            await self.hooks.emit('task_todos', {'task_id': handle.task_id, 'todos': todos})
            await self.hooks.persist_todos(handle.task_id, todos)
        elif name == 'status':
            pass  # 内部状态，不发 event_bus
        elif name == 'done':
            status = str(data.get('status', 'failed'))
            handle.result_text = str(data.get('result_text', ''))
            handle.pending_questions = {}
            handle.awaiting = False
            if status in ('completed', 'partial'):
                handle.return_code = 0
                if handle.mode == 'plan_then_execute' and handle.result_text:
                    # plan 落库（等价 ExitPlanMode hook 的 _save_design_plan）；
                    # 成败都算终局——校验被拒时任务带 plan_invalid 落 FAILED，
                    # 编排器可重试；approval 则由 execute_planned_task 的
                    # dead-session 回退路径拉全新 execute 会话。
                    saved = True
                    if self.hooks.save_plan is not None:
                        saved = bool(await self.hooks.save_plan(handle.task_id, handle.result_text))
                    if saved:
                        handle.plan_saved_event.set()
                    else:
                        handle.return_code = 1
                        handle.error_category = 'plan_invalid'
                elif handle.result_text:
                    await self.hooks.save_result(handle.task_id, handle.result_text)
            elif status == 'cancelled':
                handle.return_code = -1
                handle.interrupted = True
            else:
                handle.return_code = 1
                handle.error_category = str(data.get('error_code') or 'runtime_error')
            await self.hooks.emit(
                'agent_done',
                {
                    'task_id': handle.task_id,
                    'return_code': handle.return_code,
                    'mode': handle.mode,
                    **({'interrupted': True} if handle.interrupted else {}),
                },
            )

    # ── 交互面 ──

    async def stop(self, task_id: str) -> bool:
        handle = self._sessions.get(task_id)
        if not handle or handle.finished:
            return False
        status, _ = await self.client.post(f'/v1/runs/{handle.run_id}/stop', {})
        if status not in (200, 409):
            return False
        # 与 CLI 后端语义一致：stop() 等到会话真正结束才返回
        try:
            await asyncio.wait_for(handle.done.wait(), timeout=30)
        except asyncio.TimeoutError:
            logger.warning('[%s] bridge stop timed out waiting for done', task_id[:8])
        return True

    async def submit_answer(self, task_id: str, request_id: str, answers: dict) -> bool:
        handle = self._sessions.get(task_id)
        if not handle or handle.finished or not handle.awaiting:
            return False
        status, _ = await self.client.post(
            f'/v1/runs/{handle.run_id}/answers',
            {'request_id': request_id, 'answers': answers},
        )
        if status == 202:
            handle.pending_questions = {}
            handle.awaiting = False
            return True
        return False

    async def send_message(self, task_id: str, message: str) -> bool:
        # 桥 v1 无活会话续话：恒 False，路由器走 fresh run + message_history fallback
        handle = self._sessions.get(task_id)
        if not handle or handle.finished:
            return False
        status, _ = await self.client.post(f'/v1/runs/{handle.run_id}/messages', {'message': message})
        return status == 202

    async def approve_plan(self, task_id: str) -> bool:
        return False  # 桥 v1 无计划模式

    async def reject_plan(self, task_id: str, feedback: str = '') -> bool:
        return False

    async def retry_without_resume(self, task_id: str) -> bool:
        """编排器 resume 失败重试路径：以原参数重启 fresh run（persist_prompt=False）。"""
        prior = self._sessions.get(task_id)
        if prior is None:
            return False
        args = dict(prior.args)
        args['persist_prompt'] = False
        args['resume'] = False
        self._sessions.pop(task_id, None)
        return await self.run(
            task_id,
            args.get('prompt', ''),
            system_extra=args.get('system_extra', ''),
            mode=args.get('mode', 'execute'),
            profile_id=args.get('profile_id', 'default'),
            message_history=args.get('message_history') or [],
            no_store=args.get('no_store', False),
            auto_approve_plan=args.get('auto_approve_plan', False),
            store_slug=args.get('store_slug'),
            skip_reflection=args.get('skip_reflection', True),
            persist_prompt=False,
            workspace_dir=args.get('workspace_dir'),
        )

    # ── 查询面 ──

    def is_running(self, task_id: str) -> bool:
        handle = self._sessions.get(task_id)
        return bool(handle and not handle.finished)

    def get_session(self, task_id: str) -> Optional[TsSessionHandle]:
        return self._sessions.get(task_id)

    def get_pending_questions(self, task_id: str) -> Optional[dict]:
        handle = self._sessions.get(task_id)
        if not handle:
            return None
        if handle.pending_questions:
            return dict(handle.pending_questions)
        return None

    async def interrupt_pending_question(self, task_id: str) -> Optional[str]:
        """用户发聊天消息而非答题时：解除活门挂起（不当正式答案），发 task_question_interrupted。"""
        pending = self.get_pending_questions(task_id)
        if not pending:
            return None
        request_id = pending.get('request_id')
        note = (
            '[用户没有直接回答上面的问题，而是发送了一条新消息。请阅读用户接下来'
            '的消息并据此继续，不要把这段当作对上面问题的正式回答。]'
        )
        await self.submit_answer(task_id, request_id, {'_free_text': note})
        await self.hooks.emit('task_question_interrupted', {'task_id': task_id, 'request_id': request_id})
        return request_id

    def set_max_concurrent(self, n: int) -> None:
        pass  # 并发上限由桥进程持有；此方法保留 API 兼容

    def loaded_skills_and_workspace(self, task_id: str):
        handle = self._sessions.get(task_id)
        if handle is None:
            return frozenset(), None
        return frozenset(handle._loaded_skills), handle.task_dir

    async def stop_all(self) -> int:
        running = [tid for tid, h in self._sessions.items() if not h.finished]
        for tid in running:
            try:
                await self.stop(tid)
            except Exception:
                logger.warning('stop_all: %s failed', tid, exc_info=True)
        return len(running)
