using MongoDB.Driver;
using PrdAgent.Core.Models;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// API 请求日志两阶段存储测试
/// 
/// 测试场景：
/// 1. 快速请求：完整插入先完成，预插入应被忽略
/// 2. 慢速请求：预插入先完成，完整插入应更新记录
/// 3. 并发场景：预插入和完整插入同时执行
/// 4. 数据完整性验证
/// 
/// 运行前确保本地 MongoDB 运行：
///   docker run -d -p 27017:27017 --name mongo-test mongo:6
/// 
/// 运行命令（不触发 CI）：
///   dotnet test tests/PrdAgent.Tests --filter "Category=Manual" --no-build -v n
/// </summary>
[Trait("Category", "Manual")]
public class ApiRequestLogTwoPhaseStorageTests : IAsyncLifetime
{
    private readonly ITestOutputHelper _output;
    private readonly IMongoCollection<ApiRequestLog> _collection;
    private readonly string _testDbName = $"prdagent_test_{Guid.NewGuid():N}";

    public ApiRequestLogTwoPhaseStorageTests(ITestOutputHelper output)
    {
        _output = output;
        
        // 连接本地 MongoDB
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") 
            ?? "mongodb://localhost:27017";
        var client = new MongoClient(connectionString);
        var database = client.GetDatabase(_testDbName);
        _collection = database.GetCollection<ApiRequestLog>("api_request_logs");
    }

    public async Task InitializeAsync()
    {
        // 确保集合为空
        await _collection.DeleteManyAsync(Builders<ApiRequestLog>.Filter.Empty);
        _output.WriteLine($"Test database: {_testDbName}");
    }

    public async Task DisposeAsync()
    {
        // 清理测试数据
        var client = new MongoClient("mongodb://localhost:27017");
        await client.DropDatabaseAsync(_testDbName);
        _output.WriteLine($"Dropped test database: {_testDbName}");
    }

    /// <summary>
    /// 模拟预插入：插入 status=running 的记录
    /// </summary>
    private async Task<bool> SimulatePreInsert(string logId, string requestId, DateTime startedAt)
    {
        try
        {
            var log = new ApiRequestLog
            {
                Id = logId,
                RequestId = requestId,
                StartedAt = startedAt,
                EndedAt = null,
                DurationMs = null,
                Method = "POST",
                Path = "/api/test",
                StatusCode = 0,
                Status = "running",
                Direction = "inbound",
                UserId = "test-user"
            };
            await _collection.InsertOneAsync(log);
            return true;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return false; // 重复键，说明完整插入先完成了
        }
    }

    /// <summary>
    /// 模拟完整插入：upsert 完整记录
    /// </summary>
    private async Task SimulateCompleteInsert(string logId, string requestId, DateTime startedAt, DateTime endedAt, long durationMs)
    {
        var log = new ApiRequestLog
        {
            Id = logId,
            RequestId = requestId,
            StartedAt = startedAt,
            EndedAt = endedAt,
            DurationMs = durationMs,
            Method = "POST",
            Path = "/api/test",
            StatusCode = 200,
            Status = "completed",
            Direction = "inbound",
            UserId = "test-user",
            ResponseBody = "{\"success\":true}",
            ResponseBodyBytes = 18
        };

        await _collection.ReplaceOneAsync(
            x => x.Id == logId,
            log,
            new ReplaceOptions { IsUpsert = true });
    }

