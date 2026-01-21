using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 限流配置控制器
/// </summary>
[ApiController]
[Route("api/v1/admin/rate-limit")]
[Authorize]
[AdminController("rate-limit", AdminPermissionCatalog.SettingsRead, WritePermission = AdminPermissionCatalog.SettingsWrite)]
public class RateLimitController : ControllerBase
{
    private readonly IRateLimitService _rateLimitService;
    private readonly MongoDbContext _db;
    private readonly ILogger<RateLimitController> _logger;

    public RateLimitController(
        IRateLimitService rateLimitService,
        MongoDbContext db,
        ILogger<RateLimitController> logger)
    {
        _rateLimitService = rateLimitService;
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 获取全局限流配置
    /// </summary>
    [HttpGet("global")]
    public async Task<IActionResult> GetGlobalConfig(CancellationToken ct)
    {
        var config = await _rateLimitService.GetGlobalConfigAsync(ct);
        return Ok(ApiResponse<GlobalRateLimitConfig>.Ok(config));
    }

    /// <summary>
    /// 更新全局限流配置
    /// </summary>
    [HttpPut("global")]
    public async Task<IActionResult> UpdateGlobalConfig([FromBody] UpdateGlobalRateLimitRequest request, CancellationToken ct)
    {
        if (request.MaxRequestsPerMinute < 1 || request.MaxRequestsPerMinute > 100000)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "每分钟最大请求数必须在 1-100000 之间"));
        }

        if (request.MaxConcurrentRequests < 1 || request.MaxConcurrentRequests > 10000)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "最大并发请求数必须在 1-10000 之间"));
        }

        var config = new GlobalRateLimitConfig
        {
            MaxRequestsPerMinute = request.MaxRequestsPerMinute,
            MaxConcurrentRequests = request.MaxConcurrentRequests
        };

        await _rateLimitService.SetGlobalConfigAsync(config, ct);

        _logger.LogInformation("Global rate limit config updated: MaxRequestsPerMinute={MaxRpm}, MaxConcurrentRequests={MaxConcurrent}",
            config.MaxRequestsPerMinute, config.MaxConcurrentRequests);

        return Ok(ApiResponse<GlobalRateLimitConfig>.Ok(config));
    }

    /// <summary>
    /// 获取用户限流配置
    /// </summary>
    [HttpGet("users/{userId}")]
    public async Task<IActionResult> GetUserConfig(string userId, CancellationToken ct)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        var isExempt = await _rateLimitService.IsExemptAsync(userId, ct);
        var userConfig = await _rateLimitService.GetUserConfigAsync(userId, ct);
        var globalConfig = await _rateLimitService.GetGlobalConfigAsync(ct);

        var response = new UserRateLimitResponse
        {
            UserId = userId,
            Username = user.Username,
            DisplayName = user.DisplayName,
            IsExempt = isExempt,
            HasCustomConfig = userConfig != null,
            MaxRequestsPerMinute = userConfig?.MaxRequestsPerMinute ?? globalConfig.MaxRequestsPerMinute,
            MaxConcurrentRequests = userConfig?.MaxConcurrentRequests ?? globalConfig.MaxConcurrentRequests,
            GlobalMaxRequestsPerMinute = globalConfig.MaxRequestsPerMinute,
            GlobalMaxConcurrentRequests = globalConfig.MaxConcurrentRequests
        };

        return Ok(ApiResponse<UserRateLimitResponse>.Ok(response));
    }

    /// <summary>
    /// 更新用户限流配置
    /// </summary>
    [HttpPut("users/{userId}")]
    public async Task<IActionResult> UpdateUserConfig(string userId, [FromBody] UpdateUserRateLimitRequest request, CancellationToken ct)
    {
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        // 更新豁免状态
        if (request.IsExempt.HasValue)
        {
            await _rateLimitService.SetExemptAsync(userId, request.IsExempt.Value, ct);
            _logger.LogInformation("User {UserId} rate limit exempt status changed to {IsExempt}", userId, request.IsExempt.Value);
        }

        // 更新自定义配置
        if (request.UseCustomConfig == true)
        {
            if (!request.MaxRequestsPerMinute.HasValue || !request.MaxConcurrentRequests.HasValue)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "启用自定义配置时必须提供限流参数"));
            }

            if (request.MaxRequestsPerMinute < 1 || request.MaxRequestsPerMinute > 100000)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "每分钟最大请求数必须在 1-100000 之间"));
            }

            if (request.MaxConcurrentRequests < 1 || request.MaxConcurrentRequests > 10000)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "最大并发请求数必须在 1-10000 之间"));
            }

            var config = new UserRateLimitConfig
            {
                MaxRequestsPerMinute = request.MaxRequestsPerMinute.Value,
                MaxConcurrentRequests = request.MaxConcurrentRequests.Value
            };

            await _rateLimitService.SetUserConfigAsync(userId, config, ct);
            _logger.LogInformation("User {UserId} rate limit config updated: {Config}", userId, config);
        }
        else if (request.UseCustomConfig == false)
        {
            await _rateLimitService.RemoveUserConfigAsync(userId, ct);
            _logger.LogInformation("User {UserId} rate limit config removed (using global)", userId);
        }

        // 返回更新后的配置
        return await GetUserConfig(userId, ct);
    }

    /// <summary>
    /// 获取所有豁免用户列表
    /// </summary>
    [HttpGet("exempt-users")]
    public async Task<IActionResult> GetExemptUsers(CancellationToken ct)
    {
        var exemptUserIds = await _rateLimitService.GetAllExemptUsersAsync(ct);

        // 查询用户信息
        var users = await _db.Users
            .Find(u => exemptUserIds.Contains(u.UserId))
            .ToListAsync(ct);

        var items = users.Select(u => new ExemptUserItem
        {
            UserId = u.UserId,
            Username = u.Username,
            DisplayName = u.DisplayName
        }).ToList();

        return Ok(ApiResponse<ExemptUsersResponse>.Ok(new ExemptUsersResponse { Items = items }));
    }

    /// <summary>
    /// 获取所有有自定义配置的用户
    /// </summary>
    [HttpGet("custom-configs")]
    public async Task<IActionResult> GetCustomConfigs(CancellationToken ct)
    {
        var configs = await _rateLimitService.GetAllUserConfigsAsync(ct);
        var userIds = configs.Select(c => c.userId).ToList();

        // 查询用户信息
        var users = await _db.Users
            .Find(u => userIds.Contains(u.UserId))
            .ToListAsync(ct);

        var userDict = users.ToDictionary(u => u.UserId);

        var items = configs.Select(c =>
        {
            userDict.TryGetValue(c.userId, out var user);
            return new CustomConfigItem
            {
                UserId = c.userId,
                Username = user?.Username ?? "unknown",
                DisplayName = user?.DisplayName ?? "unknown",
                MaxRequestsPerMinute = c.config.MaxRequestsPerMinute,
                MaxConcurrentRequests = c.config.MaxConcurrentRequests
            };
        }).ToList();

        return Ok(ApiResponse<CustomConfigsResponse>.Ok(new CustomConfigsResponse { Items = items }));
    }
}

