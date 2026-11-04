using MongoDB.Driver;

namespace PrdAgent.Api.Services;

/// <summary>VOC query-budget failures have the same recoverable meaning for HTTP and SSE clients.</summary>
public static class TeamActivityQueryTimeout
{
    public const string Code = "VOC_QUERY_TIMEOUT";
    public const string Message = "查询超时，请缩短时间范围后重试";

    public static bool IsTimeout(MongoException exception) =>
        exception is MongoExecutionTimeoutException or MongoCommandException { Code: 50 };

    public static Task SendSseErrorAsync(Func<string, object?, Task> send) =>
        send("error", new { code = Code, message = Message });

    public static async Task<DateTime> ReadTrackingStartAsync(
        TeamActivityQueryCache<DateTime> cache, Func<Task<DateTime>> read, Action<MongoException> logTimeout)
    {
        try { return await cache.GetAsync("tracking-start", read); }
        catch (MongoException ex) when (IsTimeout(ex))
        {
            // Degrade outside the cache so a timeout is evicted and the next request can recover.
            logTimeout(ex);
            return default;
        }
    }
}