    [Fact]
    public async Task Scenario1_FastRequest_CompleteFirstThenPreInsert()
    {
        // 场景1：快速请求，完整插入先完成，预插入后执行应被忽略
        var logId = Guid.NewGuid().ToString("N");
        var requestId = "req-fast-001";
        var startedAt = DateTime.UtcNow;
        var endedAt = startedAt.AddMilliseconds(50);

        _output.WriteLine($"Test: Fast request - complete first, then pre-insert");
        _output.WriteLine($"LogId: {logId}");

        // 1. 完整插入先执行
        await SimulateCompleteInsert(logId, requestId, startedAt, endedAt, 50);
        _output.WriteLine("Complete insert executed");

        // 2. 预插入后执行（应失败，因为 Id 已存在）
        var preInsertSuccess = await SimulatePreInsert(logId, requestId, startedAt);
        _output.WriteLine($"Pre-insert result: {(preInsertSuccess ? "inserted" : "skipped (duplicate)")}");

        Assert.False(preInsertSuccess, "Pre-insert should be skipped when complete insert already done");

        // 3. 验证数据完整性
        var log = await _collection.Find(x => x.Id == logId).FirstOrDefaultAsync();
        Assert.NotNull(log);
        Assert.Equal("completed", log.Status);
        Assert.Equal(200, log.StatusCode);
        Assert.Equal(50, log.DurationMs);
        Assert.NotNull(log.EndedAt);
        Assert.NotNull(log.ResponseBody);

        _output.WriteLine($"Final status: {log.Status}, statusCode: {log.StatusCode}, durationMs: {log.DurationMs}");
        _output.WriteLine("PASS: Data integrity verified - complete insert was NOT overwritten");
    }

    [Fact]
    public async Task Scenario2_SlowRequest_PreInsertFirstThenComplete()
    {
        // 场景2：慢速请求，预插入先完成，完整插入后更新
        var logId = Guid.NewGuid().ToString("N");
        var requestId = "req-slow-001";
        var startedAt = DateTime.UtcNow;

        _output.WriteLine($"Test: Slow request - pre-insert first, then complete");
        _output.WriteLine($"LogId: {logId}");

        // 1. 预插入先执行
        var preInsertSuccess = await SimulatePreInsert(logId, requestId, startedAt);
        _output.WriteLine($"Pre-insert result: {(preInsertSuccess ? "inserted" : "skipped")}");
        Assert.True(preInsertSuccess, "Pre-insert should succeed");

        // 验证预插入状态
        var preLog = await _collection.Find(x => x.Id == logId).FirstOrDefaultAsync();
        Assert.NotNull(preLog);
        Assert.Equal("running", preLog.Status);
        Assert.Equal(0, preLog.StatusCode);
        Assert.Null(preLog.EndedAt);
        Assert.Null(preLog.DurationMs);
        _output.WriteLine($"After pre-insert: status={preLog.Status}, statusCode={preLog.StatusCode}");

        // 2. 完整插入后执行（应覆盖预插入）
        var endedAt = startedAt.AddSeconds(5);
        await SimulateCompleteInsert(logId, requestId, startedAt, endedAt, 5000);
        _output.WriteLine("Complete insert executed (upsert)");

        // 3. 验证数据被更新
        var finalLog = await _collection.Find(x => x.Id == logId).FirstOrDefaultAsync();
        Assert.NotNull(finalLog);
        Assert.Equal("completed", finalLog.Status);
        Assert.Equal(200, finalLog.StatusCode);
        Assert.Equal(5000, finalLog.DurationMs);
        Assert.NotNull(finalLog.EndedAt);
        Assert.NotNull(finalLog.ResponseBody);

        _output.WriteLine($"Final status: {finalLog.Status}, statusCode: {finalLog.StatusCode}, durationMs: {finalLog.DurationMs}");
        _output.WriteLine("PASS: Data integrity verified - pre-insert was correctly updated");
    }

    [Fact]
    public async Task Scenario3_ConcurrentInserts_DataIntegrity()
    {
        // 场景3：并发插入，验证最终数据完整性
        var logId = Guid.NewGuid().ToString("N");
        var requestId = "req-concurrent-001";
        var startedAt = DateTime.UtcNow;
        var endedAt = startedAt.AddMilliseconds(100);

        _output.WriteLine($"Test: Concurrent inserts - both execute simultaneously");
        _output.WriteLine($"LogId: {logId}");

        // 并发执行预插入和完整插入
        var preInsertTask = Task.Run(() => SimulatePreInsert(logId, requestId, startedAt));
        var completeTask = Task.Run(() => SimulateCompleteInsert(logId, requestId, startedAt, endedAt, 100));

        await Task.WhenAll(preInsertTask, completeTask);

        var preInsertSuccess = await preInsertTask;
        _output.WriteLine($"Pre-insert result: {(preInsertSuccess ? "inserted" : "skipped")}");
        _output.WriteLine("Complete insert executed");

        // 验证最终状态：无论谁先执行，最终应该是完整数据
        var log = await _collection.Find(x => x.Id == logId).FirstOrDefaultAsync();
        Assert.NotNull(log);
        Assert.Equal("completed", log.Status);
        Assert.Equal(200, log.StatusCode);
        Assert.Equal(100, log.DurationMs);
        Assert.NotNull(log.EndedAt);

        _output.WriteLine($"Final status: {log.Status}, statusCode: {log.StatusCode}, durationMs: {log.DurationMs}");
        _output.WriteLine("PASS: Data integrity verified - final state is complete regardless of execution order");
    }

