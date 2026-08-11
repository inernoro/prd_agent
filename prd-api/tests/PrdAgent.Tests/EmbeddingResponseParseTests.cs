using System.Text.Json.Nodes;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 向量应答解析的守卫。
///
/// 这里守的全是同一件事：**向量必须对得上它那段原文，对不上就整批拒绝**。
/// 之所以每一条都值得写，是因为出错时全都不报错——错位的向量写进库，余弦照算、
/// 检索照返回，只是答案稳定地牛头不对马嘴，而且事后从库里分辨不出哪些是脏的。
/// </summary>
public class EmbeddingResponseParseTests
{
    private static GatewayModelResolution Res(string model) => new()
    {
        Success = true,
        ActualModel = model,
    };

    private static string Body(params (object? Index, double[] Vec)[] items)
    {
        var arr = new JsonArray();
        foreach (var (index, vec) in items)
        {
            var node = new JsonObject
            {
                ["embedding"] = new JsonArray(vec.Select(v => (JsonNode)JsonValue.Create(v)).ToArray()),
            };
            if (index != null) node["index"] = JsonValue.Create(index);
            arr.Add(node);
        }
        return new JsonObject { ["data"] = arr }.ToJsonString();
    }

    [Fact]
    public void 正常应答_按index归位()
    {
        // 故意乱序返回：规范允许，且真按数组顺序对回原文就会错位
        var json = Body((1, new[] { 9d, 9d }), (0, new[] { 1d, 1d }));
        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 2, Res("bge-m3"));

        Assert.True(batch.Success);
        Assert.Equal(1f, batch.Vectors[0][0]);
        Assert.Equal(9f, batch.Vectors[1][0]);
    }

    [Fact]
    public void 缺index时按出现顺序补位()
    {
        var json = Body((null, new[] { 1d, 1d }), (null, new[] { 2d, 2d }));
        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 2, Res("bge-m3"));

        Assert.True(batch.Success);
        Assert.Equal(1f, batch.Vectors[0][0]);
        Assert.Equal(2f, batch.Vectors[1][0]);
    }

    /// <summary>
    /// 核心用例：给了 index 却越界，不能退回「按出现顺序」。
    ///
    /// 那条兜底只为「字段缺省」准备。上游给了却越界，说明它的应答与我们发出去的这批输入
    /// 对不上；此时填第一个空位等于**猜**这条向量属于哪段原文，猜错就是 A 的向量记在 B 名下。
    /// </summary>
    [Fact]
    public void 越界index必须整批拒绝_而不是当成没给()
    {
        var json = Body((5, new[] { 1d, 1d }), (0, new[] { 2d, 2d }));
        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 2, Res("bge-m3"));

        Assert.False(batch.Success);
        Assert.Equal("UPSTREAM_ERROR", batch.ErrorCode);
    }

    [Fact]
    public void 负index同样整批拒绝()
    {
        var json = Body((-1, new[] { 1d, 1d }));
        Assert.False(EmbeddingService.ParseOpenAiEmbeddings(json, 1, Res("bge-m3")).Success);
    }

    [Fact]
    public void 同一个index返回两次_整批拒绝()
    {
        var json = Body((0, new[] { 1d, 1d }), (0, new[] { 2d, 2d }));
        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 2, Res("bge-m3"));

        Assert.False(batch.Success);
        Assert.Equal("UPSTREAM_ERROR", batch.ErrorCode);
    }

    /// <summary>
    /// 核心用例：index 不是整数时要返回 UPSTREAM_ERROR，**不能抛异常**。
    ///
    /// 原实现直接 GetValue&lt;int&gt;()，只 catch 了 JSON 解析本身；字符串 / null / 小数
    /// 会让异常一路穿透成未处理的服务异常或批任务失败。一个不兼容的供应商应答不该把调用方打崩。
    /// </summary>
    /// <remarks>
    /// 不含 JSON `null`：`JsonObject["index"]` 对「字段值是 null」和「字段不存在」
    /// 返回的都是 C# null，在这一层物理上区分不了。把显式 null 当成缺省、走按序补位，
    /// 是可接受的语义（补位本身是安全的，越界才危险），故不在此断言。
    /// </remarks>
    [Theory]
    [InlineData("\"0\"")]
    [InlineData("0.5")]
    [InlineData("99999999999999999999")]
    [InlineData("true")]
    [InlineData("{}")]
    public void 非整数index返回错误而不是抛异常(string rawIndex)
    {
        var json = $"{{\"data\":[{{\"index\":{rawIndex},\"embedding\":[1.0,2.0]}}]}}";

        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 1, Res("bge-m3"));

        Assert.False(batch.Success);
        Assert.Equal("UPSTREAM_ERROR", batch.ErrorCode);
    }

    [Fact]
    public void 整数值的浮点写法_仍按整数接受()
    {
        // 1.0 是合法的「整数值」，只是写成了浮点；拒绝它属于误伤
        var json = "{\"data\":[{\"index\":1.0,\"embedding\":[9.0]},{\"index\":0.0,\"embedding\":[1.0]}]}";
        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 2, Res("bge-m3"));

        Assert.True(batch.Success);
        Assert.Equal(1f, batch.Vectors[0][0]);
        Assert.Equal(9f, batch.Vectors[1][0]);
    }

    /// <summary>
    /// 核心用例：向量分量不是有限数字时整批拒绝，**不能用 0 兜底、也不能抛**。
    ///
    /// `?? 0d` 会把 JSON null 悄悄变成 0——一条掺了零的向量看起来完全正常，写进库、
    /// 算余弦、返回结果，全程不报错，只是这一条永远检索得不准，事后还认不出来它是坏的。
    /// 字符串 / 布尔 / 对象则会让 GetValue&lt;double&gt;() 抛到 JSON 解析的 catch 之外。
    /// </summary>
    [Theory]
    [InlineData("[1.0,null]")]
    [InlineData("[1.0,\"x\"]")]
    [InlineData("[1.0,true]")]
    [InlineData("[1.0,{}]")]
    [InlineData("[1.0,[]]")]
    [InlineData("[1.0,1e400]")]
    public void 分量不是有限数字时整批拒绝(string embedding)
    {
        var json = $"{{\"data\":[{{\"index\":0,\"embedding\":{embedding}}}]}}";

        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 1, Res("bge-m3"));

        Assert.False(batch.Success);
        Assert.Equal("UPSTREAM_ERROR", batch.ErrorCode);
    }

    [Fact]
    public void 合法分量_含负数与整数写法_正常接受()
    {
        var json = "{\"data\":[{\"index\":0,\"embedding\":[-0.5,0,1,2.25]}]}";
        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 1, Res("bge-m3"));

        Assert.True(batch.Success);
        Assert.Equal(new[] { -0.5f, 0f, 1f, 2.25f }, batch.Vectors[0]);
    }

    [Fact]
    public void 条数不足时整批拒绝()
    {
        var json = Body((0, new[] { 1d, 1d }));
        Assert.False(EmbeddingService.ParseOpenAiEmbeddings(json, 3, Res("bge-m3")).Success);
    }

    [Fact]
    public void 同批维度不一致时整批拒绝()
    {
        var json = Body((0, new[] { 1d, 1d }), (1, new[] { 1d, 1d, 1d }));
        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 2, Res("bge-m3"));

        Assert.False(batch.Success);
        Assert.Equal("DIMENSION_MISMATCH", batch.ErrorCode);
    }

    [Fact]
    public void 不是合法JSON时返回错误而不是抛异常()
    {
        var batch = EmbeddingService.ParseOpenAiEmbeddings("<html>502</html>", 1, Res("bge-m3"));

        Assert.False(batch.Success);
        Assert.Equal("UPSTREAM_ERROR", batch.ErrorCode);
    }

    [Fact]
    public void 贴的模型名来自传进来的那个resolution()
    {
        var json = Body((0, new[] { 1d, 1d }));
        var batch = EmbeddingService.ParseOpenAiEmbeddings(json, 1, Res("text-embedding-3-small"));

        Assert.True(batch.Success);
        Assert.Equal("text-embedding-3-small", batch.Model);
    }
}

