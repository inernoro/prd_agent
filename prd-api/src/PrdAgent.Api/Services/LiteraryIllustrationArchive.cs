using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
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
    /// 两个入口现在都经 <see cref="WriteContentResetAsync"/> 调这一处（它负责带快照条件写库并盖版本号）。
    /// </summary>
    public static UpdateDefinition<ImageMasterWorkspace> ContentResetUpdate(
        ImageMasterWorkspace ws, IEnumerable<ImageAsset> assets, DateTime now, string reason)
    {
        var history = ArchiveCurrent(ws, assets, now, reason);
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

    /// <summary>
    /// 网页这次提交算不算「换了正文」。清空也算（如上传了一个空文件）：旧标记、带标记正文与挂图指针
    /// 不能挂在空文章上。两个网页更新入口共用这一个判据——此前各写一份，修了一处另一处照旧。
    /// </summary>
    public static bool IsContentChange(ImageMasterWorkspace ws, string? newContent)
        => newContent != null && !string.Equals(newContent, ws.ArticleContent ?? string.Empty, StringComparison.Ordinal);

    public enum ContentResetOutcome { Written, WorkspaceGone, KeptChanging }

    /// <summary>
    /// 网页换正文的写入：以读到的配图方案版本为条件写，对不上（中间插进了一次整篇重写 / 重新规划）
    /// 就按最新状态重算一次再写。只按 id 写的话，两次换稿会从同一份旧快照推出同一个版本号，
    /// 后写的把先写的方案与历史整个盖掉，还在跑的旧任务也会按这个撞号的版本通过回填校验。
    /// 用户在网页上明确换了正文，按最新状态重来正是他的意图，所以重试而不是直接拒绝；连续几次都被抢先才放弃。
    /// </summary>
    /// <param name="otherFields">同一次提交里的其它字段（标题、文件夹等），与换稿在同一次写入里落库</param>
    public static async Task<ContentResetOutcome> WriteContentResetAsync(
        MongoDbContext db, ImageMasterWorkspace ws, string newContent,
        UpdateDefinition<ImageMasterWorkspace> otherFields, string reason, CancellationToken ct)
    {
        var F = Builders<ImageMasterWorkspace>.Filter;
        var current = ws;
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var now = DateTime.UtcNow;
            var assets = await LiteraryIllustrationHistory.LoadAssetsAsync(db, current.Id, ct);
            var update = Builders<ImageMasterWorkspace>.Update.Combine(otherFields,
                ContentResetUpdate(current, assets, now, reason).Set(x => x.ArticleContent, newContent));
            var sameWorkflow = current.ArticleWorkflow == null
                ? F.Eq(x => x.ArticleWorkflow, null)
                : LiteraryMarkerWrites.VersionIs(current.ArticleWorkflow.Version);
            var result = await db.ImageMasterWorkspaces.UpdateOneAsync(F.And(F.Eq(x => x.Id, current.Id), sameWorkflow),
                update, cancellationToken: CancellationToken.None);
            if (result.MatchedCount > 0)
            {
                await StampUnversionedAsync(db, current.Id, current.ArticleWorkflow?.Version ?? 0);
                return ContentResetOutcome.Written;
            }
            current = await db.ImageMasterWorkspaces.Find(x => x.Id == ws.Id).FirstOrDefaultAsync(CancellationToken.None);
            if (current == null) return ContentResetOutcome.WorkspaceGone;
        }
        return ContentResetOutcome.KeptChanging;
    }

    /// <summary>
    /// 把当前配图方案存进历史（最多 10 份），三处换稿入口（网页换正文、智能体整篇重写、网页重新生成标记）都走这里。
    ///
    /// 存的不是方案原样：AssetIdByMarkerIndex 改写成那一刻<b>真正挂在正文上</b>的图（与正文、导出同一个判定源，
    /// 含手动放回的旧图、按版本推断出来的图），并记下换下的时间与原因。以前三处各抄一份「原样塞进历史」，
    /// 用户说「恢复成上传前最后用的」时，只能按生成时间去猜，手动放回过旧图就猜错。
    /// </summary>
    public static List<ArticleIllustrationWorkflow> ArchiveCurrent(
        ImageMasterWorkspace ws, IEnumerable<ImageAsset> assets, DateTime now, string reason)
    {
        var history = (ws.ArticleWorkflowHistory ?? new List<ArticleIllustrationWorkflow>()).ToList();
        var workflow = ws.ArticleWorkflow;
        if (workflow == null) return history;
        var current = LiteraryMcpWorkflow.SelectCurrent(ws, assets);
        history.Insert(0, new ArticleIllustrationWorkflow
        {
            Version = workflow.Version,
            Phase = workflow.Phase,
            Markers = workflow.Markers,
            ExpectedImageCount = workflow.ExpectedImageCount,
            DoneImageCount = current.Count,
            AssetIdByMarkerIndex = current.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value.Id),
            AssetRunAtByMarkerIndex = workflow.AssetRunAtByMarkerIndex,
            UpdatedAt = workflow.UpdatedAt,
            ArchivedAt = now,
            ArchivedReason = LiteraryArchiveReason.Normalize(reason),
            AdoptedAssetIds = workflow.AdoptedAssetIds ?? new List<string>(),
        });
        return history.Count > 10 ? history.Take(10).ToList() : history;
    }

    /// <summary>把该工作区里带插入位、但没有版本号的配图归到 <paramref name="version"/>。</summary>
    public static Task StampUnversionedAsync(MongoDbContext db, string workspaceId, int version)
        => db.ImageAssets.UpdateManyAsync(
            x => x.WorkspaceId == workspaceId && x.ArticleInsertionIndex != null && x.ArticleWorkflowVersion == null,
            Builders<ImageAsset>.Update.Set(x => x.ArticleWorkflowVersion, version),
            cancellationToken: CancellationToken.None);
}

