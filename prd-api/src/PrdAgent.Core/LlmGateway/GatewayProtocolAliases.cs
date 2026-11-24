namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// 上游协议别名归一化——**唯一一份**。
///
/// 同一个协议在库里有好几种写法（<c>anthropic</c> / <c>claude-compatible</c> 都是 Claude 协议，
/// <c>openai-compatible</c> / <c>openrouter</c> / <c>gemini-compatible</c> 都走 OpenAI 那套）。
/// 这件事有两个消费方：选哪个适配器发请求，以及按哪套口径算用量的账。
///
/// 两边各认一张别名表就会出事，而且是**静默**的：2026-09-17 那次是
/// <c>claude-compatible</c> 选中了 Claude 适配器（它把 cache_read_input_tokens 与
/// input_tokens 分开报），而计价那一侧只认 <c>anthropic</c> / <c>claude</c>，于是按 OpenAI 口径
/// 把缓存读从输入里减了一遍——成本报低、预算闸跟着松，编译过、不报错、只在对账时显形。
///
/// 所以归一化收在这里，两个消费方都先过它再判。加一个新别名只改这一处，
/// 不会出现「适配器认得、计价不认得」的半边。
/// </summary>
public static class GatewayProtocolAliases
{
    /// <summary>Claude 协议的适配器键。</summary>
    public const string Claude = "claude";

    /// <summary>OpenAI 协议的适配器键。</summary>
    public const string OpenAI = "openai";

    /// <summary>
    /// 把库里存的协议写法归一成适配器键；认不出来的原样返回（调用方按「OpenAI 兼容」兜底），
    /// 空 / unknown 返回 null。
    /// </summary>
    public static string? NormalizeAdapterKey(string? protocol)
    {
        var normalized = protocol?.Trim().ToLowerInvariant();
        return normalized switch
        {
            null or "" or "unknown" => null,
            "anthropic" or "claude-compatible" => Claude,
            "openai-compatible" or "openrouter" or "gemini-compatible" => OpenAI,
            _ => normalized,
        };
    }

    /// <summary>这个协议走的是不是 Claude 那套适配器。</summary>
    public static bool IsClaudeProtocol(string? protocol)
        => string.Equals(NormalizeAdapterKey(protocol), Claude, StringComparison.Ordinal);
}
