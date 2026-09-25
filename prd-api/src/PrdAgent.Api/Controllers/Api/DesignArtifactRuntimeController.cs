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
    private const int DefaultProxyTimeoutSeconds = 900;
    private const int DefaultProxyIdleTimeoutSeconds = 90;
    internal const int MaxPreviewHtmlBytes = 1_048_576;
    /// <summary>
    /// 传输层上限按 JSON 转义后的体积算：CDS 用 JSON.stringify 推整页，引号、反斜杠、换行各变两个字符，
    /// 解码后没超 1 MiB 的属性密集页面，请求体可能远超「1 MiB + 4 KB」，被 Kestrel 在进 action 之前 413
    /// 掉，实时预览就断了（Codex P2）。这里给两倍余量；真正的 1 MiB 仍在解码之后按 HTML 本身判。
    /// </summary>
    internal const int MaxPreviewRequestBytes = MaxPreviewHtmlBytes * 2 + 4096;
    private static readonly TimeSpan PreviewEventTtl = TimeSpan.FromHours(24);
    private readonly IDesignArtifactWorkspaceBroker _broker;
    private readonly PrdAgent.Core.Interfaces.IRunEventStore? _events;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _configuration;
    private readonly ILogger<DesignArtifactRuntimeController> _logger;

    public DesignArtifactRuntimeController(
        IDesignArtifactWorkspaceBroker broker,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<DesignArtifactRuntimeController> logger,
        PrdAgent.Core.Interfaces.IRunEventStore? events = null)
    {
        _events = events;
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
            // 本控制器是匿名入口：先验工作区票据（与实时预览同一张票、同一个运行窗口），
            // 再读请求体。反过来的话，没有票据的请求也能把最多 6 MiB 读进内存（Codex P2，PR #1533）。
            // CommitResultAsync 里仍会再验一次，这里只负责把未授权请求挡在读体之前。
            var token = ReadBearerToken();
            await _broker.ValidatePreviewAsync(runId, token, ct);
            var bytes = await ReadBoundedBodyAsync(Request, DesignArtifactWorkspaceBroker.MaxOutputBytes, ct);
            var result = await _broker.CommitResultAsync(runId, token, bytes, ct);
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

    /// <summary>
    /// OpenDesign 运行期间的实时预览：CDS 发现 /workspace/index.html 变了就把整页推来，
    /// 这里只写进 Redis 事件流（生成流与修改流都会转给前端），不进 Mongo，也不当产物——
    /// 最终产物仍然只认 workspace/result 那一次整包提交与两道校验。
    /// </summary>
    [HttpPost("workspace/preview")]
    [RequestSizeLimit(MaxPreviewRequestBytes)]
    public async Task<IActionResult> PushWorkspacePreview(string runId, CancellationToken ct)
    {
        try
        {
            await _broker.ValidatePreviewAsync(runId, ReadBearerToken(), ct);
            var bytes = await ReadBoundedBodyAsync(Request, MaxPreviewRequestBytes, ct);
            using var document = JsonDocument.Parse(bytes);
            var html = document.RootElement.TryGetProperty("html", out var htmlElement) && htmlElement.ValueKind == JsonValueKind.String
                ? htmlElement.GetString() ?? string.Empty
                : string.Empty;
            var revision = document.RootElement.TryGetProperty("revision", out var revisionElement)
                           && revisionElement.TryGetInt32(out var parsedRevision)
                ? parsedRevision
                : 0;
            if (html.Length == 0 || Encoding.UTF8.GetByteCount(html) > MaxPreviewHtmlBytes)
                return BadRequest(new { error = "preview_invalid", message = "预览内容为空或超过 1 MB" });
            if (_events == null)
                return StatusCode(503, new { error = "preview_unavailable", message = "事件流未配置" });
            await _events.AppendEventAsync(
                PrdAgent.Core.Models.RunKinds.DesignArtifact,
                runId,
                "preview",
                new { html, revision },
                PreviewEventTtl,
                CancellationToken.None);
            return Ok(new { accepted = true, revision });
        }
        catch (JsonException)
        {
            return BadRequest(new { error = "preview_invalid", message = "预览内容不是合法 JSON" });
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
    public Task ProxyChatCompletions(string runId, CancellationToken ct) =>
        ProxyModelAsync(runId, responses: false, ct);

    [HttpPost("llm/v1/responses")]
    [RequestSizeLimit(MaxProxyRequestBytes)]
    public Task ProxyResponses(string runId, CancellationToken ct) =>
        ProxyModelAsync(runId, responses: true, ct);

    private async Task ProxyModelAsync(string runId, bool responses, CancellationToken ct)
    {
        try
        {
            // 先验模型票据再读请求体：匿名入口上，没有票据的请求不该换来一次最多 1 MiB 的
            // 上传、分配与 JSON 解析（Codex P2，PR #1533）。这里只读校验，不计数；
            // 调用次数仍在请求体通过合同校验之后由 ReserveModelCallAsync 记，口径不变。
            var ticket = ReadBearerToken();
            await _broker.ValidateModelTicketAsync(runId, ticket, ct);
            var bodyBytes = await ReadBoundedBodyAsync(Request, MaxProxyRequestBytes, ct);
            var body = JsonNode.Parse(bodyBytes) as JsonObject
                       ?? throw new InvalidOperationException("模型请求格式不正确，请重新发起任务");
            if (!responses && body["messages"] is not JsonArray)
                throw new InvalidOperationException("模型请求缺少对话内容，请重新发起任务");
            if (responses && body["input"] is not JsonArray
                && !(body["input"] is JsonValue input && input.TryGetValue<string>(out _)))
                throw new InvalidOperationException("模型请求缺少任务上下文，请重新发起任务");

            var run = await _broker.ReserveModelCallAsync(runId, ticket, ct);
            var selection = DesignArtifactModelSelection.ForRun(run, _configuration);
            if (responses)
                selection.ApplyToResponsesRequest(body);
            else
            {
                selection.ApplyToOpenAiRequest(body);
                ApplySingleOutputContract(body);
            }

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
                // 两条都走 gw-native 面：这里送的 pin 是 MAP 冻结的快照（运行时自带的那份在
                // ApplyToOpenAiRequest 里已经先剥掉了），而对外兼容面 /v1/* 一律拒绝请求自带 pin。
                responses ? $"{serveBaseUrl}/gw/v1/responses" : $"{serveBaseUrl}/gw/v1/chat/completions")
            {
                Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            upstream.Headers.TryAddWithoutValidation("X-Gateway-Key", gatewayKey);
            upstream.Headers.TryAddWithoutValidation("X-Gateway-App-Caller", caller);
            upstream.Headers.TryAddWithoutValidation("X-Gateway-Source", "map");
            upstream.Headers.TryAddWithoutValidation("X-Gateway-User-Id", run.UserId);
            upstream.Headers.TryAddWithoutValidation("X-Gateway-Run-Id", run.Id);
            // 只消费经票据绑定的 MAP 快照，绝不转发远端同名请求头。
            if (selection.Policy?.ReasoningMode == "omit")
                upstream.Headers.TryAddWithoutValidation("X-Gateway-Include-Thinking", "false");

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
            Response.Headers.CacheControl = "no-store";
            if (response.Headers.TryGetValues("x-request-id", out var requestIds)
                && requestIds.FirstOrDefault() is { Length: > 0 } requestId)
                Response.Headers["X-Request-Id"] = requestId;
            if (!response.IsSuccessStatusCode)
            {
                var publicStatus = response.StatusCode == System.Net.HttpStatusCode.TooManyRequests
                    ? StatusCodes.Status429TooManyRequests
                    : StatusCodes.Status502BadGateway;
                _logger.LogWarning(
                    "远程设计模型上游拒绝请求 runId={RunId} upstreamStatus={UpstreamStatus}",
                    runId,
                    (int)response.StatusCode);
                Response.StatusCode = publicStatus;
                Response.ContentType = "application/json";
                await Response.WriteAsJsonAsync(new
                {
                    error = new
                    {
                        code = publicStatus == StatusCodes.Status429TooManyRequests
                            ? "DESIGN_RUNTIME_MODEL_RATE_LIMITED"
                            : "DESIGN_RUNTIME_MODEL_REJECTED",
                        message = publicStatus == StatusCodes.Status429TooManyRequests
                            ? "设计模型当前请求较多，请稍后重试"
                            : "设计模型暂时无法处理本次请求，请重新发起任务",
                    },
                }, proxyDeadline.Token);
                return;
            }
            Response.StatusCode = (int)response.StatusCode;
            Response.ContentType = response.Content.Headers.ContentType?.ToString() ?? "application/json";
            if (response.Content.Headers.ContentType?.MediaType == "text/event-stream")
                Response.Headers["X-Accel-Buffering"] = "no";
            await using var stream = await response.Content.ReadAsStreamAsync(proxyDeadline.Token);
            // 边转发边读网关报的 model：执行器（服务或 CDS 容器）里调的模型，MAP 只有在这里看得见。
            var servedModel = new DesignRuntimeServedModelSniffer(
                eventStream: response.Content.Headers.ContentType?.MediaType == "text/event-stream");
            await CopyWithIdleTimeoutAsync(
                stream,
                Response.Body,
                idleTimeout,
                proxyDeadline.Token,
                forwarded =>
                {
                    servedModel.Observe(forwarded.Span);
                    return Task.CompletedTask;
                });
            // 整条响应转发完才记：流里先出现的可能是逻辑别名，终态里的才是网关实际用的模型。
            if (servedModel.Model is { } served)
                await RecordServedModelAsync(run, served);
        }
        catch (OperationCanceledException)
        {
            // 调用方自己走了：没有需要往下传的失败，记一条就够（与下面那个 catch 同一判据）。
            if (HttpContext.RequestAborted.IsCancellationRequested)
            {
                _logger.LogInformation("设计模型调用方已断开连接，本次代理提前结束 runId={RunId}", runId);
                return;
            }
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
                return;
            }
            // 已经发过头了：不中断的话 Kestrel 会把下游收成一次干净的 200 EOF，
            // 超时在这一层被抹平，OpenDesign 读到的是「完整的成功」。
            // 下面那个 catch 为同一件事加了 Abort，这里漏了——同一条判据的两份写法
            //（判据与接线纪律 形状 3 + 形状 10）。
            HttpContext.Abort();
        }
        catch (Exception ex) when (ex is ObjectDisposedException or IOException)
        {
            // 这个 catch 会接住两件完全不同的事，以前一并吞掉、正常返回（Codex P1，2026-09-15）：
            //  1) 调用方自己走了——没有需要往下传的失败，照旧只记一条；
            //  2) 上游网关**刻意**中断了本次响应（缺终态事件时它会补一个 error 事件再断开）。
            //     第二种被吞掉后，Kestrel 把下游收成一次干净的 200 EOF，网关那边造出来的传输失败
            //     在这一层被抹平，OpenDesign 读到的又是「完整的成功」——判据与接线纪律 形状 10。
            if (HttpContext.RequestAborted.IsCancellationRequested)
            {
                _logger.LogInformation("设计模型调用方已断开连接，本次代理提前结束 runId={RunId}", runId);
                return;
            }
            _logger.LogWarning(ex, "上游网关中断了本次设计模型响应（多半是缺终态事件）runId={RunId}", runId);
            if (!Response.HasStarted)
            {
                Response.StatusCode = StatusCodes.Status502BadGateway;
                Response.ContentType = "application/json";
                using var responseDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await Response.WriteAsJsonAsync(new
                {
                    error = new
                    {
                        code = "DESIGN_RUNTIME_MODEL_INTERRUPTED",
                        message = "设计模型响应被上游中断，请重新发起任务",
                        runId,
                    },
                }, responseDeadline.Token);
                return;
            }
            // 已经发出去的状态码收不回，只能让下游确定地读到一次传输失败，而不是干净的 EOF。
            HttpContext.Abort();
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
                return;
            }
            // 兜底这一支同样要中断。上面两支各自写了一遍「已发头就必须 Abort」，
            // 唯独这里漏了——而漏掉的恰恰是类型没被点名的那一类：HttpRequestException
            // 不派生自 IOException，读 HTTP/2 响应体时抛出来就落到这里，只记一条日志就返回，
            // Kestrel 于是把下游收成一次干净的 200 EOF，传输失败被抹平，
            // OpenDesign 读到的是「完整的成功」（形状 10 静默降级 + 形状 3 判据分裂）。
            // 调用方自己走了不算失败：连接已经没了，终止权在它那边，照旧只记一条。
            if (HttpContext.RequestAborted.IsCancellationRequested)
            {
                _logger.LogInformation("设计模型调用方已断开连接，本次代理提前结束 runId={RunId}", runId);
                return;
            }
            HttpContext.Abort();
        }
    }

    /// <summary>记录实际模型（落库 + 推事件）各自的上限：它挡在模型响应的 EOF 之前，必须短。</summary>
    internal static readonly TimeSpan ServedModelProjectionTimeout = TimeSpan.FromSeconds(3);

    /// <summary>
    /// 网关实际回答所用的模型：代理从网关响应里读到、且与 run 上记的不同时写一次并推一条 model 事件，
    /// 面板顶部的「{模型} · {平台}」由此显示真实值（ai-model-visibility）。平台名网关响应里没有，
    /// 不编：留空，前端按统一口径显示为「LLM Gateway」。这是旁路：失败只记日志，绝不影响转发。
    /// </summary>
    private async Task RecordServedModelAsync(DesignArtifactRun run, string model)
    {
        if (string.Equals(run.ResolvedModel, model, StringComparison.Ordinal)) return;
        try
        {
            using var timeout = new CancellationTokenSource(ServedModelProjectionTimeout);
            if (!await _broker.RecordServedModelAsync(run.Id, model, platform: null, timeout.Token)
                    .WaitAsync(ServedModelProjectionTimeout))
                return;
            _logger.LogInformation(
                "设计模型代理记下网关实际使用的模型 runId={RunId} model={Model} previous={Previous}",
                run.Id,
                model,
                run.ResolvedModel ?? "none");
            run.ResolvedModel = model;
            if (_events != null)
            {
                // 旁路投影：模型响应已经转发完，执行器要等本方法返回才看得到 EOF。
                // 事件存储慢或不可用时不能拖住这次成功的模型调用，所以限时、失败只记日志。
                // 用 WaitAsync 在调用方这一侧截断：Redis 实现并不理会传入的取消令牌，只传令牌是假限时。
                using var projectionTimeout = new CancellationTokenSource(ServedModelProjectionTimeout);
                await _events.AppendEventAsync(
                        PrdAgent.Core.Models.RunKinds.DesignArtifact,
                        run.Id,
                        "model",
                        new { model, platform = (string?)null },
                        PreviewEventTtl,
                        projectionTimeout.Token)
                    .WaitAsync(ServedModelProjectionTimeout);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "记录网关实际使用的设计模型失败，面板沿用已有值 runId={RunId}", run.Id);
        }
    }

    internal static async Task CopyWithIdleTimeoutAsync(
        Stream source,
        Stream destination,
        TimeSpan idleTimeout,
        CancellationToken totalDeadline,
        Func<ReadOnlyMemory<byte>, Task>? observeForwarded = null)
    {
        var buffer = new byte[64 * 1024];
        var destinationConnected = true;
        while (true)
        {
            using var idleDeadline = CancellationTokenSource.CreateLinkedTokenSource(totalDeadline);
            idleDeadline.CancelAfter(idleTimeout);
            var read = await source.ReadAsync(buffer.AsMemory(), idleDeadline.Token);
            if (read == 0) break;
            // 调用方断开后仍在排空上游：旁路观察照样进行（模型事实与它是否还有人在读无关）。
            if (observeForwarded != null) await observeForwarded(buffer.AsMemory(0, read));
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

    internal static void ApplySingleOutputContract(JsonObject body)
    {
        // 设计运行时消费单个输出，不支持候选分叉。输出 token 字段保持原样，
        // 包括缺省和畸形值；合法性与模型能力仍由 LLMGW / 上游校验，不能默改成任务预算。
        body.Remove("best_of");
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
            UnauthorizedAccessException => (StatusCodes.Status401Unauthorized, "DESIGN_RUNTIME_TICKET_INVALID", "远程设计凭证无效或已过期，请重新发起任务"),
            KeyNotFoundException => (StatusCodes.Status404NotFound, "DESIGN_RUNTIME_RUN_NOT_FOUND", "设计任务不存在，请重新发起"),
            InvalidOperationException or JsonException => (StatusCodes.Status409Conflict, "DESIGN_RUNTIME_CONTRACT_REJECTED", "远程设计数据不符合本次任务合同，请重新发起"),
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
