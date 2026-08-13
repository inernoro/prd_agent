namespace PrdAgent.Infrastructure.LlmGateway.Asr;

/// <summary>
/// 标准音频转写端点的 multipart 参数权威策略。
/// 业务 Worker 不得自行拼 response_format 或时间戳参数，避免模型切换后协议漂移。
/// </summary>
public static class AsrTranscriptionRequestPolicy
{
    public static Dictionary<string, object> BuildMultipartFields(
        string? model,
        string? language = null)
    {
        var effectiveModel = string.IsNullOrWhiteSpace(model) ? "whisper-1" : model.Trim();
        var compactJson = UsesCompactJson(effectiveModel);
        var fields = new Dictionary<string, object>
        {
            ["model"] = effectiveModel,
            ["response_format"] = compactJson ? "json" : "verbose_json",
        };
        if (!compactJson)
            fields["timestamp_granularities[]"] = "segment";
        if (!string.IsNullOrWhiteSpace(language))
            fields["language"] = language.Trim();
        return fields;
    }

    public static bool UsesCompactJson(string? model)
        => model?.StartsWith("gpt-4o-transcribe", StringComparison.OrdinalIgnoreCase) == true
            || model?.StartsWith("gpt-4o-mini-transcribe", StringComparison.OrdinalIgnoreCase) == true;
}
