"""Safe failure contract and real ORM/scan orchestration, without provider calls."""
import importlib.util
import pathlib
import tempfile
import unittest
import uuid
import zipfile
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.db.base import Base
from app.models import User, Project, AuditTask, AuditFileResult, AuditIssue
from app.api.v1.endpoints.tasks import AuditTaskSchema
from app.api.v1.endpoints import scan
from app.services import scanner
from app.services.llm.types import LLMError
from app.services.scan_errors import ERROR_MESSAGES, classify_scan_error, record_scan_error


class ProviderError(Exception):
    def __init__(self, status, body=None):
        super().__init__('private-provider-response SECRET-TEST-KEY source-code')
        self.status_code, self.body = status, body


class SafeFailureContract(unittest.TestCase):
    def test_known_structured_statuses_and_pool_code(self):
        for error, code in [(ProviderError(503, {'error': {'code': 'MODEL_POOL_ALL_UNAVAILABLE'}}), 'MODEL_POOL_ALL_UNAVAILABLE'),
                            (ProviderError(429), 'MODEL_RATE_LIMITED'), (ProviderError(401), 'MODEL_AUTH_FAILED'),
                            (ProviderError(403), 'MODEL_AUTH_FAILED'), (ProviderError(504), 'MODEL_TIMEOUT'),
                            (TimeoutError('SECRET-TEST-KEY'), 'MODEL_TIMEOUT')]:
            with self.subTest(code=code): self.assertEqual(classify_scan_error(error), code)

    def test_real_adapter_wrapper_retains_structured_gateway_failure(self):
        error = LLMError("API service unavailable", status_code=503,
                         api_response='{"error":{"code":"MODEL_POOL_ALL_UNAVAILABLE","message":"SECRET-TEST-KEY"}}')
        self.assertEqual(classify_scan_error(error), "MODEL_POOL_ALL_UNAVAILABLE")
        wrapped = LLMError("generic wrapper", original_error=ProviderError(429))
        self.assertEqual(classify_scan_error(wrapped), "MODEL_RATE_LIMITED")

    def test_plain_provider_text_does_not_invent_a_known_cause(self):
        self.assertEqual(classify_scan_error(Exception('429 timeout MODEL_POOL_ALL_UNAVAILABLE')), 'ANALYSIS_FAILED')
        self.assertEqual(classify_scan_error(ProviderError(503)), 'ANALYSIS_FAILED')

    def test_nested_failure_preserves_specific_cause_without_disclosing_it(self):
        error = RuntimeError('wrapper SECRET-TEST-KEY')
        error.__cause__ = ProviderError(429)
        task = SimpleNamespace(error_code=None)
        record_scan_error(task, error); record_scan_error(task, Exception('consecutive failures'))
        self.assertEqual(task.error_code, 'MODEL_RATE_LIMITED')
        self.assertEqual(task.error_message, ERROR_MESSAGES[task.error_code])
        self.assertNotIn('SECRET', task.error_message)

    def test_schema_omits_unknown_codes_and_replaces_arbitrary_provider_messages(self):
        data = dict(id='task', project_id='project', task_type='repository', status='failed', created_by='user', created_at=datetime.now(timezone.utc))
        known = AuditTaskSchema(**data, error_code='MODEL_TIMEOUT', error_message='SECRET-TEST-KEY source-code')
        self.assertEqual(known.error_message, ERROR_MESSAGES['MODEL_TIMEOUT'])
        old = AuditTaskSchema(**data)
        self.assertIsNone(old.error_code); self.assertIsNone(old.error_message)
        unknown = AuditTaskSchema(**data, error_code='secret-provider-code', error_message='SECRET-TEST-KEY')
        self.assertIsNone(unknown.error_code); self.assertIsNone(unknown.error_message)

    def test_actual_migration_preserves_existing_task_rows(self):
        path = pathlib.Path(__file__).resolve().parents[1] / 'alembic/versions/009_cds_scan_failure_details.py'
        spec = importlib.util.spec_from_file_location('scan_failure_migration', path)
        migration = importlib.util.module_from_spec(spec); spec.loader.exec_module(migration)
        engine = create_engine('sqlite://')
        with engine.begin() as connection:
            connection.exec_driver_sql('CREATE TABLE audit_tasks (id VARCHAR PRIMARY KEY)')
            connection.exec_driver_sql("INSERT INTO audit_tasks (id) VALUES ('existing')")
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
                self.assertEqual({c['name'] for c in inspect(connection).get_columns('audit_tasks')}, {'id', 'error_code', 'error_message'})
                self.assertEqual(connection.exec_driver_sql('SELECT * FROM audit_tasks').one(), ('existing', None, None))
                migration.downgrade()
                self.assertEqual(connection.exec_driver_sql('SELECT id FROM audit_tasks').scalar(), 'existing')
        engine.dispose()


