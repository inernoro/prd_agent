using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// CDS 隔离工作区的短期数据面。OpenDesign 只拿到本次 run 的模型票据；
/// 工作区 transfer token 只由 CDS 控制面持有，不进入容器。
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("api/design-artifacts/runtime/{runId}")]
public sealed class DesignArtifactRuntimeController : ControllerBase
{
    private const int MaxProxyRequestBytes = 1_048_576;
    private const int DefaultMaxCompletionTokens = 4_096;
    private const int DefaultProxyTimeoutSeconds = 900;
    private const int DefaultProxyIdleTimeoutSeconds = 90;
    private readonly IDesignArtifactWorkspaceBroker _broker;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _configuration;
    private readonly ILogger<DesignArtifactRuntimeController> _logger;

    public DesignArtifactRuntimeController(
        IDesignArtifactWorkspaceBroker broker,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<DesignArtifactRuntimeController> logger)
    {
        _broker = broker;
        _httpClientFactory = httpClientFactory;
        _configuration = configuration;
        _logger = logger;
    }

    [HttpGet("workspace/input")]
    public async Task<IActionResult> GetWorkspaceInput(string runId, CancellationToken ct)
    {
        try
        {
            var bytes = await _broker.ReadInputPackageAsync(runId, ReadBearerToken(), ct);
            return File(bytes, "application/json");
        }
        catch (Exception ex)
        {
            return MapRuntimeError(ex, runId);
        }
    }

    [HttpPost("workspace/result")]
    [RequestSizeLimit(DesignArtifactWorkspaceBroker.MaxOutputBytes)]
    public async Task<IActionResult> CommitWorkspaceResult(string runId, CancellationToken ct)
    {
        try
        {
            var bytes = await ReadBoundedBodyAsync(Request, DesignArtifactWorkspaceBroker.MaxOutputBytes, ct);
            var result = await _broker.CommitResultAsync(runId, ReadBearerToken(), bytes, ct);
            return Ok(new
            {
                artifactRef = $"map://design-artifact/{runId}/result",
                resultSha256 = result.ResultSha256,
                files = result.Files,
                idempotent = result.Idempotent,
            });
        }
        catch (Exception ex)
        {
            return MapRuntimeError(ex, runId);
        }
    }

    [HttpGet("llm/v1/models")]
    public async Task<IActionResult> ListModels(string runId, CancellationToken ct)
    {
        try
        {
            await _broker.ValidateModelTicketAsync(runId, ReadBearerToken(), ct);
            return Ok(new
            {
                @object = "list",
                data = new[]
                {
                    new { id = "map-managed", @object = "model", owned_by = "map-llmgw" },
                },
            });
        }
        catch (Exception ex)
        {
            return MapRuntimeError(ex, runId);
        }
    }

