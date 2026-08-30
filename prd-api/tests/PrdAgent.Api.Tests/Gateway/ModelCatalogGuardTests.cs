using PrdAgent.LlmGw.LogicalModels;
using PrdAgent.LlmGw.Provisioning;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 已知模型名录的守卫。
///
/// 名录是白名单的内置那一半，它一旦自相矛盾，坏法都是静默的：
/// 能力名写错 → 入库时被 <c>IsSupportedCapabilityCode</c> 悄悄丢掉，模型看着导进来了却没有用途；
/// 两条登记抢同一个归一化键 → 同一个模型解析成谁全看字典构建顺序；
/// 归一化漏了某种写法 → 同一个模型在不同网关上被当成两个，一半查名录一半靠猜。
/// 这些都编译得过、跑得通，只有真发请求或事后核对数据才看得出来，所以必须机械判。
///
/// 每条用例都能红：改坏名录里任意一条登记，对应用例立刻失败。
/// </summary>
public sealed class ModelCatalogGuardTests
{
    [Fact]
    public void EveryCapability_IsInTheCanonicalContract()
    {
        var canonical = LogicalModelCapabilityPolicy.CanonicalCapabilities;
        var offenders = ModelCatalog.All
            .SelectMany(m => m.Capabilities.Select(c => (m.CanonicalId, Capability: c)))
            .Where(x => !canonical.Contains(x.Capability))
            .Select(x => $"{x.CanonicalId} -> {x.Capability}")
            .ToList();

        offenders.ShouldBeEmpty(
            "名录里的能力名必须全在规范能力表内，否则入库时会被能力校验静默丢掉——"
            + "模型看着导进来了，实际一个用途都没有，路由永远选不到它。");
    }

    [Fact]
    public void NormalizedKeys_AreUniqueAcrossTheCatalog()
    {
        var claims = new List<(string Key, string Owner)>();
        foreach (var model in ModelCatalog.All)
        {
            claims.Add((ModelCatalog.Normalize(model.CanonicalId), model.CanonicalId));
            foreach (var alias in model.Aliases ?? Array.Empty<string>())
                claims.Add((ModelCatalog.Normalize(alias), model.CanonicalId));
        }

        var collisions = claims
            .GroupBy(x => x.Key, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Select(x => x.Owner).Distinct(StringComparer.Ordinal).Count() > 1)
            .Select(g => $"{g.Key} 被 {string.Join(" / ", g.Select(x => x.Owner).Distinct())} 同时认领")
            .ToList();

        collisions.ShouldBeEmpty(
            "同一个归一化标识不能落到两条登记上：那样解析出哪条全看字典构建顺序，"
            + "是下一次「同一个模型两份能力」漂移的温床。");
    }

    [Theory]
    // 同一个模型的三种等价写法都必须落回同一条登记：登记过的厂商前缀、日期快照、-latest。
    // 前两者的处置不同——日期与 -latest 由归一化吃掉，而厂商前缀是**逐条登记的别名**，
    // 查不到时才按「名录自己登记过的厂商段」剥一层（没登记过的前缀一律不剥，见下一条用例）。
    [InlineData("gpt-4o", "openai/gpt-4o")]
    [InlineData("gpt-4o", "gpt-4o-2024-08-06")]
    [InlineData("gpt-4o", "GPT-4O-latest")]
    [InlineData("claude-3-5-sonnet", "anthropic/claude-3.5-sonnet")]
    [InlineData("claude-3-5-sonnet", "claude-3-5-sonnet-20241022")]
    [InlineData("qwen-vl-max", "qwen/qwen-vl-max-latest")]
    public void EquivalentWritings_ResolveToTheSameEntry(string canonicalId, string writing)
    {
        var direct = ModelCatalog.Find(canonicalId);
        var viaWriting = ModelCatalog.Find(writing);

        direct.ShouldNotBeNull($"名录里应当有 {canonicalId}");
        viaWriting.ShouldNotBeNull($"「{writing}」是 {canonicalId} 的等价写法，应当查得到");
        viaWriting!.CanonicalId.ShouldBe(direct!.CanonicalId);
    }

    [Fact]
    public void UnknownModel_IsNotGuessedIntoTheCatalog()
    {
        // 名录是白名单：「看着像」不等于「就是它」。模糊匹配一旦放进来，
        // 白名单就退化成又一个关键词猜测。
        ModelCatalog.Find("gpt-4o-my-private-finetune-v2").ShouldBeNull();
        ModelCatalog.Contains("some-vendor/never-heard-of-this").ShouldBeFalse();
    }