/// <summary>配图方案被换下的原因：有限取值，人话标签只在这一处。</summary>
public static class LiteraryArchiveReason
{
    public const string WebContent = "web-content";
    public const string AgentRewrite = "agent-rewrite";
    public const string Replan = "replan";

    private static readonly Dictionary<string, string> Labels = new(StringComparer.Ordinal)
    {
        [WebContent] = "网页上换了正文",
        [AgentRewrite] = "智能体整篇重写",
        [Replan] = "网页重新生成配图标记",
    };

    public static string Normalize(string reason)
        => Labels.ContainsKey(reason) ? reason : throw new ArgumentOutOfRangeException(nameof(reason), reason, "未登记的换稿原因");

    /// <summary>早期存进历史的方案没有记原因，读作「换稿」。</summary>
    public static string Label(string? reason) => reason != null && Labels.TryGetValue(reason, out var label) ? label : "换稿";
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
    /// <param name="unchangedSince">给了就再加一个条件：工作区自那个版本令牌之后没被改过（覆盖描述时防冲掉别人的修改）</param>
    public static async Task<bool> PatchMarkerAsync(
        MongoDbContext db, string workspaceId, int version, int markerIndex,
        IReadOnlyDictionary<string, object?> fields, ArticleIllustrationPlanItem? planItem, DateTime? unchangedSince = null)
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
        var filter = F.And(F.Eq(x => x.Id, workspaceId), VersionIs(version),
            F.ElemMatch(x => x.ArticleWorkflow!.Markers, m => m.Index == markerIndex));
        if (unchangedSince is { } since) filter = F.And(filter, F.Eq(x => x.UpdatedAt, since));
        var result = await db.ImageMasterWorkspaces.UpdateOneAsync(
            filter,
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

        // 并发上传（页面批量生图会同时回传多张）时各自读到的快照新旧不一：只在新值更大时写，
        // 陈旧的较小计数后落地也压不低——与 ImageGenRunWorker 回填同一个单调门控。
        var latest = await db.ImageMasterWorkspaces.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
        var done = latest?.ArticleWorkflow?.AssetIdByMarkerIndex?.Values.Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().Count() ?? 0;
        await db.ImageMasterWorkspaces.UpdateOneAsync(F.And(filter, F.Lt(x => x.ArticleWorkflow!.DoneImageCount, done)),
            U.Set(x => x.ArticleWorkflow!.DoneImageCount, done), cancellationToken: CancellationToken.None);
        return true;
    }

