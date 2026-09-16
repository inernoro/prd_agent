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

        // 但 vision 是例外：带图对话走的就是 /v1/chat/completions，入参兼容，
        // 判成 vision 只会让它接不了最常用的那类请求（gpt-4o 正是 chat+vision）。
        // 而 PublicId 跨用途唯一，同一个标识补不出第二条 chat 的。
        Assert.Equal("chat", GatewayWhitelistPublishing.ResolveModelType(new[] { "chat", "vision" }));
        Assert.Equal("vision", GatewayWhitelistPublishing.ResolveModelType(new[] { "vision" }));
        // 生图那条仍然压过一切：它的入参真的不兼容。
        Assert.Equal("generation", GatewayWhitelistPublishing.ResolveModelType(new[] { "chat", "vision", "image_generation" }));
    }

    [Fact]
    public void 对外模型清单已接上线且凭key过滤()
    {
        // 接线：建了没人调等于没做
        Assert.Contains("app.MapGet(\"/v1/models\"", Serving);
        // catch-all 而不是单段：PublicId 允许斜杠（创建端点的字符集里有 `/`，
        // 清单也会把 vendor/model 这样的标识列出去），单段路由接不住它——
        // 字面斜杠会被当成另一个路径段直接 404，清单里列得出来的模型有一部分取不回来。
        Assert.Contains("app.MapGet(\"/v1/models/{**modelId}\"", Serving);
        // 百分号编码的斜杠不会被 Kestrel 当分段，原样落到处理函数，也要认。
        Assert.Contains("Uri.UnescapeDataString(modelId)", Serving);
        Assert.Contains("GatewayModelCatalogEndpoint.BuildAsync", Serving);

        // 列清单同样要凭 key：白名单本身就是授权面，匿名可读等于白送
        Assert.Contains("path.Equals(\"/v1/models\", StringComparison.OrdinalIgnoreCase)", Serving);

        // 租户身份只能来自已验证的授权上下文，不许读请求自报的字段
        Assert.Contains("GetVerifiedTenantId(http)", Serving);
        Assert.Contains("ResolveVerifiedAppCaller(http", Serving);
    }

    /// <summary>
    /// 手工新增一个模型，也要登上白名单，而且走的是和批量导入同一个函数。
    ///
    /// 池路由已经删了，调用方按**公开模型名**请求，找的是对外模型 + 线路。
    /// 只把模型写进 llmgw_models、再同步进托管默认池，得到的是一个库里看得见、
    /// 界面报「已保存」、却怎么也调不通的模型——链路只建了一半，而且不会有任何东西变红。
    ///
    /// 两个入口共用一个函数，是为了让发布规则（公开名怎么算、用途怎么判、跨用途怎么拒）
    /// 只有一份：各写一份的话，下一次改规则只会改到其中一份，谁赢取决于用户从哪个入口进来。
    /// </summary>
    [Fact]
    public void 手工新增的模型也登白名单且与批量导入共用一份发布规则()
    {
        // 发布规则只有一处实现
        Assert.Contains("static async Task<(string PublicId, bool CreatedLogical, bool LinkedToExisting, string? CrossTypeConflict)?>", Console);
        Assert.Contains("PublishGatewayModelToWhitelistAsync(", Console);

        // 两个入口都调它：批量导入 + 手工新增
        var callSites = System.Text.RegularExpressions.Regex.Matches(
            Console, @"await PublishGatewayModelToWhitelistAsync\(").Count;
        Assert.True(callSites >= 2, $"发布函数只有 {callSites} 个调用点，两个入口应各有一个");

        // 手工新增那条路自己也得调，而不是只有批量导入调
        var createStart = Console.IndexOf("app.MapPost(\"/gw/models\"", StringComparison.Ordinal);
        Assert.True(createStart > 0);
        var createEnd = Console.IndexOf("app.MapPut(\"/gw/platforms/{id}/enabled\"", createStart, StringComparison.Ordinal);
        Assert.True(createEnd > createStart, "单模型新增端点的边界变了，守卫取值口径需要更新");
        var createBody = Console[createStart..createEnd];
        Assert.Contains("await PublishGatewayModelToWhitelistAsync(", createBody);

        // 没登上时要如实说，而不是只报「已保存」。
        // 模型本身不回滚——它是有效配置，删掉更糟；但那句话必须给出下一步。
        Assert.Contains("WhitelistMessage", Console);
        Assert.Contains("模型白名单", createBody);

        var page = ReadRepoFile("llmgw/web/src/pages/ModelsPage.tsx");
        Assert.Contains("whitelistMessage", page);
        Assert.Contains("publicId", page);
    }

    [Fact]
    public void 列模型要的是读权限不是调用权限()
    {
        // 2026-09-14 在 CDS 上真打一次才发现的：/v1/models 原先落到 ResolveRequiredScope 的
        // 默认分支 invoke，权限判反了——一把只读的发现型 key（只有 route:read）列不出可用
        // 模型，反而必须给能花钱的 invoke 才行。它和 /gw/v1/pools、/gw/v1/image-models
        // 是同一件事：列出有什么。
        var start = Serving.IndexOf("private static string ResolveRequiredScope(string path)", StringComparison.Ordinal);
        Assert.True(start >= 0);
        var end = Serving.IndexOf("return \"invoke\";", start, StringComparison.Ordinal);
        Assert.True(end > start, "ResolveRequiredScope 的兜底分支变了，守卫取值口径需要更新");
        var body = Serving[start..end];

        // 必须在落到 invoke 兜底**之前**就判成 route:read
        Assert.Contains("path.Equals(\"/v1/models\", StringComparison.OrdinalIgnoreCase)", body);
        Assert.Contains("path.StartsWith(\"/v1/models/\", StringComparison.OrdinalIgnoreCase)", body);
        Assert.Contains("return \"route:read\";", body);

        // 而且要排在按子串判的那几条**之前**。模型 id 是用户可控的、允许带斜杠
        // （名录里确实有 vendor/model 这种公开名），排在后面的话一个叫 vendor/raw-model
        // 或 vendor/images/foo 的合法模型，取详情时会被子串判成 raw:invoke——
        // 一把只有 route:read 的发现型 key 列得出它、却取不到它的详情。
        // 这与 requestId 那条是同一个道理：用户输入不许参与子串匹配。
        var modelsRouteAt = body.IndexOf("path.StartsWith(\"/v1/models/\"", StringComparison.Ordinal);
        var rawSubstringAt = body.IndexOf("path.Contains(\"/raw\"", StringComparison.Ordinal);
        Assert.True(rawSubstringAt > 0, "按子串判 /raw 的那条不见了，守卫取值口径需要更新");
        Assert.True(
            modelsRouteAt < rawSubstringAt,
            "取模型详情必须排在按子串判 /raw、/images/ 之前，否则带这两个字样的合法模型 id 会被判成 raw:invoke");
    }

    /// <summary>
    /// 兼容入口不接受客户端自带的「钉住某个上游」字段。
    ///
    /// 这两个字段是内部调度语义：绕过对外模型目录，按平台 id + 模型 id 直取上游。
    /// 池退场之前，池成员检查恰好是它的调用方边界——pin 指到的成员必须在这个 appCaller
    /// 获准的池里。池删掉之后那道边界跟着没了，而 TryResolvePinnedModelAsync 只验
    /// 「平台与模型在本租户启用」：一把绑定某个 appCaller 的服务密钥，只要知道内部 id
    /// 就能调本租户任何启用的物理模型，越过了它自己的授权名单。
    ///
    /// 拒绝而不是静默忽略：忽略会让对方以为自己钉住了某个上游，实际走的是另一条路。
    /// 内部那条路（/gw/v1/*，gw-native）不受影响。
    /// </summary>
    [Fact]
    public void 兼容入口拒绝客户端自带的钉住上游字段()
    {
        var endpoints = Serving;

        // 判据函数改名成「拒绝」，语义写进名字里——留着 Resolve 这个名字，下一个人会以为它还在取值
        Assert.Contains("RejectClientSuppliedPinnedTarget", endpoints);
        Assert.DoesNotContain("ResolveCompatPinnedTarget", endpoints);

        // 拒绝要给专属错误码，方便对方定位；不是笼统的 invalid_json
        Assert.Contains("\"pinned_target_not_allowed\"", endpoints);

        // 六个兼容入口逐个都要拒。少一个就是留了一扇后门，而它不会红。
        var rejections = System.Text.RegularExpressions.Regex.Matches(
            endpoints, @"RejectClientSuppliedPinnedTarget\(http,").Count;
        Assert.True(rejections >= 6,
            $"每个兼容入口都要拒绝客户端自带的 pin，当前只有 {rejections} 处");

        // 拒完之后不许再把客户端的值往下传
        Assert.DoesNotContain("PinnedPlatformId = pinnedPlatformId", endpoints);
    }

    [Fact]
    public void 对外清单按线路逐条报价且非美金不当美金报()
    {
        // 不折算成一个统一价：走官网和走中转单价不同，取平均会让对方算出来的账对不上
        Assert.Contains("[\"routes\"] = pricedRoutes", Catalog);
        Assert.Contains("[\"currency\"] = \"USD\"", Catalog);
        // 只有**显式** USD 才报价。判据原先写成「是字符串且不是 USD 才跳过」，
        // 于是缺币种、null、存成非字符串的那几种全都落进了报价这一支，
        // 而 pricing 段的 label 是写死的 USD——那些数字实际可能是人民币，
        // 对方拿去算账差一个数量级。缺价是看得见的，报错价不是。
        Assert.Contains("!currency.IsString", Catalog);
        Assert.Contains("!string.Equals(currency.AsString.Trim(), \"USD\", StringComparison.OrdinalIgnoreCase)", Catalog);
        // 一条都算不出价时写 null 而不是省略：省略读起来像免费
        Assert.Contains("pricedRoutes.Count == 0\n                ? null", Catalog.Replace("\r\n", "\n"));
        // 授权范围非空时必须点名命中，且没带 appCaller 只回不限授权的那部分
        Assert.Contains("x.AllowedAppCallerCodes.Count == 0", Catalog);
        Assert.Contains("x.AllowedAppCallerCodes.Contains(appCallerCode", Catalog);
        // 没有可用线路的模型不列出来，列了就是让对方白调一次
        Assert.Contains("logicalRoutes.Count == 0", Catalog);

        // via 不许回落到内部 Mongo id：对外没有意义，也不该泄露我们的标识
        Assert.DoesNotContain("[\"via\"] = route.UpstreamModelId ?? route.TargetId", Catalog);
        Assert.Contains("model.GetValue(\"ModelName\"", Catalog);
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
