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
        string? Time, string? Date, int? Day, bool Enabled, string? WebhookUrl, string? Revision,
        bool? MentionAll = null, string? SourceTaskId = null,
        ScheduledNotificationWebhookInput?[]? Webhooks = null, string? SourceRevision = null);

    public sealed record ScheduledNotificationWebhookInput(int? ExistingIndex, string? Url,
        string? GroupId = null, string? GroupRevision = null);
    public sealed record ScheduledNotificationEnablementRequest(bool Enabled, string? Revision);

    private const int MaxScheduledNotificationWebhooks = 10;

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

    [HttpPatch("settings/scheduled-notifications/{id}/enabled")]
    public async Task<IActionResult> SetScheduledNotificationEnabled(string id, ScheduledNotificationEnablementRequest request,
        [FromServices] IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!ProductScheduledNotificationWorker.CanManage(configuration))
            return Conflict(ApiResponse<object>.Fail("NOTIFICATION_PRODUCTION_ONLY", "请在正式环境管理定时通知。"));

        var current = await _db.ProductScheduledNotifications.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (current == null)
            return NotFound(ApiResponse<object>.Fail("NOTIFICATION_NOT_FOUND", "任务不存在，请刷新列表。"));
        if (current.IsScheduleEnabled() == request.Enabled)
            return Ok(ApiResponse<object>.Ok(ScheduledNotificationView(current)));

        var now = DateTime.UtcNow;
        DateTime? next = null;
        if (request.Enabled && !current.HasCompletedOneTimeSchedule())
            ProductScheduledNotificationTiming.TryGetNext(current.Frequency, current.Time, current.Date, current.Day, now, out next);

        var update = Builders<ProductScheduledNotification>.Update
            .Set(x => x.Enabled, request.Enabled).Set(x => x.EnablementExplicit, true).Set(x => x.NextRunAt, next)
            .Set(x => x.UpdatedAt, now).Set(x => x.Revision, Guid.NewGuid().ToString("N"));
        var filter = Builders<ProductScheduledNotification>.Filter.Where(x => x.Id == id && x.Revision == request.Revision);
        var saved = await _db.ProductScheduledNotifications.FindOneAndUpdateAsync(
            filter, update,
            new FindOneAndUpdateOptions<ProductScheduledNotification> { ReturnDocument = ReturnDocument.After });
        return saved == null
            ? Conflict(ApiResponse<object>.Fail("NOTIFICATION_CHANGED", "任务已更新，请刷新列表后重试。"))
            : Ok(ApiResponse<object>.Ok(ScheduledNotificationView(saved)));
    }

    private async Task<IActionResult> SaveScheduledNotification(string? id, ScheduledNotificationRequest request,
        IDataProtectionProvider protection, IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!ProductScheduledNotificationWorker.CanManage(configuration))
            return Conflict(ApiResponse<object>.Fail("NOTIFICATION_PRODUCTION_ONLY", "请在正式环境管理定时通知。"));

        ProductScheduledNotification? current = null;
        if (id != null)
        {
            current = await _db.ProductScheduledNotifications.Find(x => x.Id == id).FirstOrDefaultAsync();
            if (current == null)
                return NotFound(ApiResponse<object>.Fail("NOTIFICATION_NOT_FOUND", "任务不存在，请刷新列表。"));
            if (current.LeaseId != null)
                return Conflict(ApiResponse<object>.Fail("NOTIFICATION_IN_PROGRESS", "这条通知正在发送，请发送结束后再编辑。"));
        }

        var now = DateTime.UtcNow;
        var name = request.Name?.Trim() ?? "";
        var message = request.Message?.Trim() ?? "";
        if (name.Length is 0 or > 100 || message.Length == 0 || Encoding.UTF8.GetByteCount(message) > 2048)
            return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_TEXT", "请输入任务名称和通知内容，名称最多 100 字，内容最多 2048 字节。"));
        if (!ProductScheduledNotificationTiming.TryGetNext(request.Frequency, request.Time, request.Date, request.Day, now, out var next))
            return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_SCHEDULE", "请填写有效的北京时间与周期。"));
        var date = request.Frequency == "once" ? request.Date : null;
        var day = request.Frequency is "weekly" or "monthly" ? request.Day : null;

        var original = current;
        var existingWebhooks = current?.GetProtectedWebhooks() ?? [];
        var existingGroupNames = current?.WebhookGroupNames;
        if (id == null && !string.IsNullOrEmpty(request.SourceTaskId))
        {
            var source = await _db.ProductScheduledNotifications.Find(x => x.Id == request.SourceTaskId).FirstOrDefaultAsync();
            if (source == null || (request.SourceRevision != null && source.Revision != request.SourceRevision))
                return Conflict(ApiResponse<object>.Fail("NOTIFICATION_SOURCE_CHANGED", "原任务已更新，请关闭后重新复制。"));
            existingWebhooks = source.GetProtectedWebhooks();
            existingGroupNames = source.WebhookGroupNames;
            original = source;
        }

        var requestedWebhooks = request.Webhooks;
        if (requestedWebhooks == null && !string.IsNullOrWhiteSpace(request.WebhookUrl))
            requestedWebhooks = [new(null, request.WebhookUrl)];
        var protectedWebhooks = existingWebhooks;
        var groupNames = existingGroupNames;
        if (requestedWebhooks != null)
        {
            if (requestedWebhooks.Length is < 1 or > MaxScheduledNotificationWebhooks)
                return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_WEBHOOK_COUNT", "请配置 1 至 10 个企业微信群机器人 Webhook。"));

            var protector = protection.CreateProtector(ProductScheduledNotificationTiming.ProtectionPurpose);
            var keys = new HashSet<string>(StringComparer.Ordinal);
            var directory = requestedWebhooks.Any(entry => entry?.GroupId != null)
                ? (await GetProductAgentSettingsAsync())?.ScheduledNotificationGroups
                : null;
            protectedWebhooks = new string[requestedWebhooks.Length];
            groupNames = new string?[requestedWebhooks.Length];
            for (var i = 0; i < requestedWebhooks.Length; i++)
            {
                var entry = requestedWebhooks[i];
                string? url = entry?.Url?.Trim();
                string? encrypted = null;
                if (entry?.GroupId is string groupId)
                {
                    if (url != null || entry.ExistingIndex != null)
                        return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_WEBHOOK", $"第 {i + 1} 个地址只能选择常用群或手动填写。"));
                    var group = directory?.Items.Find(item => item.Id == groupId);
                    if (group == null || group.Revision != entry.GroupRevision) return NotificationGroupChanged();
                    encrypted = group.ProtectedWebhook;
                    groupNames[i] = group.Name;
                }
                else if (entry?.ExistingIndex is int index)
                {
                    if (url != null || index < 0 || index >= existingWebhooks.Length
                        || (id == null && request.SourceRevision == null))
                        return BadRequest(ApiResponse<object>.Fail("NOTIFICATION_WEBHOOK_UNAVAILABLE", "已保存的 Webhook 发生变化，请刷新后重试。"));
                    encrypted = existingWebhooks[index];
                    if (existingGroupNames != null && index < existingGroupNames.Length)
                        groupNames[i] = existingGroupNames[index];
                }
                if (encrypted != null)
                {
                    try { url = protector.Unprotect(encrypted); }
                    catch (System.Security.Cryptography.CryptographicException)
                    {
                        return BadRequest(ApiResponse<object>.Fail("NOTIFICATION_WEBHOOK_UNAVAILABLE", $"第 {i + 1} 个 Webhook 无法读取，请更换该地址。"));
                    }
                }
                if (url is not { Length: <= 512 } || !ProductClaimWebhookPayload.IsValidWebhook(url))
                    return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_WEBHOOK", $"请检查第 {i + 1} 个企业微信群机器人 Webhook。"));
                var key = new Uri(url).Query[5..];
                if (Guid.TryParseExact(key, "D", out var parsedKey)) key = parsedKey.ToString("D");
                if (!keys.Add(key))
                    return BadRequest(ApiResponse<object>.Fail("DUPLICATE_NOTIFICATION_WEBHOOK", $"第 {i + 1} 个 Webhook 已配置，请移除重复地址。"));
                protectedWebhooks[i] = encrypted ?? protector.Protect(url);
            }
        }
        if (protectedWebhooks.Length == 0)
            return BadRequest(ApiResponse<object>.Fail("NOTIFICATION_WEBHOOK_UNAVAILABLE", "请至少配置一个企业微信群机器人 Webhook。"));

        var sameSchedule = original != null && original.Frequency == request.Frequency && original.Time == request.Time
            && original.Date == date && original.Day == day;
        ProductNotificationOneTimeRunState? oneTimeRunState = request.Frequency == "once"
            ? (sameSchedule ? original!.GetOneTimeRunState() : ProductNotificationOneTimeRunState.Pending)
            : null;
        var enabled = id == null && original != null ? original.IsScheduleEnabled() : request.Enabled;
        if (sameSchedule && current?.NextRunAt is { } existingNext) next = existingNext;
        if (!enabled || oneTimeRunState is ProductNotificationOneTimeRunState.Attempted or ProductNotificationOneTimeRunState.Sent)
            next = null;

        var task = new ProductScheduledNotification
        {
            Name = name,
            Message = message,
            MentionAll = request.MentionAll ?? true,
            ProtectedWebhook = protectedWebhooks[0],
            ProtectedWebhooks = protectedWebhooks,
            WebhookGroupNames = groupNames,
            Frequency = request.Frequency!,
            Time = request.Time!,
            Date = date,
            Day = day,
            Enabled = enabled,
            EnablementExplicit = true,
            OneTimeRunState = oneTimeRunState,
            NextRunAt = next,
            UpdatedAt = now,
        };
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
            .Set(x => x.EnablementExplicit, true).Set(x => x.OneTimeRunState, task.OneTimeRunState)
            .Set(x => x.UpdatedAt, task.UpdatedAt).Set(x => x.Revision, task.Revision);
        if (requestedWebhooks != null)
            update = update.Set(x => x.ProtectedWebhook, task.ProtectedWebhook).Set(x => x.ProtectedWebhooks, task.ProtectedWebhooks)
                .Set(x => x.WebhookGroupNames, task.WebhookGroupNames);
        if (request.MentionAll.HasValue) update = update.Set(x => x.MentionAll, request.MentionAll.Value);
        var filter = Builders<ProductScheduledNotification>.Filter.Where(x => x.Id == id && x.Revision == request.Revision && x.LeaseId == null);
        var saved = await _db.ProductScheduledNotifications.FindOneAndUpdateAsync(
            filter, update,
            new FindOneAndUpdateOptions<ProductScheduledNotification> { ReturnDocument = ReturnDocument.After });
        return saved == null
            ? Conflict(ApiResponse<object>.Fail("NOTIFICATION_CHANGED", "任务已执行或发生变更，请刷新列表后重新编辑。"))
            : Ok(ApiResponse<object>.Ok(ScheduledNotificationView(saved)));
    }

    private static object ScheduledNotificationView(ProductScheduledNotification task) => new
    {
        task.Id, task.Revision, task.Name, task.Message, task.Frequency, task.Time, task.Date, task.Day,
        enabled = task.IsScheduleEnabled(), task.MentionAll, task.NextRunAt, task.LastRunAt, task.LastResult, task.LastDelivery,
        scheduleSent = task.Frequency == "once" && task.GetOneTimeRunState() == ProductNotificationOneTimeRunState.Sent,
        canEdit = true,
        canDebug = !task.HasCompletedOneTimeSchedule(),
        webhookCount = task.GetProtectedWebhooks().Length,
        webhookConfigured = task.GetProtectedWebhooks().Length > 0,
        task.WebhookGroupNames,
        debugLastResult = task.DebugRun?.Status,
        debugLastRunAt = task.DebugRun?.RequestedAt,
        webhookMasked = ProductScheduledNotificationTiming.MaskedWebhook,
    };
}
