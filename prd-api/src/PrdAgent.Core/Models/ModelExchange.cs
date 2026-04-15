using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 模型中继 (Exchange) 配置
/// 将非标准 API（如 fal.ai）伪装为标准 OpenAI 兼容接口，
/// 使模型池可以像使用普通模型一样调用非标准模型。
/// </summary>
[AppOwnership(AppNames.Llm, AppNames.LlmDisplay, IsPrimary = true)]
public class ModelExchange
{
    /// <summary>Exchange ID</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>显示名称（如 "Nano Banana Pro Edit"）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// 模型别名（模型池中引用的 ModelId）
    /// 例如: "nano-banana-pro-edit"
    /// 单中继单模型场景使用此字段；多模型共享一个中继时请使用 ModelAliases。
    /// </summary>
    public string ModelAlias { get; set; } = string.Empty;

    /// <summary>
    /// 附加模型别名列表。允许一个中继（Provider 级别）承接多个模型。
    /// 例如 Gemini 原生协议下，同一个 Provider 入口可以通过 URL 模版 {model} 替换
    /// 分发到不同模型（gemini-3.1-flash / gemini-3.1-flash-image-preview 等）。
    /// ModelResolver 会同时匹配 ModelAlias 与 ModelAliases。
    /// </summary>
    public List<string> ModelAliases { get; set; } = new();

    /// <summary>
    /// 目标 API 完整 URL。支持 {model} 占位符，运行时会被实际模型 ID 替换。
    /// 例如: "https://fal.run/fal-ai/nano-banana-pro/edit"
    /// 或: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    /// </summary>
    public string TargetUrl { get; set; } = string.Empty;

    /// <summary>目标 API Key（加密存储）</summary>
    public string TargetApiKeyEncrypted { get; set; } = string.Empty;

    /// <summary>
    /// 认证方案
    /// Bearer: Authorization: Bearer {key}
    /// Key: Authorization: Key {key}
    /// XApiKey: x-api-key: {key}
    /// </summary>
    public string TargetAuthScheme { get; set; } = "Bearer";

    /// <summary>
    /// 转换器类型（决定请求/响应如何转换）
    /// 例如: "fal-image-edit", "fal-text2img", "passthrough"
    /// </summary>
    public string TransformerType { get; set; } = "passthrough";

    /// <summary>
    /// 转换器额外配置（JSON 格式，不同转换器有不同字段）
    /// </summary>
    public Dictionary<string, object>? TransformerConfig { get; set; }

    /// <summary>是否启用</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>备注</summary>
    public string? Description { get; set; }

    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
