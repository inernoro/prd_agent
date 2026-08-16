using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class LegacyOwnerScopeTests
{
    [Fact]
    public void Build_AdoptsLegacyOwnersOnlyBeforeConfiguredCutoff()
    {
        var cutoff = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var rendered = Render(LegacyOwnerScope.Build<TranscriptRun>(
            nameof(TranscriptRun.OwnerInstanceId),
            ["prd-agent:production::main"],
            includeUnowned: true,
            retiredLegacyOwnerIds: ["main"],
            legacyOwnerCreatedBeforeUtc: cutoff));

        rendered.ShouldContain("main");
        rendered.ShouldContain("CreatedAt");
        rendered.ShouldContain("$lte");
        rendered.ShouldContain("2026-01-01");
    }

    [Fact]
    public void Build_RejectsAllLegacyOwnersWhenCutoffIsMissing()
    {
        var rendered = Render(LegacyOwnerScope.Build<TranscriptRun>(
            nameof(TranscriptRun.OwnerInstanceId),
            ["prd-agent:production::main"],
            includeUnowned: true,
            retiredLegacyOwnerIds: ["main"],
            legacyOwnerCreatedBeforeUtc: null));

        rendered.ShouldContain("prd-agent:production::main");
        rendered.ShouldNotContain("CreatedAt");
        rendered.ShouldNotContain("$exists");
        rendered.ShouldNotContain("\"main\"");
    }

    private static string Render(FilterDefinition<TranscriptRun> filter)
    {
        var registry = BsonSerializer.SerializerRegistry;
        return filter.Render(new RenderArgs<TranscriptRun>(
                registry.GetSerializer<TranscriptRun>(),
                registry))
            .ToJson();
    }
}
