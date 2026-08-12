using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// 内置上游预设。
///
/// 存在的理由见 .claude/rules/minimal-user-input.md：供应方的接口地址、协议类型、默认并发
/// 都是**系统本来就知道**的值，让用户去搜供应商文档再抄进输入框，是把系统的活转嫁给用户。
/// 用户只需要提供系统无从得知的那一个东西——密钥。
///
/// 这份表是后端 SSOT（对齐 frontend-architecture.md：前端不另维护一份映射表）。
/// 新增上游只改这里，控制台的搜索、下拉、默认值会一起跟上。
/// </summary>
public sealed record ProviderPreset(
    string Key,
    string Name,
    string PlatformType,
    string ApiUrl,
    string? ProviderId,
    int MaxConcurrency,
    string KeyConsoleUrl,
    string KeyPrefixHint,
    bool SupportsModelDiscovery,
    bool SupportsUpstreamPricing,
    string Summary,
    string[] SearchTerms,
    /// <summary>
    /// 本地/自建这类**不校验密钥**的上游，填一个占位密钥值；需要真密钥的上游为空串。
    ///
    /// 为什么不是「让密钥变成非必填」：网关的 Provider 记录把密钥当必填不变量
    /// （GatewayConfigurationProvisioning 会拒空），放开它要动的是所有上游的校验面。
    /// 而 Ollama / vLLM 的 OpenAI 兼容接口本来就忽略 Authorization 头，占位值填什么都能通——
    /// 这正是 minimal-user-input 说的「系统自己知道的值不该摆成输入框」：系统替他填，
    /// 他仍可覆盖（自建服务真开了 --api-key 时）。
    ///
    /// 第一版只在 Summary 里写「默认无需密钥」，判据却照旧拒空，用户照着文案留空就被拦下
    /// （predicate-and-wiring-discipline 形状 8：拿一份不成立的声明当证据）。
    /// </summary>
    string KeylessPlaceholder = "");

