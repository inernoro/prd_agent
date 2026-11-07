"""Release preflight checks, deliberately dependency-free."""
import ast
import asyncio
import json
import pathlib
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

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


if __name__ == "__main__":
    unittest.main()
