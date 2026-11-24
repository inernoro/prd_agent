"""Real ORM and immutable archives, controlled model I/O; no external scans."""
import asyncio
import contextvars
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
import uuid
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from fastapi import BackgroundTasks, HTTPException, UploadFile
from sqlalchemy import create_engine, select, inspect
from sqlalchemy.orm import Session
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.core.config import settings
from app.db.base import Base
from app.models import User, Project, AuditTask, AuditIssue, AuditFileResult
from app.api.v1.endpoints import scan, tasks
from app.services import scanner, static_runner
from app.services.scan_options import get_analysis_config
from app.services.scan_snapshot import archive_path, snapshot_exists

_db_depth = contextvars.ContextVar('test_db_depth', default=0)


class ControlledModel:
    def __init__(self, delay=.005, block_after=None):
        self.calls, self.active, self.peak = [], 0, 0
        self.delay, self.block_after = delay, block_after
        self.blocked = asyncio.Event()
        self.context_reads = 0

    async def load_analysis_context(self, db, *args):
        assert _db_depth.get() == 1
        self.context_reads += 1
        return 'resolved prompt', [{'rule_code': 'test'}]

    async def analyze_code_with_custom_prompt(self, content, language, prompt, rules):
        return await self.analyze_code(content, language)

    async def analyze_code(self, content, language):
        assert _db_depth.get() == 0, 'A model worker retained a database session'
        self.calls.append(content)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            if self.block_after is not None and len(self.calls) > self.block_after:
                await self.blocked.wait()
            await asyncio.sleep(self.delay)
            return {'issues': [{'title': hashlib.sha256(content.encode()).hexdigest(), 'line': 1, 'type': 'security', 'severity': 'high'}], 'quality_score': 80}
        finally:
            self.active -= 1


