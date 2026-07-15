using MongoDB.Bson;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelPools;

public sealed record GatewayModelPoolTypeDefinition(
    string Code,
    string Name,
    string Purpose,
    int SortOrder)
{
    public string DefaultPoolCode => $"default-{Code}";
    public string DefaultPoolName => $"{Name}默认池";
}

public static class GatewayModelPoolTypeRegistry
{
    public static IReadOnlyList<GatewayModelPoolTypeDefinition> All { get; } =
    [
        new("chat", "对话", "通用对话、推理与工具调用", 10),
        new("intent", "意图识别", "低延迟分类、提取与结构化判断", 20),
        new("vision", "图片理解", "图片识别、视觉问答与多模态理解", 30),
        new("generation", "图片生成", "文本生成图片与图片编辑", 40),
        new("code", "代码", "代码生成、补全与审查", 50),
        new("long-context", "长文本", "长上下文阅读、总结与分析", 60),
        new("embedding", "向量嵌入", "文本或多模态向量化", 70),
        new("rerank", "重排序", "搜索与知识库结果重排序", 80),
        new("asr", "语音识别", "语音转文字", 90),
        new("tts", "语音合成", "文字转语音", 100),
        new("video-gen", "视频生成", "文本或图片生成视频", 110),
        new("audio-gen", "音频生成", "音乐与通用音频生成", 120),
        new("moderation", "内容审核", "文本、图片与多模态内容审核", 130),
    ];

    public static GatewayModelPoolTypeDefinition? Find(string? code)
        => All.FirstOrDefault(item => string.Equals(item.Code, code?.Trim(), StringComparison.OrdinalIgnoreCase));

    public static bool IsCompatible(BsonDocument model, string? modelType)
    {
        var type = modelType?.Trim().ToLowerInvariant() ?? string.Empty;
        return type switch
        {
            "vision" => Flag(model, "IsVision") || HasCapability(model, "vision", "image_input", "multimodal"),
            "generation" => Flag(model, "IsImageGen") || HasCapability(model, "image_generation", "text_to_image", "image"),
            "intent" => Flag(model, "IsIntent") || Flag(model, "IsMain"),
            "chat" => Flag(model, "IsMain") || Flag(model, "IsIntent") || HasCapability(model, "chat", "text_generation", "reasoning"),
            "code" => HasCapability(model, "code", "code_generation", "code_completion"),
            "long-context" => HasCapability(model, "long_context", "long-context") || Flag(model, "IsMain"),
            "embedding" => HasCapability(model, "embedding", "embeddings", "vector"),
            "rerank" => HasCapability(model, "rerank", "reranking"),
            "asr" => HasCapability(model, "asr", "speech_to_text", "audio_input"),
            "tts" => HasCapability(model, "tts", "text_to_speech", "audio_output"),
            "video-gen" => HasCapability(model, "video_generation", "text_to_video", "image_to_video", "video"),
            "audio-gen" => HasCapability(model, "audio_generation", "music_generation", "audio"),
            "moderation" => HasCapability(model, "moderation", "safety", "content_filter"),
            _ => false,
        };
    }

    private static bool Flag(BsonDocument model, string name) => model.AsNullableBool(name) == true;

    private static bool HasCapability(BsonDocument model, params string[] names)
    {
        var wanted = names.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var capabilities = model.TryGetValue("Capabilities", out var value) && value.IsBsonArray
            ? value.AsBsonArray
            : new BsonArray();
        return capabilities
            .Where(item => item.IsBsonDocument)
            .Select(item => item.AsBsonDocument)
            .Any(item => item.AsNullableBool("Value") == true && wanted.Contains(item.GetStringOrEmpty("Type")));
    }
}
