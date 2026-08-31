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
    // 同一个模型的等价写法都必须落回同一条登记——而且**每一条都靠逐条登记的别名**，
    // 没有一条是靠归一化合成的：大小写与首尾空白之外，归一化不再改写标识的任何一个字符。
    // 厂商前缀是别名；查不到时才按「名录自己登记过的厂商段」剥一层（没登记过的一律不剥，见下一条用例）。
    [InlineData("gpt-4o", "openai/gpt-4o")]
    // `-latest` 与日期快照同样是**登记过的别名**（删掉名录里那条别名，这一行立刻红），
    // 不是「后缀被吃掉之后碰巧撞上」——那种合成会让 `gpt-4o-20990101` 一起蒙混过关。
    [InlineData("gpt-4o", "GPT-4O-latest")]
    [InlineData("claude-3-5-sonnet", "anthropic/claude-3.5-sonnet")]
    // 标点写法同理逐条登记：这一条命中靠的是名录里真有 `claude-3.5-sonnet` 这个别名。
    [InlineData("claude-3-5-sonnet", "claude-3.5-sonnet")]
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
    public void SuffixVariants_AreNotSynthesizedIntoTheCatalog()
    {
        /*
          归一化曾把日期快照后缀（`-20240806` / `-2024-08-06`）与 `-latest` 剥掉再查。
          那是与标点合并**同一种病**，只是换了个后缀：名录里只登记过 `gpt-4o`，
          而任何人随手写的 `gpt-4o-20990101` 都会跟它落到同一个键上，继承它的用途与能力，
          并且因为「判成名录内」而不需要放行标记——两道门一起放过一个从没被批准过的标识。

          这一条是上一轮修标点时**没有横扫同类**留下的：同一个函数里有两条合成规则，
          只删了一条。判据该描述的是「这一类合成」，不是某一种写法。
        */
        foreach (var synthesized in new[]
                 {
                     "gpt-4o-20990101", "gpt-4o-2099-01-01", "openai/gpt-4o-20990101",
                     "gpt-4.1-2099-12-31", "claude-3-opus-20240229", "o3-mini-latest",
                 })
        {
            ModelCatalog.Contains(synthesized).ShouldBeFalse(
                customMessage: $"「{synthesized}」不是名录登记过的写法，不能靠剥后缀认成别的模型");
            PrdAgent.Core.Models.GatewayModelCatalog.Contains(synthesized).ShouldBeFalse(
                customMessage: $"运行时那道门对「{synthesized}」必须得到同一个结论，否则导入拦住了、请求照样放行");
        }

        // 反过来也要成立：真实存在、**逐条登记过**的日期与 latest 写法照旧命中。
        // 这次收紧只是不再凭后缀合成，不是把已登记的写法一起误伤。
        ModelCatalog.Find("claude-3-5-sonnet-20241022")!.CanonicalId.ShouldBe("claude-3-5-sonnet");
        ModelCatalog.Find("gpt-4o-latest")!.CanonicalId.ShouldBe("gpt-4o");
        ModelCatalog.Find("claude-3-opus-latest")!.CanonicalId.ShouldBe("claude-3-opus");
    }

    [Fact]
    public void PunctuationVariants_AreNotSynthesizedIntoTheCatalog()
    {
        // 归一化曾把 `.` 与 `_` 一律改写成 `-`。那不是「统一分隔符」，是**凭标点合成别名**：
        // 名录里只登记过 `gpt-4.1`，而 `gpt-4-1` / `gpt_4.1` 从没被任何人登记过，
        // 却会跟它落到同一个键上——继承它的用途与能力，并且因为「判成名录内」
        // 而不需要放行标记，导入确认与数据面名录门一起放过它。
        // 与本文件另一条用例（UnknownModel_IsNotGuessedIntoTheCatalog）是同一条规矩：
        // 名录是白名单，「差不多像」不等于「就是它」。
        foreach (var synthesized in new[]
                 {
                     "gpt-4-1", "gpt_4.1", "openai/gpt-4-1", "gpt-3-5-turbo",
                     "gemini-1-5-pro", "claude-3_5-sonnet",
                 })
        {
            ModelCatalog.Contains(synthesized).ShouldBeFalse(
                customMessage: $"「{synthesized}」不是名录登记过的写法，不能靠改写标点认成别的模型");
            PrdAgent.Core.Models.GatewayModelCatalog.Contains(synthesized).ShouldBeFalse(
                customMessage: $"运行时那道门对「{synthesized}」必须得到同一个结论，否则导入拦住了、请求照样放行");
        }

        // 反过来也要成立：真实存在的另一种标点写法照旧命中——它们是**逐条登记的别名**，
        // 走白名单。这次收紧只是不再凭标点合成，不是误伤真写法。
        ModelCatalog.Find("gpt-4.1")!.CanonicalId.ShouldBe("gpt-4.1");
        ModelCatalog.Find("claude-3.5-sonnet")!.CanonicalId.ShouldBe("claude-3-5-sonnet");
        ModelCatalog.Find("anthropic/claude-3-5-sonnet")!.CanonicalId.ShouldBe(
            "claude-3-5-sonnet",
            customMessage: "带厂商段的官方写法由 Find 那一档剥前缀命中，不该受标点收紧影响");
        ModelCatalog.Find("gemini-1.5-pro")!.CanonicalId.ShouldBe("gemini-1.5-pro");
    }

    [Fact]
    public void TighteningMigrations_OnlyGrandfatherModelsTheTighteningActuallyBroke()
    {
        /*
          每次口径收紧都自带一个一次性窗口，给「昨天判成名录内、今天判成名录外」的存量模型补标记。
          但窗口用「此刻缺标记」当判据太宽：上一个窗口跑完之后**绕过控制台直接写库**塞进来的模型
          同样缺标记，下一个窗口会顺手把它们一起放行——那正是这道门要拦的那一种。
          等于每加一条迁移就把门重新开一次，与当初把迁移改成一次性所要解决的问题一模一样。

          所以判据必须两头都算：旧口径判内 **且** 新口径判外。
        */
        var byVendorPrefix = (Func<string?, bool>)LegacyCatalogRules.WasInCatalogBeforeStrictVendorPrefix;
        var byPunctuation = (Func<string?, bool>)LegacyCatalogRules.WasInCatalogBeforeStrictPunctuation;
        var bySuffix = (Func<string?, bool>)LegacyCatalogRules.WasInCatalogBeforeStrictSuffix;

        // 受 v2（厂商段收紧）影响的：旧口径剥掉任意前缀就命中，新口径落空。
        LegacyCatalogRules.NeedsAllowanceAfterTightening("private-provider/gpt-4o", byVendorPrefix).ShouldBeTrue();
        LegacyCatalogRules.NeedsAllowanceAfterTightening("openai/claude-3-opus", byVendorPrefix).ShouldBeTrue();

        // 受 v3（标点收紧）影响的：旧口径把点改成横杠就命中，新口径落空。
        LegacyCatalogRules.NeedsAllowanceAfterTightening("gpt-4-1", byPunctuation).ShouldBeTrue();
        LegacyCatalogRules.NeedsAllowanceAfterTightening("gpt_4.1", byPunctuation).ShouldBeTrue();

        // 受 v4（后缀收紧）影响的：旧口径剥掉日期 / -latest 就命中，新口径落空。
        LegacyCatalogRules.NeedsAllowanceAfterTightening("gpt-4o-2024-08-06", bySuffix).ShouldBeTrue();
        LegacyCatalogRules.NeedsAllowanceAfterTightening("o3-mini-latest", bySuffix).ShouldBeTrue();

        // **这条是本用例的重点**：两头都判外的陌生模型，任何一个窗口都不许放行。
        // 它正是「绕过控制台直接写库」那一种，也正是数据面名录门存在的理由。
        foreach (var stranger in new[]
                 {
                     "some-vendor/never-heard-of-this", "acme/unknown",
                     "gpt-4o-my-private-finetune", "totally-made-up-model",
                 })
        {
            LegacyCatalogRules.NeedsAllowanceAfterTightening(stranger, byVendorPrefix).ShouldBeFalse(
                customMessage: $"「{stranger}」两个口径下都不在名录里，厂商段收紧的窗口不该顺手放行它");
            LegacyCatalogRules.NeedsAllowanceAfterTightening(stranger, byPunctuation).ShouldBeFalse(
                customMessage: $"「{stranger}」两个口径下都不在名录里，标点收紧的窗口不该顺手放行它");
            LegacyCatalogRules.NeedsAllowanceAfterTightening(stranger, bySuffix).ShouldBeFalse(
                customMessage: $"「{stranger}」两个口径下都不在名录里，后缀收紧的窗口不该顺手放行它");
        }

        // 新口径下仍在名录里的，本来就不需要放行标记，窗口也不该动它们。
        foreach (var stillFine in new[] { "gpt-4o", "openai/gpt-4o", "gpt-4.1", "claude-3.5-sonnet" })
        {
            LegacyCatalogRules.NeedsAllowanceAfterTightening(stillFine, byVendorPrefix).ShouldBeFalse();
            LegacyCatalogRules.NeedsAllowanceAfterTightening(stillFine, byPunctuation).ShouldBeFalse();
            LegacyCatalogRules.NeedsAllowanceAfterTightening(stillFine, bySuffix).ShouldBeFalse();
        }
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
    [InlineData("gpt-4-1")]
    [InlineData("gpt_4.1")]
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
            // 标点口径：登记过的写法命中，靠改写标点合成的写法必须落空——同样要两侧一致。
            "gpt-4.1", "gpt-4-1", "gpt_4.1", "openai/gpt-4-1", "gpt-3-5-turbo",
            "claude-3.5-sonnet", "anthropic/claude-3-5-sonnet",
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

        /*
          v1 是「名录门上线」那一次，无差别补标记是对的——那之前根本没有放行标记这回事。
          但**每一次口径收紧都必须给出自己的影响面判据**：沿用 v1 那个「此刻缺标记」的过滤，
          会把 v1 跑完之后绕过控制台直接写库塞进来的模型一起放行——那正是这道门要拦的那一种，
          等于每加一条迁移就把门重新开一次。
        */
        var v1Call = consoleProgram.IndexOf(
            $"RunCatalogGrandfatherAsync(\n    \"{PrdAgent.Core.LlmGateway.GatewayCatalogMigrations.GrandfatherV1}\"",
            StringComparison.Ordinal);
        v1Call.ShouldBeGreaterThan(-1, customMessage: "找不到 v1 迁移的调用，守卫的取值范围失效了");
        var v1End = consoleProgram.IndexOf(");", v1Call, StringComparison.Ordinal);
        consoleProgram[v1Call..v1End].ShouldNotContain(
            "LegacyCatalogRules",
            customMessage: "v1 是门上线那一次，本来就该无差别补标记");

        CountOccurrences(consoleProgram, "LegacyCatalogRules.NeedsAllowanceAfterTightening(").ShouldBe(
            3,
            customMessage: "三次口径收紧（厂商段、标点、后缀）各要一个「旧口径判内、新口径判外」的影响面判据；"
                + "少一个就是又用 v1 那个过宽的过滤放行了一批本该被拦的模型");
        consoleProgram.ShouldContain("LegacyCatalogRules.WasInCatalogBeforeStrictSuffix");
        consoleProgram.ShouldContain("LegacyCatalogRules.WasInCatalogBeforeStrictVendorPrefix");
        consoleProgram.ShouldContain("LegacyCatalogRules.WasInCatalogBeforeStrictPunctuation");

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

    /// <summary>
    /// 「哪些状态接流量」也是一对镜像：serving 按 GatewayAppCallerPolicy 判，
    /// 控制台的幂等创建按自己那份字面量判——后者是唯一一次精确身份查询，
    /// 页面只能模糊搜一页，所以拦不拦得住停用用途全靠控制台这一处。
    ///
    /// 两侧漂移的坏法是静默的：控制台放行了一条 serving 不认的状态，
    /// 页面照常签发，而那把 key 一调用就 APP_CALLER_DISABLED。
    /// </summary>
    [Fact]
    public void AppCallerTrafficStatuses_AgreeWithServingPolicy()
    {
        var consoleProgram = File.ReadAllText(RepoFile("llmgw/console-api/Program.cs"));

        // 控制台的幂等创建必须逐个列出 serving 认的那几种状态。
        foreach (var status in new[] { "discovered", "configured", "active" })
        {
            PrdAgent.Core.LlmGateway.GatewayAppCallerPolicy.AllowsTraffic(status).ShouldBeTrue(
                customMessage: $"「{status}」在 serving 侧应当放行；两侧的枚举必须一致");
        }

        // 控制台侧的镜像判定：枚举逐字一致。
        consoleProgram.ShouldContain(
            "is \"discovered\" or \"configured\" or \"active\"",
            customMessage: "控制台必须按 serving 那套枚举判：放行了 serving 不认的状态，"
                + "页面就会签出一把一调用即 APP_CALLER_DISABLED 的 key");

        // **只此一份**。这个判断在本仓库被抄散过两次，每一次都留下一条漏判的路径：
        // 幂等创建里「先查到那条」判了、撞唯一索引回读的胜者没判；系统 appCaller 判了归属、没判状态。
        // 抄第三份就会有第三条。所以判定收敛成一个函数，并钉住它的定义只出现一次。
        CountOccurrences(consoleProgram, "static bool AppCallerAcceptsTraffic(").ShouldBe(
            1,
            customMessage: "「这条 appCaller 接不接流量」只许有一个定义——多一份就多一条会漏判的路径");

        // 三条路径都得从这道门过：幂等创建先查到的那条、撞索引回读的胜者、系统自建的那条。
        CountOccurrences(consoleProgram, "AppCallerAcceptsTraffic(").ShouldBeGreaterThanOrEqualTo(
            3,
            customMessage: "定义 1 处 + 至少 2 个调用点（幂等创建那道共用门、系统自建的那条）；"
                + "少一个调用点就是又留下一条「查到了就当能用」的路径");

        // 幂等创建的两条路径必须走同一道门，而不是各写各的。
        CountOccurrences(consoleProgram, "RejectUnusableExistingAppCaller(").ShouldBe(
            3,
            customMessage: "定义 1 处 + 两个调用点（先查到那条、撞唯一索引回读的胜者）——"
                + "撞索引那条此前只判归属不判状态，并发下的胜者是停用记录时会被当成登记成功");

        consoleProgram.ShouldContain(
            "\"APP_CALLER_DISABLED\"",
            customMessage: "拒绝要给专属错误码，否则页面只能显示一句「创建失败」，用户不知道去哪恢复");

        // serving 侧不认的状态，控制台也不许出现在那张放行清单里。
        PrdAgent.Core.LlmGateway.GatewayAppCallerPolicy.AllowsTraffic("archived").ShouldBeFalse();
        PrdAgent.Core.LlmGateway.GatewayAppCallerPolicy.AllowsTraffic("disabled").ShouldBeFalse();
    }

    /// <summary>
    /// 批量导入必须**先全批校验、再动第一次库**。
    ///
    /// 这条的坏法是静默的半committed：价格校验原来写在插入循环里，前面几条已经插进去了，
    /// 轮到一条价格非法的才返回 400。于是用户被告知「导入失败」，库里却多了几条模型；
    /// 而那个 400 还跳过了后面的默认池同步与 platform.models.import 审计——那几条既没进池
    /// （池路由选不到，业务侧调不通），也没留下任何「谁在什么时候导入了它们」的记录。
    ///
    /// 判据是**位置关系**而不是「这段代码在不在」：校验必须排在插入之前。
    /// 把它挪回循环里（位置落到插入之后），这条当场红。
    /// </summary>
    [Fact]
    public void ModelImport_ValidatesTheWholeBatchBeforeTheFirstInsert()
    {
        var consoleProgram = File.ReadAllText(RepoFile("llmgw/console-api/Program.cs"));

        var endpointAt = consoleProgram.IndexOf(
            "app.MapPost(\"/gw/platforms/{id}/models/import\"", StringComparison.Ordinal);
        endpointAt.ShouldBeGreaterThan(-1, customMessage: "找不到批量导入端点，守卫的取值范围失效了");

        var validateAt = consoleProgram.IndexOf(
            "GatewayConfigurationProvisioning.IsSupportedCurrency(entry.PriceCurrency)", endpointAt, StringComparison.Ordinal);
        var insertAt = consoleProgram.IndexOf("await gwModels.InsertOneAsync(doc)", endpointAt, StringComparison.Ordinal);

        validateAt.ShouldBeGreaterThan(-1, customMessage: "批量导入必须校验价格与币种，否则负价格会直接进成本核算");
        insertAt.ShouldBeGreaterThan(-1, customMessage: "找不到插入点，守卫的取值范围失效了");

        /*
          判据锚在**插入循环的 foreach 头**上，不是锚在插入那一行上。

          「校验排在 InsertOneAsync 这一行之前」是个假判据：把校验塞进循环体里、
          写在插入语句上方，它照样成立——而那正是这条要防的写法（前几条已经插进去了，
          第 N 条才 400）。真正要问的是「校验在不在循环外面」，所以取插入点之前
          最后一个 foreach 头，校验必须比它更早。
        */
        var insertLoopAt = consoleProgram.LastIndexOf(
            "foreach (var entry in entries)", insertAt, StringComparison.Ordinal);
        insertLoopAt.ShouldBeGreaterThan(endpointAt, customMessage: "找不到插入循环的头，守卫的取值范围失效了");
        validateAt.ShouldBeLessThan(
            insertLoopAt,
            customMessage: "价格与币种必须在**进入插入循环之前**全批校验完——校验落在循环里，"
                + "非法入参会留下几条既没进池也没进审计的模型，而调用方收到的是「导入失败」");

        // 循环里不许再留一份：留着就等于「先校验一遍、再边插边校验」，后者照样会半途返回。
        CountOccurrences(consoleProgram, "GatewayConfigurationProvisioning.IsSupportedCurrency(entry.PriceCurrency)").ShouldBe(
            1,
            customMessage: "这批校验只许有一处（全批预检那一处）；插入循环里再留一份就又能半途 400");
    }

    /// <summary>数子串出现次数：判「只此一份」与「每条路径都接上了」都靠它，比断言某一行存在更贴合。</summary>
    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        var at = haystack.IndexOf(needle, StringComparison.Ordinal);
        while (at >= 0)
        {
            count++;
            at = haystack.IndexOf(needle, at + needle.Length, StringComparison.Ordinal);
        }
        return count;
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
