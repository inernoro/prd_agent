using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.GitHub;

/// <summary>
/// per-user GitHub 连接的唯一判定源：连接状态、token 解密、仓库/分支/目录读取。
///
/// 为什么要有这一层：Device Flow 的 status/start/poll/disconnect 与「列仓库、列目录」
/// 此前在 pr-review、project-route-agent、tech-doc-format-agent 三个 Controller 里各抄了一份，
/// 改一处忘一处（predicate-and-wiring-discipline 形状 3）。新增能力一律走这里，
/// Controller 只负责把结果翻成 HTTP。
///
/// token 存 <see cref="GitHubUserConnection.AccessTokenEncrypted"/>（AES，密钥来自 Jwt:Secret），
/// 任何时候都不出本服务边界之外的日志。
/// </summary>
public sealed class GitHubUserConnectionService
{
    private const int MaxRepositoriesPageSize = 50;
    private const int MaxTreeItems = 300;

    private readonly MongoDbContext _db;
    private readonly IGitHubOAuthService _oauth;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<GitHubUserConnectionService> _logger;

    public GitHubUserConnectionService(
        MongoDbContext db,
        IGitHubOAuthService oauth,
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILogger<GitHubUserConnectionService> logger)
    {
        _db = db;
        _oauth = oauth;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logger = logger;
    }

    /// <summary>管理员是否配置了 OAuth App（没配就连不了，前端要给出明确提示而不是空转）。</summary>
    public bool IsOAuthConfigured()
        => !string.IsNullOrWhiteSpace(_config["GitHubOAuth:ClientId"]);

