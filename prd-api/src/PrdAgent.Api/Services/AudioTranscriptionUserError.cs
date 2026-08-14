namespace PrdAgent.Api.Services;

/// <summary>
/// 语音转写失败的普通用户文案。上游模型、协议、响应和异常细节只进入服务端日志。
/// </summary>
public static class AudioTranscriptionUserError
{
    public const string RouteContractInvalid = "ASR_ROUTE_CONTRACT_INVALID";
    public const string NoSpeech = "ASR_NO_SPEECH";
    public const string AllCandidatesNoSpeech = "ASR_ALL_CANDIDATES_NO_SPEECH";
    public const string AudioTooLong = "ASR_AUDIO_TOO_LONG";
    public const string UpstreamTemporary = "ASR_UPSTREAM_TEMPORARY";

    public sealed record Failure(string Code, string UserMessage, bool AutomaticRetryAllowed);

    public static Failure Classify(Exception ex)
    {
        var message = ex.Message ?? string.Empty;
        if (message.Contains(RouteContractInvalid, StringComparison.OrdinalIgnoreCase)
            || message.Contains("response_format", StringComparison.OrdinalIgnoreCase)
            || message.Contains("not a chat model", StringComparison.OrdinalIgnoreCase)
            || message.Contains("not supported in the v1/chat/completions endpoint", StringComparison.OrdinalIgnoreCase))
        {
            return new Failure(
                RouteContractInvalid,
                "语音转写服务配置不兼容，系统已停止无效重试；录音已保留。管理员修复配置后可直接重试。",
                AutomaticRetryAllowed: false);
        }

        if (message.Contains("没有识别到有效语音", StringComparison.OrdinalIgnoreCase)
            || message.Contains("NO_SPEECH", StringComparison.OrdinalIgnoreCase)
            || message.Contains("无有效语音", StringComparison.OrdinalIgnoreCase)
            || message.Contains(AllCandidatesNoSpeech, StringComparison.OrdinalIgnoreCase))
        {
            return new Failure(
                NoSpeech,
                "没有识别到有效语音。请确认录音中有人声且音量清晰，然后重新上传；原始音频已保留。",
                AutomaticRetryAllowed: false);
        }

        if (message.Contains("规范化后超过", StringComparison.OrdinalIgnoreCase)
            || message.Contains("超过单次转写上限", StringComparison.OrdinalIgnoreCase))
        {
            return new Failure(
                AudioTooLong,
                "音频时长超过单次转写上限，请裁剪或分段后重新上传；原始音频已保留。",
                AutomaticRetryAllowed: false);
        }

        return new Failure(
            UpstreamTemporary,
            "语音转写暂时失败。原始音频已保留，不需要重新录制。",
            AutomaticRetryAllowed: true);
    }

    public static string ForRetryOutcome(Failure failure, bool willRetry)
    {
        if (!string.Equals(failure.Code, UpstreamTemporary, StringComparison.Ordinal))
            return failure.UserMessage;

        return willRetry
            ? "语音转写暂时失败。系统会自动重试；原始音频已保留，不需要重新录制。"
            : "语音转写暂时失败。请点击重试；原始音频已保留，不需要重新录制。";
    }

    public static string FromException(Exception ex)
        => Classify(ex).UserMessage;
}