    [Fact]
    public void UnknownVendorPrefix_DoesNotInheritTheCatalogEntry()
    {
        // 归一化曾把斜杠前的**任意**前缀都当厂商剥掉。于是任何人只要把自家模型命名成
        // `{自定义前缀}/{知名模型名}`，它就被认成那个知名模型：继承它登记的用途与能力，
        // 并且因为「判成名录内」而不需要任何放行标记——导入确认与数据面名录门一起失守。
        // 两侧镜像同一份归一化，所以两道门会一起放行，日志里毫无异常。
        ModelCatalog.Find("private-provider/gpt-4o").ShouldBeNull(
            "没登记过的前缀不是厂商前缀；剥掉它等于把一个陌生别名认成 gpt-4o");
        ModelCatalog.Contains("acme/claude-3.5-sonnet").ShouldBeFalse();
        // 更隐蔽的一种：两段**各自**都登记过，拼在一起从没登记过。用一张全局
        // 「见过的厂商段」白名单会放它过去——剥掉 openai/ 之后认成 Anthropic 那条登记，
        // 一个没人见过的标识就继承了别人的用途与能力。厂商段必须绑到命中的那条登记上。
        ModelCatalog.Contains("openai/claude-3-opus").ShouldBeFalse(
            "openai 与 claude-3-opus 各自登记过，但这个组合没有——不能靠全局厂商白名单放行");
        ModelCatalog.Contains("anthropic/gpt-4o").ShouldBeFalse();
        PrdAgent.Core.Models.GatewayModelCatalog.Contains("openai/claude-3-opus").ShouldBeFalse();
        PrdAgent.Core.Models.GatewayModelCatalog.Contains("private-provider/gpt-4o").ShouldBeFalse(
            "运行时那道门必须得到同一个结论，否则导入拦住了、请求照样放行");

        // 反过来也要成立：名录自己登记过的厂商段照旧认得出来，否则这次收紧就成了误伤。
        ModelCatalog.Find("openai/gpt-4o")!.CanonicalId.ShouldBe("gpt-4o");
        ModelCatalog.Find("openai/o1-preview").ShouldNotBeNull(
            "`o1-preview` 是登记过的别名，openai 是登记过的厂商段，这一档必须仍然命中");
    }

    [Fact]
    public void ResolveCapabilities_PrefersCatalogOverUpstreamOverGuess()
    {
        // 名录命中：即使上游声明了别的，也以名录为准（上游把同一个模型标错过）。
        var fromCatalog = ModelCatalog.ResolveCapabilities("openai/gpt-4o", ["embedding"]);
        fromCatalog.Source.ShouldBe(ModelCatalog.SourceCatalog);
        fromCatalog.Capabilities.ShouldContain("vision");
        fromCatalog.Capabilities.ShouldNotContain("embedding");

        // 名录没有但上游声明了：用上游的，来源标 upstream。
        var fromUpstream = ModelCatalog.ResolveCapabilities("acme/unknown-model", ["chat", "vision"]);
        fromUpstream.Source.ShouldBe(ModelCatalog.SourceUpstream);
        fromUpstream.Capabilities.ShouldBe(new[] { "chat", "vision" });

        // 两边都没有才轮到猜，并且**必须**标成 guess——界面据此如实提示「这是猜的」。
        var guessed = ModelCatalog.ResolveCapabilities("acme/llama-3-instruct", null);
        guessed.Source.ShouldBe(ModelCatalog.SourceGuess);
    }

    [Fact]
    public void ModelsThatRequireAnImage_AlsoAcceptImages()
    {
        var contradictions = ModelCatalog.All
            .Where(m => m.RequiresImageInput && !m.AcceptsImageInput)
            .Select(m => m.CanonicalId)
            .ToList();

        contradictions.ShouldBeEmpty("「必须给图」却「不接收图片」是自相矛盾的登记，界面会据此做出无解的要求。");
    }

    [Fact]
    public void EveryEntry_HasIdentityFieldsFilled()
    {
        var incomplete = ModelCatalog.All
            .Where(m => string.IsNullOrWhiteSpace(m.CanonicalId)
                || string.IsNullOrWhiteSpace(m.DisplayName)
                || string.IsNullOrWhiteSpace(m.Vendor)
                || m.Capabilities.Count == 0)
            .Select(m => m.CanonicalId)
            .ToList();

        incomplete.ShouldBeEmpty("名录每条都要有标识、展示名、出品方和至少一个用途——缺哪一样都让它没法被人核对。");
    }
}

/// <summary>
/// 两份名录的镜像守卫。
///
/// 写入侧（llmgw console-api）按既定架构不引用 PrdAgent.*，所以名录在那边有一份；
/// 而拦截必须发生在数据面，于是运行时侧（PrdAgent.Core）也有一份。这与能力契约那对镜像表
/// 是同一种处置。两份一旦漂移，坏法是静默的：控制台按新表放行，运行时按旧表拒绝，
/// 用户看到「导入成功了，一调就说不在名录」——两边都「按自己的表办事」，日志里毫无异常。
///
/// 每条用例都能红：任一侧加一条、删一条、改一个能力，下面立刻失败。
/// </summary>
public sealed class ModelCatalogMirrorGuardTests
{
    private static string Describe(string id, string display, string vendor,
        IReadOnlyList<string> caps, bool acceptsImage, bool requiresImage, IReadOnlyList<string>? aliases)
        => $"{id}|{display}|{vendor}|{string.Join(",", caps.OrderBy(x => x, StringComparer.Ordinal))}"
           + $"|img={acceptsImage}|needImg={requiresImage}"
           + $"|alias={string.Join(",", (aliases ?? Array.Empty<string>()).OrderBy(x => x, StringComparer.Ordinal))}";

