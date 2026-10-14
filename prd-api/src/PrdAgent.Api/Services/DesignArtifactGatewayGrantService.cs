using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public sealed record DesignArtifactGatewayGrant(
    string Id,
    string BaseUrl,
    string ApiKey,
    string Model,
    string AppCallerCode,
    DateTime ExpiresAt);

public sealed record DesignArtifactGatewayGrantUsage(
    int CallCount,
    string? Model,
    string? Platform);

public interface IDesignArtifactGatewayGrantService
{
    Task<DesignArtifactGatewayGrant> IssueAsync(DesignArtifactRun run, DateTime expiresAt, CancellationToken ct);
    Task<DesignArtifactGatewayGrantUsage> ObserveAsync(string grantId, DesignArtifactRun run, CancellationToken ct);
    Task RevokeAsync(string grantId, CancellationToken ct);
}

/// <summary>
/// 为 OpenDesign 的单次任务签发短期 LLMGW 凭据。明文只返回给当前执行调用栈；Mongo 只保存哈希，
/// 网关再从记录恢复 run、user、appCaller 和冻结模型策略，设计容器拿到 key 也不能扩大权限。
/// </summary>
public sealed class DesignArtifactGatewayGrantService : IDesignArtifactGatewayGrantService
{
    private const int MaxCallsPerRun = 256;
    private readonly LlmGatewayDataContext _gateway;
    private readonly MongoDbContext _map;
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;

    public DesignArtifactGatewayGrantService(
        LlmGatewayDataContext gateway,
        MongoDbContext map,
        IConfiguration configuration,
        IHostEnvironment environment)
    {
        _gateway = gateway;
        _map = map;
        _configuration = configuration;
        _environment = environment;
    }

    public async Task<DesignArtifactGatewayGrant> IssueAsync(
        DesignArtifactRun run,
        DateTime expiresAt,
        CancellationToken ct)
    {
        var baseUrl = (_configuration["LlmGateway:ServeBaseUrl"] ?? string.Empty).Trim().TrimEnd('/');
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var parsed)
            || parsed.Scheme is not ("http" or "https"))
            throw new InvalidOperationException("设计模型网关地址未配置，无法启动 OpenDesign 任务");

        var selection = DesignArtifactModelSelection.ForRun(run, _configuration);
        var model = selection.ForDirectGatewayClient();
        if (string.IsNullOrWhiteSpace(model))
            throw new InvalidOperationException("当前设计任务没有冻结可用的逻辑模型，无法启动 OpenDesign 任务");

        var policy = selection.Policy;
        var caller = run.Operation == DesignArtifactOperations.Edit
            ? AppCallerRegistry.Admin.WebHosting.EditHtml
            : AppCallerRegistry.Admin.WebHosting.GenerateHtml;
        var keyBytes = RandomNumberGenerator.GetBytes(32);
        var plainKey = "gwrg_" + Convert.ToBase64String(keyBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(plainKey))).ToLowerInvariant();
        var id = Guid.NewGuid().ToString("N");
        var now = DateTime.UtcNow;
        var record = new GatewayRuntimeGrantRecord
        {
            Id = id,
            TenantId = _configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenantId
                ? tenantId
                : GatewayTenantDefaults.InternalTenantId,
            // 运行日志里只允许出现哈希前缀，绝不保存或展示明文 key 的任何片段。
            KeyPrefix = hash[..12],
            KeyHash = hash,
            RunId = run.Id,
            UserId = run.UserId,
            AppCallerCode = caller,
            Environment = NormalizeEnvironment(_environment.EnvironmentName),
            Model = model,
            ModelPoolId = selection.ModelPoolId,
            PinnedPlatformId = policy?.PinnedPlatformId,
            PinnedModelId = policy?.PinnedModelId,
            Temperature = policy?.Temperature,
            TopP = policy?.TopP,
            ReasoningMode = policy?.ReasoningMode,
            ReasoningEffort = policy?.ReasoningEffort,
            OutputTokenMode = policy?.OutputTokenMode,
            RequireDeclaredParameters = policy?.RequireDeclaredParameters == true,
            MaxCalls = MaxCallsPerRun,
            ExpiresAt = expiresAt,
            CreatedAt = now,
        };
        await _gateway.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .InsertOneAsync(record, cancellationToken: ct);
        return new(id, $"{baseUrl}/gw/v1", plainKey, model, caller, expiresAt);
    }

    public async Task<DesignArtifactGatewayGrantUsage> ObserveAsync(
        string grantId,
        DesignArtifactRun run,
        CancellationToken ct)
    {
        var grant = await _gateway.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .Find(x => x.Id == grantId && x.RunId == run.Id && x.UserId == run.UserId)
            .FirstOrDefaultAsync(ct);
        var callCount = Math.Max(0, grant?.CallCount ?? 0);
        if (callCount > 0)
        {
            await _map.DesignArtifactRuns.UpdateOneAsync(
                item => item.DeploymentSlug == DeploymentScope.Current && item.Id == run.Id,
                Builders<DesignArtifactRun>.Update.Max(item => item.RuntimeModelCallCount, callCount),
                cancellationToken: ct);
        }

        var caller = run.Operation == DesignArtifactOperations.Edit
            ? AppCallerRegistry.Admin.WebHosting.EditHtml
            : AppCallerRegistry.Admin.WebHosting.GenerateHtml;
        var latest = await _gateway.LlmRequestLogs
            .Find(item => item.ServiceKeyId == grantId
                          && item.RunId == run.Id
                          && item.UserId == run.UserId
                          && item.SourceSystem == "map"
                          && item.AppCallerCode == caller
                          && item.Model != "")
            .SortByDescending(item => item.StartedAt)
            .FirstOrDefaultAsync(ct);
        return new DesignArtifactGatewayGrantUsage(
            callCount,
            latest?.Model,
            latest?.PlatformName ?? latest?.Provider);
    }

    public Task RevokeAsync(string grantId, CancellationToken ct) =>
        _gateway.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .DeleteOneAsync(x => x.Id == grantId, ct);

    private static string NormalizeEnvironment(string value) => value.Trim().ToLowerInvariant() switch
    {
        "development" => "development",
        "test" or "testing" => "test",
        "staging" => "staging",
        _ => "production",
    };
}
