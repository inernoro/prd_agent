using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 一篇文章生成过的全部配图，以及「把某张旧图放回原位」。
///
/// 网页「历史配图」与智能体（MCP）读的是同一份：以前只有网页能看，智能体只拿到一个数字，
/// 用户说「换回原来那张」它无从下手。放回也只有这一处实现，两边按钮 / 工具都走它。
/// </summary>
public static class LiteraryIllustrationHistory
{
    /// <param name="ReplacedAt">什么时候不再挂在正文上；仍在用或算不出来时为空</param>
    /// <param name="ReplacedReason">为什么被换下（人话）</param>
    /// <param name="InLastSet">是不是「上一次换稿前在用的那组」里的一张</param>
    public sealed record Item(
        string Id, string Url, int Width, int Height, string? Prompt,
        int? MarkerIndex, string? MarkerText, int? WorkflowVersion, bool IsCurrent, DateTime CreatedAt,
        DateTime? ReplacedAt, string? ReplacedReason, bool InLastSet);

    public sealed record Group(int? WorkflowVersion, bool IsCurrentVersion, List<Item> Items);

    public sealed record SetImage(int MarkerIndex, string AssetId, string Url, string? Description);

    /// <summary>某一次换稿前挂在正文上的那一组图（存档时记下的，不是按生成时间推断的）。</summary>
    public sealed record PreviousSet(int WorkflowVersion, DateTime? ArchivedAt, string Reason, List<SetImage> Images);

    public sealed record Result(int CurrentVersion, int Total, int CurrentCount, List<Group> Groups, List<PreviousSet> PreviousSets);

    public static async Task<List<ImageAsset>> LoadAssetsAsync(MongoDbContext db, string workspaceId, CancellationToken ct)
        => await db.ImageAssets.Find(x => x.WorkspaceId == workspaceId)
            .SortByDescending(x => x.CreatedAt).Limit(1000).ToListAsync(ct);

