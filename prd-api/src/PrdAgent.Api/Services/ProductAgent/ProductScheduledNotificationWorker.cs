using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed class ProductScheduledNotificationWorker(MongoDbContext db, IDataProtectionProvider protection,
    IHttpClientFactory clients, IConfiguration configuration, ILogger<ProductScheduledNotificationWorker> logger) : BackgroundService
{
    public static bool CanManage(IConfiguration configuration) =>
        !DeploymentAuthority.IsCdsBranchPreview(configuration) && DeploymentAuthority.CanRunSharedScheduledWork(configuration);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!CanManage(configuration)) return;

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        do
        {
            try { await ProcessNextAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception) { logger.LogWarning("定时通知任务处理失败，将继续检查持久化任务。"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task ProcessNextAsync(CancellationToken stoppingToken)
    {
        var now = DateTime.UtcNow;
        var tasks = db.ProductScheduledNotifications;
        var updates = Builders<ProductScheduledNotification>.Update;
        await tasks.UpdateManyAsync(x => x.LeaseUntil != null && x.LeaseUntil <= now,
            updates.Set(x => x.LastResult, "unknown").Set(x => x.LeaseUntil, null).Set(x => x.LeaseId, null),
            cancellationToken: stoppingToken);

        var due = await tasks.Find(x => x.Enabled && x.NextRunAt != null && x.NextRunAt <= now && x.LeaseId == null)
            .SortBy(x => x.NextRunAt).FirstOrDefaultAsync(stoppingToken);
        if (due == null) return;
        ProductScheduledNotificationTiming.TryGetNext(due.Frequency, due.Time, due.Date, due.Day, now, out var next);
        var lease = Guid.NewGuid().ToString("N");
        var claimed = await tasks.UpdateOneAsync(
            x => x.Id == due.Id && x.Revision == due.Revision && x.NextRunAt == due.NextRunAt && x.LeaseId == null,
            updates.Set(x => x.LeaseId, lease).Set(x => x.LeaseUntil, now.AddMinutes(2))
                .Set(x => x.LastRunAt, now).Set(x => x.LastResult, "sending").Set(x => x.Revision, lease)
                .Set(x => x.Enabled, next != null).Set(x => x.NextRunAt, next),
            cancellationToken: stoppingToken);
        if (claimed.ModifiedCount == 0) return;

        var result = await DeliverAsync(due, stoppingToken);
        await tasks.UpdateOneAsync(x => x.Id == due.Id && x.LeaseId == lease,
            updates.Set(x => x.LastResult, result).Set(x => x.LeaseUntil, null).Set(x => x.LeaseId, null),
            cancellationToken: CancellationToken.None);
    }

    private async Task<string> DeliverAsync(ProductScheduledNotification task, CancellationToken stoppingToken)
    {
        var started = false;
        try
        {
            var url = protection.CreateProtector(ProductScheduledNotificationTiming.ProtectionPurpose).Unprotect(task.ProtectedWebhook);
            if (!ProductClaimWebhookPayload.IsValidWebhook(url)) return "failed";
            var payload = ProductClaimWebhookPayload.Build(task.Message, null);
            var client = clients.CreateClient("product-claim-webhook");
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            started = true;
            using var response = await client.PostAsync(url, content, stoppingToken);
            if (!response.IsSuccessStatusCode) return "unknown";
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(stoppingToken));
            if (!body.RootElement.TryGetProperty("errcode", out var code) || !code.TryGetInt32(out var value))
                return "unknown";
            return value == 0 ? "sent" : "failed";
        }
        catch (Exception)
        {
            // Exceptions and responses may contain the URL or credential.
            return started ? "unknown" : "failed";
        }
    }
}
