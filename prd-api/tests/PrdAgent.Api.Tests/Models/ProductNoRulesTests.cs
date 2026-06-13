using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Models;

public class ProductNoRulesTests
{
    [Theory]
    [InlineData("系统", "SYS")]
    [InlineData("子系统", "SUB")]
    [InlineData("应用", "APP")]
    [InlineData("组件", "CMP")]
    [InlineData("其他类型", "GEN")]
    public void PrefixForCategoryName_maps_known_layers(string name, string expected) =>
        Assert.Equal(expected, ProductNoRules.PrefixForCategoryName(name));

    [Fact]
    public void Format_builds_prefix_and_sequence() =>
        Assert.Equal("APP-1007157", ProductNoRules.Format("app", 1007157));

    [Theory]
    [InlineData("SYS-1007157", 1007157L)]
    [InlineData("1007157", 1007157L)]
    [InlineData("PRD-2026-0001", 1L)]
    public void TryParseSequence_extracts_stable_tail(string input, long expected)
    {
        Assert.True(ProductNoRules.TryParseSequence(input, out var seq));
        Assert.Equal(expected, seq);
    }

    [Fact]
    public void ReapplyPrefix_keeps_sequence_only_changes_prefix()
    {
        var updated = ProductNoRules.ReapplyPrefix("APP-42", "SUB");
        Assert.Equal("SUB-42", updated);
    }
}
