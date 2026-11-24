using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>持久化通知与申领请求解耦；不在预览投递，不自动重试结果不明的外部请求。</summary>
public sealed class ProductClaimWebhookWorker(IServiceProvider services, IConfiguration configuration,
    ILogger<ProductClaimWebhookWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (ProductClaimNotificationQueue.GetDeploymentBlockReason(configuration) is { } blocked)
        {
            logger.LogWarning("版本申领通知发送任务未启动：{Reason}", ProductClaimNotificationQueue.DescribeDeploymentBlock(blocked));
            return;
        }
        logger.LogInformation("版本申领通知发送任务已启动");
        await Task.Yield();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
                if (await ProductClaimWebhookBootstrap.TryInitializeAsync(db,
                    scope.ServiceProvider.GetRequiredService<IDataProtectionProvider>(), configuration))
                    logger.LogInformation("产品申领Webhook已完成默认初始化，地址已加密保存");
                var config = (await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync())?.ClaimWebhook;
                if (config?.Enabled == true && !string.IsNullOrEmpty(config.ProtectedUrl))
                {
                    await ProcessAsync(db.ProductInitiations, config, false, scope.ServiceProvider, stoppingToken);
                    await ProcessAsync(db.ProductReleases, config, true, scope.ServiceProvider, stoppingToken);
                    var notices = ProductVersionOperationNotice.Collection(db);
                    await ProcessAsync(notices, config, false, scope.ServiceProvider, stoppingToken, operationNotice: true);
                    await ProcessAsync(notices, config, true, scope.ServiceProvider, stoppingToken, operationNotice: true);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            // HTTP异常可能带密钥URL，不记录异常正文。
            catch (Exception ex) { logger.LogWarning("产品申领通知暂未处理，持久化任务保留。异常类型 {ErrorType}", ex.GetType().Name); }
            try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
        }
    }

    internal static async Task<ProductClaimNotification?> DispatchRecordAsync(
        string kind, string id, IServiceProvider services, bool manualDispatch)
    {
        var configuration = services.GetRequiredService<IConfiguration>();
        if (ProductClaimNotificationQueue.GetDeploymentBlockReason(configuration) is { } blocked)
            throw new InvalidOperationException(ProductClaimNotificationQueue.DescribeDeploymentBlock(blocked));
        var db = services.GetRequiredService<MongoDbContext>();
        var config = (await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync())?.ClaimWebhook;
        if (config?.Enabled != true || string.IsNullOrEmpty(config.ProtectedUrl)
            || (kind == "T" ? !config.NotifyInternal : !config.NotifyFormal))
            throw new InvalidOperationException("请先启用对应版本的申领通知并保存机器人地址。");
        if (kind == "T")
        {
            await ProcessAsync(db.ProductInitiations, config, false, services, CancellationToken.None,
                recordId: id, manualDispatch: manualDispatch);
            return (await db.ProductInitiations.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync())?.ClaimNotification;
        }
        if (kind == "V")
        {
            await ProcessAsync(db.ProductReleases, config, true, services, CancellationToken.None,
                recordId: id, manualDispatch: manualDispatch);
            return (await db.ProductReleases.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync())?.ClaimNotification;
        }
        throw new InvalidOperationException("不支持的通知类型。");
    }

    internal static async Task ProcessAsync<T>(IMongoCollection<T> collection, ProductClaimWebhookConfig config,
        bool formal, IServiceProvider services, CancellationToken stoppingToken, bool operationNotice = false,
        string? recordId = null, bool manualDispatch = false)
    {
        if (formal ? !config.NotifyFormal : !config.NotifyInternal) return;
        var filter = Builders<T>.Filter;
        var update = Builders<T>.Update;
        var requested = recordId is null ? filter.Empty : filter.Eq("_id", recordId);
        await collection.UpdateManyAsync(requested & filter.Eq("ClaimNotification.Status", "sending")
            & filter.Lt("ClaimNotification.NextAttemptAt", DateTime.UtcNow),
            update.Set("ClaimNotification.Status", "unknown").Set("ClaimNotification.Error", "投递结果未知，请先在企微群确认，避免重复通知"),
            cancellationToken: CancellationToken.None);
        var lease = Guid.NewGuid().ToString("N");
        var recordScope = operationNotice ? filter.Eq("Formal", formal) : filter.Eq("IsDeleted", false) & filter.Ne("Status", "voided");
        var eligible = requested & recordScope & (manualDispatch
            ? filter.In("ClaimNotification.Status", new[] { "pending", "debug_pending", "waiting_identity", "failed" })
            : filter.Eq("ClaimNotification.Status", "pending")
              | (filter.Eq("ClaimNotification.Status", "waiting_identity") & filter.Lte("ClaimNotification.NextAttemptAt", DateTime.UtcNow)));
        if (config.DebugMode && !operationNotice && !manualDispatch)
            eligible &= filter.Eq("ClaimNotification.ManualDispatchApproved", true);
        var claimUpdate = update.Set("ClaimNotification.Status", "sending").Set("ClaimNotification.LeaseId", lease)
                .Set("ClaimNotification.Error", (string?)null)
                .Set("ClaimNotification.NextAttemptAt", DateTime.UtcNow.AddMinutes(2)).Inc("ClaimNotification.Attempts", 1);
        if (manualDispatch) claimUpdate = claimUpdate.Set("ClaimNotification.ManualDispatchApproved", true);
        var record = await collection.FindOneAndUpdateAsync(eligible, claimUpdate,
            new FindOneAndUpdateOptions<T>
            {
                ReturnDocument = ReturnDocument.After,
                Sort = operationNotice ? Builders<T>.Sort.Ascending("ClaimNotification.NextAttemptAt") : null,
            }, CancellationToken.None);
        if (record is null) return;
        ProductClaimNotification? task = record switch {
            ProductInitiation t => t.ClaimNotification,
            ProductRelease v => v.ClaimNotification,
            ProductVersionOperationNotice notice => notice.ClaimNotification,
            _ => null,
        };
        if (task == null) return;
        var status = "failed";
        string? error = null;
        var started = false;
        try
        {
            var db = services.GetRequiredService<MongoDbContext>();
            ProductMentionTarget? mention = null;
            string text;
            if (record is ProductVersionOperationNotice notice)
            {
                text = notice.Text;
            }
            else
            {
                text = formal
                    ? ProductVersionCopyTemplate.Build(JsonSerializer.Deserialize<ProductRelease>(task.Snapshot)!)
                    : ProductVersionCopyTemplate.Build(JsonSerializer.Deserialize<ProductInitiation>(task.Snapshot)!);
                var owner = await db.Users.Find(user => user.UserId == task.OwnerId).FirstOrDefaultAsync();
                if (owner == null || owner.Status != UserStatus.Active || owner.UserType != UserType.Human)
                    throw new InvalidOperationException("负责人账号不可用，请核对记录，编号不受影响");
                mention = ProductClaimMentionIdentity.Resolve(owner, services.GetRequiredService<IDataProtectionProvider>());
            }
            var payload = ProductClaimWebhookPayload.Build(text, mention);
            var url = services.GetRequiredService<IDataProtectionProvider>()
                .CreateProtector(ProductClaimWebhookController.ProtectionPurpose).Unprotect(config.ProtectedUrl!);
            if (!ProductClaimWebhookPayload.IsValidWebhook(url)) throw new InvalidOperationException("Webhook配置无效，请重新保存配置");
            // 用户取消或删除后，已经被本实例取出的任务也不得继续投递。
            if (!await collection.Find(filter.Eq("ClaimNotification.LeaseId", lease)
                & filter.Eq("ClaimNotification.Status", "sending") & recordScope).AnyAsync()) return;
            var latestConfig = (await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync())?.ClaimWebhook;
            if (latestConfig?.Enabled != true || (formal ? !latestConfig.NotifyFormal : !latestConfig.NotifyInternal))
            {
                await collection.UpdateOneAsync(filter.Eq("ClaimNotification.LeaseId", lease) & filter.Eq("ClaimNotification.Status", "sending"),
                    update.Set("ClaimNotification.Status", "pending").Set("ClaimNotification.Error", (string?)null), cancellationToken: CancellationToken.None);
                return;
            }
            if (latestConfig.DebugMode && !operationNotice && !task.ManualDispatchApproved)
            {
                await collection.UpdateOneAsync(filter.Eq("ClaimNotification.LeaseId", lease) & filter.Eq("ClaimNotification.Status", "sending"),
                    update.Set("ClaimNotification.Status", "debug_pending").Set("ClaimNotification.Error", (string?)null), cancellationToken: CancellationToken.None);
                return;
            }
            var client = services.GetRequiredService<IHttpClientFactory>().CreateClient("product-claim-webhook");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            started = true;
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var response = await client.PostAsync(url, content, timeout.Token);
            if (!response.IsSuccessStatusCode) { status = "unknown"; error = $"企微响应异常（HTTP {(int)response.StatusCode}），请先核对群消息，避免重复发送。"; }
            else
            {
                using var result = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
                var success = result.RootElement.TryGetProperty("errcode", out var code) && code.TryGetInt32(out var n) && n == 0;
                status = success ? "sent" : "failed";
                if (success && mention == null && !operationNotice)
                    services.GetService<ILogger<ProductClaimWebhookWorker>>()?.LogWarning(
                        "产品申领通知已发送，负责人企微身份未同步，本次未艾特。任务租约 {LeaseId}", lease);
                if (!success)
                {
                    if (result.RootElement.TryGetProperty("errcode", out var rejected) && rejected.TryGetInt32(out var errorCode))
                        error = $"企微拒绝通知（错误码 {errorCode}），请检查群机器人配置；版本号不受影响。";
                    else { status = "unknown"; error = "企微未返回可确认的结果，请先核对群消息，避免重复发送。"; }
                }
            }
        }
        catch (System.Security.Cryptography.CryptographicException) when (!started)
        { error = "当前实例无法解密机器人配置，请在正式环境重新保存 Webhook 地址后，再从本记录补发。"; }
        catch (JsonException) when (!started)
        { error = "通知内容无法读取，本次未投递；请联系管理员核对记录，无需重新申领版本号。"; }
        catch (OperationCanceledException) when (started)
        { status = "unknown"; error = "通知投递超时或被中断，结果待确认；请先核对企微群消息，避免重复发送。"; }
        catch (InvalidOperationException ex) when (!started) { error = ex.Message; }
        catch (Exception) { status = started ? "unknown" : "failed"; error = started ? "通知投递结果未知，请先检查企微群，避免重复通知" : "通知未发送，请检查Webhook配置"; }
        await collection.UpdateOneAsync(filter.Eq("ClaimNotification.LeaseId", lease)
                & filter.Eq("ClaimNotification.Status", "sending"),
            update.Set("ClaimNotification.Status", status).Set("ClaimNotification.Error", error)
                .Set("ClaimNotification.NextAttemptAt", DateTime.UtcNow.AddMinutes(1)), cancellationToken: CancellationToken.None);
        if (recordId is null) await Task.Delay(TimeSpan.FromSeconds(4), stoppingToken);
    }
}
