using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services.ClaudeSidecar;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class SidecarAuthorizationTests
{
    private readonly Mock<ITaskExecutionCoordinator> _coordinator = new();
    private readonly TaskContinuationTokens _tokens;
    private readonly TaskExecutionIdentity _identity = new("permit", "task",
        new TaskExecutionLeaseProof("permit", "lease", "owner-secret", 1));

    public SidecarAuthorizationTests()
    {
        _coordinator.Setup(x => x.ValidateHashAsync(It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string>(), It.IsAny<long>(), false, It.IsAny<CancellationToken>(), It.IsAny<string?>()))
            .ReturnsAsync(true);
        _tokens = new TaskContinuationTokens(new EphemeralDataProtectionProvider(), _coordinator.Object);
    }

    private string Issue(string run = "run-a", string subject = "alice", DateTime? expires = null) =>
        _tokens.Issue(_identity, run, subject, expires ?? DateTime.UtcNow.AddMinutes(2), new SidecarRunRequest
        {
            RunId = run, WorkspaceRoot = "/workspace/alice", Profile = "approved-profile", BuiltinTools = ["Read"],
            Tools = [new SidecarToolDef { Name = "echo", Description = "echo", InputSchema = JsonSerializer.SerializeToElement(new { type = "object" }) }]
        });

    [Fact]
    public async Task GrantBindsSubjectRunPurposeToolsWorkspaceProfileAndExpiry()
    {
        var token = Issue();
        var authorization = await _tokens.AuthorizeRuntimeAsync(token, "run-a", "run");
        Assert.NotNull(authorization);
        Assert.Equal("alice", authorization.Subject);
        Assert.Equal("/workspace/alice", authorization.Runtime.WorkspaceRoot);
        Assert.Equal("approved-profile", authorization.Runtime.Profile);
        Assert.NotNull(await _tokens.AuthorizeRuntimeAsync(token, "run-a", "callback", "echo"));
        Assert.NotNull(await _tokens.AuthorizeRuntimeAsync(token, "run-a", "cancel"));
        Assert.Null(await _tokens.AuthorizeRuntimeAsync(token, "run-b", "run"));
        Assert.Null(await _tokens.AuthorizeRuntimeAsync(token, "run-a", "admin"));
        Assert.Null(await _tokens.AuthorizeRuntimeAsync(token, "run-a", "callback", "Bash"));
        Assert.Null(await _tokens.AuthorizeRuntimeAsync(token + "tampered", "run-a", "run"));
        Assert.Null(await _tokens.AuthorizeRuntimeAsync("shared-token", "run-a", "run"));
        Assert.Null(await _tokens.ValidateAsync(token, "run-a", "bob"));
        Assert.Null(await _tokens.AuthorizeRuntimeAsync(Issue(expires: DateTime.UtcNow.AddSeconds(-1)), "run-a", "run"));
        _coordinator.Setup(x => x.ValidateHashAsync(It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string>(), It.IsAny<long>(), false, It.IsAny<CancellationToken>(), It.IsAny<string?>())).ReturnsAsync(false);
        Assert.Null(await _tokens.AuthorizeRuntimeAsync(token, "run-a", "run"));
    }

    private AgentToolsController Controller(string token, Mock<IAgentToolRegistry> registry, ISidecarReplayStore? replay = null)
    {
        var controller = new AgentToolsController(registry.Object, Mock.Of<IOptionsMonitor<ClaudeSidecarOptions>>(),
            NullLogger<AgentToolsController>.Instance, null!, Mock.Of<IInfraConnectionService>(), Mock.Of<IChatAgentOneOffRunRegistry>());
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };
        controller.HttpContext.RequestServices = new ServiceCollection().AddSingleton(_tokens).AddSingleton<ISidecarReplayStore>(replay ?? new Mock<ISidecarReplayStore>(MockBehavior.Strict).Object).BuildServiceProvider();
        controller.Request.Headers["X-Sidecar-Token"] = token;
        return controller;
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task ApprovedToolExecutesOnceAndCannotReplayAcrossRunsSubjectsOrInputs()
    {
        var run = "run-" + Guid.NewGuid().ToString("N");
        var token = Issue(run);
        var registry = new Mock<IAgentToolRegistry>();
        registry.Setup(x => x.InvokeAsync("echo", It.IsAny<JsonElement>(),
            It.Is<AgentToolInvocationContext>(c => c.UserId == "alice" && c.RunId == run), It.IsAny<CancellationToken>()))
            .ReturnsAsync(AgentToolInvokeResult.Ok("executed"));
        var controller = Controller(token, registry, SidecarReplayPersistenceTests.Store());
        Assert.IsType<OkObjectResult>(await controller.AuthorizeRuntime(new() { RunId = run, Purpose = "run" }));
        var id = run + ":approval";
        var input = JsonSerializer.SerializeToElement(new { text = "approved" });
        Assert.IsType<OkObjectResult>(await controller.RequestApproval(run, id,
            new() { ToolName = "echo", Input = input }, default));
        Assert.IsType<OkObjectResult>(await controller.WaitForApproval(run, id, new() { ToolName = "echo" }, default));
        Assert.Equal(403, Assert.IsType<StatusCodeResult>(await Controller(Issue("other", "bob"), registry).Invoke(
            new() { RunId = run, ToolName = "echo", Input = input, ApprovalId = id }, default)).StatusCode);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await controller.Invoke(new() { RunId = run, ToolName = "echo",
            Input = JsonSerializer.SerializeToElement(new { text = "changed" }), ApprovalId = id }, default)).StatusCode);
        Assert.IsType<OkObjectResult>(await Controller(token, registry, SidecarReplayPersistenceTests.Store()).Invoke(new() { RunId = run, ToolName = "echo", Input = input, ApprovalId = id }, default));
        Assert.Equal(403, Assert.IsType<ObjectResult>(await controller.Invoke(new() { RunId = run, ToolName = "echo", Input = input, ApprovalId = id }, default)).StatusCode);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await controller.WaitForApproval(run, id, new() { ToolName = "echo" }, default)).StatusCode);
        registry.Verify(x => x.InvokeAsync(It.IsAny<string>(), It.IsAny<JsonElement>(), It.IsAny<AgentToolInvocationContext>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task CancellationDeniesNewToolsAndCannotBecomeSuccessfulCompletion()
    {
        var run = "cancel-" + Guid.NewGuid().ToString("N");
        var token = Issue(run); var registry = new Mock<IAgentToolRegistry>(MockBehavior.Strict);
        var first = Controller(token, registry, SidecarReplayPersistenceTests.Store());
        var second = Controller(token, registry, SidecarReplayPersistenceTests.Store());
        Assert.IsType<OkObjectResult>(await first.AuthorizeRuntime(new() { RunId = run, Purpose = "run" }));
        Assert.IsType<OkObjectResult>(await second.AuthorizeRuntime(new() { RunId = run, Purpose = "cancel" }));
        Assert.Equal(403, Assert.IsType<ObjectResult>(await first.RequestApproval(run, run + ":approval",
            new() { ToolName = "echo" }, default)).StatusCode);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await first.Invoke(new() { RunId = run, ToolName = "echo" }, default)).StatusCode);
        var result = Assert.IsType<OkObjectResult>(await first.AuthorizeRuntime(new() { RunId = run, Purpose = "complete" }));
        Assert.Equal("cancelled", JsonSerializer.SerializeToElement(result.Value).GetProperty("State").GetString());
        registry.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task StorageFailureReturns503WithoutToolDispatch()
    {
        var registry = new Mock<IAgentToolRegistry>(MockBehavior.Strict);
        var controller = Controller(Issue(), registry, SidecarReplayPersistenceTests.Store(true));
        Assert.Equal(503, Assert.IsType<ObjectResult>(await controller.Invoke(new()
            { RunId = "run-a", ToolName = "echo", ApprovalId = "run-a:failure" }, default)).StatusCode);
        Assert.Equal(503, Assert.IsType<ObjectResult>(await controller.AuthorizeRuntime(new()
            { RunId = "run-a", Purpose = "run" })).StatusCode);
        registry.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SharedCredentialAndWrongPurposeCannotReachTools()
    {
        var registry = new Mock<IAgentToolRegistry>(MockBehavior.Strict);
        var controller = Controller("shared-token", registry);
        Assert.IsType<UnauthorizedObjectResult>(await controller.Invoke(new() { RunId = "run-a", ToolName = "echo" }, default));
        Assert.IsType<UnauthorizedObjectResult>(await controller.RequestApproval("run-a", "run-a:x", new() { ToolName = "echo" }, default));
        Assert.Equal(403, Assert.IsType<ObjectResult>(await controller.AuthorizeRuntime(new() { RunId = "run-a", Purpose = "run" })).StatusCode);
        registry.VerifyNoOtherCalls();
    }
}
