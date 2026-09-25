using System.Net;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 「面板上显示的模型 = 网关实际回答用的模型」：OpenDesign 在执行服务里调模型，MAP 的执行器收不到网关的
/// Start 分片，只有运行时模型代理看得见网关响应。这里断言代理从响应里读出 model、只在值变化时写一次 run，
/// 并推一条 model 事件（生成流与修改流都从同一个 RunKinds.DesignArtifact 事件流读它）。
/// </summary>
public sealed class DesignArtifactRuntimeServedModelTests
{
    private const string RunId = "run-served-model";

    [Fact]
    public async Task StreamingResponse_PersistsTheGatewayModelOnceAndPushesAModelEvent()
    {
        var sse = string.Concat(
            "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5.1-actual\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5.1-actual\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: [DONE]\n\n");
        var (broker, events, controller) = Build(sse, "text/event-stream", resolvedModel: null);

        await controller.ProxyChatCompletions(RunId, CancellationToken.None);

        controller.Response.StatusCode.ShouldBe(StatusCodes.Status200OK);
        broker.Verify(x => x.RecordServedModelAsync(RunId, "gpt-5.1-actual", null, It.IsAny<CancellationToken>()), Times.Once);
        events.Verify(x => x.AppendEventAsync(
            RunKinds.DesignArtifact, RunId, "model", It.IsAny<object>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()), Times.Once);
        // 旁路观察不改变转发给执行器的字节。
        controller.Response.Body.Position = 0;
        (await new StreamReader(controller.Response.Body).ReadToEndAsync()).ShouldBe(sse);
    }

    [Fact]
    public async Task ResponsesStream_ReadsTheModelFromTheWrappedResponseObject()
    {
        var sse = string.Concat(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"model\":\"gpt-5-codex-served\"}}\n\n");
        var (broker, _, controller) = Build(sse, "text/event-stream", resolvedModel: null);

        await controller.ProxyResponses(RunId, CancellationToken.None);

        broker.Verify(x => x.RecordServedModelAsync(RunId, "gpt-5-codex-served", null, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task JsonResponse_ReadsTheTopLevelModel()
    {
        var (broker, _, controller) = Build(
            "{\"id\":\"c1\",\"object\":\"chat.completion\",\"model\":\"claude-served\",\"choices\":[]}",
            "application/json",
            resolvedModel: null);

        await controller.ProxyChatCompletions(RunId, CancellationToken.None);

        broker.Verify(x => x.RecordServedModelAsync(RunId, "claude-served", null, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task SameModelAsAlreadyRecorded_DoesNotWriteAgain()
    {
        var (broker, events, controller) = Build(
            "data: {\"model\":\"gpt-5.1-actual\"}\n\n",
            "text/event-stream",
            resolvedModel: "gpt-5.1-actual");

        await controller.ProxyChatCompletions(RunId, CancellationToken.None);

        broker.Verify(x => x.RecordServedModelAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
        events.Verify(x => x.AppendEventAsync(
            It.IsAny<string>(), It.IsAny<string>(), "model", It.IsAny<object>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData("data: {\"model\":\"auto\",\"choices\":[]}\n\n")]
    [InlineData("data: {\"choices\":[{\"delta\":{\"content\":\"\\\"model\\\":\\\"fake\\\"\"}}]}\n\n")]
    public async Task NoTrustworthyModel_KeepsCurrentBehaviourAndInventsNothing(string sse)
    {
        var (broker, _, controller) = Build(sse, "text/event-stream", resolvedModel: null);

        await controller.ProxyChatCompletions(RunId, CancellationToken.None);

        broker.Verify(x => x.RecordServedModelAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public void Sniffer_FindsTheModelAcrossChunkBoundaries()
    {
        var bytes = Encoding.UTF8.GetBytes("data: {\"object\":\"chat.completion.chunk\",\"model\":\"split-model\"}\n\n");
        var sniffer = new DesignRuntimeServedModelSniffer(eventStream: true);
        string? found = null;
        foreach (var piece in bytes.Chunk(7))
            found ??= sniffer.Observe(piece);

        found.ShouldBe("split-model");
        sniffer.Model.ShouldBe("split-model");
    }

    private static (Mock<IDesignArtifactWorkspaceBroker> Broker, Mock<IRunEventStore> Events, DesignArtifactRuntimeController Controller) Build(
        string upstreamBody,
        string upstreamMediaType,
        string? resolvedModel)
    {
        var run = new DesignArtifactRun
        {
            Id = RunId,
            UserId = "user-1",
            Status = RunStatuses.Running,
            Runtime = DesignArtifactRuntimes.OpenDesign,
            Operation = DesignArtifactOperations.Generate,
            ResolvedModel = resolvedModel,
            RuntimeTicketExpiresAt = DateTime.UtcNow.AddMinutes(10),
        };
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(x => x.ValidateModelTicketAsync(RunId, "model-ticket", It.IsAny<CancellationToken>())).ReturnsAsync(run);
        broker.Setup(x => x.ReserveModelCallAsync(RunId, "model-ticket", It.IsAny<CancellationToken>())).ReturnsAsync(run);
        broker.Setup(x => x.RecordServedModelAsync(RunId, It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(true);
        var events = new Mock<IRunEventStore>(MockBehavior.Loose);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve:8091",
            ["LlmGwServe:ApiKey"] = "gateway-secret",
            ["DesignArtifactRuntime:Model"] = "default-chat-curated",
        }).Build();
        var controller = new DesignArtifactRuntimeController(
            broker.Object,
            new FixedResponseFactory(upstreamBody, upstreamMediaType),
            configuration,
            NullLogger<DesignArtifactRuntimeController>.Instance,
            events.Object)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var requestBytes = Encoding.UTF8.GetBytes(
            "{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}],\"input\":\"hello\",\"stream\":true}");
        controller.Request.Body = new MemoryStream(requestBytes);
        controller.Request.ContentLength = requestBytes.Length;
        controller.Request.Headers.Authorization = "Bearer model-ticket";
        controller.Response.Body = new MemoryStream();
        return (broker, events, controller);
    }

    private sealed class FixedResponseFactory(string body, string mediaType) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new Handler(body, mediaType));

        private sealed class Handler(string body, string mediaType) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
                Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(body, Encoding.UTF8, mediaType),
                });
        }
    }
}
