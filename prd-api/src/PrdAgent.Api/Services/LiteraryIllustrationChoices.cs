using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;

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

    /// <summary>
    /// 比例 → 1K 档尺寸。与前端 imageAspectOptions 的 size1k 列同源。只用来在模型同一比例有好几档时挑哪一档、
    /// 以及给按范围收尺寸的模型换算像素；模型收不收，一律以 FitSize 里的模型能力为准。
    /// </summary>
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

    /// <summary>智能体说的尺寸意图：比例（16:9）或精确像素（1536x1024）。只管写法，不管模型收不收。</summary>
    public sealed record SizeRequest(string Raw, int? Width, int? Height, double Ratio)
    {
        public bool IsExact => Width != null;
    }

    /// <summary>一个可用尺寸：按这个比例传进来时会落到的那个像素尺寸。</summary>
    public sealed record SizeChoice(string Aspect, string Size);

    private const double RatioTolerance = 0.02;

    /// <summary>不传 = 1:1；比例或 宽x高 之外的写法直接拒，不猜。</summary>
    public static (SizeRequest? request, string? error) ParseSize(string? size)
    {
        var wanted = size?.Trim();
        if (string.IsNullOrEmpty(wanted)) wanted = "1:1";
        var ratio = System.Text.RegularExpressions.Regex.Match(wanted.Replace('：', ':'), @"^(\d{1,2}):(\d{1,2})$");
        if (ratio.Success && int.Parse(ratio.Groups[1].Value) is > 0 and var a && int.Parse(ratio.Groups[2].Value) is > 0 and var b)
            return (new SizeRequest($"{a}:{b}", null, null, a / (double)b), null);
        var m = System.Text.RegularExpressions.Regex.Match(wanted.ToLowerInvariant().Replace('×', 'x').Replace('*', 'x'), @"^(\d{3,4})x(\d{3,4})$");
        if (m.Success && int.Parse(m.Groups[1].Value) is >= 256 and <= 4096 and var w && int.Parse(m.Groups[2].Value) is >= 256 and <= 4096 and var h)
            return (new SizeRequest($"{w}x{h}", w, h, w / (double)h), null);
        return (null, $"尺寸「{wanted}」认不出来。传比例（如 1:1、16:9、3:2）或 宽x高（如 1024x1024）；当前模型能用哪些，见 map_literary_list_presets 返回的 sizes。");
    }

    /// <summary>
    /// 把尺寸意图落到所选模型真正收的尺寸上（MCP-LIT-18）。判据与网关执行前的校验是同一个函数，
    /// 校验对应所传的能力快照；异构线路切换的共同契约另见 MCP-LIT-19。
    /// 不支持就明说并列出可选项，不悄悄换比例、不换模型。
    /// </summary>
    public static (string? size, string? error) FitSize(SizeRequest request, ImageGenAdapterInfo model, string modelId)
    {
        if (model.SizesNotApplicable)
            return (request.IsExact ? request.Raw : TableSizeFor(request.Ratio) ?? DefaultSize, null);
        string? candidate;
        var declared = DeclaredSizes(model);
        if (request.IsExact)
            candidate = model.SizeConstraintType == SizeConstraintTypes.AspectRatio
                && !declared.Any(x => x.size == request.Raw) ? null : request.Raw;
        else candidate = PickForRatio(declared, request.Ratio);
        if (candidate != null && GatewayImageModelCatalog.ValidateSize(candidate, model) == null) return (candidate, null);

        var choices = SupportedSizes(model);
        var options = choices.Count > 0
            ? string.Join("、", choices.Select(c => $"{c.Aspect}（{c.Size}）"))
            : string.IsNullOrWhiteSpace(model.SizeConstraintDescription) ? "（模型没有公布尺寸清单）" : model.SizeConstraintDescription;
        return (null, $"当前模型「{modelId}」不支持尺寸「{request.Raw}」，没有入队，也没有扣生图额度。它能用的：{options}。"
            + "请改传其中之一（比例或宽x高都行），或在智能体接入台给这台客户端换一个支持该比例的模型。");
    }

    /// <summary>网页尺寸菜单是有限目录。即使范围模型缺最小面积字段，也不能提交目录外的旧尺寸。</summary>
    public static string? ValidateWebSize(string size, ImageGenAdapterInfo model)
    {
        var error = GatewayImageModelCatalog.ValidateSize(size, model);
        if (error != null || model.SizesNotApplicable) return error;
        return model.SizesByResolution.Values.SelectMany(x => x).Any(x => x.Size == size)
            ? null : "当前模型不支持这个配图尺寸，请从尺寸菜单重新选择后生成。";
    }

    /// <summary>这个模型每个比例实际会落到的尺寸。智能体看预设、被拒时看可选项，都是这一份。</summary>
    public static List<SizeChoice> SupportedSizes(ImageGenAdapterInfo model)
    {
        if (model.SizesNotApplicable) return new();
        return DeclaredSizes(model).GroupBy(x => x.aspect)
            .Select(g => new SizeChoice(g.Key, PickForRatio(g.ToList(), g.First().ratio)!))
            .OrderBy(c => RatioOf(c.Size)).ToList();
    }

    private static List<(string size, int w, int h, string aspect, double ratio)> DeclaredSizes(ImageGenAdapterInfo model)
        => model.SizesByResolution.Values.SelectMany(x => x).DistinctBy(x => x.Size)
            .Where(x => GatewayImageModelCatalog.ValidateSize(x.Size, model) == null)
            .Select(x =>
            {
                var valid = TryParse(x.Size, out var w, out var h);
                var hasAspect = TryAspectRatio(x.AspectRatio, out var ratio);
                return (x.Size, w, h, aspect: hasAspect ? x.AspectRatio : valid ? FriendlyRatio(w, h) : "",
                    ratio: hasAspect ? ratio : valid ? w / (double)h : 0, valid);
            }).Where(x => x.valid)
            .Select(x => (x.Size, x.w, x.h, x.aspect, x.ratio)).ToList();

    /// <summary>
    /// 同一比例常有好几档（512 / 1K / 2K）。网页尺寸表里那一档在就用它（与网页出图一致），
    /// 不在就取面积最接近 1024x1024 的一档：不至于小到 688x384，也不至于大到 4K 拖慢出图。
    /// </summary>
    private static string? PickForRatio(List<(string size, int w, int h, string aspect, double ratio)> sizes, double ratio)
    {
        var matches = sizes.Where(x => SameRatio(x.ratio, ratio)).ToList();
        if (matches.Count == 0) return null;
        var table = TableSizeFor(ratio);
        if (table != null && matches.Any(x => x.size == table)) return table;
        return matches.OrderBy(x => Math.Abs(Math.Log(x.w * (double)x.h / (1024d * 1024d)))).First().size;
    }

    private static string? TableSizeFor(double ratio)
        => AspectSizes.Where(kv => SameRatio(RatioOf(kv.Value), ratio)).Select(kv => kv.Value).FirstOrDefault();

    private static string FriendlyRatio(int w, int h)
        => GatewayImageModelCatalog.DescribeAspectRatio(w, h);

    private static bool SameRatio(double x, double y) => Math.Abs(x - y) / y <= RatioTolerance;

    private static bool TryAspectRatio(string? aspect, out double ratio)
    {
        ratio = 0;
        var parts = aspect?.Split(':');
        if (parts?.Length != 2 || !int.TryParse(parts[0], out var w) || !int.TryParse(parts[1], out var h)
            || w <= 0 || h <= 0) return false;
        ratio = w / (double)h;
        return true;
    }

    private static double RatioOf(string size) => TryParse(size, out var w, out var h) ? w / (double)h : 0;

    private static bool TryParse(string size, out int w, out int h)
    {
        w = h = 0;
        var parts = size.Split('x');
        return parts.Length == 2 && int.TryParse(parts[0], out w) && int.TryParse(parts[1], out h) && w > 0 && h > 0;
    }

    /// <summary>只保留比例：文章记住的是上个模型的像素，换了模型时按同一比例重新落。</summary>
    public static SizeRequest AsRatio(SizeRequest request, string? declaredAspect = null)
        => request.IsExact ? ParseSize(TryAspectRatio(declaredAspect, out _) ? declaredAspect
            : FriendlyRatio(request.Width!.Value, request.Height!.Value)).request! : request;

    /// <summary>上一次落到的尺寸能不能算「同一个尺寸意图」：精确像素要逐字相同，比例只比比例。</summary>
    public static bool SameIntent(string previousSize, SizeRequest request, string? declaredAspect = null)
        => request.IsExact ? previousSize == request.Raw
            : TryParse(previousSize, out var w, out var h)
              && TryAspectRatio(TryAspectRatio(declaredAspect, out _) ? declaredAspect : FriendlyRatio(w, h), out var ratio)
              && SameRatio(ratio, request.Ratio);

    public static string AspectForSize(ImageGenAdapterInfo model, string size)
        => model.SizesByResolution.Values.SelectMany(x => x).FirstOrDefault(x => x.Size == size)?.AspectRatio
           ?? (TryParse(size, out var w, out var h) ? FriendlyRatio(w, h) : "1:1");

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
    public static async Task RememberExplicitAsync(MongoDbContext db, string workspaceId, string ownerUserId, string? styleId, string? watermarkId, string? size, string? sizeAspectRatio = null)
    {
        var F = Builders<ImageMasterWorkspace>.Filter;
        var U = Builders<ImageMasterWorkspace>.Update;
        var owned = F.And(F.Eq(x => x.Id, workspaceId), F.Eq(x => x.OwnerUserId, ownerUserId));
        var now = DateTime.UtcNow;
        var sets = new List<UpdateDefinition<ImageMasterWorkspace>> { U.Set(x => x.IllustrationPrefs!.UpdatedAt, now) };
        if (styleId != null) sets.Add(U.Set(x => x.IllustrationPrefs!.StyleId, styleId));
        if (watermarkId != null) sets.Add(U.Set(x => x.IllustrationPrefs!.WatermarkId, watermarkId));
        if (size != null)
        {
            sets.Add(U.Set(x => x.IllustrationPrefs!.Size, size));
            sets.Add(U.Set(x => x.IllustrationPrefs!.SizeAspectRatio, sizeAspectRatio));
        }
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var patched = await db.ImageMasterWorkspaces.UpdateOneAsync(F.And(owned, F.Ne(x => x.IllustrationPrefs, null)),
                U.Combine(sets), cancellationToken: CancellationToken.None);
            if (patched.MatchedCount > 0) return;
            var created = await db.ImageMasterWorkspaces.UpdateOneAsync(F.And(owned, F.Eq(x => x.IllustrationPrefs, null)),
                U.Set(x => x.IllustrationPrefs, new LiteraryIllustrationPrefs { StyleId = styleId, WatermarkId = watermarkId, Size = size, SizeAspectRatio = sizeAspectRatio, UpdatedAt = now }),
                cancellationToken: CancellationToken.None);
            if (created.MatchedCount > 0) return;
        }
    }
}
