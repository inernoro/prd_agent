namespace PrdAgent.Core.Models;

/// <summary>
/// 逻辑模型能力（<c>llmgw_logical_models.Capabilities</c>）的唯一契约。
///
/// 为什么必须唯一：2026-08-11 起「写入侧只认 image_generation、运行时也只认 image_generation」，
/// 而正式环境存量数据里逻辑生图模型写的是历史值 image-gen。两侧各自解释同一个字段，
/// 结果 MAP 解析阶段把可用的逻辑模型整批过滤掉，候选数变 0，全站生图静默不可用，
/// 而 CI、容器、Gateway readiness 全绿（`predicate-and-wiring-discipline.md` 形状 1 + 形状 3）。
///
/// 因此：
/// 1. 规范能力 ID 只此一份；
/// 2. 历史别名是**有限**的显式表，只在读取判定与写入归一化时展开，数据库最终只保存规范值；
/// 3. 场景判定 <see cref="SupportsAppCallerScenario"/> 只此一份实现，
///    MAP 运行时（ModelResolver）、llmgw serving readiness、发布门禁与测试全部引用它，
///    禁止任何调用方再写 Contains / EndsWith / 字符串数组；
/// 4. 不认识的能力**不丢弃**，原样保留并由 <see cref="Normalize"/> 点名回报，
///    交给迁移与发布门禁阻断，不许静默吞掉。
///
/// 作用域说明：本契约管的是**逻辑模型的字符串能力数组**。
/// 物理模型 <c>llmgw_models.Capabilities</c> 是 <c>{Type,Value,Source}</c> 文档数组（另一套命名空间），
/// 本 PR 不改写它的存储形态；此处的词汇表把两套已知词都收进「已知」集合，
/// 只是为了让未知能力审计不会把物理模型词误报成未知。
/// </summary>
public static class GatewayCapabilityContract
{
    /// <summary>
    /// 能力契约版本。逻辑模型文档写入 <c>CapabilitySchemaVersion</c>，
    /// 迁移按版本判断是否需要重算；缺该字段的存量文档一律视为版本 0。
    /// </summary>
    public const int SchemaVersion = 1;

    /// <summary>逻辑模型文档里承载契约版本的字段名。迁移与运行时共用，禁止各写各的字面量。</summary>
    public const string SchemaVersionField = "CapabilitySchemaVersion";

    // ---------- 规范能力 ID（snake_case，落库只允许出现这些值 + 未知原值） ----------

    /// <summary>通用图片生成：没有更细的场景声明时，可服务全部图片场景。</summary>
    public const string ImageGeneration = "image_generation";

    /// <summary>纯文生图场景。</summary>
    public const string Text2Img = "text2img";

    /// <summary>单参考图生图场景。</summary>
    public const string Img2Img = "img2img";

    /// <summary>多参考图 / 视觉合成生图场景。</summary>
    public const string VisionGeneration = "vision_generation";

    /// <summary>图片分层：动作能力，只能被专用 appCaller 点名调用（见 capability-is-not-model 规则）。</summary>
    public const string ImageLayering = "image_layering";

    /// <summary>
    /// 图片分层的逻辑模型 PublicId。与能力 token 不是一套命名（PublicId 是 kebab-case），
    /// 两个都要认，否则换个数据来源就漏判。
    /// </summary>
    public const string ImageLayeringPublicId = "image-layering";

    public const string VideoGeneration = "video_generation";
    public const string AudioGeneration = "audio_generation";
    public const string LongContext = "long_context";

    /// <summary>
    /// 图片场景能力。声明了其中任意一项，就表示该逻辑模型**明确列举**了自己支持的场景，
    /// 此时不再享受通用 image_generation 的兜底放行。
    /// </summary>
    public static readonly IReadOnlyList<string> ImageScenarioCapabilities =
        [Text2Img, Img2Img, VisionGeneration];

    /// <summary>
    /// 已知能力词汇表（规范值）。包含逻辑模型场景词与物理模型用途词，
    /// 目的是让未知能力审计只对**真正没人认识**的 token 报警。
    /// </summary>
    private static readonly HashSet<string> KnownCapabilities = new(StringComparer.Ordinal)
    {
        // 逻辑模型：图片场景与动作
        ImageGeneration, Text2Img, Img2Img, VisionGeneration, ImageLayering,
        // 用途类（与 GatewayConfigurationProvisioning.ToCapabilityCode 的存储层能力名同词）
        "chat", "intent", "vision", "code", LongContext, "embedding", "rerank",
        "asr", "tts", VideoGeneration, AudioGeneration, "moderation",
        // 物理模型能力矩阵里已在用的判定词（ModelResolutionResult.CapabilityValue 系列）
        "function_calling", "tool_calling", "tools",
        "image_input", "multimodal", "image",
        "thinking", "reasoning",
        "structured_output", "json_schema", "json_mode", "response_format",
        "logprobs", "top_logprobs", "token_logprobs",
        "parallel_tool_calls", "parallel_tools", "parallel_function_calling",
    };

