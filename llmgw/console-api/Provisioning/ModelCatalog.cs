namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// 一条已知模型的登记。只登记**我们确实知道**的事实：它能吃什么、能吐什么、算哪几种用途。
///
/// 刻意不登记的：价格（只认上游自己返回的，见 <see cref="ProviderPresets.ReadPricing"/>）、
/// 上下文窗口（各家同名模型在不同网关上限不同，写死会骗人）。名录的职责是「这个模型是什么」，
/// 不是「这个模型多少钱、能塞多少字」——后两者有各自的权威来源，混进来就成了第二份会漂移的真相。
/// </summary>
/// <param name="CanonicalId">规范标识，取上游最通用的那个写法（如 <c>gpt-4o</c>）。</param>
/// <param name="DisplayName">给人看的名字。</param>
/// <param name="Vendor">模型的出品方，不是接入它的那个 Provider——同一个模型会经多个网关转售。</param>
/// <param name="Capabilities">存储层能力名，取值必须在 <c>LogicalModelCapabilityPolicy.CanonicalCapabilities</c> 里。</param>
/// <param name="AcceptsImageInput">能不能接收图片输入。</param>
/// <param name="RequiresImageInput">**必须**给图才能调（图片编辑类）；给不出图就别让用户点发送。</param>
/// <param name="Aliases">等价写法：厂商前缀、日期快照、各网关的改名。命中任一即认作同一个模型。</param>
public sealed record CatalogModel(
    string CanonicalId,
    string DisplayName,
    string Vendor,
    IReadOnlyList<string> Capabilities,
    bool AcceptsImageInput = false,
    bool RequiresImageInput = false,
    IReadOnlyList<string>? Aliases = null);

/// <summary>
/// 已知模型名录（白名单的内置那一半）。
///
/// **为什么要有它**：在此之前，模型的用途是拿模型 ID 做关键词匹配猜出来的
/// （<see cref="ProviderPresets.InferCapabilities"/>）——名字里有 <c>-vl</c> 就当能看图、
/// 有 <c>flux</c> 就当能生图，都没命中且像对话家族就给 <c>chat</c>。猜错的模型照样入池、
/// 照样被调度，等真发请求才炸，用户看到的就是「一请求就报错」。名录把这件事从「猜」
/// 变成「查」：命中名录就用名录里登记的事实，猜测降级为兜底并**如实标注来源**。
///
/// **名录不是全集，也不打算成为全集**。它是「我们确实了解的那批模型」，上游新出的、
/// 小众的、私有部署的，走管理员显式放行那条路（方案 B），放行动作进审计。名录只增不改语义：
/// 改一条已登记模型的能力等于改变线上路由行为，要有对应的迁移说明。
///
/// **别名的意义**：同一个模型在不同网关上写法不同（<c>openai/gpt-4o</c>、<c>gpt-4o-2024-08-06</c>、
/// <c>gpt-4o-latest</c>）。归一化 + 别名表让这些写法落到同一条登记上，避免「同一个模型登记三份、
/// 三份能力还不一样」这种下一次漂移的温床。
/// </summary>
public static class ModelCatalog
{
    /// <summary>能力来源，必须透出到界面：用户有权知道这条用途是查出来的还是猜出来的。</summary>
    public const string SourceCatalog = "catalog";
    public const string SourceUpstream = "upstream";
    public const string SourceGuess = "guess";

