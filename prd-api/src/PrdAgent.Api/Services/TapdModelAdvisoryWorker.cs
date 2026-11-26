using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.GatewayTransport;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services;

public sealed class TapdModelAdvisoryWorker(
    IServiceScopeFactory scopeFactory, IConfiguration configuration, ILogger<TapdModelAdvisoryWorker> logger) : BackgroundService
{
    public const string StateCollection = "model_advisory_checks";
    private const string EnabledKey = Section + ":Enabled";
    private const string Section = "TapdBugAgent:ModelAdvisory";
    private static readonly FilterDefinitionBuilder<BsonDocument> Filter = Builders<BsonDocument>.Filter;
    private static readonly UpdateDefinitionBuilder<BsonDocument> Update = Builders<BsonDocument>.Update;

    public static bool IsEnabled(IConfiguration config)
        => bool.TryParse(config[EnabledKey], out var enabled) && enabled;

    internal static bool CanCheckPreview(IConfiguration config)
        => IsEnabled(config) && DeploymentAuthority.IsCdsBranchPreview(config)
            && config["VITE_GIT_BRANCH"]?.Trim() is { Length: > 0 } branch
            && !string.Equals(branch, "main", StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(config[TapdBugAgentService.ModelPublicIdKey]);

    internal static string StateId(IConfiguration config)
    {
        var caller = AppCallerRegistry.TapdBugAgent.Extract.Chat;
        return CanCheckPreview(config)
            ? $"{caller}:{TaskPermitDeployment.Resolve(config)}:{config[TapdBugAgentService.ModelPublicIdKey]!.Trim()}"
            : caller;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(10));
        do
        {
            if (!IsEnabled(configuration)) continue;
            try { await CheckDueAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning("TAPD 模型淘汰检查未完成。错误类型 {ErrorType}", ex.GetType().Name); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task CheckDueAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var services = scope.ServiceProvider;
        var states = services.GetRequiredService<MongoDbContext>().Database.GetCollection<BsonDocument>(StateCollection);
        var caller = AppCallerRegistry.TapdBugAgent.Extract.Chat;
        var preview = CanCheckPreview(configuration);
        var key = Filter.Eq("_id", StateId(configuration));
        await states.UpdateOneAsync(key, Update.SetOnInsert("Caller", caller), new UpdateOptions { IsUpsert = true }, ct);
        var now = DateTime.UtcNow;
        var token = Guid.NewGuid().ToString("N");
        var due = !Filter.Exists("NextCheckAt") | Filter.Lte("NextCheckAt", now);
        var unlocked = !Filter.Exists("LeaseUntil") | Filter.Lte("LeaseUntil", now);
        var claimed = await states.UpdateOneAsync(key & due & unlocked,
            Update.Set("LeaseToken", token).Set("LeaseUntil", now.AddMinutes(2)).Set("LastAttemptAt", now), cancellationToken: ct);
        if (claimed.ModifiedCount == 0) return;

        var update = Update.Set("NextCheckAt", now.AddDays(1)).Unset("LeaseUntil").Unset("LeaseToken");
        try
        {
            var gateway = services.GetRequiredService<HttpLlmGatewayClient>();
            var result = await gateway.GetModelAdvisoryAsync(caller, ModelTypes.Chat, configuration[TapdBugAgentService.ModelPublicIdKey], ct);
            update = update.Set("Status", result.Status).Set("LastSuccessfulCheckAt", result.CheckedAt.UtcDateTime)
                .Set("ActualModel", BsonValue.Create(result.ActualModel)).Set("DefaultPublicId", BsonValue.Create(result.DefaultPublicId))
                .Set("DefaultAvailable", result.DefaultAvailable)
                .Set("LastQuerySucceeded", true)
                .Set("NoticeSource", BsonValue.Create(result.Notice?.Source))
                .Set("RetirementAt", result.Notice is null ? (BsonValue)BsonNull.Value : new BsonDateTime(result.Notice.RetirementAt.UtcDateTime));
            logger.LogInformation("TAPD 模型淘汰状态 {Status} ActualModel={ActualModel} Default={Default} Available={Available} CheckedAt={CheckedAt}",
                result.Status, result.ActualModel, result.DefaultPublicId, result.DefaultAvailable, result.CheckedAt);
            try
            {
                if (!preview)
                    await NotifyAsync(services.GetRequiredService<AdminNotificationEventService>(), result, now, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                update = update.Set("NextCheckAt", now.AddHours(1));
                logger.LogWarning("TAPD 淘汰通知未发出，一小时后重试。错误类型 {ErrorType}", ex.GetType().Name);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            update = update.Set("NextCheckAt", now.AddHours(1)).Set("Status", "unknown").Set("LastQuerySucceeded", false);
            logger.LogWarning("TAPD 淘汰检查失败，保留上次路由配置并在一小时后重试。错误类型 {ErrorType}", ex.GetType().Name);
        }
        await states.UpdateOneAsync(key & Filter.Eq("LeaseToken", token), update, cancellationToken: ct);
    }

    public static string DedupKey(ModelRetirementNotice notice)
        => "tapd-model-retirement-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{notice.ProviderId}\n{notice.ModelId}\n{notice.RetirementAt.UtcDateTime:O}"))).ToLowerInvariant();

    public static async Task<bool> IsCheckHealthyAsync(MongoDbContext database, DateTime utcNow,
        IConfiguration configuration, CancellationToken ct)
    {
        var requiresDefault = string.IsNullOrWhiteSpace(configuration[TapdBugAgentService.ModelPublicIdKey]);
        var state = await database.Database.GetCollection<BsonDocument>(StateCollection)
            .Find(Filter.Eq("_id", StateId(configuration))).FirstOrDefaultAsync(ct);
        return state is not null
            && state.GetValue("LastQuerySucceeded", false) == BsonBoolean.True
            && state.GetValue("Status", "").AsString is "unknown" or "announced"
            && state.GetValue("LastSuccessfulCheckAt", BsonNull.Value) is BsonDateTime last
            && last.ToUniversalTime() >= utcNow.AddHours(-48)
            && last.ToUniversalTime() <= utcNow.AddMinutes(5)
            && (!requiresDefault || state.GetValue("DefaultAvailable", false) == BsonBoolean.True);
    }

    private async Task NotifyAsync(AdminNotificationEventService notifications, ModelLifecycleAdvisory result, DateTime utcNow, CancellationToken ct)
    {
        var notice = result.Notice;
        var days = int.TryParse(configuration[Section + ":WarningDays"], out var configuredDays)
            ? Math.Clamp(configuredDays, 1, 180) : 30;
        if (result.Status != "announced" || notice is null || notice.RetirementAt > utcNow.AddDays(days)) return;

        var date = notice.RetirementAt.ToOffset(TimeSpan.FromHours(8)).ToString("yyyy-MM-dd HH:mm 'UTC+8'", CultureInfo.InvariantCulture);
        var alternatives = result.Recommendations.Count > 0
            ? $"建议评估的替代模型：{string.Join("、", result.Recommendations.Select(model => model.PublicId))}。"
            : "网关暂未找到符合当前用途的推荐模型，请核对可用目录。";
        var dedup = DedupKey(notice);
        var recipients = (configuration.GetSection(Section + ":NotifyUserIds").Get<string[]>() ?? [])
            .Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id.Trim()).Distinct(StringComparer.Ordinal).Take(30);
        foreach (var recipient in recipients)
        {
            try
            {
                await notifications.CreateAsync(new AdminNotificationEventRequest
                {
                    Source = "gateway-alert",
                    Section = AdminNotificationSections.Personal,
                    TargetUserId = recipient,
                    DedupKey = dedup,
                    Title = "TAPD 缺陷草稿模型淘汰提醒",
                    Level = "warning",
                    Message = $"TAPD 在用模型 {notice.ModelId} 公告下线时间为 {date}。{alternatives}请反馈替代选择。公告：{notice.Source}",
                }, "system", ct);
            }
            catch (InvalidOperationException)
            {
                logger.LogWarning("TAPD 模型淘汰通知收件人不可用，请核对通知负责人配置。");
            }
        }
    }
}
