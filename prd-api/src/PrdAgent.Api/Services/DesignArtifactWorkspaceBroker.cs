using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

public sealed record PreparedDesignArtifactWorkspace(
    string InputPackageUrl,
    string InputSha256,
    string ResultCommitUrl,
    string TransferToken,
    string ModelBaseUrl,
    string ModelToken,
    string Model,
    string BaseRevision,
    long MaxInputBytes,
    long MaxOutputBytes,
    IReadOnlyList<string> AllowedOutputPaths);

public sealed record DesignArtifactResultCommit(
    string ResultSha256,
    IReadOnlyList<string> Files,
    bool Idempotent);

public interface IDesignArtifactWorkspaceBroker
{
    Task<PreparedDesignArtifactWorkspace> PrepareAsync(
        DesignArtifactRun run,
        string? currentHtml,
        CancellationToken ct);

    Task<byte[]> ReadInputPackageAsync(string runId, string token, CancellationToken ct);

    Task<DesignArtifactResultCommit> CommitResultAsync(
        string runId,
        string token,
        byte[] packageBytes,
        CancellationToken ct);

    Task<string> ReadResultHtmlAsync(string runId, CancellationToken ct);

    Task<ParsedDesignWorkspaceResult> ReadResultAsync(string runId, CancellationToken ct);

    Task<DesignArtifactRun> ReserveModelCallAsync(string runId, string token, CancellationToken ct);

    Task<DesignArtifactRun> ValidateModelTicketAsync(string runId, string token, CancellationToken ct);
}

public sealed class DesignArtifactWorkspaceBroker : IDesignArtifactWorkspaceBroker
{
    public const string SchemaVersion = "map-design-workspace-v1";
    public const string ManifestSchemaVersion = "map-design-artifact-public-manifest-v2";
    public const long MaxInputBytes = 1_048_576;
    public const long MaxOutputBytes = 6_291_456;
    private static readonly TimeSpan TicketTtl = TimeSpan.FromMinutes(25);
    internal static string CurrentProcessEpoch { get; } = $"{Environment.ProcessId}:{Guid.NewGuid():N}";
    private static readonly string[] AllowedOutputPaths = ["index.html", "manifest.json", "assets/**"];
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly IDataProtector _protector;
    private readonly IConfiguration _configuration;
    private readonly IHostedSiteService? _sites;
    private readonly IDesignKnowledgeSnapshotResolver? _knowledge;
    // CDS parseWorkspacePackage accepts at most 512 input files, not the 1024 workspace total.
    internal const int MaxInputFileCount = 512;

    internal static Task<StoredAsset> SaveWorkspaceMetadataAsync(
        IAssetStorage storage,
        byte[] bytes,
        string fileName,
        CancellationToken ct) => storage.SaveAsync(
            bytes,
            "application/json",
            ct,
            domain: AppDomainPaths.DomainWebHosting,
            type: AppDomainPaths.TypeMeta,
            fileName: fileName,
            extensionHint: ".json");

    public DesignArtifactWorkspaceBroker(
        MongoDbContext db,
        IAssetStorage storage,
        IDataProtectionProvider dataProtectionProvider,
        IConfiguration configuration,
        IHostedSiteService? sites = null,
        IDesignKnowledgeSnapshotResolver? knowledge = null)
    {
        _db = db;
        _storage = storage;
        _protector = dataProtectionProvider.CreateProtector("DesignArtifactWorkspaceBroker.v1");
        _configuration = configuration;
        _sites = sites;
        _knowledge = knowledge;
    }

    public async Task<PreparedDesignArtifactWorkspace> PrepareAsync(
        DesignArtifactRun run,
        string? currentHtml,
        CancellationToken ct)
    {
        var publicBaseUrl = ResolvePublicBaseUrl(_configuration)
            ?? throw new InvalidOperationException("远程设计入口尚未配置，请先补齐当前 CDS 预览地址后重试");
        var expiresAt = DateTime.UtcNow.Add(TicketTtl);
        var currentFiles = await ReadCurrentFilesAsync(run, currentHtml, ct);
        IReadOnlyList<DesignWorkspaceFile>? originals = null;
        if (run.KnowledgeOriginals != null)
        {
            if (_knowledge == null)
                throw new InvalidOperationException("知识原件读取服务不可用，请联系管理员后重试");
            originals = await _knowledge.ReadWorkspaceOriginalsAsync(run.UserId, run.KnowledgeReferences, run.KnowledgeOriginals, ct);
        }
        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, currentHtml, currentFiles, originals);
        var bytes = DesignArtifactWorkspaceContract.ValidateInputPackageSize(package, MaxInputBytes);
        var inputSha256 = Sha256Hex(bytes);
        var inputAssetKey = _storage.TryBuildContentAddressedKey(
            bytes,
            "application/json",
            domain: AppDomainPaths.DomainWebHosting,
            type: AppDomainPaths.TypeMeta,
            fileName: $"{run.Id}.json",
            extensionHint: ".json")
            ?? throw new InvalidOperationException("当前对象存储无法预演远程设计输入路径，请联系管理员检查存储配置");

        var updatedAt = DateTime.UtcNow;
        if (!await PersistPreparedWorkspaceAsync(
                _db,
                run.Id,
                run.LeaseOwnerId,
                inputAssetKey,
                inputSha256,
                package.BaseRevision,
                expiresAt,
                updatedAt,
                CancellationToken.None))
            throw new DesignArtifactRunLeaseLostException(run.Id);

        // 先把精确内容寻址 key 通过租约 CAS 记入 Run，再写对象。
        // CAS 失败时尚未产生对象；保存响应丢失时对象仍有精确 Run 引用，不会成为无主对象。
        var stored = await SaveWorkspaceMetadataAsync(
            _storage,
            bytes,
            $"{run.Id}.json",
            CancellationToken.None);
        if (string.IsNullOrWhiteSpace(stored.Key)
            || !string.Equals(stored.Key, inputAssetKey, StringComparison.Ordinal)
            || !FixedEquals(stored.Sha256, inputSha256))
            throw new InvalidOperationException("远程工作区输入保存结果与预演不一致，请联系管理员检查存储配置");

        // 本地快照只供后续生成凭证和构造返回值；持久化使用部分 Update，禁止覆盖并发心跳。
        run.WorkspaceInputAssetKey = inputAssetKey;
        run.WorkspaceInputSha256 = inputSha256;
        run.WorkspaceBaseRevision = package.BaseRevision;
        run.WorkspaceResultAssetKey = null;
        run.WorkspaceResultSha256 = null;
        run.WorkspaceManifestSha256 = null;
        run.WorkspacePendingResultAssetKey = null;
        run.WorkspacePendingResultAttemptId = null;
        run.WorkspacePendingResultWriteState = null;
        run.WorkspacePendingResultProcessEpoch = null;
        run.WorkspacePendingResultStartedAt = null;
        run.WorkspacePendingResultWriteError = null;
        run.WorkspaceRejectedResultAssetKey = null;
        run.WorkspaceRejectedResultCleanupAttemptedAt = null;
        run.WorkspaceRejectedResultCleanupError = null;
        run.RuntimeModelCallCount = 0;
        run.RuntimeTicketExpiresAt = expiresAt;
        run.UpdatedAt = updatedAt;

