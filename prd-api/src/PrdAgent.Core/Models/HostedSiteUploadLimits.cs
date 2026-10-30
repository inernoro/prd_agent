namespace PrdAgent.Core.Models;

/// <summary>托管包的容量边界；不放宽优化、文本扫描和文件清单预算。</summary>
public static class HostedSiteUploadLimits
{
    public const long MaxPackageBytes = 5000L * 1024 * 1024;
    public const long MaxSingleFileBytes = 500L * 1024 * 1024;

    public static string? ValidateSingleFileSize(long bytes) =>
        bytes < 0 || bytes > MaxSingleFileBytes
            ? "单个文件不能超过 500 MB，请拆分大文件后再上传"
            : null;

    public static string? ValidateExtractedSize(long bytes) =>
        bytes < 0 || bytes > MaxPackageBytes
            ? "解压后总大小超过限制 (5000MB)"
            : null;

    public static bool IsWithinPackageLimit(long bytes) => bytes > 0 && bytes <= MaxPackageBytes;
}