    [HttpPost("llm/v1/chat/completions")]
    [RequestSizeLimit(MaxProxyRequestBytes)]
    public async Task ProxyChatCompletions(string runId, CancellationToken ct)
    {
        try
        {
            var bodyBytes = await ReadBoundedBodyAsync(Request, MaxProxyRequestBytes, ct);
            var body = JsonNode.Parse(bodyBytes) as JsonObject
                       ?? throw new InvalidOperationException("模型请求格式不正确，请重新发起任务");
            if (body["messages"] is not JsonArray)
                throw new InvalidOperationException("模型请求缺少对话内容，请重新发起任务");

            var run = await _broker.ReserveModelCallAsync(runId, ReadBearerToken(), ct);
            var configuredPool = _configuration["DesignArtifactRuntime:ModelPoolId"]?.Trim();
            var configuredModel = _configuration["DesignArtifactRuntime:Model"]?.Trim();
            body.Remove("model_pool_id");
            body.Remove("modelPoolId");
            body.Remove("model_policy");
            body.Remove("modelPolicy");
            if (!string.IsNullOrWhiteSpace(configuredPool))
            {
                body.Remove("model");
                body["model_pool_id"] = configuredPool;
                body["model_policy"] = "pool";
            }
            else if (!string.IsNullOrWhiteSpace(configuredModel))
            {
                body["model"] = configuredModel;
            }
            else
            {
                body.Remove("model");
            }
            var maxCompletionTokens = Math.Clamp(
                _configuration.GetValue<int?>("DesignArtifactRuntime:MaxCompletionTokens")
                ?? DefaultMaxCompletionTokens,
                1,
                8_192);
            ApplyMapOwnedCompletionBudget(body, maxCompletionTokens);

            var serveBaseUrl = _configuration["LlmGateway:ServeBaseUrl"]?.Trim().TrimEnd('/');
            var gatewayKey = _configuration["LlmGwServe:ApiKey"]?.Trim();
            if (!Uri.TryCreate(serveBaseUrl, UriKind.Absolute, out _)
                || string.IsNullOrWhiteSpace(gatewayKey))
                throw new InvalidOperationException("设计模型服务暂时不可用，请稍后重试");

            var caller = run.Operation == DesignArtifactOperations.Edit
                ? AppCallerRegistry.Admin.WebHosting.EditHtml
                : AppCallerRegistry.Admin.WebHosting.GenerateHtml;
            using var upstream = new HttpRequestMessage(
                HttpMethod.Post,
                $"{serveBaseUrl}/v1/chat/completions")
            {
                Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            upstream.Headers.TryAddWithoutValidation("X-Gateway-Key", gatewayKey);
            upstream.Headers.TryAddWithoutValidation("X-Gateway-App-Caller", caller);
            upstream.Headers.TryAddWithoutValidation("X-Gateway-Source", "map");
            upstream.Headers.TryAddWithoutValidation("X-Gateway-User-Id", run.UserId);
            upstream.Headers.TryAddWithoutValidation("X-Gateway-Run-Id", run.Id);

            var totalTimeout = ResolveProxyTotalTimeout(
                _configuration,
                run.RuntimeTicketExpiresAt,
                DateTime.UtcNow);
            var idleTimeout = TimeSpan.FromSeconds(Math.Clamp(
                _configuration.GetValue<int?>("DesignArtifactRuntime:ProxyIdleTimeoutSeconds")
                ?? DefaultProxyIdleTimeoutSeconds,
                1,
                DefaultProxyTimeoutSeconds));
            using var proxyDeadline = new CancellationTokenSource(totalTimeout);
            var client = _httpClientFactory.CreateClient("DesignArtifactRuntimeProxy");
            using var response = await client.SendAsync(
                upstream,
                HttpCompletionOption.ResponseHeadersRead,
                proxyDeadline.Token);
            Response.StatusCode = (int)response.StatusCode;
            Response.ContentType = response.Content.Headers.ContentType?.ToString() ?? "application/json";
            Response.Headers.CacheControl = "no-store";
            if (response.Headers.TryGetValues("x-request-id", out var requestIds)
                && requestIds.FirstOrDefault() is { Length: > 0 } requestId)
                Response.Headers["X-Request-Id"] = requestId;
            await using var stream = await response.Content.ReadAsStreamAsync(proxyDeadline.Token);
            await CopyWithIdleTimeoutAsync(stream, Response.Body, idleTimeout, proxyDeadline.Token);
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("远程设计模型代理超过截止时间或流式空闲上限 runId={RunId}", runId);
            if (!Response.HasStarted)
            {
                Response.StatusCode = StatusCodes.Status504GatewayTimeout;
                Response.ContentType = "application/json";
                using var responseDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await Response.WriteAsJsonAsync(new
                {
                    error = new
                    {
                        code = "DESIGN_RUNTIME_MODEL_TIMEOUT",
                        message = "设计模型响应超时，请重新发起任务",
                        runId,
                    },
                }, responseDeadline.Token);
            }
        }
        catch (Exception ex) when (ex is ObjectDisposedException or IOException)
        {
            _logger.LogInformation("远程设计模型连接已结束 runId={RunId}", runId);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "远程设计模型代理失败 runId={RunId}", runId);
            if (!Response.HasStarted)
            {
                var mapped = MapRuntimeError(ex, runId) as ObjectResult;
                Response.StatusCode = mapped?.StatusCode ?? StatusCodes.Status500InternalServerError;
                Response.ContentType = "application/json";
                using var responseDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await Response.WriteAsJsonAsync(mapped?.Value ?? new
                {
                    error = new { code = "DESIGN_RUNTIME_UNAVAILABLE", message = "设计模型服务暂时不可用，请稍后重试", runId },
                }, responseDeadline.Token);
            }
        }
    }

