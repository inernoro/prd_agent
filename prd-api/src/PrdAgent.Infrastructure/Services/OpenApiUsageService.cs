using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// OpenApi 对外网关韧性服务（Phase 2）。Redis 抖动一律 fail-open（放行），不打断网关。
/// </summary>
public class OpenApiUsageService : IOpenApiUsageService
{
    private readonly ConnectionMultiplexer _redis;
    private readonly MongoDbContext _db;
    private readonly ILogger<OpenApiUsageService> _logger;

    private const int DefaultRatePerMin = 120;

    // 每分钟滑动窗口：移除过期 → 计数 → 未超则写入。member 用唯一值避免同毫秒覆盖。
    private const string RateScript = @"
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
        local n = redis.call('ZCARD', KEYS[1])
        if n >= tonumber(ARGV[2]) then return 0 end
        redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
        redis.call('EXPIRE', KEYS[1], 120)
        return 1";

    public OpenApiUsageService(ConnectionMultiplexer redis, MongoDbContext db, ILogger<OpenApiUsageService> logger)
    {
        _redis = redis;
        _db = db;
        _logger = logger;
    }

    private static string Day() => DateTime.UtcNow.ToString("yyyyMMdd");
    private static string ReqKey(string keyId, string day) => $"or:reqs:{keyId}:{day}";
    private static string TokKey(string keyId, string day) => $"or:tok:{keyId}:{day}";

    private static int SecondsToMidnight()
    {
        var now = DateTime.UtcNow;
        return Math.Max(1, (int)(now.Date.AddDays(1) - now).TotalSeconds);
    }

    public async Task<OpenApiUsageDecision> CheckAndReserveAsync(AgentApiKey key, CancellationToken ct = default)
    {
        try
        {
            var db = _redis.GetDatabase();
            var day = Day();

            // 1. 每日 token 配额预检（只读，超额直接拒）
            if (key.OpenApiDailyTokenQuota is long tq && tq > 0)
            {
                var v = await db.StringGetAsync(TokKey(key.Id, day));
                if (v.HasValue && (long)v >= tq)
                    return OpenApiUsageDecision.Deny("daily_token_quota_exceeded",
                        $"今日 token 配额已用尽（上限 {tq}）", SecondsToMidnight());
            }

            // 2. 每日请求配额
            if (key.OpenApiDailyRequestQuota is long rq && rq > 0)
            {
                var v = await db.StringGetAsync(ReqKey(key.Id, day));
                if (v.HasValue && (long)v >= rq)
                    return OpenApiUsageDecision.Deny("daily_request_quota_exceeded",
                        $"今日请求数配额已用尽（上限 {rq}）", SecondsToMidnight());
            }

            // 3. 每分钟速率（按 Key 桶，原子滑动窗口）
            var limit = key.OpenApiRateLimitPerMin is int r && r > 0 ? r : DefaultRatePerMin;
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var windowStart = now - 60_000;
            var member = $"{now}-{Guid.NewGuid():N}";
            var allowed = (long)await db.ScriptEvaluateAsync(RateScript,
                new RedisKey[] { $"or:rate:{key.Id}" },
                new RedisValue[] { windowStart, limit, now, member });
            if (allowed == 0)
                return OpenApiUsageDecision.Deny("rate_limit_exceeded",
                    $"超过每分钟 {limit} 次速率上限，请稍后重试", 5);

            // 4. 占用一个每日请求额度
            var reqKey = ReqKey(key.Id, day);
            await db.StringIncrementAsync(reqKey);
            await db.KeyExpireAsync(reqKey, TimeSpan.FromDays(2));

            return OpenApiUsageDecision.Allow;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[OpenApiUsage] 准入检查异常，fail-open 放行 keyId={KeyId}", key.Id);
            return OpenApiUsageDecision.Allow;
        }
    }

    public async Task RecordTokensAsync(AgentApiKey key, int tokens, CancellationToken ct = default)
    {
        if (tokens <= 0) return;
        try
        {
            var db = _redis.GetDatabase();
            var day = Day();
            var k = TokKey(key.Id, day);
            var total = await db.StringIncrementAsync(k, tokens);
            await db.KeyExpireAsync(k, TimeSpan.FromDays(2));

            if (key.OpenApiDailyTokenQuota is long tq && tq > 0)
            {
                if (total >= tq)
                    await AlertOnceAsync(key, "token-100", "warning", day,
                        $"OpenApi 配额耗尽：{key.Name}",
                        $"客户「{key.Name}」今日 token 配额 {tq} 已耗尽（已用 {total}），后续请求将被拒绝。");
                else if ((double)total / tq >= 0.8)
                    await AlertOnceAsync(key, "token-80", "info", day,
                        $"OpenApi 配额预警：{key.Name}",
                        $"客户「{key.Name}」今日 token 已用 {total}/{tq}（≥80%）。");
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[OpenApiUsage] 记录 token 异常 keyId={KeyId}", key.Id);
        }
    }

    public async Task NotifyFallbackAsync(AgentApiKey key, string? resolvedModel, string? originalPool, string? reason, CancellationToken ct = default)
    {
        await AlertOnceAsync(key, "fallback", "warning", Day(),
            $"OpenApi 专属模型降级：{key.Name}",
            $"客户「{key.Name}」的专属模型已降级（实际解析 {resolvedModel ?? "未知"}，原池 {originalPool ?? "未知"}，原因 {reason ?? "未知"}）。请检查模型池健康，避免影响该客户。");
    }

    public async Task<OpenApiUsageSnapshot> GetUsageAsync(string keyId, CancellationToken ct = default)
    {
        try
        {
            var db = _redis.GetDatabase();
            var day = Day();
            var reqs = await db.StringGetAsync(ReqKey(keyId, day));
            var tok = await db.StringGetAsync(TokKey(keyId, day));
            return new OpenApiUsageSnapshot
            {
                TodayRequests = reqs.HasValue ? (long)reqs : 0,
                TodayTokens = tok.HasValue ? (long)tok : 0
            };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[OpenApiUsage] 读取用量异常 keyId={KeyId}", keyId);
            return new OpenApiUsageSnapshot();
        }
    }

    /// <summary>按天去重发管理通知（Redis SETNX 标记；Redis 不可用则不去重仍尽量发一次）。</summary>
    private async Task AlertOnceAsync(AgentApiKey key, string type, string level, string day, string title, string message)
    {
        try
        {
            try
            {
                var db = _redis.GetDatabase();
                var first = await db.StringSetAsync($"or:alert:{type}:{key.Id}:{day}", "1", TimeSpan.FromDays(2), When.NotExists);
                if (!first) return; // 今天已发过同类预警
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[OpenApiUsage] 预警去重标记失败，继续发通知 keyId={KeyId}", key.Id);
            }

            await _db.AdminNotifications.InsertOneAsync(new AdminNotification
            {
                Title = title,
                Message = message,
                Level = level,
                Status = "open",
                Source = "open-api",
                Key = $"open-api:{type}:{key.Id}:{day}",
                ActionLabel = "查看 OpenApi 网关",
                ActionUrl = "/open-platform?tab=open-api",
                ActionKind = "navigate"
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenApiUsage] 写管理预警失败 keyId={KeyId} type={Type}", key.Id, type);
        }
    }
}
