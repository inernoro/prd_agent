using Microsoft.Extensions.Configuration;
using PrdAgent.Core.Helpers;

namespace PrdAgent.Infrastructure.Security;

/// <summary>
/// 独立的平台 API key 加密钥匙环。
/// 新密文使用 ApiKeyCrypto:Secret；旧密文兼容读取 Jwt:Secret 和 ApiKeyCrypto:LegacySecrets。
/// </summary>
public static class ApiKeyCryptoKeyRing
{
    public const string PrimaryConfigKey = "ApiKeyCrypto:Secret";
    public const string LegacyConfigKey = "ApiKeyCrypto:LegacySecrets";

    public static string GetPrimarySecret(IConfiguration configuration)
    {
        var dedicated = configuration[PrimaryConfigKey];
        if (!string.IsNullOrWhiteSpace(dedicated))
            return dedicated.Trim();

        return (configuration["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!").Trim();
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
        var plain = ApiKeyCrypto.Decrypt(encryptedKey, primary);
        if (!string.IsNullOrWhiteSpace(plain))
            return new ApiKeyDecryptResult(true, plain, false);

        foreach (var legacy in GetLegacySecrets(configuration))
        {
            plain = ApiKeyCrypto.Decrypt(encryptedKey, legacy);
            if (!string.IsNullOrWhiteSpace(plain))
                return new ApiKeyDecryptResult(true, plain, true);
        }

        return ApiKeyDecryptResult.Unreadable;
    }

    public static string Encrypt(string plainText, IConfiguration configuration)
        => ApiKeyCrypto.Encrypt(plainText, GetPrimarySecret(configuration));

    public static string? DecryptPlainOrNull(string? encryptedKey, IConfiguration configuration)
    {
        var result = Decrypt(encryptedKey, configuration);
        return result.Success ? result.PlainText : null;
    }

    public static string? Mask(string? encryptedKey, IConfiguration configuration)
    {
        var result = Decrypt(encryptedKey, configuration);
        return result.Success ? ApiKeyCrypto.Mask(result.PlainText) : null;
    }
}

public sealed record ApiKeyDecryptResult(bool Success, string PlainText, bool UsedLegacySecret)
{
    public static ApiKeyDecryptResult Missing { get; } = new(false, string.Empty, false);
    public static ApiKeyDecryptResult Unreadable { get; } = new(false, string.Empty, false);
}
