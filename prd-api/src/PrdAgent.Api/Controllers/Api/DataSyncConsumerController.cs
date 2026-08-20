using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Api.Services.DataSync;
using PrdAgent.Core.DataSync;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 本站作为「目标站」：向另一台 MAP 申请授权，然后把数据拉过来一次。
///
/// 流程和界面一一对应：
/// 1. `POST prepare` —— 填源站地址，拿到跳转链接（本站生成 PKCE verifier 留在内存）
/// 2. 人在源站点同意，浏览器带着授权码回到本站 `/data-sync/callback`
/// 3. `POST callback` —— 本站服务端换取导出令牌，建一条 Run，并给出同步前对照表
/// 4. `POST runs/{id}/start` —— 确认对照表之后才真写库；DryRun 只统计
/// 5. `GET runs/{id}/stream` —— SSE 推进度，直到终态
///
/// 第 3 步和第 4 步分开是有意的：拿到令牌不等于开始写。中间那一屏是操作者最后一次
/// 看清「要往哪个库写、要写多少条、本地现在有多少」的机会。
/// </summary>
[ApiController]
[Route("api/instance-sync")]
[Authorize]
public sealed class DataSyncConsumerController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly DataSyncTokenVault _vault;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _configuration;
    private readonly ILogger<DataSyncConsumerController> _logger;

    public DataSyncConsumerController(
        MongoDbContext db,
        DataSyncTokenVault vault,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<DataSyncConsumerController> logger)
    {
        _db = db;
        _vault = vault;
        _httpClientFactory = httpClientFactory;
        _configuration = configuration;
        _logger = logger;
    }

    /// <summary>生成跳转链接。verifier 留在本站内存，只把它的散列送出去。</summary>
    [HttpPost("runs/prepare")]
    public async Task<IActionResult> Prepare([FromBody] DataSyncPrepareRequest request, CancellationToken ct)
    {
        if (!await IsAdminAsync(ct))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以发起跨实例同步"));
        }
        if (!TryNormalizeOrigin(request.SourceOrigin, out var origin))
        {
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_SOURCE_INVALID", "源站地址必须是 https 的站点根地址"));
        }

        var state = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var verifier = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(48));
        _vault.StashVerifier(state, verifier, DateTime.UtcNow.AddMinutes(15));

        var callback = $"{SelfOrigin()}/data-sync/callback";
        var authorizeUrl = QueryHelpers.AddQueryString($"{origin}/api/instance-sync/authorize", new Dictionary<string, string?>
        {
            ["redirect_uri"] = callback,
            ["state"] = state,
            ["code_challenge"] = DataSyncProviderController.Sha256Base64Url(verifier),
        });

        return Ok(ApiResponse<object>.Ok(new { authorizeUrl, state, sourceOrigin = origin, callback }));
    }

    /// <summary>浏览器回跳后由前端把 code/state 交给本站服务端，这里去源站换令牌并建 Run。</summary>
    [HttpPost("runs/callback")]
    public async Task<IActionResult> Callback([FromBody] DataSyncCallbackRequest request, CancellationToken ct)
    {
        if (!await IsAdminAsync(ct))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以发起跨实例同步"));
        }
        if (string.IsNullOrWhiteSpace(request.Code) || string.IsNullOrWhiteSpace(request.State)
            || !TryNormalizeOrigin(request.SourceOrigin, out var origin))
        {
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_CALLBACK_INVALID", "回调参数不完整"));
        }

        var verifier = _vault.TakeVerifier(request.State!);
        if (verifier is null)
        {
            // 拿不到 verifier 的两种情况都不该继续：state 不是本站发的（可能是别人塞给
            // 管理员的链接），或者进程重启了。两种都要求重新走一次跳转。
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_STATE_UNKNOWN", "这次授权已失效，请重新发起跳转"));
        }

        var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);
        using var response = await client.PostAsJsonAsync($"{origin}/api/instance-sync/token", new
        {
            code = request.Code,
            redirectUri = $"{SelfOrigin()}/data-sync/callback",
            codeVerifier = verifier,
        }, ct);

        var payload = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("[data-sync] 换取导出令牌失败 {Status}", (int)response.StatusCode);
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_TOKEN_REJECTED",
                $"源站拒绝了这次换取（HTTP {(int)response.StatusCode}）"));
        }

        var token = ReadTokenPayload(payload);
        if (token is null)
        {
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_TOKEN_MALFORMED", "源站返回的内容无法解析"));
        }

        var run = new DataSyncRun
        {
            OperatorUserId = this.GetRequiredUserId(),
            SourceOrigin = origin,
            SourceLabel = token.SiteLabel,
            Groups = token.Groups,
            Collections = token.Collections,
            ExportTokenHash = "",
            ExportTokenExpiresAt = token.ExpiresAt,
            Status = "pending",
        };
        await _db.DataSyncRuns.InsertOneAsync(run, cancellationToken: ct);
        _vault.PutExportToken(run.Id, token.ExportToken, token.ExpiresAt);

        return Ok(ApiResponse<object>.Ok(new { runId = run.Id, run.SourceLabel, run.Groups, run.Collections }));
    }

    /// <summary>
    /// 同步前对照表：源站每个集合多少条、本地现在多少条、要写进哪个数据库。
    ///
    /// 「要写进哪个数据库」这一行不是装饰：分支预览共享同一个库，在任何一个分支上跑
    /// 同步，同库的其它分支立刻看得见。让操作者在按下开始之前看见库名，是唯一能挡住
    /// 「以为只影响自己这条分支」的手段。
    /// </summary>
    [HttpGet("runs/{id}/plan")]
    public async Task<IActionResult> Plan(string id, CancellationToken ct)
    {
        if (!await IsAdminAsync(ct))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以发起跨实例同步"));
        }

        var run = await FindRunAsync(id, ct);
        if (run is null) return NotFound(ApiResponse<object>.Fail("DATA_SYNC_RUN_NOT_FOUND", "同步记录不存在"));

        var token = _vault.GetExportToken(run.Id);
        if (token is null)
        {
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_TOKEN_EXPIRED", "导出令牌已失效，请重新授权"));
        }

        var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(60);
        client.DefaultRequestHeaders.Add("X-Data-Sync-Token", token);
        using var response = await client.GetAsync($"{run.SourceOrigin}/api/instance-sync/manifest", ct);
        if (!response.IsSuccessStatusCode)
        {
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_MANIFEST_FAILED",
                $"源站清单读取失败（HTTP {(int)response.StatusCode}）"));
        }

        var manifest = ReadManifest(await response.Content.ReadAsStringAsync(ct));
        var rows = new List<object>();
        foreach (var item in manifest)
        {
            var local = await _db.Database.GetCollection<BsonDocument>(item.Collection)
                .CountDocumentsAsync(Builders<BsonDocument>.Filter.Empty, cancellationToken: ct);
            rows.Add(new
            {
                collection = item.Collection,
                group = DataSyncScope.GroupOf(item.Collection),
                sourceTotal = item.Total,
                localTotal = local,
                redactFields = item.RedactFields,
            });
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            runId = run.Id,
            run.SourceLabel,
            run.SourceOrigin,
            targetDatabase = _db.Database.DatabaseNamespace.DatabaseName,
            rows,
        }));
    }

    /// <summary>确认对照表后开始执行。真正干活的是 DataSyncRunWorker。</summary>
    [HttpPost("runs/{id}/start")]
    public async Task<IActionResult> Start(string id, [FromBody] DataSyncStartRequest request, CancellationToken ct)
    {
        if (!await IsAdminAsync(ct))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以发起跨实例同步"));
        }

        var run = await FindRunAsync(id, ct);
        if (run is null) return NotFound(ApiResponse<object>.Fail("DATA_SYNC_RUN_NOT_FOUND", "同步记录不存在"));
        if (run.Status != "pending")
        {
            // 一次授权一条 Run、一条 Run 跑一次。重复点开始不该叠加执行。
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_RUN_NOT_PENDING", $"这条同步已经是 {run.Status} 状态"));
        }
        if (_vault.GetExportToken(run.Id) is null)
        {
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_TOKEN_EXPIRED", "导出令牌已失效，请重新授权"));
        }

        await _db.DataSyncRuns.UpdateOneAsync(
            Builders<DataSyncRun>.Filter.Eq(x => x.Id, run.Id),
            Builders<DataSyncRun>.Update
                .Set(x => x.Status, "running")
                .Set(x => x.DryRun, request.DryRun)
                .Set(x => x.OverwriteExisting, request.Overwrite)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { runId = run.Id, status = "running", dryRun = request.DryRun }));
    }

    [HttpGet("runs/{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken ct)
    {
        if (!await IsAdminAsync(ct))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以发起跨实例同步"));
        }

        var run = await FindRunAsync(id, ct);
        if (run is null) return NotFound(ApiResponse<object>.Fail("DATA_SYNC_RUN_NOT_FOUND", "同步记录不存在"));
        return Ok(ApiResponse<object>.Ok(Describe(run)));
    }

    [HttpGet("runs")]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        if (!await IsAdminAsync(ct))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("DATA_SYNC_ADMIN_REQUIRED", "只有管理员可以发起跨实例同步"));
        }

        var runs = await _db.DataSyncRuns
            .Find(Builders<DataSyncRun>.Filter.Empty)
            .SortByDescending(x => x.CreatedAt)
            .Limit(20)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(runs.Select(Describe)));
    }

    /// <summary>
    /// SSE 进度流。每秒读一次 Run 文档，只在内容变化时推送，终态后收尾。
    ///
    /// 之所以不是让前端轮询：同步动辄几分钟，屏幕上必须一直有东西在动（禁止空白等待）。
    /// 推的是每个集合的真实条数，不是一个假装精确的百分比。
    /// </summary>
    [HttpGet("runs/{id}/stream")]
    public async Task Stream(string id, CancellationToken ct)
    {
        // SSE 不能靠返回 IActionResult 表达 403（响应体已经是事件流了），所以在写头之前判。
        if (!await IsAdminAsync(ct))
        {
            Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        Response.Headers.Append("Content-Type", "text/event-stream");
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("X-Accel-Buffering", "no");

        var lastPayload = "";
        var deadline = DateTime.UtcNow.AddHours(2);
        while (!ct.IsCancellationRequested && DateTime.UtcNow < deadline)
        {
            var run = await FindRunAsync(id, ct);
            if (run is null)
            {
                await WriteEventAsync("error", "{\"message\":\"同步记录不存在\"}", ct);
                return;
            }
            var payload = SerializeRunForStream(run);
            if (payload != lastPayload)
            {
                lastPayload = payload;
                await WriteEventAsync("progress", payload, ct);
            }
            if (run.Status is "succeeded" or "failed" or "cancelled")
            {
                await WriteEventAsync("done", payload, ct);
                return;
            }
            await Task.Delay(1000, ct);
        }
    }

    private async Task WriteEventAsync(string name, string data, CancellationToken ct)
    {
        await Response.WriteAsync($"event: {name}\ndata: {data}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    /// <summary>
    /// Run 的对外形状。
    ///
    /// 每个字段名都显式写成 camelCase，**不要**用 `run.Status` 这种简写。原因：这个对象
    /// 走两条路出去——`ApiResponse` 那条经 MVC 的 JSON 配置（camelCase），SSE 那条是自己
    /// 调 JsonSerializer（默认 PascalCase）。用简写的话两条路吐出的键名不一样，前端从
    /// GET 拿到 `status`、从 SSE 拿到 `Status`，页面在同步跑起来的那一刻突然读不到值。
    /// </summary>
    private static object Describe(DataSyncRun run) => new
    {
        runId = run.Id,
        status = run.Status,
        sourceLabel = run.SourceLabel,
        sourceOrigin = run.SourceOrigin,
        groups = run.Groups,
        collections = run.Collections,
        dryRun = run.DryRun,
        overwriteExisting = run.OverwriteExisting,
        error = run.Error,
        createdAt = run.CreatedAt,
        finishedAt = run.FinishedAt,
        pendingSecretFields = run.PendingSecretFields,
        progress = run.Progress.Select(kv => new
        {
            collection = kv.Key,
            sourceTotal = kv.Value.SourceTotal,
            fetched = kv.Value.Fetched,
            inserted = kv.Value.Inserted,
            skipped = kv.Value.Skipped,
            updated = kv.Value.Updated,
            plannedInsert = kv.Value.PlannedInsert,
            plannedUpdate = kv.Value.PlannedUpdate,
            done = kv.Value.Done,
        }),
    };

    /// <summary>SSE payload 的序列化口径。导出给测试，确保断言的就是真发出去的那份。</summary>
    internal static string SerializeRunForStream(DataSyncRun run) => JsonSerializer.Serialize(Describe(run));

    private Task<DataSyncRun?> FindRunAsync(string id, CancellationToken ct) =>
        _db.DataSyncRuns.Find(x => x.Id == id).FirstOrDefaultAsync(ct)!;

    private async Task<bool> IsAdminAsync(CancellationToken ct)
    {
        if (FederatedConsoleSessionPolicy.IsSynthetic(User)) return false;
        if (string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal)) return true;
        var userId = this.GetRequiredUserId();
        var user = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        return user is not null && user.Status == UserStatus.Active && user.Role == UserRole.ADMIN;
    }

    private string SelfOrigin()
    {
        var configured = _configuration["DataSync:SelfOrigin"] ?? _configuration["PUBLIC_BASE_URL"];
        if (!string.IsNullOrWhiteSpace(configured)) return configured!.TrimEnd('/');
        return $"{Request.Scheme}://{Request.Host.Value}";
    }

    internal static bool TryNormalizeOrigin(string? raw, out string origin)
    {
        origin = "";
        if (!Uri.TryCreate((raw ?? "").Trim().TrimEnd('/'), UriKind.Absolute, out var uri)) return false;
        var validScheme = uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback);
        // 只收站点根地址：带路径的地址意味着调用方在猜端点位置，猜错了错误信息会很难懂。
        if (!validScheme || uri.AbsolutePath.TrimEnd('/').Length > 0) return false;
        origin = uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
        return true;
    }

    private sealed record TokenPayload(
        string ExportToken, DateTime ExpiresAt, string SiteLabel, List<string> Groups, List<string> Collections);

    private static TokenPayload? ReadTokenPayload(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var data)) return null;
            var token = data.GetProperty("exportToken").GetString();
            if (string.IsNullOrWhiteSpace(token)) return null;
            return new TokenPayload(
                token!,
                data.GetProperty("expiresAt").GetDateTime(),
                data.TryGetProperty("siteLabel", out var label) ? label.GetString() ?? "" : "",
                data.TryGetProperty("groups", out var g)
                    ? g.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList()
                    : new List<string>(),
                data.TryGetProperty("collections", out var c)
                    ? c.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList()
                    : new List<string>());
        }
        catch (Exception)
        {
            return null;
        }
    }

    private sealed record ManifestItem(string Collection, long Total, List<string> RedactFields);

    private static List<ManifestItem> ReadManifest(string json)
    {
        var items = new List<ManifestItem>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var data)) return items;
            if (!data.TryGetProperty("collections", out var collections)) return items;
            foreach (var element in collections.EnumerateArray())
            {
                var name = element.GetProperty("collection").GetString();
                if (string.IsNullOrWhiteSpace(name)) continue;
                items.Add(new ManifestItem(
                    name!,
                    element.TryGetProperty("total", out var total) ? total.GetInt64() : 0,
                    element.TryGetProperty("redactFields", out var rf)
                        ? rf.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList()
                        : new List<string>()));
            }
        }
        catch (Exception)
        {
            return items;
        }
        return items;
    }
}

public sealed class DataSyncPrepareRequest
{
    public string? SourceOrigin { get; set; }
}

public sealed class DataSyncCallbackRequest
{
    public string? SourceOrigin { get; set; }
    public string? Code { get; set; }
    public string? State { get; set; }
}

public sealed class DataSyncStartRequest
{
    public bool DryRun { get; set; }
    public bool Overwrite { get; set; }
}