class NativeRunner(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = patch.object(settings, 'ZIP_STORAGE_PATH', str(pathlib.Path(self.directory.name) / 'persistent'))
        self.storage.start()
        self.engine = create_engine('sqlite://')
        Base.metadata.create_all(self.engine, tables=[User.__table__, Project.__table__, AuditTask.__table__, AuditIssue.__table__, AuditFileResult.__table__])
        with Session(self.engine) as session:
            session.add(User(id='user', email='test@example.com', hashed_password='unit-test-only'))
            session.add(Project(id='project', name='project', owner_id='user', repository_url='https://github.com/example/repo', repository_type='github'))
            session.commit()
        engine = self.engine
        class Database:
            async def __aenter__(self):
                self.session = Session(engine, expire_on_commit=False)
                self.token = _db_depth.set(_db_depth.get() + 1)
                return self
            async def __aexit__(self, *args):
                if not getattr(self, "closed", False):
                    self.session.close()
                    _db_depth.reset(self.token)
                    self.closed = True
            async def get(self, model, identity): return self.session.get(model, identity)
            async def execute(self, statement): return self.session.execute(statement)
            async def commit(self): self.session.commit()
            async def refresh(self, entity): self.session.refresh(entity)
            async def close(self):
                if not getattr(self, "closed", False):
                    self.session.close()
                    _db_depth.reset(self.token)
                    self.closed = True
            def add(self, value): self.session.add(value)
        self.factory = Database

    def tearDown(self):
        self.engine.dispose(); self.storage.stop(); self.directory.cleanup()

    def new_task(self, config=None, files=40):
        task_id = str(uuid.uuid4())
        path = pathlib.Path(self.directory.name) / (task_id + '.zip')
        with zipfile.ZipFile(path, 'w') as archive:
            for index in range(files): archive.writestr(f'src/file{index}.py', f'# file {index}\nvalue = {index}\n')
        with Session(self.engine) as session:
            session.add(AuditTask(id=task_id, project_id='project', created_by='user', task_type='zip_upload', status='pending', scan_config=json.dumps(config or {})))
            session.commit()
        return task_id, path

    def read(self, task_id):
        with Session(self.engine, expire_on_commit=False) as session:
            task = session.get(AuditTask, task_id)
            session.expunge(task)
            return task

    async def run_zip(self, task_id, path, model, config=None):
        with patch.object(scan, 'LLMService', return_value=model):
            await scan.process_zip_task(task_id, str(path), self.factory, config or {'otherConfig': {'llmGapMs': 0}})

    async def test_one_task_40_files_uses_bounded_four_worker_analysis_and_one_result(self):
        task_id, path = self.new_task({'max_analyze_files': 0, 'llm_concurrency': 4, 'llm_gap_ms': 0})
        model = ControlledModel()
        await self.run_zip(task_id, path, model)
        task = self.read(task_id)
        self.assertEqual((task.status, task.total_files, task.scanned_files, task.processed_files, task.issues_count), ('completed', 40, 40, 40, 40))
        self.assertEqual(model.peak, 4)
        self.assertEqual(len(model.calls), 40)
        self.assertEqual(task.checkpoint_version, 1)
        self.assertFalse(task.resumable)
        self.assertEqual(archive_path(task_id).stat().st_mode & 0o777, 0o600)
        self.assertEqual((archive_path(task_id).parent / 'manifest.json').stat().st_mode & 0o777, 0o600)
        with Session(self.engine) as session:
            self.assertEqual(len(session.scalars(select(AuditTask)).all()), 1)
            self.assertEqual(len(session.scalars(select(AuditIssue)).all()), 40)
            self.assertEqual(len(session.scalars(select(AuditFileResult)).all()), 40)

    async def test_native_github_uses_same_runner_and_freezes_source_before_analysis(self):
        task_id, _ = self.new_task({'llm_concurrency': 2, 'llm_gap_ms': 0}, files=0)
        with Session(self.engine) as session:
            session.get(AuditTask, task_id).task_type = 'repository'; session.commit()
        async def acquire(*args, **kwargs):
            self.assertEqual(_db_depth.get(), 0)
            return 'value = 1'
        model = ControlledModel()
        files = [{'path': 'one.py', 'url': 'https://example.invalid/one'}, {'path': 'two.py', 'url': 'https://example.invalid/two'}]
        with patch.object(scanner, 'LLMService', return_value=model), patch.object(scanner, 'github_api', AsyncMock(return_value={'sha': 'f' * 40})), patch.object(scanner, 'get_github_files', AsyncMock(return_value=files)), patch.object(scanner, 'fetch_file_content', side_effect=acquire):
            await scanner.scan_repo_task(task_id, self.factory, {})
        self.assertEqual((self.read(task_id).status, self.read(task_id).scanned_files), ('completed', 2))
        self.assertEqual(len(model.calls), 2)
        self.assertTrue(snapshot_exists(task_id))

    async def test_eight_worker_configuration_is_honored(self):
        task_id, path = self.new_task({'llm_concurrency': 8, 'llm_gap_ms': 0}, files=16)
        model = ControlledModel(delay=.02)
        await self.run_zip(task_id, path, model)
        self.assertEqual(model.peak, 8)
        self.assertEqual(self.read(task_id).scanned_files, 16)

    async def test_rules_are_preloaded_once_and_no_session_crosses_model_await(self):
        task_id, path = self.new_task({'rule_set_id': 'rules', 'prompt_template_id': 'prompt', 'llm_concurrency': 4, 'llm_gap_ms': 0}, files=8)
        model = ControlledModel()
        await self.run_zip(task_id, path, model)
        self.assertEqual(model.context_reads, 1)
        self.assertEqual(self.read(task_id).scanned_files, 8)

    async def test_interrupted_task_resumes_same_id_without_reanalyzing_completed_files(self):
        task_id, path = self.new_task({'llm_concurrency': 4, 'llm_gap_ms': 0})
        first = ControlledModel(block_after=8)
        running = asyncio.create_task(self.run_zip(task_id, path, first))
        try:
            for _ in range(200):
                if self.read(task_id).scanned_files >= 5: break
                await asyncio.sleep(.005)
            self.assertGreaterEqual(self.read(task_id).scanned_files, 5)
        finally:
            running.cancel()
            with self.assertRaises(asyncio.CancelledError): await running
        before = self.read(task_id)
        self.assertEqual(before.status, 'failed'); self.assertTrue(before.resumable)
        with Session(self.engine) as session:
            completed = session.scalars(select(AuditFileResult).where(AuditFileResult.task_id == task_id, AuditFileResult.status == 'completed')).all()
            finished_hashes = {row.source_hash for row in completed}
        # Changing a project's latest ZIP cannot alter this task's frozen snapshot.
        path.write_bytes(b'replaced-project-upload')
        again = ControlledModel()
        await self.run_zip(task_id, path, again)
        self.assertFalse(finished_hashes & {hashlib.sha256(content.encode()).hexdigest() for content in again.calls})
        after = self.read(task_id)
        self.assertEqual((after.status, after.scanned_files, after.issues_count), ('completed', 40, 40))
        self.assertEqual(after.id, before.id)
        with Session(self.engine) as session:
            self.assertEqual(len(session.scalars(select(AuditIssue)).all()), 40)

    async def test_user_cancel_does_not_auto_restart_and_explicit_resume_keeps_identity(self):
        task_id, path = self.new_task({'llm_concurrency': 2, 'llm_gap_ms': 0})
        first = ControlledModel(block_after=4)
        running = asyncio.create_task(self.run_zip(task_id, path, first))
        for _ in range(200):
            if self.read(task_id).scanned_files >= 4: break
            await asyncio.sleep(.005)
        async with self.factory() as db:
            await tasks.cancel_task(task_id, db, SimpleNamespace(id='user'))
        first.blocked.set()
        await running
        self.assertEqual(self.read(task_id).status, 'cancelled')
        self.assertTrue(self.read(task_id).resumable)
        blocked = ControlledModel()
        await self.run_zip(task_id, path, blocked)
        self.assertEqual(blocked.calls, [])
        background = BackgroundTasks()
        again = ControlledModel()
        with patch.object(tasks, 'AsyncSessionLocal', self.factory), patch.object(scan, 'get_user_config_dict', AsyncMock(return_value={})), patch.object(scan, 'LLMService', return_value=again):
            async with self.factory() as db:
                result = await tasks.resume_task(task_id, background, db, SimpleNamespace(id='user'))
                self.assertEqual(_db_depth.get(), 0)
                self.assertEqual(result, {'task_id': task_id, 'status': 'started'})
                await background()
        self.assertEqual((self.read(task_id).status, self.read(task_id).scanned_files), ('completed', 40))

    async def test_upload_releases_dependency_session_before_background_model_calls(self):
        path = pathlib.Path(self.directory.name) / 'upload.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            for index in range(4): archive.writestr(f'file{index}.py', f'value = {index}')
        background = BackgroundTasks()
        model = ControlledModel()
        with open(path, 'rb') as source, patch.object(scan, 'get_user_config_dict', AsyncMock(return_value={})), patch.object(scan, 'AsyncSessionLocal', self.factory), patch.object(scan, 'LLMService', return_value=model):
            async with self.factory() as db:
                result = await scan.scan_zip(background, 'project', UploadFile(filename='source.zip', file=source), json.dumps({'max_analyze_files': 0, 'llm_concurrency': 2, 'llm_gap_ms': 0}), db, SimpleNamespace(id='user'))
                self.assertEqual(_db_depth.get(), 0)
                await background()
        self.assertEqual(self.read(result['task_id']).scanned_files, 4)

    async def test_unsafe_zip_fails_without_extraction_or_model_execution(self):
        task_id, path = self.new_task(files=0)
        with zipfile.ZipFile(path, 'w') as archive: archive.writestr('../outside.py', 'raise SystemExit()')
        model = ControlledModel()
        await self.run_zip(task_id, path, model)
        self.assertEqual(model.calls, [])
        self.assertEqual(self.read(task_id).status, 'failed')
        self.assertFalse(self.read(task_id).resumable)
        self.assertFalse((pathlib.Path(self.directory.name) / 'outside.py').exists())

    async def test_explicit_targets_keep_skipped_reasons_and_never_count_as_analyzed(self):
        names = ['good.py', 'empty.py', 'asset.png', 'vendor/skipped.py', 'missing.py']
        task_id, path = self.new_task({'file_paths': names, 'llm_gap_ms': 0}, files=0)
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('good.py', 'value = 1'); archive.writestr('empty.py', '')
            archive.writestr('asset.png', 'binary'); archive.writestr('vendor/skipped.py', 'value = 2')
        await self.run_zip(task_id, path, ControlledModel())
        task = self.read(task_id)
        self.assertEqual((task.total_files, task.scanned_files, task.skipped_files, task.processed_files), (5, 1, 4, 5))
        self.assertFalse(task.resumable)
        with Session(self.engine) as session:
            reasons = {row.skip_reason for row in session.scalars(select(AuditFileResult)).all() if row.status == 'skipped'}
        self.assertEqual(reasons, {'EMPTY_FILE', 'UNSUPPORTED_TYPE', 'EXCLUDED_BY_POLICY', 'MISSING_SOURCE'})

    async def test_whole_file_input_is_not_truncated(self):
        task_id, path = self.new_task({'llm_gap_ms': 0}, files=0)
        content = '# start\n' + 'value = 1\n' * 9000 + '# END_OF_FILE_MARKER'
        with zipfile.ZipFile(path, 'w') as archive: archive.writestr('large.py', content)
        model = ControlledModel()
        await self.run_zip(task_id, path, model)
        self.assertEqual(model.calls, [content])

    async def test_resume_permissions_active_worker_and_broken_snapshot_fail_closed(self):
        task_id, path = self.new_task({'llm_gap_ms': 0}, files=2)
        model = ControlledModel()
        await self.run_zip(task_id, path, model)
        with Session(self.engine) as session:
            task = session.get(AuditTask, task_id); task.status = 'failed'
            row = session.scalars(select(AuditFileResult).limit(1)).one(); row.status = 'failed'; row.error_code = 'MODEL_TIMEOUT'
            task.failed_files = 1; task.scanned_files = 1; task.processed_files = 2; session.commit()
        self.assertTrue(self.read(task_id).resumable)
        async with self.factory() as db:
            with self.assertRaises(HTTPException) as denied:
                await tasks.resume_task(task_id, BackgroundTasks(), db, SimpleNamespace(id='other'))
            self.assertEqual(denied.exception.status_code, 403)
        static_runner._active_tasks.add(task_id)
        try:
            async with self.factory() as db:
                with self.assertRaises(HTTPException) as busy:
                    await tasks.resume_task(task_id, BackgroundTasks(), db, SimpleNamespace(id='user'))
                self.assertEqual(busy.exception.status_code, 409)
        finally: static_runner._active_tasks.discard(task_id)
        archive_path(task_id).write_bytes(b'broken')
        self.assertFalse(self.read(task_id).resumable)
        async with self.factory() as db:
            with self.assertRaises(HTTPException) as missing:
                await tasks.resume_task(task_id, BackgroundTasks(), db, SimpleNamespace(id='user'))
            self.assertEqual(missing.exception.status_code, 409)

    async def test_cancelled_legacy_task_is_never_falsely_resumable(self):
        task_id, _ = self.new_task(files=1)
        with Session(self.engine) as session:
            session.get(AuditTask, task_id).status = 'failed'; session.commit()
        self.assertEqual(self.read(task_id).checkpoint_version, 0)
        self.assertFalse(self.read(task_id).resumable)

    async def test_pagination_is_stable_and_count_is_full_task_count(self):
        task_id, path = self.new_task({'llm_concurrency': 4, 'llm_gap_ms': 0}, files=40)
        await self.run_zip(task_id, path, ControlledModel())
        async with self.factory() as db:
            first = await tasks.read_task_issues(task_id, 0, 17, db, SimpleNamespace(id='user'))
            second = await tasks.read_task_issues(task_id, 17, 17, db, SimpleNamespace(id='user'))
            third = await tasks.read_task_issues(task_id, 34, 17, db, SimpleNamespace(id='user'))
        identities = [row.id for row in first + second + third]
        self.assertEqual(identities, sorted(set(identities)))
        self.assertEqual(len(identities), 40)
        self.assertEqual(self.read(task_id).issues_count, 40)

    def test_zero_and_configuration_precedence_and_default_two(self):
        with patch.object(settings, 'MAX_ANALYZE_FILES', 12), patch.object(settings, 'LLM_CONCURRENCY', 2), patch.object(settings, 'LLM_GAP_MS', 2000):
            value = get_analysis_config({'otherConfig': {'maxAnalyzeFiles': 12, 'llmConcurrency': 8}, 'scan_config': {'max_analyze_files': 0, 'llm_concurrency': 4, 'llm_gap_ms': 0}})
            self.assertEqual(value, {'max_analyze_files': 0, 'llm_concurrency': 4, 'llm_gap_ms': 0})
            self.assertEqual(get_analysis_config()['llm_concurrency'], 2)
            self.assertEqual(get_analysis_config({'otherConfig': {'maxAnalyzeFiles': 0}})['max_analyze_files'], 0)

    def test_checkpoint_migration_preserves_old_tasks_without_fake_resume(self):
        path = pathlib.Path(__file__).resolve().parents[1] / 'alembic/versions/010_ordinary_scan_checkpoints.py'
        spec = importlib.util.spec_from_file_location('checkpoint_migration', path)
        migration = importlib.util.module_from_spec(spec); spec.loader.exec_module(migration)
        engine = create_engine('sqlite://')
        with engine.begin() as connection:
            connection.exec_driver_sql('CREATE TABLE audit_tasks (id VARCHAR PRIMARY KEY)')
            connection.exec_driver_sql("INSERT INTO audit_tasks (id) VALUES ('legacy')")
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
                self.assertEqual(connection.exec_driver_sql('SELECT checkpoint_version, processed_files FROM audit_tasks').one(), (0, 0))
                self.assertIn('audit_file_results', inspect(connection).get_table_names())
                migration.downgrade()
                self.assertEqual(connection.exec_driver_sql('SELECT id FROM audit_tasks').scalar(), 'legacy')
        engine.dispose()


if __name__ == '__main__': unittest.main()
