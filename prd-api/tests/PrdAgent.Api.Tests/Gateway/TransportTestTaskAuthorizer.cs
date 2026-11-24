using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>仅运输契约单测使用；真实准入/网关核销测试不得用此替身代替数据库许可。</summary>
internal sealed class TransportTestTaskAuthorizer : ITaskExecutionAuthorizer
{
    public static readonly TransportTestTaskAuthorizer Instance = new();
    public Task AuthorizeOutboundAsync(HttpRequestMessage message, string appCallerCode,
        GatewayRequestContext? context, CancellationToken ct)
    {
        message.Headers.TryAddWithoutValidation("X-Gateway-Task-Permit", "transport-unit-test-permit");
        message.Headers.TryAddWithoutValidation("X-Gateway-Execution-Origin", "interactive");
        message.Headers.TryAddWithoutValidation("X-Gateway-Source-Deployment", "transport-test-deployment");
        if (context is not null)
        {
            context.TaskPermitId = "transport-unit-test-permit";
            context.ExecutionOrigin = "interactive";
            context.SourceDeployment = "transport-test-deployment";
        }
        return Task.CompletedTask;
    }
}
