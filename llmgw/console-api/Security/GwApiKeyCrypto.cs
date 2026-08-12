using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.LlmGw.Security;

/// <summary>
/// Platform/model/exchange API key encryption compatible with PrdAgent.Core.Helpers.ApiKeyCrypto.
/// llmgw/console-api intentionally does not reference PrdAgent.* projects, so the minimal compatible writer lives here.
/// </summary>
public static class GwApiKeyCrypto
{
    public const string PrimaryConfigKey = "ApiKeyCrypto:Secret";
    public const string LegacyConfigKey = "ApiKeyCrypto:LegacySecrets";

    public static string GetRequiredPrimarySecret(IConfiguration configuration)
    {
        var secret = configuration[PrimaryConfigKey]?.Trim();
        if (string.IsNullOrWhiteSpace(secret))
        {
            throw new InvalidOperationException("ApiKeyCrypto:Secret 未配置，拒绝写入平台密钥。请为 llmgw 注入与 api/llmgw-serve 相同的 ApiKeyCrypto__Secret。");
        }

        if (Encoding.UTF8.GetByteCount(secret) < 32)
        {
            throw new InvalidOperationException("ApiKeyCrypto:Secret 过短，至少需要 32 bytes，拒绝写入平台密钥。");
        }

        return secret;
    }

    public static string Encrypt(string apiKey, IConfiguration configuration)
    {
        var normalized = apiKey?.Trim();
        if (string.IsNullOrWhiteSpace(normalized))
            throw new ArgumentException("apiKey 不能为空", nameof(apiKey));

        var secret = GetRequiredPrimarySecret(configuration);
        var keyBytes = Encoding.UTF8.GetBytes(secret.PadRight(32)[..32]);

        using var aes = Aes.Create();
        aes.Key = keyBytes;
        aes.GenerateIV();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;

        using var encryptor = aes.CreateEncryptor();
        var plainBytes = Encoding.UTF8.GetBytes(normalized);
        var encryptedBytes = encryptor.TransformFinalBlock(plainBytes, 0, plainBytes.Length);
        return $"{Convert.ToBase64String(aes.IV)}:{Convert.ToBase64String(encryptedBytes)}";
    }

    public static bool HasDedicatedPrimarySecret(IConfiguration configuration)
        => !string.IsNullOrWhiteSpace(configuration[PrimaryConfigKey]);

