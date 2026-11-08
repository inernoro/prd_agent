"""Release preflight checks, deliberately dependency-free."""
import ast
import asyncio
import json
import importlib.util
import pathlib
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace, ModuleType
from unittest.mock import AsyncMock, Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]


class StaticRuntimePolicy(unittest.TestCase):
    def test_weak_or_missing_independent_secrets_are_rejected(self):
        tree = ast.parse((ROOT / "backend/app/cds_runtime.py").read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == "validate_runtime_config")
        scope = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "runtime", "exec"), scope)
        validate = scope["validate_runtime_config"]
        valid = {"SECRET_KEY": "s" * 64, "CDS_SERVICE_EMAIL": "review@example.invalid",
                 "CDS_SERVICE_PASSWORD": "p" * 32, "DATABASE_URL": "postgresql+asyncpg://db/test",
                 "LLM_API_KEY": "dedicated-test-key", "LLM_MODEL": "test-model"}
        self.assertEqual(validate(valid), (valid["CDS_SERVICE_EMAIL"], valid["CDS_SERVICE_PASSWORD"]))
        for key in valid:
            with self.subTest(key=key):
                with self.assertRaises(RuntimeError):
                    validate({**valid, key: ""})
        for key, value in [("SECRET_KEY", "changethis" + "x" * 40),
                           ("CDS_SERVICE_EMAIL", "demo@example.com"),
                           ("CDS_SERVICE_EMAIL", "cds-admin@example.com"),
                           ("CDS_SERVICE_PASSWORD", "demo123")]:
            with self.subTest(key=key):
                with self.assertRaises(RuntimeError):
                    validate({**valid, key: value})

    def test_runtime_does_not_mount_dynamic_routers_or_demo_lifespan(self):
        source = (ROOT / "backend/app/cds_runtime.py").read_text()
        tree = ast.parse(source)
        imports = [alias.name for node in ast.walk(tree)
                   if isinstance(node, ast.ImportFrom) for alias in node.names]
        self.assertNotIn("agent_tasks", imports)
        self.assertNotIn("ssh_keys", imports)
        self.assertNotIn("init_db", imports)
        self.assertIn("is_active=False", source)
        self.assertIn("/auth/register", source)

    def test_images_and_volumes_do_not_enable_host_execution(self):
        for name in ("cds-compose.yml", "docker-compose.cds-release.yml"):
            source = (ROOT / name).read_text()
            self.assertNotIn("docker.sock", source)
            self.assertNotIn("privileged:", source)
            self.assertNotIn(":latest", source)
            self.assertIn("sha-${CDS_COMMIT_SHA", source)
            if name == "docker-compose.cds-release.yml":
                self.assertIn("backend-uploads", source)
        import json
        plan = json.loads((ROOT / "cds-storage-plan.json").read_text())
        self.assertEqual({item["containerPath"] for item in plan["backend"]},
                         {"/app/uploads", "/app/data"})
        self.assertTrue(all(item["purpose"] == "persistent" for item in plan["backend"]))


