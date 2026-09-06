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

    private static ApplicationReadinessProbe CreateProbe(
        Func<CancellationToken, Task> mongo,
        Func<CancellationToken, Task> redis,
        Func<bool, CancellationToken, Task<AssetStorageReadinessResponse>> asset)
        => new(
            mongo,
            redis,
            asset,
            NullLogger<ApplicationReadinessProbe>.Instance);

    private static AssetStorageReadinessResponse HealthyAsset()
        => new() { Status = "healthy" };

    private static Task Record(ICollection<string> calls, string component)
    {
        calls.Add(component);
        return Task.CompletedTask;
    }
}
