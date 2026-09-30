using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文学配图「换版不删图」的归档动作。
///
/// 改正文、重新规划标记、同一位置重新上传时，网页此前会把工作区里的文章配图连底层文件一起硬删：
/// 用户要回看历史配图时已经没了，智能体通过开放接口生成的图也被网页的一次操作一并抹掉。
/// 现在一律保留，只给还没盖版本号的旧图盖上它所属的那一版——之后「当前挂哪张」由
/// <see cref="PrdAgent.Core.Services.LiteraryMcpWorkflow.SelectCurrent"/> 按版本判定，
/// 旧图不会再被按 index 猜回新标记上，而是出现在「历史配图」里。
/// </summary>
public static class LiteraryIllustrationArchive
{
    /// <summary>
    /// 「正文换了」的提交型复位：版本 +1、旧流程进历史、清标记与带标记正文。
    ///
    /// 这段判断曾只写在 ImageMaster 的更新接口里；文学页拆出自己的 PUT 之后没带过来，
    /// 于是网页上给一篇文章重新上传正文时，旧标记和旧配图方案原样挂在新正文上（刷新后又回来）。
    /// 两个入口现在都调这一处。调用方负责在写库后调用 <see cref="StampUnversionedAsync"/>。
    /// </summary>
    public static UpdateDefinition<ImageMasterWorkspace> ContentResetUpdate(ImageMasterWorkspace ws, DateTime now)
    {
        var history = ws.ArticleWorkflowHistory ?? new List<ArticleIllustrationWorkflow>();
        if (ws.ArticleWorkflow != null)
        {
            history.Insert(0, ws.ArticleWorkflow);
            if (history.Count > 10) history = history.Take(10).ToList();
        }
        return Builders<ImageMasterWorkspace>.Update
            .Set(x => x.ArticleWorkflow, new ArticleIllustrationWorkflow
            {
                Version = (ws.ArticleWorkflow?.Version ?? 0) + 1,
                Phase = 1, // Editing
                Markers = new List<ArticleIllustrationMarker>(),
                ExpectedImageCount = null,
                DoneImageCount = 0,
                AssetIdByMarkerIndex = new Dictionary<string, string>(),
                UpdatedAt = now,
            })
            .Set(x => x.ArticleWorkflowHistory, history)
            .Set(x => x.ArticleContentWithMarkers, null);
    }

    /// <summary>把该工作区里带插入位、但没有版本号的配图归到 <paramref name="version"/>。</summary>
    public static Task StampUnversionedAsync(MongoDbContext db, string workspaceId, int version)
        => db.ImageAssets.UpdateManyAsync(
            x => x.WorkspaceId == workspaceId && x.ArticleInsertionIndex != null && x.ArticleWorkflowVersion == null,
            Builders<ImageAsset>.Update.Set(x => x.ArticleWorkflowVersion, version),
            cancellationToken: CancellationToken.None);
}

/// <summary>
/// 网页端对单个配图标记的**定向**写入。
///
/// 网页此前是「读出整份 ArticleWorkflow → 改一处 → 整份写回」，写回只按工作区 id 过滤：
/// 用户开着页面、智能体同时在生图时，网页那份几秒前的快照会把智能体任务刚认领的 runId、
/// Worker 刚写入的图片指针一起盖掉——界面显示没图或一直在跑，查询接口却说已完成。
/// 这里只 $set 被点名的那个标记的字段，并要求配图流程版本仍是调用方读到的那一版。
/// </summary>
public static class LiteraryMarkerWrites
{
    private static readonly string[] MarkerFields = { "draftText", "status", "runId", "errorMessage", "url" };

