using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

public sealed class SpeechException(string code, string message, int statusCode = 400) : Exception(message)
{
    public string Code { get; } = code;
    public int StatusCode { get; } = statusCode;
}

/// <summary>界面、MCP、Worker 共用的能力约束，不根据供应商品牌或模型名字猜功能。</summary>
public static class SpeechCapabilityPolicy
{
    private static readonly HashSet<string> OpenAiFormats = new(StringComparer.Ordinal)
        { "mp3", "opus", "aac", "flac", "wav", "pcm" };
    private static readonly HashSet<string> DoubaoFormats = new(StringComparer.Ordinal)
        { "mp3", "ogg_opus", "pcm" };
    public const int MaxAudioBytes = PrdAgent.Core.Interfaces.GatewaySpeechResponseLimits.MaxAudioBytes;

    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public static int CountCharacters(string text) => text.EnumerateRunes().Count();

    public static void ValidateProfile(SpeechProfile p)
    {
        if (p.Voices == null || p.Formats == null || p.Emotions == null || p.Voices.Any(v => v == null || v.Languages == null))
            throw new SpeechException("PROFILE_INVALID", "音色、语言、格式与情绪列表不能为空对象。");
        if (string.IsNullOrWhiteSpace(p.Id) || p.Id.Length > 96 || p.Id.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            throw new SpeechException("PROFILE_INVALID", "能力标识只能包含字母、数字、连字符和下划线，最长96位。");
        if (string.IsNullOrWhiteSpace(p.Name) || p.Name.Length > 100 || string.IsNullOrWhiteSpace(p.ModelPoolId))
            throw new SpeechException("PROFILE_INVALID", "请填写能力名称并选择网关模型。");
        if (p.Protocol is not ("openai" or "doubao-tts"))
            throw new SpeechException("PROTOCOL_UNSUPPORTED", "当前支持 OpenAI 语音协议和豆包 TTS 协议。");
        var supportedFormats = p.Protocol == "openai" ? OpenAiFormats : DoubaoFormats;
        if (p.Formats.Count == 0 || p.Formats.Distinct().Count() != p.Formats.Count || p.Formats.Any(x => !supportedFormats.Contains(x))
            || !p.Formats.Contains(p.DefaultFormat))
            throw new SpeechException("FORMAT_UNSUPPORTED", "输出格式或默认格式不符合当前协议，请检查能力配置。");
        if (p.Voices.Count is < 1 or > 200 || p.Voices.Any(v => string.IsNullOrWhiteSpace(v.Id) || v.Id.Length > 160 || string.IsNullOrWhiteSpace(v.Name))
            || p.Voices.Select(x => x.Id).Distinct(StringComparer.Ordinal).Count() != p.Voices.Count || !p.Voices.Any(x => x.Id == p.DefaultVoiceId))
            throw new SpeechException("VOICE_INVALID", "音色标识需唯一，并且默认音色必须在当前音色目录内。");
        if (p.Voices.Any(v => v.PreviewUrl != null && (!Uri.TryCreate(v.PreviewUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https")))
            throw new SpeechException("VOICE_INVALID", "试听地址必须为 HTTPS 地址。");
        var min = p.Protocol == "openai" ? 0.25 : 0.5;
        var max = p.Protocol == "openai" ? 4 : 2;
        if (!double.IsFinite(p.MinSpeed) || !double.IsFinite(p.MaxSpeed) || p.MinSpeed < min || p.MaxSpeed > max || p.MinSpeed > 1 || p.MaxSpeed < 1)
            throw new SpeechException("SPEED_INVALID", $"当前协议语速范围为 {min}–{max}，配置范围必须包含默认语速1。");
        if (p.Protocol == "doubao-tts" && p.SupportsInstructions || p.Protocol == "openai" && p.SupportsEmotion)
            throw new SpeechException("FEATURE_UNSUPPORTED", "所选协议不支持该专属参数，不能混用声音指令与情绪字段。");
        if (p.Emotions.Count > 100 || p.Emotions.Any(string.IsNullOrWhiteSpace) || p.SupportsEmotion && p.Emotions.Count == 0)
            throw new SpeechException("EMOTION_INVALID", "开启情绪控制后必须配置实际支持的情绪列表。");
        if (p.MaxTextChars is < 1 or > 20000 || p.DailyCharacterQuota is < 1 or > 10000000 || p.MaxConcurrentRuns is < 1 or > 20)
            throw new SpeechException("LIMIT_INVALID", "文本上限应为1–20000字符，每日额度1–10000000字符，并发上限1–20。");
    }

    public static SpeechOptions ResolveOptions(SpeechProfile p, SpeechOptions request)
    {
        if (!p.Enabled) throw new SpeechException("PROFILE_DISABLED", "该语音能力已停用，请选择其他可用能力。");
        if (request.ProfileRevision != null && request.ProfileRevision != p.Revision)
            throw new SpeechException("PROFILE_CHANGED", "语音能力配置已更新，请重新查询能力并检查声音预设。", 409);
        var voice = request.VoiceId ?? p.DefaultVoiceId;
        var format = request.Format ?? p.DefaultFormat;
        var speed = request.Speed ?? 1;
        if (!p.Voices.Any(x => x.Id == voice)) throw new SpeechException("VOICE_UNAVAILABLE", "所选音色不在该能力的音色目录中，系统没有替换音色。");
        if (!p.Formats.Contains(format)) throw new SpeechException("FORMAT_UNSUPPORTED", "所选能力不支持该输出格式。");
        if (!double.IsFinite(speed) || speed < p.MinSpeed || speed > p.MaxSpeed) throw new SpeechException("SPEED_UNSUPPORTED", "语速超出所选能力支持的范围。");
        if (request.Instructions != null && (!p.SupportsInstructions || request.Instructions.Length > 2000))
            throw new SpeechException("INSTRUCTIONS_UNSUPPORTED", "当前能力不支持声音指令，或声音指令超过2000字。");
        if (request.Emotion != null && (!p.SupportsEmotion || !p.Emotions.Contains(request.Emotion)))
            throw new SpeechException("EMOTION_UNSUPPORTED", "当前能力不支持所选情绪，请查询实际支持的情绪列表。");
        return new SpeechOptions { ProfileId = p.Id, ProfileRevision = p.Revision, VoiceId = voice, Format = format, Speed = speed,
            Instructions = request.Instructions, Emotion = request.Emotion };
    }

    public static JsonObject BuildRequestBody(SpeechRun run)
    {
        var result = new JsonObject { ["input"] = run.Text, ["voice"] = run.VoiceId, ["response_format"] = run.Format, ["speed"] = run.Speed };
        if (run.Instructions != null) result["instructions"] = run.Instructions;
        if (run.Emotion != null) result["emotion"] = run.Emotion;
        return result;
    }

    public static string RequestFingerprint(SpeechCreateRequest request) => Hash(JsonSerializer.Serialize(new
    {
        request.Text, request.Title, request.ProfileId, request.ProfileRevision, request.VoiceId, request.Format,
        request.Speed, request.Instructions, request.Emotion, request.PresetId,
    }));

    public static string MimeFor(string format) => format switch
    {
        "mp3" => "audio/mpeg", "wav" => "audio/wav", "flac" => "audio/flac", "aac" => "audio/aac",
        "opus" or "ogg_opus" => "audio/ogg", "pcm" => "audio/pcm", _ => "application/octet-stream",
    };
}
