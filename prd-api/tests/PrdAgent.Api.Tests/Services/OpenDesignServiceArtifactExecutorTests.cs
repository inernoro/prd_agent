using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// MAP 直连设计执行服务（map-design-executor-v1）的适配器：用一个按脚本回话的假服务
///（HttpMessageHandler 桩）断言事件流 → 执行器分片的映射、忙时排队重试、断线续读、取消与失败文案。
/// 服务端契约取自 design-runtime/opendesign/src/http/server.ts 与 tasks.ts。
/// </summary>
public sealed class OpenDesignServiceArtifactExecutorTests
{
    private const string RunId = "0123456789abcdef0123456789abcdef";
    private const string BaseUrl = "http://design-opendesign:8093";
    private const string ApiKey = "internal-design-key";
    private const string IndexHtml = "<!doctype html><html><body>服务交回的页面</body></html>";

    // ───────────── 执行：事件映射 ─────────────

    [Fact]
    public async Task Success_MapsServiceEventsToChunksAndSubmitsTheSameTransferAsTheCdsPath()
    {
        var service = new FakeDesignService();
        service.OnSubmit(_ => Json(HttpStatusCode.Accepted, new JsonObject { ["task"] = TaskView("running") }));
        service.OnEvents(_ => Sse(
            Event(1, "status", new JsonObject { ["status"] = "creating", ["reason"] = "task_accepted", ["attempt"] = 1 }),
            Event(2, "status", new JsonObject { ["status"] = "running", ["reason"] = "open_design_running", ["elapsedSeconds"] = 3 }),
            Event(3, "text_delta", new JsonObject { ["text"] = "OpenDesign 正在修改共享工作区。" }),
            Event(4, "done", new JsonObject { ["artifactRef"] = "ref-1", ["resultSha256"] = new string('b', 64) })));
        var broker = BuildBroker();
        var executor = BuildExecutor(service, broker.Object);

        var chunks = await CollectAsync(executor, BuildRun());

        // 服务接单的第一条事件（task_accepted）就要让进度动起来，而不是等到引擎开跑。
        chunks.First().Type.ShouldBe("phase");
        chunks.ShouldContain(chunk => chunk.Type == "phase" && chunk.Progress.HasValue);
        chunks.ShouldContain(chunk => chunk.Type == "thinking" && chunk.Content == "OpenDesign 正在修改共享工作区。");
        var delta = chunks.Single(chunk => chunk.Type == "delta");
        delta.Content.ShouldBe(IndexHtml);

        var submit = service.Submissions.ShouldHaveSingleItem();
        submit.Authorization.ShouldBe($"Bearer {ApiKey}");
        submit.Body!["taskId"]!.GetValue<string>().ShouldBe(RunId);
        submit.Body["attempt"]!.GetValue<int>().ShouldBe(1);
        submit.Body["transfer"]!["transferToken"]!.GetValue<string>().ShouldBe("transfer-token");
        submit.Body["transfer"]!["inputPackageUrl"]!.GetValue<string>().ShouldBe("https://map.example/api/design-artifacts/runtime/r/workspace/input");
        submit.Body["model"]!["baseUrl"]!.GetValue<string>().ShouldBe("https://map.example/api/design-artifacts/runtime/r/llm/v1");
        submit.Body["model"]!["apiKey"]!.GetValue<string>().ShouldBe("model-ticket");
        submit.Body["model"]!["protocol"]!.GetValue<string>().ShouldBe("openai");
        submit.Body["envelope"]!["runId"]!.GetValue<string>().ShouldBe(RunId);
        submit.Body["envelope"]!["schemaVersion"]!.GetValue<string>().ShouldBe("map-design-artifact-command-v2");
        service.EventRequests.ShouldHaveSingleItem().Accept.ShouldContain("text/event-stream");
        // 拿到终态就不该再去取消它。
        service.CancelCalls.ShouldBe(0);
    }

