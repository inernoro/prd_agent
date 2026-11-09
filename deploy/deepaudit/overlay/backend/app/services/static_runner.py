"""Ordinary scans: one task, bounded analyzers, one short-transaction writer."""
import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from sqlalchemy import case, delete, func, select
from app.models.audit import AuditTask, AuditIssue, AuditFileResult
from app.models.project import Project
from app.services.scan_errors import ERROR_MESSAGES, classify_scan_error, record_scan_error
from app.services.scan_options import get_analysis_config
from app.services.scan_snapshot import (archive_path, archive_digest, inspect_archive,
                                        read_file, snapshot_exists, write_manifest)

_active_tasks = set()


def can_resume(task):
    return bool(getattr(task, 'checkpoint_version', 0) == 1 and
                getattr(task, 'total_files', 0) > 0 and
                (task.status in ('failed', 'cancelled') or
                 (task.status == 'completed' and getattr(task, 'failed_files', 0) > 0)) and
                (getattr(task, 'failed_files', 0) > 0 or
                 getattr(task, 'processed_files', 0) < getattr(task, 'total_files', 0)) and
                task.id not in _active_tasks and snapshot_exists(task.id))


def task_active(task_id):
    return task_id in _active_tasks


def _plain_task(task):
    return SimpleNamespace(id=task.id, project_id=task.project_id, created_by=task.created_by,
                           task_type=task.task_type, branch_name=task.branch_name,
                           scan_config=task.scan_config, exclude_patterns=task.exclude_patterns,
                           checkpoint_version=task.checkpoint_version, snapshot_sha256=task.snapshot_sha256)


async def _aggregate(db, task):
    completed = AuditFileResult.status == 'completed'
    row = (await db.execute(select(
        func.count(AuditFileResult.id),
        func.sum(case((completed, 1), else_=0)),
        func.sum(case((AuditFileResult.status == 'failed', 1), else_=0)),
        func.sum(case((AuditFileResult.status == 'skipped', 1), else_=0)),
        func.sum(case((completed, AuditFileResult.line_count), else_=0)),
        func.avg(case((completed, AuditFileResult.quality_score), else_=None)),
    ).where(AuditFileResult.task_id == task.id))).one()
    task.total_files, task.scanned_files, task.failed_files, task.skipped_files, task.total_lines = [int(value or 0) for value in row[:5]]
    task.processed_files = task.scanned_files + task.failed_files + task.skipped_files
    task.quality_score = float(row[5] or 0)
    task.issues_count = (await db.execute(select(func.count(AuditIssue.id)).where(AuditIssue.task_id == task.id))).scalar_one()
    code = (await db.execute(select(AuditFileResult.error_code).where(
        AuditFileResult.task_id == task.id, AuditFileResult.status == 'failed')
        .order_by(AuditFileResult.file_path).limit(1))).scalar_one_or_none()
    task.error_code, task.error_message = code, ERROR_MESSAGES.get(code)


async def run_static_task(task_id, factory, user_config, prepare_source, service_factory,
                          control, is_text_file, should_exclude, language_for_path):
    if task_id in _active_tasks:
        return
    _active_tasks.add(task_id)
    try:
        async with factory() as db:
            task = await db.get(AuditTask, task_id)
            if not task or task.status == 'cancelled':
                return
            task.status = 'running'
            task.error_code = task.error_message = None
            task.started_at = datetime.now(timezone.utc)
            task.completed_at = None
            await db.commit()
            saved = _plain_task(task)
            project = await db.get(Project, task.project_id)
            project_data = {column.name: getattr(project, column.name) for column in Project.__table__.columns} if project else None
        # All ORM objects/sessions are gone before acquisition or model I/O.
        config = dict(user_config or {})
        scan_config = json.loads(saved.scan_config or '{}')
        config['scan_config'] = {**scan_config, **(config.get('scan_config') or {})}
        if not config['scan_config'].get('exclude_patterns'):
            config['scan_config']['exclude_patterns'] = json.loads(saved.exclude_patterns or '[]')
        options = get_analysis_config(config)
        service = service_factory(user_config=config)
        if saved.checkpoint_version != 1:
            source_metadata = await prepare_source(saved, project_data, config, options)
            rows, digest = await asyncio.to_thread(inspect_archive, task_id, config, is_text_file, should_exclude)
            write_manifest(task_id, {'version': 1, 'snapshot_sha256': digest, **(source_metadata or {})})
            async with factory() as db:
                task = await db.get(AuditTask, task_id)
                # A checkpoint and its task marker become visible atomically.
                for row in rows:
                    db.add(AuditFileResult(task_id=task_id, **row))
                task.checkpoint_version = 1
                task.snapshot_sha256 = digest
                await _aggregate(db, task)
                await db.commit()
        else:
            digest = await asyncio.to_thread(archive_digest, archive_path(task_id))
            if digest != saved.snapshot_sha256:
                raise ValueError('Immutable source archive changed')
        async with factory() as db:
            task = await db.get(AuditTask, task_id)
            context = await service.load_analysis_context(db,
                config['scan_config'].get('rule_set_id'), config['scan_config'].get('prompt_template_id'))
            records = (await db.execute(select(AuditFileResult).where(
                AuditFileResult.task_id == task_id, AuditFileResult.status.in_(['pending', 'failed'])))).scalars().all()
            pending = [{column.name: getattr(row, column.name) for column in AuditFileResult.__table__.columns} for row in records]
        await _analyze(task_id, factory, service, context, pending, options, control, language_for_path)
    except asyncio.CancelledError:
        # The process may disappear instead: startup marks it interrupted while the ledger stays intact.
        await _mark_failed(factory, task_id, None)
        raise
    except Exception as error:
        await _mark_failed(factory, task_id, error)
    finally:
        _active_tasks.discard(task_id)
        control.cleanup_task(task_id)


