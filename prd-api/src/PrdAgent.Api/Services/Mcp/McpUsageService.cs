using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.Mcp;

/// <summary>闸门结论。放行时带上占了多少坑，调用失败要按这个退还。</summary>
public sealed record McpQuotaVerdict(bool Allowed, string? Reason, string? ReservedKind = null, int ReservedAmount = 0)
{
    public static readonly McpQuotaVerdict Ok = new(true, null);
    public static McpQuotaVerdict Reserved(string kind, int amount) => new(true, null, kind, amount);
    public static McpQuotaVerdict Deny(string reason) => new(false, reason);
}

/// <summary>
/// 接入台的用量闸门与调用记录。
///
/// 闸门管三件事，都是「智能体跑飞了会撞上、人正常用撞不上」的量级：
///   - 每日生图张数（默认 50）：生图直接烧模型额度，没有上限时一个循环就能把一天烧光
///   - 每日写入次数（默认 200）：建站、写文档这类会留下东西的动作
///   - 每分钟调用次数（默认 60）：挡住重试风暴
///
/// 三个上限都能按密钥单独调（AgentApiKey.Mcp* 字段），空值走默认。
///
/// 日额度是**先原子占坑、失败再退还**，不是「查历史再放行」：后者在并发下每个请求都读到
/// 同一个旧值，一把 50 张的密钥能同时放行上百个生图，闸门等于没有。占坑走 McpUsageCounter
/// 的 $inc + upsert，一次操作拿到新值，超了就把自己那份退回去。
///
/// 日界按 UTC 自然日切 —— 与记录里的 CreatedAt 同一把尺子；用户看到的「今日」也按这个口径，
/// 面板上要写明白，别让人以为是本地零点。
///
/// 速率窗口是**进程内**的：多实例部署时每个实例各算各的。这不是漏洞是取舍 ——
/// 日额度走 Mongo（跨实例准确），分钟级只为挡住失控循环，不值得为它引入分布式计数。
/// </summary>
public sealed class McpUsageService
{
    public const int DefaultDailyImageQuota = 50;
    public const int DefaultDailyWriteQuota = 200;
    public const int DefaultRateLimitPerMin = 60;

    public const string KindImage = "image";
    public const string KindWrite = "write";

    private readonly MongoDbContext _db;
    private readonly ILogger<McpUsageService> _logger;

    /// <summary>keyId → (当前分钟起点, 该分钟内已调用次数)</summary>
    private static readonly ConcurrentDictionary<string, (DateTime MinuteStart, int Count)> RateWindows = new();

    public McpUsageService(MongoDbContext db, ILogger<McpUsageService> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>某工具算不算「写入类动作」：判据取自工具定义本身的 HTTP 方法，不另维护一张名单。</summary>
    public static bool IsWriteTool(McpToolDef tool) =>
        !string.Equals(tool.Method, "GET", StringComparison.OrdinalIgnoreCase);

    public static bool IsImageTool(McpToolDef tool) =>
        string.Equals(tool.Name, "map_visual_generate_image", StringComparison.Ordinal);

    public static DateTime TodayStartUtc() => DateTime.UtcNow.Date;

    /// <summary>
    /// 调用前的闸门：过速率窗口，再为日额度原子占坑。
    /// 返回不允许时，Reason 是直接给智能体看的中文说明（它会转述给用户）。
    /// 放行时若占了坑，调用失败要用 <see cref="ReleaseAsync"/> 退还。
    /// </summary>
    public async Task<McpQuotaVerdict> CheckAsync(string keyId, McpToolDef? tool, int imageCount, CancellationToken ct)
    {
        var key = await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);
        var ratePerMin = key?.McpRateLimitPerMin ?? DefaultRateLimitPerMin;

        // 1. 分钟级速率（进程内）
        var now = DateTime.UtcNow;
        var minute = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0, DateTimeKind.Utc);
        var window = RateWindows.AddOrUpdate(keyId,
            _ => (minute, 1),
            (_, cur) => cur.MinuteStart == minute ? (minute, cur.Count + 1) : (minute, 1));
        if (window.Count > ratePerMin)
            return McpQuotaVerdict.Deny($"调用太频繁：这把密钥每分钟最多 {ratePerMin} 次工具调用，请等一分钟再试。");

        if (tool == null) return McpQuotaVerdict.Ok;

        // 2. 日额度：原子占坑
        if (IsImageTool(tool))
        {
            var quota = key?.McpDailyImageQuota ?? DefaultDailyImageQuota;
            var amount = Math.Max(imageCount, 1);
            var (ok, used) = await TryReserveAsync(keyId, KindImage, amount, quota, ct);
            if (!ok)
                return McpQuotaVerdict.Deny(
                    $"今天的生图额度用完了（已用 {used}/{quota} 张，按 UTC 自然日计）。可以在密钥管理里把这把密钥的上限调高，或者明天再来。");
            return McpQuotaVerdict.Reserved(KindImage, amount);
        }