        var transferToken = ProtectTicket(run, "workspace", expiresAt);
        var modelToken = ProtectTicket(run, "model", expiresAt);
        var runtimeRoot = $"{publicBaseUrl}/api/design-artifacts/runtime/{Uri.EscapeDataString(run.Id)}";
        return new PreparedDesignArtifactWorkspace(
            $"{runtimeRoot}/workspace/input",
            inputSha256,
            $"{runtimeRoot}/workspace/result",
            transferToken,
            $"{runtimeRoot}/llm/v1",
            modelToken,
            "map-managed",
            package.BaseRevision,
            MaxInputBytes,
            MaxOutputBytes,
            AllowedOutputPaths);
    }

    private async Task<IReadOnlyList<DesignWorkspaceFile>?> ReadCurrentFilesAsync(
        DesignArtifactRun run, string? currentHtml, CancellationToken ct)
    {
        if (run.Operation != DesignArtifactOperations.Edit) return null;
        if (_sites == null || string.IsNullOrWhiteSpace(run.TargetSiteId))
            throw new InvalidOperationException("当前站点工作区读取服务不可用，请联系管理员后重试");

        // This service owns edit authorization (including team/group roles), wrapper
        // restrictions and entry decoding. Never fetch caller-supplied public URLs.
        var before = await ReadAuthorizedCurrentEntryAsync(run, ct);
        var entryHtml = DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(before.Html);
        if (string.IsNullOrWhiteSpace(currentHtml)
            || !string.Equals(entryHtml, DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(currentHtml), StringComparison.Ordinal)
            || (!string.IsNullOrEmpty(run.VersionBoundary?.BaseContentHash)
                && !FixedEquals(run.VersionBoundary.BaseContentHash, Sha256Hex(Encoding.UTF8.GetBytes(entryHtml)))))
            throw CurrentVersionChanged();

        var sourceFiles = before.Site.Files;
        if (sourceFiles == null || sourceFiles.Count == 0
            || (long)sourceFiles.Count + run.KnowledgeReferences.Count + 1 > MaxInputFileCount)
            throw new InvalidOperationException("站点文件清单为空或文件过多，请精简后重试");
        // The current runtime's canonical edit entry is index.html. Preserve legacy
        // single-file .htm/non-index behavior, but do not silently relocate a multi-file entry.
        if (sourceFiles.Count > 1 && before.Site.EntryFile != "index.html")
            throw new InvalidOperationException("多文件编辑目前需要根目录 index.html 入口，请调整站点入口后重试");
        ValidateCurrentFileManifest(sourceFiles);
        var beforeFingerprint = CurrentSiteFingerprint(before);
        var files = new List<DesignWorkspaceFile>();
        long totalBytes = 0;
        foreach (var source in sourceFiles.OrderBy(x => x.Path, StringComparer.Ordinal))
        {
            ct.ThrowIfCancellationRequested();
            var bytes = await ReadCurrentAssetAsync(source.CosKey, ct)
                ?? throw new InvalidOperationException("站点资源缺失，无法准备完整工作区，请重新上传或重试");
            if (bytes.LongLength != source.Size || bytes.LongLength > MaxInputBytes - totalBytes)
                throw new InvalidOperationException("站点资源大小不一致或超过工作区上限，请重新上传或精简后重试");
            totalBytes += bytes.LongLength;
            var isEntry = string.Equals(source.Path, before.Site.EntryFile, StringComparison.OrdinalIgnoreCase);
            if (isEntry)
            {
                var decoded = bytes.AsSpan().StartsWith(new byte[] { 0xEF, 0xBB, 0xBF })
                    ? Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3) : Encoding.UTF8.GetString(bytes);
                if (!string.Equals(decoded, before.Html, StringComparison.Ordinal)) throw CurrentVersionChanged();
                // Keep the existing trusted system-envelope normalization, not a new hardening profile.
                bytes = Encoding.UTF8.GetBytes(entryHtml);
            }
            files.Add(new DesignWorkspaceFile("current/" + (isEntry ? "index.html" : source.Path),
                Convert.ToBase64String(bytes), Sha256Hex(bytes), bytes.LongLength, source.MimeType));
        }

        // Reauthorize and compare the complete server manifest, not only HTML/version.
        // Published objects use immutable version keys; a concurrent pointer switch, removal
        // or permission revocation must fail before the Run CAS and input upload.
        var after = await ReadAuthorizedCurrentEntryAsync(run, ct);
        if (beforeFingerprint != CurrentSiteFingerprint(after)
            || !string.Equals(before.Html, after.Html, StringComparison.Ordinal))
            throw CurrentVersionChanged();
        return files;
    }

    private async Task<HostedSiteEditableEntry> ReadAuthorizedCurrentEntryAsync(DesignArtifactRun run, CancellationToken ct)
    {
        try { return await _sites!.GetEditableEntryHtmlAsync(run.TargetSiteId!, run.UserId, ct); }
        catch (KeyNotFoundException) { throw new KeyNotFoundException("站点不存在或当前无编辑权限"); }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // Storage SDK exceptions can contain physical keys or signed URLs.
            throw new InvalidOperationException("站点入口读取失败，请确认站点可编辑并重新上传或重试");
        }
    }

    private async Task<byte[]?> ReadCurrentAssetAsync(string key, CancellationToken ct)
    {
        try { return await _storage.TryDownloadBytesAsync(key, ct); }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            throw new InvalidOperationException("站点资源读取失败，请重新上传或稍后重试");
        }
    }

    private static void ValidateCurrentFileManifest(IReadOnlyList<HostedSiteFile> files)
    {
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long totalBytes = 0;
        foreach (var file in files)
        {
            if (!DesignArtifactPublicPath.TryNormalize(file.Path, out var normalized)
                || !DesignArtifactPublicPath.TryNormalize("current/" + normalized, out _)
                || !paths.Add(normalized)
                || !DesignArtifactPublicPath.TryNormalize(file.CosKey, out _)
                || !System.Net.Http.Headers.MediaTypeHeaderValue.TryParse(file.MimeType, out _))
                throw new InvalidOperationException("站点文件路径或类型无效、存在冲突，请重新上传后重试");
            if (file.Size < 0 || file.Size > MaxInputBytes - totalBytes)
                throw new InvalidOperationException("站点资源超过工作区上限，请精简后重试");
            totalBytes += file.Size;
        }
        foreach (var filePath in paths)
        {
            for (var separator = filePath.IndexOf('/'); separator >= 0; separator = filePath.IndexOf('/', separator + 1))
                if (paths.Contains(filePath[..separator]))
                    throw new InvalidOperationException("站点文件与目录路径冲突，请重新上传后重试");
        }
    }

    private static string CurrentSiteFingerprint(HostedSiteEditableEntry entry) => Sha256Hex(
        JsonSerializer.SerializeToUtf8Bytes(new
        {
            entry.Site.Id, entry.ContentVersion, entry.Site.PublishedRevisionId, entry.Site.EntryFile,
            files = entry.Site.Files.OrderBy(x => x.Path, StringComparer.Ordinal)
                .Select(x => new { x.Path, x.CosKey, x.Size, x.MimeType }),
        }, DesignArtifactWorkspaceContract.JsonOptions));

    private static InvalidOperationException CurrentVersionChanged() =>
        new("站点版本或资源已变化，请刷新页面后重新发起修改");

    public async Task<byte[]> ReadInputPackageAsync(string runId, string token, CancellationToken ct)
    {
        ValidateTicket(token, runId, "workspace");
        var run = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId)).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        EnsureActiveWorkspaceWindow(run);
        if (string.IsNullOrWhiteSpace(run.WorkspaceInputAssetKey))
            throw new InvalidOperationException("设计任务输入尚未准备完成，请稍后重试");
        var bytes = await _storage.TryDownloadBytesAsync(run.WorkspaceInputAssetKey, CancellationToken.None)
            ?? throw new InvalidOperationException("设计任务输入暂时无法读取，请稍后重试");
        if (bytes.LongLength > MaxInputBytes
            || !FixedEquals(run.WorkspaceInputSha256, Sha256Hex(bytes)))
            throw new InvalidOperationException("设计任务输入校验失败，请重新发起任务");
        return bytes;
    }

    public async Task<DesignArtifactResultCommit> CommitResultAsync(
        string runId,
        string token,
        byte[] packageBytes,
        CancellationToken ct)
    {
        ValidateTicket(token, runId, "workspace");
        if (packageBytes.LongLength == 0 || packageBytes.LongLength > MaxOutputBytes)
            throw new InvalidOperationException("远程设计结果大小不符合要求，请重新生成");
        var run = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId)).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        EnsureActiveWorkspaceWindow(run);
        var parsed = DesignArtifactWorkspaceContract.ParseAndValidateResult(
            packageBytes,
            runId,
            run.WorkspaceBaseRevision ?? string.Empty,
            MaxOutputBytes);
        var packageSha = Sha256Hex(packageBytes);
        var manifestSha = parsed.Files.Single(file => file.Path == "manifest.json").Sha256;
        if (!string.IsNullOrWhiteSpace(run.WorkspaceResultAssetKey))
        {
            if (FixedEquals(run.WorkspaceResultSha256, packageSha))
                return new DesignArtifactResultCommit(packageSha, parsed.Files.Select(file => file.Path).ToArray(), true);
            throw new InvalidOperationException("该工作区已经提交过不同结果，请重新发起任务");
        }

        // 精确物理 key 与 attempt 围栏必须先于 SaveAsync 持久化。这样即使进程在对象写入成功后、
        // 终态 CAS 前退出，恢复器仍能定位唯一对象；同一 Run 的并发请求也不能共享无主占位。
        var now = DateTime.UtcNow;
        var attemptId = Guid.NewGuid().ToString("N");
        var pendingKey = _storage.TryBuildContentAddressedKey(
            packageBytes,
            "application/json",
            domain: AppDomainPaths.DomainWebHosting,
            type: AppDomainPaths.TypeMeta,
            fileName: $"{run.Id}.json",
            extensionHint: ".json");
        if (string.IsNullOrWhiteSpace(pendingKey))
            throw new InvalidOperationException("当前对象存储无法预演远程设计结果路径，请联系管理员检查存储配置");
        var activeFilter = BuildActiveWorkspaceFilter(runId, run.LeaseOwnerId, now);
        var reservation = await _db.DesignArtifactRuns.UpdateOneAsync(
            Builders<DesignArtifactRun>.Filter.Eq(item => item.DeploymentSlug, DeploymentScope.Current) & (Builders<DesignArtifactRun>.Filter.And(
                activeFilter,
                Builders<DesignArtifactRun>.Filter.Eq(item => item.WorkspaceResultAssetKey, null),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.WorkspacePendingResultAssetKey, null),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.WorkspaceRejectedResultAssetKey, null),
                Builders<DesignArtifactRun>.Filter.Or(
                    Builders<DesignArtifactRun>.Filter.Eq(item => item.WorkspaceResultSha256, null),
                    Builders<DesignArtifactRun>.Filter.Eq(item => item.WorkspaceResultSha256, packageSha)))),
            Builders<DesignArtifactRun>.Update
                .Set(item => item.WorkspaceResultSha256, packageSha)
                .Set(item => item.WorkspaceManifestSha256, manifestSha)
                .Set(item => item.WorkspacePendingResultAssetKey, pendingKey)
                .Set(item => item.WorkspacePendingResultAttemptId, attemptId)
                .Set(item => item.WorkspacePendingResultWriteState, DesignWorkspaceResultWriteStates.Writing)
                .Set(item => item.WorkspacePendingResultProcessEpoch, CurrentProcessEpoch)
                .Set(item => item.WorkspacePendingResultStartedAt, now)
                .Set(item => item.WorkspacePendingResultWriteError, null)
                .Set(item => item.UpdatedAt, now),
            cancellationToken: CancellationToken.None);
        if (reservation.MatchedCount == 0)
        {
            var winner = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId))
                .FirstOrDefaultAsync(CancellationToken.None);
            if (winner != null
                && winner.Status == RunStatuses.Running
                && winner.LeaseOwnerId == run.LeaseOwnerId
                && winner.LeaseExpiresAt > now
                && winner.RuntimeTicketExpiresAt > now
                && !string.IsNullOrWhiteSpace(winner.WorkspaceResultAssetKey)
                && FixedEquals(winner.WorkspaceResultSha256, packageSha))
                return new DesignArtifactResultCommit(packageSha, parsed.Files.Select(file => file.Path).ToArray(), true);
            throw new InvalidOperationException("该工作区已经提交过不同结果，请重新发起任务");
        }

        StoredAsset stored;
        try
        {
            stored = await SaveWorkspaceMetadataAsync(
                _storage,
                packageBytes,
                $"{run.Id}.json",
                CancellationToken.None);
            if (string.IsNullOrWhiteSpace(stored.Key)
                || !string.Equals(stored.Key, pendingKey, StringComparison.Ordinal))
                throw new InvalidOperationException("远程设计结果保存路径与预演不一致，请联系管理员检查存储配置");
        }
        catch (Exception saveError)
        {
            var failedAt = DateTime.UtcNow;
            await _db.DesignArtifactRuns.UpdateOneAsync(
                item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId
                        && item.WorkspaceResultAssetKey == null
                        && item.WorkspaceResultSha256 == packageSha
                        && item.WorkspacePendingResultAssetKey == pendingKey
                        && item.WorkspacePendingResultAttemptId == attemptId),
                Builders<DesignArtifactRun>.Update
                    .Set(item => item.WorkspacePendingResultWriteState, DesignWorkspaceResultWriteStates.SaveFailed)
                    .Set(item => item.WorkspacePendingResultWriteError, BoundedCleanupError(saveError))
                    .Set(item => item.UpdatedAt, failedAt),
                cancellationToken: CancellationToken.None);
            var failed = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId))
                .FirstOrDefaultAsync(CancellationToken.None);
            if (failed != null)
                await RecoverPendingWorkspaceResultAsync(_db, _storage, failed, failedAt, CancellationToken.None);
            throw;
        }

        // 单独落下 stored 状态，让恢复器能够区分“上传可能仍在进行”与“对象已确认可见”。
        // 即便进程在本次更新前退出，writing 状态也已经携带精确 key，租约失效后仍可查存在性并回收。
        var storedAt = DateTime.UtcNow;
        await _db.DesignArtifactRuns.UpdateOneAsync(
            item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId
                    && item.WorkspaceResultAssetKey == null
                    && item.WorkspaceResultSha256 == packageSha
                    && item.WorkspacePendingResultAssetKey == pendingKey
                    && item.WorkspacePendingResultAttemptId == attemptId),
            Builders<DesignArtifactRun>.Update
                .Set(item => item.WorkspacePendingResultWriteState, DesignWorkspaceResultWriteStates.Stored)
                .Set(item => item.WorkspacePendingResultWriteError, null)
                .Set(item => item.UpdatedAt, storedAt),
            cancellationToken: CancellationToken.None);

        var completedAt = DateTime.UtcNow;
        var update = Builders<DesignArtifactRun>.Update
            .Set(item => item.WorkspaceResultAssetKey, pendingKey)
            .Set(item => item.WorkspacePendingResultAssetKey, null)
            .Set(item => item.WorkspacePendingResultAttemptId, null)
            .Set(item => item.WorkspacePendingResultWriteState, null)
            .Set(item => item.WorkspacePendingResultProcessEpoch, null)
            .Set(item => item.WorkspacePendingResultStartedAt, null)
            .Set(item => item.WorkspacePendingResultWriteError, null)
            .Set(item => item.WorkspaceRejectedResultAssetKey, null)
            .Set(item => item.WorkspaceRejectedResultCleanupAttemptedAt, null)
            .Set(item => item.WorkspaceRejectedResultCleanupError, null)
            .Set(item => item.UpdatedAt, completedAt);
        var write = await _db.DesignArtifactRuns.UpdateOneAsync(
            Builders<DesignArtifactRun>.Filter.Eq(item => item.DeploymentSlug, DeploymentScope.Current) & (Builders<DesignArtifactRun>.Filter.And(
                BuildActiveWorkspaceFilter(runId, run.LeaseOwnerId, completedAt),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.WorkspaceResultAssetKey, null),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.WorkspaceResultSha256, packageSha),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.WorkspacePendingResultAssetKey, pendingKey),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.WorkspacePendingResultAttemptId, attemptId),
                Builders<DesignArtifactRun>.Filter.Eq(
                    item => item.WorkspacePendingResultWriteState,
                    DesignWorkspaceResultWriteStates.Stored))),
            update,
            cancellationToken: CancellationToken.None);
        if (write.ModifiedCount == 0)
        {
            var winner = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId)).FirstOrDefaultAsync(CancellationToken.None);
            if (winner != null
                && !string.IsNullOrWhiteSpace(winner.WorkspaceResultAssetKey)
                && string.Equals(winner.WorkspaceResultAssetKey, pendingKey, StringComparison.Ordinal)
                && FixedEquals(winner.WorkspaceResultSha256, packageSha))
            {
                if (HasActiveWorkspaceWindow(winner, run.LeaseOwnerId, completedAt))
                    return new DesignArtifactResultCommit(packageSha, parsed.Files.Select(file => file.Path).ToArray(), true);
                throw new UnauthorizedAccessException("远程设计凭证对应的任务已结束，请重新发起任务");
            }

            if (winner != null)
                await RecoverPendingWorkspaceResultAsync(
                    _db,
                    _storage,
                    winner,
                    DateTime.UtcNow,
                    CancellationToken.None,
                    throwOnCleanupFailure: true);

            if (winner == null || !HasActiveWorkspaceWindow(winner, run.LeaseOwnerId, completedAt))
                throw new UnauthorizedAccessException("远程设计凭证对应的任务已结束，请重新发起任务");
            throw new InvalidOperationException("远程设计结果提交冲突，请重试");
        }
        return new DesignArtifactResultCommit(packageSha, parsed.Files.Select(file => file.Path).ToArray(), false);
    }

    public async Task<string> ReadResultHtmlAsync(string runId, CancellationToken ct)
        => (await ReadResultAsync(runId, ct)).IndexHtml;

    public async Task<ParsedDesignWorkspaceResult> ReadResultAsync(string runId, CancellationToken ct)
    {
        var run = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId)).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        if (string.IsNullOrWhiteSpace(run.WorkspaceResultAssetKey))
            throw new InvalidOperationException("远程设计任务没有提交可用页面，请重试");
        var bytes = await _storage.TryDownloadBytesAsync(run.WorkspaceResultAssetKey, CancellationToken.None)
            ?? throw new InvalidOperationException("远程设计结果暂时无法读取，请稍后重试");
        if (!FixedEquals(run.WorkspaceResultSha256, Sha256Hex(bytes)))
            throw new InvalidOperationException("远程设计结果校验失败，请重新发起任务");
        var parsed = DesignArtifactWorkspaceContract.ParseAndValidateResult(
                bytes,
                runId,
                run.WorkspaceBaseRevision ?? string.Empty,
                MaxOutputBytes);
        return parsed with
        {
            IndexHtml = HostedSiteRevisionRules.StripSingleTrustedSystemCspEnvelope(parsed.IndexHtml),
        };
    }

    public async Task<DesignArtifactRun> ReserveModelCallAsync(string runId, string token, CancellationToken ct)
    {
        ValidateTicket(token, runId, "model");
        var current = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId)).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        EnsureActiveWorkspaceWindow(current);
        var now = DateTime.UtcNow;
        // 只按凭证与任务租约准入；计数用于审计，不再承担额外次数预算门禁。
        var filter = BuildActiveWorkspaceFilter(runId, current.LeaseOwnerId, now);
        var run = await _db.DesignArtifactRuns.FindOneAndUpdateAsync(
            Builders<DesignArtifactRun>.Filter.Eq(item => item.DeploymentSlug, DeploymentScope.Current) & (filter),
            Builders<DesignArtifactRun>.Update
                .Inc(item => item.RuntimeModelCallCount, 1)
                .Set(item => item.UpdatedAt, now),
            new FindOneAndUpdateOptions<DesignArtifactRun> { ReturnDocument = ReturnDocument.After },
            CancellationToken.None);
        return run ?? throw new UnauthorizedAccessException("远程设计凭证对应的任务已结束，请重新发起任务");
    }

    public async Task<DesignArtifactRun> ValidateModelTicketAsync(string runId, string token, CancellationToken ct)
    {
        ValidateTicket(token, runId, "model");
        var run = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId)).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        EnsureActiveWorkspaceWindow(run);
        return run;
    }

    internal static async Task<bool> PersistPreparedWorkspaceAsync(
        MongoDbContext db,
        string runId,
        string? leaseOwner,
        string inputAssetKey,
        string inputSha256,
        string baseRevision,
        DateTime ticketExpiresAt,
        DateTime updatedAt,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(leaseOwner)) return false;
        var write = await db.DesignArtifactRuns.UpdateOneAsync(
            item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId
                    && item.Status == RunStatuses.Running
                    && item.LeaseOwnerId == leaseOwner
                    && item.LeaseExpiresAt > updatedAt
                    && item.WorkspaceInputAssetKey == null),
            Builders<DesignArtifactRun>.Update
                .Set(item => item.WorkspaceInputAssetKey, inputAssetKey)
                .Set(item => item.WorkspaceInputSha256, inputSha256)
                .Set(item => item.WorkspaceBaseRevision, baseRevision)
                .Set(item => item.WorkspaceResultAssetKey, null)
                .Set(item => item.WorkspaceResultSha256, null)
                .Set(item => item.WorkspaceManifestSha256, null)
                .Set(item => item.WorkspacePendingResultAssetKey, null)
                .Set(item => item.WorkspacePendingResultAttemptId, null)
                .Set(item => item.WorkspacePendingResultWriteState, null)
                .Set(item => item.WorkspacePendingResultProcessEpoch, null)
                .Set(item => item.WorkspacePendingResultStartedAt, null)
                .Set(item => item.WorkspacePendingResultWriteError, null)
                .Set(item => item.WorkspaceRejectedResultAssetKey, null)
                .Set(item => item.WorkspaceRejectedResultCleanupAttemptedAt, null)
                .Set(item => item.WorkspaceRejectedResultCleanupError, null)
                .Set(item => item.RuntimeModelCallCount, 0)
                .Set(item => item.RuntimeTicketExpiresAt, ticketExpiresAt)
                .Max(item => item.UpdatedAt, updatedAt),
            cancellationToken: ct);
        return write.ModifiedCount == 1;
    }

    private string ProtectTicket(DesignArtifactRun run, string purpose, DateTime expiresAt) =>
        _protector.Protect(JsonSerializer.Serialize(new RuntimeTicket(
            run.Id,
            run.UserId,
            purpose,
            expiresAt,
            Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant())));

    private void ValidateTicket(string token, string runId, string purpose)
    {
        try
        {
            var payload = JsonSerializer.Deserialize<RuntimeTicket>(_protector.Unprotect(token));
            if (payload == null
                || payload.ExpiresAt <= DateTime.UtcNow
                || !FixedEquals(payload.RunId, runId)
                || !FixedEquals(payload.Purpose, purpose))
                throw new InvalidOperationException();
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException or InvalidOperationException)
        {
            throw new UnauthorizedAccessException("远程设计凭证无效或已过期，请重新发起任务");
        }
    }

    private static void EnsureTicketWindow(DesignArtifactRun run)
    {
        if (run.RuntimeTicketExpiresAt is null || run.RuntimeTicketExpiresAt <= DateTime.UtcNow)
            throw new UnauthorizedAccessException("远程设计凭证已过期，请重新发起任务");
    }

    private static void EnsureActiveWorkspaceWindow(DesignArtifactRun run)
    {
        EnsureTicketWindow(run);
        if (!HasActiveWorkspaceWindow(run, run.LeaseOwnerId, DateTime.UtcNow))
            throw new UnauthorizedAccessException("远程设计凭证对应的任务已结束，请重新发起任务");
    }

    private static bool HasActiveWorkspaceWindow(DesignArtifactRun run, string? leaseOwner, DateTime now) =>
        run.Status == RunStatuses.Running
        && !string.IsNullOrWhiteSpace(leaseOwner)
        && run.LeaseOwnerId == leaseOwner
        && run.LeaseExpiresAt > now
        && run.RuntimeTicketExpiresAt > now;

    internal static FilterDefinition<DesignArtifactRun> BuildActiveWorkspaceFilter(
        string runId,
        string? leaseOwner,
        DateTime now) => Builders<DesignArtifactRun>.Filter.And(
            Builders<DesignArtifactRun>.Filter.Eq(item => item.Id, runId),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.Status, RunStatuses.Running),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.LeaseOwnerId, leaseOwner),
            Builders<DesignArtifactRun>.Filter.Gt(item => item.LeaseExpiresAt, now),
            Builders<DesignArtifactRun>.Filter.Gt(item => item.RuntimeTicketExpiresAt, now));

    internal static async Task<bool> RecoverPendingWorkspaceResultAsync(
        MongoDbContext db,
        IAssetStorage storage,
        DesignArtifactRun candidate,
        DateTime attemptedAt,
        CancellationToken ct,
        bool throwOnCleanupFailure = false,
        string? processEpoch = null)
    {
        var key = candidate.WorkspacePendingResultAssetKey;
        var attemptId = candidate.WorkspacePendingResultAttemptId;
        if (string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(attemptId)) return false;

        var current = await db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == candidate.Id
                                                               && item.WorkspacePendingResultAssetKey == key
                                                               && item.WorkspacePendingResultAttemptId == attemptId))
            .FirstOrDefaultAsync(ct);
        if (current == null) return false;

        // 获胜结果已经引用同一个内容寻址对象时，只移除旧 attempt，绝不能删除对象。
        if (!string.IsNullOrWhiteSpace(current.WorkspaceResultAssetKey))
        {
            if (string.Equals(current.WorkspaceResultAssetKey, key, StringComparison.Ordinal))
                return await ClearPendingWorkspaceResultAsync(db, current, attemptedAt, clearHash: false, ct);
            return false;
        }

        var active = HasActiveWorkspaceWindow(current, current.LeaseOwnerId, attemptedAt);
        if (active
            && !string.Equals(
                current.WorkspacePendingResultWriteState,
                DesignWorkspaceResultWriteStates.SaveFailed,
                StringComparison.Ordinal))
            return false;

        // writing 表示对象存储调用尚未确认返回。同一进程仍可能在完成上传，不能依赖固定时长猜测。
        // 只有新的进程代际才能确认旧写入者已经退出，再按精确 key 接管回收。
        if (string.Equals(
                current.WorkspacePendingResultWriteState,
                DesignWorkspaceResultWriteStates.Writing,
                StringComparison.Ordinal)
            && string.Equals(
                current.WorkspacePendingResultProcessEpoch,
                processEpoch ?? CurrentProcessEpoch,
                StringComparison.Ordinal))
            return false;

        // 对象内容寻址可跨部署复用。引用保护必须覆盖新旧集合，不授予引用方执行或写入资格。
        var referencedByWinner = await db.FindDesignArtifactRunHistoryAsync(
            item => item.WorkspaceResultAssetKey == key, ct);
        if (referencedByWinner != null)
            return await ClearPendingWorkspaceResultAsync(db, current, attemptedAt, clearHash: true, ct);

        // 同内容可能由另一个 Run 同时写入。只要仍有活跃写入，就延后回收，避免删除其即将采用的对象。
        var activeSibling = await db.FindDesignArtifactRunHistoryAsync(item =>
                item.Id != current.Id
                && item.WorkspaceResultAssetKey == null
                && item.WorkspacePendingResultAssetKey == key
                && item.Status == RunStatuses.Running
                && item.LeaseExpiresAt > attemptedAt
                && item.RuntimeTicketExpiresAt > attemptedAt
                && item.WorkspacePendingResultWriteState != DesignWorkspaceResultWriteStates.SaveFailed, ct);
        if (activeSibling != null) return false;

        try
        {
            if (await storage.ExistsAsync(key, CancellationToken.None))
                await storage.DeleteByKeyAsync(key, CancellationToken.None);
        }
        catch (Exception cleanupError)
        {
            await db.DesignArtifactRuns.UpdateOneAsync(
                item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == current.Id
                        && item.WorkspaceResultAssetKey == null
                        && item.WorkspacePendingResultAssetKey == key
                        && item.WorkspacePendingResultAttemptId == attemptId),
                Builders<DesignArtifactRun>.Update
                    .Set(item => item.WorkspaceRejectedResultCleanupAttemptedAt, attemptedAt)
                    .Set(item => item.WorkspaceRejectedResultCleanupError, BoundedCleanupError(cleanupError))
                    .Set(item => item.UpdatedAt, attemptedAt),
                cancellationToken: CancellationToken.None);
            if (throwOnCleanupFailure) throw;
            return false;
        }

        return await ClearPendingWorkspaceResultAsync(db, current, attemptedAt, clearHash: true, ct);
    }

    private static async Task<bool> ClearPendingWorkspaceResultAsync(
        MongoDbContext db,
        DesignArtifactRun current,
        DateTime attemptedAt,
        bool clearHash,
        CancellationToken ct)
    {
        var update = Builders<DesignArtifactRun>.Update
            .Set(item => item.WorkspacePendingResultAssetKey, null)
            .Set(item => item.WorkspacePendingResultAttemptId, null)
            .Set(item => item.WorkspacePendingResultWriteState, null)
            .Set(item => item.WorkspacePendingResultProcessEpoch, null)
            .Set(item => item.WorkspacePendingResultStartedAt, null)
            .Set(item => item.WorkspacePendingResultWriteError, null)
            .Set(item => item.WorkspaceRejectedResultCleanupAttemptedAt, null)
            .Set(item => item.WorkspaceRejectedResultCleanupError, null)
            .Set(item => item.UpdatedAt, attemptedAt);
        if (clearHash)
            update = update
                .Set(item => item.WorkspaceResultSha256, null)
                .Set(item => item.WorkspaceManifestSha256, null);
        var write = await db.DesignArtifactRuns.UpdateOneAsync(
            item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == current.Id
                    && item.WorkspacePendingResultAssetKey == current.WorkspacePendingResultAssetKey
                    && item.WorkspacePendingResultAttemptId == current.WorkspacePendingResultAttemptId
                    && (clearHash
                        ? item.WorkspaceResultAssetKey == null
                        : item.WorkspaceResultAssetKey == current.WorkspaceResultAssetKey)),
            update,
            cancellationToken: ct);
        return write.ModifiedCount == 1;
    }

    private static string BoundedCleanupError(Exception error)
    {
        var message = string.IsNullOrWhiteSpace(error.Message) ? error.GetType().Name : error.Message;
        return message.Length <= 500 ? message : message[..500];
    }

    internal static string? ResolvePublicBaseUrl(IConfiguration configuration)
    {
        foreach (var key in new[]
                 {
                     "DesignArtifactRuntime:PublicBaseUrl",
                     "ServerUrl",
                     "App:FrontendBaseUrl",
                     "CDS_PREVIEW_URL",
                     "PUBLIC_BASE_URL",
                     "APP_PUBLIC_BASE_URL",
                 })
        {
            var value = configuration[key]?.Trim().TrimEnd('/');
            if (Uri.TryCreate(value, UriKind.Absolute, out var uri)
                && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp))
                return value;
        }
        return null;
    }

    private static string Sha256Hex(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static bool FixedEquals(string? left, string? right)
    {
        if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
        var leftBytes = Encoding.UTF8.GetBytes(left);
        var rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length
               && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private sealed record RuntimeTicket(
        string RunId,
        string UserId,
        string Purpose,
        DateTime ExpiresAt,
        string Nonce);
}

public static class DesignArtifactWorkspaceContract
{
    private static readonly Regex ExplicitSingleVisibleTextInsertion = new(
        @"(?:新增|添加|增加|插入|写上|放入|放置)(?:[^“”""「」『』\r\n]{0,48})(?:文案|短句|文字|标记|副?标题|标签|按钮(?:文案|文字)?)(?:[^“”""「」『』\r\n]{0,16})[“""「『](?<text>[^“”""「」『』\r\n]{4,200})[”""」』]",
        RegexOptions.Compiled | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));
    private static readonly Regex MultiPlacementIntent = new(
        @"(?:分别|所有|各自|多处|每(?:个|处|页|张|项|栏|块|段|行|篇|条)|各(?:个|处|页|张|项|栏|块|段|行|篇|条)|重复\s*(?:两|2|多)\s*(?:次|遍))",
        RegexOptions.Compiled | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));
    private static readonly Regex ActionBoundary = new(
        @"(?:[。；;！!？?\r\n]|(?:然后|随后|接着|另外|并且|同时|再))",
        RegexOptions.Compiled | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));
    private static readonly Regex SafeSlug = new("[^a-zA-Z0-9._-]+", RegexOptions.Compiled);
    private static readonly Regex MapSlideNavCompatBlock = new(
        @"<!--map-slide-nav-compat-->\s*<script\b[^>]*>[\s\S]*?</script\s*>",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex MapSlideNavCompatMarker = new(
        @"<!--map-slide-nav-compat-->",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex CdsOfflineGuardBlock = new(
        @"<script\b(?=[^>]*\bdata-cds-offline-guard(?:\s|=|>))[^>]*>[\s\S]*?</script\s*>",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);
    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static DesignWorkspacePackage BuildInputPackage(
        DesignArtifactRun run, string? currentHtml, IReadOnlyList<DesignWorkspaceFile>? currentFiles = null,
        IReadOnlyList<DesignWorkspaceFile>? originalFiles = null)
    {
        var visibleTextOccurrenceConstraints = ExtractVisibleTextOccurrenceConstraints(run.Instruction);
        var factualSources = new List<string>();
        if (run.KnowledgeReferences.Count > 0) factualSources.Add("server-knowledge");
        if (run.Operation == DesignArtifactOperations.Edit && !string.IsNullOrWhiteSpace(currentHtml))
            factualSources.Add("server-current-visible-content");
        var semantic = JsonSerializer.SerializeToUtf8Bytes(new
        {
            run.Id,
            run.ArtifactType,
            run.Operation,
            run.SourceSurface,
            run.Instruction,
            run.InputAuthority,
            run.UserSuppliedContentHash,
            run.Title,
            knowledge = run.KnowledgeReferences.Select(item => new { item.EntryId, item.ContentHash }),
            currentHtmlHash = string.IsNullOrEmpty(currentHtml) ? null : HashText(currentHtml),
        }, JsonOptions);
        // Keep the existing HTML-only revision algorithm for callers without a
        // server file snapshot; complete edits additionally bind every file digest.
        if (currentFiles != null || originalFiles != null)
            semantic = JsonSerializer.SerializeToUtf8Bytes(new
            {
                inputRevision = HashBytes(semantic),
                currentFiles = currentFiles?.Select(file => new { file.Path, file.Sha256, file.Size, file.MediaType }),
                originalFiles = originalFiles?.Select(file => new { file.Path, file.Sha256, file.Size, file.MediaType }),
            }, JsonOptions);
        var baseRevision = Convert.ToHexString(SHA256.HashData(semantic)).ToLowerInvariant();
        var files = new List<DesignWorkspaceFile>();
        var task = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schemaVersion = DesignArtifactWorkspaceBroker.SchemaVersion,
            runId = run.Id,
            run.ArtifactType,
            run.Operation,
            run.SourceSurface,
            input = new
            {
                userSupplied = new
                {
                    instruction = run.Instruction,
                    contentHash = run.UserSuppliedContentHash,
                    authority = DesignArtifactInputAuthorities.UserSupplied,
                },
                serverKnowledge = new
                {
                    authority = "server-authoritative-snapshot",
                    references = run.KnowledgeReferences.Select(item => new
                    {
                        item.EntryId,
                        item.StoreId,
                        item.ContentHash,
                    }),
                },
                currentHtml = string.IsNullOrWhiteSpace(currentHtml)
                    ? (object?)null
                    : new { authority = "server-owned-current-artifact", contentHash = HashText(currentHtml) },
            },
            run.InputAuthority,
            run.Title,
            baseRevision,
            responseContract = new
            {
                requiredFile = "index.html",
                manifestFile = "manifest.json",
                writeback = "external",
            },
            qualityContract = new
            {
                schemaVersion = "map-design-artifact-quality-v1",
                factualSources,
                userSuppliedInputsAreFactualProvenance = false,
                measuredClaimsRequireSource = true,
                sensitiveFactsRequireSource = true,
                contextBoundMetricsReviewRequired = true,
                visibleDraftMarkersAllowed = false,
                emptyOrMissingFragmentTargetsAllowed = false,
                inertEnabledButtonsAllowed = false,
                finalReviewRequired = true,
                visibleTextOccurrenceConstraints,
            },
        }, JsonOptions);
        if (originalFiles != null)
        {
            var completeTask = System.Text.Json.Nodes.JsonNode.Parse(task)!;
            completeTask["input"]!["knowledgeOriginals"] = JsonSerializer.SerializeToNode(new
            {
                authority = "server-owned-knowledge-originals",
                files = originalFiles.Select(file => new { file.Path, file.Sha256, file.Size, file.MediaType }),
            }, JsonOptions);
            task = JsonSerializer.SerializeToUtf8Bytes(completeTask, JsonOptions);
        }
        if (currentFiles != null)
        {
            var completeTask = System.Text.Json.Nodes.JsonNode.Parse(task)!;
            completeTask["input"]!["currentArtifact"] = JsonSerializer.SerializeToNode(new
            {
                authority = "server-owned-current-artifact",
                entryFile = "current/index.html",
                files = currentFiles.Select(file => new { file.Path, file.Sha256, file.Size, file.MediaType }),
            }, JsonOptions);
            task = JsonSerializer.SerializeToUtf8Bytes(completeTask, JsonOptions);
        }
        files.Add(ToFile("brief/task.json", "application/json", task));
        for (var index = 0; index < run.KnowledgeReferences.Count; index++)
        {
            var item = run.KnowledgeReferences[index];
            var slug = SafeSlug.Replace(item.Title.Trim(), "-").Trim('-');
            if (string.IsNullOrWhiteSpace(slug)) slug = item.EntryId;
            slug = slug.Length > 64 ? slug[..64] : slug;
            var markdown = $"# {item.Title}\n\n{item.Content}";
            files.Add(ToFile($"knowledge/{index + 1:D2}-{slug}.md", "text/markdown", Encoding.UTF8.GetBytes(markdown)));
        }
        if (originalFiles != null) files.AddRange(originalFiles);
        if (currentFiles != null)
        {
            files.AddRange(currentFiles);
        }
        else if (!string.IsNullOrWhiteSpace(currentHtml))
        {
            var editableHtml = NormalizeCurrentHtmlForRemoteEditing(currentHtml);
            files.Add(ToFile("current/index.html", "text/html", Encoding.UTF8.GetBytes(editableHtml)));
        }
        return new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            baseRevision,
            files);
    }

    internal static IReadOnlyList<DesignVisibleTextOccurrenceConstraint> ExtractVisibleTextOccurrenceConstraints(
        string instruction)
    {
        if (string.IsNullOrWhiteSpace(instruction))
            return [];

        var constraints = new List<DesignVisibleTextOccurrenceConstraint>();
        foreach (Match match in ExplicitSingleVisibleTextInsertion.Matches(instruction))
        {
            var actionStart = 0;
            foreach (Match boundary in ActionBoundary.Matches(instruction[..match.Index]))
                actionStart = boundary.Index + boundary.Length;
            var actionEnd = match.Groups["text"].Index;
            if (MultiPlacementIntent.IsMatch(instruction[actionStart..actionEnd]))
                continue;

            var text = Regex.Replace(match.Groups["text"].Value.Trim(), @"\s+", " ");
            if (constraints.Any(item => string.Equals(item.Text, text, StringComparison.Ordinal)))
                continue;
            constraints.Add(new DesignVisibleTextOccurrenceConstraint(text, 1, 1));
            if (constraints.Count >= 12)
                break;
        }
        return constraints;
    }

    internal static string NormalizeCurrentHtmlForRemoteEditing(string html)
    {
        // 网页托管会给已发布页面追加 MAP 翻页兼容垫片，CDS 也会给远程产物追加离线守卫与 CSP。
        // 它们属于交付包装，不属于用户页面源码；编辑工作区先剥离明确带内部标记的包装，回收时再统一加固。
        // 任意未带这些标记的脚本均保持原样，仍会由 CDS 的产物安全闸门严格审查。
        var normalized = MapSlideNavCompatBlock.Replace(html, string.Empty);
        normalized = MapSlideNavCompatMarker.Replace(normalized, string.Empty);
        normalized = CdsOfflineGuardBlock.Replace(normalized, string.Empty);
        return HostedSiteRevisionRules.StripSingleTrustedSystemCspEnvelope(normalized);
    }

    /// <summary>
    /// 序列化最终会发送给远程执行器的真实 JSON 包后校验上限；调用方不能用原始字符数估算，
    /// 因为文件正文会经过 UTF-8、base64 与 JSON 包装膨胀。
    /// </summary>
    public static byte[] ValidateInputPackageSize(DesignWorkspacePackage package, long maxInputBytes)
    {
        if (package.Files.Count is < 1 or > DesignArtifactWorkspaceBroker.MaxInputFileCount)
            throw new InvalidOperationException("工作区输入文件超过 512 个，请精简引用或站点资源后重试");
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in package.Files)
            if (!DesignArtifactPublicPath.TryNormalize(file.Path, out var path) || !paths.Add(path))
                throw new InvalidOperationException("工作区输入文件路径无效或重复，请重新选择来源");
        foreach (var path in paths)
            for (var separator = path.IndexOf('/'); separator >= 0; separator = path.IndexOf('/', separator + 1))
                if (paths.Contains(path[..separator]))
                    throw new InvalidOperationException("工作区输入文件与目录路径冲突，请重新选择来源");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(package, JsonOptions);
        if (bytes.LongLength > maxInputBytes)
            throw new InvalidOperationException(
                $"页面、知识资料与任务说明打包后超过远程工作区 {maxInputBytes / 1024 / 1024}MB 上限，请减少引用或精简页面后重试");
        return bytes;
    }

    public static ParsedDesignWorkspaceResult ParseAndValidateResult(
        byte[] bytes,
        string runId,
        string baseRevision,
        long maxBytes)
    {
        if (bytes.LongLength == 0 || bytes.LongLength > maxBytes)
            throw new InvalidOperationException("远程设计结果大小不符合要求，请重新生成");
        DesignWorkspacePackage package;
        try
        {
            package = JsonSerializer.Deserialize<DesignWorkspacePackage>(bytes, JsonOptions)
                      ?? throw new JsonException();
        }
        catch (JsonException)
        {
            throw new InvalidOperationException("远程设计结果格式不正确，请重新生成");
        }
        if (package.SchemaVersion != DesignArtifactWorkspaceBroker.SchemaVersion
            || !string.Equals(package.RunId, runId, StringComparison.Ordinal)
            || !string.Equals(package.BaseRevision, baseRevision, StringComparison.Ordinal)
            || package.Files.Count is 0 or > 100)
            throw new InvalidOperationException("远程设计结果版本不匹配，请重新生成");

        string? indexHtml = null;
        byte[]? manifestBytes = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var verifiedFiles = new Dictionary<string, DesignWorkspaceFile>(StringComparer.Ordinal);
        foreach (var file in package.Files)
        {
            if (!TryNormalizeResultPath(file.Path, out var normalized) || !seen.Add(normalized))
                throw new InvalidOperationException("远程设计结果包含不允许的文件，请重新生成");
            byte[] content;
            try
            {
                content = Convert.FromBase64String(file.ContentBase64);
            }
            catch (FormatException)
            {
                throw new InvalidOperationException("远程设计结果文件损坏，请重新生成");
            }
            if (content.LongLength != file.Size
                || !string.Equals(HashBytes(content), file.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("远程设计结果文件校验失败，请重新生成");
            if (normalized == "index.html") indexHtml = Encoding.UTF8.GetString(content);
            if (normalized == "manifest.json") manifestBytes = content;
            verifiedFiles[normalized] = file with { Path = normalized };
        }
        if (string.IsNullOrWhiteSpace(indexHtml))
            throw new InvalidOperationException("远程设计没有生成可发布网页，请重试");
        if (manifestBytes == null)
            throw new InvalidOperationException("远程设计结果缺少产物清单，请重新生成");
        ValidateManifest(manifestBytes, verifiedFiles);
        return new ParsedDesignWorkspaceResult(
            indexHtml,
            verifiedFiles.Values.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray());
    }

    private static void ValidateManifest(
        byte[] bytes,
        IReadOnlyDictionary<string, DesignWorkspaceFile> verifiedFiles)
    {
        DesignArtifactManifest manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<DesignArtifactManifest>(bytes, JsonOptions)
                       ?? throw new JsonException();
        }
        catch (JsonException)
        {
            throw new InvalidOperationException("远程设计产物清单格式不正确，请重新生成");
        }
        var expected = verifiedFiles.Values
            .Where(file => file.Path != "manifest.json")
            .OrderBy(file => file.Path, StringComparer.Ordinal)
            .ToArray();
        if (manifest.SchemaVersion != DesignArtifactWorkspaceBroker.ManifestSchemaVersion
            || manifest.EntryFile != "index.html")
            throw new InvalidOperationException("远程设计产物清单版本不匹配，请重新生成");
        var actual = manifest.Files
            .OrderBy(file => file.Path, StringComparer.Ordinal)
            .ToArray();
        if (actual.Length != expected.Length)
            throw new InvalidOperationException("远程设计产物清单与文件数量不一致，请重新生成");
        for (var index = 0; index < expected.Length; index++)
        {
            if (actual[index].Path != expected[index].Path
                || actual[index].Size != expected[index].Size
                || !string.Equals(actual[index].Sha256, expected[index].Sha256, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(actual[index].MediaType, expected[index].MediaType, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("远程设计产物清单与文件校验结果不一致，请重新生成");
        }
        var expectedRevision = ComputePublicArtifactRevision(expected.Select(file =>
            new DesignArtifactManifestFile(file.Path, file.Sha256, file.Size, file.MediaType)));
        if (!string.Equals(manifest.ArtifactRevision, expectedRevision, StringComparison.Ordinal))
            throw new InvalidOperationException("远程设计产物清单与文件校验结果不一致，请重新生成");
    }

    public static string ComputePublicArtifactRevision(IEnumerable<DesignArtifactManifestFile> files)
        => DesignArtifactPublicRevision.Compute(files.Select(file =>
            new DesignArtifactPublicRevisionFile(file.Path, file.Sha256, file.Size, file.MediaType)));

    private static bool TryNormalizeResultPath(string? path, out string normalized)
    {
        if (!DesignArtifactPublicPath.TryNormalize(path, out normalized))
            return false;
        return DesignArtifactPublicPath.IsWebPageWorkspaceOutput(
            normalized,
            includeInternalManifest: true);
    }

    private static DesignWorkspaceFile ToFile(string path, string mediaType, byte[] content) =>
        new(path, Convert.ToBase64String(content), HashBytes(content), content.LongLength, mediaType);

    private static string HashText(string content) => HashBytes(Encoding.UTF8.GetBytes(content));

    private static string HashBytes(byte[] content) => Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();
}

public sealed record DesignWorkspacePackage(
    string SchemaVersion,
    string RunId,
    string BaseRevision,
    IReadOnlyList<DesignWorkspaceFile> Files);

public sealed record DesignVisibleTextOccurrenceConstraint(
    string Text,
    int MinOccurrences,
    int MaxOccurrences);

public sealed record DesignWorkspaceFile(
    string Path,
    string ContentBase64,
    string Sha256,
    long Size,
    string MediaType);

public sealed record ParsedDesignWorkspaceResult(
    string IndexHtml,
    IReadOnlyList<DesignWorkspaceFile> Files);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record DesignArtifactManifest(
    string SchemaVersion,
    string ArtifactRevision,
    string EntryFile,
    IReadOnlyList<DesignArtifactManifestFile> Files);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record DesignArtifactManifestFile(
    string Path,
    string Sha256,
    long Size,
    string MediaType);
