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
using PrdAgent.Infrastructure.Deployment;
using PrdAgent.Infrastructure.Security;

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
    private readonly IConfiguration _configuration;

    public LlmGatewaySsoController(
        MongoDbContext db,
        LlmGatewayDataContext gatewayData,
        IConfiguration configuration)
    {
        _db = db;
        _gatewayData = gatewayData;
        _configuration = configuration;
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
            console = ResolveConsoleTarget(),
        }));
    }

    /// <summary>
    /// 票据要送去哪个控制台——由**服务端**回答，前端不再按 hostname 自己拼域名。
    ///
    /// 四种结果各自明确（根 CLAUDE.md 规则 #11：预览地址只能来自平台，禁止本地推算）：
    ///   ① 表里有这一项           → CDS 已发布独立控制台入口，直接去；
    ///   ② 表里没有这一项         → 该入口确实没发布（命名子域超 DNS 63 字符上限时 CDS 直接
    ///                              跳过不发布），如实告知而不是拼一个不存在的域名；
    ///   ③ 预览环境但没有表       → 跑着旧版 CDS（入口下发是 2026-07-29 才加的能力）。此时
    ///                              「有没有入口」是未知，既不能断言没发布，也不能自己推算
    ///                              ——如实说未知，并指出 CDS 更新后自愈；
    ///   ④ 非预览、也没有表       → 正式环境，控制台与本站同源，前端走 /llmgw/。
    /// </summary>
    private object ResolveConsoleTarget()
    {
        var baseUrl = PlatformEntrypoints.ResolveGatewayConsoleBaseUrl(_configuration);
        if (baseUrl is not null)
        {
            return new { baseUrl, unavailableReason = (string?)null };
        }

        if (PlatformEntrypoints.HasEntrypointTable(_configuration))
        {
            return new
            {
                baseUrl = (string?)null,
                unavailableReason = "本环境未发布模型网关控制台入口：预览分支名过长时，网关子域会超出 DNS 63 字符上限，平台不会发布这条路由。请用更短的分支名重新部署，或在正式域名上打开。",
            };
        }

        if (DeploymentAuthority.IsCdsBranchPreview(_configuration))
        {
            return new
            {
                baseUrl = (string?)null,
                unavailableReason = "当前预览环境的平台尚未下发入口表（CDS 版本早于该能力），无法确定模型网关控制台地址。CDS 更新后本入口会自动恢复；在此之前请在正式域名上打开。",
            };
        }

        return new { baseUrl = (string?)null, unavailableReason = (string?)null };
    }
}