        if (IsWriteTool(tool))
        {
            var quota = key?.McpDailyWriteQuota ?? DefaultDailyWriteQuota;
            var (ok, used) = await TryReserveAsync(keyId, KindWrite, 1, quota, ct);
            if (!ok)
                return McpQuotaVerdict.Deny(
                    $"今天的写入额度用完了（已用 {used}/{quota} 次，按 UTC 自然日计）。可以在密钥管理里把这把密钥的上限调高。");
            return McpQuotaVerdict.Reserved(KindWrite, 1);
        }

        return McpQuotaVerdict.Ok;
    }

    /// <summary>原子占坑：$inc + upsert 一次拿到新值；超限就把自己那份退回去。</summary>
    private async Task<(bool Ok, int Used)> TryReserveAsync(string keyId, string kind, int amount, int quota, CancellationToken ct)
    {
        var day = TodayStartUtc();
        var id = BuildCounterId(keyId, day, kind);
        var update = Builders<McpUsageCounter>.Update
            .Inc(x => x.Count, amount)
            .Set(x => x.UpdatedAt, DateTime.UtcNow)
            .SetOnInsert(x => x.KeyId, keyId)
            .SetOnInsert(x => x.Kind, kind)
            .SetOnInsert(x => x.DayUtc, day);

        var after = await _db.McpUsageCounters.FindOneAndUpdateAsync<McpUsageCounter>(
            x => x.Id == id,
            update,
            new FindOneAndUpdateOptions<McpUsageCounter, McpUsageCounter>
            {
                IsUpsert = true,
                ReturnDocument = ReturnDocument.After,
            },
            ct);

        var used = after?.Count ?? amount;
        if (used <= quota) return (true, used);

        // 超了：退还自己占的这份，返回「占坑前已用多少」给文案用
        await ReleaseAsync(keyId, kind, amount, ct);
        return (false, Math.Max(used - amount, 0));
    }

    /// <summary>退还占坑（调用没真的发生时）。退到负数没有意义，这里只做减法，读的时候按下限 0 取。</summary>
    public async Task ReleaseAsync(string keyId, string kind, int amount, CancellationToken ct)
    {
        if (amount <= 0 || string.IsNullOrEmpty(kind)) return;
        try
        {
            var id = BuildCounterId(keyId, TodayStartUtc(), kind);
            await _db.McpUsageCounters.UpdateOneAsync(
                x => x.Id == id,
                Builders<McpUsageCounter>.Update.Inc(x => x.Count, -amount).Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
        }
        catch (Exception ex)
        {
            // 退不回去只会让今天的额度偏紧，绝不能因此把已经跑完的调用报成失败
            _logger.LogWarning(ex, "[mcp] 退还配额失败 key={KeyId} kind={Kind} amount={Amount}", keyId, kind, amount);
        }
    }

    /// <summary>今日已用（面板展示口径与闸门同源，读的是同一份计数器）。</summary>
    public async Task<(int Images, int Writes)> GetTodayUsageAsync(string keyId, CancellationToken ct)
    {
        var day = TodayStartUtc();
        var ids = new[] { BuildCounterId(keyId, day, KindImage), BuildCounterId(keyId, day, KindWrite) };
        var docs = await _db.McpUsageCounters.Find(Builders<McpUsageCounter>.Filter.In(x => x.Id, ids)).ToListAsync(ct);
        var images = docs.FirstOrDefault(d => d.Kind == KindImage)?.Count ?? 0;
        var writes = docs.FirstOrDefault(d => d.Kind == KindWrite)?.Count ?? 0;
        return (Math.Max(images, 0), Math.Max(writes, 0));
    }

    internal static string BuildCounterId(string keyId, DateTime dayUtc, string kind)
        => $"{keyId}:{dayUtc:yyyyMMdd}:{kind}";

    /// <summary>写一条调用记录。记录失败绝不影响工具调用本身 —— 记账坏了不能把业务打挂。</summary>
    public async Task LogAsync(McpCallLog log, CancellationToken ct)
    {
        try
        {
            log.DeploymentSlug = DeploymentScope.Current;
            await _db.McpCallLogs.InsertOneAsync(log, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[mcp] 写调用记录失败 tool={Tool} key={KeyId}", log.ToolName, log.KeyId);
        }
    }

    /// <summary>入参摘要：够用户看懂它当时要干什么，又不至于把整篇正文存进记录。</summary>
    public static string? SummarizeArguments(JsonObject? args)
    {
        if (args == null || args.Count == 0) return null;
        var parts = new List<string>();
        foreach (var kv in args)
        {
            var v = kv.Value?.ToJsonString() ?? "null";
            if (v.Length > 120) v = v[..120] + "…";
            parts.Add($"{kv.Key}={v}");
            if (parts.Count >= 6) break;
        }
        var text = string.Join(" · ", parts);
        return text.Length > 600 ? text[..600] + "…" : text;
    }
}
