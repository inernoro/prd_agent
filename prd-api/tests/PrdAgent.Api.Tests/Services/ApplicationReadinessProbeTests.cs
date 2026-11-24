using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Json;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ApplicationReadinessProbeTests
{
    [Fact]
    public async Task CheckAsync_ShouldRequireMongoRedisAndAssetStorage()
    {
        var calls = new List<string>();
        var probe = CreateProbe(
            mongo: _ => Record(calls, "mongodb"),
            redis: _ => Record(calls, "redis"),
            asset: (_, _) =>
            {
                calls.Add("asset-storage");
                return Task.FromResult(HealthyAsset());
            });

        var result = await probe.CheckAsync(force: true);

        result.Status.ShouldBe("healthy");
        result.ErrorCode.ShouldBeNull();
        result.Components.Select(component => component.Name)
            .ShouldBe(["mongodb", "redis", "asset-storage"]);
        result.Components.ShouldAllBe(component => component.Ready);
        calls.OrderBy(value => value).ShouldBe(
            new[] { "asset-storage", "mongodb", "redis" });
    }

    [Theory]
    [InlineData("mongodb", "MONGODB_UNAVAILABLE")]
    [InlineData("redis", "REDIS_UNAVAILABLE")]
    [InlineData("asset-storage", "ASSET_STORAGE_UNAVAILABLE")]
    public async Task CheckAsync_ShouldReturnOnlyStableCodeForDependencyFailure(
        string failedComponent,
        string expectedErrorCode)
    {
        const string sensitiveDetail = "mongodb://root:never-return-this@db:27017";
        var probe = CreateProbe(
            mongo: _ => failedComponent == "mongodb"
                ? Task.FromException(new InvalidOperationException(sensitiveDetail))
                : Task.CompletedTask,
            redis: _ => failedComponent == "redis"
                ? Task.FromException(new InvalidOperationException(sensitiveDetail))
                : Task.CompletedTask,
            asset: (_, _) => Task.FromResult(failedComponent == "asset-storage"
                ? new AssetStorageReadinessResponse
                {
                    Status = "unhealthy",
                    ErrorCode = "write_failed",
                    ErrorMessage = sensitiveDetail,
                }
                : HealthyAsset()));

        var result = await probe.CheckAsync(force: true);
        var json = JsonSerializer.Serialize(result);

        result.Status.ShouldBe("unhealthy");
        result.ErrorCode.ShouldBe(expectedErrorCode);
        result.Components.Single(component => component.Name == failedComponent)
            .ErrorCode.ShouldBe(expectedErrorCode);
        json.ShouldNotContain(sensitiveDetail);
        json.ShouldNotContain("ErrorMessage", Case.Insensitive);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("write_failed")]
    [InlineData("provider_exception: never-return-raw-diagnostic")]
    public async Task CheckAsync_ShouldNormalizeAssetFailureWithoutLeakingRawDiagnostics(string? rawErrorCode)
    {
        const string rawMessage = "never-return-private-storage-diagnostic";
        var asset = new AssetStorageReadinessResponse
        {
            Status = "unhealthy",
            ErrorCode = rawErrorCode,
            ErrorMessage = rawMessage,
            WriteVerified = true,
            InternalReadVerified = true,
            PublicReadVerified = false,
            CleanupVerified = true,
        };
        var probe = CreateProbe(
            mongo: _ => Task.CompletedTask,
            redis: _ => Task.CompletedTask,
            asset: (_, _) => Task.FromResult(asset));

        var result = await probe.CheckAsync();

        result.Status.ShouldBe("unhealthy");
        result.ErrorCode.ShouldBe(ApplicationReadinessProbe.AssetStorageUnavailable);
        result.Components.Single(component => component.Name == "asset-storage")
            .ErrorCode.ShouldBe(ApplicationReadinessProbe.AssetStorageUnavailable);
        result.Components.Single(component => component.Name == "asset-storage").Ready.ShouldBeFalse();
        result.WriteVerified.ShouldBeTrue();
        result.InternalReadVerified.ShouldBeTrue();
        result.PublicReadVerified.ShouldBeFalse();
        result.CleanupVerified.ShouldBeTrue();
        var json = JsonSerializer.Serialize(result);
        json.ShouldNotContain(rawMessage);
        if (!string.IsNullOrWhiteSpace(rawErrorCode)) json.ShouldNotContain(rawErrorCode);
        // 聚合器不改写专用诊断探针的结果，诊断端点仍可使用其阶段信息。
        asset.ErrorCode.ShouldBe(rawErrorCode);
        asset.ErrorMessage.ShouldBe(rawMessage);
    }

    [Fact]
    public async Task CheckAsync_ShouldCancelStalledDependencyProbes()
    {
        // 超时只让调用方走人是不够的：探测留在后台跑，依赖掉线期间每次就绪请求都堆一条在途操作。
        CancellationToken mongoToken = default;
        var probe = CreateProbe(
            mongo: async token =>
            {
                mongoToken = token;
                await Task.Delay(TimeSpan.FromSeconds(30), token);
            },
            redis: _ => Task.CompletedTask,
            asset: (_, _) => Task.FromResult(HealthyAsset()),
            dependencyTimeout: TimeSpan.FromMilliseconds(50));

        var result = await probe.CheckAsync();

        result.Status.ShouldBe("unhealthy");
        result.ErrorCode.ShouldBe(ApplicationReadinessProbe.MongoUnavailable);
        mongoToken.IsCancellationRequested.ShouldBeTrue(
            customMessage: "超时后传给依赖探测的令牌必须已取消，否则这条探测会在后台继续跑");
    }

    [Fact]
    public async Task CheckAsync_ShouldNotHangOnAStalledAssetStorageProbe()
    {
        // 对象存储那一条此前没有超时：存储卡住时 Task.WhenAll 一直等，整个 /health/ready 挂着，
        // 部署就绪检查会超时，而调用方在它后面排队。
        CancellationToken assetToken = default;
        var probe = CreateProbe(
            mongo: _ => Task.CompletedTask,
            redis: _ => Task.CompletedTask,
            asset: async (_, token) =>
            {
                assetToken = token;
                await Task.Delay(TimeSpan.FromSeconds(30), token);
                return HealthyAsset();
            },
            dependencyTimeout: TimeSpan.FromMilliseconds(50));

        var check = probe.CheckAsync();
        var completed = await Task.WhenAny(check, Task.Delay(TimeSpan.FromSeconds(10)));
        completed.ShouldBeSameAs(
            check,
            customMessage: "存储卡住时就绪检查必须在依赖超时内给出结论，而不是一直挂着");

        var result = await check;
        result.Status.ShouldBe("unhealthy");
        result.ErrorCode.ShouldBe(ApplicationReadinessProbe.AssetStorageUnavailable);
        assetToken.IsCancellationRequested.ShouldBeTrue(
            customMessage: "超时后传给存储探测的令牌必须已取消");
    }

    [Fact]
    public async Task CheckAsync_ShouldPropagateCallerCancellation()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var probe = CreateProbe(
            mongo: token => Task.Delay(TimeSpan.FromSeconds(30), token),
            redis: _ => Task.CompletedTask,
            asset: (_, _) => Task.FromResult(HealthyAsset()));

        await Should.ThrowAsync<OperationCanceledException>(
            () => probe.CheckAsync(cancellationToken: cancellation.Token));
    }

    [Fact]
    public async Task HangingRedis_ShouldNotStartANewPingForEveryReadinessRequest()
    {
        // Redis 的 PingAsync 不收取消令牌，谁也停不掉它；本仓库量到过 multiplexer 半失活时
        // 命令不按 SyncTimeout 抛异常而是直接挂住。就绪端点由编排每几秒打一次，不合并的话
        // 一次 Redis 故障就会攒出成百条谁也停不掉的在途探测。
        var started = 0;
        var release = new TaskCompletionSource();
        // 时钟不走：五轮都落在过期窗口之内。窗口内外由用例决定，不取决于 CI 当时有多慢。
        var clock = new ManualTimeProvider();
        var probe = CreateProbe(
            mongo: _ => Task.CompletedTask,
            redis: _ =>
            {
                Interlocked.Increment(ref started);
                return release.Task;
            },
            asset: (_, _) => Task.FromResult(HealthyAsset()),
            dependencyTimeout: TimeSpan.FromMilliseconds(40),
            timeProvider: clock);

        for (var round = 0; round < 5; round++)
        {
            var result = await probe.CheckAsync(force: true);
            result.ErrorCode.ShouldBe(ApplicationReadinessProbe.RedisUnavailable);
        }

        started.ShouldBe(1);

        // 上一次真的结束之后不再合并：合并是为了不堆在途调用，不是缓存结论。
        release.SetResult();
        var recovered = await probe.CheckAsync(force: true);
        recovered.Status.ShouldBe("healthy");
        started.ShouldBe(2);
    }

    [Fact]
    public async Task HangingRedis_ShouldEventuallyBeReprobedSoReadinessCanRecoverWithoutARestart()
    {
        // 合并本身会变成第二个故障：PingAsync 挂死后那条任务永远不完成，之后每一次就绪检查
        // 都复用它、都超时——Redis 恢复了也没人再去 ping，只能靠重启 API 才能重新变健康
        //（Codex P2，2026-09-16）。并发闸纪律第四条：卡住的持有者必须有人来收。
        var started = 0;
        var firstAttempt = new TaskCompletionSource();
        var clock = new ManualTimeProvider();
        var probe = CreateProbe(
            mongo: _ => Task.CompletedTask,
            redis: _ =>
            {
                // 第一条永远挂着（模拟半失活的 multiplexer）；之后的立刻成功（Redis 恢复了）。
                return Interlocked.Increment(ref started) == 1 ? firstAttempt.Task : Task.CompletedTask;
            },
            asset: (_, _) => Task.FromResult(HealthyAsset()),
            dependencyTimeout: TimeSpan.FromMilliseconds(10),
            timeProvider: clock);

        (await probe.CheckAsync(force: true)).ErrorCode.ShouldBe(ApplicationReadinessProbe.RedisUnavailable);
        started.ShouldBe(1);

        // 过期窗口之内仍然合并：这正是它存在的理由，不能为了能恢复就退回一次请求一条。
        (await probe.CheckAsync(force: true)).ErrorCode.ShouldBe(ApplicationReadinessProbe.RedisUnavailable);
        started.ShouldBe(1);

        // 熬过窗口（10ms x 12 = 120ms）之后必须重新发起，于是 Redis 一恢复就能重新变健康。
        clock.Advance(TimeSpan.FromMilliseconds(10 * SingleFlightProbe.StaleProbeTimeoutMultiplier + 1));

        var recovered = await probe.CheckAsync(force: true);
        recovered.Status.ShouldBe("healthy");
        started.ShouldBe(2);

        // 那条挂死的探测仍然挂着——PingAsync 停不掉是它的性质；关键是它不再挡着后来者。
        firstAttempt.Task.IsCompleted.ShouldBeFalse();
        firstAttempt.SetResult();
    }

    [Fact]
    public async Task MissingIndexes_AreReportedButDoNotChangeTheHealthVerdict()
    {
        var checkedAt = new DateTime(2026, 9, 24, 1, 2, 3, DateTimeKind.Utc);
        var probe = new ApplicationReadinessProbe(
            _ => Task.CompletedTask,
            _ => Task.CompletedTask,
            (_, _) => Task.FromResult(HealthyAsset()),
            NullLogger<ApplicationReadinessProbe>.Instance,
            indexReport: () => new PrdAgent.Infrastructure.Database.MongoIndexAdvisoryReport(
                checkedAt,
                ["hosted_site_deletion_tasks.idx_hosted_site_deletion_due"],
                ["activity_logs.uniq_activity_logs_deduplication_key"]));

        var result = await probe.CheckAsync();

        // 索引缺失是「会变慢 / 并发窗口敞开」，不是「接不了流量」：不许把实例判成未就绪。
        result.Status.ShouldBe("healthy");
        result.ErrorCode.ShouldBeNull();
        result.MissingIndexes.ShouldBe(["hosted_site_deletion_tasks.idx_hosted_site_deletion_due"]);
        result.UnverifiedIndexes.ShouldBe(["activity_logs.uniq_activity_logs_deduplication_key"]);
        result.IndexesCheckedAt.ShouldBe(checkedAt);
    }

    [Fact]
    public async Task IndexFieldsStayNullUntilTheStartupCheckHasRun()
    {
        var probe = CreateProbe(
            mongo: _ => Task.CompletedTask,
            redis: _ => Task.CompletedTask,
            asset: (_, _) => Task.FromResult(HealthyAsset()));

        var result = await probe.CheckAsync();

        result.MissingIndexes.ShouldBeNull();
        result.UnverifiedIndexes.ShouldBeNull();
        result.IndexesCheckedAt.ShouldBeNull();
    }

    private static ApplicationReadinessProbe CreateProbe(
        Func<CancellationToken, Task> mongo,
        Func<CancellationToken, Task> redis,
        Func<bool, CancellationToken, Task<AssetStorageReadinessResponse>> asset,
        TimeSpan? dependencyTimeout = null,
        TimeProvider? timeProvider = null)
        => new(
            mongo,
            redis,
            asset,
            NullLogger<ApplicationReadinessProbe>.Instance,
            dependencyTimeout,
            timeProvider: timeProvider);

    /// <summary>只在用例调用 Advance 时才走的时钟：过期窗口的判断从此与机器快慢无关。</summary>
    private sealed class ManualTimeProvider : TimeProvider
    {
        private long _ticks;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => Interlocked.Read(ref _ticks);

        public void Advance(TimeSpan by) => Interlocked.Add(ref _ticks, by.Ticks);
    }

    private static AssetStorageReadinessResponse HealthyAsset()
        => new() { Status = "healthy" };

    private static Task Record(ICollection<string> calls, string component)
    {
        calls.Add(component);
        return Task.CompletedTask;
    }
}
