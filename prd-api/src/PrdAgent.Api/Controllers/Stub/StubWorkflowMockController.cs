using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

namespace PrdAgent.Api.Controllers.Stub;

/// <summary>
/// 工作流自测 Mock 端点 —— 供大全套验收模板使用。
/// 所有端点无需认证，路径前缀 /api/v1/stub/workflow-mock/
///
/// 端点列表：
/// - GET  /echo?msg=xxx              → 原样返回 msg（测试 http-request 基本连通）
/// - GET  /delay?ms=2000             → 延迟指定毫秒后返回（测试并行时间节省）
/// - GET  /random-data?count=10      → 返回 N 条随机数据（测试数据流 + 合并）
/// - GET  /error-once?key=xxx        → 第一次调用返回 500，第二次返回 200（测试重试）
/// - GET  /counter?key=xxx           → 原子计数器，返回调用次数（验证并行执行确实发生）
/// - POST /validate                  → 校验请求体中的 expected 字段（测试条件分支 + 数据校验）
/// </summary>
[ApiController]
[Route("api/v1/stub/workflow-mock")]
public class StubWorkflowMockController : ControllerBase
{
    // error-once: key → 是否已经失败过一次
    private static readonly ConcurrentDictionary<string, bool> _errorOnceTracker = new();

    // counter: key → 调用次数
    private static readonly ConcurrentDictionary<string, int> _counters = new();

    /// <summary>
    /// Echo — 原样返回消息，附带时间戳和服务端信息。
    /// 用于测试 http-request 舱基本连通性。
    /// </summary>
    [HttpGet("echo")]
    public IActionResult Echo([FromQuery] string msg = "hello", [FromQuery] string? tag = null)
    {
        return Ok(new
        {
            message = msg,
            tag,
            echoedAt = DateTime.UtcNow.ToString("O"),
            source = "stub-workflow-mock",
        });
    }

    /// <summary>
    /// Delay — 延迟指定毫秒后返回。
    /// 用于测试并行执行时间节省（如 3 个 1s 的 delay 并行 → 总共约 1s 而非 3s）。
    /// </summary>
    [HttpGet("delay")]
    public async Task<IActionResult> Delay([FromQuery] int ms = 1000, [FromQuery] string? label = null)
    {
        ms = Math.Clamp(ms, 0, 30000); // 最大 30s
        var startedAt = DateTime.UtcNow;
        await Task.Delay(ms);
        return Ok(new
        {
            label,
            delayMs = ms,
            startedAt = startedAt.ToString("O"),
            completedAt = DateTime.UtcNow.ToString("O"),
            actualMs = (DateTime.UtcNow - startedAt).TotalMilliseconds,
        });
    }

    /// <summary>
    /// Random Data — 返回 N 条带有不同字段的模拟数据。
    /// 用于测试数据流、合并舱、脚本统计。
    /// </summary>
    [HttpGet("random-data")]
    public IActionResult RandomData(
        [FromQuery] int count = 10,
        [FromQuery] string? category = null,
        [FromQuery] string? prefix = null)
    {
        count = Math.Clamp(count, 1, 1000);
        var rng = new Random();
        var categories = new[] { "alpha", "beta", "gamma", "delta" };
        var statuses = new[] { "active", "pending", "completed", "cancelled" };
        var priorities = new[] { "high", "medium", "low" };

        var items = Enumerable.Range(1, count).Select(i => new
        {
            id = $"{prefix ?? "item"}-{i:D4}",
            name = $"Record #{i}",
            category = category ?? categories[rng.Next(categories.Length)],
            status = statuses[rng.Next(statuses.Length)],
            priority = priorities[rng.Next(priorities.Length)],
            value = rng.Next(1, 100),
            createdAt = DateTime.UtcNow.AddDays(-rng.Next(0, 30)).ToString("yyyy-MM-dd"),
        }).ToList();

        return Ok(new
        {
            items,
            meta = new { total = count, generatedAt = DateTime.UtcNow.ToString("O") },
        });
    }

    /// <summary>
    /// Error Once — 第一次调用返回 500，之后返回 200。
    /// 用于测试重试（Retry）机制。每个 key 独立追踪。
    /// </summary>
    [HttpGet("error-once")]
    public IActionResult ErrorOnce([FromQuery] string key = "default")
    {
        var alreadyFailed = _errorOnceTracker.GetOrAdd(key, false);
        if (!alreadyFailed)
        {
            _errorOnceTracker[key] = true;
            return StatusCode(500, new
            {
                error = "TRANSIENT_ERROR",
                message = $"模拟瞬态错误 (key={key})，重试一次即可成功",
                key,
                attempt = 1,
            });
        }

        return Ok(new
        {
            success = true,
            message = $"重试成功 (key={key})",
            key,
            recoveredAt = DateTime.UtcNow.ToString("O"),
        });
    }

    /// <summary>
    /// Counter — 原子计数器，每次调用 +1 并返回当前计数。
    /// 用于验证并行执行确实同时发生（多个并行分支各调用一次 → 计数等于分支数）。
    /// </summary>
    [HttpGet("counter")]
    public IActionResult Counter([FromQuery] string key = "default")
    {
        var count = _counters.AddOrUpdate(key, 1, (_, old) => old + 1);
        return Ok(new
        {
            key,
            count,
            timestamp = DateTime.UtcNow.ToString("O"),
        });
    }

    /// <summary>
    /// Counter Reset — 重置指定计数器（方便多次验收）。
    /// </summary>
    [HttpDelete("counter")]
    public IActionResult CounterReset([FromQuery] string key = "default")
    {
        _counters.TryRemove(key, out var old);
        _errorOnceTracker.TryRemove(key, out _);
        return Ok(new { key, previousCount = old, reset = true });
    }

    /// <summary>
    /// Validate — 校验请求体中的条件。
    /// 用于测试条件分支舱：发送数据 → 返回校验结果 → 后续条件判断。
    /// </summary>
    [HttpPost("validate")]
    public IActionResult Validate([FromBody] JsonElement body)
    {
        var totalItems = 0;
        var hasRequiredFields = true;
        var errors = new List<string>();

        if (body.TryGetProperty("totalItems", out var ti))
            totalItems = ti.GetInt32();

        if (body.TryGetProperty("requiredFields", out var rf) && rf.ValueKind == JsonValueKind.Array)
        {
            foreach (var field in rf.EnumerateArray())
            {
                var fieldName = field.GetString() ?? "";
                if (!body.TryGetProperty(fieldName, out _))
                {
                    hasRequiredFields = false;
                    errors.Add($"缺少必填字段: {fieldName}");
                }
            }
        }

        var isValid = totalItems > 0 && hasRequiredFields && errors.Count == 0;
        return Ok(new
        {
            valid = isValid,
            status = isValid ? "pass" : "fail",
            totalItems,
            hasRequiredFields,
            errors,
            validatedAt = DateTime.UtcNow.ToString("O"),
        });
    }
}
