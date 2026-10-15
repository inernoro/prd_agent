using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>只用于协议和授权回归的显式活租约；真实领取、竞争、续期由平台协调器集成测试验证。</summary>
internal static class PlatformExecutionFixture
{
    internal static string Token(string permit) => TaskExecutionCoordinator.Fingerprint("isolated-test-lease:" + permit)[..32];
    internal static GatewayTaskPermitRecord Prepare(GatewayTaskPermitRecord permit)
    {
        permit.ExecutionContractVersion = TaskExecutionCoordinator.ContractVersion;
        permit.BusinessKeyHash = TaskExecutionCoordinator.Fingerprint(permit.Id);
        permit.RequestFingerprint = TaskExecutionCoordinator.Fingerprint("fixture-parameters");
        permit.Executions = [new() { RunId = "", OwnerHash = TaskExecutionCoordinator.OwnerHash(Token(permit.Id)),
            Fence = 1, State = TaskExecutionLeaseStates.Running, LeaseUntil = DateTime.UtcNow.AddMinutes(20) }];
        return permit;
    }
    internal static TaskExecutionIdentity Identity(string permit, string? run = null) => new(permit, run, new(permit, null, Token(permit), 1));
    internal static void Headers(HttpRequestMessage message, string permit)
    {
        message.Headers.Add(TaskExecutionHeaders.LeaseToken, Token(permit));
        message.Headers.Add(TaskExecutionHeaders.LeaseFence, "1");
    }
}
