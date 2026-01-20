using System.Linq;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/authz/users")]
[Authorize]
[AdminController("authz", AdminPermissionCatalog.AuthzManage)]
public sealed class UserAuthzController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAdminPermissionService _permissionService;

    public UserAuthzController(MongoDbContext db, IAdminPermissionService permissionService)
    {
        _db = db;
        _permissionService = permissionService;
    }

    [HttpGet("{userId}/authz")]
    public async Task<IActionResult> GetUserAuthz([FromRoute] string userId, CancellationToken ct)
    {
        var uid = (userId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空"));

        var snap = await _permissionService.GetUserAuthzSnapshotAsync(uid, ct);
        if (snap == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));

        return Ok(ApiResponse<AdminUserAuthzSnapshot>.Ok(snap));
    }

    [HttpPut("{userId}/authz")]
    public async Task<IActionResult> UpdateUserAuthz([FromRoute] string userId, [FromBody] UpdateUserAuthzRequest req, CancellationToken ct)
    {
        var uid = (userId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空"));

        var existed = await _db.Users.Find(x => x.UserId == uid).FirstOrDefaultAsync(ct);
        if (existed == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));

        var roleKey = (req?.SystemRoleKey ?? string.Empty).Trim().ToLowerInvariant();
        roleKey = string.IsNullOrWhiteSpace(roleKey) ? null : roleKey;

        static List<string>? Norm(List<string>? list)
        {
            if (list == null) return null;
            var items = list
                .Select(x => (x ?? string.Empty).Trim())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Distinct(StringComparer.Ordinal)
                .ToList();
            return items;
        }

        var allow = Norm(req?.PermAllow);
        var deny = Norm(req?.PermDeny);

        var update = Builders<PrdAgent.Core.Models.User>.Update
            .Set(x => x.SystemRoleKey, roleKey)
            .Set(x => x.PermAllow, allow)
            .Set(x => x.PermDeny, deny);

        await _db.Users.UpdateOneAsync(x => x.UserId == uid, update, cancellationToken: ct);

        var snap = await _permissionService.GetUserAuthzSnapshotAsync(uid, ct);
        return Ok(ApiResponse<AdminUserAuthzSnapshot>.Ok(snap!));
    }
}

