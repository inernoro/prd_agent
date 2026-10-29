using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.LlmGatewayHost;

/// <summary>所有业务共用的任务金额闸；合同只取已验证许可，物理预占/结算复用既有账本。</summary>
public sealed class TaskBudgetGateway(
    PrdAgent.Infrastructure.LlmGateway.LlmGateway inner,
    IHttpContextAccessor accessor,
    LlmGatewayDataContext data,
    IGatewayRuntimeGrantCallCounter counter) : PrdAgent.Core.LlmGateway.ILlmGateway
{
    private GatewayTaskPermitRecord? Permit => accessor.HttpContext?.Items[GatewayTaskAdmission.HttpContextPermitKey] as GatewayTaskPermitRecord;
    private bool Bound => !string.IsNullOrWhiteSpace(Permit?.BudgetScopeId);

    private async Task<bool> UsesVerifiedPptContract(string caller, GatewayRequestContext? context, CancellationToken ct)
    {
        if (caller is not (AppCallerRegistry.MdToPptAgent.Generation.Outline
            or AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate or AppCallerRegistry.MdToPptAgent.Generation.Patch)) return false;
        var grant = (accessor.HttpContext?.Items["llmgw.key.authorization"] as GatewayKeyAuthorization)?.RuntimeGrant;
        var scopeId = grant?.BudgetScopeId ?? context?.TaskBudgetScopeId;
        if (scopeId is not { Length: > 0 } || context?.RunId is not { Length: > 0 } run
            || !Permit!.BoundRunIds.Contains(run, StringComparer.Ordinal)) return false;
        var scope = await data.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .Find(x => x.Id == scopeId && x.TenantId == Permit.TenantId && x.UserId == context.UserId
                && x.Status == "active" && x.ExpiresAt > DateTime.UtcNow).FirstOrDefaultAsync(ct);
        return scope?.PptCompletion is not null && scope.TaskPermitId is null
            && (caller == AppCallerRegistry.MdToPptAgent.Generation.Outline
                ? scope.RootOutlineRunId == run
                : grant is not null && grant.TaskPermitId == Permit.Id && grant.RunId == run
                    && grant.PptCompletionId == scope.PptCompletion.Id);
    }

    private async Task<GatewayTaskBudgetPolicy> PolicyAsync(string caller, string? modelType, JsonObject body,
        GatewayRequestContext? context, CancellationToken ct)
    {
        var permit = Permit!;
        if (modelType != ModelTypes.Chat || ContainsUnpricedInput(body))
            throw Denied("GATEWAY_TASK_BUDGET_PRICING_UNSUPPORTED", "此请求包含未登记计价方式的媒体或供应商工具，已停止发送；需要对应的价格合同。");
        if (context?.TaskBudgetScopeId is { Length: > 0 })
            throw Denied("GATEWAY_TASK_BUDGET_CONTRACT_CONFLICT", "此任务已绑定平台金额合同，不能再叠加或替换业务金额合同。");
        var scope = await data.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .Find(x => x.Id == permit.BudgetScopeId && x.TaskPermitId == permit.Id
                && x.TenantId == permit.TenantId && x.UserId == permit.ActorUserId).FirstOrDefaultAsync(ct);
        if (scope is null || !scope.AllowedAppCallerCodes.Contains(caller, StringComparer.OrdinalIgnoreCase))
            throw Denied("GATEWAY_TASK_BUDGET_BINDING_INVALID", "任务金额合同与许可不匹配，已停止发送。");
        return await counter.ResolveTaskPolicyAsync(scope.Id, permit.TenantId, permit.ActorUserId, RunId(context), caller, ct)
            ?? throw Denied("GATEWAY_TASK_BUDGET_INACTIVE", "任务金额合同已关闭或失效，已停止发送。");
    }

    private string RunId(GatewayRequestContext? context) => context?.RunId is { Length: > 0 } run ? run
        : context?.TaskLeaseRunId is { Length: > 0 } leaseRun ? leaseRun : Permit!.Id;
    private GatewayTaskBudgetRequest Reservation(string caller, GatewayRequestContext? context,
        GatewayTaskBudgetPolicy policy, GatewayPhysicalAdmissionContext physical)
        => new(policy.ScopeId, Permit!.TenantId, Permit.ActorUserId, RunId(context), caller, Permit.Id,
            physical.RequestId, physical.RequestBodyUtf8Bytes, physical.EffectiveMaxOutputTokens,
            physical.LogicalModelPublicId, physical.Provider, physical.Model, physical.OfferingId, TaskPermitId: Permit.Id, Protocol: physical.Protocol);

    public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
        => Bound ? SendWithAdmissionAsync(request, (_, _) => Task.FromResult<GatewayResponse?>(null), ct) : inner.SendAsync(request, ct);

    public async Task<GatewayResponse> SendWithAdmissionAsync(GatewayRequest request,
        Func<GatewayPhysicalAdmissionContext, CancellationToken, Task<GatewayResponse?>> admit, CancellationToken ct = default)
    {
        if (!Bound) return await inner.SendWithAdmissionAsync(request, admit, ct);
        GatewayTaskBudgetRequest? reserved = null;
        GatewayTokenUsage? usage = null;
        var outcome = "unknown";
        try
        {
            var policy = await PolicyAsync(request.AppCallerCode, request.ModelType, request.GetEffectiveRequestBody(), request.Context, ct);
            var response = await inner.SendWithAdmissionAsync(Cap(request, policy.MaxOutputTokens), async (physical, token) =>
            {
                if (await admit(physical, token) is { } denied) return denied;
                var attempt = Reservation(request.AppCallerCode, request.Context, policy, physical);
                var decision = await counter.TryReserveTaskAsync(attempt, token);
                if (!decision.Allowed) return GatewayResponse.Fail(decision.ErrorCode, decision.Detail, decision.StatusCode);
                reserved = attempt;
                MarkAdmission(attempt);
                return null;
            }, ct);
            usage = response.TokenUsage;
            outcome = response is GatewaySendRejectedBeforeSend ? GatewayTaskBudgetOutcomes.RejectedBeforeSend
                : response.Success ? "succeeded" : response.ErrorCode ?? "failed-unknown";
            if (response is GatewaySendRejectedBeforeSend) MarkBeforeSend();
            return response;
        }
        catch (TaskExecutionAdmissionException ex) { return GatewayResponse.Fail(ex.Code, ex.Message, ex.StatusCode); }
        finally { if (reserved is not null) await counter.FinalizeTaskAsync(reserved, usage, outcome, CancellationToken.None); }
    }

    public IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest request, CancellationToken ct = default)
        => Bound ? StreamWithAdmissionAsync(request, (_, _) => Task.FromResult<GatewayStreamChunk?>(null), ct) : inner.StreamAsync(request, ct);

    public async IAsyncEnumerable<GatewayStreamChunk> StreamWithAdmissionAsync(GatewayRequest request,
        Func<GatewayPhysicalAdmissionContext, CancellationToken, Task<GatewayStreamChunk?>> admit,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        if (!Bound || await UsesVerifiedPptContract(request.AppCallerCode, request.Context, ct))
        {
            await foreach (var chunk in inner.StreamWithAdmissionAsync(request, admit, ct)) yield return chunk;
            yield break;
        }
        GatewayTaskBudgetPolicy? policy = null;
        GatewayStreamChunk? policyError = null;
        try { policy = await PolicyAsync(request.AppCallerCode, request.ModelType, request.GetEffectiveRequestBody(), request.Context, ct); }
        catch (TaskExecutionAdmissionException ex) { policyError = GatewayStreamChunk.Fail(ex.Message, ex.Code); }
        if (policyError is not null) { MarkBeforeSend(); yield return policyError; yield break; }
        GatewayTaskBudgetRequest? reserved = null;
        GatewayTokenUsage? usage = null;
        var outcome = "unknown";
        try
        {
            await foreach (var chunk in inner.StreamWithAdmissionAsync(Cap(request, policy!.MaxOutputTokens), async (physical, token) =>
            {
                if (await admit(physical, token) is { } denied) return denied;
                var attempt = Reservation(request.AppCallerCode, request.Context, policy, physical);
                var decision = await counter.TryReserveTaskAsync(attempt, token);
                if (!decision.Allowed) { MarkBeforeSend(); return GatewayStreamChunk.Fail(decision.Detail, decision.ErrorCode); }
                reserved = attempt;
                MarkAdmission(attempt);
                return null;
            }, ct))
            {
                if (chunk.Type == GatewayChunkType.Done) { usage = chunk.TokenUsage; outcome = "succeeded"; }
                if (chunk is GatewayStreamRejectedBeforeSend) { outcome = GatewayTaskBudgetOutcomes.RejectedBeforeSend; MarkBeforeSend(); }
                yield return chunk;
            }
        }
        finally { if (reserved is not null) await counter.FinalizeTaskAsync(reserved, usage, outcome, CancellationToken.None); }
    }

    public async Task<GatewayRawResponse> SendNativeResponsesWithResolutionAsync(GatewayRawRequest request,
        GatewayModelResolution resolution, Func<GatewayNativeResponseChunk, CancellationToken, Task> write,
        Func<GatewayNativeAdmissionContext, CancellationToken, Task<GatewayRawResponse?>>? admit = null, CancellationToken ct = default)
    {
        if (!Bound || await UsesVerifiedPptContract(request.AppCallerCode, request.Context, ct))
            return await inner.SendNativeResponsesWithResolutionAsync(request, resolution, write, admit, ct);
        GatewayTaskBudgetRequest? reserved = null;
        GatewayTokenUsage? usage = null;
        var outcome = "unknown";
        try
        {
            var policy = await PolicyAsync(request.AppCallerCode, request.ModelType, request.RequestBody ?? new JsonObject(), request.Context, ct);
            var body = request.RequestBody?.DeepClone().AsObject() ?? new JsonObject();
            body["max_output_tokens"] = Math.Min(ReadCap(body), policy.MaxOutputTokens);
            var capped = CopyRaw(request, body);
            var response = await inner.SendNativeResponsesWithResolutionAsync(capped, resolution, write, async (physical, token) =>
            {
                if (admit is not null && await admit(physical, token) is { } denied) return denied;
                var attempt = Reservation(request.AppCallerCode, request.Context, policy, physical);
                var decision = await counter.TryReserveTaskAsync(attempt, token);
                if (!decision.Allowed) return GatewayRawResponse.Fail(decision.ErrorCode, decision.Detail, decision.StatusCode);
                reserved = attempt;
                MarkAdmission(attempt);
                return null;
            }, ct);
            usage = response.TokenUsage;
            outcome = response is GatewayResponseRejectedBeforeSend ? GatewayTaskBudgetOutcomes.RejectedBeforeSend
                : response.Success ? "succeeded" : response.ErrorCode ?? "failed-unknown";
            if (response is GatewayResponseRejectedBeforeSend) MarkBeforeSend();
            return response;
        }
        catch (TaskExecutionAdmissionException ex) { return GatewayRawResponse.Fail(ex.Code, ex.Message, ex.StatusCode); }
        finally { if (reserved is not null) await counter.FinalizeTaskAsync(reserved, usage, outcome, CancellationToken.None); }
    }

    public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default)
        => Bound ? Task.FromResult(GatewayRawResponse.Fail("GATEWAY_TASK_BUDGET_PRICING_UNSUPPORTED", "此原始或媒体请求尚无物理计价合同，已停止发送", 409))
            : inner.SendRawWithResolutionAsync(request, resolution, ct);
    public Task<GatewayRawResponse> TestUpstreamProfileAsync(GatewayUpstreamProfileTestRequest request, CancellationToken ct = default)
        => Bound ? Task.FromResult(GatewayRawResponse.Fail("GATEWAY_TASK_BUDGET_PRICING_UNSUPPORTED", "任务金额合同不能用于临时供应商配置", 409))
            : inner.TestUpstreamProfileAsync(request, ct);
    public Task<GatewayModelResolution> ResolveModelAsync(string appCallerCode, string modelType, string? expectedModel = null,
        string? pinnedPlatformId = null, string? pinnedModelId = null, CancellationToken ct = default)
        => inner.ResolveModelAsync(appCallerCode, modelType, expectedModel, pinnedPlatformId, pinnedModelId, ct);
    public Task<GatewayModelResolution> ResolveOfferingAsync(string appCallerCode, string modelType, string offeringId, CancellationToken ct = default)
        => inner.ResolveOfferingAsync(appCallerCode, modelType, offeringId, ct);
    public Task<GatewayModelResolution> ResolveRequiredLogicalModelAsync(string appCallerCode, string modelType, string logicalModelPublicId, CancellationToken ct = default)
        => ((PrdAgent.Core.LlmGateway.ILlmGateway)inner).ResolveRequiredLogicalModelAsync(appCallerCode, modelType, logicalModelPublicId, ct);
    public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string appCallerCode, string modelType, CancellationToken ct = default)
        => inner.GetAvailablePoolsAsync(appCallerCode, modelType, ct);
    public ILLMClient CreateClient(string appCallerCode, string modelType, int maxTokens = 4096, double temperature = 0.2,
        bool includeThinking = false, string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null)
        => new GatewayLLMClient(this, appCallerCode, modelType, maxTokens: maxTokens, temperature: temperature,
            includeThinking: includeThinking, expectedModel: expectedModel, pinnedPlatformId: pinnedPlatformId, pinnedModelId: pinnedModelId);

    private void MarkAdmission(GatewayTaskBudgetRequest request)
    {
        if (accessor.HttpContext is { } http)
            http.Items[GatewayInvocationAuthority.TaskBudgetAdmissionKey] = new TaskBudgetSendFact(request.ScopeId, request.TaskPermitId!, request.RequestId);
    }

    private void MarkBeforeSend()
    { if (accessor.HttpContext is { } http) http.Items[GatewayBudgetCoordinator.HttpContextFinalStatusCodeKey] = 403; }
    private static TaskExecutionAdmissionException Denied(string code, string message) => new(code, message, 409);
    private static int ReadCap(JsonObject body) => new[] { "max_tokens", "max_completion_tokens", "max_output_tokens" }
        .Select(name => int.TryParse(body[name]?.ToString(), out var value) && value > 0 ? value : int.MaxValue).Min();
    private static GatewayRequest Cap(GatewayRequest request, int cap)
    {
        var body = request.GetEffectiveRequestBody().DeepClone().AsObject();
        var bounded = Math.Min(ReadCap(body), cap);
        body.Remove("max_completion_tokens"); body.Remove("max_output_tokens"); body["max_tokens"] = bounded;
        return new GatewayRequest { AppCallerCode = request.AppCallerCode, ModelType = request.ModelType,
            ExpectedModel = request.ExpectedModel, PinnedPlatformId = request.PinnedPlatformId, PinnedModelId = request.PinnedModelId,
            RequestBody = body, Stream = request.Stream, IncludeThinking = request.IncludeThinking,
            EnablePromptCache = request.EnablePromptCache, TimeoutSeconds = request.TimeoutSeconds, Context = request.Context };
    }
    private static GatewayRawRequest CopyRaw(GatewayRawRequest request, JsonObject body) => new()
    { AppCallerCode = request.AppCallerCode, ModelType = request.ModelType, EndpointPath = request.EndpointPath,
        HttpMethod = request.HttpMethod, RequestBody = body, TimeoutSeconds = request.TimeoutSeconds, Context = request.Context,
        ExtraHeaders = request.ExtraHeaders, ExpectedModel = request.ExpectedModel,
        PinnedPlatformId = request.PinnedPlatformId, PinnedModelId = request.PinnedModelId,
        RequiredLogicalModelPublicId = request.RequiredLogicalModelPublicId,
        RequiredOfferingId = request.RequiredOfferingId,
        IsMultipart = request.IsMultipart, MultipartFields = request.MultipartFields, MultipartFiles = request.MultipartFiles,
        MultipartFileRefs = request.MultipartFileRefs, ExpectBinaryResponse = request.ExpectBinaryResponse, CanonicalImageRequest = request.CanonicalImageRequest };
    private static bool ContainsUnpricedInput(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            if (new[] { "n", "best_of" }.Any(key => obj[key] is { } count && (!int.TryParse(count.ToString(), out var value) || value != 1))) return true;
            if (obj["tools"] is JsonArray tools && tools.Any(t => t?["type"]?.ToString() != "function")) return true;
            if (obj.Any(p => p.Key is "image_url" or "input_audio" or "audio" or "file_id" or "file_url" or "modalities")) return true;
            if (obj["type"]?.ToString() is "input_image" or "image" or "input_file" or "input_audio" or "audio" or "video") return true;
            return obj.Any(p => ContainsUnpricedInput(p.Value));
        }
        return node is JsonArray list && list.Any(ContainsUnpricedInput);
    }
}
