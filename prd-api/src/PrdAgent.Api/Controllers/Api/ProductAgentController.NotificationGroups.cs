using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class ProductAgentController
{
    public sealed record NotificationGroupRequest(string? Name, string? WebhookUrl, string? Revision);

    [HttpGet("settings/scheduled-notifications/groups")]
    public async Task<IActionResult> ListNotificationGroups([FromServices] IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!ProductScheduledNotificationWorker.CanManage(configuration)) return NotificationGroupsUnavailable();

        var settings = await GetProductAgentSettingsAsync();
        var groups = settings?.ScheduledNotificationGroups?.Items ?? [];
        return Ok(ApiResponse<object>.Ok(new { items = groups.Select(NotificationGroupView) }));
    }

    [HttpPost("settings/scheduled-notifications/groups")]
    public Task<IActionResult> CreateNotificationGroup(NotificationGroupRequest request,
        [FromServices] IDataProtectionProvider protection, [FromServices] IConfiguration configuration) =>
        SaveNotificationGroup(null, request, protection, configuration);

    [HttpPut("settings/scheduled-notifications/groups/{id}")]
    public Task<IActionResult> UpdateNotificationGroup(string id, NotificationGroupRequest request,
        [FromServices] IDataProtectionProvider protection, [FromServices] IConfiguration configuration) =>
        SaveNotificationGroup(id, request, protection, configuration);

    private async Task<IActionResult> SaveNotificationGroup(string? id, NotificationGroupRequest request,
        IDataProtectionProvider protection, IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!ProductScheduledNotificationWorker.CanManage(configuration)) return NotificationGroupsUnavailable();

        var name = request.Name?.Trim() ?? "";
        if (name.Length is 0 or > 60)
            return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_GROUP_NAME", "请输入群名，最多 60 字。"));

        var settings = await EnsureProductAgentSettingsAsync(GetUserId());
        if (settings == null)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "请联系产品管理应用管理员管理常用群。"));

        var groups = settings.ScheduledNotificationGroups?.Items.ToList() ?? [];
        var index = id == null ? -1 : groups.FindIndex(group => group.Id == id);
        if (id != null && (index < 0 || groups[index].Revision != request.Revision)) return NotificationGroupChanged();
        if (id == null && groups.Count >= 100)
            return BadRequest(ApiResponse<object>.Fail("NOTIFICATION_GROUP_LIMIT", "最多保存 100 个常用群，请移除不用的群后重试。"));
        if (groups.Any(group => group.Id != id && string.Equals(group.Name, name, StringComparison.OrdinalIgnoreCase)))
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE_NOTIFICATION_GROUP_NAME", "该群名已存在，请使用其他名称。"));

        var url = request.WebhookUrl?.Trim();
        var protectedWebhook = index >= 0 ? groups[index].ProtectedWebhook : "";
        if (url != null || index < 0)
        {
            if (url is not { Length: <= 512 } || !ProductClaimWebhookPayload.IsValidWebhook(url))
                return BadRequest(ApiResponse<object>.Fail("INVALID_NOTIFICATION_WEBHOOK", "请输入有效的企业微信群机器人 Webhook 地址。"));
            protectedWebhook = protection.CreateProtector(ProductScheduledNotificationTiming.ProtectionPurpose).Protect(url);
        }

        var updated = new ProductNotificationGroup { Name = name, ProtectedWebhook = protectedWebhook };
        if (index >= 0)
        {
            updated.Id = groups[index].Id;
            groups[index] = updated;
        }
        else
        {
            groups.Add(updated);
        }

        return await WriteNotificationGroups(settings, groups)
            ? Ok(ApiResponse<object>.Ok(NotificationGroupView(updated)))
            : NotificationGroupChanged();
    }

    [HttpDelete("settings/scheduled-notifications/groups/{id}")]
    public async Task<IActionResult> RemoveNotificationGroup(string id, [FromQuery] string? revision,
        [FromServices] IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!ProductScheduledNotificationWorker.CanManage(configuration)) return NotificationGroupsUnavailable();

        var settings = await GetProductAgentSettingsAsync();
        if (settings?.ScheduledNotificationGroups is not { } directory) return NotificationGroupChanged();
        var group = directory.Items.Find(item => item.Id == id);
        if (group == null || group.Revision != revision) return NotificationGroupChanged();

        return await WriteNotificationGroups(settings, directory.Items.Where(item => item.Id != id).ToList())
            ? Ok(ApiResponse<object>.Ok(new { id }))
            : NotificationGroupChanged();
    }

    private async Task<bool> WriteNotificationGroups(ProductAgentSettings settings, List<ProductNotificationGroup> groups)
    {
        var filter = Builders<ProductAgentSettings>.Filter;
        var revision = settings.ScheduledNotificationGroups?.Revision;
        var match = filter.Eq(item => item.Id, ProductAgentSettings.SingletonId) &
            (revision == null
                ? filter.Eq(item => item.ScheduledNotificationGroups, null)
                : filter.Eq(item => item.ScheduledNotificationGroups!.Revision, revision));
        var update = Builders<ProductAgentSettings>.Update
            .Set(item => item.ScheduledNotificationGroups, new ProductNotificationGroupDirectory { Items = groups })
            .Set(item => item.UpdatedBy, GetUserId()).Set(item => item.UpdatedAt, DateTime.UtcNow);
        var result = await _db.ProductAgentSettings.UpdateOneAsync(match, update, cancellationToken: CancellationToken.None);
        return result.MatchedCount == 1;
    }

    private ConflictObjectResult NotificationGroupChanged() =>
        Conflict(ApiResponse<object>.Fail("NOTIFICATION_GROUP_CHANGED", "常用群已修改或移除，请刷新后重试。"));

    private ConflictObjectResult NotificationGroupsUnavailable() =>
        Conflict(ApiResponse<object>.Fail("NOTIFICATION_PRODUCTION_ONLY", "请在正式环境管理常用群。"));

    private static object NotificationGroupView(ProductNotificationGroup group) => new
    {
        group.Id, group.Name, group.Revision, webhookMasked = ProductScheduledNotificationTiming.MaskedWebhook,
    };
}
