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
}

public sealed record ApiKeyDecryptResult(bool Success, string PlainText, bool UsedLegacySecret)
{
    public static ApiKeyDecryptResult Missing { get; } = new(false, string.Empty, false);
    public static ApiKeyDecryptResult Unreadable { get; } = new(false, string.Empty, false);
}
