using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.Authorization;

/// <summary>
/// 语雀授权处理器（Personal Access Token 模式）。
/// API 文档：https://www.yuque.com/yuque/developer
/// </summary>
public class YuqueAuthHandler : IAuthTypeHandler
{
    private readonly IHttpClientFactory _httpClientFactory;

    public YuqueAuthHandler(IHttpClientFactory httpClientFactory)
    {
        _httpClientFactory = httpClientFactory;
    }

    public string TypeKey => "yuque";
    public string DisplayName => "语雀";

    public IReadOnlyList<AuthFieldDefinition> CredentialFields => new[]
    {
        new AuthFieldDefinition
        {
            Key = "apiToken",
            Label = "Personal Access Token",
            Type = "password",
            Placeholder = "请粘贴语雀 Token",
            HelpText = "语雀设置 → Token → 新建 Token（勾选「读取内容」权限即可）",
            Required = true,
        },
    };

    public async Task<AuthValidationResult> ValidateAsync(Dictionary<string, string> credentials, CancellationToken ct)
    {
        if (!credentials.TryGetValue("apiToken", out var token) || string.IsNullOrWhiteSpace(token))
            return AuthValidationResult.Fail("Token 未填写");

        try
        {
            using var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(10);

            var req = new HttpRequestMessage(HttpMethod.Get, "https://www.yuque.com/api/v2/user");
            req.Headers.Add("X-Auth-Token", token.Trim());
            req.Headers.Add("User-Agent", "PrdAgent/1.0");

            using var resp = await client.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
                return AuthValidationResult.Fail($"语雀 API 返回 HTTP {(int)resp.StatusCode}，Token 可能无效");

            var body = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(body);

            var metadata = new Dictionary<string, object>();
            if (doc.RootElement.TryGetProperty("data", out var data))
            {
                if (data.TryGetProperty("login", out var login))
                    metadata["login"] = login.GetString() ?? "";
                if (data.TryGetProperty("name", out var name))
                    metadata["name"] = name.GetString() ?? "";
                if (data.TryGetProperty("books_count", out var booksCount))
                    metadata["booksCount"] = booksCount.GetInt32();
            }

            return AuthValidationResult.Success(metadata); // 语雀 Token 长期有效
        }
        catch (Exception ex)
        {
            return AuthValidationResult.Fail($"验证失败: {ex.Message}");
        }
    }

    public async Task<Dictionary<string, object>> ExtractMetadataAsync(Dictionary<string, string> credentials, CancellationToken ct)
    {
        var result = await ValidateAsync(credentials, ct);
        return result.Metadata ?? new Dictionary<string, object>();
    }

    public Dictionary<string, string> MaskCredentials(Dictionary<string, string> credentials)
    {
        var masked = new Dictionary<string, string>();
        foreach (var kv in credentials)
        {
            // apiToken 始终脱敏，即使很短也不回显完整值
            if (kv.Key == "apiToken")
            {
                masked[kv.Key] = kv.Value.Length > 8
                    ? kv.Value.Substring(0, 4) + "...***"
                    : "***";
            }
            else
            {
                masked[kv.Key] = kv.Value;
            }
        }
        return masked;
    }
}
