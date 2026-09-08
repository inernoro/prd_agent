namespace PrdAgent.Infrastructure.Services.AssetStorage;

/// <summary>
/// 一次保存的结果。
///
/// <para><b>为什么要带 <paramref name="Key"/></b>：<paramref name="Url"/> 是**本站此刻**的绝对地址
/// （公网域名 + 本站前缀 + key）。把它当成附件的身份存进库，等于把「东西在哪」和
/// 「这台机器叫什么」焊死在一起——换个桶、换个公网域名、或者把库搬到另一台机器，
/// 存量地址全部指回原处（debt.platform.cross-instance-data-sync 的 DS1）。</para>
///
/// <para>key 才是不随部署变化的那一半。存下它，运行时用 <see cref="IAssetStorage.BuildUrlForKey"/>
/// 拼本站前缀，地址就跟着部署走。可空只是为了兼容存量与测试替身；
/// 真实实现必须回填，有守卫盯着。</para>
/// </summary>
public record StoredAsset(string Sha256, string Url, long SizeBytes, string Mime, string? Key = null);
public record AssetReadHandle(Stream Content, string Mime, long? Length);

/// <summary>
/// 允许存储实现回收严格受约束的自服务头像单对象，不扩大通用安全删除白名单。
/// </summary>
public static class AssetStorageDeletePolicy
{
    private const string AvatarPathPrefix = "icon/backups/head/";

    public static bool IsVersionedUserAvatarKey(string? key, string? configuredPrefix = null)
    {
        var normalized = (key ?? string.Empty).Trim().Replace('\\', '/').TrimStart('/');
        var prefix = (configuredPrefix ?? string.Empty).Trim().Replace('\\', '/').Trim('/');
        if (!string.IsNullOrWhiteSpace(prefix)
            && normalized.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized[(prefix.Length + 1)..];
        }

        if (!normalized.StartsWith(AvatarPathPrefix, StringComparison.OrdinalIgnoreCase)) return false;
        var fileName = normalized[AvatarPathPrefix.Length..];
        return System.Text.RegularExpressions.Regex.IsMatch(
            fileName,
            @"^u-[0-9a-f]{12}-[0-9a-f]{24}\.(png|jpg|gif|webp)$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase
            | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    }

    public static bool IsContentAddressedGeneratedVideoKey(string? key, string? configuredPrefix = null)
    {
        var normalized = (key ?? string.Empty).Trim().Replace('\\', '/').TrimStart('/');
        var prefix = (configuredPrefix ?? string.Empty).Trim().Replace('\\', '/').Trim('/');
        if (!string.IsNullOrWhiteSpace(prefix)
            && normalized.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized[(prefix.Length + 1)..];
        }

        return System.Text.RegularExpressions.Regex.IsMatch(
            normalized,
            @"^video-agent/video/[a-z2-7]{26}\.mp4$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase
            | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    }

    public static bool IsContentAddressedGeneratedImageKey(string? key, string? configuredPrefix = null)
    {
        var normalized = (key ?? string.Empty).Trim().Replace('\\', '/').TrimStart('/');
        var prefix = (configuredPrefix ?? string.Empty).Trim().Replace('\\', '/').Trim('/');
        if (!string.IsNullOrWhiteSpace(prefix)
            && normalized.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized[(prefix.Length + 1)..];
        }

        return System.Text.RegularExpressions.Regex.IsMatch(
            normalized,
            @"^visual-agent/img/[a-z2-7]{26}\.(png|jpg|jpeg|gif|webp)$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase
            | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    }

    /// <summary>
    /// 网页托管优化只允许回收系统生成的临时对象。站点 ID 必须是 32 位十六进制，
    /// 且路径必须落在 __chunks、__source 或 __preview 下；正式站点文件永远不命中。
    /// </summary>
    public static bool IsHostedSiteOptimizationTemporaryKey(string? key, string? configuredPrefix = null)
    {
        var normalized = (key ?? string.Empty).Trim().Replace('\\', '/').TrimStart('/');
        var prefix = (configuredPrefix ?? string.Empty).Trim().Replace('\\', '/').Trim('/');
        if (!string.IsNullOrWhiteSpace(prefix)
            && normalized.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized[(prefix.Length + 1)..];
        }

        if (normalized.Contains("/../", StringComparison.Ordinal)
            || normalized.EndsWith("/..", StringComparison.Ordinal)
            || normalized.Contains("/./", StringComparison.Ordinal)
            || normalized.EndsWith("/.", StringComparison.Ordinal))
            return false;

        return System.Text.RegularExpressions.Regex.IsMatch(
            normalized,
            @"^web-hosting/sites/[0-9a-f]{32}/__(chunks/[0-9]{6}\.part|source/source\.zip|preview/.+)$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase
            | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    }
}

/// <summary>
/// 暴露运行时实际选择的存储实现，供就绪检查核对环境合同。
/// 只返回提供商名称，不暴露 bucket、endpoint 或凭据。
/// </summary>
public interface IAssetStorageRuntimeInfo
{
    string ProviderName { get; }
}

public interface IAssetStorage
{
    /// <summary>
    /// 保存 bytes 并返回稳定可访问 URL。
    /// 重要：若提供 domain/type，则会把对象存储到 {domain}/{type}/...（全小写）。
    /// fileName/extensionHint 用于决定存储 key 的扩展名 —— 这是首选来源，因为 mime 反推
    /// 扩展名（image/jpeg → jpg）对 audio/video/zip/docx 等不可靠（octet-stream 全踩坑）。
    ///   - 优先：extensionHint（如 ".m4a"）
    ///   - 次选：从 fileName 提取扩展名
    ///   - 最后：从 mime 反推（仅图片/字体/常见文档可靠）
    ///   - 兜底：".bin"（绝不再用 .png 兜底，否则 CDN 会按图片处理音视频）
    /// </summary>
    Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null, string? fileName = null, string? extensionHint = null);

    /// <summary>
    /// 按 sha256 读取 bytes（用于本地存储或兼容旧数据）。
    /// </summary>
    Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null);

    /// <summary>
    /// 按 sha256 打开顺序读取流。用于大文件响应，避免把完整对象装入托管内存。
    /// 不支持原生流的远端实现可返回 null，由调用方使用受控 HTTP 流式代理。
    /// </summary>
    Task<AssetReadHandle?> TryOpenReadByShaAsync(
        string sha256,
        CancellationToken ct,
        string? domain = null,
        string? type = null) => Task.FromResult<AssetReadHandle?>(null);

    /// <summary>
    /// 按 sha256 删除底层对象（若实现支持）。
    /// </summary>
    Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null);

    /// <summary>
    /// 按 sha256 和 mime 类型构建公开访问 URL（不下载文件）。
    /// </summary>
    string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null);

