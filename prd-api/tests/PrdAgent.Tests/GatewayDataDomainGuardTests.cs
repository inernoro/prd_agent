using System.Diagnostics;
using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// LLM Gateway 数据域守卫：MAP 业务日志继续归 MAP，GW serving 请求日志与 shadow 证据归 llm_gateway。
/// 这是 full-cutover S0.5 的硬前置，防止后续装配改动把证据重新写回 prdagent。
/// </summary>
public class GatewayDataDomainGuardTests
{
    [Fact]
    public void VisualCreation_AlwaysUsesDedicatedHttpGatewayForResolveAndSend()
    {
        var program = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");
        var client = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs");
        var httpGateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/HttpLlmGatewayClient.cs");

        Assert.Contains("ILogicalModelGateway : ILlmGateway", ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/ILogicalModelGateway.cs"));
        Assert.Contains("ILogicalModelGateway, CoreGateway.ILlmGateway", httpGateway);
        Assert.Contains("AddScoped<PrdAgent.Core.LlmGateway.ILogicalModelGateway>", program);
        Assert.Contains("private readonly ILogicalModelGateway _servingGateway", client);
        Assert.Contains("HttpLlmGatewayClient servingGateway", client);
        Assert.True(
            client.Split("var requestGateway = _servingGateway;", StringSplitOptions.None).Length - 1 == 2,
            "文生图与多图生图都必须直接选择独立 Gateway HTTP 边界");
        Assert.DoesNotContain("private readonly ILlmGateway _gateway", client);
        Assert.DoesNotContain("private readonly ILogicalModelGateway _logicalModelGateway", client);
        Assert.DoesNotContain("_gateway.ResolveRequiredLogicalModelAsync", client);
        Assert.DoesNotContain("_gateway.SendRawWithResolutionAsync", client);
        Assert.Contains("requestGateway.ResolveRequiredLogicalModelAsync", client);
        Assert.Contains("requestGateway.SendRawWithResolutionAsync", client);
    }

    [Fact]
    public void ImageGeneration_UserFacingFailuresAlwaysUseTheNormalizationBoundary()
    {
        var client = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs");
        var controller = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs");
        var normalizer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenerationUserError.cs");
        var rule = ReadRepoFile(".Codex/rules/user-readable-errors.md");

        Assert.Contains("ImageGenerationUserError.FromGateway", client);
        Assert.Contains("ImageGenerationUserError.FromException", client);
        Assert.DoesNotContain("ApiResponse<ImageGenResult>.Fail(\"NETWORK_ERROR\", ex.Message)", client);
        Assert.DoesNotContain("ApiResponse<ImageGenResult>.Fail(ErrorCodes.LLM_ERROR, ex.Message)", client);
        Assert.DoesNotContain("Vision API 错误:", client);
        Assert.DoesNotContain("请求失败: HTTP", client);
        Assert.DoesNotContain("errorMessage = ex.Message", controller);
        Assert.Contains("errorCode = ErrorCodes.IMAGE_GEN_UNAVAILABLE", controller);
        Assert.Contains("原始响应只允许进入服务端日志", normalizer);
        Assert.Contains("禁止向普通用户透传上游响应原文", rule);
    }

    [Fact]
    public void WorkloadIdentity_IsServerDerivedFilterableAndNeverStoresKeyMaterialInRequestLog()
    {
        var logModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs");
        var serving = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var servingProgram = ReadRepoFile("llmgw/serving/Program.cs");
        var logWriter = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var activity = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");

        Assert.Contains("public string? ServiceKeyId", logModel);
        Assert.Contains("public string? ClientCode", logModel);
        Assert.Contains("public string? Environment", logModel);
        Assert.Contains("public string? ServiceKeyPrefix", logModel);
        Assert.DoesNotContain("public string? KeyHash", logModel);
        Assert.Contains("ingress.Context.ServiceKeyId = authorization.KeyId", serving);
        Assert.Contains("ingress.Context.ClientCode = authorization.ClientCode", serving);
        Assert.Contains("fb.Eq(\"ServiceKeyId\", serviceKeyId.Trim())", console);
        Assert.Contains("fb.Eq(\"ClientCode\", clientCode.Trim())", console);
        Assert.Contains("filterClientCode", activity);
        Assert.Contains("filterEnvironment", activity);
        Assert.Contains("filterServiceKeyId", activity);
        Assert.Contains("LlmRequestLogContextItems.LifecycleStarted", serving);
        Assert.Contains("MarkLifecycleStarted();", logWriter);
        Assert.Contains("sp.GetRequiredService<IHttpContextAccessor>()", servingProgram);
    }

    [Fact]
    public void CostEvidenceAndLegacyCutover_AreTenantScopedAuditableAndFailClosed()
    {
        var logModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs");
        var costEvidence = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmCostEvidence.cs");
        var logBackground = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogBackground.cs");
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        var governanceRecords = ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayGovernanceRecords.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var runtime = ReadRepoFile("llmgw/serving/GatewayRuntimeGovernance.cs");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var dtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var costPolicy = ReadRepoFile("llmgw/console-api/Costs/CostReconciliationPolicy.cs");

        Assert.Contains("public string? PriceSnapshotHash", logModel);
        Assert.Contains("public string? ProviderRequestId", logModel);
        Assert.Contains("public decimal? ProviderReportedCost", logModel);
        var importDto = dtos[dtos.IndexOf("class CostReconciliationImportRequest", StringComparison.Ordinal)..dtos.IndexOf("class CostReconciliationItem", StringComparison.Ordinal)];
        Assert.Contains("public decimal? ProviderReportedCost", importDto);
        Assert.Contains("SHA256.HashData", costEvidence);
        Assert.Contains("LlmCostEvidence.ResolveProviderRequestId(done.ResponseHeaders)", logBackground);
        Assert.True(System.Text.RegularExpressions.Regex.Matches(gateway, "LlmCostEvidence.BuildSafeResponseHeaders").Count >= 3);
        Assert.DoesNotContain("TenantId", dtos[dtos.IndexOf("class CostReconciliationImportRequest", StringComparison.Ordinal)..dtos.IndexOf("class CostReconciliationItem", StringComparison.Ordinal)]);
        Assert.Contains("BILLING_WINDOW_TEAM_AMBIGUOUS", console);
        Assert.Contains("BILLING_WINDOW_OVERLAP", console);
        Assert.Contains("PROVIDER_REQUEST_COVERED_BY_WINDOW", console);
        Assert.Contains("providerReportedCost is null", console);
        Assert.Contains("coveringWindowFilters.Add(Builders<BsonDocument>.Filter.Eq(\"ServiceKeyId\", BsonNull.Value))", console);
        Assert.Contains("BILLING_WINDOW_CONTAINS_RECONCILED_REQUEST", console);
        Assert.Contains("var actualAggregate = await costReconciliations.Aggregate()", console);
        Assert.Contains("var statusAggregate = await costReconciliations.Aggregate()", console);
        Assert.True(System.Text.RegularExpressions.Regex.Matches(console, "await ApplyMatchedRequestLogAsync\\(\\);").Count >= 2);
        Assert.Contains("Filter.Type(\"ProviderReportedCost\", BsonType.Decimal128)", console);
        Assert.Contains("{ \"TenantId\", access.TenantId }", console);
        Assert.Contains("{ \"TeamId\", reconciliationTeamId is null ? BsonNull.Value : reconciliationTeamId }", console);
        Assert.Contains("idx_llmgw_logs_tenant_provider_request", initializer);
        Assert.Contains("idx_llmgw_service_key_tenant_workload_purpose", initializer);
        Assert.Contains("idx_llmgw_service_key_tenant_workload_purpose", console);
        Assert.Contains("uniq_llmgw_cost_tenant_provider_external", initializer);
        Assert.Contains("uniq_llmgw_cost_tenant_provider_request", initializer);
        Assert.Contains("uniq_llmgw_cost_import_lock_tenant_provider_team", initializer);
        Assert.Contains("CostImportScopeLock.TryAcquireAsync", console);
        Assert.Contains("CostImportScopeLock.TryRenewAsync", console);
        Assert.Contains("CostImportScopeLock.ReleaseAsync", console);
        Assert.True(console.LastIndexOf("CostImportScopeLock.TryAcquireAsync", StringComparison.Ordinal)
                    < console.IndexOf("var overlapFilter", StringComparison.Ordinal));
        Assert.True(console.IndexOf("CostImportScopeLock.TryRenewAsync", StringComparison.Ordinal)
                    < console.IndexOf("await costReconciliations.InsertOneAsync(record)", StringComparison.Ordinal));
        Assert.Contains("Ascending(\"TenantId\").Ascending(\"TeamId\").Ascending(\"ServiceKeyId\")", initializer);
        Assert.Contains("return new(\"fx-unavailable\", null, null, null)", costPolicy);

        Assert.Contains("public string Purpose { get; set; } = string.Empty", governanceRecords);
        Assert.Contains("ROTATION_IDENTITY_MISMATCH", console);
        Assert.Contains("rotatedPurpose, purpose", console);
        Assert.Contains("GATEWAY_LEGACY_KEY_EXTERNAL_FORBIDDEN", runtime);
        Assert.Contains("x => x.TenantId == _internalTenantId", runtime);
        Assert.Contains("SuccessorObservationCounts", governanceRecords);
        Assert.Contains(".Inc($\"SuccessorObservationCounts.{record.Id}\", 1)", runtime);
        Assert.Contains("SuccessorObservationCounts.{successorId}", console);
        Assert.Contains("new BsonRegularExpression(\"^production$\", \"i\")", console);
        Assert.Contains("new BsonRegularExpression(\"^runtime$\", \"i\")", console);
        Assert.Contains("LegacySuccessorScopePolicy.FindMissing(successor.AsStringList(\"Scopes\"), requiredScopes)", console);
        Assert.Contains(".Set(\"RequiredScopes\", new BsonArray(requiredScopes))", console);
        Assert.Contains("record.Environment, \"production\"", runtime);
        Assert.Contains("GatewayKeyPurposePolicy.AllowsDataPlaneRequest", runtime);
        Assert.Contains("GATEWAY_KEY_PURPOSE_DENIED", runtime);
        Assert.Contains("GatewaySuccessorObservationPolicy.IsBusinessInvocationScope(serviceKeyScope)", runtime);
        Assert.Contains("LEGACY_REVOCATION_FINAL", console);
        Assert.Contains("TenantAccess.Filter(http)", console);
    }

    [Fact]
    public void ServiceKeyRotation_RequiresClientCutoverBeforeOldKeyRevocation()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var page = ReadRepoFile("llmgw/web/src/pages/ServiceKeysPage.tsx");

        Assert.Contains("/gw/service-keys/{id}/rotation/client-cutover", console);
        Assert.Contains("ROTATION_CLIENT_SWITCH_REQUIRED", console);
        Assert.Contains("ROTATION_SOURCE_STAGE_INVALID", console);
        Assert.Contains("string.IsNullOrWhiteSpace(successorId)", console);
        Assert.Contains("var legacySourceClientCode = rotatedKey.AsNullableString(\"SourceSystem\")", console);
        Assert.Contains("Regex.IsMatch(legacySourceClientCode", console);
        Assert.Contains(".Set(\"ClientCode\", clientCode)", console);
        Assert.Contains(".Set(\"Environment\", environment)", console);
        Assert.Contains("predecessorRotationState = !string.IsNullOrWhiteSpace(rotatedKey.AsNullableString(\"RotatesKeyId\"))", console);
        Assert.Contains("{ \"PredecessorRotationState\", predecessorRotationState is null ? BsonNull.Value : predecessorRotationState }", console);
        Assert.Contains(".Set(\"RotationState\", restoreState)", console);
        Assert.Contains("BsonDocument? stableSuccessor = null", console);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"IssuanceState\", \"creating\")", console);
        Assert.Contains(".Set(\"IssuanceState\", \"delivering\")", console);
        Assert.Contains("http.Response.OnCompleted(async () =>", console);
        Assert.Contains(".Set(\"IssuanceState\", \"issued\")", console);
        Assert.Contains("DateTime.UtcNow.AddSeconds(-30)", console);
        Assert.Contains("SERVICE_KEY_AUDIT_FAILED", console);
        Assert.Contains("throwOnFailure: true", console);
        Assert.Contains("await RollbackIssuanceAsync();", console);
        Assert.Contains("SERVICE_KEY_ISSUANCE_PENDING", console);
        Assert.Contains("轮换新密钥已被并发撤销", console);
        Assert.Contains("successorIdentityFilter & Builders<BsonDocument>.Filter.Eq(\"RotationState\", \"new-key-created\")", console);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"RotationState\", \"awaiting-client-cutover\")", console);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"RotationState\", \"abort-in-progress\")", console);
        Assert.Contains("service_key.rotation_abort", console);
        Assert.Contains("\"awaiting-client-cutover\"", console);
        Assert.Contains("\"client-switched\"", console);
        Assert.Contains("\"old-key-revoked\"", console);
        Assert.Contains("\"completed\"", console);
        Assert.Contains("确认已切换", page);
        Assert.Contains("撤销旧钥并完成", page);
        Assert.Contains("&& !item.rotatedByKeyId", page);
    }
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
    public void Serving_RuntimeData_UsesGatewayContext_WhileResolverKeepsOptionalMapFallbackContext()
    {
        var program = ReadRepoFile("llmgw/serving/Program.cs");

        Assert.Contains("builder.Services.AddSingleton(new MongoDbContext(mongoConn, mongoDb));", program);
        Assert.Contains("builder.Services.AddSingleton(new LlmGatewayDataContext(gatewayMongoConn, gatewayDb));", program);
        Assert.Contains("builder.Configuration[\"LlmGateway:MongoConnectionString\"]", program);
        Assert.Contains("new LlmRequestLogBackground(\n        sp.GetRequiredService<LlmGatewayDataContext>().Context", program);
        Assert.Contains("new LlmRequestLogWriter(\n        sp.GetRequiredService<LlmGatewayDataContext>().Context", program);
        Assert.Contains("new GatewayAppSettingsService(", program);
        Assert.Contains("AddHostedService<GatewayRuntimeSettingsInitializer>()", program);
        Assert.Contains("sp.GetRequiredService<LlmGatewayDataContext>().Context,\n        sp.GetRequiredService<ILogger<PrdAgent.Infrastructure.ModelPool.PoolFailoverNotifier>>()", program);
        Assert.Contains("new RegistryAssetStorage(inner, db, providerName, regLogger, \"llmgw_asset_registry\")", program);
        Assert.Contains("GetCollection<PrdAgent.Core.Models.LLMPlatform>(\"llmgw_platforms\")", program);
        Assert.DoesNotContain("AddSingleton<PrdAgent.Core.Interfaces.IAppSettingsService, PrdAgent.Infrastructure.Services.AppSettingsService>()", program);
        Assert.Contains("AddScoped<PrdAgent.Core.LlmGateway.IModelResolver, PrdAgent.Infrastructure.LlmGateway.ModelResolver>()", program);
    }

    [Fact]
    public void GatewayOwnedModelConfig_ModelsIgnoreExtraMetadataFields()
    {
        var modelGroup = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ModelGroup.cs");
        var modelExchange = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ModelExchange.cs");

        Assert.Contains("using MongoDB.Bson.Serialization.Attributes;", modelGroup);
        Assert.Contains("[BsonIgnoreExtraElements]\npublic class ModelGroup", modelGroup);
        Assert.Contains("using MongoDB.Bson.Serialization.Attributes;", modelExchange);
        Assert.Contains("[BsonIgnoreExtraElements]\npublic class ModelExchange", modelExchange);
    }

    [Fact]
    public void ShadowReadEndpoints_UseGatewayDatabase()
    {
        var servingEndpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var smoke = ReadRepoFile("scripts/gw-smoke.py");

        Assert.Contains("services.GetService<LlmGatewayDataContext>()?.Context", servingEndpoints);
        Assert.Contains("var logs = gatewayDatabase.GetCollection<BsonDocument>(\"llmrequestlogs\");", consoleProgram);
        Assert.DoesNotContain("var logs = mapDatabase.GetCollection<BsonDocument>(\"llmrequestlogs\");", consoleProgram);
        Assert.Contains("var shadows = gatewayDatabase.GetCollection<BsonDocument>(\"llmshadow_comparisons\");", consoleProgram);
        Assert.DoesNotContain("var shadows = mapDatabase.GetCollection<BsonDocument>(\"llmshadow_comparisons\");", consoleProgram);
        Assert.Contains("Builders<BsonDocument>.Filter.Ne(\"IsHealthProbe\", true)", consoleProgram);
        Assert.Contains("\"IsHealthProbe\": True", smoke);
        Assert.Contains("bool? IsHealthProbe = null", ReadRepoFile("prd-api/src/PrdAgent.Core/Interfaces/ILLMRequestContextAccessor.cs"));
        Assert.Contains("IsHealthProbe: ctx?.IsHealthProbe", servingEndpoints);
        Assert.Contains("IsHealthProbe = current?.IsHealthProbe", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/HttpLlmClient.cs"));
        Assert.Contains("IsHealthProbe = scopeCtx?.IsHealthProbe", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayLLMClient.cs"));
        Assert.Contains("var runId = ResolveCompatRunId(http, body)", servingEndpoints);
        Assert.Contains("RunId = runId", servingEndpoints);
        Assert.Contains("ResolveHeader(http, \"X-Gateway-Run-Id\")", servingEndpoints);
        Assert.Contains("RunId = d.AsNullableString(\"RunId\")", consoleProgram);
        Assert.Contains("string? releaseCommit,\n    string? runId, string? requestId, string? sessionId", consoleProgram);
        Assert.Contains("fb.Eq(\"RunId\", runId.Trim())", consoleProgram);
        Assert.Contains("fb.Eq(\"RequestId\", requestId.Trim())", consoleProgram);
        Assert.Contains("fb.Eq(\"SessionId\", sessionId.Trim())", consoleProgram);
        Assert.Contains("LastObservedRequestId", servingEndpoints);
        Assert.Contains("LastObservedSessionId", servingEndpoints);
        Assert.Contains("LastObservedRunId", servingEndpoints);
        Assert.Contains("private static AppCallerStatusDecision CheckAppCallerStatus", servingEndpoints);
        Assert.Contains("GatewayAppCallerPolicy.AllowsTraffic(normalized)", servingEndpoints);
        Assert.Contains("APP_CALLER_DISABLED", servingEndpoints);
        Assert.Contains("StatusCodes.Status403Forbidden", servingEndpoints);
        Assert.Contains("if (decision.Status.Rejected)", servingEndpoints);
        Assert.Contains("if (await TryWriteGovernanceErrorAsync(http, governance)) return;", servingEndpoints);
        Assert.Contains("var governanceResult = GovernanceResult(http, governance, jsonOpts);", servingEndpoints);
        Assert.Contains("app.MapPost(\"/gw/v1/profile-test\", async (\n            HttpContext http,", servingEndpoints);
        Assert.Contains("RequestId = requestId", servingEndpoints);
        Assert.Contains("Context = profileContext", servingEndpoints);
        Assert.Contains("GatewayTransport = GatewayTransports.Http", servingEndpoints);
        Assert.Contains("AppCallerTitle = profileTitle", servingEndpoints);
        Assert.Contains("PinnedModelId = profileRequest.Model", servingEndpoints);
        Assert.Contains("gateway.TestUpstreamProfileAsync(profileRequest, cancellation?.Token ?? CancellationToken.None)", servingEndpoints);
        Assert.Contains("public GatewayRequestContext? Context { get; init; }", ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayRequest.cs"));
        Assert.Contains("SourceSystem = sourceContext?.SourceSystem", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs"));
        Assert.Contains("IngressProtocol = sourceContext?.IngressProtocol", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs"));
        var runtimeProfileService = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs");
        Assert.Contains("Context = new GatewayRequestContext", runtimeProfileService);
        Assert.Contains("SourceSystem = \"map\"", runtimeProfileService);
        Assert.Contains("ModelPolicy = \"pinned\"", runtimeProfileService);
        Assert.Contains("LastObservedRequestId = d.AsNullableString(\"LastObservedRequestId\")", consoleProgram);
        Assert.Contains("fb.Regex(\"LastObservedRequestId\", pattern)", consoleProgram);
        Assert.Contains("ValidateActiveGatewayAppCallerConfigAsync", consoleProgram);
        Assert.Contains("ObservedIngressProtocols", ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayRequest.cs"));
        Assert.Contains(".AddToSet(x => x.ObservedIngressProtocols, ingressProtocol)", servingEndpoints);
        Assert.Contains("ObservedIngressProtocols = GetObservedIngressProtocols(d)", consoleProgram);
        Assert.Contains("fb.AnyEq(\"ObservedIngressProtocols\"", consoleProgram);
        Assert.Contains("active appCaller 必须绑定 llm_gateway.llmgw_model_pools", consoleProgram);
        Assert.Contains("active appCaller 必须使用 modelPolicy=auto/pool/pinned", consoleProgram);
        var modelResolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        Assert.DoesNotContain("active-appcaller-auto-policy-without-gateway-pool", modelResolver);
        Assert.Contains("allowMapFallback: !gatewayConfigRequired", modelResolver);
        Assert.Contains("TryGetGatewayRegistryGroupsAsync", modelResolver);
        Assert.Contains("GatewayAppCallerPolicy.AllowsTraffic", modelResolver);
        Assert.Contains("FindGatewayOwnedDefaultModelPoolsAsync", modelResolver);
        Assert.Contains("gatewayRegistry.TrafficRejected", modelResolver);
        Assert.Contains("DisableMapConfigFallbackForRegisteredAppCallers", modelResolver);
        Assert.Contains("if (!gatewayConfigRequired)", modelResolver);
        Assert.True(
            modelResolver.IndexOf("if (!gatewayConfigRequired)", StringComparison.Ordinal)
            < modelResolver.IndexOf("_db.LLMAppCallers", StringComparison.Ordinal),
            "GW-only 模式必须在任何 MAP appCaller 查询前短路");
        Assert.True(
            modelResolver.IndexOf("gatewayRegistry.Groups.Count == 0 && gatewayConfigRequired", StringComparison.Ordinal)
            < modelResolver.IndexOf("var pinned = await TryResolvePinnedModelAsync", StringComparison.Ordinal),
            "GW-only 模式必须先拒绝缺失专用池，再处理 pinned 精确模型，避免绕过 appCaller 治理边界");
        Assert.Contains("FindGatewayOwnedOrMapPlatformAsync(platformId, enabledOnly: true, ct, allowMapFallback)", modelResolver);
        Assert.Contains("normalized-to-supported-model-policy", consoleProgram);
        Assert.Contains("IsSupportedAppCallerModelPolicy(currentModelPolicy)", consoleProgram);
        Assert.Contains("路由策略保留或补齐为 {targetModelPolicy}", consoleProgram);
        Assert.Contains("HasUsableGatewayPoolMemberAsync", consoleProgram);
        Assert.Contains("m.AsNullableBool(\"Enabled\") ?? true", consoleProgram);
        Assert.Contains("string.Equals(m.AsNullableString(\"DisplayName\"), modelId, StringComparison.Ordinal)", consoleProgram);
        Assert.Contains("gw-pool-without-usable-member", consoleProgram);
        Assert.Contains("没有可解析、非 unavailable 的成员", consoleProgram);
        Assert.Contains("ActiveWithUsableGatewayPool", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("ActiveBoundPoolWithoutUsableMember", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("activeBoundPoolWithoutUsableMember == 0", consoleProgram);
        Assert.Contains("activeAppCallerMapFallbackCutoverPrerequisitesReady", consoleProgram);
        Assert.Contains("http-full 阶段会开启运行态 fail-closed 开关", consoleProgram);
        Assert.Contains("currentCommitHttpTransportReady", consoleProgram);
        Assert.Contains("pre-http shadow/seed 日志不阻断进入 http-full", consoleProgram);
        Assert.Contains("activeBoundPoolWithoutUsableMember", ReadRepoFile("scripts/llmgw-release-gate.py"));
        Assert.Contains("activeBoundPoolWithoutUsableMember", ReadRepoFile("scripts/llmgw-config-authority-apply.py"));
        Assert.Contains("activeBoundPoolWithoutUsableMember", ReadRepoFile("scripts/llmgw-rollout-ledger.py"));
        Assert.Contains("默认模型池必须至少包含一个可用成员", consoleProgram);
        Assert.Contains("DEFAULT_POINTER_REQUIRED", consoleProgram);
        Assert.Contains("DefaultPoolId", consoleProgram);
        Assert.Contains("action: \"pool.set_default\"", consoleProgram);
        Assert.Contains("ValidateDefaultGatewayPoolMembersAsync", consoleProgram);
        Assert.Contains("默认模型池必须保留至少一个可用成员", consoleProgram);
        Assert.Contains("TenantAccess.FilterTeamScope(http, logFilter)", consoleProgram);
        Assert.Contains("fb.Eq(\"ModelPoolId\", modelPoolId.Trim())", consoleProgram);
        Assert.Contains("action: \"pool.models.bulk_import\"", consoleProgram);
        Assert.Contains("action: wasExisting ? \"pool.model.update\" : \"pool.model.add\"", consoleProgram);
        Assert.Contains("action: \"pool.model.remove\"", consoleProgram);
        Assert.Contains("ValidateBulkActiveGatewayAppCallerConfigAsync", consoleProgram);
        var logsTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        Assert.Contains("runId?: string", logsTypes);
        Assert.Contains("requestId?: string", logsTypes);
        Assert.Contains("sessionId?: string", logsTypes);
        Assert.Contains("lastObservedRequestId?: string | null", logsTypes);
        Assert.Contains("lastObservedSessionId?: string | null", logsTypes);
        Assert.Contains("lastObservedRunId?: string | null", logsTypes);
        Assert.Contains("observedIngressProtocols?: string[]", logsTypes);
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");
        Assert.Contains("runId: filterRunId.trim() || undefined", logsView);
        Assert.Contains("requestId: filterRequestId.trim() || undefined", logsView);
        Assert.Contains("sessionId: filterSessionId.trim() || undefined", logsView);
        Assert.Contains("initialQueryValue('requestId')", logsView);
        var appCallersPage = ReadRepoFile("llmgw/web/src/pages/AppCallersPage.tsx");
        Assert.Contains("logsHref('requestId', item.lastObservedRequestId)", appCallersPage);
        Assert.Contains("logsHref('sessionId', item.lastObservedSessionId)", appCallersPage);
        Assert.Contains("logsHref('runId', item.lastObservedRunId)", appCallersPage);
        Assert.Contains("item.observedIngressProtocols?.length", appCallersPage);
        Assert.Contains("RunId = string.IsNullOrWhiteSpace(start.RunId) ? null : start.RunId.Trim()", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs"));
    }

    [Fact]
    public void ProgramPoolRegistry_UsesTenantScopedAtomicPointerAndAppendOnlyManagedPools()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var registry = ReadRepoFile("llmgw/console-api/ModelPools/GatewayModelPoolTypeRegistry.cs");
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var page = ReadRepoFile("llmgw/web/src/pages/ModelPoolsPage.tsx");

        Assert.Contains("llmgw_model_pool_types", console);
        Assert.Contains("fb.Eq(\"TenantId\", tenantId), fb.Eq(\"Code\", modelType)", console);
        Assert.Contains("FindOneAndUpdateAsync", console);
        Assert.Contains("DefaultSwitchPendingUntil", console);
        Assert.Contains("PoolVersionGuard", console);
        Assert.Contains("APPEND_ONLY_POOL", console);
        Assert.Contains("Builders<BsonDocument>.Update.Push(\"Models\"", console);
        Assert.Contains("if (IsManagedAppendOnlyPool(poolDoc)) continue;", console);
        Assert.Contains("GatewayModelPoolTypeRegistry.IsCompatible(modelDoc, poolModelType)", console);
        Assert.Contains("MODEL_DISABLED", console);
        Assert.Contains("PLATFORM_DISABLED", console);
        Assert.Contains("modelId = modelDoc.AsNullableString(\"ModelName\") ?? modelDoc.AsNullableString(\"Name\") ?? modelDoc.GetStringOrEmpty(\"_id\")", console);
        Assert.DoesNotContain("!Flag(model, \"IsImageGen\")", registry);
        Assert.Contains("GetCollection<BsonDocument>(\"llmgw_model_pool_types\")", resolver);
        Assert.Contains("PinnedModel 不在 appCaller 专用模型池内", resolver);
        Assert.Contains("有则增加，无则不变", page);
        Assert.Contains("按平台规则补齐", page);
        Assert.Contains("pool.appendOnly ? 'compatible' : filterMode", page);
        Assert.Contains("已过滤已有成员与不匹配模型", page);
        Assert.Contains("return false;", page);
    }

    [Fact]
    public void Console_ExposesProtocolCoverageFromGatewayLogsAndRegistry()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var consoleDtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var webApi = ReadRepoFile("llmgw/web/src/lib/api.ts");
        var webTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var overviewPage = ReadRepoFile("llmgw/web/src/pages/OverviewPage.tsx");
        var protocolAudit = ReadRepoFile("scripts/llmgw-protocol-router-audit.py");
        var protocolCanary = ReadRepoFile("scripts/llmgw-protocol-canary.py");

        Assert.Contains("public sealed class ProtocolCoverageData", consoleDtos);
        Assert.Contains("public sealed class ProtocolCoverageItem", consoleDtos);
        Assert.Contains("DroppedParameterRequests", consoleDtos);
        Assert.Contains("app.MapGet(\"/gw/protocol-coverage\"", consoleProgram);
        Assert.Contains("TargetIngressProtocols", consoleProgram);
        Assert.Contains("NormalizeIngressProtocol", consoleProgram);
        Assert.Contains("GetObservedIngressProtocols", consoleProgram);
        Assert.Contains("Where(d => GetObservedIngressProtocols(d).Contains(protocol.Key", consoleProgram);
        Assert.Contains("IsRuntimeGovernedAppCallerStatus", consoleProgram);
        Assert.Contains("HasDroppedParameters", consoleProgram);
        Assert.Contains("protocol_runtime_coverage", consoleProgram);
        Assert.Contains("appcaller_ingress_registry_coverage", consoleProgram);
        Assert.Contains(".Include(\"ObservedIngressProtocols\")", consoleProgram);
        Assert.Contains("registryObservedProtocols", consoleProgram);
        Assert.Contains("missingRegistryProtocols", consoleProgram);
        Assert.Contains("missingIngressProtocols", consoleProgram);
        Assert.Contains("/gw/protocol-coverage?releaseCommit=", consoleProgram);
        Assert.Contains("Builders<BsonDocument>.Filter.Ne(\"IsHealthProbe\", true)", consoleProgram);
        Assert.Contains("GetCollection<BsonDocument>(\"llmgw_app_callers\")", consoleProgram);
        Assert.Contains("GetCollection<BsonDocument>(\"llmrequestlogs\")", consoleProgram);
        Assert.Contains("ProtocolCoverageData", webTypes);
        Assert.Contains("ProtocolCoverageItem", webTypes);
        Assert.Contains("getProtocolCoverage", webApi);
        Assert.Contains("getProtocolCoverage({ releaseCommit: protocolReleaseCommit, sinceHours: 24 })", overviewPage);
        Assert.Contains("new URLSearchParams(window.location.search).get('releaseCommit')", overviewPage);
        Assert.Contains("ProtocolCoveragePanel", overviewPage);
        Assert.Contains("协议入口覆盖", overviewPage);
        Assert.Contains("case 'protocol_runtime_coverage':", overviewPage);
        Assert.Contains("case 'appcaller_ingress_registry_coverage':", overviewPage);
        Assert.Contains("appcaller_ingress_registry_coverage: [", overviewPage);
        Assert.Contains("protocolCanaryRequired", overviewPage);
        Assert.Contains("protocolCanaryJson", overviewPage);
        Assert.Contains("app.MapGet(\\\"/gw/protocol-coverage\\\"", protocolAudit);
        Assert.Contains("ProtocolCoveragePanel", protocolAudit);
        Assert.Contains("protocol_runtime_coverage", protocolAudit);
        Assert.Contains("LLM Gateway four-protocol runtime canary", protocolCanary);
        Assert.Contains("appCaller ingress registry coverage", protocolCanary);
        Assert.Contains("TARGET_PROTOCOLS = (\"gw-native\", \"openai-compatible\", \"claude-compatible\", \"gemini-compatible\")", protocolCanary);
        Assert.Contains("parser.add_argument(\"--execute\", action=\"store_true\"", protocolCanary);
        Assert.Contains("dry-run only; add --execute to create runtime logs", protocolCanary);
        Assert.DoesNotContain("IsHealthProbe", protocolCanary);
        Assert.Contains("X-Gateway-Model-Policy", protocolCanary);
        Assert.Contains("LLMGW_PROTOCOL_CANARY_JSON_OUT", protocolCanary);
        Assert.Contains("--max-runtime-calls", protocolCanary);
        Assert.Contains("LLMGW_PROTOCOL_CANARY_MAX_RUNTIME_CALLS", protocolCanary);
        Assert.Contains("--no-reuse-existing", protocolCanary);
        Assert.Contains("--allow-empty-expect-commit", protocolCanary);
        Assert.Contains("_existing_report_covers", protocolCanary);
        Assert.Contains("reusedExisting=true; no runtime LLM calls were created", protocolCanary);
        Assert.Contains("missing --expect-commit for --execute", protocolCanary);
        Assert.Contains("selected protocols exceed --max-runtime-calls", protocolCanary);
    }

    [Fact]
    public void ConsoleWriteOperations_AreAuditedToGatewayDatabase()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("var operationAudits = gatewayDatabase.GetCollection<BsonDocument>(\"llmgw_operation_audits\");", consoleProgram);
        Assert.Contains("WriteOperationAuditAsync", consoleProgram);
        Assert.Contains("action: \"auth.change_password\"", consoleProgram);
        Assert.Contains("action: \"platform.set_enabled\"", consoleProgram);
        Assert.Contains("action: \"model.set_enabled\"", consoleProgram);
        Assert.Contains("action: \"pool.set_default\"", consoleProgram);
        Assert.Contains("WriteSystemOperationAuditAsync", consoleProgram);
        Assert.Contains("\"admin.env_authority_reconcile\" : \"admin.force_reset\"", consoleProgram);
        Assert.Contains("\"admin.env_authority_bootstrap\" : \"admin.force_reset_bootstrap\"", consoleProgram);
        Assert.Contains("if (!passwordDrifted && !activeDrifted && !mustChangeDrifted && !ownershipDrifted)", consoleProgram);
        Assert.Contains("var securityStateChanged = passwordDrifted || activeDrifted || mustChangeDrifted;", consoleProgram);
        Assert.Contains("action: \"admin.bootstrap\"", consoleProgram);
        Assert.Contains("action: \"admin.reactivate\"", consoleProgram);
        Assert.Contains("\"team.create\"", consoleProgram);
        Assert.Contains("\"membership.create\"", consoleProgram);
        Assert.Contains("\"membership.update\"", consoleProgram);
        Assert.DoesNotContain("action: \"admin.deactivate_legacy_users\"", consoleProgram);
        Assert.Contains("Console.Error.WriteLine($\"[LlmGw] operation audit write failed:", consoleProgram);
        Assert.Contains("Console.Error.WriteLine($\"[LlmGw] system operation audit write failed:", consoleProgram);
        Assert.DoesNotContain("mapDatabase.GetCollection<BsonDocument>(\"llmgw_operation_audits\")", consoleProgram);
    }

    [Fact]
    public void OrganizationConsole_ExposesExistingTenantScopedMembershipLifecycle()
    {
        var webApi = ReadRepoFile("llmgw/web/src/lib/api.ts");
        var webTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var organizationPage = ReadRepoFile("llmgw/web/src/pages/OrganizationPage.tsx");
        var consoleLayout = ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx");
        var accessRules = ReadRepoFile("llmgw/web/src/lib/access.ts");
        var changePasswordPage = ReadRepoFile("llmgw/web/src/pages/ChangePasswordPage.tsx");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var localPasswordPolicy = ReadRepoFile("llmgw/console-api/Auth/LocalPasswordPolicy.cs");
        var membershipPolicy = ReadRepoFile("llmgw/console-api/Organization/MembershipPolicy.cs");

        Assert.Contains("export function createMember", webApi);
        Assert.Contains("'/members'", webApi);
        Assert.Contains("export function updateMember", webApi);
        Assert.Contains("/invalidate-sessions", webApi);
        Assert.Contains("export type CreateMemberRequest", webTypes);
        Assert.Contains("export type UpdateMemberRequest", webTypes);
        Assert.Contains("expectedVersion: number", webTypes);
        Assert.Contains("添加成员", organizationPage);
        Assert.Contains("已创建；首次登录时必须设置自己的密码", organizationPage);
        Assert.Contains("强制重新登录", organizationPage);
        Assert.Contains("只有 Owner 可以修改 Owner", organizationPage);
        Assert.Contains("canUseCapability(sessionTenant?.role, 'organizationWrite')", organizationPage);
        Assert.Contains("expectedVersion: member.version", organizationPage);
        Assert.Contains("memberInitialPassword.length < 12", organizationPage);
        Assert.Contains("memberRole === 'developer' && memberTeamIds.length === 0", organizationPage);
        Assert.Contains("team.status === 'active' || selected.includes(team.id)", organizationPage);
        Assert.Contains("不能在这里修改自己", organizationPage);
        Assert.Contains("canAccessPage(tenant, item.page)", consoleLayout);
        Assert.Contains("organization: { capability: 'logsRead' }", accessRules);
        Assert.DoesNotContain("tenantId:", organizationPage);
        Assert.Contains("新口令至少 12 位", changePasswordPage);
        Assert.DoesNotContain("admin/admin", changePasswordPage);
        // 口令长度下限改由 LocalPasswordPolicy 单点权威（改密、设置口令、登录名校验
        // 三处共用），Program.cs 不再内联那个 12。判据跟着改成「走没走共享判定源 +
        // 那个源上的值是不是 12」——比原来钉死一行字面量更强：既挡住有人把下限改小，
        // 也挡住有人绕开策略类再写一遍自己的判断（.claude/rules 形状 3/4a）。
        Assert.Contains("LocalPasswordPolicy.MeetsMinimumLength(newPwd)", consoleProgram);
        Assert.Contains("\"WEAK_PASSWORD\"", consoleProgram);
        Assert.Contains("新口令至少 {LocalPasswordPolicy.MinPasswordLength} 位", consoleProgram);
        Assert.Contains("public const int MinPasswordLength = GwPasswordPolicy.MinimumLength;", localPasswordPolicy);
        Assert.Contains("GwPasswordPolicy.MeetsMinimumLength(initialPassword)", consoleProgram);
        Assert.Contains("PASSWORD_MANAGED_BY_DEPLOYMENT", consoleProgram);
        Assert.Contains("body.ExpectedVersion != membership.Version", consoleProgram);
        Assert.Contains("x.Version == previousVersion", consoleProgram);
        Assert.Contains("DEVELOPER_TEAM_REQUIRED", consoleProgram);
        Assert.Contains("SELF_MEMBERSHIP_CHANGE_FORBIDDEN", consoleProgram);
        Assert.Contains("SELF_SESSION_INVALIDATION_FORBIDDEN", consoleProgram);
        Assert.Contains("MembershipPolicy.RemovesActiveOwner", consoleProgram);
        Assert.Contains("MembershipPolicy.HasUsableDeveloperScope", consoleProgram);
        Assert.Contains("MembershipPolicy.TryCanonicalizeUsername", consoleProgram);
        Assert.Contains("MembershipPolicy.AllowsIdempotentReplay", consoleProgram);
        Assert.Contains("MEMBERSHIP_PROVISIONING_INCOMPLETE", consoleProgram);
        Assert.Contains("USERNAME_UNAVAILABLE", consoleProgram);
        Assert.Contains("\"beforeTeamIds\"", consoleProgram);
        Assert.Contains("\"teamIds\", new BsonArray(membership.TeamIds)", consoleProgram);
        Assert.Contains("BeginRequiredOperationAuditAsync", consoleProgram);
        Assert.Contains("CompleteRequiredOperationAuditAsync", consoleProgram);
        Assert.Contains("{ \"State\", \"pending\" }", consoleProgram);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"TenantId\", tenantId)", consoleProgram);
        Assert.Contains("^[a-z0-9][a-z0-9._-]{2,47}$", membershipPolicy);
        Assert.Contains("teamIds.All(activeTeamIds.Contains)", membershipPolicy);
        Assert.Contains("MaxCanonicalUsernameLength = 128", membershipPolicy);
    }

    [Fact]
    public void EnvironmentAuthority_UsesTheSamePasswordPolicyAsInteractiveAccounts()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var passwordPolicy = ReadRepoFile("llmgw/console-api/Auth/GwPasswordPolicy.cs");
        var localPasswordPolicy = ReadRepoFile("llmgw/console-api/Auth/LocalPasswordPolicy.cs");

        Assert.Contains("public const int MinimumLength = 12", passwordPolicy);
        Assert.Contains("Environment.GetEnvironmentVariable(\"LLMGW_ADMIN_PASSWORD\")?.Trim()", consoleProgram);
        Assert.Contains("GwPasswordPolicy.MeetsMinimumLength(adminBootstrapPwd)", consoleProgram);
        Assert.Contains("LocalPasswordPolicy.MeetsMinimumLength(newPwd)", consoleProgram);
        Assert.Contains("GwPasswordPolicy.MeetsMinimumLength(initialPassword)", consoleProgram);
        Assert.Contains("public const int MinPasswordLength = GwPasswordPolicy.MinimumLength;", localPasswordPolicy);
        Assert.Contains("GwPasswordPolicy.MeetsMinimumLength(password)", localPasswordPolicy);
        Assert.DoesNotContain("envAuthorityAdmin && (string.IsNullOrWhiteSpace(adminBootstrapPwd)", consoleProgram);
        Assert.DoesNotContain("adminBootstrapPwd!.Trim()", consoleProgram);
    }

    [Fact]
    public void EnvironmentAuthority_RejectsInteractiveAdminPasswordChanges()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("envAuthorityAdmin && string.Equals(user.Username, AdminUser, StringComparison.Ordinal)", consoleProgram);
        Assert.Contains("PASSWORD_MANAGED_BY_DEPLOYMENT", consoleProgram);
        Assert.Contains("该管理员口令由部署配置统一管理，当前页面不能修改。请联系系统管理员更新后重新登录。", consoleProgram);
        Assert.Contains("statusCode: 409", consoleProgram);
    }

    [Fact]
    public void TenantBoundaryPropagation_PreservesVerifiedTenantAndInternalLogFallback()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var logWriter = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs");

        Assert.Contains("GetMetadata<IAllowAnonymous>()", consoleProgram);
        Assert.True(
            endpoints.Split("TenantId = ingress.Context?.TenantId", StringSplitOptions.None).Length - 1 >= 2,
            "native 与 raw 路由重建都必须使用 service key 校验后写入的 ingress tenant");
        Assert.True(
            endpoints.Split("TeamId = ingress.Context?.TeamId", StringSplitOptions.None).Length - 1 >= 2,
            "native 与 raw 路由重建都必须使用 service key 校验后写入的 ingress team");
        Assert.Contains("TenantId = ResolveTenantId(start.TenantId)", logWriter);
        Assert.Contains("configuration[\"LlmGateway:InternalTenantId\"]", logWriter);
        Assert.Contains("? _internalTenantId", logWriter);
        Assert.Contains("GatewayTenantDefaults.InternalTenantId", logWriter);
        Assert.DoesNotContain("TenantId = start.TenantId ?? string.Empty", logWriter);
    }

    [Fact]
    public void InternalTenantFallbacks_UseConfigurationAcrossLogsShadowConcurrencyAndLegacyKeys()
    {
        var apiProgram = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");
        var shadow = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ShadowLlmGateway.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");

        Assert.Contains("configuration?[\"LlmGateway:InternalTenantId\"]", shadow);
        Assert.DoesNotContain("?? GatewayTenantDefaults.InternalTenantId", shadow);
        Assert.Contains("configuration?[\"LlmGateway:InternalTenantId\"]", gateway);
        Assert.Contains("string.IsNullOrWhiteSpace(tenantId) ? _internalTenantId : tenantId", gateway);
        Assert.Contains("app.Configuration[\"LlmGateway:InternalTenantId\"]", endpoints);
        Assert.Contains("TenantId: internalTenantId", endpoints);
        Assert.Contains("configuration: sp.GetRequiredService<IConfiguration>()", apiProgram);
    }

    [Fact]
    public void RawIdempotency_NormalizesVerifiedTenantContextBeforeFingerprinting()
    {
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var nativeStart = endpoints.IndexOf("app.MapPost(\"/gw/v1/raw\"", StringComparison.Ordinal);
        var compatStart = endpoints.IndexOf("private static async Task ExecuteRawWithIdempotencyAsync", StringComparison.Ordinal);

        Assert.True(nativeStart >= 0 && compatStart > nativeStart, "找不到 raw 幂等入口");
        Assert.True(
            endpoints.IndexOf("request = ApplyVerifiedRawRequestContext(http, request, ingress);", nativeStart, StringComparison.Ordinal)
            < endpoints.IndexOf("GatewayRequestExecutionStore.Fingerprint(request)", nativeStart, StringComparison.Ordinal),
            "native raw 必须在 fingerprint 前覆盖服务端 tenant/team");
        Assert.True(
            endpoints.IndexOf("request = ApplyVerifiedRawRequestContext(http, request, ingress);", compatStart, StringComparison.Ordinal)
            < endpoints.IndexOf("GatewayRequestExecutionStore.Fingerprint(request)", compatStart, StringComparison.Ordinal),
            "兼容 raw 必须在 fingerprint 前覆盖服务端 tenant/team");
        Assert.Contains("ingress.Context.TenantId = GetVerifiedTenantId(http)", endpoints);
        Assert.Contains("ingress.Context.TeamId = GetVerifiedTeamId(http)", endpoints);
    }

    [Fact]
    public void TeamRename_MapsTenantScopedUniqueNameCollisionToConflict()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var updateStart = consoleProgram.IndexOf("app.MapPut(\"/gw/teams/{id}\"", StringComparison.Ordinal);
        var memberStart = consoleProgram.IndexOf("app.MapPost(\"/gw/members\"", updateStart, StringComparison.Ordinal);
        var updateBlock = consoleProgram[updateStart..memberStart];

        Assert.Contains("x.Id == id && x.TenantId == access.TenantId", updateBlock);
        Assert.Contains("ServerErrorCategory.DuplicateKey", updateBlock);
        Assert.Contains("Fail(\"TEAM_CONFLICT\", \"当前租户已存在同名团队\")", updateBlock);
        Assert.Contains("jsonOptions, 409", updateBlock);
    }

    [Fact]
    public void ServiceKeyWrites_HaveDedicatedDeveloperPermissionWithoutConfigWrite()
    {
        var access = ReadRepoFile("llmgw/console-api/Auth/TenantAccessContext.cs");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var listStart = consoleProgram.IndexOf("app.MapGet(\"/gw/service-keys\"", StringComparison.Ordinal);
        var createStart = consoleProgram.IndexOf("app.MapPost(\"/gw/service-keys\"", StringComparison.Ordinal);
        var deleteStart = consoleProgram.IndexOf("app.MapDelete(\"/gw/service-keys/{id}\"", createStart, StringComparison.Ordinal);
        var shadowStart = consoleProgram.IndexOf("// 影子比对", deleteStart, StringComparison.Ordinal);

        Assert.Contains("public const string ServiceKeyWrite = \"service-key:write\"", access);
        Assert.Contains("LlmGwTenantRoles.Developer => permission is LogsRead or RequestBodyRead or UsageRead or AppCallerWrite or ServiceKeyWrite", access);
        Assert.DoesNotContain("LlmGwTenantRoles.Developer => permission is LogsRead or RequestBodyRead or UsageRead or ConfigWrite", access);
        Assert.Contains("options.AddPolicy(\"ServiceKeyWrite\"", consoleProgram);
        Assert.Contains("CreatedByUserId", consoleProgram[listStart..createStart]);
        Assert.Contains("RequireAuthorization(\"ServiceKeyWrite\")", consoleProgram[listStart..createStart]);
        Assert.Contains("CreatedByUserId", consoleProgram[createStart..deleteStart]);
        Assert.Contains("RequireAuthorization(\"ServiceKeyWrite\")", consoleProgram[createStart..deleteStart]);
        Assert.Contains("CreatedByUserId", consoleProgram[deleteStart..shadowStart]);
        Assert.Contains("RequireAuthorization(\"ServiceKeyWrite\")", consoleProgram[deleteStart..shadowStart]);
    }

    [Fact]
    public void ServingCidrGate_ConsumesOnlyTheProxyAppendedRightmostHop()
    {
        var servingProgram = ReadRepoFile("llmgw/serving/Program.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");

        Assert.Contains("options.ForwardLimit = 1", servingProgram);
        Assert.Contains("options.KnownNetworks.Clear()", servingProgram);
        Assert.Contains("options.KnownProxies.Clear()", servingProgram);
        Assert.True(
            servingProgram.IndexOf("app.UseForwardedHeaders()", StringComparison.Ordinal)
            < servingProgram.IndexOf("app.MapGatewayServingEndpoints", StringComparison.Ordinal),
            "CIDR 鉴权前必须先把代理追加的最右侧来源地址解析到 RemoteIpAddress");
        Assert.Contains("context.Connection.RemoteIpAddress", endpoints);
    }

    [Fact]
    public void NativeQuickstart_UsesTheSameSourceSystemInHeaderAndBody()
    {
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");

        Assert.Contains("X-Gateway-Source: external", quickstart);
        Assert.Contains("sourceSystem: 'external'", quickstart);
        Assert.Contains("context: { sourceSystem: 'external' }", quickstart);
        Assert.Contains("payload.success ?? payload.Success", quickstart);
        Assert.Contains("normalizeRoutePreview(payload, normalizedBaseUrl)", quickstart);
        Assert.Contains("preview.checkedBaseUrl !== normalizeBaseUrl(baseUrl)", quickstart);
        Assert.Contains("disabled={!realRouteReady || routeChecking}", quickstart);
        Assert.Contains("const snippetMode: TestMode", quickstart);
        Assert.Contains("X-Request-Id: \\$REQUEST_ID", quickstart);
        Assert.DoesNotContain("quickstart-curl", quickstart);
        Assert.Contains("/gw/v1/invoke", quickstart);
        Assert.Contains("VITE_LLMGW_SERVING_BASE_URL", quickstart);
        Assert.DoesNotContain("hostname.replace('-llmgw-web.', '.')", quickstart);
        Assert.Contains("return new URL(window.location.href).origin", quickstart);
        Assert.DoesNotContain("gateway.example.com", quickstart);

        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        Assert.Contains("SourceSystem = body.Context?.SourceSystem", endpoints);
        Assert.Contains("path.Equals(\"/gw/v1/resolve\", StringComparison.OrdinalIgnoreCase) ? headerSource : null", endpoints);
        Assert.DoesNotContain("|| path.Equals(\"/gw/v1/resolve\", StringComparison.OrdinalIgnoreCase);", endpoints);
        var resolveStart = endpoints.IndexOf("app.MapPost(\"/gw/v1/resolve\"", StringComparison.Ordinal);
        var resolveEnd = endpoints.IndexOf("async Task<IResult> HandleNativeInvokeAsync", resolveStart, StringComparison.Ordinal);
        Assert.True(resolveStart >= 0 && resolveEnd > resolveStart);
        Assert.DoesNotContain("RecordDiscoveredAppCallerAsync", endpoints[resolveStart..resolveEnd]);
        Assert.Contains("CanPreviewAppCallerForTeamAsync", endpoints[resolveStart..resolveEnd]);
        Assert.Contains("registered is null || string.Equals(registered.TeamId, requestedTeamId", endpoints);
    }

    [Fact]
    public void FinalPlatformAcceptance_UsesAuthenticatedTenantContextAndFourPublicProtocols()
    {
        var acceptance = ReadRepoFile("scripts/llmgw-prod-governance-acceptance.sh");
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");
        var home = ReadRepoFile("llmgw/web/src/pages/HomePage.tsx");

        Assert.Contains("$console_base/auth/login", acceptance);
        Assert.Contains("$console_base/auth/context", acceptance);
        Assert.Contains("TenantId: tenantId", acceptance);
        Assert.DoesNotContain("LLMGW_JWT_SECRET", acceptance);
        Assert.DoesNotContain("urlsafe_b64encode", acceptance);
        Assert.DoesNotContain("deleteMany({ AppCallerCode: caller })", acceptance);
        Assert.DoesNotContain("findOne({ AppCallerCode:", acceptance);

        foreach (var protocol in new[] { "GW Native", "OpenAI", "Claude", "Gemini" })
        {
            Assert.Contains($"label: '{protocol}'", quickstart);
            Assert.Contains($"'{protocol}'", home);
        }

        Assert.DoesNotContain("'OpenAI Chat'", home);
        Assert.DoesNotContain("'OpenAI Responses'", home);
    }

    [Fact]
    public void ProductionReleaseSafety_IsPersistedAsRuleDebtAndAgentTrigger()
    {
        var rule = ReadRepoFile("doc/rule.platform.production-release-safety.md");
        var debt = ReadRepoFile("doc/debt.platform.production-release.md");
        var agentRule = ReadRepoFile(".claude/rules/production-release-safety.md");
        var codexRule = ReadRepoFile(".Codex/rules/production-release-safety.md");
        var agents = ReadRepoFile("AGENTS.md");
        var hotfixSkill = ReadRepoFile(".claude/skills/production-hotfix-release/SKILL.md");
        var cdsDeploySkill = ReadRepoFile(".claude/skills/cds-deploy-pipeline/SKILL.md");
        var smokeSkill = ReadRepoFile(".claude/skills/smoke-test/SKILL.md");
        var acceptanceSkill = ReadRepoFile(".claude/skills/acceptance-checklist/SKILL.md");
        var handoffSkill = ReadRepoFile(".claude/skills/task-handoff-checklist/SKILL.md");

        Assert.Contains("公网 HTML 与入口资源是完成门", codexRule);
        Assert.Contains("doc/rule.platform.production-release-safety.md", agentRule);
        Assert.Contains("production-release-safety.md", agents);
        Assert.Contains("`GET /` 返回 200", rule);
        Assert.Contains("`umask 077`", rule);
        Assert.Contains("`./exec_dep.sh release` 的兼容合同是部署 latest", rule);
        Assert.Contains("自动恢复 previous", rule);
        Assert.Contains("首次把目录设置为 `700` 的具体进程无法从现有证据中确定", rule);
        Assert.Contains("2026-07-12-atomic-static-release", debt);
        Assert.Contains("2026-07-12-public-surface-smoke", debt);
        Assert.Contains("2026-07-12-release-command-compatibility", debt);
        Assert.Contains("2026-07-12-release-forensic-ledger", debt);
        foreach (var skill in new[] { hotfixSkill, cdsDeploySkill, smokeSkill, acceptanceSkill })
            Assert.Contains("doc/rule.platform.production-release-safety.md", skill);
        Assert.Contains("| 发布与运维 |", handoffSkill);
        Assert.Contains("部署、迁移、回滚、监控、开关、依赖和环境变量", handoffSkill);
        Assert.Contains("不得根据分支名、项目名或历史规律拼接 URL", handoffSkill);
        Assert.Contains("不得把密码写入仓库或公开报告", handoffSkill);
        Assert.Contains("API smoke 通过后继续使用 `preview-url` 与 `acceptance-checklist`", smokeSkill);
        Assert.Contains("实际入口 JS/CSS", hotfixSkill);
        Assert.Contains("previous/回滚验证", acceptanceSkill);
        Assert.Contains("只有证据支持时才写“已完成”", handoffSkill);
    }

    [Fact]
    public void ProductionStaticDist_RequiresEntryAssetsAndNormalizesPermissions()
    {
        var deploy = ReadRepoFile("exec_dep.sh");
        var validator = ReadRepoFile("scripts/validate-static-dist.sh");
        var behaviorTest = ReadRepoFile("scripts/tests/validate-static-dist.test.sh");

        Assert.Contains("[ ! -s \"$active_static_validation_root/index.html\" ]", deploy);
        Assert.Contains("scripts/validate-static-dist.sh --normalize \"$active_static_validation_root\"", deploy);
        Assert.Contains("pwd -P", validator);
        Assert.Contains("find \"$static_root\" -type d -exec chmod 755 {} +", validator);
        Assert.Contains("find \"$static_root\" -type f -exec chmod 644 {} +", validator);
        Assert.Contains("index.html does not reference a local JavaScript entry asset", validator);
        Assert.Contains("referenced entry asset is missing or empty", validator);
        Assert.Contains("umask 077", behaviorTest);
        Assert.Contains("expected missing index validation to fail", behaviorTest);
        Assert.Contains("expected missing entry asset validation to fail", behaviorTest);
    }

    [Fact]
    public void ProductionRelease_UsesAtomicStaticRollbackPublicSurfaceAndImmutableEvidence()
    {
        var deploy = ReadRepoFile("exec_dep.sh");
        var staticLayout = ReadRepoFile("scripts/lib/static-release.sh");
        var layoutTest = ReadRepoFile("scripts/tests/static-release-layout.test.sh");
        var publicSurface = ReadRepoFile("scripts/prd-agent-public-surface-smoke.py");
        var publicSurfaceTest = ReadRepoFile("scripts/tests/public-surface-smoke.test.py");
        var evidence = ReadRepoFile("scripts/prd-agent-release-evidence.py");
        var evidenceTest = ReadRepoFile("scripts/tests/release-evidence.test.py");
        var scheduledWatch = ReadRepoFile(".github/workflows/llmgw-shadow-watch.yml");

        Assert.Contains("[ \"$1\" = \"release\" ]", deploy);
        Assert.Contains("release_ref=\"latest\"", deploy);
        Assert.Contains("static_release_activate", deploy);
        Assert.Contains("Static release activated after service readiness", deploy);
        Assert.Contains("trap release_exit EXIT", deploy);
        Assert.Contains("static_release_rollback \"$active_static_root\"", deploy);
        Assert.Contains("scripts/prd-agent-public-surface-smoke.py", deploy);
        Assert.Contains("scripts/prd-agent-release-evidence.py", deploy);
        Assert.Contains("--asset-storage-readiness-json", deploy);
        Assert.DoesNotContain("rm -rf deploy/web/dist/*", deploy);
        var readinessIndex = deploy.LastIndexOf("wait_for_llmgw_serving_readiness", StringComparison.Ordinal);
        var activationIndex = deploy.LastIndexOf("activate_pending_static_release", StringComparison.Ordinal);
        Assert.True(readinessIndex >= 0 && activationIndex > readinessIndex);
        var storageReadinessIndex = deploy.LastIndexOf(
            "run_asset_storage_readiness",
            activationIndex,
            StringComparison.Ordinal);
        Assert.True(storageReadinessIndex > readinessIndex && activationIndex > storageReadinessIndex);

        Assert.Contains("os.replace(sys.argv[1], sys.argv[2])", staticLayout);
        Assert.Contains("STATIC_RELEASE_ROLLBACK_TARGET", staticLayout);
        Assert.Contains("$static_root/.releases", staticLayout);
        Assert.Contains("Static release layout test: PASS", layoutTest);
        Assert.Contains("main-page does not reference a same-origin JavaScript entry asset", publicSurface);
        Assert.Contains("main-page does not reference a same-origin CSS entry asset", publicSurface);
        Assert.Contains("api_identity_is_healthy", publicSurface);
        Assert.Contains("--expect-commit", deploy);
        Assert.Contains("llmgw-serving-health commit mismatch", publicSurface);
        Assert.Contains("Public surface smoke test: PASS", publicSurfaceTest);
        Assert.Contains("release evidence already exists and cannot be overwritten", evidence);
        Assert.Contains("static-before-mode", evidence);
        Assert.Contains("assetStorageReadiness", evidence);
        Assert.Contains("Release evidence test: PASS", evidenceTest);
        Assert.Contains("public-surface:", scheduledWatch);
        Assert.Contains("scripts/prd-agent-public-surface-smoke.py", scheduledWatch);
        Assert.Contains("name: public-surface-${{ github.run_id }}", scheduledWatch);
    }

    [Fact]
    public void TenantOverviewAndLearningCenter_AreTenantScopedAndExplainTheFullAccessChain()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var dtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var webApi = ReadRepoFile("llmgw/web/src/lib/api.ts");
        var webTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var home = ReadRepoFile("llmgw/web/src/pages/HomePage.tsx");
        var learning = ReadRepoFile("llmgw/web/src/pages/LearningCenterPage.tsx");
        var app = ReadRepoFile("llmgw/web/src/App.tsx");
        var layout = ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx");

        const string overviewSignature = "app.MapGet(\"/gw/overview\", async (HttpContext http, string? from, string? to) =>";
        var overviewStart = console.IndexOf(overviewSignature, StringComparison.Ordinal);
        var overviewEnd = console.IndexOf("app.MapGet(\"/gw/protocol-coverage\"", overviewStart, StringComparison.Ordinal);
        Assert.True(overviewStart >= 0 && overviewEnd > overviewStart, "找不到租户首页聚合端点");
        var overview = console[overviewStart..overviewEnd];

        Assert.Contains(overviewSignature, overview);
        Assert.Contains("TenantAccess.FilterTeamScope(http, fb.And(", overview);
        Assert.Contains("serviceKeys.Find(TenantAccess.FilterTeamScope(http, fb.Empty))", overview);
        Assert.Contains("BuildBusinessOperationFilter()", overview);
        Assert.Contains("fb.Ne(\"IsHealthProbe\", true)", console);
        Assert.Contains("from/to 必须是有效的 UTC 日期时间", overview);
        Assert.Contains("TenantAccess.HasPermission(http.User, LlmGwPermissions.LogsRead)", overview);
        Assert.Contains("RequireAuthorization(\"UsageRead\")", overview);
        Assert.DoesNotContain("string? tenantId", overview);
        Assert.DoesNotContain("EstimatedCostUsd = 0", overview);
        Assert.Contains("public sealed class TenantOverviewData", dtos);
        Assert.Contains("public sealed class ServiceKeyOverview", dtos);
        Assert.Contains("TenantOverviewData", webTypes);
        Assert.Contains("getTenantOverview", webApi);
        Assert.Contains("getTenantOverview({ from: from.toISOString(), to: to.toISOString() })", home);
        Assert.Contains("CNY 与 USD 不做无汇率相加", home);
        Assert.Contains("无请求时不显示 0%", home);

        Assert.Contains("path=\"/learn\"", app);
        Assert.Contains("to: '/learn', label: '学习中心'", layout);
        Assert.Contains("to=\"/learn\"", layout);
        foreach (var concept in new[] { "租户", "团队与用户", "appCaller", "租户接入密钥", "模型池", "模型", "Provider", "Exchange", "请求记录", "用量与费用" })
        {
            Assert.Contains(concept, learning);
        }
    }

    [Fact]
    public void PromptPolicy_IsTenantScopedChatVisionOnlyAndLogsMetadataWithoutPolicyBody()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        var serving = ReadRepoFile("llmgw/serving/GatewayPromptPolicyApplier.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var gatewayRequest = ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayRequest.cs");
        var logModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/LlmRequestLog.cs");
        var logDto = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var webTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var detailDrawer = ReadRepoFile("llmgw/web/src/components/GenerationDetailsDrawer.tsx");
        var promptPolicyPage = ReadRepoFile("llmgw/web/src/pages/PromptPolicyPage.tsx");
        var auditsPage = ReadRepoFile("llmgw/web/src/pages/AuditsPage.tsx");
        var usagePage = ReadRepoFile("llmgw/web/src/pages/UsagePage.tsx");

        Assert.Contains("uniq_llmgw_prompt_policy_tenant_caller_type_version", console);
        Assert.Contains("Builders<BsonDocument>.IndexKeys.Ascending(\"TenantId\").Ascending(\"AppCallerCode\").Ascending(\"RequestType\").Ascending(\"Version\")", console);
        const string teamIndex = "Builders<BsonDocument>.IndexKeys.Ascending(\"TenantId\").Ascending(\"TeamId\").Ascending(\"UpdatedAt\")";
        Assert.Contains(teamIndex, console);
        Assert.Contains(teamIndex, initializer);
        Assert.Contains("fb.Eq(\"TenantId\", tenantId)", serving);
        Assert.Contains("requestType is not (\"chat\" or \"vision\")", serving);
        Assert.DoesNotContain("GatewayPromptPolicyApplier.ApplyAsync(services, request, ingress)", endpoints);
        Assert.Contains("RedactAppliedPromptPolicy(requestBody, request.Context)", gateway);
        Assert.Contains("PromptPolicyId: request.Context?.PromptPolicyId", gateway);
        Assert.Contains("PromptPolicyHash: request.Context?.PromptPolicyHash", gateway);
        Assert.Contains("SystemPromptText: string.IsNullOrWhiteSpace(request.Context?.PromptPolicyId) ? request.Context?.SystemPromptText : null", gateway);
        foreach (var loggingSurface in new[] { gatewayRequest, gateway, logModel, logDto, webTypes, detailDrawer })
        {
            Assert.DoesNotContain("PromptPolicyChars", loggingSurface);
            Assert.DoesNotContain("promptPolicyChars", loggingSurface);
        }
        Assert.Contains("日志只记录策略 id、版本和 hash", promptPolicyPage);
        Assert.Contains("提示词策略只记录策略 id、版本和 hash", auditsPage);
        Assert.Contains("{ \"version\", doc[\"Version\"] }", console);
        Assert.Contains("{ \"policyHash\", doc[\"PolicyHash\"] }", console);
        Assert.DoesNotContain("{ \"enabled\", doc[\"Enabled\"] }", console);
        Assert.DoesNotContain("{ \"policyChars\", doc[\"PolicyChars\"] }", console);
        Assert.DoesNotContain("{ \"maxChars\", doc[\"MaxChars\"] }", console);
        Assert.Contains("个模板字符", promptPolicyPage);
        Assert.Contains("个本次生效字符", promptPolicyPage);
        Assert.Contains("缺价格保持“未知”，不会显示成 0", usagePage);
        Assert.Contains("CNY 与 USD 不会直接相加", usagePage);
    }

    [Fact]
    public void UsageCostStates_AreTraceableAndNeverInventFxOrZeroUnknownCost()
    {
        var usagePage = ReadRepoFile("llmgw/web/src/pages/UsagePage.tsx");

        foreach (var label in new[] { "费用四状态", "可估算", "供应商实际", "估算未知", "已对账" })
        {
            Assert.Contains(label, usagePage);
        }

        Assert.Contains("reconciliation.items.map", usagePage);
        Assert.Contains("/logs?requestId=", usagePage);
        Assert.Contains("逐条查看 Gateway 估算、供应商实际、差额依据和匹配粒度", usagePage);
        Assert.Contains("汇总记录没有单条 requestId", usagePage);
        Assert.Contains("value == null ? unknownLabel", usagePage);
        Assert.Contains("item.reconciliationStatus !== 'reconciled' || item.reconciliationDelta == null", usagePage);
        Assert.Contains("币种不同且没有可审计 FX，禁止计算差额", usagePage);
        Assert.Contains("前端不猜测汇率", usagePage);
        Assert.DoesNotContain("providerToEstimatedFxRate *", usagePage);
        Assert.DoesNotContain("* item.providerToEstimatedFxRate", usagePage);
    }

    [Fact]
    public void ExchangeSelfService_IsTenantScopedAuditedAndKeepsSecretsWriteOnly()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var dtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var provisioning = ReadRepoFile("llmgw/console-api/Provisioning/GatewayConfigurationProvisioning.cs");
        var page = ReadRepoFile("llmgw/web/src/pages/ExchangesPage.tsx");
        var api = ReadRepoFile("llmgw/web/src/lib/api.ts");
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var serving = ReadRepoFile("llmgw/serving/Program.cs");

        Assert.Contains("app.MapPost(\"/gw/exchanges\"", console);
        Assert.Contains("app.MapPut(\"/gw/exchanges/{id}\"", console);
        Assert.Contains("TenantAccess.Filter(http, fb.Eq(\"_id\", id))", console);
        Assert.Contains("action: \"exchange.create\"", console);
        Assert.Contains("action: \"exchange.update\"", console);
        Assert.Contains("BeginRequiredOperationAuditAsync", console);
        Assert.Contains("EXCHANGE_AUDIT_PENDING", console);
        Assert.Contains("无法先建立 Exchange 审计意图，本次未写入配置", console);
        Assert.Contains("无法先建立 Exchange 审计意图，本次未修改配置", console);
        var exchangeCreateStart = console.IndexOf("app.MapPost(\"/gw/exchanges\"", StringComparison.Ordinal);
        var exchangeUpdateStart = console.IndexOf("app.MapPut(\"/gw/exchanges/{id}\"", exchangeCreateStart, StringComparison.Ordinal);
        var exchangeClaimStart = console.IndexOf("app.MapPut(\"/gw/exchanges/{id}/claim\"", exchangeUpdateStart, StringComparison.Ordinal);
        var exchangeCreateSection = console[exchangeCreateStart..exchangeUpdateStart];
        var exchangeUpdateSection = console[exchangeUpdateStart..exchangeClaimStart];
        Assert.True(
            exchangeCreateSection.IndexOf("BeginRequiredOperationAuditAsync", StringComparison.Ordinal)
            < exchangeCreateSection.IndexOf("gwModelExchanges.InsertOneAsync", StringComparison.Ordinal),
            "Exchange 创建必须先写 pending 审计意图，再写业务配置");
        Assert.True(
            exchangeUpdateSection.IndexOf("BeginRequiredOperationAuditAsync", StringComparison.Ordinal)
            < exchangeUpdateSection.IndexOf("gwModelExchanges.UpdateOneAsync", StringComparison.Ordinal),
            "Exchange 修改必须先写 pending 审计意图，再写业务配置");
        Assert.Contains("EXCHANGE_READBACK_FAILED", console);
        Assert.Contains("EXCHANGE_CONCURRENTLY_MODIFIED", console);
        Assert.Contains("ValidateExternalExchangeTargetAsync(draft.TargetUrl", console);
        Assert.Contains("Dns.GetHostAddressesAsync(host, ct)", console);
        Assert.Contains("UNSAFE_TARGET_URL", console);
        Assert.Contains("gwModelExchanges.Find(TenantAccess.Filter(http", console);
        Assert.Contains("BuildExchangePoolModelDocument(platformId, exchangeModel)", console);
        Assert.Contains("GwApiKeyCrypto.Encrypt(draft.ApiKey!, config)", console);
        var exchangeItemStart = dtos.IndexOf("public sealed class ExchangeItem", StringComparison.Ordinal);
        var exchangeItemEnd = dtos.IndexOf("public sealed class ExchangeModelItem", exchangeItemStart, StringComparison.Ordinal);
        var writeRequestStart = dtos.IndexOf("public sealed class CreateExchangeRequest", StringComparison.Ordinal);
        var writeRequestEnd = dtos.IndexOf("// ── GW-owned API key", writeRequestStart, StringComparison.Ordinal);
        Assert.DoesNotContain("ApiKey", dtos[exchangeItemStart..exchangeItemEnd]);
        Assert.DoesNotContain("TenantId", dtos[writeRequestStart..writeRequestEnd]);
        Assert.Contains("Exchange 通讯密钥不能为空", provisioning);
        Assert.Contains("uniq_llmgw_exchange_tenant_name", initializer);
        Assert.Contains("Ascending(\"TenantId\").Ascending(\"NameNormalized\")", initializer);
        Assert.Contains("Filter.Type(\"TenantId\", BsonType.String)", initializer);
        Assert.Contains("createExchange({ ...common, apiKey: form.apiKey.trim() }", page);
        Assert.Contains("updateExchange(editingId!", page);
        Assert.Contains("上游接口类型", page);
        Assert.Contains("上游模型标识重复", page);
        Assert.Contains("当前填写的内容仍保留", page);
        Assert.Contains("只有豆包流式语音识别可使用公网 WSS", page);
        Assert.Contains("其他类型必须使用 HTTP/HTTPS", page);
        Assert.Contains("transformerType === 'fal-image'", page);
        Assert.Contains("transformerType === 'doubao-asr'", page);
        Assert.Contains("/audits?targetType=llmgw_model_exchange", page);
        Assert.DoesNotContain("tenantId:", page);
        Assert.Contains("body: req", api);
        Assert.Contains("IsExternalTenant(tenantId)", gateway);
        Assert.Contains("CreateClient(\"SafeOutbound\")", gateway);
        Assert.Contains("requirePublicPinnedWebSocket: externalTenant", gateway);
        Assert.Contains("AddHttpClient(\"SafeOutbound\")", serving);
        Assert.Contains("SafeOutboundHttpHandlerFactory", serving);
        Assert.Contains("ISafeOutboundWebSocketConnector", serving);
        var safeWebSocket = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/SafeOutboundWebSocketConnector.cs");
        Assert.Contains("AllowAutoRedirect = false", safeWebSocket);
        Assert.Contains("UseProxy = false", safeWebSocket);
        Assert.Contains("ConnectCallback", safeWebSocket);
        Assert.Contains("TargetHost = target.Uri.IdnHost", safeWebSocket);
        Assert.Contains("SslPolicyErrors.None", safeWebSocket);
        var poolsPage = ReadRepoFile("llmgw/web/src/pages/ModelPoolsPage.tsx");
        Assert.Contains("getExchanges({ enabled: true })", poolsPage);
        Assert.Contains("toExchangeModelCandidates", poolsPage);
        Assert.Contains("llmgw_model_exchanges", poolsPage);
    }

    [Fact]
    public void Compose_DeclaresGatewayDatabaseName_ForApiAndServing()
    {
        var dockerCompose = ReadRepoFile("docker-compose.yml");
        var cdsCompose = ReadRepoFile("cds-compose.yml");

        Assert.Contains("LlmGateway__DatabaseName=${LLMGW_DATABASE_NAME:-llm_gateway}", dockerCompose);
        Assert.Contains("LlmGateway__Mode=${LLMGW_MODE}", dockerCompose);
        Assert.DoesNotContain("LlmGateway__Mode=${LLMGW_MODE:-inproc}", dockerCompose);
        Assert.Contains("LlmGateway__Mode: \"inproc\"", cdsCompose);
        Assert.True(
            dockerCompose.Split("LlmGateway__DisableMapConfigFallbackForRegisteredAppCallers=", StringSplitOptions.None).Length - 1 >= 3,
            "api、llmgw-serve、llmgw 必须同时收到 registered appCaller 配置权威退场开关");
        Assert.Contains("LlmGateway__DisableMapConfigFallbackForRegisteredAppCallers: \"false\"", cdsCompose);
        Assert.True(
            cdsCompose.Split("LlmGateway__DisableMapConfigFallbackForRegisteredAppCallers:", StringSplitOptions.None).Length - 1 >= 2,
            "CDS api 与 llmgw-serve 必须同时收到 registered appCaller 配置权威退场开关");
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        Assert.Contains("llmgw_app_caller_duplicate_archive", initializer);
        Assert.Contains("app_caller.deduplicate", initializer);
        Assert.Contains("duplicate.ToBsonDocument()", initializer);
        Assert.True(
            initializer.IndexOf("archive.ReplaceOneAsync", StringComparison.Ordinal)
            < initializer.IndexOf("callers.DeleteManyAsync", StringComparison.Ordinal),
            "重复 appCaller 必须先完整归档再删除");
        Assert.Contains("LlmGateway__HttpAppCallerAllowlist=${LLMGW_HTTP_APP_CALLER_ALLOWLIST:-}", dockerCompose);

        Assert.Contains("LlmGateway__HttpAppCallerAllowlist: \"transcript-agent.transcribe::asr\"", cdsCompose);
        Assert.DoesNotContain("LlmGateway__HttpAppCallerAllowlist: \"${", cdsCompose);
        Assert.DoesNotContain("LlmGateway__DisableMapConfigFallbackForRegisteredAppCallers: \"${", cdsCompose);
        Assert.DoesNotContain("LlmGateway__DisableMapConfigFallbackForActiveAppCallers: \"${", cdsCompose);
        Assert.Contains("LlmGateway__ShadowFullSamplePercent=${LLMGW_SHADOW_FULL_SAMPLE_PERCENT:-0}", dockerCompose);
        Assert.Contains("LlmGateway__ShadowFullSampleAppCallerAllowlist=${LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST:-}", dockerCompose);
        Assert.Contains("LlmGateway__DisableMapConfigFallbackForActiveAppCallers=${LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS:-false}", dockerCompose);
        Assert.Contains("LlmGateway__RolloutLedgerPath=/app/.llmgw-release-evidence/rollout-ledger.jsonl", dockerCompose);
        Assert.Contains("./.llmgw-release-evidence:/app/.llmgw-release-evidence:ro", dockerCompose);
        Assert.Contains("LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:-}", dockerCompose);
        Assert.Contains("LLMGW_ADMIN_FORCE_RESET=${LLMGW_ADMIN_FORCE_RESET:-}", dockerCompose);
        Assert.DoesNotContain("LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:?", dockerCompose);
        Assert.DoesNotContain("LLMGW_ADMIN_USER", dockerCompose);
        Assert.Contains("LlmGateway__DatabaseName: llm_gateway", cdsCompose);
        Assert.Contains("默认由 llm_gateway.llmgw_console_users 托管账号", cdsCompose);
        Assert.Contains("LLMGW_ADMIN_ENV_AUTHORITY: \"${LLMGW_ADMIN_ENV_AUTHORITY}\"", cdsCompose);
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
    public void TranscriptRunWorker_RejectsEmptyNonChatSuccessBeforeAcceptingCandidate()
    {
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/TranscriptRunWorker.cs");

        Assert.Contains("validatedNonChatSegments", worker);
        Assert.Contains("candidateSegments.Count > 0", worker);
        Assert.Contains("非对话音频模型返回空或无效转写，自动尝试下一候选", worker);
        Assert.Contains("validatedChatText != null || validatedNonChatSegments != null", worker);
    }

    [Fact]
    public void EveryAsrRawPathPinsTheResolvedPhysicalModelAcrossHttpServing()
    {
        var paths = new[]
        {
            "prd-api/src/PrdAgent.Api/Services/TranscriptRunWorker.cs",
            "prd-api/src/PrdAgent.Api/Services/SubtitleGenerationProcessor.cs",
            "prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs",
            "prd-api/src/PrdAgent.Api/Services/VideoToDocRunWorker.cs",
            "prd-api/src/PrdAgent.Api/Controllers/Api/LlmGatewayOpsCanaryController.cs",
            "prd-api/src/PrdAgent.Infrastructure/LlmGateway/Asr/LiveAsrBatchFallbackService.cs",
        };

        foreach (var path in paths)
        {
            var source = ReadRepoFile(path);
            Assert.Contains("RequiredOfferingId =", source);
            Assert.Contains("PinnedPlatformId =", source);
            Assert.Contains("PinnedModelId =", source);
        }
    }

    [Fact]
    public void LatestTranscriptionRunCanBeScopedToTheCurrentUserAfterRefresh()
    {
        var controller = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs");
        var page = ReadRepoFile("prd-admin/src/pages/document-store/DocumentStorePage.tsx");

        Assert.Contains("[FromQuery] bool ownUserOnly = false", controller);
        Assert.Contains("Filter.Eq(r => r.UserId, GetUserId())", controller);
        Assert.Contains("{ ownUserOnly: true }", page);
    }

    [Fact]
    public void TranscriptRuns_AreConsumedOnlyByTheirCreatingDeployment()
    {
        var model = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/TranscriptRun.cs");
        var controller = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/TranscriptAgentController.cs");
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/TranscriptRunWorker.cs");
        var watchdog = ReadRepoFile("prd-api/src/PrdAgent.Api/Middleware/TranscriptRunWatchdog.cs");
        var recordingWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/DocumentRecordingArchiveWorker.cs");
        var documentWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/DocumentStoreAgentWorker.cs");
        var shortVideoWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ShortVideoMaterialWorker.cs");
        var legacyOwnerScope = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/LegacyOwnerScope.cs");
        var authority = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Security/DeploymentAuthority.cs");
        var transcriptController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/TranscriptAgentController.cs");
        var cdsCompose = ReadRepoFile("cds-compose.yml");
        var productionCompose = ReadRepoFile("docker-compose.yml");

        Assert.Contains("public string OwnerInstanceId { get; set; }", model);
        Assert.Contains("OwnerInstanceId = InstanceIdentity.Get(_config)", controller);
        Assert.Contains("Status = TranscriptRunStatuses.ScopedQueued", controller);
        Assert.Contains("Filter.Eq(r => r.Status, TranscriptRunStatuses.ScopedQueued)", worker);
        Assert.Contains("Filter.Eq(r => r.Status, TranscriptRunStatuses.LegacyQueued)", worker);
        Assert.Contains("LegacyOwnerScope.Build<TranscriptRun>", worker);
        Assert.Contains("DeploymentAuthority.CanAdoptLegacyTranscriptRuns(configuration)", worker);
        Assert.Contains("Filter.Or(scopedForCurrentInstance, adoptableLegacyRun)", worker);
        Assert.Contains("AdoptLegacyTranscriptRunsKey", authority);
        Assert.Contains("AdoptLegacyBranchOwnersKey", authority);
        Assert.Contains("RetiredLegacyBranchOwnerIdsKey", authority);
        Assert.Contains("LegacyOwnerCreatedBeforeUtcKey", authority);
        Assert.Contains("LegacyTranscriptRolloutCreatedBeforeUtc", authority);
        Assert.Contains("IsLegacyTranscriptMigrationAuthority", authority);
        Assert.Contains("GetLegacyTranscriptCreatedBeforeUtc", worker);
        Assert.DoesNotContain("GetRetiredLegacyBranchOwnerIds", ReadRepoFile("prd-api/src/PrdAgent.Api/Services/InstanceIdentity.cs"));
        Assert.Contains("Transcript__AdoptLegacyUnownedRuns: \"\"", cdsCompose);
        Assert.Contains("Deployment__Identity: \"prd-agent:cds\"", cdsCompose);
        Assert.Contains("Deployment__AdoptLegacyBranchOwners: \"false\"", cdsCompose);
        Assert.Contains("Deployment__RetiredLegacyBranchOwnerIds: \"\"", cdsCompose);
        Assert.Contains("Deployment__LegacyOwnerCreatedBeforeUtc: \"\"", cdsCompose);
        Assert.Contains("Deployment__Identity=${DEPLOYMENT_IDENTITY:-prd-agent:production}", productionCompose);
        Assert.Contains("Deployment__AdoptLegacyBranchOwners=${ADOPT_LEGACY_BRANCH_OWNERS:-true}", productionCompose);
        Assert.Contains("Deployment__RetiredLegacyBranchOwnerIds=${RETIRED_LEGACY_BRANCH_OWNER_IDS:-main}", productionCompose);
        Assert.Contains("Deployment__LegacyOwnerCreatedBeforeUtc=${LEGACY_OWNER_CREATED_BEFORE_UTC:-2026-08-12T19:20:00Z}", productionCompose);
        Assert.Contains("SYNTHETIC_LOGIN_ENABLED: \"true\"", cdsCompose);
        Assert.Contains("Transcript__AdoptLegacyUnownedRuns=${TRANSCRIPT_ADOPT_LEGACY_UNOWNED_RUNS:-}", productionCompose);
        Assert.True(
            cdsCompose.Split("command -v ffmpeg", StringSplitOptions.None).Length - 1 >= 3,
            "CDS API 的 dev、static 与默认源码命令都必须在启动前保证 ffmpeg 可用");
        Assert.Contains("Sort.Ascending(r => r.CreatedAt)", worker);
        Assert.Contains(".Set(r => r.OwnerInstanceId, instanceId)", worker);
        Assert.Contains("Filter.Eq(r => r.OwnerInstanceId, run.OwnerInstanceId)", worker);
        Assert.Contains("Filter.In(r => r.OwnerInstanceId, _compatibleOwnerIds)", watchdog);
        Assert.Contains("DeploymentAuthority.CanAdoptLegacyTranscriptRuns(config)", watchdog);
        Assert.Contains("LegacyOwnerScope.Build<TranscriptRun>", watchdog);
        Assert.Contains(".Set(r => r.OwnerInstanceId, _instanceId)", watchdog);
        Assert.DoesNotContain("BranchOnlyOwnerPattern", legacyOwnerScope);
        Assert.Contains("Filter.In(ownerField, retiredLegacyOwnerIds)", legacyOwnerScope);
        Assert.Contains("Filter.Lte(\"CreatedAt\", legacyOwnerCreatedBeforeUtc.Value)", legacyOwnerScope);
        Assert.Contains("var retiredLegacyOwnerIds = DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(configuration)", recordingWorker);
        Assert.Contains("retiredLegacyOwnerIds: retiredLegacyOwnerIds", recordingWorker);
        Assert.Contains("LegacyOwnerScope.Build<DocumentStoreAgentRun>", documentWorker);
        Assert.Contains("LegacyOwnerScope.Build<ShortVideoMaterialRun>", shortVideoWorker);
        Assert.Contains(".Set(r => r.OwnerInstanceId, instanceId)", documentWorker);
        Assert.Contains(".Set(r => r.OwnerInstanceId, instanceId)", shortVideoWorker);
        Assert.Contains("TranscriptRunTimingPolicy.ResolveWatchdogTimeout(config)", watchdog);
        Assert.Contains("TranscriptRunTimingPolicy.ResolveAsrProcessingDeadline(configuration)", worker);
        Assert.Contains("while (!ct.IsCancellationRequested)", transcriptController);
        Assert.DoesNotContain("i < 600", transcriptController);
        Assert.Contains("OwnedProcessingRun(run)", worker);
        Assert.Contains("candidate.ToGatewayResolution(),\n                    processingToken", worker);
        Assert.Contains("public const string LegacyQueued = \"queued\"", model);
    }

    [Fact]
    public void OfferingRouteEdits_CreateImmutableReplacementForAcceptedAsyncJobs()
    {
        var consoleApi = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("model-offering.route-replaced", consoleApi);
        Assert.Contains("SupersedesOfferingId", consoleApi);
        Assert.Contains("SupersededByOfferingId", consoleApi);
        Assert.Contains("pending:{replacementId}", consoleApi);
        Assert.Contains("replacement[\"Enabled\"] = false", consoleApi);
        Assert.Contains("OFFERING_PROMOTION_FAILED", consoleApi);
        Assert.Contains(".Where(x => !x.Contains(\"SupersededByOfferingId\"))", consoleApi);
        Assert.True(
            consoleApi.IndexOf("await gwModelOfferings.InsertOneAsync(replacement)", StringComparison.Ordinal)
            < consoleApi.IndexOf(".Set(\"SupersededByOfferingId\", replacementId)", StringComparison.Ordinal));

        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        Assert.Contains("EnsureOfferingIdentityIndexAsync", initializer);
        Assert.Contains(".Ascending(\"SupersededByOfferingId\")", initializer);
        Assert.Contains("uniq_llmgw_offering_tenant_logical_target_v2", initializer);
        Assert.Contains("catch (MongoCommandException ex) when (ex.Code == 27)", initializer);
        Assert.Contains("IsEquivalentOfferingIdentityIndex", initializer);
        Assert.Contains("MongoDB 不允许同一 key/options 仅以不同名称重复建索引", initializer);
        Assert.True(
            initializer.IndexOf("IsEquivalentOfferingIdentityIndex(index, expectedKeys)", StringComparison.Ordinal)
            < initializer.IndexOf("DropIndexIfPresentAsync(collection, legacyIndexName", StringComparison.Ordinal));
        Assert.True(
            initializer.IndexOf("DropIndexIfPresentAsync(collection, legacyIndexName", StringComparison.Ordinal)
            < initializer.IndexOf("Name = versionAwareIndexName", StringComparison.Ordinal));
        Assert.Contains("Offering 唯一索引升级为版本感知结构", initializer);
    }

    [Fact]
    public void VideoSceneWorker_SynchronizesProjectStatusAfterSceneTerminalStates()
    {
        var videoWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs");
        var videoService = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/VideoGenService.cs");

        Assert.Contains("await SyncProjectSceneActivityAsync(run.Id);", videoWorker);
        Assert.Contains("await SyncProjectSceneActivityAsync(runId);", videoWorker);
        Assert.Contains("ResolveProjectStatusForScenes(run.Scenes)", videoWorker);
        Assert.Contains("SceneItemStatus.Submitting", videoService);
        Assert.Contains("FindOneAndUpdateAsync", videoWorker);
        Assert.Contains("Scenes.{sceneIdx}.JobId", videoWorker);
    }

    [Fact]
    public void VisualImageRun_PreservesLogicalModelIdentityAcrossWorkerAndRawGatewayBoundary()
    {
        var runModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ImageGenRun.cs");
        var imageController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs");
        var imageMasterController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs");
        var imageWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs");
        var imageClient = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs");

        Assert.Contains("public string? LogicalModelPublicId { get; set; }", runModel);
        Assert.Contains("LogicalModelPublicId = string.Equals(platformId, \"logical-model\"", imageController);
        Assert.Contains("LogicalModelPublicId = string.Equals(platformId, \"logical-model\"", imageMasterController);
        Assert.Contains("var frontendExpectedModelId = run.LogicalModelPublicId ?? run.ModelId;", imageWorker);
        Assert.Contains("modelName: run.LogicalModelPublicId ?? run.ModelId", imageWorker);
        Assert.Contains(".Set(x => x.LogicalModelPublicId, logicalModelPublicId)", imageWorker);
        Assert.Contains("modelPool = doneDisplayModel, logicalModelPublicId = run.LogicalModelPublicId", imageWorker);
        Assert.Contains("RequiredLogicalModelPublicId = resolution.LogicalModelPublicId", imageClient);
        Assert.Contains("ExpectedModel = resolution.LogicalModelPublicId ?? effectiveModelName", imageClient);
        Assert.Contains("ResolveRequiredLogicalModelAsync", imageClient);
        Assert.Contains("ResolveRequiredLogicalModelPublicId(", imageClient);
        Assert.Contains("string.Equals(platformId?.Trim(), \"logical-model\"", imageClient);
        Assert.Contains("requiredLogicalModelPublicId: run.LogicalModelPublicId", imageWorker);
        Assert.Contains("ResolveExplicitLogicalModelPublicId(run)", imageWorker);
        Assert.Contains("run.DeploymentSlug", imageController);
        Assert.Contains("显式逻辑模型跳过 MAP 模型池调度", imageWorker);
        Assert.Contains(".Set(x => x.ModelResolutionType, ModelResolutionType.LogicalModel)", imageWorker);
    }

    [Fact]
    public void LiteraryIllustrationPicker_UsesCapabilityAwareSizeMetadataForEveryPicker()
    {
        var editor = ReadRepoFile("prd-admin/src/pages/literary-agent/ArticleIllustrationEditorPage.tsx");

        Assert.Contains("getVisualAgentAdapterInfo,", editor);
        Assert.Contains("const [currentModelSizesNotApplicable, setCurrentModelSizesNotApplicable]", editor);
        Assert.Contains("setCurrentModelSizesNotApplicable(res.data.sizesNotApplicable === true);", editor);
        Assert.Equal(2, editor.Split("!currentModelSizesNotApplicable && (", StringSplitOptions.None).Length - 1);
    }

    [Fact]
    public void ImageRunEvents_UseResolvedSizeCapabilityInsteadOfOnlyTheLegacyAdapter()
    {
        var imageWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs");
        var imageClient = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs");

        Assert.Contains("var startIsAdaptive = await ResolveRunIsAdaptiveAsync", imageWorker);
        Assert.Contains("var doneIsAdaptive = meta?.IsAdaptive", imageWorker);
        Assert.Contains("isAdaptive = doneIsAdaptive", imageWorker);
        Assert.Contains("IsAdaptive = ResolveEffectiveIsAdaptive(gatewayResp.Resolution, effectiveModelName)", imageClient);
    }

    [Fact]
    public void VisualImageRun_UsesQueueStatusThatLegacyWorkersCannotClaim()
    {
        var runModel = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ImageGenRun.cs");
        var imageController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs");
        var imageMasterController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs");
        var literaryController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/LiteraryAgentImageGenController.cs");
        var weeklyPosterController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/WeeklyPosterController.cs");
        var imageWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs");

        Assert.Contains("ScopedQueued", runModel);
        Assert.Contains("Status = ImageGenRunStatus.ScopedQueued", imageController);
        Assert.Contains("Status = ImageGenRunStatus.ScopedQueued", imageMasterController);
        Assert.Contains("Status = ImageGenRunStatus.ScopedQueued", literaryController);
        Assert.Contains("Status = ImageGenRunStatus.ScopedQueued", weeklyPosterController);
        Assert.Contains("ClaimNextRunByStatusAsync(ImageGenRunStatus.ScopedQueued", imageWorker);
        Assert.Contains("DeploymentScope.Current == null", imageWorker);
        Assert.Contains("ClaimNextRunByStatusAsync(ImageGenRunStatus.Queued", imageWorker);
    }

    [Fact]
    public void WorkspaceDeletion_RemovesAllReferencesBeforePhysicalObjectCleanup()
    {
        var controller = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs");
        var helperStart = controller.IndexOf("private async Task<bool> TryDeleteUnreferencedGeneratedImageAsync", StringComparison.Ordinal);
        var imageAssetCheck = controller.IndexOf("_db.ImageAssets.CountDocumentsAsync(imageAssetFilter", helperStart, StringComparison.Ordinal);
        var uploadArtifactCheck = controller.IndexOf("_db.UploadArtifacts.CountDocumentsAsync(artifactFilter", helperStart, StringComparison.Ordinal);
        var imageRunCheck = controller.IndexOf("_db.ImageGenRuns.CountDocumentsAsync(runFilter", helperStart, StringComparison.Ordinal);
        var helperDeleteObject = controller.IndexOf("await _assetStorage.DeleteByShaAsync(", helperStart, StringComparison.Ordinal);
        var collectArtifacts = controller.IndexOf("runArtifacts = (await _db.UploadArtifacts.Find", StringComparison.Ordinal);
        var deleteAssetRecords = controller.IndexOf("await _db.ImageAssets.DeleteManyAsync", collectArtifacts, StringComparison.Ordinal);
        var deleteArtifactRecords = controller.IndexOf("await _db.UploadArtifacts.DeleteManyAsync", deleteAssetRecords, StringComparison.Ordinal);
        var deleteRun = controller.IndexOf("await _db.ImageGenRuns.DeleteManyAsync", deleteArtifactRecords, StringComparison.Ordinal);
        var deleteWorkspace = controller.IndexOf("await _db.ImageMasterWorkspaces.DeleteOneAsync", deleteRun, StringComparison.Ordinal);
        var workspaceDeleteObject = controller.IndexOf("await TryDeleteUnreferencedGeneratedImageAsync(sha, CancellationToken.None)", deleteWorkspace, StringComparison.Ordinal);

        Assert.True(helperStart >= 0, "底层对象删除必须复用统一的引用检查入口");
        Assert.True(imageAssetCheck > helperStart, "删除对象前必须检查图片资产引用");
        Assert.True(uploadArtifactCheck > imageAssetCheck, "删除对象前必须检查其他上传产物引用");
        Assert.True(imageRunCheck > uploadArtifactCheck, "删除对象前必须检查其他生图任务引用");
        Assert.True(helperDeleteObject > imageRunCheck, "全部引用检查通过后才能删除底层对象");
        Assert.True(collectArtifacts >= 0, "工作区删除必须先按 runId 收集生成产物");
        Assert.True(deleteAssetRecords > collectArtifacts, "收集归属完成后才能删除资产记录");
        Assert.True(deleteArtifactRecords > deleteAssetRecords, "必须先解除资产引用再解除产物引用");
        Assert.True(deleteRun > deleteArtifactRecords, "必须在底层对象回收前解除任务归属");
        Assert.True(deleteWorkspace > deleteRun, "工作区记录必须在任务归属解除后删除");
        Assert.True(workspaceDeleteObject > deleteWorkspace, "全部数据库引用解除后才能通过统一入口回收底层对象");
        Assert.Contains(".Find(x => x.WorkspaceId == wid)", controller);
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
        Assert.Contains("compose_dotenv_file=\"${PRD_AGENT_DOTENV_FILE:-.env}\"", script);
        Assert.Contains("docker compose --env-file \"$compose_dotenv_file\"", script);
        Assert.Contains("docker-compose --env-file \"$compose_dotenv_file\"", script);
        Assert.Contains("compose_run up -d --force-recreate", script);
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
        Assert.Contains("if [ \"$mode\" = \"http\" ] && [ \"$maintenance_release\" != \"1\" ] && [ -z \"$required_kinds_compact\" ]; then", script);
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
        Assert.Contains("LLM Gateway release gate: required before deploy (selected shadow evidence commit; new commit probes run after compose up)", script);
        Assert.Contains("shadow_release_commit=\"$(printf '%s' \"${LLMGW_GATE_SHADOW_RELEASE_COMMIT:-$expect_commit}\" | xargs || true)\"", script);
        Assert.Contains("args=\"$args --shadow-release-commit $shadow_release_commit\"", script);
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
        Assert.Contains("LLMGW_POST_DEPLOY_SMOKE_KEY=\"${LLMGW_POST_DEPLOY_SERVICE_KEY:-$gate_key}\"", script);
        Assert.Contains("smoke_key=\"${LLMGW_POST_DEPLOY_SMOKE_KEY:-$gate_key}\"", script);
        Assert.Contains("protocol_canary_key=\"${LLMGW_POST_DEPLOY_PROTOCOL_CANARY_KEY:-$smoke_key}\"", script);
        Assert.Contains("GW_BASE=\"$gate_base\" GW_KEY=\"$smoke_key\" GW_TIMEOUT=\"${LLMGW_GATE_SMOKE_TIMEOUT_SECONDS:-120}\" GW_EXPECT_COMMIT=\"$expect_commit\" python3 scripts/gw-smoke.py", script);
        Assert.Contains("LLMGW_GATE_RUN_SERVING_PROBE", script);
        Assert.Contains("LLMGW_SERVING_PROBE_JSON_OUT", script);
        Assert.Contains("LLMGW_SERVING_PROBE_REPORT_MD", script);
        Assert.Contains("scripts/llmgw-serving-probe.py", script);
        Assert.Contains("scripts/llmgw-disk-space-guard.sh", script);
        Assert.Contains("LLMGW_DEPLOY_DISK_GUARD_PATH", script);
        Assert.Contains("LLMGW_DEPLOY_MIN_FREE_MB:-4096", script);
        Assert.Contains("LLM Gateway exec_dep deploy", script);
        Assert.Contains("provider_audit_required=0", script);
        Assert.Contains("if { [ \"$mode\" = \"http\" ] && [ \"$maintenance_release\" != \"1\" ]; } || [ \"$canary_stage\" = \"video-asr\" ]; then", script);
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
        Assert.Contains("LLMGW_POST_DEPLOY_RUN_PROTOCOL_CANARY", script);
        Assert.Contains("LLMGW_POST_DEPLOY_PROTOCOL_CANARY_JSON_OUT", script);
        Assert.Contains("LLMGW_POST_DEPLOY_PROTOCOL_CANARY_REPORT_MD", script);
        Assert.Contains("LLMGW_POST_DEPLOY_PROTOCOL_CANARY_MAX_RUNTIME_CALLS", script);
        Assert.Contains("protocol_canary_json_dir=\"$(dirname -- \"$protocol_canary_json\")\"", script);
        Assert.Contains("protocol_canary_md_dir=\"$(dirname -- \"$protocol_canary_md\")\"", script);
        Assert.Contains("mkdir -p \"$protocol_canary_json_dir\"", script);
        Assert.Contains("mkdir -p \"$protocol_canary_md_dir\"", script);
        Assert.Contains("LLM Gateway post-deploy protocol canary: required before runtime gates", script);
        Assert.Contains("LLM Gateway post-deploy protocol canary: disabled; not passing unverified JSON to runtime gates", script);
        Assert.Contains("python3 scripts/llmgw-protocol-canary.py", script);
        Assert.Contains("GW_KEY=\"$protocol_canary_key\" python3 scripts/llmgw-protocol-canary.py", script);
        Assert.DoesNotContain("GW_KEY=\"$smoke_key\" python3 scripts/llmgw-protocol-canary.py", script);
        Assert.Contains("protocol_canary_arg=\"--protocol-canary-json $protocol_canary_json\"", script);
        Assert.Contains("$protocol_canary_arg --require-runtime-gates", script);
        Assert.Contains("[ \"$mode\" = \"http\" ] && [ \"$maintenance_release\" = \"1\" ]", script);
        Assert.Contains("skipped for audited full-http maintenance release", script);
        Assert.Contains("LLM Gateway post-deploy runtime gates: allowing self-finalizing full_http_rollout_ledger only", script);
        Assert.Contains("--allow-pending-http-full-ledger", script);
        Assert.Contains("LLMGW_GATE_SERVING_PROBE_SAMPLES", script);
        Assert.Contains("LLMGW_GATE_SERVING_PROBE_INTERVAL_SECONDS", script);
        Assert.Contains("LLMGW_SKIP_RELEASE_GATE=1", script);
        Assert.Contains("LLMGW_SKIP_RELEASE_GATE=1 is not allowed when LLM Gateway release evidence is required", script);
        Assert.Contains("Use scripts/llmgw-rollback-inproc.sh for emergency rollback", script);
        Assert.DoesNotContain("已跳过发布证据门", script);
        var protocolCanaryIdx = script.IndexOf("python3 scripts/llmgw-protocol-canary.py", StringComparison.Ordinal);
        var runtimeGatesIdx = script.IndexOf("--require-runtime-gates", StringComparison.Ordinal);
        Assert.True(protocolCanaryIdx >= 0 && runtimeGatesIdx >= 0 && protocolCanaryIdx < runtimeGatesIdx);
    }

    [Fact]
    public void ExecDep_PreservesGatewayContainerIpForStaticDistReuseDeployments()
    {
        var script = ReadRepoFile("exec_dep.sh");
        var refreshStart = script.IndexOf("refresh_gateway_after_compose()", StringComparison.Ordinal);
        var refreshEnd = script.IndexOf("compose_services_without_gateway()", refreshStart, StringComparison.Ordinal);
        Assert.True(refreshStart >= 0 && refreshEnd > refreshStart);
        var refresh = script[refreshStart..refreshEnd];

        Assert.Contains("compose_services_without_gateway", script);
        Assert.Contains("grep -Fvx \"$gateway_service\"", script);
        Assert.Contains("compose_run up -d --force-recreate $release_services", script);
        Assert.Contains("sync_active_gateway_nginx_config", script);
        Assert.Contains("reload_active_gateway", script);
        Assert.Contains("compose_run up -d --no-deps \"$gateway_service\"", script);
        Assert.DoesNotContain("--force-recreate", refresh);
        Assert.DoesNotContain("--force-recreate \"$gateway_service\"", script);
        Assert.Contains(".Destination \"/usr/share/nginx/html\"", script);
        Assert.Contains(".Destination \"/etc/nginx/conf.d\"", script);
        Assert.Contains("$active_static_root/current", script);
        Assert.Contains("root /usr/share/nginx/html/current;", ReadRepoFile("deploy/nginx/conf.d/branches/_standalone.conf"));
        Assert.Contains("static-restored-and-public-verified", script);
        Assert.Contains("Refresh existing DNS resolutions immediately", script);

        foreach (var recoveryScript in new[]
                 {
                     ReadRepoFile("scripts/llmgw-rollback-inproc.sh"),
                     ReadRepoFile("scripts/llmgw-restore-shadow-safe.sh")
                 })
        {
            Assert.Contains("reload_gateway_in_place", recoveryScript);
            Assert.Contains("nginx -t", recoveryScript);
            Assert.Contains("nginx -s reload", recoveryScript);
            Assert.DoesNotContain("--force-recreate \"$gateway_service\"", recoveryScript);
        }
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
    public void MaintenanceRelease_InheritsOnlyAuditedShadowEvidence_AndRechecksNewCommit()
    {
        var stage = ReadRepoFile("scripts/llmgw-prod-stage.sh");
        var deploy = ReadRepoFile("exec_dep.sh");
        var ledger = ReadRepoFile("scripts/llmgw-rollout-ledger.py");

        Assert.Contains("--maintenance-from-commit", stage);
        Assert.Contains("maintenance_baseline_json=\"\"", stage);
        Assert.Contains("if [ -n \"$maintenance_from_commit\" ]; then\n  maintenance_baseline_json=\"${evidence_prefix}.maintenance-baseline.json\"", stage);
        Assert.Contains("llmgw-rollout-ledger.py maintenance-baseline", stage);
        Assert.Contains("--json-out \"$maintenance_baseline_json\"", stage);
        Assert.Contains("maintenance evidence commit must differ from the new release commit", stage);
        Assert.Contains("shadow_evidence_commit=\"$(python3 - \"$maintenance_baseline_json\"", stage);
        Assert.Contains("--shadow-evidence-commit \"$shadow_evidence_commit\"", stage);
        Assert.Contains("--maintenance-baseline-commit \"$maintenance_from_commit\"", stage);
        Assert.Contains("--maintenance-baseline-json \"$maintenance_baseline_json\"", stage);
        Assert.Contains("export LLMGW_GATE_SHADOW_RELEASE_COMMIT=\"$shadow_evidence_commit\"", stage);
        Assert.Contains("export LLMGW_MAINTENANCE_BASELINE_COMMIT=\"$maintenance_from_commit\"", stage);
        Assert.Contains("export LLMGW_MAINTENANCE_BASELINE_JSON=\"$maintenance_baseline_json\"", stage);
        Assert.Contains("LLMGW_GATE_SHADOW_RELEASE_COMMIT:-$expect_commit", deploy);
        Assert.Contains("LLM Gateway maintenance release: audited baseline accepted", deploy);
        Assert.Contains("args=\"--base $gate_base --min-total 0 --min-per-app 0 --skip-global-cells\"", deploy);
        Assert.Contains("[ \"$maintenance_release\" != \"1\" ]", deploy);
        Assert.Contains("{ [ \"$mode\" = \"http\" ] && [ \"$maintenance_release\" != \"1\" ]; }", deploy);
        Assert.Contains("config-authority inherited from audited full-http maintenance baseline", deploy);
        Assert.Contains("LLMGW_POST_DEPLOY_EXPECT_COMMIT=\"$expect_commit\"", deploy);
        Assert.Contains("shadowEvidenceCommit", ledger);
        Assert.Contains("maintenanceBaselineCommit", ledger);
        Assert.Contains("maintenanceBaselineJson", ledger);
        Assert.Contains("allow_skipped_runtime_gates=bool(maintenance_baseline_commit)", ledger);
        Assert.Contains("args.shadow_evidence_commit or args.commit", ledger);
        Assert.Contains("def maintenance_baseline(args: argparse.Namespace)", ledger);
        Assert.Contains("maintenance baseline is stale because a later negative event exists", ledger);
        Assert.Contains("maintenance baseline release gate has no shadow checks", ledger);
        Assert.Contains("shadow_evidence_commit = _normalize_commit(stage_evidence.get(\"shadowEvidenceCommit\")) or commit", ledger);
        Assert.Contains("deployment_receipt=", stage);
        Assert.Contains("LLM Gateway deploy-once: receipt exists", stage);
        Assert.Contains("LLMGW_VERIFY_ONLY=1", stage);
        Assert.Contains("LLMGW_STAGE_FORCE_REDEPLOY_REASON", stage);
        Assert.Contains("LLMGW_DEPLOY_RECEIPT_FILE", deploy);
        Assert.Contains("LLM Gateway verify-only: preserving current containers", deploy);
    }

    [Fact]
    public void RolloutLedger_StageReport_AllowsAuditedShadowCommitDifferentFromReleaseCommit()
    {
        var root = LocateRepoRoot();
        var tempDir = Path.Combine(Path.GetTempPath(), "llmgw-maintenance-report-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            const string releaseCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            const string shadowCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            var route = new
            {
                ok = true,
                selfTestStatus = "ok",
                mode = "dry-run",
                upstreamCalled = false,
                total = 4,
                passed = 4,
                protocols = new[] { "gw-native", "openai-compatible", "claude-compatible", "gemini-compatible" },
            };
            var protocolRouter = WriteJson("protocol-router.json", new
            {
                verdict = "pass",
                scope = "static-code-and-document-evidence",
                targetComplete = false,
                runtimeEvidenceComplete = false,
                progressPercent = 90,
                remainingRuntimeGates = new[] { "current_commit_http_transport" },
            });
            var preflight = WriteJson("preflight.json", new
            {
                verdict = "pass",
                expectCommit = releaseCommit,
                mode = "start",
                checks = new[] { new { name = "gateway_route_self_test", ok = true, detail = System.Text.Json.JsonSerializer.Serialize(route) } },
            });
            var serving = WriteJson("serving.json", new
            {
                verdict = "pass",
                expectedCommit = releaseCommit,
                healthSamples = new[] { new { commit = releaseCommit } },
                routeSelfTest = route,
            });
            var releaseGate = WriteJson("release-gate.json", new
            {
                verdict = "pass",
                shadowReleaseCommit = shadowCommit,
                shadowChecks = new[] { new { label = "maintenance", releaseCommit = shadowCommit } },
                configAuthority = new
                {
                    required = true,
                    ok = true,
                    status = "ready",
                    mapFallbackObjectsRemaining = 0,
                    activeAppCallerMapFallbackReady = true,
                    activeBoundPoolWithoutUsableMember = 0,
                },
                runtimeGates = new
                {
                    required = false,
                    ok = false,
                    readyForHttpFull = false,
                    remainingRuntimeGates = Array.Empty<string>(),
                    allowedPendingRuntimeGates = Array.Empty<string>(),
                },
            });
            var maintenanceBaseline = WriteJson("maintenance-baseline.json", new
            {
                verdict = "pass",
                commit = shadowCommit,
                shadowEvidenceCommit = shadowCommit,
            });
            var report = Path.Combine(tempDir, "stage.json");

            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-rollout-ledger.py", "stage-report",
                    "--json-out", report,
                    "--stage", "http-full",
                    "--status", "success",
                    "--commit", releaseCommit,
                    "--shadow-evidence-commit", shadowCommit,
                    "--maintenance-baseline-commit", shadowCommit,
                    "--maintenance-baseline-json", maintenanceBaseline,
                    "--disable-map-config-fallback-for-active-app-callers", "true",
                    "--protocol-router-audit-json", protocolRouter,
                    "--prod-preflight-json", preflight,
                    "--serving-probe-json", serving,
                    "--release-gate-json", releaseGate,
                    "--release-gate-required", "1",
                    "--smoke-required", "0",
                }
            })!;
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.True(process.ExitCode == 0, stderr + stdout);
            var reportJson = File.ReadAllText(report);
            Assert.Contains($"\"shadowEvidenceCommit\": \"{shadowCommit}\"", reportJson);
            Assert.Contains($"\"maintenanceBaselineCommit\": \"{shadowCommit}\"", reportJson);
            Assert.Contains($"\"maintenanceBaselineJson\": \"{maintenanceBaseline.Replace("\\", "\\\\")}\"", reportJson);

            var ledger = Path.Combine(tempDir, "rollout.jsonl");
            using var appendProcess = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-rollout-ledger.py", "append",
                    "--ledger", ledger,
                    "--stage", "http-full",
                    "--status", "success",
                    "--commit", releaseCommit,
                    "--evidence-json", report,
                    "--shadow-evidence-commit", shadowCommit,
                    "--maintenance-baseline-commit", shadowCommit,
                    "--maintenance-baseline-json", maintenanceBaseline,
                    "--disable-map-config-fallback-for-active-app-callers", "true",
                    "--protocol-router-audit-json", protocolRouter,
                    "--prod-preflight-json", preflight,
                    "--serving-probe-json", serving,
                    "--release-gate-json", releaseGate,
                    "--release-gate-required", "1",
                    "--smoke-required", "0",
                }
            })!;
            var appendStdout = appendProcess.StandardOutput.ReadToEnd();
            var appendStderr = appendProcess.StandardError.ReadToEnd();
            appendProcess.WaitForExit();

            Assert.True(appendProcess.ExitCode == 0, appendStderr + appendStdout);
            Assert.Contains($"\"maintenanceBaselineCommit\": \"{shadowCommit}\"", File.ReadAllText(ledger));

            var rejectedReport = Path.Combine(tempDir, "stage-without-maintenance-marker.json");
            using var rejectedProcess = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-rollout-ledger.py", "stage-report",
                    "--json-out", rejectedReport,
                    "--stage", "http-full",
                    "--status", "success",
                    "--commit", releaseCommit,
                    "--shadow-evidence-commit", shadowCommit,
                    "--disable-map-config-fallback-for-active-app-callers", "true",
                    "--protocol-router-audit-json", protocolRouter,
                    "--prod-preflight-json", preflight,
                    "--serving-probe-json", serving,
                    "--release-gate-json", releaseGate,
                    "--release-gate-required", "1",
                    "--smoke-required", "0",
                }
            })!;
            var rejectedStdout = rejectedProcess.StandardOutput.ReadToEnd();
            var rejectedStderr = rejectedProcess.StandardError.ReadToEnd();
            rejectedProcess.WaitForExit();

            Assert.NotEqual(0, rejectedProcess.ExitCode);
            Assert.Contains("runtimeGates is not required+ok+ready", rejectedStderr + rejectedStdout);

            string WriteJson(string name, object value)
            {
                var path = Path.Combine(tempDir, name);
                File.WriteAllText(path, System.Text.Json.JsonSerializer.Serialize(value));
                return path;
            }
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void AppCallerRouteObservations_DoNotUseOnlyTheLastRequest()
    {
        var endpoint = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var request = ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayRequest.cs");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("ObservedModelPolicies", request);
        Assert.Contains("ObservedModelPoolIds", request);
        Assert.Contains("ObservedParameterPolicies", request);
        Assert.Contains("AddToSet(x => x.ObservedModelPolicies, modelPolicy)", endpoint);
        Assert.Contains("AddToSet(x => x.ObservedModelPoolIds, modelPoolId)", endpoint);
        Assert.Contains("observedValues.Contains(configured)", console);
        Assert.Contains("BuildFieldDriftExpr(\"ModelPolicy\", \"LastObservedModelPolicy\", \"ObservedModelPolicies\")", console);
    }

    [Fact]
    public void GatewaySmoke_LabelsReleaseProbeAsHttpTransport()
    {
        var smoke = ReadRepoFile("scripts/gw-smoke.py");

        Assert.Contains("\"GatewayTransport\": \"http\"", smoke);
        Assert.Contains("SMOKE_SOURCE_SYSTEM = os.environ.get(\"GW_SMOKE_SOURCE_SYSTEM\", \"release-probe\")", smoke);
        Assert.Contains("\"SourceSystem\": SMOKE_SOURCE_SYSTEM", smoke);
        Assert.DoesNotContain("\"SourceSystem\": \"release-probe\"", smoke);
        Assert.Contains("\"IngressProtocol\": \"gw-native\"", smoke);
        Assert.DoesNotContain("\"Context\": {\"UserId\": \"smoke-test\", \"IsHealthProbe\": True}", smoke);
    }

    [Fact]
    public void ShadowComparisonReadEndpoints_CanFilterByKind()
    {
        var servingEndpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
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
        Assert.Contains("FirstComparedAt", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("CoverageHours", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("ReleaseCommit", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
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
        Assert.Contains("--require-runtime-gates", releaseGate);
        Assert.Contains("--allow-pending-http-full-ledger", releaseGate);
        Assert.Contains("--protocol-canary-json", releaseGate);
        Assert.Contains("_protocol_canary_check", releaseGate);
        Assert.Contains("\"protocolCanary\"", releaseGate);
        Assert.Contains("protocol canary mode 不是 execute", releaseGate);
        Assert.Contains("protocol canary 缺少协议样本", releaseGate);
        Assert.Contains("allowedPendingRuntimeGates", releaseGate);
        Assert.Contains("selfFinalizingHttpFullLedger", releaseGate);
        Assert.Contains("remaining == [\"full_http_rollout_ledger\"]", releaseGate);
        Assert.Contains("appcaller_ingress_registry_coverage", releaseGate);
        Assert.Contains("blocked runtime gates missing registry facts", releaseGate);
        Assert.Contains("\"stable\"", releaseGate);
        Assert.Contains("--json-out", releaseGate);
        Assert.Contains("--report-md", releaseGate);
        Assert.Contains("\"shadowChecks\"", releaseGate);
    }

    [Fact]
    public void ProtocolRouterAudit_AcceptsAssembledChangelogWhenFragmentWasConsumed()
    {
        var root = LocateRepoRoot();
        var report = Path.Combine(Path.GetTempPath(), $"llmgw-protocol-router-audit-{Guid.NewGuid():N}.json");

        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "python3",
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "scripts/llmgw-protocol-router-audit.py",
                    "--json-out", report,
                }
            })!;
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.True(process.ExitCode == 0, stderr + stdout);
            var reportJson = File.ReadAllText(report);
            Assert.Contains("\"verdict\": \"pass\"", reportJson);
            Assert.Contains("\"name\": \"readiness_and_changelog_capture_protocol_router_progress\"", reportJson);
            Assert.Contains("\"CHANGELOG.md\"", reportJson);
        }
        finally
        {
            File.Delete(report);
        }
    }

    [Fact]
    public void ConsoleRuntimeGateEvidenceLinks_CanDeepLinkToFilteredEvidence()
    {
        var overview = ReadRepoFile("llmgw/web/src/pages/OverviewPage.tsx");
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");
        var shadowPage = ReadRepoFile("llmgw/web/src/pages/ShadowPage.tsx");
        var auditsPage = ReadRepoFile("llmgw/web/src/pages/AuditsPage.tsx");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var consoleDtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var consoleTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var protocolAudit = ReadRepoFile("scripts/llmgw-protocol-router-audit.py");

        Assert.Contains("public List<RuntimeGateLink> Links { get; set; } = new();", consoleDtos);
        Assert.Contains("public sealed class RuntimeGateLink", consoleDtos);
        Assert.Contains("static RuntimeGateLink Link", consoleProgram);
        Assert.Contains("static List<RuntimeGateLink> RuntimeGateLinks", consoleProgram);
        Assert.Contains("Links = RuntimeGateLinks(id, gateFacts, runtimeCommit)", consoleProgram);
        Assert.Contains("/audits?targetType=llmgw_config_authority", consoleProgram);

        Assert.Contains("function runtimeGateActionLinks", overview);
        Assert.Contains("item.links && item.links.length > 0 ? item.links : runtimeGateActionLinks", overview);
        Assert.Contains("const releaseCommit = (facts.releaseCommit || gates.releaseCommit || '').trim();", overview);
        Assert.Contains("const releaseQuery = releaseCommit ? `?releaseCommit=${encodeURIComponent(releaseCommit)}` : '';", overview);
        Assert.Contains("case 'current_commit_http_transport':", overview);
        Assert.Contains("case 'dropped_parameter_runtime_evidence':", overview);
        Assert.Contains("case 'appcaller_runtime_coverage':", overview);
        Assert.Contains("case 'appcaller_ingress_registry_coverage':", overview);
        Assert.Contains("case 'protocol_runtime_coverage':", overview);
        Assert.Contains("case 'shadow_runtime_evidence':", overview);
        Assert.Contains("case 'full_http_rollout_ledger':", overview);
        Assert.Contains("/logs${releaseQuery}", overview);
        Assert.Contains("/shadow${releaseQuery}", overview);
        Assert.Contains("/app-callers?status=active", overview);
        Assert.Contains("/app-callers?drift=any", overview);
        Assert.Contains("/audits?targetType=llmgw_config_authority", overview);

        Assert.Contains("initialQueryValue('releaseCommit')", logsView);
        Assert.Contains("releaseCommit: filterReleaseCommit.trim() || undefined", logsView);
        Assert.Contains("placeholder=\"发布提交\"", logsView);
        Assert.Contains("setFilterReleaseCommit('')", logsView);

        Assert.Contains("useSearchParams", shadowPage);
        Assert.Contains("searchParams.get('releaseCommit')", shadowPage);
        Assert.Contains("searchParams.get('appCallerCode')", shadowPage);
        Assert.Contains("searchParams.get('kind')", shadowPage);
        Assert.Contains("searchParams.get('sinceHours')", shadowPage);
        Assert.Contains("searchParams.get('quick')", shadowPage);
        Assert.Contains("releaseCommit: releaseCommit.trim() || undefined", shadowPage);
        Assert.Contains("kind: kind.trim() || undefined", shadowPage);
        Assert.Contains("sinceHours: Number.isFinite(parsedSinceHours) && parsedSinceHours > 0 ? parsedSinceHours : undefined", shadowPage);

        Assert.Contains("useSearchParams", auditsPage);
        Assert.Contains("searchParams.get('targetType')", auditsPage);
        Assert.Contains("targetType: targetType || undefined", auditsPage);

        Assert.Contains("links?: RuntimeGateLink[]", consoleTypes);
        Assert.Contains("export type RuntimeGateLink", consoleTypes);

        Assert.Contains("runtimeGateActionLinks", protocolAudit);
        Assert.Contains("Links = RuntimeGateLinks", protocolAudit);
        Assert.Contains("initialQueryValue('releaseCommit')", protocolAudit);
        Assert.Contains("/audits?targetType=llmgw_config_authority", protocolAudit);
        Assert.Contains("\"runtimeEvidenceComplete\": False", protocolAudit);
        Assert.Contains("\"progressPercent\": None", protocolAudit);
        Assert.Contains("staticEvidencePercent covers code/doc evidence only", protocolAudit);
        Assert.DoesNotContain("\"progressPercent\": static_percent", protocolAudit);
    }

    [Fact]
    public void ConsoleRuntimeGate_MaintenanceReleaseRetainsOnlyQualifiedPriorShadowEvidence()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("retainedShadowMatchesPreviousFullHttp", consoleProgram);
        Assert.Contains("ReadSuccessfulHttpFullRolloutCommits", consoleProgram);
        Assert.Contains("successfulHttpFullCommits", consoleProgram);
        Assert.Contains("retainedShadowCandidates.FirstOrDefault", consoleProgram);
        Assert.Contains("!ReadJsonBool(root, \"releaseGateRequired\")", consoleProgram);
        Assert.Contains("!ReadJsonBool(root, \"protocolCanaryRequired\")", consoleProgram);
        Assert.Contains("configAuthorityLedgerEvidence.Ready", consoleProgram);
        Assert.Contains("httpTransportLogs == releaseLogTotal", consoleProgram);
        Assert.Contains("missingIngressProtocols.Count == 0", consoleProgram);
        Assert.Contains("protocolFailedLogs == 0", consoleProgram);
        Assert.Contains("missingRuntimeCoverageAppCallers.Count == 0", consoleProgram);
        Assert.Contains("canRetainPreviousShadowEvidence ? \"retained\" : \"waiting\"", consoleProgram);
        Assert.Contains("首次切流必须跑当前 commit 的真实 appCaller shadow 样本", consoleProgram);
    }

    [Fact]
    public void ExecDep_ProvidesNoUnderscoreCompatibilityWrapper()
    {
        var wrapper = ReadRepoFile("execdep.sh");

        Assert.Contains("exec_dep.sh", wrapper);
        Assert.Contains("exec \"$script_dir/exec_dep.sh\" \"$@\"", wrapper);
    }

    [Fact]
    public void ReportAgentChatBootstrap_UsesIsolatedDedicatedPoolByDefault()
    {
        var shell = ReadRepoFile("scripts/llmgw-prod-chat-pool-bootstrap.sh");
        var script = ReadRepoFile("scripts/llmgw-prod-chat-pool-bootstrap.js");

        Assert.Contains("LLMGW_CHAT_BOOTSTRAP_ISOLATE_POOL:-1", shell);
        Assert.Contains("LLMGW_CHAT_BOOTSTRAP_POOL_CODE:-report-agent-weekly", shell);
        Assert.Contains("const nextModels = isolatePool ? [modelItem]", script);
        Assert.Contains("ModelGroupIds: isolatePool ? [pool._id]", script);
        Assert.Contains("isolated bootstrap refuses pool with Code=", script);
        Assert.Contains("IsDefaultForType: false", script);
        Assert.Contains("const gatewayDb = db.getSiblingDB(gatewayDbName)", script);
        Assert.Contains("GW authority caller must resolve exactly once", script);
        Assert.Contains("isolated GW authority bootstrap requires caller binding", script);
        Assert.Contains("tenantSource: callerTenantId ? \"caller\" : \"server-internal-default\"", script);
        Assert.Contains("otherGatewayReferences.length > 0", script);
        Assert.Contains("ModelPolicy: \"pool\"", script);
        Assert.Contains("TenantId: tenantId", script);
        Assert.Contains("GW authority post-write verification failed", script);
        Assert.Contains("backup_collection \"$gateway_db\" llmgw_model_pools", shell);
        Assert.Contains("--collection \"$backup_collection_name\" --archive --gzip", shell);
        Assert.Contains("SHA256SUMS", shell);
        Assert.DoesNotContain("LLMGW_CHAT_BOOTSTRAP_TENANT_ID", shell + script);
        Assert.DoesNotContain("const defaultPool = db.model_groups.findOne", script);
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
        Assert.Contains("scripts/llmgw-map-shadow-seed.py", script);
        Assert.Contains("scripts/llmgw-report-agent-shadow-seed.py", script);
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
        Assert.Contains("smoke_required=1", script);
        Assert.Contains("LLMGW_GATE_RUN_SMOKE:-1", script);
        Assert.Contains("--smoke-required \"$smoke_required\"", script);
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
        Assert.Contains("LLMGW_STAGE_MAP_BASE or PRD_AGENT_BASE", script);
        Assert.Contains("LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS=1", script);
        Assert.Contains("This does not bypass gateway release gates or completion-mode direct-transport checks.", script);
        Assert.Contains("preflight += \" --map-base ${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}\"", script);
        Assert.Contains("map_base=\"$(printf '%s' \"${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}\" | xargs || true)\"", script);
        Assert.Contains("preflight_args=\"$preflight_args --map-base $map_base\"", script);
        Assert.Contains("allow_missing_map_logs_waiver_for_stage()", script);
        Assert.Contains("canary-*|http-full)", script);
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
        Assert.Contains("\"smokeRequired\": _bool_flag(args.smoke_required)", ledger);
        Assert.Contains("append_parser.add_argument(\"--smoke-required\", default=\"1\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--smoke-required\", default=\"1\")", ledger);
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
        Assert.Contains("runtimeEvidenceComplete must remain false in static audit evidence", ledger);
        Assert.Contains("progressPercent must not report 100 while targetComplete=false", ledger);
        Assert.Contains("allowedPendingRuntimeGates", ledger);
        Assert.Contains("selfFinalizingHttpFullLedger", ledger);
        Assert.Contains("pending_http_full_ledger_only", ledger);
        Assert.Contains("allowedPending=", ledger);
        Assert.Contains("\"providerAuditExternalBlockers\": provider_external_blockers", ledger);
        Assert.Contains("_provider_external_blockers", ledger);
        Assert.Contains("contains external blockers", ledger);
        Assert.Contains("providerExternalBlockers", ledger);
        Assert.Contains("_require_prod_health_preflight_for_commit", ledger);
        Assert.Contains("\"prodHealthPreflightJson\": args.prod_health_preflight_json", ledger);
        Assert.Contains("\"prodHealthPreflightRequired\": _bool_flag(args.prod_health_preflight_required)", ledger);
        Assert.Contains("append_parser.add_argument(\"--prod-health-preflight-json\", default=\"\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--prod-health-preflight-json\", default=\"\")", ledger);
        Assert.Contains("production health preflight evidence", ledger);
        Assert.Contains("_require_protocol_canary_for_commit", ledger);
        Assert.Contains("\"protocolCanaryJson\": args.protocol_canary_json", ledger);
        Assert.Contains("\"protocolCanaryRequired\": _bool_flag(args.protocol_canary_required)", ledger);
        Assert.Contains("append_parser.add_argument(\"--protocol-canary-json\", default=\"\")", ledger);
        Assert.Contains("report_parser.add_argument(\"--protocol-canary-json\", default=\"\")", ledger);
        Assert.Contains("protocol canary evidence", ledger);
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("latestProtocolCanaryRequired", consoleProgram);
        Assert.Contains("latestHasProtocolCanaryJson", consoleProgram);
        Assert.Contains("missing.Add(\"protocolCanaryRequired\")", consoleProgram);
        Assert.Contains("missing.Add(\"protocolCanaryJson\")", consoleProgram);
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
        Assert.Contains("run_prod_preflight", readiness);
        Assert.Contains("scripts/llmgw-prod-preflight.py --mode start", readiness);
        Assert.Contains("--prod-preflight-json \\\"$prod_preflight_json\\\"", readiness);
        Assert.Contains("run_prod_health_preflight", readiness);
        Assert.Contains("scripts/llmgw-prod-health-preflight.py", readiness);
        Assert.Contains("prod-health-preflight.json", readiness);
        Assert.Contains("--prod-health-preflight-json \\\"$prod_health_preflight_json\\\"", readiness);
        Assert.Contains("--prod-health-preflight-required \\\"$prod_health_preflight_required\\\"", readiness);
        Assert.Contains("prodHealthPreflightRequired", readiness);
        Assert.Contains("protocol-canary.json", readiness);
        Assert.Contains("LLMGW_STAGE_RUN_PROTOCOL_CANARY", readiness);
        Assert.Contains("LLMGW_STAGE_PROTOCOL_CANARY_MAX_RUNTIME_CALLS", readiness);
        Assert.Contains("protocol_canary_default=1", readiness);
        Assert.Contains("canary-*|http-full", readiness);
        Assert.Contains("run_protocol_canary_evidence", readiness);
        Assert.Contains("scripts/llmgw-protocol-canary.py", readiness);
        Assert.Contains("--expect-commit \\\"$commit\\\"", readiness);
        Assert.Contains("--max-runtime-calls \\\"$protocol_canary_max_runtime_calls\\\"", readiness);
        Assert.Contains("--protocol-canary-json \\\"$protocol_canary_json\\\"", readiness);
        Assert.Contains("--protocol-canary-required \\\"$run_protocol_canary\\\"", readiness);
        Assert.Contains("protocolCanaryJson", readiness);
        Assert.Contains("protocolCanaryRequired", readiness);
        Assert.Contains("serving-probe.json", readiness);
        Assert.Contains("rollout-status.json", readiness);
        Assert.Contains("rolloutStatusRequired", readiness);
        Assert.Contains("rolloutStatusJson", readiness);
        Assert.Contains("run_rollout_status_ready_gate", readiness);
        Assert.Contains("scripts/llmgw-rollout-status.py", readiness);
        Assert.Contains("--require-ready", readiness);
        var releaseTreeIdx = script.IndexOf("validate_release_tree", StringComparison.Ordinal);
        var statusGateIdx = script.IndexOf("run_rollout_status_ready_gate", StringComparison.Ordinal);
        Assert.True(releaseTreeIdx >= 0 && statusGateIdx >= 0 && releaseTreeIdx < statusGateIdx);
        Assert.Contains("GW_SMOKE_JSON_OUT", readiness);
        Assert.Contains("--smoke-required \\\"$smoke_required\\\"", readiness);
        Assert.Contains("LLMGW_GATE_RUN_SMOKE:-1", readiness);
        Assert.Contains("LLMGW_STAGE_MIN_OBSERVATION_HOURS", readiness);
        Assert.Contains("LLMGW_RELEASE_MAIN_REF", readiness);
        Assert.Contains("validate_main_ancestry", readiness);
        Assert.Contains("if [ \\\"$stage\\\" = \\\"rollback-inproc\\\" ]; then", readiness);
        Assert.Contains("if [ \\\"$stage\\\" = \\\"rollback-rehearsal\\\" ]; then", readiness);
        Assert.Contains("LLM Gateway rollback rehearsal: release main SHA recorded without ancestry enforcement", readiness);
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
        Assert.Contains("runtimeEvidenceComplete", readiness);
        Assert.Contains("progressPercent", readiness);
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
        Assert.Contains("http-full", workflow);
        Assert.Contains("rollback-inproc", workflow);
        Assert.Contains("execute:", workflow);
        Assert.Contains("default: false", workflow);
        Assert.Contains("commit:\n        description: \"40-char release commit. Required for every non-rollback-inproc stage.\"\n        required: false", workflow);
        Assert.Contains("runner_labels_json", workflow);
        Assert.Contains("[\\\"self-hosted\\\",\\\"prd-agent-prod\\\"]", workflow);
        Assert.Contains("allow_release_tree_mismatch", workflow);
        Assert.Contains("INPUT_ALLOW_RELEASE_TREE_MISMATCH", workflow);
        Assert.Contains("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH=1", workflow);
        Assert.Contains("allow_missing_map_logs", workflow);
        Assert.Contains("INPUT_ALLOW_MISSING_MAP_LOGS", workflow);
        Assert.Contains("LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS=1", workflow);
        Assert.Contains("LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH", workflow);
        Assert.Contains("release_tree_mismatch_bypass", workflow);
        Assert.Contains("environment: production", workflow);
        Assert.Contains("PRD_AGENT_PROD_BASE", workflow);
        Assert.Contains("PRD_AGENT_PROD_API_KEY", workflow);
        Assert.Contains("LLMGW_PROD_GATE_BASE", workflow);
        Assert.Contains("LLMGW_PROD_GATE_KEY", workflow);
        Assert.Contains("PRD_AGENT_PROD_GITHUB_TOKEN", workflow);
        Assert.Contains("RUNNER_ADMIN_TOKEN_CONFIGURED", workflow);
        Assert.Contains("args+=(--allow-api-unavailable)", workflow);
        Assert.Contains("timeout-minutes: 30", workflow);
        Assert.Contains("rollout_evidence_run_id", workflow);
        Assert.Contains("actions: read", workflow);
        Assert.Contains("logs:read access", workflow);
        Assert.Contains("fetch-depth: 0", workflow);
        Assert.Contains("actions/download-artifact@v4", workflow);
        Assert.Contains("Restore previous rollout evidence", workflow);
        Assert.Contains("Restore trusted production maintenance evidence", workflow);
        Assert.Contains("Prepare production runtime inputs", workflow);
        Assert.Contains("PRODUCTION_RUNTIME_SOURCE: /root/inernoro/prd_agent", workflow);
        Assert.Contains("PRODUCTION_EVIDENCE_SOURCE: /root/inernoro/prd_agent/.llmgw-release-evidence", workflow);
        Assert.Contains("PRD_AGENT_DOTENV_FILE: /root/inernoro/prd_agent/.env", workflow);
        Assert.Contains("stat -c '%u' \"$env_source\"", workflow);
        Assert.Contains("reuse_existing_static_dist", workflow);
        Assert.Contains("INPUT_REUSE_EXISTING_STATIC_DIST", workflow);
        Assert.Matches("reuse_existing_static_dist:\\s+description:.*\\s+required: true\\s+default: false\\s+type: boolean", workflow);
        Assert.Contains("INPUT_REUSE_EXISTING_STATIC_DIST: ${{ github.event.inputs.reuse_existing_static_dist || 'false' }}", workflow);
        Assert.Contains("cp -a \"$dist_source/.\" deploy/web/dist/", workflow);
        Assert.Contains("export PRD_AGENT_REUSE_EXISTING_STATIC_DIST=0", workflow);
        Assert.DoesNotContain("production_evidence_source:", workflow);
        Assert.Contains("scripts/llmgw-prod-evidence-restore.py", workflow);
        Assert.Contains("--require-owner-uid 0", workflow);
        Assert.Contains("production-evidence-baseline-audit.json", workflow);
        Assert.Contains("llmgw-prod-stage-{0}", workflow);
        Assert.Contains("default branch", ReadRepoFile("doc/plan.platform.llm-gateway.full-cutover.md"));
        Assert.Contains("[ \"$stage\" != \"rollback-inproc\" ] && [ \"$stage\" != \"rollback-rehearsal\" ] && [ \"$stage\" != \"config-authority\" ] && [ -z \"$map_base\" ]", workflow);
        Assert.Contains("[ \"$stage\" != \"rollback-inproc\" ] && [ \"$stage\" != \"rollback-rehearsal\" ] && [ \"$stage\" != \"config-authority\" ] && [ \"$allow_missing_map_logs\" != \"true\" ] && [ -z \"$(printf '%s' \"${PRD_AGENT_API_KEY:-}\" | xargs)\" ]", workflow);
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
        Assert.Contains("maintenance_from_commit", workflow);
        Assert.Contains("INPUT_MAINTENANCE_FROM_COMMIT", workflow);
        Assert.Contains("args+=(--maintenance-from-commit \"$maintenance_from_commit\")", workflow);
        Assert.Contains("maintenance_from_commit is only valid for stage http-full", workflow);
        Assert.Contains("Audit recorded maintenance release", workflow);
        Assert.Contains("scripts/llmgw-rollout-ledger.py maintenance-baseline", workflow);
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
        Assert.Contains("Restore trusted production maintenance evidence", readiness);

        var runnerPrecheck = ReadRepoFile("scripts/llmgw-prod-runner-precheck.py");
        Assert.Contains("--allow-api-unavailable", runnerPrecheck);
        Assert.Contains("deferred-to-stage-job", runnerPrecheck);
        Assert.Contains("runner_job_handshake", runnerPrecheck);

        var evidenceRestore = ReadRepoFile("scripts/llmgw-prod-evidence-restore.py");
        Assert.Contains("Restore the minimum trusted rollout evidence", evidenceRestore);
        Assert.Contains("trusted evidence must not be a symlink", evidenceRestore);
        Assert.Contains("trusted evidence escapes source root", evidenceRestore);
        Assert.Contains("trusted evidence is world-writable", evidenceRestore);
        Assert.Contains("missing successful http-full baseline", evidenceRestore);
        Assert.Contains("LLM Gateway production evidence restore self-test: PASS", evidenceRestore);

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
        Assert.Contains("prod_health_preflight_is_readonly_commit_gate", script);
        Assert.Contains("scripts/llmgw-prod-health-preflight.py", script);
        var prodHealthPreflight = ReadRepoFile("scripts/llmgw-prod-health-preflight.py");
        Assert.Contains("Read-only LLM Gateway production health preflight", prodHealthPreflight);
        Assert.Contains("/gw/v1/healthz", prodHealthPreflight);
        Assert.Contains("--expect-current-head", prodHealthPreflight);
        Assert.Contains("--check-auth-boundary", prodHealthPreflight);
        Assert.Contains("healthz commit mismatch", prodHealthPreflight);
        Assert.Contains("auth boundary expected 401", prodHealthPreflight);
        Assert.Contains("never calls model providers", prodHealthPreflight);
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
        Assert.Contains("/readyz", script);
        Assert.Contains("_request(base, \"/readyz\", key=key)", script);
        Assert.Contains("readyz not ready", script);
        Assert.Contains("components", script);
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
    }

    [Fact]
    public void ProductionServing_HasDeterministicComposeIdentityDeepReadinessAndTwoInstances()
    {
        var compose = ReadRepoFile("docker-compose.yml");
        var cdsCompose = ReadRepoFile("cds-compose.yml");
        var deploy = ReadRepoFile("exec_dep.sh");
        var stage = ReadRepoFile("scripts/llmgw-prod-stage.sh");
        var endpoint = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var readiness = ReadRepoFile("llmgw/serving/GatewayServingReadinessProbe.cs");
        var nginx = ReadRepoFile("deploy/nginx/conf.d/branches/_standalone.conf");
        var imageNginx = ReadRepoFile("deploy/nginx/nginx.conf");
        var providerAudit = ReadRepoFile("scripts/llmgw-prod-provider-config-audit.py");
        var topologyPreflight = ReadRepoFile("scripts/llmgw-prod-topology-preflight.sh");
        var cdsServingStart = cdsCompose.LastIndexOf("\n  llmgw-serve:\n", StringComparison.Ordinal);
        var cdsServingEnd = cdsCompose.IndexOf("\n  llmgw-web:\n", cdsServingStart, StringComparison.Ordinal);
        Assert.True(cdsServingStart >= 0 && cdsServingEnd > cdsServingStart, "CDS llmgw-serve service block missing");
        var cdsServing = cdsCompose[cdsServingStart..cdsServingEnd];
        var cdsConsoleStart = cdsCompose.LastIndexOf("\n  llmgw:\n", StringComparison.Ordinal);
        Assert.True(cdsConsoleStart >= 0 && cdsServingStart > cdsConsoleStart, "CDS llmgw service block missing");
        var cdsConsole = cdsCompose[cdsConsoleStart..cdsServingStart];
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("PRD_AGENT_COMPOSE_PROJECT_NAME", deploy);
        Assert.Contains("COMPOSE_PROJECT_NAME", deploy);
        Assert.Contains("PRD_AGENT_COMPOSE_PROJECT_NAME", stage);
        Assert.Contains("AI_ACCESS_KEY=${AI_ACCESS_KEY:-}", compose);
        Assert.Contains("wait_for_llmgw_serving_readiness", deploy);
        Assert.Contains("llmgw-prod-topology-preflight.sh", deploy);
        Assert.Contains("LLMGW_SERVE_BASE_URL must be", topologyPreflight);
        Assert.Contains("LLMGW_READINESS_ASSET_PROBE_KEY", topologyPreflight);
        Assert.Contains("LLMGW_READINESS_REQUIRE_ASSET_PROBE=true", topologyPreflight);
        Assert.Contains("location = /health", nginx);
        Assert.Contains("proxy_pass http://api:8080/health;", nginx);
        Assert.Contains("location = /health", imageNginx);
        Assert.Contains("proxy_pass http://api:8080/health;", imageNginx);
        Assert.Contains("[ \"$health\" != \"healthy\" ]", deploy);
        Assert.Contains("llmgw-serve-b:", compose);
        Assert.Contains("condition: service_healthy", compose);
        Assert.Contains("/gw/v1/healthz", compose);
        Assert.Contains("LlmGateway__Readiness__RequireAssetProbe: \"false\"", cdsServing);
        Assert.Contains("LlmGateway__MongoConnectionString", cdsServing);
        Assert.Contains("LlmGateway__MongoConnectionString", cdsConsole);
        Assert.True(
            compose.Split("LlmGateway__MongoConnectionString", StringSplitOptions.None).Length - 1 >= 3,
            "正式 compose 的控制台与两份 serving 必须使用同一 GW Mongo 配置入口");
        Assert.Contains("config[\"LlmGateway:MongoConnectionString\"]", consoleProgram);
        Assert.Contains("gatewayMongoClient.GetDatabase(gatewayDbName)", consoleProgram);
        Assert.Contains("cds.readiness-path: \"/gw/v1/healthz\"", cdsServing);
        Assert.Contains("LlmGateway__ServeBaseUrl=${LLMGW_SERVE_BASE_URL:-http://gateway}", compose);
        Assert.DoesNotContain("http://gateway/gw/v1", compose);
        Assert.Contains("MapGet(\"/gw/v1/readyz\"", endpoint);
        Assert.DoesNotContain("map-mongo", readiness);
        Assert.Contains("gateway-mongo", readiness);
        Assert.Contains("asset-storage", readiness);
        Assert.Contains("key-integrity", readiness);
        Assert.Contains("router", readiness);
        Assert.Contains("routableCallers", readiness);
        Assert.Contains("IsPoolRoutableForRequestType", readiness);
        Assert.Contains("pool.IsDefaultForType", readiness);
        Assert.Contains("HasEnabledBackend", readiness);
        Assert.Contains("governed.Count > 0 && routableCallers == 0", readiness);
        Assert.Contains("exceptionType={ExceptionType}", readiness);
        Assert.DoesNotContain("ex.Message", readiness);
        Assert.Contains("server llmgw-serve:8091", nginx);
        Assert.Contains("server llmgw-serve-b:8091", nginx);
        Assert.Contains("llmgw-serve-b:8091 backup", nginx);
        Assert.Contains("proxy_next_upstream", nginx);
        Assert.DoesNotContain("non_idempotent", nginx);
        Assert.Contains("gatewayDb.llmgw_app_callers", providerAudit);
        Assert.Contains("gatewayDb.llmgw_model_pools", providerAudit);
        Assert.Contains("deferredUnboundGroups", providerAudit);
        Assert.Contains("unbound-to-production-appCaller", providerAudit);
        Assert.Contains("ASR appCaller RequestType mismatch", providerAudit);
        Assert.Contains("video appCaller RequestType mismatch", providerAudit);
    }

    [Fact]
    public void ShadowCoverageReport_RendersExplicitCoverageCellsWithoutLeakingKey()
    {
        var script = ReadRepoFile("scripts/llmgw-shadow-coverage-report.py");
        var endpoint = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");

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
        Assert.Contains("default branch", ReadRepoFile("doc/plan.platform.llm-gateway.full-cutover.md"));
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
        var plan = ReadRepoFile("doc/plan.platform.llm-gateway.full-cutover.md");

        Assert.Contains("--include-desktop-chat-run", script);
        Assert.Contains("--include-open-platform", script);
        Assert.Contains("--include-open-api-chat", script);
        Assert.Contains("--include-open-api-image", script);
        Assert.Contains("--include-model-lab-run", script);
        Assert.Contains("--include-arena-run", script);
        Assert.Contains("--include-report-agent-generate", script);
        Assert.Contains("--skip-text-seeds", script);
        Assert.Contains("skipTextSeeds", script);
        Assert.Contains("--skip-text-seeds cannot be combined", script);
        Assert.Contains("--skip-text-seeds requires at least one image, vision, video, or ASR include flag", script);
        Assert.Contains("focused_non_text_seed_requested", script);
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
        Assert.Contains("report-agent.generate::chat", plan);
        Assert.Contains("--include-visual-video-direct", script);
        Assert.Contains("--include-video-to-doc-asr", script);
        Assert.Contains("--include-video-to-text-asr-workflow", script);
        Assert.Contains("--asr-video-url", script);
        Assert.Contains("/api/visual-agent/video-gen/runs", script);
        Assert.Contains("/api/video-agent/v2d/runs", script);
        Assert.Contains("/api/workflow-agent/workflows", script);
        Assert.Contains("video-to-text", script);
        Assert.Contains("wait_visual_video_run", script);
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

        Assert.Contains("\"/invoke\"", script);
        Assert.Contains("invoke[{mtype}]", script);
        Assert.Contains("\"/send\"", script);
        Assert.Contains("send-compat[chat]", script);
        Assert.Contains("_sse_req", script);
        Assert.Contains("\"/stream\"", script);
        Assert.Contains("stream[chat]", script);
        Assert.Contains("\"/client-stream\"", script);
        Assert.Contains("client-stream[chat]", script);
        Assert.Contains("GW_SMOKE_PROMPT", script);
        Assert.Contains("GW_SMOKE_MAX_TOKENS", script);
        Assert.Contains("GW_SMOKE_REQUEST_TIMEOUT_SECONDS", script);
        Assert.Contains("\"Messages\": [{\"Role\": \"user\", \"Content\": SMOKE_PROMPT}]", script);
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
        Assert.Contains("\"LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST\": \"\"", restore);
        Assert.Contains("export LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=", restore);
        Assert.Contains("preserve_release_image_vars", restore);
        Assert.Contains("preserve_image_var PRD_AGENT_API_IMAGE prdagent-api", restore);
        Assert.Contains("RESTORE_PRD_AGENT_API_IMAGE", restore);
        Assert.Contains("\"PRD_AGENT_API_IMAGE\": os.environ.get(\"RESTORE_PRD_AGENT_API_IMAGE\", \"\")", restore);
    }

    /// <summary>
    /// 控制台探测上游用的地址推导，必须与网关真实调用用的是同一条「baseUrl 是否自带版本号」判据。
    ///
    /// 两边漂移的后果特别阴：控制台「测试连接」打的是 A 地址、说通了，业务真调用走 B 地址却 404。
    /// 用户拿到的是一个绿灯 + 一个不工作的 Provider，而两处单独看都没错
    /// （predicate-and-wiring-discipline 形状 3）。console-api 是独立工程、引用不到网关那份代码，
    /// 只能从源码上钉死。
    /// </summary>
    [Fact]
    public void ProviderPresets_VersionSuffixPredicateMatchesGatewayAdapter()
    {
        var adapter = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/Adapters/OpenAIGatewayAdapter.cs");
        var presets = ReadRepoFile("llmgw/console-api/Provisioning/ProviderPresets.cs");

        const string pattern = @"/(api/)?v\d+$";
        Assert.Contains(pattern, adapter);
        Assert.Contains(pattern, presets);
    }

    /// <summary>
    /// 价格只许来自上游。内置价目表会过时，而过时的价格比没有价格更危险——它看起来是真的，
    /// 成本报表照算，没人会去核对（no-rootless-tree.md）。
    /// </summary>
    [Fact]
    public void ProviderPresets_DoesNotShipABuiltinPriceTable()
    {
        var presets = ReadRepoFile("llmgw/console-api/Provisioning/ProviderPresets.cs");

        Assert.Contains("ReadPricing", presets);
        Assert.DoesNotContain("PriceTable", presets);
        Assert.DoesNotContain("BuiltinPricing", presets);
    }

    /// <summary>
    /// 每个预设都必须给用户一条**真能走通**的拿密钥路径：要么指向供应商的密钥控制台，
    /// 要么自带占位密钥由系统替他填。
    ///
    /// 由验收抓出：Ollama 预设的介绍写着「默认无需密钥」，而
    /// GatewayConfigurationProvisioning 照旧拒空密钥 —— 用户照文案留空就被拦下，
    /// 只能自己瞎填一个值才能过。这是 predicate-and-wiring-discipline 形状 8：
    /// 拿一份**在真实校验下不成立**的声明当成「已经支持」的证据。
    /// 文案不是判据，能不能保存才是。
    /// </summary>
    [Fact]
    public void ProviderPresets_每个预设都要有一条走得通的密钥路径()
    {
        var presets = ReadRepoFile("llmgw/console-api/Provisioning/ProviderPresets.cs");
        var listStart = presets.IndexOf("public static IReadOnlyList<ProviderPreset> All", StringComparison.Ordinal);
        Assert.True(listStart > 0, "预设清单的位置变了，守卫要跟着改");
        var body = presets[listStart..];

        // 每条形如：new("key", "名称", "type", "url", "provider", N,
        //            "密钥控制台 URL", "前缀", bool, bool,
        var matches = System.Text.RegularExpressions.Regex.Matches(
            body,
            "new\\(\"(?<key>[^\"]+)\",[^\\n]*\\n\\s*\"(?<console>[^\"]*)\",");
        Assert.True(matches.Count >= 10, $"只解析到 {matches.Count} 条预设，正则与源码格式对不上了");

        foreach (System.Text.RegularExpressions.Match match in matches)
        {
            var key = match.Groups["key"].Value;
            var hasKeyConsole = match.Groups["console"].Value.Trim().Length > 0;

            // 这一条预设的文本范围：从它自己开始，到下一条 new( 之前
            var from = match.Index;
            var nextNew = body.IndexOf("new(\"", from + 5, StringComparison.Ordinal);
            var entry = nextNew > 0 ? body[from..nextNew] : body[from..];
            var hasPlaceholder = entry.Contains("KeylessPlaceholder:", StringComparison.Ordinal);

            Assert.True(
                hasKeyConsole || hasPlaceholder,
                $"预设「{key}」既没给密钥控制台地址、也没给占位密钥，用户填不出一个能保存的值");

            // 声称不校验密钥，就必须真的能空手保存 —— 靠占位密钥兑现，而不是靠一句文案
            var claimsKeyless = entry.Contains("不校验密钥", StringComparison.Ordinal)
                || entry.Contains("无需密钥", StringComparison.Ordinal)
                || entry.Contains("不需要密钥", StringComparison.Ordinal);
            Assert.False(
                claimsKeyless && !hasPlaceholder,
                $"预设「{key}」的介绍声称不用密钥，但没有 KeylessPlaceholder 兜底，用户照文案留空会被后端拒绝");
        }
    }

    /// <summary>
    /// 单批导入上限在前后端各有一份。两份漂移的后果很具体：前端默认勾的比后端肯收的多，
    /// 用户点「导入」必吃 400，而两边单独看都没错（predicate-and-wiring-discipline 形状 3）。
    ///
    /// 由 review 抓出：OpenRouter 一次返回四百多个模型，第一版 defaultSelection 全勾，
    /// 默认路径本身就是坏的——得手动取消几百行才能继续。
    /// </summary>
    [Fact]
    public void 导入上限_前后端必须是同一个数且前端默认选中受它约束()
    {
        var server = ReadRepoFile("llmgw/console-api/Program.cs");
        var web = ReadRepoFile("llmgw/web/src/components/ProviderSetup.tsx");

        var serverLimit = System.Text.RegularExpressions.Regex.Match(server, @"MaxImportBatch\s*=\s*(\d+)");
        var webLimit = System.Text.RegularExpressions.Regex.Match(web, @"MAX_IMPORT_BATCH\s*=\s*(\d+)");
        Assert.True(serverLimit.Success, "后端的单批导入上限常量不见了");
        Assert.True(webLimit.Success, "前端没有声明单批导入上限，默认全选会撞后端 400");
        Assert.Equal(serverLimit.Groups[1].Value, webLimit.Groups[1].Value);

        // 默认选中必须真的截断，而不是只声明了个常量放着不用
        Assert.Contains("slice(0, MAX_IMPORT_BATCH)", web);
    }

    /// <summary>
    /// 批量导入完必须把模型同步进托管默认池——单模型端点一直这么做。
    /// 漏掉的话模型只是躺在集合里、不进任何池，池路由选不到：
    /// 用户看到「已导入 N 个」，业务侧却依旧调不通（形状 2）。
    /// </summary>
    [Fact]
    public void 批量导入上游模型后必须同步默认模型池()
    {
        var server = ReadRepoFile("llmgw/console-api/Program.cs");
        var importStart = server.IndexOf("/gw/platforms/{id}/models/import", StringComparison.Ordinal);
        Assert.True(importStart > 0, "批量导入端点不见了");
        // 端点体到下一个 MapPost 之前
        var next = server.IndexOf("app.MapPost(", importStart, StringComparison.Ordinal);
        var body = next > 0 ? server[importStart..next] : server[importStart..];

        Assert.Contains("EnsureGatewayModelPoolTypesAsync", body);
        // 同步失败要如实告知，不能吞掉后照报全绿
        Assert.Contains("PoolSyncFailed", body);
    }

    /// <summary>
    /// 「测试连接」的绿灯必须代表「这个 Provider 真能用」，不能只代表「HTTP 是 2xx」。
    ///
    /// 地址指到网站首页、前面挡着登录代理、对方是 SPA 全路径 fallback——统统回 200，
    /// body 却是 HTML。只看状态码就会给出绿灯 + 一个不工作的 Provider，
    /// 正是这条测试本身要防的那种假象（形状 8：拿不成立的证据当成立）。
    /// </summary>
    [Fact]
    public void 测试连接不得只凭状态码判可达()
    {
        var server = ReadRepoFile("llmgw/console-api/Program.cs");
        var probeStart = server.IndexOf("/gw/platforms/{id}/test", StringComparison.Ordinal);
        Assert.True(probeStart > 0, "测试连接端点不见了");
        var next = server.IndexOf("app.MapGet(", probeStart, StringComparison.Ordinal);
        var body = next > 0 ? server[probeStart..next] : server[probeStart..];

        Assert.Contains("shapeMismatch", body);
        // 裸的 Reachable = IsSuccessStatusCode 就是事故写法
        Assert.DoesNotContain("Reachable = resp.IsSuccessStatusCode,", body);
    }

    /// <summary>
    /// 两个新端点都会拿着用户填的地址向外发请求，等于新开了一个出口。
    /// 外部租户必须过与外部 Exchange 同一道内网地址校验，否则 owner 只要把地址填成
    /// 127.0.0.1 / 10.x / 169.254.169.254，就能拿控制台容器当跳板扫内网和云元数据。
    /// 探针客户端还必须关掉自动重定向——校验只对最初那个地址成立，跟随 302 就把它绕过去了。
    /// </summary>
    [Fact]
    public void 上游探测端点必须过内网地址校验且不跟随重定向()
    {
        var server = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("AllowAutoRedirect = false", server);
        Assert.Contains("ValidateProviderProbeTargetAsync", server);

        foreach (var route in new[] { "/gw/platforms/{id}/test", "/gw/platforms/{id}/upstream-models" })
        {
            var start = server.IndexOf(route, StringComparison.Ordinal);
            Assert.True(start > 0, $"端点 {route} 不见了");
            var next = server.IndexOf("app.Map", start + route.Length, StringComparison.Ordinal);
            var body = next > 0 ? server[start..next] : server[start..];
            Assert.True(
                body.Contains("ValidateProviderProbeTargetAsync", StringComparison.Ordinal),
                $"{route} 会向用户填的地址发请求却没过内网校验");
        }
    }

    /// <summary>
    /// 停用的 Provider 不许批量导入模型——与单模型端点一致。
    /// 不拦会走进静默坑：模型建出来了，但池同步会把「Provider 已停用」的模型排除**且不抛异常**，
    /// 于是 PoolSyncFailed 仍是 false、请求报成功，而这批模型对池路由根本不可见。
    /// </summary>
    [Fact]
    public void 停用的_Provider_不许导入模型()
    {
        var server = ReadRepoFile("llmgw/console-api/Program.cs");
        var start = server.IndexOf("/gw/platforms/{id}/models/import", StringComparison.Ordinal);
        Assert.True(start > 0, "批量导入端点不见了");
        var next = server.IndexOf("app.MapPost(", start, StringComparison.Ordinal);
        var body = next > 0 ? server[start..next] : server[start..];

        Assert.Contains("PLATFORM_DISABLED", body);
    }

    /// <summary>
    /// 从上游拉回来的值必须同时标来源与时间（minimal-user-input 第 2 条）。
    /// 只标来源不标时间时，面板开着不动的用户分不清手上这份报价是刚拉的还是很久以前的，
    /// 会照着过期价格做导入决定。
    /// </summary>
    /// <summary>
    /// 探测客户端必须在**真正建立连接的那一刻**校验对端 IP。
    ///
    /// 只在发请求前查一次 DNS 是不够的：HttpClient 连接时会再解析一次，控制着 rebinding
    /// 域名的租户可以让第一次返回公网地址、第二次返回 127.0.0.1 或 169.254.169.254，
    /// 前面那道校验就白做了（形状 6：判据读到的不是真正生效的那个值）。
    /// 放进 ConnectCallback 就没有窗口——被校验的地址和被连接的地址是同一个。
    /// </summary>
    [Fact]
    public void 探测客户端必须在连接时校验对端地址()
    {
        var server = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("ConnectCallback", server);
        Assert.Contains("IsSafeExternalExchangeAddress", server);
        // 整条探测（含读 body）要共用一个超时预算：ResponseHeadersRead 下
        // HttpClient.Timeout 只覆盖到响应头，body 挂住就没人管了
        Assert.Contains("probeCts.Token", server);
        Assert.Contains("discoveryCts.Token", server);
    }

    /// <summary>
    /// 批量导入不走 TryNormalizeModel，但校验口径必须与它同源——判定函数收在
    /// GatewayConfigurationProvisioning，两条入库路径共用一份。各写一份必然漂移：
    /// 直连调用能把任意用途名、负价格、超长标识塞进来，用途还会被池同步当成合法类型参与路由。
    /// </summary>
    [Fact]
    public void 批量导入的校验口径必须与单模型端点同源()
    {
        var provisioning = ReadRepoFile("llmgw/console-api/Provisioning/GatewayConfigurationProvisioning.cs");
        Assert.Contains("IsSupportedModelType", provisioning);
        Assert.Contains("IsValidPrice", provisioning);
        Assert.Contains("IsSupportedCurrency", provisioning);
        // 长度上限只许有一个字面量来源
        Assert.Contains("MaxModelNameLength", provisioning);

        var server = ReadRepoFile("llmgw/console-api/Program.cs");
        var start = server.IndexOf("/gw/platforms/{id}/models/import", StringComparison.Ordinal);
        var next = server.IndexOf("app.MapPost(", start, StringComparison.Ordinal);
        var body = next > 0 ? server[start..next] : server[start..];

        // 端点校验的是**存储层能力名**，用的是 IsSupportedCapabilityCode；
        // 断言成 IsSupportedModelType 会无条件红——守卫必须断言实现真正用的那个判据。
        Assert.Contains("IsSupportedCapabilityCode", body);
        Assert.Contains("IsValidPrice", body);
        Assert.Contains("MaxModelNameLength", body);
        // 池同步的触发条件不能写成「这次新建了几个」——同步失败后重试全是 Skipped，
        // Created 归零，同步块被跳过，我们自己那句「稍后重试导入」就成了空话
        Assert.Contains("result.Created > 0 || result.Skipped > 0", body);
    }

    /// <summary>
    /// 用途名与**存储层能力名**是两套词汇（`generation` -> `image_generation`），
    /// 映射只许有一份。拿用途白名单去校验存储名，会把推断出的 image_generation /
    /// video_generation 整批静默丢掉——生图与视频模型带着空用途入库，还照样默认勾选
    /// （形状 1：判据比它该管的范围窄）。
    /// </summary>
    [Fact]
    public void 推断出的每个用途都必须能通过导入端的校验()
    {
        var provisioning = ReadRepoFile("llmgw/console-api/Provisioning/GatewayConfigurationProvisioning.cs");
        var presets = ReadRepoFile("llmgw/console-api/Provisioning/ProviderPresets.cs");

        // 用途白名单
        var typesBlock = System.Text.RegularExpressions.Regex.Match(
            provisioning, @"SupportedModelTypes\s*=\s*\[(?<body>.*?)\]",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        Assert.True(typesBlock.Success, "用途白名单不见了");
        var types = System.Text.RegularExpressions.Regex.Matches(typesBlock.Groups["body"].Value, "\"([a-z-]+)\"")
            .Select(m => m.Groups[1].Value).ToHashSet();
        Assert.True(types.Count >= 10, $"只解析到 {types.Count} 个用途");

        // 映射（用途 -> 存储层能力名），与 ToCapabilityCode 同源
        string ToCode(string t) => t switch
        {
            "generation" => "image_generation",
            "long-context" => "long_context",
            "video-gen" => "video_generation",
            "audio-gen" => "audio_generation",
            _ => t,
        };
        var codes = types.Select(ToCode).ToHashSet();

        // 推断可能产出的每一个值
        var inferred = System.Text.RegularExpressions.Regex.Matches(presets, @"caps\.Add\(""([a-z_]+)""\)")
            .Select(m => m.Groups[1].Value).ToHashSet();
        Assert.True(inferred.Count >= 5, $"只解析到 {inferred.Count} 个推断用途");

        var dropped = inferred.Where(c => !codes.Contains(c)).ToList();
        Assert.True(dropped.Count == 0, "这些推断出的用途过不了导入端校验，会被静默丢掉：" + string.Join("、", dropped));

        // 映射必须只有一份
        Assert.Contains("ToCapabilityCode", provisioning);
        Assert.Contains("IsSupportedCapabilityCode", provisioning);
        Assert.Contains("IsSupportedCapabilityCode", ReadRepoFile("llmgw/console-api/Program.cs"));
    }

    /// <summary>
    /// 上游返回的字段形状不可信，解析必须先确认类型再索引。
    ///
    /// JsonNode 对非对象节点做 node["x"] 会抛 InvalidOperationException，
    /// 而 pricing 是个非标准扩展、谁都能把它写成字符串或数组。那一抛会穿过只接
    /// JsonException 的 catch，把「查看模型」整条请求变成 500——一个模型的字段形状
    /// 不合口味，整份清单就拉不出来。同一个坑在 EmbeddingService 解析 data 时踩过一次。
    ///
    /// 顺带钉住条目上限：字节上限管不住条目数，几十万个小对象照样塞得进 8MB。
    /// </summary>
    [Fact]
    public void 上游清单解析必须先判类型且条目有上限()
    {
        var presets = ReadRepoFile("llmgw/console-api/Provisioning/ProviderPresets.cs");
        // 裸 modelNode?["pricing"] 直接索引就是事故写法
        Assert.Contains("as JsonObject", presets);
        Assert.DoesNotContain("var pricing = modelNode?[\"pricing\"];", presets);

        var server = ReadRepoFile("llmgw/console-api/Program.cs");
        // 同一个坑的第三处：根节点不是对象（上游直接回 [] 或回个标量）时，
        // Parse(body)?["data"] 抛的同样是 InvalidOperationException，而「查看模型」端点
        // 只 catch JsonException —— 整条请求变 500，而不是它自己声称会给的 UPSTREAM_SHAPE。
        // 必须先 as JsonObject 再索引，转型失败自然落进「没有 data 数组」分支。
        Assert.DoesNotContain("JsonNode.Parse(body)?[\"data\"]", server);
        Assert.Contains("MaxDiscoveredModels", server);
        Assert.Contains("Take(MaxDiscoveredModels)", server);
        // 截断不许静默：得让用户看见上游原本有多少
        Assert.Contains("TruncatedFromTotal", server);
        Assert.Contains("TruncatedFromTotal", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("truncatedFromTotal", ReadRepoFile("llmgw/web/src/components/ProviderSetup.tsx"));
    }

    /// <summary>
    /// 换 Provider 必须重挂模型选择器。勾选集是 useState 的初始值，只在挂载时算一次；
    /// 开着 A 的清单再点 B 的「查看模型」时组件不卸载，A 的勾选原样留着，
    /// 撞上同名模型就会把用户没勾过的选择导进 B。key 一改，React 才会重建这个组件。
    /// </summary>
    [Fact]
    public void 换_Provider_必须重挂上游模型选择器()
    {
        var page = ReadRepoFile("llmgw/web/src/pages/PlatformsPage.tsx");
        var start = page.IndexOf("<UpstreamModelPicker", StringComparison.Ordinal);
        Assert.True(start > 0, "上游模型选择器不见了");
        var end = page.IndexOf("/>", start, StringComparison.Ordinal);
        Assert.True(end > start, "上游模型选择器的 JSX 没闭合，守卫切不出它的 props");
        Assert.Contains("key={discovery.platformId}", page[start..end]);
    }

    [Fact]
    public void 上游拉回来的清单必须带拉取时间()
    {
        Assert.Contains("FetchedAt", ReadRepoFile("llmgw/console-api/Models/Dtos.cs"));
        Assert.Contains("FetchedAt = DateTime.UtcNow", ReadRepoFile("llmgw/console-api/Program.cs"));
        Assert.Contains("formatFetchedAt", ReadRepoFile("llmgw/web/src/components/ProviderSetup.tsx"));
    }

    /// <summary>
    /// 导入的模型必须写 ModelNameNormalized。唯一索引带 PartialFilterExpression，
    /// 只覆盖这个字段是字符串的文档——不写就等于这批模型不参与唯一约束，
    /// 两个并发导入各自算出同一份 existing 快照后双双插入，同名模型重复。
    /// </summary>
    [Fact]
    public void 导入的模型必须参与唯一索引()
    {
        var server = ReadRepoFile("llmgw/console-api/Program.cs");
        var start = server.IndexOf("/gw/platforms/{id}/models/import", StringComparison.Ordinal);
        Assert.True(start > 0, "批量导入端点不见了");
        var next = server.IndexOf("app.MapPost(", start, StringComparison.Ordinal);
        var body = next > 0 ? server[start..next] : server[start..];

        Assert.Contains("ModelNameNormalized", body);
        // 并发撞唯一索引要按「已存在」吞掉，不能整批失败
        Assert.Contains("DuplicateKey", body);
    }

    /// <summary>
    /// 凡是把 HostedSite 交给前端的公开方法，都必须挂上派生字段（目前是 PdfAssetUrl）。
    ///
    /// 上一轮我按判断挑了七条「前端会用到的」路径去挂，review 立刻找出漏掉的
    /// SetVisibilityAsync：用户把 PDF 站发布/取消公开后，前端用那个响应整条替换列表项，
    /// 于是刚打开的大预览又退回依赖 CDN 的壳子——靠人挑路径本身就是形状 3 的温床。
    /// 改成全覆盖，并用这条守卫钉住：新增路径而忘了挂，CI 直接红。
    ///
    /// 切片边界必须是**下一个成员声明**，不能是「下一个返回 HostedSite 的方法」。
    /// 后者是第一版的写法，也被 review 抓了：最后几个方法的切片会一路吞到文件末尾，
    /// 把 AttachDerivedFields 的**定义**本身算成一次调用——去掉 ListAllByUserIdAsync
    /// 自己的包装，守卫照样全绿。一个不会红的守卫比没有守卫更糟（形状 4）。
    /// </summary>
    [Fact]
    public void 交付给前端的每条_HostedSite_路径都要挂上派生字段()
    {
        var src = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs");
        var lines = src.Split('\n');

        // 类成员一律在 4 空格缩进上声明；方法体内的局部函数缩进更深，不会被误当成边界。
        static bool IsMemberDeclaration(string line)
            => System.Text.RegularExpressions.Regex.IsMatch(line, @"^    (public|private|internal|protected)\b");

        static bool ReturnsHostedSite(string line)
            => System.Text.RegularExpressions.Regex.IsMatch(
                line, @"public async Task<(HostedSite\??|List<HostedSite>|\(List<HostedSite>)");

        var memberStarts = new List<int>();
        for (var i = 0; i < lines.Length; i++)
            if (IsMemberDeclaration(lines[i])) memberStarts.Add(i);
        Assert.True(memberStarts.Count > 20, $"只解析到 {memberStarts.Count} 个成员声明，正则与源码格式对不上了");

        var checkedCount = 0;
        var missing = new List<string>();
        for (var k = 0; k < memberStarts.Count; k++)
        {
            var from = memberStarts[k];
            if (!ReturnsHostedSite(lines[from])) continue;
            checkedCount++;

            // 只看**这一个方法自己的**方法体：到下一个成员声明为止
            var to = k + 1 < memberStarts.Count ? memberStarts[k + 1] : lines.Length;
            var body = string.Join("\n", lines[from..to]);
            if (!body.Contains("AttachDerivedFields(", StringComparison.Ordinal))
            {
                var name = System.Text.RegularExpressions.Regex.Match(lines[from], @"Task<[^>]*>+\s*(\w+)");
                missing.Add(name.Success ? name.Groups[1].Value : lines[from].Trim());
            }
        }

        Assert.True(checkedCount >= 10, $"只检查到 {checkedCount} 个交付方法，边界解析出问题了");
        Assert.True(missing.Count == 0,
            "这些方法把 HostedSite 交给了前端却没挂派生字段，PDF 站在这些路径上会退回壳子：" + string.Join("、", missing));
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

    /// <summary>
    /// 失败关闭只在「认定有专属绑定」时才被查，所以绑定判据必须是唯一的一份。
    /// 生产 ResolveAsync 与 InMemoryModelResolver 各判一次的话，改一处忘一处，
    /// 失败关闭会在其中一条路径上静默失效（predicate-and-wiring-discipline 形状 3）。
    /// 这里断言两条解析路径都走同一个 HasDedicatedBinding。
    /// </summary>
    [Fact]
    public void ModelResolver_BothResolutionPathsShareTheDedicatedBindingPredicate()
    {
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");

        var uses = System.Text.RegularExpressions.Regex
            .Matches(resolver, @"HasDedicatedBinding\(requirement\?\.ModelGroupIds\)")
            .Count;

        Assert.True(uses >= 2,
            $"生产与 InMemory 两条解析路径都必须用共享的 HasDedicatedBinding 判据，实际只有 {uses} 处");
    }

    [Fact]
    public void ModelResolver_AvailablePoolsFailClosedBeforeMapFallbackForExternalTenants()
    {
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var methodStart = resolver.IndexOf("public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync", StringComparison.Ordinal);
        var mapFallback = resolver.IndexOf("var appCaller = await _db.LLMAppCallers", methodStart, StringComparison.Ordinal);
        var externalTenantGuard = resolver.IndexOf(
            "if (!string.Equals(CurrentTenantId, _internalTenantId, StringComparison.Ordinal))",
            methodStart,
            StringComparison.Ordinal);

        Assert.True(methodStart >= 0 && mapFallback > methodStart, "找不到 available-pools MAP fallback");
        Assert.True(
            externalTenantGuard > methodStart && externalTenantGuard < mapFallback,
            "外部租户必须在读取 MAP LLMAppCallers/ModelGroups 前 fail closed");
    }

    [Fact]
    public void ImageGenRunWorker_DoesNotSilentlyDowngradeReferenceImageRunsToText2Img()
    {
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs");

        Assert.Contains("expectedReferenceCount", worker);
        Assert.Contains("IMAGE_REF_UNAVAILABLE", worker);
        Assert.Contains("其他输入已保留", worker);
        Assert.Contains("missingTags", worker);
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
    public void ConsoleLogsSummary_ExposesProtocolRouterDistributions()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var consoleDtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var consoleTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");

        foreach (var field in new[] { "SourceSystem", "IngressProtocol", "ModelPolicy" })
        {
            Assert.Contains($".Include(\"{field}\")", consoleProgram);
            Assert.Contains($"BuildBucket(docs, \"{field}\", fallbackKey: \"unknown\")", consoleProgram);
        }

        Assert.Contains("public List<LogsBucketItem> SourceSystemDistribution", consoleDtos);
        Assert.Contains("public List<LogsBucketItem> IngressProtocolDistribution", consoleDtos);
        Assert.Contains("public List<LogsBucketItem> ModelPolicyDistribution", consoleDtos);
        Assert.Contains("sourceSystemDistribution: LogsBucketItem[]", consoleTypes);
        Assert.Contains("ingressProtocolDistribution: LogsBucketItem[]", consoleTypes);
        Assert.Contains("modelPolicyDistribution: LogsBucketItem[]", consoleTypes);
        Assert.Contains("<details className=\"lg-log-filters lg-log-filter-menu\">", logsView);
        Assert.Contains("meta.ingressProtocols.map", logsView);
        Assert.Contains("setFilterIngressProtocol", logsView);
        Assert.Contains("meta.modelPolicies.map", logsView);
        Assert.Contains("setFilterModelPolicy", logsView);
        Assert.Contains("meta.sourceSystems.map", logsView);
        Assert.Contains("setFilterSourceSystem", logsView);
        Assert.DoesNotContain("<DistributionStrip", logsView);
        Assert.Contains("aria-label=\"入口协议\"", logsView);
        Assert.Contains("value={filterIngressProtocol}", logsView);
        Assert.Contains("aria-label=\"路由策略\"", logsView);
        Assert.Contains("value={filterModelPolicy}", logsView);
        Assert.Contains("aria-label=\"来源系统\"", logsView);
        Assert.Contains("value={filterSourceSystem}", logsView);
    }

    [Fact]
    public void AsyncVideoLogViews_PreserveLogicalChainsAndPhysicalAttemptCounts()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs");
        var videoClient = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/OpenRouterVideoClient.cs");
        var logWriter = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs");

        Assert.Contains("fb.Eq(\"Operation\", BsonNull.Value)", console);
        Assert.Contains(".Include(\"ProviderAttempts\")", console);
        Assert.Contains(".SelectMany(MapProviderAttempts)", console);
        Assert.Contains("UpstreamCalls = physicalAttempts.Count", console);
        Assert.Contains("attempt.ReachedProvider != false", console);
        Assert.Contains("ReachedProvider = doc.AsNullableBool(\"ReachedProvider\")", console);
        Assert.Contains("CompletePendingSendAttempt(rawProviderAttempts", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs"));
        Assert.Contains("StatusQueries = physicalDocs.LongCount(d => ResolveLogOperation(d) == \"status\") + internalStatusQueries", console);
        Assert.Contains("new BsonRegularExpression($\"(^|/){escapedProviderTaskId}(/|$)\")", console);
        Assert.Contains("detail.UpstreamCallCount = relatedAttempts.Count", console);
        Assert.Contains("relatedAttempts.LongCount(IsProviderPollAttempt)", console);
        Assert.Contains(".Include(\"ProviderAttempts\")", console);
        Assert.Contains(".Include(\"Model\")", console);
        Assert.Contains(".Include(\"Provider\")", console);
        Assert.Contains("var logicalRequestId = detail.LogicalRequestId;", console);
        Assert.DoesNotContain("detail.LogicalRequestId ?? detail.RunId", console);
        Assert.DoesNotContain("Filter.Eq(\"RunId\", logicalRequestId)", console);
        Assert.Contains("idx_llmgw_logs_tenant_provider_task", console);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"ProviderTaskId\", detail.ProviderTaskId)", console);
        Assert.Contains("related.Count == 1", console);
        Assert.Contains("var legacyPathFilter", console);
        Assert.Contains("_logWriter.BindProviderTaskAsync", videoClient);
        Assert.Contains("fallbackLogicalRequestId: jobId", videoClient);
        Assert.Contains("log => log.ProviderTaskId", logWriter);
        Assert.Contains("log => log.LogicalRequestId", logWriter);
        Assert.DoesNotContain("?? request.Context?.RunId\n                        ?? request.Context?.RequestId", ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs"));

        const string sceneMethodSignature = "internal async Task ProcessSceneRenderAsync(";
        var sceneStart = worker.IndexOf(sceneMethodSignature, StringComparison.Ordinal);
        var sceneEnd = worker.IndexOf("private async Task<bool> RenewSceneRenderLeaseAsync", sceneStart, StringComparison.Ordinal);
        Assert.True(sceneStart >= 0 && sceneEnd > sceneStart, "找不到单镜渲染方法");
        var sceneMethod = worker[sceneStart..sceneEnd];
        var contextScope = sceneMethod.IndexOf("using var sceneContextScope = ctxAccessor.BeginScope", StringComparison.Ordinal);
        var submitBranch = sceneMethod.IndexOf("if (!resumeExistingJob)", StringComparison.Ordinal);
        var pollingLoop = sceneMethod.IndexOf("while (DateTime.UtcNow < deadline)", StringComparison.Ordinal);
        Assert.True(contextScope >= 0 && contextScope < submitBranch && contextScope < pollingLoop,
            "场景逻辑请求上下文必须覆盖提交、恢复轮询和下载全链路");

        Assert.Contains("operation: subtab === 'upstream' ? filterOperation || undefined : undefined", logsView);
        Assert.Contains("subtab === 'upstream' ? filterOperation : ''", logsView);
        Assert.Contains("{subtab === 'upstream' ? (", logsView);
    }

    [Fact]
    public void VideoGenerationErrors_MustPassPersistenceAndResponseSafetyGates()
    {
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs");
        var videoController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/VideoAgentController.cs");
        var visualController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/VisualAgentVideoController.cs");

        Assert.Contains("VideoGenerationUserError.ForPersistence(errorCode, errorMessage)", worker);
        Assert.Contains("VideoGenerationUserError.ForPersistence(\"SCENE_RENDER_FAILED\", errorMessage)", worker);
        Assert.Contains("VideoGenerationUserError.ForPersistence(\"EXPORT_FAILED\", errorMessage)", worker);
        Assert.Contains("VideoGenerationUserError.SanitizeForResponse(run)", videoController);
        Assert.Contains("VideoGenerationUserError.SanitizeForResponse(run)", visualController);
        Assert.Contains("VideoGenerationUserError.SanitizeEventPayload(ev.EventName, ev.PayloadJson)", videoController);
        Assert.Contains("VideoGenerationUserError.SanitizeEventPayload(ev.EventName, ev.PayloadJson)", visualController);
    }

    [Fact]
    public void ExternalConsole_CostSummaryPreservesUnknownAndCurrencyBoundaries()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var consoleDtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var consoleTypes = ReadRepoFile("llmgw/web/src/lib/types.ts");
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");

        Assert.Contains(".Include(\"EstimatedCost\")", consoleProgram);
        Assert.Contains(".Include(\"EstimatedCostCurrency\")", consoleProgram);
        Assert.Contains(".Include(\"InputPricePerMillion\")", consoleProgram);
        Assert.Contains(".Include(\"OutputPricePerMillion\")", consoleProgram);
        Assert.Contains("x.Amount is not null && x.Currency is not null && x.Complete", consoleProgram);
        Assert.Contains("GroupBy(x => x.Currency!", consoleProgram);
        Assert.Contains("UnknownCostRequests = docs.Count - pricedDocs.Count", consoleProgram);
        Assert.Contains("EstimatedCostUsd = usdDocs.Count == 0 ? null", consoleProgram);
        Assert.DoesNotContain("EstimatedCostUsd = docs.Sum", consoleProgram);
        Assert.Contains("public decimal? EstimatedCostUsd", consoleDtos);
        Assert.Contains("public List<EstimatedCostBucket> EstimatedCosts", consoleDtos);
        Assert.Contains("estimatedCostUsd?: number | null", consoleTypes);
        Assert.Contains("unknownCostRequests: number", consoleTypes);
        Assert.Contains("priceCoveragePercent: number", consoleTypes);
        Assert.Contains("fmtCost(it.estimatedCost, it.estimatedCostCurrency)", logsView);
        Assert.Contains("缺价格保持未知，不显示为 0", logsView);
        Assert.Contains("有完整价格快照时显示估算；缺价格保持未知，不显示为 0。", logsView);
        Assert.Contains("未知：缺 token 或价格快照", ReadRepoFile("llmgw/web/src/components/GenerationDetailsDrawer.tsx"));
    }

    [Fact]
    public void ExternalConsole_UsesSidebarAndKeepsOperationsOffHomePage()
    {
        var layout = ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx");
        var home = ReadRepoFile("llmgw/web/src/pages/HomePage.tsx");
        var governance = ReadRepoFile("llmgw/web/src/pages/OverviewPage.tsx");

        foreach (var group in new[] { "工作区", "路由", "开发者", "组织", "治理", "设置" })
            Assert.Contains($"label: '{group}'", layout);
        Assert.Contains("<aside className={`lg-console-sidebar", layout);
        Assert.Contains("className={`lg-tenant-switcher ${className}`}", layout);
        Assert.Contains("renderTenantSwitcher('lg-desktop-tenant-switcher')", layout);
        Assert.Contains("renderTenantSwitcher('lg-mobile-tenant-switcher')", layout);
        Assert.Contains("按 requestId 定位请求", layout);
        Assert.Contains("健康状态", home);
        Assert.Contains("Quickstart", home);
        Assert.Contains("最近请求", home);
        Assert.Contains("费用可信度", home);
        Assert.DoesNotContain("RuntimeGatePanel", home);
        Assert.DoesNotContain("TOPOLOGY", home);
        Assert.Contains("RuntimeGatePanel", governance);
        Assert.Contains("TOPOLOGY", governance);
    }

    [Fact]
    public void TenantSwitcher_ResolvesMembershipsFromServerUserAndTenantIds()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var endpointStart = consoleProgram.IndexOf("app.MapGet(\"/gw/auth/tenants\"", StringComparison.Ordinal);
        var endpointEnd = consoleProgram.IndexOf("app.MapPost(\"/gw/auth/switch-tenant\"", endpointStart, StringComparison.Ordinal);
        Assert.True(endpointStart >= 0 && endpointEnd > endpointStart);
        var endpoint = consoleProgram[endpointStart..endpointEnd];

        Assert.Contains("access.UserId", endpoint);
        Assert.Contains("Filter.In(x => x.TenantId, authorizedTenantIds)", endpoint);
        Assert.Contains("Filter.Eq(x => x.UserId, access.UserId)", endpoint);
        Assert.DoesNotContain("[FromBody]", endpoint);
        Assert.DoesNotContain("body.", endpoint);
    }

    [Fact]
    public void Console_InternalOperationsVisibility_ComesFromServerTenantContext()
    {
        var tenantModel = ReadRepoFile("llmgw/console-api/Models/LlmGwTenantModels.cs");
        var access = ReadRepoFile("llmgw/console-api/Auth/TenantAccessContext.cs");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var app = ReadRepoFile("llmgw/web/src/App.tsx");
        var accessRules = ReadRepoFile("llmgw/web/src/lib/access.ts");

        Assert.Contains("public bool IsInternal { get; set; }", tenantModel);
        Assert.Contains("bool IsInternalTenant", access);
        Assert.Contains("tenant.IsInternal", access);
        Assert.Contains("IsInternal = access.IsInternalTenant", consoleProgram);
        Assert.Contains("IsInternal = tenant.IsInternal", consoleProgram);
        Assert.Contains("function RequirePageAccess", app);
        Assert.Contains("if (!isTenantRole(tenant?.role))", app);
        Assert.Contains("控制台不会加载导航或业务接口", app);
        Assert.Contains("<RequirePageAccess page=\"home\"><OverviewPage", app);
        Assert.Contains("<RequirePageAccess page=\"learn\"><LearningCenterPage", app);
        Assert.Contains("<RequirePageAccess page=\"settings\"><SettingsPage", app);
        Assert.Contains("canAccessPage(tenant, page)", app);
        Assert.Contains("internalOnly: true", accessRules);
        Assert.Contains("if (rule.internalOnly && !tenant.isInternal) return false", accessRules);
        Assert.DoesNotContain("TenantId", app);
    }

    [Fact]
    public void Console_RbacVisibility_MirrorsServerPermissionsAndFailsClosed()
    {
        var serverAccess = ReadRepoFile("llmgw/console-api/Auth/TenantAccessContext.cs");
        var accessRules = ReadRepoFile("llmgw/web/src/lib/access.ts");
        var app = ReadRepoFile("llmgw/web/src/App.tsx");
        var layout = ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx");
        var pools = ReadRepoFile("llmgw/web/src/pages/ModelPoolsPage.tsx");
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");
        var serviceKeys = ReadRepoFile("llmgw/web/src/pages/ServiceKeysPage.tsx");
        var governance = ReadRepoFile("llmgw/web/src/pages/OverviewPage.tsx");

        Assert.Contains("LlmGwTenantRoles.Owner => true", serverAccess);
        Assert.Contains("LlmGwTenantRoles.Billing => permission is UsageRead", serverAccess);
        Assert.Contains("logsRead: ['owner', 'admin', 'developer', 'viewer']", accessRules);
        Assert.Contains("usageRead: ALL_ROLES", accessRules);
        Assert.Contains("configWrite: ['owner', 'admin']", accessRules);
        Assert.Contains("appCallerWrite: ['owner', 'admin', 'developer']", accessRules);
        Assert.Contains("serviceKeyWrite: ['owner', 'admin', 'developer']", accessRules);
        Assert.Contains("home: { capability: 'usageRead' }", accessRules);
        Assert.Contains("governance: { capability: 'logsRead', internalOnly: true }", accessRules);
        Assert.Contains("return isTenantRole(role)", accessRules);
        Assert.Contains("function RequirePageAccess", app);
        Assert.Contains("不会再发起注定失败的请求", app);
        Assert.Contains("items: group.items.filter((item) => canAccessPage(tenant, item.page))", layout);
        Assert.Contains("const canSearchRequests = canUseCapability(tenant?.role, 'logsRead')", layout);
        Assert.Contains("canWrite={canWrite}", pools);
        Assert.Contains("当前角色可以查看模型池、成员健康和路由使用情况", pools);
        Assert.Contains("const canCreateAccess = canUseCapability", quickstart);
        Assert.Contains("不能创建 appCaller、签发密钥或执行安全直测", quickstart);
        Assert.Contains("const canCreateWildcard = canCreateWildcardServiceKey(tenant?.role)", serviceKeys);
        Assert.Contains("Developer 只能创建明确限定 appCaller、协议和 scope 的团队密钥", serviceKeys);
        Assert.Contains("if (canManageLegacyCutover)", serviceKeys);
        Assert.Contains("const canWrite = canUseCapability(tenant?.role, 'configWrite')", governance);
        Assert.Contains("当前角色可以查看运行状态、配置权威和容器拓扑", governance);
    }

    [Fact]
    public void Console_Productization_UsesRealOriginSafeTestAndGuidedEmptyStates()
    {
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");
        var serviceKeys = ReadRepoFile("llmgw/web/src/pages/ServiceKeysPage.tsx");
        var logs = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");
        var theme = ReadRepoFile("llmgw/web/src/lib/theme.ts");
        var servingProgram = ReadRepoFile("llmgw/serving/Program.cs");

        Assert.Contains("return new URL(window.location.href).origin", quickstart);
        Assert.Contains("createGatewayAppCaller", quickstart);
        Assert.Contains("createServiceKey", quickstart);
        Assert.Contains("X-Gateway-Dry-Run", quickstart);
        Assert.Contains("const definition = protocolDefinition(protocol);", quickstart);
        Assert.Contains("PROTOCOLS.map((item) => item.ingressProtocol)", quickstart);
        var quickstartTestStart = quickstart.IndexOf("const runTest", StringComparison.Ordinal);
        var quickstartTestEnd = quickstart.IndexOf("const editIdentity", quickstartTestStart, StringComparison.Ordinal);
        Assert.True(quickstartTestStart >= 0 && quickstartTestEnd > quickstartTestStart);
        Assert.DoesNotContain("bundle.protocol", quickstart[quickstartTestStart..quickstartTestEnd]);
        Assert.Contains("upstreamCalled === false", quickstart);
        Assert.Contains("/logs?requestId=", quickstart);
        Assert.Contains("Agent Skill", quickstart);
        Assert.Contains("credentials: 'omit'", quickstart);
        Assert.DoesNotContain("gateway.example.com", quickstart);
        Assert.DoesNotContain("localStorage", quickstart);
        Assert.DoesNotContain("sessionStorage", quickstart);
        Assert.Contains("invoke, route:read", serviceKeys);
        Assert.Contains("gw-native, openai-compatible, claude-compatible, gemini-compatible", serviceKeys);
        Assert.Contains("平台内部服务使用部署级内部身份", serviceKeys);
        Assert.Contains("创建第一把密钥", serviceKeys);
        Assert.Contains("去快速接入", logs);
        Assert.Contains("查看示例说明", logs);
        Assert.Contains("跟随系统", ReadRepoFile("llmgw/web/src/pages/SettingsPage.tsx"));
        Assert.Contains("prefers-color-scheme: light", theme);
        Assert.Contains("WithMethods(HttpMethods.Get, HttpMethods.Post)", servingProgram);
        Assert.Contains("\"X-Gateway-Dry-Run\"", servingProgram);
        Assert.Contains("WithExposedHeaders(\"X-Request-Id\", \"X-Gateway-Upstream-Called\")", servingProgram);
        Assert.Contains("app.UseCors(BrowserDryRunCors)", servingProgram);
    }

    [Fact]
    public void Console_RelatedRoutingObjects_OpenInlinePreviewsWithoutExposingSecrets()
    {
        var preview = ReadRepoFile("llmgw/web/src/components/EntityPreviewDrawer.tsx");
        var platforms = ReadRepoFile("llmgw/web/src/pages/PlatformsPage.tsx");
        var models = ReadRepoFile("llmgw/web/src/pages/ModelsPage.tsx");
        var appCallers = ReadRepoFile("llmgw/web/src/pages/AppCallersPage.tsx");
        var exchanges = ReadRepoFile("llmgw/web/src/pages/ExchangesPage.tsx");

        Assert.Contains("createPortal", preview);
        Assert.Contains("role=\"dialog\"", preview);
        Assert.Contains("aria-modal=\"true\"", preview);
        Assert.Contains("event.key === 'Escape'", preview);
        Assert.Contains("event.key !== 'Tab'", preview);
        Assert.Contains("triggerButtonRef.current?.focus()", preview);
        Assert.Contains("密钥明文不会在预览中显示", preview);

        Assert.Contains("Provider 接口预览", platforms);
        Assert.Contains("查看接口", platforms);
        Assert.Contains("查看 Provider", models);
        Assert.Contains("预览模型池", appCallers);
        Assert.Contains("Exchange 路由预览", exchanges);
        Assert.Contains("查看路由", exchanges);

        Assert.DoesNotContain("apiKey={", preview);
        Assert.DoesNotContain("bundle.key", preview);
    }

    [Fact]
    public void Console_GenerationDetails_PrioritizesResultsAndProgressivelyDisclosesAuditFields()
    {
        var drawer = ReadRepoFile("llmgw/web/src/components/GenerationDetailsDrawer.tsx");
        var logs = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");
        var entityDetails = ReadRepoFile("llmgw/web/src/pages/EntityDetailsPages.tsx");
        var theme = ReadRepoFile("llmgw/web/src/theme.css");

        Assert.Contains("生成详情", drawer);
        Assert.Contains("上游耗时", drawer);
        Assert.Contains("生成速度", drawer);
        Assert.Contains("未知：缺 token 或价格快照", drawer);
        Assert.Contains("<ProviderResponses detail={detail}", drawer);
        Assert.Contains("上游响应", drawer);
        Assert.Contains("['overview', '概览']", drawer);
        Assert.Contains("['content', '请求与响应']", drawer);
        Assert.Contains("['routing', '路由']", drawer);
        Assert.Contains("['audit', '审计']", drawer);
        Assert.Contains("无法打开这条生成记录", drawer);
        Assert.Contains("请求详情加载失败，请稍后重试", drawer);
        Assert.Contains("width: 'min(820px, 100vw)'", drawer);
        Assert.DoesNotContain("width: 'min(820px, 96vw)'", drawer);
        Assert.Contains("openedRequestIdRef", logs);
        Assert.Contains("openLogDetail(matched.id)", logs);
        Assert.Contains("Provider 实际费用", drawer);
        Assert.Contains("汇率快照", drawer);
        Assert.Contains("请求内容", drawer);
        Assert.Contains("响应内容", drawer);
        Assert.Contains("原始数据", drawer);
        Assert.Contains("const displayName = detail.appCallerCodeDisplayName?.trim() || detail.appCallerTitle?.trim()", drawer);
        Assert.Contains("const displayName = item.appCallerCodeDisplayName?.trim() || item.appCallerTitle?.trim()", logs);
        Assert.Contains("<ImageResponseGallery detail={detail}", drawer);
        Assert.Contains("detail.imageSuccessCount", drawer);
        Assert.Contains("s/image", drawer);
        Assert.Contains("query.set('transaction', id)", logs);
        Assert.Contains("onPrevious=", logs);
        Assert.Contains("onNext=", logs);
        Assert.DoesNotContain("return '1 prompt'", logs);
        Assert.DoesNotContain("image/min", logs);
        Assert.Contains("display: inline-flex;", theme);
        Assert.Contains("width: fit-content;", theme);
        Assert.DoesNotContain(".lg-log-entity-hover-root {\n  display: block;", theme);
        Assert.Contains("<details className=\"lg-log-filters lg-log-filter-menu\">", logs);
        Assert.DoesNotContain("fontSize: 10", logs);
        Assert.Contains(".lg-log-table {", theme);
        // 字号已收敛为 :root 的七档 token（doc/rule.platform.llm-gateway.console-design-tonality.md）。
        // 契约不变——日志表格正文仍是 14px——但要断言「body 档是 14px」+「表格确实消费该档」，
        // 而不是像以前那样只要文件里任意位置出现过 14px 就算通过。
        Assert.Contains("--fs-body: 14px;", theme);
        Assert.Matches(@"(?s)\.lg-log-table\s*\{[^}]*font-size:\s*var\(--fs-body\)", theme);
        Assert.Contains("subtitle=\"会话主要模型\"", logs);
        Assert.Contains("lg-truncate lg-log-model-name", logs);
        Assert.Matches(@"(?s)\.lg-log-model-name\s*\{[^}]*font-weight:\s*450", theme);
        Assert.Contains("--log-text-entity: #fcfcfe", theme);
        Assert.Contains("--log-text-muted: rgba(252, 252, 254, 0.627)", theme);
        Assert.Matches(@"(?s)\.lg-log-entity\s*\{[^}]*color:\s*var\(--log-text-entity\)", theme);
        Assert.Contains("observedAppCaller(observed, requestedCode)", entityDetails);
        Assert.Contains("仅日志观测", entityDetails);
        Assert.Contains("不补造预算或速率配置", entityDetails);
        Assert.Contains("observedProvider(observed, requestedName)", entityDetails);
        Assert.Contains("非配置实体", entityDetails);
        Assert.Contains("不补造密钥状态", entityDetails);
        Assert.Contains("日志观测 · 非配置关系", entityDetails);
        Assert.Contains("--bg-page: #03080a", theme);
        Assert.Contains("--text-primary: #fcfcfe", theme);
        // 页头已并入共享 SSOT 规则（.lg-page-heading / .lg-logs-heading / .lg-title 共用一条），
        // 字重走 --fw-title。契约不变——页面标题仍是 700——断言改为「token 是 700」+「日志页头消费该 token」。
        Assert.Contains("--fw-title: 700;", theme);
        Assert.Matches(@"(?s)\.lg-logs-heading h1,[^{]*\{[^}]*font-weight:\s*var\(--fw-title\)", theme);
        Assert.Matches(@"(?s)@media[^}]*max-width:\s*680px.*?\.lg-log-table-head > div:first-child,[^}]*left:\s*10px", theme);

        var imageBackground = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogBackground.cs");
        Assert.Contains("CreateClient(\"SafeOutbound\")", imageBackground);
        Assert.Contains("EnsureSafeHttpUrlAsync", imageBackground);
        Assert.Contains("ResponseHeadersRead", imageBackground);
        Assert.Contains("Content-Type 不是 image/*", imageBackground);
        Assert.Contains("MaxStoredImageBytes", imageBackground);
        Assert.DoesNotContain("Url = image.SourceUrl", imageBackground);

        var appCallers = ReadRepoFile("llmgw/web/src/pages/AppCallersPage.tsx");
        Assert.Contains("tableLayout: 'fixed'", appCallers);
        Assert.Contains("<colgroup>", appCallers);
        Assert.Contains("lg-app-caller-mobile-list", appCallers);
        Assert.Contains("function AppCallerMobileCard", appCallers);
        Assert.Contains("requestType || drift || modelPoolId", appCallers);
        Assert.Contains("modelPoolId: modelPoolId || undefined", appCallers);
        Assert.Contains("lg-app-caller-active-filter", appCallers);

        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var bulkStart = console.IndexOf("app.MapPost(\"/gw/app-callers/bulk-governance\"", StringComparison.Ordinal);
        var bulkEnd = console.IndexOf("RequireAuthorization(\"ConfigWrite\")", bulkStart, StringComparison.Ordinal);
        Assert.True(bulkStart >= 0 && bulkEnd > bulkStart);
        Assert.Contains("AddExactFilter(\"ModelPoolId\", body.ModelPoolId)", console[bulkStart..bulkEnd]);
    }

    [Fact]
    public void AgentFirstQuickstart_KeepsTenantAuthorityAndUnknownCostBoundaries()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var access = ReadRepoFile("llmgw/console-api/Auth/TenantAccessContext.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");
        var webNginx = ReadRepoFile("llmgw/web/nginx.conf");
        var devCompose = ReadRepoFile("docker-compose.dev.yml");

        var createStart = console.IndexOf("app.MapPost(\"/gw/app-callers\"", StringComparison.Ordinal);
        var createEnd = console.IndexOf("RequireAuthorization(\"AppCallerWrite\")", createStart, StringComparison.Ordinal);
        Assert.True(createStart >= 0 && createEnd > createStart);
        var createEndpoint = console[createStart..createEnd];
        Assert.Contains("TenantAccess.GetRequired(http)", createEndpoint);
        Assert.Contains("TenantAccess.Filter(http, identity)", createEndpoint);
        Assert.Contains("x.TenantId == access.TenantId", createEndpoint);
        Assert.DoesNotContain("body.TenantId", createEndpoint);
        Assert.Contains("uniq_llmgw_app_callers_tenant_code_request_type", console);
        Assert.Contains("APP_CALLER_AUDIT_FAILED", createEndpoint);
        Assert.Contains("gwAppCallers.DeleteOneAsync(TenantAccess.Filter(http", createEndpoint);
        Assert.Contains("AppCallerWrite", access);

        Assert.Contains("TryHandleQuickstartDryRunAsync", endpoints);
        Assert.Contains("authorization.TenantId", endpoints);
        Assert.Contains("authorization.TeamId", endpoints);
        Assert.Contains("authorization.KeyId", endpoints);
        Assert.Contains("authorization.ClientCode", endpoints);
        Assert.Contains("authorization.Environment", endpoints);
        Assert.Contains("\"gateway-dry-run\"", endpoints);
        Assert.Contains("\"quickstart-dry-run-no-upstream\"", endpoints);
        var dryRunStart = endpoints.IndexOf("private static async Task<bool> TryHandleQuickstartDryRunAsync", StringComparison.Ordinal);
        var dryRunEnd = endpoints.IndexOf("private static bool IsQuickstartDryRunPath", dryRunStart, StringComparison.Ordinal);
        var dryRunEndpoint = endpoints[dryRunStart..dryRunEnd];
        Assert.DoesNotContain("EstimatedCost", dryRunEndpoint);
        var logWriteIndex = dryRunEndpoint.IndexOf("llmrequestlogs", StringComparison.Ordinal);
        var observationUpdateIndex = dryRunEndpoint.IndexOf(".Inc(x => x.TotalSeen, 1)", StringComparison.Ordinal);
        Assert.True(logWriteIndex >= 0 && observationUpdateIndex > logWriteIndex);
        Assert.True(System.Text.RegularExpressions.Regex.Matches(console, "TeamId = d.AsNullableString\\(\\\"TeamId\\\"\\)").Count >= 4);

        Assert.Contains("scopes: ['invoke', 'stream:invoke', 'route:read']", quickstart);
        Assert.Contains("ingressProtocols: PROTOCOLS.map((item) => item.ingressProtocol)", quickstart);
        Assert.Contains("type RequestType = 'chat' | 'vision'", quickstart);
        Assert.Contains("requestType,", quickstart);
        Assert.DoesNotContain("requestType: 'chat'", quickstart);
        Assert.Contains("visionOpenAiContent", quickstart);
        Assert.Contains("visionClaudeContent", quickstart);
        Assert.Contains("visionGeminiParts", quickstart);
        Assert.Contains("upstreamCalled=false", quickstart);
        Assert.Contains("type TestMode = 'safe' | 'real'", quickstart);
        Assert.Contains("const checkRealRoute", quickstart);
        Assert.Contains("const prepareRealRoute", quickstart);
        Assert.Contains("testMode === 'safe'", quickstart);
        Assert.Contains("testMode === 'real'", quickstart);
        Assert.Contains("canRunRealTest(currentRoutePreview, baseUrl)", quickstart);
        Assert.Contains("/prompt-policy", quickstart);
        Assert.Contains("const identityLocked = Boolean(bundle) || creatingStage !== null", quickstart);
        Assert.Contains("disabled={!canCreateAccess || identityLocked}", quickstart);
        Assert.Contains("修改身份", quickstart);
        Assert.DoesNotContain("tenantId:", quickstart);
        Assert.DoesNotContain("['*']", quickstart);
        Assert.Contains("location ^~ /gw/v1/", webNginx);
        Assert.Contains("location ^~ /v1/", webNginx);
        Assert.Contains("location ^~ /v1beta/", webNginx);
        Assert.Contains("location ^~ /gemini/v1beta/", webNginx);
        Assert.Contains("client_max_body_size 30m;", webNginx);
        Assert.True(System.Text.RegularExpressions.Regex.Matches(webNginx, "proxy_pass http://\\$llmgw_serving_upstream:8091;").Count == 4);
        Assert.Contains("llmgw-serve:", devCompose);
        Assert.Contains("dockerfile: llmgw/serving/Dockerfile", devCompose);
        Assert.Contains("- llmgw-serve", devCompose);
    }

    [Fact]
    public void GatewayWeb_UsesPublicSubpathForEntryAndFontAssets()
    {
        var vite = ReadRepoFile("llmgw/web/vite.config.ts");
        var nginx = ReadRepoFile("llmgw/web/nginx.conf");

        Assert.Contains("base: '/llmgw/'", vite);
        Assert.Contains("location ^~ /llmgw/assets/", nginx);
        Assert.Contains("alias /usr/share/nginx/html/assets/;", nginx);
    }

    [Fact]
    public void ExternalTenant_CannotMasqueradeAsMapServiceKeyPurpose()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var page = ReadRepoFile("llmgw/web/src/pages/ServiceKeysPage.tsx");
        var createStart = console.IndexOf("app.MapPost(\"/gw/service-keys\"", StringComparison.Ordinal);
        var deleteStart = console.IndexOf("app.MapDelete(\"/gw/service-keys/{id}\"", createStart, StringComparison.Ordinal);
        var createEndpoint = console[createStart..deleteStart];

        Assert.Contains("if (sourceSystem == \"*\")", createEndpoint);
        Assert.Contains("INVALID_KEY_SOURCE", createEndpoint);
        Assert.Contains("!tenant.IsInternalTenant && (isMapSource || purpose != \"external-platform\")", createEndpoint);
        Assert.Contains("INTERNAL_KEY_PURPOSE_FORBIDDEN", createEndpoint);
        Assert.Contains("const isInternalTenant = tenant?.isInternal === true", page);
        Assert.Contains("外部租户身份由服务端固定，不能伪装为 MAP", page);
        Assert.Contains("isInternalTenant ? <div", page);
    }

    [Fact]
    public void ConsoleOnlyStartup_BackfillsLegacyGatewayDocumentsBeforeTenantFiltering()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var backfillCall = console.IndexOf(
            "await BackfillInternalTenantAsync(gatewayDatabase, internalTenantId, CancellationToken.None);",
            StringComparison.Ordinal);
        var firstTenantFilteredEndpoint = console.IndexOf(
            "lifecycleRuns.Find(TenantAccess.Filter(http))",
            StringComparison.Ordinal);

        Assert.True(backfillCall >= 0, "console-only 启动必须执行 internal tenant 历史回填");
        Assert.True(
            firstTenantFilteredEndpoint > backfillCall,
            "TenantAccess.Filter 生效前必须完成历史 TenantId 回填");
        foreach (var collection in new[]
                 {
                     "llmrequestlogs",
                     "llmshadow_comparisons",
                     "llmgw_operation_audits",
                     "llmgw_login_audits",
                     "llmgw_lifecycle_runs",
                     "llmgw_app_callers",
                     "llmgw_model_pools",
                     "llmgw_platforms",
                     "llmgw_models",
                     "llmgw_model_exchanges",
                     "llmgw_service_keys",
                 })
        {
            Assert.Contains($"\"{collection}\"", console);
        }
        Assert.Contains("Filter.Exists(\"TenantId\", false)", console);
        Assert.Contains("Filter.Eq(\"TenantId\", BsonNull.Value)", console);
        Assert.Contains("Update.Set(\"TenantId\", tenantId)", console);
    }

    [Fact]
    public void ConsoleDefaultPoolSwitch_UsesTenantScopedAtomicPointer()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var endpointStart = console.IndexOf(
            "app.MapPut(\"/gw/pools/{id}/default\"",
            StringComparison.Ordinal);
        var endpointEnd = console.IndexOf(
            "app.MapPut(\"/gw/pools/{id}/claim\"",
            endpointStart,
            StringComparison.Ordinal);
        Assert.True(endpointStart >= 0, "找不到默认模型池切换端点");
        Assert.True(endpointEnd > endpointStart, "默认模型池切换端点边界无效");
        var endpoint = console[endpointStart..endpointEnd];

        Assert.Contains("fb.Eq(\"TenantId\", tenantId), fb.Eq(\"Code\", modelType)", endpoint);
        Assert.Contains("FindOneAndUpdateAsync", endpoint);
        Assert.Contains(".Set(\"DefaultPoolId\", id)", endpoint);
        Assert.Contains("PoolVersionGuard", endpoint);
        Assert.Contains("DefaultSwitchPendingUntil", endpoint);
        Assert.DoesNotContain("targetPools.UpdateManyAsync", endpoint);
    }

    [Fact]
    public void ModelLabAndArena_PinSelectedModelThroughGateway()
    {
        var modelLab = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ModelLabController.cs");
        var arenaWorker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ArenaRunWorker.cs");

        Assert.Contains("_gateway.CreateClient(", modelLab);
        Assert.Contains("Admin.ModelLab.Run", modelLab);
        Assert.Contains("expectedModel: modelName", modelLab);
        Assert.Contains("pinnedPlatformId: platform.Id", modelLab);
        Assert.Contains("pinnedModelId: modelName", modelLab);
        Assert.Contains("expectedModel: model.ModelName", modelLab);
        Assert.Contains("pinnedPlatformId: resolvedPlatformId", modelLab);
        Assert.Contains("pinnedModelId: model.ModelName", modelLab);
        Assert.Contains("ModelResolutionType: ModelResolutionType.DirectModel", modelLab);

        Assert.Contains("gateway.CreateClient(", arenaWorker);
        Assert.Contains("AppCallerRegistry.Desktop.Arena.BattleChat", arenaWorker);
        Assert.Contains("expectedModel: slot.ModelId", arenaWorker);
        Assert.Contains("pinnedPlatformId: platform.Id", arenaWorker);
        Assert.Contains("pinnedModelId: slot.ModelId", arenaWorker);
        Assert.Contains("ModelResolutionType: ModelResolutionType.DirectModel", arenaWorker);
    }

    [Fact]
    public void GatewayProductionHardening_HasExecutableLifecycleBudgetKeyCancelAndIdempotencyGuards()
    {
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        var runtime = ReadRepoFile("llmgw/serving/GatewayRuntimeGovernance.cs");
        var concurrency = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayProviderConcurrencyCoordinator.cs");
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var httpClient = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/HttpLlmGatewayClient.cs");
        var stage = ReadRepoFile("scripts/llmgw-prod-stage.sh");

        Assert.Contains("idx_llmgw_logs_tenant_time_caller_type_transport", initializer);
        Assert.Contains("ttl_llmgw_logs_started", initializer);
        Assert.Contains("uniq_llmgw_budget_month", initializer);
        Assert.Contains("uniq_llmgw_execution_request", initializer);
        Assert.Contains("uniq_llmgw_service_key_hash", initializer);
        Assert.Contains("uniq_llmgw_multipart_ref", initializer);
        Assert.Contains("uniq_llmgw_provider_concurrency_slot", initializer);
        Assert.Contains("ttl_llmgw_provider_concurrency_slot", initializer);
        Assert.Contains("LlmGateway:Retention:EnableTtlIndexes", initializer);
        Assert.Contains("EnsureBudgetConfigurationIntegrityAsync", initializer);
        Assert.Contains("APP_CALLER_BUDGET_MIGRATION_REQUIRED", initializer);

        Assert.Contains("class GatewayBudgetCoordinator", runtime);
        Assert.Contains("FindOneAndUpdateAsync", runtime);
        Assert.Contains("class GatewayRequestExecutionStore", runtime);
        Assert.Contains("GatewayExecutionBeginState.Unknown", runtime);
        Assert.Contains("class GatewayScopedKeyAuthorizer", runtime);
        Assert.Contains("GATEWAY_KEY_SCOPE_DENIED", runtime);
        Assert.Contains("class GatewayCancellationRegistry", runtime);
        Assert.Contains("class GatewayDataLifecycleWorker", runtime);
        Assert.Contains("GatewayLifecycleRunRecord", runtime);
        Assert.Contains("Status = \"dry-run-complete\"", runtime);
        Assert.Contains("EnsureRetentionTtlIndexesAsync", runtime);
        Assert.True(
            runtime.IndexOf("await lifecycle.InsertOneAsync(run", StringComparison.Ordinal)
            < runtime.IndexOf("EnsureRetentionTtlIndexesAsync", runtime.IndexOf("await lifecycle.InsertOneAsync(run", StringComparison.Ordinal), StringComparison.Ordinal),
            "必须先持久化 dry-run，再创建会触发删除的 TTL 索引");
        Assert.Contains("ttl_llmgw_login_audits", initializer);
        Assert.Contains("LlmGateway:Retention:AuditDays", initializer);
        Assert.Contains("TimeSpan.FromDays(auditDays)", initializer);
        Assert.True(
            runtime.IndexOf("await _budgets.ReleaseExpiredAsync(ct);", StringComparison.Ordinal)
            < runtime.IndexOf("if (apply)", runtime.IndexOf("var multipart", StringComparison.Ordinal), StringComparison.Ordinal),
            "预算过期结算必须独立于 retention apply 开关");

        Assert.Contains("class GatewayProviderConcurrencyCoordinator", concurrency);
        Assert.Contains("PROVIDER_CONCURRENCY_EXHAUSTED", concurrency);
        Assert.Contains("FindOneAndUpdateAsync", concurrency);
        Assert.Contains("MongoCommandException ex) when (ex.Code is 11000 or 11001)", concurrency);
        Assert.Contains("AcquireProviderConcurrencyAsync", gateway);
        Assert.Contains("GatewayProviderConcurrencyCoordinator? concurrencyCoordinator = null", gateway);

        Assert.Contains("/gw/v1/requests/{requestId}/cancel", endpoints);
        Assert.Contains("RunWithRequestCancellationAsync", endpoints);
        Assert.Contains("ExecuteRawWithIdempotencyAsync", endpoints);
        Assert.Contains("GATEWAY_OUTCOME_UNKNOWN", endpoints);
        var nativeStreamStart = endpoints.IndexOf("app.MapPost(\"/gw/v1/stream\"", StringComparison.Ordinal);
        var nativeStreamEnd = endpoints.IndexOf("app.MapPost(\"/gw/v1/raw\"", nativeStreamStart, StringComparison.Ordinal);
        Assert.Contains(
            "HttpContextOutcomeUnknownKey",
            endpoints[nativeStreamStart..nativeStreamEnd]);
        var clientStreamStart = endpoints.IndexOf("app.MapPost(\"/gw/v1/client-stream\"", StringComparison.Ordinal);
        var clientStreamEnd = endpoints.IndexOf("app.MapGet(\"/gw/v1/shadow-comparisons\"", clientStreamStart, StringComparison.Ordinal);
        Assert.Contains(
            "HttpContextOutcomeUnknownKey",
            endpoints[clientStreamStart..clientStreamEnd]);
        var imageHelperStart = endpoints.IndexOf("private static async Task ExecuteRawWithIdempotencyAsync", StringComparison.Ordinal);
        var imageHelperEnd = endpoints.IndexOf("private static async Task SendOpenAiCompatibleAsync", imageHelperStart, StringComparison.Ordinal);
        var imageHelper = endpoints[imageHelperStart..imageHelperEnd];
        Assert.True(
            imageHelper.IndexOf("store.BeginAsync", StringComparison.Ordinal)
            < imageHelper.IndexOf("RecordAndCheckAppCallerGovernanceAsync", StringComparison.Ordinal),
            "图片兼容入口的幂等 replay 必须在预算预占与限流前返回");
        var rawEndpointStart = endpoints.IndexOf("app.MapPost(\"/gw/v1/raw\"", StringComparison.Ordinal);
        var rawEndpointEnd = endpoints.IndexOf("app.MapPost(\"/gw/v1/profile-test\"", rawEndpointStart, StringComparison.Ordinal);
        var rawEndpoint = endpoints[rawEndpointStart..rawEndpointEnd];
        Assert.True(
            rawEndpoint.IndexOf("executionStore.BeginAsync", StringComparison.Ordinal)
            < rawEndpoint.IndexOf("RecordAndCheckAppCallerGovernanceAsync", StringComparison.Ordinal),
            "raw 幂等 replay 必须在预算预占与限流前返回");
        Assert.Contains("path.Equals(\"/gw/v1/profile-test\"", endpoints);
        Assert.Contains("return \"profile:test\"", endpoints);
        Assert.Contains("NormalizeGatewayStatusCode(value.Success, value.StatusCode)", endpoints);
        Assert.Contains("ResolveScopedAuthorizationInputsAsync", endpoints);
        Assert.Contains("ShouldInspectAuthorizationBody", endpoints);
        Assert.Contains("GATEWAY_APP_CALLER_MISMATCH", endpoints);
        Assert.Contains("ReadJsonBool(root, \"stream\")", endpoints);
        Assert.Contains("path.Equals(\"/gw/v1/client-stream\"", endpoints);
        Assert.Contains("path.Contains(\":streamGenerateContent\"", endpoints);
        Assert.DoesNotContain("Request.ContentType?.Contains(\"json\"", endpoints);
        Assert.Contains("CleanupMultipartRefsAsync", endpoints);
        Assert.Contains("protectedGatewayPath", endpoints);
        Assert.DoesNotContain("!path.StartsWith(\"/gw/v1/readyz\"", endpoints);
        Assert.Contains("llmgw_multipart_objects", httpClient);
        Assert.Contains("X-Gateway-App-Caller", httpClient);
        Assert.Contains("TryDeserializeRawResponse", httpClient);
        Assert.Contains("TryDeserializeGatewayResponse", httpClient);
        Assert.Contains("ResolveCompatibleDefaultAppCaller", endpoints);

        Assert.Contains("ensure_serving_probe_evidence", stage);
        Assert.Contains("collecting missing serving probe evidence without upstream model calls", stage);
        Assert.Contains("LLMGW_GATE_KEY=\"$gate_key\" python3 scripts/llmgw-serving-probe.py", stage);

        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("ValidateBudgetConfiguration", console);
        Assert.Contains("配置月预算时必须同时配置大于 0 的单次预算预占", console);
        Assert.Contains("单次预算预占不能超过月预算", console);
    }

    [Fact]
    public void GatewayFinalAcceptance_IsOneShotBoundedAndStopsOnFailure()
    {
        var script = ReadRepoFile("scripts/llmgw-final-acceptance.py");
        var seed = ReadRepoFile("scripts/llmgw-map-shadow-seed.py");
        var compose = ReadRepoFile("docker-compose.yml");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("CELLS = (\"text\", \"stream\", \"image\", \"vision\", \"asr\", \"video\")", script);
        Assert.Contains("automatic full rerun is forbidden", script);
        Assert.Contains("serving commit mismatch", script);
        Assert.Contains("lifecycle apply/index gate is not ready", script);
        Assert.Contains("no later cells executed", script);
        Assert.Contains("\"maxUpstreamCalls\": 1", script);
        Assert.Contains("\"maxSubmitCalls\": 1", script);
        Assert.Contains("CELLS.index(args.resume_cell)", script);
        Assert.Contains("--max-canary-calls\", \"1", script);
        Assert.Contains("--include-report-agent-generate", script);
        Assert.Contains("--include-image-worker-vision", script);
        Assert.Contains("--poll-status\", \"--download-result", script);
        Assert.Contains("args.include_report_agent_generate", seed);
        Assert.Contains("LlmGateway__Retention__RequestLogDays=${LLMGW_RETENTION_REQUEST_LOG_DAYS:-90}", compose);
        Assert.Contains("LlmGateway__Retention__SensitiveBodyDays=${LLMGW_RETENTION_SENSITIVE_BODY_DAYS:-7}", compose);
        Assert.Contains("LlmGateway__Retention__ShadowDays=${LLMGW_RETENTION_SHADOW_DAYS:-30}", compose);
        Assert.Contains("LlmGateway__Retention__AuditDays=${LLMGW_RETENTION_AUDIT_DAYS:-180}", compose);
        Assert.Contains("LlmGateway__Retention__SuccessfulMultipartHours=${LLMGW_RETENTION_SUCCESSFUL_MULTIPART_HOURS:-24}", compose);
        Assert.Contains("LlmGateway__Retention__FailedMultipartHours=${LLMGW_RETENTION_FAILED_MULTIPART_HOURS:-72}", compose);
        Assert.Contains("MapGet(\"/gw/lifecycle/status\"", console);
    }

    [Fact]
    public void GatewayProductBoundary_UsesRootLlmGwPathsWithoutLegacyDirectories()
    {
        var root = LocateRepoRoot();
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "console-api")));
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "web")));
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "serving")));
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "deploy")));
        Assert.True(Directory.Exists(Path.Combine(root, "llmgw", "docs")));
        Assert.False(Directory.Exists(Path.Combine(root, "prd-llmgw")));
        Assert.False(Directory.Exists(Path.Combine(root, "prd-llmgw-web")));
        Assert.False(Directory.Exists(Path.Combine(root, "prd-api", "src", "PrdAgent.LlmGateway")));

        var solution = ReadRepoFile("prd-api/PrdAgent.sln");
        var workflow = ReadRepoFile(".github/workflows/branch-image.yml");
        var devCompose = ReadRepoFile("docker-compose.dev.yml");
        Assert.Contains("..\\llmgw\\serving\\PrdAgent.LlmGateway.csproj", solution);
        Assert.Contains("llmgw/console-api/**", workflow);
        Assert.Contains("llmgw/web/**", workflow);
        Assert.Contains("llmgw/serving/**", workflow);
        Assert.Contains("context: .", workflow);
        Assert.Contains("file: ./llmgw/serving/Dockerfile", workflow);
        Assert.Contains("context: ./llmgw/console-api", devCompose);
        Assert.Contains("context: ./llmgw/web", devCompose);
    }

    [Fact]
    public void TenantHardening_EnforcesTeamReadScopeAndIdentityLifecycle()
    {
        var access = ReadRepoFile("llmgw/console-api/Auth/TenantAccessContext.cs");
        var user = ReadRepoFile("llmgw/console-api/Models/LlmGwUser.cs");
        var jwt = ReadRepoFile("llmgw/console-api/Auth/GwJwt.cs");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var recovery = ReadRepoFile("llmgw/console-api/Provisioning/GatewayRecoveryOperations.cs");
        var runtime = ReadRepoFile("llmgw/serving/GatewayRuntimeGovernance.cs");
        var endpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");

        Assert.Contains("FilterTeamScope", access);
        Assert.Contains("UserSecurityVersionClaim", access);
        Assert.Contains("user.SecurityVersion != securityVersion", access);
        Assert.Contains("x.Status == \"active\"", access);
        Assert.Contains("public long SecurityVersion", user);
        Assert.Contains("TenantAccess.UserSecurityVersionClaim", jwt);

        Assert.Contains("WILDCARD_SCOPE_DENIED", console);
        Assert.Contains("WILDCARD_CONFIRMATION_REQUIRED", console);
        Assert.Contains("service_key.create_wildcard", console);
        Assert.Contains("TEAM_SCOPE_REQUIRED", console);
        Assert.Contains("APP_CALLER_TEAM_MISMATCH", console);
        Assert.Contains("membership.invalidate_sessions", console);
        Assert.Contains("TenantOwnerAuthority.TryRemoveAsync", console);
        Assert.Contains("ActiveOwnerMembershipIds", recovery);
        Assert.Contains("OwnerFenceGeneration", recovery);
        Assert.Contains("StartHeartbeatAsync", recovery);
        Assert.Contains("catch (Exception) when (_stop.IsCancellationRequested)", recovery);
        Assert.Contains("GatewayRecoveryOperations.RepairExpiredAsync", console);
        Assert.True(
            console.Split("GatewayRecoveryOperations.StartHeartbeatAsync", StringSplitOptions.None).Length - 1 >= 3,
            "租户创建、成员创建和 owner 边界修改都必须在 live request 期间续租 recovery operation");
        Assert.DoesNotContain("OwnerMutationLock", console);
        Assert.Contains("MEMBERSHIP_VERSION_CONFLICT", console);
        Assert.Contains("idempotentReplay = true", console);
        Assert.Contains("invalidatedMemberships", console);
        Assert.Contains("revokedServiceKeys", console);
        Assert.Contains("disabledAppCallers", console);
        Assert.Contains("RollbackTenantCreationAsync", console);
        Assert.Contains("RollbackMemberCreationAsync", console);
        Assert.True(
            console.Split("TenantAccess.FilterTeamScope(http", StringSplitOptions.None).Length - 1 >= 10,
            "日志、首页、协议覆盖、会话、详情和 appCaller 读取必须统一使用团队范围过滤");

        Assert.Contains("service_key.tenant_inactive", runtime);
        Assert.Contains("service_key.team_inactive", runtime);
        Assert.Contains("service_key.owner_inactive", runtime);
        Assert.Contains("service_key.owner_role_denied", runtime);
        Assert.Contains("service_key.owner_team_denied", runtime);
        Assert.Contains("service_key.app_caller_team_denied", runtime);
        Assert.Contains("AppCallerStatusDecision.Reject(appCallerCode, requestType, \"team-disabled\")", endpoints);
        Assert.Contains("app_caller.team_ownership_denied", endpoints);
        Assert.Contains("GATEWAY_APP_CALLER_MISMATCH", endpoints);
    }

    [Fact]
    public void LiveAsrWebSocket_UsesSharedGovernanceAndRequestLifecycleLogging()
    {
        var liveEndpoint = ReadRepoFile("llmgw/serving/LiveAsrGatewayEndpoint.cs");
        var gatewayEndpoints = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
        var servingProgram = ReadRepoFile("llmgw/serving/Program.cs");

        Assert.Contains("GatewayHttpEndpoints.AdmitSpecializedRequestAsync", liveEndpoint);
        Assert.Contains("GetRequiredService<ILLMRequestContextAccessor>", liveEndpoint);
        Assert.Contains("GatewayHttpEndpoints.OpenContextScope", liveEndpoint);
        Assert.Contains("RecordAndCheckAppCallerGovernanceAsync", gatewayEndpoints);
        Assert.Contains("ILlmRequestLogWriter", liveEndpoint);
        Assert.Contains("logWriter.StartAsync", liveEndpoint);
        Assert.Contains("logWriter.MarkDone", liveEndpoint);
        Assert.Contains("logWriter.MarkError", liveEndpoint);
        Assert.Contains("GatewayBudgetCoordinator.HttpContextFinalStatusCodeKey", liveEndpoint);
        Assert.Contains("HttpContextFinalStatusCodeKey", gatewayEndpoints);
        Assert.Contains("LiveAsrSessionOrchestrator", liveEndpoint);
        Assert.DoesNotContain("IModelResolver", liveEndpoint);
        Assert.DoesNotContain("Channel.CreateBounded", liveEndpoint);
        Assert.DoesNotContain("TranscribeLivePcmAsync", liveEndpoint);
        Assert.DoesNotContain("LiveAsrBatchFallbackService", liveEndpoint);
        Assert.Contains("AddScoped<LiveAsrSessionOrchestrator>", servingProgram);
        Assert.True(
            liveEndpoint.IndexOf("AdmitSpecializedRequestAsync", StringComparison.Ordinal)
            < liveEndpoint.IndexOf("AcceptWebSocketAsync", StringComparison.Ordinal),
            "实时 ASR 必须在接受 WebSocket 和访问付费上游前完成治理准入");
        Assert.True(
            liveEndpoint.IndexOf("logWriter.StartAsync", StringComparison.Ordinal)
            < liveEndpoint.IndexOf("orchestrator.ExecuteAsync", StringComparison.Ordinal),
            "实时 ASR 必须先建立请求生命周期日志，再访问流式供应商");
        Assert.True(
            liveEndpoint.IndexOf("GatewayHttpEndpoints.OpenContextScope", StringComparison.Ordinal)
            < liveEndpoint.IndexOf("orchestrator.ExecuteAsync", StringComparison.Ordinal),
            "实时 ASR 必须先把已验证租户打开为请求上下文，再解析和访问该租户的模型供应商");
    }

    [Fact]
    public void LogicalModelCatalog_OnlyPublishesOfferingsThatTheExecutionResolverCanBuild()
    {
        var resolver = ReadRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var catalogStart = resolver.IndexOf(
            "private async Task<List<AvailableModelPool>> GetAvailableLogicalModelsAsPoolsAsync",
            StringComparison.Ordinal);
        var resolveStart = resolver.IndexOf(
            "private async Task<ModelResolutionResult?> TryResolveLogicalModelAsync",
            catalogStart,
            StringComparison.Ordinal);
        Assert.True(catalogStart >= 0 && resolveStart > catalogStart);
        var catalog = resolver[catalogStart..resolveStart];

        Assert.Contains("OrderLogicalOfferings(logical, logicalOfferings)", catalog);
        Assert.Contains("TryBuildLogicalOfferingResolutionAsync(logical, offering, logical.PublicId, ct)", catalog);
        Assert.Contains("if (!hasResolvableOffering)", catalog);
        Assert.DoesNotContain("availableIds.Contains", catalog);
    }

    [Fact]
    public void AcceptedVideoJobs_ResolveTheirRetainedOfferingAfterControlPlaneDisable()
    {
        var resolver = ReadRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var lifecycleStart = resolver.IndexOf(
            "public async Task<ModelResolutionResult> ResolveOfferingAsync",
            StringComparison.Ordinal);
        var lifecycleEnd = resolver.IndexOf(
            "public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync",
            lifecycleStart,
            StringComparison.Ordinal);
        Assert.True(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart);
        var lifecycle = resolver[lifecycleStart..lifecycleEnd];

        Assert.DoesNotContain("Filter.Eq(x => x.Enabled, true)", lifecycle);
        Assert.Contains("requireEnabled: false", lifecycle);
    }

    [Fact]
    public void GatewayCredentialRotation_RecoversAffectedOfferingHealth()
    {
        var consoleApi = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("ResetOfferingsAfterCredentialChangeAsync", consoleApi);
        Assert.Contains("http, \"platform\", [id], gwModels, gwModelOfferings", consoleApi);
        Assert.Contains("http, \"model\", [id], gwModels, gwModelOfferings", consoleApi);
        Assert.Contains("http, \"exchange\", [id], gwModels, gwModelOfferings", consoleApi);
        Assert.Contains("http, objectType, matchedTargetIds, gwModels, gwModelOfferings", consoleApi);
        Assert.Contains(".Set(\"HealthStatus\", 0)", consoleApi);
        Assert.Contains(".Set(\"ConsecutiveFailures\", 0)", consoleApi);
    }

    /// <summary>
    /// 上游治理三件套：删得掉、认得出、查得到。
    ///
    /// 这三条都是「删掉之后测试仍全绿」的接线，只会安静地退化成
    /// 「垃圾平台清不掉 / 两条同名上游分不清谁是谁 / 出了事翻不到这条上游的日志」，
    /// 所以逐条钉死，别指望下一个人记得。
    /// </summary>
    [Fact]
    public void PlatformGovernance_CanDeleteIdentifyAndTraceUpstreams()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var crypto = ReadRepoFile("llmgw/console-api/Security/GwApiKeyCrypto.cs");
        var dtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");
        var page = ReadRepoFile("llmgw/web/src/pages/PlatformsPage.tsx");
        var logsView = ReadRepoFile("llmgw/web/src/components/LogsView.tsx");
        var api = ReadRepoFile("llmgw/web/src/lib/api.ts");

        // 1) 删得掉——但必须先查占用，否则池成员会挂着一条不存在的平台静默失联
        Assert.Contains("app.MapDelete(\"/gw/platforms/{id}\"", console);
        Assert.Contains("CollectPlatformDeleteBlockersAsync", console);
        Assert.Contains("PLATFORM_IN_USE", console);
        Assert.Contains("platform.delete", console);
        Assert.Contains("ElemMatch<BsonDocument>(\"Models\"", console);
        Assert.Contains("export function deletePlatform(", api);
        Assert.Contains("removePlatform", page);

        // 2) 认得出——只给指纹，且必须有 ConfigWrite 才下发；明文任何时候都不许出现在响应里
        Assert.Contains("public static string Fingerprint(", crypto);
        Assert.Contains("public string? KeyFingerprint", dtos);
        Assert.Contains("LlmGwPermissions.ConfigWrite", console);
        Assert.Contains("revealFingerprint", console);
        Assert.Contains("keyFingerprint", page);
        // 明文解出来只有一个去处：喂给 Fingerprint。多出任何一处引用都可能是把整把 key 塞进了响应。
        Assert.Contains("GwApiKeyCrypto.Fingerprint(decrypted.PlainText)", console);
        Assert.Equal(
            1,
            console.Split("decrypted.PlainText").Length - 1);

        // 3) 查得到——按 PlatformId 精确过滤（provider 会重名，本仓库真出现过同名同 URL 两条上游）
        Assert.Contains("fb.Eq(\"PlatformId\", platformId.Trim())", console);
        Assert.Contains("platformId?: string;", ReadRepoFile("llmgw/web/src/lib/types.ts"));
        Assert.Contains("initialQueryValue('platformId')", logsView);
        Assert.Contains("/logs?platformId=", page);
        // 请求页与会话页共用同一份筛选参数：只有一边收 platformId 的话，用户从深链进来切到
        // 会话页，界面上筛选还亮着、列的却是所有平台的会话——筛选条件在说谎。
        // 判据钉「每个吃这份筛选的端点都要把 platformId 传进同一个 BuildFilter」。
        foreach (var endpoint in new[] { "app.MapGet(\"/gw/logs\"", "app.MapGet(\"/gw/logs/sessions\"" })
        {
            var body = EndpointBody(console, endpoint);
            Assert.Contains("platformId", body);
            Assert.Contains("BuildFilter(", body);
            var call = body[body.IndexOf("BuildFilter(", StringComparison.Ordinal)..];
            Assert.True(
                call.Contains("platformId)", StringComparison.Ordinal)
                || call.Contains("platformId: platformId", StringComparison.Ordinal),
                $"{endpoint} 没把 platformId 传进 BuildFilter，平台筛选会在这一页失效");
        }

        // 4) 改得动 / 并得了——「只能建不能改、不能并」正是垃圾堆积的上游成因
        Assert.Contains("app.MapPut(\"/gw/platforms/{id}\"", console);
        Assert.Contains("platform.update", console);
        Assert.Contains("export function updatePlatform(", api);
        Assert.Contains("beginEdit", page);

        // 5) 模型也删得掉——平台删除要求先清模型引用，没有这个端点那条路径根本走不通
        Assert.Contains("app.MapDelete(\"/gw/models/{id}\"", console);
        Assert.Contains("MODEL_IN_USE", console);
        Assert.Contains("model.delete", console);
        Assert.Contains("export function deleteModel(", api);
    }

    /// <summary>
    /// 默认池不能被自己的坏状态锁死。
    ///
    /// 真实死锁：默认池成员全部掉成 Unavailable 后，「必须留一个可用成员」这条守卫
    /// 把删除／覆盖／重新声明全部挡下——唯一能救回池子的动作，被池子当前的坏状态挡在门外。
    /// 判据取的是变更前的状态，却用来 gate 那个会改变该状态的变更。
    /// </summary>
    [Fact]
    public void DefaultPoolGuard_DoesNotBlockTheOnlyActionThatCanRepairIt()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        // 改动前就已经零可用成员时不再拦：拦不住任何损害，只会把修复一起挡掉
        var guardStart = console.IndexOf("static async Task<string?> ValidateDefaultGatewayPoolMembersAsync", StringComparison.Ordinal);
        Assert.True(guardStart > 0, "默认池守卫函数应当存在");
        var guardBody = console[guardStart..(guardStart + 2000)];
        Assert.Contains("HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, pool)", guardBody);

        // 显式重新声明成员必须重置健康位。旧写法把 HealthStatus 塞在「仅新成员」的初始化块里，
        // existing 会把陈旧的 Unavailable 一路带回去；现在改成空构造 + 无条件重置。
        // 断言这一行的存在，等于断言不会退回旧写法。
        Assert.Contains("existing is not null ? new BsonDocument(existing) : new BsonDocument();", console);
    }

    /// <summary>
    /// 「建得出、删不掉」是垃圾堆积的系统性成因。
    ///
    /// 断头自检（2026-08-10）扫出 7 类资源只有创建没有删除：模型池、交换所、逻辑模型、
    /// appCaller、池成员、团队、租户。本测试钉住其中已补齐的五条删除链路——
    /// 每条都要求「后端端点 + 审计动作 + 前端 api 函数 + 页面调用点」四段齐全，
    /// 缺任何一段这条能力就是断头的，而少任何一段都不会让别的测试变红。
    /// </summary>
    [Fact]
    public void GatewayResources_ThatCanBeCreated_CanAlsoBeDeleted()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var api = ReadRepoFile("llmgw/web/src/lib/api.ts");

        // 端点路径 / 审计动作 / api 函数 / 页面文件 / 页面里的调用点
        var links = new[]
        {
            ("app.MapDelete(\"/gw/pools/{id}\"", "pool.delete", "export function deletePool(", "llmgw/web/src/pages/ModelPoolsPage.tsx", "deletePool("),
            ("app.MapDelete(\"/gw/logical-models/{id}\"", "logical-model.delete", "export function deleteLogicalModel(", "llmgw/web/src/pages/LogicalModelsPage.tsx", "deleteLogicalModel("),
            ("app.MapDelete(\"/gw/app-callers/{id}\"", "app_caller.delete", "export function deleteAppCaller(", "llmgw/web/src/pages/AppCallersPage.tsx", "deleteAppCaller("),
            ("app.MapDelete(\"/gw/exchanges/{id}\"", "exchange.delete", "export function deleteExchange(", "llmgw/web/src/pages/ExchangesPage.tsx", "deleteExchange("),
            ("app.MapDelete(\"/gw/models/{id}\"", "model.delete", "export function deleteModel(", "llmgw/web/src/pages/ModelsPage.tsx", "deleteModel("),
        };

        foreach (var (endpoint, auditAction, apiExport, pagePath, pageCall) in links)
        {
            Assert.Contains(endpoint, console);
            Assert.Contains(auditAction, console);
            Assert.Contains(apiExport, api);
            Assert.Contains(pageCall, ReadRepoFile(pagePath));
        }

        // 删除阻挡：删掉一个还在被引用的对象，引用方不会报错，只会在路由时静默降级。
        // 所以每条删除都必须先查引用并把阻挡原因报回去，而不是「删了再说」。
        Assert.Contains("POOL_IN_USE", console);
        Assert.Contains("EXCHANGE_IN_USE", console);
        Assert.Contains("MODEL_IN_USE", console);
        // 逻辑模型没有阻挡：Offering 是它自己的下挂路由，别处不引用，所以是连带删。
        // 但连带删必须把删掉几条报回去——否则运维点一次删掉 N 条却毫无感知。
        Assert.Contains("OfferingsDeleted", console);
        Assert.Contains("offeringsDeleted", ReadRepoFile("llmgw/web/src/pages/LogicalModelsPage.tsx"));
        // 交换所被池成员引用有两种写法（直指 id / __exchange__ 别名），只查一种会漏判成「没人用」
        Assert.Contains("__exchange__", console);
        // 模型池删除的两类阻挡语义不同，必须分开报：改默认 vs 解绑 appCaller，补救动作不一样
        Assert.Contains("IsCurrentDefault", console);
    }

    /// <summary>
    /// 组织三件（团队 / 成员 / 租户）的删除。它们和网关资源不同：删错了丢的是「谁能进来」，
    /// 补不回来。所以每一条都要求额外的归属校验，且这些校验必须写在服务端——
    /// 前端按钮可见性只是提示，绕过它的人正是最需要被挡住的那个。
    /// </summary>
    [Fact]
    public void OrganizationDeletes_CarryTheirOwnershipGuards()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var api = ReadRepoFile("llmgw/web/src/lib/api.ts");
        var page = ReadRepoFile("llmgw/web/src/pages/OrganizationPage.tsx");

        // 团队：三类引用（成员 / 接入密钥 / appCaller）任一存在就不许删。
        // 团队被删后引用方不会报错，只会被权限判定当成「没有范围」，所以必须拦在删除前。
        Assert.Contains("app.MapDelete(\"/gw/teams/{id}\"", console);
        Assert.Contains("TEAM_IN_USE", console);
        Assert.Contains("team.delete", console);
        Assert.Contains("export function deleteTeam(", api);
        Assert.Contains("removeTeam", page);
        // 阻挡清单报 userId 等于没报——运维看着一串 hex 不知道去找谁解绑。必须解成账号名。
        Assert.Contains("nameById.TryGetValue(x, out var name)", console);

        // 成员：不能删自己、只有 owner 能删 owner、不能删掉最后一个活跃 owner。
        // 最后一条走 TenantOwnerAuthority.TryRemoveAsync 的原子判定，
        // 且摘牌后若删除失败必须补回去——否则 owner 名单会凭空少一位。
        var memberDelete = EndpointBody(console, "app.MapDelete(\"/gw/members/{id}\"");
        Assert.Contains("SELF_MEMBERSHIP_CHANGE_FORBIDDEN", memberDelete);
        Assert.Contains("OWNER_REQUIRED", memberDelete);
        Assert.Contains("TenantOwnerAuthority.TryRemoveAsync", memberDelete);
        Assert.Contains("OwnerRemovalResult.LastOwner", memberDelete);
        Assert.Contains("TenantOwnerAuthority.RestoreAsync", memberDelete);
        Assert.Contains("membership.delete", memberDelete);
        Assert.Contains("export function deleteMember(", api);
        Assert.Contains("removeMember", page);

        // 租户：只能删当前会话所在的租户、内置租户不许删、非空不许删。
        // 用户建的东西一律不级联——级联写错不可逆，「先自己清干净再删」可逆。
        // 唯一的例外是系统自己铺的脚手架（空的托管默认池 + 池类型指针）：它们由平台在开租户时
        // 自动创建、用户删不掉（当前默认池不许删），算进「非空」就会让成功分支永远走不到。
        var tenantDelete = EndpointBody(console, "app.MapDelete(\"/gw/tenants/{id}\"");
        Assert.Contains("TENANT_SCOPE_MISMATCH", tenantDelete);
        Assert.Contains("INTERNAL_TENANT", tenantDelete);
        Assert.Contains("TENANT_NOT_EMPTY", tenantDelete);
        // 阻挡计数必须排掉空的托管默认池，否则 Pools == 0 不可达
        Assert.Contains("ManagedByRegistry", tenantDelete);
        Assert.Contains("PoolMemberCount(d) == 0", tenantDelete);
        // 池删了，指着它的类型文档也要删——否则留下一条指向已删池的 DefaultPoolId
        Assert.Contains("gwModelPoolTypes.DeleteManyAsync(tenantFilter)", tenantDelete);
        Assert.Contains("tenant.delete", tenantDelete);
        Assert.Contains("RequireAuthorization(\"TenantOwner\")", tenantDelete);

        // 收尾顺序：**会毁掉「还能重试」这个能力的那一步必须最后做**（同合并那条纪律）。
        // 本端点要 TenantOwner 才进得来，而 ResolveAsync 查不到 active 成员关系就返回 null，
        // 所以毁掉重试能力的是删成员关系，不是删租户。先删成员再删租户的话，卡在中间
        // 就是「租户还在、没人进得来、连重试都不行」，只能上数据库手工救。
        // 先删租户则相反：ResolveAsync 查不到 active 租户同样返回 null，剩下的成员关系
        // 只是指向已不存在租户的惰性残留，清不掉也不挡人。
        var tenantGone = tenantDelete.IndexOf("tenants.DeleteOneAsync", StringComparison.Ordinal);
        var membershipsGone = tenantDelete.IndexOf("memberships.DeleteManyAsync", StringComparison.Ordinal);
        Assert.True(tenantGone > 0, "租户删除端点没有删租户本身");
        Assert.True(membershipsGone > 0, "租户删除端点没有清理成员关系");
        Assert.True(
            tenantGone < membershipsGone,
            "删租户必须排在删成员关系之前：反过来一旦中途失败，租户还在而最后一个 owner 已经进不来，连重试删除都做不到");
        Assert.Contains("export function deleteTenant(", api);
        Assert.Contains("removeTenant", page);
        // 租户没了，绑在它上面的会话也就没了：必须正规登出，不能留一个指向空租户的 token
        Assert.Contains("logout();", page);
    }

    /// <summary>
    /// 内部租户的池视图是「GW 自有池 + 未影子化的 MAP 池」两段拼起来的，
    /// 三个删除闸门就必须都按这个口径查占用，少一个就漏一类。
    ///
    /// 交换所那条最容易漏：它的判据要跑 GatewayExchangeSupportsModel 这个 C# 谓词，
    /// 写法和另外两条的 Mongo ElemMatch 不一样，于是第一版只扫了 GW 池。
    /// 而运行时 ModelResolver 解析 __exchange__ 成员时优先认 GW 自有交换所——
    /// 删掉它，那条 MAP 池成员就地解析不到上游，且删除时一句告警都没有。
    /// </summary>
    [Fact]
    public void AllDeleteGates_CountMapPoolsForInternalTenant()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        // 删模型 / 删平台：共享判定源里按 isInternal 把 MAP 池并进候选
        var collector = MethodBody(console, "static async Task<ModelDeleteBlockers> CollectModelDeleteBlockersAsync");
        Assert.Contains("isInternal", collector);
        Assert.Contains("mapPools.Find(memberFilter)", collector);

        var platformCollector = MethodBody(console, "static async Task<PlatformDeleteBlockers> CollectPlatformDeleteBlockersAsync");
        Assert.Contains("mapPools", platformCollector);

        // 删交换所：判据在端点内联（要跑 C# 谓词），同样必须并进 MAP 池
        var exchangeDelete = EndpointBody(console, "app.MapDelete(\"/gw/exchanges/{id}\"");
        Assert.Contains("internalTenantId", exchangeDelete);
        Assert.Contains("modelGroups.Find(", exchangeDelete);
        // 粗筛必须覆盖判据认的两种 PlatformId，少一个等于把那一类重新漏掉
        Assert.Contains("new[] { id, \"__exchange__\" }", exchangeDelete);
        // 且粗筛必须发生在判据之前——顺序反了就是先判后补，补进来的没人看
        Assert.True(
            exchangeDelete.IndexOf("modelGroups.Find(", StringComparison.Ordinal)
            < exchangeDelete.IndexOf("var blocking = pools", StringComparison.Ordinal),
            "MAP 池必须在 blocking 判据之前并入候选");
    }

    /// <summary>
    /// offering 是第二类引用，而且是唯一按 _id 单键指过去的那一类。
    ///
    /// 池成员按 (modelId, platformId) 复合定位、随处可见，写判据时很难忘；
    /// 逻辑模型的 offering 藏在另一张集合里，删掉目标它不会报错、不会变红，
    /// 只会在路由时静默解析不到——正是本 PR 的删除闸门要消灭的那种残留，
    /// 却在第一版里被删模型与删交换所两条路径同时漏掉。
    /// 所以这两条路径必须各自走同一个共享判定源，任何一条改回去都在这里变红。
    ///
    /// （上游合并那条路径同属这一族，随合并功能一起挪到后续 PR，
    /// 见 doc/debt.platform.llm-gateway.md「上游合并拆出本 PR」。）
    /// </summary>
    [Fact]
    public void Deletes_NeverOrphanLogicalModelOfferings()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        // 删模型：占用清单要同时报「池把它当成员」和「逻辑模型把它当 offering 上游」
        var modelDelete = EndpointBody(console, "app.MapDelete(\"/gw/models/{id}\"");
        Assert.Contains("blockers.TotalCount > 0", modelDelete);
        Assert.Contains("blockers.LogicalModels", modelDelete);

        // 删交换所：图层能力就是靠 TargetKind=exchange 的 offering 装起来的，只查池会整条漏掉
        var exchangeDelete = EndpointBody(console, "app.MapDelete(\"/gw/exchanges/{id}\"");
        Assert.Contains("CollectOfferingHolderNamesAsync(http, gwModelOfferings, gwLogicalModels, \"exchange\", id)", exchangeDelete);

    }

    /// <summary>
    /// 提示词策略是 appCaller 的从属子项，必须跟着一起删。
    ///
    /// 它只能从 `/gw/app-callers/{id}/prompt-policy` 建、没有独立入口，
    /// 运行时（`GatewayPromptPolicyApplier`）却按 (TenantId, AppCallerCode, RequestType) 选中它，
    /// **完全不看 appCaller 注册文档**。只删注册行的话策略照样在改写系统提示词；
    /// 而 appCaller 是被下一次真实调用被动重建的，重建之后老提示词就这么回来了——
    /// 与确认弹窗承诺的「配置不会回来」正好相反。
    /// </summary>
    [Fact]
    public void DeletingAppCaller_AlsoRemovesItsPromptPolicies()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var applier = ReadRepoFile("llmgw/serving/GatewayPromptPolicyApplier.cs");
        var page = ReadRepoFile("llmgw/web/src/pages/AppCallersPage.tsx");

        // 运行时的选中判据不含 appCaller 文档：这就是「只删注册行不够」的根据
        Assert.Contains("fb.Eq(\"AppCallerCode\", request.AppCallerCode.Trim().ToLowerInvariant())", applier);

        var delete = EndpointBody(console, "app.MapDelete(\"/gw/app-callers/{id}\"");
        Assert.Contains("promptPolicies.DeleteManyAsync", delete);
        Assert.Contains("promptPolicyVersionsDeleted", delete);
        // 删了几版必须报出来：它会改写系统提示词，静默删等于静默改行为
        Assert.Contains("promptPolicyVersionsDeleted", page);
    }

    /// <summary>
    /// 改名必须同步归一名。唯一索引与重名判定读的都是 NameNormalized，
    /// 只改 Name 会让「看到的名字」和「判定用的名字」分家：当场不报错，
    /// 下一次改名或新建才炸，且报的是索引冲突而不是「重名」。
    /// </summary>
    [Fact]
    public void PlatformRename_KeepsNormalizedNameInSync()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var update = EndpointBody(console, "app.MapPut(\"/gw/platforms/{id}\"");

        Assert.Contains("Set(\"NameNormalized\", normalized)", update);
        // 归一口径必须与创建路径一致（GatewayConfigurationProvisioning：Trim + ToLowerInvariant）
        Assert.Contains("name.ToLowerInvariant()", update);
        Assert.Contains("name.ToLowerInvariant()", ReadRepoFile("llmgw/console-api/Provisioning/GatewayConfigurationProvisioning.cs"));
        // 改成一个已存在的名字要按重名拒绝，而不是让唯一索引抛出去变成 500
        Assert.Contains("DUPLICATE_PLATFORM", update);
        // 预检和写入之间有窗口：并发改名双方都能过预检，最后由唯一索引挡下一个。
        // 只有预检没有 catch，那一个就成 500——同一件事对外报两种结果。
        // 这里要求这条路径自己接住 DuplicateKey，而不是依赖调用方少并发。
        var duplicateCatch = update.IndexOf("ServerErrorCategory.DuplicateKey", StringComparison.Ordinal);
        Assert.True(duplicateCatch > 0, "改名端点没有接住唯一索引的重名冲突，并发改名会变成 500");
        Assert.Contains("DUPLICATE_PLATFORM", update[duplicateCatch..]);
    }

    /// <summary>
    /// 改上游类型不能把「继承协议」的模型悄悄换掉报文协议。
    ///
    /// 模型 Protocol 为空表示继承所属上游
    /// （运行时 `IsNullOrWhiteSpace(Protocol) ? PlatformType : Protocol`），
    /// 把上游 openai 改成 claude，这批模型之后全按错协议发出去。一处挡了另一处没挡，
    /// 等于这条不变量只在一半路径上成立。
    /// </summary>
    [Fact]
    public void PlatformTypeChange_BlockedWhileModelsInheritProtocol()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var update = EndpointBody(console, "app.MapPut(\"/gw/platforms/{id}\"");

        Assert.Contains("PLATFORM_TYPE_LOCKED", update);

        // 判据必须真的按「继承」取模型：只看 PlatformId 会把显式写了协议的也算进去（过宽），
        // 只判某一种空值写法则会漏掉另外两种（过窄，形状 1）。三种空值形态都要认。
        var guardAt = update.IndexOf("PLATFORM_TYPE_LOCKED", StringComparison.Ordinal);
        var guard = update[..guardAt];
        Assert.Contains("Exists(\"Protocol\", false)", guard);
        Assert.Contains("Eq(\"Protocol\", BsonNull.Value)", guard);
        Assert.Contains("Eq(\"Protocol\", \"\")", guard);

        // 只在类型真的变了时才挡：空上游、或名下模型都显式写了协议的，改类型无人受影响
        Assert.Contains("string.Equals(currentType, type, StringComparison.Ordinal)", guard);

        // 判据取的模型集合必须与**路由能解析到的**那一套一致。认领自 MAP 的平台，名下模型
        // 可能还只存在于 MAP 的 models 集合里（池成员端点对内部租户会回退过去），
        // 那批模型 Protocol 为空一样继承本平台类型。只数 gwModels 就是形状 1：换个存放位置就漏。
        Assert.Contains("models.Find(", guard);
        Assert.Contains("internalTenantId", guard);
        // MAP 侧要排掉被 GW 同 _id 遮住的那些（认领是把同一个 _id 复制过来，GW 为准）
        Assert.Contains("gwIdsUnderPlatform", guard);

        // 报的条数必须是两边合计：名字列表是截断的，拿它的长度当条数会把 50 个说成 5 个，
        // 用户照着提示改完那 5 个再来，还是被挡。
        Assert.Contains("gwInheriting.Count + mapInheriting.Count", guard);
        var message = update[guardAt..];
        Assert.Contains("{inheritingCount} 个模型", message);
        Assert.DoesNotContain("{names.Count} 个模型", message);
    }

    /// <summary>
    /// 反断头通用守卫：api.ts 里导出的每个函数都必须有人调用。
    ///
    /// 形状 2（链路只建到一半）在本仓库的具体形态就是「后端加了端点、api.ts 加了函数、
    /// 然后没有任何页面用它」——编译过、全量测试绿、通读也看不出来，只会静默地
    /// 「功能像是有，但界面上找不到入口」。本测试写完当场就抓到一条：deleteModel
    /// 已经写了两天，前端一个调用点都没有。
    /// </summary>
    [Fact]
    public void ConsoleApiClient_HasNoOrphanExports()
    {
        var root = LocateRepoRoot();
        var srcDir = Path.Combine(root, "llmgw", "web", "src");
        var apiPath = Path.Combine(srcDir, "lib", "api.ts");
        var apiSource = File.ReadAllText(apiPath);

        var others = Directory
            .EnumerateFiles(srcDir, "*.*", SearchOption.AllDirectories)
            .Where(x => x.EndsWith(".ts", StringComparison.Ordinal) || x.EndsWith(".tsx", StringComparison.Ordinal))
            .Where(x => !string.Equals(x, apiPath, StringComparison.Ordinal))
            .Select(File.ReadAllText)
            .ToList();

        var orphans = new List<string>();
        foreach (Match match in Regex.Matches(apiSource, @"^export function (\w+)", RegexOptions.Multiline))
        {
            var name = match.Groups[1].Value;
            var word = new Regex($@"\b{Regex.Escape(name)}\b");
            if (others.Any(x => word.IsMatch(x))) continue;
            // 同文件内被引用 ≥2 次（定义 + 至少一处使用）说明它是内部 helper 顺带导出的，不算断头
            if (word.Matches(apiSource).Count >= 2) continue;
            orphans.Add(name);
        }

        Assert.True(
            orphans.Count == 0,
            $"api.ts 有 {orphans.Count} 个导出没有任何调用点，功能建了一半：{string.Join("、", orphans)}");
    }

    [Fact]
    public void AsrTargets_CannotBeReenabledWithoutReverseContractValidation()
    {
        var source = ReadRepoFile("llmgw/console-api/Program.cs");
        var platformEnable = EndpointBody(source, "app.MapPut(\"/gw/platforms/{id}/enabled\"");
        var modelEnable = EndpointBody(source, "app.MapPut(\"/gw/models/{id}/enabled\"");

        Assert.Contains("if (enabled && targetAuthority == \"llm_gateway\")", platformEnable);
        Assert.Contains("ValidateAsrPlatformMutationAsync", platformEnable);
        Assert.Contains("AsrOfferingContractPolicy.ErrorCode", platformEnable);
        Assert.Contains("if (enabled && targetAuthority == \"llm_gateway\")", modelEnable);
        Assert.Contains("ValidateAsrModelMutationAsync", modelEnable);
        Assert.Contains("AsrOfferingContractPolicy.ErrorCode", modelEnable);
    }

    /// <summary>
    /// 从端点定义切到它自己的收尾（`}).RequireAuthorization(...)` 那一行），而不是取固定字符数。
    ///
    /// 固定字符数的窗口会随着端点变长而悄悄把尾部断言切到窗口外——本仓库刚踩过：
    /// 往租户删除里加了几行，「必须挂 TenantOwner」这条断言就落到 4000 字之外报了「找不到」，
    /// 报的是缺失，实际是窗口太窄。判据的边界要跟着被判对象走，不能是一个拍出来的数字。
    /// </summary>
    private static string EndpointBody(string source, string anchor)
    {
        var start = source.IndexOf(anchor, StringComparison.Ordinal);
        Assert.True(start > 0, $"找不到端点：{anchor}");
        var end = source.IndexOf("}).Require", start, StringComparison.Ordinal);
        Assert.True(end > start, $"端点没有收尾的授权声明：{anchor}");
        var lineEnd = source.IndexOf('\n', end);
        return source[start..(lineEnd < 0 ? source.Length : lineEnd)];
    }

    /// <summary>
    /// 取一个静态方法的方法体。端点靠 "}).Require" 收尾，静态方法没有那个锚，
    /// 所以按大括号配平找终点——找错了会把后面的方法一起吃进来，断言就形同虚设。
    /// </summary>
    private static string MethodBody(string source, string signature)
    {
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start > 0, $"找不到方法：{signature}");
        var open = source.IndexOf('{', source.IndexOf('\n', start));
        Assert.True(open > start, $"方法没有方法体：{signature}");
        var depth = 0;
        for (var i = open; i < source.Length; i++)
        {
            if (source[i] == '{') depth++;
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0) return source[start..(i + 1)];
            }
        }

        Assert.Fail($"方法大括号不配平：{signature}");
        return string.Empty;
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