async def _mark_failed(factory, task_id, error):
    async with factory() as db:
        task = await db.get(AuditTask, task_id)
        if not task:
            return
        if task.status != 'cancelled':
            task.status = 'failed'
            record_scan_error(task, error)
        task.completed_at = datetime.now(timezone.utc)
        await db.commit()


async def _analyze(task_id, factory, service, context, pending, options, control, language_for_path):
    count = options['llm_concurrency']
    work = asyncio.Queue(maxsize=max(1, count * 2))
    results = asyncio.Queue(maxsize=max(1, count * 2))
    halted = asyncio.Event()
    rate_lock = asyncio.Lock()
    next_start = 0.0
    consecutive_failures = 0

    def cancelled():
        return control.is_cancelled(task_id)

    async def producer():
        for row in pending:
            if halted.is_set() or cancelled():
                break
            await work.put(row)
        for _ in range(count):
            await work.put(None)

    async def worker():
        nonlocal next_start
        while True:
            row = await work.get()
            if row is None:
                await results.put(None)
                return
            if halted.is_set() or cancelled():
                continue
            try:
                content = await asyncio.to_thread(read_file, task_id, row)
                async with rate_lock:
                    loop = asyncio.get_running_loop()
                    await asyncio.sleep(max(0, next_start - loop.time()))
                    next_start = loop.time() + options['llm_gap_ms'] / 1000
                if halted.is_set() or cancelled():
                    continue
                language = language_for_path(row['file_path'])
                if context and context[0]:
                    analysis = await service.analyze_code_with_custom_prompt(content, language, context[0], context[1])
                else:
                    analysis = await service.analyze_code(content, language)
                if not isinstance(analysis, dict) or not isinstance(analysis.get('issues'), list):
                    raise ValueError('Invalid analysis result')
                await results.put((row, analysis, content.count('\n') + 1, None))
            except asyncio.CancelledError:
                raise
            except Exception as error:
                await results.put((row, None, 0, classify_scan_error(error)))

    async def writer():
        nonlocal consecutive_failures
        stopped = 0
        while stopped < count:
            result = await results.get()
            if result is None:
                stopped += 1
                continue
            row, analysis, lines, error_code = result
            async with factory() as db:
                task = await db.get(AuditTask, task_id)
                record = await db.get(AuditFileResult, row['id'])
                if record.status == 'completed':
                    continue
                await db.execute(delete(AuditIssue).where(AuditIssue.task_id == task_id,
                                                          AuditIssue.file_path == row['file_path']))
                if error_code:
                    record.status, record.error_code = 'failed', error_code
                    consecutive_failures += 1
                    if consecutive_failures >= 5:
                        halted.set()
                else:
                    record.status, record.error_code = 'completed', None
                    record.line_count = lines
                    raw_score = analysis.get('quality_score')
                    record.quality_score = min(100.0, max(0.0, float(raw_score))) if raw_score is not None else None
                    for issue in analysis.get('issues', []):
                        if not isinstance(issue, dict):
                            raise ValueError('Invalid issue result')
                        db.add(AuditIssue(task_id=task_id, file_path=row['file_path'],
                            line_number=issue.get('line', 1), column_number=issue.get('column'),
                            issue_type=issue.get('type', 'maintainability'), severity=issue.get('severity', 'low'),
                            title=issue.get('title', 'Issue'), message=issue.get('title', 'Issue'),
                            description=issue.get('description'), suggestion=issue.get('suggestion'),
                            code_snippet=issue.get('code_snippet'),
                            ai_explanation=json.dumps(issue.get('xai')) if issue.get('xai') else None, status='open'))
                    consecutive_failures = 0
                await _aggregate(db, task)
                await db.commit()
        async with factory() as db:
            task = await db.get(AuditTask, task_id)
            await _aggregate(db, task)
            if cancelled() or task.status == 'cancelled':
                task.status = 'cancelled'
            elif halted.is_set() or task.scanned_files == 0:
                task.status = 'failed'
                if not task.error_code:
                    record_scan_error(task)
            else:
                task.status = 'completed'
            task.completed_at = datetime.now(timezone.utc)
            await db.commit()

    # A failing writer must cancel producers/workers, rather than leave a blocked queue behind.
    async with asyncio.TaskGroup() as group:
        group.create_task(producer())
        for _ in range(count):
            group.create_task(worker())
        group.create_task(writer())
