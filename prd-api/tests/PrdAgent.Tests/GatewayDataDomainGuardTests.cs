using System.Diagnostics;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// LLM Gateway 数据域守卫：MAP 业务日志继续归 MAP，GW serving 请求日志与 shadow 证据归 llm_gateway。
/// 这是 full-cutover S0.5 的硬前置，防止后续装配改动把证据重新写回 prdagent。
/// </summary>
public class GatewayDataDomainGuardTests
{
    [Fact]
    public void Api_ShadowWriter_UsesGatewayDataContext()
    {
        var program = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");

        Assert.Contains("new LlmGatewayDataContext(mongoConnectionString, llmGatewayDatabaseName)", program);
        Assert.Contains("ILlmShadowComparisonWriter>(sp =>", program);
        Assert.Contains("sp.GetRequiredService<LlmGatewayDataContext>().Context", program);
        Assert.DoesNotContain(
            "AddScoped<PrdAgent.Core.Interfaces.ILlmShadowComparisonWriter,\n    PrdAgent.Infrastructure.LlmGateway.LlmShadowComparisonWriter>()",
            program);
    }

    [Fact]
    public void Serving_LogWriter_UsesGatewayDataContext_WhileResolverKeepsMapContext()
    {
        var program = ReadRepoFile("prd-api/src/PrdAgent.LlmGateway/Program.cs");

        Assert.Contains("builder.Services.AddSingleton(new MongoDbContext(mongoConn, mongoDb));", program);
        Assert.Contains("builder.Services.AddSingleton(new LlmGatewayDataContext(mongoConn, gatewayDb));", program);
        Assert.Contains("new LlmRequestLogBackground(\n        sp.GetRequiredService<LlmGatewayDataContext>().Context", program);
        Assert.Contains("new LlmRequestLogWriter(\n        sp.GetRequiredService<LlmGatewayDataContext>().Context", program);
        Assert.Contains("AddScoped<PrdAgent.Infrastructure.LlmGateway.IModelResolver, PrdAgent.Infrastructure.LlmGateway.ModelResolver>()", program);
    }

    [Fact]
    public void ShadowReadEndpoints_UseGatewayDatabase()
    {
        var servingEndpoints = ReadRepoFile("prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");

        Assert.Contains("services.GetService<LlmGatewayDataContext>()?.Context", servingEndpoints);
        Assert.Contains("var shadows = gatewayDatabase.GetCollection<BsonDocument>(\"llmshadow_comparisons\");", consoleProgram);
        Assert.DoesNotContain("var shadows = mapDatabase.GetCollection<BsonDocument>(\"llmshadow_comparisons\");", consoleProgram);
    }

    [Fact]
    public void GatewayLogs_PreserveIngressAndRoutePolicyContext_ForConsoleTrace()
    {
        var startContract = ReadRepoFile("prd-api/src/PrdAgent.Core/Interfaces/ILlmRequestLogWriter.cs");
        var logModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs");
        var logWriter = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var gatewayRequest = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayRequest.cs");
        var servingEndpoints = ReadRepoFile("prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs");
        var consoleDtos = ReadRepoFile("prd-llmgw/Models/Dtos.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var consoleTypes = ReadRepoFile("prd-llmgw-web/src/lib/types.ts");
        var drawer = ReadRepoFile("prd-llmgw-web/src/components/GenerationDetailsDrawer.tsx");
        var logsView = ReadRepoFile("prd-llmgw-web/src/components/LogsView.tsx");
        var appCallersPage = ReadRepoFile("prd-llmgw-web/src/pages/AppCallersPage.tsx");

        foreach (var field in new[] { "SourceSystem", "IngressProtocol", "AppCallerTitle", "ModelPolicy", "ModelPoolId" })
        {
            Assert.Contains(field, startContract);
            Assert.Contains($"public string? {field} {{ get; set; }}", logModel);
            Assert.Contains($"{field} = string.IsNullOrWhiteSpace(start.{field}) ? null : start.{field}", logWriter);
            Assert.Contains($"{field}: request.Context?.{field}", gateway);
            Assert.Contains($"public string? {field} {{ get; set; }}", consoleDtos);
            Assert.Contains($"{field} = d.AsNullableString(\"{field}\")", consoleProgram);
        }

        Assert.Contains("Add(\"ingress\", \"source\", sourceSystem);", consoleProgram);
        Assert.Contains("Add(\"ingress\", \"protocol\", ingressProtocol);", consoleProgram);
        Assert.Contains("Add(\"policy\", \"model policy\", modelPolicy ?? mode);", consoleProgram);
        Assert.Contains("Add(\"pool\", \"requested pool\", modelPoolId);", consoleProgram);
        Assert.Contains("SourceSystems = NormalizeDistinct(sourceSystemsRaw, 80)", consoleProgram);
        Assert.Contains("IngressProtocols = NormalizeDistinct(ingressProtocolsRaw, 80)", consoleProgram);
        Assert.Contains("ModelPolicies = NormalizeDistinct(modelPoliciesRaw, 40)", consoleProgram);
        Assert.Contains("if (!string.IsNullOrWhiteSpace(sourceSystem)) filters.Add(fb.Eq(\"SourceSystem\", sourceSystem));", consoleProgram);
        Assert.Contains("if (!string.IsNullOrWhiteSpace(ingressProtocol)) filters.Add(fb.Eq(\"IngressProtocol\", ingressProtocol));", consoleProgram);
        Assert.Contains("if (!string.IsNullOrWhiteSpace(modelPolicy)) filters.Add(fb.Eq(\"ModelPolicy\", modelPolicy));", consoleProgram);
        Assert.Contains("public List<string> SourceSystems { get; set; } = new();", consoleDtos);
        Assert.Contains("public List<string> IngressProtocols { get; set; } = new();", consoleDtos);
        Assert.Contains("public List<string> ModelPolicies { get; set; } = new();", consoleDtos);

        foreach (var field in new[] { "sourceSystem", "ingressProtocol", "appCallerTitle", "modelPolicy", "modelPoolId" })
        {
            Assert.Contains(field, consoleTypes);
            Assert.Contains(field, drawer);
        }

        foreach (var field in new[] { "sourceSystems", "ingressProtocols", "modelPolicies", "filterSourceSystem", "filterIngressProtocol", "filterModelPolicy" })
        {
            Assert.Contains(field, logsView);
        }

        foreach (var field in new[] { "LastObservedModelPolicy", "LastObservedModelPoolId", "LastObservedParameterPolicy" })
        {
            Assert.Contains($"public string? {field} {{ get; set; }}", gatewayRequest);
            Assert.Contains($"public string? {field} {{ get; set; }}", consoleDtos);
            Assert.Contains($"{field} = d.AsNullableString(\"{field}\")", consoleProgram);
        }

        Assert.Contains(".SetOnInsert(x => x.ModelPolicy, modelPolicy)", servingEndpoints);
        Assert.Contains(".SetOnInsert(x => x.ParameterPolicy, parameterPolicy)", servingEndpoints);
        Assert.Contains("updates.Add(Builders<GatewayAppCallerRecord>.Update.SetOnInsert(x => x.ModelPoolId, modelPoolId));", servingEndpoints);
        Assert.Contains(".Set(x => x.LastObservedModelPolicy, modelPolicy)", servingEndpoints);
        Assert.Contains(".Set(x => x.LastObservedModelPoolId, modelPoolId)", servingEndpoints);
        Assert.Contains(".Set(x => x.LastObservedParameterPolicy, parameterPolicy)", servingEndpoints);
        Assert.Contains("lastObservedModelPolicy", consoleTypes);
        Assert.Contains("lastObservedModelPoolId", consoleTypes);
        Assert.Contains("lastObservedParameterPolicy", consoleTypes);
        Assert.Contains("最近请求：", appCallersPage);
        Assert.Contains("BuildAppCallerDriftFilter", consoleProgram);
        Assert.Contains("BuildFieldDriftExpr(\"ModelPolicy\", \"LastObservedModelPolicy\")", consoleProgram);
        Assert.Contains("BuildFieldDriftExpr(\"ModelPoolId\", \"LastObservedModelPoolId\")", consoleProgram);
        Assert.Contains("BuildFieldDriftExpr(\"ParameterPolicy\", \"LastObservedParameterPolicy\")", consoleProgram);
        Assert.Contains("public string? Drift { get; set; }", consoleDtos);
        Assert.Contains("drift?: string", consoleTypes);
        Assert.Contains("drift: params?.drift", ReadRepoFile("prd-llmgw-web/src/lib/api.ts"));
        Assert.Contains("DRIFT_FILTERS", appCallersPage);
        Assert.Contains("路由漂移", appCallersPage);
        Assert.Contains("参数漂移", appCallersPage);
    }

    [Fact]
    public void ConsoleWriteOperations_AreAuditedToGatewayDatabase()
    {
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");

        Assert.Contains("var operationAudits = gatewayDatabase.GetCollection<BsonDocument>(\"llmgw_operation_audits\");", consoleProgram);
        Assert.Contains("WriteOperationAuditAsync", consoleProgram);
        Assert.Contains("action: \"auth.change_password\"", consoleProgram);
        Assert.Contains("action: \"platform.set_enabled\"", consoleProgram);
        Assert.Contains("action: \"model.set_enabled\"", consoleProgram);
        Assert.Contains("action: \"pool.set_default\"", consoleProgram);
        Assert.Contains("action: \"app_caller.update\"", consoleProgram);
        Assert.Contains("Owner", consoleProgram);
        Assert.Contains("MonthlyBudgetUsd", consoleProgram);
        Assert.Contains("RateLimitPerMinute", consoleProgram);
        Assert.Contains("owner 最多 120 字符", consoleProgram);
        Assert.Contains("monthlyBudgetUsd 不能小于 0", consoleProgram);
        Assert.Contains("rateLimitPerMinute 不能小于 0", consoleProgram);
        Assert.Contains("WriteSystemOperationAuditAsync", consoleProgram);
        Assert.Contains("action: \"admin.force_reset\"", consoleProgram);
        Assert.Contains("action: \"admin.force_reset_bootstrap\"", consoleProgram);
        Assert.Contains("action: \"admin.bootstrap\"", consoleProgram);
        Assert.Contains("action: \"admin.reactivate\"", consoleProgram);
        Assert.Contains("action: \"admin.deactivate_legacy_users\"", consoleProgram);
        Assert.Contains("Console.Error.WriteLine($\"[LlmGw] operation audit write failed:", consoleProgram);
        Assert.Contains("Console.Error.WriteLine($\"[LlmGw] system operation audit write failed:", consoleProgram);
        Assert.DoesNotContain("mapDatabase.GetCollection<BsonDocument>(\"llmgw_operation_audits\")", consoleProgram);
    }

    [Fact]
    public void Compose_DeclaresGatewayDatabaseName_ForApiAndServing()
    {
        var dockerCompose = ReadRepoFile("docker-compose.yml");
        var cdsCompose = ReadRepoFile("cds-compose.yml");

        Assert.Contains("LlmGateway__DatabaseName=${LLMGW_DATABASE_NAME:-llm_gateway}", dockerCompose);
        Assert.Contains("LlmGateway__HttpAppCallerAllowlist=${LLMGW_HTTP_APP_CALLER_ALLOWLIST:-}", dockerCompose);
        Assert.Contains("LlmGateway__ShadowFullSamplePercent=${LLMGW_SHADOW_FULL_SAMPLE_PERCENT:-0}", dockerCompose);
        Assert.Contains("LlmGateway__ShadowFullSampleAppCallerAllowlist=${LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST:-}", dockerCompose);
        Assert.Contains("LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:-}", dockerCompose);
        Assert.Contains("LLMGW_ADMIN_FORCE_RESET=${LLMGW_ADMIN_FORCE_RESET:-}", dockerCompose);
        Assert.DoesNotContain("LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:?", dockerCompose);
        Assert.DoesNotContain("LLMGW_ADMIN_USER", dockerCompose);
        Assert.Contains("LlmGateway__DatabaseName: llm_gateway", cdsCompose);
        Assert.Contains("控制台账号长期权威是 llm_gateway.llmgw_console_users", cdsCompose);
    }

    [Fact]
    public void ShadowForceSampling_PropagatesAcrossQueuedRuns()
    {
        var imageRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ImageGenRun.cs");
        var transcriptRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/TranscriptRun.cs");
        var documentRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/DocumentStoreAgentRun.cs");
        var videoGenRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/VideoGenModels.cs");
        var videoToDocRun = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/VideoToDocModels.cs");

        foreach (var model in new[] { imageRun, transcriptRun, documentRun, videoGenRun, videoToDocRun })
        {
            Assert.Contains("public bool ForceFullShadowSample { get; set; }", model);
        }

        var imageController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs");
        var imageMasterController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs");
        var transcriptController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/TranscriptAgentController.cs");
        var documentController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs");
        var videoController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/VideoAgentController.cs");
        var videoService = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/VideoGenService.cs");

        foreach (var creator in new[] { imageController, imageMasterController, transcriptController, documentController, videoController, videoService })
        {
            Assert.Contains("ForceFullShadowSample = _llmRequestContext.Current?.ForceFullShadowSample == true", creator);
        }

        var imageWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs");
        var transcriptWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/TranscriptRunWorker.cs");
        var subtitleProcessor = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/SubtitleGenerationProcessor.cs");
        var reprocessProcessor = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ContentReprocessProcessor.cs");
        var videoWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs");
        var videoToDocWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/VideoToDocRunWorker.cs");

        foreach (var worker in new[] { imageWorker, transcriptWorker, subtitleProcessor, reprocessProcessor, videoWorker, videoToDocWorker })
        {
            Assert.Contains("ForceFullShadowSample: run.ForceFullShadowSample", worker);
        }
    }

    [Fact]
    public void ExecDep_RequiresReleaseGateBeforeFullHttpOrCanaryMode()
    {
        var script = ReadRepoFile("exec_dep.sh");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("run_llmgw_release_gate_if_needed", script);
        Assert.Contains("check_fast_release_intent", script);
        Assert.Contains("PRD_AGENT_RELEASE_INTENT_FILE", script);
        Assert.Contains(".prd-agent-release-intent.env", script);
        Assert.Contains("PRD_AGENT_REQUIRE_FAST_INTENT", script);
        Assert.Contains("PRD_AGENT_IGNORE_FAST_INTENT", script);
        Assert.Contains("fast.sh / exec_dep.sh release ref mismatch", script);
        Assert.Contains("guard_llmgw_prod_stage_context_if_needed", script);
        Assert.Contains("Release intent: matched fast.sh warmup", script);
        Assert.Contains("LLMGW_HTTP_APP_CALLER_ALLOWLIST", script);
        Assert.Contains("read_dotenv_value", script);
        Assert.Contains("config_value LLMGW_MODE LlmGateway__Mode", script);
        Assert.Contains("config_value LLMGW_HTTP_APP_CALLER_ALLOWLIST LlmGateway__HttpAppCallerAllowlist", script);
        Assert.Contains("config_value LLMGW_SHADOW_FULL_SAMPLE_PERCENT LlmGateway__ShadowFullSamplePercent", script);
        Assert.Contains("config_value LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST LlmGateway__ShadowFullSampleAppCallerAllowlist", script);
        Assert.Contains("mode_raw=\"$(llmgw_mode_value)\"", script);
        Assert.Contains("LLMGW_POST_DEPLOY_VERIFY_NEEDED", script);
        Assert.Contains("LLMGW_POST_DEPLOY_GATE_BASE", script);
        Assert.Contains("run_llmgw_post_deploy_verification_if_needed", script);
        Assert.Contains("allowlist_compact", script);
        Assert.Contains("LLMGW_CANARY_STAGE", script);
        Assert.Contains("canary_allowed_app_callers=\"report-agent.generate::chat\"", script);
        Assert.Contains("canary_allowed_app_callers=\"report-agent.generate::chat prd-agent-desktop.chat.sendmessage::chat open-platform-agent.proxy::chat\"", script);
        Assert.Contains("canary_allowed_app_callers=\"visual-agent.image.vision::generation\"", script);
        Assert.Contains("canary_allowed_app_callers=\"visual-agent.image-gen.generate::generation visual-agent.image.text2img::generation visual-agent.image.img2img::generation\"", script);
        Assert.Contains("canary_allowed_app_callers=\"video-agent.videogen::video-gen visual-agent.videogen::video-gen document-store.subtitle::asr transcript-agent.transcribe::asr video-agent.v2d.transcribe::asr video-agent.video-to-text::asr\"", script);
        Assert.Contains("LLM Gateway canary 发布设置了 LLMGW_HTTP_APP_CALLER_ALLOWLIST，但未设置 LLMGW_CANARY_STAGE", script);
        Assert.Contains("LLM Gateway canary 阶段 $canary_stage 不允许入口 $app_trimmed", script);
        Assert.Contains("LLM Gateway canary stage: $canary_stage allowlist=$allowlist_compact", script);
        Assert.Contains("LLMGW_SHADOW_FULL_SAMPLE_PERCENT", script);
        Assert.Contains("shadow_sample_allowlist_compact", script);
        Assert.Contains("shadow_sample_enabled=0", script);
        Assert.Contains("if [ -n \"$shadow_sample_allowlist_compact\" ]; then", script);
        Assert.Contains("release_gate_required=0", script);
        Assert.Contains("if [ \"$release_gate_required\" != \"1\" ] && [ \"$shadow_sample_enabled\" != \"1\" ]; then", script);
        Assert.Contains("LLMGW_PROD_STAGE_ACTIVE", script);
        Assert.Contains("LLMGW_PROD_STAGE", script);
        Assert.Contains("必须通过 scripts/llmgw-prod-stage.sh 执行", script);
        Assert.Contains("绕过 rollout ledger、生产预检和阶段顺序审计", script);
        Assert.Contains("shadow sample startup", script);
        Assert.Contains("serving/smoke verification runs after compose up", script);
        Assert.Contains("LLM Gateway http/canary/shadow sample 发布需要提供 LLMGW_GATE_BASE 或 GW_BASE", script);
        Assert.Contains("LLM Gateway http/canary/shadow sample 发布需要提供 LLMGW_GATE_KEY/GW_KEY 或 LLMGW_SERVE_KEY", script);
        Assert.Contains("expect_commit=\"${TAG#sha-}\"", script);
        Assert.DoesNotContain("args=\"$args --expect-commit $expect_commit\"", script);
        Assert.Contains("probe_args=\"$probe_args --expect-commit $expect_commit\"", script);
        Assert.Contains("LLMGW_GATE_HEALTH_SAMPLES", script);
        Assert.Contains("LLMGW_GATE_HEALTH_INTERVAL_SECONDS", script);
        Assert.Contains("--health-samples ${LLMGW_GATE_HEALTH_SAMPLES:-3}", script);
        Assert.Contains("--health-interval ${LLMGW_GATE_HEALTH_INTERVAL_SECONDS:-5}", script);
        Assert.Contains("LLMGW_GATE_SHADOW_SINCE_HOURS", script);
        Assert.Contains("--since-hours ${LLMGW_GATE_SHADOW_SINCE_HOURS:-48}", script);
        Assert.Contains("LLMGW_GATE_MIN_COVERAGE_HOURS", script);
        Assert.Contains("--min-coverage-hours $gate_min_coverage_hours", script);
        Assert.Contains("默认要求 shadow 证据覆盖 24 小时", script);
        Assert.Contains("LLMGW_GATE_FULL_HTTP_APP_CALLERS", script);
        Assert.Contains("gate_app_callers_raw=\"${LLMGW_GATE_FULL_HTTP_APP_CALLERS:-report-agent.generate::chat", script);
        Assert.Contains("prd-agent-desktop.chat.sendmessage::chat", script);
        Assert.Contains("prd-agent-desktop.preview-ask.section::chat", script);
        Assert.Contains("open-platform-agent.proxy::chat", script);
        Assert.Contains("open-api.proxy::chat", script);
        Assert.Contains("open-api.proxy::generation", script);
        Assert.Contains("prd-agent-web.model-lab.run::chat", script);
        Assert.Contains("prd-agent.arena.battle::chat", script);
        Assert.Contains("tutorial-email.generate::chat", script);
        Assert.Contains("visual-agent.image-gen.generate::generation", script);
        Assert.Contains("visual-agent.image.text2img::generation", script);
        Assert.Contains("visual-agent.image.img2img::generation", script);
        Assert.Contains("visual-agent.image.vision::generation", script);
        Assert.Contains("video-agent.videogen::video-gen", script);
        Assert.Contains("document-store.subtitle::asr", script);
        Assert.Contains("transcript-agent.transcribe::asr", script);
        Assert.Contains("video-agent.v2d.transcribe::asr", script);
        Assert.Contains("video-agent.video-to-text::asr", script);
        Assert.Contains("LLM Gateway release gate: LLMGW_MODE=http 未设置 LLMGW_GATE_APP_CALLERS，默认要求核心入口逐个达标", script);
        Assert.Contains("LLMGW_GATE_REQUIRED_KINDS", script);
        Assert.Contains("required_kinds_raw=\"${LLMGW_GATE_REQUIRED_KINDS:-}\"", script);
        Assert.Contains("if [ \"$mode\" = \"http\" ] && [ -z \"$required_kinds_compact\" ]; then", script);
        Assert.Contains("full_http_kind_min=\"${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}\"", script);
        Assert.Contains("required_kinds_raw=\"send:${full_http_kind_min},stream:${full_http_kind_min},raw:${full_http_kind_min}\"", script);
        Assert.Contains("LLMGW_GATE_CANARY_KIND_MIN", script);
        Assert.Contains("required_kinds_raw=\"send:${canary_kind_min}\"", script);
        Assert.Contains("required_kinds_raw=\"stream:${canary_kind_min}\"", script);
        Assert.Contains("required_kinds_raw=\"raw:${canary_kind_min}\"", script);
        Assert.Contains("LLM Gateway release gate: canary 阶段 $canary_stage 未设置 LLMGW_GATE_REQUIRED_KINDS，默认要求 $required_kinds_raw", script);
        Assert.Contains("args=\"$args --require-kind $kind_req_trimmed\"", script);
        Assert.Contains("LLMGW_GATE_REQUIRED_APP_KINDS", script);
        Assert.Contains("LLMGW_GATE_FULL_HTTP_APP_KINDS", script);
        Assert.Contains("required_app_kinds_raw=\"${LLMGW_GATE_REQUIRED_APP_KINDS:-}\"", script);
        Assert.Contains("full_http_app_kind_min=\"${LLMGW_GATE_FULL_HTTP_APP_KIND_MIN:-${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}}\"", script);
        Assert.Contains("report-agent.generate::chat:send:", script);
        Assert.Contains("prd-agent-desktop.chat.sendmessage::chat:stream:", script);
        Assert.Contains("prd-agent-desktop.preview-ask.section::chat:stream:", script);
        Assert.Contains("open-platform-agent.proxy::chat:stream:", script);
        Assert.Contains("open-api.proxy::chat:send:", script);
        Assert.Contains("open-api.proxy::generation:raw:", script);
        Assert.Contains("prd-agent-web.model-lab.run::chat:stream:", script);
        Assert.Contains("prd-agent.arena.battle::chat:stream:", script);
        Assert.Contains("tutorial-email.generate::chat:send:", script);
        Assert.Contains("visual-agent.image-gen.generate::generation:raw:", script);
        Assert.Contains("visual-agent.image.text2img::generation:raw:", script);
        Assert.Contains("visual-agent.image.img2img::generation:raw:", script);
        Assert.Contains("visual-agent.image.vision::generation:raw:", script);
        Assert.Contains("video-agent.videogen::video-gen:raw:", script);
        Assert.Contains("visual-agent.videogen::video-gen:raw:", script);
        Assert.Contains("document-store.subtitle::asr:raw:", script);
        Assert.Contains("transcript-agent.transcribe::asr:raw:", script);
        Assert.Contains("video-agent.v2d.transcribe::asr:raw:", script);
        Assert.Contains("video-agent.video-to-text::asr:raw:", script);
        Assert.Contains("LLM Gateway release gate: LLMGW_MODE=http 未设置 LLMGW_GATE_REQUIRED_APP_KINDS，默认要求核心 send/stream/raw 入口逐个具备 app-kind 样本", script);
        Assert.Contains("LLMGW_GATE_CANARY_APP_KIND_MIN", script);
        Assert.Contains("LLMGW_GATE_CANARY_APP_KINDS", script);
        Assert.Contains("LLM Gateway release gate: canary 阶段 $canary_stage 默认要求 raw app-kind 样本逐个达标", script);
        Assert.Contains("args=\"$args --require-app-kind $app_kind_req_trimmed\"", script);
        Assert.Contains("for app in ${LLMGW_HTTP_APP_CALLER_ALLOWLIST:-}; do", script);
        Assert.Contains("LLM Gateway release gate: requiring GW config-authority report for http/full rollout", script);
        Assert.Contains("args=\"$args --require-config-authority\"", script);
        Assert.Contains("LLM Gateway release gate: required before deploy (same-commit shadow evidence only; commit probe runs after compose up)", script);
        Assert.Contains("args=\"$args --shadow-release-commit $expect_commit\"", script);
        Assert.Contains("LLMGW_GATE_JSON_OUT", script);
        Assert.Contains("args=\"$args --json-out $LLMGW_GATE_JSON_OUT\"", script);
        Assert.Contains("LLMGW_GATE_REPORT_MD", script);
        Assert.Contains("args=\"$args --report-md $LLMGW_GATE_REPORT_MD\"", script);
        Assert.Contains("python3 scripts/llmgw-release-gate.py", script);
        Assert.Contains("LLMGW_GATE_RUN_SMOKE", script);
        Assert.Contains("scripts/gw-smoke.py", script);
        Assert.Contains("LLMGW_GATE_SMOKE_TIMEOUT_SECONDS", script);
        Assert.Contains("GW_SMOKE_JSON_OUT", script);
        Assert.Contains("GW_SMOKE_REPORT_MD", script);
        Assert.Contains("GW_EXPECT_COMMIT=\"$expect_commit\"", script);
        Assert.Contains("GW_BASE=\"$gate_base\" GW_KEY=\"$gate_key\" GW_TIMEOUT=\"${LLMGW_GATE_SMOKE_TIMEOUT_SECONDS:-120}\" GW_EXPECT_COMMIT=\"$expect_commit\" python3 scripts/gw-smoke.py", script);
        Assert.Contains("LLM Gateway post-deploy runtime gates: required (/gw/runtime-gates readyForHttpFull)", script);
        Assert.Contains("runtime_gate_expect_arg=\"--expect-commit $expect_commit\"", script);
        Assert.Contains("python3 scripts/llmgw-release-gate.py $args $runtime_gate_expect_arg --require-runtime-gates", script);
        Assert.Contains("LLMGW_GATE_RUN_SERVING_PROBE", script);
        Assert.Contains("LLMGW_SERVING_PROBE_JSON_OUT", script);
        Assert.Contains("LLMGW_SERVING_PROBE_REPORT_MD", script);
        Assert.Contains("scripts/llmgw-serving-probe.py", script);
        Assert.Contains("scripts/llmgw-disk-space-guard.sh", script);
        Assert.Contains("LLMGW_DEPLOY_DISK_GUARD_PATH", script);
        Assert.Contains("LLMGW_DEPLOY_MIN_FREE_MB:-4096", script);
        Assert.Contains("LLM Gateway exec_dep deploy", script);
        Assert.Contains("provider_audit_required=0", script);
        Assert.Contains("if [ \"$mode\" = \"http\" ] || [ \"$canary_stage\" = \"video-asr\" ]; then", script);
        Assert.Contains("scripts/llmgw-prod-provider-config-audit.py", script);
        Assert.Contains("LLMGW_PROVIDER_AUDIT_JSON_OUT", script);
        Assert.Contains("LLMGW_PROVIDER_AUDIT_REPORT_MD", script);
        Assert.Contains("LLMGW_PROVIDER_AUDIT_SEED_EVIDENCE_JSON", script);
        Assert.Contains("LLM Gateway provider config audit: required before deploy", script);
        var providerAudit = ReadRepoFile("scripts/llmgw-prod-provider-config-audit.py");
        Assert.Contains("OpenRouter /videos requests", providerAudit);
        Assert.Contains("Volcengine Ark OpenAI chat base URL", providerAudit);
        Assert.Contains("dedicated Volcengine video adapter", providerAudit);
        Assert.Contains("externalBlockers", providerAudit);
        Assert.Contains("modelPoolConfig", providerAudit);
        Assert.Contains("asr_credential_rejected", providerAudit);
        Assert.Contains("asr_authorization_failed", providerAudit);
        Assert.Contains("asr_channel_unavailable", providerAudit);
        Assert.Contains("video_channel_unavailable", providerAudit);
        Assert.Contains("video_model_not_open", providerAudit);
        Assert.Contains("--self-test", providerAudit);
        Assert.Contains("_self_test_report", providerAudit);
        Assert.Contains("requiredCodes", providerAudit);
        Assert.Contains("missingCodes", providerAudit);
        Assert.Contains("requiredPairs", providerAudit);
        Assert.Contains("missingPairs", providerAudit);
        Assert.Contains("provider_audit_external_blocker_self_test", readiness);
        Assert.Contains("probe_args=\"--base $gate_base\"", script);
        Assert.Contains("python3 scripts/llmgw-serving-probe.py $probe_args", script);
        Assert.Contains("LLM Gateway post-deploy serving probe: required", script);
        Assert.Contains("LLM Gateway post-deploy D-layer smoke: required", script);
        Assert.Contains("LLMGW_GATE_SERVING_PROBE_SAMPLES", script);
        Assert.Contains("LLMGW_GATE_SERVING_PROBE_INTERVAL_SECONDS", script);
        Assert.Contains("LLMGW_SKIP_RELEASE_GATE=1", script);
        Assert.Contains("LLMGW_SKIP_RELEASE_GATE=1 is not allowed when LLM Gateway release evidence is required", script);
        Assert.Contains("Use scripts/llmgw-rollback-inproc.sh for emergency rollback", script);
        Assert.DoesNotContain("已跳过发布证据门", script);
    }

    [Fact]
    public void FastAndExecDep_KeepApiAndGatewayImagesOnSameReleaseRef()
    {
        var fast = ReadRepoFile("fast.sh");
        var execDep = ReadRepoFile("exec_dep.sh");

        Assert.Contains("PRD_AGENT_RELEASE_INTENT_FILE", fast);
        Assert.Contains(".prd-agent-release-intent.env", fast);
        Assert.Contains("write_release_intent", fast);
        Assert.Contains("RELEASE_TAG=%s", fast);
        Assert.Contains("RELEASE_REF_TYPE=%s", fast);
        Assert.Contains("REPO=%s", fast);
        Assert.Contains("PRD_AGENT_API_IMAGE=%s", fast);
        Assert.Contains("PRD_AGENT_LLMGW_IMAGE=%s", fast);
        Assert.Contains("PRD_AGENT_LLMGW_SERVE_IMAGE=%s", fast);
        Assert.Contains("PRD_AGENT_LLMGW_WEB_IMAGE=%s", fast);
        Assert.Contains("Release intent written:", fast);

        Assert.Contains("intent_value", execDep);
        Assert.Contains("check_fast_release_intent", execDep);
        Assert.Contains("PRD_AGENT_REQUIRE_FAST_INTENT=1", execDep);
        Assert.Contains("PRD_AGENT_IGNORE_FAST_INTENT=1", execDep);
        Assert.Contains("intent_tag", execDep);
        Assert.Contains("intent_repo", execDep);
        Assert.Contains("check_intent_image_match PRD_AGENT_API_IMAGE", execDep);
        Assert.Contains("check_intent_image_match PRD_AGENT_LLMGW_IMAGE", execDep);
        Assert.Contains("check_intent_image_match PRD_AGENT_LLMGW_SERVE_IMAGE", execDep);
        Assert.Contains("check_intent_image_match PRD_AGENT_LLMGW_WEB_IMAGE", execDep);
        Assert.Contains("persist_release_image_pins", execDep);
        Assert.Contains("PRD_AGENT_PERSIST_IMAGE_PINS", execDep);
        Assert.Contains("PRD_AGENT_API_IMAGE_VALUE", execDep);
        Assert.Contains("Release image pins: persisted to", execDep);
        Assert.Contains("fast.sh / exec_dep.sh image mismatch", execDep);
        Assert.Contains("fast.sh warmed:", execDep);
        Assert.Contains("exec_dep wants:", execDep);
        Assert.Contains("fast.sh repo:", execDep);
        Assert.Contains("exec_dep repo:", execDep);
        Assert.Contains("Release intent: matched fast.sh warmup", execDep);
    }

    [Fact]
    public void ShadowComparisonReadEndpoints_CanFilterByKind()
    {
        var servingEndpoints = ReadRepoFile("prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var releaseGate = ReadRepoFile("scripts/llmgw-release-gate.py");

        Assert.Contains("string? kind", servingEndpoints);
        Assert.Contains("string? releaseCommit", servingEndpoints);
        Assert.Contains("double? sinceHours", servingEndpoints);
        Assert.Contains("Builders<LlmShadowComparison>.Filter.Eq(x => x.Kind, kind.Trim())", servingEndpoints);
        Assert.Contains("Builders<LlmShadowComparison>.Filter.Eq(x => x.ReleaseCommit, normalizedReleaseCommit)", servingEndpoints);
        Assert.Contains("Builders<LlmShadowComparison>.Filter.Gte(x => x.ComparedAt, since.Value)", servingEndpoints);
        Assert.Contains("releaseCommit = normalizedReleaseCommit", servingEndpoints);
        Assert.Contains("firstComparedAt = first", servingEndpoints);
        Assert.Contains("lastComparedAt = last", servingEndpoints);
        Assert.Contains("coverageHours", servingEndpoints);
        Assert.Contains("string? kind", consoleProgram);
        Assert.Contains("string? releaseCommit", consoleProgram);
        Assert.Contains("double? sinceHours", consoleProgram);
        Assert.Contains("fb.Eq(\"Kind\", kind.Trim())", consoleProgram);
        Assert.Contains("fb.Eq(\"ReleaseCommit\", normalizedReleaseCommit)", consoleProgram);
        Assert.Contains("FirstComparedAt", ReadRepoFile("prd-llmgw/Models/Dtos.cs"));
        Assert.Contains("CoverageHours", ReadRepoFile("prd-llmgw/Models/Dtos.cs"));
        Assert.Contains("ReleaseCommit", ReadRepoFile("prd-llmgw/Models/Dtos.cs"));
        Assert.Contains("query_items[\"kind\"] = kind", releaseGate);
        Assert.Contains("query_items[\"releaseCommit\"] = normalized_release_commit", releaseGate);
        Assert.Contains("query_items[\"sinceHours\"] = f\"{since_hours:g}\"", releaseGate);
        Assert.Contains("--shadow-release-commit", releaseGate);
        Assert.Contains("\"shadowReleaseCommit\"", releaseGate);
        Assert.Contains("--since-hours", releaseGate);
        Assert.Contains("--min-coverage-hours", releaseGate);
        Assert.Contains("\"shadowSinceHours\"", releaseGate);
        Assert.Contains("\"minCoverageHours\"", releaseGate);
        Assert.Contains("\"coverageHours\"", releaseGate);
        Assert.Contains("观察时长不足", releaseGate);
        Assert.Contains("--require-kind", releaseGate);
        Assert.Contains("--require-app-kind", releaseGate);
        Assert.Contains("--require-config-authority", releaseGate);
        Assert.Contains("--require-runtime-gates", releaseGate);
        Assert.Contains("LLMGW_CONSOLE_BASE", releaseGate);
        Assert.Contains("configAuthority", releaseGate);
        Assert.Contains("runtimeGates", releaseGate);
        Assert.Contains("/runtime-gates", releaseGate);
        Assert.Contains("runtime gates releaseCommit mismatch", releaseGate);
        Assert.Contains("expectedCommit", releaseGate);
        Assert.Contains("readyForHttpFull", releaseGate);
        Assert.Contains("remainingRuntimeGates", releaseGate);
        Assert.Contains("remainingRuntimeGateDetails", releaseGate);
        Assert.Contains("missing structured facts", releaseGate);
        Assert.Contains("current_commit_http_transport", releaseGate);
        Assert.Contains("nonHttpTransportLogs", releaseGate);
        Assert.Contains("missing transport facts", releaseGate);
        Assert.Contains("runtime gate markdown should include transport facts", releaseGate);
        Assert.Contains("tempfile.TemporaryDirectory", releaseGate);
        Assert.Contains("_runtime_gates_result_from_data", releaseGate);
        Assert.Contains("--self-test", releaseGate);
        Assert.Contains("LLM Gateway release gate self-test: PASS", releaseGate);
        Assert.Contains("mapFallbackObjectsRemaining", releaseGate);
        Assert.Contains("activeAppCallerMapFallbackReady", releaseGate);
        Assert.Contains("release gate 不允许用未改密账号放行", releaseGate);
        Assert.Contains("--health-samples", releaseGate);
        Assert.Contains("--health-interval", releaseGate);
        Assert.Contains("\"stable\"", releaseGate);
        Assert.Contains("--json-out", releaseGate);
        Assert.Contains("--report-md", releaseGate);
        Assert.Contains("\"shadowChecks\"", releaseGate);
    }

    [Fact]
    public void ConfigAuthorityApplyScript_IsDryRunByDefaultAndAuditable()
    {
        var script = ReadRepoFile("scripts/llmgw-config-authority-apply.py");
        var prodStage = ReadRepoFile("scripts/llmgw-prod-stage.sh");

        Assert.Contains("LLM Gateway 配置权威退场操作脚本", script);
        Assert.Contains("/config-authority/report", script);
        Assert.Contains("/config-authority/bulk-claim", script);
        Assert.Contains("/config-authority/bind-active-app-callers", script);
        Assert.Contains("--execute", script);
        Assert.Contains("--overwrite", script);
        Assert.Contains("--skip-bulk-claim", script);
        Assert.Contains("--skip-bind-active", script);
        Assert.Contains("--require-ready", script);
        Assert.Contains("--self-test", script);
        Assert.Contains("LLM Gateway config authority apply self-test: PASS", script);
        Assert.Contains("LLMGW_CONSOLE_BASE", script);
        Assert.Contains("LLMGW_CONSOLE_TOKEN", script);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_JSON_OUT", script);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_REPORT_MD", script);
        Assert.Contains("mustChangePassword", script);
        Assert.Contains("不允许用未改密账号放行", script);
        Assert.Contains("mapFallbackObjectsRemaining", script);
        Assert.Contains("activeAppCallerMapFallbackReady", script);
        Assert.Contains("activeMissingGatewayPool", script);
        Assert.Contains("config authority status 不是 ready", script);
        Assert.Contains("MAP fallback 对象未清零", script);
        Assert.Contains("active appCaller 尚未全部绑定有效 GW 模型池", script);
        Assert.Contains("active appCaller 缺 GW 池", script);
        Assert.Contains("if args.execute:", script);
        Assert.Contains("report[\"actions\"] = []", script);
        Assert.Contains("dry-run read only", script);
        Assert.Contains("scripts/llmgw-config-authority-apply.py", prodStage);
    }

    [Fact]
    public void ConfigAuthorityBackup_BacksUpCriticalCollectionsBeforeConfigAuthorityApply()
    {
        var backup = ReadRepoFile("scripts/llmgw-config-authority-backup.sh");
        var prodStage = ReadRepoFile("scripts/llmgw-prod-stage.sh");
        var ledger = ReadRepoFile("scripts/llmgw-rollout-ledger.py");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLM Gateway config authority backup", backup);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_BACKUP_DRY_RUN", backup);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_BACKUP_DATABASES:-prdagent llm_gateway", backup);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_BACKUP_COLLECTIONS", backup);
        Assert.Contains("prdagent.model_groups", backup);
        Assert.Contains("prdagent.llmplatforms", backup);
        Assert.Contains("prdagent.llmmodels", backup);
        Assert.Contains("prdagent.model_exchanges", backup);
        Assert.Contains("llm_gateway.*", backup);
        Assert.Contains("llmgw-disk-space-guard.sh", backup);
        Assert.Contains("mongodump --db \"$db\" --archive", backup);
        Assert.Contains("mongodump --db \"$db\" --collection \"$collection\" --archive", backup);
        Assert.Contains("gzip -t", backup);
        Assert.Contains("SHA256SUMS", backup);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_BACKUP_JSON_OUT", backup);
        Assert.Contains("archiveCount", backup);
        Assert.Contains("sha256Sums", backup);
        Assert.DoesNotContain("rm -", backup);
        Assert.DoesNotContain("deleteMany", backup);
        Assert.DoesNotContain("dropDatabase", backup);
        Assert.DoesNotContain("docker volume rm", backup);
        Assert.DoesNotContain("down -v", backup);

