using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.BackgroundTasks;

/// <summary>平台签发任务时冻结金额合同；复用 runtime budget 集合和结算器，不由业务漏写决定是否启用。</summary>
public static class TaskBudgetContracts
{
    public const string ConfigurationRoot = "LlmGateway:TaskBudgets";

    public static async Task BindAsync(GatewayTaskPermitRecord permit, IConfiguration configuration,
        LlmGatewayDataContext data, CancellationToken ct)
    {
        var section = configuration.GetSection($"{ConfigurationRoot}:Policies:{permit.Origin}");
        if (!section.GetChildren().Any())
        {
            if (configuration.GetValue<bool>($"{ConfigurationRoot}:Required"))
                throw Denied("TASK_BUDGET_POLICY_REQUIRED", "此任务来源尚未配置金额合同，已停止付费任务；请由平台配置额度与价格版本。");
            return;
        }
        var policy = section.Get<TaskBudgetContractPolicy>();
        if (policy is null || !policy.Valid())
            throw Denied("TASK_BUDGET_POLICY_INVALID", "任务金额合同不完整，已停止付费任务；请核对额度、路由、输出上限及价格版本。");
        var id = $"task_{permit.Id}";
        var scopes = data.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var record = new GatewayRuntimeBudgetScopeRecord
        {
            Id = id, TenantId = permit.TenantId, UserId = permit.ActorUserId,
            TaskPermitId = permit.Id, MaxPhysicalCalls = permit.MaxCalls, AllowedAppCallerCodes = permit.AllowedAppCallerCodes.ToList(),
            SourcePlanHash = permit.RequestFingerprint ?? "", AuthorizedLimitUsd = policy.AuthorizedLimitUsd,
            InputUsdPerMillion = policy.InputUsdPerMillion, OutputUsdPerMillion = policy.OutputUsdPerMillion,
            CachedInputUsdPerMillion = policy.CachedInputUsdPerMillion, CacheWriteUsdPerMillion = policy.CacheWriteUsdPerMillion,
            LongContextThresholdTokens = long.MaxValue,
            LongContextInputUsdPerMillion = policy.InputUsdPerMillion, LongContextOutputUsdPerMillion = policy.OutputUsdPerMillion,
            InputByteTokenMultiplier = 4, MaxOutputTokens = policy.MaxOutputTokens,
            ExpectedLogicalModelPublicId = policy.LogicalModelPublicId.Trim(),
            ExpectedProvider = policy.Provider.Trim(), ExpectedModel = policy.Model.Trim(),
            PriceProtocol = policy.Protocol.Trim(), PriceVersion = policy.PriceVersion.Trim(),
            ActivatedByUserId = "platform-task-admission", ExpiresAt = permit.ExpiresAt,
            CreatedAt = permit.CreatedAt, UpdatedAt = permit.CreatedAt,
        };
        // 同一业务意图只建一次；重试、配置变化都不能清账或补满额度。
        try { await scopes.InsertOneAsync(record, cancellationToken: ct); }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey) { }
        var existing = await scopes.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (existing is null || existing.TaskPermitId != permit.Id || existing.TenantId != permit.TenantId
            || existing.UserId != permit.ActorUserId || existing.SourcePlanHash != record.SourcePlanHash
            || !existing.AllowedAppCallerCodes.Order().SequenceEqual(permit.AllowedAppCallerCodes.Order()))
            throw Denied("TASK_BUDGET_BINDING_INVALID", "任务金额合同与执行身份不一致，已停止付费任务。");
        permit.BudgetScopeId = id;
    }

    private static TaskExecutionAdmissionException Denied(string code, string message) => new(code, message, 409);
}

public sealed class TaskBudgetContractPolicy
{
    public decimal AuthorizedLimitUsd { get; set; }
    public decimal InputUsdPerMillion { get; set; }
    public decimal OutputUsdPerMillion { get; set; }
    public decimal? CachedInputUsdPerMillion { get; set; }
    public decimal? CacheWriteUsdPerMillion { get; set; }
    public int MaxOutputTokens { get; set; }
    public string LogicalModelPublicId { get; set; } = "";
    public string Provider { get; set; } = "";
    public string Model { get; set; } = "";
    public string Protocol { get; set; } = "";
    public string PriceVersion { get; set; } = "";

    public bool Valid() => AuthorizedLimitUsd > 0 && MaxOutputTokens > 0
        && InputUsdPerMillion > 0 && OutputUsdPerMillion > 0
        && CachedInputUsdPerMillion is >= 0 && CacheWriteUsdPerMillion is >= 0
        && new[] { LogicalModelPublicId, Provider, Model, PriceVersion }.All(x => !string.IsNullOrWhiteSpace(x) && x.Length <= 128)
        && (GatewayProtocolAliases.NormalizeAdapterKey(Protocol) == GatewayProtocolAliases.OpenAI || GatewayProtocolAliases.IsClaudeProtocol(Protocol));
}