    public static IReadOnlyList<CatalogModel> All { get; } = new List<CatalogModel>
    {
        // ── OpenAI ───────────────────────────────────────────────────────────
        new("gpt-4o", "GPT-4o", "openai", ["chat", "vision", "function_calling", "structured_output"],
            AcceptsImageInput: true,
            Aliases: ["openai/gpt-4o", "gpt-4o-latest", "chatgpt-4o-latest"]),
        new("gpt-4o-mini", "GPT-4o mini", "openai", ["chat", "vision", "function_calling", "structured_output"],
            AcceptsImageInput: true,
            Aliases: ["openai/gpt-4o-mini"]),
        new("gpt-4.1", "GPT-4.1", "openai", ["chat", "vision", "function_calling", "structured_output", "long_context"],
            AcceptsImageInput: true,
            Aliases: ["openai/gpt-4.1"]),
        new("gpt-4.1-mini", "GPT-4.1 mini", "openai", ["chat", "vision", "function_calling", "structured_output", "long_context"],
            AcceptsImageInput: true,
            Aliases: ["openai/gpt-4.1-mini"]),
        new("gpt-3.5-turbo", "GPT-3.5 Turbo", "openai", ["chat", "function_calling"],
            Aliases: ["openai/gpt-3.5-turbo"]),
        new("gpt-4-turbo", "GPT-4 Turbo", "openai", ["chat", "vision", "function_calling"],
            AcceptsImageInput: true, Aliases: ["openai/gpt-4-turbo"]),
        new("o1", "o1", "openai", ["chat", "reasoning", "vision", "function_calling"],
            AcceptsImageInput: true, Aliases: ["openai/o1", "o1-preview"]),
        // o1-mini / o3-mini 只登记确实知道的：会推理、能对话。没把握的能力一律不写——
        // 名录写错比不写更糟，它是被当成事实用的。
        new("o1-mini", "o1-mini", "openai", ["chat", "reasoning"], Aliases: ["openai/o1-mini"]),
        new("o3-mini", "o3-mini", "openai", ["chat", "reasoning", "function_calling"], Aliases: ["openai/o3-mini"]),
        new("o3", "o3", "openai", ["chat", "reasoning", "vision", "function_calling"],
            AcceptsImageInput: true, Aliases: ["openai/o3"]),
        new("o4-mini", "o4-mini", "openai", ["chat", "reasoning", "vision", "function_calling"],
            AcceptsImageInput: true, Aliases: ["openai/o4-mini"]),
        new("text-embedding-3-small", "Embedding 3 small", "openai", ["embedding"],
            Aliases: ["openai/text-embedding-3-small"]),
        new("text-embedding-3-large", "Embedding 3 large", "openai", ["embedding"],
            Aliases: ["openai/text-embedding-3-large"]),
        new("dall-e-3", "DALL·E 3", "openai", ["image_generation", "text2img"],
            Aliases: ["openai/dall-e-3", "dalle-3"]),
        // 图片编辑：没有原图就无从编辑起，界面必须先要图再放行发送。
        new("gpt-image-1", "GPT Image 1", "openai", ["image_generation", "text2img", "img2img"],
            AcceptsImageInput: true, Aliases: ["openai/gpt-image-1"]),
        new("whisper-1", "Whisper", "openai", ["asr"], Aliases: ["openai/whisper-1"]),

        // ── Anthropic ────────────────────────────────────────────────────────
        new("claude-3-5-sonnet", "Claude 3.5 Sonnet", "anthropic",
            ["chat", "vision", "function_calling", "long_context"],
            AcceptsImageInput: true,
            Aliases: ["anthropic/claude-3.5-sonnet", "claude-3.5-sonnet", "claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022"]),
        new("claude-3-5-haiku", "Claude 3.5 Haiku", "anthropic",
            ["chat", "vision", "function_calling"],
            AcceptsImageInput: true,
            Aliases: ["anthropic/claude-3.5-haiku", "claude-3.5-haiku", "claude-3-5-haiku-latest"]),
        new("claude-3-opus", "Claude 3 Opus", "anthropic",
            ["chat", "vision", "function_calling", "long_context"],
            AcceptsImageInput: true,
            Aliases: ["anthropic/claude-3-opus", "claude-3-opus-latest"]),

        // ── Google ───────────────────────────────────────────────────────────
        new("gemini-1.5-pro", "Gemini 1.5 Pro", "google",
            ["chat", "vision", "function_calling", "long_context"],
            AcceptsImageInput: true, Aliases: ["google/gemini-1.5-pro", "gemini-1.5-pro-latest"]),
        new("gemini-1.5-flash", "Gemini 1.5 Flash", "google",
            ["chat", "vision", "function_calling", "long_context"],
            AcceptsImageInput: true, Aliases: ["google/gemini-1.5-flash", "gemini-1.5-flash-latest"]),
        new("gemini-2.0-flash", "Gemini 2.0 Flash", "google",
            ["chat", "vision", "function_calling"],
            AcceptsImageInput: true, Aliases: ["google/gemini-2.0-flash", "gemini-2.0-flash-exp"]),

        // ── DeepSeek ─────────────────────────────────────────────────────────
        new("deepseek-chat", "DeepSeek Chat", "deepseek", ["chat", "function_calling"],
            Aliases: ["deepseek/deepseek-chat", "deepseek-v3"]),
        new("deepseek-reasoner", "DeepSeek Reasoner", "deepseek", ["chat", "reasoning"],
            Aliases: ["deepseek/deepseek-r1", "deepseek-r1"]),
        new("deepseek-coder", "DeepSeek Coder", "deepseek", ["chat", "code"],
            Aliases: ["deepseek/deepseek-coder"]),

        // ── 阿里 通义千问 ────────────────────────────────────────────────────
        new("qwen-max", "通义千问 Max", "alibaba", ["chat", "function_calling"],
            Aliases: ["qwen/qwen-max", "qwen-max-latest"]),
        new("qwen-plus", "通义千问 Plus", "alibaba", ["chat", "function_calling"],
            Aliases: ["qwen/qwen-plus", "qwen-plus-latest"]),
        new("qwen-turbo", "通义千问 Turbo", "alibaba", ["chat"],
            Aliases: ["qwen/qwen-turbo"]),
        new("qwen-vl-max", "通义千问 VL Max", "alibaba", ["chat", "vision"],
            AcceptsImageInput: true, Aliases: ["qwen/qwen-vl-max", "qwen-vl-max-latest"]),
        new("qwen-vl-plus", "通义千问 VL Plus", "alibaba", ["chat", "vision"],
            AcceptsImageInput: true, Aliases: ["qwen/qwen-vl-plus"]),
        new("text-embedding-v3", "通义向量 v3", "alibaba", ["embedding"],
            Aliases: ["qwen/text-embedding-v3"]),

        // ── 智谱 GLM ─────────────────────────────────────────────────────────
        new("glm-4", "GLM-4", "zhipu", ["chat", "function_calling"], Aliases: ["zhipu/glm-4"]),
        new("glm-4v", "GLM-4V", "zhipu", ["chat", "vision"],
            AcceptsImageInput: true, Aliases: ["zhipu/glm-4v"]),

        // ── 月之暗面 Kimi ────────────────────────────────────────────────────
        new("moonshot-v1-8k", "Kimi 8k", "moonshot", ["chat"], Aliases: ["moonshot/moonshot-v1-8k"]),
        new("moonshot-v1-32k", "Kimi 32k", "moonshot", ["chat", "long_context"], Aliases: ["moonshot/moonshot-v1-32k"]),
        new("moonshot-v1-128k", "Kimi 128k", "moonshot", ["chat", "long_context"], Aliases: ["moonshot/moonshot-v1-128k"]),

        // ── 字节 豆包 ────────────────────────────────────────────────────────
        new("doubao-pro", "豆包 Pro", "bytedance", ["chat", "function_calling"], Aliases: ["doubao-pro-32k", "doubao-pro-128k"]),
        new("doubao-vision", "豆包 Vision", "bytedance", ["chat", "vision"],
            AcceptsImageInput: true, Aliases: ["doubao-vision-pro"]),
    };