    /// <summary>
    /// 把一张旧图放回指定标记：指针、标记显示字段、描述、「被放回过」记录在<b>同一次</b>带版本条件的写入里完成。
    /// 以前拆成「挂指针」与「改标记」两步，中间换了稿，第二步落空却照样报成功——界面说放回了，新方案里其实没有它。
    /// 返回 false 表示版本已变或标记不存在（调用方应重读）。
    /// </summary>
    /// <param name="description">图当初的描述；为空则只换图、描述保持不变</param>
    public static async Task<bool> RestoreMarkerAsync(
        MongoDbContext db, string workspaceId, int version, int markerIndex, ImageAsset asset,
        string? description, ArticleIllustrationPlanItem? planItem)
    {
        var F = Builders<ImageMasterWorkspace>.Filter;
        var U = Builders<ImageMasterWorkspace>.Update;
        var now = DateTime.UtcNow;
        var key = markerIndex.ToString();
        var filter = F.And(F.Eq(x => x.Id, workspaceId), F.Ne(x => x.ArticleWorkflow, null), VersionIs(version),
            F.ElemMatch(x => x.ArticleWorkflow!.Markers, m => m.Index == markerIndex));
        var update = U.Set($"articleWorkflow.assetIdByMarkerIndex.{key}", asset.Id)
            .Set($"articleWorkflow.assetRunAtByMarkerIndex.{key}", now)
            .Set("articleWorkflow.updatedAt", now)
            .Set(x => x.UpdatedAt, now)
            .AddToSet("articleWorkflow.adoptedAssetIds", asset.Id)
            .Set("articleWorkflow.markers.$[m].status", "done")
            .Set("articleWorkflow.markers.$[m].assetId", asset.Id)
            .Set("articleWorkflow.markers.$[m].url", asset.Url)
            // runId 指向的是被换下那张图的任务，留着会误导；放回的图用 assetId 识别
            .Set("articleWorkflow.markers.$[m].runId", (string?)null)
            .Set("articleWorkflow.markers.$[m].errorMessage", (string?)null)
            .Set("articleWorkflow.markers.$[m].updatedAt", now);
        if (description != null) update = update.Set("articleWorkflow.markers.$[m].draftText", description);
        if (planItem != null) update = update.Set("articleWorkflow.markers.$[m].planItem", planItem);
        var result = await db.ImageMasterWorkspaces.UpdateOneAsync(filter, update,
            new UpdateOptions { ArrayFilters = new[] { MarkerFilter(markerIndex) } }, CancellationToken.None);
        if (result.MatchedCount == 0) return false;

        // 完成张数是派生值，按写入后的指针重算（不参与「放没放回去」的判定）。
        // 放回可能让计数变小（放回的是已挂在别处的图），所以不能用「只增不减」的门控；改为以读到的
        // 方案时间戳为条件：读完之后又有人改了指针，就让后来者按更新的指针去写，陈旧快照不落地。
        var latest = await db.ImageMasterWorkspaces.Find(F.And(F.Eq(x => x.Id, workspaceId), VersionIs(version))).FirstOrDefaultAsync(CancellationToken.None);
        if (latest?.ArticleWorkflow is { } wf)
        {
            var done = wf.AssetIdByMarkerIndex?.Values.Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().Count() ?? 0;
            await db.ImageMasterWorkspaces.UpdateOneAsync(
                F.And(F.Eq(x => x.Id, workspaceId), VersionIs(version), F.Eq(x => x.ArticleWorkflow!.UpdatedAt, wf.UpdatedAt)),
                U.Set(x => x.ArticleWorkflow!.DoneImageCount, done), cancellationToken: CancellationToken.None);
        }
        return true;
    }

    /// <summary>版本判据。很早的工作区文档里没有 version 字段（读出来是默认值 0），0 版要把「字段缺失」一并认下。</summary>
    internal static FilterDefinition<ImageMasterWorkspace> VersionIs(int version)
    {
        var F = Builders<ImageMasterWorkspace>.Filter;
        return version == 0
            ? F.Or(F.Eq("articleWorkflow.version", 0), F.Exists("articleWorkflow.version", false))
            : F.Eq("articleWorkflow.version", version);
    }

    private static ArrayFilterDefinition MarkerFilter(int markerIndex)
        => new BsonDocumentArrayFilterDefinition<MongoDB.Bson.BsonDocument>(new MongoDB.Bson.BsonDocument("m.index", markerIndex));
}
