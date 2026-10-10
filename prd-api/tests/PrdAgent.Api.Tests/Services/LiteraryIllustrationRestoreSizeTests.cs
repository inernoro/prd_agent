using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LLM.Adapters;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class LiteraryIllustrationRestoreSizeTests
{
    [Fact]
    public void RestoredImageUsesItsDimensionsInsteadOfTargetDefaults()
    {
        var marker = new ArticleIllustrationMarker
        {
            PlanItem = new() { Prompt = "当前位置", Count = 2, Size = "1024x1024" },
        };
        var asset = new ImageAsset { Width = 1264, Height = 848 };

        var restored = LiteraryIllustrationHistory.RestoredPlan(marker, asset, "旧图描述");

        Assert.NotNull(restored);
        Assert.Equal("1264x848", restored.Size);
        Assert.Equal("旧图描述", restored.Prompt);
        Assert.Equal(2, restored.Count);
        Assert.Equal("1024x1024", marker.PlanItem.Size);
    }

    [Fact]
    public void LegacyImageWithoutDescriptionKeepsPromptAndRestoresKnownDimensions()
    {
        var marker = new ArticleIllustrationMarker
        {
            PlanItem = new() { Prompt = "保留当前描述", Size = "1024x1024" },
        };

        var restored = LiteraryIllustrationHistory.RestoredPlan(
            marker, new ImageAsset { Width = 1536, Height = 1024 }, null);

        Assert.NotNull(restored);
        Assert.Equal("1536x1024", restored.Size);
        Assert.Equal("保留当前描述", restored.Prompt);
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(1264, 0)]
    public void MissingDimensionsKeepExistingPlanSize(int width, int height)
    {
        var marker = new ArticleIllustrationMarker
        {
            PlanItem = new() { Prompt = "当前位置", Size = "1536x1024" },
        };
        var asset = new ImageAsset { Width = width, Height = height };

        Assert.Null(LiteraryIllustrationHistory.RestoredPlan(marker, asset, null));
        var restored = LiteraryIllustrationHistory.RestoredPlan(marker, asset, "旧图描述");
        Assert.NotNull(restored);
        Assert.Equal("1536x1024", restored.Size);
        Assert.Equal("旧图描述", restored.Prompt);
    }

    [Fact]
    public void ProPreviewThreeToTwoMatchesVerifiedPixelsAndKeepsOneKTier()
    {
        var config = ImageGenModelConfigs.Configs.Single(c => c.ModelIdPattern == "gemini-3-pro-image-preview*");
        var option = Assert.Single(config.SizesByResolution["1k"].Where(s => s.AspectRatio == "3:2"));
        Assert.Equal("1264x848", option.Size);
        Assert.Equal("1264x848", ImageGenModelAdapterRegistry.NormalizeSize(config, option.Size).Size);
        var (ratio, tier) = GooglePlatformAdapter.ParseSizeToGoogleParams(option.Size);
        Assert.Equal("3:2", ratio);
        Assert.Equal("1K", tier);
        Assert.Contains(config.SizesByResolution["2k"], s => s.Size == "2528x1696");
        Assert.Contains(config.SizesByResolution["4k"], s => s.Size == "5056x3392");
    }
}
