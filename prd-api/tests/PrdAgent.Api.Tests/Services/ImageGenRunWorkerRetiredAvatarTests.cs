using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ImageGenRunWorkerRetiredAvatarTests
{
    [Fact]
    public void BuildRetiredAvatarRunFilter_ReclaimsOnlyQueuedOrSufficientlyStaleRunningRuns()
    {
        var cutoff = new DateTime(2026, 8, 12, 8, 0, 0, DateTimeKind.Utc);
        var rendered = Render(ImageGenRunWorker.BuildRetiredAvatarRunFilter(
            "prd-agent::branch::revision::new",
            new BsonRegularExpression("^prd-agent::branch(?:::revision::.+)?$"),
            cutoff));

        rendered.ShouldContain($"\"Status\" : {(int)ImageGenRunStatus.ScopedQueued}");
        rendered.ShouldContain($"\"Status\" : {(int)ImageGenRunStatus.Running}");
        rendered.ShouldContain(nameof(ImageGenRun.StartedAt));
        rendered.ShouldContain("$lte");
        rendered.ShouldContain("2026-08-12T08:00:00Z");
        rendered.ShouldContain(ProfileAvatarGenerationCleanupService.AppKey);
        rendered.ShouldContain("prd-agent::branch::revision::new");
    }

    private static string Render(FilterDefinition<ImageGenRun> filter)
    {
        var registry = BsonSerializer.SerializerRegistry;
        return filter.Render(new RenderArgs<ImageGenRun>(
                registry.GetSerializer<ImageGenRun>(),
                registry))
            .ToJson();
    }
}
