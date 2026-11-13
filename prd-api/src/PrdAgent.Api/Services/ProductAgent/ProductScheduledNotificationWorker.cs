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
            catch (Exception ex) { logger.LogWarning("定时通知任务处理失败，将继续检查持久化任务。错误类型 {ErrorType}", ex.GetType().Name); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    internal async Task ProcessNextAsync(CancellationToken stoppingToken)
    {
        var now = DateTime.UtcNow;
        var tasks = db.ProductScheduledNotifications;
        var updates = Builders<ProductScheduledNotification>.Update;
        await tasks.UpdateManyAsync(x => x.LeaseUntil != null && x.LeaseUntil <= now,
            updates.Set(x => x.LastResult, "unknown").Set(x => x.LeaseUntil, null).Set(x => x.LeaseId, null),
            cancellationToken: CancellationToken.None);
        await tasks.UpdateManyAsync(x => x.DebugRun != null && x.DebugRun.Status == "sending" && x.DebugRun.LeaseUntil <= now,
            updates.Set(x => x.DebugRun!.Status, "unknown"), cancellationToken: CancellationToken.None);

        var due = await tasks.Find(x => x.Enabled && x.NextRunAt != null && x.NextRunAt <= now && x.LeaseId == null)
            .SortBy(x => x.NextRunAt).FirstOrDefaultAsync(stoppingToken);
        if (due == null) return;
        DateTime? next = null;
        if (due.Frequency != "once")
            ProductScheduledNotificationTiming.TryGetNext(due.Frequency, due.Time, due.Date, due.Day, now, out next);
        var lease = Guid.NewGuid().ToString("N");
        var claim = updates.Set(x => x.LeaseId, lease).Set(x => x.LeaseUntil, now.AddMinutes(2))
            .Set(x => x.LastRunAt, now).Set(x => x.LastResult, "sending").Set(x => x.Revision, lease)
            .Set(x => x.LastDelivery, null).Set(x => x.NextRunAt, next);
        if (due.Frequency == "once")
            claim = claim.Set(x => x.OneTimeRunState, ProductNotificationOneTimeRunState.Attempted);
        var claimed = await tasks.UpdateOneAsync(
            x => x.Id == due.Id && x.Enabled && x.Revision == due.Revision && x.NextRunAt == due.NextRunAt && x.LeaseId == null,
            claim,
            cancellationToken: CancellationToken.None);
        if (claimed.ModifiedCount == 0) return;

        var webhooks = due.GetProtectedWebhooks();
        var outcomes = await Task.WhenAll(webhooks.Select(webhook => DeliverAsync(due, webhook, protection, clients, stoppingToken)));
        var delivery = new ProductNotificationDelivery(outcomes.Count(x => x == "sent"),
            outcomes.Count(x => x == "failed"), outcomes.Count(x => x == "unknown"));
        var result = delivery.Sent > 0
            ? (delivery.Sent == outcomes.Length ? "sent" : "partial")
            : (delivery.Unknown > 0 ? "unknown" : "failed");
        var finish = updates.Set(x => x.LastResult, result).Set(x => x.LastDelivery, delivery)
            .Set(x => x.LeaseUntil, null).Set(x => x.LeaseId, null);
        if (due.Frequency == "once" && delivery.Sent > 0)
            finish = finish.Set(x => x.OneTimeRunState, ProductNotificationOneTimeRunState.Sent);
        await tasks.UpdateOneAsync(x => x.Id == due.Id && x.LeaseId == lease, finish, cancellationToken: CancellationToken.None);
    }

    internal static async Task<string> DeliverAsync(ProductScheduledNotification task, string protectedWebhook,
        IDataProtectionProvider protection, IHttpClientFactory clients, CancellationToken stoppingToken)
    {
        var started = false;
        try
        {
            var url = protection.CreateProtector(ProductScheduledNotificationTiming.ProtectionPurpose).Unprotect(protectedWebhook);
            if (!ProductClaimWebhookPayload.IsValidWebhook(url)) return "failed";
            var payload = ProductClaimWebhookPayload.Build(task.Message, null, task.MentionAll);
            using var client = clients.CreateClient("product-claim-webhook");
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