    /// <summary>
    /// 按 key 下载对象的原始 bytes（不存在返回 null）。
    /// </summary>
    Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct);

    /// <summary>
    /// 判断指定 key 的对象是否存在。
    /// </summary>
    Task<bool> ExistsAsync(string key, CancellationToken ct);

    /// <summary>
    /// 上传 bytes 到指定的自定义 key（绕过 SHA256 去重，用于站点托管等场景）。
    /// key 需包含完整路径（含 prefix），可通过 BuildSiteKey 生成。
    /// cacheControl 可选：设置对象的 Cache-Control 响应头（如 "public, max-age=3600"）。
    /// 网页托管场景配合 SiteUrl 上的 ?v={UpdatedAt} 版本指纹使用：内容不变 → URL 不变 → 命中缓存；
    /// 重新上传 → UpdatedAt 变化 → URL 变化 → 击穿缓存。
    /// </summary>
    Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct, string? cacheControl = null);

    /// <summary>
    /// 根据 key 构建公开访问 URL。
    /// </summary>
    /// <remarks>
    /// 这里的 key 是**完整物理 key**：本实现原样使用，不会替你补上自己配置的前缀。
    /// 内容寻址对象的物理 key 由 <c>SaveAsync</c> 生成、已经含前缀，所以这个方法拼得对；
    /// 但**跨站搬来的 key 带的是源站前缀**，那种场景要用
    /// <see cref="BuildUrlForLogicalKey"/>。
    /// </remarks>
    string BuildUrlForKey(string key);

    /// <summary>
    /// 根据**不带前缀的逻辑 key**（`{domain}/{type}/{文件名}`）构建本站地址：先套本站前缀，再拼公网根。
    /// </summary>
    /// <remarks>
    /// 跨实例同步专用。搬过来的对象 key 带的是**源站**前缀，两站前缀不一致时，
    /// 拿它直接走 <see cref="BuildUrlForKey"/> 会拼出 `{本站根}/{源站前缀}/...`——
    /// 一个谁家都不是的路径（DS31）。调用方先把 key 剥成逻辑 key，前缀交给本方法套。
    ///
    /// 默认实现等同 <see cref="BuildUrlForKey"/>：没有前缀概念的实现（本地磁盘）本就一致，
    /// 测试替身也不必为此改签名。真正带前缀的实现（R2 / COS）必须覆写。
    /// </remarks>
    string BuildUrlForLogicalKey(string logicalKey) => BuildUrlForKey(logicalKey);

    /// <summary>
    /// 删除指定 key 的对象。
    /// </summary>
    Task DeleteByKeyAsync(string key, CancellationToken ct);

    /// <summary>
    /// 构建站点托管文件的 COS key（含 prefix），格式：{prefix}/web-hosting/sites/{siteId}/{filePath}
    /// </summary>
    string BuildSiteKey(string siteId, string filePath);
}
