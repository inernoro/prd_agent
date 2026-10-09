using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文学配图「用哪套风格 / 水印 / 尺寸」的唯一判定源。
///
/// 智能体（开放接口）与网页（编辑页生图）都从这里取值：以前这套规则只写在开放接口控制器里，
/// 网页生图沿用账号默认，于是同一篇文章里出现两种水印（同一判据分成两份，形状 3）。
/// </summary>
public static class LiteraryIllustrationChoices
{
    internal const string AppKey = "literary-agent";
    internal const string DefaultSize = "1024x1024";
    internal const string LegacyStyleId = "legacy-default";

    /// <summary>比例 → 1K 档尺寸。与前端 imageAspectOptions 的 size1k 列同源（文学页的尺寸选项就是这张表）。</summary>
    public static readonly IReadOnlyDictionary<string, string> AspectSizes = new Dictionary<string, string>
    {
        ["1:1"] = "1024x1024", ["4:3"] = "1200x896", ["3:4"] = "896x1200", ["4:5"] = "928x1152",
        ["5:4"] = "1152x928", ["16:9"] = "1376x768", ["9:16"] = "768x1376", ["2:3"] = "848x1264",
        ["3:2"] = "1264x848", ["21:9"] = "1584x672",
    };

    public sealed record StyleChoice(string? StyleId, string Label, string? Sha, string? PromptPrefix);
    public sealed record WatermarkChoice(string WatermarkId, string Label);

    public static bool IsNone(string value)
        => value.Equals("none", StringComparison.OrdinalIgnoreCase) || value is "无" or "不使用" or "不要";

    /// <summary>
    /// 风格（参考图配置）按 ID 或名称选。不传时与网页完全同一个判据：当前启用且有参考图的那套 →
    /// 历史的全局参考图 → 无。选中的结果会回给调用方，不再让它猜「平台到底套了哪一套」。
    /// </summary>
    public static async Task<(StyleChoice? choice, string? error)> ResolveStyleAsync(MongoDbContext db, string userId, string? style, CancellationToken ct)
    {
        var wanted = style?.Trim();
        var configs = await db.ReferenceImageConfigs.Find(x => x.AppKey == AppKey && x.CreatedByAdminId == userId).ToListAsync(ct);
        if (string.IsNullOrEmpty(wanted))
        {
            var active = configs.FirstOrDefault(x => x.IsActive && !string.IsNullOrWhiteSpace(x.ImageSha256));
            if (active != null)
                return (new StyleChoice(active.Id, active.Name, active.ImageSha256!.Trim().ToLowerInvariant(),
                    string.IsNullOrWhiteSpace(active.Prompt) ? null : active.Prompt), null);
            var legacy = await LegacyStyleAsync(db, ct);
            return (legacy ?? new StyleChoice("none", "不使用参考图", null, null), null);
        }
        if (IsNone(wanted)) return (new StyleChoice("none", "不使用参考图", null, null), null);
        if (wanted == LegacyStyleId)
        {
            var legacy = await LegacyStyleAsync(db, ct);
            return legacy == null ? (null, "系统默认参考图不存在，请用 map_literary_list_presets 查看可用风格。") : (legacy, null);
        }
        var hits = configs.Where(x => x.Id == wanted).ToList();
        if (hits.Count == 0)
            hits = configs.Where(x => string.Equals(x.Name?.Trim(), wanted, StringComparison.OrdinalIgnoreCase)).ToList();
        if (hits.Count == 0)
        {
            var names = configs.Select(x => $"「{x.Name}」").ToList();
            return (null, names.Count == 0
                ? $"没有叫「{wanted}」的风格：这个账号在文学创作里还没有任何参考图配置，请先在页面「风格/参考图」里建一套，或传 none。"
                : $"没有叫「{wanted}」的风格。可用的有：{string.Join("、", names)}（也可传 none）。");
        }
        if (hits.Count > 1)
            return (null, $"有 {hits.Count} 套风格都叫「{wanted}」，请改传 ID：{string.Join("、", hits.Select(x => x.Id))}。");
        var hit = hits[0];
        var sha = string.IsNullOrWhiteSpace(hit.ImageSha256) ? null : hit.ImageSha256.Trim().ToLowerInvariant();
        return (new StyleChoice(hit.Id, hit.Name, sha, string.IsNullOrWhiteSpace(hit.Prompt) ? null : hit.Prompt), null);
    }

    public static async Task<StyleChoice?> LegacyStyleAsync(MongoDbContext db, CancellationToken ct)
    {
        var legacy = await db.LiteraryAgentConfigs.Find(x => x.Id == AppKey).FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(legacy?.ReferenceImageSha256) ? null
            : new StyleChoice(LegacyStyleId, "系统默认参考图", legacy.ReferenceImageSha256.Trim().ToLowerInvariant(), null);
    }

