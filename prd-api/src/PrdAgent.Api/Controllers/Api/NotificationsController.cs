using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
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

    public NotificationsController(MongoDbContext db, AdminPushNotificationService pushService)
    {
        _db = db;
        _pushService = pushService;
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

        await _pushService.DispatchForUserAsync(userId, items, ct);

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
        var subscriptions = await _pushService.GetSubscriptionsAsync(userId, ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            topics = AdminPushNotificationService.TopicDefinitions,
            presets = AdminPushNotificationService.PresetDefinitions,
            placeholders = new[] { "appname", "title", "message", "level", "source", "actionUrl", "createdAt", "notificationId" },
            subscriptions
        }));
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
}