    [Fact]
    public async Task Scenario4_MultipleRequests_NoDataMixup()
    {
        // 场景4：多个请求同时处理，验证数据不会混淆
        var requests = Enumerable.Range(1, 10).Select(i => new
        {
            LogId = Guid.NewGuid().ToString("N"),
            RequestId = $"req-multi-{i:000}",
            Duration = i * 100
        }).ToList();

        _output.WriteLine($"Test: Multiple requests ({requests.Count}) - no data mixup");

        var tasks = requests.Select(async req =>
        {
            var startedAt = DateTime.UtcNow;
            
            // 模拟不同的执行顺序
            if (req.Duration % 200 == 0)
            {
                // 偶数：预插入先
                await SimulatePreInsert(req.LogId, req.RequestId, startedAt);
                await Task.Delay(10);
                await SimulateCompleteInsert(req.LogId, req.RequestId, startedAt, startedAt.AddMilliseconds(req.Duration), req.Duration);
            }
            else
            {
                // 奇数：完整插入先
                await SimulateCompleteInsert(req.LogId, req.RequestId, startedAt, startedAt.AddMilliseconds(req.Duration), req.Duration);
                await SimulatePreInsert(req.LogId, req.RequestId, startedAt);
            }
        });

        await Task.WhenAll(tasks);

        // 验证每个请求的数据完整性
        foreach (var req in requests)
        {
            var log = await _collection.Find(x => x.Id == req.LogId).FirstOrDefaultAsync();
            Assert.NotNull(log);
            Assert.Equal(req.RequestId, log.RequestId);
            Assert.Equal("completed", log.Status);
            Assert.Equal(200, log.StatusCode);
            Assert.Equal(req.Duration, log.DurationMs);
            _output.WriteLine($"{req.RequestId}: status={log.Status}, duration={log.DurationMs}ms - OK");
        }

        _output.WriteLine("PASS: All requests have correct data, no mixup");
    }

    [Fact]
    public async Task Scenario5_FailedRequest_StatusIsFailed()
    {
        // 场景5：失败的请求，状态应为 failed
        var logId = Guid.NewGuid().ToString("N");
        var requestId = "req-failed-001";
        var startedAt = DateTime.UtcNow;
        var endedAt = startedAt.AddMilliseconds(200);

        _output.WriteLine($"Test: Failed request - status should be 'failed'");

        // 预插入
        await SimulatePreInsert(logId, requestId, startedAt);

        // 完整插入（模拟 500 错误）
        var log = new ApiRequestLog
        {
            Id = logId,
            RequestId = requestId,
            StartedAt = startedAt,
            EndedAt = endedAt,
            DurationMs = 200,
            Method = "POST",
            Path = "/api/test",
            StatusCode = 500,
            Status = "failed",
            Direction = "inbound",
            UserId = "test-user",
            ResponseBody = "{\"success\":false,\"error\":{\"code\":\"INTERNAL_ERROR\"}}",
            ErrorCode = "INTERNAL_ERROR"
        };

        await _collection.ReplaceOneAsync(
            x => x.Id == logId,
            log,
            new ReplaceOptions { IsUpsert = true });

        // 验证
        var finalLog = await _collection.Find(x => x.Id == logId).FirstOrDefaultAsync();
        Assert.NotNull(finalLog);
        Assert.Equal("failed", finalLog.Status);
        Assert.Equal(500, finalLog.StatusCode);
        Assert.Equal("INTERNAL_ERROR", finalLog.ErrorCode);

        _output.WriteLine($"Final status: {finalLog.Status}, statusCode: {finalLog.StatusCode}, errorCode: {finalLog.ErrorCode}");
        _output.WriteLine("PASS: Failed request correctly marked as 'failed'");
    }

