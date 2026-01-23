using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 会话控制器
/// </summary>
[ApiController]
[Route("api/v1/sessions")]
[Authorize]
public class SessionsController : ControllerBase
{
    private readonly ISessionService _sessionService;
    private readonly MongoDbContext _db;
    private readonly ILogger<SessionsController> _logger;

    public SessionsController(
        ISessionService sessionService,
        MongoDbContext db,
        ILogger<SessionsController> logger)
    {
        _sessionService = sessionService;
        _db = db;
        _logger = logger;
    }

    private static string? GetUserId(ClaimsPrincipal user)
        => user.FindFirst("sub")?.Value ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value;

    private async Task<bool> IsAdminAsync(string userId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userId)) return false;
        var u = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        return u?.Role == UserRole.ADMIN;
    }

    private async Task<bool> CanAccessSessionAsync(Session session, string userId, CancellationToken ct = default)
    {
        if (session == null || string.IsNullOrWhiteSpace(userId)) return false;
        if (session.DeletedAtUtc != null) return false;

        // 个人会话：必须 owner
        if (!string.IsNullOrWhiteSpace(session.OwnerUserId))
        {
            return string.Equals(session.OwnerUserId, userId, StringComparison.Ordinal);
        }

        // 群组会话：必须是成员（ADMIN 也需要是成员，避免“跨群随便读”）
        if (!string.IsNullOrWhiteSpace(session.GroupId))
        {
            var gid = session.GroupId.Trim();
            var count = await _db.GroupMembers.CountDocumentsAsync(
                x => x.GroupId == gid && x.UserId == userId,
                cancellationToken: ct);
            return count > 0;
        }

        // 兜底：无 owner / 无 groupId 的异常数据，拒绝访问
        return false;
    }

    /// <summary>
    /// 获取会话列表（IM 形态：个人会话）
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<SessionListResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListSessions([FromQuery] bool includeArchived = false, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var filter = Builders<Session>.Filter.Eq(x => x.OwnerUserId, userId)
                     & Builders<Session>.Filter.Eq(x => x.DeletedAtUtc, null);
        if (!includeArchived)
        {
            filter &= Builders<Session>.Filter.Eq(x => x.ArchivedAtUtc, null);
        }

        var items = await _db.Sessions
            .Find(filter)
            .SortByDescending(x => x.LastActiveAt)
            .Limit(200)
            .ToListAsync(ct);

        return Ok(ApiResponse<SessionListResponse>.Ok(new SessionListResponse
        {
            Items = items.Select(MapToResponse).ToList()
        }));
    }

    /// <summary>
    /// 获取会话信息
    /// </summary>
    [HttpGet("{sessionId}")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetSession(string sessionId, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.SESSION_NOT_FOUND, 
                "会话不存在"));
        }

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        // 读操作也视为“活跃”：用于桌面端/管理端做轻量 keep-alive
        await _sessionService.RefreshActivityAsync(sessionId);

        var response = MapToResponse(session);
        return Ok(ApiResponse<SessionResponse>.Ok(response));
    }

    /// <summary>
    /// 切换角色
    /// </summary>
    [HttpPut("{sessionId}/role")]
    [ProducesResponseType(typeof(ApiResponse<SwitchRoleResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> SwitchRole(string sessionId, [FromBody] SwitchRoleRequest request, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        // 仅 ADMIN 允许“切换回答机器人”（语义：选择 bot，而不是更改成员身份）
        var isAdmin = await IsAdminAsync(userId, ct);
        if (!isAdmin)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        try
        {
            var session = await _sessionService.SwitchRoleAsync(sessionId, request.Role);

            // 个人会话仅允许 owner 切换；群会话只允许群成员切换（用于调试）
            var canAccess = await CanAccessSessionAsync(session, userId, ct);
            if (!canAccess)
            {
                return StatusCode(StatusCodes.Status403Forbidden,
                    ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
            }
            
            var response = new SwitchRoleResponse
            {
                SessionId = session.SessionId,
                CurrentRole = session.CurrentRole
            };

            _logger.LogInformation("Session {SessionId} role switched to {Role}", 
                sessionId, request.Role);

            return Ok(ApiResponse<SwitchRoleResponse>.Ok(response));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.SESSION_NOT_FOUND, 
                "会话不存在或已过期"));
        }
    }

    /// <summary>
    /// 删除会话
    /// </summary>
    [HttpDelete("{sessionId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> DeleteSession(string sessionId, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }
        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        await _sessionService.DeleteAsync(sessionId);
        return NoContent();
    }

    /// <summary>
    /// 归档会话（个人会话 IM 形态）
    /// </summary>
    [HttpPost("{sessionId}/archive")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Archive(string sessionId, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        // 群会话暂不支持归档（避免影响群内共享对话体验）
        if (!string.IsNullOrWhiteSpace(session.GroupId))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "群会话不支持归档"));
        }

        var now = DateTime.UtcNow;
        await _db.Sessions.UpdateOneAsync(
            x => x.SessionId == session.SessionId && x.DeletedAtUtc == null,
            Builders<Session>.Update
                .Set(x => x.ArchivedAtUtc, now)
                .Set(x => x.LastActiveAt, now),
            cancellationToken: ct);

        var updated = await _sessionService.GetByIdAsync(session.SessionId);
        if (updated == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }
        return Ok(ApiResponse<SessionResponse>.Ok(MapToResponse(updated)));
    }

    /// <summary>
    /// 取消归档会话
    /// </summary>
    [HttpPost("{sessionId}/unarchive")]
    [ProducesResponseType(typeof(ApiResponse<SessionResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Unarchive(string sessionId, CancellationToken ct = default)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }

        var canAccess = await CanAccessSessionAsync(session, userId, ct);
        if (!canAccess)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));
        }

        if (!string.IsNullOrWhiteSpace(session.GroupId))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "群会话不支持归档"));
        }

        var now = DateTime.UtcNow;
        await _db.Sessions.UpdateOneAsync(
            x => x.SessionId == session.SessionId && x.DeletedAtUtc == null,
            Builders<Session>.Update
                .Set(x => x.ArchivedAtUtc, null)
                .Set(x => x.LastActiveAt, now),
            cancellationToken: ct);

        var updated = await _sessionService.GetByIdAsync(session.SessionId);
        if (updated == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在"));
        }
        return Ok(ApiResponse<SessionResponse>.Ok(MapToResponse(updated)));
    }

    private static SessionResponse MapToResponse(Session session)
    {
        return new SessionResponse
        {
            SessionId = session.SessionId,
            GroupId = session.GroupId,
            OwnerUserId = session.OwnerUserId,
            Title = session.Title,
            CurrentRole = session.CurrentRole,
            Mode = session.Mode,
            CreatedAt = session.CreatedAt,
            LastActiveAt = session.LastActiveAt,
            ArchivedAtUtc = session.ArchivedAtUtc,
            DeletedAtUtc = session.DeletedAtUtc
        };
    }
}