    /// <summary>更新一个标记的显示字段。返回 false 表示版本已变或标记不存在（调用方应重读）。</summary>
    public static async Task<bool> PatchMarkerAsync(
        MongoDbContext db, string workspaceId, int version, int markerIndex,
        IReadOnlyDictionary<string, object?> fields, ArticleIllustrationPlanItem? planItem)
    {
        var F = Builders<ImageMasterWorkspace>.Filter;
        var U = Builders<ImageMasterWorkspace>.Update;
        var now = DateTime.UtcNow;
        var updates = new List<UpdateDefinition<ImageMasterWorkspace>>
        {
            U.Set("articleWorkflow.markers.$[m].updatedAt", now),
            U.Set("articleWorkflow.updatedAt", now),
            U.Set(x => x.UpdatedAt, now),
        };
        foreach (var (name, value) in fields)
        {
            if (!MarkerFields.Contains(name)) throw new ArgumentException($"不支持的标记字段 {name}", nameof(fields));
            updates.Add(U.Set($"articleWorkflow.markers.$[m].{name}", value));
        }
        if (planItem != null) updates.Add(U.Set("articleWorkflow.markers.$[m].planItem", planItem));
        var result = await db.ImageMasterWorkspaces.UpdateOneAsync(
            F.And(F.Eq(x => x.Id, workspaceId), VersionIs(version),
                F.ElemMatch(x => x.ArticleWorkflow!.Markers, m => m.Index == markerIndex)),
            U.Combine(updates),
            new UpdateOptions { ArrayFilters = new[] { MarkerFilter(markerIndex) } },
            CancellationToken.None);
        return result.MatchedCount > 0;
    }

    /// <summary>把一张（手动上传 / 网页持久化的）图挂到指定标记上，并重算完成张数。</summary>
    public static async Task<bool> PointMarkerAsync(MongoDbContext db, string workspaceId, int version, int markerIndex, string assetId)
    {
        var F = Builders<ImageMasterWorkspace>.Filter;
        var U = Builders<ImageMasterWorkspace>.Update;
        var now = DateTime.UtcNow;
        var key = markerIndex.ToString();
        var filter = F.And(F.Eq(x => x.Id, workspaceId), F.Ne(x => x.ArticleWorkflow, null), VersionIs(version));
        var hasMarker = await db.ImageMasterWorkspaces.Find(F.And(filter,
            F.ElemMatch(x => x.ArticleWorkflow!.Markers, m => m.Index == markerIndex))).AnyAsync(CancellationToken.None);
        var update = U.Set($"articleWorkflow.assetIdByMarkerIndex.{key}", assetId)
            .Set($"articleWorkflow.assetRunAtByMarkerIndex.{key}", now)
            .Set("articleWorkflow.updatedAt", now);
        UpdateResult result;
        if (hasMarker)
        {
            update = update.Set("articleWorkflow.markers.$[m].status", "done")
                .Set("articleWorkflow.markers.$[m].assetId", assetId)
                .Set("articleWorkflow.markers.$[m].errorMessage", (string?)null)
                .Set("articleWorkflow.markers.$[m].updatedAt", now);
            result = await db.ImageMasterWorkspaces.UpdateOneAsync(filter, update,
                new UpdateOptions { ArrayFilters = new[] { MarkerFilter(markerIndex) } }, CancellationToken.None);
        }
        else
        {
            result = await db.ImageMasterWorkspaces.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
        }
        if (result.MatchedCount == 0) return false;

        var latest = await db.ImageMasterWorkspaces.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
        var done = latest?.ArticleWorkflow?.AssetIdByMarkerIndex?.Values.Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().Count() ?? 0;
        await db.ImageMasterWorkspaces.UpdateOneAsync(filter,
            U.Set(x => x.ArticleWorkflow!.DoneImageCount, done), cancellationToken: CancellationToken.None);
        return true;
    }

    /// <summary>版本判据。很早的工作区文档里没有 version 字段（读出来是默认值 0），0 版要把「字段缺失」一并认下。</summary>
    private static FilterDefinition<ImageMasterWorkspace> VersionIs(int version)
    {
        var F = Builders<ImageMasterWorkspace>.Filter;
        return version == 0
            ? F.Or(F.Eq("articleWorkflow.version", 0), F.Exists("articleWorkflow.version", false))
            : F.Eq("articleWorkflow.version", version);
    }

    private static ArrayFilterDefinition MarkerFilter(int markerIndex)
        => new BsonDocumentArrayFilterDefinition<MongoDB.Bson.BsonDocument>(new MongoDB.Bson.BsonDocument("m.index", markerIndex));
}