    private static readonly Dictionary<string, CatalogModel> ByKey = BuildIndex();

    private static Dictionary<string, CatalogModel> BuildIndex()
    {
        var index = new Dictionary<string, CatalogModel>(StringComparer.OrdinalIgnoreCase);
        foreach (var model in All)
        {
            index[Normalize(model.CanonicalId)] = model;
            foreach (var alias in model.Aliases ?? Array.Empty<string>())
                index[Normalize(alias)] = model;
        }
        return index;
    }

    /// <summary>
    /// 归一化模型标识，让「同一个模型的不同写法」落到同一条登记上：
    /// 统一小写、去掉日期快照后缀（<c>gpt-4o-2024-08-06</c>）、去掉 <c>-latest</c>。
    ///
    /// **标点不合并**：`.` 与 `_` 不会被改写成 `-`。合并它们等于凭标点**合成别名**——
    /// 从没登记过的 `gpt-4-1` / `gpt_4.1` 会落到登记过的 `gpt-4.1` 上，继承它的用途与能力，
    /// 并且因为「判成名录内」而不需要任何放行标记：导入确认与数据面名录门一起放过它。
    /// 这与本注释最后一段自己立的规矩（名录是白名单，不做模糊匹配）也是矛盾的。
    /// 真实上游确实在用的另一种标点写法（`claude-3.5-sonnet` 之于 `claude-3-5-sonnet`）
    /// **逐条登记为别名**，走白名单而不是靠合成。
    ///
    /// **厂商前缀保留**，不在这里剥。它是标识的一部分：`private-provider/gpt-4o` 与 `gpt-4o`
    /// 是两个东西，无条件剥掉前缀等于把一个从没登记过的别名认成登记过的那个，连带继承它的
    /// 用途与能力——而两道门用的是同一个判据，于是导入确认与数据面名录门一起失守。
    /// 已知上游的前缀写法（<c>openai/gpt-4o</c> 一类）由名录**逐条登记为别名**，走的是白名单，
    /// 不是猜；<see cref="Find"/> 里那一档只剥名录自己登记过的厂商段。
    ///
    /// 刻意**不**做模糊匹配（不做前缀包含、不做编辑距离）：名录是白名单，
    /// 「差不多像」不能等于「就是它」——那正是关键词猜测出问题的地方。
    /// </summary>
    public static string Normalize(string? modelId)
    {
        var id = (modelId ?? string.Empty).Trim().ToLowerInvariant();
        if (id.Length == 0) return string.Empty;

        // 日期快照后缀：-20240806 / -2024-08-06
        id = System.Text.RegularExpressions.Regex.Replace(id, @"-\d{4}-\d{2}-\d{2}$", string.Empty);
        id = System.Text.RegularExpressions.Regex.Replace(id, @"-\d{8}$", string.Empty);
        if (id.EndsWith("-latest", StringComparison.Ordinal)) id = id[..^"-latest".Length];

        return id;
    }

