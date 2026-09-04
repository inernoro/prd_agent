using System.Security.Cryptography;
using System.Text;
using Markdig;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 网页/知识库自定义文件夹服务实现。
///
/// 生成路径分两种：
/// - Markdown：稳固的即时生成路径。Markdig 渲染 → 包壳 HTML →
///   IHostedSiteService.CreateFromContentAsync（web）或写入 DocumentEntry + ParsedPrd（document-store）。
/// - skill：暂为 best-effort/延后。skill 执行依赖 LLM/run-worker 异步链路，
///   wave 1 不在此构建半成品 LLM 管线，直接返回 { generated = false, reason }，
///   优先保证 Markdown 路径稳固（见 .claude/rules/no-rootless-tree.md：缺什么明确暴露）。
/// </summary>
public class WebFolderService : IWebFolderService
{
    private const string NameClaimCollection = "web_folder_name_claims";
    private const string RenameLockCollection = "web_folder_rename_locks";
    private const string ClaimFolderIdField = "FolderId";
    private const string RenameFenceField = "Fence";
    private const string RenameOperationIdField = "RenameOperationId";
    private readonly MongoDbContext _db;
    private readonly IHostedSiteService _hostedSites;
    private readonly IDocumentService _documents;
    private readonly ILogger<WebFolderService> _logger;

    private sealed record NameClaimResolution(string FolderId, bool WasCreated);
    private sealed record RenameLease(string OperationId, long Fence);

    public WebFolderService(
        MongoDbContext db,
        IHostedSiteService hostedSites,
        IDocumentService documents,
        ILogger<WebFolderService> logger)
    {
        _db = db;
        _hostedSites = hostedSites;
        _documents = documents;
        _logger = logger;
    }

    public async Task<WebFolder> CreateAsync(string userId, WebFolder input, CancellationToken ct = default)
    {
        for (var transitionAttempt = 0; transitionAttempt < 4; transitionAttempt++)
        {
            var resolved = await TryCreateAsync(userId, input, ct);
            if (resolved != null)
                return resolved;
        }

        throw new InvalidOperationException("文件夹名称正在变更，请稍后重试");
    }

    private async Task<WebFolder?> TryCreateAsync(string userId, WebFolder input, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var normalizedName = NormalizeName(input.Name);
        var existing = (await _db.WebFolders
                .Find(folder => folder.OwnerUserId == userId)
                .ToListAsync(ct))
            .FirstOrDefault(folder => NormalizeName(folder.Name) == normalizedName);
        if (existing != null)
        {
            await ResolveFolderIdAsync(userId, normalizedName, existing.Id, CancellationToken.None);
            return existing;
        }

        // 名称 claim 与文件夹实体分离：claim 的 _id 负责跨实例并发串行化，FolderId
        // 仍是稳定的随机身份。这样文件夹重命名后可以释放旧名称，而不会改写实体 ID。
        var candidateId = Guid.NewGuid().ToString("N");
        var claim = await ResolveFolderIdAsync(userId, normalizedName, candidateId, CancellationToken.None);
        var folderId = claim.FolderId;

        var category = new WebFolder
        {
            Id = folderId,
            OwnerUserId = userId,
            Name = (input.Name ?? string.Empty).Trim(),
            Description = input.Description?.Trim(),
            SortOrder = input.SortOrder,
            GeneratorType = WebFolderGeneratorType.All.Contains(input.GeneratorType)
                ? input.GeneratorType
                : WebFolderGeneratorType.None,
            GeneratorSkillId = string.IsNullOrWhiteSpace(input.GeneratorSkillId) ? null : input.GeneratorSkillId.Trim(),
            GeneratorMarkdown = input.GeneratorMarkdown,
            GenerateTarget = WebFolderGenerateTarget.All.Contains(input.GenerateTarget)
                ? input.GenerateTarget
                : WebFolderGenerateTarget.Web,
            GenerateStoreId = string.IsNullOrWhiteSpace(input.GenerateStoreId) ? null : input.GenerateStoreId.Trim(),
            CreatedAt = now,
            UpdatedAt = now,
        };

        var ub = Builders<WebFolder>.Update;
        var created = await IMongoCollectionExtensions.FindOneAndUpdateAsync<WebFolder, WebFolder>(
            _db.WebFolders,
            folder => folder.Id == category.Id,
            ub.Combine(
                ub.SetOnInsert(folder => folder.Id, category.Id),
                ub.SetOnInsert(folder => folder.OwnerUserId, category.OwnerUserId),
                ub.SetOnInsert(folder => folder.Name, category.Name),
                ub.SetOnInsert(folder => folder.Description, category.Description),
                ub.SetOnInsert(folder => folder.SortOrder, category.SortOrder),
                ub.SetOnInsert(folder => folder.GeneratorType, category.GeneratorType),
                ub.SetOnInsert(folder => folder.GeneratorSkillId, category.GeneratorSkillId),
                ub.SetOnInsert(folder => folder.GeneratorMarkdown, category.GeneratorMarkdown),
                ub.SetOnInsert(folder => folder.GenerateTarget, category.GenerateTarget),
                ub.SetOnInsert(folder => folder.GenerateStoreId, category.GenerateStoreId),
                ub.SetOnInsert(folder => folder.CreatedAt, category.CreatedAt),
                ub.SetOnInsert(folder => folder.UpdatedAt, category.UpdatedAt)),
            new FindOneAndUpdateOptions<WebFolder, WebFolder>
            {
                IsUpsert = true,
                ReturnDocument = ReturnDocument.After,
            },
            CancellationToken.None) ?? throw new InvalidOperationException("文件夹创建后未能读取，请稍后重试");

        if (NormalizeName(created.Name) == normalizedName)
        {
            _logger.LogInformation("[web-folder] Resolved idempotent folder {Id} '{Name}' by {UserId}", created.Id, created.Name, userId);
            return created;
        }

        // 重命名会先占用目标名称，再写实体名称。创建请求撞上这个短暂窗口时，
        // 不能把同 ID 的旧名称实体当成创建成功；等待 claim 与实体重新一致。
        return await WaitForClaimedFolderAsync(userId, normalizedName);
    }

