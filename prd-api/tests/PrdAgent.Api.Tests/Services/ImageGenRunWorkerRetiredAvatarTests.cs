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
    public void BuildRetiredAvatarRunFilter_ReclaimsOnlyQueuedRuns()
    {
        var rendered = Render(ImageGenRunWorker.BuildRetiredAvatarRunFilter(
            "prd-agent::branch::revision::new",
            new BsonRegularExpression("^prd-agent::branch(?:::revision::.+)?$")));

        rendered.ShouldContain($"\"Status\" : {(int)ImageGenRunStatus.ScopedQueued}");
        rendered.ShouldNotContain($"\"Status\" : {(int)ImageGenRunStatus.Running}");
        rendered.ShouldNotContain(nameof(ImageGenRun.StartedAt));
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
