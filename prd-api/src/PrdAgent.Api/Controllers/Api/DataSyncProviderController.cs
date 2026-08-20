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
            // 界面显示 enabled（生效值），并发比对送 storedEnabled（库里原样那份）。
            // 两者只在「名单空了」这一格不同，而那一格恰恰是死锁发生的地方。
            storedEnabled = config.StoredEnabled,
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
            // 通配条目不许带端口。匹配时比的是 uri.Host（不含端口），拿它去对
            // 「.example.com:8443」这样的后缀永远对不上——名单里明明有它，
            // 每一次授权却都被拒。要么让匹配也认端口，要么在这里就说清楚不支持；
            // 选后者：一个带端口的通配本身语义就含混（是所有子域的这个端口，
            // 还是这个子域的所有端口），与其猜不如不收。
            if (isWildcard && candidate.LastIndexOf(':') > candidate.IndexOf('.'))
            {
                return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_ORIGIN_INVALID",
                    $"「{candidate}」不支持：子域通配不能带端口。改成不带端口的 *.example.com，"
                    + "或者把那台机器的完整地址逐条列出来。"));
            }
            var probe = isWildcard ? $"https://x{candidate[1..]}" : candidate;
            // 必须是**光秃秃的站点根**。带路径 / 查询 / 片段 / 用户名的写法这里放过去，
            // 界面上就显示成「已信任」，而换票时比的是回调地址的 origin
            //（https://host[:port]，不含其余部分）——两边永远对不上，于是每一次换票都被
            // 拒绝，管理员看着名单里明明有它。错误契约本来就写着「站点根地址」，
            // 校验没照着这句话做，形状 1：判据比它承诺的范围窄。
            var isBareRoot = Uri.TryCreate(probe, UriKind.Absolute, out var uri)
                && (uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback))
                && (uri.AbsolutePath.Length == 0 || uri.AbsolutePath == "/")
                && string.IsNullOrEmpty(uri.Query)
                && string.IsNullOrEmpty(uri.Fragment)
                && string.IsNullOrEmpty(uri.UserInfo);
            if (!isBareRoot)
            {
                return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_ORIGIN_INVALID",
                    $"「{candidate}」不是合法的来源：必须是 https 的站点根地址（不带路径、查询串或用户名），"
                    + "或以 *. 开头的子域通配"));
            }
            // 存之前先过一遍**读取时用的那个规范化**（ParseOrigins：通配转小写、
            // 非通配去尾斜杠）。不过这一遍的话，`*.EXAMPLE.com` 会原样存进库，而读回来
            // 时被转成小写——比对令牌拿规范化后的值去比库里那份大写的原文，永远比不上，
            // 于是这张卡从第一次保存之后就再也存不动了（又一个「拿规范化值比原始字段」，
            // 和第 29 轮那个开关死锁同族）。
            //
            // 关键是复用同一个函数，不是在这儿再写一遍小写逻辑——两份规范化早晚会漂开。
            var canonical = ParseOrigins(candidate).FirstOrDefault() ?? candidate;
            if (!origins.Contains(canonical, StringComparer.OrdinalIgnoreCase)) origins.Add(canonical);
        }

        // 条件更新。前端把「我看到的那份名单」一起送上来，只有库里仍是那一份才写得进去。
        // 没有这道门的话：两个管理员各自移走一台机器，后到的那次 PUT 会把先移走的那台
        // 放回来；TrustOriginAsync 刚加进去的那台也会被一次陈旧的保存抹掉。而票据鉴权
        // 每次都拿这份活名单重对，所以「撤销被悄悄取消」= 一台已被踢出的机器仍然能取数据。
        var filter = Builders<AppSettings>.Filter.Eq(x => x.Id, "global");
        var currentConfig = await ReadConfigAsync(ct);
        // 全新部署根本没有 global 这一行：条件更新匹配不到任何东西，于是每次保存都回
        // 「你手上这份过期了」，刷新出来的还是同一份环境变量兜底值，再试还是过期——
        // 这张卡永远建不出它的第一份设置。所以「我看到的就是那份兜底值」时允许 upsert：
        // 它仍然是原子的（_id 唯一索引兜底），只是把「插入第一份」也算作合法的当前状态。
        var expectedMatchesFallback = false;
        if (request.ExpectedOrigins is not null)
        {
            var expected = string.Join(",", ParseOrigins(string.Join(",", request.ExpectedOrigins)));
            var alternatives = new List<FilterDefinition<AppSettings>>
            {
                Builders<AppSettings>.Filter.Eq(x => x.DataSyncAllowedConsumerOrigins, expected),
            };
            // 库里还没有这个字段时，生效名单来自环境变量兜底。这一格只有在提交者看到的
            // 正是那份兜底值时才算「他看的还是当前状态」——所以这个判断在 C# 里算完，
            // 再决定要不要把「字段缺失」作为一种可接受的当前状态放进条件里。
            expectedMatchesFallback = string.Equals(
                expected, string.Join(",", currentConfig.AllowedOrigins), StringComparison.Ordinal);
            if (expectedMatchesFallback)
            {
                alternatives.Add(Builders<AppSettings>.Filter.Or(
                    Builders<AppSettings>.Filter.Exists(x => x.DataSyncAllowedConsumerOrigins, false),
                    Builders<AppSettings>.Filter.Eq(x => x.DataSyncAllowedConsumerOrigins, (string?)null)));
            }
            filter = Builders<AppSettings>.Filter.And(filter, Builders<AppSettings>.Filter.Or(alternatives));

            // 开关也要进比对令牌。只比名单的话，「另一个人把开关关了」这件事对本次提交
            // 是隐形的，而本次提交带着的是它打开页面那一刻的旧开关值——一次纯粹的
            // 「移走一台机器」会把整个对外导出重新打开。
            if (request.ExpectedEnabled is bool expectedEnabled)
            {
                var enabledAlternatives = new List<FilterDefinition<AppSettings>>
                {
                    Builders<AppSettings>.Filter.Eq(x => x.DataSyncProviderEnabled, expectedEnabled),
                };
                // 库里没有这个字段时，值来自环境变量兜底；口径与名单那半保持一致。
                if (expectedEnabled == currentConfig.StoredEnabled)
                {
                    enabledAlternatives.Add(Builders<AppSettings>.Filter.Or(
                        Builders<AppSettings>.Filter.Exists(x => x.DataSyncProviderEnabled, false),
                        Builders<AppSettings>.Filter.Eq(x => x.DataSyncProviderEnabled, (bool?)null)));
                }
                filter = Builders<AppSettings>.Filter.And(
                    filter, Builders<AppSettings>.Filter.Or(enabledAlternatives));
            }
        }

        UpdateResult saved;
        try
        {
            saved = await _db.AppSettings.UpdateOneAsync(
                filter,
                Builders<AppSettings>.Update
                    .Set(x => x.DataSyncProviderEnabled, request.Enabled)
                    .Set(x => x.DataSyncAllowedConsumerOrigins, string.Join(",", origins))
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    new UpdateOptions { IsUpsert = request.ExpectedOrigins is null || expectedMatchesFallback },
                ct);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // upsert 想插第一份，但同一瞬间别人已经插进去了。语义上和「你手上那份过期了」
            // 是同一件事：让他看最新的再决定，不要盲目覆盖。
            return Conflict(ApiResponse<object>.Fail("DATA_SYNC_SETTINGS_STALE",
                "这份名单在你编辑期间被别人改过了，已经刷新成最新的那份，请确认后再保存一次"));
        }

        if (request.ExpectedOrigins is not null && saved.MatchedCount == 0 && saved.UpsertedId is null)
        {
            return Conflict(ApiResponse<object>.Fail("DATA_SYNC_SETTINGS_STALE",
                "这份名单在你编辑期间被别人改过了，已经刷新成最新的那份，请确认后再保存一次"));
        }

        _logger.LogInformation("[data-sync] {Admin} 更新对外同步设置：开关={Enabled}，名单 {Count} 条",
            identity.Value.Username, request.Enabled, origins.Count);
        // 回的是**实际生效**的状态，不是请求里那个原始开关：名单空掉之后鉴权链路
        // 一律按关闭处理，这里若回 true，前端乐观更新会把「开着」这个假象定格下来。
        return Ok(ApiResponse<object>.Ok(new
        {
            enabled = IsEffectivelyEnabled(request.Enabled, origins),
            // 也要回刚刚**存下去**的那个原始开关。前端把这份响应合进本地状态，
            // 下一次保存的比对令牌就取自它——只回生效值的话，名单一空，本地那份
            // storedEnabled 会停在保存前的旧值，下次保存立刻被判过期。
            storedEnabled = request.Enabled,
            origins,
        }));
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
            // 冻结**当时**展开出来的集合清单，而不是只记分组 key。
            // 只记分组的话，票在两小时有效期内会跟着白名单一起变：源站中途上线一个
            // 新集合并归进某个已批准的分组，这张老票立刻就能读到批准人从没见过、
            // 也从没同意过的数据。授权是对「那一屏上列出的那些集合」的授权。
            { "Collections", new BsonArray(DataSyncScope.Expand(approvedGroups).Select(c => c.Name)) },
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
        var frozen = ReadFrozenCollections(grant);

        return Ok(ApiResponse<object>.Ok(new
        {
            exportToken,
            expiresAt = now.Add(ExportTokenLifetime),
            siteLabel = SiteLabel(),
            groups,
            collections = frozen,
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

        // 只报这张票冻结时就批准过的那些集合，不重新展开分组（见 Authorize 里的说明）。
        var manifestIncludeCredentials = grant.GetValue("IncludeCredentials", BsonBoolean.False).ToBoolean();
        var items = new List<object>();
        foreach (var name in ReadFrozenCollections(grant))
        {
            // 冻结之后本站又把某个集合移出白名单：解析不出来就不报，
            // 目标站的对照表会把它列成「源站没报告、不会同步」。
            if (!DataSyncScope.TryResolve(name, out var collection)) continue;
            var effectiveScope = DataSyncScope.ApplyGrant(collection, manifestIncludeCredentials);
            var count = await _db.Database.GetCollection<BsonDocument>(collection.Name)
                .CountDocumentsAsync(Builders<BsonDocument>.Filter.Empty, cancellationToken: ct);
            items.Add(new
            {
                collection = collection.Name,
                group = DataSyncScope.GroupOf(collection.Name),
                total = count,
                redactFields = effectiveScope.RedactFields,
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

        // 令牌能不能读这个集合，取决于**签发那一刻冻结下来的集合清单**，
        // 不是白名单全集，也不是「分组现在展开成什么」——后者会让票跟着白名单变宽。
        if (!ReadFrozenCollections(grant).Contains(resolved.Name, StringComparer.Ordinal))
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
            filter = BuildAfterCursorFilter(cursorValue);
        }

        var docs = await _db.Database.GetCollection<BsonDocument>(resolved.Name)
            .Find(filter)
            .Sort(Builders<BsonDocument>.Sort.Ascending("_id"))
            .Limit(pageSize)
            .ToListAsync(ct);

        // 批准的人同意连口令散列一起给时，users 的 PasswordHash 不脱敏——
        // 目标站的人用原账号密码就能直接登进去，这是「同步完直接可用」的前提。
        // 其余脱敏字段一律照旧，这条豁免只针对这一个字段。判定在 DataSyncScope.ApplyGrant，
        // 清单端点走的是同一个，两边不会说两套话。
        var includeCredentials = grant.GetValue("IncludeCredentials", BsonBoolean.False).ToBoolean();
        var effective = DataSyncScope.ApplyGrant(resolved, includeCredentials);

        var clearedFields = new HashSet<string>(StringComparer.Ordinal);
        foreach (var doc in docs)
        {
            foreach (var field in DataSyncRedactor.Redact(doc, effective)) clearedFields.Add(field);
            // 目标站本地执行历史整个删掉，且**不**计入 clearedFields——它不是待补的凭据，
            // 目标站会用自己那份。计进去的话同步页会催人去补一个本来就该由本机维护的东西。
            DataSyncRedactor.StripTargetLocal(doc, effective);
            // 只有口令没跟过去时才标「必须重设」。跟过去了还标，等于让人白改一遍密码。
            // 「要不要标必须重设」直接看散列这次到底清没清，不再另立一个平行条件。
            if (effective.RedactFields.Contains(DataSyncScope.CredentialCarryField, StringComparer.Ordinal))
            {
                DataSyncRedactor.MarkUserNeedsPasswordReset(doc);
            }
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
        // 作废这条路**不能**走 ResolveExportGrantAsync：那个函数会先过「对外同步开着吗、
        // 这台机器还在允许名单里吗」这两道门。而作废恰恰经常发生在门刚关上的时候——
        // 管理员在同步收尾的当口关了开关或把对方移出名单，于是这里查不到票、直接回
        // 「已失效」，目标站信了就把手上的令牌忘掉。可源站这边 ExportRevokedAt 从没写上：
        // 开关一旦在两小时内重新打开，那张本该一次性的票**又能用了**。
        //
        // 作废只需要证明「你拿着这张票」，跟本站当前的对外策略无关。所以这里直接按
        // 令牌散列找一张还没作废、还没过期的票，找到就作废。
        var presented = ReadExportToken();
        var grant = string.IsNullOrEmpty(presented)
            ? null
            : await _db.DataSyncGrants.Find(Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("ExportTokenHash", Hash(presented)),
                Builders<BsonDocument>.Filter.Eq("ExportRevokedAt", BsonNull.Value),
                Builders<BsonDocument>.Filter.Gt("ExportTokenExpiresAt", DateTime.UtcNow)))
                .FirstOrDefaultAsync(ct);
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

    /// <summary>
    /// 这张票签发时冻结下来的集合清单。
    ///
    /// 存量 grant（本字段落地之前签发的）没有这一格，退回按分组展开——那是它们签发时
    /// 的语义，不能事后改判成「什么都不许读」。两小时后它们自然过期，这条兼容也就到期。
    /// </summary>
    private static IReadOnlyList<string> ReadFrozenCollections(BsonDocument grant)
    {
        if (grant.TryGetValue("Collections", out var frozen) && frozen is BsonArray array && array.Count > 0)
        {
            return array.Select(x => x.AsString).ToList();
        }
        var groups = grant.GetValue("Groups", new BsonArray()).AsBsonArray.Select(x => x.AsString).ToList();
        return DataSyncScope.Expand(groups).Select(c => c.Name).ToList();
    }

    /// <summary>取请求上的导出令牌并做形状校验。作废与鉴权两处共用同一个来源。</summary>
    private string? ReadExportToken()
    {
        var token = Request.Headers["X-Data-Sync-Token"].ToString().Trim();
        return string.IsNullOrWhiteSpace(token) || token.Length is < 32 or > 256 ? null : token;
    }

    private async Task<BsonDocument?> ResolveExportGrantAsync(CancellationToken ct)
    {
        var token = ReadExportToken();
        if (token is null) return null;

        var config = await ReadConfigAsync(ct);
        if (!config.Enabled) return null;

        var grant = await _db.DataSyncGrants.Find(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("ExportTokenHash", Hash(token)),
            Builders<BsonDocument>.Filter.Eq("ExportRevokedAt", BsonNull.Value),
            Builders<BsonDocument>.Filter.Gt("ExportTokenExpiresAt", DateTime.UtcNow)))
            .FirstOrDefaultAsync(ct);
        if (grant is null) return null;

        // 允许名单是活的，票据必须**每次**拿它重新对一遍。
        //
        // 只看全局开关不够：管理员把某台机器移出名单时，只要名单里还剩别的机器，
        // 开关就仍是开着的，那台被移除的机器手上那张没过期的票照样能继续读数据，
        // 最长两小时。撤销入口写着「移除」，实际却要等票自己过期——那不叫撤销。
        var storedRedirect = grant.GetValue("RedirectUri", BsonString.Empty).AsString;
        if (!TryValidateRedirect(storedRedirect, config.AllowedOrigins, out _)) return null;

        return grant;
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

    /// <param name="Enabled">**生效**值：开关为真且名单非空。鉴权与界面显示都用它。</param>
    /// <param name="AllowedOrigins">生效名单（库里没配过时来自环境变量兜底）。</param>
    /// <param name="StoredEnabled">
    /// 库里**原样**存着的那个开关（没配过时是环境变量那份）。
    ///
    /// 它和 Enabled 只在「名单空了」这一格上不同，而并发比对必须用它：拿生效值去比
    /// 库里的原始字段，管理员撤掉最后一条来源之后就会永远比不上——生效值是 false、
    /// 库里存的还是 true，于是每次保存都回「你手上这份过期了」，刷新出来还是 false，
    /// 再试还是过期。这正是我在第 25 轮修过一次的那个死锁（形状 5），第 27 轮给开关
    /// 加比对时又照原样造了一遍，因为「显示用哪个值」和「比对用哪个值」被当成了同一个。
    /// </param>
    private sealed record ProviderConfig(
        bool Enabled,
        IReadOnlyList<string> AllowedOrigins,
        bool StoredEnabled);

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
        return new ProviderConfig(IsEffectivelyEnabled(enabled, origins), origins, enabled);
    }

    /// <summary>
    /// 对外同步「实际上」开没开。
    ///
    /// 白名单为空即关闭：没配过不等于允许所有，这条正是钓鱼面所在。
    ///
    /// 抽成一处是因为它曾经分裂过：鉴权链路按这个公式算，而设置接口的 PUT 直接把
    /// 请求里那个原始开关回给前端。管理员撤掉最后一条来源之后，界面上开关还亮着，
    /// 握手与换票却一律被拒——显示的状态和真正生效的判据说了两套话。
    /// </summary>
    internal static bool IsEffectivelyEnabled(bool flag, IReadOnlyList<string> origins)
        => flag && origins.Count > 0;

    /// <summary>
    /// 把一个 origin 写进允许名单并打开对外同步开关。幂等：已在名单里就不重复追加。
    /// 只落 AppSettings，不碰环境变量——环境变量是部署时的兜底，运行期以库里的为准
    /// （<see cref="ReadConfigAsync"/> 的读取顺序也是这样）。
    /// </summary>
    private async Task TrustOriginAsync(string origin, ProviderConfig config, CancellationToken ct)
    {
        // 名单在库里是一个逗号拼起来的**单值**，所以「加一条」实际是整份覆盖写。
        // 直接拿手上这份算好再写，两个管理员同时批准两台不同的机器时，后写的那份
        // 是基于旧名单算的，先写进去的那台就被抹掉了——而它此刻已经拿到票，
        // 下一次 manifest / export 重对名单时突然 401，看上去像「票莫名其妙失效」。
        //
        // 没有 $addToSet 可用（不是数组），所以走乐观重试：每轮重新读当前的原始值，
        // 用它当更新条件；条件没命中说明这一轮里有人改过，重读再来。
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var current = await _db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct);
            var raw = current?.DataSyncAllowedConsumerOrigins;
            // 库里没有这个字段时，生效的名单来自环境变量兜底（ReadConfigAsync 的读取顺序）。
            // 此时若从空列表起算，这次 upsert 会把「只有新批准的这一台」写进库，而之后所有
            // 读取都优先库里的值——环境变量里配的那些来源就此静默消失，它们手上还没过期的
            // 票下一次重对名单时全部失效。所以缺字段要从**生效值**起算，不是从零。
            var origins = (raw is null ? config.AllowedOrigins : ParseOrigins(raw)).ToList();
            var alreadyTrusted = origins.Any(o => string.Equals(o, origin, StringComparison.OrdinalIgnoreCase));
            if (!alreadyTrusted) origins.Add(origin);

            var update = Builders<AppSettings>.Update
                .Set(x => x.DataSyncProviderEnabled, true)
                .Set(x => x.DataSyncAllowedConsumerOrigins, string.Join(",", origins))
                .Set(x => x.UpdatedAt, DateTime.UtcNow);

            if (current is null)
            {
                // 文档还不存在：用 upsert 建，条件是「仍然不存在」。
                // 撞上并发插入会抛重复键，下一轮就走到下面那条正常路径。
                try
                {
                    await _db.AppSettings.UpdateOneAsync(
                        Builders<AppSettings>.Filter.Eq(x => x.Id, "global"),
                        update, new UpdateOptions { IsUpsert = true }, ct);
                    return;
                }
                catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
                {
                    continue;
                }
            }

            var result = await _db.AppSettings.UpdateOneAsync(
                Builders<AppSettings>.Filter.And(
                    Builders<AppSettings>.Filter.Eq(x => x.Id, "global"),
                    // 条件是「名单还是我刚读到的那一份」。注意用原始值而不是解析后的列表：
                    // 解析会做去空白、去重、大小写归一，拿它当条件对不上库里存的字面量。
                    Builders<AppSettings>.Filter.Eq(x => x.DataSyncAllowedConsumerOrigins, raw)),
                update, cancellationToken: ct);

            if (result.ModifiedCount > 0 || result.MatchedCount > 0) return;
        }

        // 五轮都被别人抢先：与其静默返回让调用方以为加成功了，不如让这次授权失败。
        // 名单没加上而票照发，等于发一张下一秒就会被拒的票。
        throw new InvalidOperationException(
            $"把 {origin} 加入允许名单时反复与其它改动冲突，请重试一次。");
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

    /// <summary>
    /// BSON 类型的**排序**次序（不是 BsonType 的枚举值）。分页要跨类型往前走，就得知道
    /// 谁排在谁后面。只列 _id 现实中可能出现的那些，其余归到末尾。
    /// </summary>
    private static readonly (BsonType Type, string Alias)[] BsonSortOrder =
    {
        (BsonType.MinKey, "minKey"),
        (BsonType.Null, "null"),
        (BsonType.Double, "double"),
        (BsonType.Int32, "int"),
        (BsonType.Int64, "long"),
        (BsonType.Decimal128, "decimal"),
        (BsonType.String, "string"),
        (BsonType.Document, "object"),
        (BsonType.Array, "array"),
        (BsonType.Binary, "binData"),
        (BsonType.ObjectId, "objectId"),
        (BsonType.Boolean, "bool"),
        (BsonType.DateTime, "date"),
        (BsonType.Timestamp, "timestamp"),
        (BsonType.RegularExpression, "regex"),
        (BsonType.MaxKey, "maxKey"),
    };

    /// <summary>
    /// 「_id 排在游标之后」的过滤器。
    ///
    /// 为什么不能只写 `$gt`：Mongo 的比较**运算符**只在同一个 BSON 类型段内比较，
    /// 而排序是跨类型的全序。本仓库有历史数据是 ObjectId、新数据是字符串
    /// （见 StringOrObjectIdSerializer），一个集合里两种 _id 混着放。
    ///
    /// 于是只用 `$gt` 会这样：按 _id 升序先出字符串那一段，游标停在某个字符串上之后，
    /// `$gt:"..."` 再也匹配不到后面的 ObjectId——下一页直接空了。worker 看到短页
    /// 就判这个集合拉完了，**报成功，而 ObjectId 那批一条都没同步过去**。
    /// 静默漏数据，两边条数对不上时也没人知道断在哪。
    ///
    /// 所以补上第二个分支：类型排在游标类型之后的，全都算「在后面」。两个分支都能走索引。
    /// </summary>
    internal static FilterDefinition<BsonDocument> BuildAfterCursorFilter(BsonValue cursor)
    {
        var sameBracket = Builders<BsonDocument>.Filter.Gt("_id", cursor);

        var rank = Array.FindIndex(BsonSortOrder, x => x.Type == cursor.BsonType);
        if (rank < 0) return sameBracket;   // 认不出的类型：至少保住同段内的推进

        var laterAliases = BsonSortOrder.Skip(rank + 1).Select(x => x.Alias).ToArray();
        if (laterAliases.Length == 0) return sameBracket;

        var laterTypes = new BsonDocument("_id", new BsonDocument("$type", new BsonArray(laterAliases)));
        return Builders<BsonDocument>.Filter.Or(sameBracket, laterTypes);
    }

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

    /// <summary>
    /// 提交者**看到的那一份**名单。整份覆盖写必须带上它做条件更新，否则两个管理员
    /// 各自移走一台机器时，后到的那次会把先移走的那台放回来——而票据鉴权每次都读
    /// 这份活名单，等于一次撤销被悄悄取消。null 表示旧版前端，按不带并发保护处理。
    /// </summary>
    public List<string>? ExpectedOrigins { get; set; }

    /// <summary>
    /// 提交者看到的**开关**状态。和 ExpectedOrigins 一起构成比对令牌。
    ///
    /// 只比名单不够：两个管理员各自打开同一页，一个把对外同步整个关掉，另一个只移走
    /// 一台机器——后者的名单比对仍然成立（那一栏确实没被改过），于是它把自己那份陈旧的
    /// Enabled=true 写了回去，悄悄把刚关掉的对外导出重新打开。
    /// </summary>
    public bool? ExpectedEnabled { get; set; }
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
