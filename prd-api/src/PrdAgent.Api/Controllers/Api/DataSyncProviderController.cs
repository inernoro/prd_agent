using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.DataSync;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 本站作为「源站」：把数据一次性交给另一台 MAP 实例。
///
/// ## 协议为什么长这样
///
/// 目标站和源站是两台独立部署的同一套代码，之间**没有预共享密钥**。要在没有共享
/// 密钥的前提下证明「来换票的就是发起跳转的那一位」，走 PKCE：目标站自己生成
/// verifier 留在服务端、只把它的 SHA-256 送出去，换票时再出示 verifier。中途截获
/// 授权码的人拿不出 verifier，码就是废的。
///
/// ## 三段
///
/// 1. `GET  authorize`  —— 目标站把浏览器跳过来，本站转到同意页（人在这里勾选范围）
/// 2. `POST authorize`  —— 本站真人管理员点同意，签发 60 秒、单次消费的授权码
/// 3. `POST token`      —— 目标站服务端用码 + verifier 换一个绑定单次同步的导出令牌
///
/// 之后 `manifest` / `export` 用导出令牌读数据，令牌过期或被用完即止。
///
/// ## 三条不可协商的约束
///
/// - 同意的人必须是**真人管理员浏览器会话**（合成测试会话被挡在外）
/// - 回跳地址必须命中本站配置的白名单 Origin；白名单为空 = 功能关闭，不是「允许所有」
/// - 导出范围只能从 <see cref="DataSyncScope"/> 白名单里取，敏感字段在**出口**清空
/// </summary>
[ApiController]
[Route("api/instance-sync")]
public sealed class DataSyncProviderController : ControllerBase
{
    /// <summary>授权码活得极短：它只需要撑过一次浏览器回跳。</summary>
    private static readonly TimeSpan CodeLifetime = TimeSpan.FromSeconds(60);

    /// <summary>
    /// 导出令牌活 2 小时：几万条文档分页拉完可能要几十分钟，60 秒的码撑不住。
    /// 但它绑定单条 Run、单个回跳地址，且 Run 进终态即作废——不是一张长期通行证。
    /// </summary>
    private static readonly TimeSpan ExportTokenLifetime = TimeSpan.FromHours(2);

    private const int MaxPageSize = 500;

    private readonly MongoDbContext _db;
    private readonly IConfiguration _configuration;
    private readonly ILogger<DataSyncProviderController> _logger;

    public DataSyncProviderController(
        MongoDbContext db,
        IConfiguration configuration,
        ILogger<DataSyncProviderController> logger)
    {
        _db = db;
        _configuration = configuration;
        _logger = logger;
    }

    /// <summary>本条同步协议的版本。两端不一致时不该硬跑。</summary>
    private const int ProtocolVersion = 1;

    /// <summary>给同一进程里的消费方侧读，两边比的是同一个常量。</summary>
    internal const int ProtocolVersionForHandshake = ProtocolVersion;

