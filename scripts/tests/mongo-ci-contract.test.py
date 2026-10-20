#!/usr/bin/env python3
"""锁住真实 CI 的临时 Mongo 8.0 兼容环境，不替代原生服务启动与 xUnit。

运行：python3 scripts/tests/mongo-ci-contract.test.py
原事故：Actions run 39374522104 / job 118469606598 在 checkout 前启动 Mongo 失败。
"""

from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
GUARD = "scripts/tests/mongo-ci-contract.test.py"
WORKFLOW = ".github/workflows/ci.yml"


def block(text, heading, indent):
    """按当前 workflow 的同级缩进切块；重复声明拒收，不从注释取值。"""
    matches = list(re.finditer(rf"(?m)^{' ' * indent}{re.escape(heading)}:\s*$", text))
    if len(matches) != 1:
        raise AssertionError(f"必须且只能有一个 {heading}")
    tail = text[matches[0].end():]
    end = re.search(rf"(?m)^\S|^ {{1,{indent}}}\S", tail)
    return tail[:end.start()] if end else tail


class MongoCiContractTests(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / WORKFLOW).read_text(encoding="utf-8")

    def executable_run(self, server, name):
        """只读当前单行/竖线 run 形状，命令注释不能充当执行证据。"""
        steps = re.findall(
            rf"(?ms)^      - name: {re.escape(name)}\n(.*?)(?=^      - name:|\Z)", server,
        )
        self.assertEqual(len(steps), 1, name)
        step = steps[0]
        self.assertNotRegex(step, r"(?m)^        (?:if|continue-on-error):")
        runs = re.findall(r"(?m)^        run: (.+)\n((?:          .*\n|\n)*)", step)
        self.assertEqual(len(runs), 1, name)
        value, body = runs[0]
        source = body if value == "|" else value
        return "\n".join(line.strip() for line in source.splitlines()
                         if line.strip() and not line.lstrip().startswith("#"))

    def assert_server_contract(self, text):
        server = block(text, "server-build", 2)
        self.assertEqual(re.findall(r"(?m)^    runs-on: (.+)$", server), ["ubuntu-22.04"])
        self.assertIn("needs.changes.outputs.server == 'true'", server)
        self.assertRegex(text, r"(?m)^  DOTNET_VERSION: '8\.0\.x'$")
        mongo = block(block(server, "services", 4), "mongodb", 6)
        self.assertEqual(re.findall(r"(?m)^        image: (.+)$", mongo), ["mongo:8.0"])
        for required in ("27017:27017", "db.runCommand({ ping: 1 }).ok",
                         "--health-interval 5s", "--health-timeout 5s", "--health-retries 20"):
            self.assertIn(required, mongo)
        self.assertIn("MONGODB_TEST_CONNECTION: mongodb://127.0.0.1:27017", server)
        self.assertIn("dotnet-version: ${{ env.DOTNET_VERSION }}", server)
        self.assertEqual(self.executable_run(server, "Restore dependencies"), "dotnet restore PrdAgent.sln")
        self.assertEqual(self.executable_run(server, "Build"), "dotnet build PrdAgent.sln -c Release --no-restore")
        tests = self.executable_run(server, "Run tests (exclude integration and manual tests)")
        self.assertEqual(re.findall(r'(?m)^--filter "([^"]+)"', tests),
                         ["Category!=Integration&Category!=Manual"])
        self.assertRegex(tests, r"(?m)^dotnet test PrdAgent[.]sln -c Release --no-build --verbosity detailed(?: |$)")
        self.assertRegex(tests, r"(?m)^set -o pipefail$")

    def test_real_server_job_preserves_database_build_and_test_contract(self):
        self.assert_server_contract(self.workflow)

    def test_old_runner_and_reduced_test_contract_are_rejected(self):
        for before, after in (("runs-on: ubuntu-22.04", "runs-on: ubuntu-latest"),
                              ("runs-on: ubuntu-22.04", "runs-on: ubuntu-24.04"),
                              ("mongo:8.0", "mongo:7.0"),
                              ("--health-retries 20", "--health-retries 1"),
                              ("Category!=Integration&Category!=Manual", "FullyQualifiedName~Smoke"),
                              ("run: dotnet restore PrdAgent.sln", "run: echo # dotnet restore PrdAgent.sln"),
                              ("run: dotnet build PrdAgent.sln -c Release --no-restore",
                               "run: echo # dotnet build PrdAgent.sln -c Release --no-restore")):
            with self.subTest(regression=after), self.assertRaises(AssertionError):
                self.assert_server_contract(self.workflow.replace(before, after))

    def test_commented_test_pipeline_is_rejected(self):
        pipeline = re.search(
            r"(?ms)^      - name: Run tests \(exclude integration and manual tests\)\n        run: \|\n(.*?)(?=^        shell:)",
            self.workflow,
        )
        self.assertIsNotNone(pipeline)
        comments = "".join(f"          # {line.strip()}\n" for line in pipeline.group(1).splitlines())
        mutant = self.workflow[:pipeline.start(1)] + comments + "          :\n" + self.workflow[pipeline.end(1):]
        with self.assertRaises(AssertionError):
            self.assert_server_contract(mutant)

    def test_guard_runs_without_mongo_and_both_input_paths_trigger_it(self):
        release = block(self.workflow, "release-script-test", 2)
        self.assertIn("needs.changes.outputs.release_scripts == 'true'", release)
        self.assertNotIn("services:", release)
        layout = block(self.workflow, "repository-layout", 2)
        self.assertNotRegex(layout, r"(?m)^    (?:needs|if|services|continue-on-error):")
        command = f"python3 {GUARD}"
        self.assertEqual(self.executable_run(layout, "MongoDB CI compatibility contract"), command)
        self.assertLess(layout.index("uses: actions/checkout@v4"), layout.index(f"run: {command}"))
        self.assertNotIn(f"run: {command}", release)
        required = block(self.workflow, "server-required", 2)
        self.assertEqual(re.findall(r"(?m)^    (?:name|needs|if): (.+)$", required),
                         ["Server Build & Test", "[changes, server-build]", "always()"])
        self.assertNotRegex(required, r"(?m)^    (?:continue-on-error|services|defaults):")
        self.assertEqual(self.executable_run(required, "MongoDB CI compatibility contract"), command)
        self.assertLess(required.index("uses: actions/checkout@v4"), required.index(f"run: {command}"))
        server = block(self.workflow, "server-build", 2)
        self.assertEqual(re.findall(r"(?m)^    name: (.+)$", server), ["Server Build & Test (execution)"])
        self.assertNotIn(f"run: {command}", server)
        server_filters = block(self.workflow, "server", 12)
        for path in (WORKFLOW, GUARD):
            self.assertIn(f"- '{path}'", server_filters)
        filters = block(self.workflow, "release_scripts", 12)
        for path in (WORKFLOW, GUARD):
            self.assertIn(f"- '{path}'", filters)

    def test_runtime_receipt_reports_only_kernel_and_mongo_version(self):
        server = block(self.workflow, "server-build", 2)
        receipt = re.search(r"(?ms)^      - name: MongoDB runtime versions\n(.*?)(?=^      - name:)", server)
        self.assertIsNotNone(receipt)
        body = receipt.group(1)
        for required in ("uname -r", "${{ job.services.mongodb.id }}", "mongosh --quiet --eval",
                         "db.version()", "db.adminCommand({ ping: 1 }).ok !== 1", "quit(1)"):
            self.assertIn(required, body)
        self.assertNotRegex(body, r"(?m)^        (?:if|continue-on-error):")
        self.assertNotRegex(body, r"(?i)printenv|\bsecrets\b|process\.env")

    def aggregate_script(self):
        summary = block(self.workflow, "ci-status", 2)
        self.assertRegex(summary, r"(?m)^    if: always\(\)$")
        needs = re.findall(r"(?m)^    needs: \[([^\]]+)\]$", summary)
        self.assertEqual(len(needs), 1)
        jobs = [job.strip() for job in needs[0].split(",")]
        self.assertIn("repository-layout", jobs)
        self.assertNotIn("release-script-test", jobs)
        source = re.search(r"(?ms)^      - name: Check CI status\n        run: \|\n(.*)\Z", summary)
        self.assertIsNotNone(source)
        return textwrap.dedent(source.group(1))

    def aggregate_result(self, script, layout_result, release_result="success", overrides=None):
        main = "github.event_name == 'push' && github.ref == 'refs/heads/main'"
        values = {main: "false", "needs.repository-layout.result": layout_result,
                  "needs.release-script-test.result": release_result}
        for output in ("server", "admin", "desktop", "cds", "design_runtime", "docs", "acceptance_report"):
            values[f"needs.changes.outputs.{output}"] = "true"
            values[f"needs.changes.outputs.{output} == 'true' || ({main})"] = "true"
        for job in ("server-build", "admin-build", "desktop-check", "cds-build",
                    "design-runtime-test", "docs-readability", "acceptance-report-gate"):
            values[f"needs.{job}.result"] = "success"
        values.update(overrides or {})
        def render(match):
            expression = match.group(1).strip()
            self.assertIn(expression, values)
            return values[expression]
        rendered = re.sub(r"\$\{\{(.*?)\}\}", render, script)
        self.assertNotIn("${{", rendered)
        return subprocess.run(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail"],
                              input=rendered, text=True, capture_output=True, check=False, timeout=10)

    def test_aggregate_shell_requires_layout_not_the_whole_release_job(self):
        script = self.aggregate_script()
        for result in ("success", "failure", "cancelled", "skipped"):
            with self.subTest(layout=result):
                actual = self.aggregate_result(script, result)
                self.assertEqual(actual.returncode, 0 if result == "success" else 1,
                                 actual.stdout + actual.stderr)
                self.assertIn("All required checks passed!" if result == "success" else
                              f"Repository layout: {result}", actual.stdout)
        # release 整批仍不是新阻断条件；本次只借用原 layout 消费者。
        self.assertEqual(self.aggregate_result(script, "success", "failure").returncode, 0)
        mutant = script.replace('"$layout_ok" == "true" && ', "", 1)
        self.assertNotEqual(mutant, script)
        # 摘掉真实最终消费者后，失败会实际漏成 exit0；上面的正常断言必须能抓住它。
        self.assertEqual(self.aggregate_result(mutant, "failure").returncode, 0)

    def test_required_wrapper_shell_rejects_failure_and_illegal_skip(self):
        required = block(self.workflow, "server-required", 2)
        self.executable_run(required, "Forward server result")
        source = re.search(r"(?ms)^      - name: Forward server result\n        run: \|\n(.*)\Z", required)
        self.assertIsNotNone(source)
        script = textwrap.dedent(source.group(1))
        needed = "needs.changes.outputs.server == 'true' || (github.event_name == 'push' && github.ref == 'refs/heads/main')"
        accepted = {("success", "true", "success"), ("success", "false", "success"),
                    ("success", "false", "skipped")}
        for changes in ("success", "failure", "cancelled", "skipped"):
            for needs_server in ("true", "false"):
                for result in ("success", "failure", "cancelled", "skipped"):
                    with self.subTest(changes=changes, needs_server=needs_server, result=result):
                        actual = self.aggregate_result(script, "success", overrides={
                            "needs.changes.result": changes, needed: needs_server, "needs.server-build.result": result})
                        self.assertEqual(actual.returncode, 0 if (changes, needs_server, result) in accepted else 1,
                                         actual.stdout + actual.stderr)

    def test_guard_process_rejects_real_old_runner_fixture_without_recursion(self):
        with tempfile.TemporaryDirectory(prefix="mongo-ci-contract-") as directory:
            fixture = Path(directory)
            guard = fixture / GUARD
            guard.parent.mkdir(parents=True)
            guard.write_bytes(Path(__file__).read_bytes())
            workflow = fixture / WORKFLOW
            workflow.parent.mkdir(parents=True)
            target = "MongoCiContractTests.test_real_server_job_preserves_database_build_and_test_contract"
            for runner, expected in (("ubuntu-22.04", 0), ("ubuntu-latest", 1)):
                with self.subTest(runner=runner):
                    workflow.write_text(self.workflow.replace("runs-on: ubuntu-22.04",
                                                             f"runs-on: {runner}", 1), encoding="utf-8")
                    actual = subprocess.run([sys.executable, str(guard), target], text=True,
                                            capture_output=True, check=False, timeout=10)
                    self.assertEqual(actual.returncode, expected, actual.stdout + actual.stderr)
                    self.assertIn("Ran 1 test", actual.stderr)


if __name__ == "__main__":
    unittest.main()
