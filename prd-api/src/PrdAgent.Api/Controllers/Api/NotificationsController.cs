using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
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

    public NotificationsController(MongoDbContext db)
    {
        _db = db;
    }

    private string? GetUserId() => User.FindFirst("userId")?.Value ?? User.FindFirst("sub")?.Value;

    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> List([FromQuery] bool includeHandled = false, CancellationToken ct = default)
    {
        var userId = GetUserId();
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
                x.CreatedAt,
                x.UpdatedAt,
                x.HandledAt,
                x.ExpiresAt
            })
        }));
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