#region Request/Response DTOs

public class UpdateGlobalRateLimitRequest
{
    public int MaxRequestsPerMinute { get; set; }
    public int MaxConcurrentRequests { get; set; }
}

public class UpdateUserRateLimitRequest
{
    /// <summary>是否豁免限流</summary>
    public bool? IsExempt { get; set; }

    /// <summary>是否使用自定义配置（false 表示恢复默认）</summary>
    public bool? UseCustomConfig { get; set; }

    /// <summary>每分钟最大请求数（使用自定义配置时必填）</summary>
    public int? MaxRequestsPerMinute { get; set; }

    /// <summary>最大并发请求数（使用自定义配置时必填）</summary>
    public int? MaxConcurrentRequests { get; set; }
}

public class UserRateLimitResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public bool IsExempt { get; set; }
    public bool HasCustomConfig { get; set; }
    public int MaxRequestsPerMinute { get; set; }
    public int MaxConcurrentRequests { get; set; }
    public int GlobalMaxRequestsPerMinute { get; set; }
    public int GlobalMaxConcurrentRequests { get; set; }
}

public class ExemptUsersResponse
{
    public List<ExemptUserItem> Items { get; set; } = new();
}

public class ExemptUserItem
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
}

public class CustomConfigsResponse
{
    public List<CustomConfigItem> Items { get; set; } = new();
}

public class CustomConfigItem
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public int MaxRequestsPerMinute { get; set; }
    public int MaxConcurrentRequests { get; set; }
}

#endregion