    /// <param name="resolveUrl">把存储里的地址转成调用方能直接打开的地址（开放接口要绝对地址）</param>
    public static Result Build(ImageMasterWorkspace ws, List<ImageAsset> assets, Func<string, string>? resolveUrl = null)
    {
        var current = LiteraryMcpWorkflow.SelectCurrent(ws, assets);
        var currentIds = current.Values.Select(a => a.Id).ToHashSet(StringComparer.Ordinal);
        var currentVersion = ws.ArticleWorkflow?.Version ?? 0;
        // 资产自己记下的描述优先；没有（早期数据）才借当前版本同位置标记的描述
        var markerText = ws.ArticleWorkflow?.Markers?.GroupBy(m => m.Index)
            .ToDictionary(g => g.Key, g => LiteraryMcpWorkflow.EffectivePrompt(g.First()))
            ?? new Dictionary<int, string>();

        string Url(string u) => resolveUrl == null ? u : resolveUrl(u);
        var byId = assets.ToDictionary(a => a.Id, StringComparer.Ordinal);

        // 存档里记着每次换稿前真正在用的那组：从新到旧
        var archived = (ws.ArticleWorkflowHistory ?? new List<ArticleIllustrationWorkflow>())
            .Where(w => w.AssetIdByMarkerIndex.Count > 0)
            .ToList();
        var previousSets = archived.Take(5).Select(w => new PreviousSet(
            w.Version, w.ArchivedAt, LiteraryArchiveReason.Label(w.ArchivedReason),
            w.AssetIdByMarkerIndex
                .Select(kv => (ok: int.TryParse(kv.Key, out var idx), idx, id: kv.Value))
                .Where(x => x.ok && byId.ContainsKey(x.id))
                .OrderBy(x => x.idx)
                // 描述取那一版标记的生效描述：带标记写回时沿用就是拿它来比对的，照着它写回一定接得上
                .Select(x => new SetImage(x.idx, x.id, Url(byId[x.id].Url),
                    w.Markers.Where(m => m.Index == x.idx).Select(LiteraryMcpWorkflow.EffectivePrompt).FirstOrDefault()
                        ?? byId[x.id].OriginalMarkerText))
                .ToList()))
            .Where(set => set.Images.Count > 0)
            .ToList();
        var lastSetIds = previousSets.FirstOrDefault()?.Images.Select(i => i.AssetId).ToHashSet(StringComparer.Ordinal)
            ?? new HashSet<string>(StringComparer.Ordinal);

        // 换下时间：先找这张图最后一次在用的那一版（它生成的那版、被沿用 / 放回进去的那版、存档时在用的那版），
        // 再看它在那一版里是怎么下来的：存档时还挂着 = 那次换稿换下；否则 = 那一版里同位置换上了别的图。
        // 只按「哪份存档里有它」判断会出错：存档后又被沿用回来、再被放回顶掉的图，会错显成早先那次换稿。
        var timeline = archived.AsEnumerable().Reverse().ToList(); // 旧 → 新
        if (ws.ArticleWorkflow != null) timeline.Add(ws.ArticleWorkflow);
        (DateTime? at, string? reason) ReplacedOf(ImageAsset a)
        {
            if (currentIds.Contains(a.Id)) return (null, null);
            var last = timeline.LastOrDefault(w =>
                w.AssetIdByMarkerIndex.ContainsValue(a.Id)
                || (w.AdoptedAssetIds?.Contains(a.Id) ?? false)
                || (a.ArticleWorkflowVersion != null && a.ArticleWorkflowVersion == w.Version));
            if (last == null) return (null, null);
            if (last.ArchivedAt != null && last.AssetIdByMarkerIndex.ContainsValue(a.Id))
                return (last.ArchivedAt, LiteraryArchiveReason.Label(last.ArchivedReason));
            if (last.ArchivedAt == null && ws.ArticleWorkflow != null && !ReferenceEquals(last, ws.ArticleWorkflow) && last.AssetIdByMarkerIndex.ContainsValue(a.Id))
                return (null, LiteraryArchiveReason.Label(last.ArchivedReason)); // 早期存档：没有时间
            var marker = last.AssetIdByMarkerIndex.FirstOrDefault(kv => kv.Value == a.Id).Key
                ?? a.ArticleInsertionIndex?.ToString();
            if (marker == null) return (null, null);
            var later = assets
                .Where(o => o.Id != a.Id && o.ArticleInsertionIndex?.ToString() == marker && o.ArticleWorkflowVersion == last.Version && o.CreatedAt > a.CreatedAt)
                .Select(o => (DateTime?)o.CreatedAt);
            if (last.AssetRunAtByMarkerIndex?.TryGetValue(marker, out var pointedAt) == true
                && last.AssetIdByMarkerIndex.TryGetValue(marker, out var pointedId) && pointedId != a.Id)
                later = later.Append(pointedAt);
            var when = later.Min();
            return (when, when == null ? null : "同一位置换上了别的图（重画或放回）");
        }

        var items = assets.Select(a =>
        {
            var (replacedAt, replacedReason) = ReplacedOf(a);
            return new Item(
                a.Id,
                Url(a.Url),
                a.Width, a.Height, a.Prompt,
                a.ArticleInsertionIndex,
                a.OriginalMarkerText
                    ?? (a.ArticleInsertionIndex is { } mi && (a.ArticleWorkflowVersion ?? currentVersion) == currentVersion
                        && markerText.TryGetValue(mi, out var t) ? t : null),
                a.ArticleWorkflowVersion,
                currentIds.Contains(a.Id),
                a.CreatedAt,
                replacedAt, replacedReason,
                lastSetIds.Contains(a.Id));
        }).ToList();

        var groups = items
            .GroupBy(x => x.WorkflowVersion ?? (x.IsCurrent ? currentVersion : -1))
            .OrderByDescending(g => g.Key == currentVersion)
            .ThenByDescending(g => g.Key)
            .Select(g => new Group(
                g.Key < 0 ? null : g.Key,
                g.Key == currentVersion,
                g.OrderBy(x => x.MarkerIndex ?? int.MaxValue).ThenByDescending(x => x.CreatedAt).ToList()))
            .ToList();

        return new Result(currentVersion, items.Count, currentIds.Count, groups, previousSets);
    }