class StaticRunnerPromptContext(unittest.IsolatedAsyncioTestCase):
    async def test_original_runner_loads_default_or_explicit_context_once_before_analysis(self):
        source = ROOT / 'backend/app/services/static_runner.py'
        tree = ast.parse(source.read_text())
        functions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                     and node.name in ('_plain_task', 'run_static_task')]
        for scan_config in ({}, {'rule_set_id': 'rules'}, {'prompt_template_id': 'explicit'}):
            with self.subTest(scan_config=scan_config):
                audit_type, project_type = object(), object()
                task = SimpleNamespace(id='fixed-task', project_id='fixed-project', created_by='owner',
                    task_type='zip_upload', branch_name=None, scan_config=json.dumps(scan_config),
                    exclude_patterns='[]', checkpoint_version=1, snapshot_sha256='fixed-digest', status='pending')
                db = SimpleNamespace(get=AsyncMock(side_effect=lambda model, _id: task if model is audit_type else None),
                    commit=AsyncMock(), execute=AsyncMock(return_value=SimpleNamespace(
                        scalars=lambda: SimpleNamespace(all=lambda: []))))
                class Database:
                    async def __aenter__(self): return db
                    async def __aexit__(self, *args): pass
                context = ('configured administrator prompt', [{'rule_code': 'configured'}])
                model = SimpleNamespace(load_analysis_context=AsyncMock(return_value=context))
                analyze, failed, prepare = AsyncMock(), AsyncMock(), AsyncMock()
                control = SimpleNamespace(cleanup_task=Mock())
                scope = dict(asyncio=asyncio, json=json, datetime=datetime, timezone=timezone, SimpleNamespace=SimpleNamespace,
                    AuditTask=audit_type, Project=project_type, _active_tasks=set(), get_analysis_config=lambda _config: {},
                    archive_path=lambda _id: 'fixed-archive', archive_digest=lambda _path: 'fixed-digest',
                    AuditFileResult=SimpleNamespace(task_id=None, status=SimpleNamespace(in_=lambda _values: None)),
                    select=lambda _model: SimpleNamespace(where=lambda *args: None), _analyze=analyze, _mark_failed=failed)
                exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), scope)
                await scope['run_static_task']('fixed-task', Database, {}, prepare,
                    lambda **_kwargs: model, control, lambda _path: True, lambda _path: False, lambda _path: 'python')
                failed.assert_not_awaited(); prepare.assert_not_awaited()
                model.load_analysis_context.assert_awaited_once_with(db, scan_config.get('rule_set_id'), scan_config.get('prompt_template_id'))
                self.assertEqual(analyze.await_args.args[3], context)
                self.assertFalse(scope['_active_tasks'])


class StaticRunnerResultContract(unittest.IsolatedAsyncioTestCase):
    async def test_missing_issues_never_commits_completed_file_but_explicit_empty_list_does(self):
        source = ROOT / 'backend/app/services/static_runner.py'
        tree = ast.parse(source.read_text())
        analyze = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == '_analyze')
        for analysis, expected in [({'error': 'analysis unavailable'}, 'failed'), ({}, 'failed'),
                                   ({'issues': None}, 'failed'), ({'issues': []}, 'completed')]:
            with self.subTest(analysis=analysis):
                task_type, file_type = object(), object()
                task = SimpleNamespace(status='running', scanned_files=0, error_code=None)
                record = SimpleNamespace(status='pending', error_code=None, line_count=0, quality_score=None)
                db = SimpleNamespace(get=AsyncMock(side_effect=lambda model, _id: task if model is task_type else record),
                    execute=AsyncMock(), commit=AsyncMock(), add=Mock())
                class Database:
                    async def __aenter__(self): return db
                    async def __aexit__(self, *args): pass
                class Statement:
                    def where(self, *args): return self
                async def aggregate(_db, current):
                    current.scanned_files = int(record.status == 'completed')
                service = SimpleNamespace(analyze_code=AsyncMock(return_value=analysis))
                scope = dict(asyncio=asyncio, datetime=datetime, timezone=timezone, json=json,
                    read_file=lambda *_args: 'original full file', AuditTask=task_type, AuditFileResult=file_type,
                    AuditIssue=SimpleNamespace(task_id=None, file_path=None), delete=lambda _model: Statement(),
                    classify_scan_error=lambda _error: 'ANALYSIS_FAILED', _aggregate=aggregate, record_scan_error=Mock())
                exec(compile(ast.Module(body=[analyze], type_ignores=[]), str(source), 'exec'), scope)
                await scope['_analyze']('fixed-task', Database, service, None,
                    [{'id': 'fixed-file', 'file_path': 'original.py'}], {'llm_concurrency': 1, 'llm_gap_ms': 0},
                    SimpleNamespace(is_cancelled=lambda _id: False), lambda _path: 'python')
                self.assertEqual(record.status, expected)
                self.assertEqual(task.status, expected)
                self.assertEqual(task.scanned_files, int(expected == 'completed'))
                self.assertEqual(record.error_code, None if expected == 'completed' else 'ANALYSIS_FAILED')
                service.analyze_code.assert_awaited_once_with('original full file', 'python')
                db.add.assert_not_called()