        var backupIndex = prodStage.IndexOf("scripts/llmgw-config-authority-backup.sh", StringComparison.Ordinal);
        var applyIndex = prodStage.IndexOf("python3 scripts/llmgw-config-authority-apply.py", StringComparison.Ordinal);
        Assert.True(backupIndex >= 0 && applyIndex >= 0 && backupIndex < applyIndex, "config-authority must back up production data before applying config authority changes.");
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_BACKUP_DRY_RUN=0", prodStage);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_BACKUP_JSON_OUT=\"$config_authority_backup_json\"", prodStage);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_MD=\"$config_authority_backup_md\"", prodStage);
        Assert.Contains("--external-backup-json \"$config_authority_backup_json\"", prodStage);
        Assert.Contains("configAuthorityBackupJson", prodStage);

        Assert.Contains("_require_external_backup", ledger);
        Assert.Contains("\"externalBackupJson\": args.external_backup_json", ledger);
        Assert.Contains("external backup evidence", ledger);
        Assert.Contains("is dry-run evidence", ledger);
        Assert.Contains("archiveCount is zero", ledger);
        Assert.Contains("missing sha256Sums", ledger);

        Assert.Contains("config_authority_stage_backup_is_local_auditable_and_safe", readiness);
        Assert.Contains("config_authority_apply_has_local_readiness_self_test", readiness);
        Assert.Contains("config_authority_apply_self_test", readiness);
        Assert.Contains("scripts/llmgw-config-authority-apply.py\", \"--self-test", readiness);
        Assert.Contains("scripts/llmgw-config-authority-backup.sh", readiness);
        Assert.Contains("config_authority_stage_backup_is_local_auditable_and_safe", readiness);
    }

    [Fact]
    public void ExecDep_ProvidesNoUnderscoreCompatibilityWrapper()
    {
        var wrapper = ReadRepoFile("execdep.sh");

        Assert.Contains("exec_dep.sh", wrapper);
        Assert.Contains("exec \"$script_dir/exec_dep.sh\" \"$@\"", wrapper);
    }

    [Fact]
    public void ProdStageRunner_SequencesShadowCanaryHttpAndRollbackWithoutKeyCli()
    {
        var script = ReadRepoFile("scripts/llmgw-prod-stage.sh");
        var ledger = ReadRepoFile("scripts/llmgw-rollout-ledger.py");
        var preflight = ReadRepoFile("scripts/llmgw-prod-preflight.py");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");
        var compose = ReadRepoFile("docker-compose.yml");
        var cdsCompose = ReadRepoFile("cds-compose.yml");
        var workflow = ReadRepoFile(".github/workflows/llmgw-prod-stage.yml");

        Assert.Contains("LLM Gateway production stage runner", script);
        Assert.Contains("shadow-start", script);
        Assert.Contains("canary-intent-text", script);
        Assert.Contains("canary-chat", script);
        Assert.Contains("canary-streaming", script);
        Assert.Contains("canary-vision", script);
        Assert.Contains("canary-image", script);
        Assert.Contains("canary-video-asr", script);
        Assert.Contains("config-authority", script);
        Assert.Contains("rollback-rehearsal", script);
        Assert.Contains("http-full", script);
        Assert.Contains("rollback-inproc", script);
        Assert.Contains("execute=0", script);
        Assert.Contains("--execute", script);
        Assert.Contains("--min-observation-hours", script);
        Assert.Contains("LLMGW_STAGE_MIN_OBSERVATION_HOURS", script);
        Assert.Contains("LLMGW_STAGE_MIN_FREE_MB", script);
        Assert.Contains("LLMGW_STAGE_DISK_GUARD_PATH", script);
        Assert.Contains("run_stage_disk_guard", script);
        Assert.Contains("scripts/llmgw-disk-space-guard.sh", script);
        Assert.Contains("LLM Gateway production stage $stage", script);
        Assert.Contains("--main-ref", script);
        Assert.Contains("LLMGW_RELEASE_MAIN_REF", script);
        Assert.Contains("validate_main_ancestry", script);
        Assert.Contains("if [ \"$stage\" = \"rollback-inproc\" ]; then", script);
        Assert.Contains("if [ \"$stage\" = \"rollback-rehearsal\" ]; then", script);
        Assert.Contains("LLM Gateway rollback rehearsal: release main SHA recorded without ancestry enforcement", script);
        Assert.Contains("git merge-base --is-ancestor", script);
        Assert.Contains("release commit does not include latest main", script);
        Assert.Contains("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH", script);
        Assert.Contains("LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH", script);
        Assert.Contains("validate_release_tree", script);
        Assert.Contains("critical_paths", script);
        Assert.Contains("docker-compose.yml", script);
        Assert.Contains("cds-compose.yml", script);
        Assert.Contains("execdep.sh", script);
        Assert.Contains("deploy/nginx/conf.d/branches/_standalone.conf", script);
        Assert.Contains("scripts/llmgw-protocol-router-audit.py", script);
        Assert.Contains("scripts/llmgw-map-shadow-seed.py", script);
        Assert.Contains("scripts/llmgw-report-agent-shadow-seed.py", script);
        Assert.Contains("scripts/llmgw-config-authority-backup.sh", script);
        Assert.Contains("scripts/llmgw-config-authority-apply.py", script);
        Assert.Contains("git show \"$commit:<critical rollout/deploy files>\" | cmp local files", script);
        Assert.Contains("local rollout/deploy files must match --commit", script);
        Assert.Contains("release file differs from release commit", script);
        Assert.Contains("LLM Gateway release tree: OK", script);
        Assert.Contains("LLMGW_ALLOW_OUT_OF_ORDER_REASON", script);
        Assert.Contains("--allow-out-of-order-reason", script);
        Assert.Contains("requires --allow-out-of-order-reason", script);
        Assert.Contains("allowOutOfOrderReason", script);
        Assert.Contains("minObservationHours", script);
        Assert.Contains("LLMGW_GATE_KEY, GW_KEY, or LLMGW_SERVE_KEY", script);
        Assert.Contains("LLMGW_CONSOLE_BASE", script);
        Assert.Contains("LLMGW_CONSOLE_TOKEN", script);
        Assert.Contains("LLMGW_CONSOLE_USER", script);
        Assert.Contains("LLMGW_CONSOLE_PASSWORD", script);
        Assert.Contains("if [ \"$stage\" = \"config-authority\" ] || [ \"$stage\" = \"http-full\" ]; then", script);
        Assert.Contains("ERROR: $stage requires LLMGW_CONSOLE_BASE", script);
        Assert.Contains("ERROR: $stage requires LLMGW_CONSOLE_TOKEN or LLMGW_CONSOLE_USER/LLMGW_CONSOLE_PASSWORD", script);
        Assert.Contains("if [ \"$stage\" = \"config-authority\" ] || [ \"$stage\" = \"http-full\" ]; then", workflow);
        Assert.Contains("ERROR: $stage requires vars.LLMGW_PROD_CONSOLE_BASE or map_base to derive /gw.", workflow);
        Assert.Contains("ERROR: $stage requires secrets.LLMGW_PROD_CONSOLE_TOKEN or LLMGW_PROD_CONSOLE_USER/PASSWORD.", workflow);
        Assert.DoesNotContain("--key", script);
        Assert.DoesNotContain("--gateway-key", script);
        Assert.Contains("mode=\"shadow\"", script);
        Assert.Contains("mode=\"http\"", script);
        Assert.Contains("report-agent.generate::chat,prd-agent-desktop.chat.sendmessage::chat,open-platform-agent.proxy::chat", script);
        Assert.Contains("visual-agent.image-gen.generate::generation,visual-agent.image.text2img::generation,visual-agent.image.img2img::generation", script);
        Assert.Contains("video-agent.videogen::video-gen,visual-agent.videogen::video-gen,document-store.subtitle::asr,transcript-agent.transcribe::asr,video-agent.v2d.transcribe::asr,video-agent.video-to-text::asr", script);
        Assert.Contains("export PRD_AGENT_REQUIRE_FAST_INTENT=\"${PRD_AGENT_REQUIRE_FAST_INTENT:-1}\"", script);
        Assert.Contains("export LLMGW_PROD_STAGE_ACTIVE=1", script);
        Assert.Contains("export LLMGW_PROD_STAGE=\"$stage\"", script);
        Assert.Contains("disable_map_fallback_default=true", script);
        Assert.Contains("LLMGW_STAGE_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS", script);
        Assert.Contains("disableMapConfigFallbackForActiveAppCallers", script);
        Assert.Contains("export LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS=\"$disable_map_fallback_for_active_app_callers\"", script);
        Assert.Contains("release-gate.json", script);
        Assert.Contains("serving-probe.json", script);
        Assert.Contains("gw-smoke.json", script);
        Assert.Contains("smoke_required=1", script);
        Assert.Contains("LLMGW_GATE_RUN_SMOKE:-1", script);
        Assert.Contains("--smoke-required \"$smoke_required\"", script);
        Assert.Contains("LLMGW_GATE_SMOKE_ROUTE_MATRIX", script);
        Assert.Contains("LLMGW_GATE_SMOKE_ROUTE_POOL_ID", script);
        Assert.Contains("LLMGW_GATE_SMOKE_ROUTE_PINNED_PLATFORM_ID", script);
        Assert.Contains("LLMGW_GATE_SMOKE_ROUTE_PINNED_MODEL_ID", script);
        Assert.Contains("export GW_SMOKE_ROUTE_MATRIX=\"${GW_SMOKE_ROUTE_MATRIX:-$smoke_route_matrix}\"", script);
        Assert.Contains("--smoke-route-matrix-required \"$smoke_route_matrix\"", script);
        Assert.Contains("stage-report", script);
        Assert.Contains("export LLMGW_GATE_JSON_OUT=\"${LLMGW_GATE_JSON_OUT:-$release_gate_json}\"", script);
        Assert.Contains("export LLMGW_GATE_REPORT_MD=\"${LLMGW_GATE_REPORT_MD:-$release_gate_md}\"", script);
        Assert.Contains("export LLMGW_SERVING_PROBE_JSON_OUT=\"${LLMGW_SERVING_PROBE_JSON_OUT:-$serving_probe_json}\"", script);
        Assert.Contains("export GW_SMOKE_JSON_OUT=\"${GW_SMOKE_JSON_OUT:-$smoke_json}\"", script);
        Assert.Contains("rollout-ledger.jsonl", script);
        Assert.Contains("--allow-out-of-order", script);
        Assert.Contains("validate_ledger_order", script);
        Assert.Contains("append_ledger_entry success", script);
        Assert.Contains("record_failed_stage_on_exit", script);
        Assert.Contains("append_ledger_entry failed", script);
        Assert.Contains("LLM Gateway production stage failed; appending failed rollout ledger entry.", script);
        Assert.Contains("trap record_failed_stage_on_exit EXIT", script);
        Assert.Contains("append_ledger_entry rollback", script);
        Assert.Contains("rollout_ledger_status=\"rollback\"", script);
        Assert.Contains("python3 scripts/llmgw-config-authority-apply.py", script);
        Assert.Contains("--config-authority-json \"$config_authority_json\"", script);
        Assert.Contains("--external-backup-json \"$config_authority_backup_json\"", script);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_BACKUP_DRY_RUN=0", script);
        Assert.Contains("LLMGW_CONFIG_AUTHORITY_BACKUP_JSON_OUT=\"$config_authority_backup_json\"", script);
        Assert.Contains("configAuthorityJson", script);
        Assert.Contains("configAuthorityBackupJson", script);
        Assert.Contains("protocol-router-audit.json", script);
        Assert.Contains("protocolRouterAuditJson", script);
        Assert.Contains("protocolRouterAuditMd", script);
        Assert.Contains("run_protocol_router_audit_evidence", script);
        Assert.Contains("python3 scripts/llmgw-protocol-router-audit.py --json-out", script);
        Assert.Contains("--protocol-router-audit-json \"$protocol_router_audit_json\"", script);
        Assert.Contains("require_config_authority=args.stage == \"http-full\"", ledger);
        Assert.Contains("configAuthority is not required+ok for http-full gate", ledger);
        Assert.Contains("runtimeGates is not required+ok+ready for http-full gate", ledger);
        Assert.Contains("activeAppCallerMapFallbackReady is not true", ledger);
        Assert.Contains("_require_smoke_route_matrix", ledger);
        Assert.Contains("smokeRouteMatrixRequired", ledger);
        Assert.Contains("route matrix incomplete", ledger);
        Assert.Contains("append_parser.add_argument(\"--smoke-route-matrix-required\", default=\"0\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--smoke-route-matrix-required\", default=\"0\")", ledger);
        var failureTrap = script[
            script.IndexOf("record_failed_stage_on_exit()", StringComparison.Ordinal)..script.IndexOf("trap record_failed_stage_on_exit EXIT", StringComparison.Ordinal)];
        Assert.DoesNotContain("rollback-inproc", failureTrap);
        Assert.Contains("prod-preflight.json", script);
        Assert.Contains("video-canary.json", script);
        Assert.Contains("LLMGW_STAGE_RUN_VIDEO_CANARY", script);
        Assert.Contains("run_video_canary_evidence", script);
        Assert.Contains("scripts/llmgw-video-exchange-canary.py", script);
        Assert.Contains("LLMGW_VIDEO_CANARY_JSON_OUT", script);
        Assert.Contains("--video-canary-json \"$video_canary_json\"", script);
        Assert.Contains("--video-canary-required \"$run_video_canary\"", script);
        Assert.Contains("videoCanaryJson", script);
        Assert.Contains("videoCanaryRequired", script);
        Assert.Contains("run_prod_preflight", script);
        Assert.Contains("scripts/llmgw-prod-preflight.py --mode start", script);
        Assert.Contains("LLMGW_STAGE_MAP_BASE or PRD_AGENT_BASE", script);
        Assert.Contains("LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS=1", script);
        Assert.Contains("This does not bypass gateway release gates or completion-mode direct-transport checks.", script);
        Assert.Contains("preflight += \" --map-base ${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}\"", script);
        Assert.Contains("map_base=\"$(printf '%s' \"${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}\" | xargs || true)\"", script);
        Assert.Contains("preflight_args=\"$preflight_args --map-base $map_base\"", script);
        Assert.Contains("allow_missing_map_logs_waiver_for_stage()", script);
        Assert.Contains("canary-*)", script);
        Assert.Contains("elif [ \"${LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS:-0}\" = \"1\" ] && allow_missing_map_logs_waiver_for_stage; then", script);
        Assert.Contains("preflight_args=\"$preflight_args --allow-missing-map-logs\"", script);
        Assert.Contains("suffix=\"$suffix --allow-missing-map-logs\"", script);
        Assert.Contains("--prod-preflight-json \"$prod_preflight_json\"", script);
        Assert.Contains("scripts/llmgw-rollout-ledger.py validate", script);
        Assert.Contains("scripts/llmgw-rollout-ledger.py append", script);
        Assert.Contains("./fast.sh --commit \"$commit\"", script);
        Assert.Contains("./exec_dep.sh --commit \"$commit\"", script);
        Assert.Contains("scripts/llmgw-rollback-inproc.sh", script);
        Assert.Contains("LLMGW_ROLLBACK_DRY_RUN=1 scripts/llmgw-rollback-inproc.sh", script);

        Assert.Contains("LLM Gateway rollout ledger", ledger);
        Assert.Contains("STAGES = [", ledger);
        Assert.Contains("ROLLBACK_REHEARSAL_STAGE = \"rollback-rehearsal\"", ledger);
        Assert.Contains("_stage_requires_rehearsal", ledger);
        Assert.Contains("\"shadow-start\"", ledger);
        Assert.Contains("\"canary-video-asr\"", ledger);
        Assert.Contains("\"config-authority\"", ledger);
        Assert.Contains("CONFIG_AUTHORITY_STAGE = \"config-authority\"", ledger);
        Assert.Contains("\"http-full\"", ledger);
        Assert.True(
            ledger.IndexOf("\"config-authority\"", StringComparison.Ordinal) < ledger.IndexOf("\"canary-intent-text\"", StringComparison.Ordinal),
            "config-authority must run before canary stages so MAP config ownership can migrate before traffic grey rollout.");
        Assert.Contains("missing_success", ledger);
        Assert.Contains("requires rollback rehearsal success for the same commit", ledger);
        Assert.Contains("allow-out-of-order", ledger);
        Assert.Contains("allow-out-of-order-reason", ledger);
        Assert.Contains("\"allowOutOfOrder\": _bool_flag(args.allow_out_of_order)", ledger);
        Assert.Contains("\"allowOutOfOrderReason\": args.allow_out_of_order_reason.strip()", ledger);
        Assert.Contains("allowOutOfOrder missing reason", ledger);
        Assert.Contains("\"status\": args.status", ledger);
        Assert.Contains("\"evidenceJson\": args.evidence_json", ledger);
        Assert.Contains("\"disableMapConfigFallbackForActiveAppCallers\": _bool_flag(args.disable_map_config_fallback_for_active_app_callers)", ledger);
        Assert.Contains("append_parser.add_argument(\"--disable-map-config-fallback-for-active-app-callers\", default=\"0\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--disable-map-config-fallback-for-active-app-callers\", default=\"0\")", ledger);
        Assert.Contains("\"prodPreflightJson\": args.prod_preflight_json", ledger);
        Assert.Contains("_require_prod_preflight_for_commit", ledger);
        Assert.Contains("production preflight evidence", ledger);
        Assert.Contains("\"servingProbeJson\": args.serving_probe_json", ledger);
        Assert.Contains("\"smokeJson\": args.smoke_json", ledger);
        Assert.Contains("\"smokeRequired\": _bool_flag(args.smoke_required)", ledger);
        Assert.Contains("append_parser.add_argument(\"--smoke-required\", default=\"1\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--smoke-required\", default=\"1\")", ledger);
        Assert.Contains("\"rollbackRehearsal\": args.stage == ROLLBACK_REHEARSAL_STAGE", ledger);
        Assert.Contains("\"releaseMainRef\": args.main_ref", ledger);
        Assert.Contains("\"releaseMainSha\": args.main_sha.lower()", ledger);
        Assert.Contains("missing releaseMainSha", ledger);
        Assert.Contains("min_observation_hours", ledger);
        Assert.Contains("rollout stage observation window not satisfied", ledger);
        Assert.Contains("def _observation_stages", ledger);
        Assert.Contains("stage != CONFIG_AUTHORITY_STAGE", ledger);
        Assert.Contains("ordered_real_stages = _observation_stages", ledger);
        Assert.Contains("_latest_success_evidence_failures", ledger);
        Assert.Contains("_existing_success_evidence_failures", ledger);
        Assert.Contains("rollout stage prior evidence validation failed", ledger);
        Assert.Contains("prior stage evidence invalid before rollout", ledger);
        Assert.Contains("existing prior stage evidence invalid before out-of-order rollout", ledger);
        Assert.Contains("rollout target success is stale because a later negative event exists", ledger);
        Assert.Contains("_entries_after", ledger);
        Assert.Contains("\"minStageObservationHours\": args.min_stage_observation_hours", ledger);
        Assert.Contains("_require_pass_json", ledger);
        Assert.Contains("_require_stage_evidence_for_commit", ledger);
        Assert.Contains("_require_stage_evidence_matches_entry", ledger);
        Assert.Contains("_require_serving_probe_for_commit", ledger);
        Assert.Contains("_require_smoke_for_commit", ledger);
        Assert.Contains("_require_release_gate_for_commit", ledger);
        Assert.Contains("\"providerAuditExternalBlockers\": provider_external_blockers", ledger);
        Assert.Contains("_require_protocol_router_audit", ledger);
        Assert.Contains("_require_http_full_map_fallback_exit", ledger);
        Assert.Contains("http-full success requires --disable-map-config-fallback-for-active-app-callers=true", ledger);
        Assert.Contains("Full HTTP acceptance must fail closed for active appCallers", ledger);
        Assert.Contains("\"protocolRouterAuditJson\": args.protocol_router_audit_json", ledger);
        Assert.Contains("append_parser.add_argument(\"--protocol-router-audit-json\", default=\"\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--protocol-router-audit-json\", default=\"\")", ledger);
        Assert.Contains("protocol router audit evidence", ledger);
        Assert.Contains("targetComplete must remain false until runtime gates pass", ledger);
        Assert.Contains("_provider_external_blockers", ledger);
        Assert.Contains("contains external blockers", ledger);
        Assert.Contains("providerExternalBlockers", ledger);
        Assert.Contains("_canary_external_blockers", ledger);
        Assert.Contains("_merge_blockers", ledger);
        Assert.Contains("\"externalBlockers\": all_external_blockers", ledger);
        Assert.Contains("\"videoCanaryJson\": args.video_canary_json", ledger);
        Assert.Contains("\"videoCanaryRequired\": _bool_flag(args.video_canary_required)", ledger);
        Assert.Contains("\"videoCanaryExternalBlockers\": video_canary_external_blockers", ledger);
        Assert.Contains("_require_video_canary", ledger);
        Assert.Contains("video canary evidence", ledger);
        Assert.Contains("\"asrHttpCanaryJson\": args.asr_http_canary_json", ledger);
        Assert.Contains("\"asrHttpCanaryRequired\": _bool_flag(args.asr_http_canary_required)", ledger);
        Assert.Contains("\"asrHttpCanaryExternalBlockers\": asr_http_canary_external_blockers", ledger);
        Assert.Contains("_require_asr_http_canary", ledger);
        Assert.Contains("ASR HTTP canary evidence", ledger);
        Assert.Contains("\"configAuthorityJson\": args.config_authority_json", ledger);
        Assert.Contains("\"externalBackupJson\": args.external_backup_json", ledger);
        Assert.Contains("_require_external_backup", ledger);
        Assert.Contains("external backup evidence", ledger);
        Assert.Contains("_require_config_authority_apply", ledger);
        Assert.Contains("config authority evidence", ledger);
        Assert.Contains("final mapFallbackObjectsRemaining is not zero", ledger);
        Assert.Contains("missing expectedCommit for same-commit evidence", ledger);
        Assert.Contains("releaseMainSha mismatch", ledger);
        Assert.Contains("shadowReleaseCommit mismatch", ledger);
        Assert.Contains("health sample commit mismatch", ledger);
        Assert.Contains("D-layer smoke healthCommit mismatch", ledger);
        Assert.Contains("commit mismatch", ledger);
        Assert.Contains("missing shadowChecks for same-commit evidence", ledger);
        Assert.Contains("stage-report", ledger);
        Assert.Contains("ROLLOUT_SEQUENCE", ledger);
        Assert.Contains("audit", ledger);
        Assert.Contains("requireTargetSuccess", ledger);
        Assert.Contains("LLM Gateway rollout ledger audit", ledger);
        Assert.Contains("ensure_ascii=False", ledger);
        Assert.DoesNotContain("--key", ledger);

        Assert.Contains("LLM Gateway production preflight", preflight);
        Assert.Contains("--mode", preflight);
        Assert.Contains("start", preflight);
        Assert.Contains("completion", preflight);
        Assert.Contains("LLMGW_STAGE_MAP_BASE", preflight);
        Assert.Contains("missing PRD_AGENT_BASE, LLMGW_STAGE_MAP_BASE, or --map-base", preflight);
        Assert.Contains("map_logs_scope", preflight);
        Assert.Contains("map_direct_transport_absent", preflight);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_SINCE_HOURS", preflight);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_PAGE_SIZE", preflight);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_MAX_PAGES", preflight);
        Assert.Contains("directTransportSinceHours", preflight);
        Assert.Contains("gatewayTransport", preflight);
        Assert.Contains("\"direct\"", preflight);
        Assert.Contains("gateway_protected_requires_key", preflight);
        Assert.Contains("gateway_key_configured", preflight);
        Assert.Contains("rollout_ledger_start_ready", preflight);
        Assert.Contains("rollout_ledger_completion", preflight);
        Assert.Contains("PRD_AGENT_API_KEY", preflight);
        Assert.Contains("LLMGW_GATE_BASE", preflight);
        Assert.Contains("LLMGW_GATE_KEY", preflight);
        Assert.Contains("LLMGW_SERVE_KEY", preflight);
        Assert.Contains("scripts/llmgw-rollout-ledger.py", preflight);
        Assert.Contains("--require-target-success", preflight);
        Assert.Contains("\"expectCommit\"", preflight);
        Assert.DoesNotContain("print(key", preflight);
        Assert.DoesNotContain("LLMGW_GATE_KEY=\"", preflight);

        Assert.Contains("prod_stage_runner_sequences_shadow_canary_http_and_rollback", readiness);
        Assert.Contains("scripts/llmgw-prod-stage.sh", readiness);
        Assert.Contains("scripts/llmgw-rollout-ledger.py", readiness);
        Assert.Contains("scripts/llmgw-prod-preflight.py", readiness);
        Assert.Contains("map_direct_transport_absent", readiness);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_SINCE_HOURS", readiness);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_PAGE_SIZE", readiness);
        Assert.Contains("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_MAX_PAGES", readiness);
        Assert.Contains("directTransportSinceHours", readiness);
        Assert.Contains("gatewayTransport", readiness);
        Assert.Contains("preflightExecutable", readiness);
        Assert.Contains("ledgerExecutable", readiness);
        Assert.Contains("prod-preflight.json", readiness);
        Assert.Contains("video-canary.json", readiness);
        Assert.Contains("LLMGW_STAGE_RUN_VIDEO_CANARY", readiness);
        Assert.Contains("run_video_canary_evidence", readiness);
        Assert.Contains("scripts/llmgw-video-exchange-canary.py", readiness);
        Assert.Contains("LLMGW_VIDEO_CANARY_JSON_OUT", readiness);
        Assert.Contains("--video-canary-json \\\"$video_canary_json\\\"", readiness);
        Assert.Contains("--video-canary-required \\\"$run_video_canary\\\"", readiness);
        Assert.Contains("--asr-http-canary-json \\\"$asr_http_canary_json\\\"", readiness);
        Assert.Contains("--asr-http-canary-required \\\"$run_asr_http_canary\\\"", readiness);
        Assert.Contains("videoCanaryJson", readiness);
        Assert.Contains("videoCanaryRequired", readiness);
        Assert.Contains("asrHttpCanaryJson", readiness);
        Assert.Contains("asrHttpCanaryRequired", readiness);
        Assert.Contains("configAuthorityJson", readiness);
        Assert.Contains("run_prod_preflight", readiness);
        Assert.Contains("scripts/llmgw-prod-preflight.py --mode start", readiness);
        Assert.Contains("--prod-preflight-json \\\"$prod_preflight_json\\\"", readiness);
        Assert.Contains("serving-probe.json", readiness);
        Assert.Contains("rollout-status.json", readiness);
        Assert.Contains("rolloutStatusRequired", readiness);
        Assert.Contains("rolloutStatusJson", readiness);
        Assert.Contains("run_rollout_status_ready_gate", readiness);
        Assert.Contains("scripts/llmgw-rollout-status.py", readiness);
        Assert.Contains("scripts/llmgw-config-authority-apply.py", readiness);
        Assert.Contains("--require-ready", readiness);
        Assert.Contains("protocol-router-audit.json", readiness);
        Assert.Contains("protocolRouterAuditJson", readiness);
        Assert.Contains("protocolRouterAuditMd", readiness);
        Assert.Contains("disableMapConfigFallbackForActiveAppCallers", readiness);
        Assert.Contains("disable_map_fallback_default=true", readiness);
        Assert.Contains("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS", readiness);
        Assert.Contains("run_protocol_router_audit_evidence", readiness);
        Assert.Contains("scripts/llmgw-protocol-router-audit.py --json-out", readiness);
        Assert.Contains("--protocol-router-audit-json \\\"$protocol_router_audit_json\\\"", readiness);
        Assert.Contains("_require_protocol_router_audit", readiness);
        Assert.Contains("http_full_map_fallback_exit_gate_test", readiness);
        Assert.Contains("http-full success requires --disable-map-config-fallback-for-active-app-callers=true", readiness);
        Assert.Contains("\"protocolRouterAuditJson\": args.protocol_router_audit_json", ledger);
        Assert.Contains("append_parser.add_argument(\"--protocol-router-audit-json\", default=\"\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--protocol-router-audit-json\", default=\"\")", ledger);
        Assert.Contains("targetComplete must remain false until runtime gates pass", readiness);
        Assert.Contains("LlmGateway__DisableMapConfigFallbackForActiveAppCallers=${LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS:-false}", readiness);
        Assert.Contains("LlmGateway__DisableMapConfigFallbackForActiveAppCallers: \\\"${LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS:-false}\\\"", readiness);
        Assert.Contains("LlmGateway__DisableMapConfigFallbackForActiveAppCallers=${LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS:-false}", compose);
        Assert.Contains("LlmGateway__DisableMapConfigFallbackForActiveAppCallers: \"${LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS:-false}\"", cdsCompose);
        var releaseTreeIdx = script.IndexOf("validate_release_tree", StringComparison.Ordinal);
        var protocolAuditIdx = script.IndexOf("run_protocol_router_audit_evidence", StringComparison.Ordinal);
        var statusGateIdx = script.IndexOf("run_rollout_status_ready_gate", StringComparison.Ordinal);
        Assert.True(releaseTreeIdx >= 0 && protocolAuditIdx >= 0 && statusGateIdx >= 0 && releaseTreeIdx < protocolAuditIdx && protocolAuditIdx < statusGateIdx);
        Assert.Contains("GW_SMOKE_JSON_OUT", readiness);
        Assert.Contains("--smoke-required \\\"$smoke_required\\\"", readiness);
        Assert.Contains("--smoke-route-matrix", readiness);
        Assert.Contains("GW_SMOKE_ROUTE_MATRIX", readiness);
        Assert.Contains("GW_SMOKE_ROUTE_POOL_ID", readiness);
        Assert.Contains("GW_SMOKE_ROUTE_PINNED_PLATFORM_ID", readiness);
        Assert.Contains("GW_SMOKE_ROUTE_PINNED_MODEL_ID", readiness);
        Assert.Contains("LLMGW_GATE_RUN_SMOKE:-1", readiness);
        Assert.Contains("LLMGW_STAGE_MIN_OBSERVATION_HOURS", readiness);
        Assert.Contains("LLMGW_RELEASE_MAIN_REF", readiness);
        Assert.Contains("validate_main_ancestry", readiness);
        Assert.Contains("if [ \\\"$stage\\\" = \\\"rollback-inproc\\\" ]; then", readiness);
        Assert.Contains("if [ \\\"$stage\\\" = \\\"rollback-rehearsal\\\" ]; then", readiness);
        Assert.Contains("LLM Gateway rollback rehearsal: release main SHA recorded without ancestry enforcement", readiness);
        Assert.Contains("route_matrix", workflow);
        Assert.Contains("route_pool_id", workflow);
        Assert.Contains("route_pinned_platform_id", workflow);
        Assert.Contains("route_pinned_model_id", workflow);
        Assert.Contains("LLMGW_GATE_SMOKE_ROUTE_MATRIX", workflow);
        Assert.Contains("release commit does not include latest main", readiness);
        Assert.Contains("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH", readiness);
        Assert.Contains("validate_release_tree", readiness);
        Assert.Contains("local rollout/deploy files must match --commit", readiness);
        Assert.Contains("release file differs from release commit", readiness);
        Assert.Contains("LLMGW_ALLOW_OUT_OF_ORDER_REASON", readiness);
        Assert.Contains("--allow-out-of-order-reason", readiness);
        Assert.Contains("allowOutOfOrderReason", readiness);
        Assert.Contains("requires rollback rehearsal success for the same commit", readiness);
        Assert.Contains("rollout stage observation window not satisfied", readiness);
        Assert.Contains("--run-rollout-ledger", readiness);
        Assert.Contains("rollout_ledger_completion_state", readiness);
        Assert.Contains("scripts/llmgw-rollout-ledger.py", readiness);
        Assert.Contains("--require-rollout-complete", readiness);
        Assert.Contains("protocol_router_target_audit", readiness);
        Assert.Contains("scripts/llmgw-protocol-router-audit.py", readiness);
        Assert.Contains("LLM Gateway protocol router audit: PASS", readiness);
        Assert.Contains("\"--json-out\", json_out", readiness);
        Assert.Contains("\"targetComplete\": payload.get(\"targetComplete\")", readiness);
        Assert.Contains("\"remainingRuntimeGates\": remaining_names", readiness);
        Assert.Contains("leaksKeyArg", readiness);
    }

    [Fact]
    public void ProdStageWorkflow_RunsStageRunnerOnProductionRunnerAndUploadsEvidence()
    {
        var workflow = ReadRepoFile(".github/workflows/llmgw-prod-stage.yml");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");
        var treePrecheck = ReadRepoFile("scripts/llmgw-prod-tree-precheck.py");

        Assert.Contains("LLM Gateway Production Stage", workflow);
        Assert.Contains("workflow_dispatch:", workflow);
        Assert.Contains("stage:", workflow);
        Assert.Contains("shadow-start", workflow);
        Assert.Contains("rollback-rehearsal", workflow);
        Assert.Contains("canary-intent-text", workflow);
        Assert.Contains("canary-chat", workflow);
        Assert.Contains("canary-streaming", workflow);
        Assert.Contains("canary-vision", workflow);
        Assert.Contains("canary-image", workflow);
        Assert.Contains("canary-video-asr", workflow);
        Assert.Contains("config-authority", workflow);
        Assert.Contains("http-full", workflow);
        Assert.Contains("rollback-inproc", workflow);
        Assert.True(
            workflow.IndexOf("- config-authority", StringComparison.Ordinal) < workflow.IndexOf("- canary-intent-text", StringComparison.Ordinal),
            "workflow should present config-authority before canary stages.");
        Assert.Contains("execute:", workflow);
        Assert.Contains("default: false", workflow);
        Assert.Contains("DEFAULT_CONSOLE_BASE", workflow);
        Assert.Contains("LLMGW_PROD_CONSOLE_TOKEN", workflow);
        Assert.Contains("LLMGW_PROD_CONSOLE_USER", workflow);
        Assert.Contains("LLMGW_PROD_CONSOLE_PASSWORD", workflow);
        Assert.Contains("commit:\n        description: \"40-char release commit. Required for every non-rollback-inproc stage.\"\n        required: false", workflow);
        Assert.Contains("runner_labels_json", workflow);
        Assert.Contains("[\\\"self-hosted\\\",\\\"prd-agent-prod\\\"]", workflow);
        Assert.Contains("allow_release_tree_mismatch", workflow);
        Assert.Contains("INPUT_ALLOW_RELEASE_TREE_MISMATCH", workflow);
        Assert.Contains("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH=1", workflow);
        Assert.Contains("LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH", workflow);
        Assert.Contains("release_tree_mismatch_bypass", workflow);
        Assert.Contains("environment: production", workflow);
        Assert.Contains("PRD_AGENT_PROD_BASE", workflow);
        Assert.Contains("PRD_AGENT_PROD_API_KEY", workflow);
        Assert.Contains("LLMGW_PROD_GATE_BASE", workflow);
        Assert.Contains("LLMGW_PROD_GATE_KEY", workflow);
        Assert.Contains("PRD_AGENT_PROD_GITHUB_TOKEN", workflow);
        Assert.Contains("rollout_evidence_run_id", workflow);
        Assert.Contains("actions: read", workflow);
        Assert.Contains("logs:read access", workflow);
        Assert.Contains("fetch-depth: 0", workflow);
        Assert.Contains("actions/download-artifact@v4", workflow);
        Assert.Contains("Restore previous rollout evidence", workflow);
        Assert.Contains("llmgw-prod-stage-{0}", workflow);
        Assert.Contains("default branch", ReadRepoFile("doc/plan.llm-gateway.full-cutover.md"));
        Assert.Contains("[ \"$stage\" != \"rollback-inproc\" ] && [ \"$stage\" != \"rollback-rehearsal\" ] && [ \"$stage\" != \"config-authority\" ] && [ -z \"$map_base\" ]", workflow);
        Assert.Contains("[ \"$stage\" != \"rollback-inproc\" ] && [ \"$stage\" != \"rollback-rehearsal\" ] && [ \"$stage\" != \"config-authority\" ] && [ -z \"$(printf '%s' \"${PRD_AGENT_API_KEY:-}\" | xargs)\" ]", workflow);
        Assert.Contains("if [ \"$stage\" = \"config-authority\" ] || [ \"$stage\" = \"http-full\" ]; then", workflow);
        Assert.Contains("stage $stage requires rollout_evidence_run_id so prior rollout ledger evidence is restored", workflow);
        Assert.Contains("scripts/llmgw-prod-stage.sh", workflow);
        Assert.Contains("--stage \"$stage\"", workflow);
        Assert.Contains("--commit \"$commit\"", workflow);
        Assert.Contains("--execute", workflow);
        Assert.Contains("--dry-run", workflow);
        Assert.Contains("--repo \"$repo\"", workflow);
        Assert.Contains("--sample-percent \"$sample_percent\"", workflow);
        Assert.Contains("--min-observation-hours \"$min_observation_hours\"", workflow);
        Assert.Contains("--main-ref \"$main_ref\"", workflow);
        Assert.Contains("--evidence-dir \".llmgw-release-evidence\"", workflow);
        Assert.Contains("--allow-out-of-order-reason \"$allow_out_of_order_reason\"", workflow);
        Assert.Contains("scripts/llmgw-prod-tree-precheck.py", workflow);
        Assert.Contains("[ \"$execute\" = \"true\" ] && [ \"$stage\" != \"rollback-inproc\" ]", workflow);
        Assert.Contains("--allow-mismatch", workflow);
        Assert.Contains("emergency bypass is enabled; continuing to stage runner", workflow);
        Assert.Contains("--json-out \".llmgw-release-evidence/tree-precheck.json\"", workflow);
        Assert.Contains("--report-md \".llmgw-release-evidence/tree-precheck.md\"", workflow);
        Assert.Contains("scripts/llmgw-rollout-ledger.py audit", workflow);
        Assert.Contains("--require-target-success", workflow);
        Assert.Contains("stage-audit.json", workflow);
        Assert.Contains("stage-audit.md", workflow);
        Assert.Contains("actions/upload-artifact@v4", workflow);
        Assert.Contains(".llmgw-release-evidence/", workflow);
        Assert.DoesNotContain("echo \"$PRD_AGENT_API_KEY\"", workflow);
        Assert.DoesNotContain("echo \"$LLMGW_GATE_KEY\"", workflow);

        Assert.Contains("prod_stage_workflow_runs_on_production_runner_and_uploads_rollout_evidence", readiness);
        Assert.Contains(".github/workflows/llmgw-prod-stage.yml", readiness);
        Assert.Contains("leaksStageSecret", readiness);
        Assert.Contains("treePrecheckExecutable", readiness);
        Assert.Contains("treePrecheckDestructive", readiness);
        Assert.Contains("Restore previous rollout evidence", readiness);

        Assert.Contains("LLM Gateway production release tree precheck", treePrecheck);
        Assert.Contains("CRITICAL_PATHS", treePrecheck);
        Assert.Contains("scripts/llmgw-prod-stage.sh", treePrecheck);
        Assert.Contains("scripts/llmgw-map-shadow-seed.py", treePrecheck);
        Assert.Contains("scripts/llmgw-report-agent-shadow-seed.py", treePrecheck);
        Assert.Contains("scripts/llmgw-rollout-status.py", treePrecheck);
        Assert.Contains("scripts/llmgw-shadow-coverage-report.py", treePrecheck);
        Assert.Contains("scripts/llmgw-shadow-sample-plan.py", treePrecheck);
        Assert.Contains("allowMismatch", treePrecheck);
        Assert.Contains("allowMismatchSource", treePrecheck);
        Assert.Contains("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH", treePrecheck);
        Assert.Contains("LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH", treePrecheck);
        Assert.Contains("--allow-mismatch", treePrecheck);
        Assert.Contains("pathChecks", treePrecheck);
        Assert.Contains("missing-local", treePrecheck);
        Assert.Contains("missing-release", treePrecheck);
        Assert.Contains("differs", treePrecheck);
        Assert.DoesNotContain("git reset", treePrecheck);
        Assert.DoesNotContain("git checkout --", treePrecheck);
        Assert.DoesNotContain("docker compose up", treePrecheck);
    }

    [Fact]
    public void RolloutLedgerAudit_FailsWhenTargetSuccessWasLaterRolledBack()
    {
        var root = LocateRepoRoot();
        var tempDir = Path.Combine(Path.GetTempPath(), "llmgw-ledger-audit-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            var mainSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            var stageJson = Path.Combine(tempDir, "stage.json");
            var prodPreflightJson = Path.Combine(tempDir, "prod-preflight.json");
            var servingJson = Path.Combine(tempDir, "serving.json");
            var smokeJson = Path.Combine(tempDir, "smoke.json");
            var ledger = Path.Combine(tempDir, "ledger.jsonl");

            File.WriteAllText(stageJson, $$"""
            {"verdict":"pass","commit":"{{commit}}","releaseMainRef":"origin/main","releaseMainSha":"{{mainSha}}"}
            """);
            File.WriteAllText(prodPreflightJson, $$"""
            {"verdict":"pass","mode":"start","expectCommit":"{{commit}}","checks":[]}
            """);
            File.WriteAllText(servingJson, $$"""
            {"verdict":"pass","expectedCommit":"{{commit}}","healthSamples":[{"commit":"{{commit}}"}]}
            """);
            File.WriteAllText(smokeJson, $$"""
            {"verdict":"pass","expectedCommit":"{{commit}}","healthCommit":"{{commit}}"}
            """);

            File.WriteAllText(ledger, $$"""
            {"recordedAt":"2026-07-07T00:00:00+00:00","stage":"shadow-start","status":"success","commit":"{{commit}}","evidenceJson":"{{JsonPath(stageJson)}}","prodPreflightJson":"{{JsonPath(prodPreflightJson)}}","servingProbeJson":"{{JsonPath(servingJson)}}","smokeJson":"{{JsonPath(smokeJson)}}","releaseMainRef":"origin/main","releaseMainSha":"{{mainSha}}","allowOutOfOrder":false}
            {"recordedAt":"2026-07-07T01:00:00+00:00","stage":"rollback-inproc","status":"rollback","commit":"{{commit}}","evidenceJson":"","servingProbeJson":"","smokeJson":"","releaseMainRef":"origin/main","releaseMainSha":"{{mainSha}}","allowOutOfOrder":false}
            """);

            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-rollout-ledger.py",
                    "audit",
                    "--ledger",
                    ledger,
                    "--commit",
                    commit,
                    "--target-stage",
                    "shadow-start",
                    "--require-target-success",
                    "--min-observation-hours",
                    "0"
                }
            })!;

            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.NotEqual(0, process.ExitCode);
            Assert.Contains("rollout target success is stale because a later negative event exists", stderr + stdout);
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }

        static string JsonPath(string path) => path.Replace("\\", "\\\\");
    }

    [Fact]
    public void ReadinessAudit_RequireRolloutCompleteFailsWithoutHttpFullLedger()
    {
        var root = LocateRepoRoot();
        var tempDir = Path.Combine(Path.GetTempPath(), "llmgw-readiness-completion-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            var ledger = Path.Combine(tempDir, "rollout-ledger.jsonl");
            File.WriteAllText(ledger, string.Empty);

            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-readiness-audit.py",
                    "--expect-commit",
                    commit,
                    "--rollout-ledger",
                    ledger,
                    "--rollout-target-stage",
                    "http-full",
                    "--rollout-min-observation-hours",
                    "0",
                    "--require-rollout-complete",
                    "--print-json"
                }
            })!;

            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            var combined = stderr + stdout;
            Assert.NotEqual(0, process.ExitCode);
            Assert.Contains("rollout_ledger_completion_state", combined);
            Assert.Contains("missing success stage for commit: stage=http-full", combined);
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
    }

    [Fact]
    public void RollbackScript_ReturnsApiToInprocWithoutDatabaseRollback()
    {
        var script = ReadRepoFile("scripts/llmgw-rollback-inproc.sh");

        Assert.Contains("export LLMGW_MODE=inproc", script);
        Assert.Contains("export LLMGW_HTTP_APP_CALLER_ALLOWLIST=", script);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=0", script);
        Assert.Contains("export LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS=false", script);
        Assert.Contains("disableMapConfigFallbackForActiveAppCallers=false", script);
        Assert.Contains("up -d --no-deps --force-recreate \"$service_name\"", script);
        Assert.Contains("LLMGW_ROLLBACK_DRY_RUN", script);
        Assert.Contains("LLM Gateway rollback dry-run", script);
        Assert.Contains("database: unchanged", script);
        Assert.Contains("images: unchanged", script);
        Assert.Contains("LLMGW_ROLLBACK_API_SERVICE:-api", script);
        Assert.DoesNotContain("down -v", script);
        Assert.DoesNotContain("docker volume rm", script);
        Assert.DoesNotContain("mongodump", script);
        Assert.DoesNotContain("mongorestore", script);
        Assert.DoesNotContain("db.dropDatabase", script);
        Assert.DoesNotContain("git checkout", script);
    }

    [Fact]
    public void ReadinessAudit_ComposesStaticRollbackDotnetAndLiveReleaseGates()
    {
        var script = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLM Gateway full-cutover readiness audit", script);
        Assert.Contains("release_gate_supports_required_shadow_and_health_gates", script);
        Assert.Contains("release_gate_runtime_gates_self_test", script);
        Assert.Contains("scripts/llmgw-release-gate.py\", \"--self-test", script);
        Assert.Contains("exec_dep_gates_http_canary_and_shadow_sample_release", script);
        Assert.Contains("rollback_script_is_safe_and_executable", script);
        Assert.Contains("direct_client_ratchet_baselines_are_empty", script);
        Assert.Contains("multipart_http_path_has_refs_rehydrate_and_hash_guard", script);
        Assert.Contains("compose_exposes_gateway_mode_and_data_domain_controls", script);
        Assert.Contains("adminPasswordRequired", script);
        Assert.Contains("adminUserEnv", script);
        Assert.Contains("rollback_dry_run", script);
        Assert.Contains("DISABLE_MAP_FALLBACK=false", script);
        Assert.Contains("restore_shadow_persist_env_test", script);
        Assert.Contains("gw_smoke_d_layer", script);
        Assert.Contains("--run-dotnet", script);
        Assert.Contains("--run-smoke", script);
        Assert.Contains("scripts/gw-smoke.py", script);
        Assert.Contains("gateway_protocol_and_shadow_unit_tests", script);
        Assert.Contains("GatewayPinnedModelTests", script);
        Assert.Contains("GatewayProtocolFidelityTests", script);
        Assert.Contains("ClaudeToolTranslationTests", script);
        Assert.Contains("ShadowLlmGatewayTests", script);
        Assert.Contains("gateway_http_boundary_unit_tests", script);
        Assert.Contains("GatewayMultipartHttpTests", script);
        Assert.Contains("GatewayKeyGateContractTests", script);
        Assert.Contains("HttpLlmGatewayClientFailureTests", script);
        Assert.Contains("gateway_cross_process_matrix_tests", script);
        Assert.Contains("CrossProcessServingSelfTest", script);
        Assert.Contains("CrossProcessServingErrorLoadTests", script);
        Assert.Contains("GatewayServingEndpointContractTests", script);
        Assert.Contains("gateway_media_contract_tests", script);
        Assert.Contains("GatewayDoubaoStreamAsrTests", script);
        Assert.Contains("OpenRouterVideoClientGatewayTests", script);
        Assert.Contains("GW_TIMEOUT", script);
        Assert.Contains("GW_EXPECT_COMMIT", ReadRepoFile("scripts/gw-smoke.py"));
        Assert.Contains("--require-release-gate", script);
        Assert.Contains("scripts/llmgw-release-gate.py", script);
        Assert.Contains("GW_KEY", script);
        Assert.Contains("LLMGW_GATE_SHADOW_SINCE_HOURS", script);
        Assert.Contains("shadow_coverage_report_available", script);
        Assert.Contains("--run-shadow-coverage", script);
        Assert.Contains("scripts/llmgw-shadow-coverage-report.py", script);
        Assert.Contains("serving_probe_available", script);
        Assert.Contains("fast_writes_same_commit_release_intent", script);
        Assert.Contains("--run-serving-probe", script);
        Assert.Contains("scripts/llmgw-serving-probe.py", script);
        Assert.Contains("serving_stability_and_auth_probe", script);
        Assert.Contains("--run-cds-runtime", script);
        Assert.Contains("cds_runtime_uses_release_gateway_profiles", script);
        Assert.Contains("branch status is not running", script);
        Assert.Contains("lastDeployDispatchCommitSha mismatch", script);
        Assert.Contains("LLMGW_CDS_RELEASE_PROFILES", script);
        Assert.Contains("api-prd-agent,llmgw-prd-agent,llmgw-serve-prd-agent", script);
        Assert.Contains("--run-rollout-ledger", script);
        Assert.Contains("rollout_ledger_completion_state", script);
        Assert.Contains("LLMGW_ROLLOUT_LEDGER", script);
        Assert.Contains("LLMGW_ROLLOUT_TARGET_STAGE", script);
        Assert.Contains("LLMGW_STAGE_MIN_OBSERVATION_HOURS", script);
        Assert.Contains("--require-rollout-complete", script);
        Assert.Contains("args.run_rollout_ledger or args.require_rollout_complete", script);
        Assert.Contains("LLMGW_READINESS_JSON_OUT", script);
        Assert.Contains("LLMGW_READINESS_REPORT_MD", script);
    }

    [Fact]
    public void ServingProbe_ChecksHealthCommitStabilityAndNoKeyAuth()
    {
        var script = ReadRepoFile("scripts/llmgw-serving-probe.py");

        Assert.Contains("LLM Gateway serving probe", script);
        Assert.Contains("/healthz", script);
        Assert.Contains("--expect-commit", script);
        Assert.Contains("--samples", script);
        Assert.Contains("--interval", script);
        Assert.Contains("--protected-path", script);
        Assert.Contains("--protected-endpoint", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/send\"", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/stream\"", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/client-stream\"", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/raw\"", script);
        Assert.Contains("\"method\": \"POST\", \"path\": \"/profile-test\"", script);
        Assert.Contains("expectedCommit", script);
        Assert.Contains("healthSamples", script);
        Assert.Contains("protectedChecks", script);
        Assert.Contains("commit drift", script);
        Assert.Contains("protected endpoint {method} {path} should reject missing key with 401", script);
        Assert.Contains("LLMGW_SERVING_PROBE_JSON_OUT", script);
        Assert.Contains("LLMGW_SERVING_PROBE_REPORT_MD", script);
        Assert.DoesNotContain("GW_KEY", script);
    }

    [Fact]
    public void ShadowCoverageReport_RendersExplicitCoverageCellsWithoutLeakingKey()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-coverage-report.py");
        var endpoint = ReadRepoFile("prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs");

        Assert.Contains("LLM Gateway shadow coverage", script);
        Assert.Contains("/shadow-comparisons", script);
        Assert.Contains("--app-caller", script);
        Assert.Contains("--kind", script);
        Assert.Contains("--require-kind", script);
        Assert.Contains("--require-app-kind", script);
        Assert.Contains("_parse_kind_requirement", script);
        Assert.Contains("_parse_app_kind_requirement", script);
        Assert.Contains("_upsert_cell_spec", script);
        Assert.Contains("--min-per-cell", script);
        Assert.Contains("LLMGW_HTTP_APP_CALLER_ALLOWLIST", script);
        Assert.Contains("LLMGW_SHADOW_COVERAGE_JSON_OUT", script);
        Assert.Contains("LLMGW_SHADOW_COVERAGE_REPORT_MD", script);
        Assert.Contains("critical", script);
        Assert.Contains("httpFail", script);
        Assert.Contains("coverageHours", script);
        Assert.Contains("--min-coverage-hours", script);
        Assert.Contains("--release-commit", script);
        Assert.Contains("LLMGW_SHADOW_COVERAGE_RELEASE_COMMIT", script);
        Assert.Contains("releaseCommit", script);
        Assert.Contains("minCoverageHours", script);
        Assert.Contains("覆盖时长不足", script);
        Assert.Contains("--failure-sample-limit", script);
        Assert.Contains("LLMGW_SHADOW_COVERAGE_FAILURE_SAMPLE_LIMIT", script);
        Assert.Contains("failureSamples", script);
        Assert.Contains("Failure Samples", script);
        Assert.Contains("httpError", script);
        Assert.Contains("failureLimit", endpoint);
        Assert.Contains("failureRecent", endpoint);
        Assert.Contains("Filter.Eq(x => x.HttpOk, false)", endpoint);
        Assert.DoesNotContain("for app in app_callers:\n            for kind in kinds:", script);
        Assert.DoesNotContain("print(key", script);
        Assert.DoesNotContain("GW_KEY=\"", script);
    }

    [Fact]
    public void ShadowWatchWorkflow_RunsScheduledEvidenceGateWithoutLeakingKey()
    {
        var workflow = ReadRepoFile(".github/workflows/llmgw-shadow-watch.yml");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("cron: \"17 */6 * * *\"", workflow);
        Assert.Contains("workflow_dispatch:", workflow);
        Assert.Contains("LLMGW_PROD_GATE_BASE", workflow);
        Assert.Contains("LLMGW_PROD_GATE_KEY", workflow);
        Assert.Contains("--run-serving-probe", workflow);
        Assert.Contains("--run-shadow-coverage", workflow);
        Assert.Contains("--require-release-gate", workflow);
        Assert.Contains("--min-coverage-hours \"$MIN_COVERAGE_HOURS\"", workflow);
        Assert.Contains("WATCH_APP_CALLERS", workflow);
        Assert.Contains("WATCH_COVERAGE_KINDS", workflow);
        Assert.Contains("WATCH_REQUIRED_KINDS", workflow);
        Assert.Contains("WATCH_REQUIRED_APP_KINDS", workflow);
        Assert.Contains("visual-agent.image-gen.generate::generation", workflow);
        Assert.Contains("visual-agent.image-gen.generate::generation:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("video-agent.v2d.transcribe::asr", workflow);
        Assert.Contains("video-agent.v2d.transcribe::asr:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("video-agent.video-to-text::asr", workflow);
        Assert.Contains("video-agent.video-to-text::asr:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("actions/upload-artifact@v4", workflow);

        Assert.Contains("_redact_cmd", readiness);
        Assert.Contains("if item in {\"--key\", \"--gateway-key\"}", readiness);
        Assert.Contains("\"cmd\": _redact_cmd(cmd)", readiness);
        Assert.Contains("--min-coverage-hours", readiness);
        Assert.Contains("str(args.min_coverage_hours)", readiness);
        Assert.Contains("cmd.extend([\"--require-kind\", item])", readiness);
        Assert.Contains("cmd.extend([\"--require-app-kind\", item])", readiness);
        Assert.Contains("visual-agent.image-gen.generate::generation:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("video-agent.v2d.transcribe::asr:raw:${MIN_PER_CELL}", workflow);
        Assert.Contains("video-agent.video-to-text::asr:raw:${MIN_PER_CELL}", workflow);
    }

    [Fact]
    public void ShadowSampleWindow_RestoresSamplingAndDoesNotLeakGatewayKeyInArgv()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-sample-window.sh");

        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_DRY_RUN:-1", script);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_RESTORE_PERCENT:-1", script);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_COMPOSE_TIMEOUT_SECONDS:-180", script);
        Assert.Contains("执行模式必须设置 LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS", script);
        Assert.Contains("up -d --force-recreate \"$api_service\"", script);
        Assert.Contains("trap restore_sampling EXIT INT TERM", script);
        Assert.Contains("trap - EXIT INT TERM", script);
        Assert.Contains("set_env_value LLMGW_SHADOW_FULL_SAMPLE_PERCENT \"$restore_percent\"", script);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=\"$restore_percent\"", script);
        Assert.Contains("wait_api_ready \"$restore_percent\"", script);
        Assert.Contains("restore_failed=0", script);
        Assert.Contains("shadow sample restore failed", script);
        Assert.Contains("LLMGW_GATE_KEY=\"$gate_key\" python3", script);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=\"$sample_percent\"", script);
        Assert.Contains("redact_seed_flags", script);
        Assert.Contains("--asr-video-url", script);
        Assert.Contains("seedFlags: $(redact_seed_flags \"$seed_flags\")", script);
        Assert.DoesNotContain("--gw-key \"$gate_key\"", script);
        Assert.DoesNotContain("echo \"$gate_key\"", script);
    }

    [Fact]
    public void ShadowSampleAccumulator_RunsBatchedWindowsAndCoverageWithoutLeakingGatewayKeyInArgv()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-sample-accumulate.sh");

        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_DRY_RUN:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_PROFILE", script);
        Assert.Contains("canary-intent-text", script);
        Assert.Contains("--include-report-agent-generate", script);
        Assert.Contains("report-agent.generate::chat:send:30", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT", script);
        Assert.Contains("避免混用旧 commit shadow 样本", script);
        Assert.Contains("release_commit_trimmed=\"$(printf '%s' \"$release_commit\" | xargs || true)\"", script);
        Assert.Contains("seed_run_flags=\"$seed_flags\"", script);
        Assert.Contains("seed_run_flags=\"$seed_run_flags --release-commit $release_commit_trimmed\"", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_BATCHES:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES", script);
        Assert.Contains("max_batches=\"${LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES:-3}\"", script);
        Assert.Contains("超过本 profile 默认上限", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_PREFLIGHT_COVERAGE:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_ALLOW_AFTER_PASS:-0", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_ENFORCE_PLAN:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_ALLOW_WINDOW_EXTENSION:-0", script);
        Assert.Contains("--allow-window-extension", script);
        Assert.Contains("coverage already satisfies gate; skip seeding", script);
        Assert.Contains("preflight-shadow-coverage.json", script);
        Assert.Contains("llmgw-shadow-sample-plan.py", script);
        Assert.Contains("preflight-shadow-sample-plan.json", script);
        Assert.Contains("canRunRecommendedBatches", script);
        Assert.Contains("recommendedBatches", script);
        Assert.Contains("requested batches=$batches exceeds planner recommendation=$plan_recommended", script);
        Assert.Contains("refusing to over-sample", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_SEED_FLAGS", script);
        Assert.Contains("执行模式必须设置 LLMGW_SHADOW_ACCUMULATE_SEED_FLAGS", script);
        Assert.Contains("llmgw-shadow-sample-window.sh", script);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_DRY_RUN=0", script);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS=\"$seed_run_flags\"", script);
        Assert.Contains("batch-$batch_id-shadow-sample-window.json", script);
        Assert.Contains("llmgw-shadow-coverage-report.py", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_RUN_COVERAGE:-1", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MIN_PER_CELL:-30", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MIN_COVERAGE_HOURS:-24", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_REQUIRED_KINDS", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_REQUIRED_APP_KINDS", script);
        Assert.Contains("redact_seed_flags", script);
        Assert.Contains("seedFlags: $(redact_seed_flags \"$seed_flags\")", script);
        Assert.Contains("--require-kind $trimmed", script);
        Assert.Contains("--require-app-kind $trimmed", script);
        Assert.Contains("GW_KEY=\"$gate_key\" python3", script);
        Assert.DoesNotContain("--key \"$gate_key\"", script);
        Assert.DoesNotContain("--gw-key \"$gate_key\"", script);
        Assert.DoesNotContain("seedFlags: $seed_flags", script);
        Assert.DoesNotContain("echo \"$gate_key\"", script);
    }

    [Fact]
    public void ShadowSampleAccumulatorMonitor_FailsIfSamplingStaysHighWithoutWindow()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-accumulate-monitor.sh");

        Assert.Contains("LLM Gateway shadow accumulator monitor", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MONITOR_RUN_DIR", script);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_MONITOR_SAFE_PERCENT:-1", script);
        Assert.Contains("LlmGateway__ShadowFullSamplePercent", script);
        Assert.Contains("LLMGW_SHADOW_FULL_SAMPLE_PERCENT", script);
        Assert.Contains("window_running=0", script);
        Assert.Contains("no sample window is running", script);
        Assert.Contains("batchFailedStepCount", script);
        Assert.DoesNotContain("GW_KEY", script);
        Assert.DoesNotContain("LLMGW_SERVE_KEY", script);
        Assert.DoesNotContain("--key", script);
    }

    [Fact]
    public void ProdPreflightWorkflow_RunsStartAndCompletionPreflightWithoutLeakingKeys()
    {
        var workflow = ReadRepoFile(".github/workflows/llmgw-prod-preflight.yml");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLM Gateway Production Preflight", workflow);
        Assert.Contains("workflow_dispatch:", workflow);
        Assert.Contains("mode:", workflow);
        Assert.Contains("- start", workflow);
        Assert.Contains("- completion", workflow);
        Assert.Contains("rollout_evidence_run_id", workflow);
        Assert.Contains("actions: read", workflow);
        Assert.Contains("PRD_AGENT_PROD_BASE", workflow);
        Assert.Contains("PRD_AGENT_PROD_API_KEY", workflow);
        Assert.Contains("LLMGW_PROD_GATE_BASE", workflow);
        Assert.Contains("LLMGW_PROD_GATE_KEY", workflow);
        Assert.Contains("LLMGW_PROD_EXPECT_COMMIT", workflow);
        Assert.Contains("actions/download-artifact@v4", workflow);
        Assert.Contains("Restore rollout evidence for completion", workflow);
        Assert.Contains("llmgw-prod-stage-{0}", workflow);
        Assert.Contains(".llmgw-release-evidence/", workflow);
        Assert.Contains("default branch", ReadRepoFile("doc/plan.llm-gateway.full-cutover.md"));
        Assert.Contains("completion mode requires rollout_evidence_run_id", workflow);
        Assert.Contains("completion mode could not find .llmgw-release-evidence/rollout-ledger.jsonl after artifact restore", workflow);
        Assert.Contains("logs:read access", workflow);
        Assert.Contains("scripts/llmgw-prod-preflight.py", workflow);
        Assert.Contains("--mode \"$mode\"", workflow);
        Assert.Contains("--map-base \"$map_base\"", workflow);
        Assert.Contains("--gw-base \"$gw_base\"", workflow);
        Assert.Contains("--expect-commit \"$expect_commit\"", workflow);
        Assert.Contains("--rollout-target-stage \"$ROLLOUT_TARGET_STAGE\"", workflow);
        Assert.Contains("--rollout-min-observation-hours \"$ROLLOUT_MIN_OBSERVATION_HOURS\"", workflow);
        Assert.Contains("artifacts/llmgw-prod-preflight/prod-preflight.json", workflow);
        Assert.Contains("actions/upload-artifact@v4", workflow);
        Assert.DoesNotContain("echo \"$PRD_AGENT_API_KEY\"", workflow);
        Assert.DoesNotContain("echo \"$LLMGW_GATE_KEY\"", workflow);

        Assert.Contains("prod_preflight_workflow_uploads_redacted_start_completion_report", readiness);
        Assert.Contains("leaksPreflightSecret", readiness);
        Assert.Contains("Restore rollout evidence for completion", readiness);
        Assert.Contains("default branch", readiness);
    }

    [Fact]
    public void ProdExternalBackup_CanBypassComposeExtensionsWithMongoContainer()
    {
        var script = ReadRepoFile("scripts/llmgw-prod-external-backup.sh");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLMGW_EXTERNAL_BACKUP_MONGO_CONTAINER", script);
        Assert.Contains("mongoContainer", script);
        Assert.Contains("remote_mongo_dump()", script);
        Assert.Contains("docker exec -i '$mongo_container' mongodump", script);
        Assert.Contains("docker compose -f '$compose_file' exec -T '$mongo_service' mongodump", script);
        Assert.Contains("write_remote_container_snapshot", script);
        Assert.Contains("docker ps --format", script);
        Assert.Contains("env.snapshot.redacted", script);
        Assert.Contains("gzip -t \"$backup_dir/$db.archive.gz\"", script);
        Assert.Contains("SHA256SUMS", script);
        Assert.DoesNotContain("rm -", script);
        Assert.DoesNotContain("dropDatabase", script);
        Assert.DoesNotContain("docker volume rm", script);

        Assert.Contains("LLMGW_EXTERNAL_BACKUP_MONGO_CONTAINER", readiness);
        Assert.Contains("docker exec -i '$mongo_container'", readiness);
        Assert.Contains("mongodump --db '$db'$collection_arg --archive", readiness);
    }

    [Fact]
    public void ProdVideoCallerBootstrap_BacksUpBeforeBindingVisualVideoCaller()
    {
        var script = ReadRepoFile("scripts/llmgw-prod-video-caller-bootstrap.sh");
        var js = ReadRepoFile("scripts/llmgw-prod-video-caller-bootstrap.js");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLMGW_VIDEO_BOOTSTRAP_DRY_RUN:-1", script);
        Assert.Contains("LLM Gateway video caller bootstrap dry-run: backup skipped", script);
        Assert.Contains("llmgw-disk-space-guard.sh", script);
        Assert.Contains("mongodump --db \"$mongo_db\" --archive", script);
        Assert.Contains("mongo-$mongo_db-video-caller-bootstrap.archive.gz", script);
        Assert.Contains("LLMGW_VIDEO_BOOTSTRAP_SOURCE_CALLER", script);
        Assert.Contains("video-agent.videogen::video-gen", script);
        Assert.Contains("LLMGW_VIDEO_BOOTSTRAP_TARGET_CALLERS", script);
        Assert.Contains("visual-agent.videogen::video-gen", script);

        Assert.Contains("source video appCaller missing", js);
        Assert.Contains("source video appCaller has no video-gen ModelGroupIds", js);
        Assert.Contains("source video appCaller references missing video-gen pools", js);
        Assert.Contains("target video appCallers missing", js);
        Assert.Contains("ModelType: \"video-gen\"", js);
        Assert.Contains("ModelGroupIds: poolIds", js);
        Assert.Contains("LLM Gateway video caller bootstrap dry-run: no data changed", js);

        Assert.Contains("prod_video_caller_bootstrap_is_backed_up_and_dry_run_first", readiness);
    }

    [Fact]
    public void MapShadowSeed_CoversVisualVideoRawGate()
    {
        var script = ReadRepoFile("scripts/llmgw-map-shadow-seed.py");
        var plan = ReadRepoFile("doc/plan.llm-gateway.full-cutover.md");

        Assert.Contains("--include-desktop-chat-run", script);
        Assert.Contains("--include-open-platform", script);
        Assert.Contains("--include-open-api-chat", script);
        Assert.Contains("--include-open-api-image", script);
        Assert.Contains("--include-model-lab-run", script);
        Assert.Contains("--include-arena-run", script);
        Assert.Contains("--include-report-agent-generate", script);
        Assert.Contains("llmgw-report-agent-shadow-seed.py", script);
        Assert.Contains("\"LLMGW_SHADOW_SAMPLE_KEY\": FORCE_SHADOW_SAMPLE_KEY", script);
        Assert.Contains("/api/v1/chat-runs/", script);
        Assert.Contains("/api/lab/model/runs/stream", script);
        Assert.Contains("/api/lab/arena/runs", script);
        Assert.Contains("resolve_chat_model_from_gateway", script);
        Assert.Contains("/pools", script);
        Assert.Contains("\"modelType\": \"chat\"", script);
        Assert.Contains("HealthStatus", script);
        Assert.Contains("looks_like_non_chat_model", script);
        Assert.Contains("seedance", script);
        Assert.Contains("seedream", script);
        Assert.Contains("prd-agent-desktop.chat.sendmessage::chat", plan);
        Assert.Contains("open-platform-agent.proxy::chat", plan);
        Assert.Contains("open-api.proxy::chat", plan);
        Assert.Contains("open-api.proxy::generation", plan);
        Assert.Contains("prd-agent-web.model-lab.run::chat", plan);
        Assert.Contains("prd-agent.arena.battle::chat", plan);
        Assert.Contains("--include-report-agent-generate", plan);
        Assert.Contains("report-agent.generate::chat/send", plan);
        Assert.Contains("--include-visual-video-direct", script);
        Assert.Contains("--include-video-to-doc-asr", script);
        Assert.Contains("--include-video-to-text-asr-workflow", script);
        Assert.Contains("--asr-video-url", script);
        Assert.Contains("/api/visual-agent/video-gen/runs", script);
        Assert.Contains("/api/video-agent/v2d/runs", script);
        Assert.Contains("/api/workflow-agent/workflows", script);
        Assert.Contains("video-to-text", script);
        Assert.Contains("wait_visual_video_run", script);
        Assert.Contains("visual-agent.videogen::video-gen:raw", plan);
        Assert.Contains("video-agent.v2d.transcribe::asr:raw", plan);
        Assert.Contains("video-agent.video-to-text::asr:raw", plan);
        Assert.Contains("--include-visual-video-direct", plan);
        Assert.Contains("--include-video-to-doc-asr", plan);
        Assert.Contains("--include-video-to-text-asr-workflow", plan);
        Assert.Contains("No people, no faces, no logos, no letters, no readable text, no symbols.", script);
        Assert.Contains("Static test card with color blocks only, no text.", script);
        Assert.DoesNotContain("black text only", script);
        Assert.DoesNotContain("small black label", script);
        Assert.DoesNotContain("combined comparison card", script);
    }

    [Fact]
    public void ProdAsrCredentialRotate_UsesApiEncryptionAfterBackup()
    {
        var script = ReadRepoFile("scripts/llmgw-prod-asr-credential-rotate.sh");
        var py = ReadRepoFile("scripts/llmgw-prod-asr-credential-rotate.py");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

        Assert.Contains("LLMGW_ASR_CREDENTIAL_ROTATE_DRY_RUN:-1", script);
        Assert.Contains("LLMGW_ASR_NEW_KEY", script);
        Assert.Contains("LLM Gateway ASR credential rotate dry-run: backup skipped", script);
        Assert.Contains("llmgw-disk-space-guard.sh", script);
        Assert.Contains("mongodump --db \"$mongo_db\" --collection model_exchanges --archive", script);
        Assert.Contains("ROOT_ACCESS_USERNAME", script);
        Assert.Contains("ROOT_ACCESS_PASSWORD", script);
        Assert.Contains("llmgw-prod-asr-credential-rotate.py", script);

        Assert.Contains("never prints the new key", py);
        Assert.Contains("/api/mds/exchanges", py);
        Assert.Contains("\"targetApiKey\": new_key", py);
        Assert.Contains("DoubaoAsr", py);
        Assert.Contains("XApiKey", py);
        Assert.Contains("newKeyShape", py);
        Assert.DoesNotContain("TargetApiKeyEncrypted", py);

        Assert.Contains("asr_credential_rotate_is_backup_first_and_api_encrypted", readiness);
    }

    [Fact]
    public void GwSmoke_CoversStreamingAndClientStreamBoundaries()
    {
        var script = ReadRepoFile("scripts/gw-smoke.py");

        Assert.Contains("_sse_req", script);
        Assert.Contains("\"/stream\"", script);
        Assert.Contains("stream[chat]", script);
        Assert.Contains("\"/client-stream\"", script);
        Assert.Contains("client-stream[chat]", script);
        Assert.Contains("\"Messages\": [{\"Role\": \"user\", \"Content\": \"ping, client stream reply OK\"}]", script);
        Assert.Contains("GW_SMOKE_ROUTE_MATRIX", script);
        Assert.Contains("GW_SMOKE_ROUTE_POOL_ID", script);
        Assert.Contains("GW_SMOKE_ROUTE_PINNED_PLATFORM_ID", script);
        Assert.Contains("GW_SMOKE_ROUTE_PINNED_MODEL_ID", script);
        Assert.Contains("GW_SMOKE_SELF_TEST", script);
        Assert.Contains("gw-smoke self-test PASS route matrix", script);
        Assert.Contains("\"/resolve\"", script);
        Assert.Contains("route-auto", script);
        Assert.Contains("route-pool", script);
        Assert.Contains("route-pinned", script);
        Assert.Contains("GW_SMOKE_JSON_OUT", script);
        Assert.Contains("GW_SMOKE_REPORT_MD", script);
        Assert.Contains("\"verdict\": \"pass\" if passed == len(rows) else \"fail\"", script);
    }

    [Fact]
    public void ShadowRawEvidence_UsesExplicitFullSampleAllowlistAndRollbackClearsIt()
    {
        var apiProgram = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");
        var shadowGateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ShadowLlmGateway.cs");
        var prodStage = ReadRepoFile("scripts/llmgw-prod-stage.sh");
        var rollback = ReadRepoFile("scripts/llmgw-rollback-inproc.sh");
        var restore = ReadRepoFile("scripts/llmgw-restore-shadow-safe.sh");

        Assert.Contains("LlmGateway:ShadowFullSampleAppCallerAllowlist", apiProgram);
        Assert.Contains("fullSampleAllowlist: shadowFullSampleAllowlist", apiProgram);
        Assert.Contains("_fullSampleAllowlist.Contains(appCallerCode)", shadowGateway);
        Assert.Contains("LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST", prodStage);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=\"$shadow_full_sample_allowlist\"", prodStage);
        Assert.Contains("llmgw_shadow_sample_allowlist_value()", ReadRepoFile("exec_dep.sh"));
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=", rollback);
        Assert.Contains("export LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS=false", rollback);
        Assert.Contains("\"LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST\": \"\"", restore);
        Assert.Contains("\"LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS\": \"false\"", restore);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=", restore);
        Assert.Contains("export LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS=false", restore);
        Assert.Contains("preserve_release_image_vars", restore);
        Assert.Contains("preserve_image_var PRD_AGENT_API_IMAGE prdagent-api", restore);
        Assert.Contains("RESTORE_PRD_AGENT_API_IMAGE", restore);
        Assert.Contains("\"PRD_AGENT_API_IMAGE\": os.environ.get(\"RESTORE_PRD_AGENT_API_IMAGE\", \"\")", restore);
    }

    [Fact]
    public void ModelResolver_FailClosesRawDedicatedPoolsBeforeLegacyFallback()
    {
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");

        Assert.Contains("ShouldFailClosedWhenDedicatedPoolUnavailable", resolver);
        Assert.Contains("ModelTypes.VideoGen", resolver);
        Assert.Contains("ModelTypes.Asr", resolver);
        Assert.Contains("跳过 expectedModel 的 LLMModels 直连兜底", resolver);
        Assert.Contains("拒绝降级 legacy 直连", resolver);
    }

    [Fact]
    public void ModelResolver_UsesActiveGatewayRegistryPoolBeforeMapPools()
    {
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");

        Assert.Contains("LlmGatewayDataContext? _gatewayDb", resolver);
        Assert.Contains("TryGetActiveGatewayRegistryGroupsAsync", resolver);
        Assert.Contains("x.Status == \"active\"", resolver);
        Assert.Contains("GatewayRegistryPool", resolver);
        Assert.Contains("使用 GW appCaller active 模型池", resolver);
        Assert.Contains("MapToAvailablePoolAsync(group, \"GatewayRegistryPool\", true, false, ct)", resolver);
    }

    [Fact]
    public void ModelResolver_CanDisableMapFallbackForActiveGatewayAppCallers()
    {
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var consoleDto = ReadRepoFile("prd-llmgw/Models/Dtos.cs");
        var overview = ReadRepoFile("prd-llmgw-web/src/pages/OverviewPage.tsx");
        var types = ReadRepoFile("prd-llmgw-web/src/lib/types.ts");

        Assert.Contains("DisableMapConfigFallbackForActiveAppCallers", resolver);
        Assert.Contains("LlmGateway:DisableMapConfigFallbackForActiveAppCallers", resolver);
        Assert.Contains("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS", resolver);
        Assert.Contains("GW active appCaller 禁止 MAP fallback", resolver);
        Assert.Contains("allowMapFallback: !activeGatewayAppCallerRequiresGwConfig", resolver);
        Assert.Contains("跳过 expectedModel 的 MAP 全量池搜索", resolver);
        Assert.Contains("跳过 expectedModel 的 LLMModels 直连兜底", resolver);
        Assert.Contains("拒绝降级 MAP legacy", resolver);
        Assert.Contains("GatewayRegistryLookup.Blocked", resolver);
        Assert.Contains("gateway-registry-unavailable", resolver);
        Assert.Contains("gateway-registry-read-failed", resolver);
        Assert.Contains("active-appcaller-model-pool-not-found-in-gateway", resolver);

        Assert.Contains("MapFallbackObjectsRemaining", consoleProgram);
        Assert.Contains("ActiveAppCallerMapFallbackReady", consoleProgram);
        Assert.Contains("LlmGateway:DisableMapConfigFallbackForActiveAppCallers=true", consoleProgram);
        Assert.Contains("public int MapFallbackObjectsRemaining { get; set; }", consoleDto);
        Assert.Contains("public bool ActiveAppCallerMapFallbackReady { get; set; }", consoleDto);
        Assert.Contains("activeAppCallerMapFallbackReady: boolean", types);
        Assert.Contains("active fallback 可关闭", overview);
    }

    [Fact]
    public void GatewayConsole_AppCallerPolicyEnums_MatchProtocolRouterPlan()
    {
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var appCallersPage = ReadRepoFile("prd-llmgw-web/src/pages/AppCallersPage.tsx");
        var plan = ReadRepoFile("doc/plan.platform.llm-gateway-protocol-router.md");

        Assert.Contains("default-drop", plan);
        Assert.Contains("strict-require", plan);
        Assert.Contains("parameterPolicy 仅支持 default-drop/strict-require", consoleProgram);
        Assert.Contains("\"drop-unsupported\" => \"default-drop\"", consoleProgram);
        Assert.Contains("\"strict\" => \"strict-require\"", consoleProgram);
        Assert.Contains("const PARAMETER_POLICIES = ['default-drop', 'strict-require'];", appCallersPage);
        Assert.Contains("status 仅支持 discovered/configured/active/disabled/archived", consoleProgram);
        Assert.Contains("const STATUSES = ['discovered', 'configured', 'active', 'disabled', 'archived'];", appCallersPage);
    }

    [Fact]
    public void GatewayParameterPolicy_IsVisibleInRequestLogsAndConsoleDetail()
    {
        var logModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs");
        var logContract = ReadRepoFile("prd-api/src/PrdAgent.Core/Interfaces/ILlmRequestLogWriter.cs");
        var resolverContract = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/IModelResolver.cs");
        var gatewayResponse = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayResponse.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var writer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs");
        var consoleDto = ReadRepoFile("prd-llmgw/Models/Dtos.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var drawer = ReadRepoFile("prd-llmgw-web/src/components/GenerationDetailsDrawer.tsx");

        Assert.Contains("public string? ParameterPolicy { get; set; }", logModel);
        Assert.Contains("public List<string>? DroppedParameters { get; set; }", logModel);
        Assert.Contains("public List<LlmProviderAttempt>? ProviderAttempts { get; set; }", logModel);
        Assert.Contains("public class LlmProviderAttempt", logModel);
        Assert.Contains("public int? StatusCode { get; set; }", logModel);
        Assert.Contains("public long? DurationMs { get; set; }", logModel);
        Assert.Contains("public List<ModelResolutionResult>? RetryCandidates { get; set; }", resolverContract);
        Assert.Contains("public List<ModelResolutionResult>? RetryCandidates { get; init; }", gatewayResponse);
        Assert.Contains("[JsonIgnore]", gatewayResponse);
        Assert.Contains("RetryCandidates = RetryCandidates", resolverContract);
        Assert.Contains("string? ParameterPolicy = null", logContract);
        Assert.Contains("List<string>? DroppedParameters = null", logContract);
        Assert.Contains("List<LlmProviderAttempt>? ProviderAttempts = null", logContract);
        Assert.Contains("string? Provider = null", logContract);
        Assert.Contains("ParameterPolicy: request.Context?.ParameterPolicy", gateway);
        Assert.Contains("DroppedParameters: request.Context?.DroppedParameters", gateway);
        Assert.Contains("BuildProviderAttempts(resolution", gateway);
        Assert.Contains("CompleteProviderAttempts", gateway);
        Assert.Contains("AddProviderAttempt(", gateway);
        Assert.Contains("GetProviderRetryResolutions", gateway);
        Assert.Contains("GatewayRawRequest request)", gateway);
        Assert.Contains("TryBuildRawHttpRequest", gateway);
        Assert.Contains("previous candidate failed with HTTP", gateway);
        Assert.Contains("ShouldRetryProviderStatus", gateway);
        Assert.Contains("LLMGW_PROVIDER_RETRY_MAX_ATTEMPTS", gateway);
        Assert.Contains("poll-timeout", gateway);
        Assert.Contains("ParameterPolicy = string.IsNullOrWhiteSpace(start.ParameterPolicy) ? null : start.ParameterPolicy", writer);
        Assert.Contains("DroppedParameters = start.DroppedParameters?", writer);
        Assert.Contains("ProviderAttempts = start.ProviderAttempts", writer);
        Assert.Contains("public string? ParameterPolicy { get; set; }", consoleDto);
        Assert.Contains("public List<string> DroppedParameters { get; set; } = new();", consoleDto);
        Assert.Contains("public List<ProviderAttemptDto> ProviderAttempts { get; set; } = new();", consoleDto);
        Assert.Contains("ParameterPolicy = d.AsNullableString(\"ParameterPolicy\")", consoleProgram);
        Assert.Contains("DroppedParameters = d.AsStringList(\"DroppedParameters\")", consoleProgram);
        Assert.Contains("ProviderAttempts = MapProviderAttempts(d)", consoleProgram);
        Assert.Contains("StatusCode = doc.AsNullableInt(\"StatusCode\")", consoleProgram);
        Assert.Contains("DurationMs = doc.AsNullableLong(\"DurationMs\")", consoleProgram);
        Assert.Contains("Parameter policy", drawer);
        Assert.Contains("Dropped parameters", drawer);
        Assert.Contains("Provider attempts", drawer);
        Assert.Contains("HTTP pending", drawer);
    }

    [Fact]
    public void GatewayLogDetail_ExposesRouterTraceForRouteExplanation()
    {
        var consoleDto = ReadRepoFile("prd-llmgw/Models/Dtos.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var types = ReadRepoFile("prd-llmgw-web/src/lib/types.ts");
        var drawer = ReadRepoFile("prd-llmgw-web/src/components/GenerationDetailsDrawer.tsx");
        var plan = ReadRepoFile("doc/plan.platform.llm-gateway-protocol-router.md");

        Assert.Contains("public RouterTraceDto RouterTrace { get; set; } = new();", consoleDto);
        Assert.Contains("public sealed class RouterTraceDto", consoleDto);
        Assert.Contains("public sealed class RouterTraceStepDto", consoleDto);
        Assert.Contains("public string? ModelResolutionType { get; set; }", consoleDto);
        Assert.Contains("public string? ModelGroupName { get; set; }", consoleDto);

        Assert.Contains("RouterTrace = BuildRouterTrace(d)", consoleProgram);
        Assert.Contains("static RouterTraceDto BuildRouterTrace(BsonDocument d)", consoleProgram);
        Assert.Contains("NormalizeResolutionMode", consoleProgram);
        Assert.Contains("ModelResolutionType", consoleProgram);
        Assert.Contains("ModelGroupName", consoleProgram);
        Assert.Contains("d.AsStringList(\"DroppedParameters\")", consoleProgram);

        Assert.Contains("export type RouterTrace", types);
        Assert.Contains("routerTrace: RouterTrace", types);
        Assert.Contains("function RouterTracePanel", drawer);
        Assert.Contains("Router trace", drawer);
        Assert.Contains("Requested", drawer);
        Assert.Contains("Actual", drawer);
        Assert.Contains("Pool", drawer);
        Assert.Contains("Platform", drawer);
        Assert.Contains("router trace、actual model、pool、provider attempts", plan);
    }

    [Fact]
    public void GatewayModelPools_CanBeClaimedAndResolvedBeforeMapPools()
    {
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var modelGroup = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ModelGroup.cs");
        var modelResolverContract = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/IModelResolver.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var consoleDto = ReadRepoFile("prd-llmgw/Models/Dtos.cs");
        var api = ReadRepoFile("prd-llmgw-web/src/lib/api.ts");
        var types = ReadRepoFile("prd-llmgw-web/src/lib/types.ts");
        var poolsPage = ReadRepoFile("prd-llmgw-web/src/pages/ModelPoolsPage.tsx");
        var overview = ReadRepoFile("prd-llmgw-web/src/pages/OverviewPage.tsx");

        Assert.Contains("GetCollection<ModelGroup>(\"llmgw_model_pools\")", resolver);
        Assert.Contains("FindGatewayOwnedOrMapModelPoolAsync", resolver);
        Assert.Contains("GW-owned model pool 命中", resolver);
        Assert.Contains("public List<LLMModelCapability>? Capabilities { get; set; }", modelGroup);
        Assert.Contains("SupportsFunctionCalling = FunctionCallingCapability(model)", modelResolverContract);
        Assert.Contains("SupportsVision = VisionCapability(model)", modelResolverContract);
        Assert.Contains("SupportsImageGeneration = ImageGenerationCapability(model)", modelResolverContract);
        Assert.Contains("SupportsThinking = ThinkingCapability(model)", modelResolverContract);
        Assert.Contains("SupportsStructuredOutput = StructuredOutputCapability(model)", modelResolverContract);
        Assert.Contains("SupportsLogprobs = LogprobsCapability(model)", modelResolverContract);
        Assert.Contains("SupportsParallelToolCalls = ParallelToolCallsCapability(model)", modelResolverContract);
        Assert.Contains("ParameterCapabilities = ExtractParameterCapabilities(model.Capabilities)", modelResolverContract);
        Assert.Contains("FunctionCallingCapability(ModelGroupItem model)", modelResolverContract);
        Assert.Contains("VisionCapability(ModelGroupItem model)", modelResolverContract);
        Assert.Contains("ImageGenerationCapability(ModelGroupItem model)", modelResolverContract);
        Assert.Contains("ThinkingCapability(ModelGroupItem model)", modelResolverContract);
        Assert.Contains("StructuredOutputCapability(ModelGroupItem model)", modelResolverContract);
        Assert.Contains("LogprobsCapability(ModelGroupItem model)", modelResolverContract);
        Assert.Contains("ParallelToolCallsCapability(ModelGroupItem model)", modelResolverContract);
        Assert.Contains("ParameterCapabilityName", modelResolverContract);
        Assert.Contains("var gwModelPools = gatewayDatabase.GetCollection<BsonDocument>(\"llmgw_model_pools\");", consoleProgram);
        Assert.Contains("app.MapGet(\"/gw/config-authority/report\"", consoleProgram);
        Assert.Contains("app.MapGet(\"/gw/runtime-gates\"", consoleProgram);
        Assert.Contains("ReadyForHttpFull", consoleProgram);
        Assert.Contains("full_http_rollout_ledger", consoleProgram);
        Assert.Contains("config_authority_rollout_ledger", consoleProgram);
        Assert.Contains("appcaller_policy_drift", consoleProgram);
        Assert.Contains("IsGovernedAppCaller", consoleProgram);
        Assert.Contains("HasObservedFieldDrift", consoleProgram);
        Assert.Contains("/gw/app-callers?drift=any", consoleProgram);
        Assert.Contains("appcaller_runtime_coverage", consoleProgram);
        Assert.Contains("activeAppCallerCodes", consoleProgram);
        Assert.Contains("releaseLogAppCallers", consoleProgram);
        Assert.Contains("releaseShadowAppCallers", consoleProgram);
        Assert.Contains("coveredAppCallerCodes", consoleProgram);
        Assert.Contains("missingRuntimeCoverageAppCallers", consoleProgram);
        Assert.Contains("logs.Distinct<string>(\"AppCallerCode\", logReleaseFilter)", consoleProgram);
        Assert.Contains("shadows.Distinct<string>(\"AppCallerCode\", shadowFilter)", consoleProgram);
        Assert.Contains("gateway_pool_member_readiness", consoleProgram);
        Assert.Contains("HasUsablePoolMember", consoleProgram);
        Assert.Contains("IsResolvablePoolMember", consoleProgram);
        Assert.Contains("ExchangeSupportsModel", consoleProgram);
        Assert.Contains("HealthStatus\") ?? 0) == 2", consoleProgram);
        Assert.Contains("/gw/pools activeBoundPools=", consoleProgram);
        Assert.Contains("active_appcaller_map_fallback_exit", consoleProgram);
        Assert.Contains("disableMapFallbackForActiveAppCallers", consoleProgram);
        Assert.Contains("activeAppCallerMapFallbackExitReady", consoleProgram);
        Assert.Contains("IsTruthy(config[\"LlmGateway:DisableMapConfigFallbackForActiveAppCallers\"])", consoleProgram);
        Assert.Contains("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS", consoleProgram);
        Assert.Contains("[\"disableMapConfigFallbackForActiveAppCallers\"]", consoleProgram);
        Assert.Contains("legacy_cleanup_after_stability", consoleProgram);
        Assert.Contains("ReadLatestHttpFullRolloutLedgerEvidence", consoleProgram);
        Assert.Contains("ReadLatestConfigAuthorityRolloutLedgerEvidence", consoleProgram);
        Assert.Contains("configAuthorityLedgerEvidence.Facts", consoleProgram);
        Assert.Contains("ledgerEvidence.Facts", consoleProgram);
        Assert.Contains("[\"rolloutLedger\"]", consoleProgram);
        Assert.Contains("[\"latestCommit\"]", consoleProgram);
        Assert.Contains("[\"sameCommit\"]", consoleProgram);
        Assert.Contains("[\"recordedAt\"]", consoleProgram);
        Assert.Contains("[\"configAuthorityJson\"]", consoleProgram);
        Assert.Contains("[\"externalBackupJson\"]", consoleProgram);
        Assert.Contains("[\"releaseGateJson\"]", consoleProgram);
        Assert.Contains("[\"disableMapConfigFallbackForActiveAppCallers\"]", consoleProgram);
        Assert.Contains("[\"missing\"]", consoleProgram);
        Assert.Contains("LlmGateway:RolloutLedgerPath", consoleProgram);
        Assert.Contains("LLMGW_ROLLOUT_LEDGER", consoleProgram);
        Assert.Contains("same-commit", consoleProgram);
        Assert.Contains("var runtimeCommit = NormalizeCommitFilter(gitCommit)", consoleProgram);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"ReleaseCommit\", runtimeCommit)", consoleProgram);
        Assert.Contains("dropped_parameter_runtime_evidence", consoleProgram);
        Assert.Contains("releaseLogTotal", consoleProgram);
        Assert.Contains("current_commit_http_transport", consoleProgram);
        Assert.Contains("httpTransportLogs", consoleProgram);
        Assert.Contains("nonHttpTransportLogs", consoleProgram);
        Assert.Contains("Builders<BsonDocument>.Filter.Ne(\"GatewayTransport\", \"http\")", consoleProgram);
        Assert.Contains("真实 send/stream/raw appCaller 样本", consoleProgram);
        Assert.Contains("resolve-only route matrix 不计入该 gate", consoleProgram);
        Assert.Contains("route matrix 只证明路由策略，不产生 LLM 请求日志", consoleProgram);
        Assert.Contains("resolve-only route matrix 不计入该覆盖 gate", consoleProgram);
        Assert.Contains("droppedParameterLogs", consoleProgram);
        Assert.Contains("Builders<BsonDocument>.Filter.Exists(\"DroppedParameters.0\", true)", consoleProgram);
        Assert.Contains("/gw/logs?releaseCommit=", consoleProgram);
        Assert.Contains("ReleaseCommit = d.AsNullableString(\"ReleaseCommit\")", consoleProgram);
        Assert.Contains("string? releaseCommit", consoleProgram);
        Assert.Contains("if (normalizedReleaseCommit is not null) filters.Add(fb.Eq(\"ReleaseCommit\", normalizedReleaseCommit));", consoleProgram);
        Assert.Contains("/gw/shadow-comparisons releaseCommit=", consoleProgram);
        Assert.Contains("当前 commit 的 shadow 样本", consoleProgram);
        Assert.Contains("gateway_key_integrity", consoleProgram);
        Assert.Contains("GwApiKeyCrypto.HasDedicatedPrimarySecret(config)", consoleProgram);
        Assert.Contains("/gw/key-health total=", consoleProgram);
        Assert.Contains("enabled platform/exchange missing", consoleProgram);
        Assert.Contains("disableMapConfigFallbackForActiveAppCallers", consoleProgram);
        Assert.Contains("configAuthorityJson", consoleProgram);
        Assert.Contains("externalBackupJson", consoleProgram);
        Assert.Contains("app.MapPost(\"/gw/config-authority/bulk-claim\"", consoleProgram);
        Assert.Contains("app.MapPost(\"/gw/config-authority/bind-active-app-callers\"", consoleProgram);
        Assert.Contains("ActiveMissingGatewayPool", consoleProgram);
        Assert.Contains("map-only", consoleProgram);
        Assert.Contains("action: \"config_authority.bulk_claim_to_gateway\"", consoleProgram);
        Assert.Contains("action: \"config_authority.bind_active_app_callers\"", consoleProgram);
        Assert.Contains("missing-default-gw-pool", consoleProgram);
        Assert.Contains("app.MapPost(\"/gw/pools\"", consoleProgram);
        Assert.Contains("app.MapPut(\"/gw/pools/{id}\"", consoleProgram);
        Assert.Contains("app.MapPost(\"/gw/pools/bulk-claim\"", consoleProgram);
        Assert.Contains("app.MapPut(\"/gw/pools/{id}/claim\"", consoleProgram);
        Assert.Contains("app.MapPut(\"/gw/pools/{id}/models\"", consoleProgram);
        Assert.Contains("app.MapDelete(\"/gw/pools/{id}/models\"", consoleProgram);
        Assert.Contains("app.MapPost(\"/gw/pools/{id}/models/bulk-import\"", consoleProgram);
        Assert.Contains("action: \"pool.create_gateway\"", consoleProgram);
        Assert.Contains("action: \"pool.update_gateway\"", consoleProgram);
        Assert.Contains("action: \"pool.bulk_claim_to_gateway\"", consoleProgram);
        Assert.Contains("action: \"pool.claim_to_gateway\"", consoleProgram);
        Assert.Contains("action: wasExisting ? \"pool.model.update\" : \"pool.model.add\"", consoleProgram);
        Assert.Contains("action: \"pool.model.remove\"", consoleProgram);
        Assert.Contains("action: \"pool.models.bulk_import\"", consoleProgram);
        Assert.Contains("member[\"Capabilities\"]", consoleProgram);
        Assert.Contains("body.Capabilities", consoleProgram);
        Assert.Contains("BuildPoolMemberFromModel", consoleProgram);
        Assert.Contains("DoesModelMatchBulkImportFilter", consoleProgram);
        Assert.Contains("capability.type 不能为空", consoleProgram);
        Assert.Contains("IsVision = md.AsNullableBool(\"IsVision\")", consoleProgram);
        Assert.Contains("请先将模型池认领到 GW，再在 GW 中管理池成员", consoleProgram);
        Assert.Contains("请先将模型池认领到 GW，再在 GW 中批量导入成员", consoleProgram);
        Assert.Contains("请先将模型池认领到 GW，再编辑模型池属性", consoleProgram);
        Assert.Contains("Authority = d.AsNullableString(\"Authority\") ?? \"map\"", consoleProgram);
        Assert.Contains("public sealed class CreatePoolRequest", consoleDto);
        Assert.Contains("public sealed class UpdatePoolRequest", consoleDto);
        Assert.Contains("public sealed class BulkClaimPoolsRequest", consoleDto);
        Assert.Contains("public sealed class BulkImportPoolModelsRequest", consoleDto);
        Assert.Contains("public sealed class BulkImportPoolModelsResult", consoleDto);
        Assert.Contains("public sealed class UpsertPoolModelRequest", consoleDto);
        Assert.Contains("public List<ModelCapabilityItem> Capabilities { get; set; } = new();", consoleDto);
        Assert.Contains("public List<ModelCapabilityItem>? Capabilities { get; set; }", consoleDto);
        Assert.Contains("public sealed class ConfigAuthorityReportData", consoleDto);
        Assert.Contains("public sealed class RuntimeGatesData", consoleDto);
        Assert.Contains("public sealed class RuntimeGateItem", consoleDto);
        Assert.Contains("public string? ReleaseCommit { get; set; }", consoleDto);
        Assert.Contains("ReleaseCommit = runtimeCommit", consoleProgram);
        Assert.Contains("public Dictionary<string, string> Facts { get; set; } = new();", consoleDto);
        Assert.Contains("Facts = facts ?? new Dictionary<string, string>()", consoleProgram);
        Assert.Contains("[\"missingAppCallerCodes\"] = string.Join(\",\", missingRuntimeCoverageAppCallers)", consoleProgram);
        Assert.Contains("public string? ReleaseCommit { get; set; }", consoleDto);
        Assert.Contains("public sealed class BulkClaimConfigAuthorityRequest", consoleDto);
        Assert.Contains("public sealed class BulkClaimConfigAuthorityResult", consoleDto);
        Assert.Contains("public sealed class BindActiveAppCallerPoolsResult", consoleDto);
        Assert.Contains("getConfigAuthorityReport", api);
        Assert.Contains("getRuntimeGates", api);
        Assert.Contains("bulkClaimConfigAuthority", api);
        Assert.Contains("bindActiveAppCallerPools", api);
        Assert.Contains("export type ConfigAuthoritySummary", types);
        Assert.Contains("export type RuntimeGatesData", types);
        Assert.Contains("export type RuntimeGateItem", types);
        Assert.Contains("releaseCommit?: string | null", types);
        Assert.Contains("commit={gates.releaseCommit}", overview);
        Assert.Contains("facts?: Record<string, string>", types);
        Assert.Contains("runtimeGateFactsForDisplay(item)", overview);
        Assert.Contains("function runtimeGateFactsForDisplay", overview);
        Assert.Contains("config_authority_rollout_ledger", overview);
        Assert.Contains("full_http_rollout_ledger", overview);
        Assert.Contains("active_appcaller_map_fallback_exit", overview);
        Assert.Contains("current_commit_http_transport", overview);
        Assert.Contains("'disableMapConfigFallbackForActiveAppCallers'", overview);
        Assert.Contains("'nonHttpTransportLogs'", overview);
        Assert.Contains("'sameCommit'", overview);
        Assert.Contains("'missing'", overview);
        Assert.Contains("releaseCommit?: string", types);
        Assert.Contains("export type BulkClaimConfigAuthorityResult", types);
        Assert.Contains("export type BindActiveAppCallerPoolsResult", types);
        Assert.Contains("export type UpdatePoolRequest", types);
        Assert.Contains("export type BulkImportPoolModelsRequest", types);
        Assert.Contains("export type BulkImportPoolModelsResult", types);
        Assert.Contains("capabilities: ModelCapability[]", types);
        Assert.Contains("createPool", api);
        Assert.Contains("updatePool", api);
        Assert.Contains("bulkClaimPools", api);
        Assert.Contains("bulkImportPoolModels", api);
        Assert.Contains("upsertPoolModel", api);
        Assert.Contains("removePoolModel", api);
        Assert.Contains("claimPoolToGateway", poolsPage);
        Assert.Contains("新建 GW 池", poolsPage);
        Assert.Contains("编辑属性", poolsPage);
        Assert.Contains("保存属性", poolsPage);
        Assert.Contains("匹配当前池", poolsPage);
        Assert.Contains("matchesModelFilter", poolsPage);
        Assert.Contains("CapabilityTags", poolsPage);
        Assert.Contains("structured_output", poolsPage);
        Assert.Contains("Structured output", poolsPage);
        Assert.Contains("structured-output", poolsPage);
        Assert.Contains("value=\"logprobs\"", poolsPage);
        Assert.Contains("Logprobs", poolsPage);
        Assert.Contains("value=\"parallel_tool_calls\"", poolsPage);
        Assert.Contains("Parallel tools", poolsPage);
        Assert.Contains("parallel-tools", poolsPage);
        Assert.Contains("value=\"parameter_capabilities\"", poolsPage);
        Assert.Contains("Parameters", poolsPage);
        Assert.Contains("parameterCapabilities", poolsPage);
        Assert.Contains("mergeParameterCapabilities", poolsPage);
        Assert.Contains("type: `parameter:${name}`", poolsPage);
        Assert.Contains("批量认领 MAP 池", poolsPage);
        Assert.Contains("批量导入成员", poolsPage);
        Assert.Contains("只写 GW 权威池，默认跳过已有成员", poolsPage);
        Assert.Contains("upsertPoolModel", poolsPage);
        Assert.Contains("removePoolModel", poolsPage);
        Assert.Contains("添加/更新", poolsPage);
        Assert.Contains("GW 权威", poolsPage);
        Assert.Contains("getConfigAuthorityReport()", overview);
        Assert.Contains("getRuntimeGates()", overview);
        Assert.Contains("RuntimeGatePanel", overview);
        Assert.Contains("发布 Gate", overview);
        Assert.Contains("还不能宣称 full-http 完成", overview);
        Assert.Contains("权威迁移", overview);
        Assert.Contains("认领 MAP-only 配置", overview);
        Assert.Contains("绑定 active 调用方", overview);
    }

    [Fact]
    public void GatewayPlatformsModelsAndExchanges_CanBeClaimedAndResolvedBeforeMapConfig()
    {
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var consoleDto = ReadRepoFile("prd-llmgw/Models/Dtos.cs");
        var consoleCsproj = ReadRepoFile("prd-llmgw/prd-llmgw.csproj");
        var consoleCrypto = ReadRepoFile("prd-llmgw/Security/GwApiKeyCrypto.cs");
        var api = ReadRepoFile("prd-llmgw-web/src/lib/api.ts");
        var types = ReadRepoFile("prd-llmgw-web/src/lib/types.ts");
        var platformsPage = ReadRepoFile("prd-llmgw-web/src/pages/PlatformsPage.tsx");
        var app = ReadRepoFile("prd-llmgw-web/src/App.tsx");
        var layout = ReadRepoFile("prd-llmgw-web/src/components/ConsoleLayout.tsx");
        var modelsPage = ReadRepoFile("prd-llmgw-web/src/pages/ModelsPage.tsx");
        var exchangesPage = ReadRepoFile("prd-llmgw-web/src/pages/ExchangesPage.tsx");
        var overview = ReadRepoFile("prd-llmgw-web/src/pages/OverviewPage.tsx");
        var dockerCompose = ReadRepoFile("docker-compose.yml");
        var cdsCompose = ReadRepoFile("cds-compose.yml");

        Assert.Contains("GetCollection<LLMPlatform>(\"llmgw_platforms\")", resolver);
        Assert.Contains("GetCollection<LLMModel>(\"llmgw_models\")", resolver);
        Assert.Contains("GetCollection<ModelExchange>(\"llmgw_model_exchanges\")", resolver);
        Assert.Contains("FindGatewayOwnedOrMapPlatformAsync", resolver);
        Assert.Contains("FindGatewayOwnedOrMapModelAsync", resolver);
        Assert.Contains("FindGatewayOwnedExchangeAsync", resolver);
        Assert.Contains("GW-owned platform 命中", resolver);
        Assert.Contains("GW-owned model 命中", resolver);
        Assert.Contains("GW-owned exchange 命中", resolver);

        Assert.Contains("var gwPlatforms = gatewayDatabase.GetCollection<BsonDocument>(\"llmgw_platforms\");", consoleProgram);
        Assert.Contains("var gwModels = gatewayDatabase.GetCollection<BsonDocument>(\"llmgw_models\");", consoleProgram);
        Assert.Contains("var gwModelExchanges = gatewayDatabase.GetCollection<BsonDocument>(\"llmgw_model_exchanges\");", consoleProgram);
        Assert.Contains("app.MapPut(\"/gw/platforms/{id}/claim\"", consoleProgram);
        Assert.Contains("app.MapPut(\"/gw/models/{id}/claim\"", consoleProgram);
        Assert.Contains("app.MapGet(\"/gw/exchanges\"", consoleProgram);
        Assert.Contains("app.MapPut(\"/gw/exchanges/{id}/claim\"", consoleProgram);
        Assert.Contains("app.MapPut(\"/gw/platforms/{id}/api-key\"", consoleProgram);
        Assert.Contains("app.MapPut(\"/gw/models/{id}/api-key\"", consoleProgram);
        Assert.Contains("app.MapPut(\"/gw/exchanges/{id}/api-key\"", consoleProgram);
        Assert.Contains("app.MapDelete(\"/gw/platforms/{id}/api-key\"", consoleProgram);
        Assert.Contains("app.MapDelete(\"/gw/models/{id}/api-key\"", consoleProgram);
        Assert.Contains("app.MapDelete(\"/gw/exchanges/{id}/api-key\"", consoleProgram);
        Assert.Contains("app.MapPost(\"/gw/api-keys/bulk-rotate\"", consoleProgram);
        Assert.Contains("app.MapPost(\"/gw/models/capabilities/bulk-update\"", consoleProgram);
        Assert.Contains("app.MapGet(\"/gw/key-health\"", consoleProgram);
        Assert.Contains("MapKeyHealth(d, \"platform\", \"ApiKeyEncrypted\", config)", consoleProgram);
        Assert.Contains("MapKeyHealth(d, \"exchange\", \"TargetApiKeyEncrypted\", config)", consoleProgram);
        Assert.Contains("action: \"platform.claim_to_gateway\"", consoleProgram);
        Assert.Contains("action: \"model.claim_to_gateway\"", consoleProgram);
        Assert.Contains("action: \"exchange.claim_to_gateway\"", consoleProgram);
        Assert.Contains("action: \"platform.rotate_api_key\"", consoleProgram);
        Assert.Contains("action: \"model.rotate_api_key\"", consoleProgram);
        Assert.Contains("action: \"exchange.rotate_api_key\"", consoleProgram);
        Assert.Contains("action: \"platform.delete_api_key\"", consoleProgram);
        Assert.Contains("action: \"model.delete_api_key\"", consoleProgram);
        Assert.Contains("action: \"exchange.delete_api_key\"", consoleProgram);
        Assert.Contains("auditAction = \"platform.bulk_rotate_api_key\"", consoleProgram);
        Assert.Contains("auditAction = \"model.bulk_rotate_api_key\"", consoleProgram);
        Assert.Contains("auditAction = \"exchange.bulk_rotate_api_key\"", consoleProgram);
        Assert.Contains("action: \"model.capabilities.bulk_update\"", consoleProgram);
        Assert.Contains("批量能力维护必须选择平台，或显式设置 allGwOwned=true", consoleProgram);
        Assert.Contains("批量轮换必须提供 ids，或显式设置 allGwOwned=true", consoleProgram);
        Assert.Contains("targetAuthority == \"llm_gateway\" ? \"llmgw_platform\" : \"llmplatform\"", consoleProgram);
        Assert.Contains("targetAuthority == \"llm_gateway\" ? \"llmgw_model\" : \"llmmodel\"", consoleProgram);
        Assert.Contains("static ExchangeItem MapExchange(BsonDocument d)", consoleProgram);
        Assert.Contains("请先将平台认领到 GW，再在 GW 中轮换密钥", consoleProgram);
        Assert.Contains("请先将模型认领到 GW，再在 GW 中轮换密钥", consoleProgram);
        Assert.Contains("请先将 Exchange 认领到 GW，再在 GW 中轮换密钥", consoleProgram);
        Assert.Contains("请先将平台认领到 GW，再在 GW 中删除密钥", consoleProgram);
        Assert.Contains("请先将模型认领到 GW，再在 GW 中删除密钥", consoleProgram);
        Assert.Contains("请先将 Exchange 认领到 GW，再在 GW 中删除密钥", consoleProgram);

        Assert.DoesNotContain("PrdAgent.Core", consoleCsproj);
        Assert.DoesNotContain("PrdAgent.Infrastructure", consoleCsproj);
        Assert.Contains("ApiKeyCrypto:Secret 未配置", consoleCrypto);
        Assert.Contains("Convert.ToBase64String(aes.IV)", consoleCrypto);
        Assert.Contains("public const string LegacyConfigKey = \"ApiKeyCrypto:LegacySecrets\";", consoleCrypto);
        Assert.Contains("public static ApiKeyDecryptResult Decrypt", consoleCrypto);
        Assert.Contains("UsedLegacySecret", consoleCrypto);
        Assert.Contains("public string SourceCollection { get; set; } = \"llmplatforms\";", consoleDto);
        Assert.Contains("public string SourceCollection { get; set; } = \"llmmodels\";", consoleDto);
        Assert.Contains("public sealed class RotateApiKeyRequest", consoleDto);
        Assert.Contains("public sealed class BulkRotateApiKeysRequest", consoleDto);
        Assert.Contains("public sealed class BulkRotateApiKeysResult", consoleDto);
        Assert.Contains("public sealed class BulkUpdateModelCapabilitiesRequest", consoleDto);
        Assert.Contains("public sealed class BulkUpdateModelCapabilitiesResult", consoleDto);
        Assert.Contains("public sealed class KeyHealthData", consoleDto);
        Assert.Contains("public sealed class ExchangesData", consoleDto);
        Assert.Contains("public sealed class ExchangeItem", consoleDto);
        Assert.Contains("claimPlatformToGateway", api);
        Assert.Contains("claimModelToGateway", api);
        Assert.Contains("getExchanges", api);
        Assert.Contains("claimExchangeToGateway", api);
        Assert.Contains("rotatePlatformApiKey", api);
        Assert.Contains("rotateModelApiKey", api);
        Assert.Contains("rotateExchangeApiKey", api);
        Assert.Contains("deletePlatformApiKey", api);
        Assert.Contains("deleteModelApiKey", api);
        Assert.Contains("deleteExchangeApiKey", api);
        Assert.Contains("bulkRotateApiKeys", api);
        Assert.Contains("bulkUpdateModelCapabilities", api);
        Assert.Contains("getKeyHealth", api);
        Assert.Contains("export type BulkRotateApiKeysRequest", types);
        Assert.Contains("export type BulkRotateApiKeysResult", types);
        Assert.Contains("export type BulkUpdateModelCapabilitiesRequest", types);
        Assert.Contains("export type BulkUpdateModelCapabilitiesResult", types);
        Assert.Contains("export type KeyHealthSummary", types);
        Assert.Contains("认领到 GW 平台", platformsPage);
        Assert.Contains("更新「${res.data.name}」的 GW 平台密钥", platformsPage);
        Assert.Contains("清除「${res.data.name}」的 GW 平台密钥", platformsPage);
        Assert.Contains("清除密钥", platformsPage);
        Assert.Contains("批量轮换 GW 平台密钥", platformsPage);
        Assert.Contains("确认写入 GW 权威平台", platformsPage);
        Assert.Contains("GW 权威", platformsPage);
        Assert.Contains("<Route path=\"/models\" element={<ModelsPage />} />", app);
        Assert.Contains("<Route path=\"/exchanges\" element={<ExchangesPage />} />", app);
        Assert.Contains("{ to: '/models', label: '模型'", layout);
        Assert.Contains("{ to: '/exchanges', label: 'Exchange'", layout);
        Assert.Contains("认领到 GW 模型", modelsPage);
        Assert.Contains("更新「${res.data.modelName || res.data.name}」的 GW 模型密钥", modelsPage);
        Assert.Contains("清除「${res.data.modelName || res.data.name}」的 GW 模型密钥", modelsPage);
        Assert.Contains("清除密钥", modelsPage);
        Assert.Contains("批量轮换 GW 模型密钥", modelsPage);
        Assert.Contains("确认写入当前筛选的 GW 模型", modelsPage);
        Assert.Contains("批量维护 GW 模型能力", modelsPage);
        Assert.Contains("选择模板", modelsPage);
        Assert.Contains("applyCapabilityTemplate", modelsPage);
        Assert.Contains("mergeCapabilityText", modelsPage);
        Assert.Contains("bulkUpdateModelCapabilities", modelsPage);
        Assert.Contains("parseCapabilities", modelsPage);
        Assert.Contains("claimModelToGateway", modelsPage);
        Assert.Contains("认领到 GW Exchange", exchangesPage);
        Assert.Contains("更新「${res.data.name}」的 GW Exchange 密钥", exchangesPage);
        Assert.Contains("清除「${res.data.name}」的 GW Exchange 密钥", exchangesPage);
        Assert.Contains("清除密钥", exchangesPage);
        Assert.Contains("批量轮换 GW Exchange 密钥", exchangesPage);
        Assert.Contains("确认写入当前筛选的 GW Exchange", exchangesPage);
        Assert.Contains("claimExchangeToGateway", exchangesPage);
        Assert.Contains("getExchanges()", overview);
        Assert.Contains("getKeyHealth()", overview);
        Assert.Contains("密钥自检", overview);
        Assert.Contains("to=\"/models\"", overview);
        Assert.Contains("to=\"/exchanges\"", overview);

        Assert.Contains("ApiKeyCrypto__Secret=${API_KEY_CRYPTO_SECRET:?", dockerCompose);
        Assert.Contains("ApiKeyCrypto__Secret: \"${ApiKeyCrypto__Secret}\"", cdsCompose);
    }

    [Fact]
    public void ImageGenRunWorker_DoesNotSilentlyDowngradeReferenceImageRunsToText2Img()
    {
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs");

        Assert.Contains("expectedReferenceCount", worker);
        Assert.Contains("IMAGE_REF_UNAVAILABLE", worker);
        Assert.Contains("参考图加载不完整", worker);
        Assert.Contains("loadedImageRefs.Count < expectedReferenceCount", worker);
        Assert.Contains("Builders<ImageGenRun>.Update.Set(x => x.AppCallerCode, appCallerCode)", worker);
        Assert.Contains("AppCallerRegistry.VisualAgent.Image.Img2Img", worker);
        Assert.Contains("AppCallerRegistry.VisualAgent.Image.VisionGen", worker);
    }

    [Fact]
    public void ShadowForceSample_IsKeyCheckedAndDoesNotRequireApiRestart()
    {
        var apiProgram = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");
        var context = ReadRepoFile("prd-api/src/PrdAgent.Core/Interfaces/ILLMRequestContextAccessor.cs");
        var accessor = ReadRepoFile("prd-api/src/PrdAgent.Core/Services/LLMRequestContextAccessor.cs");
        var shadowGateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ShadowLlmGateway.cs");
        var seed = ReadRepoFile("scripts/llmgw-map-shadow-seed.py");
        var reportSeed = ReadRepoFile("scripts/llmgw-report-agent-shadow-seed.py");
        var accumulator = ReadRepoFile("scripts/llmgw-shadow-sample-accumulate.sh");

        Assert.Contains("X-Llmgw-Shadow-Sample-Key", apiProgram);
        Assert.Contains("FixedTimeEqualsNonEmpty", apiProgram);
        Assert.Contains("ForceFullShadowSample: true", apiProgram);
        Assert.Contains("bool ForceFullShadowSample = false", context);
        Assert.Contains("prev?.ForceFullShadowSample == true", accessor);
        Assert.Contains("_ctx?.Current?.ForceFullShadowSample == true", shadowGateway);
        Assert.Contains("--force-shadow-sample", seed);
        Assert.Contains("X-Llmgw-Shadow-Sample-Key", seed);
        Assert.Contains("\"LLMGW_SHADOW_SAMPLE_KEY\": FORCE_SHADOW_SAMPLE_KEY", seed);
        Assert.DoesNotContain("cmd.extend([\"--shadow-sample-key\"", seed);
        Assert.Contains("SHADOW_SAMPLE_KEY = args.shadow_sample_key.strip()", reportSeed);
        Assert.Contains("headers[\"X-Llmgw-Shadow-Sample-Key\"] = SHADOW_SAMPLE_KEY", reportSeed);
        Assert.Contains("LLMGW_SHADOW_ACCUMULATE_FORCE_SAMPLE", accumulator);
        Assert.Contains("--force-shadow-sample", accumulator);
        Assert.Contains("python3 \"$seed_script\"", accumulator);
        Assert.Contains("\"$window_script\"", accumulator);
    }

    [Fact]
    public void ShadowSamplePlan_IsReadOnlyAndCapsRecommendedBatches()
    {
        var planner = ReadRepoFile("scripts/llmgw-shadow-sample-plan.py");

        Assert.Contains("Plan bounded LLM Gateway shadow sample top-up batches", planner);
        Assert.Contains("This script is read-only", planner);
        Assert.Contains("--coverage-json", planner);
        Assert.Contains("LLMGW_SHADOW_SAMPLE_PLAN_MAX_BATCHES", planner);
        Assert.Contains("recommendedBatches", planner);
        Assert.Contains("canRunRecommendedBatches", planner);
        Assert.Contains("bounded-top-up", planner);
        Assert.Contains("coverage-read-failure", planner);
        Assert.Contains("coverageReadReady", planner);
        Assert.Contains("_coverage_failure_reason", planner);
        Assert.Contains("_is_benign_coverage_failure", planner);
        Assert.Contains("coverageFailures", planner);
        Assert.Contains("coverage.get(\"failures\")", planner);
        Assert.Contains("already-ready", planner);
        Assert.Contains("wait-coverage-window", planner);
        Assert.Contains("window-extension-top-up", planner);
        Assert.Contains("--allow-window-extension", planner);
        Assert.Contains("_can_extend_window", planner);
        Assert.DoesNotContain("urllib.request", planner);
        Assert.DoesNotContain("subprocess.run", planner);
        Assert.DoesNotContain("requests.", planner);
    }

    [Fact]
    public void RolloutStatus_CanFailAsReleaseGateWithoutCallingProviders()
    {
        var status = ReadRepoFile("scripts/llmgw-rollout-status.py");

        Assert.Contains("Read-only LLM Gateway rollout status board", status);
        Assert.Contains("It never calls MAP seed endpoints and never calls model providers.", status);
        Assert.Contains("--require-ready", status);
        Assert.Contains("--require-action", status);
        Assert.Contains("_required_action_failure", status);
        Assert.Contains("LLM Gateway rollout status: NOT READY", status);
        Assert.Contains("require_release_ready", status);
        Assert.Contains("releaseStatus=", status);
        Assert.Contains("healthOk=", status);
        Assert.Contains("nextEligibleAt=", status);
        Assert.Contains("ready-for-release-gate", status);
    }

    [Fact]
    public void FieldLevelParameterCapabilities_AreVisibleInConsoleMetadata()
    {
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var consoleDtos = ReadRepoFile("prd-llmgw/Models/Dtos.cs");
        var consoleApi = ReadRepoFile("prd-llmgw-web/src/lib/api.ts");
        var consoleTypes = ReadRepoFile("prd-llmgw-web/src/lib/types.ts");
        var poolsPage = ReadRepoFile("prd-llmgw-web/src/pages/ModelPoolsPage.tsx");

        foreach (var parameter in new[]
        {
            "seed",
            "stop",
            "frequency_penalty",
            "presence_penalty",
            "modalities",
            "audio",
            "prediction",
            "stream_options",
            "service_tier",
            "store",
            "user",
            "n",
        })
        {
            Assert.Contains($"\"{parameter}\"", gateway);
            Assert.Contains($"(\"{parameter}\"", consoleProgram);
        }

        Assert.Contains("StrictParameterCapabilityKeys", gateway);
        Assert.Contains("managedParameterCapabilities", consoleProgram);
        Assert.Contains("providerParameterCapabilityTemplates", consoleProgram);
        Assert.Contains("openai-chat-standard", consoleProgram);
        Assert.Contains("claude-messages", consoleProgram);
        Assert.Contains("gemini-generate-content", consoleProgram);
        Assert.Contains("app.MapGet(\"/gw/parameter-capabilities/meta\"", consoleProgram);
        Assert.Contains("ParameterCapabilitiesMetaData", consoleDtos);
        Assert.Contains("ParameterCapabilityMetaItem", consoleDtos);
        Assert.Contains("ParameterCapabilityTemplateItem", consoleDtos);
        Assert.Contains("getParameterCapabilitiesMeta", consoleApi);
        Assert.Contains("ParameterCapabilityMetaItem", consoleTypes);
        Assert.Contains("ParameterCapabilityTemplateItem", consoleTypes);
        Assert.Contains("templates: ParameterCapabilityTemplateItem[]", consoleTypes);
        Assert.Contains("ParameterCapabilityOptions", poolsPage);
        Assert.Contains("gw-parameter-capability-options", poolsPage);
    }

    [Fact]
    public void AppCallerRegistry_ExposesGovernanceMetadataInConsole()
    {
        var consoleDtos = ReadRepoFile("prd-llmgw/Models/Dtos.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var gatewayRequest = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayRequest.cs");
        var consoleTypes = ReadRepoFile("prd-llmgw-web/src/lib/types.ts");
        var appCallersPage = ReadRepoFile("prd-llmgw-web/src/pages/AppCallersPage.tsx");
        var consoleApi = ReadRepoFile("prd-llmgw-web/src/lib/api.ts");
        var auditsPage = ReadRepoFile("prd-llmgw-web/src/pages/AuditsPage.tsx");
        var consoleApp = ReadRepoFile("prd-llmgw-web/src/App.tsx");
        var consoleLayout = ReadRepoFile("prd-llmgw-web/src/components/ConsoleLayout.tsx");

        foreach (var field in new[] { "Owner", "MonthlyBudgetUsd", "RateLimitPerMinute" })
        {
            Assert.Contains(field, consoleDtos);
            Assert.Contains(field, consoleProgram);
            Assert.Contains(field, gatewayRequest);
        }

        foreach (var field in new[] { "owner", "monthlyBudgetUsd", "rateLimitPerMinute" })
        {
            Assert.Contains(field, consoleTypes);
            Assert.Contains(field, appCallersPage);
        }

        Assert.Contains("parseNonNegativeNumber", appCallersPage);
        Assert.Contains("parseNonNegativeInteger", appCallersPage);
        Assert.Contains("预算 USD/月", appCallersPage);
        Assert.Contains("RPM", appCallersPage);
        Assert.Contains("BulkUpdateGatewayAppCallersRequest", consoleDtos);
        Assert.Contains("BulkUpdateGatewayAppCallersResult", consoleDtos);
        Assert.Contains("app.MapPost(\"/gw/app-callers/bulk-governance\"", consoleProgram);
        Assert.Contains("批量治理必须至少提供一个筛选条件", consoleProgram);
        Assert.Contains("action: \"app_caller.bulk_governance\"", consoleProgram);
        Assert.Contains("bulkUpdateGatewayAppCallers", appCallersPage);
        Assert.Contains("按当前筛选批量治理", appCallersPage);
        Assert.Contains("parseOptionalNonNegativeNumber", appCallersPage);
        Assert.Contains("parseOptionalNonNegativeInteger", appCallersPage);
        Assert.Contains("OperationAuditsData", consoleDtos);
        Assert.Contains("OperationAuditItem", consoleDtos);
        Assert.Contains("app.MapGet(\"/gw/audits\"", consoleProgram);
        Assert.Contains("MapOperationAudit", consoleProgram);
        Assert.Contains("getOperationAudits", consoleApi);
        Assert.Contains("OperationAuditsData", consoleTypes);
        Assert.Contains("llmgw_operation_audits", auditsPage);
        Assert.Contains("搜索 action / target / actor", auditsPage);
        Assert.Contains("path=\"/audits\"", consoleApp);
        Assert.Contains("label: '审计'", consoleLayout);
    }

    [Fact]
    public void Serving_EnforcesAppCallerGovernanceFromGatewayRegistry()
    {
        var servingEndpoints = ReadRepoFile("prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs");

        Assert.Contains("RecordAndCheckAppCallerGovernanceAsync", servingEndpoints);
        Assert.Contains("CheckAppCallerGovernanceAsync", servingEndpoints);
        Assert.Contains("CheckAppCallerMonthlyBudgetAsync", servingEndpoints);
        Assert.Contains("llmgw_app_caller_rate_windows", servingEndpoints);
        Assert.Contains("RateLimitPerMinute", servingEndpoints);
        Assert.Contains("MonthlyBudgetUsd", servingEndpoints);
        Assert.Contains("TotalCostUsd", servingEndpoints);
        Assert.Contains("CostUsd", servingEndpoints);
        Assert.Contains("EstimatedCostUsd", servingEndpoints);
        Assert.Contains("FindOneAndUpdateAsync", servingEndpoints);
        Assert.Contains("APP_CALLER_RATE_LIMITED", servingEndpoints);
        Assert.Contains("APP_CALLER_MONTHLY_BUDGET_EXCEEDED", servingEndpoints);
        Assert.Contains("StatusCodes.Status429TooManyRequests", servingEndpoints);
        Assert.Contains("Headers.RetryAfter", servingEndpoints);
        Assert.Contains("TryRejectStrictDroppedParametersAsync", servingEndpoints);
        Assert.Contains("AppCallerGovernanceDecision", servingEndpoints);

        var enforcementCallCount = servingEndpoints.Split("RecordAndCheckAppCallerGovernanceAsync").Length - 1;
        Assert.True(enforcementCallCount >= 9, $"真实发送入口必须统一接入 appCaller governance，当前仅 {enforcementCallCount} 处。");
        Assert.Contains("await RecordDiscoveredAppCallerAsync(services, new GatewayIngressRequest\n            {\n                RequestId = Guid.NewGuid().ToString(\"N\")", servingEndpoints);
    }

    [Fact]
    public void ServingIngressProtocols_AllRouteThroughIrAppCallerRegistryAndGovernance()
    {
        var servingEndpoints = ReadRepoFile("prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var gatewayRequest = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayRequest.cs");
        var gatewayKeyGateTests = ReadRepoFile("prd-api/tests/PrdAgent.Api.Tests/Gateway/GatewayKeyGateContractTests.cs");
        var gatewayTests = ReadRepoFile("prd-api/tests/PrdAgent.Api.Tests/Services/LlmGatewayTests.cs");
        var plan = ReadRepoFile("doc/plan.platform.llm-gateway-protocol-router.md");

        Assert.Contains("public sealed class GatewayIngressRequest", gatewayRequest);
        Assert.Contains("public required string IngressProtocol { get; init; }", gatewayRequest);
        Assert.Contains("public required string AppCallerCode { get; init; }", gatewayRequest);
        Assert.Contains("public string ModelPolicy { get; init; } = \"auto\";", gatewayRequest);
        Assert.Contains("public string? ModelPoolId { get; init; }", gatewayRequest);
        Assert.Contains("public string ParameterPolicy { get; init; } = \"default-drop\";", gatewayRequest);
        Assert.Contains("public sealed class GatewayAppCallerRecord", gatewayRequest);
        Assert.Contains("public string Status { get; set; } = \"discovered\";", gatewayRequest);

        Assert.Contains("IngressProtocol = \"openai-compatible\"", servingEndpoints);
        Assert.Contains("IngressProtocol = \"claude-compatible\"", servingEndpoints);
        Assert.Contains("IngressProtocol = \"gemini-compatible\"", servingEndpoints);
        Assert.Contains("IngressProtocol = body.Context?.IngressProtocol ?? \"gw-native\"", servingEndpoints);
        Assert.Contains("private static GatewayIngressRequest ToIngress(GatewayRequest request, string ingressProtocol, string sourceSystem)", servingEndpoints);
        Assert.Contains("private static GatewayIngressRequest ToIngress(GatewayRawRequest request, string ingressProtocol, string sourceSystem)", servingEndpoints);

        var registryIndex = servingEndpoints.IndexOf("private static async Task RecordDiscoveredAppCallerAsync", StringComparison.Ordinal);
        Assert.True(registryIndex >= 0, "serving must keep a single passive appCaller registration path.");
        var registryBlock = servingEndpoints[registryIndex..servingEndpoints.IndexOf("private static IResult JsonContentResult", StringComparison.Ordinal)];
        Assert.Contains("GetCollection<GatewayAppCallerRecord>(\"llmgw_app_callers\")", registryBlock);
        Assert.Contains("SetOnInsert(x => x.Status, \"discovered\")", registryBlock);
        Assert.Contains("Set(x => x.SourceSystem", registryBlock);
        Assert.Contains("Set(x => x.IngressProtocol", registryBlock);
        Assert.Contains("Set(x => x.Title", registryBlock);
        Assert.Contains("Inc(x => x.TotalSeen, 1)", registryBlock);
        Assert.Contains("new UpdateOptions { IsUpsert = true }", registryBlock);
        Assert.Contains("被动登记是观测能力，不能阻断模型请求主链路", registryBlock);

        foreach (var marker in new[]
        {
            "app.MapPost(\"/v1/responses\"",
            "app.MapPost(\"/v1/images/generations\"",
            "app.MapPost(\"/v1/images/edits\"",
            "app.MapPost(\"/v1/chat/completions\"",
            "app.MapPost(\"/v1/messages\"",
            "=> GeminiGenerateContentAsync(model, stream: false",
            "=> GeminiGenerateContentAsync(model, stream: true",
            "app.MapPost(\"/gw/v1/send\"",
            "app.MapPost(\"/gw/v1/stream\"",
            "app.MapPost(\"/gw/v1/raw\"",
        })
        {
            Assert.Contains(marker, servingEndpoints);
        }

        var governanceCallCount = servingEndpoints.Split("RecordAndCheckAppCallerGovernanceAsync").Length - 1;
        Assert.True(governanceCallCount >= 9, $"四类协议入口和 GW Native 真实发送路径必须接入治理，当前仅 {governanceCallCount} 处。");
        Assert.Contains("ResolveCompatModelPolicy", servingEndpoints);
        Assert.Contains("ResolveCompatModelPoolId", servingEndpoints);
        Assert.Contains("ResolveCompatPinnedTarget", servingEndpoints);
        Assert.Contains("ConvertClaudeContentToOpenAiContent", servingEndpoints);
        Assert.Contains("ConvertClaudeContentPart", servingEndpoints);
        Assert.Contains("data:{mediaType};base64,{data}", servingEndpoints);
        Assert.Contains("imageUrlObject[\"detail\"] = detail.DeepClone()", servingEndpoints);
        Assert.Contains("IsGeminiImageFileData", servingEndpoints);
        Assert.Contains("fileUri", servingEndpoints);
        Assert.Contains("var requestType = ContainsOpenAiImageInput(openAiBody) ? ModelTypes.Vision : ModelTypes.Chat;", servingEndpoints);
        Assert.Contains("AppCallerRegistry.OpenApi.Proxy.Vision", servingEndpoints);
        Assert.Contains("X-Gateway-Model-Policy", servingEndpoints);
        Assert.Contains("X-Gateway-Model-Pool-Id", servingEndpoints);
        Assert.Contains("X-Gateway-Pinned-Platform-Id", servingEndpoints);
        Assert.Contains("X-Gateway-Pinned-Model-Id", servingEndpoints);
        Assert.Contains("NormalizeModelPolicy", servingEndpoints);
        Assert.Contains("providerNode is JsonObject provider", servingEndpoints);
        Assert.Contains("ModelPolicy = explicitModelPolicy", servingEndpoints);
        Assert.Contains("ModelPoolId = modelPoolId", servingEndpoints);
        Assert.Contains("PinnedPlatformId = pinnedPlatformId", servingEndpoints);
        Assert.Contains("PinnedModelId = pinnedModelId", servingEndpoints);
        Assert.Contains("IsOpenAiImageEditImageField", servingEndpoints);
        Assert.Contains("imageFileCount > 1 || IsOpenAiImageEditArrayField", servingEndpoints);
        Assert.Contains("NormalizeMultipartSendFieldName", gateway);
        Assert.Contains("IsIndexedMultipartArrayField(fieldName, \"image\")", gateway);
        Assert.Contains("OpenAiImageEditsCompatibleEndpoint_PreservesMultiImageArrayFields", gatewayKeyGateTests);
        Assert.Contains("requestBody.ShouldContain(\"\\\"detail\\\":\\\"high\\\"\")", gatewayKeyGateTests);
        Assert.Contains("ClaudeCompatibleEndpoint_WithImageBlock_UsesVisionRequestType", gatewayKeyGateTests);
        Assert.Contains("ClaudeCompatibleEndpoint_WithImageUrlSource_UsesVisionRequestType", gatewayKeyGateTests);
        Assert.Contains("GeminiCompatibleEndpoint_WithInlineImage_UsesVisionRequestType", gatewayKeyGateTests);
        Assert.Contains("GeminiCompatibleEndpoint_WithImageFileData_UsesVisionRequestType", gatewayKeyGateTests);
        Assert.Contains("SendRawWithResolutionAsync_WhenMultipartImageArrayKeys_ShouldSendImageArrayFields", gatewayTests);
        Assert.Contains("Images edits 基础 multipart 形态和 `image[]`/`image[n]` 多图 multipart 字段规范化", plan);
        Assert.Contains("不写 LLM 请求日志", plan);
        Assert.Contains("不能替代 `appcaller_runtime_coverage`", plan);
        Assert.Contains("`current_commit_http_transport` 或 `dropped_parameter_runtime_evidence`", plan);
        Assert.Contains("该证据不计入 appCaller runtime coverage", plan);
    }

    [Fact]
    public void ProtocolRouterTargetAudit_ReportsTargetProgressEvidence()
    {
        var script = ReadRepoFile("scripts/llmgw-protocol-router-audit.py");

        Assert.Contains("LLM Gateway protocol-router target static audit", script);
        Assert.Contains("doc/plan.platform.llm-gateway-protocol-router.md", script);
        Assert.Contains("assets/prototypes/llmgw-architecture-map.html", script);
        Assert.Contains("public sealed class GatewayIngressRequest", script);
        Assert.Contains("public string? ModelPoolId { get; init; }", script);
        Assert.Contains("openai-compatible", script);
        Assert.Contains("claude-compatible", script);
        Assert.Contains("gemini-compatible", script);
        Assert.Contains("ResolveCompatModelPoolId", script);
        Assert.Contains("ResolveCompatPinnedTarget", script);
        Assert.Contains("X-Gateway-Model-Pool-Id", script);
        Assert.Contains("X-Gateway-Pinned-Platform-Id", script);
        Assert.Contains("X-Gateway-Pinned-Model-Id", script);
        Assert.Contains("llmgw_app_callers", script);
        Assert.Contains("RecordAndCheckAppCallerGovernanceAsync", script);
        Assert.Contains("DisableMapConfigFallbackForActiveAppCallers", script);
        Assert.Contains("/gw/config-authority/report", script);
        Assert.Contains("/gw/runtime-gates", script);
        Assert.Contains("RuntimeGatePanel", script);
        Assert.Contains("ReadyForHttpFull", script);
        Assert.Contains("scripts/llmgw-config-authority-backup.sh", script);
        Assert.Contains("protocol-router-audit.json", script);
        Assert.Contains("--protocol-router-audit-json", script);
        Assert.Contains("_require_protocol_router_audit", script);
        Assert.Contains("protocolRouterAuditJson", script);
        Assert.Contains("targetComplete must remain false until runtime gates pass", script);
        Assert.Contains("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS", script);
        Assert.Contains("LlmGateway__DisableMapConfigFallbackForActiveAppCallers", script);
        Assert.Contains("disableMapConfigFallbackForActiveAppCallers", script);
        Assert.Contains("disable_map_fallback_default=true", script);
        Assert.Contains("routerTrace", script);
        Assert.Contains("providerAttempts", script);
        Assert.Contains("--json-out", script);
        Assert.Contains("--report-md", script);
        Assert.Contains("\"scope\": \"static-code-and-document-evidence\"", script);
        Assert.Contains("\"targetComplete\": False", script);
        Assert.Contains("staticEvidencePercent", script);
        Assert.Contains("progressPercent", script);
        Assert.Contains("remainingRuntimeGates", script);
        Assert.Contains("production_config_authority_execute", script);
        Assert.Contains("active_appcaller_map_fallback_exit", script);
        Assert.Contains("full_http_rollout_acceptance", script);
        Assert.Contains("targetComplete=false", script);
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");
        Assert.Contains("protocol_router_target_audit", readiness);
        Assert.Contains("scripts/llmgw-protocol-router-audit.py", readiness);
        Assert.Contains("\"targetComplete\": payload.get(\"targetComplete\")", readiness);
        Assert.Contains("\"remainingRuntimeGates\": remaining_names", readiness);
    }

    [Fact]
    public void GatewayCostAttribution_IsWrittenToLogsAndConsole()
    {
        var logModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs");
        var logWriterContract = ReadRepoFile("prd-api/src/PrdAgent.Core/Interfaces/ILlmRequestLogWriter.cs");
        var logBackground = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogBackground.cs");
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/IModelResolver.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var modelGroup = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ModelGroup.cs");
        var consoleDtos = ReadRepoFile("prd-llmgw/Models/Dtos.cs");
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");
        var consoleTypes = ReadRepoFile("prd-llmgw-web/src/lib/types.ts");
        var consoleApi = ReadRepoFile("prd-llmgw-web/src/lib/api.ts");
        var logsHelpers = ReadRepoFile("prd-llmgw-web/src/lib/logsHelpers.ts");
        var logsView = ReadRepoFile("prd-llmgw-web/src/components/LogsView.tsx");
        var detailsDrawer = ReadRepoFile("prd-llmgw-web/src/components/GenerationDetailsDrawer.tsx");
        var modelPoolsPage = ReadRepoFile("prd-llmgw-web/src/pages/ModelPoolsPage.tsx");

        foreach (var field in new[]
                 {
                     "InputPricePerMillion",
                     "OutputPricePerMillion",
                     "PricePerCall",
                     "PriceCurrency",
                     "EstimatedInputCost",
                     "EstimatedOutputCost",
                     "EstimatedCallCost",
                     "EstimatedCost",
                     "EstimatedCostCurrency",
                     "EstimatedCostUsd",
                 })
        {
            Assert.Contains(field, logModel);
        }

        Assert.Contains("InputPricePerMillion = model.InputPricePerMillion", resolver);
        Assert.Contains("OutputPricePerMillion = model.OutputPricePerMillion", resolver);
        Assert.Contains("PricePerCall = model.PricePerCall", resolver);
        Assert.Contains("public string? PriceCurrency", modelGroup);
        Assert.Contains("NormalizeModelPoolPriceCurrency(model.PriceCurrency)", resolver);
        Assert.Contains("DefaultModelPoolPriceCurrency = \"CNY\"", resolver);
        Assert.Contains("EstimateCost", gateway);
        Assert.Contains("EstimatedCostUsd: cost.Usd", gateway);
        Assert.Contains("EstimatedCostUsd", logWriterContract);
        Assert.Contains("EstimatedCostUsd", logBackground);
        Assert.Contains("EstimatedCostUsd", consoleDtos);
        Assert.Contains("PriceCurrency", consoleDtos);
        Assert.Contains("NormalizePriceCurrency", consoleProgram);
        Assert.Contains("priceCurrency 仅支持 CNY 或 USD", consoleProgram);
        Assert.Contains("BulkCalibratePoolPriceCurrencyRequest", consoleDtos);
        Assert.Contains("BulkCalibratePoolPriceCurrencyResult", consoleDtos);
        Assert.Contains("app.MapPost(\"/gw/pools/price-currency/bulk-calibrate\"", consoleProgram);
        Assert.Contains("action: \"pool.bulk_calibrate_price_currency\"", consoleProgram);
        Assert.Contains("EstimatedCostUsd = docs.Sum", consoleProgram);
        Assert.Contains("EstimatedCost = d.AsNullableDecimal(\"EstimatedCost\")", consoleProgram);
        Assert.Contains("estimatedCostUsd", consoleTypes);
        Assert.Contains("priceCurrency?: string", consoleTypes);
        Assert.Contains("BulkCalibratePoolPriceCurrencyRequest", consoleTypes);
        Assert.Contains("bulkCalibratePoolPriceCurrency", consoleApi);
        Assert.Contains("fmtCost", logsHelpers);
        Assert.Contains("fmtCost(it.estimatedCost, it.estimatedCostCurrency)", logsView);
        Assert.Contains("fmtCost(detail.estimatedCost, detail.estimatedCostCurrency)", detailsDrawer);
        Assert.Contains("priceCurrency: member.priceCurrency || undefined", modelPoolsPage);
        Assert.Contains("<option value=\"USD\">USD</option>", modelPoolsPage);
        Assert.Contains("校准价格币种", modelPoolsPage);
        Assert.Contains("只补空币种", modelPoolsPage);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var root = LocateRepoRoot();
        var full = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    }
}
