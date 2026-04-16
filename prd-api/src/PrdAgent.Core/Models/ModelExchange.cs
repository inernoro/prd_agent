using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 模型中继 (Exchange) 配置
/// 将非标准 API（如 fal.ai / Gemini 原生）伪装为标准 OpenAI 兼容接口，
/// 使模型池可以像使用普通模型一样调用非标准模型。
///
/// 一个 Exchange = 一个「虚拟平台」。Name 字段就是用户定义的平台展示名（如 "我的 Gemini"）。
/// </summary>
[AppOwnership(AppNames.Llm, AppNames.LlmDisplay, IsPrimary = true)]
public class ModelExchange
{
    /// <summary>Exchange ID（也用作虚拟平台 ID）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>显示名称（同时作为虚拟平台名，如 "Google Gemini (原生)"）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// 【旧字段 · 兼容保留】主模型别名，在没有 Models 列表时充当唯一模型。
    /// 新写入请使用 Models；读取时 GetEffectiveModels() 会自动兼容两种格式。
    /// </summary>
    public string ModelAlias { get; set; } = string.Empty;

    /// <summary>
    /// 【旧字段 · 兼容保留】附加模型别名列表，在没有 Models 列表时提供一组字符串别名。
    /// 新写入请使用 Models；读取时 GetEffectiveModels() 会自动兼容两种格式。
    /// </summary>
    public List<string> ModelAliases { get; set; } = new();

    /// <summary>
    /// 挂在此中继下的模型列表。每个条目是一个可被模型池引用的模型，
    /// ModelId 会被拼进 TargetUrl 的 {model} 占位符。
    /// 新写入请使用这个字段；旧数据读取时会从 ModelAlias+ModelAliases 自动合并。
    /// </summary>
    public List<ExchangeModel> Models { get; set; } = new();

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
    /// x-goog-api-key: x-goog-api-key: {key}（Gemini 原生）
    /// </summary>
    public string TargetAuthScheme { get; set; } = "Bearer";

    /// <summary>
    /// 转换器类型（决定请求/响应如何转换）
    /// 例如: "fal-image-edit", "fal-text2img", "gemini-native", "passthrough"
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

/// <summary>
/// 挂在 Exchange 下的一个模型条目。
/// 把 Exchange 当成"虚拟平台"，一个 Exchange 可以挂多个模型
/// （Gemini 中继下可以同时挂 gemini-2.5-flash / gemini-3.1-flash-image-preview 等）。
/// </summary>
public class ExchangeModel
{
    /// <summary>
    /// 模型 ID。调用时会被拼进 Exchange.TargetUrl 的 {model} 占位符，
    /// 例如 "gemini-3.1-flash-image-preview"。
    /// </summary>
    public string ModelId { get; set; } = string.Empty;

    /// <summary>展示名（可选）。为空时 UI 用 ModelId。</summary>
    public string? DisplayName { get; set; }

    /// <summary>
    /// 模型类型，决定一键体验用什么测试 prompt，也用于模型池过滤。
    /// 取值: chat / vision / generation / tts / asr / embedding。
    /// </summary>
    public string ModelType { get; set; } = "chat";

    /// <summary>说明（可选）</summary>
    public string? Description { get; set; }

    /// <summary>是否启用（禁用后不出现在模型池选择器）</summary>
    public bool Enabled { get; set; } = true;
}

/// <summary>
/// ModelExchange 的访问帮助器：统一新旧数据的读取入口。
/// 旧数据（Models 为空）自动从 ModelAlias + ModelAliases 合成等价的 ExchangeModel 列表；
/// 新数据直接返回 Models。永远不写回数据库（lazy migration）。
/// </summary>
public static class ModelExchangeAccessors
{
    /// <summary>
    /// 返回该 Exchange 的有效模型列表：
    ///   - 优先使用 Models
    ///   - Models 为空时，从 ModelAlias + ModelAliases 合成
    /// 不修改原对象。
    /// </summary>
    public static IReadOnlyList<ExchangeModel> GetEffectiveModels(this ModelExchange exchange)
    {
        if (exchange.Models != null && exchange.Models.Count > 0)
            return exchange.Models;

        // 从旧字段合成
        var synthesized = new List<ExchangeModel>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        if (!string.IsNullOrWhiteSpace(exchange.ModelAlias))
        {
            synthesized.Add(new ExchangeModel
            {
                ModelId = exchange.ModelAlias,
                ModelType = InferModelTypeFromTransformer(exchange.TransformerType),
                Enabled = true
            });
            seen.Add(exchange.ModelAlias);
        }

        foreach (var alias in exchange.ModelAliases ?? new List<string>())
        {
            if (string.IsNullOrWhiteSpace(alias) || !seen.Add(alias)) continue;
            synthesized.Add(new ExchangeModel
            {
                ModelId = alias,
                ModelType = InferModelTypeFromTransformer(exchange.TransformerType),
                Enabled = true
            });
        }

        return synthesized;
    }

    /// <summary>
    /// 按 transformerType 推断默认的 ModelType（仅用于旧数据合成）。
    /// gemini-native 会被推断为 chat（主用途），但实际图像模型需要用户显式标注。
    /// </summary>
    private static string InferModelTypeFromTransformer(string? transformerType)
    {
        if (string.IsNullOrEmpty(transformerType)) return "chat";
        if (transformerType.StartsWith("fal-image", StringComparison.OrdinalIgnoreCase)) return "generation";
        if (transformerType.Contains("asr", StringComparison.OrdinalIgnoreCase)) return "asr";
        if (transformerType.Contains("tts", StringComparison.OrdinalIgnoreCase)) return "tts";
        return "chat";
    }
}