public static class ProviderPresets
{
    /// <summary>
    /// 预设清单。ApiUrl 一律写到「网关自己会补版本号」的那个层级，与
    /// <see cref="ResolveModelsUrl"/> 的版本号判据保持一致，别在这里画蛇添足加 /v1。
    /// </summary>
    public static IReadOnlyList<ProviderPreset> All { get; } = new List<ProviderPreset>
    {
        new("openai", "OpenAI", "openai", "https://api.openai.com/v1", "openai", 20,
            "https://platform.openai.com/api-keys", "sk-", true, false,
            "GPT 系列、向量嵌入、图片生成与语音，官方直连。",
            new[] { "openai", "gpt", "chatgpt", "欧派埃", "开放人工智能" }),

        new("anthropic", "Anthropic", "claude", "https://api.anthropic.com", "anthropic", 20,
            "https://console.anthropic.com/settings/keys", "sk-ant-", false, false,
            "Claude 系列，走 Claude 原生协议而不是 OpenAI 兼容。",
            new[] { "anthropic", "claude", "克劳德" }),

        new("openrouter", "OpenRouter", "openai", "https://openrouter.ai/api", "openrouter.ai", 20,
            "https://openrouter.ai/keys", "sk-or-", true, true,
            "一个密钥聚合数百个模型，**上游直接返回价格**，导入时可自动填。",
            new[] { "openrouter", "open router", "聚合", "路由" }),

        new("deepseek", "DeepSeek 深度求索", "openai", "https://api.deepseek.com", "deepseek", 20,
            "https://platform.deepseek.com/api_keys", "sk-", true, false,
            "DeepSeek 对话与代码模型，OpenAI 兼容接口。",
            new[] { "deepseek", "深度求索", "ds" }),

        new("siliconflow", "硅基流动 SiliconFlow", "openai", "https://api.siliconflow.cn/v1", "siliconflow", 20,
            "https://cloud.siliconflow.cn/account/ak", "sk-", true, false,
            "国内多模型聚合，含常用开源向量模型（bge / gte 系列）。",
            new[] { "siliconflow", "硅基流动", "硅基", "guiji" }),

        new("dashscope", "阿里云百炼 DashScope", "openai", "https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope", 20,
            "https://bailian.console.aliyun.com/?tab=model#/api-key", "sk-", true, false,
            "通义千问系列与 text-embedding，使用兼容模式端点。",
            new[] { "dashscope", "阿里", "百炼", "通义", "qwen", "aliyun", "bailian" }),

        new("moonshot", "Moonshot 月之暗面", "openai", "https://api.moonshot.cn/v1", "moonshot", 20,
            "https://platform.moonshot.cn/console/api-keys", "sk-", true, false,
            "Kimi 系列，长上下文见长。",
            new[] { "moonshot", "kimi", "月之暗面", "月暗" }),

        new("zhipu", "智谱 BigModel", "openai", "https://open.bigmodel.cn/api/paas/v4", "zhipu", 20,
            "https://open.bigmodel.cn/usercenter/apikeys", "", true, false,
            "GLM 系列对话、向量与多模态。",
            new[] { "zhipu", "智谱", "glm", "bigmodel", "chatglm" }),

        new("volcengine", "火山方舟 Ark", "openai", "https://ark.cn-beijing.volces.com/api/v3", "volcengine", 20,
            "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", "", true, false,
            "豆包系列。注意方舟按「接入点 ID」调用，模型标识可能不是模型名。",
            new[] { "volcengine", "火山", "方舟", "ark", "doubao", "豆包" }),

        new("minimax", "MiniMax", "openai", "https://api.minimax.chat/v1", "minimax", 20,
            "https://platform.minimaxi.com/user-center/basic-information/interface-key", "", true, false,
            "abab 系列对话与语音。",
            new[] { "minimax", "abab", "海螺" }),

        new("stepfun", "阶跃星辰 StepFun", "openai", "https://api.stepfun.com/v1", "stepfun", 20,
            "https://platform.stepfun.com/interface-key", "", true, false,
            "step 系列，多模态较强。",
            new[] { "stepfun", "阶跃", "星辰", "step" }),

        new("xai", "xAI Grok", "openai", "https://api.x.ai/v1", "xai", 20,
            "https://console.x.ai/", "xai-", true, false,
            "Grok 系列，OpenAI 兼容接口。",
            new[] { "xai", "grok", "x.ai" }),

        new("groq", "Groq", "openai", "https://api.groq.com/openai/v1", "groq", 20,
            "https://console.groq.com/keys", "gsk_", true, false,
            "开源模型的高速推理，延迟极低。",
            new[] { "groq", "lpu", "高速" }),

        new("mistral", "Mistral AI", "openai", "https://api.mistral.ai/v1", "mistral", 20,
            "https://console.mistral.ai/api-keys/", "", true, false,
            "Mistral 与 Codestral 系列。",
            new[] { "mistral", "codestral", "米斯特拉" }),

        new("together", "Together AI", "openai", "https://api.together.xyz/v1", "together", 20,
            "https://api.together.xyz/settings/api-keys", "", true, false,
            "开源模型托管，模型数量多。",
            new[] { "together", "togetherai" }),

        new("fireworks", "Fireworks AI", "openai", "https://api.fireworks.ai/inference/v1", "fireworks", 20,
            "https://fireworks.ai/account/api-keys", "fw_", true, false,
            "开源模型托管，函数调用支持较好。",
            new[] { "fireworks", "烟花" }),

        new("ollama", "Ollama（本地）", "openai", "http://host.docker.internal:11434/v1", "ollama", 4,
            "", "", true, false,
            "本地跑的开源模型。不校验密钥，已替你填好占位值；地址按你的部署改（高级选项里）。",
            new[] { "ollama", "本地", "local", "离线" },
            KeylessPlaceholder: "ollama"),

        new("vllm", "vLLM / 自建 OpenAI 兼容服务", "openai", "http://host.docker.internal:8000/v1", "vllm", 8,
            "", "", true, false,
            "自建推理服务。默认不校验密钥，已填占位值；开了 --api-key 就改成真密钥。地址一定要按你的部署改（高级选项里）。",
            new[] { "vllm", "自建", "sglang", "lmdeploy", "tgi" },
            KeylessPlaceholder: "local"),
    };

    public static ProviderPreset? Find(string? key)
        => string.IsNullOrWhiteSpace(key)
            ? null
            : All.FirstOrDefault(p => string.Equals(p.Key, key.Trim(), StringComparison.OrdinalIgnoreCase));

    // ---------------------------------------------------------------------
    // 上游地址推导
    // ---------------------------------------------------------------------

    /// <summary>
    /// 「baseUrl 是否已自带版本号」的判据。
    ///
    /// 必须与 prd-api 的 OpenAIGatewayAdapter.BuildEndpoint 用同一个正则：那边决定业务请求
    /// 发去哪里，这边决定探测和拉模型发去哪里。两边判据一旦漂移，就会出现「测试连接说通了、
    /// 真实调用 404」这种最难查的错（predicate-and-wiring-discipline 形状 3）。
    /// console-api 是独立工程、无法直接引用那份代码，故用源码守卫测试钉住两处一致。
    /// </summary>
    internal const string VersionSuffixPattern = @"/(api/)?v\d+$";

    /// <summary>
    /// 拉取上游模型清单的地址。OpenAI 兼容协议统一是 GET {base}/models。
    /// </summary>
    public static string ResolveModelsUrl(string apiUrl)
    {
        var baseUrl = (apiUrl ?? string.Empty).TrimEnd('/');
        var hasVersion = Regex.IsMatch(baseUrl, VersionSuffixPattern, RegexOptions.IgnoreCase);
        return hasVersion ? $"{baseUrl}/models" : $"{baseUrl}/v1/models";
    }

    // ---------------------------------------------------------------------
    // 用途推断
    // ---------------------------------------------------------------------

