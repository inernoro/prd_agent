namespace PrdAgent.Core.Models;

/// <summary>
/// LLM 日志字符限制配置（系统设置）
/// 所有大模型请求输入的字符限制统一来源
/// </summary>
public static class LlmLogLimits
{
    /// <summary>
    /// 请求 Body 最大字符数（默认 200k）
    /// </summary>
    public const int DefaultRequestBodyMaxChars = 200_000;

    /// <summary>
    /// 响应 Answer 最大字符数（默认 200k）
    /// </summary>
    public const int DefaultAnswerMaxChars = 200_000;

    /// <summary>
    /// 错误信息最大字符数（默认 20k）
    /// </summary>
    public const int DefaultErrorMaxChars = 20_000;

    /// <summary>
    /// HTTP 日志 Body 最大字符数（默认 50k）
    /// </summary>
    public const int DefaultHttpLogBodyMaxChars = 50_000;

    /// <summary>
    /// JSON 解析失败时的兜底最大字符数（默认 50k）
    /// </summary>
    public const int DefaultJsonFallbackMaxChars = 50_000;

    /// <summary>
    /// 获取请求 Body 最大字符数（优先从 AppSettings 读取，否则使用默认值）
    /// </summary>
    public static int GetRequestBodyMaxChars(AppSettings? settings = null)
    {
        return settings?.RequestBodyMaxChars ?? DefaultRequestBodyMaxChars;
    }

    /// <summary>
    /// 获取响应 Answer 最大字符数（优先从 AppSettings 读取，否则使用默认值）
    /// </summary>
    public static int GetAnswerMaxChars(AppSettings? settings = null)
    {
        return settings?.AnswerMaxChars ?? DefaultAnswerMaxChars;
    }

    /// <summary>
    /// 获取错误信息最大字符数（优先从 AppSettings 读取，否则使用默认值）
    /// </summary>
    public static int GetErrorMaxChars(AppSettings? settings = null)
    {
        return settings?.ErrorMaxChars ?? DefaultErrorMaxChars;
    }

    /// <summary>
    /// 获取 HTTP 日志 Body 最大字符数（优先从 AppSettings 读取，否则使用默认值）
    /// </summary>
    public static int GetHttpLogBodyMaxChars(AppSettings? settings = null)
    {
        return settings?.HttpLogBodyMaxChars ?? DefaultHttpLogBodyMaxChars;
    }

    /// <summary>
    /// 获取 JSON 解析失败时的兜底最大字符数（优先从 AppSettings 读取，否则使用默认值）
    /// </summary>
    public static int GetJsonFallbackMaxChars(AppSettings? settings = null)
    {
        return settings?.JsonFallbackMaxChars ?? DefaultJsonFallbackMaxChars;
    }
}

