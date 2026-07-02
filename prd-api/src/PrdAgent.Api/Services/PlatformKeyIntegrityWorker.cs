using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services;

/// <summary>
/// 平台密钥完整性自检 —— 启动后及每 6 小时扫描全部启用平台和中继，
/// 用 ApiKeyCrypto:Secret 钥匙环试解密 API key 密文。「密文存在但解出为空」
/// 意味着部署环境的数据加密密钥与存量密文不匹配。
///
/// 历史背景：2026-06-12 CDS 全局 CDS_JWT_SECRET 为修另一项目的 HS512 弱钥
/// 被更换，跨项目穿透导致本系统 6 个平台 key 全部不可解密，模型池调用
/// 静默 401 约两小时无任何告警。本 Worker 把这类故障从「用户报障」
/// 提前到「启动即知」：LogError + 全局站内通知（幂等，恢复后自动标记已处理）。
/// </summary>
public class PlatformKeyIntegrityWorker : BackgroundService
{
    private const string NotificationKey = "platform-key-integrity";
    private static readonly TimeSpan StartupDelay = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(6);

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IConfiguration _configuration;
    private readonly ILogger<PlatformKeyIntegrityWorker> _logger;

    public PlatformKeyIntegrityWorker(
        IServiceScopeFactory scopeFactory,
        IConfiguration configuration,
        ILogger<PlatformKeyIntegrityWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _configuration = configuration;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(StartupDelay, stoppingToken); }
        catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await CheckAsync(stoppingToken);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[PlatformKeyIntegrity] check loop error");
            }

            try { await Task.Delay(CheckInterval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    // 有意的 dev-stub 平台（如"Stub 开发桩"）密文本就是占位、天然解不出，属预期噪音，不当真故障告警/推站内信。
    // 注意：仅按"开发桩"或独立词 "stub" 判定（词边界，非任意子串），避免真实平台名恰含 stub 子串被误判静默（Bugbot Low）。
    // 即便误判，stub 类仍会在 Info 日志列出（非彻底静默），保留审计线索。
    private static bool IsStub(string? name)
        => !string.IsNullOrWhiteSpace(name)
        && (name!.Contains("开发桩")
            || System.Text.RegularExpressions.Regex.IsMatch(name, @"(^|[^a-z])stub([^a-z]|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase));

    private async Task CheckAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var platforms = await db.LLMPlatforms
            .Find(p => p.Enabled)
            .ToListAsync(ct);

        var exchanges = await db.ModelExchanges
            .Find(e => e.Enabled)
            .ToListAsync(ct);
        var models = await db.LLMModels
            .Find(m => m.Enabled)
            .ToListAsync(ct);
        var configs = await db.LLMConfigs
            .Find(c => true)
            .ToListAsync(ct);

        var unreadable = new List<string>();       // 真实平台/模型/中继解不出 —— 需告警 + 站内信
        var stubUnreadable = new List<string>();   // dev-stub 解不出 —— 预期噪音，不告警
        var rotated = 0;
        var canRotate = ApiKeyCryptoKeyRing.HasDedicatedPrimarySecret(_configuration);

        void MarkUnreadable(string label, string? name)
        {
            if (IsStub(name)) stubUnreadable.Add(label); else unreadable.Add(label);
        }

        foreach (var platform in platforms.Where(p => !string.IsNullOrWhiteSpace(p.ApiKeyEncrypted)))
        {
            var result = ApiKeyCryptoKeyRing.Decrypt(platform.ApiKeyEncrypted, _configuration);
            if (!result.Success)
            {
                MarkUnreadable(platform.Name, platform.Name);
                continue;
            }

            if (canRotate && result.UsedLegacySecret)
            {
                await db.LLMPlatforms.UpdateOneAsync(
                    p => p.Id == platform.Id,
                    Builders<LLMPlatform>.Update
                        .Set(p => p.ApiKeyEncrypted, ApiKeyCryptoKeyRing.Encrypt(result.PlainText, _configuration))
                        .Set(p => p.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: ct);
                rotated++;
            }
        }

        foreach (var exchange in exchanges.Where(e => !string.IsNullOrWhiteSpace(e.TargetApiKeyEncrypted)))
        {
            var result = ApiKeyCryptoKeyRing.Decrypt(exchange.TargetApiKeyEncrypted, _configuration);
            if (!result.Success)
            {
                MarkUnreadable(exchange.Name, exchange.Name);
                continue;
            }

            if (canRotate && result.UsedLegacySecret)
            {
                await db.ModelExchanges.UpdateOneAsync(
                    e => e.Id == exchange.Id,
                    Builders<ModelExchange>.Update
                        .Set(e => e.TargetApiKeyEncrypted, ApiKeyCryptoKeyRing.Encrypt(result.PlainText, _configuration))
                        .Set(e => e.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: ct);
                rotated++;
            }
        }

        foreach (var model in models.Where(m => !string.IsNullOrWhiteSpace(m.ApiKeyEncrypted)))
        {
            var result = ApiKeyCryptoKeyRing.Decrypt(model.ApiKeyEncrypted, _configuration);
            if (!result.Success)
            {
                MarkUnreadable($"模型:{model.Name}", model.Name);
                continue;
            }

            if (canRotate && result.UsedLegacySecret)
            {
                await db.LLMModels.UpdateOneAsync(
                    m => m.Id == model.Id,
                    Builders<LLMModel>.Update
                        .Set(m => m.ApiKeyEncrypted, ApiKeyCryptoKeyRing.Encrypt(result.PlainText, _configuration))
                        .Set(m => m.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: ct);
                rotated++;
            }
        }

        foreach (var config in configs.Where(c => !string.IsNullOrWhiteSpace(c.ApiKeyEncrypted)))
        {
            var result = ApiKeyCryptoKeyRing.Decrypt(config.ApiKeyEncrypted, _configuration);
            if (!result.Success)
            {
                MarkUnreadable($"旧配置:{config.Provider}/{config.Model}", config.Provider);
                continue;
            }

            if (canRotate && result.UsedLegacySecret)
            {
                await db.LLMConfigs.UpdateOneAsync(
                    c => c.Id == config.Id,
                    Builders<LLMConfig>.Update
                        .Set(c => c.ApiKeyEncrypted, ApiKeyCryptoKeyRing.Encrypt(result.PlainText, _configuration))
                        .Set(c => c.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: ct);
                rotated++;
            }
        }

        // dev-stub 解不出属预期，不告警——但留 Info 审计线索（与 serving 侧 ServingKeyIntegrityCheck 对齐，Bugbot Low）。
        if (stubUnreadable.Count > 0)
            _logger.LogInformation(
                "[PlatformKeyIntegrity] 已跳过 {Count} 个 dev-stub（密文为占位、预期解不出，非故障）：{Names}",
                stubUnreadable.Count, string.Join("、", stubUnreadable));

        var existing = await db.AdminNotifications
            .Find(n => n.Key == NotificationKey && n.Status == "open")
            .FirstOrDefaultAsync(ct);

        if (unreadable.Count == 0)
        {
            if (existing != null)
            {
                await db.AdminNotifications.UpdateOneAsync(
                    n => n.Id == existing.Id,
                    Builders<AdminNotification>.Update
                        .Set(x => x.Status, "handled")
                        .Set(x => x.HandledAt, DateTime.UtcNow)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: ct);
                _logger.LogInformation("[PlatformKeyIntegrity] 平台和中继密钥已恢复可解密，告警自动关闭");
            }
            if (rotated > 0)
                _logger.LogInformation("[PlatformKeyIntegrity] 已将 {Count} 个旧密文自动重加密到 ApiKeyCrypto:Secret", rotated);
            return;
        }

        var names = string.Join("、", unreadable);
        var message =
            $"以下模型相关 API key 用当前 ApiKeyCrypto:Secret 钥匙环解密为空：{names}。" +
            "所有依赖这些平台的模型池调用将以空凭据请求上游（401）。" +
            "典型原因：部署环境的数据加密密钥被轮换，或存量密文来自另一套历史密钥。" +
            "修复：配置 ApiKeyCrypto__LegacySecrets 后重启触发自动迁移，" +
            "或在模型平台重新保存各平台 API key。";

        _logger.LogError(
            "[PlatformKeyIntegrity] {Count} 个模型相关 API key 无法解密：{Names}。环境数据加密密钥与存量密文不匹配，模型池调用将全部失败",
            unreadable.Count, names);

        var now = DateTime.UtcNow;
        if (existing != null)
        {
            await db.AdminNotifications.UpdateOneAsync(
                n => n.Id == existing.Id,
                Builders<AdminNotification>.Update
                    .Set(x => x.Message, message)
                    .Set(x => x.UpdatedAt, now)
                    .Set(x => x.ExpiresAt, now.AddDays(7)),
                cancellationToken: ct);
            return;
        }

        await db.AdminNotifications.InsertOneAsync(new AdminNotification
        {
            Key = NotificationKey,
            TargetUserId = null, // 全局
            Title = "平台 API key 解密失败（环境密钥不匹配）",
            Message = message,
            Level = "error",
            Status = "open",
            Source = "platform-key-integrity",
            ActionLabel = "去模型平台检查",
            ActionUrl = "/mds",
            CreatedAt = now,
            UpdatedAt = now,
            ExpiresAt = now.AddDays(7),
        }, cancellationToken: ct);
    }
}