class ScanFailurePersistence(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://')
        Base.metadata.create_all(self.engine, tables=[User.__table__, Project.__table__, AuditTask.__table__, AuditFileResult.__table__, AuditIssue.__table__])
        self.session = Session(self.engine, expire_on_commit=False)
        user = User(id='user', email='test@example.com', hashed_password='not-a-real-password')
        project = Project(id='project', name='test', owner_id='user', repository_url='https://github.com/example/repo', repository_type='github')
        self.task = AuditTask(id=str(uuid.uuid4()), project_id='project', created_by='user', task_type='repository', status='pending')
        self.session.add_all([user, project, self.task]); self.session.commit()
        session = self.session
        class Database:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def get(self, model, identity): return session.get(model, identity)
            async def commit(self): session.commit()
            async def execute(self, statement): return session.execute(statement)
            def add(self, entity): session.add(entity)
        self.factory = Database
        self.config = {'otherConfig': {'llmGapMs': 1, 'maxAnalyzeFiles': 0}}

    def tearDown(self):
        self.session.close(); self.engine.dispose()

    def assert_persisted(self, code, status, scanned):
        self.session.expire_all(); stored = self.session.get(AuditTask, self.task.id)
        self.assertEqual((stored.error_code, stored.status, stored.scanned_files), (code, status, scanned))
        self.assertEqual(stored.error_message, ERROR_MESSAGES[code])
        self.assertNotIn('SECRET', stored.error_message)

    async def test_zip_all_failed_records_safe_pool_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'source.zip'
            with zipfile.ZipFile(path, 'w') as archive: archive.writestr('test.py', 'x = 1')
            service = SimpleNamespace(analyze_code=AsyncMock(side_effect=ProviderError(503, {'error': {'code': 'MODEL_POOL_ALL_UNAVAILABLE'}})))
            with patch.object(scan, 'LLMService', return_value=service):
                await scan.process_zip_task(self.task.id, str(path), self.factory, self.config)
        self.assert_persisted('MODEL_POOL_ALL_UNAVAILABLE', 'failed', 0)
        self.assertEqual(self.task.total_files, 1)

    async def test_zip_partial_scan_retains_coverage_and_failure_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'source.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('first.py', 'x = 1'); archive.writestr('second.py', 'y = 2')
            service = SimpleNamespace(analyze_code=AsyncMock(side_effect=[TimeoutError(), {'issues': [], 'quality_score': 90}]))
            with patch.object(scan, 'LLMService', return_value=service):
                await scan.process_zip_task(self.task.id, str(path), self.factory, self.config)
        self.assert_persisted('MODEL_TIMEOUT', 'completed', 1)
        self.assertEqual(self.task.total_files, 2)

    async def test_repository_consecutive_failure_does_not_erase_pool_cause(self):
        service = SimpleNamespace(analyze_code=AsyncMock(side_effect=ProviderError(503, {'error': {'code': 'MODEL_POOL_ALL_UNAVAILABLE'}})))
        files = [{'path': f'file{i}.py', 'url': 'https://example.invalid/file'} for i in range(6)]
        with patch.object(scanner, 'LLMService', return_value=service), patch.object(scanner, 'github_api', AsyncMock(return_value={'sha': 'f' * 40})), patch.object(scanner, 'get_github_files', AsyncMock(return_value=files)), patch.object(scanner, 'fetch_file_content', AsyncMock(return_value='x = 1')):
            await scanner.scan_repo_task(self.task.id, self.factory, self.config)
        self.assert_persisted('MODEL_POOL_ALL_UNAVAILABLE', 'failed', 0)
        self.assertEqual(self.task.total_files, 6)


if __name__ == '__main__': unittest.main()
