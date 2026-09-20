using System.Text.RegularExpressions;
using MongoDB.Bson;
using PrdAgent.Infrastructure.LlmGateway;
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
    public void 公开模型名只在名录认得出来时才剥供应商前缀()
    {
        /*
          名录登记过的前缀写法要收敛：openai/gpt-4o 与 gpt-4o 必须落到同一个公开名，
          否则从官网导一次、从中转再导一次，白名单里就是两个条目，多来源永远合不起来。

          但**不许无条件剥**。上一版对任何带斜杠的名字都取最后一段，于是管理员显式导入一个
          名录外的 private-provider/gpt-4o 会被算成公开名 gpt-4o，发布那一步按这个公开名找到
          已存在的那条 gpt-4o、用途又恰好相同，就把这个私有上游当成它的又一条线路挂上去——
          普通 gpt-4o 流量从此可能落到一个毫不相干的上游（第 70 轮 review）。

          判据与 ModelCatalog.Find 完全一致（它的注释自己就写着「private-provider/gpt-4o
          必须查不到」），而且是**直接问它**，不是照着它再写一遍。
        */
        Assert.Equal("gpt-4o", GatewayWhitelistPublishing.ToPublicId("openai/gpt-4o"));
        Assert.Equal("gpt-4o", GatewayWhitelistPublishing.ToPublicId("gpt-4o"));

        // 名录外的厂商段一律整串保留：宁可多出一条 private-provider/gpt-4o，
        // 也不要把它混进别人的模型里。
        Assert.Equal("private-provider/gpt-4o", GatewayWhitelistPublishing.ToPublicId("private-provider/gpt-4o"));
        // 拼出来的组合同样不认——openai 与 claude-3-opus 各自登记过，合在一起没人登记过。
        Assert.Equal("openai/claude-3-opus", GatewayWhitelistPublishing.ToPublicId("openai/claude-3-opus"));

        // 剥完不合法就返回空，让调用方跳过而不是写一条建不出来的记录
        Assert.Equal(string.Empty, GatewayWhitelistPublishing.ToPublicId("openai/"));
        Assert.Equal(string.Empty, GatewayWhitelistPublishing.ToPublicId("   "));

        // 判据只有一份：这里不许再出现自己剥前缀的写法
        Assert.Contains("ModelCatalog.Find(name, catalogOverrides)", Publishing);
        Assert.DoesNotContain("name[(slash + 1)..]", Publishing);
    }

    [Fact]
    public void 多模态模型判成生图而不是对话()
    {
        // 顺序是判据不是偏好：同时声明 image_generation 与 chat 时判成对话，
        // 会拿它当对话模型调度，请求带着错误入参打到生图端点。宁可窄不可宽。
        Assert.Equal("generation", GatewayWhitelistPublishing.TryResolveModelType(new[] { "chat", "image_generation" }));
        Assert.Equal("video-gen", GatewayWhitelistPublishing.TryResolveModelType(new[] { "chat", "video_generation" }));
        Assert.Equal("embedding", GatewayWhitelistPublishing.TryResolveModelType(new[] { "embedding" }));
        // 认不出落到 chat：这是唯一一个猜错也只是少个可选项的落点
        // 认不出来就回 null，不兜底成 chat。
        //
        // 兜底成 chat 的那一版写着「猜错也只是少了个可选项」，而这条路正是
        // 「管理员放行名录外模型」的出口——那类模型提交上来的能力常常是空的。
        // publish 成 chat 之后它就是一个货真价实的对话模型：普通对话调用方不要求任何
        // 场景能力，于是它会被列出、被选中、按对话契约调走，而那个上游可能是生图或视频。
        Assert.Null(GatewayWhitelistPublishing.TryResolveModelType(new[] { "wat" }));
        Assert.Null(GatewayWhitelistPublishing.TryResolveModelType(System.Array.Empty<string>()));
        // 明说自己是对话模型的才判对话
        Assert.Equal("chat", GatewayWhitelistPublishing.TryResolveModelType(new[] { "chat" }));

        // 但 vision 是例外：带图对话走的就是 /v1/chat/completions，入参兼容，
        // 判成 vision 只会让它接不了最常用的那类请求（gpt-4o 正是 chat+vision）。
        // 而 PublicId 跨用途唯一，同一个标识补不出第二条 chat 的。
        Assert.Equal("chat", GatewayWhitelistPublishing.TryResolveModelType(new[] { "chat", "vision" }));
        Assert.Equal("vision", GatewayWhitelistPublishing.TryResolveModelType(new[] { "vision" }));
        // 生图那条仍然压过一切：它的入参真的不兼容。
        Assert.Equal("generation", GatewayWhitelistPublishing.TryResolveModelType(new[] { "chat", "vision", "image_generation" }));
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
        Assert.Contains("static async Task<(string PublicId, bool CreatedLogical, bool LinkedToExisting, string? BlockedKind, string? BlockedMessage)?>", Console);
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

    /// <summary>
    /// 对外清单要过名录门：运行时会拒的，这里就不该列出来。
    ///
    /// 名录门拦的是绕过控制台进来的模型（直接写库、历史遗留、别的写入方）。那种模型
    /// 启用着、平台也启用着，可用判据一条都拦不住，于是被当成可调的发布出去；
    /// 真调用时回 MODEL_NOT_IN_CATALOG。对方照着清单调一次必然失败——
    /// 而这个端点的注释自己写着「列出来就是让对方白调一次」。
    ///
    /// 「要不要拦」必须与运行时同源：配置降到 observe、或补标记迁移没跑完时，
    /// 运行时只记录不拦，这里也不能少列，否则从漏判走到了误判。
    /// </summary>
    [Fact]
    public void 对外清单与运行时共用名录门的判据()
    {
        var endpoint = ReadRepoFile("llmgw/serving/GatewayModelCatalogEndpoint.cs");

        // 判据与生效条件都取自那一份共享实现，端点自己不再复述一遍。
        //
        // 这里刻意**不**断言 GatewayModelCatalog.Contains 之类的具体调用：那是在要求判据
        // 长成某个样子，而要钉住的是「两边用的是同一份」。判据后来收进 GatewayCatalogGate
        // 时，端点里那几个调用一个都不剩，而不变量完好无损——按字面量写的守卫会在这种时候
        // 变红，那种红说的是实现变了，不是契约破了（形状 4a）。
        Assert.Contains("GatewayCatalogGate.EnforcesAsync", endpoint);
        // 两类目标各有各的入口，但判据都在共享那一份里：
        // 物理线路按它实际会打出去的那个模型名判（线路可以用 UpstreamModelId 覆盖），
        // 兑换所线路判到别名这一层。都不在这个文件里自己拼判据。
        Assert.Contains("GatewayCatalogGate.PhysicalRoutePasses(", endpoint);
        Assert.Contains("GatewayCatalogGate.ExchangeRoutePasses(", endpoint);

        // 端点不许自己再判一遍「配置是不是 observe」「迁移跑完没有」——判据分家就是从这里开始的。
        Assert.DoesNotContain("\"observe\", StringComparison.OrdinalIgnoreCase", endpoint);
        Assert.DoesNotContain("GatewayCatalogMigrations.RequiredIds", endpoint);

        // 应用侧那条清单（选择器读的那份）是同类，也要过这道门：
        // 少了它，选择器里列出来的模型选中即失败（MODEL_NOT_IN_CATALOG），而用户没做错任何事。
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        var listStart = resolver.IndexOf("GetAvailableLogicalModelsAsPoolsAsync", StringComparison.Ordinal);
        Assert.True(listStart > 0);
        var listEnd = resolver.IndexOf("private async Task<ModelResolutionResult?> TryResolveLogicalModelAsync", listStart, StringComparison.Ordinal);
        Assert.True(listEnd > listStart, "应用侧清单的边界变了，守卫取值口径需要更新");
        var listBody = resolver[listStart..listEnd];
        Assert.Contains("CatalogVerdict.Blocked", listBody);
        Assert.Contains("CatalogGateEnforcesAsync", listBody);
    }

    /// <summary>
    /// serving 的 readiness 也要认「对外模型」这条路，不能只按池算。
    ///
    /// 池退场之后，正确迁移的部署一个池都不绑——不点名的请求由认领或用途默认接住。
    /// 而 router 组件只按池数判可路由，于是对一个完全健康的部署报 503、被编排摘掉。
    /// 判据没跟上现实，灯就开始说谎（与 2026-08-13 那次同形，只是反了个方向）。
    /// </summary>
    [Fact]
    public void serving就绪探针认对外模型这条路()
    {
        var probe = ReadRepoFile("llmgw/serving/GatewayServingReadinessProbe.cs");
        var start = probe.IndexOf("private async Task<GatewayServingReadinessComponent> CheckRouterAsync", StringComparison.Ordinal);
        Assert.True(start > 0);
        var end = probe.IndexOf("private async Task<GatewayServingReadinessComponent> CheckScenarioCapabilityAsync", start, StringComparison.Ordinal);
        Assert.True(end > start, "router 组件的边界变了，守卫取值口径需要更新");
        var body = probe[start..end];

        Assert.Contains("HasLogicalCatcher", body);

        // 两层同序：先认领、后用途默认。
        // 取值范围必须收在 HasLogicalCatcher 里——router 组件上半段查旧池默认时也会出现
        // IsDefaultForType，拿整段找会匹配到池那一侧，判出来的先后与要测的东西无关。
        var catcherAt = body.IndexOf("bool HasLogicalCatcher", StringComparison.Ordinal);
        Assert.True(catcherAt > 0);
        var catcherBody = body[catcherAt..];
        var claimAt = catcherBody.IndexOf("DefaultForAppCallerCodes", StringComparison.Ordinal);
        var typeDefaultAt = catcherBody.IndexOf("IsDefaultForType", StringComparison.Ordinal);
        Assert.True(claimAt > 0 && typeDefaultAt > claimAt, "就绪探针的两层判据必须与运行时同序");
        // 池那条已经删了：运行时的解析主流程里没有任何池分支，判据留着它就是替一条死路作保。
        // 现在「可路由」只有对外模型这一条路，反向钉住池不许回来。
        Assert.DoesNotContain("IsCallerRoutable", body);
        Assert.DoesNotContain("ModelGroup", body);
    }

    /// <summary>
    /// 对外报价与实际计价必须同一个口径：有按次价时只报按次价。
    ///
    /// 计价那一侧在有按次价时完全不看 token 单价。清单若把两套价一起报出去，
    /// 对方读到的是「两种都收」，按它估出来的费用比实际高——清单与账单说的是两件事，
    /// 而两份不同口径的数字里必然有一份是假的。
    /// </summary>
    [Fact]
    public void 对外报价与计价同口径_按次计费不报token单价()
    {
        var endpoint = ReadRepoFile("llmgw/serving/GatewayModelCatalogEndpoint.cs");
        var start = endpoint.IndexOf("var routeNode = new JsonObject", StringComparison.Ordinal);
        Assert.True(start > 0);
        var end = endpoint.IndexOf("pricedRoutes.Add(routeNode);", start, StringComparison.Ordinal);
        Assert.True(end > start);
        var block = endpoint[start..end];

        var callAt = block.IndexOf("routeNode[\"call\"]", StringComparison.Ordinal);
        var promptAt = block.IndexOf("routeNode[\"prompt\"]", StringComparison.Ordinal);
        Assert.True(callAt > 0 && promptAt > callAt,
            "token 单价必须落在 perCall 的 else 分支里，不能与按次价并列报出去");
        Assert.Contains("else", block);
    }

    /// <summary>
    /// 「已导入」与「已登上白名单」是两件事，界面要分开，且未登记的仍可再导一次。
    ///
    /// 能力认不出来的模型会被导入成物理模型、却不登白名单。若这一屏把「已导入」的行
    /// 整个禁选，服务端给的那句「补完能力再导一次」就没法照做——自己给出、自己堵死的路。
    /// 导入本身幂等（已存在的走 Skipped，只补名单），所以重勾一次是安全的。
    /// </summary>
    [Fact]
    public void 已导入但没登上白名单的模型仍能再导一次补登()
    {
        // 后端把两件事分开报，判据是「有没有线路指向这个物理模型」
        Assert.Contains("AlreadyPublished", Console);
        Assert.Contains("publishedTargetIds", Console);
        Assert.Contains("fb.Eq(\"TargetKind\", \"model\")", Console);

        // 界面据此放行选择，并把状态说清楚
        var setup = ReadRepoFile("llmgw/web/src/components/ProviderSetup.tsx");
        Assert.Contains("needsRegistration", setup);
        Assert.Contains("已导入·未登记", setup);
        Assert.DoesNotContain("const disabled = m.alreadyImported || blocked;", setup);
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

    /// <summary>
    /// 兑换所线路能不能列进对外清单，判据要与运行时同一份。
    ///
    /// 只判兑换所文档启用是不够的：线路真正打给上游的是哪一个别名由 UpstreamModelId 决定
    /// （没写就回落到兑换所主别名）。管理员把一条别名从兑换所里摘掉之后，兑换所照样启用着，
    /// 而运行时按名录门把这条别名判死——清单于是列出一个「选中即失败」的模型。
    /// </summary>
    [Fact]
    public void 对外清单的兑换所线路要判到别名这一层()
    {
        var endpoint = ReadRepoFile("llmgw/serving/GatewayModelCatalogEndpoint.cs");

        // 判据取自共享那一份，端点不自己写「别名在不在」。
        Assert.Contains("GatewayCatalogGate.ExchangeRoutePasses", endpoint);
        // 判的是这条线路的上游别名，不只是兑换所 id。
        Assert.Contains("route.UpstreamModelId", endpoint);

        // 运行时那一侧也走同一份，两处不许各写各的。
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        Assert.Contains("GatewayCatalogGate.ExchangeDeclares", resolver);
        Assert.Contains("GatewayCatalogGate.ExchangeAliasAllowedOutsideCatalog", resolver);

        // 回落口径必须一致：线路没写覆盖时运行时会用兑换所主别名，判据也得认这个回落，
        // 否则「线路没写覆盖」这一种输入就整个绕过了这道门。
        var gate = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayCatalogGate.cs");
        Assert.Contains("EffectiveExchangeModelId", gate);
        Assert.Contains("exchange.ModelAlias", gate);
    }

    /// <summary>
    /// 对外报价要覆盖计价真的会收的每一档，缓存写入那一档不许漏。
    ///
    /// 计价侧按 CacheWritePricePerMillion 真的收 cache-creation token 的钱（没配就按输入全价算）。
    /// 清单不报它，对方照这份报价估出来的费用会系统性地少一截——提示词缓存正是
    /// 「第一次写贵、后面读便宜」的形状，漏掉写入那一半估出来的数最不准。
    /// </summary>
    [Fact]
    public void 对外报价覆盖缓存写入那一档()
    {
        var endpoint = ReadRepoFile("llmgw/serving/GatewayModelCatalogEndpoint.cs");
        Assert.Contains("CacheWritePricePerMillion", endpoint);
        Assert.Contains("cache_write", endpoint);

        // 报的是**实际会收的那个数**：计价侧的口径是「缓存价 ?? 输入全价」，
        // 没配缓存价不等于缓存免费，只等于按提示词价收。清单只在显式配过时才报的话，
        // 一个没配缓存价的模型对外看起来是「缓存不收费」，而每个缓存 token 都在计费。
        // 两档缓存价都要回落，只做其中一档就是同一个洞换个位置。
        Assert.Contains("var effectiveCacheRead = cached ?? prompt;", endpoint);
        Assert.Contains("var effectiveCacheWrite = cacheWrite ?? prompt;", endpoint);

        // 计价那一侧确实按它收钱——两边说的是同一件事，守卫才有意义。
        var calculator = ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayCostCalculator.cs");
        Assert.Contains("cacheWritePricePerMillion", calculator);

        // 按次计费时一档 token 价都不报，缓存写入也在这条规矩里（在 else 分支内）。
        var perCallAt = endpoint.IndexOf("routeNode[\"call\"]", StringComparison.Ordinal);
        var cacheWriteAt = endpoint.IndexOf("routeNode[\"cache_write\"]", StringComparison.Ordinal);
        Assert.True(perCallAt > 0 && cacheWriteAt > perCallAt,
            "缓存写入价必须落在「不是按次计费」那一支里，否则按次模型会同时报出两套价");
    }

    /// <summary>
    /// Quickstart 的模型选择器只列真的会被用上的模型，修复入口要指向还活着的页面。
    ///
    /// 「有一条线路 enabled」不等于「这条线路会被用上」：熔断中、指向已停用物理模型或兑换所的
    /// 线路照样 enabled。服务端已经按唯一那份排队判据算好了名次，前端读它就行，不自己重写。
    /// 而修复入口指着 /pools——那个地址现在无条件重定向，按钮上写着「打开模型池」，
    /// 点过去是另一个页面，名录补登那一屏根本没被指出来。
    /// </summary>
    [Fact]
    public void Quickstart只列可用模型且修复入口指向活着的页面()
    {
        var page = ReadRepoFile("llmgw/web/src/pages/QuickstartPage.tsx");

        // 候选按服务端算好的排队名次筛，不是只看 enabled。
        Assert.Contains("route.queuePosition > 0", page);

        // 修复入口不许再指 /pools（它已经是一个重定向）。
        Assert.DoesNotContain("to: '/pools'", page);
        Assert.Contains("to: '/logical-models'", page);
        Assert.Contains("to: '/platforms'", page);

        // /pools 仍然是重定向，这条守卫的前提才成立。
        var app = ReadRepoFile("llmgw/web/src/App.tsx");
        Assert.Contains("path=\"/pools\" element={<Navigate to=\"/logical-models\"", app);

        // 管理员侧的处置提示同样不许停在池的世界里。
        var failure = ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayRouteFailure.cs");
        Assert.DoesNotContain("AllowedModelPoolIds", failure);
        Assert.DoesNotContain("为该 appCaller 绑定模型池", failure);
    }

    /// <summary>
    /// 兼容入口（raw）这条路也要把缓存 token 读出来，否则计价必然失真。
    ///
    /// 两头都不是小数：OpenAI 把命中缓存的部分**含在** prompt_tokens 里，不读出来就按输入
    /// 全价收，账比实际高；Anthropic 分三个数报，不读出来那两截直接不进账，账比实际低。
    /// 而预算闸读的就是 EstimatedCostUsd。
    /// </summary>
    [Fact]
    public void 兼容入口也解析缓存token()
    {
        var parser = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/RawGatewayUsageParser.cs");

        // 三家协议的字段名都要认，少认一家就是那一家的账错。
        foreach (var field in new[]
                 {
                     "cache_read_input_tokens",
                     "cache_creation_input_tokens",
                     "cached_tokens",
                     "cachedContentTokenCount",
                 })
        {
            Assert.Contains(field, parser);
        }

        // 读出来还要真的接进计价与落库，不然就是读了个寂寞（形状 2：链路只建一半）。
        var gateway = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs");
        Assert.Contains("CacheReadInputTokens = rawUsage.CacheReadInputTokens", gateway);
        Assert.Contains("CacheCreationInputTokens = rawUsage.CacheCreationInputTokens", gateway);
        Assert.DoesNotContain("CacheCreationInputTokens: null,", gateway);
    }

    /// <summary>
    /// 探针的两层挑选要与运行时同序同语义：先按认领选出那一条，再看它能不能用。
    ///
    /// 反过来做（先筛掉没有可用线路的，再找认领）会让「认领了这个调用方、但线路全挂」的模型
    /// 从候选里消失，判据接着挑中一个健康的用途默认并报绿——而运行时按认领选中前者、
    /// 解析不出来就如实失败，**不会**回头去试用途默认。
    /// </summary>
    [Fact]
    public void 探针先按认领挑再看它能不能用()
    {
        var probe = ReadRepoFile("llmgw/serving/GatewayServingReadinessProbe.cs");
        var start = probe.IndexOf("private static bool HasLogicalCatcher", StringComparison.Ordinal);
        Assert.True(start > 0);
        var body = probe[start..];

        // 候选集合按用途取全量，**不**在这里先按可用性筛。
        var sameTypeAt = body.IndexOf("var sameType = view.EnabledLogicalModels", StringComparison.Ordinal);
        var claimAt = body.IndexOf("DefaultForAppCallerCodes", StringComparison.Ordinal);
        var usableAt = body.IndexOf("view.RoutableLogicalModelIds.Contains", StringComparison.Ordinal);
        Assert.True(sameTypeAt > 0 && claimAt > sameTypeAt, "认领要在同用途全量里挑");
        Assert.True(usableAt > sameTypeAt, "可用性判定不能排在挑选之前");

        // 排序与运行时一致：存量里万一有两条，两边取的必须是同一条。
        Assert.Contains("OrderBy(x => x.DisplayOrder)", body);
        Assert.Contains("ThenBy(x => x.PublicId, StringComparer.Ordinal)", body);
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        Assert.Contains("SortBy(x => x.DisplayOrder).ThenBy(x => x.PublicId)", resolver);
    }

    /// <summary>
    /// 兑换所里被单独停掉的那条别名，不许还被当成可用。
    ///
    /// 兑换所整体启用着，不代表里面每一条别名都开着。只判 Exchange.Enabled 的话，
    /// 线路继续往一条被关掉的别名上发流量，而目录与就绪判据都说它可用——
    /// 「关了等于没关」，比没有这个开关更糟。
    /// </summary>
    [Fact]
    public void 被停掉的兑换所别名不算数()
    {
        var gate = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayCatalogGate.cs");

        // 取那条别名的地方只有一处，启用判定长在它身上——两处各查一次迟早有一处忘了判。
        Assert.Contains("private static ExchangeModel? FindDeclared(", gate);
        Assert.Contains("item.Enabled && string.Equals(item.ModelId, modelId", gate);
        var declaresAt = gate.IndexOf("public static bool ExchangeDeclares(", StringComparison.Ordinal);
        var allowedAt = gate.IndexOf("public static bool ExchangeAliasAllowedOutsideCatalog(", StringComparison.Ordinal);
        Assert.True(declaresAt > 0 && allowedAt > 0);
        Assert.Contains("FindDeclared(exchange, modelId)", gate[declaresAt..]);
        Assert.Contains("FindDeclared(exchange, modelId)", gate[allowedAt..]);

        // 解析那一侧也要判：名录门降档时它是唯一还在看这件事的地方。
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        Assert.Contains("requireEnabled && !GatewayCatalogGate.ExchangeDeclares(exchange, item.ModelId)", resolver);

        // 旧形态合成出来的别名一律启用，这条改动不影响它们。
        var accessors = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/ModelExchange.cs");
        Assert.Contains("Enabled = true", accessors);
    }

    /// <summary>
    /// 「这条模型能不能记账」要按计价那一侧真正的口径判，不是「配了一项就算」。
    ///
    /// 只配了输入单价的对话模型，按「配了任意一项」会被标成可计费、模型页于是不显示
    /// 那句「不计入限额」的提醒，而它的每一次正常调用都因为缺输出单价被判 unpriced——
    /// 界面说算得出钱，账上一分没有。
    /// </summary>
    [Fact]
    public void 可计费判的是价格配齐而不是配了一项()
    {
        var policy = ReadRepoFile("llmgw/console-api/Provisioning/PricingPolicy.cs");

        Assert.Contains("public static bool HasCompletePrice(", policy);
        // 有按次价就够（计价那一侧按次时完全不看 token 单价）；否则输入与输出两个都要有。
        Assert.Contains("pricePerCall is not null\n           || (inputPricePerMillion is not null && outputPricePerMillion is not null)", policy);
        // 可计费走配齐那条，不再走「配了任意一项」。
        var billableAt = policy.IndexOf("public static bool IsBillable(", StringComparison.Ordinal);
        Assert.True(billableAt > 0);
        Assert.Contains("HasCompletePrice(inputPricePerMillion, outputPricePerMillion, pricePerCall)", policy[billableAt..]);

        // 计价那一侧的口径没变：按次只按次算，token 那几档逐项要求单价。
        var calculator = ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayCostCalculator.cs");
        Assert.Contains("if (billableInput > 0 && inputPrice is null) missing.Add", calculator);
        Assert.Contains("if (outputTokens > 0 && outputPrice is null) missing.Add", calculator);
    }

    /// <summary>
    /// 同一个模式上，租户自己的生图契约要盖过平台级那条，而不是看 Mongo 的返回顺序。
    /// </summary>
    [Fact]
    public void 生图契约租户的盖过平台级()
    {
        var worker = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigSyncWorker.cs");
        Assert.Contains("ThenBy(x => string.IsNullOrEmpty(x.TenantId) ? 1 : 0)", worker);
        // 作用域优先级要排在模式长度之前：长度只决定「哪个更具体」，决定不了「谁的」。
        var scopeAt = worker.IndexOf("string.IsNullOrEmpty(x.TenantId) ? 1 : 0", StringComparison.Ordinal);
        var lengthAt = worker.IndexOf("ThenByDescending(x => x.ModelIdPattern.Trim().Length)", StringComparison.Ordinal);
        Assert.True(scopeAt > 0 && lengthAt > scopeAt, "租户优先要排在模式长度之前");
    }

    /// <summary>
    /// 启动时不许丢掉正在生效的线路身份唯一索引。
    ///
    /// 丢一条正在生效的唯一索引再同步重建，在大集合上会阻塞写入、甚至让进程起不来；
    /// 两次操作之间失败一次就让那条不变量彻底失去保护。`no-auto-index` 规则禁的正是这个。
    /// 全新库直接建对的那条；已有旧版的如实报出来交给 DBA，在那之前旧索引继续生效——
    /// 它比新的更严，后果是「第二条别名建不出来」，会如实报错而不是静默走偏。
    /// </summary>
    [Fact]
    public void 启动不丢正在生效的线路身份索引()
    {
        var initializer = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/LlmGatewayDatabaseInitializer.cs");
        var start = initializer.IndexOf("private async Task EnsureOfferingIdentityIndexAsync", StringComparison.Ordinal);
        Assert.True(start > 0);
        var end = initializer.IndexOf("private static bool IsEquivalentOfferingIdentityIndex", start, StringComparison.Ordinal);
        Assert.True(end > start);
        var body = initializer[start..end];

        // 这一段里不许再丢索引。
        Assert.DoesNotContain("DropIndexIfPresentAsync", body);
        // 发现旧版要响铃，而且要给得出该跑什么——拒绝没有下一步等于把问题丢回去。
        Assert.Contains("LogWarning", body);
        Assert.Contains("dropIndex", body);
        Assert.Contains("doc/guide.platform.mongodb-indexes.md", body);
        /*
          这一段里也不许**建**索引（no-auto-index）。上一版只在「有旧索引」那条分支上返回，
          留着「全新库」那条去建——那个口子的理由是新库没有存量所以安全，可是「库其实不新、
          只是索引被误删了」长得一模一样。所以判据不再看分支：整段不许出现建索引。
        */
        Assert.DoesNotContain("Indexes.CreateOneAsync", body);
        Assert.DoesNotContain("Indexes.CreateManyAsync", body);
        // 两种缺口都要报出来：旧版索引还在、以及一条都没有。
        Assert.Contains("线路身份唯一索引还是旧版", body);
        Assert.Contains("线路身份唯一索引 {Expected} 不存在", body);

        // DBA 那一侧要查得到这条待办。
        var guide = ReadRepoFile("doc/guide.platform.mongodb-indexes.md");
        Assert.Contains("uniq_llmgw_offering_tenant_logical_target_v3", guide);
        Assert.Contains("UpstreamModelId", guide);
    }

    /// <summary>
    /// 对外报价要么配齐要么不报，与计价那一侧同口径。
    ///
    /// 只配了一半时，计价对一次正常调用判的是 unpriced——整笔算不出钱。清单若把那半边报出去，
    /// 对方会把缺的那一维当成免费，照它估出来的账系统性偏低，而这个端点的契约写着
    /// 「算不出就给 null」。
    /// </summary>
    [Fact]
    public void 对外报价要么配齐要么不报()
    {
        var endpoint = ReadRepoFile("llmgw/serving/GatewayModelCatalogEndpoint.cs");
        Assert.Contains("if (perCall is null && (prompt is null || completion is null)) continue;", endpoint);
        Assert.DoesNotContain("if (prompt is null && completion is null && perCall is null) continue;", endpoint);
    }

    /// <summary>
    /// 计费模式看**配没配**按次价，不看这一次收不收那笔固定费。
    ///
    /// 一次失败的、或按约定不收固定费的调用，callCost 是 null，而这条模型仍然是按次计费的。
    /// 从 callCost 反推模式就会在这种时候掉回按 token 收钱——恰恰违反这个方法自己写的规矩。
    /// </summary>
    [Fact]
    public void 计费模式看配没配按次价()
    {
        var calculator = ReadRepoFile("prd-api/src/PrdAgent.Core/LlmGateway/GatewayCostCalculator.cs");

        // 两处判定（合计与 Classify）都从 pricePerCall 推，不从 callCost 推。
        var derived = System.Text.RegularExpressions.Regex
            .Matches(calculator, @"var billedPerCall = pricePerCall is not null;").Count;
        Assert.True(derived >= 2, $"合计与状态判定都要从配没配按次价推，实际只有 {derived} 处");
        Assert.DoesNotContain("var billedPerCall = callCost is not null;", calculator);

        // 按次计费而这一次不收固定费：账是算出来了，就是零，不是「算不出」。
        Assert.Contains("status == GatewayCostStatus.Priced && billedPerCall ? 0m", calculator);
    }

    /// <summary>
    /// 物理线路要按它**实际会打出去的那个模型名**过名录门，而且**每一处**都要。
    ///
    /// 线路可以用 UpstreamModelId 覆盖上游模型名，运行时判的就是覆盖之后那个名字。
    /// 只判目标文档自己的名字，就会出现「目标在名录里、覆盖成的那个不在」：对外清单照样
    /// 把它列出来、就绪照样报绿，而真调用回 MODEL_NOT_IN_CATALOG。
    ///
    /// 这条守卫刻意不钉某一个文件——上一轮就是只补了被点名的那一处（对外清单），
    /// 同族的另一处（就绪探针）原样留着，第二天被原样报回来。所以判据是扫描式的：
    /// **凡是自己算过「名录门要不要拦」又在判线路的文件，一个都不许自己判。**
    /// 新写一处路由判据时它自动进入这张网，不需要有人记得回来改这条守卫。
    /// </summary>
    [Fact]
    public void 每一处线路判据都走共享的名录门()
    {
        // 权威实现只有一处：运行时按解析结果里的 ActualModel 自己判（ApplyCatalogGateAsync）。
        // 其余任何地方都是镜像，必须走共享谓词。往这张表里加名字得是有意识的动作。
        var authorities = new[] { "prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs" };

        var mirrors = EnumerateRepoSources()
            .Where(x => !x.Path.EndsWith("GatewayCatalogGate.cs", StringComparison.Ordinal))
            .Where(x => !authorities.Contains(x.Path, StringComparer.Ordinal))
            .Where(x => x.Text.Contains("catalogGateEnforces", StringComparison.Ordinal)
                && x.Text.Contains("GatewayModelOffering", StringComparison.Ordinal))
            .ToList();

        // 网不能是空的：判据文件要是被改名或挪走了，这条守卫会静默变成一条永远绿的空跑。
        Assert.True(mirrors.Count >= 2,
            $"扫到的线路判据宿主只有 {mirrors.Count} 个，判据的取值方式可能已经变了，这条守卫失效了");

        foreach (var mirror in mirrors)
        {
            Assert.True(mirror.Text.Contains("GatewayCatalogGate.PhysicalRoutePasses(", StringComparison.Ordinal),
                $"{mirror.Path} 在判线路却没走共享的 PhysicalRoutePasses——物理线路会按目标文档的名字判，"
                + "而运行时判的是 UpstreamModelId 覆盖之后那个名字");
            Assert.True(mirror.Text.Contains("GatewayCatalogGate.ExchangeRoutePasses(", StringComparison.Ordinal),
                $"{mirror.Path} 在判线路却没走共享的 ExchangeRoutePasses");
            Assert.False(mirror.Text.Contains("GatewayCatalogGate.Passes(", StringComparison.Ordinal),
                $"{mirror.Path} 还在拿目标文档自己判一次名录门（GatewayCatalogGate.Passes）——"
                + "判两次口径就会分家，线路这一层只许走 PhysicalRoutePasses / ExchangeRoutePasses");
        }

        // 两处镜像都要算出「实际会打出去的名字」，而不是拿目标文档的名字凑合。
        foreach (var mirror in mirrors)
        {
            Assert.True(mirror.Text.Contains("string EffectiveUpstreamName(GatewayModelOffering route)", StringComparison.Ordinal),
                $"{mirror.Path} 没有算实际上游名");
            // 预取那一步的同名谓词也要走共享那一份。上一版逐字要求源码里出现
            // `ModelNameNormalized`——那是把「自己拼两支 In」这个写法钉死，而它恰好是
            // 第 68 轮被证明太窄的那个（存量文档没有归一化字段时两支都查不到）。
            Assert.True(mirror.Text.Contains("GatewayCatalogGate.SameNameBatchFilter(", StringComparison.Ordinal),
                $"{mirror.Path} 预取同名文档时自己拼谓词，与运行时取值不同源");
            // 挑同名文档这一步也不许自己写：两处各拼一个 "{平台}::{名字}" 的键，
            // 大小写与库里存的不一致时查空、判成「管不着」放行，而运行时判拦。
            Assert.True(mirror.Text.Contains("GatewayCatalogGate.SelectSameNameDocs(", StringComparison.Ordinal),
                $"{mirror.Path} 自己挑同名文档而不是走共享的 SelectSameNameDocs——"
                + "键怎么拼就是一道暗缝，上一次正是大小写不一致把线路放了过去");
        }

        // 判据本体在共享那一份，宿主只喂数据。
        var gate = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayCatalogGate.cs");
        Assert.Contains("public static bool PhysicalRoutePasses(", gate);
        // 查不到同名文档时属于「管不着」，与运行时的 OutOfJurisdiction 同档，放行而不是拦。
        Assert.Contains("if (sameNameDocsOnPlatform.Count == 0) return true;", gate);
    }

    /// <summary>
    /// 「不点名时落到谁」的每一处镜像都必须是**认领排他**的：先按认领挑出那一条，
    /// 再判它能不能用；挑中的那条不可用就是失败，不许回头去试用途默认。
    ///
    /// 运行时写的是 <c>logical ??=</c>——第二层只在第一层一条都没查到时才走。
    /// 镜像若写成「一边挑一边筛」，一个「认领坏了 + 用途默认健康」的调用方就会被判绿，
    /// 而它真实的不点名请求每一次都失败：灯替一条根本不会走的路作了保。
    /// </summary>
    [Fact]
    public void 每一处不点名镜像都是认领排他的()
    {
        // 这三处「不点名落到谁」的判据：运行时（权威）、serving 就绪探针、控制台发布闸。
        // 扫描式而不是点名式——再多一处写同样判据的地方，它自动进这张网。
        var mirrors = EnumerateRepoSources()
            .Where(x => x.Text.Contains("DefaultForAppCallerCodes", StringComparison.Ordinal))
            .Where(x => x.Text.Contains("IsDefaultForType", StringComparison.Ordinal))
            .Where(x => x.Text.Contains("Ascending(\"DisplayOrder\")", StringComparison.Ordinal)
                || x.Text.Contains("OrderBy(x => x.DisplayOrder)", StringComparison.Ordinal)
                || x.Text.Contains("SortBy(x => x.DisplayOrder)", StringComparison.Ordinal))
            .ToList();

        // 网不能是空的、也不能只剩一处：判据挪走或改写之后这条守卫会静默退化成空跑。
        Assert.True(mirrors.Count >= 3,
            "扫到的「不点名落到谁」镜像只有 " + mirrors.Count
            + " 个（预期至少运行时、就绪探针、发布闸三处）："
            + string.Join("、", mirrors.Select(x => x.Path)));

        foreach (var mirror in mirrors)
        {
            /*
              认领是排他的：挑中之后成败就看它自己，不许回头去试用途默认。
              代码里成立的写法只有两种——
                · 用途默认那一层写成 `??=`（只在认领一条都没查到时才赋值）；
                · 认领挑中后当场 return。
              两种都不是，就说明这一处又变回了「一边挑一边筛」：认领坏了的调用方
              被判绿，而运行时那个调用方的每一次不点名请求都失败。
            */
            // 写法一（运行时）：用途默认那一层写成 `logical ??=`，只在认领一条都没查到时才赋值。
            var deferredDefault = mirror.Text.Contains("logical ??=", StringComparison.Ordinal);

            // 写法二（镜像）：认领挑中后当场 return，且**返回的是对挑中那一条的可用性判定**。
            //
            // 这里刻意不接受 `return claimed;` 这种「返回一个已经筛过的结果」——
            // 那正是被报回来的那版写法：挑选与可用性揉在同一个循环里，认领坏了的模型被跳过，
            // 循环接着去试用途默认，于是判绿。挑选必须先于判定，判定必须作用在挑中的那一条上。
            var returnsUsabilityOfClaim = Regex.IsMatch(
                mirror.Text,
                @"if \(claimed is not null\) return (await )?\w*Usable\w*\(claimed\)");

            // 写法三（镜像，更好的那种）：挑选整个收进一个只挑不判的函数，调用方拿到那一条再判。
            // 同一个宿主里有第二个组件要问同一个问题时，只有这种写法能保证两边挑的是同一条。
            var delegatesToSelector = mirror.Text.Contains("SelectUnnamedCatcher(", StringComparison.Ordinal);

            Assert.True(deferredDefault || returnsUsabilityOfClaim || delegatesToSelector,
                mirror.Path + " 的认领层不是排他的：既没有把用途默认写成 ??=，"
                + "也没有「挑中认领 → 判定挑中那一条」，更没有把挑选收进一个只挑不判的函数。"
                + "这一处会在认领坏掉时回落到用途默认，而运行时不会——它会如实失败。");

            /*
              收进了选择器的那个宿主，里面**每一个**要问「不点名落到谁」的组件都得用它。

              serving 有两个（router 与 scenario-capability）：上一版只有 router 走了排他挑选，
              scenario-capability 还在 Any(...) 扫遍同用途全部模型，于是「认领它的模型不具备
              该场景能力、而另一条无关模型恰好具备」时那个组件判绿，而那个调用方每一次请求都失败。
              判据是出现次数：新写一个组件却自己扫一遍，这里就红。
            */
            if (delegatesToSelector)
            {
                var selectorMentions = Regex.Matches(mirror.Text, @"SelectUnnamedCatcher\(").Count;
                // 一次是定义，其余是调用点；serving 里至少两个组件要问这个问题。
                Assert.True(selectorMentions >= 3,
                    $"{mirror.Path} 里 SelectUnnamedCatcher 只出现 {selectorMentions} 次"
                    + "（定义 + 调用点）：这个宿主里每一个要问「不点名落到谁」的组件都要用它，"
                    + "自己扫一遍就会与运行时挑中的那一条分家");

                // 选择器自己必须是排他的：挑中认领就返回，不再往下看用途默认。
                Assert.Contains("if (claimed is not null) return claimed;", mirror.Text);
            }

            /*
              能力判定必须作用在**挑中的那一条**上，不许挂在一个扫全表的 Any(...) 里。

              这条与上面几条互补：上面管「认领层是不是排他的」，这条管「判能力时手里
              拿的是哪一条」。serving 的 scenario-capability 组件曾经写成
              enabledLogicalModels.Any(model => … SupportsAppCallerScenario(model …))——
              router 那一侧已经是排他挑选了，这一侧照样扫遍同用途全部模型，
              于是「认领它的模型不具备该场景能力、而另一条无关模型恰好具备」时判绿，
              而那个调用方的每一次请求都失败。判据：每一处能力判定往前看一眼，
              它所在的那条语句里不许出现 .Any(。
            */
            foreach (Match call in Regex.Matches(mirror.Text, @"SupportsAppCallerScenario\("))
            {
                var statementStart = mirror.Text.LastIndexOfAny([';', '{', '}'], call.Index);
                var statement = mirror.Text[(statementStart + 1)..call.Index];
                Assert.False(statement.Contains(".Any(", StringComparison.Ordinal),
                    $"{mirror.Path} 把场景能力判定挂在了一个 .Any(...) 上：那是「同用途里有没有一条能接的」，"
                    + "而运行时只会选中认领的那一条。判定要作用在挑中的那一条上。");
            }
        }
    }

    /// <summary>
    /// 同名文档的挑选必须与运行时逐条同口径：两个名字字段都认，其中归一化字段按小写比。
    ///
    /// 这是行为用例不是源码扫描——上一版两处镜像各自拼 `"{平台}::{名字}"` 的键、
    /// 用原样大小写比，于是「库里存 GPT-4o、线路覆盖成 gpt-4o」这种再普通不过的组合
    /// 查不到同名文档，判成「管不着」放行；而运行时按 ModelNameNormalized 查得到、判拦。
    /// 同一条线路两个结论，清单与就绪都替它作了保。
    /// </summary>
    [Fact]
    public void 挑同名文档时大小写不一致也要认得出来()
    {
        var docs = new[]
        {
            new BsonDocument
            {
                { "_id", "m1" },
                { "PlatformId", "p1" },
                { "ModelName", "GPT-4o" },
                { "ModelNameNormalized", "gpt-4o" },
            },
            new BsonDocument
            {
                { "_id", "m2" },
                { "PlatformId", "p2" },
                { "ModelName", "GPT-4o" },
                { "ModelNameNormalized", "gpt-4o" },
            },
        };

        // 覆盖值与库里存的大小写不同：归一化字段那一支必须认出来。
        Assert.Single(GatewayCatalogGate.SelectSameNameDocs(docs, "gpt-4o", "p1"));
        // 原样大小写同样认。
        Assert.Single(GatewayCatalogGate.SelectSameNameDocs(docs, "GPT-4o", "p1"));
        // 前后空白不该改变结论（运行时是 Trim 过的）。
        Assert.Single(GatewayCatalogGate.SelectSameNameDocs(docs, "  gpt-4o  ", "p1"));
        // Provider 不同就不是这条线路该管的。
        Assert.Empty(GatewayCatalogGate.SelectSameNameDocs(docs, "gpt-4o", "p3"));
        // 不给 Provider 时不收窄。
        Assert.Equal(2, GatewayCatalogGate.SelectSameNameDocs(docs, "gpt-4o", null).Count);
        // 名字对不上一条都不该给。
        Assert.Empty(GatewayCatalogGate.SelectSameNameDocs(docs, "claude-sonnet-4-6", "p1"));

        // 挑出来之后这道门才谈得上判：名录外、又没盖放行标记的，拦。
        Assert.False(GatewayCatalogGate.PhysicalRoutePasses(
            "gpt-4o-private",
            GatewayCatalogGate.SelectSameNameDocs(
                new[]
                {
                    new BsonDocument
                    {
                        { "_id", "m3" },
                        { "PlatformId", "p1" },
                        { "ModelName", "GPT-4o-Private" },
                        { "ModelNameNormalized", "gpt-4o-private" },
                    },
                },
                "gpt-4o-private",
                "p1"),
            gateEnforces: true));
    }

    /// <summary>仓库里参与网关路由判据的 C# 源码（不含测试自身）。</summary>
    private static IReadOnlyList<(string Path, string Text)> EnumerateRepoSources()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var root = dir!.FullName;

        var roots = new[] { "llmgw", "prd-api/src" };
        var files = new List<(string, string)>();
        foreach (var relative in roots)
        {
            var full = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!Directory.Exists(full)) continue;
            foreach (var file in Directory.EnumerateFiles(full, "*.cs", SearchOption.AllDirectories))
            {
                if (file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                    || file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
                {
                    continue;
                }
                files.Add((
                    Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'),
                    File.ReadAllText(file)));
            }
        }
        Assert.NotEmpty(files);
        return files;
    }
}
