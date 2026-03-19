using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 桌面客户端更新加速缓存：将 GitHub Release 资产缓存到 COS，加速国内下载。
/// 每个 (Version, Target) 对应一条记录。
/// </summary>
[AppOwnership(AppNames.Desktop, AppNames.DesktopDisplay, IsPrimary = true)]
public class DesktopUpdateCache
{
    public string Id { get; set; } = string.Empty;

    /// <summary>版本号（如 "1.6.0"）</summary>
    public string Version { get; set; } = string.Empty;

    /// <summary>平台目标（如 "x86_64-pc-windows-msvc"、"aarch64-apple-darwin"）</summary>
    public string Target { get; set; } = string.Empty;

    /// <summary>原始 GitHub manifest JSON（latest-{target}.json 的完整内容）</summary>
    public string OriginalManifestJson { get; set; } = string.Empty;

    /// <summary>安装包的 COS URL（替换 manifest 中的 url 字段后返回给客户端）</summary>
    public string? CosPackageUrl { get; set; }

    /// <summary>加速后的 manifest JSON（url 已替换为 COS 地址）</summary>
    public string? AcceleratedManifestJson { get; set; }

    /// <summary>缓存状态：pending / downloading / ready / failed</summary>
    public string Status { get; set; } = "pending";

    /// <summary>失败原因（Status == failed 时）</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>安装包文件大小（字节）</summary>
    public long? PackageSizeBytes { get; set; }

    /// <summary>GitHub 安装包下载 URL（原始）</summary>
    public string? GithubPackageUrl { get; set; }

    /// <summary>Signature（Minisign 签名，从 manifest 中复制）</summary>
    public string? Signature { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