    /// <summary>
    /// 查名录。命中返回登记，未命中返回 null——**不猜**。
    ///
    /// 先按完整标识查（前缀是标识的一部分）。没查到且带前缀时，只在那个前缀是
    /// **名录自己登记过的厂商段**时才剥掉它再查一次：`openai/o1-preview` 该落到
    /// `o1-preview` 上，而 `private-provider/gpt-4o` 必须查不到——它跟 `gpt-4o`
    /// 不是同一个模型，认成同一个就等于让一个没登记过的别名继承了别人的能力登记。
    /// </summary>
    public static CatalogModel? Find(string? modelId)
    {
        var key = Normalize(modelId);
        if (key.Length == 0) return null;
        if (ByKey.TryGetValue(key, out var direct)) return direct;

        // 只剥一层，而且剥掉的那一段必须是**命中的那条登记自己的**厂商段。
        // 用一张全局「见过的厂商段」白名单是不够的：`openai` 与 `claude-3-opus` 各自
        // 都登记过，拼在一起的 `openai/claude-3-opus` 从没被登记过，却会被剥成
        // `claude-3-opus` 认成 Anthropic 那条——一个没人见过的标识就这样继承了
        // 别人的用途与能力，导入确认与数据面名录门一起放过它。
        var slash = key.IndexOf('/');
        if (slash <= 0 || slash >= key.Length - 1) return null;
        if (!ByKey.TryGetValue(key[(slash + 1)..], out var stripped)) return null;
        return RegistersVendorSegment(stripped, key[..slash]) ? stripped : null;
    }

    /// <summary>这条登记自己认不认这个厂商段？认它的出品方，或它登记过的带前缀别名。</summary>
    private static bool RegistersVendorSegment(CatalogModel model, string vendor)
    {
        if (string.Equals(Normalize(model.Vendor), vendor, StringComparison.OrdinalIgnoreCase)) return true;
        foreach (var alias in model.Aliases ?? Array.Empty<string>())
        {
            var normalized = Normalize(alias);
            var slash = normalized.IndexOf('/');
            if (slash > 0 && string.Equals(normalized[..slash], vendor, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    public static bool Contains(string? modelId) => Find(modelId) is not null;

    /// <summary>
    /// 解析一个模型的用途，并**如实报告这批用途是哪来的**。
    ///
    /// 优先级：名录 &gt; 上游自己声明的 &gt; 关键词猜测。猜测保留但降级——它仍是唯一
    /// 能覆盖名录外模型的手段，只是从此不再冒充事实：来源标成 <see cref="SourceGuess"/>，
    /// 界面要照实说「这是按名字猜的，请核对」。
    /// </summary>
    public static (IReadOnlyList<string> Capabilities, string Source) ResolveCapabilities(
        string? modelId, IReadOnlyList<string>? upstreamDeclared)
    {
        var entry = Find(modelId);
        if (entry is not null) return (entry.Capabilities, SourceCatalog);

        var declared = (upstreamDeclared ?? Array.Empty<string>())
            .Where(c => !string.IsNullOrWhiteSpace(c))
            .Select(c => c.Trim().ToLowerInvariant())
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (declared.Count > 0) return (declared, SourceUpstream);

        return (ProviderPresets.InferCapabilities(modelId ?? string.Empty), SourceGuess);
    }
}
