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
    public void ConsoleWriteOperations_AreAuditedToGatewayDatabase()
    {
        var consoleProgram = ReadRepoFile("prd-llmgw/Program.cs");

        Assert.Contains("var operationAudits = gatewayDatabase.GetCollection<BsonDocument>(\"llmgw_operation_audits\");", consoleProgram);
        Assert.Contains("WriteOperationAuditAsync", consoleProgram);
        Assert.Contains("action: \"auth.change_password\"", consoleProgram);
        Assert.Contains("action: \"platform.set_enabled\"", consoleProgram);
        Assert.Contains("action: \"model.set_enabled\"", consoleProgram);
        Assert.Contains("action: \"pool.set_default\"", consoleProgram);
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
        Assert.Contains("LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:-}", dockerCompose);
        Assert.Contains("LLMGW_ADMIN_FORCE_RESET=${LLMGW_ADMIN_FORCE_RESET:-}", dockerCompose);
        Assert.DoesNotContain("LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:?", dockerCompose);
        Assert.DoesNotContain("LLMGW_ADMIN_USER", dockerCompose);
        Assert.Contains("LlmGateway__DatabaseName: llm_gateway", cdsCompose);
        Assert.Contains("控制台账号长期权威是 llm_gateway.llmgw_console_users", cdsCompose);
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
        Assert.Contains("shadow_sample_enabled=0", script);
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
        Assert.Contains("--since-hours ${LLMGW_GATE_SHADOW_SINCE_HOURS:-24}", script);
        Assert.Contains("LLMGW_GATE_MIN_COVERAGE_HOURS", script);
        Assert.Contains("--min-coverage-hours $gate_min_coverage_hours", script);
        Assert.Contains("默认要求 shadow 证据覆盖 24 小时", script);
        Assert.Contains("LLMGW_GATE_FULL_HTTP_APP_CALLERS", script);
        Assert.Contains("gate_app_callers_raw=\"${LLMGW_GATE_FULL_HTTP_APP_CALLERS:-report-agent.generate::chat", script);
        Assert.Contains("prd-agent-desktop.chat.sendmessage::chat", script);
        Assert.Contains("open-platform-agent.proxy::chat", script);
        Assert.Contains("prd-agent-web.model-lab.run::chat", script);
        Assert.Contains("prd-agent.arena.battle::chat", script);
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
        Assert.Contains("LLM Gateway release gate: LLMGW_MODE=http 未设置 LLMGW_GATE_REQUIRED_APP_KINDS，默认要求 raw 入口逐个具备 raw 样本", script);
        Assert.Contains("LLMGW_GATE_CANARY_APP_KIND_MIN", script);
        Assert.Contains("LLMGW_GATE_CANARY_APP_KINDS", script);
        Assert.Contains("LLM Gateway release gate: canary 阶段 $canary_stage 默认要求 raw app-kind 样本逐个达标", script);
        Assert.Contains("args=\"$args --require-app-kind $app_kind_req_trimmed\"", script);
        Assert.Contains("for app in ${LLMGW_HTTP_APP_CALLER_ALLOWLIST:-}; do", script);
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
        Assert.Contains("asr_credential_rejected", providerAudit);
        Assert.Contains("asr_authorization_failed", providerAudit);
        Assert.Contains("asr_channel_unavailable", providerAudit);
        Assert.Contains("video_channel_unavailable", providerAudit);
        Assert.Contains("video_model_not_open", providerAudit);
        Assert.Contains("--self-test", providerAudit);
        Assert.Contains("_self_test_report", providerAudit);
        Assert.Contains("requiredCodes", providerAudit);
        Assert.Contains("missingCodes", providerAudit);
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
        Assert.Contains("--health-samples", releaseGate);
        Assert.Contains("--health-interval", releaseGate);
        Assert.Contains("\"stable\"", releaseGate);
        Assert.Contains("--json-out", releaseGate);
        Assert.Contains("--report-md", releaseGate);
        Assert.Contains("\"shadowChecks\"", releaseGate);
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

        Assert.Contains("LLM Gateway production stage runner", script);
        Assert.Contains("shadow-start", script);
        Assert.Contains("canary-intent-text", script);
        Assert.Contains("canary-chat", script);
        Assert.Contains("canary-streaming", script);
        Assert.Contains("canary-vision", script);
        Assert.Contains("canary-image", script);
        Assert.Contains("canary-video-asr", script);
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
        Assert.Contains("release-gate.json", script);
        Assert.Contains("serving-probe.json", script);
        Assert.Contains("gw-smoke.json", script);
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
        Assert.Contains("\"http-full\"", ledger);
        Assert.Contains("missing_success", ledger);
        Assert.Contains("requires rollback rehearsal success for the same commit", ledger);
        Assert.Contains("allow-out-of-order", ledger);
        Assert.Contains("allow-out-of-order-reason", ledger);
        Assert.Contains("\"allowOutOfOrder\": _bool_flag(args.allow_out_of_order)", ledger);
        Assert.Contains("\"allowOutOfOrderReason\": args.allow_out_of_order_reason.strip()", ledger);
        Assert.Contains("allowOutOfOrder missing reason", ledger);
        Assert.Contains("\"status\": args.status", ledger);
        Assert.Contains("\"evidenceJson\": args.evidence_json", ledger);
        Assert.Contains("\"prodPreflightJson\": args.prod_preflight_json", ledger);
        Assert.Contains("_require_prod_preflight_for_commit", ledger);
        Assert.Contains("production preflight evidence", ledger);
        Assert.Contains("\"servingProbeJson\": args.serving_probe_json", ledger);
        Assert.Contains("\"smokeJson\": args.smoke_json", ledger);
        Assert.Contains("\"rollbackRehearsal\": args.stage == ROLLBACK_REHEARSAL_STAGE", ledger);
        Assert.Contains("\"releaseMainRef\": args.main_ref", ledger);
        Assert.Contains("\"releaseMainSha\": args.main_sha.lower()", ledger);
        Assert.Contains("missing releaseMainSha", ledger);
        Assert.Contains("min_observation_hours", ledger);
        Assert.Contains("rollout stage observation window not satisfied", ledger);
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
        Assert.Contains("run_prod_preflight", readiness);
        Assert.Contains("scripts/llmgw-prod-preflight.py --mode start", readiness);
        Assert.Contains("--prod-preflight-json \\\"$prod_preflight_json\\\"", readiness);
        Assert.Contains("serving-probe.json", readiness);
        Assert.Contains("GW_SMOKE_JSON_OUT", readiness);
        Assert.Contains("LLMGW_STAGE_MIN_OBSERVATION_HOURS", readiness);
        Assert.Contains("LLMGW_RELEASE_MAIN_REF", readiness);
        Assert.Contains("validate_main_ancestry", readiness);
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
        Assert.Contains("leaksKeyArg", readiness);
    }

    [Fact]
    public void ProdStageWorkflow_RunsStageRunnerOnProductionRunnerAndUploadsEvidence()
    {
        var workflow = ReadRepoFile(".github/workflows/llmgw-prod-stage.yml");
        var readiness = ReadRepoFile("scripts/llmgw-readiness-audit.py");

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
        Assert.Contains("http-full", workflow);
        Assert.Contains("rollback-inproc", workflow);
        Assert.Contains("execute:", workflow);
        Assert.Contains("default: false", workflow);
        Assert.Contains("commit:\n        description: \"40-char release commit. Required for every non-rollback-inproc stage.\"\n        required: false", workflow);
        Assert.Contains("runner_labels_json", workflow);
        Assert.Contains("[\\\"self-hosted\\\",\\\"prd-agent-prod\\\"]", workflow);
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
        Assert.Contains("[ \"$stage\" != \"rollback-inproc\" ] && [ \"$stage\" != \"rollback-rehearsal\" ] && [ -z \"$map_base\" ]", workflow);
        Assert.Contains("[ \"$stage\" != \"rollback-inproc\" ] && [ \"$stage\" != \"rollback-rehearsal\" ] && [ -z \"$(printf '%s' \"${PRD_AGENT_API_KEY:-}\" | xargs)\" ]", workflow);
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
        Assert.Contains("Restore previous rollout evidence", readiness);
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
    public void RollbackScript_ReturnsApiToInprocWithoutDatabaseRollback()
    {
        var script = ReadRepoFile("scripts/llmgw-rollback-inproc.sh");

        Assert.Contains("export LLMGW_MODE=inproc", script);
        Assert.Contains("export LLMGW_HTTP_APP_CALLER_ALLOWLIST=", script);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=0", script);
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
        Assert.Contains("exec_dep_gates_http_canary_and_shadow_sample_release", script);
        Assert.Contains("rollback_script_is_safe_and_executable", script);
        Assert.Contains("direct_client_ratchet_baselines_are_empty", script);
        Assert.Contains("multipart_http_path_has_refs_rehydrate_and_hash_guard", script);
        Assert.Contains("compose_exposes_gateway_mode_and_data_domain_controls", script);
        Assert.Contains("adminPasswordRequired", script);
        Assert.Contains("adminUserEnv", script);
        Assert.Contains("rollback_dry_run", script);
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
    public void ShadowCoverageReport_RendersAppCallerKindMatrixWithoutLeakingKey()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-coverage-report.py");

        Assert.Contains("LLM Gateway shadow coverage", script);
        Assert.Contains("/shadow-comparisons", script);
        Assert.Contains("--app-caller", script);
        Assert.Contains("--kind", script);
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
        Assert.Contains("visual-agent.image-gen.generate::generation:raw:${MIN_PER_CELL}", readiness);
        Assert.Contains("video-agent.v2d.transcribe::asr:raw:${MIN_PER_CELL}", readiness);
        Assert.Contains("video-agent.video-to-text::asr:raw:${MIN_PER_CELL}", readiness);
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
    public void GwSmoke_CoversStreamingAndClientStreamBoundaries()
    {
        var script = ReadRepoFile("scripts/gw-smoke.py");

        Assert.Contains("_sse_req", script);
        Assert.Contains("\"/stream\"", script);
        Assert.Contains("stream[chat]", script);
        Assert.Contains("\"/client-stream\"", script);
        Assert.Contains("client-stream[chat]", script);
        Assert.Contains("\"Messages\": [{\"Role\": \"user\", \"Content\": \"ping, client stream reply OK\"}]", script);
        Assert.Contains("GW_SMOKE_JSON_OUT", script);
        Assert.Contains("GW_SMOKE_REPORT_MD", script);
        Assert.Contains("\"verdict\": \"pass\" if passed == len(rows) else \"fail\"", script);
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