    /// <summary>
    /// 水印按 ID 或名称选。不传时在**入队这一刻**就把「账号给文学创作绑定的那套」钉进任务，
    /// 执行时不再重新猜——入队后改了绑定，也不会让已经排上的任务换一套水印。
    /// </summary>
    public static async Task<(WatermarkChoice? choice, string? error)> ResolveWatermarkAsync(MongoDbContext db, string userId, string? watermark, CancellationToken ct)
    {
        var wanted = watermark?.Trim();
        var configs = await db.WatermarkConfigs.Find(x => x.UserId == userId).ToListAsync(ct);
        if (string.IsNullOrEmpty(wanted))
        {
            var bound = configs.FirstOrDefault(x => x.AppKeys != null && x.AppKeys.Contains(AppKey));
            return (bound == null ? new WatermarkChoice(WatermarkSelection.None, "不打水印（账号未给文学创作绑定水印）")
                : new WatermarkChoice(bound.Id, bound.Name), null);
        }
        if (IsNone(wanted)) return (new WatermarkChoice(WatermarkSelection.None, "不打水印"), null);
        var hits = configs.Where(x => x.Id == wanted).ToList();
        if (hits.Count == 0)
            hits = configs.Where(x => string.Equals(x.Name?.Trim(), wanted, StringComparison.OrdinalIgnoreCase)).ToList();
        if (hits.Count == 0)
        {
            var names = configs.Select(x => $"「{x.Name}」").ToList();
            return (null, names.Count == 0
                ? $"没有叫「{wanted}」的水印：这个账号还没有任何水印配置，请先在页面「水印」里建一套，或传 none。"
                : $"没有叫「{wanted}」的水印。可用的有：{string.Join("、", names)}（也可传 none）。");
        }
        if (hits.Count > 1)
            return (null, $"有 {hits.Count} 套水印都叫「{wanted}」，请改传 ID：{string.Join("、", hits.Select(x => x.Id))}。");
        return (new WatermarkChoice(hits[0].Id, hits[0].Name), null);
    }

    public static (string? size, string? error) ResolveSize(string? size)
    {
        var wanted = size?.Trim();
        if (string.IsNullOrEmpty(wanted)) return (DefaultSize, null);
        if (AspectSizes.TryGetValue(wanted.Replace('：', ':'), out var mapped)) return (mapped, null);
        var m = System.Text.RegularExpressions.Regex.Match(wanted.ToLowerInvariant().Replace('×', 'x').Replace('*', 'x'), @"^(\d{3,4})x(\d{3,4})$");
        if (m.Success && int.Parse(m.Groups[1].Value) is >= 256 and <= 4096 && int.Parse(m.Groups[2].Value) is >= 256 and <= 4096)
            return ($"{m.Groups[1].Value}x{m.Groups[2].Value}", null);
        return (null, $"尺寸「{wanted}」认不出来。传比例（{string.Join(" / ", AspectSizes.Keys)}）或 宽x高（256-4096）。");
    }

    /// <summary>
    /// 一篇文章当前该用的风格与水印：这篇记住的优先（记住的那套已被删时退回账号默认并给出说明），否则账号默认。
    /// 返回值里的 source：remembered / account-default。
    /// </summary>
    public static async Task<(StyleChoice style, string styleSource, WatermarkChoice watermark, string watermarkSource, List<string> notes)>
        ResolveForArticleAsync(MongoDbContext db, string userId, LiteraryIllustrationPrefs? prefs, CancellationToken ct)
    {
        var notes = new List<string>();
        var styleSource = !string.IsNullOrWhiteSpace(prefs?.StyleId) ? "remembered" : "account-default";
        var (style, styleError) = await ResolveStyleAsync(db, userId, prefs?.StyleId, ct);
        if (styleError != null)
        {
            (style, _) = await ResolveStyleAsync(db, userId, null, ct);
            styleSource = "account-default";
            notes.Add("这篇文章上次用的风格已不存在，本次改用账号默认风格。");
        }
        var watermarkSource = !string.IsNullOrWhiteSpace(prefs?.WatermarkId) ? "remembered" : "account-default";
        var (watermark, watermarkError) = await ResolveWatermarkAsync(db, userId, prefs?.WatermarkId, ct);
        if (watermarkError != null)
        {
            (watermark, _) = await ResolveWatermarkAsync(db, userId, null, ct);
            watermarkSource = "account-default";
            notes.Add("这篇文章上次用的水印已不存在，本次改用账号默认水印。");
        }
        return (style!, styleSource, watermark!, watermarkSource, notes);
    }

    /// <summary>
    /// 把这次明确指定的风格 / 水印 / 尺寸记到文章上，只动给了的那几项。
    /// 文章还没有设定（或被网页清空成 null）时没有字段可按路径改，就整份建一个只含这几项的；
    /// 两步都带「当时是否为空」的条件，夹在中间被别人建好了就再按字段改一次。
    /// 智能体生图与网页顶栏都走这里：整份写回读到的快照，会把另一个入口刚改的那一项改回去。
    /// </summary>
    public static async Task RememberExplicitAsync(MongoDbContext db, string workspaceId, string ownerUserId, string? styleId, string? watermarkId, string? size)
    {
        var F = Builders<ImageMasterWorkspace>.Filter;
        var U = Builders<ImageMasterWorkspace>.Update;
        var owned = F.And(F.Eq(x => x.Id, workspaceId), F.Eq(x => x.OwnerUserId, ownerUserId));
        var now = DateTime.UtcNow;
        var sets = new List<UpdateDefinition<ImageMasterWorkspace>> { U.Set(x => x.IllustrationPrefs!.UpdatedAt, now) };
        if (styleId != null) sets.Add(U.Set(x => x.IllustrationPrefs!.StyleId, styleId));
        if (watermarkId != null) sets.Add(U.Set(x => x.IllustrationPrefs!.WatermarkId, watermarkId));
        if (size != null) sets.Add(U.Set(x => x.IllustrationPrefs!.Size, size));
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var patched = await db.ImageMasterWorkspaces.UpdateOneAsync(F.And(owned, F.Ne(x => x.IllustrationPrefs, null)),
                U.Combine(sets), cancellationToken: CancellationToken.None);
            if (patched.MatchedCount > 0) return;
            var created = await db.ImageMasterWorkspaces.UpdateOneAsync(F.And(owned, F.Eq(x => x.IllustrationPrefs, null)),
                U.Set(x => x.IllustrationPrefs, new LiteraryIllustrationPrefs { StyleId = styleId, WatermarkId = watermarkId, Size = size, UpdatedAt = now }),
                cancellationToken: CancellationToken.None);
            if (created.MatchedCount > 0) return;
        }
    }
}