    public enum RestoreFailure { None, NoMarkers, MarkerNotFound, AssetNotFound, VersionChanged }

    public sealed record RestoreResult(RestoreFailure Failure, string? Message, int MarkerIndex, string? Url, string? Description)
    {
        public bool Ok => Failure == RestoreFailure.None;
    }

    /// <summary>
    /// 把这篇文章的某张旧图挂回到指定标记上。旧图本身不动，被换下的那张同样留在历史里。
    ///
    /// 图记着自己当初按哪段描述画的，就把标记描述一并换成它——否则又是「图和描述对不上」：
    /// 下一次改稿按描述匹配沿用，会把这张图错配出去。早期没记描述的图只换图，描述保留，并如实说明。
    /// </summary>
    public static async Task<RestoreResult> RestoreAsync(
        MongoDbContext db, ImageMasterWorkspace ws, string assetId, int markerIndex, int workflowVersion, CancellationToken ct)
    {
        var workflow = ws.ArticleWorkflow;
        if (workflow == null || workflow.Markers.Count == 0)
            return new(RestoreFailure.NoMarkers, "这篇文章现在没有配图标记，旧图没有位置可放。先生成配图标记（或带标记改稿）再放回。", markerIndex, null, null);
        var marker = workflow.Markers.FirstOrDefault(m => m.Index == markerIndex);
        if (marker == null)
            return new(RestoreFailure.MarkerNotFound,
                $"配图标记 {markerIndex} 不存在（这篇共 {workflow.Markers.Count} 个，从 0 开始）。", markerIndex, null, null);
        var asset = await db.ImageAssets.Find(x => x.Id == assetId && x.WorkspaceId == ws.Id).FirstOrDefaultAsync(ct);
        if (asset == null)
            return new(RestoreFailure.AssetNotFound, "这张图不属于这篇文章，或已不存在。先读一遍历史配图拿到 assetId。", markerIndex, null, null);

        if (!await LiteraryMarkerWrites.PointMarkerAsync(db, ws.Id, workflowVersion, markerIndex, asset.Id))
            return new(RestoreFailure.VersionChanged, "配图方案已经更新（正文被改过或重新规划了标记），请重读后再放回。", markerIndex, null, null);

        var description = string.IsNullOrWhiteSpace(asset.OriginalMarkerText) ? null : asset.OriginalMarkerText.Trim();
        // runId 指向的是被换下那张图的任务，留着会误导；放回的图用 assetId 识别
        var fields = new Dictionary<string, object?> { ["url"] = asset.Url, ["runId"] = null };
        ArticleIllustrationPlanItem? planItem = null;
        if (description != null)
        {
            fields["draftText"] = description;
            planItem = new ArticleIllustrationPlanItem
            {
                Prompt = description,
                Count = marker.PlanItem?.Count ?? 1,
                Size = marker.PlanItem?.Size,
            };
        }
        await LiteraryMarkerWrites.PatchMarkerAsync(db, ws.Id, workflowVersion, markerIndex, fields, planItem);
        await db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == ws.Id,
            Builders<ImageMasterWorkspace>.Update.AddToSet("articleWorkflow.adoptedAssetIds", asset.Id),
            cancellationToken: CancellationToken.None);
        return new(RestoreFailure.None,
            description == null ? "已放回。这张图是早期生成的，没有记下当初的描述，标记描述保持不变。" : null,
            markerIndex, asset.Url, description ?? LiteraryMcpWorkflow.EffectivePrompt(marker));
    }
}
