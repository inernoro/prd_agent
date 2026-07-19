using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// MAP 管理员进入 LLM Gateway 的一次性登录入口。
/// MAP access token 不离开当前系统；跨系统只传递 60 秒、单次消费的随机授权码。
/// </summary>
[ApiController]
[Route("api/llm-gateway/sso")]
[Authorize]
public sealed class LlmGatewaySsoController : ControllerBase
{
    private static readonly TimeSpan TicketLifetime = TimeSpan.FromSeconds(60);
    private const string TicketCollectionName = "llmgw_map_sso_tickets";
    private readonly MongoDbContext _db;
    private readonly LlmGatewayDataContext _gatewayData;

    public LlmGatewaySsoController(MongoDbContext db, LlmGatewayDataContext gatewayData)
    {
        _db = db;
        _gatewayData = gatewayData;
    }

    [HttpPost("ticket")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> CreateTicket(CancellationToken ct)
    {
        // 只接受 MAP 管理后台真人会话。Agent/API key 即使绑定了管理员用户，也不能签发浏览器 SSO。
        var clientType = User.FindFirst("clientType")?.Value;
        var sessionKey = User.FindFirst("sessionKey")?.Value;
        if (!string.Equals(clientType, "admin", StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(sessionKey))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("MAP_SSO_BROWSER_SESSION_REQUIRED", "请使用 MAP 管理后台登录后再打开模型网关"));
        }

        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        var userId = this.GetRequiredUserId();
        User? user = null;
        if (!isRoot && userId.Length > 0)
        {
            user = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        }

        if (!isRoot && (user is null
                        || user.Status != UserStatus.Active
                        || user.UserType != UserType.Human
                        || user.Role != UserRole.ADMIN))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("MAP_ADMIN_REQUIRED", "只有 MAP 管理员可以直接进入模型网关"));
        }

        var effectiveUserId = isRoot ? "root" : user!.UserId;
        var effectiveUsername = isRoot ? "root" : user!.Username;
        var effectiveDisplayName = isRoot ? "ROOT" : user!.DisplayName;
        var now = DateTime.UtcNow;
        var expiresAt = now.Add(TicketLifetime);
        var code = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var codeHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code))).ToLowerInvariant();

        var tickets = _gatewayData.Database.GetCollection<BsonDocument>(TicketCollectionName);
        await tickets.InsertOneAsync(new BsonDocument
        {
            { "_id", Guid.NewGuid().ToString("N") },
            { "CodeHash", codeHash },
            { "Purpose", "map-console-login" },
            { "Audience", "llmgw-console" },
            { "MapUserId", effectiveUserId },
            { "MapUsername", effectiveUsername },
            { "MapDisplayName", effectiveDisplayName },
            { "MapRole", UserRole.ADMIN.ToString() },
            { "MapIsRoot", isRoot },
            { "State", "issued" },
            { "CreatedAt", now },
            { "ExpiresAt", expiresAt },
            { "ConsumedAt", BsonNull.Value },
        }, cancellationToken: ct);

        // 前端只会把 code 放进受控 Gateway 地址的 fragment，静态服务器和 Referer 都不会收到明文。
        return Ok(ApiResponse<object>.Ok(new
        {
            code,
            expiresAt = expiresAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
        }));
    }
}
