using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// GitHub 目录同步服务 — 从 GitHub 仓库目录拉取所有文件同步到文档空间。
/// 增量同步：比较 SHA 去重，只更新变化的文件，删除远端已不存在的文件。
/// </summary>
public class GitHubDirectorySyncService
{
    private readonly ILogger<GitHubDirectorySyncService> _logger;
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    static GitHubDirectorySyncService()
    {
        Http.DefaultRequestHeaders.UserAgent.ParseAdd("PrdAgent-GitHubSync/1.0");
        Http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github.v3+json");
    }

    public GitHubDirectorySyncService(ILogger<GitHubDirectorySyncService> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// 同步 GitHub 目录到文档空间。
    /// parentEntry 是 github_directory 类型的"目录条目"，Metadata 中存储 github_owner/repo/path/branch。
    /// 每个文件对应一个 sourceType=subscription 的子 entry。
    /// 返回 GitHubDirectoryDiff 描述本次同步的增删改情况，由 Worker 决定是否落日志。
    /// </summary>
    public async Task<GitHubDirectoryDiff> SyncDirectoryAsync(
        MongoDbContext db,
        IDocumentService documentService,
        DocumentEntry parentEntry,
        CancellationToken ct)
    {
        var diff = new GitHubDirectoryDiff();

        var meta = parentEntry.Metadata;
        if (!meta.TryGetValue("github_owner", out var owner) ||
            !meta.TryGetValue("github_repo", out var repo))
        {
            throw new InvalidOperationException("缺少 github_owner 或 github_repo 元数据");
        }

        var path = meta.GetValueOrDefault("github_path", "");
        var branch = meta.GetValueOrDefault("github_branch", "main");

        _logger.LogInformation("[GitHubSync] Syncing {Owner}/{Repo}/{Path}@{Branch} → store {StoreId}",
            owner, repo, path, branch, parentEntry.StoreId);

        // 1) 调用 GitHub Contents API 获取目录文件列表
        var files = await ListDirectoryFilesAsync(owner, repo, path, branch, ct);
        _logger.LogInformation("[GitHubSync] Found {Count} files in {Owner}/{Repo}/{Path}", files.Count, owner, repo, path);

        if (files.Count == 0) return diff;

        // 2) 查找该 Store 下已有的同步子条目（SourceType=subscription + github_parent_id）
        var existingEntries = await db.DocumentEntries.Find(
            e => e.StoreId == parentEntry.StoreId &&
                 e.SourceType == DocumentSourceType.Subscription &&
                 e.Metadata.ContainsKey("github_parent_id") &&
                 e.Metadata["github_parent_id"] == parentEntry.Id
        ).ToListAsync(ct);

        var existingByUrl = existingEntries.ToDictionary(e => e.SourceUrl ?? "", e => e);

        var processedUrls = new HashSet<string>();

        foreach (var file in files)
        {
            processedUrls.Add(file.DownloadUrl);

            if (existingByUrl.TryGetValue(file.DownloadUrl, out var existing))
            {
                // 已存在 → 比较 SHA 决定是否需要更新（GitHub SHA 即版本号，O(1) 命中判定）
                var existingSha = existing.Metadata.GetValueOrDefault("github_sha", "");
                if (existingSha == file.Sha)
                {
                    diff.SkippedCount++;
                    continue;
                }

                // SHA 变了 → 重新拉取内容并更新
                await SyncSingleFileAsync(db, documentService, existing, file, ct);
                diff.UpdatedCount++;
                diff.FileChanges.Add(new DocumentSyncFileChange
                {
                    Path = file.Path,
                    Action = DocumentSyncFileAction.Updated,
                });
            }
            else
            {
                // 新文件 → 创建条目
                var now = DateTime.UtcNow;
                var entry = new DocumentEntry
                {
                    StoreId = parentEntry.StoreId,
                    Title = file.Name,
                    SourceType = DocumentSourceType.Subscription,
                    SourceUrl = file.DownloadUrl,
                    SyncIntervalMinutes = parentEntry.SyncIntervalMinutes,
                    SyncStatus = DocumentSyncStatus.Idle,
                    ContentType = "text/markdown",
                    CreatedBy = parentEntry.CreatedBy,
                    LastChangedAt = now,
                    Metadata = new Dictionary<string, string>
                    {
                        ["github_parent_id"] = parentEntry.Id,
                        ["github_sha"] = file.Sha,
                        ["github_path"] = file.Path,
                    },
                };

                await SyncSingleFileAsync(db, documentService, entry, file, ct, isNew: true);
                diff.AddedCount++;
                diff.FileChanges.Add(new DocumentSyncFileChange
                {
                    Path = file.Path,
                    Action = DocumentSyncFileAction.Added,
                });
            }
        }

        // 3) 删除远端已不存在的条目
        foreach (var (url, entry) in existingByUrl)
        {
            if (!processedUrls.Contains(url))
            {
                await db.DocumentEntries.DeleteOneAsync(e => e.Id == entry.Id, cancellationToken: CancellationToken.None);
                diff.DeletedCount++;
                diff.FileChanges.Add(new DocumentSyncFileChange
                {
                    Path = entry.Metadata.GetValueOrDefault("github_path", entry.Title),
                    Action = DocumentSyncFileAction.Deleted,
                });
            }
        }

        // 4) 更新父条目的文档计数 + 同步状态
        var totalEntries = await db.DocumentEntries.CountDocumentsAsync(
            e => e.StoreId == parentEntry.StoreId, cancellationToken: CancellationToken.None);
        await db.DocumentStores.UpdateOneAsync(
            s => s.Id == parentEntry.StoreId,
            Builders<DocumentStore>.Update
                .Set(s => s.DocumentCount, (int)totalEntries)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation(
            "[GitHubSync] Done: added={Added} updated={Updated} skipped={Skipped} deleted={Deleted}",
            diff.AddedCount, diff.UpdatedCount, diff.SkippedCount, diff.DeletedCount);

        return diff;
    }

    private async Task SyncSingleFileAsync(
        MongoDbContext db,
        IDocumentService documentService,
        DocumentEntry entry,
        GitHubFile file,
        CancellationToken ct,
        bool isNew = false)
    {
        try
        {
            // 拉取文件内容（通过 raw.githubusercontent.com）
            var content = await Http.GetStringAsync(file.DownloadUrl, ct);

            if (string.IsNullOrWhiteSpace(content))
            {
                _logger.LogWarning("[GitHubSync] Empty content for {Path}", file.Path);
                return;
            }

            // 解析为 ParsedPrd
            var parsed = await documentService.ParseAsync(content);
            parsed.Title = Path.GetFileNameWithoutExtension(file.Name);
            await documentService.SaveAsync(parsed);

            var summary = content.Length > 200 ? content[..200] : content;

            entry.DocumentId = parsed.Id;
            entry.ContentType = "text/markdown";
            entry.FileSize = Encoding.UTF8.GetByteCount(content);
            entry.Summary = summary.Trim();
            entry.ContentIndex = content.Length > 2000 ? content[..2000] : content;
            entry.SyncStatus = DocumentSyncStatus.Idle;
            entry.SyncError = null;
            entry.LastSyncAt = DateTime.UtcNow;
            entry.LastChangedAt = DateTime.UtcNow; // SHA 变了才会进入此函数（除新建外），即真的有变化
            entry.UpdatedAt = DateTime.UtcNow;
            entry.Metadata["github_sha"] = file.Sha;

            if (isNew)
            {
                await db.DocumentEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
            }
            else
            {
                await db.DocumentEntries.ReplaceOneAsync(
                    e => e.Id == entry.Id, entry, cancellationToken: CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[GitHubSync] Failed to sync file {Path}", file.Path);
        }
    }

    /// <summary>调用 GitHub Contents API 获取目录下的文件列表</summary>
    private async Task<List<GitHubFile>> ListDirectoryFilesAsync(
        string owner, string repo, string path, string branch, CancellationToken ct)
    {
        var url = $"https://api.github.com/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/contents/{path}?ref={Uri.EscapeDataString(branch)}";

        var response = await Http.GetAsync(url, ct);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            throw new Exception($"GitHub API 返回 {response.StatusCode}: {body}");
        }

        var json = await response.Content.ReadAsStringAsync(ct);
        var doc = JsonDocument.Parse(json);

        var files = new List<GitHubFile>();
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            var type = item.GetProperty("type").GetString();
            if (type != "file") continue;

            var name = item.GetProperty("name").GetString() ?? "";
            // 只同步 .md 文件
            if (!name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) continue;

            var downloadUrl = item.GetProperty("download_url").GetString();
            if (string.IsNullOrEmpty(downloadUrl)) continue;

            files.Add(new GitHubFile
            {
                Name = name,
                Path = item.GetProperty("path").GetString() ?? "",
                Sha = item.GetProperty("sha").GetString() ?? "",
                Size = item.GetProperty("size").GetInt64(),
                DownloadUrl = downloadUrl,
            });
        }

        return files;
    }

    /// <summary>解析 GitHub 仓库地址，提取 owner/repo/path/branch</summary>
    public static (string owner, string repo, string path, string branch) ParseGitHubUrl(string url)
    {
        // 支持格式：
        // https://github.com/owner/repo/tree/branch/path/to/dir
        // https://github.com/owner/repo
        var uri = new Uri(url);
        var segments = uri.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);

        if (segments.Length < 2)
            throw new ArgumentException("无效的 GitHub 地址，至少需要 owner/repo");

        var owner = segments[0];
        var repo = segments[1].Replace(".git", "");
        var branch = "main";
        var path = "";

        // /owner/repo/tree/branch/path...
        if (segments.Length >= 4 && segments[2] == "tree")
        {
            branch = segments[3];
            if (segments.Length > 4)
                path = string.Join("/", segments[4..]);
        }

        return (owner, repo, path, branch);
    }

    private class GitHubFile
    {
        public string Name { get; set; } = "";
        public string Path { get; set; } = "";
        public string Sha { get; set; } = "";
        public long Size { get; set; }
        public string DownloadUrl { get; set; } = "";
    }
}

/// <summary>
/// GitHub 目录同步本次执行结果（增删改计数 + 逐文件变化）。
/// 由 Worker 决定是否将变化落入 DocumentSyncLog。
/// </summary>
public class GitHubDirectoryDiff
{
    public int AddedCount { get; set; }
    public int UpdatedCount { get; set; }
    public int DeletedCount { get; set; }
    public int SkippedCount { get; set; }
    public List<DocumentSyncFileChange> FileChanges { get; set; } = new();

    public bool HasChanges => AddedCount > 0 || UpdatedCount > 0 || DeletedCount > 0;

    public string BuildSummary()
    {
        var parts = new List<string>();
        if (AddedCount > 0) parts.Add($"+{AddedCount} 新增");
        if (UpdatedCount > 0) parts.Add($"~{UpdatedCount} 修改");
        if (DeletedCount > 0) parts.Add($"-{DeletedCount} 删除");
        return parts.Count > 0 ? string.Join(" / ", parts) : "无变化";
    }
}
