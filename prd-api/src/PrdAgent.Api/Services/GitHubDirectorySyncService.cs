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
                        var backfillDate = await GetLatestCommitDateAsync(owner, repo, file.Path, branch, accessToken, ct);
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
                var updated = await SyncSingleFileAsync(db, documentService, versions, existing, file, owner, repo, branch, accessToken, ct);
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

                var added = await SyncSingleFileAsync(db, documentService, versions, entry, file, owner, repo, branch, accessToken, ct, isNew: true);
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
        string? accessToken,
        CancellationToken ct,
        bool isNew = false)
    {
        // 拉 git 最后提交时间（用来驱动前端显示的时间 + "NEW" 徽标）。
        // 和文件内容拉取并行，不把网络往返叠加在同步延迟上。
        var commitDateTask = GetLatestCommitDateAsync(owner, repo, file.Path, branch, accessToken, ct);
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
            var content = await FetchFileContentAsync(file, owner, repo, branch, accessToken, ct);

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
    /// 给已存在的子条目编去重键。
    ///
    /// 键用仓库内路径，而不是 download_url —— 私有仓的 download_url 每次列目录都会带一个新的
    /// 临时 token 查询串，拿它当键会让「同一个文件」每轮同步都被判成"新增 + 删除"，历史版本一起没。
    /// 存量条目（早期没写 github_path）用 SourceUrl 兜底，避免升级当天全量重建。
    /// 两者都没有的条目不进索引：它认不了亲，也就不该被当成"远端已不存在"删掉。
    /// </summary>
    internal static Dictionary<string, DocumentEntry> IndexExistingChildren(
        IEnumerable<DocumentEntry> existingEntries)
    {
        var indexed = new Dictionary<string, DocumentEntry>(StringComparer.Ordinal);
        foreach (var e in existingEntries)
        {
            var key = e.Metadata.GetValueOrDefault("github_path", "");
            if (string.IsNullOrEmpty(key)) key = e.SourceUrl ?? "";
            if (key.Length == 0) continue;
            indexed[key] = e;
        }
        return indexed;
    }

    /// <summary>
    /// 本轮没在远端见到的子条目 —— 它们就是要删的那批。
    ///
    /// 判据只有一条：这一轮列目录时没认到亲。**远端一篇都没剩下时，这里返回全部**，
    /// 因为"目录被清空"和"目录里的文件被逐个删光"对用户是同一件事，产物都该跟着消失。
    /// 调用方不得在 files 为空时跳过这一步（那正是 2026-09-15 对抗审查发现的洞）。
    /// </summary>
    internal static List<DocumentEntry> SelectStaleChildren(
        IReadOnlyDictionary<string, DocumentEntry> existingByKey,
        IReadOnlySet<string> processedKeys)
        => existingByKey
            .Where(kv => !processedKeys.Contains(kv.Key))
            .Select(kv => kv.Value)
            .ToList();

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
    private sealed record DirectoryListing(List<GitHubFile> Files, bool Complete);

    /// <summary>
    /// 目录列不出来（404）时，能不能当成「远端把它删光了」去调和。
    ///
    /// 判据要两个条件同时成立：目录本身 404，**而且**仓库与分支这一层仍然够得着。
    /// GitHub 对无权访问的私有仓、改名的仓库、被删的分支一律回 404，与「目录真的没了」
    /// 长得一模一样——只凭目录那一个 404 就动手删，等于把一次权限变动变成一次数据清空。
    /// 探测不出结论（网络错误，refStatus 为 null）同样不许删。
    /// </summary>
    internal static bool ShouldReconcileAsEmpty(HttpStatusCode directoryStatus, HttpStatusCode? refStatus)
        => directoryStatus == HttpStatusCode.NotFound && refStatus == HttpStatusCode.OK;

    /// <summary>
    /// 探一下仓库 + 分支这一层还够不够得着，返回原始状态码；网络层出错返回 null（没问出结论）。
    /// 用分支端点而不是仓库端点：它一次同时回答「仓库还在、还有权限、这个分支还在」三件事。
    /// </summary>
    private async Task<HttpStatusCode?> ProbeRefAsync(
        string owner, string repo, string branch, string? accessToken, CancellationToken ct)
    {
        try
        {
            var url = $"https://api.github.com/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}"
                    + $"/branches/{Uri.EscapeDataString(branch)}";
            using var request = BuildApiRequest(url, accessToken);
            using var response = await Http.SendAsync(request, ct);
            return response.StatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            _logger.LogWarning(ex, "[GitHubSync] 探测 {Owner}/{Repo}@{Branch} 失败", owner, repo, branch);
            return null;
        }
    }

    /// <summary>调用 GitHub Contents API 获取目录下的文件列表</summary>
    private async Task<DirectoryListing> ListDirectoryFilesAsync(
        string owner, string repo, string path, string branch, Matcher? matcher,
        string? accessToken, CancellationToken ct)
    {
        // 路径要逐段转义：目录名里合法的 # 会被当成片段、? 会被当成查询串，
        // 结果是扫描器列得出来的目录，同步时打到另一个地址上必然失败。
        var safePath = Uri.EscapeDataString(path).Replace("%2F", "/", StringComparison.Ordinal);
        var url = $"https://api.github.com/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/contents/{safePath}?ref={Uri.EscapeDataString(branch)}";

        using var request = BuildApiRequest(url, accessToken);
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
                var refStatus = await ProbeRefAsync(owner, repo, branch, accessToken, ct);
                if (ShouldReconcileAsEmpty(response.StatusCode, refStatus))
                {
                    _logger.LogInformation(
                        "[GitHubSync] {Owner}/{Repo}/{Path}@{Branch} 已不存在，而仓库与分支仍可访问：按「远端删光了」调和",
                        owner, repo, path, branch);
                    // 目录压根不存在，不存在「只回了一部分」的可能，所以这份空清单是完整的
                    return new DirectoryListing(new List<GitHubFile>(), Complete: true);
                }

                _logger.LogWarning(
                    "[GitHubSync] {Owner}/{Repo}/{Path}@{Branch} 返回 404，但仓库/分支探测是 {RefStatus}：不当成删空，按失败处理",
                    owner, repo, path, branch, refStatus?.ToString() ?? "探测失败");
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
            throw new GitHubSyncUserFacingException(DescribeListFailure(
                response.StatusCode, accessToken, owner, repo, path, branch,
                rateLimited: GitHubRateLimit.IsExhausted(response),
                resetHint: GitHubRateLimit.ResetHint(response)));
        }

        var json = await response.Content.ReadAsStringAsync(ct);
        var doc = JsonDocument.Parse(json);

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
        return new DirectoryListing(files, IsListingComplete(rawCount));
    }

    /// <summary>
    /// 查询单个文件在指定分支上的最近一次 commit 时间。
    /// GitHub Commits API: GET /repos/:owner/:repo/commits?path=:path&sha=:branch&per_page=1
    /// 返回 UTC DateTime；失败/无结果返回 null（不抛异常，避免影响主同步流程）。
    /// </summary>
    private async Task<DateTime?> GetLatestCommitDateAsync(
        string owner, string repo, string path, string branch, string? accessToken, CancellationToken ct)
    {
        try
        {
            var url = $"https://api.github.com/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/commits"
                    + $"?path={Uri.EscapeDataString(path)}&sha={Uri.EscapeDataString(branch)}&per_page=1";
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
    private static string BuildBlobUrl(string owner, string repo, string branch, string path)
        => $"https://github.com/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}"
         + $"/blob/{Uri.EscapeDataString(branch)}/"
         + Uri.EscapeDataString(path).Replace("%2F", "/", StringComparison.Ordinal);

    /// <summary>
    /// 取单个文件正文。已连接走 Contents API 的 raw 媒体类型（私有仓可读、地址稳定不带临时 token），
    /// 未连接沿用历史的 download_url。
    /// </summary>
    private async Task<string> FetchFileContentAsync(
        GitHubFile file, string owner, string repo, string branch, string? accessToken, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(accessToken))
        {
            return await Http.GetStringAsync(file.DownloadUrl, ct);
        }

        var url = $"https://api.github.com/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}"
                + $"/contents/{Uri.EscapeDataString(file.Path).Replace("%2F", "/", StringComparison.Ordinal)}"
                + $"?ref={Uri.EscapeDataString(branch)}";
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

    /// <summary>
    /// 有文件失败。调用方**必须**据此把父条目标成失败，而不是照常标 idle——
    /// 否则「少了几篇」会被一个绿色的成功状态盖住（形状 10：静默降级）。
    /// </summary>
    public bool HasFailures => FailedCount > 0;

    /// <summary>给用户看的失败描述：缺了几篇、举几个例子。</summary>
    public string BuildFailureMessage()
    {
        var sample = string.Join("、", FailedPaths.Take(3));
        var more = FailedPaths.Count > 3 ? $" 等 {FailedPaths.Count} 个文件" : "";
        return $"有 {FailedCount} 篇文档没有拉取成功（{sample}{more}）。"
             + "常见原因是 GitHub 调用频率超限或授权失效；已同步的部分已保留，可稍后点「重试同步」补齐。";
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
