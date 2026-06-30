using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Api.Models;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/dashboard/notifications")]
[Authorize]
[AdminController("dashboard", AdminPermissionCatalog.Access)]
public sealed class NotificationsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly AdminPushNotificationService _pushService;
    private readonly AdminNotificationEventService _eventService;

    public NotificationsController(
        MongoDbContext db,
        AdminPushNotificationService pushService,
        AdminNotificationEventService eventService)
    {
        _db = db;
        _pushService = pushService;
        _eventService = eventService;
    }

    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> List([FromQuery] bool includeHandled = false, CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;
        var filter = Builders<AdminNotification>.Filter.Empty;

        // 过滤：全局通知（TargetUserId 为空）或针对当前用户的通知
        filter &= Builders<AdminNotification>.Filter.Or(
            Builders<AdminNotification>.Filter.Eq(x => x.TargetUserId, null),
            Builders<AdminNotification>.Filter.Eq(x => x.TargetUserId, userId));

        filter &= Builders<AdminNotification>.Filter.Or(
            Builders<AdminNotification>.Filter.Eq(x => x.ExpiresAt, null),
            Builders<AdminNotification>.Filter.Gt(x => x.ExpiresAt, now));

        if (!includeHandled)
        {
            filter &= Builders<AdminNotification>.Filter.Eq(x => x.Status, "open");
        }

        var items = await _db.AdminNotifications
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Limit(200)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            items = items.Select(x => new
            {
                x.Id,
                x.Key,
                x.Title,
                x.Message,
                x.Level,
                x.Status,
                x.ActionLabel,
                x.ActionUrl,
                x.ActionKind,
                x.Source,
                attachments = x.Attachments,
                x.CreatedAt,
                x.UpdatedAt,
                x.HandledAt,
                x.ExpiresAt
            })
        }));
    }

    [HttpGet("subscriptions")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListSubscriptions(CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();
        var defaultProfile = await _pushService.GetDefaultProfileAsync(userId, ct);
        var subscriptions = await _pushService.GetSubscriptionsAsync(userId, ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            topics = AdminPushNotificationService.TopicDefinitions,
            presets = AdminPushNotificationService.PresetDefinitions,
            resources = AdminPushNotificationService.ResourceDefinitions,
            placeholders = new[] { "appname", "title", "message", "level", "source", "actionUrl", "iconUrl", "imageUrl", "createdAt", "notificationId" },
            defaultProfile,
            subscriptions
        }));
    }

    [HttpPut("subscriptions/default-profile")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpsertDefaultProfile(
        [FromBody] AdminPushProfileUpsertRequest request,
        CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var defaultProfile = await _pushService.UpsertDefaultProfileAsync(userId, request, ct);
            return Ok(ApiResponse<object>.Ok(new { defaultProfile }));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpPut("subscriptions/{topicKey}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpsertSubscription(
        [FromRoute] string topicKey,
        [FromBody] AdminPushSubscriptionUpsertRequest request,
        CancellationToken ct = default)
    {
        request.TopicKey = topicKey;
        var userId = this.GetRequiredUserId();
        try
        {
            var subscription = await _pushService.UpsertSubscriptionAsync(userId, request, ct);
            return Ok(ApiResponse<object>.Ok(new { subscription }));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpPost("subscriptions/{topicKey}/test")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> TestSubscription(
        [FromRoute] string topicKey,
        [FromBody] AdminPushSubscriptionUpsertRequest request,
        CancellationToken ct = default)
    {
        request.TopicKey = topicKey;
        var userId = this.GetRequiredUserId();
        try
        {
            var delivery = await _pushService.SendTestAsync(userId, request, ct);
            return Ok(ApiResponse<object>.Ok(new { delivery }));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpPost("events")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CreateEvent([FromBody] AdminNotificationEventRequest request, CancellationToken ct = default)
    {
        if (!HasAdminNotificationEventPermission())
        {
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权创建管理员通知事件"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var result = await _eventService.CreateAsync(request, userId, ct);
            var n = result.Notification;
            return Ok(ApiResponse<object>.Ok(new
            {
                created = result.Created,
                notification = new
                {
                    n.Id,
                    n.Key,
                    n.Title,
                    n.Message,
                    n.Level,
                    n.Status,
                    n.ActionLabel,
                    n.ActionUrl,
                    n.ActionKind,
                    n.Source,
                    attachments = n.Attachments,
                    n.CreatedAt,
                    n.UpdatedAt,
                    n.ExpiresAt
                }
            }));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpPost("{id}/handle")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Handle([FromRoute] string id, CancellationToken ct = default)
    {
        var nid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(nid))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));
        }

        var now = DateTime.UtcNow;
        var update = Builders<AdminNotification>.Update
            .Set(x => x.Status, "handled")
            .Set(x => x.HandledAt, now)
            .Set(x => x.UpdatedAt, now);

        await _db.AdminNotifications.UpdateOneAsync(x => x.Id == nid, update, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { handled = true }));
    }

    [HttpPost("handle-all")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> HandleAll(CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var filter = Builders<AdminNotification>.Filter.Eq(x => x.Status, "open");
        var update = Builders<AdminNotification>.Update
            .Set(x => x.Status, "handled")
            .Set(x => x.HandledAt, now)
            .Set(x => x.UpdatedAt, now);

        await _db.AdminNotifications.UpdateManyAsync(filter, update, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { handled = true }));
    }

    private bool HasAdminNotificationEventPermission()
    {
        if (string.Equals(User.FindFirst(AiAccessKeyAuthenticationHandler.ClaimTypeIsAiSuperAccess)?.Value, "1", StringComparison.Ordinal))
            return true;

        var permissions = User.FindAll("permissions").Select(x => x.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return permissions.Contains(AdminPermissionCatalog.Super)
            || permissions.Contains(AdminPermissionCatalog.SettingsWrite)
            || permissions.Contains(AdminPermissionCatalog.OpenPlatformManage)
            || permissions.Contains(AdminPermissionCatalog.AutomationsManage)
            || permissions.Contains(AdminPermissionCatalog.DefectAgentManage);
    }
}
