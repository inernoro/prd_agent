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
    /// <summary>SSE 心跳间隔。10 秒是 server-authority #4 定的下限。</summary>
    private static readonly TimeSpan KeepAliveInterval = TimeSpan.FromSeconds(10);

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

        // 跳转之前先握一次手：版本对不上、或者对方压根没开对外同步，
        // 在这里当场说清楚，而不是让人跳过去勾一遍、回来才发现跑不了。
        var probe = await ProbeSourceAsync(origin, ct);
        if (probe.Error is not null)
        {
            return BadRequest(ApiResponse<object>.Fail(probe.Code!, probe.Error));
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

        return Ok(ApiResponse<object>.Ok(new
        {
            authorizeUrl, state, sourceOrigin = origin, callback,
            sourceLabel = probe.SiteLabel,
            sourceBuild = probe.Build,
        }));
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

        // 源站地址是管理员填进来的，必须走 SafeOutbound：它禁自动重定向、并在建连时把
        // 解析出的每个地址过一遍内网/保留段校验。默认客户端会让「https://127.0.0.1」
        // 或者一个公网地址 302 跳内网，把 API 服务器变成打自己内网的跳板。
        // 从这里开始一律 CancellationToken.None，不再看浏览器还连不连着。
        //
        // 换票是**双方各自改状态**的一步：源站收到请求就把授权码原子地标成已消费，
        // 并签出一张两小时的导出令牌。而本站这边 verifier 刚刚已经被 TakeVerifier 取走
        // （一次性），重来一次也换不了。所以只要请求发出去了，这一段就必须跑完——
        // 管理员在等待期间关掉标签页而把 ct 取消的话，PostAsJsonAsync 当场抛，
        // 本站既没存下也没作废那张令牌，它在源站眼里照样有效整整两小时，
        // 而任何人都不再持有它、也无从交还。这正是 server-authority 第 1 条
        // 「状态变更不得挂在 RequestAborted 上」要防的。
        var client = _httpClientFactory.CreateClient("SafeOutbound");
        client.Timeout = TimeSpan.FromSeconds(30);
        using var response = await client.PostAsJsonAsync($"{origin}/api/instance-sync/token", new
        {
            code = request.Code,
            redirectUri = $"{SelfOrigin()}/data-sync/callback",
            codeVerifier = verifier,
        }, CancellationToken.None);

        var payload = await response.Content.ReadAsStringAsync(CancellationToken.None);
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
        try
        {
            await _db.DataSyncRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
            _vault.PutExportToken(run.Id, token.ExportToken, token.ExpiresAt);
        }
        catch (Exception ex)
        {
            // 票已经在手上、Run 却没建成：这张令牌从此没有任何人会用它，也没有任何人
            // 会交还它，就这么在源站有效两小时。当场还回去，别留一个谁都不认领的凭据。
            _logger.LogError(ex, "[data-sync] 已换到导出令牌但建立同步记录失败，正在交还源站作废");
            await RevokeAtSourceAsync(origin, token.ExportToken);
            return StatusCode(StatusCodes.Status500InternalServerError, ApiResponse<object>.Fail(
                "DATA_SYNC_RUN_CREATE_FAILED",
                "已从源站取得导出令牌，但本站建立同步记录失败；令牌已交还作废，请重新发起授权。"));
        }

        return Ok(ApiResponse<object>.Ok(new { runId = run.Id, run.SourceLabel, run.Groups, run.Collections }));
    }

    /// <summary>
    /// 把一张还没落到任何 Run 上的导出令牌交还源站作废。
    ///
    /// 与 worker 收尾时那次交还是同一个端点、同一套判据（拿票即可作废，与源站当前
    /// 的对外开关无关）；区别只是这里还没有 Run，所以单独走一份。
    /// 尽力而为：还不掉就留日志等它自然过期，不为此把已经给出的错误再改一个说法。
    /// 一律 CancellationToken.None——这本身就是补偿动作，浏览器早就不在了。
    /// </summary>
    private async Task RevokeAtSourceAsync(string origin, string exportToken)
    {
        try
        {
            var client = _httpClientFactory.CreateClient("SafeOutbound");
            client.Timeout = TimeSpan.FromSeconds(15);
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{origin}/api/instance-sync/revoke");
            request.Headers.TryAddWithoutValidation("X-Data-Sync-Token", exportToken);
            using var response = await client.SendAsync(request, CancellationToken.None);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("[data-sync] 交还未落地的导出令牌失败 HTTP {Status}，票据将等待自然过期",
                    (int)response.StatusCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[data-sync] 交还未落地的导出令牌异常，票据将等待自然过期");
        }
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

        var client = _httpClientFactory.CreateClient("SafeOutbound");
        client.Timeout = TimeSpan.FromSeconds(60);
        client.DefaultRequestHeaders.Add("X-Data-Sync-Token", token);
        using var response = await client.GetAsync($"{run.SourceOrigin}/api/instance-sync/manifest", ct);
        if (!response.IsSuccessStatusCode)
        {
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_MANIFEST_FAILED",
                $"源站清单读取失败（HTTP {(int)response.StatusCode}）"));
        }

        List<ManifestItem> manifest;
        try
        {
            manifest = ReadManifest(await response.Content.ReadAsStringAsync(ct));
        }
        catch (InvalidOperationException ex)
        {
            // 解析不出来就别让人往下走：对照表是操作者唯一一次看清「要写什么」的机会。
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_MANIFEST_MALFORMED",
                $"源站清单读不懂，多半是两边版本不一致：{ex.Message}"));
        }
        // 源站没报告、但在授权清单里的集合，也要出现在对照表上并写明「不会同步」。
        // 藏起来等于让人以为它同步了。
        var reported = manifest.Select(x => x.Collection).ToHashSet(StringComparer.Ordinal);
        var missing = run.Collections.Where(c => !reported.Contains(c)).ToList();

        var rows = new List<object>();
        // 源站报了、但本站白名单不认识的集合（源站升级后新增、而本站还没跟上）：
        // 必须当场说清楚「不会同步」，并且**不能进执行清单**。
        // 原来这两件事都没做：它带着真实条数出现在对照表上，看着就是要同步的，
        // worker 到了跟前 TryResolve 失败、记条日志跳过，整条 Run 照样报成功——
        // 人确认过的清单里有它，终态却是「成功」，而它一条都没搬。
        var unsupported = new List<string>();
        foreach (var item in manifest)
        {
            if (!DataSyncScope.TryResolve(item.Collection, out _))
            {
                unsupported.Add(item.Collection);
                rows.Add(new
                {
                    collection = item.Collection,
                    group = (string?)null,
                    sourceReported = true,
                    sourceTotal = item.Total,
                    localTotal = -1L,
                    redactFields = Array.Empty<string>(),
                    supportedHere = false,
                });
                continue;
            }
            var local = await _db.Database.GetCollection<BsonDocument>(item.Collection)
                .CountDocumentsAsync(Builders<BsonDocument>.Filter.Empty, cancellationToken: ct);
            rows.Add(new
            {
                collection = item.Collection,
                group = DataSyncScope.GroupOf(item.Collection),
                sourceReported = true,
                sourceTotal = item.Total,
                localTotal = local,
                redactFields = item.RedactFields,
                supportedHere = true,
            });
        }

        foreach (var name in missing)
        {
            rows.Add(new
            {
                collection = name,
                group = DataSyncScope.GroupOf(name),
                sourceTotal = -1L,
                localTotal = -1L,
                redactFields = Array.Empty<string>(),
                sourceReported = false,
                supportedHere = true,
            });
        }

        // 把「对照表上真实展示过、且源站确实提供」的这一份落到 Run 上，执行只认它。
        //
        // 过滤带上 pending：Start 会把状态原子地改成 running，之后这份清单就必须冻住。
        // 否则另一个标签页（或另一个管理员）在 Start 之后、worker 认领之前再调一次
        // Plan，就能把清单换掉——人按下开始时看的是一份，worker 执行的是另一份。
        // 已经 running 的 Run 这里不报错：调用方只是想再看一眼对照表，读到什么给什么，
        // 只是不再允许它改写执行范围。
        // 执行清单只收「源站报了 + 本站认识」的那些。对照表上照样列出不认识的那几个，
        // 但它们不会进 PlannedCollections，worker 也就不会遇到「计划里有、却跑不了」。
        var planned = manifest.Where(x => DataSyncScope.TryResolve(x.Collection, out _)).ToList();
        // 源站报的总条数与脱敏契约一起固化。这两样只有源站知道，对照表上刚显示过，
        // 渲染完就丢掉的话下游只能瞎猜：进度里的 sourceTotal 永远 0，脱敏处理退回按
        // 本站白名单算，只被源站列为敏感的字段就此隐身。与执行清单同一次条件更新写入。
        var plannedManifest = planned.ToDictionary(
            x => x.Collection,
            x => new DataSyncPlannedCollection { SourceTotal = x.Total, RedactFields = x.RedactFields },
            StringComparer.Ordinal);
        await _db.DataSyncRuns.UpdateOneAsync(
            Builders<DataSyncRun>.Filter.And(
                Builders<DataSyncRun>.Filter.Eq(x => x.Id, run.Id),
                Builders<DataSyncRun>.Filter.Eq(x => x.Status, "pending")),
            Builders<DataSyncRun>.Update
                .Set(x => x.PlannedCollections, planned.Select(x => x.Collection).ToList())
                .Set(x => x.PlannedManifest, plannedManifest)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            runId = run.Id,
            notReportedBySource = missing,
            notSupportedHere = unsupported,
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
        if (run.PlannedCollections.Count == 0)
        {
            // 「先看对照表」不是建议而是关口：没看过就没有「屏幕上展示过的清单」，
            // 也就无从保证「看到的等于会写的」。界面本来就会先拉对照表，
            // 这里挡的是绕过界面直接打接口的路径。
            return BadRequest(ApiResponse<object>.Fail("DATA_SYNC_PLAN_REQUIRED",
                "开始之前要先读一次对照表（GET runs/{id}/plan），确认要往哪个库写什么"));
        }

        // 上面那次 Status 检查和这次写入之间有窗口。只按 _id 更新的话，两个并发的
        // Start 都会「成功」，后到的那个还能把 DryRun 从 true 改成 false——
        // 用户点的是「只试跑」，worker 认领到的却是真写库。所以把 pending 放进过滤条件，
        // 让「认领」由数据库一次原子完成，没改到任何文档就说明别人已经抢先了。
        var claimed = await _db.DataSyncRuns.UpdateOneAsync(
            Builders<DataSyncRun>.Filter.And(
                Builders<DataSyncRun>.Filter.Eq(x => x.Id, run.Id),
                Builders<DataSyncRun>.Filter.Eq(x => x.Status, "pending")),
            Builders<DataSyncRun>.Update
                .Set(x => x.Status, "running")
                .Set(x => x.DryRun, request.DryRun)
                .Set(x => x.OverwriteExisting, request.Overwrite)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        if (claimed.ModifiedCount == 0)
        {
            return Conflict(ApiResponse<object>.Fail("DATA_SYNC_RUN_NOT_PENDING",
                "这条同步刚刚已经被启动了，请刷新查看当前状态"));
        }

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
        var lastWriteAt = DateTime.UtcNow;
        var deadline = DateTime.UtcNow.AddHours(2);
        // 关标签页 / 代理掐连接是这条流最常见的结束方式，不是异常。
        // 断开会把 ct 取消，于是 Mongo 查询和 Task.Delay 都会抛 OperationCanceled；
        // 不接住的话，一次再普通不过的离开会变成端点异常终止（server-authority #2）。
        // 只接「确实是本请求被取消」这一种，别的取消照旧抛出去。
        //
        // 写入侧另有一套抛法（Kestrel 的 IOException / InvalidOperationException /
        // ObjectDisposed），交给 TryWriteEventAsync 用共享判据处理——那条判据不能在这里
        // 重写一遍（形状 3）。这个端点是纯观察者，同步本身跑在 Worker 里，
        // 所以对端走了就干净收摊，没有「必须继续做完」的服务端任务（server-authority #3）。
        try
        {
            while (!ct.IsCancellationRequested && DateTime.UtcNow < deadline)
            {
                var run = await FindRunAsync(id, ct);
                if (run is null)
                {
                    await TryWriteEventAsync("error", "{\"message\":\"同步记录不存在\"}", ct);
                    return;
                }
                var payload = SerializeRunForStream(run);
                if (payload != lastPayload)
                {
                    lastPayload = payload;
                    lastWriteAt = DateTime.UtcNow;
                    if (!await TryWriteEventAsync("progress", payload, ct)) return;
                }
                if (run.Status is "succeeded" or "failed" or "cancelled")
                {
                    await TryWriteEventAsync("done", payload, ct);
                    return;
                }
                // 心跳（server-authority #4）：一次慢导出或一批慢写入期间，进度可能几十秒
                // 一动不动。中间任何一层 ingress 的空闲超时都会把这条流掐掉，而前端把
                // 「流结束了」当成正常收尾、不重连——同步还在跑，屏幕却永远停在那一刻。
                // 所以不管有没有变化，至少每 10 秒写一次。
                if (DateTime.UtcNow - lastWriteAt >= KeepAliveInterval)
                {
                    lastWriteAt = DateTime.UtcNow;
                    if (!await TryWriteEventAsync("keepalive", "{}", ct)) return;
                }
                await Task.Delay(1000, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // 对端走了，正常收尾。
        }
    }

    /// <summary>
    /// 写一个 SSE 事件。返回 false = 对端已经不在了，调用方该收摊。
    ///
    /// 连接层的失败一律不往外抛：判据复用 <see cref="SseEventWriter.IsClientDisconnect"/>，
    /// 因为 Kestrel 对「socket 没了」有好几种抛法（IOException / InvalidOperationException /
    /// ObjectDisposed / OperationCanceled），在这里另写一份迟早漏掉其中一种。
    /// </summary>
    private async Task<bool> TryWriteEventAsync(string name, string data, CancellationToken ct)
    {
        try
        {
            await Response.WriteAsync($"event: {name}\ndata: {data}\n\n", ct);
            await Response.Body.FlushAsync(ct);
            return true;
        }
        catch (Exception ex) when (SseEventWriter.IsClientDisconnect(ex))
        {
            return false;
        }
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
        plannedCollections = run.PlannedCollections,
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

    private sealed record SourceProbe(string? Code, string? Error, string? SiteLabel, string? Build);

    /// <summary>
    /// 跳转前的握手。三件事：对方在不在、协议版本对不对、对外同步开没开。
    /// 探测失败一律给可执行的下一步，不给「操作失败」。
    /// </summary>
    private async Task<SourceProbe> ProbeSourceAsync(string origin, CancellationToken ct)
    {
        try
        {
            var client = _httpClientFactory.CreateClient("SafeOutbound");
            client.Timeout = TimeSpan.FromSeconds(15);
            using var response = await client.GetAsync($"{origin}/api/instance-sync/handshake", ct);
            if (!response.IsSuccessStatusCode)
            {
                return new SourceProbe("DATA_SYNC_SOURCE_UNREACHABLE",
                    $"连不上对方的同步接口（HTTP {(int)response.StatusCode}）。确认地址没写错，"
                    + "并且对方跑的是带「数据同步」功能的版本。", null, null);
            }

            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            if (!doc.RootElement.TryGetProperty("data", out var data))
            {
                return new SourceProbe("DATA_SYNC_SOURCE_UNREADABLE", "对方返回的内容读不懂，多半不是一台 MAP。", null, null);
            }

            var remoteVersion = data.TryGetProperty("protocolVersion", out var pv) && pv.TryGetInt32(out var v) ? v : -1;
            if (remoteVersion != DataSyncProviderController.ProtocolVersionForHandshake)
            {
                return new SourceProbe("DATA_SYNC_PROTOCOL_MISMATCH",
                    $"两端的同步协议版本对不上（本站 {DataSyncProviderController.ProtocolVersionForHandshake}，"
                    + $"对方 {(remoteVersion < 0 ? "未知" : remoteVersion.ToString())}）。先把两边升到同一版再同步。",
                    null, null);
            }

            var providerEnabled = data.TryGetProperty("providerEnabled", out var pe) && pe.ValueKind == JsonValueKind.True;
            var label = data.TryGetProperty("siteLabel", out var sl) ? sl.GetString() : null;
            var build = data.TryGetProperty("build", out var b) ? b.GetString() : null;
            if (!providerEnabled)
            {
                // 不拦：对方管理员可以在同意页上当场打开。这里只是把话说在前面。
                _logger.LogInformation("[data-sync] 源站 {Origin} 当前未开启对外同步，仍允许跳转由对方管理员当场决定", origin);
            }
            return new SourceProbe(null, null, label, build);
        }
        catch (Exception ex)
        {
            // 不把异常原文回给前端。DNS / TLS / 代理 / 连接建立失败的消息里可能带内网地址、
            // 证书主体名、代理主机这类只有本站该知道的东西，而它对操作者也给不出可执行的
            // 下一步。原文进日志并带上一个可对照的短 id，界面给固定文案 + 这个 id。
            var trace = Guid.NewGuid().ToString("N")[..8];
            _logger.LogWarning(ex, "[data-sync] 握手失败 trace={Trace} origin={Origin}", trace, origin);
            return new SourceProbe("DATA_SYNC_SOURCE_UNREACHABLE",
                $"连不上对方（诊断号 {trace}）。确认这个地址能在浏览器里直接打开，"
                + "并且它是一台已经部署好的 MAP。", null, null);
        }
    }

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
        // 只收 https。这里曾经给 http + loopback 开过口子，但出站一律走 SafeOutbound，
        // 而它按解析出来的地址挡掉回环段——于是 http://localhost:5001 这种地址在这道门
        // 「通过」、到握手那一步必然连不上，错误信息还完全指不到原因。两处判据必须一致：
        // 与其让它过了再炸，不如在这里就说「不支持」。
        if (uri.Scheme != Uri.UriSchemeHttps) return false;
        if (uri.IsLoopback) return false;
        // 只收站点根地址：带路径的地址意味着调用方在猜端点位置，猜错了错误信息会很难懂。
        if (uri.AbsolutePath.TrimEnd('/').Length > 0) return false;
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

    /// <summary>
    /// 解析源站清单。解析不出来必须抛，不能退回空列表——空列表会让对照表显示「0 个集合」，
    /// 而 Start 照样能按，worker 随后按 Run 里固化的集合名把每一个都同步一遍。
    /// 那等于绕过了对照表这道确认关口：人看到的是「什么都不会写」，实际全写。
    /// </summary>
    private static List<ManifestItem> ReadManifest(string json)
    {
        var items = new List<ManifestItem>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("data", out var data)
                || !data.TryGetProperty("collections", out var collections)
                || collections.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidOperationException("源站清单缺少 data.collections");
            }
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
        catch (Exception ex) when (ex is not InvalidOperationException)
        {
            throw new InvalidOperationException($"源站清单无法解析：{ex.Message}", ex);
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
