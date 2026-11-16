using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class TaskBudgetMetadataCompatibilityTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MetadataPreviewDelegatesWithoutExecutionResolutionOrPhysicalSend(bool bound)
    {
        const string caller = AppCallerRegistry.Admin.Lab.Chat;
        using var cancellation = new CancellationTokenSource();
        var resolver = new Mock<IModelResolver>(MockBehavior.Strict);
        resolver.Setup(x => x.ResolveMetadataAsync(caller, "chat", "synthetic-logical", "synthetic-platform",
                "synthetic-model", cancellation.Token))
            .ReturnsAsync(new ModelResolutionResult { Success = true, ActualModel = "synthetic-model" });
        var transport = new Mock<IHttpClientFactory>(MockBehavior.Strict);
        var inner = new LlmGateway(resolver.Object, transport.Object, NullLogger<LlmGateway>.Instance);
        var http = new DefaultHttpContext();
        if (bound) http.Items[GatewayTaskAdmission.HttpContextPermitKey] = new GatewayTaskPermitRecord
        { Id = "synthetic-permit", BudgetScopeId = "synthetic-budget" };
        PrdAgent.Core.LlmGateway.ILlmGateway gateway = new TaskBudgetGateway(inner,
            new HttpContextAccessor { HttpContext = http }, null!,
            new Mock<IGatewayRuntimeGrantCallCounter>(MockBehavior.Strict).Object);

        var result = await gateway.ResolveModelMetadataAsync(caller, "chat", "synthetic-logical",
            "synthetic-platform", "synthetic-model", cancellation.Token);

        Assert.True(result.Success, result.ErrorMessage);
        Assert.Equal("synthetic-model", result.ActualModel);
        resolver.VerifyAll();
        resolver.VerifyNoOtherCalls();
        transport.VerifyNoOtherCalls();
    }
}
