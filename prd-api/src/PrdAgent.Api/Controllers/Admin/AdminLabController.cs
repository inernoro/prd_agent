using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.Tokens;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 实验室（模拟/演示）能力
/// </summary>
[ApiController]
[Route("api/v1/admin/lab")]
[Authorize(Roles = "ADMIN")]
public class AdminLabController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IConfiguration _config;
    private readonly ILogger<AdminLabController> _logger;

    public AdminLabController(MongoDbContext db, IConfiguration config, ILogger<AdminLabController> logger)
    {
        _db = db;
        _config = config;
        _logger = logger;
    }

    /// <summary>
    /// 冒充指定用户签发短期 JWT（仅用于实验室演示）
    /// </summary>
    [HttpPost("impersonate")]
    [ProducesResponseType(typeof(ApiResponse<AdminImpersonateResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Impersonate([FromBody] AdminImpersonateRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.UserId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空"));
        }

        var adminId = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? User.FindFirst("sub")?.Value ?? "unknown";

        var user = await _db.Users.Find(u => u.UserId == request.UserId.Trim()).FirstOrDefaultAsync();
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        if (user.Status == UserStatus.Disabled)
        {
            return BadRequest(ApiResponse<object>.Fail("ACCOUNT_DISABLED", "账号已被禁用"));
        }

        var jwtSecret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("JWT Secret not configured");
        var jwtIssuer = _config["Jwt:Issuer"] ?? "prdagent";
        var jwtAudience = _config["Jwt:Audience"] ?? "prdagent";

        var expiresInSeconds = Math.Max(60, Math.Min(3600, request.ExpiresInSeconds ?? 900)); // 默认15分钟，范围 1-60分钟
        var expiresAt = DateTime.UtcNow.AddSeconds(expiresInSeconds);

        var securityKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret));
        var credentials = new SigningCredentials(securityKey, SecurityAlgorithms.HmacSha256);

        // 同时写入 "role" 与 ClaimTypes.Role，最大化兼容性
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.UserId),
            new(JwtRegisteredClaimNames.UniqueName, user.Username),
            new("displayName", user.DisplayName),
            new("role", user.Role.ToString()),
            new(ClaimTypes.Role, user.Role.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("impersonatedBy", adminId)
        };

        var token = new JwtSecurityToken(
            issuer: jwtIssuer,
            audience: jwtAudience,
            claims: claims,
            expires: expiresAt,
            signingCredentials: credentials);

        var accessToken = new JwtSecurityTokenHandler().WriteToken(token);

        _logger.LogInformation("Admin impersonation issued: adminId={AdminId}, userId={UserId}, expiresIn={Expires}s",
            adminId, user.UserId, expiresInSeconds);

        var response = new AdminImpersonateResponse
        {
            AccessToken = accessToken,
            ExpiresIn = expiresInSeconds,
            User = new AdminImpersonateUser
            {
                UserId = user.UserId,
                Username = user.Username,
                DisplayName = user.DisplayName,
                Role = user.Role.ToString()
            }
        };

        return Ok(ApiResponse<AdminImpersonateResponse>.Ok(response));
    }
}

public class AdminImpersonateRequest
{
    public string UserId { get; set; } = string.Empty;

    /// <summary>可选：有效期秒数（默认 900；范围 60-3600）</summary>
    public int? ExpiresInSeconds { get; set; }
}

public class AdminImpersonateResponse
{
    public string AccessToken { get; set; } = string.Empty;
    public int ExpiresIn { get; set; }
    public AdminImpersonateUser User { get; set; } = new();
}

public class AdminImpersonateUser
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
}


