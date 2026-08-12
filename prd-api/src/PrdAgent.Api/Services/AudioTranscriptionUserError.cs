namespace PrdAgent.Api.Services;

/// <summary>
/// 语音转写失败的普通用户文案。上游模型、协议、响应和异常细节只进入服务端日志。
/// </summary>
public static class AudioTranscriptionUserError
{
    public static string FromException(Exception ex)
    {
        var message = ex.Message ?? string.Empty;
        if (message.Contains("没有识别到有效语音", StringComparison.OrdinalIgnoreCase)
            || message.Contains("NO_SPEECH", StringComparison.OrdinalIgnoreCase)
            || message.Contains("无有效语音", StringComparison.OrdinalIgnoreCase))
        {
            return "没有识别到有效语音。请确认录音中有人声且音量清晰，然后重新上传；原始音频已保留。";
        }

        if (message.Contains("规范化后超过", StringComparison.OrdinalIgnoreCase)
            || message.Contains("超过单次转写上限", StringComparison.OrdinalIgnoreCase))
        {
            return "音频时长超过单次转写上限，请裁剪或分段后重新上传；原始音频已保留。";
        }

        return "语音转写暂时失败。请稍后重试或换一段清晰音频；原始音频已保留，不需要重新录制。";
    }
}
