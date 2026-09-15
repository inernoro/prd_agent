namespace PrdAgent.Api.Services.ModelLeaderboard;

/// <summary>榜单条目的授权归类。前端只读这个值，不自己判字符串。</summary>
public static class LicenseKind
{
    /// <summary>能认出来的标准开源许可（MIT / Apache / BSD…）。「仅开源」筛选只放这一类。</summary>
    public const string Open = "open";

    /// <summary>带明确使用限制：闭源、非商用、仅研究、各家 community 许可。</summary>
    public const string Restricted = "restricted";

    /// <summary>认不出来，或者页面上压根没给授权段。<b>不是「开源」的同义词。</b></summary>
    public const string Unknown = "unknown";
}

/// <summary>
/// 把 arena.ai 页面上那段授权文本归类。
///
/// ## 为什么不能沿用「除了 Proprietary 都算开源」
///
/// 原来的判据是 <c>!/proprietary/i.test(license)</c>，也就是**默认开源、只排除一个词**。
/// 拿线上四个榜的真实数据数一数就知道它错得多离谱——42 种不同的授权写法里，被这条判据
/// 标成「开源」并挂上绿色徽章的包括：
///
/// - <c>CC-BY-NC-4.0</c>、<c>flux-non-commercial-license</c>、<c>Non-commercial</c>——**明确非商用**；
/// - <c>Mistral Research</c>——**仅限研究**；
/// - <c>Llama 2/3/3.1/4 Community</c>、<c>Gemma license</c>、<c>MiniMax Community License</c>、
///   <c>tencent-hunyuan-community</c> 等九种——**source-available 但带使用限制**，不是开源。
///
/// 而页面上那个「仅开源」筛选，本页教程里是**推荐给想自部署的人**的。把非商用许可标成开源，
/// 是在一个用户会照着做决定的地方给错信息。
///
/// ## 判据方向：只有认得出来的才算开源，认不出的一律 unknown
///
/// 三态而不是二态，是因为这条长尾根本认不完（42 种写法，其中一半是各家自造的）。
/// 与其去猜尾巴，不如把「猜错的代价」摆正：
///
/// - 把非开源标成开源 = 用户照着自部署，踩许可证 → **不可接受**；
/// - 把开源标成 unknown = 它不出现在「仅开源」里，用户在「全部」里照样看得到，
///   而且授权原文一直在页面上摆着 → **可接受**。
///
/// 所以宁可漏，不可错：限制标记优先判，其次才是开源白名单，剩下全是 unknown
/// （<c>no-rootless-tree.md</c>：认不出来就说认不出来，不拿默认值冒充结论）。
///
/// ## 放后端
///
/// <c>frontend-architecture.md</c>「单一数据源原则」：业务映射表在后端维护，前端不许另存一份。
/// 前端拿到的是 <c>licenseKind</c>，不是一个让它自己去正则匹配的字符串。
/// </summary>
public static class ModelLicenseClassifier
{
    /// <summary>
    /// 带使用限制的标记。**先判它**：「Apache 2.0 with Commons Clause (non-commercial)」
    /// 这类写法里两边的词都在，限制必须赢。
    /// </summary>
    private static readonly string[] RestrictedMarkers =
    [
        "proprietary",      // Proprietary（线上 646 行）
        "non-commercial",   // flux-non-commercial-license / flux-1-dev-non-commercial-license
        "noncommercial",
        "non commercial",   // Non-commercial
        "-nc-",             // CC-BY-NC-4.0
        "cc-by-nc",
        "community",        // Llama * Community / *-community-license / MiniMax Community License…
        "research",         // Mistral Research
    ];

    /// <summary>
    /// 开源许可的家族前缀（规范化之后比）。写家族而不是逐个版本号，是为了不必为
    /// 「Apache 2.0 / Apache-2.0 / Apache License 2.0」这种同义写法各列一行——
    /// 那种逐条加同义词的表正是 AGENTS.md §5.5 熔断要防的东西。
    ///
    /// 只收**标准许可**。各家自造的（Gemma / Qianwen / DeepSeek / NVIDIA Open Model /
    /// Kimi K3 license / OpenMDW / Modified MIT）一律不进这张表：它们的条款得逐个读过才敢说开源，
    /// 而没读过就落 unknown 正是上面说的那个安全方向。
    /// </summary>
    private static readonly string[] OpenFamilies =
    [
        "mit",          // MIT（注意「Modified MIT」不以此开头，落 unknown，正确）
        "apache",       // Apache 2.0 / Apache-2.0
        "bsd",
        "mpl",
        "isc",
        "zlib",
        "unlicense",
        "cc0",
        "gpl",          // GPL / GPL-3.0
        "lgpl",
        "agpl",
    ];

    /// <summary>归类。<paramref name="license"/> 是页面上那段原文，可能为 null。</summary>
    public static string Classify(string? license)
    {
        var normalized = Normalize(license);
        if (normalized.Length == 0) return LicenseKind.Unknown;

        foreach (var marker in RestrictedMarkers)
        {
            if (normalized.Contains(marker, StringComparison.Ordinal))
                return LicenseKind.Restricted;
        }

        foreach (var family in OpenFamilies)
        {
            // 前缀 +「后面必须是分隔符或结尾」，不是 Contains：授权段是别人家页面上的自由文本，
            // Contains("mit") 会被 permit / transmit 这类词命中，而一次误判就是一个错的绿徽章。
            if (!normalized.StartsWith(family, StringComparison.Ordinal)) continue;
            if (normalized.Length == family.Length) return LicenseKind.Open;
            var next = normalized[family.Length];
            if (next is ' ' or '-' or '.' or '_' or '/') return LicenseKind.Open;
        }

        return LicenseKind.Unknown;
    }

    private static string Normalize(string? license)
        => (license ?? string.Empty).Trim().ToLowerInvariant();
}
