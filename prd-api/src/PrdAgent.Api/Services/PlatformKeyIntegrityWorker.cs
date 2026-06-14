using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 平台密钥完整性自检 —— 启动后及每 6 小时扫描全部启用平台，
/// 用当前 Jwt:Secret 试解密 ApiKeyEncrypted。「密文存在但解出为空」
/// 意味着部署环境的加密密钥与存量密文不匹配（典型诱因：CDS_JWT_SECRET
/// 被轮换后容器重建）——此前这种故障完全静默，直到用户撞上 401 才暴露。
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

    private async Task CheckAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var jwtSecret = _configuration["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";

        var platforms = await db.LLMPlatforms
            .Find(p => p.Enabled)
            .ToListAsync(ct);

        var unreadable = platforms
            .Where(p => !string.IsNullOrWhiteSpace(p.ApiKeyEncrypted)
                && string.IsNullOrWhiteSpace(ApiKeyCrypto.Decrypt(p.ApiKeyEncrypted, jwtSecret)))
            .Select(p => p.Name)
            .ToList();

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
                _logger.LogInformation("[PlatformKeyIntegrity] 平台密钥已恢复可解密，告警自动关闭");
            }
            return;
        }

        var names = string.Join("、", unreadable);
        var message =
            $"以下平台的 API key 用当前 Jwt:Secret 解密为空：{names}。" +
            "所有依赖这些平台的模型池调用将以空凭据请求上游（401）。" +
            "典型原因：部署环境的 JWT_SECRET 被轮换（如 CDS 全局密钥变更后容器重建）。" +
            "修复：恢复原 JWT_SECRET（或在 CDS 项目环境变量钉住 Jwt__Secret），" +
            "或在 模型平台 重新保存各平台 API key。";

        _logger.LogError(
            "[PlatformKeyIntegrity] {Count} 个平台 API key 无法解密：{Names}。环境加密密钥与存量密文不匹配，模型池调用将全部失败",
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
