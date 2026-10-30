using System.Security.Cryptography;
using System.Text.Json;
using PrdAgent.Api.Controllers.Api;

namespace PrdAgent.Api.Services;

/// <summary>无 T 号历史行的来源身份；同一产品的相同原始行重导时应跳过。</summary>
public static class ProductVersionImportFingerprint
{
    public static string Compute(string productId, ImportVersionWorkflowRow row)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(new { ProductId = productId, Row = row }));
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
            WriteCanonical(document.RootElement, writer);
        return Convert.ToHexString(SHA256.HashData(buffer.ToArray()));
    }

    private static void WriteCanonical(JsonElement element, Utf8JsonWriter writer)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(property.Value, writer);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray()) WriteCanonical(item, writer);
                writer.WriteEndArray();
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }
}