    [Fact]
    public void Catalogs_AreIdenticalOnBothSides()
    {
        var console = ModelCatalog.All
            .Select(m => Describe(m.CanonicalId, m.DisplayName, m.Vendor, m.Capabilities, m.AcceptsImageInput, m.RequiresImageInput, m.Aliases))
            .OrderBy(x => x, StringComparer.Ordinal).ToList();
        var runtime = PrdAgent.Core.Models.GatewayModelCatalog.All
            .Select(m => Describe(m.CanonicalId, m.DisplayName, m.Vendor, m.Capabilities, m.AcceptsImageInput, m.RequiresImageInput, m.Aliases))
            .OrderBy(x => x, StringComparer.Ordinal).ToList();

        runtime.ShouldBe(
            console,
            "写入侧名录与运行时名录必须逐条一致，否则会出现「控制台放行了、运行时照样拒」这种两边都自认没错的静默不一致。");
    }

    [Theory]
    // 归一化是两道门共用的判据：写入侧用它判「要不要拦」，运行时用它判「放不放行」。
    // 两份实现只要有一处不同，同一个模型就会在两道门得到相反的结论。
    [InlineData("openai/gpt-4o")]
    [InlineData("gpt-4o-2024-08-06")]
    [InlineData("GPT-4O-latest")]
    [InlineData("anthropic/claude-3.5-sonnet")]
    [InlineData("acme/never-heard-of-this-2024-01-02")]
    [InlineData("")]
    public void Normalize_AgreesOnBothSides(string raw)
    {
        PrdAgent.Core.Models.GatewayModelCatalog.Normalize(raw)
            .ShouldBe(ModelCatalog.Normalize(raw), $"「{raw}」在两侧的归一化结果必须相同");
    }

    [Fact]
    public void Contains_AgreesOnBothSides()
    {
        string[] probes =
        [
            "gpt-4o", "openai/gpt-4o-mini", "claude-3-5-sonnet-20241022", "qwen-vl-max-latest",
            "o3-mini", "acme/unknown", "gpt-4o-my-private-finetune", "",
            // 前缀口径：登记过的厂商段该命中，没登记过的必须落空——两侧结论要一致，
            // 否则会出现「导入拦住了、请求照样放行」这种两边都自认没错的静默不一致。
            "private-provider/gpt-4o", "openai/o1-preview", "acme/claude-3.5-sonnet",
            "openai/claude-3-opus", "anthropic/gpt-4o",
        ];

        foreach (var probe in probes)
        {
            PrdAgent.Core.Models.GatewayModelCatalog.Contains(probe)
                .ShouldBe(ModelCatalog.Contains(probe), $"「{probe}」在两道门必须得到同一个结论");
        }
    }

    /// <summary>
    /// 补标记迁移的 id 也是一对镜像：控制台按这些 id 记「跑过了」，数据面按同样的 id 判「能不能开拦」。
    ///
    /// 改一侧忘一侧的坏法是静默的：控制台照常迁移并记下新 id，数据面还在找旧 id、永远找不到，
    /// 于是这道门在一个**已经迁完**的部署上永久停在只记录不拦——它等于没上线，
    /// 而日志里只有一句「还没迁完」，看着像句正常的等待。
    /// </summary>
    [Fact]
    public void CatalogMigrationIds_AreDeclaredOnBothSides()
    {
        var consoleProgram = File.ReadAllText(RepoFile("llmgw/console-api/Program.cs"));

        consoleProgram.ShouldContain(
            $"GetCollection<BsonDocument>(\"{PrdAgent.Core.LlmGateway.GatewayCatalogMigrations.CollectionName}\")",
            customMessage: "控制台记迁移的集合名必须与数据面读的那个一致，否则数据面永远读不到完成标记");

        foreach (var id in PrdAgent.Core.LlmGateway.GatewayCatalogMigrations.RequiredIds)
        {
            consoleProgram.ShouldContain(
                $"\"{id}\"",
                customMessage: $"数据面要等「{id}」跑完才敢开拦，控制台必须真的用这个 id 记录，否则这道门永久停在只记录不拦");
        }

        // 完成时间字段同理：控制台只写 ClaimedAt 而不写它，数据面就会一直认为没迁完。
        consoleProgram.ShouldContain(
            $"Set(\"{PrdAgent.Core.LlmGateway.GatewayCatalogMigrations.CompletedAtField}\"",
            customMessage: "控制台必须写下完成时间——数据面判「迁完了」认的就是这个字段");
    }

    private static string RepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "AGENTS.md")))
        {
            dir = dir.Parent;
        }

        dir.ShouldNotBeNull("找不到仓库根目录（以 AGENTS.md 为锚）");
        var full = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        File.Exists(full).ShouldBeTrue($"找不到文件：{full}");
        return full;
    }
}
