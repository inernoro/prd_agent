namespace PrdAgent.Core.Models;

/// <summary>
/// 一条已知模型的登记（运行时侧）。字段语义与写入侧镜像逐条相同。
/// </summary>
public sealed record GatewayCatalogModel(
    string CanonicalId,
    string DisplayName,
    string Vendor,
    IReadOnlyList<string> Capabilities,
    bool AcceptsImageInput = false,
    bool RequiresImageInput = false,
    IReadOnlyList<string>? Aliases = null);

/// <summary>
/// 已知模型名录的**运行时权威副本**。
///
/// 为什么要有两份：写入侧（llmgw console-api）按既定架构不引用 PrdAgent.*（镜像构建上下文
/// 只有 llmgw/console-api），所以名录在那边有一份；而拦截要发生在数据面——serving 与 MAP 的
/// ModelResolver 都在这边。这与能力契约 <see cref="GatewayCapabilityContract"/> 和它在写入侧的
/// 镜像是同一种处置，不是新发明：两份表由守卫测试逐条比对，任一侧改了另一侧没跟上，CI 立刻红。
///
/// 两道门的分工：**导入那道门**让用户在入库时就知道被拦了、为什么、怎么放行；
/// **这道门**兜住绕过控制台的路径（直接写库、旧数据、别的写入方），选中的模型
/// 既不在名录、又没有放行标记时，结构化失败而不是打给上游让它报一个看不懂的错。
/// </summary>
public static class GatewayModelCatalog
{
    public static IReadOnlyList<GatewayCatalogModel> All { get; } = new List<GatewayCatalogModel>
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
            Aliases: ["anthropic/claude-3.5-sonnet", "claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022"]),
        new("claude-3-5-haiku", "Claude 3.5 Haiku", "anthropic",
            ["chat", "vision", "function_calling"],
            AcceptsImageInput: true,
            Aliases: ["anthropic/claude-3.5-haiku", "claude-3-5-haiku-latest"]),
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

    private static readonly Dictionary<string, GatewayCatalogModel> ByKey = BuildIndex();

    private static Dictionary<string, GatewayCatalogModel> BuildIndex()
    {
        var index = new Dictionary<string, GatewayCatalogModel>(StringComparer.OrdinalIgnoreCase);
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
    /// 去掉日期快照后缀（<c>gpt-4o-2024-08-06</c>）、去掉 <c>-latest</c>，并统一小写与分隔符。
    ///
    /// **厂商前缀保留**，不在这里剥。它是标识的一部分：`private-provider/gpt-4o` 与 `gpt-4o`
    /// 是两个东西，无条件剥掉前缀等于把一个从没登记过的别名认成登记过的那个，连带继承它的
    /// 用途与能力——而两道门用的是同一个判据，于是导入确认与数据面名录门一起失守。
    /// 已知上游的前缀写法（<c>openai/gpt-4o</c> 一类）由名录**逐条登记为别名**，走的是白名单，
    /// 不是猜；<see cref="Find"/> 里那一档只剥名录自己登记过的厂商段。
    ///
    /// 与写入侧 <c>ModelCatalog</c> 的同名成员逐字相同：两道门共用这一套判据，
    /// 差一处就会出现「导入时判成名录内、请求时判成名录外」。守卫测试比对两份实现的输出。
    ///
    /// 刻意**不**做模糊匹配（不做前缀包含、不做编辑距离）：名录是白名单，
    /// 「差不多像」不能等于「就是它」——那正是关键词猜测出问题的地方。
    /// </summary>
    public static string Normalize(string? modelId)
    {
        var id = (modelId ?? string.Empty).Trim().ToLowerInvariant();
        if (id.Length == 0) return string.Empty;

        id = id.Replace('.', '-').Replace('_', '-');

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
    public static GatewayCatalogModel? Find(string? modelId)
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
    private static bool RegistersVendorSegment(GatewayCatalogModel model, string vendor)
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
}
