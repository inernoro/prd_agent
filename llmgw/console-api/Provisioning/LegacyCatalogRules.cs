namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// 名录判定的**历史口径**，只给一次性补标记迁移用。
///
/// 为什么需要它：每次收紧名录判定，都会有一批模型「昨天判成名录内、今天判成名录外」。
/// 它们当年入库时因为「判成名录内」而没有被要求盖放行标记，收紧之后会在 enforce 档下
/// 集体被拒——所以每次收紧自带一个一次性窗口给它们补标记。
///
/// 但窗口必须**只覆盖真受这次收紧影响的那些**。用「此刻缺标记」当判据太宽：
/// 上一次窗口跑完之后绕过控制台直接写库塞进来的模型同样缺标记，下一个窗口会顺手把它们
/// 一起放行——那正是这道门要拦的那一种，等于每加一条迁移就把门重新开一次。
/// 所以判据是「**旧口径判成名录内，新口径判成名录外**」，两头都要算。
///
/// **这里的规则是冻结的，不许跟着 <see cref="ModelCatalog"/> 一起演进。**
/// 它描述的是历史上某一刻的判定方式，改了它就等于改写历史，会让窗口覆盖错人。
/// 与 ModelCatalog 里看起来重复的那几段是**有意重复**，不要「顺手统一」掉——
/// 尤其是那几个后缀/标点改写：ModelCatalog 已经不再做了，而这里必须原样留着，
/// 因为它们正是当年那个口径的定义。
/// </summary>
public static class LegacyCatalogRules
{
    /// <summary>历史上做过的两种改写，按收紧的先后拆开：先没了标点合并（v3），再没了后缀剥除（v4）。</summary>
    private static string StripSnapshotSuffix(string id)
    {
        id = System.Text.RegularExpressions.Regex.Replace(id, @"-\d{4}-\d{2}-\d{2}$", string.Empty);
        id = System.Text.RegularExpressions.Regex.Replace(id, @"-\d{8}$", string.Empty);
        if (id.EndsWith("-latest", StringComparison.Ordinal)) id = id[..^"-latest".Length];
        return id;
    }

    /// <summary>
    /// v3 收紧之前的归一化：小写、**把 `.` `_` 一律改写成 `-`**、去日期快照、去 `-latest`。
    /// 标点合并正是 v3 收紧掉的那一条。
    /// </summary>
    private static string NormalizeWithPunctuationCollapsed(string? modelId)
    {
        var id = (modelId ?? string.Empty).Trim().ToLowerInvariant();
        if (id.Length == 0) return string.Empty;
        id = id.Replace('.', '-').Replace('_', '-');
        return StripSnapshotSuffix(id);
    }

    /// <summary>
    /// v4 收紧之前的归一化：标点已经不合并了（v3 收紧过），但日期快照与 `-latest` 仍被剥掉。
    /// 后缀剥除正是 v4 收紧掉的那一条。
    /// </summary>
    private static string NormalizeWithSuffixStripped(string? modelId)
    {
        var id = (modelId ?? string.Empty).Trim().ToLowerInvariant();
        if (id.Length == 0) return string.Empty;
        return StripSnapshotSuffix(id);
    }

    /// <summary>按给定归一化建一份名录索引（登记的标识与别名都进）。</summary>
    private static Dictionary<string, CatalogModel> BuildIndex(Func<string?, string> normalize)
    {
        var index = new Dictionary<string, CatalogModel>(StringComparer.OrdinalIgnoreCase);
        foreach (var model in ModelCatalog.All)
        {
            index[normalize(model.CanonicalId)] = model;
            foreach (var alias in model.Aliases ?? Array.Empty<string>())
                index[normalize(alias)] = model;
        }
        return index;
    }

    private static readonly Dictionary<string, CatalogModel> PunctuationCollapsedIndex =
        BuildIndex(NormalizeWithPunctuationCollapsed);

    private static readonly Dictionary<string, CatalogModel> SuffixStrippedIndex =
        BuildIndex(NormalizeWithSuffixStripped);

    /// <summary>这条登记自己认不认这个厂商段？（与当时 ModelCatalog 的判定一致，按那一刻的归一化算。）</summary>
    private static bool RegistersVendorSegment(CatalogModel model, string vendor, Func<string?, string> normalize)
    {
        if (string.Equals(normalize(model.Vendor), vendor, StringComparison.OrdinalIgnoreCase))
            return true;
        foreach (var alias in model.Aliases ?? Array.Empty<string>())
        {
            var normalized = normalize(alias);
            var slash = normalized.IndexOf('/');
            if (slash > 0 && string.Equals(normalized[..slash], vendor, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    /// <summary>
    /// **v2（厂商段收紧）之前**的判定：归一化含标点合并与后缀剥除，查不到时剥掉斜杠前的
    /// **任意**一段重查。于是 `private-provider/gpt-4o` 当年判成名录内的 `gpt-4o`。
    /// </summary>
    public static bool WasInCatalogBeforeStrictVendorPrefix(string? modelId)
    {
        var key = NormalizeWithPunctuationCollapsed(modelId);
        if (key.Length == 0) return false;
        if (PunctuationCollapsedIndex.ContainsKey(key)) return true;

        var slash = key.IndexOf('/');
        if (slash <= 0 || slash >= key.Length - 1) return false;
        return PunctuationCollapsedIndex.ContainsKey(key[(slash + 1)..]);
    }

    /// <summary>
    /// **v3（标点收紧）之前**的判定：归一化仍含标点合并，而前缀规则已经是 v2 之后的
    /// 「只剥名录自己登记过的厂商段」。于是 `gpt-4-1` 当年判成名录内的 `gpt-4.1`。
    /// </summary>
    public static bool WasInCatalogBeforeStrictPunctuation(string? modelId)
        => WasInCatalogUnder(modelId, NormalizeWithPunctuationCollapsed, PunctuationCollapsedIndex);

    /// <summary>
    /// **v4（后缀收紧）之前**的判定：标点已不合并，而日期快照与 `-latest` 仍被剥掉。
    /// 于是名录里没登记过的 `gpt-4o-2024-08-06` 当年判成名录内的 `gpt-4o`。
    /// </summary>
    public static bool WasInCatalogBeforeStrictSuffix(string? modelId)
        => WasInCatalogUnder(modelId, NormalizeWithSuffixStripped, SuffixStrippedIndex);

    /// <summary>v2 之后那套前缀规则（只剥名录自己登记过的厂商段）+ 指定的历史归一化。</summary>
    private static bool WasInCatalogUnder(
        string? modelId,
        Func<string?, string> normalize,
        Dictionary<string, CatalogModel> index)
    {
        var key = normalize(modelId);
        if (key.Length == 0) return false;
        if (index.ContainsKey(key)) return true;

        var slash = key.IndexOf('/');
        if (slash <= 0 || slash >= key.Length - 1) return false;
        if (!index.TryGetValue(key[(slash + 1)..], out var stripped)) return false;
        return RegistersVendorSegment(stripped, key[..slash], normalize);
    }

    /// <summary>
    /// 这条模型该不该被「某次口径收紧」的窗口补标记：旧口径判内、新口径判外，两条同时成立才算。
    /// 两头都判外的（比如绕过控制台直接写库塞进来的陌生模型）一律不放行——那正是这道门要拦的。
    /// </summary>
    public static bool NeedsAllowanceAfterTightening(string? modelId, Func<string?, bool> wasInCatalog)
        => wasInCatalog(modelId) && !ModelCatalog.Contains(modelId);
}