    [Fact]
    public async Task ErrorEvent_FailsWithTheSharedOpenDesignFailureMessage()
    {
        var service = new FakeDesignService();
        service.OnSubmit(_ => Json(HttpStatusCode.Accepted, new JsonObject { ["task"] = TaskView("running") }));
        service.OnEvents(_ => Sse(
            Event(1, "status", new JsonObject { ["status"] = "creating", ["reason"] = "task_accepted" }),
            Event(2, "error", new JsonObject
            {
                ["code"] = "design_output_quality_rejected",
                ["message"] = "quality gate rejected index.html",
                ["retryable"] = false,
            })));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var error = await Should.ThrowAsync<InvalidOperationException>(() => CollectAsync(executor, BuildRun()));

        error.Message.ShouldContain("没有通过发布前的校验");
        // 远端原文不进用户读的那句话，挂在异常链里进日志（与 CDS 路径同一口径）。
        error.Message.ShouldNotContain("quality gate rejected");
        error.InnerException.ShouldNotBeNull();
        service.CancelCalls.ShouldBe(0);
    }

    [Fact]
    public async Task ExecutorBusy_ShowsAQueueLineWaitsTheAdvisedSecondsAndResubmitsTheSameAttempt()
    {
        var service = new FakeDesignService();
        var submissions = 0;
        service.OnSubmit(_ => ++submissions == 1
            ? Json((HttpStatusCode)409, new JsonObject
            {
                ["error"] = new JsonObject
                {
                    ["code"] = "executor_busy",
                    ["message"] = "本服务正在执行另一个设计任务",
                    ["retryable"] = true,
                    ["details"] = new JsonObject { ["code"] = "executor_busy", ["slot"] = "running" },
                },
                ["retryAfterSeconds"] = 15,
            })
            : Json(HttpStatusCode.Accepted, new JsonObject { ["task"] = TaskView("running") }));
        service.OnEvents(_ => Sse(Event(1, "done", new JsonObject { ["artifactRef"] = "ref-1" })));
        var delays = new List<TimeSpan>();
        var executor = BuildExecutor(service, BuildBroker().Object, delays);

        var chunks = await CollectAsync(executor, BuildRun());

        var queueLine = chunks.First(chunk => chunk.Type == "phase");
        queueLine.Content.ShouldContain("设计执行服务正在处理另一个任务，约 15 秒后重试");
        queueLine.Progress.ShouldNotBeNull("排队提示也要带进度，worker 才会把它写成可见阶段");
        delays.ShouldContain(TimeSpan.FromSeconds(15));
        service.Submissions.Count.ShouldBe(2);
        service.Submissions[1].Body!["attempt"]!.GetValue<int>().ShouldBe(1);
        service.Submissions[1].Body!.ToJsonString().ShouldBe(service.Submissions[0].Body!.ToJsonString());
        chunks.ShouldContain(chunk => chunk.Type == "delta");
    }

    [Fact]
    public async Task StreamDisconnect_ResumesFromTheLastSeenSequence()
    {
        var service = new FakeDesignService();
        service.OnSubmit(_ => Json(HttpStatusCode.Accepted, new JsonObject { ["task"] = TaskView("running") }));
        var opens = 0;
        service.OnEvents(_ => ++opens == 1
            // 第一条连接送了两条事件就断了，没有终态。
            ? Sse(
                Event(1, "status", new JsonObject { ["status"] = "creating", ["reason"] = "task_accepted" }),
                Event(2, "text_delta", new JsonObject { ["text"] = "第一段" }))
            : Sse(
                Event(3, "text_delta", new JsonObject { ["text"] = "第二段" }),
                Event(4, "done", new JsonObject { ["artifactRef"] = "ref-1" })));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var chunks = await CollectAsync(executor, BuildRun());

        service.EventRequests.Count.ShouldBe(2);
        service.EventRequests[0].AfterSeq.ShouldBe("0");
        service.EventRequests[1].AfterSeq.ShouldBe("2");
        chunks.Where(chunk => chunk.Type == "thinking").Select(chunk => chunk.Content).ShouldBe(["第一段", "第二段"]);
        chunks.ShouldContain(chunk => chunk.Type == "delta");
    }

