using PrdAgent.LlmGw.Provisioning;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 批量登记与对外模型清单的守卫。
///
/// 背景：这两件事回答的是同一个问题——「拆成『模型』和『白名单』两个页面，意义在哪」。
/// 分层本身有用（一个公开模型名要能挂多条上游线路），但代价一直由用户承担：
/// 批量导入只建物理模型，导完白名单里什么都没多，用户得再去另一页把同一个模型建两遍；
/// 而对外的四条 POST 兼容入口都有，唯独没有 GET /v1/models，对方能调却列不出可调什么。
///
/// 下面钉住的是这两个洞被堵上之后的口径。
/// </summary>
public class GatewayWhitelistPublishingTests
{
    private static readonly string Console = ReadRepoFile("llmgw/console-api/Program.cs");
    private static readonly string Publishing = ReadRepoFile("llmgw/console-api/Provisioning/GatewayWhitelistPublishing.cs");
    private static readonly string Serving = ReadRepoFile("llmgw/serving/GatewayHttpEndpoints.cs");
    private static readonly string Catalog = ReadRepoFile("llmgw/serving/GatewayModelCatalogEndpoint.cs");

    [Fact]
    public void 批量导入默认登记白名单且失败不报全绿()
    {
        // 默认开：不登记的话「批量登记」只做了一半，用户看到成功提示、白名单里却是空的
        Assert.Contains("body?.PublishToWhitelist ?? true", Console);
        // 三层一次建齐
        Assert.Contains("gwLogicalModels.InsertOneAsync", Console);
        Assert.Contains("gwModelOfferings.InsertOneAsync", Console);
        // 同名不新建公开名，只多挂一条线路——这是「一个模型多个来源」的入口
        Assert.Contains("result.LinkedToExistingCount++", Console);
        // 登记失败时模型已入库，必须如实说而不是吞掉
        Assert.Contains("result.WhitelistMessage", Console);
    }

    [Fact]
    public void 公开模型名剥掉供应商前缀否则同一个模型会变成两个()
    {
        // openai/gpt-4o 与 gpt-4o 必须收敛到同一个公开名，否则从官网导一次、从中转再导一次，
        // 白名单里就是两个条目，多来源永远合不起来。
        Assert.Equal("gpt-4o", GatewayWhitelistPublishing.ToPublicId("openai/gpt-4o"));
        Assert.Equal("gpt-4o", GatewayWhitelistPublishing.ToPublicId("gpt-4o"));
        Assert.Equal("claude-sonnet-4", GatewayWhitelistPublishing.ToPublicId("anthropic/claude-sonnet-4"));
        // 版本后缀是不同的模型，不许一起剥掉
        Assert.Equal("gpt-4o-2024-08-06", GatewayWhitelistPublishing.ToPublicId("openai/gpt-4o-2024-08-06"));
        // 剥完不合法就返回空，让调用方跳过而不是写一条建不出来的记录
        Assert.Equal(string.Empty, GatewayWhitelistPublishing.ToPublicId("openai/"));
        Assert.Equal(string.Empty, GatewayWhitelistPublishing.ToPublicId("   "));

        // 源码侧：剥的是最后一段，不是第一个斜杠
        Assert.Contains("LastIndexOf('/')", Publishing);
    }

    [Fact]
    public void 多模态模型判成生图而不是对话()
    {
        // 顺序是判据不是偏好：同时声明 image_generation 与 chat 时判成对话，
        // 会拿它当对话模型调度，请求带着错误入参打到生图端点。宁可窄不可宽。
        Assert.Equal("generation", GatewayWhitelistPublishing.ResolveModelType(new[] { "chat", "image_generation" }));
        Assert.Equal("video-gen", GatewayWhitelistPublishing.ResolveModelType(new[] { "chat", "video_generation" }));
        Assert.Equal("embedding", GatewayWhitelistPublishing.ResolveModelType(new[] { "embedding" }));
        // 认不出落到 chat：这是唯一一个猜错也只是少个可选项的落点
        Assert.Equal("chat", GatewayWhitelistPublishing.ResolveModelType(new[] { "wat" }));
        Assert.Equal("chat", GatewayWhitelistPublishing.ResolveModelType(System.Array.Empty<string>()));
    }

    [Fact]
    public void 对外模型清单已接上线且凭key过滤()
    {
        // 接线：建了没人调等于没做
        Assert.Contains("app.MapGet(\"/v1/models\"", Serving);
        Assert.Contains("app.MapGet(\"/v1/models/{modelId}\"", Serving);
        Assert.Contains("GatewayModelCatalogEndpoint.BuildAsync", Serving);

        // 列清单同样要凭 key：白名单本身就是授权面，匿名可读等于白送
        Assert.Contains("path.Equals(\"/v1/models\", StringComparison.OrdinalIgnoreCase)", Serving);

        // 租户身份只能来自已验证的授权上下文，不许读请求自报的字段
        Assert.Contains("GetVerifiedTenantId(http)", Serving);
        Assert.Contains("ResolveVerifiedAppCaller(http", Serving);
    }

    [Fact]
    public void 对外清单按线路逐条报价且非美金不当美金报()
    {
        // 不折算成一个统一价：走官网和走中转单价不同，取平均会让对方算出来的账对不上
        Assert.Contains("[\"routes\"] = pricedRoutes", Catalog);
        Assert.Contains("[\"currency\"] = \"USD\"", Catalog);
        // 非美金的价整条跳过，不按美金报——差一个数量级
        Assert.Contains("!string.Equals(currency.AsString, \"USD\", StringComparison.OrdinalIgnoreCase)", Catalog);
        // 一条都算不出价时写 null 而不是省略：省略读起来像免费
        Assert.Contains("pricedRoutes.Count == 0\n                ? null", Catalog.Replace("\r\n", "\n"));
        // 授权范围非空时必须点名命中，且没带 appCaller 只回不限授权的那部分
        Assert.Contains("x.AllowedAppCallerCodes.Count == 0", Catalog);
        Assert.Contains("x.AllowedAppCallerCodes.Contains(appCallerCode", Catalog);
        // 没有可用线路的模型不列出来，列了就是让对方白调一次
        Assert.Contains("logicalRoutes.Count == 0", Catalog);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }
}