    internal static async Task CopyWithIdleTimeoutAsync(
        Stream source,
        Stream destination,
        TimeSpan idleTimeout,
        CancellationToken totalDeadline)
    {
        var buffer = new byte[64 * 1024];
        var destinationConnected = true;
        while (true)
        {
            using var idleDeadline = CancellationTokenSource.CreateLinkedTokenSource(totalDeadline);
            idleDeadline.CancelAfter(idleTimeout);
            var read = await source.ReadAsync(buffer.AsMemory(), idleDeadline.Token);
            if (read == 0) break;
            if (!destinationConnected) continue;

            try
            {
                await destination.WriteAsync(buffer.AsMemory(0, read), totalDeadline);
                await destination.FlushAsync(totalDeadline);
            }
            catch (Exception ex) when (
                ex is IOException or ObjectDisposedException
                || (ex is OperationCanceledException && !totalDeadline.IsCancellationRequested))
            {
                // 浏览器断开只停止回写，不能取消已经进入 LLMGW 的服务端权威请求。
                // 继续在总截止和空闲截止内排空上游，使 LLMGW 审计与计费事实完整落库。
                destinationConnected = false;
            }
        }
    }

    internal static TimeSpan ResolveProxyTotalTimeout(
        IConfiguration configuration,
        DateTime? runtimeTicketExpiresAt,
        DateTime now)
    {
        var configuredTimeout = TimeSpan.FromSeconds(Math.Clamp(
            configuration.GetValue<int?>("DesignArtifactRuntime:ProxyTimeoutSeconds")
            ?? DefaultProxyTimeoutSeconds,
            1,
            DefaultProxyTimeoutSeconds));
        if (runtimeTicketExpiresAt is not { } ticketExpiresAt)
            return configuredTimeout;

        var ticketBudget = ticketExpiresAt - now;
        if (ticketBudget <= TimeSpan.Zero)
            throw new UnauthorizedAccessException("远程设计凭证已过期，请重新发起任务");
        return ticketBudget < configuredTimeout ? ticketBudget : configuredTimeout;
    }

    internal static void ApplyMapOwnedCompletionBudget(JsonObject body, int maxCompletionTokens)
    {
        // OpenDesign is only a passive consumer of the MAP model endpoint. It cannot raise the
        // output budget through either OpenAI spelling or fan out one call into several choices.
        body.Remove("max_tokens");
        body.Remove("max_completion_tokens");
        body.Remove("best_of");
        body["max_tokens"] = Math.Clamp(maxCompletionTokens, 1, 8_192);
        body["n"] = 1;
    }

    private string ReadBearerToken()
    {
        var authorization = Request.Headers.Authorization.ToString();
        if (!AuthenticationHeaderValue.TryParse(authorization, out var header)
            || !string.Equals(header.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(header.Parameter))
            throw new UnauthorizedAccessException("远程设计凭证缺失，请重新发起任务");
        return header.Parameter;
    }

    private ObjectResult MapRuntimeError(Exception ex, string runId)
    {
        var (status, code, message) = ex switch
        {
            UnauthorizedAccessException => (StatusCodes.Status401Unauthorized, "DESIGN_RUNTIME_TICKET_INVALID", ex.Message),
            KeyNotFoundException => (StatusCodes.Status404NotFound, "DESIGN_RUNTIME_RUN_NOT_FOUND", "设计任务不存在，请重新发起"),
            InvalidOperationException => (StatusCodes.Status409Conflict, "DESIGN_RUNTIME_CONTRACT_REJECTED", ex.Message),
            BadHttpRequestException => (StatusCodes.Status413PayloadTooLarge, "DESIGN_RUNTIME_PAYLOAD_TOO_LARGE", "远程设计数据超过允许大小，请减少引用后重试"),
            _ => (StatusCodes.Status500InternalServerError, "DESIGN_RUNTIME_UNAVAILABLE", "远程设计服务暂时不可用，请稍后重试"),
        };
        if (status >= 500) _logger.LogError(ex, "远程设计数据面失败 runId={RunId}", runId);
        return StatusCode(status, new { error = new { code, message, runId } });
    }

    private static async Task<byte[]> ReadBoundedBodyAsync(HttpRequest request, long limit, CancellationToken ct)
    {
        if (request.ContentLength > limit)
            throw new BadHttpRequestException("request body too large", StatusCodes.Status413PayloadTooLarge);
        await using var output = new MemoryStream();
        var buffer = new byte[64 * 1024];
        while (true)
        {
            var read = await request.Body.ReadAsync(buffer, ct);
            if (read == 0) break;
            if (output.Length + read > limit)
                throw new BadHttpRequestException("request body too large", StatusCodes.Status413PayloadTooLarge);
            await output.WriteAsync(buffer.AsMemory(0, read), ct);
        }
        return output.ToArray();
    }
}