    [Fact]
    public async Task EventsFromAnEarlierAttemptAreIgnored()
    {
        var service = new FakeDesignService();
        service.OnSubmit(_ => Json(HttpStatusCode.OK, new JsonObject { ["task"] = TaskView("running"), ["replayed"] = true }));
        service.OnEvents(_ => Sse(
            Event(1, "error", new JsonObject { ["code"] = "open_design_engine_exited", ["message"] = "old" }, attempt: 0),
            Event(2, "done", new JsonObject { ["artifactRef"] = "ref-1" })));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var chunks = await CollectAsync(executor, BuildRun());

        chunks.ShouldContain(chunk => chunk.Type == "delta");
    }

    [Fact]
    public async Task MapCancellation_AsksTheServiceToCancelTheTask()
    {
        var service = new FakeDesignService();
        service.OnSubmit(_ => Json(HttpStatusCode.Accepted, new JsonObject { ["task"] = TaskView("running") }));
        service.OnEvents(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StreamContent(new FirstThenHangStream(Encoding.UTF8.GetBytes(Event(1, "text_delta",
                new JsonObject { ["text"] = "正在设计" })))),
        });
        var executor = BuildExecutor(service, BuildBroker().Object);
        using var cts = new CancellationTokenSource();

        await Should.ThrowAsync<OperationCanceledException>(async () =>
        {
            await foreach (var chunk in executor.ExecuteAsync(BuildRun(), null, cts.Token))
            {
                if (chunk.Type == "thinking") cts.Cancel();
            }
        });

