using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>只用于协议和授权回归的显式活租约；真实领取、竞争、续期由平台协调器集成测试验证。</summary>
internal static class PlatformExecutionFixture
{
    internal static async Task<TaskExecutionIdentity> AdmitDesignRunAsync(
        LlmGatewayDataContext data, IConfiguration configuration, DesignArtifactRun run)
    {
        run.TaskPermitId = Guid.NewGuid().ToString("N");
        var permit = Prepare(new GatewayTaskPermitRecord
        {
            Id = run.TaskPermitId,
            TenantId = configuration["LlmGateway:InternalTenantId"] ?? GatewayTenantDefaults.InternalTenantId,
            ActorUserId = run.UserId,
            SubjectUserIds = [run.UserId],
            TriggerCredentialId = "synthetic-session",
            Origin = TaskExecutionOrigins.Interactive,
            SourceDeployment = TaskPermitDeployment.Resolve(configuration),
            SourceTask = "design-budget-integration-fixture",
            AllowedAppCallerCodes = [DesignArtifactGatewayGrantService.CallerFor(run)],
            MaxCalls = 256,
            MaxRuns = 8,
            CreatedAt = DateTime.UtcNow.AddMinutes(-1),
            ExpiresAt = DateTime.UtcNow.AddMinutes(15),
        });
        await data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
            .InsertOneAsync(permit);
        return Identity(permit.Id, run.Id);
    }

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