    /// <summary>
    /// 握手：跳转之前先问一句「你是谁、跑的什么版本、开着对外同步吗」。
    ///
    /// 匿名可读，且**只回这几样**——它是给还没有任何凭据的目标站看的，
    /// 多回一个字段就是给没授权的人多一分情报。放它在这里的理由：版本对不上时
    /// 应该在跳转之前当场说清楚，而不是让人跳过去、勾完、回来、跑到一半才炸。
    /// </summary>
    [HttpGet("handshake")]
    [AllowAnonymous]
    public async Task<IActionResult> Handshake(CancellationToken ct)
    {
        var config = await ReadConfigAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            siteLabel = SiteLabel(),
            protocolVersion = ProtocolVersion,
            build = VersionStamp(),
            providerEnabled = config.Enabled,
        }));
    }

    /// <summary>构建标识：只回短 sha，用来让人判断两端是不是同一版代码。</summary>
    private string VersionStamp()
    {
        // 与 /api/version 取同一批环境变量，避免两处各报各的
        foreach (var key in new[] { "GIT_COMMIT", "COMMIT_SHA", "GITHUB_SHA", "SOURCE_VERSION", "CDS_COMMIT_SHA" })
        {
            var value = (_configuration[key] ?? string.Empty).Trim();
            if (value.Length > 0) return value.Length >= 8 ? value[..8] : value;
        }
        return "";
    }

    // ---------------------------------------------------------------- 同意页数据

    /// <summary>
    /// 同意页要展示的东西：可勾选的分组（含每个集合的估算条数）+ 明确不会带走的清单。
    ///
    /// 条数用 EstimatedDocumentCount：它读集合元数据，128 个集合也是毫秒级；
    /// 精确 count 要全扫，同意页会卡十几秒。这里的数字是给人判断量级的，不是对账用的。
    /// </summary>
    [HttpGet("scope-catalog")]
    [Authorize]
    public async Task<IActionResult> ScopeCatalog(
        [FromQuery(Name = "redirect_uri")] string? redirectUri,
        CancellationToken ct)
    {
        // 这份目录把全站集合名和逐集合条数都摊开了——只有能按「同意」的那个人才该看见。
        // 判据必须和 Authorize 用同一个（真人浏览器会话 + 管理员），否则同意页对普通用户
        // 是「看得见清单但按不下按钮」，等于白送一份数据分布图。
        if (await ResolveAdminIdentityAsync(ct) is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以查看可授权范围"));
        }

        // 这里**不**因为「本站还没开对外同步」就 503。管理员正站在同意页上，
        // 他就是那个有权开的人；把门关上让他去改配置再重启，是把系统自己能做的事
        // 推给人（minimal-user-input）。改为如实把当前状态一起返回，由页面当场处理。
        var config = await ReadConfigAsync(ct);
        var shapeOk = TryValidateRedirectShape(redirectUri, out _, out var requestOrigin);
        var readiness = new
        {
            providerEnabled = config.Enabled,
            requestOrigin,
            redirectShapeValid = shapeOk,
            originAllowed = shapeOk && IsOriginAllowed(requestOrigin, config.AllowedOrigins),
            allowedOriginCount = config.AllowedOrigins.Count,
        };

        var groups = new List<object>();
        foreach (var group in DataSyncScope.Groups)
        {
            var collections = new List<object>();
            foreach (var collection in group.Collections)
            {
                long count;
                try
                {
                    count = await _db.Database.GetCollection<BsonDocument>(collection.Name)
                        .EstimatedDocumentCountAsync(cancellationToken: ct);
                }
                catch (Exception ex)
                {
                    // 单个集合数不出来不该让整页空白——标成 -1，界面显示「未知」。
                    _logger.LogWarning(ex, "[data-sync] 估算集合 {Collection} 条数失败", collection.Name);
                    count = -1;
                }
                collections.Add(new
                {
                    name = collection.Name,
                    estimatedCount = count,
                    redactFields = collection.RedactFields,
                });
            }
            groups.Add(new { key = group.Key, label = group.Label, collections });
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            siteLabel = SiteLabel(),
            groups,
            excluded = DataSyncScope.Excluded.Select(kv => new { collection = kv.Key, reason = kv.Value }),
            readiness,
        }));
    }

    /// <summary>
    /// 本站对外同步的当前设置：开关 + 允许名单。只有管理员看得到。
    /// </summary>
    [HttpGet("provider-settings")]
    [Authorize]
    public async Task<IActionResult> GetProviderSettings(CancellationToken ct)
    {
        if (await ResolveAdminIdentityAsync(ct) is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以查看对外同步设置"));
        }
        var config = await ReadConfigAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            enabled = config.Enabled,
            origins = config.AllowedOrigins,
            siteLabel = SiteLabel(),
        }));
    }

    /// <summary>
    /// 改本站对外同步的设置。存在的意义是**撤销**：同意页只会往名单里加，
    /// 没有这一处，一个来源加进去就再也拿不掉，只能去改配置——那正是这个功能
    /// 一开始想摆脱的东西。
    /// </summary>
    [HttpPut("provider-settings")]
    [Authorize]
    public async Task<IActionResult> UpdateProviderSettings(
        [FromBody] DataSyncProviderSettingsRequest request, CancellationToken ct)
    {
        var identity = await ResolveAdminIdentityAsync(ct);
        if (identity is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以修改对外同步设置"));
        }

        // 名单里的每一条都要能过形状校验，否则存进去的是一条永远匹配不上的死规则，
        // 而界面上看着像已经允许了。
        var origins = new List<string>();
        foreach (var raw in request.Origins ?? new List<string>())
        {
            var candidate = (raw ?? string.Empty).Trim().TrimEnd('/');
            if (candidate.Length == 0) continue;
            var isWildcard = candidate.StartsWith("*.", StringComparison.Ordinal);
            var probe = isWildcard ? $"https://x{candidate[1..]}" : candidate;
            if (!Uri.TryCreate(probe, UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
            {
                return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_ORIGIN_INVALID",
                    $"「{candidate}」不是合法的来源：必须是 https 的站点根地址，或以 *. 开头的子域通配"));
            }
            if (!origins.Contains(candidate, StringComparer.OrdinalIgnoreCase)) origins.Add(candidate);
        }

        await _db.AppSettings.UpdateOneAsync(
            Builders<AppSettings>.Filter.Eq(x => x.Id, "global"),
            Builders<AppSettings>.Update
                .Set(x => x.DataSyncProviderEnabled, request.Enabled)
                .Set(x => x.DataSyncAllowedConsumerOrigins, string.Join(",", origins))
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            new UpdateOptions { IsUpsert = true },
            ct);

        _logger.LogInformation("[data-sync] {Admin} 更新对外同步设置：开关={Enabled}，名单 {Count} 条",
            identity.Value.Username, request.Enabled, origins.Count);
        return Ok(ApiResponse<object>.Ok(new { enabled = request.Enabled, origins }));
    }

    // ---------------------------------------------------------------- 授权

    /// <summary>目标站把浏览器跳到这里；本站原样转给同意页，由人来点。</summary>
    [HttpGet("authorize")]
    [AllowAnonymous]
    public IActionResult AuthorizePage(
        [FromQuery(Name = "redirect_uri")] string? redirectUri,
        [FromQuery] string? state,
        [FromQuery(Name = "code_challenge")] string? codeChallenge)
    {
        var target = QueryHelpers.AddQueryString("/data-sync/authorize", new Dictionary<string, string?>
        {
            ["redirect_uri"] = redirectUri,
            ["state"] = state,
            ["code_challenge"] = codeChallenge,
        });
        return Redirect(target);
    }

    /// <summary>真人管理员点「同意」：签发一次性授权码，附带他勾选的分组。</summary>
    [HttpPost("authorize")]
    [Authorize]
    public async Task<IActionResult> Authorize([FromBody] DataSyncAuthorizeRequest request, CancellationToken ct)
    {
        if (FederatedConsoleSessionPolicy.IsSynthetic(User))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("SYNTHETIC_SESSION_FORBIDDEN", "合成测试会话不能批准数据导出"));
        }

        var config = await ReadConfigAsync(ct);

        // 形状先判：https / 路径精确等于 /data-sync/callback / 无 query 无 fragment。
        // 这几条永远不可当场放宽——放宽固定路径等于允许「白名单域名下的开放重定向页」。
        if (!TryValidateRedirectShape(request.RedirectUri, out var callback, out var requestOrigin)
            || string.IsNullOrWhiteSpace(request.State) || request.State.Length is < 32 or > 256
            || !IsValidCodeChallenge(request.CodeChallenge))
        {
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_AUTHORIZE_INVALID", "授权请求无效：回跳地址、state 或校验串不合法"));
        }

        var approvedGroups = (request.Groups ?? new List<string>())
            .Where(g => DataSyncScope.Groups.Any(x => x.Key == g))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (approvedGroups.Count == 0)
        {
            // 一个分组都没勾就签发，等于签发一张什么都拿不到的票；直接挡回去，
            // 免得目标站跑完一次「成功但零条」的同步还以为源站是空的。
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_SCOPE_EMPTY", "至少要勾选一个分组"));
        }

        var identity = await ResolveAdminIdentityAsync(ct);
        if (identity is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以批准数据导出"));
        }

        // 当场准入：本站还没开对外同步、或这个来源还不在名单里时，管理员可以在同意页上
        // 勾一个**单独的**确认项一次性解决，不必去改配置再重启（DS6）。
        // 这不是把门拆了——门还是同一道，只是把「谁能开」从「能改 env 的人」收敛成
        // 「此刻正在看这一屏、看得见对方是谁、并且额外勾了一次的管理员」。
        var enabled = config.Enabled;
        var originAllowed = IsOriginAllowed(requestOrigin, config.AllowedOrigins);
        if (!enabled || !originAllowed)
        {
            if (!request.TrustThisOrigin)
            {
                return StatusCode(StatusCodes.Status409Conflict, ApiResponse<object>.Fail(
                    "DATA_SYNC_ORIGIN_NOT_TRUSTED",
                    $"本站尚未允许 {requestOrigin} 来取数据。确认这台机器可信后再同意。"));
            }
            await TrustOriginAsync(requestOrigin, config, ct);
            _logger.LogWarning(
                "[data-sync] {Admin} 在同意页上把 {Origin} 加入允许名单并开启对外同步",
                identity.Value.Username, requestOrigin);
        }

        var now = DateTime.UtcNow;
        var code = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        await _db.DataSyncGrants.InsertOneAsync(new BsonDocument
        {
            { "_id", Guid.NewGuid().ToString("N") },
            { "CodeHash", Hash(code) },
            { "CodeChallenge", request.CodeChallenge! },
            { "RedirectUri", callback },
            { "Groups", new BsonArray(approvedGroups) },
            // 批准的人是否同意把登录口令散列一起给出去。这是一次独立的决定，
            // 所以单独存一格，而不是藏在分组里。
            { "IncludeCredentials", request.IncludeCredentials },
            { "ApprovedBy", identity.Value.Subject },
            { "ApprovedByName", identity.Value.DisplayName },
            { "State", "issued" },
            { "CreatedAt", now },
            { "ExpiresAt", now.Add(CodeLifetime) },
            { "ConsumedAt", BsonNull.Value },
            { "ExportTokenHash", BsonNull.Value },
            { "ExportTokenExpiresAt", BsonNull.Value },
            { "ExportRevokedAt", BsonNull.Value },
        }, cancellationToken: ct);

        _logger.LogInformation(
            "[data-sync] {Admin} 批准向 {Callback} 导出 {Groups}",
            identity.Value.Username, callback, string.Join(",", approvedGroups));

        var target = $"{callback}#code={Uri.EscapeDataString(code)}&state={Uri.EscapeDataString(request.State!)}";
        return Ok(ApiResponse<object>.Ok(new { redirectUrl = target, approvedGroups }));
    }

    /// <summary>目标站服务端拿码 + verifier 换导出令牌。码在这一步作废。</summary>
    [HttpPost("token")]
    [AllowAnonymous]
    public async Task<IActionResult> Token([FromBody] DataSyncTokenRequest request, CancellationToken ct)
    {
        var config = await ReadConfigAsync(ct);
        if (!config.Enabled
            || !TryValidateRedirect(request.RedirectUri, config.AllowedOrigins, out var callback)
            || string.IsNullOrWhiteSpace(request.Code) || request.Code!.Length is < 32 or > 256
            || string.IsNullOrWhiteSpace(request.CodeVerifier) || request.CodeVerifier!.Length is < 43 or > 128)
        {
            return Unauthorized(ApiResponse<object>.Fail("DATA_SYNC_TOKEN_INVALID", "换取导出令牌的请求无效"));
        }

        var now = DateTime.UtcNow;
        var exportToken = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

        // 一次原子的「找到并标记已消费」——两个目标站同时拿同一个码，只有一个能成。
        var grant = await _db.DataSyncGrants.FindOneAndUpdateAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("CodeHash", Hash(request.Code)),
                Builders<BsonDocument>.Filter.Eq("RedirectUri", callback),
                Builders<BsonDocument>.Filter.Eq("State", "issued"),
                Builders<BsonDocument>.Filter.Gt("ExpiresAt", now)),
            Builders<BsonDocument>.Update
                .Set("State", "consumed")
                .Set("ConsumedAt", now)
                .Set("ExportTokenHash", Hash(exportToken))
                .Set("ExportTokenExpiresAt", now.Add(ExportTokenLifetime)),
            new FindOneAndUpdateOptions<BsonDocument, BsonDocument> { ReturnDocument = ReturnDocument.Before },
            ct);

        if (grant is null)
        {
            return Unauthorized(ApiResponse<object>.Fail("DATA_SYNC_CODE_INVALID", "授权码无效、已使用或已过期"));
        }

        // PKCE 校验放在原子消费**之后**：码无论校验成败都已经作废，攻击者拿不到
        // 「猜错 verifier 还能再试一次」的机会。
        var challenge = grant.GetValue("CodeChallenge", "").AsString;
        if (!FixedEquals(challenge, Sha256Base64Url(request.CodeVerifier!)))
        {
            await _db.DataSyncGrants.UpdateOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", grant["_id"]),
                Builders<BsonDocument>.Update.Set("ExportRevokedAt", now).Set("State", "rejected"),
                cancellationToken: ct);
            _logger.LogWarning("[data-sync] PKCE 校验失败，授权码已作废（回跳 {Callback}）", callback);
            return Unauthorized(ApiResponse<object>.Fail("DATA_SYNC_PKCE_MISMATCH", "校验串不匹配，授权码已作废"));
        }

        var groups = grant.GetValue("Groups", new BsonArray()).AsBsonArray.Select(x => x.AsString).ToList();
        var collections = DataSyncScope.Expand(groups);

        return Ok(ApiResponse<object>.Ok(new
        {
            exportToken,
            expiresAt = now.Add(ExportTokenLifetime),
            siteLabel = SiteLabel(),
            groups,
            collections = collections.Select(c => c.Name),
            approvedBy = grant.GetValue("ApprovedByName", "").AsString,
        }));
    }

    // ---------------------------------------------------------------- 导出

    /// <summary>每个获批集合的条数，供目标站做同步前对照。</summary>
    [HttpGet("manifest")]
    [AllowAnonymous]
    public async Task<IActionResult> Manifest(CancellationToken ct)
    {
        var grant = await ResolveExportGrantAsync(ct);
        if (grant is null) return Unauthorized(ApiResponse<object>.Fail("DATA_SYNC_EXPORT_UNAUTHORIZED", "导出令牌无效或已过期"));

        var groups = grant.GetValue("Groups", new BsonArray()).AsBsonArray.Select(x => x.AsString).ToList();
        var items = new List<object>();
        foreach (var collection in DataSyncScope.Expand(groups))
        {
            var count = await _db.Database.GetCollection<BsonDocument>(collection.Name)
                .CountDocumentsAsync(Builders<BsonDocument>.Filter.Empty, cancellationToken: ct);
            items.Add(new
            {
                collection = collection.Name,
                group = DataSyncScope.GroupOf(collection.Name),
                total = count,
                redactFields = collection.RedactFields,
            });
        }
        return Ok(ApiResponse<object>.Ok(new { siteLabel = SiteLabel(), collections = items }));
    }

    /// <summary>
    /// 按 _id 升序分页导出一个集合。游标是上一批最后一个 _id 的扩展 JSON。
    ///
    /// 用 _id 做游标而不是 skip：skip 在几万条上会越翻越慢，而且中途有写入就会漏或重。
    /// _id 上有唯一索引，`Gt` 翻页既稳又快。
    /// </summary>
    [HttpGet("export")]
    [AllowAnonymous]
    public async Task<IActionResult> Export(
        [FromQuery] string? collection,
        [FromQuery] string? after,
        [FromQuery] int limit,
        CancellationToken ct)
    {
        var grant = await ResolveExportGrantAsync(ct);
        if (grant is null) return Unauthorized(ApiResponse<object>.Fail("DATA_SYNC_EXPORT_UNAUTHORIZED", "导出令牌无效或已过期"));

        if (!DataSyncScope.TryResolve(collection, out var resolved))
        {
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_COLLECTION_UNKNOWN", "集合不在可导出白名单里"));
        }

        // 令牌能不能读这个集合，取决于**当初批准的分组**，不是白名单全集。
        var groups = grant.GetValue("Groups", new BsonArray()).AsBsonArray.Select(x => x.AsString).ToList();
        if (!groups.Contains(DataSyncScope.GroupOf(resolved.Name) ?? "__none__", StringComparer.Ordinal))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_COLLECTION_NOT_GRANTED", "这个集合不在本次授权范围内"));
        }

        var pageSize = limit is > 0 and <= MaxPageSize ? limit : 200;
        var filter = Builders<BsonDocument>.Filter.Empty;
        if (!string.IsNullOrWhiteSpace(after))
        {
            if (!TryParseCursor(after!, out var cursorValue))
            {
                return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_CURSOR_INVALID", "游标无法解析"));
            }
            filter = Builders<BsonDocument>.Filter.Gt("_id", cursorValue);
        }

        var docs = await _db.Database.GetCollection<BsonDocument>(resolved.Name)
            .Find(filter)
            .Sort(Builders<BsonDocument>.Sort.Ascending("_id"))
            .Limit(pageSize)
            .ToListAsync(ct);

        // 批准的人同意连口令散列一起给时，users 的 PasswordHash 不脱敏——
        // 目标站的人用原账号密码就能直接登进去，这是「同步完直接可用」的前提。
        // 其余脱敏字段一律照旧，这条豁免只针对这一个字段。
        var includeCredentials = grant.GetValue("IncludeCredentials", BsonBoolean.False).ToBoolean();
        var effective = resolved;
        if (includeCredentials && resolved.Name == "users")
        {
            effective = resolved with
            {
                RedactFields = resolved.RedactFields
                    .Where(f => !string.Equals(f, "PasswordHash", StringComparison.Ordinal))
                    .ToList(),
            };
        }

        var clearedFields = new HashSet<string>(StringComparer.Ordinal);
        foreach (var doc in docs)
        {
            foreach (var field in DataSyncRedactor.Redact(doc, effective)) clearedFields.Add(field);
            // 只有口令没跟过去时才标「必须重设」。跟过去了还标，等于让人白改一遍密码。
            if (!includeCredentials && resolved.Name == "users") DataSyncRedactor.MarkUserNeedsPasswordReset(doc);
        }

        var nextCursor = docs.Count == pageSize && docs.Count > 0 ? SerializeCursor(docs[^1]["_id"]) : null;
        return Ok(ApiResponse<object>.Ok(new
        {
            collection = resolved.Name,
            count = docs.Count,
            nextCursor,
            clearedFields = clearedFields.OrderBy(x => x, StringComparer.Ordinal),
            // 扩展 JSON 而不是普通 JSON：日期、Decimal128、ObjectId 走普通 JSON 会掉类型，
            // 目标站写回去就变成一堆字符串。
            documents = docs.Select(d => d.ToJson(new MongoDB.Bson.IO.JsonWriterSettings
            {
                OutputMode = MongoDB.Bson.IO.JsonOutputMode.CanonicalExtendedJson,
            })),
        }));
    }

    /// <summary>
    /// 目标站跑完（成功或失败）后主动交还导出令牌，源站当场把这张票作废。
    ///
    /// 没有这一步的话：界面上写着「这次一次性同步已经结束」，而那张票在源站眼里
    /// 还能再用一小时五十分钟——「一次性」就只是文案。用令牌自己鉴权，因为此刻
    /// 目标站手上除了它没有别的凭据；幂等，重复调用返回同样的结果。
    /// </summary>
    [HttpPost("revoke")]
    [AllowAnonymous]
    public async Task<IActionResult> Revoke(CancellationToken ct)
    {
        var grant = await ResolveExportGrantAsync(ct);
        // 找不到 = 已经作废或本来就无效。两种都是「现在它不能用了」，如实回 ok，
        // 免得目标站为了一张已经没用的票反复重试。
        if (grant is null) return Ok(ApiResponse<object>.Ok(new { revoked = false, reason = "票据已失效或不存在" }));

        await _db.DataSyncGrants.UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", grant["_id"]),
            Builders<BsonDocument>.Update
                .Set("ExportRevokedAt", DateTime.UtcNow)
                .Set("State", "completed"),
            cancellationToken: ct);
        _logger.LogInformation("[data-sync] 导出令牌已被目标站交还并作废");
        return Ok(ApiResponse<object>.Ok(new { revoked = true }));
    }

    // ---------------------------------------------------------------- 内部

    private async Task<BsonDocument?> ResolveExportGrantAsync(CancellationToken ct)
    {
        var token = Request.Headers["X-Data-Sync-Token"].ToString().Trim();
        if (string.IsNullOrWhiteSpace(token) || token.Length is < 32 or > 256) return null;

        var config = await ReadConfigAsync(ct);
        if (!config.Enabled) return null;

        return await _db.DataSyncGrants.Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("ExportTokenHash", Hash(token)),
            Builders<BsonDocument>.Filter.Eq("ExportRevokedAt", BsonNull.Value),
            Builders<BsonDocument>.Filter.Gt("ExportTokenExpiresAt", DateTime.UtcNow)))
            .FirstOrDefaultAsync(ct);
    }

    private async Task<(string Subject, string Username, string DisplayName)?> ResolveAdminIdentityAsync(CancellationToken ct)
    {
        if (!FederatedConsoleSessionPolicy.IsEligibleBrowserSession(User)) return null;
        if (string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal))
        {
            return ("admin:root", "root", "ROOT");
        }
        var userId = this.GetRequiredUserId();
        var user = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        if (user is null || user.Status != UserStatus.Active || user.UserType != UserType.Human || user.Role != UserRole.ADMIN)
        {
            return null;
        }
        return ($"admin:{user.UserId}", user.Username, user.DisplayName);
    }

    private sealed record ProviderConfig(bool Enabled, IReadOnlyList<string> AllowedOrigins);

    private async Task<ProviderConfig> ReadConfigAsync(CancellationToken ct)
    {
        var settings = await _db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct);
        var enabled = settings?.DataSyncProviderEnabled
            ?? IsTruthy(_configuration["DataSync:ProviderEnabled"] ?? _configuration["DATA_SYNC_PROVIDER_ENABLED"]);
        // null = 从来没在库里配过，落回环境变量；空串 = 管理员刚刚把最后一条删掉了，
        // 那是一次明确的撤销，不能因为「看起来是空的」就把环境变量那份又捡回来——
        // 否则界面上删掉的机器过一秒又变回受信任（Codex 指出）。
        var origins = ParseOrigins(settings?.DataSyncAllowedConsumerOrigins is not null
            ? settings.DataSyncAllowedConsumerOrigins
            : FirstNonEmpty(
                _configuration["DataSync:AllowedConsumerOrigins"],
                _configuration["DATA_SYNC_ALLOWED_CONSUMER_ORIGINS"]));
        // 白名单为空即关闭：没配过不等于允许所有，这条正是钓鱼面所在。
        return new ProviderConfig(enabled && origins.Count > 0, origins);
    }

    /// <summary>
    /// 把一个 origin 写进允许名单并打开对外同步开关。幂等：已在名单里就不重复追加。
    /// 只落 AppSettings，不碰环境变量——环境变量是部署时的兜底，运行期以库里的为准
    /// （<see cref="ReadConfigAsync"/> 的读取顺序也是这样）。
    /// </summary>
    private async Task TrustOriginAsync(string origin, ProviderConfig config, CancellationToken ct)
    {
        var origins = config.AllowedOrigins.ToList();
        if (!origins.Any(o => string.Equals(o, origin, StringComparison.OrdinalIgnoreCase)))
        {
            origins.Add(origin);
        }
        await _db.AppSettings.UpdateOneAsync(
            Builders<AppSettings>.Filter.Eq(x => x.Id, "global"),
            Builders<AppSettings>.Update
                .Set(x => x.DataSyncProviderEnabled, true)
                .Set(x => x.DataSyncAllowedConsumerOrigins, string.Join(",", origins))
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            new UpdateOptions { IsUpsert = true },
            ct);
    }

    private string SiteLabel()
    {
        var configured = _configuration["DataSync:SiteLabel"] ?? _configuration["SITE_LABEL"];
        return string.IsNullOrWhiteSpace(configured) ? Request.Host.Value ?? "MAP" : configured!;
    }

    /// <summary>
    /// 回跳地址校验：https（本机可 http）、路径必须精确是 /data-sync/callback、
    /// 不许带 query 和 fragment、Origin 必须命中白名单。
    /// 固定路径这一条容易被当成多余——它挡的是「白名单域名下有个开放重定向页」这种情况。
    /// </summary>
    internal static bool TryValidateRedirect(string? raw, IReadOnlyList<string> allowedOrigins, out string callback)
        => TryValidateRedirectShape(raw, out callback, out var origin) && IsOriginAllowed(origin, allowedOrigins);

    /// <summary>
    /// 回跳地址的**形状**校验：https（本机可 http）、路径精确等于 /data-sync/callback、
    /// 不许带 query 和 fragment。这几条与「谁被允许」无关，任何人都不能当场放宽——
    /// 固定路径挡的是「白名单域名下有个开放重定向页」，放宽它等于把整条链交给对方摆布。
    /// </summary>
    internal static bool TryValidateRedirectShape(string? raw, out string callback, out string origin)
    {
        callback = "";
        origin = "";
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri)) return false;
        var validScheme = uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback);
        if (!validScheme
            || !string.Equals(uri.AbsolutePath.TrimEnd('/'), "/data-sync/callback", StringComparison.Ordinal)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment))
        {
            return false;
        }
        origin = uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
        callback = $"{origin}/data-sync/callback";
        return true;
    }

    /// <summary>Origin 是否在允许名单里。这一条**可以**由本站管理员在同意页上当场授予。</summary>
    internal static bool IsOriginAllowed(string origin, IReadOnlyList<string> allowedOrigins)
    {
        if (string.IsNullOrEmpty(origin)) return false;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
        return allowedOrigins.Any(pattern =>
        {
            if (pattern.StartsWith("*.", StringComparison.Ordinal))
            {
                var suffix = pattern[1..];
                return uri.Host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) && uri.Host.Length > suffix.Length;
            }
            return string.Equals(origin, pattern, StringComparison.OrdinalIgnoreCase);
        });
    }

    private static bool IsValidCodeChallenge(string? challenge) =>
        !string.IsNullOrWhiteSpace(challenge)
        && challenge!.Length is >= 43 and <= 128
        && challenge.All(c => char.IsLetterOrDigit(c) || c is '-' or '_');

    internal static string Sha256Base64Url(string value) =>
        WebEncoders.Base64UrlEncode(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static bool FixedEquals(string? a, string? b) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(a ?? ""), Encoding.UTF8.GetBytes(b ?? ""));

    private static bool IsTruthy(string? value) =>
        value is not null && (value.Equals("1", StringComparison.Ordinal)
            || value.Equals("true", StringComparison.OrdinalIgnoreCase));

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

    internal static IReadOnlyList<string> ParseOrigins(string? raw) =>
        (raw ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(v => v.StartsWith("*.", StringComparison.Ordinal) ? v.ToLowerInvariant() : v.TrimEnd('/'))
            .ToList();

    internal static string SerializeCursor(BsonValue id) =>
        new BsonDocument("v", id).ToJson(new MongoDB.Bson.IO.JsonWriterSettings
        {
            OutputMode = MongoDB.Bson.IO.JsonOutputMode.CanonicalExtendedJson,
        });

    internal static bool TryParseCursor(string cursor, out BsonValue value)
    {
        value = BsonNull.Value;
        try
        {
            value = BsonDocument.Parse(cursor)["v"];
            return true;
        }
        catch (Exception)
        {
            // 游标是目标站原样回传的，坏了就是坏了；返回 false 让调用方给 400，
            // 而不是悄悄退回「从头开始」——那会让一次续传变成一次重复全量拉取。
            return false;
        }
    }
}

