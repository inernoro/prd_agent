"""Release preflight checks, deliberately dependency-free."""
import ast
import pathlib
import unittest

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


if __name__ == "__main__":
    unittest.main()