    /// <summary>
    /// 按上游模型标识推断用途。
    ///
    /// 只做**高置信**推断：命中明确的关键词才给结论，拿不准就返回空让用户自己勾。
    /// 宁可少推断，也不能把一个 chat 模型标成 embedding——那会让向量库进脏数据
    /// （见 ModelResolver 的失败关闭注释），而错误的自动值比没有自动值更难被发现。
    /// </summary>
    public static IReadOnlyList<string> InferCapabilities(string modelId)
    {
        var id = (modelId ?? string.Empty).ToLowerInvariant();
        if (id.Length == 0) return Array.Empty<string>();

        // 顺序有意义：先判专用型，再判通用对话。一个 id 同时命中多条时全部返回。
        var caps = new List<string>();

        if (Contains(id, "embed", "embedding", "bge-", "gte-", "text-embedding", "m3e", "jina-embeddings"))
            caps.Add("embedding");

        if (Contains(id, "rerank", "reranker"))
            caps.Add("rerank");

        if (Contains(id, "whisper", "-asr", "speech-to-text", "stt", "transcribe", "gpt-audio", "sensevoice"))
            caps.Add("asr");

        if (Contains(id, "tts", "text-to-speech", "-voice", "cosyvoice", "audio-speech"))
            caps.Add("tts");

        // 「image」既可能是生图也可能是看图，靠更具体的词区分；两边都不命中就不猜。
        if (Contains(id, "dall-e", "dalle", "image-gen", "-image", "flux", "stable-diffusion", "sd3", "midjourney", "seedream", "wanx"))
            caps.Add("image_generation");

        if (Contains(id, "-vl", "vision", "-vl-", "llava", "internvl", "qwen-vl"))
            caps.Add("vision");

        if (Contains(id, "video", "sora", "kling", "wan-", "seedance"))
            caps.Add("video_generation");

        if (Contains(id, "coder", "code-", "codestral", "starcoder", "deepseek-coder"))
            caps.Add("code");

        // 没命中任何专用型，且看起来是个对话模型family，才给 chat。
        if (caps.Count == 0 && Contains(id,
                "gpt", "claude", "gemini", "qwen", "glm", "deepseek", "kimi", "moonshot",
                "llama", "mistral", "mixtral", "yi-", "baichuan", "hunyuan", "doubao",
                "abab", "step-", "grok", "command", "phi-", "gemma", "chat", "instruct"))
            caps.Add("chat");

        return caps;
    }

    private static bool Contains(string id, params string[] needles)
        => needles.Any(n => id.Contains(n, StringComparison.Ordinal));

    // ---------------------------------------------------------------------
    // 价格
    // ---------------------------------------------------------------------

    /// <summary>
    /// 从上游模型条目里读价格。
    ///
    /// **只认上游自己给的数**，没有内置价目表。理由很实在：价目表会过时，而过时的价格
    /// 比没有价格更危险——它看起来是真的，成本报表照算，没人会去核对（no-rootless-tree.md）。
    /// OpenRouter 这类在 /models 响应里带 pricing 的上游可以自动填满；不带的就如实留空，
    /// 让界面显示「上游未提供价格」，而不是编一个。
    ///
    /// OpenRouter 的口径是「每 token 的美元数」，这里换算成每百万 token。
    /// </summary>
    public static UpstreamPricing? ReadPricing(JsonNode? modelNode)
    {
        var pricing = modelNode?["pricing"];
        if (pricing is null) return null;

        var input = ReadPerToken(pricing["prompt"] ?? pricing["input"]);
        var output = ReadPerToken(pricing["completion"] ?? pricing["output"]);
        var perCall = ReadPerToken(pricing["request"]);

        if (input is null && output is null && perCall is null) return null;

        return new UpstreamPricing(
            InputPricePerMillion: input is null ? null : Math.Round(input.Value * 1_000_000m, 6),
            OutputPricePerMillion: output is null ? null : Math.Round(output.Value * 1_000_000m, 6),
            PricePerCall: perCall,
            Currency: "USD");
    }

    /// <summary>
    /// 价格字段在不同上游里可能是字符串也可能是数字；负数和非数字一律当作「没给」。
    /// 特别地 OpenRouter 用 "-1" 表示「不适用」，不能当成 0 —— 0 会被读成「免费」。
    /// </summary>
    private static decimal? ReadPerToken(JsonNode? node)
    {
        if (node is null) return null;
        decimal value;
        if (node is JsonValue jv)
        {
            if (jv.TryGetValue(out decimal d)) value = d;
            else if (jv.TryGetValue(out string? s) && decimal.TryParse(s, System.Globalization.NumberStyles.Float,
                         System.Globalization.CultureInfo.InvariantCulture, out var parsed)) value = parsed;
            else return null;
        }
        else return null;

        return value < 0 ? null : value;
    }
}

public sealed record UpstreamPricing(
    decimal? InputPricePerMillion,
    decimal? OutputPricePerMillion,
    decimal? PricePerCall,
    string Currency);
