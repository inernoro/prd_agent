using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 智能体接入台 —— 用户自己看的那一页：我授权了什么、连着哪几台客户端、它们刚才做了什么。
///
/// 鉴权走用户 JWT（这是给人用的界面，不是给智能体用的）。智能体那侧走 /api/mcp。
///
/// 三个问题必须在这一页里答完，用户不该再去别处翻：
///   1. 我的智能体能替我做什么（能力卡 + 每块能力挂着哪些工具）
///   2. 它刚才做了什么（调用记录 + 产物直达）
///   3. 它还能做多少（今日额度）
/// </summary>
[ApiController]
[Route("api/mcp-console")]
[Authorize]
public class McpConsoleController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAgentApiKeyService _keyService;
    private readonly IAdminPermissionService _permissions;
    private readonly Services.Mcp.McpUsageService _usage;

    public McpConsoleController(
        MongoDbContext db,
        IAgentApiKeyService keyService,
        IAdminPermissionService permissions,
        Services.Mcp.McpUsageService usage)
    {
        _db = db;
        _keyService = keyService;
        _permissions = permissions;
        _usage = usage;
    }

    /// <summary>
    /// MCP 端点地址 —— 用户要把它复制进客户端配置，所以必须是对外真实可达的那个。
    ///
    /// 不能用 Request.Scheme/Host：nginx 终止 TLS 后转给 Kestrel 的是明文 HTTP，
    /// 直接拼会给出一个 http:// 的地址，粘进客户端就连不上。走转发头解析。
    /// </summary>
    private string BuildEndpointUrl() => $"{Request.ResolveExternalBaseUrl()}/api/mcp";

    [HttpGet("overview")]
    public async Task<IActionResult> Overview(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        var ownedPermissions = await _permissions.GetEffectivePermissionsAsync(userId, isRoot, ct);

        var nowUtc = DateTime.UtcNow;
        // 两份名单，用途不同，别合成一份：
        //   allKeys —— 今日用量统计用。今天用掉额度、之后被撤销的钥匙也得算进去，
        //              否则 today.calls 还算着它的调用、today.images/writes 却把它的量抹掉，
        //              同一屏的两个数字自己跟自己对不上。
        //   keys    —— 客户端列表与「已授权」用。撤销的不该再出现在「连着的客户端」里。
        var allKeys = await _keyService.ListByOwnerAsync(userId, ct);
        var keys = allKeys.Where(k => k.RevokedAt == null).ToList();
        // 「还能用吗」走鉴权那一处判据（AgentApiKey.IsUsableAt），不是光看 IsActive ——
        // 过了宽限期的钥匙 IsActive 仍是 true，照着它判会把一台每个请求都被拒的客户端
        // 显示成「已连接、能力已授权」。面板和智能体遇到的必须是同一件事。
        var activeKeys = keys.Where(k => AgentApiKey.IsUsableAt(k, nowUtc, out _)).ToList();
        // 「已授权」要跟鉴权口径一致：受权限位把关的 scope，权限被回收后鉴权时就会被剥掉，
        // 面板不能还显示成已授权 —— 否则用户看到的和智能体实际能用的是两回事。
        var grantedScopes = activeKeys.SelectMany(k => EffectiveScopesOf(k, ownedPermissions))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var since = McpUsageService.TodayStartUtc();
        // 计数走聚合，不再靠「取最近 N 条再在内存里数」：按每分钟 60 次的上限，
        // 十几分钟就能超过任何截断阈值，之后面板会系统性少报。列表只取要展示的那几条。
        var tally = await TodayTallyAsync(userId, since, ct);
        var recentLogs = await RecentLogsAsync(userId, since, 5, ct);
        // 「今天没调用」不等于「从来没接过」，而上面这几个数全是今天的
        var hasHistory = await HasAnyHistoryAsync(userId, ct);

        var capabilities = McpCapabilityCatalog.All.Select(cap =>
        {
            var tools = McpCapabilityCatalog.ToolsOf(cap);
            var scopes = cap.AllScopes().ToList();
            return new
            {
                key = cap.Key,
                title = cap.Title,
                summary = cap.Summary,
                readScope = cap.ReadScope,
                writeScope = cap.WriteScope,
                writeNeedsApproval = cap.WriteNeedsApproval,
                // 我自己有没有这块能力的权限位 —— 没有的话向导里勾了也签不出密钥，得先说清楚。
                // 判据与签发校验同一个（IsIssuancePermissionChecked）：真正没有权限位的 scope
                //（海鲜市场：闸门在接口自己身上）恒为可用，拿权限位去判会把「其实签得出来」的显示成灰的；
                // 而 document-store 有真实权限位、且等价于文档空间的读写权限，签发要查，这里就得跟着灰。
                //
                // 读与写要分开报：只有 web-pages.read 的人，整张卡是可用的，但写入那一档签不出来。
                // 合成一个 Any() 会让向导把写入勾选框也点亮，勾了之后在后端交集校验那里才失败 ——
                // 用户在最后一步才知道自己不该勾，这是把系统本来就知道的事推给他去撞。
                availableToMe = ScopeAvailable(cap.ReadScope ?? cap.WriteScope, ownedPermissions),
                writeAvailableToMe = ScopeAvailable(cap.WriteScope, ownedPermissions),
                granted = scopes.Any(s => McpCapabilityCatalog.ScopeSatisfies(grantedScopes, s)),
                todayCalls = tally.ByCapability.TryGetValue(cap.Key, out var capCalls) ? capCalls : 0,
                tools = tools.Select(t => new
                {
                    name = t.Name,
                    description = t.Description,
                    requiredScope = t.RequiredScope,
                    isWrite = McpUsageService.IsWriteTool(t),
                    granted = McpCapabilityCatalog.ScopeSatisfies(grantedScopes, t.RequiredScope),
                }),
            };
        }).ToList();

        // 今日用量要覆盖「今天有过调用」的**全部**密钥，不只是现在还列得出来的那几把。
        // 密钥可以被撤销，也可以被硬删（AgentApiKeysController.Delete 只删密钥，不动日志与计数器）——
        // 两种情况下 today.calls 都还算着它的调用，而 today.images/writes 会把它的量整个抹掉，
        // 同一屏两个数字自己跟自己对不上。用不着另存一份「历史密钥」：今天出现过的 keyId
        // 就在调用记录的聚合里，取并集即可。
        var usageKeyIds = new HashSet<string>(allKeys.Select(k => k.Id), StringComparer.Ordinal);
        foreach (var loggedKeyId in tally.ByKey.Keys) usageKeyIds.Add(loggedKeyId);
        var usageByKey = await _usage.GetTodayUsageAsync(usageKeyIds, ct);

        var clients = keys.Select(k => new
        {
            keyId = k.Id,
            name = k.Name,
            keyPrefix = k.KeyPrefix,
            // 自动模式的清单是现算的，不是库里存的那份（存的是空）。面板必须显示「它此刻真拿得到什么」，
            // 否则一把自动模式的钥匙在界面上会是「零个能力」，而它实际什么都调得动。
            // 「已停用 / 过了宽限期」的那些要显示成零个 —— 这一行下面就写着 isActive=false，
            // 旁边却列一串它根本调不动的能力，是同一行自己说两种话。
            scopes = McpCapabilityCatalog.EffectiveScopesForKey(k, ownedPermissions, nowUtc),
            scopeMode = k.ScopeMode == AgentApiKeyScopeMode.Auto ? "auto" : "manual",
            // 手动模式才有「你有、但没开给它」这件事 —— 自动模式按定义不会缺。
            // 这正是「用户知道、钥匙没权限」：平台新上一块能力、或者他当初没勾，都落在这里。
            // 用不了的钥匙也不谈「你还能再给它什么」—— 那句话的前提是它还能用。
            missingCapabilities = k.ScopeMode == AgentApiKeyScopeMode.Auto
                                  || !AgentApiKey.IsUsableAt(k, nowUtc, out _)
                ? new List<object>()
                : MissingCapabilitiesOf(k, ownedPermissions),
            isActive = AgentApiKey.IsUsableAt(k, nowUtc, out _),
            // 这份名单一开始就把 RevokedAt 非空的滤掉了（见上面的 allKeys.Where），
            // 所以出现在这里而又不可用的，只可能是「停用」或「过了宽限期」——两种都还救得回来。
            // 界面上原本一律写「已作废」，那是不可逆的意思，会让用户白白重接一台。
            unusableReason = AgentApiKey.IsUsableAt(k, nowUtc, out _)
                ? (string?)null
                : !k.IsActive ? "disabled" : "expired",
            expiresAt = k.ExpiresAt,
            lastUsedAt = k.LastUsedAt,
            todayCalls = tally.ByKey.TryGetValue(k.Id, out var keyCalls) ? keyCalls : 0,
            dailyImageQuota = k.McpDailyImageQuota ?? McpUsageService.DefaultDailyImageQuota,
            dailyWriteQuota = k.McpDailyWriteQuota ?? McpUsageService.DefaultDailyWriteQuota,
            rateLimitPerMin = k.McpRateLimitPerMin ?? McpUsageService.DefaultRateLimitPerMin,
            // 已用数读闸门那份计数器，不再由日志推算：两边口径必须是同一个，
            // 否则面板显示还剩很多、智能体那边却已经被挡（或反过来）。
            todayImages = usageByKey.TryGetValue(k.Id, out var u1) ? u1.Images : 0,
            todayWrites = usageByKey.TryGetValue(k.Id, out var u2) ? u2.Writes : 0,
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            endpointUrl = BuildEndpointUrl(),
            capabilities,
            clients,
            today = new
            {
                // 「今天」按 UTC 自然日切，与额度口径一致；界面上要写明白，别让人以为是本地零点
                sinceUtc = since,
                calls = tally.Total,
                images = usageByKey.Values.Sum(u => u.Images),
                writes = usageByKey.Values.Sum(u => u.Writes),
                denied = tally.ByStatus.TryGetValue("denied", out var denied) ? denied : 0,
                failed = tally.ByStatus.TryGetValue("error", out var failed) ? failed : 0,
            },
            hasHistory,
            recentCalls = recentLogs.Select(ToLogDto),
        }));
    }

    /// <summary>调用记录（分页，最新在前）。</summary>
    [HttpGet("calls")]
    public async Task<IActionResult> Calls(
        [FromQuery] string? keyId,
        [FromQuery] string? capability,
        [FromQuery] string? status,
        [FromQuery] int skip,
        [FromQuery] int limit,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var resolvedLimit = limit is > 0 and <= 200 ? limit : 50;
        var resolvedSkip = skip > 0 ? skip : 0;

        var f = Builders<McpCallLog>.Filter;
        var filter = f.And(
            f.Eq(x => x.OwnerUserId, userId),
            f.Eq(x => x.DeploymentSlug, DeploymentScope.CurrentDurable));
        if (!string.IsNullOrWhiteSpace(keyId)) filter = f.And(filter, f.Eq(x => x.KeyId, keyId));
        if (!string.IsNullOrWhiteSpace(capability)) filter = f.And(filter, f.Eq(x => x.Capability, capability));
        if (!string.IsNullOrWhiteSpace(status)) filter = f.And(filter, f.Eq(x => x.Status, status));

        var total = await _db.McpCallLogs.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.McpCallLogs.Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip(resolvedSkip)
            .Limit(resolvedLimit)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            total,
            skip = resolvedSkip,
            limit = resolvedLimit,
            items = items.Select(ToLogDto),
        }));
    }

    /// <summary>
    /// 能力自检：这把密钥现在能看到哪些工具。
    ///
    /// 服务端按 scope 直接算，与 /api/mcp 的 tools/list 同一个判据 —— 不发网络请求，
    /// 所以它回答的是「授权对不对」，不是「你的客户端能不能连上」。界面上要如实这么写。
    /// </summary>
    [HttpGet("keys/{keyId}/visible-tools")]
    public async Task<IActionResult> VisibleTools(string keyId, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var key = await _keyService.GetByIdAsync(keyId, ct);
        if (key == null || key.OwnerUserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "密钥不存在或无权访问"));

        // 先问「这把钥匙现在还用得了吗」，再算它能看见什么。
        //
        // 停用、撤销、过了宽限期的钥匙，/api/mcp 在 LookupByPlaintextAsync 那一步就直接拒了，
        // 一个工具也调不动。而这里原来只按存下来的 scope 算清单，照样能算出一串名字，
        // 弹窗接着报「授权自检通过」—— 用户拿着一把已经作废的钥匙去接，接不上还找不着原因。
        // isActive 字段当时是回了的，但没人拿它拦这段计算：算出来的东西本身就是错的，
        // 不该指望展示层去补救（形状 1：判据比它该管的范围窄）。
        var usable = AgentApiKey.IsUsableAt(key, DateTime.UtcNow, out var inGrace);
        if (!usable)
            return Ok(ApiResponse<object>.Ok(new
            {
                endpointUrl = BuildEndpointUrl(),
                keyId = key.Id,
                keyName = key.Name,
                keyPrefix = key.KeyPrefix,
                isActive = false,
                expiresAt = key.ExpiresAt,
                unusableReason = key.RevokedAt.HasValue ? "这把钥匙已经吊销了"
                    : !key.IsActive ? "这把钥匙被停用了"
                    : "这把钥匙已经过期，连宽限期也过了",
                toolCount = 0,
                tools = Array.Empty<VisibleTool>(),
            }));

        // 与 /api/mcp 的 tools/list 同口径：权限被回收的 scope 在鉴权时就被剥掉了，
        // 自检不能照着存下来的 scope 报一串对方其实看不见的工具。
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        var ownedPermissions = await _permissions.GetEffectivePermissionsAsync(userId, isRoot, ct);
        // 自动模式的钥匙库里存的是空清单 —— 照着它算，自检会报「0 个工具」，
        // 而它连上去其实什么都调得动。走与鉴权同一处的推导。
        var scopes = EffectiveScopesOf(key, ownedPermissions)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var visible = McpBuiltinTools.All
            .Where(t => McpCapabilityCatalog.ScopeSatisfies(scopes, t.RequiredScope))
            .Select(t => new VisibleTool(
                t.Name, t.Description, McpCapabilityCatalog.ByScope(t.RequiredScope)?.Key, McpUsageService.IsWriteTool(t)))
            .ToList();

        // tools/list 除了内置工具还会列出登记表里的动态开放接口（agent.* scope）。
        // 自检只扫内置的话，一把只带动态 scope 的钥匙会被报成「0 个工具」，
        // 而它连上去其实好好的 —— 自检的用处就是回答「授权对不对」，报少了比不报还糟。
        // 可见性判据复用网关那一处 McpGatewayController.DynamicToolVisible，不另写一份。
        var endpoints = await _db.AgentOpenEndpoints.Find(e => e.IsActive).ToListAsync(ct);
        visible.AddRange(endpoints
            .Where(e => McpGatewayController.DynamicToolVisible(e, scopes, key.OwnerUserId))
            .Select(e => new VisibleTool(
                McpGatewayController.DynamicToolName(e),
                string.IsNullOrWhiteSpace(e.Description) ? e.Title : $"{e.Title} — {e.Description}",
                null,
                !string.Equals(e.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase))));

        return Ok(ApiResponse<object>.Ok(new
        {
            endpointUrl = BuildEndpointUrl(),
            keyId = key.Id,
            keyName = key.Name,
            keyPrefix = key.KeyPrefix,
            isActive = true,
            expiresAt = key.ExpiresAt,
            // 宽限期内还能用，但用户得知道它正在倒计时 —— 不说的话，某天突然全部调不动。
            unusableReason = inGrace ? "这把钥匙已经过期，正在宽限期里，续期之前随时会停" : null,
            toolCount = visible.Count,
            tools = visible,
        }));
    }

    /// <summary>自检里的一行工具。内置与动态两路要合成一张清单，所以给它一个名字，不用匿名类型。</summary>
    private sealed record VisibleTool(string Name, string Description, string? Capability, bool IsWrite);

    /// <summary>
    /// 这把钥匙此刻实际拿得到哪些 scope。判据与 <c>ApiKeyAuthenticationHandler</c> 同源：
    /// 自动模式现算（主人当前权限 ∩ 平台当前开放），手动模式读存的那份再按权限位过一遍。
    ///
    /// 面板与鉴权必须走同一个口径 —— 上一版就栽在这上面：面板照 IsActive 判、鉴权照能不能用判，
    /// 于是用户看到「已连接、已授权」，而它发的每个请求都被拒。
    /// </summary>
    private static IReadOnlyList<string> EffectiveScopesOf(AgentApiKey key, IReadOnlyList<string> ownedPermissions)
        => McpCapabilityCatalog.EffectiveScopesFor(key.ScopeMode, key.Scopes, ownedPermissions);

    /// <summary>
    /// 「你自己有、但没开给这台客户端」的能力。只对手动模式成立。
    ///
    /// 不去追「平台是哪天新增的」：那需要给能力目录记时间戳，而用户要回答的问题从来不是
    /// 「这是不是新的」，而是「我还能给它什么」。按当前权限与当前授权做差，两种来源
    ///（平台新上的、他当初没勾的）都落进同一句话里。
    ///
    /// 两条判据缺一不可，缺任何一条这一行都会跟它自己上半行的能力标签打架：
    ///   1. 「有没有」用 <see cref="McpCapabilityCatalog.ScopeSatisfies"/>，不是集合直接 Contains ——
    ///      知识库与网页托管声明了 WriteImpliesRead，只存 `:write` 的钥匙闸门认它连读一起满足；
    ///   2. 只报**整块一点都没给**的能力（All 而不是 Any）—— 只给了读档的钥匙，那块能力是
    ///      部分授权，标签上写着已授权，这里若因为缺写档就把整块报成「还没开给它」，就是同一行
    ///      自己说两种话。
    ///
    /// 代价是：「你还可以再给它写入档」这句话现在说不出来。那要给这个字段带上档位
    ///（read/write），是新的语义类别 —— 按 §5.5 归后续 PR，见 doc/debt.platform.md #23。
    /// </summary>
    private static List<object> MissingCapabilitiesOf(AgentApiKey key, IReadOnlyList<string> ownedPermissions)
    {
        // held 必须取**有效**清单，不能读库里存的那份原始 scope。
        // 权限被回收之后两者会分叉：一把存着 web-pages:write 的手动钥匙，主人被降成只读时，
        // 有效清单里那条 write 已经被剥掉（鉴权也不会认），可原始清单里它还在 ——
        // 而 ScopeSatisfies 认 write 蕴含 read，于是这里会判「读档也满足了」，
        // 把 Web 整块从「还能给它什么」里漏掉：那一行同时显示「一块能力都没有」和「没有缺的」。
        // 与展示、鉴权同一处判据，不在这里读第二份数据。
        var held = McpCapabilityCatalog
            .EffectiveScopesFor(key.ScopeMode, key.Scopes, ownedPermissions)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return McpCapabilityCatalog.All
            .Where(cap => cap.AllScopes().Any(s => ScopeAvailable(s, ownedPermissions))
                          && cap.AllScopes().All(s =>
                              !ScopeAvailable(s, ownedPermissions) || !McpCapabilityCatalog.ScopeSatisfies(held, s)))
            .Select(cap => (object)new { key = cap.Key, title = cap.Title })
            .ToList();
    }

    /// <summary>
    /// 某个 scope 我自己签不签得出来：不受权限位把关的恒真，受把关的看权限位。
    ///
    /// 判据按 **scope** 而不是按能力整块判，且用的是签发口径（IsIssuancePermissionChecked）——
    /// 与 AgentApiKeysController.ValidateScopeAsync 同一个函数。两处不同口径的后果是
    /// 面板上写着「可以开通」，一点却被签发接口打回来：把用户请到门口再关门。
    /// </summary>
    private static bool ScopeAvailable(string? scope, IReadOnlyCollection<string> ownedPermissions)
    {
        if (string.IsNullOrEmpty(scope)) return false;
        if (!McpCapabilityCatalog.IsIssuancePermissionChecked(scope!)) return true;
        return McpCapabilityCatalog.PermissionsAllowScope(ownedPermissions, scope!);
    }

    private sealed record TodayTally(
        long Total,
        IReadOnlyDictionary<string, long> ByStatus,
        IReadOnlyDictionary<string, long> ByKey,
        IReadOnlyDictionary<string, long> ByCapability);

    /// <summary>
    /// 这个人在这套部署上**有没有过**任何一次调用 —— 不带时间下界。
    ///
    /// 面板上其余数字都按 UTC 自然日切，而「从来没接过」是一句关于**全部历史**的话：
    /// 一把昨天用过、今天之前被撤销的钥匙会让 clients 空、today 全零，
    /// 照着今天的数据说「还没有客户端接进来」，等于把一段真实历史说成从来没有。
    ///
    /// 前端一度想用 overview 的 recentCalls 代替这个判据 —— 那是错的，
    /// 它同样走 TodayFilter，今天没调用时必然为空。跨天的那份是「它干了什么」
    /// 那个端点（listMcpCalls），不是这里。两个数据源同名不同义，别再混。
    /// </summary>
    private async Task<bool> HasAnyHistoryAsync(string userId, CancellationToken ct)
    {
        var f = Builders<McpCallLog>.Filter;
        var scoped = f.And(
            f.Eq(x => x.OwnerUserId, userId),
            f.Eq(x => x.DeploymentSlug, DeploymentScope.CurrentDurable));
        return await _db.McpCallLogs.Find(scoped).Limit(1).AnyAsync(ct);
    }

    private FilterDefinition<McpCallLog> TodayFilter(string userId, DateTime since)
    {
        var f = Builders<McpCallLog>.Filter;
        return f.And(
            f.Eq(x => x.OwnerUserId, userId),
            f.Eq(x => x.DeploymentSlug, DeploymentScope.CurrentDurable),
            f.Gte(x => x.CreatedAt, since));
    }

    /// <summary>今日计数：交给 Mongo 分组统计，条数再多也是准的。</summary>
    private async Task<TodayTally> TodayTallyAsync(string userId, DateTime since, CancellationToken ct)
    {
        var groups = await _db.McpCallLogs.Aggregate()
            .Match(TodayFilter(userId, since))
            .Group(new BsonDocument
            {
                { "_id", new BsonDocument
                    {
                        { "status", "$Status" },
                        { "keyId", "$KeyId" },
                        { "capability", "$Capability" },
                    }
                },
                { "n", new BsonDocument("$sum", 1) },
            })
            .ToListAsync(ct);

        long total = 0;
        var byStatus = new Dictionary<string, long>(StringComparer.Ordinal);
        var byKey = new Dictionary<string, long>(StringComparer.Ordinal);
        var byCapability = new Dictionary<string, long>(StringComparer.Ordinal);

        foreach (var doc in groups)
        {
            var n = doc["n"].ToInt64();
            total += n;
            var id = doc["_id"].AsBsonDocument;
            Accumulate(byStatus, ReadKey(id, "status"), n);
            Accumulate(byKey, ReadKey(id, "keyId"), n);
            Accumulate(byCapability, ReadKey(id, "capability"), n);
        }

        return new TodayTally(total, byStatus, byKey, byCapability);

        static string? ReadKey(BsonDocument id, string name)
            => id.TryGetValue(name, out var v) && !v.IsBsonNull ? v.AsString : null;

        static void Accumulate(Dictionary<string, long> map, string? key, long n)
        {
            if (string.IsNullOrEmpty(key)) return;
            map[key] = map.TryGetValue(key, out var cur) ? cur + n : n;
        }
    }

    private async Task<List<McpCallLog>> RecentLogsAsync(string userId, DateTime since, int limit, CancellationToken ct)
        => await _db.McpCallLogs.Find(TodayFilter(userId, since))
            .SortByDescending(x => x.CreatedAt)
            .Limit(limit)
            .ToListAsync(ct);

    private static object ToLogDto(McpCallLog l) => new
    {
        id = l.Id,
        keyId = l.KeyId,
        keyName = l.KeyName,
        toolName = l.ToolName,
        capability = l.Capability,
        status = l.Status,
        isWrite = l.IsWrite,
        deduplicated = l.Deduplicated,
        imageCount = l.ImageCount,
        // 原始状态码不发给这个页面：它是普通用户（access 权限）的页面，不是管理员诊断面。
        // 结果由 status 说，失败原因由 errorMessage 用人话说；状态码留在 mcp_call_logs 里备查。
        durationMs = l.DurationMs,
        argumentsPreview = l.ArgumentsPreview,
        errorMessage = l.ErrorMessage,
        artifact = l.ArtifactKind == null && l.ArtifactUrl == null ? null : new
        {
            kind = l.ArtifactKind,
            id = l.ArtifactId,
            url = l.ArtifactUrl,
            title = l.ArtifactTitle,
        },
        createdAt = l.CreatedAt,
    };
}
