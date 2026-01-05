namespace PrdAgent.Core.Models;

/// <summary>
/// 全局应用配置（单例文档）
/// </summary>
public class AppSettings
{
    /// <summary>固定为 global</summary>
    public string Id { get; set; } = "global";

    /// <summary>是否启用 Prompt Caching（关闭后将强制不使用缓存相关能力）</summary>
    public bool EnablePromptCache { get; set; } = true;

    /// <summary>请求 Body 最大字符数（默认 200k，所有大模型请求输入的字符限制统一来源）</summary>
    public int? RequestBodyMaxChars { get; set; }

    /// <summary>响应 Answer 最大字符数（默认 200k）</summary>
    public int? AnswerMaxChars { get; set; }

    /// <summary>错误信息最大字符数（默认 20k）</summary>
    public int? ErrorMaxChars { get; set; }

    /// <summary>HTTP 日志 Body 最大字符数（默认 50k）</summary>
    public int? HttpLogBodyMaxChars { get; set; }

    /// <summary>JSON 解析失败时的兜底最大字符数（默认 50k）</summary>
    public int? JsonFallbackMaxChars { get; set; }

    /// <summary>
    /// Desktop 客户端显示名称（用于登录页/窗口标题等）
    /// </summary>
    public string? DesktopName { get; set; }

    /// <summary>
    /// Desktop 登录图标资源 key（文件名，指向 /icon/desktop/&lt;key&gt;，允许任意图片格式）
    /// </summary>
    public string? DesktopLoginIconKey { get; set; }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}


