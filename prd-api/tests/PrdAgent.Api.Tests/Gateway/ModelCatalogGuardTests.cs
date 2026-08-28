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
    // 归一化要吃掉的三种写法：厂商前缀、日期快照、-latest。三者都必须落回同一条登记。
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
