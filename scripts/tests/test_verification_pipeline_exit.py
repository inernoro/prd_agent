#!/usr/bin/env python3
"""验证原脚本的管道失败会拒绝真实提交，且不调用宿主 SDK。

运行：python3 scripts/tests/test_verification_pipeline_exit.py
CI 由 ci.yml 的 scripts/tests/test_*.py 循环执行。
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE_ROOT = Path(__file__).resolve().parents[2]


class VerificationPipelineExitTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="prd-verification-pipeline-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.repo = self.root / "repo"
        self.bin = self.root / "bin"
        self.repo.mkdir()
        self.bin.mkdir()
        self.env = {
            "PATH": str(self.bin),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "VERIFICATION_TOOL_LOG": str(self.root / "tools.log"),
            "VERIFICATION_FAIL_STAGE": "",
            "VERIFICATION_FORMAT_INSTALLED": "0",
        }
        for name in ("git", "dirname", "mkdir", "cat", "chmod", "grep", "tail", "sed", "head", "tr"):
            target = shutil.which(name, path=os.defpath)
            self.assertIsNotNone(target, f"缺少夹具必需系统工具：{name}")
            (self.bin / name).symlink_to(target)
        self.command(["git", "init", "--quiet"])
        self.command(["git", "config", "--local", "core.hooksPath", str(self.repo / ".git" / "hooks")])
        self.command(["git", "config", "--local", "user.name", "验证夹具"])
        self.command(["git", "config", "--local", "user.email", "pipeline-test@example.invalid"])
        self.command(["git", "config", "--local", "commit.gpgsign", "false"])
        hooks = self.command(["git", "rev-parse", "--git-path", "hooks"]).stdout.strip()
        self.assertEqual(Path(hooks).resolve(), (self.repo / ".git" / "hooks").resolve())
        (self.repo / "scripts").mkdir()
        for name in ("setup-hooks.sh", "verify-changes.sh", "validate-commit-msg.sh"):
            shutil.copy2(SOURCE_ROOT / "scripts" / name, self.repo / "scripts" / name)
        for directory, filename in (("prd-admin", "sample.ts"), ("prd-api", "Sample.cs")):
            (self.repo / directory).mkdir()
            (self.repo / directory / filename).write_text("// 验证夹具\n", encoding="utf-8")
        for tool in ("pnpm", "dotnet"):
            stub = self.bin / tool
            stub.write_text(
                "#!/bin/bash\n"
                f"tool={tool}\n"
                'printf "%s %s\\n" "$tool" "$*" >> "$VERIFICATION_TOOL_LOG"\n'
                'if [ "$VERIFICATION_FAIL_STAGE" = "$tool:$1" ]; then\n'
                '    echo "fixture failure: $tool:$1"\n'
                "    exit 19\n"
                "fi\n"
                'if [ "$tool:$1" = "dotnet:tool" ] && [ "$VERIFICATION_FORMAT_INSTALLED" = "1" ]; then\n'
                '    echo "dotnet-format 8.0 fixture"\n'
                "fi\n"
                "exit 0\n",
                encoding="utf-8",
            )
            stub.chmod(0o755)

    def tearDown(self):
        self.scratch.cleanup()
        self.assertFalse(self.root.exists(), "仅本测试创建的临时目录必须清理")

    def command(self, args, check=True):
        result = subprocess.run(
            args, cwd=self.repo, env=self.env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15,
        )
        if check:
            self.assertEqual(result.returncode, 0, result.stdout)
        return result

    def tool_calls(self):
        log = Path(self.env["VERIFICATION_TOOL_LOG"])
        return log.read_text(encoding="utf-8").splitlines() if log.exists() else []

    def commit(self):
        self.command(["/bin/bash", "scripts/setup-hooks.sh"])
        self.command(["git", "add", "--", "prd-admin/sample.ts", "prd-api/Sample.cs"])
        return self.command(["git", "commit", "-m", "test: 验证检查管道退出状态"], check=False)

    def assert_hook_failure(self, stage):
        self.env["VERIFICATION_FAIL_STAGE"] = stage
        result = self.commit()
        self.assertIn(f"fixture failure: {stage}", result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("[pre-commit] 检查通过", result.stdout)
        self.assertNotEqual(self.command(["git", "rev-parse", "--verify", "HEAD"], check=False).returncode, 0)

    def assert_verify_failure(self, stage):
        self.env["VERIFICATION_FAIL_STAGE"] = stage
        result = self.command(["/bin/bash", "scripts/verify-changes.sh"], check=False)
        self.assertIn(f"fixture failure: {stage}", result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("所有检查通过", result.stdout)
        self.assertTrue(any(call.startswith(stage.replace(":", " ")) for call in self.tool_calls()))

    def test_hook_rejects_pnpm_type_failure(self):
        self.assert_hook_failure("pnpm:tsc")

    def test_hook_rejects_dotnet_build_failure(self):
        self.assert_hook_failure("dotnet:build")

    def test_hook_success_really_commits(self):
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("[pre-commit] 检查通过", result.stdout)
        self.command(["git", "rev-parse", "--verify", "HEAD"])
        self.assertTrue(any(call.startswith("dotnet build ") for call in self.tool_calls()))
        self.assertTrue(any(call.startswith("pnpm tsc ") for call in self.tool_calls()))

    def test_verify_rejects_dotnet_build_failure(self):
        self.assert_verify_failure("dotnet:build")

    def test_verify_rejects_dotnet_test_failure(self):
        self.assert_verify_failure("dotnet:test")

    def test_verify_rejects_pnpm_type_failure(self):
        self.assert_verify_failure("pnpm:tsc")

    def test_verify_rejects_pnpm_test_failure(self):
        self.assert_verify_failure("pnpm:test")

    def test_verify_success_runs_all_required_stages(self):
        result = self.command(["/bin/bash", "scripts/verify-changes.sh"])
        self.assertIn("所有检查通过", result.stdout)
        for stage in ("dotnet build ", "dotnet test ", "pnpm tsc ", "pnpm test "):
            self.assertTrue(any(call.startswith(stage) for call in self.tool_calls()), stage)

    def test_dotnet_format_failure_stays_nonblocking(self):
        self.env["VERIFICATION_FORMAT_INSTALLED"] = "1"
        self.env["VERIFICATION_FAIL_STAGE"] = "dotnet:format"
        result = self.command(["/bin/bash", "scripts/verify-changes.sh"])
        self.assertIn("fixture failure: dotnet:format", result.stdout)
        self.assertIn("所有检查通过", result.stdout)

    def test_absent_optional_tools_do_not_become_required(self):
        for tool in ("pnpm", "dotnet"):
            (self.bin / tool).unlink()
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.command(["git", "rev-parse", "--verify", "HEAD"])
        result = self.command(["/bin/bash", "scripts/verify-changes.sh"])
        self.assertIn("所有检查通过", result.stdout)
        self.assertEqual(self.tool_calls(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