    internal static string NormalizeName(string? name) =>
        WebFolderName.Canonicalize(name);

    internal static string BuildNameClaimId(string userId, string normalizedName)
    {
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes($"{userId}\0{normalizedName}"));
        return Convert.ToHexString(digest.AsSpan(0, 16)).ToLowerInvariant();
    }

    private async Task<NameClaimResolution> ResolveFolderIdAsync(
        string userId,
        string normalizedName,
        string preferredFolderId,
        CancellationToken ct,
        RenameLease? initialLease = null)
    {
        var claims = _db.Database.GetCollection<BsonDocument>(NameClaimCollection);
        var claimId = BuildNameClaimId(userId, normalizedName);
        var now = DateTime.UtcNow;
        var updates = new List<UpdateDefinition<BsonDocument>>
        {
            Builders<BsonDocument>.Update.SetOnInsert("_id", claimId),
            Builders<BsonDocument>.Update.SetOnInsert(ClaimFolderIdField, preferredFolderId),
            Builders<BsonDocument>.Update.SetOnInsert("OwnerUserId", userId),
            Builders<BsonDocument>.Update.SetOnInsert("NormalizedName", normalizedName),
            Builders<BsonDocument>.Update.SetOnInsert("CreatedAt", now),
            Builders<BsonDocument>.Update.Set("UpdatedAt", now),
        };
        if (initialLease != null)
        {
            // 重命名目标 claim 首次创建时就带恢复身份，消除“claim 已落库但围栏尚未写入”
            // 的进程退出窗口。后续 Own 仍会复核同一 operationId + fence。
            updates.Add(Builders<BsonDocument>.Update.SetOnInsert(
                RenameOperationIdField, initialLease.OperationId));
            updates.Add(Builders<BsonDocument>.Update.SetOnInsert(
                RenameFenceField, initialLease.Fence));
        }
        var update = Builders<BsonDocument>.Update.Combine(updates);
        var previousClaim = await claims.FindOneAndUpdateAsync(
            Builders<BsonDocument>.Filter.Eq("_id", claimId),
            update,
            new FindOneAndUpdateOptions<BsonDocument>
            {
                IsUpsert = true,
                ReturnDocument = ReturnDocument.Before,
            },
            ct);
        return previousClaim == null
            ? new NameClaimResolution(preferredFolderId, true)
            : new NameClaimResolution(previousClaim[ClaimFolderIdField].AsString, false);
    }

    internal static FilterDefinition<BsonDocument> BuildNameClaimOwnershipFilter(
        string userId,
        string normalizedName,
        string folderId,
        string operationId,
        long fence)
    {
        var filter = Builders<BsonDocument>.Filter;
        return filter.And(
            filter.Eq("_id", BuildNameClaimId(userId, normalizedName)),
            filter.Eq(ClaimFolderIdField, folderId),
            filter.Or(
                filter.Exists(RenameFenceField, false),
                filter.Lt(RenameFenceField, fence),
                filter.And(
                    filter.Eq(RenameFenceField, fence),
                    filter.Or(
                        filter.Exists(RenameOperationIdField, false),
                        filter.Eq(RenameOperationIdField, operationId)))));
    }

    internal static FilterDefinition<BsonDocument> BuildOwnedNameClaimFilter(
        string userId,
        string normalizedName,
        string folderId,
        string operationId,
        long fence)
    {
        var filter = Builders<BsonDocument>.Filter;
        return filter.And(
            filter.Eq("_id", BuildNameClaimId(userId, normalizedName)),
            filter.Eq(ClaimFolderIdField, folderId),
            filter.Eq(RenameOperationIdField, operationId),
            filter.Eq(RenameFenceField, fence));
    }

    private async Task OwnNameClaimAsync(
        string userId,
        string normalizedName,
        string folderId,
        RenameLease lease)
    {
        var claims = _db.Database.GetCollection<BsonDocument>(NameClaimCollection);
        var owned = await claims.UpdateOneAsync(
            BuildNameClaimOwnershipFilter(
                userId, normalizedName, folderId, lease.OperationId, lease.Fence),
            Builders<BsonDocument>.Update.Combine(
                Builders<BsonDocument>.Update.Set(RenameOperationIdField, lease.OperationId),
                Builders<BsonDocument>.Update.Set(RenameFenceField, lease.Fence),
                Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow)),
            cancellationToken: CancellationToken.None);
        if (owned.MatchedCount != 1)
            throw new InvalidOperationException("文件夹已被另一个操作接管，请重试");
    }

    private async Task FinalizeOwnedNameClaimAsync(
        string userId,
        string normalizedName,
        string folderId,
        RenameLease lease)
    {
        var claims = _db.Database.GetCollection<BsonDocument>(NameClaimCollection);
        var finalized = await claims.UpdateOneAsync(
            BuildOwnedNameClaimFilter(
                userId, normalizedName, folderId, lease.OperationId, lease.Fence),
            Builders<BsonDocument>.Update.Combine(
                Builders<BsonDocument>.Update.Set(ClaimFolderIdField, folderId),
                Builders<BsonDocument>.Update.Set("OwnerUserId", userId),
                Builders<BsonDocument>.Update.Set("NormalizedName", normalizedName),
                Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow),
                Builders<BsonDocument>.Update.Unset(RenameOperationIdField),
                Builders<BsonDocument>.Update.Unset(RenameFenceField)),
            cancellationToken: CancellationToken.None);
        if (finalized.MatchedCount != 1)
            throw new InvalidOperationException("文件夹已被另一个操作接管，请重试");
    }

    private Task ReleaseOwnedNameClaimAsync(
        string userId,
        string normalizedName,
        string folderId,
        RenameLease lease)
    {
        var claims = _db.Database.GetCollection<BsonDocument>(NameClaimCollection);
        return claims.DeleteOneAsync(
            BuildOwnedNameClaimFilter(
                userId, normalizedName, folderId, lease.OperationId, lease.Fence),
            CancellationToken.None);
    }

    private async Task<WebFolder?> WaitForClaimedFolderAsync(
        string userId,
        string normalizedName)
    {
        var claims = _db.Database.GetCollection<BsonDocument>(NameClaimCollection);
        var claimId = BuildNameClaimId(userId, normalizedName);
        for (var attempt = 0; attempt < 400; attempt++)
        {
            var currentClaim = await claims
                .Find(Builders<BsonDocument>.Filter.Eq("_id", claimId))
                .FirstOrDefaultAsync(CancellationToken.None);
            if (currentClaim == null)
                return null;
            if (!currentClaim.TryGetValue(ClaimFolderIdField, out var folderIdValue)
                || !folderIdValue.IsString)
                throw new InvalidOperationException("文件夹名称占用记录无效，请稍后重试");

            var claimedFolderId = folderIdValue.AsString;
            var claimedFolder = await _db.WebFolders
                .Find(folder => folder.Id == claimedFolderId && folder.OwnerUserId == userId)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (claimedFolder != null && NormalizeName(claimedFolder.Name) == normalizedName)
                return claimedFolder;

            if (await TryReclaimAbandonedNameClaimAsync(
                    currentClaim, userId, normalizedName, claimedFolderId))
                return null;

            await Task.Delay(25, CancellationToken.None);
        }

        throw new InvalidOperationException("文件夹名称正在变更，请稍后重试");
    }

    private async Task<bool> TryReclaimAbandonedNameClaimAsync(
        BsonDocument claim,
        string userId,
        string normalizedName,
        string folderId)
    {
        if (!claim.TryGetValue(RenameOperationIdField, out var operationValue)
            || !operationValue.IsString
            || !claim.TryGetValue(RenameFenceField, out var fenceValue)
            || !fenceValue.IsNumeric)
            return false;

        var operationId = operationValue.AsString;
        var fence = fenceValue.ToInt64();
        var locks = _db.Database.GetCollection<BsonDocument>(RenameLockCollection);
        var now = DateTime.UtcNow;
        var leaseActive = await locks.Find(
                Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("_id", folderId),
                    Builders<BsonDocument>.Filter.Eq("OperationId", operationId),
                    Builders<BsonDocument>.Filter.Eq(RenameFenceField, fence),
                    Builders<BsonDocument>.Filter.Gt("ExpiresAt", now)))
            .AnyAsync(CancellationToken.None);
        if (leaseActive) return false;

        var claims = _db.Database.GetCollection<BsonDocument>(NameClaimCollection);
        var deleted = await claims.DeleteOneAsync(
            BuildOwnedNameClaimFilter(userId, normalizedName, folderId, operationId, fence),
            CancellationToken.None);
        return deleted.DeletedCount == 1;
    }

    private async Task<bool> RepairNameClaimIfCurrentOwnerAsync(
        string userId,
        string normalizedName,
        string folderId)
    {
        var snapshot = await _db.WebFolders
            .Find(folder => folder.Id == folderId && folder.OwnerUserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (snapshot == null || NormalizeName(snapshot.Name) != normalizedName)
            return false;

        var resolution = await ResolveFolderIdAsync(
            userId, normalizedName, folderId, CancellationToken.None);
        if (!string.Equals(resolution.FolderId, folderId, StringComparison.Ordinal))
            return false;

        // Resolve 与复核之间如果另一个重命名已提高围栏，本次历史快照失效；
        // 只释放仍指向该 folderId 的 claim，绝不覆盖并发创建者的新映射。
        var current = await _db.WebFolders
            .Find(folder => folder.Id == folderId && folder.OwnerUserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);
        var stillOwnsName = current != null
            && current.RenameFence == snapshot.RenameFence
            && NormalizeName(current.Name) == normalizedName;
        if (stillOwnsName) return true;

        await ReleaseNameClaimAsync(userId, normalizedName, folderId, CancellationToken.None);
        return false;
    }

    private Task ReleaseNameClaimAsync(
        string userId,
        string normalizedName,
        string folderId,
        CancellationToken ct)
    {
        var claims = _db.Database.GetCollection<BsonDocument>(NameClaimCollection);
        var filter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("_id", BuildNameClaimId(userId, normalizedName)),
            Builders<BsonDocument>.Filter.Eq(ClaimFolderIdField, folderId));
        return claims.DeleteOneAsync(filter, ct);
    }

    private async Task<RenameLease> AcquireRenameLockAsync(string folderId, string userId)
    {
        var locks = _db.Database.GetCollection<BsonDocument>(RenameLockCollection);
        var operationId = Guid.NewGuid().ToString("N");
        for (var attempt = 0; attempt < 400; attempt++)
        {
            var now = DateTime.UtcNow;
            var filter = Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", folderId),
                Builders<BsonDocument>.Filter.Or(
                    Builders<BsonDocument>.Filter.Lt("ExpiresAt", now),
                    Builders<BsonDocument>.Filter.Exists("ExpiresAt", false)));
            var update = Builders<BsonDocument>.Update.Combine(
                Builders<BsonDocument>.Update.SetOnInsert("_id", folderId),
                Builders<BsonDocument>.Update.Set("OperationId", operationId),
                Builders<BsonDocument>.Update.Set("OwnerUserId", userId),
                Builders<BsonDocument>.Update.Set("ExpiresAt", now.AddSeconds(30)),
                Builders<BsonDocument>.Update.Set("UpdatedAt", now),
                Builders<BsonDocument>.Update.Inc(RenameFenceField, 1));
            try
            {
                var acquired = await locks.FindOneAndUpdateAsync(
                    filter,
                    update,
                    new FindOneAndUpdateOptions<BsonDocument>
                    {
                        IsUpsert = true,
                        ReturnDocument = ReturnDocument.After,
                    },
                    CancellationToken.None);
                if (acquired != null)
                    return new RenameLease(operationId, acquired[RenameFenceField].ToInt64());
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                await Task.Delay(25, CancellationToken.None);
            }
            catch (MongoCommandException ex) when (ex.Code == 11000)
            {
                // findAndModify + upsert 在锁仍有效时会尝试插入同一 _id；
                // 驱动会把这条路径包成 MongoCommandException，等待当前租约即可。
                await Task.Delay(25, CancellationToken.None);
            }
        }

        throw new InvalidOperationException("文件夹正在被修改，请稍后重试");
    }

    private Task ReleaseRenameLockAsync(string folderId, RenameLease lease)
    {
        var locks = _db.Database.GetCollection<BsonDocument>(RenameLockCollection);
        return locks.UpdateOneAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", folderId),
                Builders<BsonDocument>.Filter.Eq("OperationId", lease.OperationId),
                Builders<BsonDocument>.Filter.Eq(RenameFenceField, lease.Fence)),
            Builders<BsonDocument>.Update.Combine(
                Builders<BsonDocument>.Update.Set("ExpiresAt", DateTime.MinValue),
                Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow)),
            cancellationToken: CancellationToken.None);
    }

    private async Task RenewRenameLockAsync(string folderId, RenameLease lease)
    {
        var locks = _db.Database.GetCollection<BsonDocument>(RenameLockCollection);
        var now = DateTime.UtcNow;
        var renewed = await locks.UpdateOneAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("_id", folderId),
                Builders<BsonDocument>.Filter.Eq("OperationId", lease.OperationId),
                Builders<BsonDocument>.Filter.Eq(RenameFenceField, lease.Fence)),
            Builders<BsonDocument>.Update.Combine(
                Builders<BsonDocument>.Update.Set("ExpiresAt", now.AddSeconds(30)),
                Builders<BsonDocument>.Update.Set("UpdatedAt", now)),
            cancellationToken: CancellationToken.None);
        if (renewed.MatchedCount != 1)
            throw new InvalidOperationException("文件夹已被另一个操作接管，请重试");
    }

    internal static FilterDefinition<WebFolder> BuildRenameFenceAdvanceFilter(
        string folderId,
        string userId,
        long nextFence)
    {
        var filter = Builders<WebFolder>.Filter;
        return filter.And(
            filter.Eq(folder => folder.Id, folderId),
            filter.Eq(folder => folder.OwnerUserId, userId),
            filter.Or(
                filter.Exists(nameof(WebFolder.RenameFence), false),
                filter.Lt(folder => folder.RenameFence, nextFence)));
    }

    internal static FilterDefinition<WebFolder> BuildRenameFenceOwnerFilter(
        string folderId,
        string userId,
        long fence)
    {
        var filter = Builders<WebFolder>.Filter;
        return filter.And(
            filter.Eq(folder => folder.Id, folderId),
            filter.Eq(folder => folder.OwnerUserId, userId),
            filter.Eq(folder => folder.RenameFence, fence));
    }

    public async Task<List<WebFolder>> ListAsync(string userId, CancellationToken ct = default)
    {
        return await _db.WebFolders
            .Find(c => c.OwnerUserId == userId)
            .Sort(Builders<WebFolder>.Sort
                .Ascending(c => c.SortOrder)
                .Ascending(c => c.CreatedAt))
            .ToListAsync(ct);
    }

    public async Task<WebFolder?> UpdateAsync(string id, string userId, WebFolder patch, CancellationToken ct = default)
    {
        // 名称 claim、实体改名、旧 claim 释放必须由服务端完整执行；客户端断开不能
        // 取消其中任一步。Mongo `_id` 锁同时串行化同一文件夹的跨实例重命名。
        var lease = await AcquireRenameLockAsync(id, userId);
        try
        {
            var fenced = await _db.WebFolders.UpdateOneAsync(
                BuildRenameFenceAdvanceFilter(id, userId, lease.Fence),
                Builders<WebFolder>.Update.Set(folder => folder.RenameFence, lease.Fence),
                cancellationToken: CancellationToken.None);
            if (fenced.MatchedCount != 1)
            {
                var exists = await _db.WebFolders
                    .Find(folder => folder.Id == id && folder.OwnerUserId == userId)
                    .AnyAsync(CancellationToken.None);
                if (!exists) return null;
                throw new InvalidOperationException("文件夹已被另一个操作接管，请重试");
            }

            return await UpdateUnderRenameLockAsync(id, userId, patch, lease);
        }
        finally
        {
            await ReleaseRenameLockAsync(id, lease);
        }
    }

    private async Task<WebFolder?> UpdateUnderRenameLockAsync(
        string id,
        string userId,
        WebFolder patch,
        RenameLease lease)
    {
        await RenewRenameLockAsync(id, lease);
        var existing = await _db.WebFolders
            .Find(BuildRenameFenceOwnerFilter(id, userId, lease.Fence))
            .FirstOrDefaultAsync(CancellationToken.None);
        if (existing == null)
            throw new InvalidOperationException("文件夹已被另一个操作接管，请重试");

        var ub = Builders<WebFolder>.Update;
        var previousNormalizedName = NormalizeName(existing.Name);
        var nextNormalizedName = patch.Name == null
            ? previousNormalizedName
            : NormalizeName(patch.Name);

        if (nextNormalizedName != previousNormalizedName)
        {
            var ownerFolders = await _db.WebFolders
                .Find(folder => folder.OwnerUserId == userId && folder.Id != existing.Id)
                .ToListAsync(CancellationToken.None);
            var persistedCollision = ownerFolders.FirstOrDefault(folder =>
                NormalizeName(folder.Name) == nextNormalizedName);
            if (persistedCollision != null)
            {
                // 老数据没有名称 claim。先把真实占用回填为权威映射，再拒绝本次改名，
                // 避免两个持久文件夹得到同一个归一化名称。
                await RenewRenameLockAsync(id, lease);
                if (await RepairNameClaimIfCurrentOwnerAsync(
                        userId, nextNormalizedName, persistedCollision.Id))
                    throw new InvalidOperationException("同名文件夹已存在，请换一个名称");
            }

            await RenewRenameLockAsync(id, lease);
            var targetClaim = await ResolveFolderIdAsync(
                userId, nextNormalizedName, existing.Id, CancellationToken.None, lease);
            if (!string.Equals(targetClaim.FolderId, existing.Id, StringComparison.Ordinal))
                throw new InvalidOperationException("同名文件夹已存在，请换一个名称");

            await RenewRenameLockAsync(id, lease);
            await OwnNameClaimAsync(userId, nextNormalizedName, existing.Id, lease);
            try
            {
                await RenewRenameLockAsync(id, lease);
                var renamed = await _db.WebFolders.UpdateOneAsync(
                    BuildRenameFenceOwnerFilter(id, userId, lease.Fence),
                    ub.Combine(BuildFolderUpdates(ub, patch)),
                    cancellationToken: CancellationToken.None);
                if (renamed.MatchedCount != 1)
                    throw new InvalidOperationException("文件夹已被另一个操作接管，请重试");

                await RenewRenameLockAsync(id, lease);
                await FinalizeOwnedNameClaimAsync(userId, nextNormalizedName, existing.Id, lease);
                await ReleaseNameClaimAsync(
                    userId, previousNormalizedName, existing.Id, CancellationToken.None);

                return await _db.WebFolders
                    .Find(BuildRenameFenceOwnerFilter(id, userId, lease.Fence))
                    .FirstOrDefaultAsync(CancellationToken.None);
            }
            catch
            {
                if (targetClaim.WasCreated)
                {
                    await ReleaseOwnedNameClaimAsync(userId, nextNormalizedName, existing.Id, lease);
                }
                throw;
            }
        }

        await RenewRenameLockAsync(id, lease);
        var updated = await _db.WebFolders.UpdateOneAsync(
            BuildRenameFenceOwnerFilter(id, userId, lease.Fence),
            ub.Combine(BuildFolderUpdates(ub, patch)),
            cancellationToken: CancellationToken.None);
        if (updated.MatchedCount != 1)
            throw new InvalidOperationException("文件夹已被另一个操作接管，请重试");

        return await _db.WebFolders
            .Find(BuildRenameFenceOwnerFilter(id, userId, lease.Fence))
            .FirstOrDefaultAsync(CancellationToken.None);
    }

    private static IEnumerable<UpdateDefinition<WebFolder>> BuildFolderUpdates(
        UpdateDefinitionBuilder<WebFolder> ub,
        WebFolder patch)
    {
        var updates = new List<UpdateDefinition<WebFolder>>();
        if (patch.Name != null)
            updates.Add(ub.Set(c => c.Name, patch.Name.Trim()));
        if (patch.Description != null)
            updates.Add(ub.Set(c => c.Description, patch.Description.Trim()));
        updates.Add(ub.Set(c => c.SortOrder, patch.SortOrder));
        if (WebFolderGeneratorType.All.Contains(patch.GeneratorType))
            updates.Add(ub.Set(c => c.GeneratorType, patch.GeneratorType));
        updates.Add(ub.Set(c => c.GeneratorSkillId,
            string.IsNullOrWhiteSpace(patch.GeneratorSkillId) ? null : patch.GeneratorSkillId.Trim()));
        updates.Add(ub.Set(c => c.GeneratorMarkdown, patch.GeneratorMarkdown));
        if (WebFolderGenerateTarget.All.Contains(patch.GenerateTarget))
            updates.Add(ub.Set(c => c.GenerateTarget, patch.GenerateTarget));
        updates.Add(ub.Set(c => c.GenerateStoreId,
            string.IsNullOrWhiteSpace(patch.GenerateStoreId) ? null : patch.GenerateStoreId.Trim()));
        updates.Add(ub.Set(c => c.UpdatedAt, DateTime.UtcNow));
        return updates;
    }

    public async Task<bool> DeleteAsync(string id, string userId, CancellationToken ct = default)
    {
        var existing = await _db.WebFolders
            .Find(c => c.Id == id && c.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
        if (existing == null) return false;

        var result = await _db.WebFolders.DeleteOneAsync(
            c => c.Id == id && c.OwnerUserId == userId, CancellationToken.None);
        if (result.DeletedCount > 0)
            await ReleaseNameClaimAsync(
                userId, NormalizeName(existing.Name), existing.Id, CancellationToken.None);
        return result.DeletedCount > 0;
    }

    public async Task<object> GenerateAsync(string id, string userId, CancellationToken ct = default)
    {
        var category = await _db.WebFolders
            .Find(c => c.Id == id && c.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
        if (category == null)
            return new { generated = false, reason = "文件夹不存在或无权访问" };

        // ── skill 生成：best-effort，wave 1 延后（依赖 LLM/run-worker 异步链路）──
        if (category.GeneratorType == WebFolderGeneratorType.Skill)
        {
            _logger.LogInformation(
                "[web-folder] Generate {Id} skill path deferred (skillId={SkillId})",
                category.Id, category.GeneratorSkillId);
            return new
            {
                generated = false,
                reason = "skill 生成需异步执行（依赖 LLM 调用链），暂仅支持 Markdown 即时生成",
            };
        }

        // ── Markdown 生成 ──
        if (category.GeneratorType == WebFolderGeneratorType.Markdown)
        {
            var markdown = category.GeneratorMarkdown ?? string.Empty;
            if (string.IsNullOrWhiteSpace(markdown))
                return new { generated = false, reason = "该文件夹未配置 Markdown 模板内容" };

            var title = $"{category.Name} {DateTime.Now:yyyy-MM-dd HH:mm}";

            if (category.GenerateTarget == WebFolderGenerateTarget.DocumentStore)
            {
                return await GenerateDocumentEntryAsync(category, userId, markdown, title, ct);
            }

            // 默认 web 目标
            var html = RenderMarkdownToHtml(markdown, title);
            var site = await _hostedSites.CreateFromContentAsync(
                userId, html, title, category.Description,
                sourceType: "category-gen", sourceRef: category.Id,
                tags: null, folder: category.Name, ct);

            _logger.LogInformation(
                "[web-folder] Generated web page {SiteId} from category {CategoryId}", site.Id, category.Id);

            return new
            {
                generated = true,
                target = WebFolderGenerateTarget.Web,
                siteId = site.Id,
                title = site.Title,
                siteUrl = site.SiteUrl,
                entryFile = site.EntryFile,
            };
        }

        // ── none ──
        return new { generated = false, reason = "该文件夹未绑定生成器" };
    }

    /// <summary>生成知识库条目：校验 store 归属 → 创建 ParsedPrd → 写 DocumentEntry → 计数 +1</summary>
    private async Task<object> GenerateDocumentEntryAsync(
        WebFolder category, string userId, string markdown, string title, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(category.GenerateStoreId))
            return new { generated = false, reason = "生成目标为知识库，但未指定知识库空间 ID" };

        var store = await _db.DocumentStores
            .Find(s => s.Id == category.GenerateStoreId)
            .FirstOrDefaultAsync(ct);
        if (store == null)
            return new { generated = false, reason = "指定的知识库空间不存在" };
        if (store.OwnerId != userId)
            return new { generated = false, reason = "无权写入该知识库空间" };

        // 解析正文为 ParsedPrd（镜像 DocumentStoreController.UpdateEntryContent 的创建路径）
        var parsed = await _documents.ParseAsync(markdown);
        parsed.Title = title;
        await _documents.SaveAsync(parsed);

        var summary = markdown.Length > 200 ? markdown[..200] : markdown;
        var contentIndex = markdown.Length > 2000 ? markdown[..2000] : markdown;

        var entry = new DocumentEntry
        {
            StoreId = store.Id,
            ParentId = null,
            IsFolder = false,
            DocumentId = parsed.Id,
            Title = title,
            Summary = summary.Trim(),
            SourceType = DocumentSourceType.Import,
            ContentType = "text/markdown",
            ContentIndex = contentIndex.Trim(),
            CreatedBy = userId,
            UpdatedBy = userId,
            LastChangedAt = DateTime.UtcNow,
        };

        await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: ct);

        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == store.Id,
            Builders<PrdAgent.Core.Models.DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        _logger.LogInformation(
            "[web-folder] Generated document entry {EntryId} in store {StoreId} from category {CategoryId}",
            entry.Id, store.Id, category.Id);

        return new
        {
            generated = true,
            target = WebFolderGenerateTarget.DocumentStore,
            storeId = store.Id,
            entryId = entry.Id,
            documentId = parsed.Id,
            title = entry.Title,
        };
    }

    /// <summary>Markdig 渲染 Markdown → 安全 HTML，包一层最小 HTML 壳。关闭原始 HTML 透传防 XSS。</summary>
    private static string RenderMarkdownToHtml(string markdown, string title)
    {
        var pipeline = new MarkdownPipelineBuilder()
            .UseAdvancedExtensions()
            .UseSoftlineBreakAsHardlineBreak()
            .DisableHtml()
            .Build();
        var bodyHtml = Markdig.Markdown.ToHtml(markdown, pipeline);
        var safeTitle = HtmlEscape(title);

        var sb = new StringBuilder();
        sb.AppendLine("<!DOCTYPE html>");
        sb.AppendLine("<html lang=\"zh-CN\">");
        sb.AppendLine("<head>");
        sb.AppendLine("  <meta charset=\"UTF-8\" />");
        sb.AppendLine("  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />");
        sb.Append("  <title>").Append(safeTitle).AppendLine("</title>");
        sb.AppendLine("  <style>");
        sb.AppendLine("    :root{color-scheme:light dark;}");
        sb.AppendLine("    body{margin:0;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2328;background:#fff;}");
        sb.AppendLine("    .markdown-body{max-width:780px;margin:0 auto;}");
        sb.AppendLine("    .markdown-body h1,.markdown-body h2,.markdown-body h3{border-bottom:1px solid #eaecef;padding-bottom:0.3em;margin-top:1.8em;}");
        sb.AppendLine("    .markdown-body pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto;}");
        sb.AppendLine("    .markdown-body code{background:rgba(175,184,193,0.2);padding:.2em .4em;border-radius:6px;font-size:85%;}");
        sb.AppendLine("    .markdown-body pre code{background:transparent;padding:0;}");
        sb.AppendLine("    .markdown-body img{max-width:100%;}");
        sb.AppendLine("    .markdown-body blockquote{border-left:4px solid #d0d7de;padding:0 1em;color:#57606a;margin:0;}");
        sb.AppendLine("    .markdown-body table{border-collapse:collapse;}");
        sb.AppendLine("    .markdown-body th,.markdown-body td{border:1px solid #d0d7de;padding:6px 13px;}");
        sb.AppendLine("    @media (prefers-color-scheme: dark){");
        sb.AppendLine("      body{background:#0d1117;color:#e6edf3;}");
        sb.AppendLine("      .markdown-body h1,.markdown-body h2,.markdown-body h3{border-bottom-color:#30363d;}");
        sb.AppendLine("      .markdown-body pre{background:#161b22;}");
        sb.AppendLine("      .markdown-body code{background:rgba(110,118,129,0.4);}");
        sb.AppendLine("      .markdown-body blockquote{border-left-color:#30363d;color:#8b949e;}");
        sb.AppendLine("      .markdown-body th,.markdown-body td{border-color:#30363d;}");
        sb.AppendLine("    }");
        sb.AppendLine("  </style>");
        sb.AppendLine("</head>");
        sb.AppendLine("<body>");
        sb.AppendLine("  <article class=\"markdown-body\">");
        sb.AppendLine(bodyHtml);
        sb.AppendLine("  </article>");
        sb.AppendLine("</body>");
        sb.AppendLine("</html>");
        return sb.ToString();
    }

    private static string HtmlEscape(string s)
        => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
