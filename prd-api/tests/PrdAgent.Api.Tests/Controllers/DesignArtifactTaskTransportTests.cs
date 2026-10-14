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
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class DesignArtifactTaskTransportTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ValidRuntimeTicket_RestoresOnlyPersistedTaskPermitBeforeGateway(bool responses)
    {
        var run = Run("0123456789abcdef0123456789abcdef");
        var authorizer = new RunAuthorizer(run);
        var (controller, transport) = Build(run, authorizer);
        controller.Request.Headers["X-Gateway-Task-Permit"] = "forged-by-runtime";
        using var outer = TaskExecutionContext.Enter(new TaskExecutionIdentity("outer-task"));
        if (responses) await controller.ProxyResponses(run.Id, CancellationToken.None);
        else await controller.ProxyChatCompletions(run.Id, CancellationToken.None);
        Assert.Equal(200, controller.Response.StatusCode);
        Assert.Equal(1, transport.Sends);
        Assert.Equal(1, authorizer.Calls);
        Assert.Equal(run.TaskPermitId, transport.Permit);
        Assert.Equal(run.Id, transport.RunId);
        Assert.Equal(run.UserId, transport.UserId);
        Assert.Equal("outer-task", TaskExecutionContext.Current!.PermitId);
    }

    [Fact]
    public async Task LegacyRunWithoutPersistedPermit_CannotUseRuntimeTicketToMintModelAdmission()
    {
        var run = Run(null);
        var (controller, transport) = Build(run, new RunAuthorizer(run));
        await controller.ProxyChatCompletions(run.Id, CancellationToken.None);
        Assert.Equal(403, controller.Response.StatusCode);
        Assert.Equal(0, transport.Sends);
    }

    [Fact]
    public async Task MissingAuthorizer_StopsRuntimeProxyBeforeNetwork()
    {
        var (controller, transport) = Build(Run("0123456789abcdef0123456789abcdef"), null);
        await controller.ProxyResponses("run-model", CancellationToken.None);
        Assert.Equal(403, controller.Response.StatusCode);
        Assert.Equal(0, transport.Sends);
    }

    private static DesignArtifactRun Run(string? permit) => new()
    {
        Id = "run-model", UserId = "owner", TaskPermitId = permit, Status = RunStatuses.Running,
        Runtime = DesignArtifactRuntimes.OpenDesign, Operation = DesignArtifactOperations.Generate,
        RuntimeTicketExpiresAt = DateTime.UtcNow.AddMinutes(5),
    };

    private static (DesignArtifactRuntimeController, Transport) Build(DesignArtifactRun run, ITaskExecutionAuthorizer? authorizer)
    {
        var broker = new Mock<IDesignArtifactWorkspaceBroker>();
        broker.Setup(x => x.ValidateModelTicketAsync(run.Id, "valid-ticket", It.IsAny<CancellationToken>())).ReturnsAsync(run);
        broker.Setup(x => x.ReserveModelCallAsync(run.Id, "valid-ticket", It.IsAny<CancellationToken>())).ReturnsAsync(run);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "https://gateway.invalid",
            ["LlmGwServe:ApiKey"] = "internal-key",
            ["DesignArtifactRuntime:Model"] = "future-model",
        }).Build();
        var transport = new Transport();
        var controller = new DesignArtifactRuntimeController(broker.Object, transport, config,
            NullLogger<DesignArtifactRuntimeController>.Instance, taskAuthorizer: authorizer)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
        var bytes = Encoding.UTF8.GetBytes("{\"messages\":[],\"input\":\"test\",\"model\":\"future-model\"}");
        controller.Request.Body = new MemoryStream(bytes);
        controller.Request.ContentLength = bytes.Length;
        controller.Request.Headers.Authorization = "Bearer valid-ticket";
        controller.Response.Body = new MemoryStream();
        return (controller, transport);
    }

    private sealed class RunAuthorizer(DesignArtifactRun run) : ITaskExecutionAuthorizer
    {
        public int Calls { get; private set; }
        public Task AuthorizeOutboundAsync(HttpRequestMessage message, string caller, GatewayRequestContext? context, CancellationToken ct)
        {
            Calls++;
            var identity = TaskExecutionContext.Current;
            if (run.TaskPermitId is null || identity?.PermitId != run.TaskPermitId || identity.RunId != run.Id)
                throw new TaskExecutionAdmissionException("TASK_EXECUTION_NOT_ADMITTED", "任务未获得执行许可，请重新发起。");
            Assert.Equal(run.UserId, context!.UserId);
            message.Headers.Add("X-Gateway-Task-Permit", run.TaskPermitId);
            return Task.CompletedTask;
        }
    }

    private sealed class Transport : HttpMessageHandler, IHttpClientFactory
    {
        public int Sends { get; private set; }
        public string? Permit { get; private set; }
        public string? RunId { get; private set; }
        public string? UserId { get; private set; }
        public HttpClient CreateClient(string name)
        {
            Assert.Equal(AuthorizedGatewayRequest.HttpClientName, name);
            return new(new MapModelEgressHandler(name, new Uri("https://gateway.invalid")) { InnerHandler = this });
        }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Sends++;
            Permit = request.Headers.GetValues("X-Gateway-Task-Permit").Single();
            RunId = request.Headers.GetValues("X-Gateway-Run-Id").Single();
            UserId = request.Headers.GetValues("X-Gateway-User-Id").Single();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") });
        }
    }
}
