using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
public class ModelReclassifyParserTests
{
    [Fact]
    public void ParseOrThrow_InvalidJson_ShouldThrow()
    {
        var raw = "not json";
        var ex = Assert.Throws<ModelReclassifyParseException>(() =>
            ModelReclassifyParser.ParseOrThrow(raw, new[] { "m1" }));
        Assert.Contains("不是有效 JSON", ex.Message);
    }

    [Fact]
    public void ParseOrThrow_CodeFenceAndExtraText_ShouldParse()
    {
        var raw = """
                  下面是结果：
                  ```json
                  [
                    {"modelName":"m1","group":"g1","tags":["reasoning"],"confidence":0.9},
                    {"modelName":"m2","group":"g2","tags":["vision","free"]}
                  ]
                  ```
                  """;

        var r = ModelReclassifyParser.ParseOrThrow(raw, new[] { "m1", "m2" });
        Assert.Equal(2, r.Count);
        Assert.Equal("m1", r[0].ModelName);
        Assert.Equal("g1", r[0].Group);
        Assert.Contains("reasoning", r[0].Tags);
    }

    [Fact]
    public void ParseOrThrow_MissingModelResult_ShouldThrow()
    {
        var raw = """
                  [
                    {"modelName":"m1","group":"g1","tags":["reasoning"]}
                  ]
                  """;

        var ex = Assert.Throws<ModelReclassifyParseException>(() =>
            ModelReclassifyParser.ParseOrThrow(raw, new[] { "m1", "m2" }));
        Assert.Contains("缺少", ex.Message);
    }

    [Fact]
    public void ParseOrThrow_UnsupportedTag_ShouldThrow()
    {
        var raw = """
                  [
                    {"modelName":"m1","group":"g1","tags":["unknown_tag"]}
                  ]
                  """;

        var ex = Assert.Throws<ModelReclassifyParseException>(() =>
            ModelReclassifyParser.ParseOrThrow(raw, new[] { "m1" }));
        Assert.Contains("不支持", ex.Message);
    }
}


