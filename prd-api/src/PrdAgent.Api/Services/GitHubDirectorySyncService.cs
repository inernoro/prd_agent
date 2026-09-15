using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.FileSystemGlobbing;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.GitHub;
using DocStoreServices = PrdAgent.Infrastructure.Services.DocumentStore;

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
        return await SyncDirectoryAsync(db, documentService, null, parentEntry, ct);
    }

    /// <summary>
    /// 同步 GitHub 目录。<paramref name="versions"/> 非空时，在覆盖已存在文档前把旧正文快照成版本，
    /// 使「订阅文档被远端同步覆盖」也不会丢失用户在本地的改动（可从历史版本恢复）。
    /// </summary>
    public async Task<GitHubDirectoryDiff> SyncDirectoryAsync(
        MongoDbContext db,
        IDocumentService documentService,
        DocStoreServices.DocumentVersionService? versions,
        DocumentEntry parentEntry,
        CancellationToken ct)
        => await SyncDirectoryAsync(db, documentService, versions, parentEntry, null, ct);

    /// <summary>
    /// 同步 GitHub 目录。<paramref name="accessToken"/> 非空时全程带用户 token 请求：
    /// 私有仓才拉得到，限额也从匿名的 60 次/小时提到 5000 次/小时。
    /// 匿名路径（token 为 null）行为与历史完全一致，公开仓订阅不受影响。
    /// </summary>
    public async Task<GitHubDirectoryDiff> SyncDirectoryAsync(
        MongoDbContext db,
        IDocumentService documentService,
        DocStoreServices.DocumentVersionService? versions,
        DocumentEntry parentEntry,
        string? accessToken,
        CancellationToken ct)
    {
        var diff = new GitHubDirectoryDiff();

        var meta = parentEntry.Metadata;
        if (!meta.TryGetValue("github_owner", out var owner) ||
            !meta.TryGetValue("github_repo", out var repo))
        {
            // 用户看得懂的说法 + 下一步；原始字段名只对开发者有意义，留在日志里
            throw new GitHubSyncUserFacingException(
                "这条订阅缺少仓库信息（无法确定要同步哪个 GitHub 仓库），请删掉它后用「从 GitHub 同步」重新添加。");
        }

        var path = meta.GetValueOrDefault("github_path", "");
        var branch = meta.GetValueOrDefault("github_branch", "main");

        _logger.LogInformation("[GitHubSync] Syncing {Owner}/{Repo}/{Path}@{Branch} → store {StoreId}",
            owner, repo, path, branch, parentEntry.StoreId);

        // 1) 调用 GitHub Contents API 获取目录文件列表
        var includeGlob = meta.GetValueOrDefault("github_include_glob", null);
        Matcher? matcher = null;
        if (!string.IsNullOrWhiteSpace(includeGlob))
        {
            matcher = new Matcher();
            matcher.AddInclude(includeGlob);
        }

        var listing = await ListDirectoryFilesAsync(owner, repo, path, branch, matcher, accessToken, ct);
        var files = listing.Files;
        // 本轮所有对 GitHub 的读取都用同一个 ref：清单、正文、最近修改时间必须出自同一份快照。
        var reference = listing.Reference;
        _logger.LogInformation(
            "[GitHubSync] Found {Count} files in {Owner}/{Repo}/{Path} matching glob '{Glob}'（清单完整：{Complete}）",
            files.Count, owner, repo, path, includeGlob ?? "*", listing.Complete);

        // 这里**不能**在 files.Count == 0 时提前返回：列目录成功但一篇 Markdown 都不剩，
        // 说明远端把这个目录清空了（或全部改名），旧子文档就该跟着删。提前返回会让它们
        // 永远留在知识库里，用户看到的是一份远端已经不存在的文档。
        // 列目录失败是抛异常（见 ListDirectoryFilesAsync），走不到这里。
        // 但「这一轮没见到」只在**清单完整**时才等于「远端没有了」—— 见下面第 3 步的闸。

        // 2) 查找该 Store 下已有的同步子条目（SourceType=subscription + github_parent_id）
        var existingEntries = await db.DocumentEntries.Find(
            e => e.StoreId == parentEntry.StoreId &&
                 e.SourceType == DocumentSourceType.Subscription &&
                 e.Metadata.ContainsKey("github_parent_id") &&
                 e.Metadata["github_parent_id"] == parentEntry.Id
        ).ToListAsync(ct);

        var existingByKey = IndexExistingChildren(existingEntries);

        var processedKeys = new HashSet<string>(StringComparer.Ordinal);

        foreach (var file in files)
        {
            processedKeys.Add(file.Path);

            if (!existingByKey.TryGetValue(file.Path, out var existing)
                && existingByKey.TryGetValue(file.DownloadUrl, out var legacy))
            {
                // 命中存量键：登记它，否则下面的删除环节会把它当"远端已不存在"删掉
                existing = legacy;
                processedKeys.Add(file.DownloadUrl);
            }

            if (existing != null)
            {
                // 已存在 → 比较 SHA 决定是否需要更新（GitHub SHA 即版本号，O(1) 命中判定）
                var existingSha = existing.Metadata.GetValueOrDefault("github_sha", "");

                // 自愈：SHA 相同但 Document 已是空壳（受 SHA 缓存 bug 历史影响），强制重拉一次
                var contentMissing = false;
                if (existingSha == file.Sha && !string.IsNullOrEmpty(existing.DocumentId))
                {
                    var existingDoc = await documentService.GetByIdAsync(existing.DocumentId);
                    if (existingDoc == null || string.IsNullOrWhiteSpace(existingDoc.RawContent))
                    {
                        _logger.LogWarning(
                            "[GitHubSync] Entry {EntryId} has matching SHA but empty Document {DocumentId}; forcing re-fetch",
                            existing.Id, existing.DocumentId);
                        contentMissing = true;
                    }
                }

                if (existingSha == file.Sha && !contentMissing)
                {
                    diff.SkippedCount++;
                    // 回填 github_last_commit_at：历史条目没有这个字段，无需重新拉内容，只补时间戳
                    if (!existing.Metadata.ContainsKey("github_last_commit_at"))
                    {
                        var backfillDate = await GetLatestCommitDateAsync(owner, repo, file.Path, reference, accessToken, ct);
                        if (backfillDate.HasValue)
                        {
                            existing.Metadata["github_last_commit_at"] = backfillDate.Value.ToString("O");
                            existing.UpdatedAt = DateTime.UtcNow;
                            await db.DocumentEntries.ReplaceOneAsync(
                                e => e.Id == existing.Id, existing, cancellationToken: CancellationToken.None);
                        }
                    }
                    continue;
                }

                // SHA 变了 → 重新拉取内容并更新
                var updated = await SyncSingleFileAsync(db, documentService, versions, existing, file, owner, repo, branch, reference, accessToken, ct);
                if (updated)
                {
                    diff.UpdatedCount++;
                    diff.FileChanges.Add(new DocumentSyncFileChange
                    {
                        Path = file.Path,
                        Action = DocumentSyncFileAction.Updated,
                    });
                }
                else
                {
                    diff.FailedCount++;
                    diff.FailedPaths.Add(file.Path);
                }
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
                    SourceUrl = BuildBlobUrl(owner, repo, branch, file.Path),
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

                var added = await SyncSingleFileAsync(db, documentService, versions, entry, file, owner, repo, branch, reference, accessToken, ct, isNew: true);
                if (added)
                {
                    diff.AddedCount++;
                    diff.FileChanges.Add(new DocumentSyncFileChange
                    {
                        Path = file.Path,
                        Action = DocumentSyncFileAction.Added,
                    });
                }
                else
                {
                    diff.FailedCount++;
                    diff.FailedPaths.Add(file.Path);
                }
            }
        }

        // 3) 删除远端已不存在的条目（远端整个目录被删光时，这里会删掉全部子文档——这正是本意）
        //
        // **清单不完整时整个删除环节都不跑。** GitHub 的目录接口一次最多回 1000 条，超了就截断，
        // 而截断这件事它不会明说。窗口之外的文件在本轮「没见到」，但它们在远端好好的——
        // 照删就是拿一个非事件去做不可逆的破坏（连历史版本一起没）。
        // 一个能真实发生的例子：某个目录塞了一千多个非 Markdown 文件，把原先导入的那几十篇挤出窗口，
        // 过滤后恰好 0 篇，于是「远端删光了」这个判断成立——而实际上一篇都没少。
        // 新增与更新不受影响：见到什么就同步什么，只有「删」需要完整清单撑腰。
        if (!listing.Complete)
        {
            _logger.LogWarning(
                "[GitHubSync] {Owner}/{Repo}/{Path}@{Branch} 的目录清单可能被截断（上游一次最多 {Cap} 条），"
                + "本轮跳过删除环节，只做新增与更新",
                owner, repo, path, branch, ContentsApiDirectoryCap);
            diff.ListingIncomplete = true;
        }

        var staleChildren = listing.Complete
            ? SelectStaleChildren(existingByKey, processedKeys)
            : new List<DocumentEntry>();
        foreach (var entry in staleChildren)
        {
            await db.DocumentEntries.DeleteOneAsync(e => e.Id == entry.Id, cancellationToken: CancellationToken.None);
            // 级联清理该条目历史版本，和手动 DeleteEntry 一致，避免远端删文件后版本快照残留（Bugbot）
            await db.DocumentEntryVersions.DeleteManyAsync(v => v.EntryId == entry.Id, CancellationToken.None);
            diff.DeletedCount++;
            diff.FileChanges.Add(new DocumentSyncFileChange
            {
                Path = entry.Metadata.GetValueOrDefault("github_path", entry.Title),
                Action = DocumentSyncFileAction.Deleted,
            });
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
            "[GitHubSync] Done: added={Added} updated={Updated} skipped={Skipped} deleted={Deleted} failed={Failed}",
            diff.AddedCount, diff.UpdatedCount, diff.SkippedCount, diff.DeletedCount, diff.FailedCount);

        return diff;
    }

    /// <summary>
    /// 同步单个文件。**返回是否成功** —— 失败必须冒泡给调用方，
    /// 否则文件没落库、计数却照加，父条目还标成功（形状 10：静默降级）。
    /// </summary>
    private async Task<bool> SyncSingleFileAsync(
        MongoDbContext db,
        IDocumentService documentService,
        DocStoreServices.DocumentVersionService? versions,
        DocumentEntry entry,
        GitHubFile file,
        string owner,
        string repo,
        string branch,
        // 本轮列目录实际用的 ref（解析成功即提交号）：正文与修改时间都按它取
        PinnedRef reference,
        string? accessToken,
        CancellationToken ct,
        bool isNew = false)
    {
        // 拉 git 最后提交时间（用来驱动前端显示的时间 + "NEW" 徽标）。
        // 和文件内容拉取并行，不把网络往返叠加在同步延迟上。
        var commitDateTask = GetLatestCommitDateAsync(owner, repo, file.Path, reference, accessToken, ct);
        try
        {
            // 优化：跨知识库/同文件多次拉取复用检查 (Pooling by SHA)
            var filter = Builders<DocumentEntry>.Filter.Eq("Metadata.github_sha", file.Sha);
            var cachedEntry = await db.DocumentEntries.Find(
                filter & Builders<DocumentEntry>.Filter.Ne(e => e.DocumentId, null)
            ).FirstOrDefaultAsync(ct);

            if (cachedEntry != null && cachedEntry.DocumentId != null)
            {
                var cachedDoc = await documentService.GetByIdAsync(cachedEntry.DocumentId);
                // 关键：必须验证 RawContent 非空，否则会把"空壳 Document"传染给所有 SHA 相同的同步条目
                // （历史 bug：用户看到「11h 前同步过」但右侧空白，根因即此处只查 != null 没查内容）
                var cacheUsable = cachedDoc != null && !string.IsNullOrWhiteSpace(cachedDoc.RawContent);
                if (!cacheUsable && cachedEntry != null)
                {
                    _logger.LogWarning(
                        "[GitHubSync] Cached entry {EntryId} (DocumentId={DocumentId}) has empty content; falling back to live fetch for SHA {Sha}",
                        cachedEntry.Id, cachedEntry.DocumentId, file.Sha);
                }
                if (cacheUsable)
                {
                    _logger.LogInformation("[GitHubSync] Reusing cached content for SHA {Sha} from Entry {EntryId}", file.Sha, cachedEntry.Id);

                    // 序列化深拷贝，生成独立底层副本确保级联删除时互不干扰
                    var cloneJson = System.Text.Json.JsonSerializer.Serialize(cachedDoc);
                    var newDoc = System.Text.Json.JsonSerializer.Deserialize<PrdAgent.Core.Models.ParsedPrd>(cloneJson)!;
                    newDoc.Id = Guid.NewGuid().ToString("N");
                    newDoc.CreatedAt = DateTime.UtcNow;

                    await documentService.SaveAsync(newDoc);

                    // 覆盖前快照旧正文：SHA 命中缓存复用分支同样会覆盖本地正文，必须和 live-fetch 分支
                    // 一样先留存旧内容，否则用户本地插入的配图等改动在此路径会被静默覆盖、无法恢复（Codex P2）。
                    if (versions != null && !isNew && !string.IsNullOrEmpty(entry.DocumentId))
                    {
                        var oldCachedDoc = await documentService.GetByIdAsync(entry.DocumentId);
                        if (oldCachedDoc != null && !string.IsNullOrWhiteSpace(oldCachedDoc.RawContent))
                            await versions.SnapshotAsync(entry.Id, entry.StoreId, oldCachedDoc.RawContent,
                                DocumentVersionSource.Sync, entry.UpdatedBy ?? entry.CreatedBy, entry.UpdatedByName ?? entry.CreatedByName, ct: CancellationToken.None);
                    }

                    entry.DocumentId = newDoc.Id;
                    entry.ContentType = cachedEntry.ContentType;
                    entry.FileSize = cachedEntry.FileSize;
                    entry.Summary = cachedEntry.Summary;
                    entry.ContentIndex = cachedEntry.ContentIndex;
                    
                    entry.SyncStatus = DocumentSyncStatus.Idle;
                    entry.SyncError = null;
                    entry.LastSyncAt = DateTime.UtcNow;
                    entry.LastChangedAt = DateTime.UtcNow;
                    entry.UpdatedAt = DateTime.UtcNow;
                    entry.SourceUrl = BuildBlobUrl(owner, repo, branch, file.Path);
                    // 与改写 SourceUrl 同一拍补上 github_path：存量条目（早期没有这个字段）
                    // 是靠 SourceUrl == download_url 认亲的，只改地址不补路径键，下一轮同步
                    // 会把它当"远端已不存在"删掉再重建，历史版本一起没。
                    entry.Metadata["github_path"] = file.Path;
                    entry.Metadata["github_sha"] = file.Sha;
                    var cachedCommitDate = await commitDateTask;
                    if (cachedCommitDate.HasValue)
                    {
                        entry.Metadata["github_last_commit_at"] = cachedCommitDate.Value.ToString("O");
                    }

                    if (isNew)
                    {
                        await db.DocumentEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
                    }
                    else
                    {
                        await db.DocumentEntries.ReplaceOneAsync(
                            e => e.Id == entry.Id, entry, cancellationToken: CancellationToken.None);
                    }

                    // 同步后的新正文也快照（与 live-fetch 分支一致，保持「最新版本==当前正文」；去重避免噪音）
                    if (versions != null && !string.IsNullOrWhiteSpace(newDoc.RawContent))
                        await versions.SnapshotAsync(entry.Id, entry.StoreId, newDoc.RawContent,
                            DocumentVersionSource.Sync, entry.UpdatedBy ?? entry.CreatedBy, entry.UpdatedByName ?? entry.CreatedByName, ct: CancellationToken.None);
                    return true; // 跳过后续的外网拉取
                }
            }

            // 拉取文件内容：
            //   已连接 → 走 Contents API + Accept: raw，带 Authorization，私有仓可读；
            //   未连接 → 保持历史路径（raw.githubusercontent.com 的 download_url），公开仓行为不变。
            // 注意不要把用户 token 发到 download_url 那个域，避免凭据外扩到非 api.github.com 主机。
            var content = await FetchFileContentAsync(file, owner, repo, reference, accessToken, ct);

            if (string.IsNullOrWhiteSpace(content))
            {
                _logger.LogWarning("[GitHubSync] Empty content for {Path}", file.Path);
                return false;
            }

            // 覆盖已存在文档前，把旧正文快照成版本：订阅文档被远端同步覆盖时，
            // 用户本地的改动（如插入的配图）不会丢失，可从历史版本恢复。去重保证无变化不产生噪音。
            if (versions != null && !isNew && !string.IsNullOrEmpty(entry.DocumentId))
            {
                var oldDoc = await documentService.GetByIdAsync(entry.DocumentId);
                if (oldDoc != null && !string.IsNullOrWhiteSpace(oldDoc.RawContent))
                    await versions.SnapshotAsync(entry.Id, entry.StoreId, oldDoc.RawContent,
                        DocumentVersionSource.Sync, entry.UpdatedBy ?? entry.CreatedBy, entry.UpdatedByName ?? entry.CreatedByName, ct: CancellationToken.None);
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
            entry.SourceUrl = BuildBlobUrl(owner, repo, branch, file.Path);
            // 同上：改地址必须同时补路径键，否则存量条目下一轮会被判成删除 + 新增
            entry.Metadata["github_path"] = file.Path;
            entry.Metadata["github_sha"] = file.Sha;
            var freshCommitDate = await commitDateTask;
            if (freshCommitDate.HasValue)
            {
                entry.Metadata["github_last_commit_at"] = freshCommitDate.Value.ToString("O");
            }

            if (isNew)
            {
                await db.DocumentEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
            }
            else
            {
                await db.DocumentEntries.ReplaceOneAsync(
                    e => e.Id == entry.Id, entry, cancellationToken: CancellationToken.None);
            }

            // 同步后的新正文也快照成版本，保证「最新版本 == 当前正文」（去重避免重复落库）
            if (versions != null)
                await versions.SnapshotAsync(entry.Id, entry.StoreId, content,
                    DocumentVersionSource.Sync, entry.UpdatedBy ?? entry.CreatedBy, entry.UpdatedByName ?? entry.CreatedByName, ct: CancellationToken.None);

            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // 服务停机不是「这个文件拉不下来」。吞成失败的话，父条目会带着 HasFailures 收尾、
            // 写一条用户看得见的同步错误并推进 LastSyncAt——按天调度于是要等到次日才再碰它。
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[GitHubSync] Failed to sync file {Path}", file.Path);
            return false;
        }
    }

    /// <summary>
    /// 从存量条目存着的 GitHub 地址里抠出仓库内路径。
    ///
    /// 早期条目没有单独存路径，只存了地址，而地址里嵌着一个 ref（分支名或提交号）。
    /// 一旦列目录改成按提交号列，上游给回的地址也换成带提交号的那种，
    /// 逐字符比对地址就再也认不出同一个文件——于是它会被当成新文件建一遍，
    /// 原来那条被当成「远端已不存在」删掉，连历史版本一起没。
    /// 所以认亲要认**路径**，不认地址里那一段会变的 ref。
    ///
    /// 认两种形状：raw 域名的 {owner}/{repo}/{ref}/{path}，以及网页端的 {owner}/{repo}/blob/{ref}/{path}。
    /// 认不出来就返回 null，调用方仍用原地址当键（至少不会更糟）。
    /// </summary>
    internal static string? ExtractRepoPathFromGitHubUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return null;

        var segments = uri.AbsolutePath.Trim('/').Split('/');
        // raw：owner/repo/ref/path...   网页端：owner/repo/blob/ref/path...
        var skip = segments.Length > 2 && segments[2].Equals("blob", StringComparison.OrdinalIgnoreCase) ? 4 : 3;
        if (segments.Length <= skip) return null;

        var path = string.Join('/', segments.Skip(skip));
        return string.IsNullOrWhiteSpace(path) ? null : Uri.UnescapeDataString(path);
    }

    /// <summary>
    /// 给已存在的子条目编去重键。
    ///
    /// 键用仓库内路径：私有仓的下载地址每次列目录都会带一个新的临时凭据查询串，
    /// 而按提交号列目录时地址里还会换上提交号——拿地址当键，「同一个文件」每轮都会被判成
    /// 「新增 + 删除」，历史版本一起没。
    ///
    /// 存量条目（早期没单独存路径）先试着从它存的地址里抠出路径，抠不出来才退回用原地址当键。
    /// 一条条目可能同时挂在两个键上（抠出的路径 + 原地址），这是有意的：哪个键先认上都算认上。
    /// 两样都没有的条目不进索引：它认不了亲，也就不该被当成「远端已不存在」删掉。
    /// </summary>
    internal static Dictionary<string, DocumentEntry> IndexExistingChildren(
        IEnumerable<DocumentEntry> existingEntries)
    {
        var indexed = new Dictionary<string, DocumentEntry>(StringComparer.Ordinal);
        foreach (var e in existingEntries)
        {
            var githubPath = e.Metadata.GetValueOrDefault("github_path", "");
            if (!string.IsNullOrEmpty(githubPath))
            {
                indexed[githubPath] = e;
                continue;
            }

            var derivedPath = ExtractRepoPathFromGitHubUrl(e.SourceUrl);
            if (!string.IsNullOrEmpty(derivedPath)) indexed[derivedPath] = e;

            var legacyUrl = e.SourceUrl ?? "";
            if (legacyUrl.Length > 0) indexed[legacyUrl] = e;
        }
        return indexed;
    }

    /// <summary>
    /// 本轮没在远端见到的子条目 —— 它们就是要删的那批。
    ///
    /// 判据只有一条：这一轮列目录时**这条条目的任何一个键**都没被认到。
    /// 按条目去重：一条条目可能同时挂在两个键上（存量条目的路径与原地址），
    /// 只要其中一个被认上就不算失联；也保证同一条不会被删两次、计数不会翻倍。
    ///
    /// **远端一篇都没剩下时，这里返回全部**，因为「目录被清空」和「目录里的文件被逐个删光」
    /// 对用户是同一件事，产物都该跟着消失。调用方不得在 files 为空时跳过这一步。
    /// </summary>
    internal static List<DocumentEntry> SelectStaleChildren(
        IReadOnlyDictionary<string, DocumentEntry> existingByKey,
        IReadOnlySet<string> processedKeys)
    {
        var seenIds = new HashSet<string>(
            existingByKey.Where(kv => processedKeys.Contains(kv.Key)).Select(kv => kv.Value.Id),
            StringComparer.Ordinal);

        var stale = new List<DocumentEntry>();
        var added = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in existingByKey.Values)
        {
            if (seenIds.Contains(entry.Id)) continue;
            if (!added.Add(entry.Id)) continue;
            stale.Add(entry);
        }
        return stale;
    }

    /// <summary>GitHub 目录接口一次最多回多少条：超过就截断，而且它不会明说截断了。</summary>
    internal const int ContentsApiDirectoryCap = 1000;

    /// <summary>
    /// 这份目录清单能不能代表远端的全部。
    ///
    /// 判据看**过滤前**的原始条数：到了上限就说明可能还有没回来的，
    /// 「这一轮没见到」于是不再等于「远端没有了」，删除环节必须让路。
    /// 过滤后的条数不能用来判断——它天然会因为非 Markdown 文件而变少。
    /// </summary>
    internal static bool IsListingComplete(int rawEntryCount) => rawEntryCount < ContentsApiDirectoryCap;

    /// <summary>
    /// 一次列目录的结果：过滤后的文件清单，以及这份清单是否代表远端的全部。
    ///
    /// 必须是 private：它带着 <see cref="GitHubFile"/>（private 嵌套类），
    /// 声明成 internal 会让构造函数暴露一个可访问性更低的类型（CS0051）。
    /// 它只在本类内部流转，测试打的是 <see cref="IsListingComplete"/> 那条判据，不需要这个类型。
    /// </summary>
    /// <summary>
    /// 本轮实际用的 ref：解析成功就是提交号，否则是分支名。
    /// 取内容、取最近修改时间都要用它，否则「清单来自提交 A、正文取自提交 B」，
    /// 会把 B 的正文按 A 的版本号存起来，直到下次同步都对不上。
    /// </summary>
    private sealed record DirectoryListing(List<GitHubFile> Files, bool Complete, PinnedRef Reference);

    /// <summary>
    /// 目录列不出来（404）时，能不能当成「远端把它删光了」去调和。
    ///
    /// 只看一件事：是不是 404。因为走到这一步时，**本轮必然是按已解析的提交号列的**——
    /// 解析不出提交号那一轮已经中止了。提交号不可变：在它上面拿到 404，
    /// 就证明那一刻该目录确实不存在；而解析这一步本身已经证明仓库与分支都够得着。
    /// <summary>
    /// 这个目录到底在不在——只认**正面证据**：上一级目录在同一个提交上列得出来，
    /// 而它的清单里没有这一级。不接受「404 多半就是删了」这种推断。
    /// </summary>
    internal enum PathAbsence
    {
        /// <summary>上一级列得出来，清单里没有它：确实没了。</summary>
        ProvenAbsent,
        /// <summary>上一级列得出来，清单里有它：那条 404 另有来路，不许删。</summary>
        ProvenPresent,
        /// <summary>没能取得证据（读不到、清单可能被截断、网络不通）：一律不许删。</summary>
        Unproven,
    }

    /// <summary>
    /// 「远端删光了」的唯一判据：列目录拿到 404，**并且**有正面证据说明它确实不在。
    ///
    /// 为什么不能只看 404：GitHub 对「无权访问的私有仓」回的也是 404，和「目录真没了」逐字一样。
    /// 为什么不能只补一次「此刻还读得到吗」：那证明的是「仓库读得到」，不是「这个路径不存在」——
    /// 两次请求之间授权抖一下，探测照样成功，而那条 404 其实是权限造成的。
    /// 所以证据必须和结论说的是同一件事：**上一级的清单里没有它**。
    /// </summary>
    internal static bool ShouldReconcileAsEmpty(HttpStatusCode directoryStatus, PathAbsence absence)
        => directoryStatus == HttpStatusCode.NotFound && absence == PathAbsence.ProvenAbsent;

    /// <summary>
    /// Contents 接口对**目录**回数组、对**文件**回对象。两处读它的地方共用这一条判别：
    /// 少判一次的后果是直接把对象当数组遍历，抛异常、整轮同步失败，而真相只是
    /// 「那个目录被同名文件顶替了」——那本该是一条可以调和的结论。
    /// </summary>
    internal static bool IsDirectoryPayload(JsonValueKind rootKind) => rootKind == JsonValueKind.Array;

    /// <summary>父路径：`a/b` → `a`，`a` → 仓库根（空串），仓库根本身 → null（无处可上溯）。</summary>
    internal static string? ParentPathOf(string path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        var i = path.LastIndexOf('/');
        return i < 0 ? "" : path[..i];
    }

    /// <summary>路径最后一段的名字：`a/b` → `b`。</summary>
    internal static string NameOf(string path)
    {
        var i = path.LastIndexOf('/');
        return i < 0 ? path : path[(i + 1)..];
    }

    /// <summary>
    /// 本轮定住的那个提交号。做成独立类型而不是裸 string，是因为「这一轮所有读取共用同一份快照」
    /// 这条不变量此前只能靠一条扫源码的守卫盯着——重命名一下它就假红，而某个新写的辅助函数
    /// 改传分支名它又照样绿。换成类型之后，把分支名塞进任何一个要提交号的位置都编译不过，
    /// 那条守卫也就可以删掉了：能用类型表达的不变量，不许降级成测试断言。
    /// </summary>
    internal readonly record struct PinnedRef(string CommitSha)
    {
        public override string ToString() => CommitSha;
    }

    /// <summary>解析 ref 的请求地址。纯函数：测试直接断言它吐出来的地址，不去扫源码字面量。</summary>
    internal static string BuildRefResolveUrl(string owner, string repo, string reference)
        // /commits/{ref} 对分支、标签、提交号一视同仁；/branches/{ref} 只认分支，
        // 那会让按标签或提交号订阅的目录再也同步不了。
        => $"https://api.github.com/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}"
         + $"/commits/{Uri.EscapeDataString(reference)}";

    /// <summary>列目录的请求地址。路径要逐段转义：目录名里合法的 # 会被当成片段、? 会被当成查询串。</summary>
    internal static string BuildContentsUrl(string owner, string repo, string path, PinnedRef reference)
    {
        var safePath = Uri.EscapeDataString(path).Replace("%2F", "/", StringComparison.Ordinal);
        return $"https://api.github.com/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}"
             + $"/contents/{safePath}?ref={Uri.EscapeDataString(reference.CommitSha)}";
    }

    /// <summary>
    /// 把一个 ref 解析成它此刻指向的提交号，顺带证明这个仓库此刻读得到。
    /// ref 可以是分支名、标签名，也可以是提交号本身——订阅地址里 /tree/ 后面那一段
    /// 允许是其中任意一种，只认分支会让按标签订阅的目录再也同步不了。
    /// 拿不到提交号（状态码非 200、响应缺字段、网络出错）一律回 null，调用方据此决定停还是走。
    /// </summary>
    /// <summary>
    /// 一次 GitHub 请求失败的完整口径。**唯一构造入口是 From(response)**，所以限额判据
    /// 不可能被漏掉——此前三处失败各自决定要不要带限额信息，漏了两次，两次都让用户看到
    /// 「没有读取权限」而真正该做的是「等到几点几分再试」。能用类型挡住的，不留给下一个人记。
    /// </summary>
    private readonly record struct GitHubFailure(HttpStatusCode Status, bool RateLimited, string? ResetHint)
    {
        public static GitHubFailure From(HttpResponseMessage response) => new(
            response.StatusCode,
            GitHubRateLimit.IsExhausted(response),
            GitHubRateLimit.ResetHint(response));
    }

    /// <summary>解析 ref 的结果：要么拿到提交号，要么带着一份完整的失败口径。</summary>
    private readonly record struct RefResolution(string? CommitSha, GitHubFailure? Failure)
    {
        /// <summary>上游明确答复了，只是没给出可用的提交号（网络层出错时连答复都没有）。</summary>
        public bool AnsweredButUnusable => CommitSha == null && Failure.HasValue;
    }

    /// <summary>取证的结果：结论 + 万一是因为失败而没有结论，那份失败的完整口径。</summary>
    private readonly record struct AbsenceProof(PathAbsence Outcome, GitHubFailure? Failure = null);

    /// <summary>上溯到的那一级长什么样。四种各有各的处置，不许压成「成功 / 失败」两档。</summary>
    private enum AncestorKind
    {
        /// <summary>它是个目录，清单拿到了。</summary>
        Listed,
        /// <summary>它是个**文件**——那么它下面不可能还有东西，目标必然不存在。</summary>
        IsFile,
        /// <summary>这一级也不在，继续往上找。</summary>
        NotFound,
        /// <summary>没问出结论（限额、权限、故障、网络）。</summary>
        Failed,
    }

    private readonly record struct AncestorListing(
        AncestorKind Kind, List<string>? Names = null, bool Complete = false, GitHubFailure? Failure = null);

    private async Task<RefResolution> ResolveRefCommitAsync(
        string owner, string repo, string reference, string? accessToken, CancellationToken ct)
    {
        try
        {
            // /commits/{ref} 对分支、标签、提交号一视同仁；/branches/{ref} 只认分支。
            using var request = BuildApiRequest(BuildRefResolveUrl(owner, repo, reference), accessToken);
            using var response = await Http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning(
                    "[GitHubSync] 解析 {Owner}/{Repo}@{Ref} 的提交号失败：{Status}",
                    owner, repo, reference, (int)response.StatusCode);
                return new RefResolution(null, GitHubFailure.From(response));
            }

            var json = await response.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);
            var sha = doc.RootElement.TryGetProperty("sha", out var shaElement)
                ? shaElement.GetString()
                : null;
            return new RefResolution(string.IsNullOrWhiteSpace(sha) ? null : sha, Failure: null);

        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // 服务停机不是「没问出结论」：吞掉会让上游把它翻成一次用户可见的同步失败，
            // 条目标红、下次调度推到次日，而真相只是这轮被打断了。交给 worker 的停机分支。
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        {
            // 走到这里的 OperationCanceledException 是 HttpClient 自己的超时（ct 没被取消）。
            // 网络层出错：上游一个字都没答，所以没有状态码可交。
            _logger.LogWarning(ex, "[GitHubSync] 解析 {Owner}/{Repo}@{Ref} 的提交号失败", owner, repo, reference);
            return new RefResolution(null, Failure: null);
        }
    }

    /// <summary>
    /// 取「这个路径确实不在」的正面证据：从目标逐级上溯，找第一个**在同一个提交上列得出来**的祖先，
    /// 看它的清单里有没有下一级。
    ///
    /// 为什么这样才算证据：祖先列得出来，说明此刻确实读得到这个仓库的内容、读的又是同一个提交，
    /// 于是「清单里没有它」说的就是「它不存在」，而不是「我们看不见」。
    /// 一路上溯到仓库根都列不出来，那只能说明读不到——仓库根不会「被删掉」。
    ///
    /// 清单可能被上游截断（一次最多一千条且不明说）时一律判为没有结论：
    /// 没看见 ≠ 不存在，而这条结论下一步就是删东西。
    /// </summary>
    private async Task<AbsenceProof> ProvePathAbsentAsync(
        string owner, string repo, string path, PinnedRef reference, string? accessToken, CancellationToken ct)
    {
        var target = path;
        while (true)
        {
            var parent = ParentPathOf(target);
            if (parent == null) return new AbsenceProof(PathAbsence.Unproven);

            var ancestor = await TryListEntryNamesAsync(owner, repo, parent, reference, accessToken, ct);

            switch (ancestor.Kind)
            {
                case AncestorKind.NotFound:
                    // 上一级也不在：接着往上找一个列得出来的。
                    target = parent;
                    continue;

                case AncestorKind.IsFile:
                    // 上一级是个文件。文件下面不可能挂着目录，所以目标在这个提交上必然不存在——
                    // 这同样是正面证据（目录被同名文件顶替掉是真实会发生的一种删除）。
                    return new AbsenceProof(PathAbsence.ProvenAbsent);

                case AncestorKind.Listed:
                    // 清单可能被上游截断时不作数：没看见不等于不存在。
                    if (!ancestor.Complete || ancestor.Names == null) return new AbsenceProof(PathAbsence.Unproven);
                    return new AbsenceProof(ancestor.Names.Contains(NameOf(target), StringComparer.Ordinal)
                        ? PathAbsence.ProvenPresent
                        : PathAbsence.ProvenAbsent);

                default:
                    // 没问出结论时把失败口径一起交上去：取证这一步撞上限额，用户该看到的是
                    // 「等到几点几分再试」，而不是最初那条 404 翻出来的「找不到 / 没有权限」。
                    return new AbsenceProof(PathAbsence.Unproven, ancestor.Failure);
            }
        }
    }

    /// <summary>
    /// 列出某个目录下每一项的名字。只为取证用，所以失败一律如实回空，不抛也不猜。
    /// complete 复用与主清单同一条完整性判据（看过滤前的原始条数），免得两处各判一次然后漂。
    /// </summary>
    private async Task<AncestorListing> TryListEntryNamesAsync(
        string owner, string repo, string path, PinnedRef reference, string? accessToken, CancellationToken ct)
    {
        try
        {
            using var request = BuildApiRequest(BuildContentsUrl(owner, repo, path, reference), accessToken);
            using var response = await Http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                return new AncestorListing(
                    response.StatusCode == HttpStatusCode.NotFound ? AncestorKind.NotFound : AncestorKind.Failed,
                    Failure: GitHubFailure.From(response));
            }

            var json = await response.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);
            // 目标是目录时上游回数组；回对象说明这一级是文件，那它就没有「下一级」可言。
            // 上游对目录回数组、对文件回对象。回对象说明这一级是个文件——这不是失败，
            // 是一条结论；把它当失败会拼出「读取失败（状态 200）」这种自相矛盾的话，
            // 还会让「目录被同名文件顶替」这种真实的删除永远调和不掉。
            if (!IsDirectoryPayload(doc.RootElement.ValueKind)) return new AncestorListing(AncestorKind.IsFile);

            var names = doc.RootElement.EnumerateArray()
                .Select(e => e.TryGetProperty("name", out var n) ? n.GetString() : null)
                .Where(n => !string.IsNullOrEmpty(n))
                .Select(n => n!)
                .ToList();
            return new AncestorListing(
                AncestorKind.Listed, names, IsListingComplete(doc.RootElement.GetArrayLength()));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException)
        {
            _logger.LogWarning(ex, "[GitHubSync] 取证时列 {Owner}/{Repo}/{Path} 失败", owner, repo, path);
            return new AncestorListing(AncestorKind.Failed);
        }
    }

    /// <summary>调用 GitHub Contents API 获取目录下的文件列表</summary>
    private async Task<DirectoryListing> ListDirectoryFilesAsync(
        string owner, string repo, string path, string branch, Matcher? matcher,
        string? accessToken, CancellationToken ct)
    {
        // 先把 ref（分支 / 标签 / 提交号都可能）解析成一个**不可变的提交号**，本轮所有读取都按它来，
        // 这样清单、正文、版本号一定来自同一份快照，不会「清单来自一个提交、正文来自另一个」。
        //
        // 但要认清它定住的是什么：它定住了**内容的版本**，定不住**授权**。所以在提交号上拿到 404
        // 仍不足以断定目录没了——删之前还要再探一次「此刻读不读得到这个仓库」，见下面那段。
        //
        // 解析不出来就**整轮中止**，不退回按分支名跑。退路看着体贴，实则让本轮承诺的
        // 「读取共用同一份快照」在那条路上不成立：一轮同步可能跑几分钟，期间分支往前走一步，
        // 清单与版本号来自旧提交、正文却取自新提交，于是新内容被按旧版本号存起来，
        // 下轮比版本号没变就跳过——正文和它自称的版本会一直对不上。
        // 中止是可恢复的：条目标红说明原因，用户点「重试同步」或等下一轮调度即可。
        var resolved = await ResolveRefCommitAsync(owner, repo, branch, accessToken, ct);
        if (resolved.CommitSha == null)
        {
            // 失败文案只有一个出处（DescribeListFailure）：它已经分得清「带授权的找不到」
            // 和「匿名访问私有仓」，在这儿另写一句必然和它漂。上游连状态码都没给（网络层出错）
            // 才用兜底那句——那种情况下没有任何可归因的上游答复。
            throw new GitHubSyncUserFacingException(resolved.AnsweredButUnusable
                ? Describe(resolved.Failure!.Value, accessToken, owner, repo, path, branch)
                : "暂时连不上 GitHub，本轮先不同步以免存进不一致的内容。稍后点「重试同步」即可。");
        }

        var commitSha = resolved.CommitSha!;
        var reference = new PinnedRef(commitSha);

        using var request = BuildApiRequest(BuildContentsUrl(owner, repo, path, reference), accessToken);
        var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
        {
            // 目录整个消失是**最常见的一种删除**：Git 里没有空目录，删光最后一个文件，
            // 目录本身就不存在了，这里拿到的是 404 而不是「200 + 空清单」。
            // 但 GitHub 对「无权访问」「仓库改名」「分支被删」返回的同样是 404，
            // 所以先确认仓库与这个分支还够得着——够得着才敢把它当成「远端删光了」去调和，
            // 否则一次权限变动就会把用户已导入的文档全删掉。
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                // 这条 404 有两种来路，长得一模一样：目录真没了，或者我们读不到这个仓库。
                // 分辨它不能靠「再确认一次仓库读得到」——那证明的是仓库，不是这个路径：
                // 两次请求之间授权抖一下，确认照样通过，而那条 404 其实是权限造成的。
                // 所以去取一份说的是同一件事的**正面证据**：上一级目录的清单里有没有它。
                var proof = await ProvePathAbsentAsync(owner, repo, path, reference, accessToken, ct);

                if (ShouldReconcileAsEmpty(response.StatusCode, proof.Outcome))
                {
                    _logger.LogInformation(
                        "[GitHubSync] {Owner}/{Repo}/{Path} 已不在提交 {Commit} 的上级清单里：按「远端删光了」调和",
                        owner, repo, path, commitSha);
                    // 目录在那个提交上压根不存在，不存在「只回了一部分」的可能，所以这份空清单是完整的
                    return new DirectoryListing(new List<GitHubFile>(), Complete: true, Reference: reference);
                }

                _logger.LogWarning(
                    "[GitHubSync] {Owner}/{Repo}/{Path} 列目录 404，但拿不到「它确实没了」的证据（{Absence}）：不调和、按失败处理",
                    owner, repo, path, proof.Outcome);
                // 取证自己也失败了（限额、权限、故障）就报它：那才是这一轮真正拦住我们的东西，
                // 最初那条 404 翻出来的「找不到 / 没有权限」会把用户引去查错方向。
                throw new GitHubSyncUserFacingException(Describe(
                    proof.Failure ?? GitHubFailure.From(response), accessToken, owner, repo, path, branch));
            }

            var body = await response.Content.ReadAsStringAsync(ct);
            // 上游正文只进服务端日志：它会被 worker 存进 SyncError 并原样渲染在目录卡片上，
            // 里面是协议 JSON 与文档链接，对用户既不可读也不可行动（external-cause-first）。
            _logger.LogWarning(
                "[GitHubSync] List {Owner}/{Repo}/{Path}@{Branch} failed: status={Status} body={Body}",
                owner, repo, path, branch, (int)response.StatusCode, body);
            // 限额判定交给共用的 GitHubRateLimit（看 X-RateLimit-Remaining 头），
            // 不再自己在正文里找 "rate limit" 字样——同一件事两份判据必然漂（形状 3）。
            // GitHubSyncUserFacingException：DescribeListFailure 产出的就是可执行文案，
            // 声明它可以原样给用户看；其余异常一律走 GitHubSyncFailureMessage 兜底翻译
            throw new GitHubSyncUserFacingException(Describe(
                GitHubFailure.From(response), accessToken, owner, repo, path, branch));
        }

        var json = await response.Content.ReadAsStringAsync(ct);
        var doc = JsonDocument.Parse(json);

        // 订阅的这个路径自己变成了文件（有人把目录换成了同名文件）：上游回的是 200 + 对象，
        // 不是上面处理的 404。直接拿去遍历数组会抛异常、整轮同步失败、旧子文档永远留着，
        // 而这份 200 恰恰是「这个目录在这个提交上不存在了」的正面证据——照「远端删光了」调和。
        if (!IsDirectoryPayload(doc.RootElement.ValueKind))
        {
            _logger.LogInformation(
                "[GitHubSync] {Owner}/{Repo}/{Path} 在提交 {Commit} 上是个文件而不是目录：按「远端删光了」调和",
                owner, repo, path, commitSha);
            return new DirectoryListing(new List<GitHubFile>(), Complete: true, Reference: reference);
        }

        var rawCount = 0;
        var files = new List<GitHubFile>();
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            rawCount++;
            var type = item.GetProperty("type").GetString();
            if (type != "file") continue;

            var name = item.GetProperty("name").GetString() ?? "";
            // 可导入后缀与目录规划器共用同一个判据，避免「勾上了却同步出 0 篇」
            if (!GitHubDocDirectoryPlanner.IsSyncableMarkdown(name)) continue;

            // Glob 匹配（如匹配失败则丢弃）
            if (matcher != null && !matcher.Match(name).HasMatches) continue;

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

        // 完整性看**过滤前**的原始条数：过滤后的 0 篇既可能是「真没有 Markdown」，
        // 也可能是「Markdown 全被挤出了窗口」，只有原始条数才分得开这两件事。
        return new DirectoryListing(files, IsListingComplete(rawCount), reference);
    }

    /// <summary>
    /// 查询单个文件在指定分支上的最近一次 commit 时间。
    /// GitHub Commits API: GET /repos/:owner/:repo/commits?path=:path&sha=:branch&per_page=1
    /// 返回 UTC DateTime；失败/无结果返回 null（不抛异常，避免影响主同步流程）。
    /// </summary>
    private async Task<DateTime?> GetLatestCommitDateAsync(
        string owner, string repo, string path, PinnedRef reference, string? accessToken, CancellationToken ct)
    {
        try
        {
            var url = $"https://api.github.com/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/commits"
                    + $"?path={Uri.EscapeDataString(path)}&sha={Uri.EscapeDataString(reference.CommitSha)}&per_page=1";
            using var request = BuildApiRequest(url, accessToken);
            var response = await Http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug("[GitHubSync] commits API {Code} for {Path}", response.StatusCode, path);
                return null;
            }

            var json = await response.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array || doc.RootElement.GetArrayLength() == 0)
            {
                return null;
            }

            var first = doc.RootElement[0];
            if (!first.TryGetProperty("commit", out var commit)) return null;

            // 优先 committer.date（提交入仓时间），兜底 author.date（原始作者时间）
            if (commit.TryGetProperty("committer", out var committer)
                && committer.TryGetProperty("date", out var committerDate)
                && DateTime.TryParse(committerDate.GetString(), out var dtCommitter))
            {
                return dtCommitter.ToUniversalTime();
            }
            if (commit.TryGetProperty("author", out var author)
                && author.TryGetProperty("date", out var authorDate)
                && DateTime.TryParse(authorDate.GetString(), out var dtAuthor))
            {
                return dtAuthor.ToUniversalTime();
            }
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "[GitHubSync] fetch commit date failed for {Path}", path);
            return null;
        }
    }

    /// <summary>
    /// 把列目录失败翻译成一句「说清是谁的问题、下一步做什么」的话。
    ///
    /// 404 是这里最容易骗人的一个码：GitHub 对**无权访问的私有仓**返回的不是 403 而是 404，
    /// 和「目录真的不存在」长得一模一样。所以必须把「这次带没带授权」一起说出来，
    /// 否则用户看到的就是一句无法行动的 "Not Found"。
    /// </summary>
    /// <summary>把一份失败口径翻成用户能照着做的一句话。文案本体仍在 DescribeListFailure。</summary>
    private static string Describe(
        GitHubFailure failure, string? accessToken, string owner, string repo, string path, string branch)
        => DescribeListFailure(failure.Status, accessToken, owner, repo, path, branch,
            rateLimited: failure.RateLimited, resetHint: failure.ResetHint);

    private static string DescribeListFailure(
        System.Net.HttpStatusCode status, string? accessToken,
        string owner, string repo, string path, string branch,
        bool rateLimited = false, string? resetHint = null)
    {
        var target = $"{owner}/{repo}/{(string.IsNullOrEmpty(path) ? "/" : path)}@{branch}";
        var authed = !string.IsNullOrEmpty(accessToken);
        var retryAt = resetHint != null ? $"请在 {resetHint} 后重试。" : "请稍后重试。";

        // 限额先判：GitHub 把「额度耗尽」同时报成 403 和 429，
        // 落到下面的 403/默认分支就会变成「拒绝访问」或一串原始状态码，两种都不可行动。
        if (rateLimited || (int)status == 429)
        {
            return authed
                ? $"GitHub 调用频率已达上限（已使用授权额度）。{retryAt}"
                : $"GitHub 匿名调用频率已达上限（每小时 60 次）。请在知识库里连接 GitHub 账号，额度会提到每小时 5000 次；{retryAt}";
        }

        return status switch
        {
            System.Net.HttpStatusCode.NotFound when authed =>
                $"GitHub 找不到 {target}：可能是目录或分支已删除，也可能是这个 GitHub 账号对该仓库没有读取权限"
                + "（私有仓需要授权时勾选 repo 权限）。",
            System.Net.HttpStatusCode.NotFound =>
                $"GitHub 找不到 {target}：本次是**匿名**访问，私有仓在匿名下一律返回找不到。"
                + "请在知识库里连接 GitHub 账号后重试。",
            System.Net.HttpStatusCode.Unauthorized =>
                "GitHub 授权已失效，请在知识库里重新连接 GitHub 账号后再试。",
            System.Net.HttpStatusCode.Forbidden =>
                $"GitHub 拒绝访问 {target}：请确认该 GitHub 账号对此仓库有读取权限。",
            // 未分类的状态码（422 / 5xx 等）：只给可行动的一句，正文已经进了服务端日志
            _ => $"GitHub 读取 {target} 失败（状态 {(int)status}），请稍后重试；若持续失败请联系管理员查看服务端日志。",
        };
    }

    /// <summary>
    /// 构造一个指向 api.github.com 的请求；有 token 就带上 Authorization。
    /// 只对 api.github.com 加凭据 —— 其它主机（raw.githubusercontent.com）一律不带。
    /// </summary>
    private static HttpRequestMessage BuildApiRequest(string url, string? accessToken, string? accept = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (!string.IsNullOrEmpty(accessToken)
            && string.Equals(request.RequestUri?.Host, "api.github.com", StringComparison.OrdinalIgnoreCase))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        }
        if (!string.IsNullOrEmpty(accept))
        {
            request.Headers.Accept.Clear();
            request.Headers.Accept.ParseAdd(accept);
        }
        return request;
    }

    /// <summary>
    /// 子条目对外展示的来源地址：GitHub 网页上这个文件的稳定地址。
    ///
    /// **不能存 download_url**：私有仓的那串地址带着几分钟就失效的临时凭据，
    /// 存下来等于（其一）把凭据留在库里和界面上，（其二）用户过一会儿点开就是个死链。
    /// 正文一直是走 Contents API 现取的，从不读这个字段，所以这里只管「人点得开」。
    /// </summary>
    /// <summary>
    /// 条目上存给用户点的那个地址。
    ///
    /// 这里**刻意用分支名而不是提交号**：它是给人看的链接，指向分支才会随文档更新而更新；
    /// 钉到提交号会让它永远停在导入那一刻的旧版本。与「读取一律钉提交号」不冲突——
    /// 那是为了同一轮内取到同一份快照，这是为了链接长期有效。
    /// </summary>
    private static string BuildBlobUrl(string owner, string repo, string branch, string path)
        => $"https://github.com/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}"
         + $"/blob/{Uri.EscapeDataString(branch)}/"
         + Uri.EscapeDataString(path).Replace("%2F", "/", StringComparison.Ordinal);

    /// <summary>
    /// 取单个文件正文。已连接走 Contents API 的 raw 媒体类型（私有仓可读、地址稳定不带临时 token），
    /// 未连接沿用历史的 download_url。
    /// </summary>
    private async Task<string> FetchFileContentAsync(
        GitHubFile file, string owner, string repo, PinnedRef reference, string? accessToken, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(accessToken))
        {
            return await Http.GetStringAsync(file.DownloadUrl, ct);
        }

        // 和列目录共用同一个地址构造：此前这里自己拼了一遍，于是「路径逐段转义」这条规矩
        // 在两处各写了一份（形状 3），而参数名一改就露出它还在用旧的那个变量。
        var url = BuildContentsUrl(owner, repo, file.Path, reference);
        using var request = BuildApiRequest(url, accessToken, "application/vnd.github.raw");
        using var response = await Http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(ct);
    }

    /// <summary>解析 GitHub 仓库地址，提取 owner/repo/path/branch</summary>
    public static (string owner, string repo, string path, string branch) ParseGitHubUrl(string url)
    {
        // 支持格式：
        // https://github.com/owner/repo/tree/branch/path/to/dir
        // https://github.com/owner/repo
        var uri = new Uri(url);
        // AbsolutePath 保留百分号转义（空格是 %20、# 是 %23）。必须先解回来：
        // 存进条目的路径口径是**未转义的原始路径**（扫描器给的就是这种），
        // 发请求时再统一转义一次。不解就会被二次转义成 %2520，打到一个不存在的目录上。
        var segments = uri.AbsolutePath.Trim('/')
            .Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Select(Uri.UnescapeDataString)
            .ToArray();

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

    /// <summary>本轮有多少个文件没能拉下来（限流、401、超时…）。</summary>
    public int FailedCount { get; set; }

    /// <summary>
    /// 这一轮的目录清单可能被上游截断，因此**跳过了删除环节**。
    /// 记下来是为了让「这轮一条没删」有据可查：否则远端确实删了东西而这边没动，
    /// 看起来会像同步坏了（external-cause-first：说得出为什么没动）。
    /// </summary>
    public bool ListingIncomplete { get; set; }

    /// <summary>失败文件的路径样本，写进 SyncError 让用户知道缺了什么。</summary>
    public List<string> FailedPaths { get; set; } = new();

    public List<DocumentSyncFileChange> FileChanges { get; set; } = new();

    public bool HasChanges => AddedCount > 0 || UpdatedCount > 0 || DeletedCount > 0;

    /// <summary>有文件没拉下来。</summary>
    public bool HasFailures => FailedCount > 0;

    /// <summary>
    /// 这一轮**没把承诺的事做完**，调用方必须据此把父条目标红，而不是照常标 idle。
    ///
    /// 两种来路，后果对用户是同一件事——界面显示的内容和远端对不上：
    /// 有文件没拉下来（少了几篇），或清单被截断因而跳过了删除（多出几篇远端已经没有的）。
    /// 任一情况被一个绿色的成功状态盖住，都是形状 10 的静默降级。
    /// </summary>
    public bool NeedsAttention => HasFailures || ListingIncomplete;

    /// <summary>给用户看的描述：发生了什么 + 下一步怎么办（两种来路都可能同时出现）。</summary>
    public string BuildFailureMessage()
    {
        var parts = new List<string>();

        if (HasFailures)
        {
            var sample = string.Join("、", FailedPaths.Take(3));
            var more = FailedPaths.Count > 3 ? $" 等 {FailedPaths.Count} 个文件" : "";
            parts.Add($"有 {FailedCount} 篇文档没有拉取成功（{sample}{more}）。"
                    + "常见原因是 GitHub 调用频率超限或授权失效；已同步的部分已保留，可稍后点「重试同步」补齐。");
        }

        if (ListingIncomplete)
        {
            parts.Add($"这个目录的条目数超过了 GitHub 一次能返回的上限（{GitHubDirectorySyncService.ContentsApiDirectoryCap} 条），"
                    + "本轮只做了新增与更新、没有处理删除——远端已经删掉的文档在这里可能仍然可见。"
                    + "把目录拆细，或清掉目录里无关的文件之后再同步即可恢复。");
        }

        return string.Join(" ", parts);
    }

    public string BuildSummary()
    {
        var parts = new List<string>();
        if (AddedCount > 0) parts.Add($"+{AddedCount} 新增");
        if (UpdatedCount > 0) parts.Add($"~{UpdatedCount} 修改");
        if (DeletedCount > 0) parts.Add($"-{DeletedCount} 删除");
        return parts.Count > 0 ? string.Join(" / ", parts) : "无变化";
    }
}
