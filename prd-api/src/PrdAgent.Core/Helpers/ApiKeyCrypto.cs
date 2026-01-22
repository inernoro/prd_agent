using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Core.Helpers;

/// <summary>
/// API Key 加解密工具类
/// 加密格式: "Base64(IV):Base64(EncryptedData)"
/// </summary>
public static class ApiKeyCrypto
{
    /// <summary>
    /// 加密 API Key
    /// </summary>
    /// <param name="apiKey">明文 API Key</param>
    /// <param name="secretKey">加密密钥（至少 32 字符）</param>
    /// <returns>加密后的字符串，格式为 "IV:EncryptedData"</returns>
    public static string Encrypt(string apiKey, string secretKey)
    {
        if (string.IsNullOrEmpty(apiKey)) return string.Empty;

        var keyBytes = Encoding.UTF8.GetBytes(secretKey.PadRight(32)[..32]);

        using var aes = Aes.Create();
        aes.Key = keyBytes;
        aes.GenerateIV(); // 生成随机 IV
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;

        using var encryptor = aes.CreateEncryptor();
        var plainBytes = Encoding.UTF8.GetBytes(apiKey);
        var encryptedBytes = encryptor.TransformFinalBlock(plainBytes, 0, plainBytes.Length);

        // 格式: IV:EncryptedData
        return $"{Convert.ToBase64String(aes.IV)}:{Convert.ToBase64String(encryptedBytes)}";
    }

    /// <summary>
    /// 解密 API Key
    /// </summary>
    /// <param name="encryptedKey">加密后的字符串，格式为 "IV:EncryptedData"</param>
    /// <param name="secretKey">加密密钥（至少 32 字符）</param>
    /// <returns>解密后的明文 API Key，解密失败返回空字符串</returns>
    public static string Decrypt(string encryptedKey, string secretKey)
    {
        if (string.IsNullOrEmpty(encryptedKey)) return string.Empty;

        var parts = encryptedKey.Split(':');
        if (parts.Length != 2)
        {
            // 格式无效
            return string.Empty;
        }

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
            // 解密失败
            return string.Empty;
        }
    }

    /// <summary>
    /// 对 API Key 进行部分脱敏显示
    /// 保留前后各 4 个字符，中间用 *** 替代
    /// </summary>
    /// <param name="apiKey">明文 API Key</param>
    /// <returns>脱敏后的字符串</returns>
    public static string Mask(string? apiKey)
    {
        if (string.IsNullOrEmpty(apiKey)) return "***";

        const int visibleChars = 4;
        const int minLength = visibleChars * 2 + 1; // 至少 9 个字符才部分显示

        if (apiKey.Length < minLength)
        {
            return "***";
        }

        var prefix = apiKey[..visibleChars];
        var suffix = apiKey[^visibleChars..];
        return $"{prefix}***{suffix}";
    }
}
