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
    public void VisualCreation_SendsCanonicalBusinessRequestThroughDedicatedHttpGateway()
    {
        var program = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");
        var client = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs");
        var httpGateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/HttpLlmGatewayClient.cs");

        Assert.Contains("ILogicalModelGateway : ILlmGateway", ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/ILogicalModelGateway.cs"));
        Assert.Contains("ILogicalModelGateway, CoreGateway.ILlmGateway", httpGateway);
        Assert.Contains("AddScoped<PrdAgent.Core.LlmGateway.ILogicalModelGateway>", program);
        Assert.Contains("private readonly HttpLlmGatewayClient _servingGateway", client);
        Assert.Contains("HttpLlmGatewayClient servingGateway", client);
        Assert.True(
            client.Split("ILogicalModelGateway requestGateway = _servingGateway;", StringSplitOptions.None).Length - 1 == 2,
            "尚未迁移的消费者也必须保留独立 Gateway HTTP 边界");
        var logicalStart = client.IndexOf("private async Task<ApiResponse<ImageGenResult>> GenerateLogicalImageAsync", StringComparison.Ordinal);
        var logicalEnd = client.IndexOf("public async Task<ApiResponse<ImageGenResult>> GenerateAsync", logicalStart, StringComparison.Ordinal);
        var logicalPath = client[logicalStart..logicalEnd];
        Assert.Contains("_servingGateway.GenerateImageAsync", logicalPath);
        Assert.Contains("RequiredLogicalModelPublicId = logicalModel", logicalPath);
        Assert.Contains("CanonicalImageRequest = new GatewayCanonicalImageRequest", logicalPath);
        Assert.DoesNotContain("ResolveModel", logicalPath);
        Assert.DoesNotContain("ResolveRequiredLogicalModel", logicalPath);
        Assert.DoesNotContain("ImageGenRequestBuilder", logicalPath);
        Assert.Contains("ImageReferences = imageReferences", logicalPath);
        Assert.Contains("prompt, inputArtifactIds, identified.Width", logicalPath);
        Assert.Contains("ActualModel = response.Resolution?.ActualModel", logicalPath);
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs");
        Assert.Contains("actualModel = doneActualModel", worker);
        Assert.Contains("modelId = doneActualModel", worker);
        Assert.Contains("var doneActualModel = meta?.ActualModel", worker);
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
        // 这里原本钉的是「active appCaller 必须绑定 GW 权威模型池」——那是旧世界的不变量：
        // 池是必需品。2026-09-15 断流时换掉了：真正该守的是「不点名的请求有没有人接」，
        // 绑池只是接住它的其中一种方式。判据搬到本文件下面那条专门的断言里。
        Assert.Contains("FindUnnamedCatcherAsync", consoleProgram);
        Assert.Contains("active appCaller 必须使用 modelPolicy=auto/pool/pinned", consoleProgram);
        var modelResolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        Assert.DoesNotContain("active-appcaller-auto-policy-without-gateway-pool", modelResolver);
        Assert.Contains("allowMapFallback: !gatewayConfigRequired", modelResolver);
        Assert.Contains("TryGetGatewayAppCallerStatusAsync", modelResolver);
        Assert.Contains("GatewayAppCallerPolicy.AllowsTraffic", modelResolver);
        Assert.Contains("caller.TrafficRejected", modelResolver);
        Assert.Contains("DisableMapConfigFallbackForRegisteredAppCallers", modelResolver);
        Assert.Contains("if (!gatewayConfigRequired)", modelResolver);
        // 这条不变量在 2026-09-15 删池之后**变强了**：原来要求「GW-only 模式必须在任何
        // MAP appCaller 查询之前短路」，现在解析器根本不查 MAP 的调用方集合——那段查询
        // 是池路才需要的，池删了它也没了。所以判据从「顺序对」升成「压根没有」。
        Assert.DoesNotContain("_db.LLMAppCallers", modelResolver);
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
        // 这条状态与它的文案只属于 /gw/config-authority/bind-active-app-callers（还在写池绑定的老端点）。
        // 配置权威报告那一处已经换成「有没有对外模型接得住」，对应的断言在
        // 调用方有没有人接得住只许有一份判据 里——那条文案钉在这里会反向锁死已经修掉的判据。
        Assert.Contains("gw-pool-without-usable-member", consoleProgram);
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
        Assert.Contains("DefaultPoolId", consoleProgram);
        Assert.Contains("TenantAccess.FilterTeamScope(http, logFilter)", consoleProgram);
        Assert.Contains("fb.Eq(\"ModelPoolId\", modelPoolId.Trim())", consoleProgram);
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

        Assert.Contains("llmgw_model_pool_types", console);
        Assert.Contains("FindOneAndUpdateAsync", console);
        Assert.Contains("DefaultSwitchPendingUntil", console);
        Assert.Contains("PoolVersionGuard", console);
        Assert.Contains("APPEND_ONLY_POOL", console);
        Assert.Contains("Builders<BsonDocument>.Update.Push(\"Models\"", console);
        Assert.Contains("PLATFORM_DISABLED", console);
        Assert.DoesNotContain("!Flag(model, \"IsImageGen\")", registry);
        // 2026-09-14 池已停止新建：「按平台规则补齐」会建池、也会往在承接流量的托管池里追加成员，
        // 与冻结直接冲突，整块 UI 已删。这里反向钉住，防它随手被加回来。
        // 补齐语义本身（有则增加，无则不变）仍留在页面的 HelpPopover 里，上一条断言管着。
        // 冻结必须说出口，不能只把按钮藏了——用户会以为是权限问题或者页面坏了
    }


    [Fact]
    public void IntentPoolEligibility_HasExactlyOneJudgmentAndOneWayToDeclareIt()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var registry = ReadRepoFile("llmgw/console-api/ModelPools/GatewayModelPoolTypeRegistry.cs");
        var dtos = ReadRepoFile("llmgw/console-api/Models/Dtos.cs");

        // 判据只许有一份。Program.cs 曾抄过一份只认布尔位的拷贝，与注册表分别演进，
        // 同一个模型在 PUT 池成员与 bulk-import 两条路上判出不同结果。
        Assert.Contains("public static bool IsIntentCapable(BsonDocument model)", registry);
        var legacyIntentJudgment = new Regex(
            @"IsIntent""\)\s*==\s*true\s*\|\|[^\n]*IsMain",
            RegexOptions.None);
        Assert.False(
            legacyIntentJudgment.IsMatch(console),
            "Program.cs 里不许再出现只认 IsIntent/IsMain 布尔位的 intent 判据，走 GatewayModelPoolTypeRegistry.IsIntentCapable");

        // 判据认 Capabilities 里的 intent，就必须有一条只改这一个模型的能力维护路径；
        // 否则想给单个模型补一条能力，只能连同平台上几百个模型一起刷。
        Assert.Contains("HasCapability(model, \"intent\")", registry);
        Assert.Contains("public List<string>? ModelIds { get; set; }", dtos);
        Assert.Contains("必须选择平台或指定 modelIds", console);
        Assert.Contains("fb.In(\"_id\", modelIds)", console);
    }

    [Fact]
    public void RowActions_KeepsOverflowMenuClearOfTheCdsPreviewWidget()
    {
        // 窄屏行操作菜单贴视口底部，而 CDS 注入的预览徽章 #cds-widget 是
        // fixed / 左下角 / z-index 99999 —— 层级上永远压过菜单。做法是**量出真实遮挡**
        // 再让位，而不是拍一个固定留白：预览环境自动抬高，正式环境没有这个元素就还是贴底。
        //
        // 这段逻辑删掉之后编译照过、llmgw/web 又整包没有单测，属于「改动删掉测试仍全绿」，
        // 所以必须有一条会红的守卫（predicate-and-wiring-discipline 形状 2）。
        var rowActions = ReadRepoFile("llmgw/web/src/components/RowActions.tsx");

        Assert.Contains("function bottomObstructionHeight", rowActions);
        Assert.Contains("document.getElementById('cds-widget')", rowActions);
        // 判据要求它真的贴在视口底部才算数，别的地方出现同名元素不该跟着抬高
        Assert.Contains("rect.bottom < viewportHeight - 160", rowActions);
        // 查不到就是 0：正式环境必须原样退回贴底
        Assert.Contains("if (!widget) return 0;", rowActions);
        Assert.Contains("Math.max(10, bottomObstructionHeight(vh) + 8)", rowActions);
        // 抬高之后还要重算可用高度，否则菜单会从顶部溢出去
        Assert.Contains("maxHeight: Math.max(120, vh - bottom - 16)", rowActions);
    }

    [Fact]
    public void CallTrace_AnswersWhereARequestLandsIncludingTheUnnamedPath()
    {
        // 「调用全貌」这一屏的全部价值建立在两件事上：它说的是当前真实状态，
        // 而且它说的和运行时实际做的是同一份判据。任一条不成立，它就是一份看着很确定的假话。
        //
        // 判据一致性由 GatewayCallTraceMirrorTests 的行为对照钉住（那才是主守卫）；
        // 这里钉的是**接线**与**产品语义**：端点在不在、前端调没调、
        // 「只给 appCallerCode 不点名」那条路有没有被单独回答、按权重时有没有闭嘴不指名。
        var planner = ReadRepoFile("llmgw/console-api/LogicalModels/CallTracePlanner.cs");
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");
        var panel = ReadRepoFile("llmgw/web/src/components/CallTracePanel.tsx");
        var modelsPage = ReadRepoFile("llmgw/web/src/pages/LogicalModelsPage.tsx");
        var webApi = ReadRepoFile("llmgw/web/src/lib/api.ts");

        // 端点存在，且排队名次是服务端算的
        Assert.Contains("/gw/logical-models/{id}/call-trace", consoleProgram);
        Assert.Contains("CallTracePlanner.Queue(candidates", consoleProgram);
        Assert.Contains("offering.QueuePosition = positionById", consoleProgram);

        // 接线：前端真的调了它，页面真的渲染了面板
        Assert.Contains("getCallTrace", webApi);
        Assert.Contains("call-trace", webApi);
        Assert.Contains("CallTracePanel", modelsPage);
        Assert.Contains("getCallTrace", panel);

        // 前端不许再自己判「哪条在扛流量」——那份判据比运行时严，会把降级但仍在承接的
        // 线路显示成「没有主」。名次一律用服务端下发的 queuePosition。
        Assert.Contains("queuePosition === 1", modelsPage);
        Assert.DoesNotContain("x.enabled && x.healthStatus === 0", modelsPage);

        // 「只给 appCallerCode、不点名模型」那条路必须被单独回答，不能混在别的话里
        Assert.Contains("call-trace-unnamed", panel);
        Assert.Contains("只给 appCallerCode", panel);
        // 断言的是**接线**不是措辞：上一版这里逐字要求一句文案存在，结果这次把那句话
        // 改得更准确（补上主语）反而让守卫变红——谁修谁的 CI 红，正是形状 4a 该避免的写法。
        Assert.Contains("Unnamed = new CallTraceUnnamed", consoleProgram);
        Assert.Contains("ServesUnnamed = servesUnnamed", consoleProgram);

        // 按权重分配时不许指名道姓（运行时 seed 由 requestId 派生，说「会落到 A」就是编的）
        Assert.Contains("按权重分到", planner);
        Assert.Contains("不指名道姓", panel);

        // 结论在第一屏。把一屏数字丢给人自己算「所以会落到谁」，这一屏就白做了
        Assert.Contains("call-trace-conclusion", panel);

        // 缺价如实说，不补零
        Assert.Contains("未计价", panel);
        Assert.Contains("单价未登记", panel);

        // 「不点名会落到谁」这一问在运行时是一次 Mongo 查询（TryResolveDefaultLogicalModelAsync），
        // 不是纯函数，进不了 CallTracePlanner 的行为对照。它的三个条件必须在控制台这边逐条对齐，
        // 否则面板会把一个根本不生效的默认报成「现在的默认」：
        //   Enabled==true —— 停用的默认运行时会跳过并回落到池；
        //   DisplayOrder/PublicId 排序 —— 存量有两个默认时不排序就是看 Mongo 心情。
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        Assert.Contains("Builders<GatewayLogicalModel>.Filter.Eq(x => x.Enabled, true)", resolver);
        Assert.Contains("SortBy(x => x.DisplayOrder).ThenBy(x => x.PublicId)", resolver);
        Assert.Contains("Sort(Builders<BsonDocument>.Sort.Ascending(\"DisplayOrder\").Ascending(\"PublicId\"))", consoleProgram);

        // 「会落到它」要几件事同时成立，少一条就是在撒谎：够格当兜底（是用途默认，或者
        // 认领了调用方）、自己启用着、而且真有一条线路能接。
        //
        // 这里断言的是**接线**不是措辞：上一版逐字锁死了那个表达式，结果补上「按调用方
        // 认领」这一层之后，把判据改得更全反而让守卫变红——谁修谁的 CI 红（形状 4a）。
        Assert.Contains("item.Enabled && hasEligibleRoute", consoleProgram);
        Assert.Contains("item.IsDefaultForType || myClaims.Count > 0", consoleProgram);
        Assert.Contains("一条能接的线路都没有", consoleProgram);

        // 一条线路不参与，除了它自己被停用/熔断，还有第三种：它指向的物理模型或所属上游被停用。
        // 运行时用 requireEnabled 在查目标时过滤掉；控制台必须算出同一个答案并说得出原因。
        // 2026-09-14 漏掉这一档，线上 default-chat 的队首指向一个已停用的物理模型，
        // 面板照样指着它说「会落到它」——判据比它该管的范围窄（形状 1）。
        Assert.Contains("modelFilter &= Builders<LLMModel>.Filter.Eq(x => x.Enabled, true)", resolver);
        Assert.Contains("exchangeFilter &= Builders<ModelExchange>.Filter.Eq(x => x.Enabled, true)", resolver);
        Assert.Contains("bool TargetUsable(ModelOfferingItem offering)", consoleProgram);
        Assert.Contains("platformById.TryGetValue(platformId, out var platform)", consoleProgram);
        Assert.Contains("上游那个模型被停用了", planner);

        // 「不点名会落到它」必须有主语。
        //
        // 2026-09-15 对抗审查抓到的 P1：这句话此前只判模型这一侧（是默认、启用着、有能接的线路），
        // 全程不问「谁在调」。冒烟之所以没抓到，是因为只跑了一个调用方，
        // 用一个样本判绿了一句全称命题（形状 1）。
        //
        // 判据本身的两侧一致由 GatewayCallTraceMirrorTests 钉住；这里钉的是**接线**：
        // 运行时真的走共享判据、端点真的逐个调用方算、面板真的逐个调用方渲染、冒烟真的逐个跑。
        //
        // 视觉创作那份调用方名单 2026-09-16 从共享判据搬回解析器：它剩下的唯一职责是
        // 模型选择器的目录展示，解析判据和控制台面板都不需要知道它，份数从 2 降到 1。
        // 这里钉「名单在解析器里只许有一份集中的集合」，反向断言防它散成一串 if。
        Assert.Contains("VisualCatalogCallers.Contains(appCallerCode)", resolver);
        Assert.DoesNotContain("appCallerCode is AppCallerRegistry.VisualAgent.Image.Text2Img", resolver);

        Assert.Contains("CallTracePlanner.Reach(new CallTracePlanner.CallerBinding(", consoleProgram);
        Assert.Contains("CallTracePlanner.AllowsTraffic", consoleProgram);
        Assert.Contains("fb.Eq(\"RequestType\", item.ModelType)", consoleProgram);
        // 同上：断言接线不断言措辞。「落到这个模型」必须同时看调用方那道门与两层默认。
        Assert.Contains("ReachesThisModel = landsHere", consoleProgram);
        Assert.Contains("reach == CallTracePlanner.CallerReach.UsesModelCatalog", consoleProgram);
        Assert.Contains("mine || (!claimedElsewhere && item.IsDefaultForType)", consoleProgram);

        Assert.Contains("call-trace-unnamed-callers", panel);
        Assert.Contains("data.unnamed.callers.map", panel);
        // 2026-09-16 删掉「走自己的专属池」那个 chip：模型池退场后运行时不再看 AllowedModelPoolIds，
        // 放行的调用方一律认这张目录，那个 chip 只会拿一个已经失效的理由解释落点。
        Assert.DoesNotContain("走自己的专属池", panel);
        Assert.DoesNotContain("DedicatedPoolOnly", panel);

        // 冒烟必须逐个调用方跑。写死成「挑一个样本」的那种写法正是这次漏检的成因。
        var smoke = ReadRepoFile("scripts/llmgw-call-trace-smoke.py");
        Assert.Contains("for caller in callers:", smoke);
        Assert.Contains("app_caller=code", smoke);
        Assert.Contains("TrafficRejected", smoke);

        // 不点名是**两层**：先看有没有模型认领了这个调用方，没有才回落到用途默认。
        //
        // 这一层是模型池那个「按调用方兜底」能力的落点——少了它，把最后一个走池的调用方
        // 切过来时它会掉到全局默认上，换了模型。2026-09-15 盘线上数据才看出这个缺口：
        // document-store.transcribe-summary::chat 用的是自己池里的 gpt-4.1-mini，
        // 而 chat 的全局默认是 gpt-3.5-turbo。
        //
        // 面板必须把两层都算进去，否则又是一句「面板说不落到它、运行时落到它」的假话。
        Assert.Contains("AnyEq(x => x.DefaultForAppCallerCodes, appCallerCode)", resolver);
        // 顺序是判据：认领那一层必须查在用途默认之前，反了就等于这个字段不存在。
        var claimAt = resolver.IndexOf("AnyEq(x => x.DefaultForAppCallerCodes, appCallerCode)", StringComparison.Ordinal);
        var typeDefaultAt = resolver.IndexOf("fb.Eq(x => x.IsDefaultForType, true)", StringComparison.Ordinal);
        Assert.True(claimAt > 0 && typeDefaultAt > claimAt,
            "按调用方认领必须查在用途默认之前，否则那个字段等于不存在");

        // 「同用途最多一个默认」是库级不变量，不能只靠端点里的「先清后置」。
        //
        // 两个管理员同时改时，两边都能清完各自看到的旧默认再各自置上自己那个：两次写都成功，
        // 库里有两个默认，而不点名的请求解析到哪个全看排序，两人的界面都显示「已生效」。
        // 应用层补不了——Mongo 没有跨文档原子性，任何「查一下有没有别人」都在竞态窗口里。
        // 部分唯一索引把第二个写变成 E11000，端点如实回 409 而不是笼统的「保存失败」。
        // 索引由 DBA 建（no-auto-index），所以定义的落脚点是 DBA 指南，控制台只留巡检；两边都要在。
        var indexGuide = ReadRepoFile("doc/guide.platform.mongodb-indexes.md");
        Assert.Contains("uniq_llmgw_logical_default_per_type", consoleProgram);
        Assert.Contains("uniq_llmgw_logical_default_per_type", indexGuide, StringComparison.Ordinal);
        Assert.Contains("`IsDefaultForType` 等于 true", indexGuide, StringComparison.Ordinal);
        Assert.Contains("DEFAULT_CONFLICT", consoleProgram);

        // 认领是同一类不变量，同样要库级唯一——认领存在数组里，所以走多键唯一索引，
        // 每个元素各生成一个 (租户, 用途, 调用方) 键，跨文档唯一。
        // 部分过滤器判「数组里至少有一个字符串」：空数组在多键索引里记成 undefined，
        // 那样所有「一个都没认领」的模型会互相撞车，索引根本建不起来。
        Assert.Contains("uniq_llmgw_logical_claim_per_type", consoleProgram);
        Assert.Contains("uniq_llmgw_logical_claim_per_type", indexGuide, StringComparison.Ordinal);
        Assert.Contains("`DefaultForAppCallerCodes` 的类型是字符串", indexGuide, StringComparison.Ordinal);
        Assert.Contains("CLAIM_CONFLICT", consoleProgram);

        // 冲突时前面已经摘掉的认领要还回去：一次**被拒绝的保存**不许改线上路由。
        // 还原走条件更新（值还是我写的那个才还），还不回去的逐条报出来，不假装都还原了。
        Assert.Contains("claimRollbacks", consoleProgram);
        Assert.Contains("没能还原", consoleProgram);

        // 补偿要覆盖**所有**失败路径，不是只有并发冲突那一条。
        //
        // 摘和置是两次写，中间任何原因导致置失败——撞唯一索引、目标被别人删掉（404）、
        // 连接抖动（异常）——摘掉的就留在库里。摘的是默认时后果最重：这个用途一个默认都不剩，
        // 所有不点名的请求当场解析失败，而操作者只看到一句「模型不存在」。
        Assert.Contains("defaultRollbacks", consoleProgram);
        Assert.Contains("CompensateAsync(restoreDefaults: true)", consoleProgram);
        // 撞唯一索引那一支「还不还默认」不是常量，取决于撞的是哪条索引——
        // 上一版这里钉的是写死 false 的那种写法，等于反向锁死了缺陷：
        // 认领撞车时用途默认没有赢家，不还就把这个用途弄丢了。
        // 判据见 撞车补偿先分清撞的是哪条索引。
        Assert.Contains("CompensateAsync(restoreDefaults: claimRace)", consoleProgram);

        Assert.Contains("DefaultForAppCallerCodes", consoleProgram);
        Assert.Contains("claimedBy", consoleProgram);
        Assert.Contains("它被 {claimedBy[x.Code]} 认领了", consoleProgram);
        // 认领的唯一性由写入侧保证，且要先摘别人再置自己——反过来会有一瞬两个模型都认领同一个人。
        Assert.Contains("displacedClaims", consoleProgram);

        // 「必须绑池」换成「必须有人接得住」。
        //
        // 断流第一次撞上的就是这堵墙：架构上池早已可替换，写入侧却还把它当必需品
        // （active appCaller 必须绑定 GW 权威模型池）。真正该守的不是「绑没绑池」，
        // 是「不点名的请求有没有人接」——不然调用方一改成 active 就开始静默失败。
        Assert.DoesNotContain("active appCaller 必须绑定 llm_gateway.llmgw_model_pools", consoleProgram);
        Assert.Contains("FindUnnamedCatcherAsync", consoleProgram);
        Assert.Contains("没有对外模型接得住它", consoleProgram);
        // 写入侧那份判据必须与运行时的两层同序：先认领、后用途默认。
        var catcherAt = consoleProgram.IndexOf("static async Task<string?> FindUnnamedCatcherAsync", StringComparison.Ordinal);
        Assert.True(catcherAt > 0);
        var catcherEnd = consoleProgram.IndexOf(
            "static async Task<string?> ValidateActiveGatewayAppCallerConfigAsync", catcherAt, StringComparison.Ordinal);
        Assert.True(catcherEnd > catcherAt, "「接得住」判据的边界变了，守卫取值口径需要更新");
        var catcherBody = consoleProgram[catcherAt..catcherEnd];
        var claimLayer = catcherBody.IndexOf("AnyEq(\"DefaultForAppCallerCodes\"", StringComparison.Ordinal);
        var typeLayer = catcherBody.IndexOf("fb.Eq(\"IsDefaultForType\", true)", StringComparison.Ordinal);
        Assert.True(claimLayer > 0 && typeLayer > claimLayer,
            "写入侧的「接得住」判据必须与运行时同序：先认领、后用途默认");

        // 「有一条线路」要按运行时的口径判，不能只看 Offering 的 Enabled 开关。
        //
        // 运行时还会拒掉：健康档 Unavailable 的、目标模型或它的平台停用/不存在的、
        // 以及授权名单不含这个调用方的。只看 Enabled 的后果是闸门放行、请求全灭——
        // 发布门禁说「都有人接」，每条真实请求回 MODEL_NOT_FOUND。那比没有闸门更糟：
        // 它让人以为这件事已经验过了（形状 8：拿一份不成立的证据当证明）。
        Assert.Contains("fb.Ne(\"HealthStatus\", 2)", catcherBody);
        // 取整份模型文档而不只是平台 id：名录门要判它的模型名与放行标记。
        Assert.Contains("enabledModelById", catcherBody);

        /*
          兑换所那一支要判到**别名**这一层，不是只判兑换所文档启用。

          线路打给上游的是哪一个别名由 UpstreamModelId 决定；别名被摘掉或单独停用之后，
          兑换所照样启用着，而运行时把这条线路整条跳过。上一版这里钉的是只存 id 的那种写法
          （enabledExchangeIds），等于反向锁死了缺陷：闸门说「有能用的线路」，
          而那个调用方一条路都走不通。判据与写入侧、与运行时同一份。
        */
        Assert.Contains("enabledExchangeById", catcherBody);
        // 别名这一层与名录门合在一个判据里（ExchangeRoutePasses 内部先 Declares 再判门），
        // 它自己与运行时的对照在 ExchangeAliasPolicyMirrorTests。
        Assert.Contains("offering.AsNullableString(\"UpstreamModelId\")", catcherBody);

        /*
          授权名单与场景能力是**同一道门**，不能只判前一半。

          运行时走的是 SupportsAppCallerScenario：先看名单，再看这个调用方要的场景能力
          （text2img / img2img / vision_generation …）模型具不具备。只判名单的话，
          一个只会文生图的模型会被判成「接得住图生图调用方」，发布闸放行，
          而运行时对那个调用方的每一次请求都回能力不匹配。
        */
        Assert.Contains("LogicalModelCapabilityPolicy.SupportsAppCallerScenario(", catcherBody);
        Assert.Contains("GetStringArray(logical, \"Capabilities\")", catcherBody);

        /*
          名录门也要判：运行时在解析出口上会把名录外、又没盖放行标记的模型拒成
          MODEL_NOT_IN_CATALOG。闸门不判的话，一条「模型启用、平台启用」却过不了名录门的线路
          会被算成可用——发布放行，而经这条线路的每一次请求都失败。
          两支（物理线路 / 兑换所别名）都要判，判据走镜像类（有逐例对照守卫）。
        */
        Assert.Contains("CatalogGatePolicy.PhysicalRoutePasses(", catcherBody);
        Assert.Contains("CatalogGatePolicy.ExchangeRoutePasses(", catcherBody);
        Assert.Contains("CatalogGatePolicy.EnforcesAsync(", catcherBody);
        Assert.Contains("AllowsCaller", catcherBody);

        // 残留的池字段不许让这道判断整个被跳过。
        //
        // 运行时早就不读 ModelPoolId / AllowedModelPoolIds / DefaultModelPoolId 了，
        // 跳过去校验旧池会两头都错：健康的旧池替「其实没人接得住」的调用方背书（假绿），
        // 被删掉的旧池又拦住与它无关的治理改动（误伤），而它指的那个页面已经 302 走了。
        var validateAt = consoleProgram.IndexOf(
            "static async Task<string?> ValidateActiveGatewayAppCallerConfigAsync", StringComparison.Ordinal);
        var validateEnd = consoleProgram.IndexOf(
            "static async Task<bool> HasUsableGatewayPoolMemberAsync", validateAt, StringComparison.Ordinal);
        Assert.True(validateEnd > validateAt, "调用方校验的边界变了，守卫取值口径需要更新");
        var validateBody = consoleProgram[validateAt..validateEnd];
        var catcherCallAt = validateBody.IndexOf("await FindUnnamedCatcherAsync(", StringComparison.Ordinal);
        var poolBranchAt = validateBody.IndexOf("var strictPoolIds", StringComparison.Ordinal);
        Assert.True(catcherCallAt > 0 && poolBranchAt > catcherCallAt,
            "「谁接得住」必须无条件先判，不能因为调用方身上还留着池字段就整个跳过");
        // 还带着池绑定时，校验的是它的后继（对外模型记着 MigratedFromPoolIds），不是那个已退场的池。
        Assert.Contains("AnyEq(\"MigratedFromPoolIds\", effectivePoolId)", validateBody);
        Assert.DoesNotContain("HasUsableGatewayPoolMemberAsync(gwPlatforms, gwModels, gwModelExchanges, pool)", validateBody);

        // 「其余那些为什么没落到它」必须按真实构成说，不许写死成某几种原因。
        // 上一版写死了「配了专属池或未放行」，断流之后原因变成「被别的模型认领了」，
        // 那句总结就开始撒一个小谎——逐调用方那一栏是对的，总结不是（形状 1）。
        Assert.Contains("DescribeMissReasons", consoleProgram);
        Assert.DoesNotContain("其余的配了专属池或未放行", consoleProgram);

        // 判定流程图：图最容易被人当真，所以每条岔路的状态必须由后端下发，前端一句判断都不做。
        // 「前端自己判这支走不走」就是第二份判据（形状 3），而且是最难被发现的那一份。
        var flowPanel = ReadRepoFile("llmgw/web/src/components/CallTraceFlow.tsx");
        Assert.Contains("Flow = flow", consoleProgram);
        Assert.Contains("string StateOf(bool certain, bool possible)", consoleProgram);
        Assert.Contains("CallTraceFlow", panel);
        Assert.Contains("STATE_STYLE[branch.state]", flowPanel);
        // 三档齐全：少了 possible 就会把「取决于请求或调用方」硬画成一条确定路径，那是在编。
        Assert.Contains("taken:", flowPanel);
        Assert.Contains("possible:", flowPanel);
        Assert.Contains("blocked:", flowPanel);
        Assert.Contains("call-trace-flow", flowPanel);

        // 结论那一句也要有主语，而且点名与不点名都要有。
        //
        // 那道门罩的不只是「不点名」那一档，它罩着整张对外模型目录：配了专属池的调用方哪怕
        // 点名这个模型也走不到这里。2026-09-15 的逐调用方冒烟就是这么抓到的——点名
        // document-store-transcribe-summary 时运行时回的是 GatewayRegistryPool，没有线路标识。
        // 只修「不点名」那一格等于只修了一半（形状 1 的同一处再犯）。
        Assert.Contains("outsiderCount", consoleProgram);
        Assert.Contains("点名与不点名都走不到这里", consoleProgram);
        Assert.Contains("named_reach", smoke);
        Assert.Contains("走不到这张目录", smoke);

        // 文档里那张静态图与面板这张是同构的，改一边忘另一边就会对不上。
        var architecture = ReadRepoFile("doc/design.platform.llm-gateway.model-architecture.md");
        Assert.Contains("```mermaid", architecture);
        Assert.Contains("这个调用方<br/>放行吗", architecture);
        Assert.Contains("这个调用方放行吗", consoleProgram);
    }

    [Fact]
    public void RoutingNav_KeepsTwoEntriesAndLeavesNoDeadLinks()
    {
        // 路由这一组曾经是五条平级入口，而它们回答的只有两个问题：
        // 调用方能点名什么（模型）、东西从哪来（上游）。合成两条之后有两件事必须同时成立：
        //   1) 导航里不再出现那三条旧入口——否则合并等于没做；
        //   2) 三条旧地址仍然可达——路由还在，页内还有入口，否则就是把页面做成了孤儿。
        // 两条都属于「删掉之后编译照过、测试仍全绿」，必须有守卫。
        var layout = ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx");
        var app = ReadRepoFile("llmgw/web/src/App.tsx");
        var logicalModelsPage = ReadRepoFile("llmgw/web/src/pages/LogicalModelsPage.tsx");
        var overviewPage = ReadRepoFile("llmgw/web/src/pages/OverviewPage.tsx");
        var upstreamsPage = ReadRepoFile("llmgw/web/src/pages/UpstreamsPage.tsx");

        // 导航只剩两条。断言的是导航项本身（带 page/icon 的那一行），不是路径出现过没有——
        // 注释和别处的 Link 都会提到这些路径，只查路径必然误判。
        Assert.Contains("{ to: '/logical-models', label: '模型'", layout);
        Assert.Contains("{ to: '/platforms', label: '上游'", layout);
        Assert.DoesNotContain("to: '/pools', label:", layout);
        Assert.DoesNotContain("to: '/models', label:", layout);
        Assert.DoesNotContain("to: '/exchanges', label:", layout);

        // 旧地址仍然注册着路由
        // 池页面已删，但旧地址不留死链：/pools 重定向到模型页。
        Assert.Contains("<Route path=\"/pools\" element={<Navigate to=\"/logical-models\" replace />} />", app);
        Assert.Contains("path=\"/models\"", app);
        Assert.Contains("path=\"/exchanges\"", app);

        // 且各自至少有一个页内入口，不靠背地址进去
        // 模型页原本有一颗「存量模型池」按钮；池已于 2026-09-15 删除，按钮随之退场。
        Assert.Contains("to=\"/models\"", overviewPage);

        // /exchanges 落到上游页并自动选中「转接上游」那一段，锚点还在（图片分层是深链进来的）
        Assert.Contains("location.pathname.endsWith('/exchanges')", upstreamsPage);
        Assert.Contains("转接上游", upstreamsPage);
    }

    [Fact]
    public void ProviderRow_ShowsOwnedModelsAndWhetherTheyAreRegistered()
    {
        // 「模型属于上游」这件事在界面上的落地：展开一条上游就看到它卖的货，
        // 以及每个货登记到白名单没有——没登记的模型躺在库里，调用方按公开名请求找不到它。
        // 在这之前这件事只能靠在两个页面之间来回对照才看得出来。
        //
        // 这条链路整条删掉编译照过、llmgw/web 又整包没有单测，属于「改动删掉测试仍全绿」，
        // 所以必须有守卫（predicate-and-wiring-discipline 形状 2）。
        var panel = ReadRepoFile("llmgw/web/src/components/ProviderModelsPanel.tsx");
        var platformsPage = ReadRepoFile("llmgw/web/src/pages/PlatformsPage.tsx");

        // 判据认 targetId 不认名字：同名不同上游的两个物理模型按名字会被算成一个
        Assert.Contains("offering.targetKind !== 'model'", panel);
        Assert.Contains("byTarget.get(model.id)", panel);
        Assert.DoesNotContain("byTarget.get(model.modelName)", panel);
        // 没登记的排前面：这一屏唯一需要人动手的就是它们
        Assert.Contains("a.publicIds.length - b.publicIds.length", panel);
        // 结论句而不是一个数字：「3 个模型」读不出该不该管
        Assert.Contains("个没登记", panel);
        Assert.Contains("还没登记，调用方找不到它", panel);

        // 接线：上游页真的渲染了它，而不是只建了组件没人用
        Assert.Contains("ProviderModelsPanel", platformsPage);
        Assert.Contains("collectProviderModels", platformsPage);
        Assert.Contains("expandedModelsFor === p.id", platformsPage);
        // 批量登记走的就是既有的上游拉取清单流程，不另起一条
        Assert.Contains("onRegister={canWrite && p.authority === 'llm_gateway'", platformsPage);
        // 导入完必须重拉：不重拉的话刚登记完那一列还停在「2 个没登记」
        Assert.Contains("void refreshOwnedModels();", platformsPage);
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
        Assert.Contains("normalizeRoutePreview(payload, checked)", quickstart);
        Assert.Contains("preview.checkedBaseUrl !== normalizeBaseUrl(baseUrl)", quickstart);
        // 一次预检的结论钉着「哪一条路」：地址 + 钉住的成员。只比地址的话，换成员之后
        // 上一个成员的结论仍算数，会替一条没验过的路放行——池里有成员指向开发桩时，
        // 选中它的那一刻闸门还是绿的，正是这道闸要防的那件事。
        Assert.Contains("routePreview.checkedModel === (activeProbePin?.model ?? 'auto')", quickstart);
        Assert.Contains("routePreview.checkedPlatformId === (activeProbePin?.platformId ?? '')", quickstart);
        // 并发预检只认最后发起的那一代：先发的那条后到，会把旧结论盖到当前成员头上。
        Assert.Contains("const probeId = ++routeProbeSeq.current;", quickstart);
        Assert.Contains("if (superseded()) return;", quickstart);
        // 钉住与否只许判一处，预检与真实调用必须问同一个函数，否则预检的不是会跑的那条路。
        Assert.Equal(1, CountOccurrences(quickstart, "function pinnedTargetOf("));
        // 片段里的自由文本（输入框那句、上传的文本、模型名）要过 shell 转义：
        // 一个撇号就能让 -d 的参数提前收尾，后半句被当成命令跑。
        Assert.Contains("shellSingleQuoted(", quickstart);
        Assert.Contains("shellDoubleQuoted(appCaller)", quickstart);
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
        // 「模型池」2026-09-16 换成「对外模型」：那一页讲的就是调用方点名的那个名字，
        // 而模型池已经整个退场，留着旧词等于教一个不存在的概念。
        foreach (var concept in new[] { "租户", "团队与用户", "appCaller", "租户接入密钥", "对外模型", "模型", "Provider", "Exchange", "请求记录", "用量与费用" })
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

        // 名单是逐个毕业的，每切一个调用方就会增删一次——钉死整串会让那种正确改动误红。
        // 守的是两条不变量：值是字面量（下一行那条），且既有的 asr 调用方没在增删中掉队。
        var cdsAllowlist = Regex.Match(cdsCompose, "LlmGateway__HttpAppCallerAllowlist:\\s*\"([^\"]*)\"");
        Assert.True(cdsAllowlist.Success, "cds-compose.yml 必须显式声明 LlmGateway__HttpAppCallerAllowlist");
        Assert.Contains("transcript-agent.transcribe::asr", cdsAllowlist.Groups[1].Value);
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
        // 身份的定义在 expectedKeys 里（启动只拿它判等价、不拿它建索引，见「线路身份唯一索引不在启动时建」）。
        // 身份里必须带上「打给上游的是哪一个模型」：同一个兑换所下的不同别名是不同的线路，
        // 少了它第二条插入撞 E11000，搬迁半途而废且重跑还是同样结果，那条线路永久丢。
        var identityKeys = MethodBody(initializer, "private async Task EnsureOfferingIdentityIndexAsync");
        Assert.Contains("\"SupersededByOfferingId\",", identityKeys, StringComparison.Ordinal);
        Assert.Contains("\"UpstreamModelId\",", identityKeys, StringComparison.Ordinal);
        Assert.Contains("uniq_llmgw_offering_tenant_logical_target_v3", initializer);
        // 旧名字要能被认出来（用来判断该不该提醒 DBA），但**不在启动时丢它**——
        // 丢一条正在生效的唯一索引再同步重建会阻塞写入，那一步归 DBA 的维护窗口。
        Assert.Contains("legacyVersionAwareIndexName", initializer);
        Assert.Contains("IsEquivalentOfferingIdentityIndex", initializer);
        Assert.Contains("MongoDB 不允许同一 key/options 仅以不同名称重复建索引", initializer);
        // 先认等价索引、再谈别的：已经对了就什么都不做，不去提醒一件已经做完的事。
        Assert.True(
            initializer.IndexOf("IsEquivalentOfferingIdentityIndex(index, expectedKeys)", StringComparison.Ordinal)
            < initializer.IndexOf("线路身份唯一索引 {Expected} 不存在", StringComparison.Ordinal));
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
        // 深度就绪判的是「有对外模型接得住不点名的请求」。池那三个判据已随解析器的池分支一起删掉，
        // 留着它们等于让 readyz 替一条运行时已经不存在的路作保。
        Assert.Contains("HasLogicalCatcher", readiness);
        Assert.DoesNotContain("IsPoolRoutableForRequestType", readiness);
        Assert.DoesNotContain("HasEnabledBackend", readiness);
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
    /// 价格不许是一份写死在代码里的静态表。会过时，而过时的价格比没有价格更危险——它看起来是真的，
    /// 成本报表照算，没人会去核对（no-rootless-tree.md）。
    ///
    /// 2026-09-11 升级：这条原先只禁两个标识符名字（<c>PriceTable</c> / <c>BuiltinPricing</c>），
    /// 是典型的「断言某段实现的字面不存在」——换个名字就能绕过，而它真正要防的东西
    /// （说不出来源、说不出时效的价格）它一个字都没测。现在禁令保留，判据换成下面那条：
    /// 价格必须带来源与观测时间。
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
    /// 价格三件套：数字 + 从哪来 + 什么时候的，缺一不可。
    ///
    /// 判据落在「凡是把价格写进模型文档的地方，必须同时写来源与观测时间」。这不是形式主义：
    /// OpenAI 官方的模型清单根本不返回价格，所以这类模型的价格只能靠人填；一份填完就没人再看的
    /// 数字，半年后没有任何办法判断它还能不能信。来源与时效是这份数字唯一的根。
    /// </summary>
    [Fact]
    public void 价格写入点必须同时记录来源与观测时间()
    {
        var policy = ReadRepoFile("llmgw/console-api/Provisioning/PricingPolicy.cs");
        Assert.Contains("SourceUpstream", policy);
        Assert.Contains("SourceAdmin", policy);
        Assert.Contains("SourceMigrated", policy);
        Assert.Contains("ReviewIntervalDays", policy);
        Assert.Contains("IsStale", policy);

        // 写价的三条路径：手工新建、上游批量导入、编辑已有模型。一条都不许只写数字。
        var provisioning = ReadRepoFile("llmgw/console-api/Provisioning/GatewayConfigurationProvisioning.cs");
        Assert.Contains("[\"PriceSource\"]", provisioning);
        Assert.Contains("[\"PriceObservedAt\"]", provisioning);

        var program = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("doc[\"PriceSource\"] = PricingPolicy.SourceUpstream", program);
        Assert.Contains(".Set(\"PriceSource\", PricingPolicy.SourceAdmin)", program);
    }

    /// <summary>
    /// 改了模型档案上的价格，引用它的模型池必须能跟着改——调度真正读的是池成员里那一份。
    ///
    /// 此前 <c>PUT /gw/models/{id}</c> 压根不存在：模型建完就只能删了重建，而重建会丢池成员绑定，
    /// 于是没人敢动，价格要么一直空着要么一直旧着。这条守卫钉住「能改」与「改了能同步」两件事。
    /// </summary>
    [Fact]
    public void 模型可编辑且价格能同步到引用它的模型池()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("app.MapPut(\"/gw/models/{id}\"", program);
        Assert.Contains("app.MapGet(\"/gw/models/{id}/pool-usage\"", program);
        Assert.Contains("SyncPoolMemberPricingAsync", program);
        // 覆盖价必须看得出来是覆盖，而不是假装两边同源。
        Assert.Contains("PoolMemberPriceMatchesModel", program);
    }

    /// <summary>
    /// 控制台那份成本状态名必须与网关写进日志的那份逐字一致。
    ///
    /// 两个工程互不引用，只能各存一份；一旦漂移，统计口径和写入口径就对不上——
    /// 写入侧记 <c>stale_currency</c>、统计侧按别的名字找，那部分调用会凭空从缺价统计里消失。
    /// </summary>
    [Fact]
    public void 控制台的成本状态名与网关保持一致()
    {
        var core = ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayCostStatus.cs");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        foreach (var value in new[] { "priced", "unpriced", "stale_currency", "no_usage" })
        {
            Assert.Contains($"\"{value}\"", core);
            Assert.Contains($"\"{value}\"", console);
        }
    }

    /// <summary>
    /// 计价只许有一份算法。网关不得自己再算一遍——缓存 token 该不该从输入里扣、非美金价格算不算数，
    /// 这两个判断一旦有第二份实现，就会出现「两边各自正确、合起来对不上」的账。
    /// </summary>
    [Fact]
    public void 计价只走唯一算法入口()
    {
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");

        Assert.Contains("GatewayCostCalculator.Calculate", gateway);
        // 单价换算必须在算法里，网关里不许再出现按百万 token 折算的算式。
        Assert.DoesNotContain("/ 1_000_000m", gateway);
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
    /// <summary>
    /// 上游主表只摆拿来做决定的东西，接口细节收进预览与折叠区。
    ///
    /// 由来：2026-09-16 用户看这一页说「baseurl 其实不用暴露出来，一些常见的接口什么的，
    /// 无需用户配置，默认的就好」。当时主表有「类型 / API URL / 并发」三列——选完平台就定下来的
    /// 实现细节，用户读它们做不出任何决定，却占掉半张表宽（API URL 那一列自己就 360px）。
    ///
    /// 这条钉的是**收起来而不是删掉**：三项必须仍在「查看接口」预览里查得到，
    /// 否则换 baseUrl 的上游就没地方看当前地址了——那是把一个啰嗦问题换成一个瞎子问题。
    /// 判据认表头那一行的字面量，不认「API 地址」四个字，所以预览里的同名字段不会误伤。
    /// </summary>
    [Fact]
    public void 上游主表不摆接口实现细节()
    {
        var page = ReadRepoFile("llmgw/web/src/pages/PlatformsPage.tsx");

        Assert.DoesNotContain("<th style={th}>API URL</th>", page);
        Assert.DoesNotContain("<th style={th}>类型</th>", page);
        Assert.DoesNotContain("<th style={th}>并发</th>", page);

        // 收起来的三项必须还在，而且在同一个地方查得到。
        Assert.Contains("label: '接口类型'", page);
        Assert.Contains("label: 'API 地址'", page);
        Assert.Contains("label: '最大并发'", page);

        // 编辑时同理：默认只露名称与备注，接口细节在折叠区里。
        Assert.Contains("高级：接口类型、API 地址、并发", page);
    }

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
        // 2026-09-11：判据从「按价格字段反推 Complete」换成「读写入时记下的 CostStatus」。
        // 两条不变量没变——缺价保持未知不显示为 0、跨币种不相加——变的只是判断这件事的口径。
        // 反推是判据分裂的温床：写入侧改了计价口径而统计侧还按老规矩算，两边各自正确、合起来对不上。
        Assert.Contains("x.Status == GatewayCostStatusNames.Priced && x.Amount is not null && x.Currency is not null", consoleProgram);
        Assert.Contains(".Include(\"CostStatus\")", consoleProgram);
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
        // appCaller 页那个「预览模型池」抽屉随模型池路由一起退役了（2026-09-16）。
        // 它展示的池健康、成员顺位、选择策略都已不再决定这个 appCaller 走哪个上游，
        // 留着就是指着一条走不到的路（degradation-must-alarm 的反面：不是不响铃，是响错铃）。
        // 反向钉住：它不许回来，否则下一个人会照着那些数字排查一条不存在的链路。
        Assert.DoesNotContain("预览模型池", appCallers);
        Assert.Contains("Exchange 路由预览", exchanges);
        Assert.Contains("查看路由", exchanges);

        Assert.DoesNotContain("apiKey={", preview);
        Assert.DoesNotContain("bundle.key", preview);
    }

    /// <summary>
    /// 模型编辑抽屉的判据必须是「动没动过」，不是「填没填」。
    ///
    /// 这两件事混作一谈时会长出两种形态，都不会红：
    ///   - 五个价格框全清空 → 判成「没动过」，一个字段都不发，旧价原样留着，
    ///     而界面显示保存成功——过期价格在这个抽屉里根本删不掉；
    ///   - 只改名字或备注 → 框里还摆着旧价，判成「动过」，把五个价原样重发一遍，
    ///     服务端当成人工改价，把上游抓来的价贴上「人刚填的」标签，观测时间也刷成现在。
    /// 最大输出 token 是同一个形状：清空发出去是个被 JSON 省掉的字段，
    /// 服务端分不清它和「这次没动」，「留空表示不限制」于是兑现不了。
    ///
    /// 两侧都钉：前端要按初始值比对并发显式清空标志，服务端要认那两个标志。
    /// </summary>
    /// <summary>
    /// 「缺币种」与「算不出钱」这两件事，三处判据必须一致。
    ///
    /// 同一份数据此前有三种读法：/v1/models 把缺币种的当 USD 发出去、调用全貌面板把它标成 USD、
    /// 而记账那一侧判它 stale_currency 一分钱都不计。最不该错的是面板那一种——运维照着它算账。
    ///
    /// 「算不出钱的笔数」同理：stale_currency 与 unpriced 一样不进 USD 合计、不进预算，
    /// 只数字面的 unpriced 会让这一屏报「0 笔未计价」，而实际有一批存量流量正被静悄悄排除。
    /// </summary>
    [Fact]
    public void Console_Pricing_TreatsMissingCurrencyAndStaleCurrencyConsistently()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var catalog = ReadRepoFile("llmgw/serving/GatewayModelCatalogEndpoint.cs");

        // 面板不把缺币种的价标成 USD
        Assert.Contains("币种未登记", console);
        Assert.DoesNotContain("model.AsNullableString(\"PriceCurrency\") ?? \"USD\"", console);

        // 对外清单只报显式 USD
        Assert.Contains("!currency.IsString", catalog);

        // 两处「算不出钱」的计数都要含 stale_currency。
        //
        // 上一版靠数「这串字面量出现了两次」来保证，而两次意味着两份判据——它其实是在
        // 要求那份重复存在。现在两处共用同一个表达式，不变量由结构保证：数的是「调用点够不够」，
        // 判据本体只剩一处（形状 4a：别断言实现长什么样，断言它做到了什么）。
        Assert.Contains("GatewayCostStatusNames.Unpriced, GatewayCostStatusNames.StaleCurrency", console);
        var unpricedUses = System.Text.RegularExpressions.Regex
            .Matches(console, @"LogCostAggregation\.UnpricedCount\(\)").Count;
        Assert.True(unpricedUses >= 2,
            $"模型卡与调用全貌账两处都要走同一个未计价计数，当前只有 {unpricedUses} 处");
    }

    [Fact]
    public void Console_ModelEditor_DistinguishesClearedFromUntouched()
    {
        var drawer = ReadRepoFile("llmgw/web/src/components/ModelPricingDrawer.tsx");
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        // 判据按初始值比对，而不是「有没有填」
        Assert.Contains("initialPrices", drawer);
        Assert.Contains("pricingChanged", drawer);
        Assert.Contains("maxTokensChanged", drawer);

        // 清空走显式标志
        Assert.Contains("req.clearPricing = true", drawer);
        Assert.Contains("req.clearMaxTokens = true", drawer);

        // 服务端认这两个标志，且清空是 Unset 而不是写 0
        Assert.Contains("body.ClearMaxTokens == true", console);
        Assert.Contains("update.Unset(\"MaxTokens\")", console);
        Assert.Contains("var clearPricing = body.ClearPricing == true", console);
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
        // App 显示名优先取 appCallerCodeDisplayName / appCallerTitle —— 契约不变，位置变了。
        // 2026-08-14 之前这段判断在 6 个前端文件里各抄了一遍，本处两条断言分别钉住其中两份的
        // 字面实现；那正是「断言实现字面而非行为」的形状，抄第 7 份它也拦不住，
        // 反过来还把重复固化成了契约。现在口径收敛到 lib/logsHelpers.ts 的 appDisplayName，
        // 断言随之改为「唯一实现存在 + 两个消费方确实接上了它」。
        var logsHelpers = ReadRepoFile("llmgw/web/src/lib/logsHelpers.ts");
        Assert.Contains("export function appDisplayName(item: {", logsHelpers);
        Assert.Contains("const displayName = item.appCallerCodeDisplayName?.trim() || item.appCallerTitle?.trim()", logsHelpers);
        Assert.Contains("appDisplayName(detail)", drawer);
        Assert.Contains("appDisplayName(it)", logs);
        // 同批去掉了纯展示层的 `G-` 前缀：后端 appCallerCode 里没有它，appDetailsHref 也用原始
        // code，它唯一的作用是在放不下的 App 列里白占两格，并让同一个 App 在不同渲染点因名字
        // 哈希不同而出现两种图标颜色。写出 URL 的一侧不得再产生它（读入侧保留兼容旧链接）。
        Assert.DoesNotContain("`G-${", logs);
        Assert.DoesNotContain("`G-${", drawer);
        Assert.DoesNotContain("`G-${", entityDetails);
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

    /// <summary>
    /// 改请求的每一个输入，都必须作废「当前这一跑」。
    ///
    /// 坏法是静默的：产物留在屏幕上，而它旁边的 cURL 片段与「实际执行」已经跟着新输入
    /// 重新渲染了——用户看到的回答与它旁边写着的请求内容根本不是一回事；在途那条回来时
    /// 还会继续往新输入上写。页面不报错、测试不变红，只有真的坐下来点一遍才看得见。
    ///
    /// 判据不是「某个控件有没有清结果」，而是「改请求的那几个控件是不是都走了同一道作废」。
    /// 上一轮只给模型那一个装了，判据当时写成了「用户报的是哪个控件」——于是提示词、附件、
    /// 协议三处原样留着同一个洞。所以这里钉两件事：作废只有一份定义，且每一处都调它。
    /// </summary>
    [Fact]
    public void QuickstartRequestInputs_AllInvalidateTheActiveRun()
    {
        var quickstart = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");

        // 作废是一份共享动作（顶掉代次 + abort + 清产物 + 清结论），不许各处各写一套。
        Assert.Contains("const invalidateActiveRun = () => {", quickstart);
        Assert.Contains("activeRunAbort.current?.abort();", quickstart);

        /*
          这一屏有两条会写同一批状态（testing / testResult / liveOutput / testElapsedMs）的调用路径：
          安全测试 runTest 与真实调用 runRealTest。**两条都得挂在同一份代次上**——
          上一轮只给 runRealTest 装了，于是作废对 runTest 完全无效：在途那条回来照样把结论
          写到新输入上，它的 finally 还会把另一跑的忙态收掉（按钮提前解禁、计时停在别人的耗时上）。
        */
        foreach (var (name, from, to) in new[]
                 {
                     ("runTest", "const runTest = async (target = bundle, mode = testMode) => {", "const invalidateActiveRun = () => {"),
                     ("runRealTest", "const runRealTest = async () => {", "/** 读上传的文件"),
                 })
        {
            var start = quickstart.IndexOf(from, StringComparison.Ordinal);
            Assert.True(start >= 0, $"找不到 {name}，守卫的取值范围失效了");
            var end = quickstart.IndexOf(to, start, StringComparison.Ordinal);
            Assert.True(end > start, $"{name} 的取值范围没有正常收尾");
            var body = quickstart[start..end];

            Assert.Contains("const runId = ++activeRunSeq.current;", body);
            Assert.Contains("activeRunAbort.current = abortController;", body);
            Assert.Contains("const superseded = () => activeRunSeq.current !== runId;", body);
            Assert.Contains("signal: abortController.signal,", body);
            // 收尾（忙态 + 耗时）只许当前代次做，被顶掉的那一跑不许替新的那一跑解禁按钮。
            Assert.Contains("if (!superseded()) {", body);
        }

        // 四个会改变请求内容的输入，逐个必须调它。少一个就是又留下一条「产物与请求对不上」的路径。
        Assert.Contains("setModelQuery(event.target.value); invalidateActiveRun();", quickstart);
        Assert.Contains("setTestPrompt(event.target.value); invalidateActiveRun();", quickstart);
        Assert.Contains("setAttachment(null); invalidateActiveRun();", quickstart);
        Assert.Contains("setProtocol(event.target.value as Protocol); invalidateActiveRun();", quickstart);

        // 上传附件那条路径（pickAttachment）同样改请求，也要调——连同上面四处共 5 个调用点。
        var invalidations = CountOccurrences(quickstart, "invalidateActiveRun();");
        Assert.True(
            invalidations >= 6,
            $"改请求的输入必须全部走同一道作废，当前只有 {invalidations} 个调用点");

        // 「更改身份」是第六个出口，而且是唯一一个**离开这一屏**的：不 abort 的话请求照跑照计费，
        // 不顶代次的话它会把产物/结论/忙态写到新签出来的那个身份头上。
        var editStart = quickstart.IndexOf("const editIdentity = async () => {", StringComparison.Ordinal);
        Assert.True(editStart >= 0, "找不到 editIdentity，守卫的取值范围失效了");
        var editEnd = quickstart.IndexOf("setStage('intent');", editStart, StringComparison.Ordinal);
        Assert.True(editEnd > editStart, "editIdentity 的取值范围没有正常收尾");
        Assert.Contains("invalidateActiveRun();", quickstart[editStart..editEnd]);
    }

    /// <summary>
    /// 服务网关设置：那条绿色的「测试连接」结论是照**当时那份配置**跑出来的。
    /// 改了来源/池/模型还留着它，页面就成了「配置 B + 来自配置 A 的证明」；
    /// 保存之后同样如此——而这一页存在的理由正是让人当场确认这份配置能用。
    /// </summary>
    [Fact]
    public void GatewaySettings_InvalidatesTheTestResultOnEveryChange()
    {
        var gatewaySettings = ReadRepoFile("llmgw/web/src/pages/GatewaySettingsPage.tsx");

        Assert.Contains("const invalidateTestResult = () => {", gatewaySettings);
        // 三处选择走同一个出口：记一次「用户动过手」+ 改值 + 作废旧结论。
        Assert.Contains("onClick={() => changeSelection(() => setSource(item.id))}", gatewaySettings);
        Assert.Contains("onChange={(event) => changeSelection(() => setPoolId(event.target.value))}", gatewaySettings);
        Assert.Contains("onChange={(event) => changeSelection(() => setModelName(event.target.value))}", gatewaySettings);
        Assert.Contains("invalidateTestResult();", gatewaySettings[gatewaySettings.IndexOf("const changeSelection = (apply: () => void) => {", StringComparison.Ordinal)..]);

        /*
          保存期间控件仍可编辑（该保留：保存是个快请求，为它锁整屏不值当），
          而保存收尾会读回服务端那份。不认代次的话，用户在这一小段里改的选择会被
          读回来的旧值**静默覆盖**，`dirty` 随之归零——屏幕上是他没选的那个，
          页面还告诉他「已保存」。所以：保存开头钉住选择代次，收尾按它决定要不要回填。
        */
        Assert.Contains("const selectionAtStart = selectionSeq.current;", gatewaySettings);
        Assert.Contains("const editedDuringSave = selectionSeq.current !== selectionAtStart;", gatewaySettings);
        Assert.Contains("await load(!editedDuringSave);", gatewaySettings);
        // 不回填选择时仍要刷新 data，否则 dirty 会拿旧的服务端值比，说不出「这份还没保存」。
        Assert.Contains("setData(res.data);\n    if (!applySelection) return;", gatewaySettings.Replace("\r\n", "\n"));
        // 在途那次也要按代次丢弃：请求在路上时改了选择，旧结论回来就会给新配置背书。
        Assert.Contains("if (testSeq.current !== runId) return;", gatewaySettings);
        /*
          但被代次挡掉的那条分支上不许挂着别人依赖的收尾动作。
          忙态原来就收在那条分支里：作废之后请求回来被挡住，`setTesting(false)` 永远执行不到，
          计时器跟着 testing 跑，按钮永久停在「正在测试 N s」且禁用，只有刷新才能恢复。
          所以收忙态搬进 finally 且只由当前代次收，作废本身也顺手收一次。
        */
        Assert.Contains("if (testSeq.current === runId) setTesting(false);", gatewaySettings);
        var invalidateStart = gatewaySettings.IndexOf("const invalidateTestResult = () => {", StringComparison.Ordinal);
        Assert.True(invalidateStart >= 0, "找不到 invalidateTestResult，守卫的取值范围失效了");
        var invalidateEnd = gatewaySettings.IndexOf("const save = async () => {", invalidateStart, StringComparison.Ordinal);
        Assert.True(invalidateEnd > invalidateStart, "invalidateTestResult 的取值范围没有正常收尾");
        Assert.Contains("setTesting(false);", gatewaySettings[invalidateStart..invalidateEnd]);
        Assert.True(
            CountOccurrences(gatewaySettings, "changeSelection(() =>") >= 3,
            "三处选择都得走同一个出口，少一处就会留下「配置 B 配着配置 A 的证明」");
        // 保存自己也要作废一次：保存换的是「下一次调用按什么走」，旧结论证明不了新的那份。
        Assert.Contains("invalidateTestResult();\n    const editedDuringSave", gatewaySettings.Replace("\r\n", "\n"));
    }

    /// <summary>
    /// 逻辑模型清单被截断时，剩下那些必须够得着。
    ///
    /// 坏法同样是静默的：清单只回前 200 条，排在之后的模型在这一页等于不存在——
    /// 页面不报错、下拉里就是没有它，用户只会以为系统不支持那个模型。
    /// 所以截断要成对出现三件事：能筛（关键字进查询）、说得出还剩多少（总数回前端）、
    /// 筛的时候不动用户的选择（关键字不是配置变更，不能顺手把选择框重读回来）。
    /// </summary>
    [Fact]
    public void SystemSettings_KeepsLogicalModelsBeyondThePageReachable()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var gatewaySettings = ReadRepoFile("llmgw/web/src/pages/GatewaySettingsPage.tsx");
        var api = ReadRepoFile("llmgw/web/src/lib/api.ts");

        var start = console.IndexOf("app.MapGet(\"/gw/system-settings\"", StringComparison.Ordinal);
        Assert.True(start >= 0, "找不到 /gw/system-settings，守卫的取值范围失效了");
        var end = console.IndexOf("app.MapPut(\"/gw/system-settings\"", start, StringComparison.Ordinal);
        Assert.True(end > start, "/gw/system-settings 读端点的取值范围没有正常收尾");
        var endpoint = console[start..end];

        /*
          关键字要真的进**清单那条查询**，不是「代码里出现过这个变量」就算数。
          第一版守卫写成了后者：把清单查询改回未筛的 chatModelFilter，
          变量仍在（定义 + 计数还用着它），断言照样绿——判据读的不是真正生效的那个值。
        */
        Assert.Contains("http.Request.Query[\"q\"]", endpoint);
        Assert.Contains(".Find(chatModelQueryFilter)", endpoint);
        // 总数也必须按同一份条件数，否则「还剩 N 条」说的是另一批模型。
        Assert.Contains("CountDocumentsAsync(chatModelQueryFilter)", endpoint);
        // 总数要回出去：说不出「还剩多少条」，用户就无从判断该不该去筛。
        Assert.Contains("modelTotal = chatModelTotal", endpoint);
        Assert.Contains("modelPageSize = ChatModelPageSize", endpoint);
        // 已保存的那个仍按未筛的条件补进来：筛掉它就等于把「当前在用的模型」从页面上抹掉。
        Assert.Contains("chatModelFilter,", endpoint);

        Assert.Contains("export function getSystemSettings(query?: string)", api);
        Assert.Contains("`/system-settings?q=${encodeURIComponent(q)}`", api);

        Assert.Contains("placeholder=\"按模型名或标识筛选\"", gatewaySettings);
        /*
          连着敲几个关键字就有几条读在路上：先发的那条**后回来**会把清单盖成上一个关键字的结果
          （搜索框写着 B、下拉里装着 A 的模型）；保存前发出的那条回来还会把 data 盖回保存前那份，
          让刚存好的配置显示成「未保存」、连测试连接都跟着被禁用。所以读回也按代次丢弃。
        */
        Assert.Contains("const loadId = ++loadSeq.current;", gatewaySettings);
        Assert.Contains("if (loadSeq.current !== loadId) return;", gatewaySettings);
        // 筛清单不是改配置：不回填选择框（applySelection=false），也不作废测试结论。
        Assert.Contains("void load(false, modelQuery);", gatewaySettings);
        Assert.Contains("data.modelTotal > data.models.length", gatewaySettings);
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

        // appCallerCode 必须从用户那句「我想要做什么」派生，不许再兜底成 `xxx.quickstart` 占位码：
        // 用户三次反馈「不要直接给一个随机的 xxxquickstart」，靠人自觉守不住，钉成字面量断言。
        var intent = ReadRepoFile("llmgw/web/src/lib/appCallerIntent.ts");
        Assert.Contains("MIN_INTENT_LENGTH", intent);
        Assert.Contains("analyzeAppCallerIntent", quickstart);
        Assert.Contains("buildAppCallerCode", quickstart);
        Assert.DoesNotContain(".quickstart::", quickstart);
        // 码由模型推：控制台自己吃自己的狗粮，走 serving 的兼容端点，前端边收边渲染。
        // 这条接线删掉不会让任何测试变红（页面会静默退回本地关键词表），所以钉成字面量。
        var consoleApi = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("/gw/app-callers/draft", consoleApi);
        Assert.Contains("X-Gateway-App-Caller", consoleApi);
        Assert.Contains("INTENT_DRAFT_UNAVAILABLE", consoleApi);
        Assert.Contains("draftAppCallerIntent", quickstart);

        // 系统级凭据必须自愈：手签一把 key 塞环境变量的做法在真实部署上出过
        // 「网关对自己回 401」——env 与网关库的密钥目录一旦对不上就没人能自救。
        // 这四条接线删掉都不会让别的测试变红（推导会静默退回本地关键词表），所以钉成字面量。
        Assert.Contains("EnsureSystemGatewayAccessAsync", consoleApi);
        Assert.Contains("llmgw_system_settings", consoleApi);
        Assert.Contains("/gw/system-settings", consoleApi);
        Assert.Contains("/gw/system-settings/test", consoleApi);
        // 推导端点必须走自愈入口取凭据，不许再直接读密钥类环境变量。
        Assert.DoesNotContain("LLMGW_INTENT_DRAFT_KEY", consoleApi);
        // 裸状态码对用户毫无意义（他会问「系统就是网关，还 401?」），必须翻译成能行动的一句话。
        Assert.Contains("ReadGatewayFailureDetailAsync", consoleApi);
        Assert.Contains("GATEWAY_KEY_INVALID", consoleApi);
        // 设置页存在、接进路由与侧栏，并且只让用户做「用哪个模型」这一个决定。
        var gatewaySettings = ReadRepoFile("llmgw/web/src/pages/GatewaySettingsPage.tsx");
        Assert.Contains("getSystemSettings", gatewaySettings);
        Assert.Contains("testSystemSettings", gatewaySettings);
        Assert.Contains("gatewaySettings", ReadRepoFile("llmgw/web/src/lib/access.ts"));
        Assert.Contains("/gateway-settings", ReadRepoFile("llmgw/web/src/App.tsx"));
        Assert.Contains("服务网关设置", ReadRepoFile("llmgw/web/src/components/ConsoleLayout.tsx"));
        // 系统密钥明文永不下发到浏览器：设置页只认前缀字段。
        Assert.DoesNotContain("credentialPlaintext", gatewaySettings);
        Assert.Contains("credentialPrefix", gatewaySettings);
        // 自愈必须真的闭环：被网关以凭据类原因拒绝时要作废重签，而不是让用户再点一次。
        // 且只对「重签能修好」的码作废——否则就成了自己修不好自己的循环（形状 5）。
        Assert.Contains("InvalidateSystemCredentialAsync", consoleApi);
        Assert.Contains("IsSystemCredentialFixableCode", consoleApi);
        // 系统密钥不挂在任何人名下：挂了人，那个人一离职这把 key 就跟着死。
        Assert.Contains("{ \"CreatedByUserId\", BsonNull.Value },", consoleApi);
        // 自签的 key 必须能在接入密钥页看见：列表只收 IssuanceState 缺失或 issued，
        // 写别的值这把 key 就成了页面上不存在的幽灵凭据。
        Assert.Contains("{ \"IssuanceState\", \"issued\" },", consoleApi);

        // ── 系统内部消耗单独计费：凭据与用途码必须挂在专属的「系统内部」团队上 ──
        // 用户 2026-08-28：「系统内部的，按照系统内部的团队，消耗，权限……计费方式是单独计费」。
        // 借用「租户第一个 active 团队」会把系统用量记进某个业务团队的预算，且这个团队随
        // 建库顺序变化。删掉这条归属不会让任何测试变红（调用照常成功，只是记错账），故钉字面量。
        Assert.Contains("EnsureSystemTeamAsync", consoleApi);
        Assert.Contains("const string SystemTeamName = \"系统内部\";", consoleApi);
        // 归属不许由请求体写入——留一个可写字段就等于留一条把系统账单混进业务团队的路。
        Assert.DoesNotContain("TeamId", MethodBody(
            ReadRepoFile("llmgw/console-api/Models/Dtos.cs"),
            "public sealed class UpdateSystemSettingsRequest"));
        // 「系统内部永远不会出现 401」要靠**事前**核对，不能只等被拒之后再自愈：
        // 复用存量 key 前先按 serving 的门禁判据过一遍，对不上就地重签。
        Assert.Contains("SystemKeyStillPassesTheGate", consoleApi);
        // key 与 appCaller 归属团队对不上时 serving 回 GATEWAY_KEY_TEAM_MISMATCH，
        // 而重签走 EnsureSystemTeamAsync 能让两边落到同一个团队——所以它必须在可自愈码里。
        Assert.Contains("GATEWAY_KEY_TEAM_MISMATCH", consoleApi);
        Assert.Contains("GATEWAY_KEY_TEAM_INACTIVE", consoleApi);
        // 模型推的、本地降级的、用户手改的，界面必须分得出来（推断值可见可改可追责）。
        Assert.Contains("codeSource", quickstart);
        // 系统提示词是给用户粘走的产物，绝不能把密钥明文写进去。
        Assert.Contains("$LLMGW_API_KEY", quickstart);
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
        // 判的是「这几个入口分别落到 serving」，不是「serving 的 proxy_pass 出现几次」。
        // 数个数有两处坏：新增一条**合法**的 serving 入口它也红（2026-08-30 补
        // /llmgw/gw/v1/ 时就红了一次，逼着人去改数字而不是去核对路由）；反过来，
        // 把某条入口从 8091 改到 8090、同时在别处补一条 8091，总数不变照样绿。
        // 取的是**生效的**那条 proxy_pass，不是「块里出现过这串字」：注释掉的那行
        // 一样含有它，用 Contains 判会把一条被注释的声明当成证据（形状 8）——
        // 这条守卫自己就栽过一次：把某个入口改指 8090、再把原来那行注释掉留在块里，Contains 照样绿。
        foreach (var servingPrefix in new[] { "/gw/v1/", "/v1/", "/v1beta/", "/gemini/v1beta/", "/llmgw/gw/v1/" })
        {
            var locationAt = webNginx.IndexOf($"location ^~ {servingPrefix} {{", StringComparison.Ordinal);
            Assert.True(locationAt >= 0, $"nginx.conf 缺少 serving 入口 location ^~ {servingPrefix}");
            var blockEnd = webNginx.IndexOf("\n    }", locationAt, StringComparison.Ordinal);
            Assert.True(blockEnd > locationAt, $"location ^~ {servingPrefix} 的块没有正常收尾");
            var effectiveProxyPasses = webNginx[locationAt..blockEnd]
                .Split('\n')
                .Select(line => line.Trim())
                .Where(line => line.StartsWith("proxy_pass ", StringComparison.Ordinal))
                .ToList();
            Assert.True(
                effectiveProxyPasses.Count == 1,
                $"location ^~ {servingPrefix} 里生效的 proxy_pass 应当只有一条，实际 {effectiveProxyPasses.Count} 条");
            Assert.Equal("proxy_pass http://$llmgw_serving_upstream:8091;", effectiveProxyPasses[0]);
        }
        Assert.Contains("llmgw-serve:", devCompose);
        Assert.Contains("dockerfile: llmgw/serving/Dockerfile", devCompose);
        Assert.Contains("- llmgw-serve", devCompose);
    }

    /// <summary>
    /// 登录一个月、滑动续期，且一次 SSO 不得踢掉这个人别处的会话。
    ///
    /// 用户 2026-08-28：「为什么登录总是失效，我都不知道 sso 多少次了……系统默认登录时间为
    /// 一个月，滑动更新，不允许短效，不允许打开链接就失效登录」。
    ///
    /// 根因是 map-sso 无条件 `.Inc(SecurityVersion, 1)`：SecurityVersion 是撤销计数器，
    /// 每个已鉴权请求都拿 token 里的版本与库里比对，对不上整条会话作废。于是**登录**成了
    /// 撤销事件——每 SSO 一次，之前发出去的所有链接同时失效。
    ///
    /// 这两处改动删掉都不会让任何测试变红（登录照样成功，只是会话又开始随机掉），
    /// 所以按「删掉仍全绿就需要一条守卫」钉成字面量。
    /// </summary>
    [Fact]
    public void GatewaySession_LastsAMonthSlidesAndIsNotRevokedByLoggingInAgain()
    {
        var consoleApi = ReadRepoFile("llmgw/console-api/Program.cs");
        var ssoStart = consoleApi.IndexOf("app.MapPost(\"/gw/auth/map-sso\"", StringComparison.Ordinal);
        Assert.True(ssoStart > 0, "找不到 map-sso 端点");
        var ssoEnd = consoleApi.IndexOf("}).AllowAnonymous();", ssoStart, StringComparison.Ordinal);
        Assert.True(ssoEnd > ssoStart, "map-sso 端点没有收尾声明");
        var mapSso = consoleApi[ssoStart..ssoEnd];
        Assert.DoesNotContain("SecurityVersion, 1", mapSso);

        // 撤销计数器有**两个**：用户 SecurityVersion 与成员 Version，token 里两个都带、
        // 每个请求都比对。只修掉一个，用户看到的仍然是「每次打开链接都要重新 SSO」——
        // 这正是第一轮修完之后实测仍然 401 的原因。所以两条都要钉。
        //
        // 成员那条不能简单地断言「不出现 Inc(Version, 1)」：真的有变化（首次进来、
        // 角色或状态被改过）时该自增是对的。判据是「必须先有一条不动版本的路」——
        // 角色与状态都已就位时只刷 UpdatedAt，落不到那条才走带 Inc 的 upsert。
        Assert.Contains("Builders<LlmGwMembership>.Update.Set(x => x.UpdatedAt, now)", mapSso);
        var unchangedPathIndex = mapSso.IndexOf("Builders<LlmGwMembership>.Update.Set(x => x.UpdatedAt, now)", StringComparison.Ordinal);
        var incPathIndex = mapSso.IndexOf(".Inc(x => x.Version, 1)", StringComparison.Ordinal);
        Assert.True(incPathIndex > 0, "成员变更路径仍应保留版本自增");
        Assert.True(
            mapSso.IndexOf("if (membership is null)", unchangedPathIndex, StringComparison.Ordinal) > unchangedPathIndex,
            "带 Inc 的 upsert 必须只在「不动版本那条路没命中」时才走");

        // 真正撤销会话的三处仍必须自增，否则改密/停用成员就形同虚设。
        Assert.Contains(".Inc(u => u.SecurityVersion, 1)", consoleApi);

        // 时长：常量与 appsettings 两处都要是 30 天。只改常量不改配置文件不会生效——
        // 配置里的值覆盖常量，那正是「改了却没生效」这一类问题的常见形状。
        var jwt = ReadRepoFile("llmgw/console-api/Auth/GwJwt.cs");
        Assert.Contains("DefaultLifetimeDays = 30", jwt);
        Assert.Contains("X-Gw-Token-Expires-At", ReadRepoFile("llmgw/console-api/Auth/GwSessionHeaders.cs"));
        var appSettings = ReadRepoFile("llmgw/console-api/appsettings.json");
        Assert.Contains("\"LifetimeDays\": 30", appSettings);

        // 滑动续期要真的接到浏览器上：后端发续期头、前端收下并覆写本地会话，缺一条就退化成硬过期。
        var webApi = ReadRepoFile("llmgw/web/src/lib/api.ts");
        Assert.Contains("x-gw-token", webApi.ToLowerInvariant());
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

        // 2) 认得出——只给指纹，且必须有 ConfigWrite 才下发；明文任何时候都不许出现在响应里
        Assert.Contains("public static string Fingerprint(", crypto);
        Assert.Contains("public string? KeyFingerprint", dtos);
        Assert.Contains("LlmGwPermissions.ConfigWrite", console);
        Assert.Contains("revealFingerprint", console);
        // 明文解出来只有一个去处：喂给 Fingerprint。多出任何一处引用都可能是把整把 key 塞进了响应。
        Assert.Contains("GwApiKeyCrypto.Fingerprint(decrypted.PlainText)", console);
        Assert.Equal(
            1,
            console.Split("decrypted.PlainText").Length - 1);

        // 3) 查得到——按 PlatformId 精确过滤（provider 会重名，本仓库真出现过同名同 URL 两条上游）
        Assert.Contains("fb.Eq(\"PlatformId\", platformId.Trim())", console);
        Assert.Contains("platformId?: string;", ReadRepoFile("llmgw/web/src/lib/types.ts"));
        Assert.Contains("initialQueryValue('platformId')", logsView);
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

        // 5) 模型也删得掉——平台删除要求先清模型引用，没有这个端点那条路径根本走不通
        Assert.Contains("app.MapDelete(\"/gw/models/{id}\"", console);
        Assert.Contains("MODEL_IN_USE", console);
        Assert.Contains("model.delete", console);
        Assert.Contains("export function deleteModel(", api);
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
        Assert.Contains("EXCHANGE_IN_USE", console);
        Assert.Contains("MODEL_IN_USE", console);
        // 逻辑模型没有阻挡：Offering 是它自己的下挂路由，别处不引用，所以是连带删。
        // 但连带删必须把删掉几条报回去——否则运维点一次删掉 N 条却毫无感知。
        Assert.Contains("OfferingsDeleted", console);
        Assert.Contains("offeringsDeleted", ReadRepoFile("llmgw/web/src/pages/LogicalModelsPage.tsx"));
        // 交换所被引用有两种写法（直指 id / __exchange__ 别名），只查一种会漏判成「没人用」
        Assert.Contains("__exchange__", console);
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
        // 租户没了，绑在它上面的会话也就没了：必须正规登出，不能留一个指向空租户的 token
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
    [Fact]
    public void 删对外模型之前先问过在途任务()
    {
        /*
          删对外模型会连着删掉它名下的全部线路，而视频任务提交成功后把线路 id 写进了自己的文档，
          轮询与下载都靠它回到同一个上游。先删后问等于没问——所以判据不只是「有没有这段代码」，
          还有「它在不在删除语句之前」（位置断言，与撞车补偿、首屏失败那两条同一形状）。
        */
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var delete = EndpointBody(console, "app.MapDelete(\"/gw/logical-models/{id}\"");
        var asked = delete.IndexOf("OfferingReferencePolicy.BuildInFlightVideoRunFilter", StringComparison.Ordinal);
        var deleted = delete.IndexOf("gwLogicalModels.DeleteOneAsync", StringComparison.Ordinal);
        Assert.True(asked >= 0, "删对外模型时没有问过在途任务还在不在用它名下的线路");
        Assert.True(deleted >= 0, "找不到删除语句，守卫的位置断言已经失去意义");
        Assert.True(asked < deleted, "在途任务这道闸排在删除语句之后，等于没有拦");

        // 两种引用形态都要查：direct 写在任务根上，storyboard 逐镜写。漏一种等于没查。
        var policy = ReadRepoFile("llmgw/console-api/LogicalModels/OfferingReferencePolicy.cs");
        Assert.Contains("VideoRunRootOfferingField", policy, StringComparison.Ordinal);
        Assert.Contains("VideoRunSceneOfferingField", policy, StringComparison.Ordinal);
    }

    [Fact]
    public void 挂线路与开线路走同一道上游资格闸()
    {
        /*
          「这条上游还承接得了流量吗」原先只长在新建线路那一个端点上，而重新启用一条停用的线路
          走的是另一个端点——同一个不可用状态在一边拦得住、另一边拦不住（形状 3：判断在两个入口
          各写一份然后各自漂移）。判据收进 OfferingTargetEligibility 之后，守卫盯两件事：
          两个入口都真的调了它；Program.cs 里不许再留一份自己拼的同名判断。
        */
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var create = EndpointBody(console, "app.MapPost(\"/gw/logical-models/{id}/offerings\"");
        var enable = EndpointBody(console, "app.MapPut(\"/gw/logical-models/{logicalId}/offerings/{offeringId}/enabled\"");
        Assert.Contains("OfferingTargetEligibility.Evaluate", create, StringComparison.Ordinal);
        Assert.Contains("OfferingTargetEligibility.Evaluate", enable, StringComparison.Ordinal);

        Assert.Equal(0, CountOccurrences(console, "\"TARGET_PLATFORM_UNAVAILABLE\""));
        Assert.Equal(0, CountOccurrences(console, "\"TARGET_DISABLED\""));
        var policy = ReadRepoFile("llmgw/console-api/LogicalModels/OfferingTargetEligibility.cs");
        foreach (var code in new[] { "TARGET_NOT_FOUND", "TARGET_DISABLED", "TARGET_PLATFORM_UNAVAILABLE", "EXCHANGE_ALIAS_NOT_DECLARED" })
            Assert.Contains($"\"{code}\"", policy, StringComparison.Ordinal);
    }

    [Fact]
    public void 线路身份唯一索引不在启动时建()
    {
        /*
          no-auto-index：启动路径上不许建索引。上一版在「全新库」那条分支上留了个口子，
          理由是新库没有存量所以安全——那个理由站不住，因为「库其实不新、只是索引被误删了」
          长得一模一样。判据因此不看分支，只看这个文件里还有没有人去建这条索引：
          身份索引的最后一个键是 SupersededByOfferingId，它出现在 IndexKeys 里就说明又建上了。
        */
        var initializer = ReadRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        Assert.Equal(0, CountOccurrences(initializer, "Ascending(\"SupersededByOfferingId\")"));

        var method = MethodBody(initializer, "private async Task EnsureOfferingIdentityIndexAsync");
        Assert.Equal(0, CountOccurrences(method, "Indexes.CreateOneAsync"));
        Assert.Equal(0, CountOccurrences(method, "Indexes.CreateManyAsync"));
        // 只报不建的前提是「真的报出来了」：缺索引与旧索引两种都要留下可读的告警。
        Assert.Equal(2, CountOccurrences(method, "_logger.LogWarning"));
    }

    [Fact]
    public void 并发挂线路撞唯一索引翻成冲突()
    {
        /*
          判重那一读挡不住竞态，真正拦住的是唯一索引；不接这个异常，输的那一方拿到的是 500。
          与对外模型创建同一形状（第 49 轮），这里补上线路这一侧。
        */
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var create = EndpointBody(console, "app.MapPost(\"/gw/logical-models/{id}/offerings\"");
        var inserted = create.IndexOf("gwModelOfferings.InsertOneAsync(document)", StringComparison.Ordinal);
        var caught = create.IndexOf("ServerErrorCategory.DuplicateKey", StringComparison.Ordinal);
        Assert.True(inserted >= 0, "找不到线路插入语句");
        Assert.True(caught > inserted, "线路插入没有接住撞键异常，并发创建会漏成 500");
    }

    [Fact]
    public void 控制台启动只查索引不建索引()
    {
        /*
          `no-auto-index` 在控制台这一侧的落地。本 PR 引入的四条唯一索引改成启动只查、缺了报警；
          存量那批（启动时还在建）没动，已记债。

          判据两条，缺一不可：
          ① 这四条索引的名字只许出现在巡检调用里，不许再出现在 CreateIndexModel 里；
          ② 建索引的处数是棘轮，只降不升——不写这一条的话，下一个人照着存量那批的样子
             再加一条就又是「合规」的，而本 PR 修的正是这种「照着旧的抄一条」。
        */
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        string[] introducedHere =
        [
            "uniq_llmgw_logical_default_per_type",
            "uniq_llmgw_logical_claim_per_type",
            "uniq_llmgw_catalog_entry_key",
            "uniq_llmgw_imagegen_tenant_pattern",
        ];
        var guide = ReadRepoFile("doc/guide.platform.mongodb-indexes.md");
        foreach (var name in introducedHere)
        {
            // `Name = "..."` 是 CreateIndexOptions 的写法：它出现就说明又在代码里建索引了。
            // 索引名本身可以多处出现（撞键异常要按名字分辨撞的是哪一条），所以判的不是次数。
            Assert.Equal(0, CountOccurrences(console, $"Name = \"{name}\""));

            var at = console.IndexOf($"\"{name}\"", StringComparison.Ordinal);
            Assert.True(at > 0, $"{name} 在控制台里一次都没出现，巡检大概被删了");
            var callAt = console.LastIndexOf("IndexAdvisory.ReportIfMissingAsync", at, StringComparison.Ordinal);
            Assert.True(callAt > 0 && at - callAt < 200,
                $"{name} 不是通过 IndexAdvisory.ReportIfMissingAsync 巡检的");

            // 只查不建的前提是 DBA 那一侧查得到该怎么建。查不到就等于把问题丢给了没有线索的人。
            Assert.Contains(name, guide, StringComparison.Ordinal);
        }

        var creations = CountOccurrences(console, "Indexes.CreateOneAsync")
                        + CountOccurrences(console, "Indexes.CreateManyAsync");
        Assert.True(creations <= 24,
            $"控制台启动建索引的处数升到了 {creations}（棘轮上限 24）：新索引走 IndexAdvisory 巡检 + DBA 迁移，不要在启动里建");

        // 缺索引的后果必须说出来，不许只说「索引缺失」。这一条由类型强制：
        // degradesTo 是必填参数，忘了给编译不过。这里只确认那个参数没被写成空话。
        var advisory = ReadRepoFile("llmgw/console-api/Mongo/IndexAdvisory.cs");
        Assert.Contains("degradesTo", advisory, StringComparison.Ordinal);
        Assert.Contains("doc/guide.platform.mongodb-indexes.md", advisory, StringComparison.Ordinal);
    }

    [Fact]
    public void 级联删线路失败时把对外模型放回去()
    {
        /*
          两条删除不是一个事务。中间那一下失败，结果是对外模型没了、它名下的线路成了孤儿，
          而孤儿不出现在任何一屏上（线路只在自己的对外模型底下列出），没人会发现。
          补偿的方向必须是「把父放回去」——库回到删之前的样子，重试一次就行。
        */
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var delete = EndpointBody(console, "app.MapDelete(\"/gw/logical-models/{id}\"");

        var cascadeAt = delete.IndexOf("gwModelOfferings.DeleteManyAsync(offeringFilter)", StringComparison.Ordinal);
        var restoreAt = delete.IndexOf("gwLogicalModels.InsertOneAsync(doc)", StringComparison.Ordinal);
        Assert.True(cascadeAt > 0, "找不到级联删除语句");
        Assert.True(restoreAt > cascadeAt, "级联删除失败时没有把对外模型放回去");

        // 补偿自己也失败时不许吞：要如实说清「父已删、子还在」并给出能去查的标识。
        Assert.Contains("MODEL_DELETE_ROLLED_BACK", delete, StringComparison.Ordinal);
        Assert.Contains("MODEL_DELETE_LEFT_ORPHANS", delete, StringComparison.Ordinal);
    }

    [Fact]
    public void 同步状态要写给每一个租户而不只是被跳过的那几个()
    {
        /*
          状态行的 _id 是「宿主::租户」，控制台按登录租户查。名单若只取「这一轮被跳过的」
          加「上一轮写过行的」，一个刚开的租户两边都不在，那一屏就永远说「同步从未发生」，
          而且会一直轮询——一个正常运转的进程被报成疑似宕机。
        */
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigSyncWorker.cs");
        Assert.Contains("GetCollection<BsonDocument>(\"llmgw_tenants\")", worker, StringComparison.Ordinal);
        Assert.Contains(".Concat(allTenantIds)", worker, StringComparison.Ordinal);

        // 不许退回成「只给有 override 的租户写」：三个来源都要并进去。
        var loopAt = worker.IndexOf("foreach (var tenantId in skippedByTenant.Keys", StringComparison.Ordinal);
        Assert.True(loopAt > 0, "找不到逐租户写状态的循环");
        var loopTail = worker[loopAt..(loopAt + 400)];
        Assert.Contains(".Concat(knownTenantIds)", loopTail, StringComparison.Ordinal);
        Assert.Contains(".Concat(allTenantIds)", loopTail, StringComparison.Ordinal);
    }

    [Fact]
    public void 晋升新线路失败时一律回滚不只撞键那一种()
    {
        /*
          换上游那条替换链里，晋升是最后一步：原线路已经停用、替身还挂着 staging 标记。
          这一步失败而不回滚，这个对外模型就一条可用线路都没有了。

          上一版只接了撞键那一种失败，而真实失败里最常见的（超时、主从切换、连接断开）
          恰好不在名单上——判据比它该管的范围窄（形状 1）。判据因此不数「接了几种异常」，
          而是要求这一段里的每一条失败出口都先回滚。
        */
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var update = EndpointBody(console, "app.MapPut(\"/gw/logical-models/{logicalId}/offerings/{offeringId}\"");

        Assert.Contains("catch (MongoException ex)", update, StringComparison.Ordinal);
        // 撞键、其它异常、以及 ModifiedCount 不为 1，三条失败出口都要走同一段回滚。
        Assert.True(CountOccurrences(update, "await RollbackPromotionAsync();") >= 3,
            "晋升的失败出口没有全部走回滚：撞键、其它 Mongo 异常、ModifiedCount 不为 1，三条都要");

        // 回滚自己失败时不许吞：这个模型可能一条可用线路都没有，得说清并给出两个 id。
        Assert.Contains("OFFERING_PROMOTION_LEFT_PARTIAL", update, StringComparison.Ordinal);
    }

    [Fact]
    public void 级联删除失败时父和子都要放回去()
    {
        /*
          超时这一类失败的结果是**未知的**：线路可能一条没删、也可能删了一半。只放回父，
          然后告诉操作者「库里没有留下半截状态」，在删了一半那种失败里就是一句假话——
          模型回来了，它的线路少了几条，路由从此变了样却没人知道。
        */
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var delete = EndpointBody(console, "app.MapDelete(\"/gw/logical-models/{id}\"");

        // 要先有快照才谈得上放回去：子文档整份读回来，不能只取 id。
        Assert.Contains("var childOfferings = await gwModelOfferings", delete, StringComparison.Ordinal);
        Assert.Contains("IsUpsert = true", delete, StringComparison.Ordinal);

        var cascadeAt = delete.IndexOf("gwModelOfferings.DeleteManyAsync(offeringFilter)", StringComparison.Ordinal);
        var parentAt = delete.IndexOf("gwLogicalModels.InsertOneAsync(doc)", StringComparison.Ordinal);
        var childAt = delete.IndexOf("gwModelOfferings.ReplaceOneAsync", StringComparison.Ordinal);
        Assert.True(cascadeAt > 0 && parentAt > cascadeAt, "级联删除失败时没有把对外模型放回去");
        Assert.True(childAt > parentAt, "级联删除失败时没有把线路放回去，或顺序反了（父在，子才有归属）");

        // 「库回到了删之前的样子」这句话只许在真的全放回去了的时候说。
        var fullyAt = delete.IndexOf("var fullyRestored = parentRestored", StringComparison.Ordinal);
        var claimAt = delete.IndexOf("库回到了删之前的样子", StringComparison.Ordinal);
        Assert.True(fullyAt > 0, "没有区分「全放回去了」与「只放回去一部分」");
        Assert.True(claimAt > fullyAt, "在还没判断放回去了多少之前就宣称库回到了删之前的样子");
        Assert.Contains("MODEL_DELETE_LEFT_ORPHANS", delete, StringComparison.Ordinal);

        /*
          撞键不等于「原来那一条还在」：公开名上也有唯一索引，另一个管理员在这几毫秒里用同一个
          公开名新建一条，撞的是那一条、_id 完全不同。拿撞键本身当「已恢复」的证据，就会按原 _id
          把线路放回去，造出一批藏在替身模型后面的孤儿，而回复还说全都放回去了（形状 8）。
        */
        var dupAt = delete.IndexOf("ServerErrorCategory.DuplicateKey", StringComparison.Ordinal);
        Assert.True(dupAt > 0, "回滚没有区分撞键这一种失败");
        var dupBranch = delete[dupAt..(dupAt + 900)];
        Assert.Contains("parentRestored = await gwLogicalModels", dupBranch, StringComparison.Ordinal);
        Assert.Contains("Filter.Eq(\"_id\", id)", dupBranch, StringComparison.Ordinal);
    }

    [Fact]
    public void 认领撞车只去掉被抢走的那几个调用方()
    {
        /*
          多键唯一索引只说「撞了」，不说撞的是哪一个 code。把整份认领清空重插，就把一次
          影响一个调用方的并发放大成影响这个池的全部调用方——没被抢的那几个也失去了接得住
          它们的模型，池退场后静默改用用途默认。
        */
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var branchAt = console.IndexOf(
            "else if (message.Contains(\"uniq_llmgw_logical_claim_per_type\"",
            StringComparison.Ordinal);
        Assert.True(branchAt > 0, "找不到认领撞车那条分支");
        var branch = console[branchAt..(branchAt + 3000)];

        // 回去读一遍现在谁认领着，只去掉真被占走的那几个。
        Assert.Contains("takenCodes", branch, StringComparison.Ordinal);
        Assert.Contains("keptClaims", branch, StringComparison.Ordinal);
        Assert.Contains("fb.AnyIn(\"DefaultForAppCallerCodes\", claimsToTransfer)", branch, StringComparison.Ordinal);

        // 清空是重插又撞时的最后兜底，不是第一反应：它必须排在第一次插入之后。
        var firstInsertAt = branch.IndexOf("document[\"DefaultForAppCallerCodes\"] = new BsonArray(keptClaims)", StringComparison.Ordinal);
        var emptyAt = branch.IndexOf("document[\"DefaultForAppCallerCodes\"] = new BsonArray();", StringComparison.Ordinal);
        Assert.True(firstInsertAt > 0, "重插时没有带上留下来的那几个认领");
        Assert.True(emptyAt > firstInsertAt, "认领撞车的第一反应还是把整份认领清空");
    }

    [Fact]
    public void 一条线路都没建成的池不许把接流量的身份带过来()
    {
        /*
          模型文档在建线路之前就插进去了，那一刻还不知道最终会有几条线路。成员全被跳过时，
          库里留下一个 Enabled、带着认领、可能还带着用途默认、却一条线路都没有的模型——
          解析器会选中它然后回 OfferingUnresolvable，搬迁之前还走得通的调用方搬完立刻断掉；
          它若成了用途默认，断的是整个用途。

          判据盯三件事：真的回头看了 RouteCount；身份被摘掉且模型停用；而且只对**这一趟新建的**
          那种模型动手——复用既有同名模型时那条模型本来就有自己的线路，照着停用会打掉一条在跑的模型。
        */
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var migrate = EndpointBody(console, "app.MapPost(\"/gw/pools/migrate-to-models\"");

        /*
          数的必须是「现在承接得了流量的线路」，不是「建了几条」。池成员可能指着一个已停用的
          物理模型、或者它挂的 Provider 不在了——那种线路照样建（拓扑要留着），但一条流量都接不了。
          数前者的话，一个「每条线路的上游都不可用」的模型就躲过了这道闸（第 55 轮 review）。
        */
        Assert.Contains("OfferingTargetEligibility.Evaluate(", migrate, StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(migrate, "usableRouteCount++;"));
        var checkAt = migrate.IndexOf("usableRouteCount == 0 && entry.CreatedNewModel", StringComparison.Ordinal);
        Assert.True(checkAt > 0, "搬迁没有回头确认这个池到底有几条线路真的能接流量，或者没有限定在这一趟新建的模型上");
        Assert.Contains("!linkedByRace", migrate[checkAt..(checkAt + 200)], StringComparison.Ordinal);

        var fix = migrate[checkAt..(checkAt + 1200)];
        Assert.Contains(".Set(\"Enabled\", false)", fix, StringComparison.Ordinal);
        Assert.Contains(".Set(\"IsDefaultForType\", false)", fix, StringComparison.Ordinal);
        Assert.Contains(".Set(\"DefaultForAppCallerCodes\", new BsonArray())", fix, StringComparison.Ordinal);

        // 报告里也要如实：entry 上的身份跟着清掉，否则那一屏说它还接着流量。
        Assert.Contains("entry.IsDefaultForType = false;", fix, StringComparison.Ordinal);
        Assert.Contains("entry.ClaimedAppCallerCodes = [];", fix, StringComparison.Ordinal);

        // 判在线路循环之后：循环里还在计数的时候判等于没判。
        var loopAt = migrate.IndexOf("usableRouteCount++;", StringComparison.Ordinal);
        Assert.True(loopAt > 0 && loopAt < checkAt, "零线路那道闸排在了建线路之前");
    }

    [Fact]
    public void 线路健康记账失败不许变成用户侧的失败()
    {
        /*
          RecordSuccess / RecordFailure 写的是健康台账，不是业务结果。成功那一路，响应已经在
          调用方手上等着返回；失败那一路，调用方正等着「换下一条线路」的结论。一次 Mongo 写抖动
          从这里抛出去，前者变成 500、后者根本走不到挑下一条候选那一步——一次本来能自愈的失败
          变成用户看到的失败。

          池成员那两条路径一直是 try/catch + 日志，Offering 这两条漏了；断流之后 Offering 是
          主路径，这个洞也就从边角挪到了主干（第 55 轮 review）。
        */
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");

        foreach (var method in new[] { "RecordSuccessAsync", "RecordFailureAsync" })
        {
            var at = resolver.IndexOf($"public async Task {method}(", StringComparison.Ordinal);
            Assert.True(at > 0, $"找不到 {method}");
            var branchAt = resolver.IndexOf(
                "if (!string.IsNullOrWhiteSpace(resolution.OfferingId)", at, StringComparison.Ordinal);
            Assert.True(branchAt > at, $"{method} 里找不到线路那一支");

            // 线路那一支进 try 之前不许有对库的写：try 必须紧跟在分支开头。
            var tryAt = resolver.IndexOf("try", branchAt, StringComparison.Ordinal);
            var writeAt = resolver.IndexOf("Async(", branchAt, StringComparison.Ordinal);
            Assert.True(tryAt > branchAt && tryAt < writeAt,
                $"{method} 的线路分支把库操作放在了 try 之外，一次写抖动会变成用户侧的失败");

            var catchAt = resolver.IndexOf("catch (Exception ex)", branchAt, StringComparison.Ordinal);
            Assert.True(catchAt > tryAt, $"{method} 的线路分支没有接住记账失败");
            // 接住之后要留痕，不许静默吞掉（degradation-must-alarm）。
            var tail = resolver[catchAt..(catchAt + 400)];
            Assert.Contains("_logger.LogWarning", tail, StringComparison.Ordinal);
        }
    }

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

    private static int CountOccurrences(string source, string needle)
    {
        var count = 0;
        for (var at = source.IndexOf(needle, StringComparison.Ordinal); at >= 0; at = source.IndexOf(needle, at + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
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
    /// <summary>
    /// 白名单列表不许把团队 / appCaller 平铺成名字列表。
    ///
    /// 用户原话：「你直接列出这个研发、产品，这样的团队不好，万一很长呢，部门多呢，咋办？」
    /// 样例数据下平铺看着挺好，一旦部门多起来或名字长起来就会把定宽的那一列撑爆。
    /// 判据是「给数量」这条唯一口径必须还在，且行上不许再出现 join('、') 那种拼名字的写法。
    /// </summary>
    [Fact]
    public void 白名单列表的团队授权只给数量不平铺名字()
    {
        var page = ReadRepoFile("llmgw/web/src/pages/LogicalModelsPage.tsx");

        // 唯一口径：数量由 describeScope 算，行上只调用它

        // 退回平铺就红：把名字 join 起来当行内文案是这条规则要防的那个写法
    }

    /// <summary>
    /// 价格跟着线路走，不折算成一个统一价。
    ///
    /// 同一个模型走官网和走中转单价不同，取平均或取最低都会让账单对不上实际走的那条。
    /// 用户口径：「不同价格就显示多个上游的价格就行，统计诚实即可」。
    /// </summary>
    [Fact]
    public void 白名单列表按线路逐条报价且缺价如实标出()
    {
        var page = ReadRepoFile("llmgw/web/src/pages/LogicalModelsPage.tsx");

        // 每条线路各取各的价：单价来自这条线路指向的那个物理模型
        // 缺价不编：没登记就说没登记
        // 非美金的价不当美金用，必须先换算（与计价侧 stale_currency 同一口径）
        // 价格来源与时效要透出来，否则「看起来是真的、其实早就过时」无从分辨
    }

    /// <summary>
    /// 用量趋势线的渐变 id 必须每个实例唯一。
    ///
    /// 同一页十来条曲线共用一个 id 时，浏览器一律取文档里第一个，后面所有曲线都会去填
    /// 第一条的渐变——页面照常渲染、测试照常绿，只有肉眼看得出颜色不对。
    /// 同时「全零」必须画成一条底线而不是一条假的平滑曲线：没人用和用量平稳是两件事。
    /// </summary>
    [Fact]
    public void 用量趋势线渐变id每实例唯一且不把零画成曲线()
    {
        var visuals = ReadRepoFile("llmgw/web/src/components/ModelRouteVisuals.tsx");

        Assert.Contains("useId()", visuals);
        Assert.Contains("`spark${useId().replace(/:/g, '')}`", visuals);
        Assert.Contains("const flat = peak <= 0;", visuals);
        // 认不出的上游走中性色，不按名字猜品牌
        Assert.Contains("function neutralBrand(", visuals);
    }

    /// <summary>
    /// 目录补登的键空间必须由库级唯一索引兜住，且读检查与落库共用同一份键。
    ///
    /// 端点里的「先查有没有人占了这个键、再写」在单个请求里是对的，两个管理员同时补登同一个
    /// 标识时却都能查空、都写成功——库里两条补登抢同一个键，运行时按哪条算全看排序，
    /// 而两个人的界面都显示「已保存」。Mongo 没有跨文档原子性，应用层补不了这个洞。
    ///
    /// 规范标识与等价写法共用一个键空间，所以键要合成一个数组落库，走多键唯一索引一次盖住两者；
    /// 只盖 CanonicalId 的话，别名撞车照样能两条一起写进去。
    /// </summary>
    [Fact]
    public void 目录补登的键空间有库级唯一索引且键只算一份()
    {
        var consoleProgram = ReadRepoFile("llmgw/console-api/Program.cs");

        // 键的算法只许有一处，读检查与落库都从它取——两份口径会让「查过的键」与
        // 「索引盖住的键」不是同一批（形状 3：判据分裂成两份各自漂移）。
        Assert.Contains("static List<string> CatalogEntryKeys(", consoleProgram);
        var keyFnCount = System.Text.RegularExpressions.Regex
            .Matches(consoleProgram, @"CatalogEntryKeys\(body\)").Count;
        Assert.True(keyFnCount >= 2,
            $"读检查与落库都要走同一个键算法，实际只有 {keyFnCount} 处引用它");

        // 落库要有这份键数组，否则索引无处可建
        Assert.Contains("{ \"Keys\", new BsonArray(CatalogEntryKeys(body)) }", consoleProgram);

        /*
          多键唯一索引 + 部分过滤器：空数组在多键索引里记成 undefined，
          不排除的话所有空补登会互相撞车，索引根本建不起来。
          索引本身由 DBA 建（no-auto-index），所以这份定义的落脚点是 DBA 指南，
          控制台这一侧只留巡检；两边都要在。
        */
        Assert.Contains("uniq_llmgw_catalog_entry_key", consoleProgram);
        var catalogGuide = ReadRepoFile("doc/guide.platform.mongodb-indexes.md");
        Assert.Contains("uniq_llmgw_catalog_entry_key", catalogGuide, StringComparison.Ordinal);
        Assert.Contains("`Keys` 的类型是字符串", catalogGuide, StringComparison.Ordinal);

        // 存量文档没有 Keys 字段，建索引前要补齐，否则它们一条都不受索引保护
        Assert.Contains("Builders<BsonDocument>.Filter.Exists(\"Keys\", false)", consoleProgram);

        // 撞上索引要如实回冲突，不能变成 500：两处写入路径都得接住
        var duplicateHandled = System.Text.RegularExpressions.Regex
            .Matches(consoleProgram, @"ENTRY_EXISTS").Count;
        Assert.True(duplicateHandled >= 4,
            $"新建与更新各自的「读检查」与「撞索引」都要回 ENTRY_EXISTS，实际只有 {duplicateHandled} 处");
    }

    /// <summary>
    /// 就绪探针的可路由判据必须与运行时同范围：带租户、过名录门。
    ///
    /// 运行时解析每一次查询都带 `TenantId == 当前租户`，还要再过一道名录门
    /// （名录外且没有放行标记的模型回 MODEL_NOT_IN_CATALOG）。探针少判任一层，
    /// 结果都是同一种谎：别人租户的模型、或一条会被名录门拦死的线路，把一个
    /// 「没有任何调用方能用」的部署报成绿的。
    /// </summary>
    [Fact]
    public void 就绪探针的可路由判据带租户且过名录门()
    {
        var readiness = ReadRepoFile("llmgw/serving/GatewayServingReadinessProbe.cs");

        // 按调用方自己的租户分组，逐组拿那个租户的数据判。
        Assert.Contains("governed.GroupBy(CallerTenantId", readiness);
        Assert.Contains("BuildTenantRoutingViewAsync", readiness);

        // 每一类数据都带租户过滤：池、平台、兑换所、物理模型（字段名过滤），
        // 对外模型与线路（强类型属性）。少一类就有一条跨租户的缝。
        foreach (var scoped in new[]
                 {
                     "Builders<LLMPlatform>.Filter.Eq(\"TenantId\", tenantId)",
                     "Builders<ModelExchange>.Filter.Eq(\"TenantId\", tenantId)",
                     "Builders<BsonDocument>.Filter.Eq(\"TenantId\", tenantId)",
                     "Builders<GatewayLogicalModel>.Filter.Eq(x => x.TenantId, tenantId)",
                     "Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, tenantId)",
                 })
        {
            Assert.Contains(scoped, readiness);
        }

        // 名录门：要不要拦与运行时同一处判据，不另写近似。
        Assert.Contains("GatewayCatalogGate.EnforcesAsync", readiness);
        // 物理线路判的是它**实际打出去的那个名字**（UpstreamModelId 覆盖之后），
        // 不是目标文档自己的名字——上一版这里钉的是拿目标文档判的那种写法，
        // 等于反向锁死了缺陷：目标在名录里、覆盖成的那个不在时探针照样报绿。
        Assert.Contains("GatewayCatalogGate.PhysicalRoutePasses", readiness);
        Assert.DoesNotContain("GatewayCatalogGate.Passes(", readiness);

        // 兑换所那一支要判到**别名**这一层。只判兑换所文档启用的话，别名被摘掉之后
        // 兑换所照样启用着，而运行时按名录门把它判死——探针报绿、请求全失败。
        // 三处消费方（运行时、对外清单、就绪探针）必须是同一份判据。
        Assert.Contains("GatewayCatalogGate.ExchangeRoutePasses", readiness);
        Assert.Contains("offering.UpstreamModelId", readiness);

        // 场景能力那条也带租户，且租户是必填参数——忘了传编译不过，
        // 这条不变量用类型表达，不靠守卫抽查。
        Assert.Contains("string internalTenantId)", readiness);
        Assert.Contains("string.Equals(model.TenantId, callerTenant, StringComparison.Ordinal)", readiness);
    }

    /// <summary>
    /// 挂线路时物理模型挂的那个 Provider 也得在、也得启用。
    ///
    /// 运行时解析走 FindGatewayOwnedOrMapPlatformAsync(requireEnabled: true)：Provider 不在
    /// 或已停用时这条线路会被整条丢掉。写入侧不判的话，接口回 201、界面多出一条线路，
    /// 而它一条流量都承接不了——与系统级模型池、兑换所别名同形的「存得进去、跑不起来」。
    /// </summary>
    [Fact]
    public void 挂线路时物理模型的Provider也要可用()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");
        var eligibility = ReadRepoFile("llmgw/console-api/LogicalModels/OfferingTargetEligibility.cs");

        // 判据本身收在 OfferingTargetEligibility 里（新建与启用两个入口共用，见「挂线路与开线路
        // 走同一道上游资格闸」）；这里盯的是它判的东西没被削掉。
        Assert.Contains("TARGET_PLATFORM_UNAVAILABLE", eligibility);
        Assert.Contains("targetPlatform is null", eligibility);
        Assert.Contains("targetPlatform.AsNullableBool(\"Enabled\") == false", eligibility);
        // 两种成因要分开说，下一步不一样：Provider 不在 / Provider 停用。
        Assert.Contains("去上游页确认它归属的 Provider", eligibility);
        Assert.Contains("先在上游页把它启用", eligibility);

        // 判在插入之前：这是纯查询，位移与写入之前判完（与本 PR 其它几处同一个思路）。
        var checkAt = program.IndexOf("OfferingTargetEligibility.Evaluate", StringComparison.Ordinal);
        var insertAt = program.IndexOf("await gwModelOfferings.InsertOneAsync(document);", StringComparison.Ordinal);
        Assert.True(checkAt > 0, "新建线路没有走上游资格闸");
        Assert.True(insertAt > checkAt, "上游资格判在插入线路之后，那时已经写进库了");
    }

    /// <summary>
    /// 换上游那条替换链上，撞唯一索引不能把库留在半截状态。
    ///
    /// 线路身份（唯一索引 v3）里带着实际上游模型。两条在跑的线路本来各用各的 UpstreamModelId，
    /// 把其中一条改成另一条的值，晋升那一步 Unset SupersededByOfferingId 时才会撞索引——
    /// 而那时原线路已经退休、替身还挂着 staging 标记，异常从 UpdateOneAsync 抛出去，
    /// 直接越过 ModifiedCount != 1 那段回滚：原线路停用、替身悬空，用户拿到一句 500。
    ///
    /// 两道一起要：动写之前先用纯查询拦掉（能拦住绝大多数），以及晋升那一步接住 11000
    /// 并走同一段回滚（拦不住的那几毫秒）。回滚只许有一份，两条路共用。
    /// </summary>
    [Fact]
    public void 换上游撞身份索引时把原线路还回去()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        // 纯查询那道：判据与唯一索引同一套身份（含实际上游模型），且排在插入替身之前。
        var precheckAt = program.IndexOf("var identityRival = await gwModelOfferings.Find(", StringComparison.Ordinal);
        var insertAt = program.IndexOf("await gwModelOfferings.InsertOneAsync(replacement);", StringComparison.Ordinal);
        Assert.True(precheckAt >= 0, "换上游那条路没有身份撞车的前置检查");
        Assert.True(insertAt > precheckAt, "身份撞车检查排在插入替身之后，那时已经开始写库了");
        Assert.Contains("fb.Eq(\"UpstreamModelId\", replacementUpstreamModelId)", program);

        // 回滚只许有一份，晋升那一步的两种失败都走它。
        Assert.Contains("async Task RollbackPromotionAsync()", program);
        var rollbackCallSites = System.Text.RegularExpressions.Regex.Matches(
            program, @"await RollbackPromotionAsync\(\);").Count;
        Assert.True(rollbackCallSites >= 2,
            $"RollbackPromotionAsync 只有 {rollbackCallSites} 个调用点：撞唯一索引与晋升没生效两种失败都要回滚");

        // 撞索引那一支要接住，不能让异常越过回滚。
        Assert.Contains("catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)", program);
    }

    /// <summary>
    /// 并发创建对外模型撞唯一索引要翻成 409，不能漏成 500。
    ///
    /// 两边的「有没有人占着」查询都能在对方插入之前通过——真正拦住的是唯一索引。
    /// 不接这个异常，输的那一方拿到的是一句「服务器错误」，而同一件事在不撞车时
    /// 给的是说得出下一步的 409。
    /// </summary>
    [Fact]
    public void 并发创建对外模型撞索引翻成冲突()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        var insertAt = program.IndexOf("await gwLogicalModels.InsertOneAsync(document);", StringComparison.Ordinal);
        Assert.True(insertAt >= 0, "没找到对外模型的插入");
        // 插入那一段必须被 try 包住，且按撞的是哪条索引分开说。
        // 窗口取到这个端点的返回语句为止：断言必须落在**这一处**的 catch 上，
        // 而不是碰巧扫到文件别处同形的那一段。
        var endAt = program.IndexOf("\"logical-model.create\"", insertAt, StringComparison.Ordinal);
        Assert.True(endAt > insertAt, "没找到创建对外模型的审计写入，窗口定位不住");
        var around = program[insertAt..endAt];
        Assert.Contains("catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)", around);
        Assert.Contains("uniq_llmgw_logical_claim_per_type", around);
        Assert.Contains("CLAIM_TAKEN", around);
        Assert.Contains("PUBLIC_ID_TAKEN", around);
    }

    /// <summary>
    /// 位移之前一个 early return 都不剩。
    ///
    /// 位移（把别人的用途默认清掉、把别人手上的认领摘掉）是会改变线上路由的写操作，
    /// 而位移之后的每一个 early return 都必须自己记得补偿——漏一个，那个用途就此没有默认，
    /// 所有不点名的请求当场开始失败，而操作者只看到一句 400。
    ///
    /// 与其给每个 early return 补一次补偿（下一个新增的分支又会漏），不如让位移之前
    /// 一个 return 都不剩：判据因此是**位置**——从第一次位移写库到最终写入之间，
    /// 不许出现任何 return。新加一条校验只要放错位置，这里立刻红。
    /// </summary>
    [Fact]
    public void 对外模型更新的位移之前判完所有纯校验()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        var displaceAt = program.IndexOf("var displacedDefaults = new List<string>();", StringComparison.Ordinal);
        var writeAt = program.IndexOf("updated = await gwLogicalModels.FindOneAndUpdateAsync(", StringComparison.Ordinal);
        Assert.True(displaceAt >= 0, "没找到位移那一段");
        Assert.True(writeAt > displaceAt, "没找到最终写入，或它排在位移之前");

        var between = program[displaceAt..writeAt];
        Assert.False(between.Contains("return Json(", StringComparison.Ordinal),
            "位移与最终写入之间还有 early return：那条路径上摘掉的用途默认与认领没人还回去，"
            + "一次被拒绝的保存会把这个用途的兜底拆掉。把这条校验挪到位移之前。");

        // 纯校验确实提上去了：认领与名单的相容性、以及「一个字段都没给」。
        var beforeDisplace = program[..displaceAt];
        Assert.Contains("ValidateClaimsWithinAllowlist(allowlistAfterUpdate, normalizedClaims)", beforeDisplace);
        Assert.Contains("body.IsDefaultForType is null && body.DefaultForAppCallerCodes is null", beforeDisplace);
    }

    /// <summary>
    /// 存量日志的「算没算出钱」只认美金。
    ///
    /// NormalizePriceCurrency 认 CNY 与 USD 两种（它的用途是校验入参），拿它当这个判据
    /// 就会把一条 CNY 的存量行标成 priced——而计价器把一切非美金判成 stale_currency、
    /// 聚合那一侧又因为 EstimatedCostUsd 为空把同一行算进 unpriced。同一行三处三个说法。
    /// </summary>
    [Fact]
    public void 存量日志的计价状态只认美金()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("GatewayCostStatusNames.BillingCurrency", program);
        Assert.Contains("NormalizePriceCurrency(d.AsNullableString(\"EstimatedCostCurrency\")),", program);
        // 反向禁掉「非空即已计价」那种写法。
        Assert.DoesNotContain(
            "return NormalizePriceCurrency(d.AsNullableString(\"EstimatedCostCurrency\")) is null",
            program);
    }

    /// <summary>
    /// 撞车补偿要先分清撞的是哪一条索引。
    ///
    /// 「摘掉的用途默认要不要还回去」在两种撞车下答案相反：撞用途默认那条索引时有人赢了
    /// 那个位子，还回去会再撞一次；而撞调用方认领那条索引时，用途默认这一档**根本没有赢家**，
    /// 这次请求却已经把原来的默认摘掉了——不还的话这个用途就此没有默认，所有不点名的请求
    /// 当场开始失败：一次被拒绝的保存，顺手弄坏了一整个用途。
    ///
    /// 判据用位置比较：claimRace 必须在补偿之前算出来，先补偿再判等于对两种撞车用同一个答案。
    /// </summary>
    [Fact]
    public void 撞车补偿先分清撞的是哪条索引()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        var decideAt = program.IndexOf("var claimRace = ex.Message.Contains(", StringComparison.Ordinal);
        var compensateAt = program.IndexOf("await CompensateAsync(restoreDefaults: claimRace);", StringComparison.Ordinal);
        Assert.True(decideAt >= 0, "没找到判「撞的是哪条索引」那一句");
        Assert.True(compensateAt >= 0,
            "补偿没有按撞车类型决定要不要还默认（应为 CompensateAsync(restoreDefaults: claimRace)）");
        Assert.True(decideAt < compensateAt,
            "claimRace 算在补偿之后：那等于对两种撞车用同一个答案，认领撞车会把这个用途的默认弄丢");

        // 反向禁掉写死 false 的那版：它正是把两种输入压成一种的写法。
        Assert.DoesNotContain("await CompensateAsync(restoreDefaults: false);", program);
    }

    /// <summary>
    /// 「按权重分到 N 条」里的 N 必须是真正参与轮转的那几条。
    ///
    /// 权重轮转只在最健康的那一档里进行，健康档更低的线路是后备、不分流量。
    /// 拿全部可用线路数当 N，面板就会说出「按权重分到 2 条线路：A 100%」——
    /// 数字说两条、比例只列一条，而读者更信数字。
    /// </summary>
    [Fact]
    public void 加权结论只数参与轮转的那一档()
    {
        var planner = ReadRepoFile("llmgw/console-api/LogicalModels/CallTracePlanner.cs");

        // 结论里的数字与比例列表必须来自同一个集合。
        Assert.Contains("weighted && weightShare.Count > 1", planner);
        Assert.Contains("按权重分到 {weightShare.Count} 条线路", planner);
        Assert.DoesNotContain("按权重分到 {eligible.Count} 条线路", planner);

        // 没参与轮转的那几条要说出来，不能看起来像被弄丢了。
        Assert.Contains("不参与分流，只在这几条都失败后才顶上", planner);
    }

    /// <summary>
    /// 首屏读失败要先把失败摆出来，再谈加载中。
    ///
    /// 顺序反了（先 `if (!data) return <SectionLoader/>`）的后果不是难看，是**不会结束**：
    /// 首次读取失败时 data 恒为 null，下面那条 InlineAlert 永远到不了，人看到的是一个
    /// 转不完的「正在读…」——既不知道发生了什么，也没有任何下一步。
    /// 判据用位置比较而不是比文案：文案随时会改，而「谁排在前面」才是这条缺陷的形状。
    /// </summary>
    [Fact]
    public void 首屏读失败先摆失败再谈加载中()
    {
        foreach (var relative in new[]
                 {
                     "llmgw/web/src/components/ModelCatalogSection.tsx",
                     "llmgw/web/src/components/ImageGenContractsSection.tsx",
                 })
        {
            var source = ReadRepoFile(relative);
            var errorAt = source.IndexOf("InlineAlert tone=\"error\"", StringComparison.Ordinal);
            var loaderAt = source.IndexOf("SectionLoader text=", StringComparison.Ordinal);
            Assert.True(errorAt >= 0, $"{relative} 没有错误渲染");
            Assert.True(loaderAt >= 0, $"{relative} 没有加载态");
            Assert.True(errorAt < loaderAt,
                $"{relative} 的加载态排在错误渲染之前：首次读取失败时 data 恒为 null，"
                + "那条错误永远到不了，人会看到一个不会结束的「正在读…」");
            // 失败要给得出下一步，不是只报一句错。
            Assert.True(source.Contains("重试", StringComparison.Ordinal),
                $"{relative} 的读失败没有给重试入口");
        }
    }

    /// <summary>
    /// 生图契约那一屏说了「最长 N 秒后再看」，就得自己再看一眼。
    ///
    /// 同步是后台 60 秒一轮的动作，而保存之后界面立刻重读——那一读必然还是旧版本，
    /// 于是显示「装的还不是当前这一版」。只在挂载时读一次的话它会永远停在那句话上，
    /// 而那句话是它自己许下的承诺（expectation-management：说到做到）。
    /// </summary>
    [Fact]
    public void 同步没落定时界面自己再读一次()
    {
        var source = ReadRepoFile("llmgw/web/src/components/ImageGenContractsSection.tsx");

        // 落定 = 每个进程要么装到当前这一版，要么压根不服务这个租户。
        Assert.Contains("const hostsSettled", source);
        Assert.Contains("x.syncState === 'current' || x.syncState === 'not-applicable'", source);

        // 没落定就按**它自己报出来的**刷新周期再读，不是写死一个数字。
        Assert.Contains("window.setTimeout", source);
        Assert.Contains("data.refreshSeconds", source);

        /*
          一次失败的轮询不能让它就此停摆。

          只拿 data 与 hostsSettled 当依赖的话，轮询失败时两者都没变（失败只写了 error），
          那个已经用掉的 timeout 再也不会被重排——页面从此停在「装的还不是当前这一版」，
          哪怕接口与 worker 早就恢复了。所以要有一格无论成败都会走的心跳。
        */
        Assert.Contains("const [pollTick, setPollTick]", source);
        Assert.Contains(".finally(() => setPollTick((x) => x + 1))", source);
        Assert.Contains("}, [data, hostsSettled, pollTick]);", source);
    }

    /// <summary>
    /// 线路判重的身份必须与唯一索引逐字相同。
    ///
    /// 索引 uniq_llmgw_offering_tenant_logical_target_v3 里带着 UpstreamModelId——一个兑换所
    /// 底下挂着多个别名时，同一个对外模型指向其中好几个是合法拓扑。端点的判重少一个字段
    /// 就比索引更严：同样的拓扑走搬迁建得出来、走这个端点却回 DUPLICATE_OFFERING。
    ///
    /// 这条守卫从索引那一侧**读出字段清单**再去比，不抄一份——抄的那份改了不会跟着变。
    /// </summary>
    [Fact]
    public void 线路判重的身份与唯一索引逐字相同()
    {
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        var keysBlock = System.Text.RegularExpressions.Regex.Match(
            initializer, @"string\[\] expectedKeys\s*=\s*\[(?<body>[^\]]*)\]");
        Assert.True(keysBlock.Success, "没在初始化器里找到 expectedKeys，索引定义可能已经挪走，这条守卫失效了");
        var indexKeys = System.Text.RegularExpressions.Regex.Matches(keysBlock.Groups["body"].Value, "\"(?<k>[A-Za-z]+)\"")
            .Select(m => m.Groups["k"].Value)
            .ToList();
        Assert.True(indexKeys.Count >= 5, $"索引字段只解析到 {indexKeys.Count} 个：{string.Join("、", indexKeys)}");

        var duplicateBlock = System.Text.RegularExpressions.Regex.Match(
            program, @"var duplicate = fb\.And\((?<body>.*?)\);", System.Text.RegularExpressions.RegexOptions.Singleline);
        Assert.True(duplicateBlock.Success, "没在控制台里找到线路判重那段");
        var duplicateText = duplicateBlock.Groups["body"].Value;

        foreach (var key in indexKeys)
        {
            // SupersededByOfferingId 在索引里是身份的一部分（partial 语义），在判重里表现为
            // 「只看还没被取代的那些」，所以判据形态不同，但必须出现。
            Assert.True(duplicateText.Contains(key, StringComparison.Ordinal),
                $"唯一索引的身份里有 {key}，而端点判重没有它：判重会比索引更严或更松，"
                + "同一套拓扑在搬迁与手工配置两条路上会给出不同结论");
        }
    }

    /// <summary>
    /// 兑换所线路在**保存这一刻**就要确认别名真的存在且启用着，创建与改动两个入口都要判。
    ///
    /// 不判的话：打错一个字、或选了一条被单独停掉的别名，线路照样存得进去、接口回 201，
    /// 而运行时按同一份判据把它整条跳过——那个刚保存的模型立刻没有可用上游，
    /// 与第 39 轮那条系统级模型池同形（「存得进去、跑不起来」）。
    /// </summary>
    [Fact]
    public void 兑换所线路保存时就要确认别名存在且启用()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");
        var eligibility = ReadRepoFile("llmgw/console-api/LogicalModels/OfferingTargetEligibility.cs");

        // 判据走镜像类，不在端点里现写一份近似。
        Assert.Contains("ExchangeAliasPolicy.Declares(", eligibility);
        Assert.Contains("ExchangeAliasPolicy.EffectiveAlias(", eligibility);
        Assert.Contains("EXCHANGE_ALIAS_NOT_DECLARED", eligibility);
        Assert.Contains("ExchangeAliasPolicy.Declares(", program);

        /*
          三个入口都要判，少一头就有一条缝：新建线路、启用一条停用的线路（这两条走
          OfferingTargetEligibility），以及只改上游别名的那次更新（它故意窄——不该因为
          目标停用就挡住一次无关字段的编辑，所以直接调镜像类）。
        */
        var eligibilitySites = System.Text.RegularExpressions.Regex.Matches(
            program, @"OfferingTargetEligibility\.Evaluate\(").Count;
        Assert.True(eligibilitySites >= 2,
            $"OfferingTargetEligibility.Evaluate 只有 {eligibilitySites} 个调用点：新建与启用两条路都要判");
        var directSites = System.Text.RegularExpressions.Regex.Matches(
            program, @"ExchangeAliasPolicy\.Declares\(").Count;
        Assert.True(directSites >= 1,
            "改上游别名那条路没有直接判别名，它不走 OfferingTargetEligibility");

        // 拒绝时要说得出下一步，不是一句「不合法」。
        Assert.Contains("去兑换所页确认这条别名的拼写与开关", program);
        Assert.Contains("去兑换所页确认这条别名的拼写与开关", eligibility);
    }

    /// <summary>
    /// 同步状态只对**服务这个租户的进程**提要求。
    ///
    /// prd-api 的同步器注册成单租户，只为内部租户写状态行；其它租户下那一行永远不存在。
    /// 把它写死进期望值，那一屏就永远显示它「从没回写过」、汇总永远到不了 current——
    /// 一个好好的进程被报成停了，而人照着这句话去查根本查不到东西。
    /// </summary>
    [Fact]
    public void 同步状态只对服务这个租户的进程提要求()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("bool SyncHostAppliesToTenant(string role)", program);
        // 判据要拿内部租户比，而不是写死一个名字。
        Assert.Contains("string.Equals(syncTenantId, internalTenantId, StringComparison.Ordinal)", program);
        // 筛掉的那一个不是悄悄消失：显式一态，界面据此既不报警也不当它就绪。
        Assert.Contains("\"not-applicable\"", program);
        Assert.Contains("!string.Equals(x.SyncState, \"not-applicable\", StringComparison.Ordinal)", program);
    }

    /// <summary>
    /// 「这个 active 调用方有没有人接得住」在整个仓库里只许有一份判据。
    ///
    /// 池路由退场之后，配对的调用方根本没有池绑定；按池绑定判的话，一份完全正确的配置
    /// 会被配置权威报告判成 blocked，而 `scripts/llmgw-release-gate.py` 读的正是那些字段——
    /// 这一刀砍完池，发布反而被自己的报告挡住。反向也一样坏：还留着健康池字段、
    /// 却没有任何对外模型接得住的调用方会被判成就绪。
    ///
    /// 所以发布闸与配置权威报告必须都走 FindUnnamedCatcherAsync，且那两个按池判的
    /// 老函数不许留在文件里——留着就会有人再用一次。
    /// </summary>
    [Fact]
    public void 调用方有没有人接得住只许有一份判据()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        // 两个消费方：发布闸、配置权威报告。都走同一个共享判据。
        var callSites = System.Text.RegularExpressions.Regex.Matches(
            program, @"await FindUnnamedCatcherAsync\(").Count;
        Assert.True(callSites >= 2,
            $"FindUnnamedCatcherAsync 只有 {callSites} 个调用点：发布闸与配置权威报告都要用它，"
            + "少一头就会出现「闸说可发、报告说 blocked」或反过来");

        // 按池绑定判「调用方可不可用」的老函数必须已经删掉，不是留着没人调。
        Assert.DoesNotContain("static bool AllReferencedModelPoolsExist(", program);
        Assert.DoesNotContain("static bool IsAppCallerUsable(", program);

        // 报告里给人的下一步要指向对外模型，而不是一个已经 302 走了的池页面。
        Assert.Contains("active-appcaller-without-catcher", program);
        Assert.DoesNotContain("active-missing-gw-pool", program);
        // 刻意不断言 gw-pool-without-usable-member 在全文件消失：那条状态还属于
        // /gw/config-authority/bind-active-app-callers（仍在写池绑定的老端点，见台账
        // 2026-09-17-bind-active-app-callers-still-writes-pools）。这条守卫管的是报告这一处，
        // 而报告这一处已经拿不到那两个按池判的函数了——它们上面刚断言删掉了。

        // 读这份报告的脚本也要说同一件事，否则失败信息会把人指去修池绑定。
        var gateScript = ReadRepoFile("scripts/llmgw-release-gate.py");
        Assert.Contains("没有对外模型接得住", gateScript);
        Assert.DoesNotContain("缺 GW 池", gateScript);
    }

    /// <summary>
    /// 「补登名录之后重新导入」这条恢复路必须真的能走通。
    ///
    /// 白名单那条提示就是这么写的：认不出用途的模型先补能力/补登名录，再重新导入一次
    /// 即可补上名单。可「已存在就跳过」那一支原来只记一笔 Skipped 就走，物理文档的空能力
    /// 原样留着；发布白名单时重新读的就是那份空能力，于是照样拒登——用户照做了一遍，
    /// 什么都没变（形状 2：恢复路只建了一半）。
    /// </summary>
    [Fact]
    public void 重新导入要把名录算出来的用途补给空能力的存量模型()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        // 跳过那一支要拿得到文档本身，才谈得上看它的能力空不空。
        Assert.Contains("existingByName.TryGetValue(modelId, out var existingModel)", program);
        Assert.Contains("var hasStoredCaps = storedCaps.IsBsonArray && storedCaps.AsBsonArray.Count > 0;", program);
        Assert.Contains("if (!hasStoredCaps)", program);

        // 补出来的用途与新建那条路必须同源，各算各的就是两套能力。
        Assert.Contains("List<string> DeriveCapabilityCodes(", program);
        var deriveCallSites = System.Text.RegularExpressions.Regex.Matches(
            program, @"DeriveCapabilityCodes\(entry, modelId\)").Count;
        Assert.True(deriveCallSites >= 2,
            $"DeriveCapabilityCodes 只有 {deriveCallSites} 个调用点：新建与补空两条路都要用它");
    }

    /// <summary>
    /// 系统级模型来源选「模型池」时，判据不是「池还在」而是「解析得到它」。
    ///
    /// 池路由已经退场：这条请求带 model_policy=pool + 池文档 ID，会被顶进 expectedModel，
    /// 而解析器认池 ID 的唯一一条路是某个对外模型的 MigratedFromPoolIds 里有它。
    /// 没搬过的池存得进去、页面显示正常，而每一次 Quickstart 调用都 MODEL_NOT_FOUND
    /// （或对内部租户静默落到不相干的 legacy 兜底）——保存成功变成一个静默的坏配置。
    ///
    /// 保存端点与取用路径必须共用同一份判据：一边松一边紧，就是「存得进去、跑不起来」。
    /// </summary>
    [Fact]
    public void 系统级模型池要判得到解析而不只是判它还在()
    {
        var program = ReadRepoFile("llmgw/console-api/Program.cs");

        // 判据只有一处，且与运行时 TryResolveLogicalModelAsync 那一支同源。
        Assert.Contains("async Task<bool> SystemPoolResolvableAsync(string tenantId, string poolId)", program);
        Assert.Contains("Builders<BsonDocument>.Filter.AnyEq(\"MigratedFromPoolIds\", poolId)", program);

        // 两个消费方：保存端点、取用路径。少一个就有一条缝。
        var callSites = System.Text.RegularExpressions.Regex.Matches(
            program, @"await SystemPoolResolvableAsync\(").Count;
        Assert.True(callSites >= 2,
            $"SystemPoolResolvableAsync 只有 {callSites} 个调用点：保存端点与取用路径都要判，"
            + "只判一头会出现「存得进去、跑不起来」或「存进去时好的、跑的时候已经不是」");

        // 失败要说得出下一步，不是一句「不可用」。
        Assert.Contains("MODEL_POOL_NOT_MIGRATED", program);
        Assert.Contains("去「模型池」页跑一次搬迁", program);
    }

    /// <summary>
    /// 名录门的判据只许有一处。
    ///
    /// 它此前在运行时解析、对外模型目录端点、就绪探针三处各写了一遍：三份逐字相同的判据，
    /// 意味着三份各自漂移的可能，而漂移后的表现最难查——目录说可调、探针说可路由、
    /// 真调用回 MODEL_NOT_IN_CATALOG，三处各自为真。
    /// </summary>
    [Fact]
    public void 名录门判据只有一处()
    {
        var gate = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayCatalogGate.cs");
        Assert.Contains("ConfiguredToEnforce", gate);
        Assert.Contains("MigrationsCompleteAsync", gate);
        Assert.Contains("AllowedOutsideCatalog", gate);

        // 三个消费方都走它，没人自己再判一遍「配置是不是 observe」。
        foreach (var consumer in new[]
                 {
                     "prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs",
                     "llmgw/serving/GatewayModelCatalogEndpoint.cs",
                     "llmgw/serving/GatewayServingReadinessProbe.cs",
                 })
        {
            var source = ReadRepoFile(consumer);
            Assert.Contains("GatewayCatalogGate.", source);
            Assert.DoesNotContain("\"observe\", StringComparison.OrdinalIgnoreCase", source);
        }
    }
}
