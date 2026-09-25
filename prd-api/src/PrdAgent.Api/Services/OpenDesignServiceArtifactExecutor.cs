using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// OpenDesign 的第二条传输面：MAP 按 map-design-executor-v1 直接调用独立部署的设计执行服务
///（compose 服务 design-opendesign），不再经过 CDS Remote Agent 会话。
///
/// 协议见 doc/spec.platform.design-runtime.protocol.md；服务端契约的唯一判据是
/// design-runtime/opendesign/src/protocol.ts 与 http/server.ts。
///
/// 传给服务的传输地址、模型出口、票据与经 CDS 时完全相同（都来自
/// <see cref="IDesignArtifactWorkspaceBroker.PrepareAsync"/>，落在 MAP 的公网 https 源上），
/// 事件翻译与 CDS 路径共用 <see cref="OpenDesignEventTranslator"/>。
/// 任何失败都如实失败，绝不静默改走 CDS 会话（判据与接线纪律 形状 10）；回退只能由运维改开关。
/// </summary>
public sealed class OpenDesignServiceArtifactExecutor : IDesignArtifactExecutor, IDesignArtifactProviderProbe
{
    internal const string ExecutorProtocol = "map-design-executor-v1";
    internal const string TransportLogName = "service";

    /// <summary>交给服务的整任务上限，与经 CDS 时的 15 分钟一致。</summary>
    internal const int TaskTimeoutSeconds = 900;

    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan CancelTimeout = TimeSpan.FromSeconds(5);

    /// <summary>票据到期前至少留出的余量：别让任务在最后一分钟因票据过期而白跑。</summary>
    private static readonly TimeSpan TicketSafetyMargin = TimeSpan.FromSeconds(60);

    /// <summary>服务自己在 timeoutSeconds 到点后会发 error 事件；MAP 多等这么久再判它失联。</summary>
    private static readonly TimeSpan EventGrace = TimeSpan.FromSeconds(120);

    /// <summary>服务空闲时每 15 秒发一次 keepalive，一分钟一个字节都没有就当连接已断，续读。</summary>
    internal static readonly TimeSpan StreamIdleTimeout = TimeSpan.FromSeconds(60);

    /// <summary>服务自报「引擎启动中 / 重拉中」时最多等多久；再久就不是「等一下」能解决的了。</summary>
    private static readonly TimeSpan MaxUnavailableWait = TimeSpan.FromMinutes(2);

    private static readonly TimeSpan FallbackTicketTtl = TimeSpan.FromMinutes(25);
    private const int MaxConsecutiveStreamFailures = 5;
    private const int DefaultBusyRetrySeconds = 15;
    private const int DefaultUnavailableRetrySeconds = 10;
    private const string SubmitTimeoutCode = "submit_timeout";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IDesignArtifactWorkspaceBroker _workspaceBroker;
    private readonly IConfiguration _configuration;
    private readonly ILogger<OpenDesignServiceArtifactExecutor> _logger;

    public OpenDesignServiceArtifactExecutor(
        IHttpClientFactory httpClientFactory,
        IDesignArtifactWorkspaceBroker workspaceBroker,
        IConfiguration configuration,
        ILogger<OpenDesignServiceArtifactExecutor> logger)
    {
        _httpClientFactory = httpClientFactory;
        _workspaceBroker = workspaceBroker;
        _configuration = configuration;
        _logger = logger;
    }

    /// <summary>排队与重连之间的等待。测试替换它，免得真等 15 秒。</summary>
    internal Func<TimeSpan, CancellationToken, Task> Delay { get; init; } = Task.Delay;

    public string Runtime => DesignArtifactRuntimes.OpenDesign;

    public bool Supports(string artifactType, string operation) =>
        artifactType == DesignArtifactTypes.WebPage
        && operation is DesignArtifactOperations.Generate or DesignArtifactOperations.Edit;

    // ───────────────────────── 能力探针 ─────────────────────────

