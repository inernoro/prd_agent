using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.Infrastructure.LlmGateway;

public partial class LlmGateway
{
    public async Task<GatewayRawResponse> SendNativeResponsesWithResolutionAsync(
        GatewayRawRequest request,
        GatewayModelResolution resolution,
        Func<GatewayNativeResponseChunk, CancellationToken, Task> write,
        CancellationToken ct = default)
    {
        if (!TryValidateAppCaller(request.AppCallerCode, request.ModelType, out var callerError))
            return GatewayRawResponse.Fail(InvalidAppCallerErrorCode, callerError, 400);
        if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel)
            || string.IsNullOrWhiteSpace(resolution.ApiKey) || !Uri.TryCreate(resolution.ApiUrl, UriKind.Absolute, out _))
            return GatewayRawResponse.Fail("MODEL_NOT_FOUND", resolution.ErrorMessage ?? "指定模型不可用", 404);
        if (ValidateNativeResponsesBody(request.RequestBody) is { } bodyError) return bodyError;
        if (!string.Equals(request.HttpMethod, "POST", StringComparison.Ordinal)
            || request.EndpointPath != "/v1/responses" || request.IsMultipart || request.ExtraHeaders is { Count: > 0 })
            return GatewayRawResponse.Fail("NATIVE_RESPONSES_REQUEST_INVALID", "原生 Responses 请求形态不受支持", 400);
        if (resolution.IsExchange
            || NormalizeAdapterKey(string.IsNullOrWhiteSpace(resolution.Protocol) ? resolution.PlatformType : resolution.Protocol) != "openai"
            || (!string.IsNullOrWhiteSpace(resolution.OfferingEndpointPath)
                && resolution.OfferingEndpointPath.TrimEnd('/') != "/v1/responses"))
            return GatewayRawResponse.Fail("NATIVE_RESPONSES_PROTOCOL_UNSUPPORTED", "指定上游未提供原生 Responses 协议", 400);
        // PinnedModelId 支持登记记录 Id 或模型名；由唯一一次 resolver 校验，不能与物理模型名再次比较。
        if ((!string.IsNullOrWhiteSpace(request.PinnedPlatformId) && request.PinnedPlatformId != resolution.ActualPlatformId)
            || (!string.IsNullOrWhiteSpace(request.RequiredLogicalModelPublicId)
                && request.RequiredLogicalModelPublicId != resolution.LogicalModelPublicId))
            return GatewayRawResponse.Fail("NATIVE_RESPONSES_TARGET_MISMATCH", "指定模型与解析结果不一致", 409);

        var resolved = RestoreRawResolution(resolution);
        var body = request.RequestBody!.DeepClone().AsObject();
        body["model"] = resolution.ActualModel;
        if (TryBuildRawCapabilityFailure(request, resolved, body, out var capabilityError)) return capabilityError!;
        // Raw 通道原来用于图像等接口；原生 Responses 还必须遵守工具和推理能力门。
        var strict = IsStrictParameterPolicy(request.Context);
        if (RequestHasTools(body) && CapabilityRejected(resolved.SupportsFunctionCalling, strict))
            return GatewayRawResponse.Fail("FUNCTION_CALLING_UNVERIFIED", "指定模型的工具调用能力不可用或未经确认", 400);
        if (body["reasoning"] is not null && CapabilityRejected(resolved.SupportsThinking, strict))
            return GatewayRawResponse.Fail("THINKING_UNVERIFIED", "指定模型的推理能力不可用或未经确认", 400);
        // 只沿用登记的模型技术上限，使用 Responses 自己的字段；不新增执行器消费上限。
        if (resolution.MaxTokens is > 0)
        {
            if (body["max_output_tokens"] is null)
                body["max_output_tokens"] = resolution.MaxTokens.Value;
            else if (TryReadInt(body["max_output_tokens"]!, out var requested) && requested > resolution.MaxTokens.Value)
                body["max_output_tokens"] = resolution.MaxTokens.Value;
        }

        var endpoint = BuildEndpointFromPath(resolution.ApiUrl!, "/v1/responses");
        using var message = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        SetAuthHeader(message, GetDefaultAuthSchemeForResolution(resolved) ?? "Bearer", resolution.ApiKey!);
        ApplyRequiredProviderHeaders(message, resolved);
        ApplyOpenRouterAttribution(message, resolution.ApiUrl, request.AppCallerCode);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(request.TimeoutSeconds));
        var started = DateTime.UtcNow;
        var transport = request.Context?.GatewayTransport ?? GatewayTransports.Inproc;
        var attempts = BuildProviderAttempts(resolution, transport);
        var logId = await StartRawLogAsync(request, resolution, endpoint, body.ToJsonString(), started, CancellationToken.None);
        GatewayProviderConcurrencyLease? lease = null;
        var outcome = GatewayRawResponse.Fail("NATIVE_RESPONSES_OUTCOME_UNKNOWN", "上游响应未完整结束", 502);
        var auditBody = "{}";
        NativeResponsesAuditObserver? observer = null;
        Dictionary<string, string>? responseHeaders = null;
        var reachedProvider = false;
        try
        {
            var admission = await AcquireProviderConcurrencyAsync(request.Context?.TenantId, resolved, request.TimeoutSeconds, deadline.Token);
            if (!admission.Allowed)
            {
                outcome = GatewayRawResponse.Fail(admission.ErrorCode, ProviderAdmissionMessage(admission.ErrorCode), 429);
                return outcome;
            }
            lease = admission.Lease;
            using var client = CreateOutboundClient(request.Context?.TenantId);
            // 本次 deadline 管理完整请求；不使用 HttpClient 的默认 100 秒截断原生长流。
            client.Timeout = Timeout.InfiniteTimeSpan;
            MarkLastSendAttemptReachedProvider(attempts);
            reachedProvider = true;
            using var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            var status = (int)response.StatusCode;
            var contentType = response.Content.Headers.ContentType?.ToString() ?? "application/json";
            responseHeaders = LlmCostEvidence.BuildSafeResponseHeaders(response, contentType);
            observer = new NativeResponsesAuditObserver(contentType.StartsWith("text/event-stream", StringComparison.OrdinalIgnoreCase));
            await write(new(status, contentType, ReadOnlyMemory<byte>.Empty), deadline.Token);
            await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            var buffer = new byte[16 * 1024];
            var first = true;
            while (true)
            {
                var count = await stream.ReadAsync(buffer, deadline.Token);
                if (count == 0) break;
                if (first) { first = false; if (logId != null) _logWriter?.MarkFirstByte(logId, DateTime.UtcNow); }
                // 原始字节先交付；旁路观测不得改变事件、ID、分片及多轮内容。
                await write(new(status, contentType, buffer.AsMemory(0, count)), deadline.Token);
                observer.Append(buffer.AsSpan(0, count));
            }
            observer.Complete();
            auditBody = observer.AuditBody;
            var wantsStream = body["stream"] is JsonValue streamValue && streamValue.TryGetValue<bool>(out var streaming) && streaming;
            var isStream = contentType.StartsWith("text/event-stream", StringComparison.OrdinalIgnoreCase);
            var successful = response.IsSuccessStatusCode && observer.Completed && wantsStream == isStream;
            outcome = new GatewayRawResponse
            {
                Success = successful,
                StatusCode = successful ? status : response.IsSuccessStatusCode ? 502 : status,
                ErrorCode = successful ? null : response.IsSuccessStatusCode ? "NATIVE_RESPONSES_OUTCOME_UNKNOWN" : "NATIVE_RESPONSES_UPSTREAM_FAILED",
                ErrorMessage = successful ? null : "上游未返回完整成功结果，请检查本次任务记录",
                Resolution = resolution,
                LogId = logId,
                DurationMs = (long)(DateTime.UtcNow - started).TotalMilliseconds,
            };
            return outcome;
        }
        catch (OperationCanceledException)
        {
            outcome = GatewayRawResponse.Fail(ct.IsCancellationRequested ? "GATEWAY_REQUEST_CANCELLED" : "NATIVE_RESPONSES_TIMEOUT",
                "请求已取消或超过执行时限", ct.IsCancellationRequested ? 409 : 504);
            return outcome;
        }
        catch (Exception)
        {
            // 不把可能含上游凭据或底层地址的异常文本返回给调用方。
            outcome = GatewayRawResponse.Fail("NATIVE_RESPONSES_TRANSPORT_FAILED", "上游传输中断，请检查本次任务记录", 502);
            return outcome;
        }
        finally
        {
            if (observer is not null) auditBody = observer.AuditBody;
            var duration = (long)(DateTime.UtcNow - started).TotalMilliseconds;
            CompleteLastSendAttempt(attempts, outcome.StatusCode, duration, outcome.ErrorCode);
            await FinishRawLogAsync(logId, outcome.StatusCode, auditBody, duration, resolved, request, transport,
                CancellationToken.None, attempts, responseHeaders);
            if (lease is not null) await lease.DisposeAsync();
            if (reachedProvider && HasTrackedHealthRoute(resolved))
            {
                try
                {
                    if (outcome.Success) await _modelResolver.RecordSuccessAsync(resolved, CancellationToken.None);
                    else if (!ct.IsCancellationRequested)
                        await RecordRawProviderFailureAsync(resolved, outcome.StatusCode, outcome.ErrorCode, request, CancellationToken.None);
                }
                catch { /* 健康投影失败不能改变已返回的原生结果或审计结算。 */ }
            }
        }
    }

    public static GatewayRawResponse? ValidateNativeResponsesBody(JsonObject? body)
    {
        if (body is null || body["store"] is not JsonValue store || !store.TryGetValue<bool>(out var stored) || stored
            || body["previous_response_id"] is not null || body["conversation"] is not null
            || HasStoredResponseItemReference(body["input"]))
            return GatewayRawResponse.Fail("NATIVE_RESPONSES_STATELESS_REQUIRED", "请使用 store:false 和完整输入历史，不支持服务器上下文引用", 400);
        if (body["input"] is not (JsonArray or JsonValue)
            || (body["input"] is JsonValue input && !input.TryGetValue<string>(out _)))
            return GatewayRawResponse.Fail("NATIVE_RESPONSES_INPUT_REQUIRED", "原生 Responses 请求需要完整输入历史", 400);
        if (body["stream"] is not null && (body["stream"] is not JsonValue stream || !stream.TryGetValue<bool>(out _)))
            return GatewayRawResponse.Fail("NATIVE_RESPONSES_STREAM_INVALID", "stream 必须是布尔值", 400);
        return null;
    }

    private static bool HasStoredResponseItemReference(JsonNode? node)
        => node is JsonObject obj
            ? (obj["type"] is JsonValue type && type.TryGetValue<string>(out var name) && name == "item_reference")
                || obj.Any(x => HasStoredResponseItemReference(x.Value))
            : node is JsonArray array && array.Any(HasStoredResponseItemReference);

    // 只用于既有日志/费用结算的旁路观察，不生成、修改或重放任何协议事件。
    private sealed class NativeResponsesAuditObserver(bool streaming)
    {
        private const int MaxAuditEventChars = 4 * 1024 * 1024;
        private readonly Decoder _decoder = Encoding.UTF8.GetDecoder();
        private readonly StringBuilder _line = new();
        private readonly StringBuilder _data = new();
        private bool _overflow;
        public bool Completed { get; private set; }
        public string AuditBody { get; private set; } = "{}";

        public void Append(ReadOnlySpan<byte> bytes)
        {
            var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
            var count = _decoder.GetChars(bytes, chars, false);
            for (var i = 0; i < count; i++)
            {
                var c = chars[i];
                if (streaming && c == '\n') { ConsumeLine(); continue; }
                if (_line.Length < MaxAuditEventChars) _line.Append(c);
                else _overflow = true;
            }
        }

        public void Complete()
        {
            if (streaming) { ConsumeLine(); ConsumeEvent(); }
            else if (!_overflow) Observe(_line.ToString(), false);
        }

        private void ConsumeLine()
        {
            var line = _line.ToString().TrimEnd('\r');
            _line.Clear();
            if (line.Length == 0) { ConsumeEvent(); return; }
            if (!line.StartsWith("data:", StringComparison.Ordinal)) return;
            if (_data.Length + line.Length > MaxAuditEventChars) { _overflow = true; return; }
            if (_data.Length > 0) _data.Append('\n');
            _data.Append(line.AsSpan(5).TrimStart(' '));
        }

        private void ConsumeEvent()
        {
            if (!_overflow && _data.Length > 0) Observe(_data.ToString(), true);
            _data.Clear();
            _overflow = false;
        }

        private void Observe(string json, bool isEvent)
        {
            try
            {
                if (JsonNode.Parse(json) is not JsonObject root) return;
                var type = root["type"]?.GetValue<string>();
                if (isEvent && type is not ("response.completed" or "response.failed" or "response.incomplete" or "error")) return;
                var response = isEvent ? root["response"] as JsonObject : root;
                Completed = response?["status"]?.GetValue<string>() == "completed" && (!isEvent || type == "response.completed");
                AuditBody = new JsonObject
                {
                    ["_gateway_audit"] = "native-responses-terminal-usage",
                    ["id"] = response?["id"]?.DeepClone(),
                    ["model"] = response?["model"]?.DeepClone(),
                    ["status"] = response?["status"]?.DeepClone(),
                    ["usage"] = response?["usage"]?.DeepClone(),
                    ["error"] = response?["error"]?.DeepClone() ?? root["error"]?.DeepClone(),
                }.ToJsonString();
            }
            catch (JsonException) { }
            catch (InvalidOperationException) { }
        }
    }
}