public sealed class DataSyncProviderSettingsRequest
{
    public bool Enabled { get; set; }
    public List<string>? Origins { get; set; }
}

public sealed class DataSyncAuthorizeRequest
{
    public string? RedirectUri { get; set; }
    public string? State { get; set; }
    public string? CodeChallenge { get; set; }
    public List<string>? Groups { get; set; }

    /// <summary>
    /// 是否把用户的登录口令散列一起交出去。
    ///
    /// 勾上：目标站的人用原来的账号密码就能登进去，同步完即刻可用。
    /// 不勾：账号搬过去但登不进来，需要目标站管理员逐个重设——更保守，但多一道人工。
    /// 默认勾上，因为这个功能的主场景是「把一整套环境搬到另一台自己的机器上」。
    /// </summary>
    public bool IncludeCredentials { get; set; } = true;

    /// <summary>
    /// 管理员在同意页上额外勾的「我确认这台机器可信」。只有它为 true 时，才允许把
    /// 尚未在名单里的来源当场加进去——单独一个字段而不是复用 Groups，是为了让
    /// 「批准这次导出」和「从此信任这台机器」在协议层面就是两个决定。
    /// </summary>
    public bool TrustThisOrigin { get; set; }
}

public sealed class DataSyncTokenRequest
{
    public string? Code { get; set; }
    public string? RedirectUri { get; set; }
    public string? CodeVerifier { get; set; }
}