    public static IReadOnlyList<string> GetLegacySecrets(IConfiguration configuration)
    {
        var result = new List<string>();
        var configured = configuration[LegacyConfigKey];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            result.AddRange(configured
                .Split(new[] { '\n', '\r', ';', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(x => !string.IsNullOrWhiteSpace(x)));
        }

        var jwtSecret = configuration["Jwt:Secret"];
        if (!string.IsNullOrWhiteSpace(jwtSecret))
            result.Add(jwtSecret.Trim());

        var primary = GetPrimarySecret(configuration);
        return result
            .Where(x => !string.IsNullOrWhiteSpace(x) && !string.Equals(x, primary, StringComparison.Ordinal))
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    public static ApiKeyDecryptResult Decrypt(string? encryptedKey, IConfiguration configuration)
    {
        if (string.IsNullOrWhiteSpace(encryptedKey))
            return ApiKeyDecryptResult.Missing;

        var primary = GetPrimarySecret(configuration);
        var plain = DecryptPlausiblePlainText(encryptedKey, primary);
        if (!string.IsNullOrWhiteSpace(plain))
            return new ApiKeyDecryptResult(true, plain, false);

        foreach (var legacy in GetLegacySecrets(configuration))
        {
            plain = DecryptPlausiblePlainText(encryptedKey, legacy);
            if (!string.IsNullOrWhiteSpace(plain))
                return new ApiKeyDecryptResult(true, plain, true);
        }

        return ApiKeyDecryptResult.Unreadable;
    }

    public static string GetPrimarySecret(IConfiguration configuration)
    {
        var dedicated = configuration[PrimaryConfigKey];
        if (!string.IsNullOrWhiteSpace(dedicated))
            return dedicated.Trim();

        return (configuration["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!").Trim();
    }

    private static string DecryptPlausiblePlainText(string encryptedKey, string secret)
    {
        var plain = Decrypt(encryptedKey, secret);
        return IsPlausiblePlainSecret(plain) ? plain : string.Empty;
    }

    private static string Decrypt(string encryptedKey, string secretKey)
    {
        if (string.IsNullOrEmpty(encryptedKey)) return string.Empty;

        var parts = encryptedKey.Split(':');
        if (parts.Length != 2) return string.Empty;

        try
        {
            var keyBytes = Encoding.UTF8.GetBytes(secretKey.PadRight(32)[..32]);
            var iv = Convert.FromBase64String(parts[0]);
            var encryptedBytes = Convert.FromBase64String(parts[1]);

            using var aes = Aes.Create();
            aes.Key = keyBytes;
            aes.IV = iv;
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.PKCS7;

            using var decryptor = aes.CreateDecryptor();
            var decryptedBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);
            return Encoding.UTF8.GetString(decryptedBytes);
        }
        catch
        {
            return string.Empty;
        }
    }

    private static bool IsPlausiblePlainSecret(string? plainText)
    {
        if (string.IsNullOrWhiteSpace(plainText))
            return false;

        return plainText.All(c => c != '\uFFFD' && (!char.IsControl(c) || c is '\t' or '\n' or '\r'));
    }

    /// <summary>\u5934\u5C3E\u5404\u7559\u4E00\u70B9\u3001\u4E2D\u95F4\u6253\u7801\u7684\u5BC6\u94A5\u6307\u7EB9\u3002\u7528\u6765\u300C\u8BA4\u51FA\u662F\u54EA\u4E00\u628A\u300D\uFF0C\u4E0D\u662F\u7528\u6765\u300C\u8BFB\u51FA\u8FD9\u4E00\u628A\u300D\u3002</summary>
    public const int FingerprintHeadChars = 6;

    /// <summary>\u5C3E\u90E8\u4FDD\u7559\u4F4D\u6570\u3002\u6539\u5927\u4E4B\u524D\u5148\u60F3\u6E05\u695A\uFF1A\u6CC4\u6F0F\u91CF\u968F\u5B83\u7EBF\u6027\u589E\u957F\u3002</summary>
    public const int FingerprintTailChars = 4;

    /// <summary>
    /// \u628A\u660E\u6587\u5BC6\u94A5\u538B\u6210\u4E0D\u53EF\u8FD8\u539F\u7684\u6307\u7EB9\uFF0C\u5982 <c>sk-or-\u20269c2a</c>\u3002
    ///
    /// \u4E3A\u4EC0\u4E48\u9700\u8981\u5B83\uFF1A\u4E24\u6761\u4E0A\u6E38\u53EF\u4EE5\u540C\u540D\u3001\u540C API URL\uFF0C\u53EA\u6709 key \u4E0D\u540C\uFF08\u672C\u4ED3\u5E93\u771F\u51FA\u73B0\u8FC7\uFF1A
    /// noroenrnOpenrouter \u4E0E openrouter.ai \u90FD\u6307\u5411 openrouter.ai/api\uFF0C\u4E00\u628A\u6709\u6548\u4E00\u628A 401\uFF09\u3002
    /// \u5217\u8868\u53EA\u56DE hasKey \u65F6\uFF0C\u8FD0\u7EF4\u5206\u4E0D\u51FA\u773C\u524D\u8FD9\u6761\u662F\u54EA\u4E00\u628A\uFF0C\u4E5F\u5C31\u5224\u65AD\u4E0D\u4E86\u8BE5\u6362\u54EA\u4E2A\u3002
    ///
    /// \u77ED\u5BC6\u94A5\u4E0D\u505A\u300C\u6309\u6BD4\u4F8B\u4FDD\u7559\u300D\u2014\u2014\u8D8A\u77ED\u4FDD\u7559\u8D8A\u5C11\uFF0C\u76F4\u63A5\u6574\u6761\u6253\u7801\uFF0C\u907F\u514D\u5C0F\u6837\u672C\u88AB\u53CD\u63A8\u3002
    /// </summary>
    public static string Fingerprint(string? plainKey)
    {
        var key = plainKey?.Trim() ?? string.Empty;
        if (key.Length == 0) return string.Empty;

        // \u5934\u5C3E\u52A0\u8D77\u6765\u8FD8\u4E0D\u5230\u660E\u6587\u4E00\u534A\u5C31\u4E0D\u5B89\u5168\uFF0C\u76F4\u63A5\u5168\u7801
        if (key.Length < (FingerprintHeadChars + FingerprintTailChars) * 2)
            return new string('\u00B7', Math.Min(key.Length, 8));

        return $"{key[..FingerprintHeadChars]}\u2026{key[^FingerprintTailChars..]}";
    }
}

public sealed record ApiKeyDecryptResult(bool Success, string PlainText, bool UsedLegacySecret)
{
    public static ApiKeyDecryptResult Missing { get; } = new(false, string.Empty, false);
    public static ApiKeyDecryptResult Unreadable { get; } = new(false, string.Empty, false);
}
