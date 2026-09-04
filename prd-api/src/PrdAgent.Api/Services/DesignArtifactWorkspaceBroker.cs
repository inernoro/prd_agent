using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Driver;
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

    Task<DesignArtifactRun> ReserveModelCallAsync(string runId, string token, CancellationToken ct);

    Task<DesignArtifactRun> ValidateModelTicketAsync(string runId, string token, CancellationToken ct);
}

public sealed class DesignArtifactWorkspaceBroker : IDesignArtifactWorkspaceBroker
{
    public const string SchemaVersion = "map-design-workspace-v1";
    public const string ManifestSchemaVersion = "map-design-artifact-manifest-v1";
    public const long MaxInputBytes = 1_048_576;
    public const long MaxOutputBytes = 6_291_456;
    private static readonly TimeSpan TicketTtl = TimeSpan.FromMinutes(25);
    private static readonly string[] AllowedOutputPaths = ["index.html", "manifest.json", "assets/**"];
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly IDataProtector _protector;
    private readonly IConfiguration _configuration;

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
        IConfiguration configuration)
    {
        _db = db;
        _storage = storage;
        _protector = dataProtectionProvider.CreateProtector("DesignArtifactWorkspaceBroker.v1");
        _configuration = configuration;
    }

    public async Task<PreparedDesignArtifactWorkspace> PrepareAsync(
        DesignArtifactRun run,
        string? currentHtml,
        CancellationToken ct)
    {
        var publicBaseUrl = ResolvePublicBaseUrl(_configuration)
            ?? throw new InvalidOperationException("远程设计入口尚未配置，请先补齐当前 CDS 预览地址后重试");
        var expiresAt = DateTime.UtcNow.Add(TicketTtl);
        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, currentHtml);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(package, DesignArtifactWorkspaceContract.JsonOptions);
        if (bytes.LongLength > MaxInputBytes)
            throw new InvalidOperationException("页面与知识资料超过远程工作区上限，请减少引用或精简页面后重试");

        var stored = await SaveWorkspaceMetadataAsync(
            _storage,
            bytes,
            $"{run.Id}.json",
            CancellationToken.None);
        if (string.IsNullOrWhiteSpace(stored.Key))
            throw new InvalidOperationException("远程工作区输入保存失败，请稍后重试");

        run.WorkspaceInputAssetKey = stored.Key;
        run.WorkspaceInputSha256 = stored.Sha256;
        run.WorkspaceBaseRevision = package.BaseRevision;
        run.WorkspaceResultAssetKey = null;
        run.WorkspaceResultSha256 = null;
        run.RuntimeModelCallCount = 0;
        run.RuntimeModelCallLimit = Math.Clamp(
            _configuration.GetValue<int?>("DesignArtifactRuntime:MaxModelCalls") ?? 36,
            1,
            36);
        run.RuntimeTicketExpiresAt = expiresAt;
        run.UpdatedAt = DateTime.UtcNow;
        await _db.DesignArtifactRuns.ReplaceOneAsync(
            item => item.Id == run.Id,
            run,
            cancellationToken: CancellationToken.None);

        var transferToken = ProtectTicket(run, "workspace", expiresAt);
        var modelToken = ProtectTicket(run, "model", expiresAt);
        var runtimeRoot = $"{publicBaseUrl}/api/design-artifacts/runtime/{Uri.EscapeDataString(run.Id)}";
        return new PreparedDesignArtifactWorkspace(
            $"{runtimeRoot}/workspace/input",
            stored.Sha256,
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

    public async Task<byte[]> ReadInputPackageAsync(string runId, string token, CancellationToken ct)
    {
        ValidateTicket(token, runId, "workspace");
        var run = await _db.DesignArtifactRuns.Find(item => item.Id == runId).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        EnsureTicketWindow(run);
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
        var run = await _db.DesignArtifactRuns.Find(item => item.Id == runId).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        EnsureTicketWindow(run);
        var parsed = DesignArtifactWorkspaceContract.ParseAndValidateResult(
            packageBytes,
            runId,
            run.WorkspaceBaseRevision ?? string.Empty,
            MaxOutputBytes);
        var packageSha = Sha256Hex(packageBytes);
        if (!string.IsNullOrWhiteSpace(run.WorkspaceResultAssetKey))
        {
            if (FixedEquals(run.WorkspaceResultSha256, packageSha))
                return new DesignArtifactResultCommit(packageSha, parsed.Files.Select(file => file.Path).ToArray(), true);
            throw new InvalidOperationException("该工作区已经提交过不同结果，请重新发起任务");
        }

        var stored = await SaveWorkspaceMetadataAsync(
            _storage,
            packageBytes,
            $"{run.Id}.json",
            CancellationToken.None);
        if (string.IsNullOrWhiteSpace(stored.Key))
            throw new InvalidOperationException("远程设计结果保存失败，请稍后重试");

        var update = Builders<DesignArtifactRun>.Update
            .Set(item => item.WorkspaceResultAssetKey, stored.Key)
            .Set(item => item.WorkspaceResultSha256, packageSha)
            .Set(item => item.UpdatedAt, DateTime.UtcNow);
        var write = await _db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == runId && item.WorkspaceResultAssetKey == null,
            update,
            cancellationToken: CancellationToken.None);
        if (write.ModifiedCount == 0)
        {
            var winner = await _db.DesignArtifactRuns.Find(item => item.Id == runId).FirstOrDefaultAsync(CancellationToken.None);
            if (winner != null && FixedEquals(winner.WorkspaceResultSha256, packageSha))
                return new DesignArtifactResultCommit(packageSha, parsed.Files.Select(file => file.Path).ToArray(), true);
            throw new InvalidOperationException("该工作区已经提交过不同结果，请重新发起任务");
        }
        return new DesignArtifactResultCommit(packageSha, parsed.Files.Select(file => file.Path).ToArray(), false);
    }

    public async Task<string> ReadResultHtmlAsync(string runId, CancellationToken ct)
    {
        var run = await _db.DesignArtifactRuns.Find(item => item.Id == runId).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        if (string.IsNullOrWhiteSpace(run.WorkspaceResultAssetKey))
            throw new InvalidOperationException("远程设计任务没有提交可用页面，请重试");
        var bytes = await _storage.TryDownloadBytesAsync(run.WorkspaceResultAssetKey, CancellationToken.None)
            ?? throw new InvalidOperationException("远程设计结果暂时无法读取，请稍后重试");
        if (!FixedEquals(run.WorkspaceResultSha256, Sha256Hex(bytes)))
            throw new InvalidOperationException("远程设计结果校验失败，请重新发起任务");
        return DesignArtifactWorkspaceContract.ParseAndValidateResult(
                bytes,
                runId,
                run.WorkspaceBaseRevision ?? string.Empty,
                MaxOutputBytes)
            .IndexHtml;
    }

    public async Task<DesignArtifactRun> ReserveModelCallAsync(string runId, string token, CancellationToken ct)
    {
        ValidateTicket(token, runId, "model");
        var current = await _db.DesignArtifactRuns.Find(item => item.Id == runId).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        EnsureTicketWindow(current);
        var now = DateTime.UtcNow;
        var filter = Builders<DesignArtifactRun>.Filter.And(
            Builders<DesignArtifactRun>.Filter.Eq(item => item.Id, runId),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.Status, RunStatuses.Running),
            Builders<DesignArtifactRun>.Filter.Gt(item => item.RuntimeTicketExpiresAt, now),
            Builders<DesignArtifactRun>.Filter.Lt(item => item.RuntimeModelCallCount, current.RuntimeModelCallLimit));
        var run = await _db.DesignArtifactRuns.FindOneAndUpdateAsync(
            filter,
            Builders<DesignArtifactRun>.Update
                .Inc(item => item.RuntimeModelCallCount, 1)
                .Set(item => item.UpdatedAt, now),
            new FindOneAndUpdateOptions<DesignArtifactRun> { ReturnDocument = ReturnDocument.After },
            CancellationToken.None);
        return run ?? throw new InvalidOperationException("本次远程设计的模型调用额度已用完或任务已结束，请重新发起任务");
    }

    public async Task<DesignArtifactRun> ValidateModelTicketAsync(string runId, string token, CancellationToken ct)
    {
        ValidateTicket(token, runId, "model");
        var run = await _db.DesignArtifactRuns.Find(item => item.Id == runId).FirstOrDefaultAsync(ct)
            ?? throw new KeyNotFoundException("设计任务不存在");
        EnsureTicketWindow(run);
        return run;
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
    private static readonly Regex SafeSlug = new("[^a-zA-Z0-9._-]+", RegexOptions.Compiled);
    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static DesignWorkspacePackage BuildInputPackage(DesignArtifactRun run, string? currentHtml)
    {
        var semantic = JsonSerializer.SerializeToUtf8Bytes(new
        {
            run.Id,
            run.ArtifactType,
            run.Operation,
            run.SourceSurface,
            run.Instruction,
            run.Title,
            knowledge = run.KnowledgeReferences.Select(item => new { item.EntryId, item.ContentHash }),
            currentHtmlHash = string.IsNullOrEmpty(currentHtml) ? null : HashText(currentHtml),
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
            run.Instruction,
            run.Title,
            baseRevision,
            responseContract = new
            {
                requiredFile = "index.html",
                manifestFile = "manifest.json",
                writeback = "external",
            },
        }, JsonOptions);
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
        if (!string.IsNullOrWhiteSpace(currentHtml))
            files.Add(ToFile("current/index.html", "text/html", Encoding.UTF8.GetBytes(currentHtml)));
        return new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            baseRevision,
            files);
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
            var normalized = file.Path.Replace('\\', '/').TrimStart('/');
            if (!IsAllowedResultPath(normalized) || !seen.Add(normalized))
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
        ValidateManifest(manifestBytes, baseRevision, verifiedFiles);
        return new ParsedDesignWorkspaceResult(indexHtml, package.Files);
    }

    private static void ValidateManifest(
        byte[] bytes,
        string baseRevision,
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
        if (manifest.SchemaVersion != DesignArtifactWorkspaceBroker.ManifestSchemaVersion
            || !string.Equals(manifest.BaseRevision, baseRevision, StringComparison.Ordinal)
            || manifest.EntryFile != "index.html")
            throw new InvalidOperationException("远程设计产物清单版本不匹配，请重新生成");

        var expected = verifiedFiles.Values
            .Where(file => file.Path != "manifest.json")
            .OrderBy(file => file.Path, StringComparer.Ordinal)
            .ToArray();
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
    }

    private static bool IsAllowedResultPath(string path) =>
        path is "index.html" or "manifest.json"
        || (path.StartsWith("assets/", StringComparison.Ordinal)
            && !path.Contains("../", StringComparison.Ordinal)
            && !path.EndsWith("/", StringComparison.Ordinal));

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

public sealed record DesignWorkspaceFile(
    string Path,
    string ContentBase64,
    string Sha256,
    long Size,
    string MediaType);

public sealed record ParsedDesignWorkspaceResult(
    string IndexHtml,
    IReadOnlyList<DesignWorkspaceFile> Files);

public sealed record DesignArtifactManifest(
    string SchemaVersion,
    string BaseRevision,
    string EntryFile,
    IReadOnlyList<DesignArtifactManifestFile> Files);

public sealed record DesignArtifactManifestFile(
    string Path,
    string Sha256,
    long Size,
    string MediaType);
