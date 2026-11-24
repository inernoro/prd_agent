"""Behavior tests: serve real public packages, install, upgrade and preserve edits."""

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch
import zipfile


SCRIPT = Path(__file__).with_name("skill_manager.py")
SPEC = importlib.util.spec_from_file_location("map_skill_manager", SCRIPT)
manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manager)


class PackageServer:
    def __init__(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.headers.append(dict(self.headers))
                # 公网网关会拒绝默认 Python User-Agent；下载器必须能走同一公开入口。
                if self.headers.get("User-Agent", "").startswith("Python-urllib"):
                    self.send_response(403)
                    self.end_headers()
                    return
                content = owner.archive if self.path == "/download" else json.dumps(
                    {"success": True, "data": owner.manifest}
                ).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(content)

            def log_message(self, *_args):
                pass

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.http.server_port}"
        self.url = self.base + "/manifest"
        self.headers = []
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.publish("1.0.0")

    def publish(self, version, content=None):
        self.files = {"SKILL.md": (content or f"---\nname: map-agent\nversion: {version}\n---\n").encode(),
                      "scripts/skill_manager.py": SCRIPT.read_bytes()}
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in self.files.items():
                archive.writestr("map-agent/" + name, data)
        self.archive = output.getvalue()
        self.manifest = {"key": "map-agent", "version": version,
                         "sha256": manager.digest(self.archive), "downloadUrl": self.base + "/download",
                         "files": [{"path": n, "sha256": manager.digest(b)} for n, b in self.files.items()]}

    def close(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()


class SkillManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name)
        self.server = PackageServer()

    def tearDown(self):
        self.server.close()
        self.temp.cleanup()

    def target(self, host=".agents"):
        return self.project / host / "skills" / "map-agent"

    def install(self):
        return manager.run("install", self.project, self.server.url)

    def test_install_no_host_check_without_source_then_upgrade_and_noop(self):
        self.assertTrue(self.install()["changed"])
        target = self.target()
        self.assertEqual((target / "SKILL.md").read_bytes(), self.server.files["SKILL.md"])
        self.assertFalse(self.install()["changed"])
        self.server.publish("1.1.0")
        before = (target / "SKILL.md").read_bytes()
        check = manager.run("check", self.project)
        self.assertEqual(check["installations"][0]["status"], "update-available")
        self.assertEqual(check["installations"][0]["installedVersion"], "1.0.0")
        self.assertEqual((target / "SKILL.md").read_bytes(), before)
        updated = manager.run("update", self.project)
        self.assertTrue(updated["changed"])
        self.assertEqual(updated["installations"][0]["installedVersion"], "1.1.0")
        self.assertFalse(manager.run("update", self.project)["changed"])
        self.assertTrue(all("Authorization" not in headers for headers in self.server.headers))

    def test_installs_into_all_existing_project_hosts(self):
        for host in manager.HOSTS:
            (self.project / host).mkdir()
        result = self.install()
        self.assertEqual(len(result["installations"]), 2)
        self.assertTrue(all((self.target(host) / "SKILL.md").is_file() for host in manager.HOSTS))

    def test_explicit_codex_client_is_discoverable_in_a_claude_only_project(self):
        (self.project / ".claude").mkdir()
        check = manager.run("check", self.project, self.server.url, client="codex")
        self.assertEqual(len(check["installations"]), 2)
        self.assertFalse((self.project / ".agents").exists())
        result = manager.run("install", self.project, self.server.url, client="codex")
        self.assertEqual(len(result["installations"]), 2)
        self.assertTrue((self.target() / "SKILL.md").is_file())
        self.assertTrue((self.target(".claude") / "SKILL.md").is_file())

    def test_repacked_identical_files_do_not_require_a_fake_version_update(self):
        self.install()
        output = io.BytesIO(self.server.archive)
        with zipfile.ZipFile(output, "a") as archive:
            archive.comment = b"different archive metadata, same verified files"
        self.server.archive = output.getvalue()
        self.server.manifest["sha256"] = manager.digest(self.server.archive)
        self.assertFalse(manager.run("update", self.project)["changed"])

    def test_local_edits_and_extra_files_are_never_overwritten(self):
        self.install()
        target = self.target()
        (target / "SKILL.md").write_text("my local changes", encoding="utf-8")
        (target / "private.txt").write_text("keep this", encoding="utf-8")
        self.server.publish("2.0.0")
        result = manager.run("check", self.project)
        self.assertEqual(result["installations"][0]["status"], "local-modifications")
        with self.assertRaises(manager.InstallError):
            manager.run("update", self.project)
        self.assertEqual((target / "SKILL.md").read_text(), "my local changes")
        self.assertEqual((target / "private.txt").read_text(), "keep this")

    def test_unmanaged_existing_directory_is_not_claimed(self):
        self.target().mkdir(parents=True)
        (self.target() / "SKILL.md").write_text("unmanaged", encoding="utf-8")
        with self.assertRaises(manager.InstallError):
            self.install()
        self.assertEqual((self.target() / "SKILL.md").read_text(), "unmanaged")

    def test_tampered_archive_keeps_existing_install(self):
        self.install()
        before = (self.target() / "SKILL.md").read_bytes()
        self.server.publish("2.0.0")
        self.server.archive += b"tampered"
        with self.assertRaisesRegex(manager.InstallError, "校验失败"):
            manager.run("update", self.project)
        self.assertEqual((self.target() / "SKILL.md").read_bytes(), before)

    def test_edits_made_during_download_are_preserved(self):
        self.install()
        self.server.publish("2.0.0")
        actual_unpack = manager.unpack

        def download_then_edit(manifest):
            files = actual_unpack(manifest)
            (self.target() / "SKILL.md").write_text("edited during download", encoding="utf-8")
            return files

        with patch.object(manager, "unpack", side_effect=download_then_edit):
            with self.assertRaisesRegex(manager.InstallError, "发生变化"):
                manager.run("update", self.project)
        self.assertEqual((self.target() / "SKILL.md").read_text(), "edited during download")

    def test_cross_origin_package_url_is_rejected_without_install(self):
        self.server.manifest["downloadUrl"] = "https://another.example.test/download"
        with self.assertRaisesRegex(manager.InstallError, "来源不同"):
            self.install()
        self.assertFalse(self.target().exists())

    def test_downgrade_and_same_version_content_drift_are_blocked(self):
        self.install()
        for version in ("0.9.0", "1.0.0"):
            self.server.publish(version, "changed content")
            with self.assertRaises(manager.InstallError):
                manager.run("update", self.project)
        self.assertEqual(manager.read_state(self.target())["version"], "1.0.0")

    def test_cross_host_failure_rolls_back_all_directories(self):
        for host in manager.HOSTS:
            (self.project / host).mkdir()
        self.install()
        before = {host: (self.target(host) / "SKILL.md").read_bytes() for host in manager.HOSTS}
        self.server.publish("2.0.0")
        real_replace = manager.os.replace
        failed = False

        def fail_second_stage(source, target):
            nonlocal failed
            if (not failed and Path(target).resolve() == self.target(".agents").resolve()
                    and "stage" in str(source) and "previous" not in str(source)):
                failed = True
                raise OSError("simulated replacement failure")
            return real_replace(source, target)

        with patch.object(manager.os, "replace", side_effect=fail_second_stage):
            with self.assertRaises(OSError):
                manager.run("update", self.project)
        for host in manager.HOSTS:
            self.assertEqual((self.target(host) / "SKILL.md").read_bytes(), before[host])
            self.assertEqual(manager.read_state(self.target(host))["version"], "1.0.0")
            self.assertEqual(list(self.target(host).parent.glob(".map-agent-stage-*")), [])

    def test_zip_traversal_rejected_before_writing(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("map-agent/../escaped", b"not allowed")
        self.server.archive = output.getvalue()
        self.server.manifest["sha256"] = manager.digest(self.server.archive)
        with self.assertRaisesRegex(manager.InstallError, "越界"):
            self.install()
        self.assertFalse((self.project / "escaped").exists())
        self.assertFalse(self.target().exists())

    def test_actual_cli_install_and_installed_script_check(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "install", "--project", str(self.project),
                                 "--manifest-url", self.server.url], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["data"]["changed"])
        installed_script = self.target() / "scripts" / "skill_manager.py"
        result = subprocess.run([sys.executable, str(installed_script), "check", "--project", str(self.project)],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"]["installations"][0]["status"], "current")


if __name__ == "__main__":
    unittest.main()
