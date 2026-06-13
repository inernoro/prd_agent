using PrdAgent.Core.Helpers;
using Xunit;

namespace PrdAgent.Tests;

public class ProductEntityNumberingTests
{
    [Theory]
    [InlineData("1007157", 1007157L)]
    [InlineData(" 42 ", 42L)]
    [InlineData("FEA-2026-0001", 0L)]
    [InlineData("", 0L)]
    public void TryParseTapdNumericId_parses_pure_digits_only(string input, long expected)
    {
        var ok = ProductEntityNumbering.TryParseTapdNumericId(input, out var id);
        if (expected > 0)
        {
            Assert.True(ok);
            Assert.Equal(expected, id);
        }
        else
        {
            Assert.False(ok);
        }
    }

    [Fact]
    public void NextTapdNumericId_returns_max_plus_one()
    {
        var next = ProductEntityNumbering.NextTapdNumericId(new[] { "100", "99", "FEA-1", null, "101" });
        Assert.Equal("102", next);
    }

    [Fact]
    public void NextTapdNumericId_starts_at_one_when_empty()
    {
        Assert.Equal("1", ProductEntityNumbering.NextTapdNumericId(Array.Empty<string?>()));
    }

    [Fact]
    public void NextWorkflowCode_increments_minor_on_global_max()
    {
        var next = ProductEntityNumbering.NextWorkflowCode("V", "minor", new[] { "V1.2.3", "V1.2.8" });
        Assert.Equal("V1.2.9", next);
    }

    [Fact]
    public void NextWorkflowCode_bumps_major_segment()
    {
        var next = ProductEntityNumbering.NextWorkflowCode("T", "major", new[] { "T2.1.4" });
        Assert.Equal("T3.0.0", next);
    }

    [Fact]
    public void NextWorkflowCode_bumps_medium_segment()
    {
        var next = ProductEntityNumbering.NextWorkflowCode("V", "medium", new[] { "V2.1.4" });
        Assert.Equal("V2.2.0", next);
    }
}
