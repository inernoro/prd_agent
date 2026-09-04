using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>知识驱动设计任务的统一入口。首版开放网页生成，HTML PPT 通过既有专用链路关联。</summary>
[ApiController]
[Route("api/design-artifacts")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class DesignArtifactsController : ControllerBase
{
    private static readonly TimeSpan RunTtl = TimeSpan.FromHours(24);
    private readonly MongoDbContext _db;
    private readonly IRunEventStore _events;
    private readonly IRunQueue _queue;
    private readonly IConfiguration _configuration;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly HashSet<string> _executorRuntimes;

    public DesignArtifactsController(
        MongoDbContext db,
        IRunEventStore events,
        IRunQueue queue,
        IConfiguration configuration,
        IHttpClientFactory httpClientFactory,
        IEnumerable<PrdAgent.Api.Services.IDesignArtifactExecutor> executors)
    {
        _db = db;
        _events = events;
        _queue = queue;
        _configuration = configuration;
        _httpClientFactory = httpClientFactory;
        _executorRuntimes = executors.Select(x => x.Runtime).ToHashSet(StringComparer.Ordinal);
    }

    [HttpGet("runtime-capabilities")]
    public async Task<IActionResult> RuntimeCapabilities()
    {
        var external = await Task.WhenAll(
            InspectRuntimeAsync(DesignArtifactRuntimes.OpenDesign, "OpenDesign", "DesignGeneration:Runtimes:OpenDesign"),
            InspectRuntimeAsync(DesignArtifactRuntimes.Codex, "Codex", "DesignGeneration:Runtimes:Codex"),
            InspectRuntimeAsync(DesignArtifactRuntimes.Claude, "Claude", "DesignGeneration:Runtimes:Claude"));
        var runtimes = new List<object>
        {
            new
            {
                id = DesignArtifactRuntimes.MapGateway,
                label = "MAP 模型",
                enabled = _executorRuntimes.Contains(DesignArtifactRuntimes.MapGateway),
                configured = true,
                healthy = true,
                operations = new[] { DesignArtifactOperations.Generate, DesignArtifactOperations.Edit },
            },
        };
        runtimes.AddRange(external);
        return Ok(ApiResponse<object>.Ok(new
        {
            defaultRuntime = DesignArtifactRuntimes.MapGateway,
            runtimes,
        }));
    }

    [HttpPost("runs")]
    public async Task<IActionResult> CreateRun([FromBody] CreateDesignArtifactRunRequest request)
    {
        var instruction = (request.Instruction ?? string.Empty).Trim();
        if (instruction.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请用两句话说明网页用途和期望效果"));
        if (instruction.Length > 4000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "设计要求不能超过 4000 个字符"));
        if (!string.Equals(request.ArtifactType, DesignArtifactTypes.WebPage, StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "当前统一入口只支持生成网页，HTML PPT 请从对应工作台生成"));

        var runtime = string.IsNullOrWhiteSpace(request.Runtime)
            ? DesignArtifactRuntimes.MapGateway
            : request.Runtime.Trim().ToLowerInvariant();
        if (runtime != DesignArtifactRuntimes.MapGateway)
            return Conflict(ApiResponse<object>.Fail(
                "RUNTIME_NOT_READY",
                "所选执行器尚未部署并通过健康检查，请先使用 MAP 模型"));

        var references = request.KnowledgeReferences ?? new List<DesignKnowledgeReferenceRequest>();
        if (references.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请至少选择一篇知识作为网页内容来源"));
        if (references.Count > 3)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "首版一次最多引用 3 篇知识"));
        if (references.Any(x => string.IsNullOrWhiteSpace(x.EntryId) || string.IsNullOrWhiteSpace(x.Content)))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "引用知识缺少条目或正文"));
        if (references.Sum(x => x.Content!.Length) > 60_000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "引用知识正文过长，请减少选择或缩短内容"));

        var sourceSurface = string.Equals(request.SourceSurface, DesignArtifactSourceSurfaces.KnowledgeBase, StringComparison.OrdinalIgnoreCase)
            ? DesignArtifactSourceSurfaces.KnowledgeBase
            : DesignArtifactSourceSurfaces.WebHosting;
        var runId = Guid.NewGuid().ToString("N");
        var userId = this.GetRequiredUserId();
        var snapshots = references.Select(x =>
        {
            var content = x.Content!.Trim();
            return new DesignKnowledgeSnapshot
            {
                EntryId = x.EntryId!.Trim(),
                StoreId = TrimOptional(x.StoreId, 120),
                StoreName = TrimOptional(x.StoreName, 200),
                Title = TrimTitle(x.Title),
                Content = content,
                ContentHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant(),
            };
        }).ToList();
        var run = new DesignArtifactRun
        {
            Id = runId,
            UserId = userId,
            Status = RunStatuses.Queued,
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Generate,
            SourceSurface = sourceSurface,
            Runtime = runtime,
            Instruction = instruction,
            Title = TrimOptional(request.Title, 200) ?? snapshots[0].Title,
            KnowledgeReferences = snapshots,
            Progress = 2,
            Phase = "网页生成任务已进入队列",
        };
        await _db.DesignArtifactRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);

        var meta = new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.DesignArtifact,
            Status = RunStatuses.Queued,
            CreatedByUserId = userId,
            CreatedAt = DateTime.UtcNow,
            InputJson = JsonSerializer.Serialize(new { sourceSurface }),
        };
        await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
        await _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            runId,
            "phase",
            new { progress = 2, message = run.Phase },
            RunTtl,
            CancellationToken.None);
        await _queue.EnqueueAsync(RunKinds.DesignArtifact, runId, CancellationToken.None);
        return Accepted(ApiResponse<object>.Ok(ToDto(run)));
    }

    [HttpGet("runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId)
    {
        var run = await _db.DesignArtifactRuns
            .Find(x => x.Id == runId && x.UserId == this.GetRequiredUserId())
            .FirstOrDefaultAsync(CancellationToken.None);
        return run == null
            ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "设计任务不存在"))
            : Ok(ApiResponse<object>.Ok(ToDto(run)));
    }

    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamRun(string runId, [FromQuery] long afterSeq = 0, CancellationToken ct = default)
    {
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";

        var meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, ct);
        if (meta == null || meta.CreatedByUserId != this.GetRequiredUserId())
        {
            await WriteEventAsync(null, "error", JsonSerializer.Serialize(new
            {
                code = ErrorCodes.NOT_FOUND,
                message = "设计任务不存在",
            }), ct);
            return;
        }

        var cursor = Math.Max(0, afterSeq);
        var idleRounds = 0;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var batch = await _events.GetEventsAsync(RunKinds.DesignArtifact, runId, cursor, 100, ct);
                foreach (var item in batch)
                {
                    await WriteEventAsync(item.Seq, item.EventName, item.PayloadJson, ct);
                    cursor = item.Seq;
                }
                if (batch.Count > 0)
                {
                    idleRounds = 0;
                    continue;
                }

                meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, ct);
                if (meta == null || meta.Status is RunStatuses.Done or RunStatuses.Error or RunStatuses.Cancelled)
                    return;

                idleRounds++;
                if (idleRounds % 20 == 0)
                {
                    await Response.WriteAsync(": keepalive\n\n", ct);
                    await Response.Body.FlushAsync(ct);
                }
                await Task.Delay(500, ct);
            }
        }
        catch (OperationCanceledException)
        {
            // 浏览器断开只结束观察，不取消后台任务。
        }
        catch (ObjectDisposedException)
        {
            // 响应已关闭，后台任务仍继续。
        }
    }

    private async Task<object> InspectRuntimeAsync(string id, string label, string configKey)
    {
        Uri? baseUri = null;
        var configured = _configuration.GetValue<bool>($"{configKey}:Enabled")
                         && Uri.TryCreate(_configuration[$"{configKey}:BaseUrl"], UriKind.Absolute, out baseUri);
        if (!configured)
        {
            return new
            {
                id,
                label,
                enabled = false,
                configured = false,
                healthy = false,
                operations = Array.Empty<string>(),
                reason = "CDS 中尚未配置该执行器运行时",
            };
        }

        var healthy = false;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var client = _httpClientFactory.CreateClient();
            using var response = await client.GetAsync(new Uri(baseUri!, "health"), timeout.Token);
            healthy = response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            healthy = false;
        }

        var hasAdapter = _executorRuntimes.Contains(id);
        return new
        {
            id,
            label,
            enabled = healthy && hasAdapter,
            configured = true,
            healthy,
            operations = healthy && hasAdapter
                ? new[] { DesignArtifactOperations.Generate, DesignArtifactOperations.Edit }
                : Array.Empty<string>(),
            reason = !healthy
                ? "运行时已配置但健康检查未通过"
                : hasAdapter
                    ? null
                    : "运行时已探测到，但 MAP 适配器尚未安装，不能参与本次生成",
        };
    }

    private static object ToDto(DesignArtifactRun run) => new
    {
        runId = run.Id,
        run.Status,
        run.ArtifactType,
        run.Operation,
        run.SourceSurface,
        run.Runtime,
        run.Title,
        run.Progress,
        run.Phase,
        run.ArtifactSiteId,
        run.ArtifactRevisionId,
        run.LinkedRunId,
        run.Error,
        knowledgeReferences = run.KnowledgeReferences.Select(x => new
        {
            x.EntryId,
            x.StoreId,
            x.StoreName,
            x.Title,
            x.ContentHash,
        }),
        run.CreatedAt,
        run.UpdatedAt,
        run.CompletedAt,
    };

    private static string TrimTitle(string? value)
    {
        var title = string.IsNullOrWhiteSpace(value) ? "未命名知识" : value.Trim();
        return title.Length <= 200 ? title : title[..200];
    }

    private static string? TrimOptional(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    private async Task WriteEventAsync(long? id, string eventName, string json, CancellationToken ct)
    {
        if (id.HasValue) await Response.WriteAsync($"id: {id.Value}\n", ct);
        await Response.WriteAsync($"event: {eventName}\n", ct);
        foreach (var line in json.Replace("\r", string.Empty).Split('\n'))
            await Response.WriteAsync($"data: {line}\n", ct);
        await Response.WriteAsync("\n", ct);
        await Response.Body.FlushAsync(ct);
    }
}

public sealed class CreateDesignArtifactRunRequest
{
    public string? ArtifactType { get; set; }
    public string? SourceSurface { get; set; }
    public string? Runtime { get; set; }
    public string? Instruction { get; set; }
    public string? Title { get; set; }
    public List<DesignKnowledgeReferenceRequest>? KnowledgeReferences { get; set; }
}

public sealed class DesignKnowledgeReferenceRequest
{
    public string? EntryId { get; set; }
    public string? StoreId { get; set; }
    public string? StoreName { get; set; }
    public string? Title { get; set; }
    public string? Content { get; set; }
}