def endpoint_function(name, scope):
    source = ROOT / 'backend/app/api/v1/endpoints/tasks.py'
    function = next(node for node in ast.parse(source.read_text()).body
                    if isinstance(node, ast.AsyncFunctionDef) and node.name == name)
    function.decorator_list = []
    for node in ast.walk(function):
        if isinstance(node, ast.arg): node.annotation = None
    function.returns = None
    scope.update(Depends=lambda _: None, get_db=None, deps=SimpleNamespace(get_current_user=None))
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), scope)
    return scope[name]


class NativeTaskOwnership(unittest.IsolatedAsyncioTestCase):
    async def test_issue_update_checks_owner_before_reading_or_changing_issue(self):
        class Denied(Exception):
            def __init__(self, status_code, detail): self.status_code = status_code
        class Statement:
            def __init__(self, model): self.model = model
            def where(self, *args): return self
        task_type = SimpleNamespace(id=None)
        issue_type = SimpleNamespace(id=None, task_id=None)
        issue = SimpleNamespace(status='open', resolved_by=None, resolved_at=None)
        task = SimpleNamespace(created_by='owner')
        queried = []
        async def execute(statement):
            queried.append(statement.model)
            value = task if statement.model is task_type else issue
            return SimpleNamespace(scalars=lambda: SimpleNamespace(first=lambda: value))
        db = SimpleNamespace(execute=AsyncMock(side_effect=execute), commit=AsyncMock(), refresh=AsyncMock())
        update = endpoint_function('update_issue', dict(select=Statement, AuditTask=task_type,
            AuditIssue=issue_type, HTTPException=Denied, datetime=datetime, timezone=timezone))
        with self.assertRaises(Denied) as denied:
            await update('task', 'issue', SimpleNamespace(status='resolved'), db, SimpleNamespace(id='foreign'))
        self.assertEqual(denied.exception.status_code, 403)
        self.assertEqual(queried, [task_type])
        self.assertEqual((issue.status, issue.resolved_by, issue.resolved_at), ('open', None, None))
        db.commit.assert_not_awaited(); db.refresh.assert_not_awaited()
        queried.clear()
        result = await update('task', 'issue', SimpleNamespace(status='resolved'), db, SimpleNamespace(id='owner'))
        self.assertIs(result, issue)
        self.assertEqual((issue.status, issue.resolved_by), ('resolved', 'owner'))
        self.assertIsNotNone(issue.resolved_at)
        db.commit.assert_awaited_once(); db.refresh.assert_awaited_once_with(issue)