        service.CancelCalls.ShouldBe(1);
        service.CancelAuthorization.ShouldBe($"Bearer {ApiKey}");
    }

    [Fact]
    public async Task CancellationWhileSubmissionIsInFlight_StillAsksTheServiceToCancel()
    {
        // 服务已经收到提交（可能已接单），MAP 却在拿到 202 之前被取消：
        // 不发取消，服务唯一的执行位就会被一个已被放弃的任务白占到超时。
        var service = new FakeDesignService();
        using var cts = new CancellationTokenSource();
        service.OnSubmit(_ =>
        {
            cts.Cancel();
            throw new TaskCanceledException("MAP 在提交响应到达前被取消");
        });
        var executor = BuildExecutor(service, BuildBroker().Object);

        await Should.ThrowAsync<OperationCanceledException>(async () =>
        {
            await foreach (var _ in executor.ExecuteAsync(BuildRun(), null, cts.Token)) { }
        });

        service.Submissions.Count.ShouldBe(1);
        service.CancelCalls.ShouldBe(1);
        service.CancelAuthorization.ShouldBe($"Bearer {ApiKey}");
    }

    [Fact]
    public async Task Unauthorized_FailsWithExternalCauseFirstAndNeverFallsBackToCds()
    {
        var service = new FakeDesignService();
        service.OnSubmit(_ => Json(HttpStatusCode.Unauthorized, new JsonObject
        {
            ["error"] = new JsonObject { ["code"] = "unauthorized", ["message"] = "调用方（MAP）没有带正确的密钥", ["retryable"] = false },
        }));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var error = await Should.ThrowAsync<InvalidOperationException>(() => CollectAsync(executor, BuildRun()));

        // 用户读的那句只有外因、影响与下一步（worker 会把 Message 原样存成任务的用户可见错误）；
        // 传输面、HTTP 状态、协议码、服务原文、内部地址全部挂在异常链上进日志。
        error.Message.ShouldStartWith("网页生成失败：设计执行服务拒绝了 MAP 的内部调用凭据");
        error.Message.ShouldContain("下一步");
        AssertNoTransportDiagnostics(error.Message);
        var diagnostic = error.InnerException.ShouldBeOfType<OpenDesignRemoteDiagnosticException>();
        diagnostic.RemoteCode.ShouldBe("unauthorized");
        diagnostic.Diagnostic.ShouldContain("transport=service");
        diagnostic.Diagnostic.ShouldContain("status=401");
        diagnostic.Diagnostic.ShouldContain(BaseUrl.TrimEnd('/'));
        service.EventRequests.ShouldBeEmpty();
    }

    [Fact]
    public async Task ServiceRejectsWhenTransportConfigurationIsIncomplete()
    {
        var service = new FakeDesignService();
        var executor = BuildExecutor(service, BuildBroker().Object, configuration: new Dictionary<string, string?>
        {
            [OpenDesignTransportResolver.TransportKey] = "service",
            [OpenDesignTransportResolver.BaseUrlKey] = BaseUrl,
        });

        var error = await Should.ThrowAsync<InvalidOperationException>(() => CollectAsync(executor, BuildRun()));

        error.Message.ShouldStartWith("网页生成失败：OpenDesign 直连设计执行服务所需的部署配置不完整");
        AssertNoTransportDiagnostics(error.Message);
        error.Message.ShouldNotContain(OpenDesignTransportResolver.ApiKeyKey);
        error.InnerException.ShouldBeOfType<OpenDesignRemoteDiagnosticException>()
            .Diagnostic.ShouldContain(OpenDesignTransportResolver.ApiKeyKey);
        service.Submissions.ShouldBeEmpty();
    }

    [Fact]
    public async Task ConnectionLostDuringSubmission_ResubmitsTheSameTaskInsteadOfFailing()
    {
        // 请求可能已经到了服务、只是响应丢了：同一 taskId / attempt / 内容重交是幂等的，应当重试而不是判失败。
        var service = new FakeDesignService();
        var submissions = 0;
        service.OnSubmit(_ =>
        {
            submissions++;
            if (submissions == 1) throw new HttpRequestException("connection reset by peer");
            return Json(HttpStatusCode.OK, new JsonObject { ["task"] = TaskView("running"), ["replayed"] = true });
        });
        service.OnEvents(_ => Sse(Event(1, "done", new JsonObject { ["artifactRef"] = "ref" })));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var chunks = await CollectAsync(executor, BuildRun());

        service.Submissions.Count.ShouldBe(2);
        service.Submissions[1].Body!.ToJsonString().ShouldBe(service.Submissions[0].Body!.ToJsonString());
        chunks.ShouldContain(chunk => chunk.Type == "phase" && chunk.Content!.Contains("连接在提交时中断"));
        chunks.ShouldContain(chunk => chunk.Type == "delta");
        service.CancelCalls.ShouldBe(0);
    }

    [Fact]
    public async Task ServiceStaysUnreachable_FailsWithoutLeakingTransportDetails()
    {
        var service = new FakeDesignService();
        service.OnSubmit(_ => throw new HttpRequestException("connection refused"));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var error = await Should.ThrowAsync<InvalidOperationException>(() => CollectAsync(executor, BuildRun()));

        error.Message.ShouldStartWith("网页生成失败：设计执行服务在");
        AssertNoTransportDiagnostics(error.Message);
        error.InnerException.ShouldBeOfType<OpenDesignRemoteDiagnosticException>()
            .RemoteCode.ShouldBe("submit_connection_lost");
        service.Submissions.Count.ShouldBeGreaterThan(1);
    }

    private static void AssertNoTransportDiagnostics(string message)
    {
        foreach (var leaked in new[] { "transport=", "status=", "技术细节", "HTTP ", "http://", "https://", "design-opendesign", "DesignRuntime:" })
            message.ShouldNotContain(leaked);
    }

    // ───────────── 传输开关 ─────────────

    [Fact]
    public void Transport_BothAddressAndKeyConfigured_DefaultsToService()
    {
        var resolution = OpenDesignTransportResolver.Resolve(Config(new()
        {
            [OpenDesignTransportResolver.BaseUrlKey] = BaseUrl,
            [OpenDesignTransportResolver.ApiKeyKey] = ApiKey,
        }));

        resolution.Transport.ShouldBe(OpenDesignTransport.Service);
        resolution.Problem.ShouldBeNull();
        resolution.BaseUrl!.ToString().ShouldStartWith(BaseUrl);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("${DESIGN_RUNTIME_API_KEY}")] // 部署平台没替换掉的占位符等于没配
    public void Transport_MissingKey_DefaultsToCdsSession(string? apiKey)
    {
        var resolution = OpenDesignTransportResolver.Resolve(Config(new()
        {
            [OpenDesignTransportResolver.BaseUrlKey] = BaseUrl,
            [OpenDesignTransportResolver.ApiKeyKey] = apiKey,
        }));

        resolution.Transport.ShouldBe(OpenDesignTransport.CdsSession);
        resolution.Problem.ShouldBeNull();
    }

    [Fact]
    public void Transport_ExplicitCdsSessionWinsEvenWhenServiceIsConfigured()
    {
        var resolution = OpenDesignTransportResolver.Resolve(Config(new()
        {
            [OpenDesignTransportResolver.TransportKey] = "cds-session",
            [OpenDesignTransportResolver.BaseUrlKey] = BaseUrl,
            [OpenDesignTransportResolver.ApiKeyKey] = ApiKey,
        }));

        resolution.Transport.ShouldBe(OpenDesignTransport.CdsSession);
    }

    [Theory]
    [InlineData("service")]
    [InlineData("grpc")]
    public void Transport_ExplicitServiceOrUnknownValueNeverSilentlyFallsBack(string transport)
    {
        var resolution = OpenDesignTransportResolver.Resolve(Config(new()
        {
            [OpenDesignTransportResolver.TransportKey] = transport,
        }));

        resolution.Transport.ShouldBe(OpenDesignTransport.Service);
        resolution.Problem.ShouldNotBeNull();
    }

    [Theory]
    [InlineData(true, typeof(OpenDesignServiceArtifactExecutor))]
    [InlineData(false, typeof(OpenDesignRemoteArtifactExecutor))]
    public void Transport_DiRegistersExactlyTheSelectedExecutorAsOpenDesign(bool serviceConfigured, Type expected)
    {
        var settings = new Dictionary<string, string?>
        {
            [OpenDesignTransportResolver.BaseUrlKey] = BaseUrl,
            [OpenDesignTransportResolver.ApiKeyKey] = serviceConfigured ? ApiKey : null,
        };
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IConfiguration>(Config(settings));
        services.AddSingleton(Mock.Of<IInfraConnectionService>());
        services.AddSingleton(Mock.Of<IInfraAgentSessionService>());
        services.AddSingleton(Mock.Of<IDesignArtifactWorkspaceBroker>());
        services.AddOpenDesignExecutors();
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();

        var executors = scope.ServiceProvider.GetServices<IDesignArtifactExecutor>().ToList();
        var probes = scope.ServiceProvider.GetServices<IDesignArtifactProviderProbe>().ToList();

        var executor = executors.ShouldHaveSingleItem().ShouldBeOfType<OpenDesignSelectedExecutor>();
        executor.Runtime.ShouldBe(DesignArtifactRuntimes.OpenDesign);
        executor.Selected.ShouldBeOfType(expected);
        probes.ShouldHaveSingleItem().ShouldBeOfType<OpenDesignSelectedExecutor>().Selected.ShouldBeOfType(expected);
    }

    // ───────────── 能力探针 ─────────────

    [Fact]
    public void Probe_HealthyButBusyStaysEnabled()
    {
        var result = OpenDesignServiceArtifactExecutor.MapCapabilities(
            """{"protocol":"map-design-executor-v1","healthy":true,"busy":true,"acceptingTasks":false,"state":"running","reason":null,"conditions":[]}""",
            new Uri(BaseUrl)).Result;

        result.Enabled.ShouldBeTrue();
        result.Healthy.ShouldBeTrue();
        result.Reason.ShouldBeNull();
    }

    [Fact]
    public void Probe_UnhealthyIsDisabled_UserSeesPlainReason_DiagnosticKeepsTheServicesOwn()
    {
        var verdict = OpenDesignServiceArtifactExecutor.MapCapabilities(
            """{"protocol":"map-design-executor-v1","healthy":false,"busy":false,"acceptingTasks":false,"state":"blocked","reason":{"code":"workspace_reset_failed","message":"本服务在上一个任务结束后清空工作目录失败"}}""",
            new Uri(BaseUrl));

        var result = verdict.Result;
        result.Enabled.ShouldBeFalse();
        result.Configured.ShouldBeTrue();
        // 能力原因经公开接口交给普通用户：只说结果与下一步，服务原文、错误码与内部地址只进日志。
        result.Reason!.ShouldStartWith("设计执行服务自报暂不可用");
        AssertNoTransportDiagnostics(result.Reason);
        result.Reason.ShouldNotContain("workspace_reset_failed");
        verdict.Diagnostic!.ShouldContain("workspace_reset_failed");
        verdict.Diagnostic!.ShouldContain("本服务在上一个任务结束后清空工作目录失败");
    }

    [Fact]
    public void Probe_WrongProtocolIsDisabled()
    {
        var verdict = OpenDesignServiceArtifactExecutor.MapCapabilities(
            """{"protocol":"map-design-executor-v2","healthy":true}""",
            new Uri(BaseUrl));

        verdict.Result.Enabled.ShouldBeFalse();
        verdict.Result.Reason!.ShouldContain("版本不一致");
        AssertNoTransportDiagnostics(verdict.Result.Reason!);
        verdict.Result.Reason.ShouldNotContain("map-design-executor");
        verdict.Diagnostic!.ShouldContain("map-design-executor-v2");
    }

    [Fact]
    public async Task Probe_CallsCapabilitiesAnonymouslyAndMapsTheAnswer()
    {
        var service = new FakeDesignService();
        service.OnCapabilities(() => Json(HttpStatusCode.OK, new JsonObject
        {
            ["protocol"] = "map-design-executor-v1",
            ["healthy"] = true,
            ["busy"] = false,
            ["acceptingTasks"] = true,
        }));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        result.Enabled.ShouldBeTrue();
        service.CapabilityAuthorization.ShouldBeNull("查能力是匿名接口，探针不该带密钥");
    }

    [Fact]
    public async Task Probe_MissingConfigurationIsNotConfigured()
    {
        var executor = BuildExecutor(new FakeDesignService(), BuildBroker().Object, configuration: new Dictionary<string, string?>
        {
            [OpenDesignTransportResolver.TransportKey] = "service",
        });

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        result.Configured.ShouldBeFalse();
        result.Enabled.ShouldBeFalse();
        result.Reason!.ShouldContain("部署配置不完整");
        AssertNoTransportDiagnostics(result.Reason!);
    }

    [Fact]
    public async Task Probe_NonSuccessCapabilitiesDoesNotLeakStatusOrAddress()
    {
        var service = new FakeDesignService();
        service.OnCapabilities(() => new HttpResponseMessage(HttpStatusCode.BadGateway));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var result = await executor.ProbeAsync("user-1", CancellationToken.None);

        result.Enabled.ShouldBeFalse();
        result.Reason!.ShouldStartWith("设计执行服务暂时回报不了自身状态");
        AssertNoTransportDiagnostics(result.Reason);
        result.Reason.ShouldNotContain("502");
    }

    [Fact]
    public async Task RetryableServerError_IsResubmittedInsteadOfFailingTheRun()
    {
        // 服务顶层处理器兜底返回 500 + retryable: true：同一任务幂等重交，而不是当场判失败。
        var service = new FakeDesignService();
        var submissions = 0;
        service.OnSubmit(_ => ++submissions == 1
            ? Json(HttpStatusCode.InternalServerError, new JsonObject
            {
                ["error"] = new JsonObject { ["code"] = "internal_error", ["message"] = "unexpected", ["retryable"] = true },
            })
            : Json(HttpStatusCode.Accepted, new JsonObject { ["task"] = TaskView("running") }));
        service.OnEvents(_ => Sse(Event(1, "done", new JsonObject { ["artifactRef"] = "ref" })));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var chunks = await CollectAsync(executor, BuildRun());

        service.Submissions.Count.ShouldBe(2);
        chunks.ShouldContain(chunk => chunk.Type == "phase" && chunk.Content!.Contains("暂时不能接单"));
        chunks.ShouldContain(chunk => chunk.Type == "delta");
    }

    [Fact]
    public async Task NonRetryableServerError_StillFailsWithoutLeakingDetails()
    {
        var service = new FakeDesignService();
        service.OnSubmit(_ => Json(HttpStatusCode.InternalServerError, new JsonObject
        {
            ["error"] = new JsonObject { ["code"] = "internal_error", ["message"] = "boom", ["retryable"] = false },
        }));
        var executor = BuildExecutor(service, BuildBroker().Object);

        var error = await Should.ThrowAsync<InvalidOperationException>(() => CollectAsync(executor, BuildRun()));

        service.Submissions.Count.ShouldBe(1);
        AssertNoTransportDiagnostics(error.Message);
    }

    // ───────────── 夹具 ─────────────

    private static IConfiguration Config(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    private static OpenDesignServiceArtifactExecutor BuildExecutor(
        FakeDesignService service,
        IDesignArtifactWorkspaceBroker broker,
        List<TimeSpan>? delays = null,
        Dictionary<string, string?>? configuration = null)
    {
        // 假时钟：每次「等待」立即返回并把时钟往前推，排队 / 不可用的截止时间按它算，
        // 用例既不真等、也不会在真实时间里空转到上限。
        var now = DateTime.UtcNow;
        return new(
            new SingleClientFactory(service),
            broker,
            Config(configuration ?? new Dictionary<string, string?>
            {
                [OpenDesignTransportResolver.BaseUrlKey] = BaseUrl,
                [OpenDesignTransportResolver.ApiKeyKey] = ApiKey,
            }),
            NullLogger<OpenDesignServiceArtifactExecutor>.Instance)
        {
            Delay = (wait, ct) =>
            {
                delays?.Add(wait);
                ct.ThrowIfCancellationRequested();
                now += wait;
                return Task.CompletedTask;
            },
            UtcNow = () => now,
        };
    }

    private static Mock<IDesignArtifactWorkspaceBroker> BuildBroker()
    {
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(x => x.PrepareAsync(It.IsAny<DesignArtifactRun>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((DesignArtifactRun run, string? _, CancellationToken _) =>
            {
                run.RuntimeTicketExpiresAt = DateTime.UtcNow.AddMinutes(25);
                return new PreparedDesignArtifactWorkspace(
                    "https://map.example/api/design-artifacts/runtime/r/workspace/input",
                    new string('a', 64),
                    "https://map.example/api/design-artifacts/runtime/r/workspace/result",
                    "transfer-token",
                    "https://map.example/api/design-artifacts/runtime/r/llm/v1",
                    "model-ticket",
                    "map-managed",
                    "revision-1",
                    1024 * 1024,
                    6 * 1024 * 1024,
                    ["index.html", "manifest.json", "assets/**"]);
            });
        broker.Setup(x => x.ReadResultAsync(RunId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ParsedDesignWorkspaceResult(IndexHtml, Array.Empty<DesignWorkspaceFile>()));
        return broker;
    }

    private static DesignArtifactRun BuildRun() => new()
    {
        Id = RunId,
        UserId = "user-1",
        Status = RunStatuses.Running,
        Runtime = DesignArtifactRuntimes.OpenDesign,
        ArtifactType = DesignArtifactTypes.WebPage,
        Operation = DesignArtifactOperations.Generate,
        Instruction = "做一个页面",
        Progress = 18,
    };

    private static async Task<List<DesignArtifactExecutorChunk>> CollectAsync(
        OpenDesignServiceArtifactExecutor executor,
        DesignArtifactRun run)
    {
        var chunks = new List<DesignArtifactExecutorChunk>();
        await foreach (var chunk in executor.ExecuteAsync(run, null, CancellationToken.None))
            chunks.Add(chunk);
        return chunks;
    }

    private static JsonObject TaskView(string state) => new()
    {
        ["taskId"] = RunId,
        ["attempt"] = 1,
        ["state"] = state,
        ["lastSeq"] = 1,
        ["cleanup"] = "pending",
    };

    private static string Event(long seq, string type, JsonObject payload, int attempt = 1) =>
        $"id: {seq}\nevent: {type}\ndata: " + new JsonObject
        {
            ["seq"] = seq,
            ["type"] = type,
            ["payload"] = payload,
            ["createdAt"] = "2026-09-25T00:00:00.000Z",
            ["attempt"] = attempt,
        }.ToJsonString() + "\n\n";

    private static HttpResponseMessage Sse(params string[] events) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(
            ": comment\n\nevent: keepalive\ndata: {\"ts\":\"x\"}\n\n" + string.Concat(events),
            Encoding.UTF8,
            "text/event-stream"),
    };

    private static HttpResponseMessage Json(HttpStatusCode status, JsonObject body) => new(status)
    {
        Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
    };

    internal sealed record Submission(JsonObject? Body, string? Authorization);

    internal sealed record EventsRequest(string? AfterSeq, string Accept);

    /// <summary>按路径回话的假设计执行服务。</summary>
    private sealed class FakeDesignService : HttpMessageHandler
    {
        private Func<JsonObject?, HttpResponseMessage> _submit = _ => new HttpResponseMessage(HttpStatusCode.NotImplemented);
        private Func<string?, HttpResponseMessage> _events = _ => new HttpResponseMessage(HttpStatusCode.NotImplemented);
        private Func<HttpResponseMessage> _capabilities = () => new HttpResponseMessage(HttpStatusCode.NotImplemented);

        public List<Submission> Submissions { get; } = new();
        public List<EventsRequest> EventRequests { get; } = new();
        public int CancelCalls { get; private set; }
        public string? CancelAuthorization { get; private set; }
        public string? CapabilityAuthorization { get; private set; } = "not-called";

        public void OnSubmit(Func<JsonObject?, HttpResponseMessage> respond) => _submit = respond;
        public void OnEvents(Func<string?, HttpResponseMessage> respond) => _events = respond;
        public void OnCapabilities(Func<HttpResponseMessage> respond) => _capabilities = respond;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath;
            var authorization = request.Headers.Authorization?.ToString();
            if (request.Method == HttpMethod.Get && path == "/v1/capabilities")
            {
                CapabilityAuthorization = authorization;
                return _capabilities();
            }
            if (request.Method == HttpMethod.Post && path == "/v1/tasks")
            {
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct)) as JsonObject;
                Submissions.Add(new Submission(body, authorization));
                return _submit(body);
            }
            if (request.Method == HttpMethod.Get && path == $"/v1/tasks/{RunId}/events")
            {
                var query = request.RequestUri.Query.TrimStart('?').Split('&')
                    .Select(part => part.Split('='))
                    .Where(pair => pair.Length == 2)
                    .ToDictionary(pair => pair[0], pair => pair[1]);
                var afterSeq = query.GetValueOrDefault("afterSeq");
                EventRequests.Add(new EventsRequest(afterSeq, string.Join(",", request.Headers.Accept.Select(item => item.MediaType))));
                return _events(afterSeq);
            }
            if (request.Method == HttpMethod.Post && path == $"/v1/tasks/{RunId}/cancel")
            {
                CancelCalls++;
                CancelAuthorization = authorization;
                return Json(HttpStatusCode.OK, new JsonObject { ["task"] = TaskView("cancelled") });
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }
    }

    private sealed class SingleClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    /// <summary>先给一段字节，之后一直挂着，直到读取被取消——模拟一条还在跑的 SSE 长连接。</summary>
    private sealed class FirstThenHangStream(byte[] first) : Stream
    {
        private bool _sent;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (!_sent)
            {
                _sent = true;
                first.CopyTo(buffer);
                return first.Length;
            }
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
