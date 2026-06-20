using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class DefectSeverityCatalogTests
{
    [Theory]
    [InlineData("紧急", DefectSeverityCatalog.LevelFatal)]
    [InlineData("高", DefectSeverityCatalog.LevelSerious)]
    [InlineData("中", DefectSeverityCatalog.LevelNormal)]
    [InlineData("低", DefectSeverityCatalog.LevelMinor)]
    [InlineData("无关紧要", DefectSeverityCatalog.LevelMinor)]
    public void TryNormalizeTapdToLevel_maps_tapd_priority_labels(string raw, string expected)
    {
        Assert.Equal(expected, DefectSeverityCatalog.TryNormalizeTapdToLevel(raw));
    }

    [Fact]
    public void TryNormalizeTapdToLevel_returns_null_for_blank()
    {
        Assert.Null(DefectSeverityCatalog.TryNormalizeTapdToLevel(null));
        Assert.Null(DefectSeverityCatalog.TryNormalizeTapdToLevel(""));
        Assert.Null(DefectSeverityCatalog.TryNormalizeTapdToLevel("未知"));
    }
}