    public async Task<DesignArtifactProviderProbeResult> ProbeAsync(string userId, CancellationToken ct)
    {
        var transport = OpenDesignTransportResolver.Resolve(_configuration);
        if (transport.Problem != null || transport.BaseUrl == null || transport.ApiKey == null)
            return new DesignArtifactProviderProbeResult(false, false, false, transport.Problem ?? MissingConfigurationReason);

        using var timeout = new CancellationTokenSource(ProbeTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        try
        {
            // 查能力是匿名接口：不带密钥，探针路径上不多暴露一次凭据。
            using var request = new HttpRequestMessage(HttpMethod.Get, Endpoint(transport, "v1/capabilities"));
            using var response = await CreateClient().SendAsync(request, linked.Token);
            var text = await response.Content.ReadAsStringAsync(linked.Token);
            if (!response.IsSuccessStatusCode)
            {
                return Unavailable(
                    $"设计执行服务的能力接口回了 HTTP {(int)response.StatusCode}，OpenDesign 暂不可用：需要排查：" +
                    $"{transport.BaseUrl} 是否指向 design-opendesign、它是否与本分支同一版本部署");
            }
            return MapCapabilities(text, transport.BaseUrl);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return Unavailable(
                $"MAP 在 {(int)ProbeTimeout.TotalSeconds} 秒内没有等到设计执行服务的能力接口回应，OpenDesign 暂不可用：" +
                "等待服务恢复，无需人工处理；持续出现请查看 design-opendesign 容器是否在运行");
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            _logger.LogWarning(ex, "读取设计执行服务能力失败 transport=service baseUrl={BaseUrl}", transport.BaseUrl);
            return Unavailable(
                $"MAP 连不上设计执行服务（{transport.BaseUrl}），OpenDesign 暂不可用：需要排查：design-opendesign 容器是否在运行、" +
                $"{OpenDesignTransportResolver.BaseUrlKey} 是否写对；需要回退时把 {OpenDesignTransportResolver.TransportKey} 设为 cds-session");
        }
    }

    private const string MissingConfigurationReason =
        "部署配置没有给出设计执行服务的地址与密钥，OpenDesign 暂不可用：需要处理：补齐 DesignRuntime:OpenDesign:BaseUrl 与 ApiKey";

    private static DesignArtifactProviderProbeResult Unavailable(string reason) =>
        new(Configured: true, Healthy: false, Enabled: false, Reason: reason);

    /// <summary>
    /// 能力描述 → 目录事实。判据：协议对得上且服务自报健康就可用；忙（busy / acceptingTasks=false）
    /// 不算不可用——隔离方案 A 下一个实例一次只跑一个任务，新任务排队等它就行。
    /// </summary>
    internal static DesignArtifactProviderProbeResult MapCapabilities(string json, Uri baseUrl)
    {
        JsonObject? capabilities;
        try
        {
            capabilities = JsonNode.Parse(json) as JsonObject;
        }
        catch (JsonException)
        {
            capabilities = null;
        }
        if (capabilities == null)
        {
            return Unavailable(
                $"设计执行服务（{baseUrl}）的能力接口返回的不是 JSON 对象，OpenDesign 暂不可用：需要排查：该地址是否真的指向 design-opendesign");
        }

        var protocol = ReadString(capabilities, "protocol");
        if (!string.Equals(protocol, ExecutorProtocol, StringComparison.Ordinal))
        {
            return Unavailable(
                $"设计执行服务报告的协议是「{protocol ?? "未声明"}」，与 MAP 要求的 {ExecutorProtocol} 不一致，OpenDesign 暂不可用：" +
                "需要处理：把 design-opendesign 部署成与 MAP 同一版本");
        }

        if (capabilities["healthy"]?.GetValueKind() != JsonValueKind.True)
        {
            var reason = capabilities["reason"] as JsonObject;
            var serviceMessage = ReadString(reason, "message");
            var code = ReadString(reason, "code");
            // 服务的原因本身已按「谁 + 做了什么 → 于是怎样 → 要不要紧」渲染好，原样接在主语后面。
            return Unavailable(string.IsNullOrWhiteSpace(serviceMessage)
                ? "设计执行服务自报暂不可用、但没有给出原因，OpenDesign 暂不可用：需要排查：design-opendesign 容器日志"
                : $"设计执行服务自报暂不可用（{code ?? "unknown"}）：{serviceMessage}");
        }

        return new DesignArtifactProviderProbeResult(Configured: true, Healthy: true, Enabled: true, Reason: null);
    }

    // ───────────────────────── 执行 ─────────────────────────

    public async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(
        DesignArtifactRun run,
        string? currentHtml,
        [EnumeratorCancellation] CancellationToken ct)
    {
        // 结果包已经提交过（worker 在 done 与落库之间重启）：直接交付，不再花一次模型的钱。
        if (!string.IsNullOrWhiteSpace(run.WorkspaceResultAssetKey))
        {
            var recovered = await _workspaceBroker.ReadResultAsync(run.Id, CancellationToken.None);
            yield return new DesignArtifactExecutorChunk("delta", recovered.IndexHtml, recovered.Files);
            yield break;
        }

        var transport = OpenDesignTransportResolver.Resolve(_configuration);
        _logger.LogInformation(
            "OpenDesign 设计任务开始执行 transport={Transport} run={RunId} operation={Operation} baseUrl={BaseUrl}",
            TransportLogName, run.Id, run.Operation, transport.BaseUrl);
        if (transport.Problem != null || transport.BaseUrl == null || transport.ApiKey == null)
            throw new InvalidOperationException(transport.Problem ?? MissingConfigurationReason);

        var workspace = await _workspaceBroker.PrepareAsync(run, currentHtml, CancellationToken.None);
        var ticketExpiresAt = run.RuntimeTicketExpiresAt ?? DateTime.UtcNow.Add(FallbackTicketTtl);
        // 排队不能把票据耗光：任务真正开跑时，票据至少还要够它跑满上限。
        var queueDeadline = ticketExpiresAt - TimeSpan.FromSeconds(TaskTimeoutSeconds) - TicketSafetyMargin;
        const int attempt = 1;
        var requestBody = BuildTaskRequest(run, workspace, attempt, TaskTimeoutSeconds);
        var translator = new OpenDesignEventTranslator(run.Operation == DesignArtifactOperations.Edit, run.Progress);
        var accepted = false;
        // 提交请求一旦发出，服务就可能已经接下任务——哪怕 MAP 没等到 202（调用方取消、响应丢失、超时）。
        // 收尾时按「可能已接单」处理，否则服务唯一的执行位会被一个已被放弃的任务白占到超时。
        var dispatched = false;
        var remoteTerminal = false;
        var queuedSince = DateTime.UtcNow;
        DateTime? unavailableSince = null;

        try
        {
            while (true)
            {
                dispatched = true;
                var submit = await SubmitOnceAsync(transport, run.Id, requestBody, ct);
                if (submit.Kind == SubmitKind.Accepted)
                {
                    accepted = true;
                    _logger.LogInformation(
                        "设计执行服务已接下任务 transport={Transport} run={RunId} replayed={Replayed} queuedSeconds={QueuedSeconds}",
                        TransportLogName, run.Id, submit.Replayed, (int)(DateTime.UtcNow - queuedSince).TotalSeconds);
                    break;
                }

                if (submit.Kind == SubmitKind.Busy)
                {
                    var wait = submit.RetryAfter;
                    if (DateTime.UtcNow + wait > queueDeadline)
                        throw ServiceFailure(
                            $"设计执行服务在 {(int)Math.Ceiling((DateTime.UtcNow - queuedSince).TotalMinutes)} 分钟里一直在处理其他任务",
                            "本次任务排不上号，已停止等待、没有开始生成",
                            "稍后重新发起；高峰期持续排队说明需要多部署一个 design-opendesign 实例",
                            ("transport", TransportLogName), ("code", submit.Code), ("queuedSeconds", (int)(DateTime.UtcNow - queuedSince).TotalSeconds));
                    yield return new DesignArtifactExecutorChunk(
                        "phase",
                        BusyPhase(submit.Slot, wait, DateTime.UtcNow - queuedSince),
                        Progress: translator.Progress);
                    await Delay(wait, ct);
                    continue;
                }

                if (submit.Kind == SubmitKind.Unavailable)
                {
                    unavailableSince ??= DateTime.UtcNow;
                    var wait = submit.RetryAfter;
                    if (DateTime.UtcNow - unavailableSince.Value + wait > MaxUnavailableWait
                        || DateTime.UtcNow + wait > queueDeadline)
                        throw ServiceFailure(
                            $"设计执行服务在 {(int)MaxUnavailableWait.TotalMinutes} 分钟内一直没有恢复接单（{submit.ServiceMessage ?? submit.Code}）",
                            "本次任务没有开始生成",
                            "等服务恢复后重新发起；持续出现请管理员查看 design-opendesign 容器日志",
                            ("transport", TransportLogName), ("code", submit.Code), ("status", submit.Status));
                    yield return new DesignArtifactExecutorChunk(
                        "phase",
                        submit.Code == SubmitTimeoutCode
                            ? $"设计执行服务在 {(int)RequestTimeout.TotalSeconds} 秒内没有回应这次提交，约 {(int)wait.TotalSeconds} 秒后重试"
                            : $"设计执行服务正在准备引擎，约 {(int)wait.TotalSeconds} 秒后重试提交",
                        Progress: translator.Progress);
                    await Delay(wait, ct);
                    continue;
                }

                throw submit.Failure!;
            }

            var eventsDeadline = DateTime.UtcNow + TimeSpan.FromSeconds(TaskTimeoutSeconds) + EventGrace;
            var afterSeq = 0L;
            var consecutiveFailures = 0;
            while (true)
            {
                if (DateTime.UtcNow >= eventsDeadline)
                    throw new InvalidOperationException(OpenDesignFailureMessage.Describe(
                        OpenDesignFailureStage.Deadline(TimeSpan.FromSeconds(TaskTimeoutSeconds)), remoteReason: null));

                var open = await OpenEventStreamAsync(transport, run.Id, afterSeq, ct);
                if (open.Failure != null) throw open.Failure;
                if (open.Session == null)
                {
                    consecutiveFailures++;
                    if (consecutiveFailures >= MaxConsecutiveStreamFailures)
                        throw StreamBroken(consecutiveFailures, open.Error);
                    await Delay(ReconnectBackoff(consecutiveFailures), ct);
                    continue;
                }

                using var session = open.Session;
                var sawEvent = false;
                Exception? breakError = null;
                while (true)
                {
                    var idle = Min(StreamIdleTimeout, eventsDeadline - DateTime.UtcNow);
                    if (idle <= TimeSpan.Zero) break;
                    var read = await session.ReadAsync(idle, ct);
                    if (read.Event == null)
                    {
                        breakError = read.Error;
                        break;
                    }

                    var evt = read.Event;
                    // 同一 taskId 的事件序号跨 attempt 连续：只认本次这一次尝试的事件。
                    if (evt.Attempt != attempt) { afterSeq = Math.Max(afterSeq, evt.Seq); continue; }
                    afterSeq = Math.Max(afterSeq, evt.Seq);
                    sawEvent = true;
                    consecutiveFailures = 0;
                    switch (evt.Type)
                    {
                        case OpenDesignEventTranslator.Done:
                            remoteTerminal = true;
                            var package = await _workspaceBroker.ReadResultAsync(run.Id, CancellationToken.None);
                            _logger.LogInformation(
                                "设计执行服务交回结果 transport={Transport} run={RunId} files={Files}",
                                TransportLogName, run.Id, package.Files.Count);
                            yield return new DesignArtifactExecutorChunk("delta", package.IndexHtml, package.Files);
                            yield break;
                        case OpenDesignEventTranslator.Error:
                            remoteTerminal = true;
                            var code = OpenDesignEventTranslator.ReadPayloadString(evt.PayloadJson, "code");
                            _logger.LogWarning(
                                "设计执行服务报告任务失败 transport={Transport} run={RunId} code={Code} message={RemoteMessage}",
                                TransportLogName, run.Id, code ?? "unknown",
                                OpenDesignEventTranslator.ReadPayloadString(evt.PayloadJson, "message") ?? "unknown");
                            if (code == "task_cancelled")
                                throw new DesignArtifactExecutionCancelledException("设计执行服务报告本次任务已被取消，没有提交结果");
                            throw OpenDesignEventTranslator.RemoteFailure(evt.PayloadJson);
                        default:
                            var chunk = translator.ToChunk(evt.Type, evt.PayloadJson);
                            if (chunk != null) yield return chunk;
                            break;
                    }
                }

                // 连接断了（或服务在没发终态事件时关了流）：从最后一个序号续读。
                if (!sawEvent)
                {
                    consecutiveFailures++;
                    if (consecutiveFailures >= MaxConsecutiveStreamFailures)
                        throw StreamBroken(consecutiveFailures, breakError);
                }
                _logger.LogInformation(
                    "设计执行服务事件流中断，按序号续读 transport={Transport} run={RunId} afterSeq={AfterSeq} reason={Reason}",
                    TransportLogName, run.Id, afterSeq, breakError?.GetType().Name ?? "stream_closed");
                await Delay(ReconnectBackoff(Math.Max(consecutiveFailures, 1)), ct);
            }
        }
        finally
        {
            // 提交过、未见终态就退出（MAP 取消、提交结果不明、超时、读流失败）：请服务停掉任务并清空工作目录。
            // 服务其实没接下时取消返回 404，只记日志，无副作用；取消按 taskId 定位，碰不到别的任务。
            // 用 CancellationToken.None：这一步恰恰要在调用方已取消之后做完。
            if ((accepted || dispatched) && !remoteTerminal)
                await CancelRemoteTaskAsync(transport, run.Id);
        }
    }

    internal static JsonObject BuildTaskRequest(
        DesignArtifactRun run,
        PreparedDesignArtifactWorkspace workspace,
        int attempt,
        int timeoutSeconds) => new()
        {
            ["taskId"] = run.Id,
            ["attempt"] = attempt,
            ["transfer"] = new JsonObject
            {
                ["schemaVersion"] = DesignArtifactWorkspaceBroker.SchemaVersion,
                ["inputPackageUrl"] = workspace.InputPackageUrl,
                ["inputSha256"] = workspace.InputSha256,
                ["resultCommitUrl"] = workspace.ResultCommitUrl,
                ["transferToken"] = workspace.TransferToken,
                ["baseRevision"] = workspace.BaseRevision,
                ["maxInputBytes"] = workspace.MaxInputBytes,
                ["maxOutputBytes"] = workspace.MaxOutputBytes,
                ["allowedOutputPaths"] = new JsonArray(workspace.AllowedOutputPaths.Select(path => (JsonNode?)path).ToArray()),
                // previewUrl 不传：服务按 resultCommitUrl 推导出同源的 /workspace/preview，与经 CDS 时一致。
            },
            ["model"] = new JsonObject
            {
                ["baseUrl"] = workspace.ModelBaseUrl,
                ["protocol"] = "openai",
                ["apiKey"] = workspace.ModelToken,
                ["model"] = workspace.Model,
            },
            ["timeoutSeconds"] = timeoutSeconds,
            ["envelope"] = JsonNode.Parse(DesignArtifactPromptBuilder.BuildRemoteEnvelope(run)),
        };

    private static string BusyPhase(string? slot, TimeSpan wait, TimeSpan queued)
    {
        var seconds = (int)Math.Ceiling(wait.TotalSeconds);
        var what = slot == "resetting"
            ? "设计执行服务正在清理上一个任务的工作目录"
            : "设计执行服务正在处理另一个任务";
        return queued.TotalSeconds >= 1
            ? $"{what}，约 {seconds} 秒后重试（已排队 {(int)queued.TotalSeconds} 秒）"
            : $"{what}，约 {seconds} 秒后重试";
    }

    private static TimeSpan ReconnectBackoff(int failures) =>
        TimeSpan.FromSeconds(Math.Min(10, failures * 2));

    private static TimeSpan Min(TimeSpan left, TimeSpan right) => left < right ? left : right;

    private static InvalidOperationException StreamBroken(int failures, Exception? error) => ServiceFailure(
        $"MAP 连续 {failures} 次没能从设计执行服务读到本次任务的进度",
        "本次生成已停止等待，服务侧的任务会被取消",
        "重新发起一次；反复出现请管理员查看 design-opendesign 容器是否在重启、MAP 到它的网络是否稳定",
        ("transport", TransportLogName), ("lastError", error?.GetType().Name));

    /// <summary>
    /// 传输面（HTTP 层）失败交给用户的那句话：外因在前（谁做了什么）→ 于是怎样 → 下一步 → 技术细节。
    /// 远端执行过程中的失败不走这里，走与 CDS 路径共用的 <see cref="OpenDesignFailureMessage"/>。
    /// </summary>
    internal static InvalidOperationException ServiceFailure(
        string whoDidWhat,
        string impact,
        string nextStep,
        params (string Key, object? Value)[] technical)
    {
        var details = string.Join(" · ", technical
            .Where(item => item.Value != null && !string.IsNullOrWhiteSpace(item.Value.ToString()))
            .Select(item => $"{item.Key}={item.Value}"));
        return new InvalidOperationException(
            $"网页生成失败：{whoDidWhat}，{impact}。下一步：{nextStep}。" + (details.Length > 0 ? $"技术细节：{details}" : string.Empty));
    }

    // ───────────────────────── 提交 ─────────────────────────

    private enum SubmitKind
    {
        Accepted,
        Busy,
        Unavailable,
        Failed,
    }

    private sealed record SubmitOutcome(
        SubmitKind Kind,
        bool Replayed = false,
        TimeSpan RetryAfter = default,
        string? Code = null,
        string? Slot = null,
        string? ServiceMessage = null,
        int Status = 0,
        InvalidOperationException? Failure = null);

    private async Task<SubmitOutcome> SubmitOnceAsync(
        OpenDesignTransportResolution transport,
        string runId,
        JsonObject body,
        CancellationToken ct)
    {
        using var timeout = new CancellationTokenSource(RequestTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        HttpResponseMessage response;
        string text;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint(transport, "v1/tasks"))
            {
                Content = new StringContent(body.ToJsonString(JsonOptions), Encoding.UTF8, "application/json"),
            };
            Authorize(request, transport);
            response = await CreateClient().SendAsync(request, linked.Token);
            text = await response.Content.ReadAsStringAsync(linked.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // 提交超时时服务可能已经接下了任务：下一次同 attempt、同内容的提交会得到 replayed，不会重跑。
            return new SubmitOutcome(SubmitKind.Unavailable, RetryAfter: TimeSpan.FromSeconds(DefaultUnavailableRetrySeconds),
                Code: SubmitTimeoutCode, ServiceMessage: $"提交在 {(int)RequestTimeout.TotalSeconds} 秒内没有回应");
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            _logger.LogWarning(ex, "提交设计任务时连不上设计执行服务 transport=service run={RunId} baseUrl={BaseUrl}", runId, transport.BaseUrl);
            return new SubmitOutcome(SubmitKind.Failed, Failure: ServiceFailure(
                $"MAP 连不上设计执行服务（{transport.BaseUrl}）",
                "本次任务没有开始生成",
                $"确认 design-opendesign 容器在运行、{OpenDesignTransportResolver.BaseUrlKey} 写对；需要回退时把 {OpenDesignTransportResolver.TransportKey} 设为 cds-session",
                ("transport", TransportLogName), ("error", ex.GetType().Name)));
        }

        using (response)
        {
            var status = (int)response.StatusCode;
            if (response.StatusCode is HttpStatusCode.Accepted or HttpStatusCode.OK)
            {
                var replayed = TryParse(text)?["replayed"]?.GetValueKind() == JsonValueKind.True;
                return new SubmitOutcome(SubmitKind.Accepted, Replayed: replayed);
            }

            var parsed = TryParse(text);
            var error = parsed?["error"] as JsonObject;
            var code = ReadString(error, "code") ?? "unknown";
            var serviceMessage = ReadString(error, "message");
            var retryable = error?["retryable"]?.GetValueKind() == JsonValueKind.True;
            var retryAfter = ReadRetryAfter(parsed, response);
            _logger.LogWarning(
                "设计执行服务拒绝了提交 transport=service run={RunId} status={Status} code={Code}", runId, status, code);

            if (status == 409 && code == "executor_busy")
            {
                var slot = (error?["details"] as JsonObject) is { } details ? ReadString(details, "slot") : null;
                return new SubmitOutcome(SubmitKind.Busy,
                    RetryAfter: retryAfter ?? TimeSpan.FromSeconds(DefaultBusyRetrySeconds), Code: code, Slot: slot, Status: status);
            }
            if (status == 503 && retryable)
            {
                return new SubmitOutcome(SubmitKind.Unavailable,
                    RetryAfter: retryAfter ?? TimeSpan.FromSeconds(DefaultUnavailableRetrySeconds),
                    Code: code, ServiceMessage: serviceMessage, Status: status);
            }

            return new SubmitOutcome(SubmitKind.Failed, Failure: DescribeRejection(status, code, serviceMessage, transport));
        }
    }

    private static InvalidOperationException DescribeRejection(
        int status,
        string code,
        string? serviceMessage,
        OpenDesignTransportResolution transport)
    {
        (string Key, object? Value)[] technical =
        [
            ("transport", TransportLogName), ("status", status), ("code", code),
            ("service", Truncate(serviceMessage, 240)),
        ];
        return (status, code) switch
        {
            (401, _) => ServiceFailure(
                "设计执行服务拒绝了 MAP 的调用密钥",
                "本次任务没有开始生成",
                $"核对 MAP 的 {OpenDesignTransportResolver.ApiKeyKey} 与 design-opendesign 的 DESIGN_RUNTIME_API_KEY 是否为同一把（CDS 项目环境变量）",
                technical),
            (503, "api_key_not_configured") => ServiceFailure(
                "设计执行服务的部署没有配置 DESIGN_RUNTIME_API_KEY",
                "它拒绝一切任务，本次没有开始生成",
                "在 CDS 项目环境变量或生产配置里补上这把内部密钥后重新部署 design-opendesign",
                technical),
            (503, _) => ServiceFailure(
                $"设计执行服务自报暂不能接任务（{serviceMessage ?? code}）",
                "本次任务没有开始生成",
                "按服务给出的原因处理（通常是重建 design-opendesign 镜像）后重新发起",
                technical),
            (409, _) => ServiceFailure(
                "设计执行服务上已经有同一任务编号的另一次提交",
                "本次提交被拒收，没有重复生成",
                "重新发起一次任务",
                technical),
            (404, _) => ServiceFailure(
                $"{transport.BaseUrl} 上没有 {ExecutorProtocol} 的任务接口",
                "本次任务没有开始生成",
                $"确认 {OpenDesignTransportResolver.BaseUrlKey} 指向 design-opendesign，且它与本分支同一版本部署",
                technical),
            (400 or 413, _) => ServiceFailure(
                "设计执行服务认为 MAP 提交的任务不合协议约定",
                "本次任务没有开始生成，重试也不会通过",
                "请管理员核对 MAP 与 design-opendesign 是否为同一版本部署",
                technical),
            _ => ServiceFailure(
                $"设计执行服务处理 MAP 的提交时出错（HTTP {status}）",
                "本次任务没有开始生成",
                "重新发起一次；反复出现请管理员查看 design-opendesign 容器日志",
                technical),
        };
    }

    private static TimeSpan? ReadRetryAfter(JsonObject? body, HttpResponseMessage response)
    {
        if (body?["retryAfterSeconds"] is JsonValue value && value.TryGetValue<double>(out var seconds) && seconds > 0)
            return TimeSpan.FromSeconds(Math.Min(seconds, 120));
        if (response.Headers.RetryAfter?.Delta is { } delta && delta > TimeSpan.Zero)
            return delta > TimeSpan.FromSeconds(120) ? TimeSpan.FromSeconds(120) : delta;
        return null;
    }

    // ───────────────────────── 读事件 ─────────────────────────

    private sealed record OpenOutcome(ServiceEventSession? Session, InvalidOperationException? Failure, Exception? Error);

    private async Task<OpenOutcome> OpenEventStreamAsync(
        OpenDesignTransportResolution transport,
        string runId,
        long afterSeq,
        CancellationToken ct)
    {
        using var timeout = new CancellationTokenSource(RequestTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token);
        var request = new HttpRequestMessage(
            HttpMethod.Get,
            Endpoint(transport, $"v1/tasks/{Uri.EscapeDataString(runId)}/events?afterSeq={afterSeq}"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        Authorize(request, transport);
        HttpResponseMessage? response = null;
        try
        {
            response = await CreateClient().SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);
            if (response.IsSuccessStatusCode)
            {
                var stream = await response.Content.ReadAsStreamAsync(linked.Token);
                var session = new ServiceEventSession(request, response, stream);
                request = null!;
                response = null;
                return new OpenOutcome(session, null, null);
            }

            var status = (int)response.StatusCode;
            var text = await response.Content.ReadAsStringAsync(linked.Token);
            var error = TryParse(text)?["error"] as JsonObject;
            var code = ReadString(error, "code") ?? "unknown";
            if (status >= 500 && status != 503)
                return new OpenOutcome(null, null, new HttpRequestException($"HTTP {status} {code}"));
            return new OpenOutcome(null, status == 404 && code == "task_not_found"
                ? ServiceFailure(
                    "设计执行服务上已经查不到这次任务（多半是服务在任务进行中重启过）",
                    "本次生成的进度与结果都已丢失",
                    "重新发起一次；反复出现请管理员查看 design-opendesign 容器是否在反复重启",
                    ("transport", TransportLogName), ("status", status), ("code", code))
                : DescribeRejection(status, code, ReadString(error, "message"), transport), null);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new OpenOutcome(null, null, new TimeoutException("events request timed out"));
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            return new OpenOutcome(null, null, ex);
        }
        finally
        {
            response?.Dispose();
            request?.Dispose();
        }
    }

    internal sealed record ServiceTaskEvent(long Seq, string Type, string PayloadJson, int Attempt);

    private sealed record ReadOutcome(ServiceTaskEvent? Event, Exception? Error);

    /// <summary>一条 SSE 长连接。服务每条事件的 data 是整条事件（seq / type / payload / attempt）。</summary>
    private sealed class ServiceEventSession : IDisposable
    {
        private readonly HttpRequestMessage _request;
        private readonly HttpResponseMessage _response;
        private readonly StreamReader _reader;

        internal ServiceEventSession(HttpRequestMessage request, HttpResponseMessage response, Stream stream)
        {
            _request = request;
            _response = response;
            _reader = new StreamReader(stream, Encoding.UTF8);
        }

        /// <summary>读下一条业务事件；连接结束、空闲超时或断开时返回无事件（附原因），由调用方续读。</summary>
        internal async Task<ReadOutcome> ReadAsync(TimeSpan idleTimeout, CancellationToken ct)
        {
            string? eventName = null;
            var data = new StringBuilder();
            try
            {
                while (true)
                {
                    using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    idle.CancelAfter(idleTimeout);
                    var line = await _reader.ReadLineAsync(idle.Token);
                    if (line == null) return new ReadOutcome(null, null);
                    if (line.Length == 0)
                    {
                        if (data.Length > 0 && eventName != "keepalive")
                        {
                            var parsed = ParseEvent(data.ToString());
                            if (parsed != null) return new ReadOutcome(parsed, null);
                        }
                        eventName = null;
                        data.Clear();
                        continue;
                    }
                    if (line.StartsWith(':')) continue;
                    if (line.StartsWith("event:", StringComparison.Ordinal))
                        eventName = line[6..].Trim();
                    else if (line.StartsWith("data:", StringComparison.Ordinal))
                    {
                        if (data.Length > 0) data.Append('\n');
                        data.Append(line[5..].TrimStart());
                    }
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return new ReadOutcome(null, new TimeoutException("event stream idle"));
            }
            catch (Exception ex) when (ex is IOException or HttpRequestException or ObjectDisposedException)
            {
                return new ReadOutcome(null, ex);
            }
        }

        public void Dispose()
        {
            _reader.Dispose();
            _response.Dispose();
            _request.Dispose();
        }
    }

    internal static ServiceTaskEvent? ParseEvent(string data)
    {
        if (TryParse(data) is not { } root) return null;
        var type = ReadString(root, "type");
        if (string.IsNullOrWhiteSpace(type)) return null;
        var seq = root["seq"] is JsonValue seqValue && seqValue.TryGetValue<long>(out var parsedSeq) ? parsedSeq : 0;
        var attempt = root["attempt"] is JsonValue attemptValue && attemptValue.TryGetValue<int>(out var parsedAttempt)
            ? parsedAttempt
            : 1;
        var payload = root["payload"] is JsonObject payloadObject ? payloadObject.ToJsonString() : "{}";
        return new ServiceTaskEvent(seq, type, payload, attempt);
    }

    // ───────────────────────── 取消 ─────────────────────────

    private async Task CancelRemoteTaskAsync(OpenDesignTransportResolution transport, string runId)
    {
        if (transport.BaseUrl == null || transport.ApiKey == null) return;
        try
        {
            using var timeout = new CancellationTokenSource(CancelTimeout);
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                Endpoint(transport, $"v1/tasks/{Uri.EscapeDataString(runId)}/cancel"));
            Authorize(request, transport);
            using var response = await CreateClient().SendAsync(request, timeout.Token);
            _logger.LogInformation(
                "已请设计执行服务取消任务 transport=service run={RunId} status={Status}", runId, (int)response.StatusCode);
        }
        catch (Exception ex)
        {
            // 取消只是尽力而为：服务自己的 timeoutSeconds 到点也会停掉任务并清空目录。
            _logger.LogWarning(ex, "请设计执行服务取消任务失败，交由服务自身超时收尾 transport=service run={RunId}", runId);
        }
    }

    // ───────────────────────── 杂项 ─────────────────────────

    private HttpClient CreateClient() =>
        _httpClientFactory.CreateClient(OpenDesignTransportServiceCollectionExtensions.ServiceHttpClientName);

    private static Uri Endpoint(OpenDesignTransportResolution transport, string relative) =>
        new(new Uri(transport.BaseUrl!.ToString().TrimEnd('/') + "/"), relative);

    private static void Authorize(HttpRequestMessage request, OpenDesignTransportResolution transport) =>
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", transport.ApiKey);

    private static JsonObject? TryParse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        try
        {
            return JsonNode.Parse(text) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? ReadString(JsonObject? node, string field) =>
        node?[field] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static string? Truncate(string? value, int max) =>
        value == null ? null : value.Length <= max ? value : value[..max];
}
