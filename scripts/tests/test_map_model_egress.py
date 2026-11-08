import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("map_model_egress", ROOT / "scripts/check-map-model-egress.py")
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)


class MapModelEgressTests(unittest.TestCase):
    def fixture(self, source, *, granted=None, program=None, project=None, ci=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        api = root / "prd-api/src/PrdAgent.Api"
        api.mkdir(parents=True)
        api.joinpath("Program.cs").write_text(program or "services.AddMapModelEgressGuard();\nsp.GetRequiredService<ITaskExecutionAuthorizer>();")
        api.joinpath("FutureBusiness.cs").write_text(source)
        root.joinpath(".github/workflows").mkdir(parents=True)
        root.joinpath(".github/workflows/ci.yml").write_text(ci if ci is not None else
            "paths: [prd-api/src/**, llmgw/serving/**]\nrun: python3 scripts/check-map-model-egress.py\nrun: python3 -m unittest scripts.tests.test_map_model_egress\n")
        if project:
            api.joinpath("PrdAgent.Api.csproj").write_text(project)
        ledger = {"files": granted or {}}
        return root, ledger

    def test_new_raw_http_constructor_is_rejected(self):
        root, ledger = self.fixture("using System.Net.Http; class Future { HttpClient Create() => new HttpClient(); }")
        self.assertTrue(any("FutureBusiness" in item for item in GUARD.check(root, ledger)))

    def test_qualified_alias_and_target_typed_constructors_are_found(self):
        for source in [
            "var client = new System.Net.Http.HttpClient();",
            "var client = new global::System.Net.Http.HttpClient();",
            "using Net = System.Net.Http.HttpClient; var client = new Net();",
            "HttpClient client = new();",
            "var socket = new ClientWebSocket();",
            "var socket = new TcpClient();",
        ]:
            with self.subTest(source=source):
                self.assertTrue(GUARD.invocation_fingerprints(source))

    def test_future_factory_client_is_not_silently_allowed(self):
        root, ledger = self.fixture("var http = clients.CreateClient(); await http.PostAsync(url, payload);")
        self.assertTrue(any("FutureBusiness" in item for item in GUARD.check(root, ledger)))

    def test_existing_exception_file_is_not_a_blanket_exemption(self):
        existing = "var http = factory.CreateClient(); await http.GetAsync(assetUrl);"
        calls = dict(GUARD.invocation_fingerprints(existing))
        root, ledger = self.fixture(existing + " await http.PostAsync(vendorUrl, body);", granted={
            "prd-api/src/PrdAgent.Api/FutureBusiness.cs": {"purpose": "附件读取", "calls": calls},
        })
        self.assertTrue(any("新增或变更" in item for item in GUARD.check(root, ledger)))

    def test_audited_attachment_call_and_gateway_business_use_are_allowed(self):
        existing = "var http = factory.CreateClient(); await http.GetAsync(assetUrl);"
        source = existing + " await _gateway.SendAsync(request); var llm = gateway.CreateClient(caller);"
        root, ledger = self.fixture(source, granted={
            "prd-api/src/PrdAgent.Api/FutureBusiness.cs": {"purpose": "附件读取", "calls": dict(GUARD.invocation_fingerprints(existing))},
        })
        self.assertEqual([], GUARD.check(root, ledger))

    def test_gateway_namespace_is_not_mistaken_for_in_process_gateway_constructor(self):
        self.assertFalse(GUARD.invocation_fingerprints("var body = new PrdAgent.Core.LlmGateway.GatewayRequest();"))
        self.assertTrue(GUARD.invocation_fingerprints("var gateway = new PrdAgent.Infrastructure.LlmGateway.LlmGateway();"))

    def test_strings_and_comments_cannot_spoof_a_network_construction(self):
        source = '\n// new HttpClient();\n/* new ClientWebSocket(); */\nvar message = "new TcpClient()";\nvar raw = """new HttpClient()""";'
        self.assertFalse(GUARD.invocation_fingerprints(source))

    def test_known_vendor_sdk_namespace_and_package_are_rejected(self):
        root, ledger = self.fixture("using OpenAI; class Future {}", project='<PackageReference Include="Azure.AI.OpenAI" Version="1" />')
        failures = GUARD.check(root, ledger)
        self.assertTrue(any("SDK，请调用" in item for item in failures))
        self.assertTrue(any("SDK 包依赖" in item for item in failures))

    def test_removing_registration_does_not_leave_a_green_source_guard(self):
        root, ledger = self.fixture("class Future {}", program="// services.AddMapModelEgressGuard();")
        failures = GUARD.check(root, ledger)
        self.assertTrue(any("守卫注册" in item for item in failures))
        self.assertTrue(any("authorizer" in item for item in failures))

    def test_unknown_future_sdk_package_cannot_bypass_known_vendor_names(self):
        root, ledger = self.fixture("class Future {}", project='<PackageReference Include="FutureVendor.PaidModels" Version="1" />')
        self.assertTrue(any("新依赖未进入平台出口审计" in item for item in GUARD.check(root, ledger)))

    def test_removing_ci_wiring_does_not_leave_a_green_source_guard(self):
        root, ledger = self.fixture("class Future {}", ci="# python3 scripts/check-map-model-egress.py\n")
        failures = GUARD.check(root, ledger)
        self.assertTrue(any("源码守卫" in item for item in failures))
        self.assertTrue(any("回归测试" in item for item in failures))

    def test_existing_ci_script_suite_executes_the_guard_regression(self):
        root, ledger = self.fixture("class Future {}", ci='paths: [prd-api/src/**, llmgw/serving/**]\nrun: python3 scripts/check-map-model-egress.py\nfor t in scripts/tests/test_*.py; do\n  python3 "$t"\ndone\n')
        self.assertEqual([], GUARD.check(root, ledger))

    def test_future_serving_worker_cannot_construct_untracked_http_or_socket(self):
        for source in ["var client = new HttpClient();", "var socket = new ClientWebSocket();"]:
            with self.subTest(source=source):
                root, ledger = self.fixture("class Future {}")
                serving = root / "llmgw/serving"
                serving.mkdir(parents=True)
                serving.joinpath("FuturePaidWorker.cs").write_text(source)
                self.assertTrue(any("FuturePaidWorker" in failure for failure in GUARD.check(root, ledger)))

    def test_future_serving_worker_cannot_start_untracked_model_process(self):
        for source in [
            'var process = Process.Start("python3", "model.py");',
            'var process = System.Diagnostics.Process.Start("python3", "model.py");',
            'var process = global::System.Diagnostics.Process.Start("python3", "model.py");',
            'using WorkerProcess = System.Diagnostics.Process; var process = WorkerProcess.Start("python3", "model.py");',
        ]:
            with self.subTest(source=source):
                root, ledger = self.fixture("class Future {}")
                serving = root / "llmgw/serving"
                serving.mkdir(parents=True)
                serving.joinpath("FuturePaidWorker.cs").write_text(source)
                self.assertTrue(any(key.startswith("static:Process.Start:") for key in GUARD.invocation_fingerprints(source)))
                self.assertTrue(any("FuturePaidWorker" in failure for failure in GUARD.check(root, ledger)))

    def test_audited_ffmpeg_process_call_does_not_allow_another_executable(self):
        existing = 'var process = Process.Start("ffmpeg", "-version");'
        root, ledger = self.fixture(existing, granted={
            "prd-api/src/PrdAgent.Api/FutureBusiness.cs": {"purpose": "已有媒体工具自检", "calls": dict(GUARD.invocation_fingerprints(existing))},
        })
        self.assertEqual([], GUARD.check(root, ledger))
        root.joinpath("prd-api/src/PrdAgent.Api/FutureBusiness.cs").write_text('var process = Process.Start("python3", "model.py");')
        self.assertTrue(any("新增或变更" in failure for failure in GUARD.check(root, ledger)))

    def test_serving_existing_host_is_not_an_unlimited_di_exception(self):
        existing = "builder.Services.AddScoped<DoubaoStreamAsrService>();"
        root, ledger = self.fixture("class Future {}", granted={
            "llmgw/serving/Program.cs": {"purpose": "现有宿主底层注册", "calls": dict(GUARD.invocation_fingerprints(existing))},
        })
        serving = root / "llmgw/serving"
        serving.mkdir(parents=True)
        serving.joinpath("Program.cs").write_text(existing + " var raw = sp.GetRequiredService<DoubaoStreamAsrService>();")
        self.assertTrue(any("新增或变更" in failure for failure in GUARD.check(root, ledger)))

    def test_serving_new_worker_cannot_resolve_vendor_di_without_constructor(self):
        root, ledger = self.fixture("class Future {}")
        serving = root / "llmgw/serving"
        serving.mkdir(parents=True)
        serving.joinpath("FuturePaidWorker.cs").write_text("var raw = sp.GetRequiredService<DoubaoStreamAsrService>();")
        self.assertTrue(any("禁止直接引用底层" in failure for failure in GUARD.check(root, ledger)))

    def test_serving_unknown_sdk_dependency_is_audited(self):
        root, ledger = self.fixture("class Future {}")
        serving = root / "llmgw/serving"
        serving.mkdir(parents=True)
        serving.joinpath("PrdAgent.LlmGateway.csproj").write_text('<PackageReference Include="FutureVendor.PaidSdk" Version="1" />')
        self.assertTrue(any("新依赖未进入平台出口审计" in failure for failure in GUARD.check(root, ledger)))

    def test_existing_asr_pure_helpers_do_not_allow_the_paid_executor(self):
        root, ledger = self.fixture("var text = LiveAsrBatchFallbackService.ExtractText(result); var size = LiveAsrBatchFallbackService.WindowBytes;")
        self.assertEqual([], GUARD.check(root, ledger))
        root.joinpath("prd-api/src/PrdAgent.Api/FutureBusiness.cs").write_text("var executor = sp.GetRequiredService<LiveAsrBatchFallbackService>();")
        self.assertTrue(any("禁止直接引用底层" in failure for failure in GUARD.check(root, ledger)))

    def test_ci_must_trigger_for_serving_source_changes(self):
        root, ledger = self.fixture("class Future {}", ci='paths: [prd-api/src/**]\nrun: python3 scripts/check-map-model-egress.py\nrun: python3 -m unittest scripts.tests.test_map_model_egress\n')
        self.assertTrue(any("llmgw/serving/**" in failure for failure in GUARD.check(root, ledger)))

    def test_map_cannot_resolve_existing_raw_vendor_executor_without_new_constructor(self):
        root, ledger = self.fixture("var service = sp.GetRequiredService<DoubaoStreamAsrService>();")
        self.assertTrue(any("禁止直接引用底层" in item for item in GUARD.check(root, ledger)))

    def test_deleted_exception_cannot_be_left_for_future_revival(self):
        root, ledger = self.fixture("class Future {}", granted={
            "prd-api/src/PrdAgent.Api/FutureBusiness.cs": {"purpose": "附件读取", "calls": dict(GUARD.invocation_fingerprints("var http = new HttpClient();"))},
        })
        self.assertTrue(any("可复活的旁路" in item for item in GUARD.check(root, ledger)))

    def test_no_directory_wildcards_or_missing_audit_purposes(self):
        ledger = json.loads((ROOT / "scripts/fixtures/map-model-egress-audit.json").read_text())
        for path, item in ledger["files"].items():
            self.assertNotIn("*", path)
            self.assertTrue(path.endswith(".cs"))
            self.assertTrue(item["purpose"])
            self.assertTrue(item["calls"])


if __name__ == "__main__":
    unittest.main()
