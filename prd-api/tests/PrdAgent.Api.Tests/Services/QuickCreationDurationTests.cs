using System.Text.Json;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class QuickCreationDurationTests
{
    [Fact]
    public void DefaultForDocumentKeepsTheEstimatedDurationAndSceneCount()
    {
        var estimate = QuickCreationDuration.Estimate(1840, null);
        Assert.Equal("auto", estimate.Choice);
        Assert.Equal(180, estimate.TargetSec);
        Assert.Equal(13, estimate.Scenes);
        Assert.Equal(new[] { 35, 54 }, estimate.GenerateMin);
        Assert.True(estimate.TrialDefault);

        var selected = QuickCreationDuration.Estimate(1840, 600);
        Assert.Equal(600, selected.TargetSec);
        Assert.Equal(180, selected.AutoSec);
        Assert.Equal(40, selected.Scenes);
    }

    [Theory]
    [InlineData("\"auto\"", true, null)]
    [InlineData("300", true, 300)]
    [InlineData("45", false, null)]
    [InlineData("\"180\"", false, null)]
    public void DurationChoiceUsesTheVersionedWireFormat(string json, bool accepted, int? duration)
    {
        using var document = JsonDocument.Parse(json);
        Assert.Equal(accepted, QuickCreationDuration.TryRead(document.RootElement, out var actual));
        Assert.Equal(duration, actual);
    }

    [Theory]
    [InlineData(153, true)]
    [InlineData(207, true)]
    [InlineData(152, false)]
    [InlineData(208, false)]
    public void StoryboardToleranceIsFifteenPercent(int seconds, bool accepted) =>
        Assert.Equal(accepted, QuickCreationDuration.IsWithinTarget(seconds, 180));
}
