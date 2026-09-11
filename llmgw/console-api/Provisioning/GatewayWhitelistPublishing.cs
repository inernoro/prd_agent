using PrdAgent.LlmGw.LogicalModels;

namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// 批量导入上游模型时，把物理模型登上白名单所需的两个判断。
///
/// 抽出来单放不是为了复用，是为了**能被单测直接断言**：这两件事写在
/// minimal-api 的端点闭包里就只能靠跑整条导入链路才验得到，而它们恰恰是
/// 「删掉之后编译照过、测试照绿」的那类逻辑。
/// </summary>
public static class GatewayWhitelistPublishing
{
    /// <summary>
    /// 上游模型名 -> 公开模型名。
    ///
    /// 中转商的模型名普遍带供应商前缀（<c>openai/gpt-4o</c>、<c>anthropic/claude-sonnet-4</c>）。
    /// 公开名必须**剥掉这层前缀**，否则从官网导一次得到 <c>gpt-4o</c>、从中转导一次得到
    /// <c>openai/gpt-4o</c>，同一个模型在白名单里变成两个公开名——「一个模型多个来源」
    /// 就永远合不起来，而这正是白名单存在的理由。
    ///
    /// 只剥最后一段：<c>a/b/c</c> 取 <c>c</c>。版本后缀（<c>:free</c>、<c>-2024-08-06</c>）保留，
    /// 它们是不同的模型，不该被合成一个。
    /// </summary>
    public static string ToPublicId(string upstreamModelName)
    {
        var name = (upstreamModelName ?? string.Empty).Trim();
        if (name.Length == 0) return string.Empty;
        var slash = name.LastIndexOf('/');
        if (slash >= 0)
        {
            // 斜杠在末尾 = 上游名里根本没有模型段（"openai/"）。返回空让调用方跳过，
            // 而不是退回整串——那会拿供应商名当公开模型名，在白名单里凭空造一条 "openai"。
            if (slash == name.Length - 1) return string.Empty;
            name = name[(slash + 1)..];
        }
        // 逻辑模型的 PublicId 校验：首字符必须是字母或数字，其余只允许 . _ : / -
        var cleaned = new string(name.Where(c => char.IsLetterOrDigit(c) || c is '.' or '_' or ':' or '-').ToArray());
        while (cleaned.Length > 0 && !char.IsLetterOrDigit(cleaned[0])) cleaned = cleaned[1..];
        return cleaned.Length is >= 2 and <= 160 ? cleaned : string.Empty;
    }

    /// <summary>
    /// 能力码 -> 逻辑模型的 ModelType。
    ///
    /// 顺序是判据不是偏好：一个模型同时声明 image_generation 与 chat 时（多模态很常见），
    /// 必须判成生图——拿它当对话模型调度，请求会带着错误的入参打到生图端点。
    /// 反过来把对话模型判成生图只会少用一个模型，代价小得多。宁可窄，不可宽。
    /// </summary>
    public static string ResolveModelType(IReadOnlyCollection<string> capabilityCodes)
    {
        var codes = capabilityCodes
            .Select(x => (x ?? string.Empty).Trim().ToLowerInvariant())
            .Where(x => x.Length > 0)
            .ToHashSet(StringComparer.Ordinal);

        if (codes.Contains("video_generation")) return "video-gen";
        if (codes.Contains(LogicalModelCapabilityPolicy.ImageGeneration)
            || codes.Contains("text2img") || codes.Contains("img2img")
            || codes.Contains("vision_generation") || codes.Contains("image_layering")) return "generation";
        if (codes.Contains("embedding")) return "embedding";
        if (codes.Contains("rerank")) return "rerank";
        if (codes.Contains("asr")) return "asr";
        if (codes.Contains("tts")) return "tts";
        if (codes.Contains("vision")) return "vision";
        // 认不出就按对话：这是唯一一个「猜错也只是少了个可选项」的落点，
        // 而且导入后用户在白名单页能看到并改。
        return "chat";
    }
}
