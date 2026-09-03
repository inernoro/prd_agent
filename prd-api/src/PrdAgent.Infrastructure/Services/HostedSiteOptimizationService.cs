using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 网页托管 ZIP 的保守型优化器：只移除确定不参与浏览器运行的开发文件，并把可从包内
/// node_modules 精确找到的公共 CDN 依赖收敛到 vendor。任何不确定性都保留或阻断。
/// </summary>
public sealed partial class HostedSiteOptimizationService : IHostedSiteOptimizationService
{
    private const int MaxArchiveEntries = 20_000;
    private const long MaxUncompressedBytes = 500L * 1024 * 1024;
    private const long MaxOptimizationBytes = 200L * 1024 * 1024;
    private const long MaxScannedTextFileBytes = 8L * 1024 * 1024;
    private const long MaxScannedTextBytes = 32L * 1024 * 1024;
    private static readonly TimeSpan SessionLifetime = TimeSpan.FromHours(2);

    private static readonly HashSet<string> DevelopmentDirectoryNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", ".cache", ".parcel-cache", ".turbo", ".vite", "coverage",
        "screenshots", "test-results", "tests", "__tests__",
    };

    private static readonly HashSet<string> DevelopmentFileNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ".DS_Store", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
        "tsconfig.json", "vite.config.js", "vite.config.ts", "eslint.config.js",
    };

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly IHostedSiteService _hostedSites;
    private readonly ILogger<HostedSiteOptimizationService> _logger;

    public HostedSiteOptimizationService(
        MongoDbContext db,
        IAssetStorage storage,
        IHostedSiteService hostedSites,
        ILogger<HostedSiteOptimizationService> logger)
    {
        _db = db;
        _storage = storage;
        _hostedSites = hostedSites;
        _logger = logger;
    }

    public HostedSiteOptimizationAnalysis Analyze(byte[] zipBytes)
        => BuildOptimizedPackage(zipBytes).Analysis;

    public async Task<HostedSiteOptimizationSession> CreateSessionAsync(
        string userId,
        byte[] zipBytes,
        string fileName,
        string? targetSiteId,
        string? title,
        string? description,
        string? folder,
        List<string> tags,
        HostedSiteOptimizationAnalysis analysis,
        CancellationToken ct = default)
    {
        if (!analysis.Recommended || analysis.Blocked)
            throw new InvalidOperationException("这个文件不需要进入优化预览");

        if (!string.IsNullOrWhiteSpace(targetSiteId)
            && await _hostedSites.GetByIdAsync(targetSiteId, userId, ct) == null)
            throw new KeyNotFoundException("站点不存在");

        var now = DateTime.UtcNow;
        var session = new HostedSiteOptimizationSession
        {
            OwnerUserId = userId,
            TargetSiteId = string.IsNullOrWhiteSpace(targetSiteId) ? null : targetSiteId.Trim(),
            SourceFileName = Path.GetFileName(fileName),
            SourceSha256 = Convert.ToHexString(SHA256.HashData(zipBytes)).ToLowerInvariant(),
            Title = title?.Trim(),
            Description = description?.Trim(),
            Folder = folder?.Trim(),
            Tags = tags,
            Analysis = analysis,
            CreatedAt = now,
            UpdatedAt = now,
            ExpiresAt = now.Add(SessionLifetime),
        };
        session.SourceObjectKey = _storage.BuildSiteKey(session.Id, "__source/source.zip");

        await _storage.UploadToKeyAsync(
            session.SourceObjectKey,
            zipBytes,
            "application/zip",
            CancellationToken.None,
            "private, no-store");
        try
        {
            await _db.HostedSiteOptimizationSessions.InsertOneAsync(session, cancellationToken: ct);
        }
        catch
        {
            await TryDeleteAsync(session.SourceObjectKey);
            throw;
        }

        return session;
    }

    public async Task<HostedSiteOptimizationPreviewResult> PreparePreviewAsync(
        string sessionId,
        string userId,
        CancellationToken ct = default)
    {
        var session = await GetOwnedSessionAsync(sessionId, userId, ct);
        EnsureUsable(session);

        if (session.Status == HostedSiteOptimizationStatuses.PreviewReady
            && session.PreviewFiles.Count > 0
            && !string.IsNullOrWhiteSpace(session.PreviewEntryFile))
            return ToPreviewResult(session);

        session.ExpiresAt = DateTime.UtcNow.Add(SessionLifetime);
        session.UpdatedAt = DateTime.UtcNow;
        await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
            x => x.Id == session.Id && x.OwnerUserId == userId,
            Builders<HostedSiteOptimizationSession>.Update
                .Set(x => x.ExpiresAt, session.ExpiresAt)
                .Set(x => x.UpdatedAt, session.UpdatedAt),
            cancellationToken: ct);

        var sourceBytes = await _storage.TryDownloadBytesAsync(session.SourceObjectKey, ct)
            ?? throw new InvalidOperationException("临时源文件已经过期，请重新选择文件");
        var sourceSha = Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant();
        if (!string.Equals(sourceSha, session.SourceSha256, StringComparison.Ordinal))
            throw new InvalidOperationException("临时源文件校验失败，请重新选择文件");

        var build = BuildOptimizedPackage(sourceBytes);
        if (build.Analysis.Blocked || !build.Analysis.Recommended || build.Files.Count == 0)
            throw new InvalidOperationException(build.Analysis.Error ?? "当前文件无法安全自动优化，请保留原文件");

        var uploaded = new List<HostedSiteFile>();
        try
        {
            foreach (var (path, bytes) in build.Files.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                var key = _storage.BuildSiteKey(session.Id, $"__preview/{path}");
                var mime = MimeFor(path);
                await _storage.UploadToKeyAsync(
                    key,
                    bytes,
                    mime == "text/html" ? "text/html; charset=utf-8" : mime,
                    CancellationToken.None,
                    "private, no-store");
                uploaded.Add(new HostedSiteFile
                {
                    Path = path,
                    CosKey = key,
                    Size = bytes.Length,
                    MimeType = mime,
                });
            }

            var totalSize = uploaded.Sum(x => x.Size);
            var manifestError = HostedSiteService.ValidateZipManifestSize(uploaded);
            if (manifestError != null)
                throw new InvalidOperationException(manifestError);

            session.PreviewFiles = uploaded;
            session.PreviewEntryFile = build.EntryFile;
            session.PreviewTotalSize = totalSize;
            session.Analysis = build.Analysis;
            session.Status = HostedSiteOptimizationStatuses.PreviewReady;
            session.UpdatedAt = DateTime.UtcNow;

            await _db.HostedSiteOptimizationSessions.ReplaceOneAsync(
                x => x.Id == session.Id && x.OwnerUserId == userId,
                session,
                cancellationToken: ct);
            return ToPreviewResult(session);
        }
        catch
        {
            var cleaned = true;
            foreach (var file in uploaded)
                cleaned = await TryDeleteAsync(file.CosKey) && cleaned;
            if (!cleaned)
            {
                await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id && x.OwnerUserId == userId,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.Status, HostedSiteOptimizationStatuses.CleanupPending)
                        .Set(x => x.PreviewFiles, uploaded)
                        .Set(x => x.ExpiresAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            }
            throw;
        }
    }

    public async Task<HostedSite> ConfirmAsync(
        string sessionId,
        string userId,
        string variant,
        CancellationToken ct = default)
    {
        var normalizedVariant = (variant ?? string.Empty).Trim().ToLowerInvariant();
        if (normalizedVariant is not ("original" or "optimized"))
            throw new InvalidOperationException("请选择保存原文件或优化版本");

        var session = await GetOwnedSessionAsync(sessionId, userId, ct);
        EnsureUsable(session);
        if (normalizedVariant == "optimized"
            && (session.Status != HostedSiteOptimizationStatuses.PreviewReady || session.PreviewFiles.Count == 0))
            throw new InvalidOperationException("请先查看优化版本，再决定是否保存");

        var previousStatus = session.Status;
        var claim = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
            x => x.Id == session.Id
                 && x.OwnerUserId == userId
                 && x.Status == previousStatus
                 && x.ExpiresAt > DateTime.UtcNow,
            Builders<HostedSiteOptimizationSession>.Update
                .Set(x => x.Status, HostedSiteOptimizationStatuses.Saving)
                .Set(x => x.UpdatedAt, DateTime.UtcNow)
                .Set(x => x.ExpiresAt, DateTime.UtcNow.AddMinutes(30)),
            cancellationToken: ct);
        if (claim.ModifiedCount != 1)
            throw new InvalidOperationException("这个优化任务正在保存或已经过期，请刷新后重试");

        HostedSite saved;
        try
        {
            var zipBytes = normalizedVariant == "original"
                ? await _storage.TryDownloadBytesAsync(session.SourceObjectKey, ct)
                : await BuildZipFromPreviewAsync(session, ct);
            if (zipBytes == null || zipBytes.Length == 0)
                throw new InvalidOperationException("临时文件已经过期，请重新选择文件");

            if (string.IsNullOrWhiteSpace(session.TargetSiteId))
            {
                saved = await _hostedSites.CreateFromZipAsync(
                    userId,
                    zipBytes,
                    session.Title,
                    session.Description,
                    session.Folder,
                    session.Tags,
                    ct: CancellationToken.None);
            }
            else
            {
                saved = await _hostedSites.ReuploadAsync(
                    session.TargetSiteId,
                    userId,
                    zipBytes,
                    session.SourceFileName,
                    ct: CancellationToken.None);
                var metadata = await _hostedSites.UpdateAsync(
                    saved.Id,
                    userId,
                    session.Title,
                    session.Description,
                    session.Tags,
                    session.Folder,
                    coverImageUrl: null,
                    ct: CancellationToken.None);
                if (metadata != null) saved = metadata;
            }
        }
        catch
        {
            await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                x => x.Id == session.Id && x.OwnerUserId == userId,
                Builders<HostedSiteOptimizationSession>.Update
                    .Set(x => x.Status, previousStatus)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow)
                    .Set(x => x.ExpiresAt, DateTime.UtcNow.Add(SessionLifetime)),
                cancellationToken: CancellationToken.None);
            throw;
        }

        // 从这里开始正式站点已经保存成功，后续清理异常不能再把状态恢复成可确认，
        // 否则客户端重试会重复创建站点。先固化完成身份，再做不影响结果的清理。
        session.Status = HostedSiteOptimizationStatuses.CleanupPending;
        session.CompletedSiteId = saved.Id;
        session.ExpiresAt = DateTime.UtcNow;
        session.UpdatedAt = DateTime.UtcNow;
        try
        {
            await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                x => x.Id == session.Id && x.OwnerUserId == userId,
                Builders<HostedSiteOptimizationSession>.Update
                    .Set(x => x.Status, session.Status)
                    .Set(x => x.CompletedSiteId, session.CompletedSiteId)
                    .Set(x => x.ExpiresAt, session.ExpiresAt)
                    .Set(x => x.UpdatedAt, session.UpdatedAt),
                cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "网页托管优化已保存，但记录完成状态失败: {SessionId}", session.Id);
        }

        if (await CleanupSessionFilesAsync(session))
        {
            try
            {
                await _db.HostedSiteOptimizationSessions.DeleteOneAsync(
                    x => x.Id == session.Id,
                    CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "网页托管优化临时文件已清理，但删除会话失败: {SessionId}", session.Id);
            }
        }
        return saved;
    }

    public async Task CancelAsync(string sessionId, string userId, CancellationToken ct = default)
    {
        var session = await _db.HostedSiteOptimizationSessions
            .Find(x => x.Id == sessionId && x.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
        if (session == null) return;
        if (session.Status == HostedSiteOptimizationStatuses.Saving)
            throw new InvalidOperationException("优化版本正在保存，请稍后查看结果");

        session.Status = HostedSiteOptimizationStatuses.CleanupPending;
        session.ExpiresAt = DateTime.UtcNow;
        if (await CleanupSessionFilesAsync(session))
        {
            await _db.HostedSiteOptimizationSessions.DeleteOneAsync(x => x.Id == session.Id, ct);
        }
        else
        {
            await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                x => x.Id == session.Id && x.OwnerUserId == userId,
                Builders<HostedSiteOptimizationSession>.Update
                    .Set(x => x.Status, session.Status)
                    .Set(x => x.ExpiresAt, session.ExpiresAt),
                cancellationToken: ct);
        }
    }

    public async Task<int> CleanupExpiredAsync(CancellationToken ct = default)
    {
        var expired = await _db.HostedSiteOptimizationSessions
            .Find(x => x.ExpiresAt <= DateTime.UtcNow)
            .Limit(20)
            .ToListAsync(ct);
        var cleanedCount = 0;
        foreach (var session in expired)
        {
            if (await CleanupSessionFilesAsync(session))
            {
                await _db.HostedSiteOptimizationSessions.DeleteOneAsync(x => x.Id == session.Id, ct);
                cleanedCount++;
            }
        }
        return cleanedCount;
    }

    private async Task<HostedSiteOptimizationSession> GetOwnedSessionAsync(
        string sessionId,
        string userId,
        CancellationToken ct)
        => await _db.HostedSiteOptimizationSessions
               .Find(x => x.Id == sessionId && x.OwnerUserId == userId)
               .FirstOrDefaultAsync(ct)
           ?? throw new KeyNotFoundException("优化任务不存在或已经过期");

    private static void EnsureUsable(HostedSiteOptimizationSession session)
    {
        if (session.ExpiresAt <= DateTime.UtcNow)
            throw new InvalidOperationException("优化任务已经过期，请重新选择文件");
        if (session.Status == HostedSiteOptimizationStatuses.Saving)
            throw new InvalidOperationException("优化版本正在保存，请稍后查看结果");
        if (session.Status == HostedSiteOptimizationStatuses.CleanupPending)
            throw new InvalidOperationException("这个优化任务已经结束，请刷新站点列表查看结果");
    }

    private HostedSiteOptimizationPreviewResult ToPreviewResult(HostedSiteOptimizationSession session)
    {
        var entry = session.PreviewFiles.FirstOrDefault(
            x => string.Equals(x.Path, session.PreviewEntryFile, StringComparison.OrdinalIgnoreCase));
        if (entry == null) throw new InvalidOperationException("优化版本缺少入口文件，请重新优化");
        return new HostedSiteOptimizationPreviewResult
        {
            SessionId = session.Id,
            PreviewUrl = _storage.BuildUrlForKey(entry.CosKey),
            EntryFile = entry.Path,
            FileCount = session.PreviewFiles.Count,
            TotalSize = session.PreviewTotalSize,
            ExpiresAt = session.ExpiresAt,
            Analysis = session.Analysis,
        };
    }

    private async Task<byte[]?> BuildZipFromPreviewAsync(
        HostedSiteOptimizationSession session,
        CancellationToken ct)
    {
        using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var file in session.PreviewFiles.OrderBy(x => x.Path, StringComparer.Ordinal))
            {
                var bytes = await _storage.TryDownloadBytesAsync(file.CosKey, ct);
                if (bytes == null) return null;
                var entry = archive.CreateEntry(file.Path, CompressionLevel.Optimal);
                await using var stream = entry.Open();
                await stream.WriteAsync(bytes, ct);
            }
        }
        return output.ToArray();
    }

    private async Task<bool> CleanupSessionFilesAsync(HostedSiteOptimizationSession session)
    {
        var cleaned = await TryDeleteAsync(session.SourceObjectKey);
        foreach (var file in session.PreviewFiles)
            cleaned = await TryDeleteAsync(file.CosKey) && cleaned;
        return cleaned;
    }

    private async Task<bool> TryDeleteAsync(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return true;
        try
        {
            await _storage.DeleteByKeyAsync(key, CancellationToken.None);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "清理网页托管优化临时对象失败: {Key}", key);
            return false;
        }
    }

    private sealed class OptimizedBuild
    {
        public HostedSiteOptimizationAnalysis Analysis { get; init; } = new();
        public Dictionary<string, byte[]> Files { get; init; } = new(StringComparer.Ordinal);
        public string EntryFile { get; init; } = string.Empty;
    }

    private sealed record ArchiveFile(ZipArchiveEntry Entry, string LogicalPath);

    private OptimizedBuild BuildOptimizedPackage(byte[] zipBytes)
    {
        var analysis = new HostedSiteOptimizationAnalysis { OriginalArchiveBytes = zipBytes.LongLength };
        try
        {
            using var input = new MemoryStream(zipBytes, writable: false);
            using var archive = new ZipArchive(input, ZipArchiveMode.Read);
            analysis.OriginalEntries = archive.Entries.Count;
            if (archive.Entries.Count > MaxArchiveEntries)
                return Blocked(analysis, $"ZIP 文件超过 {MaxArchiveEntries} 项，请先在本地导出运行包");

            var rawNames = archive.Entries.Select(x => NormalizePath(x.FullName)).ToList();
            if (rawNames.Any(IsUnsafePath))
                return Blocked(analysis, "ZIP 包含不安全路径，未进行优化");
            if (rawNames.GroupBy(x => x, StringComparer.Ordinal).Any(x => x.Count() > 1))
                return Blocked(analysis, "ZIP 包含重复路径，无法确定应保留哪个文件");
            if (rawNames.Where(x => !string.IsNullOrEmpty(x))
                .GroupBy(x => x, StringComparer.OrdinalIgnoreCase).Any(x => x.Select(y => y).Distinct(StringComparer.Ordinal).Count() > 1))
                return Blocked(analysis, "ZIP 包含仅大小写不同的路径，跨平台发布可能覆盖文件");

            var prefix = DetectRootPrefix(archive.Entries);
            var files = archive.Entries
                .Where(x => !string.IsNullOrEmpty(x.Name))
                .Select(x => new ArchiveFile(x, StripRoot(NormalizePath(x.FullName), prefix)))
                .ToList();
            analysis.OriginalFiles = files.Count;
            analysis.OriginalUncompressedBytes = files.Sum(x => x.Entry.Length);
            if (analysis.OriginalUncompressedBytes > MaxUncompressedBytes)
                return Blocked(analysis, "ZIP 解压后超过 500 MB，未进行优化");
            if (analysis.OriginalUncompressedBytes > MaxOptimizationBytes)
            {
                analysis.Warnings.Add("文件解压后超过 200 MB，本次跳过自动优化并按原文件保存");
                return new OptimizedBuild { Analysis = analysis };
            }
            if (files.Any(x => x.Entry.CompressedLength > 0
                               && x.Entry.Length > 1024 * 1024
                               && x.Entry.Length / Math.Max(1d, x.Entry.CompressedLength) > 1000d))
                return Blocked(analysis, "ZIP 中存在异常压缩比文件，未进行优化");

            var byPath = files.ToDictionary(x => x.LogicalPath, StringComparer.Ordinal);
            var entryFile = SelectEntry(byPath.Keys);
            if (entryFile == null)
                return Blocked(analysis, "ZIP 缺少 index.html 或 index.htm，无法生成可预览站点");

            var runtimeTextEntries = files.Where(x => IsScannedRuntimeText(x.LogicalPath)).ToList();
            if (runtimeTextEntries.Any(x => x.Entry.Length > MaxScannedTextFileBytes)
                || runtimeTextEntries.Sum(x => x.Entry.Length) > MaxScannedTextBytes)
            {
                analysis.Warnings.Add("运行文本规模过大，本次跳过自动优化并按原文件保存");
                return new OptimizedBuild { Analysis = analysis };
            }

            var output = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            foreach (var file in files)
            {
                if (IsNodeModules(file.LogicalPath))
                {
                    analysis.NodeModulesFiles++;
                    continue;
                }
                if (IsDevelopmentFile(file.LogicalPath))
                {
                    analysis.DevelopmentFiles++;
                    continue;
                }
                output[file.LogicalPath] = ReadEntry(file.Entry);
            }

            if (!output.ContainsKey(entryFile))
                return Blocked(analysis, "入口文件被识别为开发产物，未进行自动优化");

            var replacements = new Dictionary<string, string>(StringComparer.Ordinal);
            var pendingStyles = new Queue<(string SourcePath, string OutputPath)>();
            foreach (Match match in ExternalPackageUrlRegex().Matches(Encoding.UTF8.GetString(output[entryFile])))
            {
                var url = match.Value;
                var packageName = match.Groups["package"].Value;
                var packagePath = match.Groups["path"].Value;
                var sourcePath = $"node_modules/{packageName}/{packagePath}";
                if (!byPath.ContainsKey(sourcePath)) continue;
                var outputPath = $"vendor/{packageName}/{packagePath}";
                AddVendorFile(sourcePath, outputPath, byPath, output, pendingStyles);
                replacements[url] = RelativeReference(entryFile, outputPath);
                analysis.LocalizedDependencies++;
                AddPackageLicense(packageName, byPath, output, pendingStyles);
            }

            while (pendingStyles.Count > 0)
            {
                var (sourcePath, outputPath) = pendingStyles.Dequeue();
                var css = Encoding.UTF8.GetString(output[outputPath]);
                foreach (Match match in CssReferenceRegex().Matches(css))
                {
                    var value = match.Groups["path"].Value.Trim().Trim('"', '\'');
                    if (IsIgnoredReference(value) || IsExternalReference(value)) continue;
                    var nestedSource = ResolveReference(sourcePath, value);
                    if (nestedSource == null || !byPath.ContainsKey(nestedSource)) continue;
                    var packageRoot = GetPackageRoot(sourcePath, "node_modules/");
                    if (packageRoot == null || !nestedSource.StartsWith($"{packageRoot}/", StringComparison.Ordinal))
                        continue;
                    var packageRelative = nestedSource[(packageRoot.Length + 1)..];
                    var vendorRoot = GetPackageRoot(outputPath, "vendor/");
                    if (vendorRoot == null) continue;
                    var nestedOutput = $"{vendorRoot}/{packageRelative}";
                    AddVendorFile(nestedSource, nestedOutput, byPath, output, pendingStyles);
                }
            }

            if (replacements.Count > 0)
            {
                var html = Encoding.UTF8.GetString(output[entryFile]);
                foreach (var (from, to) in replacements) html = html.Replace(from, to, StringComparison.Ordinal);
                output[entryFile] = Encoding.UTF8.GetBytes(html);
            }

            var missing = FindMissingRuntimeReferences(output);
            if (missing.Count > 0)
                return Blocked(analysis, $"入口引用的本地资源缺失：{string.Join("、", missing.Take(3))}");

            analysis.OptimizedFiles = output.Count;
            analysis.OptimizedUncompressedBytes = output.Values.Sum(x => (long)x.Length);
            analysis.RemovedFiles = Math.Max(0, analysis.OriginalFiles - output.Count);
            analysis.SavedUncompressedBytes = Math.Max(0, analysis.OriginalUncompressedBytes - analysis.OptimizedUncompressedBytes);

            if (analysis.OriginalEntries > 5000)
                analysis.Reasons.Add($"原包共有 {analysis.OriginalEntries} 项，超过常规网页托管建议值 5000");
            if (analysis.NodeModulesFiles > 0)
                analysis.Reasons.Add($"检测到 {analysis.NodeModulesFiles} 个 node_modules 文件");
            if (analysis.DevelopmentFiles > 0)
                analysis.Reasons.Add($"检测到 {analysis.DevelopmentFiles} 个测试、缓存、锁文件或源码映射");
            if (analysis.LocalizedDependencies > 0)
                analysis.Reasons.Add($"可将 {analysis.LocalizedDependencies} 个外部依赖固定为包内 vendor 文件");

            var stillExternal = ExternalUrlRegex().Matches(Encoding.UTF8.GetString(output[entryFile])).Count;
            if (stillExternal > 0)
                analysis.Warnings.Add($"入口仍包含 {stillExternal} 个外部地址，预览时请确认网络依赖可用");

            var meaningfulSaving = analysis.RemovedFiles >= 100
                                   && analysis.OptimizedFiles <= analysis.OriginalFiles * 0.8;
            analysis.Recommended = meaningfulSaving
                                   || (analysis.OriginalEntries > 5000 && analysis.OptimizedFiles <= 5000);
            return new OptimizedBuild { Analysis = analysis, Files = output, EntryFile = entryFile };
        }
        catch (InvalidDataException)
        {
            return Blocked(analysis, "ZIP 文件无效或已损坏，请重新导出后再试");
        }
        catch (DecoderFallbackException)
        {
            return Blocked(analysis, "入口文件不是有效文本，无法安全分析");
        }
        catch (UriFormatException)
        {
            return Blocked(analysis, "ZIP 中包含无效的资源地址，无法安全分析");
        }
    }

    private static OptimizedBuild Blocked(HostedSiteOptimizationAnalysis analysis, string error)
    {
        analysis.Blocked = true;
        analysis.Error = error;
        return new OptimizedBuild { Analysis = analysis };
    }

    private static void AddVendorFile(
        string sourcePath,
        string outputPath,
        IReadOnlyDictionary<string, ArchiveFile> byPath,
        IDictionary<string, byte[]> output,
        Queue<(string SourcePath, string OutputPath)> pendingStyles)
    {
        if (output.ContainsKey(outputPath) || !byPath.TryGetValue(sourcePath, out var source)) return;
        output[outputPath] = ReadEntry(source.Entry);
        if (outputPath.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
            pendingStyles.Enqueue((sourcePath, outputPath));
    }

    private static void AddPackageLicense(
        string packageName,
        IReadOnlyDictionary<string, ArchiveFile> byPath,
        IDictionary<string, byte[]> output,
        Queue<(string SourcePath, string OutputPath)> pendingStyles)
    {
        foreach (var candidate in new[] { "LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md" })
        {
            var source = $"node_modules/{packageName}/{candidate}";
            if (!byPath.ContainsKey(source)) continue;
            AddVendorFile(source, $"vendor/{packageName}/{candidate}", byPath, output, pendingStyles);
            return;
        }
    }

    private static List<string> FindMissingRuntimeReferences(IReadOnlyDictionary<string, byte[]> output)
    {
        var missing = new List<string>();
        foreach (var (owner, bytes) in output)
        {
            var extension = Path.GetExtension(owner).ToLowerInvariant();
            Regex? referenceRegex = extension switch
            {
                ".html" or ".htm" => HtmlReferenceRegex(),
                ".css" => CssReferenceRegex(),
                ".js" or ".mjs" => JavaScriptImportRegex(),
                _ => null,
            };
            if (referenceRegex == null) continue;

            var text = Encoding.UTF8.GetString(bytes);
            foreach (Match match in referenceRegex.Matches(text))
            {
                var value = match.Groups["path"].Value.Trim().Trim('"', '\'');
                if (IsIgnoredReference(value) || IsExternalReference(value)) continue;
                if (extension is ".js" or ".mjs"
                    && !value.StartsWith('.') && !value.StartsWith('/'))
                    continue;
                var resolved = ResolveReference(owner, value);
                if (resolved != null && !output.ContainsKey(resolved)) missing.Add(resolved);
            }
        }
        return missing.Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToList();
    }

    private static byte[] ReadEntry(ZipArchiveEntry entry)
    {
        using var source = entry.Open();
        using var output = new MemoryStream(entry.Length > int.MaxValue ? 0 : (int)entry.Length);
        source.CopyTo(output);
        if (output.Length > MaxUncompressedBytes)
            throw new InvalidDataException("entry too large");
        return output.ToArray();
    }

    private static string? DetectRootPrefix(IEnumerable<ZipArchiveEntry> entries)
    {
        string? prefix = null;
        foreach (var entry in entries.Where(x => !string.IsNullOrEmpty(x.Name)))
        {
            var name = NormalizePath(entry.FullName);
            var slash = name.IndexOf('/');
            if (slash < 0) return null;
            var current = name[..(slash + 1)];
            if (prefix == null) prefix = current;
            else if (!string.Equals(prefix, current, StringComparison.Ordinal)) return null;
        }
        return prefix;
    }

    private static string StripRoot(string path, string? prefix)
        => !string.IsNullOrEmpty(prefix) && path.StartsWith(prefix, StringComparison.Ordinal)
            ? path[prefix.Length..]
            : path;

    private static string? SelectEntry(IEnumerable<string> paths)
    {
        var list = paths.OrderBy(x => x, StringComparer.Ordinal).ToList();
        return list.FirstOrDefault(x => x.Equals("index.html", StringComparison.OrdinalIgnoreCase))
               ?? list.FirstOrDefault(x => x.Equals("index.htm", StringComparison.OrdinalIgnoreCase))
               ?? list.FirstOrDefault(x => Path.GetFileName(x).Equals("index.html", StringComparison.OrdinalIgnoreCase))
               ?? list.FirstOrDefault(x => x.EndsWith(".html", StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsNodeModules(string path)
        => path.Split('/').Any(x => x.Equals("node_modules", StringComparison.OrdinalIgnoreCase));

    private static bool IsDevelopmentFile(string path)
    {
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Any(DevelopmentDirectoryNames.Contains)
               || DevelopmentFileNames.Contains(parts.LastOrDefault() ?? string.Empty)
               || path.EndsWith(".map", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsScannedRuntimeText(string path)
        => Path.GetExtension(path).ToLowerInvariant() is ".html" or ".htm" or ".css" or ".js" or ".mjs";

    private static bool IsUnsafePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Contains('\0') || path.StartsWith('/')) return true;
        if (path.Length >= 3 && char.IsLetter(path[0]) && path[1] == ':' && path[2] == '/') return true;
        return path.Split('/').Any(x => x == "..");
    }

    private static string NormalizePath(string path) => path.Replace('\\', '/');

    private static string? GetPackageRoot(string path, string marker)
    {
        if (!path.StartsWith(marker, StringComparison.Ordinal)) return null;
        var remainder = path[marker.Length..];
        var segments = remainder.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0) return null;
        var packageSegments = segments[0].StartsWith('@') ? 2 : 1;
        if (segments.Length < packageSegments) return null;
        return marker + string.Join('/', segments.Take(packageSegments));
    }

    private static string? ResolveReference(string owner, string value)
    {
        var path = value.Split('?', '#')[0].Trim();
        if (string.IsNullOrWhiteSpace(path)) return null;
        path = Uri.UnescapeDataString(path).Replace('\\', '/');
        var parts = new List<string>();
        if (!path.StartsWith('/'))
            parts.AddRange(owner.Split('/').SkipLast(1));
        foreach (var part in path.TrimStart('/').Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (part == ".") continue;
            if (part == "..")
            {
                if (parts.Count == 0) return null;
                parts.RemoveAt(parts.Count - 1);
            }
            else parts.Add(part);
        }
        return string.Join('/', parts);
    }

    private static string RelativeReference(string owner, string target)
    {
        var ownerSegments = owner.Split('/').SkipLast(1).ToArray();
        var targetSegments = target.Split('/');
        var common = 0;
        while (common < ownerSegments.Length && common < targetSegments.Length
               && ownerSegments[common] == targetSegments[common]) common++;
        var segments = Enumerable.Repeat("..", ownerSegments.Length - common)
            .Concat(targetSegments.Skip(common));
        var relative = string.Join('/', segments);
        return relative.StartsWith('.') ? relative : $"./{relative}";
    }

    private static bool IsExternalReference(string value)
        => value.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("//", StringComparison.Ordinal);

    private static bool IsIgnoredReference(string value)
        => string.IsNullOrWhiteSpace(value)
           || value.StartsWith('#')
           || value.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("tel:", StringComparison.OrdinalIgnoreCase);

    private static string MimeFor(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" or ".htm" => "text/html",
        ".css" => "text/css",
        ".js" or ".mjs" => "application/javascript",
        ".json" => "application/json",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        ".ttf" => "font/ttf",
        ".otf" => "font/otf",
        _ => "application/octet-stream",
    };

    [GeneratedRegex("https?://(?:unpkg\\.com/|cdn\\.jsdelivr\\.net/npm/)(?<package>@?[^@/\\s\\\"']+(?:/[^@/\\s\\\"']+)?)(?:@[^/\\s\\\"']+)?/(?<path>[^?#\\s\\\"']+)", RegexOptions.IgnoreCase)]
    private static partial Regex ExternalPackageUrlRegex();

    [GeneratedRegex("https?://[^\\s\\\"'<>]+", RegexOptions.IgnoreCase)]
    private static partial Regex ExternalUrlRegex();

    [GeneratedRegex("<(?:script|link|img|source|video|audio|iframe)\\b[^>]*?(?:src|href|poster)\\s*=\\s*[\\\"'](?<path>[^\\\"']+)[\\\"']", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex HtmlReferenceRegex();

    [GeneratedRegex("(?:url\\(\\s*|@import\\s+)[\\\"']?(?<path>[^\\)\\\"']+)", RegexOptions.IgnoreCase)]
    private static partial Regex CssReferenceRegex();

    [GeneratedRegex("(?:from\\s+|import\\s*(?:\\(\\s*)?|require\\s*\\(\\s*)[\\\"'](?<path>[^\\\"']+)[\\\"']", RegexOptions.IgnoreCase)]
    private static partial Regex JavaScriptImportRegex();
}
