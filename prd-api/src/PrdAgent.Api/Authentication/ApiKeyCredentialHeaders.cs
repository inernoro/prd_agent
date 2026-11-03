namespace PrdAgent.Api.Authentication;

/// <summary>认证与受限凭据签发共用的原始密钥读取约定，不修改请求头。</summary>
internal static class ApiKeyCredentialHeaders
{
    public static string? Read(HttpRequest request)
    {
        // 仅在主头整个缺席时兼容旧客户端；空值或其它凭据不能被备用头替换身份。
        if (!request.Headers.TryGetValue("Authorization", out var header)
            && !request.Headers.TryGetValue("X-AI-Access-Key", out header))
            return null;

        var value = header.ToString();
        if (string.IsNullOrWhiteSpace(value)) return null;
        return value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? value["Bearer ".Length..].Trim()
            : value.Trim();
    }
}
