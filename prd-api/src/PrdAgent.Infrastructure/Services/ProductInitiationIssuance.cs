using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>产品 T 号自动发放。新申领与存量待审批共用评审门、永久编号占用和条件更新。</summary>
public static class ProductInitiationIssuance
{
    private const string LegacyMigrationKey = "migration:product-initiation-single-auto-issue-20261021";
    // 本次仅授权处理用户已创建的唯一待审批记录；不能滑动到后续申请。
    private static readonly DateTime LegacyCreatedBeforeUtc = new(2026, 10, 21, 6, 26, 1, DateTimeKind.Utc);

    public static async Task<string?> ResolveLegacyTargetAsync(MongoDbContext db)
    {
        var claims = db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName);
        var filter = Builders<BsonDocument>.Filter.Eq("_id", LegacyMigrationKey);
        var claim = await claims.Find(filter).FirstOrDefaultAsync();
        if (claim == null)
        {
            // 只允许唯一候选；失败/未完成的待审批也计入歧义，不能悄悄挑另一个人。
            var candidates = await db.ProductInitiations.Find(x => !x.IsDeleted && x.Status == "owner_pending"
                    && (x.TCode == null || x.TCode == "") && x.CreatedAt <= LegacyCreatedBeforeUtc)
                .Limit(2).Project(x => x.Id).ToListAsync();
            var target = candidates.Count == 1 ? "initiation:" + candidates[0] : "blocked:not-unique";
            await ProductVersionClaimGuard.TryReserveAsync(db.Database, LegacyMigrationKey, target);
            claim = await claims.Find(filter).FirstOrDefaultAsync();
        }
        var savedTarget = claim?.GetValue("targetId", "").AsString;
        return savedTarget?.StartsWith("initiation:", StringComparison.Ordinal) == true ? savedTarget["initiation:".Length..] : null;
    }

    public static async Task<ProductInitiation?> IssueAsync(MongoDbContext db, string id,
        string expectedStatus, UpdateDefinition<ProductInitiation>? decision = null)
    {
        if (expectedStatus is not ("decision_pending" or "owner_pending"))
            throw new ArgumentException("不支持的自动发号来源状态", nameof(expectedStatus));
        var eligible = Builders<ProductInitiation>.Filter.Where(x => x.Id == id && !x.IsDeleted
            && x.Status == expectedStatus && x.ReviewPassed == true && (x.TCode == null || x.TCode == ""));
        var item = await db.ProductInitiations.Find(eligible).FirstOrDefaultAsync();
        if (item == null) return null;

        var target = "initiation:" + id;
        // 结果不明确后的重试沿用该记录已占用的编号，不释放或重用编号。
        var code = await ProductVersionClaimGuard.ReserveWorkflowCodeAsync(db, "T", item.VersionType, target,
            string.IsNullOrWhiteSpace(item.LinkedProductId) ? item.ProductId : item.LinkedProductId);

        var update = Builders<ProductInitiation>.Update.Set(x => x.TCode, code).Set(x => x.Status, "approved")
            .Set(x => x.RequirementSyncPending, true).Set(x => x.IssuedAt, DateTime.UtcNow).Set(x => x.UpdatedAt, DateTime.UtcNow);
        // 仅新申领随实际T号原子保存标准名称；旧owner_pending补发和已发号记录不重命名。
        if (expectedStatus == "decision_pending" && !string.IsNullOrWhiteSpace(item.AppName))
            update = update.Set(x => x.PlanName, ProductVersionPlanName.Format(item.AppName, code, item.PlanName));
        if (decision != null) update = Builders<ProductInitiation>.Update.Combine(decision, update);
        // 发号时重新检查评审、状态和软删除；并发重试不能覆盖已有编号或原资料。
        var unchanged = eligible & Builders<ProductInitiation>.Filter.Eq(x => x.UpdatedAt, item.UpdatedAt);
        var issued = await db.ProductInitiations.FindOneAndUpdateAsync(unchanged, update,
            new FindOneAndUpdateOptions<ProductInitiation> { ReturnDocument = ReturnDocument.After }, CancellationToken.None);
        if (issued == null) return null;
        await CompleteRequirementSyncAsync(db, issued);
        issued.RequirementSyncPending = false;
        return issued;
    }

    public static async Task<int> BackfillAsync(MongoDbContext db, string? legacyPendingId, CancellationToken stoppingToken = default)
    {
        var eligible = Builders<ProductInitiation>.Filter.Where(x => !x.IsDeleted && (
            (legacyPendingId != null && x.Id == legacyPendingId && x.Status == "owner_pending"
                && x.ReviewPassed == true && (x.TCode == null || x.TCode == ""))
            || (x.Status == "approved" && x.TCode != null && x.TCode != "" && x.RequirementSyncPending)));
        using var cursor = await db.ProductInitiations.Find(eligible)
            .SortBy(x => x.CreatedAt).ToCursorAsync(stoppingToken);
        var count = 0;
        var failures = new List<Exception>();
        while (await cursor.MoveNextAsync(stoppingToken))
        {
            foreach (var item in cursor.Current)
            {
                stoppingToken.ThrowIfCancellationRequested();
                try
                {
                    if (item.RequirementSyncPending && !string.IsNullOrWhiteSpace(item.TCode))
                        await CompleteRequirementSyncAsync(db, item);
                    else if (await IssueAsync(db, item.Id, "owner_pending") != null) count++;
                }
                catch (Exception ex) when (ex is not OperationCanceledException) { failures.Add(ex); }
            }
        }
        if (failures.Count > 0) throw new AggregateException("部分待发号记录未完成，其他记录已继续处理", failures);
        return count;
    }

    private static async Task CompleteRequirementSyncAsync(MongoDbContext db, ProductInitiation item)
    {
        await AdvanceRequirementsAsync(db, item.ProductId, item.RequirementIds,
            RequirementWorkflowCatalog.Approved, item.CreatedBy, "立项评审通过，自动发放 T 号并流转到已立项");
        await db.ProductInitiations.UpdateOneAsync(x => x.Id == item.Id && x.TCode == item.TCode && !x.IsDeleted,
            Builders<ProductInitiation>.Update.Set(x => x.RequirementSyncPending, false), cancellationToken: CancellationToken.None);
    }

    public static async Task AdvanceRequirementsAsync(MongoDbContext db, string productId,
        IEnumerable<string> requirementIds, string targetStateKey, string userId, string activityContent)
    {
        var ids = requirementIds.Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().ToList();
        if (ids.Count == 0) return;
        var reqs = await db.Requirements.Find(r => ids.Contains(r.Id) && r.ProductId == productId && !r.IsDeleted).ToListAsync();
        if (reqs.Count == 0) return;
        var defId = reqs.Select(r => r.WorkflowDefId).FirstOrDefault(id => !string.IsNullOrWhiteSpace(id));
        ProductWorkflowDefinition? def;
        if (!string.IsNullOrWhiteSpace(defId))
            def = await db.ProductWorkflowDefinitions.Find(w => w.Id == defId && !w.IsDeleted).FirstOrDefaultAsync();
        else
        {
            var defaults = await db.ProductWorkflowDefinitions.Find(w => w.EntityType == ProductEntityType.Requirement && w.IsDefault && !w.IsDeleted).ToListAsync();
            def = defaults.FirstOrDefault(w => w.ProductId == productId) ?? defaults.FirstOrDefault(w => w.ProductId == null)
                ?? ProductWorkflowDefaults.Requirement();
        }
        if (def == null) return;
        var actorName = (await db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        string LabelOf(string? key) => def.States.FirstOrDefault(s => s.Key == key)?.Label ?? key ?? "未设置";
        foreach (var req in reqs)
        {
            var fromKey = RequirementWorkflowCatalog.NormalizeStateKey(req.CurrentState, def);
            if (fromKey == targetStateKey || !def.Transitions.Any(t => t.ToState == targetStateKey
                && (string.IsNullOrWhiteSpace(t.FromState) || t.FromState == fromKey))) continue;
            var now = DateTime.UtcNow;
            var changed = await db.Requirements.UpdateOneAsync(x => x.Id == req.Id && !x.IsDeleted && x.CurrentState == req.CurrentState,
                Builders<Requirement>.Update.Set(x => x.CurrentState, targetStateKey).Set(x => x.StateEnteredAt, now).Set(x => x.UpdatedAt, now),
                cancellationToken: CancellationToken.None);
            if (changed.ModifiedCount == 0) continue;
            await db.ProductItemActivities.InsertOneAsync(new ProductItemActivity {
                EntityType = ProductEntityType.Requirement, EntityId = req.Id, ProductId = productId,
                Type = ProductActivityType.Transition, ActorId = userId, ActorName = actorName,
                Content = activityContent, FromValue = LabelOf(fromKey), ToValue = LabelOf(targetStateKey),
            }, cancellationToken: CancellationToken.None);
        }
    }
}
