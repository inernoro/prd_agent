using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 「同名模型」的库查询谓词，权威侧与控制台镜像的行为对照。
///
/// 为什么必须有这条：这个判据在本仓库已经被写坏过三次，每次都漏掉同一支——
/// 存量文档没有 ModelNameNormalized，只能靠原始名字那一支查到，而那一支按字节比就查不到
/// 换了大小写的同一个模型。第 63 轮修了运行时单查，第 68 轮修了预取，第 76 轮修的是
/// 批量导入的白名单发布。三处各写一份的结果就是漏三次，所以收敛成一份 + 这条对照。
///
/// 比的是**渲染出来的查询**而不是源码：两边各自拼的 BSON 长得不一样就会漂，
/// 而漂了不会有任何东西报错——只会让某一侧查不到，然后判成「管不着」放行。
/// </summary>
public sealed class CatalogSameNameMirrorTests
{
    private static string Render(FilterDefinition<BsonDocument> filter)
        => filter.Render(new RenderArgs<BsonDocument>(
                BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(),
                BsonSerializer.SerializerRegistry))
            .ToString();

    [Theory]
    [InlineData("gpt-4o")]
    [InlineData("GPT-4o")]
    [InlineData("  gpt-4o  ")]
    // 正则元字符必须被转义，否则一个名字里带点的模型会匹配到别人身上。
    [InlineData("private-provider/gpt-4.1-mini")]
    public void 单个同名谓词两侧一致(string modelName)
        => Assert.Equal(
            Render(GatewayCatalogGate.SameNameFilter(modelName)),
            Render(CatalogGatePolicy.SameNameFilter(modelName)));

    [Fact]
    public void 批量同名谓词两侧一致()
    {
        string[] names = ["gpt-4o", "GPT-4O", "  claude-sonnet-5 ", "", "   "];
        Assert.Equal(
            Render(GatewayCatalogGate.SameNameBatchFilter(names)),
            Render(CatalogGatePolicy.SameNameBatchFilter(names)));
    }

    /// <summary>
    /// 空集合两侧都要给恒不成立的谓词。
    ///
    /// 这一条单列是因为它的反面特别坏：空的 In 在 Mongo 里命中**整张表**，
    /// 于是「一个名字都没有」会被读成「全都要」。
    /// </summary>
    [Fact]
    public void 空集合两侧都恒不成立()
        => Assert.Equal(
            Render(GatewayCatalogGate.SameNameBatchFilter([])),
            Render(CatalogGatePolicy.SameNameBatchFilter([])));

    /// <summary>
    /// console-api 里不许再手拼同名判据——只许调共享谓词。
    ///
    /// 这个判断在本仓库被写坏过三次、手抄过四份，每次漏的都是同一支（存量文档没有
    /// ModelNameNormalized，只能靠原样名那一支查到，而那一支按字节比就查不到换了大小写的
    /// 同一个模型）。行为对照只能保证「共享的那一份是对的」，保证不了「没人再拼第五份」——
    /// 那是形状 3 的防再修一边守卫，只能扫源码。
    ///
    /// 判据选的是**过滤器位置**的归一化名：`fb.Eq("ModelNameNormalized", …)` 这类。
    /// 索引键、部分索引的类型判断、投影 Include、以及写文档时的字段赋值都不是比较，不在此列。
    /// </summary>
    [Fact]
    public void 控制台不许再手拼同名判据()
    {
        var root = LocateRepoRoot();
        var program = File.ReadAllText(Path.Combine(root, "llmgw", "console-api", "Program.cs"));

        string[] forbidden =
        [
            "fb.Eq(\"ModelNameNormalized\"",
            "fb.In(\"ModelNameNormalized\"",
            "Filter.Eq(\"ModelNameNormalized\"",
            "Filter.In(\"ModelNameNormalized\"",
        ];
        var hits = forbidden.Where(x => program.Contains(x, StringComparison.Ordinal)).ToList();
        Assert.True(hits.Count == 0,
            "这些是手拼的同名判据，请改调 CatalogGatePolicy.SameNameFilter / SameNameBatchFilter："
            + string.Join("、", hits));

        // 共享谓词确实有人在用——上面那条如果因为「一处都不查了」而判绿，等于什么都没守住。
        var uses = program.Split("CatalogGatePolicy.SameName", StringSplitOptions.None).Length - 1;
        Assert.True(uses >= 3, $"只看到 {uses} 处在用共享同名谓词，少于已知的 3 处——是被人换回手拼了吗？");
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    }

    /// <summary>
    /// 存量文档那一支真的忽略大小写：渲染出来的正则必须带 i 选项。
    ///
    /// 上面三条只保证「两边一样」——两边一起写错照样全绿（形状 4：测试测的不是它以为在测的事）。
    /// 这一条钉的是内容本身。
    /// </summary>
    [Fact]
    public void 原始名字那一支忽略大小写()
    {
        var rendered = Render(CatalogGatePolicy.SameNameFilter("GPT-4o"));
        Assert.Contains("ModelNameNormalized", rendered);
        Assert.Contains("\"gpt-4o\"", rendered);
        Assert.Contains("ModelName", rendered);
        // 渲染成 /^GPT-4o$/i —— 结尾那个 i 就是忽略大小写选项，去掉它这条断言必须红。
        Assert.Contains("/^GPT-4o$/i", rendered);
    }
}
