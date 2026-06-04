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

    // 单条原子准入：每日请求配额 + 每分钟滑动窗口合并到一个 Lua 脚本，整体原子提交。
    //   KEYS[1]=速率 ZSET (or:rate)  KEYS[2]=每日请求计数 (or:reqs:{day})
    //   ARGV: [1]=windowStart(ms) [2]=速率上限/min [3]=now(ms) [4]=member [5]=每日请求配额(0=不限) [6]=每日 key TTL 秒
    //   返回 {decision, rateCount, dailyCount}，decision: 0 放行 / 1 速率超限 / 2 每日请求超限
    // 设计要点（对应 PR#732 review）：
    //   - 日配额走 INCR-then-check，消除"读-判-写"竞态；且排在速率窗口前，日配额拒绝不写 rate ZSET（不占速率槽）
    //   - 速率拒绝时在同一脚本内 DECR 回滚日配额（请求未放行）
    //   - 整脚本原子：要么全提交要么不执行，不存在"INCR 了却没回滚"的悬挂状态，故 fail-open 无需补偿
    private const string AdmitScript = @"
        local dq = tonumber(ARGV[5])
        local dcount = redis.call('INCR', KEYS[2])
        redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
        if dq > 0 and dcount > dq then
            redis.call('DECR', KEYS[2])
            return {2, 0, dcount - 1}
        end
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
        local rn = redis.call('ZCARD', KEYS[1])
        if rn >= tonumber(ARGV[2]) then
            redis.call('DECR', KEYS[2])
            return {1, rn, dcount - 1}
        end
        redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
        redis.call('EXPIRE', KEYS[1], 120)
        return {0, rn + 1, dcount}";

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
            var limit = key.OpenApiRateLimitPerMin is int r && r > 0 ? r : DefaultRatePerMin;

            // 1. 每日 token 配额预检（只读，超额直接拒）
            if (key.OpenApiDailyTokenQuota is long tq && tq > 0)
            {
                var v = await db.StringGetAsync(TokKey(key.Id, day));
                if (v.HasValue && (long)v >= tq)
                    return OpenApiUsageDecision.Deny("daily_token_quota_exceeded",
                        $"今日 token 配额已用尽（上限 {tq}）", SecondsToMidnight(), limit);
            }

            // 2. 速率 + 每日请求配额：单条 Lua 原子准入（见 AdmitScript 注释）。
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var quota = key.OpenApiDailyRequestQuota is long rq && rq > 0 ? rq : 0L;
            var member = $"{now}-{Guid.NewGuid():N}";
            var res = (RedisValue[])(await db.ScriptEvaluateAsync(AdmitScript,
                new RedisKey[] { $"or:rate:{key.Id}", ReqKey(key.Id, day) },
                new RedisValue[] { now - 60_000, limit, now, member, quota, (long)TimeSpan.FromDays(2).TotalSeconds }))!;
            var decision = (int)res[0];
            var rateCount = (int)res[1];

            if (decision == 2)
                return OpenApiUsageDecision.Deny("daily_request_quota_exceeded",
                    $"今日请求数配额已用尽（上限 {quota}）", SecondsToMidnight(), limit);
            if (decision == 1)
                return OpenApiUsageDecision.Deny("rate_limit_exceeded",
                    $"超过每分钟 {limit} 次速率上限，请稍后重试", 5, limit);

            return OpenApiUsageDecision.Allow(limit, Math.Max(0, limit - rateCount));
        }
        catch (Exception ex)
        {
            // Redis 抖动 fail-open 放行。AdmitScript 原子提交，此处不存在半提交的日配额需回滚。
            _logger.LogWarning(ex, "[OpenApiUsage] 准入检查异常，fail-open 放行 keyId={KeyId}", key.Id);
            return OpenApiUsageDecision.Allow(0, 0);
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
