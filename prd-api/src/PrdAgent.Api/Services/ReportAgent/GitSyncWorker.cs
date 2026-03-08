using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// Git 提交同步后台服务 — 定时检查数据源并拉取新提交
/// </summary>
public class GitSyncWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<GitSyncWorker> _logger;
    private readonly IConfiguration _configuration;
    private static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(5);

    public GitSyncWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<GitSyncWorker> logger,
        IConfiguration configuration)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
        _configuration = configuration;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("GitSyncWorker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(CheckInterval, stoppingToken);
                await SyncDueSourcesAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "GitSyncWorker loop error");
            }
        }

        _logger.LogInformation("GitSyncWorker stopped");
    }

    private async Task SyncDueSourcesAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

        var sources = await db.ReportDataSources.Find(
            s => s.Enabled && (s.SourceType == DataSourceType.Git || s.SourceType == DataSourceType.Svn)
        ).ToListAsync(ct);

        var now = DateTime.UtcNow;
        var cryptoKey = _configuration["Security:ApiKeyCryptoSecret"] ?? "default-report-agent-crypto-key-32";

        foreach (var source in sources)
        {
            var nextSync = (source.LastSyncAt ?? DateTime.MinValue).AddMinutes(source.PollIntervalMinutes);
            if (now < nextSync) continue;

            try
            {
                var token = string.IsNullOrEmpty(source.EncryptedAccessToken)
                    ? null
                    : ApiKeyCrypto.Decrypt(source.EncryptedAccessToken, cryptoKey);

                ICodeSourceConnector connector = source.SourceType == DataSourceType.Svn
                    ? new SvnConnector(source, token, db, _logger)
                    : new GitHubConnector(source, token, db, _logger);
                var synced = await connector.SyncAsync(ct);

                await db.ReportDataSources.UpdateOneAsync(
                    x => x.Id == source.Id,
                    Builders<ReportDataSource>.Update
                        .Set(x => x.LastSyncAt, DateTime.UtcNow)
                        .Set(x => x.LastSyncError, null)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: ct);

                if (synced > 0)
                    _logger.LogInformation("Git sync completed: source={Source}, synced={Count}", source.Name, synced);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Git sync failed for source={Source}", source.Name);

                await db.ReportDataSources.UpdateOneAsync(
                    x => x.Id == source.Id,
                    Builders<ReportDataSource>.Update
                        .Set(x => x.LastSyncError, ex.Message)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: ct);
            }
        }
    }
}
