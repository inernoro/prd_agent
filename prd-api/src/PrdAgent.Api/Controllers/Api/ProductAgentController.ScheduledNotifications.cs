using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Controllers.Api;

public partial class ProductAgentController
{
    public sealed record ScheduledNotificationRequest(string? Name, string? Message, string? Frequency,
        string? Time, string? Date, int? Day, bool Enabled, string? WebhookUrl, string? Revision);

    [HttpGet("settings/scheduled-notifications")]
    public async Task<IActionResult> ListScheduledNotifications([FromServices] IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!ProductScheduledNotificationWorker.CanManage(configuration))
            return Ok(ApiResponse<object>.Ok(new { canManage = false, items = Array.Empty<object>() }));

        var items = await _db.ProductScheduledNotifications.Find(FilterDefinition<ProductScheduledNotification>.Empty)
            .SortByDescending(x => x.UpdatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { canManage = true, items = items.Select(ScheduledNotificationView) }));
    }

    [HttpPost("settings/scheduled-notifications")]
    public Task<IActionResult> CreateScheduledNotification(ScheduledNotificationRequest request,
        [FromServices] IDataProtectionProvider protection, [FromServices] IConfiguration configuration) =>
        SaveScheduledNotification(null, request, protection, configuration);

    [HttpPut("settings/scheduled-notifications/{id}")]
    public Task<IActionResult> UpdateScheduledNotification(string id, ScheduledNotificationRequest request,
        [FromServices] IDataProtectionProvider protection, [FromServices] IConfiguration configuration) =>
        SaveScheduledNotification(id, request, protection, configuration);

    private async Task<IActionResult> SaveScheduledNotification(string? id, ScheduledNotificationRequest request,
        IDataProtectionProvider protection, IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!ProductScheduledNotificationWorker.CanManage(configuration))
            return Conflict(ApiResponse<object>.Fail("NOTIFICATION_PRODUCTION_ONLY", "请在正式环境管理定时通知。"));

        var now = DateTime.UtcNow;
        var name = request.Name?.Trim() ?? "";
        var message = request.Message?.Trim() ?? "";
        if (name.Length is 0 or > 100 || message.Length == 0 || Encoding.UTF8.GetByteCount(message) > 2048)
            return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_TEXT", "请输入任务名称和通知内容，名称最多 100 字，内容最多 2048 字节。"));
        if (!ProductScheduledNotificationTiming.TryGetNext(request.Frequency, request.Time, request.Date, request.Day, now, out var next)
            || (request.Enabled && next == null))
            return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_SCHEDULE", "请填写有效的北京时间与周期，启用单次通知时请选择未来时间。"));

        var webhook = request.WebhookUrl?.Trim();
        if ((id == null || !string.IsNullOrEmpty(webhook)) &&
            (webhook is not { Length: <= 512 } || !ProductClaimWebhookPayload.IsValidWebhook(webhook)))
            return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_WEBHOOK", "请输入有效的企业微信群机器人 Webhook 地址。"));

        var task = new ProductScheduledNotification
        {
            Name = name,
            Message = message,
            Frequency = request.Frequency!,
            Time = request.Time!,
            Date = request.Frequency == "once" ? request.Date : null,
            Day = request.Frequency is "weekly" or "monthly" ? request.Day : null,
            Enabled = request.Enabled,
            NextRunAt = request.Enabled ? next : null,
            UpdatedAt = now,
        };
        if (!string.IsNullOrEmpty(webhook))
            task.ProtectedWebhook = protection.CreateProtector(ProductScheduledNotificationTiming.ProtectionPurpose).Protect(webhook);
        if (id == null)
        {
            await _db.ProductScheduledNotifications.InsertOneAsync(task);
            return Ok(ApiResponse<object>.Ok(ScheduledNotificationView(task)));
        }

        var update = Builders<ProductScheduledNotification>.Update
            .Set(x => x.Name, task.Name).Set(x => x.Message, task.Message)
            .Set(x => x.Frequency, task.Frequency).Set(x => x.Time, task.Time)
            .Set(x => x.Date, task.Date).Set(x => x.Day, task.Day)
            .Set(x => x.Enabled, task.Enabled).Set(x => x.NextRunAt, task.NextRunAt)
            .Set(x => x.UpdatedAt, task.UpdatedAt).Set(x => x.Revision, task.Revision);
        if (task.ProtectedWebhook.Length > 0) update = update.Set(x => x.ProtectedWebhook, task.ProtectedWebhook);
        var filter = Builders<ProductScheduledNotification>.Filter.Where(x => x.Id == id && x.Revision == request.Revision);
        var saved = await _db.ProductScheduledNotifications.FindOneAndUpdateAsync(
            filter, update,
            new FindOneAndUpdateOptions<ProductScheduledNotification> { ReturnDocument = ReturnDocument.After });
        return saved == null
            ? Conflict(ApiResponse<object>.Fail("NOTIFICATION_CHANGED", "任务已变更，请刷新列表后重新编辑。"))
            : Ok(ApiResponse<object>.Ok(ScheduledNotificationView(saved)));
    }

    private static object ScheduledNotificationView(ProductScheduledNotification task) => new
    {
        task.Id, task.Revision, task.Name, task.Message, task.Frequency, task.Time, task.Date, task.Day,
        task.Enabled, task.NextRunAt, task.LastRunAt, task.LastResult,
        webhookMasked = ProductScheduledNotificationTiming.MaskedWebhook,
    };
}
