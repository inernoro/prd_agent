using PrdAgent.LlmGw.Provisioning;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 模型名录补登「在控制台里登记、不用发版」这条链路的守卫。
///
/// 为什么这件事值得单独钉：名录回答的是「这个模型是什么」（算哪几种用途、能不能吃图），
/// 而它此前只有写死在代码里的二十来条。实测线上两个上游共 573 个模型，落在名录里的只有
/// 27 个——其余 95% 走关键词猜测，其中一百多个连一条用途都猜不出来，导进来就是「哑」模型：
/// 模型池选型时不参与任何用途匹配。
///
/// 这条链路的每一环断了都不会红：补登不生效（照样猜）、查找规则分裂成两份（补登的模型
/// 有时认有时不认）、端点忘了把补登传进去（补了等于没补）。逐条钉住。
/// </summary>
public class ModelCatalogOverrideGuardTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "AGENTS.md"))) dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    private static string Read(string relative) => File.ReadAllText(Path.Combine(RepoRoot(), relative));

    /// <summary>切出一个端点的函数体。判据只看它自己那一段，别被同文件里别处的写法蒙混过去。</summary>
    private static string Slice(string source, string endpointMarker)
    {
        var start = source.IndexOf(endpointMarker, StringComparison.Ordinal);
        Assert.True(start > 0, $"找不到端点 {endpointMarker}，判据在空跑");
        var end = source.IndexOf("RequireAuthorization", start, StringComparison.Ordinal);
        Assert.True(end > start, $"端点 {endpointMarker} 没有闭合，切不出函数体");
        return source[start..end];
    }

    private static ModelCatalog.CatalogOverrides Overrides(params CatalogModel[] models)
        => ModelCatalog.CatalogOverrides.From(models);

    /// <summary>
    /// 补登的模型真的被认出来了——这是整套东西的核心承诺。
    ///
    /// 用一个内置表里**确实没有**的标识，所以这条同时证明了「补登生效」而不是
    /// 「恰好内置表里本来就有」。
    /// </summary>
    [Fact]
    public void 补登之后系统就认识这个模型了()
    {
        const string id = "zz-brand-new-model-v9";
        Assert.Null(ModelCatalog.Find(id));
        Assert.Equal(ModelCatalog.SourceGuess, ModelCatalog.ResolveCapabilities(id, null).Source);

        var overrides = Overrides(new CatalogModel(id, "全新模型", "zz", ["chat", "vision"], AcceptsImageInput: true));

        var found = ModelCatalog.Find(id, overrides);
        Assert.NotNull(found);
        Assert.Equal("全新模型", found!.DisplayName);
        Assert.True(found.AcceptsImageInput);

        var resolved = ModelCatalog.ResolveCapabilities(id, null, overrides);
        Assert.Equal(ModelCatalog.SourceCatalog, resolved.Source);
        Assert.Equal(["chat", "vision"], resolved.Capabilities);
    }

    /// <summary>
    /// 同一个标识，补登的赢过内置的。
    ///
    /// 内置那张表登记的事实会过时（上游给老模型加了能力），补登要能纠正它，
    /// 否则「登记了但不生效」比没有这个功能更让人困惑。
    /// </summary>
    [Fact]
    public void 同一个标识补登的赢过内置的()
    {
        var builtin = ModelCatalog.Find("gpt-4o");
        Assert.NotNull(builtin);
        Assert.Equal("GPT-4o", builtin!.DisplayName);

        var overrides = Overrides(new CatalogModel("gpt-4o", "被补登改过", "openai", ["chat"]));
        Assert.Equal("被补登改过", ModelCatalog.Find("gpt-4o", overrides)!.DisplayName);
    }

    /// <summary>
    /// 补登为空时，行为与这套机制上线之前逐字节相同。
    ///
    /// 「纯增量」是可以断言的：库里一行都没有 = 回到代码内置那张表，
    /// 删光补登就回退，不需要发版。
    /// </summary>
    [Fact]
    public void 补登为空时回到代码内置那张表()
    {
        foreach (var overrides in new[] { null, ModelCatalog.CatalogOverrides.Empty })
        {
            foreach (var model in ModelCatalog.All)
            {
                var found = ModelCatalog.Find(model.CanonicalId, overrides);
                Assert.NotNull(found);
                Assert.Equal(model.CanonicalId, found!.CanonicalId);
            }
        }
    }

    /// <summary>
    /// 补登与内置走**同一套查找规则**，不是各判各的。
    ///
    /// 名录那套规则里最容易被漏掉的是「只剥自己登记过的厂商段」：
    /// `openai/gpt-4o` 该落到 `gpt-4o`，而 `private-provider/gpt-4o` 必须查不到——
    /// 后者跟前者不是同一个模型，认成同一个就等于让一个没登记过的标识继承了别人的能力。
    /// 补登要是自己写一套查找，这条规则就只在一半的模型上成立（形状 3）。
    /// </summary>
    [Fact]
    public void 补登与内置用同一套查找规则()
    {
        var overrides = Overrides(new CatalogModel("zz-vendor-model", "带厂商段的补登", "zzcorp", ["chat"]));

        // 登记过的厂商段可以剥
        Assert.NotNull(ModelCatalog.Find("zzcorp/zz-vendor-model", overrides));
        // 没登记过的厂商段不许剥——这正是内置那张表的规则
        Assert.Null(ModelCatalog.Find("someone-else/zz-vendor-model", overrides));

        // 内置那侧同一条规则仍然成立，没有被补登的引入改掉
        Assert.NotNull(ModelCatalog.Find("openai/gpt-4o", overrides));
        Assert.Null(ModelCatalog.Find("private-provider/gpt-4o", overrides));
    }

    /// <summary>
    /// 补登登记的别名也算数。
    ///
    /// 同一个模型在不同网关写法不同，补登要是只认规范标识，人就得为同一个模型补登好几条，
    /// 而那几条的能力还会各自漂移——正是名录当初引入别名要防的事。
    /// </summary>
    [Fact]
    public void 补登的别名也认()
    {
        var overrides = Overrides(new CatalogModel(
            "zz-aliased", "有别名的补登", "zz", ["chat"],
            Aliases: ["zz/zz-aliased-latest", "zz-aliased-2099-01-01"]));

        Assert.NotNull(ModelCatalog.Find("zz-aliased-2099-01-01", overrides));
        Assert.NotNull(ModelCatalog.Find("zz/zz-aliased-latest", overrides));
        Assert.Null(ModelCatalog.Find("zz-aliased-2099-01-02", overrides));
    }

    /// <summary>
    /// 上游清单那一屏真的把补登传进去了。
    ///
    /// 这是最容易静默断掉的一环：端点照常返回、界面照常渲染，只是补登的模型仍然显示
    /// 「靠猜」——补了等于没补，而且不会有任何东西变红（形状 2：链路只建一半）。
    /// </summary>
    [Fact]
    public void 上游清单那一屏真的用了补登()
    {
        var console = Read("llmgw/console-api/Program.cs");
        Assert.Contains("LoadCatalogOverridesAsync", console);
        Assert.Contains("ModelCatalog.ResolveCapabilities(modelId, declared, catalogOverrides)", console);
        Assert.Contains("ModelCatalog.Find(modelId, catalogOverrides)", console);

        // 补登必须是「每次现查」而不是进程启动时读一次：
        // 读一次就等于「补完要重启才生效」，那和改代码发版只差一点点。
        var endpoint = console[console.IndexOf("app.MapGet(\"/gw/platforms/{id}/upstream-models\"", StringComparison.Ordinal)..];
        var body = endpoint[..endpoint.IndexOf("RequireAuthorization", StringComparison.Ordinal)];
        Assert.Contains("await LoadCatalogOverridesAsync(http)", body);
    }

    /// <summary>
    /// 补登入口就在「看见它不认识」的那一屏，而且补完当场能看出变了。
    ///
    /// 入口放在哪里是这件事成不成立的关键：另开一页登记，等于要求人先记住那个模型标识、
    /// 再去别处找表单——那条路没人会走，于是「不用发版」这件事等于没做。
    ///
    /// 「补完重拉一次」同样不能省：补登是立刻生效的，但界面上那一行不会自己变。
    /// 不重拉的话人看到的仍然是「名录外」，只能自己去别处确认——正是闭环差最后一步
    /// （closed-loop-acceptance）。
    /// </summary>
    [Fact]
    public void 补登入口在看见名录外模型的那一屏()
    {
        var picker = Read("llmgw/web/src/components/ProviderSetup.tsx");
        Assert.Contains("createCatalogEntry", picker);
        Assert.Contains("CatalogEntryEditor", picker);
        Assert.Contains("openRegister(m)", picker);
        Assert.Contains("onRegistered", picker);

        // 父层真的把重拉接上了——没接的话补完那一行永远显示「名录外」，
        // 而这条线断掉不会有任何东西变红（形状 2：链路只建一半）。
        var page = Read("llmgw/web/src/pages/PlatformsPage.tsx");
        Assert.Contains("onRegistered={", page);
        Assert.Contains("openDiscovery(", page);

        // 管理区也得在：补错了要能改、要能删，否则补登比不补更糟。
        Assert.Contains("<ModelCatalogSection", page);
    }

    /// <summary>
    /// 界面上「能填哪几种用途」只有一份，来自服务端。
    ///
    /// 两处表单（管理区与就地补登）各抄一张用途清单的话，迟早有一边漏掉运行时新增的那一种，
    /// 而漏掉的后果是那种用途永远填不上——不报错、不变红（形状 3：判据分裂成多份各自漂移）。
    /// </summary>
    [Fact]
    public void 用途词表只有一份且来自服务端()
    {
        var section = Read("llmgw/web/src/components/ModelCatalogSection.tsx");
        Assert.Contains("knownCapabilities.map", section);
        Assert.Contains("data.knownCapabilities", section);

        // 就地补登那一处用的是同一个表单组件、同一份从服务端拉来的词表。
        var picker = Read("llmgw/web/src/components/ProviderSetup.tsx");
        Assert.Contains("getCatalogEntries()", picker);
        Assert.Contains("knownCapabilities={knownCapabilities}", picker);
    }

    /// <summary>
    /// 补登喂给了**每一道**名录门，不是只喂给看得见的那一道。
    ///
    /// 这条是 2026-09-16 自动 review 抓出来的真缺陷，形状教科书级（形状 3：判据分裂）：
    /// 我把补登接进了「上游清单那一屏」，却没接进同一页上的「导入」按钮。后果是
    /// 管理员就地补登一个模型 → 那一行刷新后显示「名录内」→ 他不会去勾「放行名录外」
    /// → 前端提交 allowOutsideCatalog:false → 导入端点只查内置的 38 条 → 当场拒掉。
    /// 「刚登记好的模型导不进来」，而且不会有任何东西变红。
    ///
    /// 数据面那道门（prd-api 的 ModelResolver）读不到补登表，所以它换一种方式接上：
    /// 靠补登才算数的模型入库时盖 AllowedOutsideCatalog 持久戳，那道门只认内置名录 + 这枚戳。
    /// 不盖的话模型导进来了、也进了池，第一次真实请求才被拦——库里看得见、池里也在、就是调不通。
    /// </summary>
    [Fact]
    public void 补登喂给了每一道名录门()
    {
        var console = Read("llmgw/console-api/Program.cs");
        var import = Slice(console, "app.MapPost(\"/gw/platforms/{id}/models/import\"");

        // 准入判定必须查补登，不能只查内置那 38 条
        Assert.Contains("await LoadCatalogOverridesAsync(http)", import);
        Assert.Contains("ModelCatalog.Find(modelId, importCatalogOverrides)", import);
        Assert.DoesNotContain("!ModelCatalog.Contains(modelId) && !entry.AllowOutsideCatalog", import);

        // 用途推断也得吃补登，否则补登登记的用途白登记
        Assert.Contains("ModelCatalog.ResolveCapabilities(modelId, null, importCatalogOverrides)", import);

        // 数据面那道门靠持久戳接上，且依据要分得清
        Assert.Contains("doc[\"AllowedOutsideCatalog\"] = true", import);
        Assert.Contains("\"catalog-entry\" : \"admin-override\"", import);

        // 数据面那道门确实只认内置名录 + 这枚戳——上面那枚戳才有意义
        var resolver = Read("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        Assert.Contains("GatewayModelCatalog.Contains(modelName)", resolver);
        Assert.Contains("IsAllowedOutsideCatalog", resolver);
    }

    /// <summary>
    /// 界面只让填运行时真正认的那几种用途。
    ///
    /// 填一个运行时不认的词，这条补登看着生效了、模型照样选不中，而且不会有任何东西报错——
    /// 「填了没用」是这套东西最难查的坏法。所以写入侧当场拒，而且词表取自运行时那一份，
    /// 不另抄（形状 3）。
    /// </summary>
    [Fact]
    public void 未知用途在写入侧就被拒掉()
    {
        var console = Read("llmgw/console-api/Program.cs");
        Assert.Contains("LogicalModelCapabilityPolicy.CanonicalCapabilities.Contains", console);
        Assert.Contains("这些用途运行时不认", console);

        // 一条用途都不填的补登没有意义——它不解决任何问题，却让人以为登记过了。
        Assert.Contains("至少要填一种用途", console);

        // 名录是白名单，通配符会让「差不多像」等于「就是它」，那正是关键词猜测出问题的地方。
        Assert.Contains("名录是白名单，不支持通配符", console);
    }
}