    public async Task<GitHubUserConnection?> GetConnectionAsync(string userId, CancellationToken ct)
        => await _db.GitHubUserConnections.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);

    /// <summary>取出并解密当前用户的 access token；未连接 / 解不出来都抛 <see cref="GitHubException"/>。</summary>
    public async Task<string> ResolveTokenAsync(string userId, CancellationToken ct)
    {
        var conn = await GetConnectionAsync(userId, ct);
        if (conn == null || string.IsNullOrEmpty(conn.AccessTokenEncrypted))
        {
            throw GitHubException.NotConnected();
        }

        var token = DecryptToken(conn);
        if (string.IsNullOrEmpty(token))
        {
            throw GitHubException.TokenExpired();
        }
        return token;
    }

    /// <summary>
    /// 解开**这一条**连接记录里的令牌密文，解不开回 null。
    ///
    /// 独立出来是为了让调用方能把「用哪一条」攥在自己手里：断开那条路必须对同一条记录
    /// 既撤销又删除，中途再查一次库就可能撤到另一条上去
    /// （2026-09-15 Codex review 第九轮）。
    /// </summary>
    private string? DecryptToken(GitHubUserConnection conn)
    {
        if (string.IsNullOrEmpty(conn.AccessTokenEncrypted)) return null;
        var jwtSecret = _config["Jwt:Secret"]
            ?? throw new InvalidOperationException("Jwt:Secret missing");
        var token = ApiKeyCrypto.Decrypt(conn.AccessTokenEncrypted, jwtSecret);
        return string.IsNullOrEmpty(token) ? null : token;
    }

    /// <summary>
    /// 这个用户的连接**当下**还能不能用（不只是「存过」）。
    ///
    /// 用户在 GitHub 那边撤销授权之后，本地记录仍在、token 也解得出来，但每次调用都是 401。
    /// 三态返回：明确 401/403 才算 Revoked；网络抖动等问不出结论的一律 Unknown，
    /// 交给调用方按「不确定时保守」处理——把不确定当成「已撤销」会静默改坏正常路径。
    /// </summary>
    public async Task<GitHubConnectionUsability> ProbeConnectionAsync(string userId, CancellationToken ct)
    {
        var conn = await GetConnectionAsync(userId, ct);
        if (conn == null) return GitHubConnectionUsability.Revoked;
        return await ProbeConnectionAsync(conn, ct);
    }

    /// <summary>
    /// 探**这一条**连接还能不能用。
    ///
    /// 调用方已经握着一条记录时必须走这个重载，别再传 userId 让它重查一次库：
    /// 中途若有人换了账号，重查拿到的是另一条，于是会「拿 B 的令牌去探，报 A 的账号信息」——
    /// 界面说 A 可用，接下来的请求却走 B。同一条记录既用来展示又用来判断，才不会前后不一。
    /// </summary>
    public async Task<GitHubConnectionUsability> ProbeConnectionAsync(
        GitHubUserConnection conn, CancellationToken ct)
    {
        var token = DecryptToken(conn);
        if (token == null) return GitHubConnectionUsability.Revoked;

        try
        {
            using var client = CreateApiClient(token);
            using var resp = await client.GetAsync("user", ct);
            if (resp.IsSuccessStatusCode) return GitHubConnectionUsability.Usable;

            // 只有 401 能证明这把 token 不认了。403 不行：GitHub 把**限额耗尽**也报成 403，
            // 组织的 SAML 策略同样报 403，两种情况下 token 都是好的。
            // 把它们判成 Revoked，会让一条私有仓订阅永久退回匿名（而匿名读私有仓只会得到 404）。
            return resp.StatusCode == HttpStatusCode.Unauthorized
                ? GitHubConnectionUsability.Revoked
                : GitHubConnectionUsability.Unknown;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        {
            return GitHubConnectionUsability.Unknown;
        }
    }

    /// <summary>Device Flow 成功后落库（同一用户覆盖旧连接）。</summary>
    public async Task<GitHubUserInfo> PersistConnectionAsync(
        string userId, string accessToken, string scope, CancellationToken ct)
    {
        var userInfo = await _oauth.FetchUserInfoAsync(accessToken, ct);
        var jwtSecret = _config["Jwt:Secret"]
            ?? throw new InvalidOperationException("Jwt:Secret missing");
        var encrypted = ApiKeyCrypto.Encrypt(accessToken, jwtSecret);

        var update = Builders<GitHubUserConnection>.Update
            .Set(x => x.UserId, userId)
            .Set(x => x.GitHubLogin, userInfo.Login)
            .Set(x => x.GitHubUserId, userInfo.Id.ToString())
            .Set(x => x.AvatarUrl, userInfo.AvatarUrl)
            .Set(x => x.AccessTokenEncrypted, encrypted)
            .Set(x => x.Scopes, scope)
            .Set(x => x.ConnectedAt, DateTime.UtcNow)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"));

        await _db.GitHubUserConnections.UpdateOneAsync(
            Builders<GitHubUserConnection>.Filter.Eq(x => x.UserId, userId),
            update,
            new UpdateOptions { IsUpsert = true },
            ct);

        _logger.LogInformation("[GitHubConnect] connected user={UserId} login={Login}", userId, userInfo.Login);
        return userInfo;
    }

    /// <summary>
    /// 断开当前用户的 GitHub 连接：**先去 GitHub 撤销授权，再删本地密文**。
    ///
    /// 顺序不能反：先删了本地就再也拿不到那把 token，撤销也就无从谈起，
    /// 于是"断开"只断在自己这边，GitHub 的已授权应用列表里那一条还挂着——
    /// 用户以为收回了权限，其实没有。
    ///
    /// 撤销失败不阻断本地删除（用户的诉求首先是"别再用我的账号"），但结果要原样带回去给用户看，
    /// 不许静默吞掉（predicate-and-wiring-discipline 形状 10）。
    /// </summary>
    public async Task<GitHubDisconnectResult> DisconnectAsync(string userId, CancellationToken ct)
    {
        // 先把要断开的**那一条**记下来。后面撤销要打一次 GitHub（几百毫秒），
        // 这期间用户完全可能在另一个标签页把授权重新走完、写入一条新连接；
        // 那时再按用户 ID 删，删掉的就是刚连上的新连接——用户眼睁睁看着刚接好的又没了。
        // 所以删除必须钉在这一条上（同一条记录、同一份密文），别人写进来的新连接不归这次断开管。
        var target = await GetConnectionAsync(userId, ct);

        // 撤销用的令牌只能来自**刚刚捕获的那一条**，不能再查一次库：
        // 中途若有人重新授权（甚至换了个账号），再查一次拿到的是新的那把，
        // 于是会去撤销新账号的授权，而本该撤的那份原封不动——撤错了人，还漏撤了该撤的。
        GitHubTokenRevocation revocation;
        if (target == null)
        {
            // 压根没连过：没有可撤销的东西，不是失败，也没有要用户处理的事。
            revocation = GitHubTokenRevocation.NothingToRevoke;
        }
        else
        {
            string? token;
            try
            {
                token = DecryptToken(target);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[GitHubConnect] 解不开这条连接的令牌密文 user={UserId}", userId);
                token = null;
            }

            if (token == null)
            {
                // 密文解不开（换过密钥等）：**我们手里这把钥匙读不出来，所以撤不了**。
                // 不能因此报「已撤销」——那是撒谎；也不能让断开整个失败——用户首先要的是本地别再留着它。
                revocation = GitHubTokenRevocation.Failed;
            }
            else
            {
                revocation = await _oauth.RevokeTokenAsync(token, ct);
            }
        }

        if (target == null)
        {
            _logger.LogInformation("[GitHubConnect] disconnect user={UserId}：本来就没有连接记录", userId);
            return new GitHubDisconnectResult(GitHubDisconnectOutcome.NothingToRemove, revocation);
        }

        // 钉住 Id + 那一份密文：中途被别人换掉（重新授权会 upsert 同一条记录、换新密文）就不删。
        var result = await _db.GitHubUserConnections.DeleteOneAsync(
            x => x.Id == target.Id && x.AccessTokenEncrypted == target.AccessTokenEncrypted, ct);

        // 没删成有两种来路，**只看删除条数分不开**：
        //   一是被替换（另一个标签页重新授权，密文换了，我们这条件不匹配）；
        //   二是被别人抢先删了（两个标签页同时断开，都捕获到同一条，第一个删掉了它）。
        // 所以回读一次：还在 = 被替换（那是别人的新连接，保留），不在 = 本来就没得删。
        // 只凭条数就报「被替换」，会对着第二个标签页说「新的连接已保留」——而根本没有那条连接。
        var outcome = GitHubDisconnectOutcome.Removed;
        if (result.DeletedCount == 0)
        {
            var current = await GetConnectionAsync(userId, ct);
            outcome = current == null
                ? GitHubDisconnectOutcome.NothingToRemove
                : GitHubDisconnectOutcome.ReplacedMeanwhile;
        }

        if (outcome == GitHubDisconnectOutcome.ReplacedMeanwhile)
        {
            // 回读确认过：那条新连接不归这次断开管，保留它才是对的。
            //
            // 已知边界：撤销打的是「删授权」，它会连带作废本应用为这个用户签发的**全部**令牌，
            // 所以那条新连接的令牌很可能也一起失效了。这里不去猜、也不替用户删——
            // 连接状态接口每次都会真问一次 GitHub，失效的话界面会显示「授权已失效」并给出重连出口。
            _logger.LogWarning(
                "[GitHubConnect] disconnect user={UserId}：期间连接已被替换，保留新连接不删", userId);
        }

        _logger.LogInformation(
            "[GitHubConnect] disconnect user={UserId} outcome={Outcome} revocation={Revocation}",
            userId, outcome, revocation);

        return new GitHubDisconnectResult(outcome, revocation);
    }

    public Task TouchLastUsedAsync(string userId, CancellationToken ct)
        => _db.GitHubUserConnections.UpdateOneAsync(
            x => x.UserId == userId,
            Builders<GitHubUserConnection>.Update.Set(x => x.LastUsedAt, DateTime.UtcNow),
            cancellationToken: ct);

    /// <summary>带 Bearer token 的 GitHub API 客户端（调用方负责 Dispose）。</summary>
    public HttpClient CreateApiClient(string accessToken)
    {
        var client = _httpClientFactory.CreateClient("GitHubApi");
        client.BaseAddress = new Uri("https://api.github.com/");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return client;
    }

    /// <summary>
    /// 列出当前用户可访问的仓库（owner / collaborator / org member，按更新时间倒序）。
    ///
    /// 返回值带 <c>HasMore</c>：它必须按**上游这一页的原始条数**算，不能按关键词过滤后的条数算。
    /// 过滤是在本页内做的，30 条里筛剩 2 条时上游明明还有下一页，按过滤后条数判就成了「没有更多」，
    /// 用户搜自己的仓库搜不到、也没得翻页。
    /// </summary>
    public async Task<GitHubRepositoryPage> ListRepositoriesAsync(
        string token, string? query, int page, int pageSize, CancellationToken ct)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, MaxRepositoriesPageSize);

        using var client = CreateApiClient(token);
        var path = "user/repos?affiliation=owner,collaborator,organization_member"
                 + $"&sort=updated&direction=desc&per_page={pageSize}&page={page}";
        using var resp = await client.GetAsync(path, ct);
        await ThrowIfErrorAsync(resp, "读取仓库列表失败", ct);

        var repos = await resp.Content.ReadFromJsonAsync<List<GitHubRepositoryDto>>(cancellationToken: ct)
                    ?? [];

        // 先按原始条数判还有没有下一页，再做本页过滤
        var hasMore = repos.Count >= pageSize;

        var keyword = (query ?? string.Empty).Trim();
        if (keyword.Length > 0)
        {
            repos = repos.Where(r =>
                (r.FullName ?? string.Empty).Contains(keyword, StringComparison.OrdinalIgnoreCase)
                || (r.Description ?? string.Empty).Contains(keyword, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }

        var items = repos.Select(r =>
        {
            var fullName = r.FullName ?? string.Empty;
            var parts = fullName.Split('/', 2);
            return new GitHubRepositorySummary
            {
                Id = r.Id,
                FullName = fullName,
                Owner = r.Owner?.Login ?? (parts.Length > 0 ? parts[0] : string.Empty),
                Repo = r.Name ?? (parts.Length > 1 ? parts[1] : string.Empty),
                Description = r.Description,
                IsPrivate = r.Private,
                DefaultBranch = r.DefaultBranch,
                HtmlUrl = r.HtmlUrl,
                UpdatedAt = r.UpdatedAt,
                OwnerAvatarUrl = r.Owner?.AvatarUrl,
            };
        }).ToList();

        return new GitHubRepositoryPage(items, hasMore);
    }

    /// <summary>一次分支请求取多少条，以及最多翻几页（上限 = 两者相乘）。</summary>
    private const int BranchesPerPage = 100;
    private const int MaxBranchPages = 5;

    /// <summary>
    /// 列出仓库分支。
    ///
    /// 必须翻页：只取第一页的话，分支超过 100 个的仓库里，目标分支只要不在这一页就**选不到**，
    /// 而界面既没有翻页也没有手填分支的入口——用户有权限却做不成这件事。
    /// 翻到取空或不足一页为止，并设一个页数上限兜住极端仓库（真有更多分支时，
    /// 选择器至少还有前 500 个可用，而不是整个请求被拖死）。
    /// </summary>
    public async Task<IReadOnlyList<GitHubBranchSummary>> ListBranchesAsync(
        string token, string owner, string repo, CancellationToken ct)
    {
        using var client = CreateApiClient(token);
        var all = new List<GitHubBranchSummary>();

        for (var page = 1; page <= MaxBranchPages; page++)
        {
            using var resp = await client.GetAsync(
                $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/branches"
                + $"?per_page={BranchesPerPage}&page={page}", ct);
            await ThrowIfErrorAsync(resp, $"读取 {owner}/{repo} 分支失败", ct);

            var branches = await resp.Content.ReadFromJsonAsync<List<GitHubBranchDto>>(cancellationToken: ct) ?? [];
            all.AddRange(branches
                .Where(b => !string.IsNullOrWhiteSpace(b.Name))
                .Select(b => new GitHubBranchSummary { Name = b.Name!, Protected = b.Protected }));

            if (branches.Count < BranchesPerPage) break;
        }

        return all;
    }

    /// <summary>列出单层目录内容（自由浏览用）。</summary>
    public async Task<IReadOnlyList<GitHubContentSummary>> ListDirectoryAsync(
        string token, string owner, string repo, string? path, string? branch, CancellationToken ct)
    {
        var safePath = (path ?? string.Empty).Trim().Trim('/');
        using var client = CreateApiClient(token);

        var contentsPath = safePath.Length == 0
            ? $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/contents"
            : $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/contents/{EscapePath(safePath)}";
        if (!string.IsNullOrWhiteSpace(branch))
        {
            contentsPath += $"?ref={Uri.EscapeDataString(branch)}";
        }

        using var resp = await client.GetAsync(contentsPath, ct);
        await ThrowIfErrorAsync(resp, $"读取 {owner}/{repo}/{safePath} 失败", ct);

        var items = await resp.Content.ReadFromJsonAsync<List<GitHubContentDto>>(cancellationToken: ct) ?? [];
        return items
            .OrderByDescending(x => string.Equals(x.Type, "dir", StringComparison.OrdinalIgnoreCase))
            .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
            .Take(MaxTreeItems)
            .Select(x => new GitHubContentSummary
            {
                Name = x.Name ?? string.Empty,
                Path = x.Path ?? string.Empty,
                Type = x.Type ?? string.Empty,
                Size = x.Size,
                HtmlUrl = x.HtmlUrl,
            })
            .ToList();
    }

    /// <summary>
    /// 一次 Git Trees API（recursive=1）拉全仓路径，折成可勾选的目录清单 + 默认预勾选集合。
    /// 判据全部在 <see cref="GitHubDocDirectoryPlanner"/> 里，本方法只负责取数。
    /// </summary>
    public async Task<GitHubDirectoryScan> ScanDirectoriesAsync(
        string token, string owner, string repo, string? branch, CancellationToken ct)
    {
        using var client = CreateApiClient(token);

        var resolvedBranch = branch;
        if (string.IsNullOrWhiteSpace(resolvedBranch))
        {
            using var repoResp = await client.GetAsync(
                $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}", ct);
            await ThrowIfErrorAsync(repoResp, $"读取 {owner}/{repo} 失败", ct);
            var meta = await repoResp.Content.ReadFromJsonAsync<GitHubRepositoryDto>(cancellationToken: ct);
            resolvedBranch = meta?.DefaultBranch ?? "main";
        }

        using var resp = await client.GetAsync(
            $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/git/trees/"
            + $"{Uri.EscapeDataString(resolvedBranch!)}?recursive=1", ct);
        await ThrowIfErrorAsync(resp, $"读取 {owner}/{repo}@{resolvedBranch} 目录树失败", ct);

        var tree = await resp.Content.ReadFromJsonAsync<GitHubTreeResponseDto>(cancellationToken: ct)
                   ?? new GitHubTreeResponseDto();

        var entries = (tree.Tree ?? [])
            .Where(t => !string.IsNullOrWhiteSpace(t.Path) && !string.IsNullOrWhiteSpace(t.Type))
            .Select(t => new GitHubTreeEntry(t.Path!, t.Type!));

        return GitHubDocDirectoryPlanner.BuildDirectories(
            entries, owner, repo, resolvedBranch!, truncatedUpstream: tree.Truncated);
    }

    /// <summary>GitHub 非 2xx 统一翻成领域异常，让 Controller 只用 catch 一种。</summary>
    public async Task ThrowIfErrorAsync(HttpResponseMessage resp, string message, CancellationToken ct)
    {
        if (resp.IsSuccessStatusCode) return;

        switch (resp.StatusCode)
        {
            case HttpStatusCode.Unauthorized:
                throw GitHubException.TokenExpired();
            case HttpStatusCode.Forbidden:
                // GitHub 把「主限额耗尽」也报成 403，只有 X-RateLimit-Remaining 能区分。
                // 不分开的话，限额跑满会被说成「拒绝访问该资源」，用户拿着这句去查权限，查不出任何东西。
                if (GitHubRateLimit.IsExhausted(resp))
                    throw GitHubException.RateLimited(GitHubRateLimit.ResetHint(resp));
                throw GitHubException.Forbidden();
            case HttpStatusCode.NotFound:
                // 必须带下一步动作：GitHub 对无权访问的私有仓也返回 404，而且前端的用户文案净化器
                // 会把「没有可执行动作」的消息换成通用兜底，那样这句就等于没说。
                throw new GitHubException(
                    GitHubErrorCodes.GITHUB_REPO_NOT_VISIBLE, 404,
                    $"{message}：可能是仓库或分支不存在，也可能是这个 GitHub 账号无权访问；"
                    + "请核对地址，或重新连接 GitHub 账号并授予私有仓权限后重试");
            case (HttpStatusCode)429:
                throw GitHubException.RateLimited(GitHubRateLimit.ResetHint(resp));
            default:
                var body = await resp.Content.ReadAsStringAsync(ct);
                _logger.LogWarning("[GitHubConnect] API failed: status={Status} body={Body}", (int)resp.StatusCode, body);
                throw GitHubException.Upstream((int)resp.StatusCode);
        }
    }

    private static string EscapePath(string path)
        => Uri.EscapeDataString(path).Replace("%2F", "/", StringComparison.Ordinal);

    // ===== 对外结果模型 =====

    /// <summary>连接可用性三态；Unknown 表示没问出结论（网络抖动等），不是「不可用」。</summary>
    public enum GitHubConnectionUsability { Usable, Revoked, Unknown }

    /// <summary>
    /// 本地这一侧发生了什么。三态，因为「没删成」有两种完全不同的来路，
    /// 而用户该看到的话正好相反：一种是「本来就没有」，一种是「你在别处刚连上、给你留着了」。
    /// 用布尔表达这件事必然要靠调用方去猜是哪一种，猜错就会对着用户说反话。
    /// </summary>
    public enum GitHubDisconnectOutcome
    {
        /// <summary>那条连接已删除。</summary>
        Removed,

        /// <summary>进来时就没有连接记录（比如另一个标签页已经断开过了）。</summary>
        NothingToRemove,

        /// <summary>断开期间连接被替换成了另一份，按约定保留它，没有删。</summary>
        ReplacedMeanwhile,
    }

    /// <summary>
    /// 断开的结果：本地这一侧发生了什么、GitHub 那边的授权撤掉了没。
    /// 两件事分开报，因为它们可以一成一败，而用户的下一步取决于后者。
    /// </summary>
    public sealed record GitHubDisconnectResult(
        GitHubDisconnectOutcome Outcome,
        GitHubTokenRevocation Revocation);

    /// <summary>一页仓库 + 上游是否还有下一页（HasMore 按过滤前的原始条数算）。</summary>
    public sealed record GitHubRepositoryPage(
        IReadOnlyList<GitHubRepositorySummary> Items,
        bool HasMore);

    public sealed class GitHubRepositorySummary
    {
        public long Id { get; init; }
        public string FullName { get; init; } = string.Empty;
        public string Owner { get; init; } = string.Empty;
        public string Repo { get; init; } = string.Empty;
        public string? Description { get; init; }
        public bool IsPrivate { get; init; }
        public string? DefaultBranch { get; init; }
        public string? HtmlUrl { get; init; }
        public DateTime? UpdatedAt { get; init; }
        public string? OwnerAvatarUrl { get; init; }
    }

    public sealed class GitHubBranchSummary
    {
        public string Name { get; init; } = string.Empty;
        public bool Protected { get; init; }
    }

    public sealed class GitHubContentSummary
    {
        public string Name { get; init; } = string.Empty;
        public string Path { get; init; } = string.Empty;
        public string Type { get; init; } = string.Empty;
        public long? Size { get; init; }
        public string? HtmlUrl { get; init; }
    }

    // ===== GitHub 原始 DTO =====

    private sealed class GitHubRepositoryDto
    {
        [JsonPropertyName("id")] public long Id { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("full_name")] public string? FullName { get; set; }
        [JsonPropertyName("private")] public bool Private { get; set; }
        [JsonPropertyName("description")] public string? Description { get; set; }
        [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
        [JsonPropertyName("default_branch")] public string? DefaultBranch { get; set; }
        [JsonPropertyName("updated_at")] public DateTime? UpdatedAt { get; set; }
        [JsonPropertyName("owner")] public GitHubOwnerDto? Owner { get; set; }
    }

    private sealed class GitHubOwnerDto
    {
        [JsonPropertyName("login")] public string? Login { get; set; }
        [JsonPropertyName("avatar_url")] public string? AvatarUrl { get; set; }
    }

    private sealed class GitHubBranchDto
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("protected")] public bool Protected { get; set; }
    }

    private sealed class GitHubContentDto
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("path")] public string? Path { get; set; }
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("size")] public long? Size { get; set; }
        [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
    }

    private sealed class GitHubTreeResponseDto
    {
        [JsonPropertyName("truncated")] public bool Truncated { get; set; }
        [JsonPropertyName("tree")] public List<GitHubTreeItemDto>? Tree { get; set; }
    }

    private sealed class GitHubTreeItemDto
    {
        [JsonPropertyName("path")] public string? Path { get; set; }
        [JsonPropertyName("type")] public string? Type { get; set; }
    }
}
