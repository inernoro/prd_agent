using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class ProductAgentController
{
    public sealed record NotificationDebugSettingsRequest(string? WebhookUrl);
    public sealed record NotificationDebugRequest(string? RequestId);

    [HttpGet("settings/scheduled-notifications/debug-settings")]
    public async Task<IActionResult> GetNotificationDebugSettings([FromServices] IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        var settings = await GetProductAgentSettingsAsync();
        var configured = !string.IsNullOrEmpty(settings?.ScheduledNotificationDebugWebhook);
        return Ok(ApiResponse<object>.Ok(new
        {
            configured,
            webhookMasked = configured ? ProductScheduledNotificationTiming.MaskedWebhook : null,
            canManage = ProductScheduledNotificationWorker.CanManage(configuration),
        }));
    }

    [HttpPut("settings/scheduled-notifications/debug-settings")]
    public async Task<IActionResult> SaveNotificationDebugSettings(NotificationDebugSettingsRequest request,
        [FromServices] IDataProtectionProvider protection, [FromServices] IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!ProductScheduledNotificationWorker.CanManage(configuration))
            return Conflict(ApiResponse<object>.Fail("NOTIFICATION_PRODUCTION_ONLY", "请在正式环境配置调试群。"));
        var url = request.WebhookUrl?.Trim();
        if (url is not { Length: <= 512 } || !ProductClaimWebhookPayload.IsValidWebhook(url))
            return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_WEBHOOK", "请输入有效的企业微信群机器人 Webhook 地址。"));
        var settings = await EnsureProductAgentSettingsAsync(GetUserId());
        if (settings == null)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "请联系产品管理应用管理员配置调试群。"));
        await _db.ProductAgentSettings.UpdateOneAsync(x => x.Id == ProductAgentSettings.SingletonId,
            Builders<ProductAgentSettings>.Update.Set(x => x.ScheduledNotificationDebugWebhook,
                    protection.CreateProtector(ProductScheduledNotificationTiming.ProtectionPurpose).Protect(url))
                .Set(x => x.UpdatedBy, GetUserId()).Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { configured = true, webhookMasked = ProductScheduledNotificationTiming.MaskedWebhook }));
    }

    [HttpPost("settings/scheduled-notifications/{id}/debug")]
    public async Task<IActionResult> DebugScheduledNotification(string id, NotificationDebugRequest request,
        [FromServices] IDataProtectionProvider protection, [FromServices] IConfiguration configuration,
        [FromServices] IHttpClientFactory clients)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!ProductScheduledNotificationWorker.CanManage(configuration))
            return Conflict(ApiResponse<object>.Fail("NOTIFICATION_PRODUCTION_ONLY", "请在正式环境执行通知调试。"));
        if (!Guid.TryParseExact(request.RequestId, "N", out _))
            return BadRequest(ApiResponse<object>.Fail("INVALID_DEBUG_REQUEST", "调试请求无效，请刷新后重试。"));
        var task = await _db.ProductScheduledNotifications.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (task == null)
            return NotFound(ApiResponse<object>.Fail("NOTIFICATION_NOT_FOUND", "任务不存在，请刷新列表。"));
        if (task.DebugRun?.Id == request.RequestId)
            return Ok(ApiResponse<object>.Ok(new { status = task.DebugRun.Status }));
        if (task.HasCompletedOneTimeSchedule())
            return Conflict(ApiResponse<object>.Fail("ONE_TIME_NOTIFICATION_LOCKED", "这条单次通知已执行，请复制为新任务后调试。"));
        var settings = await GetProductAgentSettingsAsync();
        var protectedUrl = settings?.ScheduledNotificationDebugWebhook;
        if (string.IsNullOrEmpty(protectedUrl))
            return BadRequest(ApiResponse<object>.Fail("DEBUG_WEBHOOK_REQUIRED", "请先打开调试设置，配置固定调试群。"));

        var now = DateTime.UtcNow;
        var run = new ProductNotificationDebugRun { Id = request.RequestId!, RequestedAt = now, LeaseUntil = now.AddMinutes(2) };
        var filter = Builders<ProductScheduledNotification>.Filter.Where(x => x.Id == id
            && x.Revision == task.Revision
            && (x.DebugRun == null || (x.DebugRun.Id != request.RequestId
                && (x.DebugRun.Status != "sending" || x.DebugRun.LeaseUntil <= now))));
        var claimed = await _db.ProductScheduledNotifications.UpdateOneAsync(filter,
            Builders<ProductScheduledNotification>.Update.Set(x => x.DebugRun, run), cancellationToken: CancellationToken.None);
        if (claimed.ModifiedCount == 0)
        {
            var current = await _db.ProductScheduledNotifications.Find(x => x.Id == id).FirstOrDefaultAsync();
            if (current?.DebugRun?.Id == request.RequestId)
                return Ok(ApiResponse<object>.Ok(new { status = current.DebugRun.Status }));
            return Conflict(ApiResponse<object>.Fail("DEBUG_IN_PROGRESS", "已有调试正在发送，请等待结果并检查群消息。"));
        }

        var status = await ProductScheduledNotificationWorker.DeliverAsync(task, protectedUrl, protection, clients, CancellationToken.None);
        await _db.ProductScheduledNotifications.UpdateOneAsync(x => x.Id == id && x.DebugRun != null && x.DebugRun.Id == run.Id,
            Builders<ProductScheduledNotification>.Update.Set(x => x.DebugRun!.Status, status), cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { status }));
    }
}
