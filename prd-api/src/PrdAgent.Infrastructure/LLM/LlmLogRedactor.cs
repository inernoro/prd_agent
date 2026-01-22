using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LLM;

internal static class LlmLogRedactor
{
    /// <summary>
    /// 仅对“密钥/令牌/密码/授权”等敏感字段做打码。
    ///
    /// 说明：
    /// - 业务排障需要更完整的 SSE/响应内容；因此不再对 content/text/data 做通用脱敏。
    /// - 仍然必须避免把 API Key / Token / Password 明文写入日志或落库。
    /// </summary>
    private static readonly HashSet<string> SensitiveKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "authorization",
        "x-api-key",
        "api-key",
        "api_key",
        "apikey",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "password"
    };

    public static string RedactJson(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return json;
        try
        {
            using var doc = JsonDocument.Parse(json);
            using var ms = new MemoryStream();
            using (var writer = new Utf8JsonWriter(ms, new JsonWriterOptions { Indented = false }))
            {
                WriteElement(writer, doc.RootElement);
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }
        catch
        {
            // 兜底截断：JSON 解析失败时使用系统配置（默认 50k）
            var fallbackMaxChars = LlmLogLimits.DefaultJsonFallbackMaxChars;
            return json.Length > fallbackMaxChars ? json[..fallbackMaxChars] + "...[TRUNCATED]" : json;
        }
    }

    public static string Sha256Hex(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// 对 API Key 进行部分脱敏，保留前后各 4 个字符，中间用 *** 替代
    /// 委托给 ApiKeyCrypto.Mask 实现
    /// </summary>
    public static string RedactApiKey(string? apiKey) => ApiKeyCrypto.Mask(apiKey);

    private static void WriteElement(Utf8JsonWriter writer, JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var prop in el.EnumerateObject())
                {
                    writer.WritePropertyName(prop.Name);
                    if (SensitiveKeys.Contains(prop.Name))
                    {
                        // 不管值类型是什么，统一用占位符覆盖（避免把 token 等以非 string 形式落库）
                        writer.WriteStringValue("***");
                        continue;
                    }

                    // 某些实现把授权信息塞进 headers 对象里（key 可能不是固定的），做一次兜底
                    if (prop.Value.ValueKind == JsonValueKind.String
                        && prop.Name.Contains("key", StringComparison.OrdinalIgnoreCase)
                        && prop.Name.Contains("api", StringComparison.OrdinalIgnoreCase))
                    {
                        writer.WriteStringValue("***");
                        continue;
                    }

                    if (prop.Value.ValueKind == JsonValueKind.String
                        && prop.Name.Contains("token", StringComparison.OrdinalIgnoreCase))
                    {
                        writer.WriteStringValue("***");
                        continue;
                    }

                    WriteElement(writer, prop.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in el.EnumerateArray())
                {
                    WriteElement(writer, item);
                }
                writer.WriteEndArray();
                break;
            default:
                el.WriteTo(writer);
                break;
        }
    }
}

