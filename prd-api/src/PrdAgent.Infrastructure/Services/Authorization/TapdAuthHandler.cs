using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.Authorization;

/// <summary>
/// TAPD 授权处理器（Cookie 模式）。
/// </summary>
public class TapdAuthHandler : IAuthTypeHandler
{
    private readonly IHttpClientFactory _httpClientFactory;

    public TapdAuthHandler(IHttpClientFactory httpClientFactory)
    {
        _httpClientFactory = httpClientFactory;
    }

    public string TypeKey => "tapd";
    public string DisplayName => "TAPD";

    public IReadOnlyList<AuthFieldDefinition> CredentialFields => new[]
    {
        new AuthFieldDefinition
        {
            Key = "cookie",
            Label = "Cookie",
            Type = "textarea",
            Placeholder = "tapdsession=xxx; t_u=xxx; ...",
            HelpText = "浏览器登录 TAPD → F12 → Network → 任意请求 → Headers → 复制 Cookie 整段",
            Required = true,
        },
        new AuthFieldDefinition
        {
            Key = "workspaceIds",
            Label = "工作空间 ID（逗号分隔，可填多个）",
            Type = "text",
            Placeholder = "64054517,66590626",
            HelpText = "TAPD 项目 URL 中的数字 ID，用于后续工作流引用",
            Required = false,
        },
    };

    public async Task<AuthValidationResult> ValidateAsync(Dictionary<string, string> credentials, CancellationToken ct)
    {
        if (!credentials.TryGetValue("cookie", out var cookie) || string.IsNullOrWhiteSpace(cookie))
            return AuthValidationResult.Fail("Cookie 未填写");

        try
        {
            using var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(15);

            var req = new HttpRequestMessage(HttpMethod.Get, "https://www.tapd.cn/api/basic/info/get_user_info");
            req.Headers.Add("Cookie", cookie.Trim());
            req.Headers.Add("User-Agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");

            using var resp = await client.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
                return AuthValidationResult.Fail($"TAPD 返回 HTTP {(int)resp.StatusCode}，Cookie 可能已失效");

            var body = await resp.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(body);

            if (!doc.RootElement.TryGetProperty("status", out var status) || status.GetInt32() != 1)
                return AuthValidationResult.Fail("TAPD 认证失败：" + body.Substring(0, Math.Min(200, body.Length)));

            var metadata = new Dictionary<string, object>();
            if (doc.RootElement.TryGetProperty("data", out var data))
            {
                if (data.TryGetProperty("user", out var user) && user.TryGetProperty("name", out var name))
                    metadata["loginName"] = name.GetString() ?? "";
                if (data.TryGetProperty("user", out var u2) && u2.TryGetProperty("email", out var email))
                    metadata["email"] = email.GetString() ?? "";
            }

            if (credentials.TryGetValue("workspaceIds", out var wsIds) && !string.IsNullOrWhiteSpace(wsIds))
            {
                var ids = wsIds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                metadata["workspaceIds"] = ids;
            }

            // TAPD Cookie 没有明确过期时间，按经验给 30 天
            return AuthValidationResult.Success(metadata, DateTime.UtcNow.AddDays(30));
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
            // cookie 始终脱敏，即使很短也不回显完整值
            if (kv.Key == "cookie")
            {
                masked[kv.Key] = kv.Value.Length > 16
                    ? kv.Value.Substring(0, 6) + "...***..." + kv.Value.Substring(kv.Value.Length - 4)
                    : "***";
            }
            else
            {
                // workspaceIds 等非敏感字段原样返回
                masked[kv.Key] = kv.Value;
            }
        }
        return masked;
    }
}