    [Fact]
    public async Task Scenario6_RunningRequest_VisibleInList()
    {
        // 场景6：进行中的请求应该在列表中可见（通过 status 筛选）
        var logId = Guid.NewGuid().ToString("N");
        var requestId = "req-running-001";
        var startedAt = DateTime.UtcNow;

        _output.WriteLine($"Test: Running request - visible when filtering by status='running'");

        // 只执行预插入（模拟长时间运行的请求）
        await SimulatePreInsert(logId, requestId, startedAt);

        // 查询 running 状态的日志
        var runningLogs = await _collection
            .Find(x => x.Status == "running")
            .ToListAsync();

        Assert.Contains(runningLogs, x => x.Id == logId);
        _output.WriteLine($"Found {runningLogs.Count} running request(s)");

        // 验证 running 状态的记录特征
        var log = runningLogs.First(x => x.Id == logId);
        Assert.Null(log.EndedAt);
        Assert.Null(log.DurationMs);
        Assert.Equal(0, log.StatusCode);
        Assert.Null(log.ResponseBody);

        _output.WriteLine($"Running request: id={log.Id}, startedAt={log.StartedAt}, endedAt={log.EndedAt}");
        _output.WriteLine("PASS: Running request is visible and has expected characteristics");
    }

    [Fact]
    public async Task Scenario7_StressTest_HighConcurrency()
    {
        // 场景7：高并发压力测试
        const int requestCount = 100;
        _output.WriteLine($"Test: High concurrency stress test ({requestCount} requests)");

        var requests = Enumerable.Range(1, requestCount).Select(i => new
        {
            LogId = Guid.NewGuid().ToString("N"),
            RequestId = $"req-stress-{i:0000}"
        }).ToList();

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();

        // 并发执行所有请求
        var tasks = requests.Select(async req =>
        {
            var startedAt = DateTime.UtcNow;
            var rnd = new Random();
            var duration = rnd.Next(50, 500);

            // 随机延迟模拟真实场景
            var preInsertDelay = rnd.Next(0, 100);
            var completeDelay = rnd.Next(0, 100);

            var preInsertTask = Task.Run(async () =>
            {
                await Task.Delay(preInsertDelay);
                return await SimulatePreInsert(req.LogId, req.RequestId, startedAt);
            });

            var completeTask = Task.Run(async () =>
            {
                await Task.Delay(completeDelay);
                await SimulateCompleteInsert(req.LogId, req.RequestId, startedAt, startedAt.AddMilliseconds(duration), duration);
            });

            await Task.WhenAll(preInsertTask, completeTask);
        });

        await Task.WhenAll(tasks);
        stopwatch.Stop();

        _output.WriteLine($"All {requestCount} requests completed in {stopwatch.ElapsedMilliseconds}ms");

        // 验证所有请求的数据完整性
        var allLogs = await _collection.Find(Builders<ApiRequestLog>.Filter.Empty).ToListAsync();
        Assert.Equal(requestCount, allLogs.Count);

        var completedCount = allLogs.Count(x => x.Status == "completed");
        var runningCount = allLogs.Count(x => x.Status == "running");

        _output.WriteLine($"Completed: {completedCount}, Running: {runningCount}");
        Assert.Equal(requestCount, completedCount);
        Assert.Equal(0, runningCount);

        // 验证所有记录都有完整数据
        foreach (var log in allLogs)
        {
            Assert.Equal("completed", log.Status);
            Assert.Equal(200, log.StatusCode);
            Assert.NotNull(log.EndedAt);
            Assert.NotNull(log.DurationMs);
        }

        _output.WriteLine("PASS: All requests have complete data under high concurrency");
    }
}
