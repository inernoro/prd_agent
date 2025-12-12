using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Json;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 用户管理控制器
/// </summary>
[ApiController]
[Route("api/v1/admin/users")]
[Authorize(Roles = "ADMIN")]
public class AdminUsersController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminUsersController> _logger;

    public AdminUsersController(MongoDbContext db, ILogger<AdminUsersController> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 获取用户列表
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetUsers(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? role = null,
        [FromQuery] string? status = null,
        [FromQuery] string? search = null)
    {
        var filter = Builders<User>.Filter.Empty;

        if (!string.IsNullOrEmpty(role) && Enum.TryParse<UserRole>(role, true, out var r))
        {
            filter &= Builders<User>.Filter.Eq(u => u.Role, r);
        }

        if (!string.IsNullOrEmpty(status) && Enum.TryParse<UserStatus>(status, true, out var s))
        {
            filter &= Builders<User>.Filter.Eq(u => u.Status, s);
        }

        if (!string.IsNullOrEmpty(search))
        {
            filter &= Builders<User>.Filter.Or(
                Builders<User>.Filter.Regex(u => u.Username, new MongoDB.Bson.BsonRegularExpression(search, "i")),
                Builders<User>.Filter.Regex(u => u.DisplayName, new MongoDB.Bson.BsonRegularExpression(search, "i"))
            );
        }

        var total = await _db.Users.CountDocumentsAsync(filter);
        var users = await _db.Users.Find(filter)
            .SortByDescending(u => u.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        var response = new UserListResponse
        {
            Items = users.Select(u => new UserListItem
            {
                UserId = u.UserId,
                Username = u.Username,
                DisplayName = u.DisplayName,
                Role = u.Role.ToString(),
                Status = u.Status.ToString(),
                CreatedAt = u.CreatedAt,
                LastLoginAt = u.LastLoginAt
            }).ToList(),
            Total = total,
            Page = page,
            PageSize = pageSize
        };

        return Ok(ApiResponse<UserListResponse>.Ok(response));
    }

    /// <summary>
    /// 获取单个用户
    /// </summary>
    [HttpGet("{userId}")]
    public async Task<IActionResult> GetUser(string userId)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        var response = new UserDetailResponse
        {
            UserId = user.UserId,
            Username = user.Username,
            DisplayName = user.DisplayName,
            Role = user.Role.ToString(),
            Status = user.Status.ToString(),
            CreatedAt = user.CreatedAt,
            LastLoginAt = user.LastLoginAt
        };

        return Ok(ApiResponse<UserDetailResponse>.Ok(response));
    }

    /// <summary>
    /// 更新用户状态
    /// </summary>
    [HttpPut("{userId}/status")]
    public async Task<IActionResult> UpdateStatus(string userId, [FromBody] UpdateStatusRequest request)
    {
        var result = await _db.Users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.Status, request.Status));

        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        _logger.LogInformation("User {UserId} status updated to {Status}", userId, request.Status);

        var response = new UserStatusUpdateResponse
        {
            UserId = userId,
            Status = request.Status.ToString()
        };

        return Ok(ApiResponse<UserStatusUpdateResponse>.Ok(response));
    }

    /// <summary>
    /// 更新用户角色
    /// </summary>
    [HttpPut("{userId}/role")]
    public async Task<IActionResult> UpdateRole(string userId, [FromBody] UpdateRoleRequest request)
    {
        var result = await _db.Users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.Role, request.Role));

        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        _logger.LogInformation("User {UserId} role updated to {Role}", userId, request.Role);

        var response = new UserRoleUpdateResponse
        {
            UserId = userId,
            Role = request.Role.ToString()
        };

        return Ok(ApiResponse<UserRoleUpdateResponse>.Ok(response));
    }

    /// <summary>
    /// 生成邀请码
    /// </summary>
    [HttpPost("invite-codes")]
    public async Task<IActionResult> GenerateInviteCode([FromBody] GenerateInviteCodeRequest request)
    {
        var adminId = User.FindFirst("sub")?.Value ?? "system";
        var codes = new List<string>();

        for (int i = 0; i < request.Count; i++)
        {
            var code = $"PRD-{Guid.NewGuid().ToString("N")[..8].ToUpper()}";
            await _db.InviteCodes.InsertOneAsync(new InviteCode
            {
                Code = code,
                CreatorId = adminId,
                ExpiresAt = request.ExpiresInDays.HasValue 
                    ? DateTime.UtcNow.AddDays(request.ExpiresInDays.Value) 
                    : null
            });
            codes.Add(code);
        }

        var response = new InviteCodeGenerateResponse { Codes = codes };
        return Ok(ApiResponse<InviteCodeGenerateResponse>.Ok(response));
    }
}

public class UpdateStatusRequest
{
    public UserStatus Status { get; set; }
}

public class UpdateRoleRequest
{
    public UserRole Role { get; set; }
}

public class GenerateInviteCodeRequest
{
    public int Count { get; set; } = 1;
    public int? ExpiresInDays { get; set; }
}