    /// <summary>
    /// **有限**历史别名表：旧写法 → 规范值。
    ///
    /// 只收录仓库或正式数据里真实出现过的写法，禁止改成「kebab 自动转 snake」这类开放规则——
    /// 开放规则会让任何新造的错别字都被静默接受，未知能力审计就永远报不出东西。
    /// 新别名进表必须有出处（哪个部署、哪条数据、哪次事故）。
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> LegacyAliasMap =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // 2026-08-13 事故：正式环境逻辑生图模型存量能力值。
            ["image-gen"] = ImageGeneration,
            ["image_gen"] = ImageGeneration,
            // 物理模型侧长期把 text_to_image 当作「能生图」的同义词
            // （见 ModelResolutionResult.ImageGenerationCapability），此处沿用同一语义，
            // 不要读成 text2img 场景。
            ["text_to_image"] = ImageGeneration,
            ["text-to-image"] = ImageGeneration,
            ["image-generation"] = ImageGeneration,
            // 用途名（kebab）历史上被直接写进能力数组
            ["video-gen"] = VideoGeneration,
            ["video-generation"] = VideoGeneration,
            ["audio-gen"] = AudioGeneration,
            ["audio-generation"] = AudioGeneration,
            ["long-context"] = LongContext,
            // 场景词的连字符写法
            ["vision-generation"] = VisionGeneration,
            ["image-layering"] = ImageLayering,
            ["text2image"] = Text2Img,
            ["img2image"] = Img2Img,
        };

    /// <summary>规范能力全集（只读，供守卫测试与控制台枚举使用）。</summary>
    public static IReadOnlyCollection<string> CanonicalCapabilities => KnownCapabilities;

    /// <summary>历史别名全集（只读，供守卫测试与镜像一致性校验使用）。</summary>
    public static IReadOnlyDictionary<string, string> LegacyAliases => LegacyAliasMap;

    /// <summary>
    /// 把单个能力 token 归一为规范值。
    /// 返回 null 表示**未知**——调用方必须显式处理（保留 + 上报），不许当成 false 丢掉。
    /// </summary>
    public static string? TryCanonicalize(string? raw)
    {
        var token = (raw ?? string.Empty).Trim().ToLowerInvariant();
        if (token.Length == 0) return null;
        if (KnownCapabilities.Contains(token)) return token;
        return LegacyAliasMap.TryGetValue(token, out var canonical) ? canonical : null;
    }

    /// <summary>某个 token 是否为已知能力（规范值或有限别名）。</summary>
    public static bool IsKnown(string? raw) => TryCanonicalize(raw) is not null;

    /// <summary>
    /// 归一化一组能力，返回落库值 + 未知 token 清单 + 是否发生变化。
    ///
    /// 落库值的构成顺序（稳定，便于幂等判定）：
    /// 1. 归一后的已知能力（去重，保持首次出现次序）；
    /// 2. <paramref name="modelType"/> 为 generation、含通用 image_generation 且**未**声明任何图片场景时，
    ///    补齐三个场景能力（保留 2026-08-11 起的既有行为）；
    /// 3. 未知 token 原样附在末尾——不丢弃，交给审计点名。
    /// </summary>
    public static GatewayCapabilityNormalization Normalize(string? modelType, IEnumerable<string>? capabilities)
    {
        var input = (capabilities ?? []).ToList();
        var canonical = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var unknown = new List<string>();
        var unknownSeen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var raw in input)
        {
            var token = (raw ?? string.Empty).Trim();
            if (token.Length == 0) continue;

            var resolved = TryCanonicalize(token);
            if (resolved is null)
            {
                if (unknownSeen.Add(token)) unknown.Add(token);
                continue;
            }

            if (seen.Add(resolved)) canonical.Add(resolved);
        }

        var isGeneration = string.Equals(modelType?.Trim(), "generation", StringComparison.OrdinalIgnoreCase);
        var backfilled = false;
        if (isGeneration
            && seen.Contains(ImageGeneration)
            && !ImageScenarioCapabilities.Any(seen.Contains))
        {
            foreach (var scenario in ImageScenarioCapabilities)
            {
                if (seen.Add(scenario)) canonical.Add(scenario);
            }
            backfilled = true;
        }

        var persisted = canonical.Concat(unknown).ToList();
        var changed = !persisted.SequenceEqual(input.Select(x => (x ?? string.Empty).Trim()), StringComparer.Ordinal);

        return new GatewayCapabilityNormalization(persisted, canonical, unknown, changed, backfilled);
    }

    /// <summary>
    /// appCaller 要求的图片场景能力；非图片场景返回 null（不凭空发明约束）。
    ///
    /// 判据只此一处：ModelResolver、readiness、控制台校验都调它，
    /// 谁也不许再写一遍 <c>EndsWith(".text2img::generation")</c>。
    /// </summary>
    public static string? RequiredScenarioCapability(string? appCallerCode)
    {
        var code = (appCallerCode ?? string.Empty).Trim();
        if (code.Length == 0) return null;
        if (code.EndsWith(".text2img::generation", StringComparison.OrdinalIgnoreCase)) return Text2Img;
        if (code.EndsWith(".img2img::generation", StringComparison.OrdinalIgnoreCase)) return Img2Img;
        if (code.EndsWith(".vision::generation", StringComparison.OrdinalIgnoreCase)) return VisionGeneration;
        return null;
    }

    /// <summary>
    /// 逻辑模型能否服务该 appCaller 的场景。**生产运行时、readiness 与发布门禁必须共用这一个判据。**
    ///
    /// 顺序：
    /// 1. 显式 allowlist 优先（配了就必须命中）；
    /// 2. 动作能力隔离：声明 image_layering 的模型只允许分层专用 appCaller；
    /// 3. 该 appCaller 无场景要求 → 放行；
    /// 4. 声明了所需场景 → 放行；
    /// 5. 兼容兜底：未声明任何图片场景、但有通用 image_generation → 放行
    ///    （2026-08-13 止血逻辑，正式数据迁移完成并有回滚方案前不得撤销）；
    /// 6. 否则拒绝。
    ///
    /// 全过程在**归一化之后**的集合上判定，所以 image-gen 这类历史别名天然被认，
    /// 不需要任何调用方再对字面量做特判。
    /// </summary>
    public static bool SupportsAppCallerScenario(
        IEnumerable<string>? capabilities,
        IEnumerable<string>? allowedAppCallerCodes,
        string appCallerCode)
    {
        var allowlist = (allowedAppCallerCodes ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
        if (allowlist.Count > 0
            && !allowlist.Contains(appCallerCode, StringComparer.OrdinalIgnoreCase))
        {
            return false;
        }

        var canonical = CanonicalSet(capabilities);

        if (canonical.Contains(ImageLayering))
        {
            return string.Equals(
                appCallerCode,
                AppCallerRegistry.VisualAgent.Image.Layering,
                StringComparison.OrdinalIgnoreCase);
        }

        var required = RequiredScenarioCapability(appCallerCode);
        if (required is null || canonical.Contains(required)) return true;

        var declaresAnyScenario = ImageScenarioCapabilities.Any(canonical.Contains)
                                  || canonical.Contains(ImageLayering);
        return !declaresAnyScenario && canonical.Contains(ImageGeneration);
    }

    /// <summary>
    /// 判断某个逻辑模型是「用户可以在选择器里挑的模型」还是「只能被具体动作调用的能力」。
    /// PublicId 与 Capabilities 两个信号都认——不同数据来源填的字段不一样，只认一个就漏。
    /// </summary>
    public static bool IsOperationOnly(string? publicId, IEnumerable<string>? capabilities)
    {
        var id = (publicId ?? string.Empty).Trim();
        if (id.Length > 0
            && string.Equals(id, ImageLayeringPublicId, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return CanonicalSet(capabilities).Contains(ImageLayering);
    }

    /// <summary>归一后的能力集合；未知 token 不会进入集合（它们不参与路由判定，只参与审计）。</summary>
    public static HashSet<string> CanonicalSet(IEnumerable<string>? capabilities)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in capabilities ?? [])
        {
            var canonical = TryCanonicalize(raw);
            if (canonical is not null) set.Add(canonical);
        }
        return set;
    }

    /// <summary>能力集合里的未知 token（原样返回，供审计点名）。</summary>
    public static IReadOnlyList<string> UnknownTokens(IEnumerable<string>? capabilities)
    {
        var unknown = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in capabilities ?? [])
        {
            var token = (raw ?? string.Empty).Trim();
            if (token.Length == 0) continue;
            if (TryCanonicalize(token) is not null) continue;
            if (seen.Add(token)) unknown.Add(token);
        }
        return unknown;
    }
}

/// <summary>
/// 能力归一化结果。
/// </summary>
/// <param name="Persisted">应当落库的能力数组（规范值在前，未知原值在后，未知不丢弃）。</param>
/// <param name="Canonical">参与路由判定的规范能力。</param>
/// <param name="Unknown">未识别的能力原值；发布门禁据此阻断并点名对象。</param>
/// <param name="Changed">与输入相比是否发生变化；迁移用它做幂等判定。</param>
/// <param name="ScenarioBackfilled">是否为通用生图模型补齐了三个图片场景能力。</param>
public sealed record GatewayCapabilityNormalization(
    IReadOnlyList<string> Persisted,
    IReadOnlyList<string> Canonical,
    IReadOnlyList<string> Unknown,
    bool Changed,
    bool ScenarioBackfilled);
