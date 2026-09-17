using MongoDB.Bson;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 控制台那份「兑换所声明过这条别名吗」必须与运行时权威实现逐例同结论。
///
/// 权威实现是 <see cref="GatewayCatalogGate.ExchangeDeclares"/>（运行时解析、对外清单、
/// 就绪探针共用）。控制台按既定架构不引用 PrdAgent.*，所以写了一份镜像；镜像与权威
/// 一旦差一点，写入侧就会一严一松：严了拒掉合法拓扑，松了放进一条运行时必跳过的线路
/// （「存得进去、跑不起来」）。这里逐例把两边摆在一起比。
/// </summary>
public class ExchangeAliasPolicyMirrorTests
{
    private static (ModelExchange Authority, BsonDocument Mirror) Build(
        string? modelAlias,
        IEnumerable<string>? modelAliases,
        IEnumerable<(string ModelId, bool Enabled)>? models)
    {
        var authority = new ModelExchange
        {
            Id = "ex-1",
            Name = "ex",
            ModelAlias = modelAlias ?? string.Empty,
            ModelAliases = modelAliases?.ToList() ?? [],
            Models = models?.Select(x => new ExchangeModel { ModelId = x.ModelId, Enabled = x.Enabled }).ToList() ?? [],
        };

        var mirror = new BsonDocument
        {
            { "_id", "ex-1" },
            { "ModelAlias", modelAlias ?? string.Empty },
            { "ModelAliases", new BsonArray(modelAliases ?? []) },
            {
                "Models",
                new BsonArray((models ?? []).Select(x => new BsonDocument
                {
                    { "ModelId", x.ModelId },
                    { "Enabled", x.Enabled },
                }))
            },
        };
        return (authority, mirror);
    }

    public static TheoryData<string?, string[]?, (string, bool)[]?, string?> Cases()
    {
        var data = new TheoryData<string?, string[]?, (string, bool)[]?, string?>();
        void Add(string? alias, string[]? aliases, (string, bool)[]? models, string? probe)
            => data.Add(alias, aliases, models, probe);

        // 新形态：只认 Models，逐条 Enabled 生效
        Add(null, null, [("gpt-4o", true), ("o3", false)], "gpt-4o");
        Add(null, null, [("gpt-4o", true), ("o3", false)], "o3");            // 被单独停用
        Add(null, null, [("gpt-4o", true)], "GPT-4O");                        // 大小写不敏感
        Add(null, null, [("gpt-4o", true)], "gpt-4");                         // 前缀不算
        Add(null, null, [("gpt-4o", true)], "");                              // 空别名
        Add(null, null, [("gpt-4o", true)], null);
        // Models 非空时旧字段被短路掉——这一条最容易在镜像里写漏
        Add("legacy-alias", ["legacy-2"], [("gpt-4o", true)], "legacy-alias");
        Add("legacy-alias", ["legacy-2"], [("gpt-4o", true)], "legacy-2");
        // 旧形态：Models 为空才从两个旧字段合成，合成出来的一律启用
        Add("legacy-alias", ["legacy-2"], null, "legacy-alias");
        Add("legacy-alias", ["legacy-2"], null, "legacy-2");
        Add("legacy-alias", ["legacy-2"], null, "LEGACY-2");
        Add("legacy-alias", ["legacy-2"], null, "legacy-3");
        Add(null, null, null, "anything");
        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void 控制台镜像与运行时权威逐例同结论(
        string? modelAlias,
        string[]? modelAliases,
        (string ModelId, bool Enabled)[]? models,
        string? probe)
    {
        var (authority, mirror) = Build(modelAlias, modelAliases, models);
        Assert.Equal(
            GatewayCatalogGate.ExchangeDeclares(authority, probe),
            ExchangeAliasPolicy.Declares(mirror, probe));
    }

    [Theory]
    [InlineData("primary", "explicit", "explicit")]
    [InlineData("primary", "  explicit  ", "explicit")]
    [InlineData("primary", null, "primary")]
    [InlineData("primary", "   ", "primary")]
    [InlineData("", null, "")]
    public void 实际打出去的别名与运行时同序(string modelAlias, string? upstreamModelId, string expected)
    {
        var (authority, mirror) = Build(modelAlias, null, null);
        Assert.Equal(expected, GatewayCatalogGate.EffectiveExchangeModelId(authority, upstreamModelId));
        Assert.Equal(expected, ExchangeAliasPolicy.EffectiveAlias(mirror, upstreamModelId));
    }
}
