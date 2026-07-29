using Microsoft.Extensions.Configuration;

namespace PrdAgent.Infrastructure.Services.AssetStorage;

/// <summary>
/// 存储提供商解析的单一事实源。启动时的 IAssetStorage 选择与所有公开 URL
/// 构造必须使用同一结果，避免 auto 模式下实际写入 R2/COS、URL 却按空配置处理。
/// </summary>
public static class AssetStorageProviderResolver
{
    public const string Local = "local";
    public const string TencentCos = "tencentCos";
    public const string CloudflareR2 = "cloudflareR2";

    public static string ResolveProviderName(IConfiguration configuration)
    {
        var configured = (configuration["ASSETS_PROVIDER"] ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(configured)
            && !string.Equals(configured, "auto", StringComparison.OrdinalIgnoreCase))
        {
            return configured;
        }

        if (HasTencentCosCredentials(configuration))
            return TencentCos;
        if (HasCloudflareR2Credentials(configuration))
            return CloudflareR2;
        if (HasAnyCloudCredentialFragment(configuration))
        {
            throw new InvalidOperationException(
                "检测到部分云存储凭据但不完整：请补全 TENCENT_COS_*（BUCKET/REGION/SECRET_ID/SECRET_KEY）" +
                "或 R2_*（ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET）整套；" +
                "若确实要用本地存储，请显式设置 ASSETS_PROVIDER=local。" +
                "已拒绝在凭据不完整时静默回退本地，以免资产写入容器本地盘、重部署后丢失。");
        }

        return Local;
    }

    public static string? ResolveCloudPublicBaseUrl(IConfiguration configuration)
    {
        var provider = ResolveProviderName(configuration);
        var raw = string.Equals(provider, CloudflareR2, StringComparison.OrdinalIgnoreCase)
            ? (configuration["R2_PUBLIC_BASE_URL"] ?? string.Empty).Trim().TrimEnd('/')
            : string.Equals(provider, TencentCos, StringComparison.OrdinalIgnoreCase)
                ? (configuration["TENCENT_COS_PUBLIC_BASE_URL"] ?? string.Empty).Trim().TrimEnd('/')
                : string.Empty;
        return string.IsNullOrWhiteSpace(raw) ? null : raw;
    }

    private static bool HasTencentCosCredentials(IConfiguration configuration)
        => !string.IsNullOrWhiteSpace(configuration["TENCENT_COS_BUCKET"])
           && !string.IsNullOrWhiteSpace(configuration["TENCENT_COS_REGION"])
           && !string.IsNullOrWhiteSpace(configuration["TENCENT_COS_SECRET_ID"])
           && !string.IsNullOrWhiteSpace(configuration["TENCENT_COS_SECRET_KEY"]);

    private static bool HasCloudflareR2Credentials(IConfiguration configuration)
        => !string.IsNullOrWhiteSpace(configuration["R2_ACCOUNT_ID"])
           && !string.IsNullOrWhiteSpace(configuration["R2_ACCESS_KEY_ID"])
           && !string.IsNullOrWhiteSpace(configuration["R2_SECRET_ACCESS_KEY"])
           && !string.IsNullOrWhiteSpace(configuration["R2_BUCKET"]);

    private static bool HasAnyCloudCredentialFragment(IConfiguration configuration)
        => new[]
        {
            "TENCENT_COS_BUCKET",
            "TENCENT_COS_REGION",
            "TENCENT_COS_SECRET_ID",
            "TENCENT_COS_SECRET_KEY",
            "R2_ACCOUNT_ID",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_BUCKET",
        }.Any(key => !string.IsNullOrWhiteSpace(configuration[key]));
}