class NativeRepositoryResponseEvidence(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        import asyncio, os, zipfile
        from pathlib import PurePosixPath
        from urllib.parse import urlparse, quote
        self.directory = tempfile.TemporaryDirectory()
        self.task = SimpleNamespace(id=str(uuid.uuid4()), project_id='project', branch_name='main')
        self.settings = SimpleNamespace(ZIP_STORAGE_PATH=self.directory.name, MAX_FILE_SIZE_BYTES=100000,
            GITHUB_TOKEN=None, GITLAB_TOKEN=None, GITEA_TOKEN=None)
        modules = {name: ModuleType(name) for name in ('app', 'app.core', 'app.core.config', 'app.services', 'app.utils', 'app.utils.repo_utils')}
        modules['app.core.config'].settings = self.settings
        def parse(url, kind):
            return dict(owner='example', repo='repo', base_url='https://git.example/api/v1' if kind == 'gitea' else 'https://git.example/api/v4', project_path='example/repo')
        modules['app.utils.repo_utils'].parse_repository_url = parse
        self.requests, self.responses, self.respond = [], [], None
        owner = self
        class Client:
            def __init__(self, **kwargs): owner.assertEqual(kwargs, {'timeout': 30})
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def get(self, url, headers):
                owner.requests.append((url, headers))
                if owner.respond is not None: return owner.respond(url, headers)
                value = owner.responses.pop(0)
                if isinstance(value, BaseException): raise value
                return value
        self.patch = patch.dict(sys.modules, modules); self.patch.start()
        def load(name, path):
            spec = importlib.util.spec_from_file_location(name, ROOT / path)
            module = importlib.util.module_from_spec(spec); sys.modules[name] = module
            spec.loader.exec_module(module)
            return module
        self.snapshot = load('app.services.scan_snapshot', 'backend/app/services/scan_snapshot.py')
        scanner = ModuleType('app.services.scanner')
        scanner.__dict__.update(httpx=SimpleNamespace(AsyncClient=Client), settings=self.settings,
            RepositoryEvidenceError=getattr(self.snapshot, 'RepositoryEvidenceError', RuntimeError),
            MAX_FILES=self.snapshot.MAX_FILES,
            List=list, Dict=dict, Optional=__import__('typing').Optional, urlparse=urlparse, quote=quote,
            parse_repository_url=parse, is_text_file=lambda path: path.endswith('.py'),
            should_exclude=lambda *args: False)
        functions = [node for node in ast.parse((ROOT / 'backend/app/services/scanner.py').read_text()).body
                     if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in
                     ('repository_get', 'github_api', 'gitlab_api', 'gitea_api', 'fetch_file_content',
                      'get_github_files', 'get_gitlab_files', 'get_gitea_files', 'gitlab_repository_token')]
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'actual-scanner', 'exec'), scanner.__dict__)
        sys.modules['app.services.scanner'] = scanner
        self.repository = load('app.services.repository_snapshot', 'backend/app/services/repository_snapshot.py')

    def tearDown(self):
        for name in ('app.services.repository_snapshot', 'app.services.scanner', 'app.services.scan_snapshot'):
            sys.modules.pop(name, None)
        self.patch.stop(); self.directory.cleanup()

    def response(self, status, body, content_type='application/json'):
        data = (json.dumps(body) if isinstance(body, (dict, list)) else body).encode()
        return SimpleNamespace(status_code=status, content=data, text=data.decode(),
            headers={'content-type': content_type, 'x-github-request-id': 'upstream-id'},
            json=lambda: json.loads(data))

    async def acquire(self, kind='github', scan_config=None, max_analyze_files=0):
        return await self.repository.prepare_repository(self.task,
            dict(repository_url='https://github.com/example/repo', repository_type=kind),
            {'otherConfig': {kind + 'Token': 'private-token-only'}, 'scan_config': scan_config or {}},
            {'max_analyze_files': max_analyze_files, 'llm_concurrency': 2})

    def records(self):
        return [json.loads(p.read_text()) for p in sorted(pathlib.Path(self.directory.name).rglob('response-*.json'))]

    async def test_native_success_retains_every_attempt_without_private_source_or_token(self):
        self.responses = [self.response(200, {'sha': 'a' * 40}),
            self.response(200, {'tree': [{'type': 'blob', 'path': 'one.py', 'size': 10}]}),
            self.response(200, 'PRIVATE_SOURCE_MARKER = 1', 'text/plain')]
        await self.acquire()
        records = self.records()
        self.assertEqual(len(records), 3)
        self.assertTrue(all(r['task_id'] == self.task.id and r['project_id'] == 'project' for r in records))
        self.assertEqual({r['outcome'] for r in records}, {'success'})
        self.assertEqual(len(self.requests), 3)
        encoded = json.dumps(records)
        self.assertNotIn('PRIVATE_SOURCE_MARKER', encoded); self.assertNotIn('private-token-only', encoded)
        self.assertTrue(all((p.stat().st_mode & 0o777) == 0o600
                            for p in pathlib.Path(self.directory.name).rglob('response-*.json')))

    async def test_native_http_failure_keeps_reason_and_redacts_echoed_credentials(self):
        self.responses = [self.response(403, {'message': 'Repository access denied for Bearer private-token-only',
            'token': 'new-response-secret', 'nested': {'password': 'do-not-save'}})]
        with self.assertRaises(Exception): await self.acquire()
        records = self.records()
        self.assertEqual(len(records), 1)
        self.assertEqual((records[0]['outcome'], records[0]['status']), ('http_error', 403))
        encoded = json.dumps(records)
        self.assertIn('Repository access denied', encoded)
        for secret in ('private-token-only', 'new-response-secret', 'do-not-save'): self.assertNotIn(secret, encoded)
        self.assertEqual(len(self.requests), 1)

    async def test_native_parse_failure_and_timeout_are_persisted_as_distinct_attempts(self):
        for response, outcome in [(self.response(200, '<html>upstream unavailable</html>', 'text/html'), 'parse_error'),
                                   (TimeoutError('private-token-only'), 'no_response')]:
            self.responses = [response]
            with self.assertRaises(Exception): await self.acquire()
        records = self.records()
        self.assertEqual([r['outcome'] for r in records], ['parse_error', 'no_response'])
        self.assertEqual([r['response_received'] for r in records], [True, False])
        self.assertEqual(len(self.requests), 2)

    async def test_existing_owner_only_task_detail_pages_persistent_evidence(self):
        self.responses = [self.response(403, {'message': 'Repository denied'})]
        with self.assertRaises(Exception): await self.acquire()
        class Denied(Exception):
            def __init__(self, status_code, detail): self.status_code = status_code
        class Statement:
            def __init__(self, model): pass
            def options(self, *args): return self
            def where(self, *args): return self
        self.task.created_by = 'owner'
        db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(
            scalars=lambda: SimpleNamespace(first=lambda: self.task))), commit=AsyncMock())
        query = Mock(wraps=self.snapshot.read_repository_responses)
        read = endpoint_function('read_task', dict(asyncio=asyncio, select=Statement,
            selectinload=lambda _: None, AuditTask=SimpleNamespace(id=None, project=None),
            HTTPException=Denied, read_repository_responses=query))
        with self.assertRaises(Denied) as denied:
            await read(self.task.id, db, SimpleNamespace(id='foreign'), 0, 1)
        self.assertEqual(denied.exception.status_code, 403); query.assert_not_called()
        task = await read(self.task.id, db, SimpleNamespace(id='owner'), 0, 1)
        self.assertEqual((task.repository_responses['total'], len(task.repository_responses['events'])), (1, 1))
        self.assertIn('Repository denied', json.dumps(task.repository_responses))
        with self.assertRaises(Denied) as invalid:
            await read(self.task.id, db, SimpleNamespace(id='owner'), 0, 101)
        self.assertEqual(invalid.exception.status_code, 422)
        db.commit.assert_not_awaited()

    async def test_audit_write_failure_stops_acquisition_observably_without_retry(self):
        self.responses = [self.response(200, {'sha': 'a' * 40})]
        with patch.object(self.snapshot.os, 'replace', side_effect=OSError('synthetic storage failure')):
            with self.assertLogs('app.services.scan_snapshot', level='ERROR') as logged:
                with self.assertRaises(self.snapshot.RepositoryEvidenceError): await self.acquire()
        self.assertIn('evidence write failed', '\n'.join(logged.output))
        self.assertEqual(len(self.requests), 1)
        self.assertFalse(self.snapshot.archive_path(self.task.id).exists())
        self.assertEqual(self.records(), [])

    async def test_gitlab_and_gitea_tree_and_file_requests_share_the_task_journal(self):
        for kind in ('gitlab', 'gitea'):
            self.task.id = str(uuid.uuid4())
            tree = [{'type': 'blob', 'path': 'one.py'}]
            self.responses = [self.response(200, {'id' if kind == 'gitlab' else 'sha': 'b' * 40}),
                              self.response(200, tree if kind == 'gitlab' else {'tree': tree}),
                              self.response(200, 'PRIVATE_SOURCE_MARKER = 1', 'text/plain')]
            await self.acquire(kind)
            page = self.snapshot.read_repository_responses(self.task.id, 0, 100)
            self.assertEqual(page['total'], 3)
            self.assertTrue(all(r['provider'] == kind and r['task_id'] == self.task.id for r in page['events']))
            self.assertNotIn('private-token-only', json.dumps(page))
        self.assertEqual(len(self.requests), 6)

    async def test_success_status_does_not_hide_upstream_business_failure_or_revision_shape(self):
        cases = [({}, 'missing'), ({'sha': None}, 'null'), ({'sha': ''}, 'empty'),
                 ({'sha': '   '}, 'whitespace'), ({'sha': 42}, 'wrong_type'),
                 ({'sha': 'not-a-revision'}, 'invalid_format'), ([], 'wrong_container_type')]
        for payload, expected in cases:
            self.task.id = str(uuid.uuid4())
            self.responses = [self.response(200, payload)]
            with self.assertRaises(Exception): await self.acquire()
            record = self.snapshot.read_repository_responses(self.task.id)['events'][0]
            self.assertEqual((record['outcome'], record['revision_state']), ('contract_error', expected))
        self.task.id = str(uuid.uuid4())
        self.responses = [self.response(200, {'success': False, 'code': 'RATE_LIMIT', 'message': 'Quota exceeded', 'sha': 'a' * 40})]
        with self.assertRaises(Exception): await self.acquire()
        record = self.snapshot.read_repository_responses(self.task.id)['events'][0]
        self.assertEqual((record['outcome'], record['code'], record['reason']), ('business_error', 'RATE_LIMIT', 'Quota exceeded'))
        self.assertEqual(len(self.requests), len(cases) + 1)

    async def test_nested_reason_and_long_text_remain_bounded_and_private(self):
        self.responses = [self.response(403, {'message': {'password': 'private-nested-reason'},
            'error': {'code': 'DENIED', 'message': 'password="new-secret" owner@example.com +8613800138000 ' + 'x' * 20000}})]
        with self.assertRaises(Exception): await self.acquire()
        record = self.records()[0]
        encoded = json.dumps(record)
        for secret in ('private-nested-reason', 'new-secret', 'owner@example.com', '13800138000'):
            self.assertNotIn(secret, encoded)
        self.assertIn('DENIED', encoded)
        self.assertLess(len(encoded.encode()), self.snapshot.MAX_RESPONSE_RECORD_BYTES)

    def repository_response(self, kind, url, rows, more=False):
        if '/commits/' in url:
            return self.response(200, {'id' if kind == 'gitlab' else 'sha': 'b' * 40,
                                      'message': 'PRIVATE_COMMIT_MESSAGE'})
        if '/repository/tree?' in url or '/git/trees/' in url:
            return self.response(200, rows if kind == 'gitlab' else {'tree': rows, 'truncated': more})
        return self.response(200, 'version-one' if 'b' * 40 in url or 'one.py' in url else 'version-two', 'text/plain')

    async def assert_pinned_native_source(self, kind):
        import zipfile
        rows = [{'type': 'blob', 'path': 'one.py'}, {'type': 'blob', 'path': 'two.py'}]
        self.respond = lambda url, headers: self.repository_response(kind, url, rows)
        metadata = await self.acquire(kind)
        self.assertEqual(metadata['repository_revision'], 'b' * 40)
        self.assertIn('/commits/main', self.requests[0][0])
        self.assertTrue(all('b' * 40 in url for url, _ in self.requests[1:]))
        with zipfile.ZipFile(self.snapshot.archive_path(self.task.id)) as archive:
            self.assertEqual({archive.read(name) for name in archive.namelist()}, {b'version-one'})
        self.assertNotIn('PRIVATE_COMMIT_MESSAGE', json.dumps(self.records()))

    async def test_gitlab_native_scan_freezes_one_commit_before_tree_and_raw_reads(self):
        await self.assert_pinned_native_source('gitlab')

    async def test_gitea_native_scan_freezes_one_commit_before_tree_and_raw_reads(self):
        await self.assert_pinned_native_source('gitea')

    async def test_native_pagination_includes_late_files_before_full_or_explicit_selection(self):
        import zipfile
        from urllib.parse import parse_qs, urlsplit
        for kind in ('gitlab', 'gitea'):
            for mode in ('full', 'selected', 'limited'):
                self.task.id = str(uuid.uuid4()); self.requests.clear()
                def respond(url, headers):
                    page = parse_qs(urlsplit(url).query).get('page', ['1'])[0]
                    rows = ([{'type': 'tree', 'path': f'dir-{i}'} for i in range(99)] +
                            [{'type': 'blob', 'path': 'one.py'}]) if page == '1' else [{'type': 'blob', 'path': 'last.py'}]
                    return self.repository_response(kind, url, rows, page == '1')
                self.respond = respond
                await self.acquire(kind, {'file_paths': ['last.py']} if mode == 'selected' else {},
                                   max_analyze_files=1 if mode == 'limited' else 0)
                with zipfile.ZipFile(self.snapshot.archive_path(self.task.id)) as archive:
                    self.assertEqual(set(archive.namelist()), {'last.py'} if mode == 'selected' else {'one.py'} if mode == 'limited' else {'one.py', 'last.py'})
                self.assertTrue(any('page=2' in url for url, _ in self.requests))
                records = self.snapshot.read_repository_responses(self.task.id)['events']
                self.assertEqual(len(records), len(self.requests))

    async def test_unending_tree_pages_fail_at_existing_manifest_bound_without_partial_archive(self):
        scanner = sys.modules['app.services.scanner']
        rows = [{'type': 'tree', 'path': f'dir-{i}'} for i in range(100)]
        for kind in ('gitlab', 'gitea'):
            self.task.id = str(uuid.uuid4()); self.requests.clear()
            self.respond = lambda url, headers: self.repository_response(kind, url, rows, True)
            with patch.object(scanner, 'MAX_FILES', 100, create=True):
                with self.assertRaises(Exception): await self.acquire(kind)
            self.assertFalse(self.snapshot.archive_path(self.task.id).exists())
            self.assertLessEqual(len(self.requests), 3)

    async def test_explicitly_truncated_github_tree_never_becomes_a_complete_snapshot(self):
        self.responses = [self.response(200, {'sha': 'a' * 40}),
            self.response(200, {'tree': [], 'truncated': True})]
        with self.assertRaises(Exception): await self.acquire()
        self.assertFalse(self.snapshot.archive_path(self.task.id).exists())
        self.assertEqual(len(self.requests), 2)

    async def test_gitlab_resolution_keeps_existing_url_token_for_tree_and_raw_reads(self):
        kind = 'gitlab'
        self.respond = lambda url, headers: self.repository_response(kind, url, [{'type': 'blob', 'path': 'one.py'}])
        await self.repository.prepare_repository(self.task,
            dict(repository_url='https://oauth2:embedded-private@git.example/example/repo', repository_type=kind),
            {'otherConfig': {'gitlabToken': 'configured-private'}},
            {'max_analyze_files': 0, 'llm_concurrency': 2})
        self.assertEqual(len(self.requests), 3)
        self.assertTrue(all(headers.get('PRIVATE-TOKEN') == 'embedded-private' for _, headers in self.requests))
        encoded = json.dumps(self.records())
        self.assertNotIn('embedded-private', encoded); self.assertNotIn('configured-private', encoded)


if __name__ == "__main__":
    unittest.main()
