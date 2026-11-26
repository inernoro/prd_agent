"""Exercise the shipped CLI over real HTTP with isolated workspace credentials."""
import json
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CLI = Path(__file__).resolve().parents[1] / "cli" / "cdscli.py"
SECRET = "cdsp_setup_test_secret_never_print"
DESIGN_APPROVAL_KEYS = {"read": "cdsp_read_fixture_never_print",
                        "feedback": "cdsp_feedback_fixture_never_print", "publish": SECRET}
POLL_TOKEN = "design_request_fixture_poll_token_never_print"
DESIGN_SETUP = "/api/agent/setup.json?target=existing&project=proj-a&mission=design-publish"
BUILD_SETUP = "/api/agent/setup.json?target=existing&project=proj-a&skills=cds-build"
FRESH_SETUP = "/api/agent/setup.json?target=system&skills=cds"
DESIGN_INTAKE = "/api/projects/proj-a/design/intake"
DESIGN_REQUEST = "/api/projects/proj-a/access-requests"
DESIGN_POLL = DESIGN_REQUEST + "/design-request-fixture"
SKILLS = ("cds", "cds-design", "cds-build", "cds-project-scan", "cds-deploy-pipeline", "cds-release", "preview-url")


class SetupCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / ".git").mkdir()
        self.cli = self.root / ".agents/skills/cds/cli/cdscli.py"
        self.cli.parent.mkdir(parents=True)
        shutil.copyfile(CLI, self.cli)
        for skill in SKILLS:
            folder = self.root / ".agents/skills" / skill
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "SKILL.md").write_text(f"---\nname: {skill}\ndescription: test\n---\n")
        self.requests = []
        self.redirects = {}
        self.status = "active"
        self.kind = "project"
        self.global_projects = "all"
        self.version = re.search(r'^VERSION = "([^"]+)"', self.cli.read_text(), re.MULTILINE)[1]
        self.minimum_version = self.version
        self.bundle_manifest = self.cli.with_name("cds-skill-manifest.json")
        self.write_bundle_manifest()
        self.project_status = 200
        self.project_error = None
        self.returned_project = "proj-a"
        self.design_manifest = {"target": {"kind": "existing", "projectId": "proj-a"},
                                "mission": "design-publish", "designAccess": "publish", "minCliVersion": "0.26.9"}
        self.build_setup_status = 200
        self.build_manifest = {"target": {"kind": "existing", "projectId": "proj-a"},
                               "skills": ["cds-build"], "designAccess": "read", "minCliVersion": self.version}
        self.design_result = {"projectId": "proj-a", "protocolVersion": 1, "permissions": {"write": True}}
        self.design_intake_status = 200
        self.design_requests = []
        self.update_bundle = None
        self.poll_proofs = []
        self.hold_design_approval = False
        self.before_design_delivery = None
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, status, body):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def do_GET(self):
                test.requests.append((self.path, self.headers.get("X-AI-Access-Key")))
                if self.path in ("/api/export-skill", "/api/skills/cds-pack/download") and test.update_bundle is not None:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/gzip")
                    self.send_header("Content-Length", str(len(test.update_bundle)))
                    self.end_headers()
                    self.wfile.write(test.update_bundle)
                    return
                if self.path in test.redirects:
                    self.send_response(302)
                    self.send_header("Location", test.redirects[self.path])
                    self.end_headers()
                    return
                status = 200
                if self.path in ("/api/agent/setup.json", FRESH_SETUP):
                    body = {"version": "cds-agent-setup.v1", "cliVersion": test.version,
                            "minCliVersion": test.minimum_version}
                elif self.path == DESIGN_SETUP:
                    body = {"version": "cds-agent-setup.v1", "cliVersion": test.version, **test.design_manifest}
                elif self.path == BUILD_SETUP:
                    status = test.build_setup_status
                    body = {"version": "cds-agent-setup.v1", "cliVersion": test.version, **test.build_manifest}
                elif self.path == "/api/credentials/self-check":
                    body = {"kind": test.kind, "status": test.status}
                    if test.kind == "global":
                        body["keyId"] = "global-current"
                    if test.kind == "project":
                        body["projectId"] = "proj-a"
                elif self.path == DESIGN_INTAKE:
                    key = self.headers.get("X-AI-Access-Key")
                    if key in (DESIGN_APPROVAL_KEYS["read"], DESIGN_APPROVAL_KEYS["feedback"]):
                        body = {**test.design_result, "permissions": {
                            "write": False, "feedback": key == DESIGN_APPROVAL_KEYS["feedback"],
                        }}
                    else:
                        status, body = test.design_intake_status, test.design_result
                elif self.path == DESIGN_POLL:
                    supplied = self.headers.get("X-Poll-Token") == POLL_TOKEN
                    test.poll_proofs.append(supplied)
                    if not supplied:
                        status, body = 403, {"error": "poll_token_required"}
                    elif test.hold_design_approval or len(test.poll_proofs) == 1:
                        body = {"status": "pending"}
                    else:
                        access = test.design_requests[-1]["designAccess"]
                        if test.before_design_delivery:
                            test.before_design_delivery()
                        body = {"status": "approved", "authorizationKey": DESIGN_APPROVAL_KEYS[access], "designAccess": access}
                elif self.path == "/api/projects/proj-a":
                    status = test.project_status
                    body = {"project": {"id": test.returned_project}, "secret": SECRET}
                    if test.project_error:
                        body = {"error": test.project_error}
                elif self.path == "/api/global-agent-keys":
                    body = {"keys": [{"id": "global-current", "access": {"projects": test.global_projects}}], "secret": SECRET}
                elif self.path == "/api/config":
                    body = {"secret": SECRET}
                else:
                    status, body = 404, {"secret": SECRET}
                self.respond(status, body)

            def do_POST(self):
                test.requests.append((self.path, self.headers.get("X-AI-Access-Key")))
                if self.path != DESIGN_REQUEST:
                    self.respond(404, {"error": "unexpected_write"})
                    return
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                test.design_requests.append(request)
                self.respond(201, {"requestId": "design-request-fixture", "pollToken": POLL_TOKEN,
                                   "projectId": "proj-a", "designAccess": request["designAccess"], "status": "pending"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.host = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.credentials = self.root / ".cds/credentials.json"
        self.credentials.parent.mkdir()
        self.credentials.write_text(json.dumps({"host": self.host, "projectId": "proj-a", "projectKey": SECRET}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def write_bundle_manifest(self):
        skills_root = self.cli.parents[2]
        files = {p.relative_to(skills_root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                 for key in SKILLS for p in (skills_root / key).rglob('*')
                 if p.is_file() and p != self.bundle_manifest}
        self.bundle_manifest.write_text(json.dumps({
            "format": "agent-skills", "version": self.version, "skills": list(SKILLS), "files": files,
        }))

    def run_cli_result(self, *args, credential_env=None):
        env = {key: value for key, value in os.environ.items()
               if key not in ("CDS_HOST", "CDS_PROJECT_ID", "CDS_PROJECT_KEY", "AI_ACCESS_KEY")}
        env.update(credential_env or {})
        result = subprocess.run([sys.executable, str(self.cli), *args],
                                cwd=self.root, env=env, capture_output=True, text=True, timeout=15)
        self.assertFalse(any(value in result.stdout + result.stderr for value in (*DESIGN_APPROVAL_KEYS.values(), POLL_TOKEN)),
                         "CLI exposed a credential or poll token")
        return result

    def run_cli(self, *args, credential_env=None):
        result = self.run_cli_result(*args, credential_env=credential_env)
        return result, json.loads(result.stdout)

    def run_check(self, *target, host=None, credential_env=None):
        return self.run_cli("setup-check", "--host", host or self.host,
                            *(target or ("--project", "proj-a")), "--skills", "cds-deploy-pipeline",
                            credential_env=credential_env)

    def assert_failure(self, reason, *target, host=None):
        result, payload = self.run_check(*target, host=host)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(payload["data"]["connected"])
        self.assertEqual(payload["data"]["checks"][-1]["reason"], reason)

    @unittest.skipUnless(shutil.which("node") and shutil.which("git"), "requires Node and Git")
    def test_skill_fresh_checks_cds_for_an_installed_bundle_inside_git(self):
        for args in (("init", "--quiet", "--initial-branch=main"),
                     ("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
                      "commit", "--quiet", "--allow-empty", "-m", "fixture"),
                     ("remote", "add", "origin", str(self.root))):
            subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)
        scripts = self.cli.parent.parent / "scripts"
        scripts.mkdir()
        script = scripts / "skill-fresh.mjs"
        shutil.copyfile(CLI.parent.parent / "scripts" / script.name, script)
        self.cli.write_text(re.sub(r'^VERSION = "[^"]+"', 'VERSION = "0.26.20"',
                                   self.cli.read_text(), count=1, flags=re.MULTILINE))
        result = subprocess.run(
            ["node", str(script)], cwd=self.root, env={**os.environ, "CDS_HOST": self.host},
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(self.requests, [(FRESH_SETUP, None)])
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stdout.splitlines()[0])["fresh"])
        self.assertIn(f"{self.host}/api/skills/cds-pack/download", result.stdout)

    @unittest.skipUnless(shutil.which("node") and shutil.which("git"), "requires Node and Git")
    def test_skill_fresh_accepts_a_tracked_bundle_on_a_branch_ahead_of_main(self):
        def git(*args):
            subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

        scripts = self.cli.parent.parent / "scripts"
        scripts.mkdir()
        script = scripts / "skill-fresh.mjs"
        shutil.copyfile(CLI.parent.parent / "scripts" / script.name, script)
        current_cli = self.cli.read_text()
        self.cli.write_text(re.sub(r'^VERSION = "[^"]+"', 'VERSION = "0.26.20"',
                                   current_cli, count=1, flags=re.MULTILINE))
        git("init", "--quiet", "--initial-branch=main")
        git("add", "--", ".agents/skills/cds")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "main")
        git("remote", "add", "origin", str(self.root))
        git("switch", "--quiet", "-c", "newer-skills")
        self.cli.write_text(current_cli)
        git("add", "--", self.cli.relative_to(self.root).as_posix())
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "update")
        result = subprocess.run(
            ["node", str(script)], cwd=self.root, env={**os.environ, "CDS_HOST": self.host},
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.requests, [(FRESH_SETUP, None)])
        self.assertTrue(json.loads(result.stdout.splitlines()[0])["fresh"])

    def test_existing_credentials_are_reused_and_target_is_really_read(self):
        before = self.credentials.read_bytes()
        result, payload = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(payload["data"]["connected"])
        self.assertEqual(payload["data"]["projectId"], "proj-a")
        self.assertEqual([path for path, _ in self.requests], [
            "/api/agent/setup.json", "/api/credentials/self-check", "/api/projects/proj-a"])
        self.assertTrue(all(key == SECRET for _, key in self.requests))
        self.assertEqual(self.credentials.read_bytes(), before)
        self.assertFalse((self.root / ".git/info/exclude").exists())

    def run_design_check(self):
        return self.run_cli_result("setup-check", "--host", self.host, "--project", "proj-a",
                                   "--skills", "cds", "--design-access", "publish")

    def run_design_connect(self, *options, scope="publish"):
        return self.run_cli_result("connect", "--host", self.host, "--project", "proj-a",
                                   "--design-access", scope, "--agent", "Fixture designer", "--interval", "1", *options)

    def run_build_check(self, scope="read", skills="cds-build"):
        return self.run_cli("setup-check", "--host", self.host, "--project", "proj-a",
                            "--skills", skills, "--design-access", scope)

    def test_design_setup_check_verifies_the_declared_project_and_live_publish_permission(self):
        before = self.credentials.read_bytes()
        result = self.run_design_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["data"]["connected"])
        self.assertEqual(payload["data"]["projectId"], "proj-a")
        self.assertEqual([path for path, _ in self.requests], [
            DESIGN_SETUP, "/api/credentials/self-check", DESIGN_INTAKE])
        self.assertTrue(all(key == SECRET for _, key in self.requests[1:]))
        self.assertEqual(self.credentials.read_bytes(), before)
        self.assertEqual(self.design_requests, [])

    def test_design_setup_check_accepts_autocrlf_checkout_of_complete_bundle(self):
        if not shutil.which("git"):
            self.skipTest("Git is required to reproduce the Windows checkout")
        source = CLI.parents[2]
        manifest = CLI.with_name("cds-skill-manifest.json").read_bytes()
        canonical = {}
        for name, digest in json.loads(manifest)["files"].items():
            raw = (source / name).read_bytes()
            if hashlib.sha256(raw).hexdigest() != digest:
                raw = raw.replace(b"\r\n", b"\n")
            self.assertEqual(hashlib.sha256(raw).hexdigest(), digest, name)
            target = self.cli.parents[2] / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            canonical[target] = raw
        self.bundle_manifest.write_bytes(manifest)

        git_env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        git_env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)

        def git(*args):
            subprocess.run(["git", *args], cwd=self.root, env=git_env, check=True, capture_output=True)

        git("init", "-q")
        git("config", "core.autocrlf", "true")
        git("add", "--", ".agents/skills")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Canonical bundle")
        for target in canonical:
            target.unlink()
        git("checkout", "HEAD", "--", ".agents/skills")
        self.assertEqual(self.cli.read_bytes(), canonical[self.cli].replace(b"\n", b"\r\n"))
        self.assertNotEqual(self.cli.read_bytes(), canonical[self.cli])
        before = self.credentials.read_bytes()

        result = self.run_design_check()
        payload = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, payload)
        self.assertTrue(payload["data"]["connected"])
        self.assertEqual([path for path, _ in self.requests],
                         [DESIGN_SETUP, "/api/credentials/self-check", DESIGN_INTAKE])
        self.assertEqual(self.credentials.read_bytes(), before)
        self.assertEqual(self.design_requests, [])

    def test_design_setup_check_rejects_crlf_content_changes_and_non_text(self):
        reference = self.cli.parents[2] / "cds-release/reference.md"
        reference.write_bytes(b"# Verified reference\n")
        binary = self.cli.parents[2] / "cds-release/fixture.bin"
        binary.write_bytes(b"\x00\x01\n\xff")
        self.write_bundle_manifest()
        for path, replacement in (
            (reference, b"# Modified reference\r\n"),
            (reference, b"# Verified reference\r"),
            (binary, b"\x00\x01\r\n\xff"),
        ):
            with self.subTest(path=path.name, replacement=replacement):
                original = path.read_bytes()
                try:
                    path.write_bytes(replacement)
                    result = self.run_design_check()
                    payload = json.loads(result.stdout)
                    self.assertEqual(result.returncode, 2, payload)
                    self.assertFalse(payload["data"]["connected"])
                    self.assertEqual(payload["data"]["checks"][-1]["reason"], "bundle_content_mismatch")
                    self.assertEqual(self.requests, [])
                finally:
                    path.write_bytes(original)

    def test_design_setup_check_rejects_active_keys_when_intake_cannot_confirm_publish(self):
        before = self.credentials.read_bytes()
        for invalid in ({"permissions": {"write": False}}, {"projectId": "proj-b"}, {"protocolVersion": 2}):
            with self.subTest(invalid=invalid):
                self.design_result = {"projectId": "proj-a", "protocolVersion": 1, "permissions": {"write": True}, **invalid}
                self.requests.clear()
                result = self.run_design_check()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual([path for path, _ in self.requests], [
                    DESIGN_SETUP, "/api/credentials/self-check", DESIGN_INTAKE])
                self.assertFalse(json.loads(result.stdout)["data"]["connected"])
                self.assertEqual(self.credentials.read_bytes(), before)
        self.assertEqual(self.design_requests, [])

    def test_design_connect_requests_scoped_approval_and_saves_only_a_verified_credential(self):
        self.credentials.unlink()
        result = self.run_design_connect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"]["projectId"], "proj-a")
        calls = [path for path, _ in self.requests]
        self.assertEqual(calls[:4], [DESIGN_SETUP, DESIGN_REQUEST, DESIGN_POLL, DESIGN_POLL])
        self.assertEqual(calls[-1], DESIGN_INTAKE)
        self.assertTrue(set(calls) <= {DESIGN_SETUP, DESIGN_REQUEST, DESIGN_POLL, DESIGN_INTAKE, "/api/credentials/self-check"})
        self.assertTrue(all(key is None for _, key in self.requests[:4]))
        self.assertTrue(self.requests[-1][1] == SECRET)
        self.assertEqual([row.get("designAccess") for row in self.design_requests], ["publish"])
        self.assertEqual([row.get("agentName") for row in self.design_requests], ["Fixture designer"])
        self.assertIn("在当前项目发布、续版和读取设计稿件", self.design_requests[0]["purpose"])
        self.assertEqual(self.poll_proofs, [True, True])
        binding = json.loads(self.credentials.read_text())
        self.assertEqual((binding.get("host"), binding.get("projectId")), (self.host, "proj-a"))
        self.assertTrue(binding.get("projectKey") == SECRET)
        if os.name == "posix":
            self.assertEqual(self.credentials.stat().st_mode & 0o777, 0o600)

    def test_design_connect_rejects_untrusted_declarations_before_requesting_approval(self):
        self.credentials.unlink()
        invalid_declarations = (
            {"designAccess": None},
            {"target": {"kind": "existing", "projectId": "proj-b"}},
            {"target": {"kind": "new", "projectId": "proj-a"}},
            {"mission": "branches"},
            {"version": "cds-agent-setup.v2"},
            {"cliVersion": "0.26.8", "minCliVersion": "0.26.8"},
        )
        for invalid in invalid_declarations:
            with self.subTest(invalid=invalid):
                self.design_manifest = {"target": {"kind": "existing", "projectId": "proj-a"},
                                        "mission": "design-publish", "designAccess": "publish", "minCliVersion": "0.26.9", **invalid}
                if self.design_manifest.get("designAccess") is None:
                    self.design_manifest.pop("designAccess")
                self.requests.clear()
                result = self.run_design_connect()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual([path for path, _ in self.requests], [DESIGN_SETUP])
                self.assertFalse(self.credentials.exists())
                self.assertEqual(self.design_requests, [])

    def test_design_connect_after_timeout_resumes_the_same_approval_without_a_second_post(self):
        self.credentials.unlink()
        self.hold_design_approval = True
        first = self.run_design_connect("--timeout", "10")
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(len(self.design_requests), 1)
        self.assertTrue(self.poll_proofs and all(self.poll_proofs))
        self.assertFalse(self.credentials.exists())
        receipt = self.root / ".cds/design-approval.json"
        approval = json.loads(receipt.read_text())
        self.assertEqual((approval["host"], approval["projectId"], approval["designAccess"], approval["requestId"]),
                         (self.host, "proj-a", "publish", "design-request-fixture"))
        self.assertTrue(approval.get("pollToken") == POLL_TOKEN)
        if os.name == "posix":
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)

        self.hold_design_approval = False
        self.requests.clear()
        resumed = self.run_design_connect("--timeout", "10")
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        paths = [url for url, _ in self.requests]
        self.assertEqual(paths[:2], [DESIGN_SETUP, DESIGN_POLL])
        self.assertEqual(paths[-1], DESIGN_INTAKE)
        self.assertEqual(len(self.design_requests), 1)
        self.assertFalse(receipt.exists())
        self.assertTrue(json.loads(self.credentials.read_text()).get("projectKey") == SECRET)

    def test_scoped_design_connect_preserves_worktree_with_ordinary_project_access(self):
        connection = self.credentials.with_name("connection.json")
        binding = json.dumps({"host": self.host, "projectId": "proj-a", "repository": "example.test/owner/project"}).encode()
        credentials = self.credentials.read_bytes()
        for scope, intake_status in (("read", 403), ("feedback", 200)):
            with self.subTest(scope=scope):
                self.credentials.write_bytes(credentials)
                connection.write_bytes(binding)
                self.requests.clear()
                self.poll_proofs.clear()
                self.design_intake_status = intake_status
                self.design_result["permissions"] = {"write": False, "feedback": False}
                result = self.run_design_connect(scope=scope)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(json.loads(result.stdout)["reason"], "existing_project_binding")
                self.assertEqual([url for url, _ in self.requests], [DESIGN_INTAKE, "/api/projects/proj-a"])
                self.assertEqual(self.credentials.read_bytes(), credentials)
                self.assertEqual(connection.read_bytes(), binding)
        self.assertEqual(self.design_requests, [])

    def test_scoped_design_connect_reuses_existing_permission_before_binding_check(self):
        self.design_result["permissions"] = {"write": False, "feedback": True}
        before = self.credentials.read_bytes()
        for scope in ("read", "feedback"):
            with self.subTest(scope=scope):
                self.requests.clear()
                result = self.run_design_connect(scope=scope)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(json.loads(result.stdout)["data"]["reused"])
                self.assertEqual([url for url, _ in self.requests], [DESIGN_INTAKE])
        self.assertEqual(self.credentials.read_bytes(), before)
        self.assertEqual(self.design_requests, [])

    def test_design_only_read_binding_can_continue_to_one_feedback_approval(self):
        self.design_result["permissions"] = {"write": False, "feedback": False}
        self.project_status = 403
        self.project_error = "design_key_scope"
        result = self.run_design_connect(scope="feedback")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"]["scope"], "design-feedback")
        self.assertEqual([item["designAccess"] for item in self.design_requests], ["feedback"])
        self.assertEqual([url for url, _ in self.requests[:3]],
                         [DESIGN_INTAKE, "/api/projects/proj-a", DESIGN_SETUP])
        self.assertTrue(json.loads(self.credentials.read_text()).get("projectKey") == DESIGN_APPROVAL_KEYS["feedback"])

    def test_scoped_design_connect_keeps_a_project_binding_saved_while_waiting(self):
        credentials = self.credentials.read_bytes()
        self.credentials.unlink()
        connection = self.credentials.with_name("connection.json")
        binding = json.dumps({"host": self.host, "projectId": "proj-a", "repository": "example.test/owner/project"}).encode()

        def bind_project():
            self.credentials.write_bytes(credentials)
            connection.write_bytes(binding)

        self.before_design_delivery = bind_project
        result = self.run_design_connect(scope="read")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["reason"], "existing_project_binding")
        self.assertEqual(self.credentials.read_bytes(), credentials)
        self.assertEqual(connection.read_bytes(), binding)

    def test_repository_bundle_passes_without_installing_or_updating(self):
        self.cli = CLI
        result, payload = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(payload["data"]["connected"])
        self.assertEqual(payload["data"]["checks"][1]["stage"], "skills")

    def test_build_skill_reuses_existing_project_binding_and_reads_intake(self):
        self.design_result['permissions'] = {'write': False}
        setup, checked = self.run_build_check(skills="cds, cds-build")
        self.assertEqual(setup.returncode, 0, setup.stdout + setup.stderr)
        self.assertEqual(checked["data"]["scope"], "design-read")
        skills = next(item for item in checked['data']['checks'] if item['stage'] == 'skills')
        self.assertEqual(skills['loadOnly'], ['cds', 'cds-build'])
        self.assertEqual([url for url, _ in self.requests],
                         [BUILD_SETUP, "/api/credentials/self-check", DESIGN_INTAKE])

        result, intake = self.run_cli('design', 'intake')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(intake['data']['projectId'], 'proj-a')
        self.assertFalse(intake['data']['permissions']['write'])
        self.assertEqual(self.requests[-1][0], DESIGN_INTAKE)
        self.assertEqual(self.design_requests, [])

    def test_build_setup_checks_the_required_version_and_actual_distribution(self):
        original = self.build_manifest.copy()
        for status, overrides, reason in (
            (503, {"cliVersion": "0.26.28", "error": "skill_bundle_incompatible"}, "skill_bundle_incompatible"),
            (503, {"error": "temporarily_unavailable"}, "setup_unavailable"),
            (200, {"cliVersion": "0.26.28"}, "skill_bundle_incompatible"),
            (200, {"minCliVersion": "99.0.0", "cliVersion": "99.0.0"}, "stale_cli"),
            (200, {"cliVersion": None}, "version_unavailable"),
        ):
            with self.subTest(status=status, overrides=overrides):
                self.build_setup_status = status
                self.build_manifest = {**original, **overrides}
                self.requests.clear()
                result, payload = self.run_build_check()
                self.assertEqual(result.returncode, 2, payload)
                self.assertFalse(payload["data"]["connected"])
                self.assertEqual(payload["data"]["checks"][-1]["reason"], reason)
                self.assertEqual([url for url, _ in self.requests], [BUILD_SETUP])
        self.assertEqual(self.design_requests, [])

    def test_build_setup_rejects_mismatched_scope_and_target(self):
        original = self.build_manifest.copy()
        for field, value in (
            ("target", {"kind": "existing", "projectId": "proj-b"}),
            ("skills", ["cds-design"]),
            ("mission", "design-publish"),
            ("designAccess", "publish"),
        ):
            with self.subTest(field=field):
                self.build_manifest = {**original, field: value}
                self.requests.clear()
                result, payload = self.run_build_check()
                self.assertEqual(result.returncode, 2, payload)
                self.assertEqual(payload["data"]["checks"][-1]["reason"], "design_approval_unavailable")
                self.assertEqual([url for url, _ in self.requests], [BUILD_SETUP])
        self.assertEqual(self.design_requests, [])

    def test_build_feedback_checks_feedback_permission_without_requiring_publish(self):
        for allowed in (False, True):
            with self.subTest(allowed=allowed):
                self.design_result["permissions"] = {"feedback": allowed, "write": False}
                self.requests.clear()
                result, checked = self.run_build_check("feedback")
                self.assertEqual(result.returncode, 0 if allowed else 2, checked)
                if allowed:
                    self.assertEqual(checked["data"]["scope"], "design-feedback")
                else:
                    self.assertEqual(checked["data"]["checks"][-1]["reason"], "design_scope_required")
                self.assertEqual([url for url, _ in self.requests],
                                 [BUILD_SETUP, "/api/credentials/self-check", DESIGN_INTAKE])
        self.assertEqual(self.design_requests, [])

    def test_revoked_build_key_returns_to_the_original_project_workflow(self):
        self.status = "revoked"
        before = self.credentials.read_bytes()
        for scope in ("read", "feedback"):
            with self.subTest(scope=scope):
                self.requests.clear()
                result, checked = self.run_build_check(scope)
                self.assertEqual(result.returncode, 2, checked)
                error = checked["data"]["checks"][-1]
                self.assertEqual(error["reason"], "revoked")
                self.assertIn("已签发密钥", error["nextStep"])
                self.assertIn("交付 → 反馈", error["nextStep"])
                self.assertNotIn("重新连接", error["nextStep"])
                self.assertEqual([url for url, _ in self.requests], [BUILD_SETUP, "/api/credentials/self-check"])
        self.assertEqual(self.credentials.read_bytes(), before)
        self.assertEqual(self.design_requests, [])

    def test_design_read_without_implementation_keeps_the_existing_compatibility_check(self):
        result, payload = self.run_build_check(skills="cds")
        self.assertEqual(result.returncode, 0, payload)
        self.assertEqual(payload["data"]["scope"], "design-read")
        self.assertEqual([url for url, _ in self.requests],
                         [DESIGN_SETUP, "/api/credentials/self-check", DESIGN_INTAKE])

    def test_update_installs_implementation_skill_and_keeps_workspace_files(self):
        skills_root = self.cli.parents[2]
        build_skill = skills_root / 'cds-build/SKILL.md'
        build_skill.write_text('---\nname: cds-build\n---\n# 固定版实施\n', encoding='utf-8')
        self.write_bundle_manifest()
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz') as bundle:
            for skill in SKILLS:
                bundle.add(skills_root / skill, arcname=f'skills/{skill}')
        self.update_bundle = archive.getvalue()
        build_skill.unlink()
        workspace_note = skills_root / 'cds/local-notes.md'
        workspace_note.write_text('保留工作区内容', encoding='utf-8')

        result, updated = self.run_cli('update')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertCountEqual(updated['data']['skillsUpdated'], SKILLS)
        self.assertIn('name: cds-build', build_skill.read_text(encoding='utf-8'))
        self.assertEqual(workspace_note.read_text(encoding='utf-8'), '保留工作区内容')
        backup = Path(updated['data']['backupAt'])
        self.assertEqual(backup.parents[1], self.root / '.cds')
        self.assertTrue((backup / 'cds/local-notes.md').is_file())

    def test_host_mismatch_sends_no_credentials(self):
        self.assert_failure("host_mismatch", host="https://other.example")
        self.assertEqual(self.requests, [])

    def test_non_http_host_cannot_read_a_local_file_through_health(self):
        local_secret = "local_file_content_must_not_be_printed"
        local = self.root / "local-host"
        local.mkdir()
        (local / "healthz").write_text(local_secret)
        result, payload = self.run_cli("health", credential_env={"CDS_HOST": local.as_uri()})
        self.assertNotIn(local_secret, result.stdout + result.stderr)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(payload["ok"])
        self.assertEqual(self.requests, [])

    def test_invalid_host_schemes_authority_and_ports_stop_before_network(self):
        for host in (
            f"ftp://127.0.0.1:{self.server.server_port}",
            f"gopher://127.0.0.1:{self.server.server_port}",
            f"httpx://127.0.0.1:{self.server.server_port}",
            f"http://user:password@127.0.0.1:{self.server.server_port}",
            "http://127.0.0.1:bad", "http://127.0.0.1:65536", "http://",
        ):
            with self.subTest(host=host):
                result, payload = self.run_cli("health", credential_env={"CDS_HOST": host})
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(payload["ok"])
                self.assertIn("HTTP/HTTPS", payload["error"])
        self.assertEqual(self.requests, [])

    def test_redirects_at_any_check_stage_never_forward_credentials_or_claim_connected(self):
        forwarded = []
        test = self

        class Receiver(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                forwarded.append((self.path, self.headers.get("X-AI-Access-Key") == SECRET))
                if self.path.endswith("setup.json"):
                    body = {"version": "cds-agent-setup.v1", "cliVersion": test.version,
                            "minCliVersion": test.minimum_version}
                elif self.path.endswith("self-check"):
                    body = {"kind": "project", "status": "active", "projectId": "proj-a"}
                else:
                    body = {"project": {"id": "proj-a"}}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

        receiver = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        thread = threading.Thread(target=receiver.serve_forever, daemon=True)
        thread.start()
        try:
            for stage, route in enumerate(("/api/agent/setup.json", "/api/credentials/self-check", "/api/projects/proj-a"), 1):
                with self.subTest(route=route):
                    self.requests.clear()
                    forwarded.clear()
                    self.redirects = {route: f"http://127.0.0.1:{receiver.server_port}{route}"}
                    result, payload = self.run_check()
                    self.assertEqual(forwarded, [])
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(payload["data"]["connected"])
                    self.assertEqual(payload["data"]["checks"][-1]["reason"], "unexpected_redirect")
                    self.assertEqual(len(self.requests), stage)
        finally:
            receiver.shutdown()
            receiver.server_close()
            thread.join()

    def test_equivalent_source_origins_do_not_block_setup_or_strict_inspect(self):
        for local, explicit in (
            ("https://cds.example", "https://CDS.EXAMPLE:443"),
            ("https://cds.example", "HTTPS://CDS.EXAMPLE:443/"),
            ("http://localhost", "http://LOCALHOST:80/"),
            ("http://[::1]", "http://[::1]:80"),
            ("https://cds.example:8443", "https://CDS.EXAMPLE:8443/"),
            ("cds.example", "https://CDS.EXAMPLE:443"),
        ):
            with self.subTest(local=local, explicit=explicit):
                self.credentials.write_text(json.dumps({"host": local, "projectId": "proj-a", "projectKey": SECRET}))
                env = {"CDS_HOST": explicit}
                result, payload = self.run_cli("auth", "inspect", "--strict", credential_env=env)
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertEqual(payload["data"]["conflicts"], [])
                result, payload = self.run_check(host="https://other.example", credential_env=env)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(payload["data"]["checks"][-1]["reason"], "host_mismatch")
        self.assertEqual(self.requests, [])

    def test_different_source_origins_still_stop_before_network(self):
        self.credentials.write_text(json.dumps({"host": "https://cds.example", "projectId": "proj-a", "projectKey": SECRET}))
        for explicit in ("http://cds.example", "https://cds.example:8443", "https://other.example"):
            with self.subTest(explicit=explicit):
                env = {"CDS_HOST": explicit}
                result, payload = self.run_cli("auth", "inspect", "--strict", credential_env=env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("host", payload["credentialSummary"]["conflicts"])
                result, payload = self.run_check(host=explicit, credential_env=env)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(payload["data"]["checks"][-1]["reason"], "credential_conflict")
        self.assertEqual(self.requests, [])

    def test_equivalent_source_hosts_reuse_credentials_over_real_http(self):
        host = f"http://localhost:{self.server.server_port}"
        self.credentials.write_text(json.dumps({"host": host, "projectId": "proj-a", "projectKey": SECRET}))
        result, payload = self.run_check(host=host, credential_env={"CDS_HOST": host.replace("http://localhost", "HTTP://LOCALHOST")})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(payload["data"]["connected"])
        self.assertEqual(len(self.requests), 3)
        self.assertTrue(all(key == SECRET for _, key in self.requests))

    def test_project_mismatch_stops_before_network(self):
        self.assert_failure("project_mismatch", "--project", "proj-b")
        self.assertEqual(self.requests, [])

    def test_empty_project_does_not_fall_back_to_system_access(self):
        self.assert_failure("invalid_project", "--project", "")
        self.assertEqual(self.requests, [])

    def test_missing_credentials_does_not_start_authorization(self):
        self.credentials.unlink()
        self.assert_failure("missing_credentials")
        self.assertEqual(self.requests, [])

    def test_revoked_credentials_do_not_read_project(self):
        self.status = "revoked"
        self.assert_failure("revoked")
        self.assertEqual(len(self.requests), 2)

    def test_disabled_identity_does_not_recommend_repeated_authorization(self):
        self.status = "principal-disabled"
        result, payload = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("恢复账号", payload["data"]["checks"][-1]["nextStep"])
        self.assertEqual(len(self.requests), 2)

    def test_uncheckable_identity_distinguishes_service_support_from_expired_key(self):
        self.status = "not-checkable"
        result, payload = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("服务版本", payload["data"]["checks"][-1]["nextStep"])

    def test_stale_cli_cannot_claim_connected(self):
        self.version = "99.0.0"
        self.assert_failure("stale_cli")
        self.assertEqual(len(self.requests), 1)

    def test_minimum_version_is_enforced_independently_of_resolved_bundle(self):
        self.minimum_version = "99.0.0"
        self.assert_failure("stale_cli")
        self.assertEqual(len(self.requests), 1)

    def test_unavailable_minimum_version_cannot_claim_connected(self):
        for minimum in (None, "invalid"):
            with self.subTest(minimum=minimum):
                self.minimum_version = minimum
                self.assert_failure("version_unavailable")
        self.assertTrue(all(path == "/api/agent/setup.json" for path, _ in self.requests))

    def test_missing_bundle_is_distinct_from_authorization(self):
        (self.root / ".agents/skills/preview-url/SKILL.md").unlink()
        self.assert_failure("incomplete_bundle")
        self.assertEqual(self.requests, [])

    def test_missing_implementation_skill_is_incomplete_before_sending_credentials(self):
        (self.cli.parents[2] / 'cds-build/SKILL.md').unlink()
        result, checked = self.run_cli('setup-check', '--host', self.host, '--project', 'proj-a', '--skills', 'cds-build')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(checked['data']['checks'][-1]['reason'], 'incomplete_bundle')
        self.assertIn('cds-build', checked['data']['checks'][-1]['nextStep'])
        self.assertEqual(self.requests, [])

    def test_bundle_manifest_is_required_and_parseable(self):
        for content in (None, "{broken"):
            with self.subTest(content=content):
                if content is None:
                    self.bundle_manifest.unlink()
                else:
                    self.bundle_manifest.write_text(content)
                self.assert_failure("bundle_manifest_unavailable")
        self.assertEqual(self.requests, [])

    def test_bundle_manifest_version_and_coverage_are_required(self):
        original = json.loads(self.bundle_manifest.read_text())
        for update, reason in (({"version": "0.1.0"}, "stale_bundle"),
                               ({"skills": ["cds"]}, "invalid_bundle_manifest"),
                               ({"files": {}}, "invalid_bundle_manifest")):
            with self.subTest(update=update):
                self.bundle_manifest.write_text(json.dumps({**original, **update}))
                self.assert_failure(reason)
        self.assertEqual(self.requests, [])

    def test_bundle_manifest_detects_mixed_companion_content(self):
        (self.cli.parents[2] / "cds-release/SKILL.md").write_text("obsolete release instructions")
        self.assert_failure("bundle_content_mismatch")
        self.assertEqual(self.requests, [])

    def test_bundle_manifest_checks_references_too(self):
        reference = self.cli.parents[2] / "cds-deploy-pipeline/reference.md"
        reference.write_text("current deployment contract")
        self.write_bundle_manifest()
        reference.write_text("obsolete deployment contract")
        self.assert_failure("bundle_content_mismatch")
        self.assertEqual(self.requests, [])

    def test_bundle_manifest_cannot_reference_paths_outside_skills(self):
        manifest = json.loads(self.bundle_manifest.read_text())
        manifest["files"]["../../outside"] = "0" * 64
        self.bundle_manifest.write_text(json.dumps(manifest))
        self.assert_failure("invalid_bundle_manifest")
        self.assertEqual(self.requests, [])

    def test_custom_files_outside_bundle_manifest_remain_usable(self):
        extra = self.cli.parents[2] / "cds/local-notes.md"
        extra.write_text("user custom notes")
        result, payload = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(payload["data"]["connected"])
        self.assertEqual(extra.read_text(), "user custom notes")

    def test_active_credential_without_real_project_access_fails(self):
        self.project_status = 403
        self.assert_failure("access_denied")

    def test_wrong_project_response_is_rejected_even_with_http_200(self):
        self.returned_project = "proj-b"
        self.assert_failure("target_mismatch")

    def test_system_task_cannot_reuse_project_key_as_system_permission(self):
        self.assert_failure("system_scope_required", "--system")
        self.assertFalse(any(path == "/api/config" for path, _ in self.requests))

    def test_system_check_rejects_create_only_and_project_scoped_global_keys(self):
        self.kind = "global"
        for scope in ([], ["proj-a"]):
            with self.subTest(scope=scope):
                self.global_projects = scope
                self.requests.clear()
                self.assert_failure("system_scope_required", "--system")
                self.assertFalse(any(path == "/api/config" for path, _ in self.requests))

    def test_system_check_accepts_only_confirmed_all_project_global_access(self):
        self.kind = "global"
        result, payload = self.run_check("--system")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(payload["data"]["connected"])
        self.assertIn("/api/global-agent-keys", [path for path, _ in self.requests])
        self.assertEqual(self.requests[-1][0], "/api/config")

    def test_system_read_only_check_does_not_invent_project(self):
        self.kind = "static"
        result, payload = self.run_check("--system")
        self.assertEqual(result.returncode, 0)
        self.assertIsNone(payload["data"]["projectId"])
        self.assertEqual(payload["data"]["scope"], "system-read")
        self.assertEqual(self.requests[-1][0], "/api/config")


if __name__ == "__main__":
    unittest.main()