/// <summary>
/// 两条源码守卫：改回去之后行为测试不会红，只能从源码上守。
/// </summary>
public class EmbeddingServiceWiringGuardTests
{
    private static string Source()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir); // 找不到仓库根就让用例红，而不是静默跳过
        var path = Path.Combine(dir!.FullName,
            "prd-api", "src", "PrdAgent.Infrastructure", "Services", "EmbeddingService.cs");
        Assert.True(File.Exists(path), $"未找到被守文件：{path}");
        return File.ReadAllText(path);
    }

    /// <summary>
    /// server-authority：模型调用不得被调用方的取消令牌打断。
    /// 上游可能已经受理并计费，取消只会让重试重复付一遍钱，而结果谁也没拿到。
    /// </summary>
    [Fact]
    public void 真正发出去的那条调用必须用None而不是转发调用方的ct()
    {
        // 只看 EmbedAsync 这一段。ResolveActiveModelAsync 只解析「当前配的是哪个模型」、
        // 不向上游发任何东西、也不写库，取消它没有代价——把它一并禁掉是过度修正
        // （上一轮在预览那条线上刚犯过一次同样的错）。
        var src = Source();
        var body = src[src.IndexOf("public async Task<EmbeddingBatch> EmbedAsync", StringComparison.Ordinal)..];
        Assert.NotEqual(string.Empty, body);

        Assert.Contains("ResolveModelAsync(appCallerCode, ModelTypes.Embedding, ct: CancellationToken.None)", body);
        Assert.Contains("}, resolution, CancellationToken.None);", body);
        // 反向：发送路径上不许再出现「把 ct 转发进网关」的写法
        Assert.DoesNotContain("ModelTypes.Embedding, ct: ct)", body);
        Assert.DoesNotContain("}, resolution, ct);", body);
    }

    /// <summary>
    /// 贴标签必须用**真正成功的那个候选**。
    ///
    /// 网关在候选可重试失败时会换一个模型再发，这时 raw.Resolution 才是算出这批向量的模型。
    /// 拿 pre-send 的 resolution 贴，就是「B 算的向量记成 A 名下」——两个不同的向量空间
    /// 被兼容性检查当成同一个比，检索静默出错且事后从库里分辨不出来。
    /// </summary>
    [Fact]
    public void 解析时用响应里的resolution贴模型名()
    {
        var src = Source();

        Assert.Contains("raw.Resolution ?? resolution", src);
        Assert.DoesNotContain("ParseOpenAiEmbeddings(raw.Content!, input.Count, resolution)", src);
    }
}
