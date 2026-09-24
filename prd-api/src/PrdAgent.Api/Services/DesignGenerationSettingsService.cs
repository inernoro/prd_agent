using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 网页生成设置的内置默认值：默认执行器、8 套风格、三段可编辑提示词、只读平台契约。
/// 设置文档里为 null 的字段一律回落到这里，所以「恢复默认」就是把字段写回 null。
/// </summary>
public static class DesignGenerationDefaults
{
    public const string DefaultRuntime = DesignArtifactRuntimes.OpenDesign;
    public const string DefaultReviewMode = DesignReviewModes.Light;
    public const int MaxPromptLength = 8000;
    public const int MaxStyles = 24;

    /// <summary>
    /// 8 套内置风格。只写名称、说明与对应的 OpenDesign 设计系统；色块不在这里手写，
    /// 由 <see cref="DesignGenerationSettingsService.Effective"/> 从设计系统快照的真实 tokens 派生
    /// （ink = --fg、paper = --bg、accent = --accent）。2026-09-24 之前这里手写的三色与 OpenDesign
    /// 真实 tokens 对不上（editorial 写的是 #b3261e，真实 accent 是 #9a5a2f），卡片展示的颜色是编的。
    /// </summary>
    public static readonly IReadOnlyList<DesignStylePreset> Styles = new[]
    {
        Style("editorial", "编辑刊物", "报刊式排版，衬线标题配大段留白，适合技术方案与深度分析", "editorial", isDefault: true),
        Style("warm-editorial", "暖调编辑", "暖米底色与柔和强调色，读起来像一本产品手册", "warm-editorial"),
        Style("minimal", "极简", "黑白灰为主，只用一种强调色，信息密度高、干净克制", "minimal"),
        Style("kami", "纸感", "纸张质感与细线分隔，适合中文长文与宣讲稿", "kami"),
        Style("corporate", "企业汇报", "稳重蓝灰配色，指标卡与表格清晰，适合对内汇报", "corporate"),
        Style("bento", "便当格", "大小不一的模块网格，适合多个要点并列展示", "bento"),
        Style("glassmorphism", "玻璃质感", "半透明分层与柔光背景，适合产品介绍与发布页", "glassmorphism"),
        Style("storytelling", "叙事长卷", "按章节推进的长滚动叙事，适合复盘与故事化讲解", "storytelling"),
    };

    public const string GeneratePrompt = """
你是资深网页设计师，要把 MAP 知识内容做成一张好看、可信的单页网页。

一、读什么（只读这些，别的不要浏览）
- /workspace/brief/task.json；
- task.json 列出的每一个知识文件；
- 如果本次指定了设计系统，严格使用它的配色、字体、间距与组件语言。
不要反复列目录，不要逐个打开与任务无关的示例文件。

二、怎么写（一次写成）
想清楚信息结构后，直接把完整页面写入 /workspace/index.html。不要先写草稿再整页重写，也不要把页面只贴在回复里。

三、视觉要求
- 首屏一句话讲清这份内容最重要的结论，并配一组来自原文的关键数字；
- 层级分明：标题与正文字号至少三档，正文每行 60–75 个字符，区块间距统一；
- 至少用一种能表达内容结构的版式：时间线、对比表、分步流程、指标卡或架构分层，不要整页都是同一种卡片；
- 避免 AI 味：不要紫蓝渐变大底、不要用表情符号当图标、不要每块都居中、不要千篇一律的圆角阴影卡片；
- 手机 390px 宽度下可读，不出现横向滚动。

四、内容
事实、数字、日期、名称都来自知识文件，逐字引用，不编造、不外推。
""";

    public const string EditPrompt = """
你在修改一张已经发布的网页。

- 只改用户点名的部分；没点名的文字、数字、结构与样式逐字保留；
- 用小范围的定点编辑，不要整页重写；
- 如果附带了截图（/workspace/reference/ 下的图片），先看截图找到用户指出的位置，再到 index.html 里定位对应元素修改；截图只是视觉参考，不是事实来源；
- 如果附带了知识文件，修改涉及的事实以知识文件为准；
- 改完重读 index.html，确认用户要求的每一处都已生效。
""";

    public const string ReviewPrompt = """
在平台规则之外，再按这份审美清单检查一遍，发现问题当场改：
- 首屏能不能一眼看出页面主题和最重要的结论；
- 标题层级是否清楚，有没有没有层次的大段文字；
- 配色是否统一（主色、强调色、中性色各一组以内），文字与背景对比是否足够；
- 相邻区块是否在重复同一种卡片样式；
- 手机 390px 宽度下有没有元素溢出或文字过小。
只做必要修改，不要重写页面。
""";

    /// <summary>
    /// 平台契约的中文说明。执行版本在 CDS（agent-workspace-session-runtime.ts 的 systemPrompt 与发布闸门），
    /// 这里给管理员与智能体搭建者看，不可编辑；改契约要改 CDS 并同步这段。
    /// </summary>
    public const string PlatformContract = """
以下规则由平台强制执行，页面违反任一条会在发布前被拒收，因此不开放编辑：

1. 先读 /workspace/brief/task.json，其中的操作类型、用户要求和标题是权威输入。
2. 事实、数字、日期、价格、联系方式与链接只能来自任务书列出的 MAP 来源；每个数字必须挂在它原本描述的对象上。
3. 严格遵守任务书里的「可见文字出现次数」约束。
4. 页面里不得残留占位文字、空链接、指向不存在锚点的链接、点了没反应的按钮。
5. 所有链接只能指向本页内的锚点（href="#某个区块 id"，且该 id 存在）；不指向外部或相对地址。
6. 每个可点击按钮要么用 popovertarget 打开真实的弹层，要么改写成指向本页区块的链接；不做事的文字就写成普通文本。
7. 成品写入 /workspace/index.html，公共资源放 assets/；新建页面必须真的写出文件，只贴在回复里视为没有产出。
8. 修改已有页面时，以当前页面为起点做定点修改，不得替换产品身份，不得删除用户要求保留的脚本、资源和交互来绕过校验。
9. 不索取凭据、不上传源文件、不发布、不部署、不改动任何外部数据。
""";

    private static DesignStylePreset Style(
        string id, string name, string description, string designSystemId, bool isDefault = false) => new()
    {
        Id = id,
        Name = name,
        Description = description,
        DesignSystemId = designSystemId,
        Swatches = new List<string>(),
        Enabled = true,
        IsDefault = isDefault,
        BuiltIn = true,
    };
}

/// <summary>设置的生效视图（已把 null 回落到内置默认）。</summary>
public sealed record DesignGenerationEffectiveSettings(
    string DefaultRuntime,
    string ReviewMode,
    IReadOnlyList<DesignStylePreset> Styles,
    string GeneratePrompt,
    bool GeneratePromptIsDefault,
    string EditPrompt,
    bool EditPromptIsDefault,
    string ReviewPrompt,
    bool ReviewPromptIsDefault,
    DateTime? UpdatedAt,
    string? UpdatedByName);

public sealed class DesignGenerationSettingsUpdate
{
    public string? DefaultRuntime { get; set; }
    public string? ReviewMode { get; set; }
    public List<DesignStylePreset>? Styles { get; set; }
    public DesignGenerationPromptsUpdate? Prompts { get; set; }
}

public sealed class DesignGenerationPromptsUpdate
{
    /// <summary>null = 不改；空字符串 = 恢复默认。</summary>
    public string? Generate { get; set; }
    public string? Edit { get; set; }
    public string? Review { get; set; }
}

public sealed class DesignGenerationSettingsException : Exception
{
    public DesignGenerationSettingsException(string message) : base(message) { }
}

public interface IDesignGenerationSettingsService
{
    Task<DesignGenerationEffectiveSettings> GetAsync(CancellationToken ct);

    Task<DesignGenerationEffectiveSettings> SaveAsync(
        DesignGenerationSettingsUpdate update, string userId, CancellationToken ct);

    /// <summary>按当前设置冻结一次运行的设计方向；styleId 为空取默认风格，未知或已停用的风格抛出。</summary>
    Task<DesignArtifactDesignDirection> FreezeAsync(string? styleId, CancellationToken ct);

    /// <summary>
    /// 用户在风格画廊「更多风格」里直接选了 OpenDesign 目录中的一套设计系统（不经管理员预设）：
    /// 设计系统按快照核对，提示词与自查强度仍取当前设置。不在快照里的编号抛出。
    /// </summary>
    Task<DesignArtifactDesignDirection> FreezeCatalogStyleAsync(string designSystemId, CancellationToken ct);
}

public sealed class DesignGenerationSettingsService : IDesignGenerationSettingsService
{
    private static readonly Regex StyleIdPattern = new("^[a-z0-9][a-z0-9-]{0,47}$", RegexOptions.CultureInvariant);
    private static readonly Regex DesignSystemIdPattern = new("^[a-z0-9][a-z0-9-]{0,63}$", RegexOptions.CultureInvariant);
    private readonly MongoDbContext _db;
    private readonly IDesignSystemCatalog _catalog;

    public DesignGenerationSettingsService(MongoDbContext db, IDesignSystemCatalog catalog)
    {
        _db = db;
        _catalog = catalog;
    }

    public async Task<DesignGenerationEffectiveSettings> GetAsync(CancellationToken ct)
        => Effective(await LoadAsync(ct), _catalog);

    public async Task<DesignGenerationEffectiveSettings> SaveAsync(
        DesignGenerationSettingsUpdate update, string userId, CancellationToken ct)
    {
        var current = await LoadAsync(ct) ?? new DesignGenerationSettings();
        var next = Apply(current, update, _catalog);
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        next.UpdatedAt = DateTime.UtcNow;
        next.UpdatedByUserId = userId;
        next.UpdatedByName = string.IsNullOrWhiteSpace(user?.DisplayName) ? user?.Username : user!.DisplayName;
        await _db.DesignGenerationSettings.ReplaceOneAsync(
            s => s.Id == DesignGenerationSettings.SingletonId,
            next,
            new ReplaceOptions { IsUpsert = true },
            CancellationToken.None);
        return Effective(next, _catalog);
    }

    public async Task<DesignArtifactDesignDirection> FreezeAsync(string? styleId, CancellationToken ct)
        => Freeze(Effective(await LoadAsync(ct), _catalog), styleId);

    public async Task<DesignArtifactDesignDirection> FreezeCatalogStyleAsync(string designSystemId, CancellationToken ct)
        => FreezeCatalogStyle(Effective(await LoadAsync(ct), _catalog), _catalog, designSystemId);

    private async Task<DesignGenerationSettings?> LoadAsync(CancellationToken ct)
        => await _db.DesignGenerationSettings
            .Find(s => s.Id == DesignGenerationSettings.SingletonId)
            .FirstOrDefaultAsync(ct);

    /// <summary>
    /// 生效视图。风格色块在这里统一从设计系统快照派生（ink = --fg、paper = --bg、accent = --accent），
    /// 库里存过的旧三色（2026-09-24 之前可编辑）一律不采用；设计系统不在快照里的风格色块为空——
    /// 拿不到真实颜色就不给，不编一组。每次都返回新的风格对象，不共享内置默认的实例。
    /// </summary>
    internal static DesignGenerationEffectiveSettings Effective(DesignGenerationSettings? stored, IDesignSystemCatalog catalog)
    {
        var source = stored?.Styles is { Count: > 0 } saved ? saved : DesignGenerationDefaults.Styles.ToList();
        var styles = source.Select(style => new DesignStylePreset
        {
            Id = style.Id,
            Name = style.Name,
            Description = style.Description,
            DesignSystemId = style.DesignSystemId,
            Swatches = DerivedSwatches(catalog.Find(style.DesignSystemId)),
            Enabled = style.Enabled,
            IsDefault = style.IsDefault,
            BuiltIn = style.BuiltIn,
        }).ToList();
        return new DesignGenerationEffectiveSettings(
            stored?.DefaultRuntime ?? DesignGenerationDefaults.DefaultRuntime,
            stored?.ReviewMode ?? DesignGenerationDefaults.DefaultReviewMode,
            styles,
            stored?.GeneratePrompt ?? DesignGenerationDefaults.GeneratePrompt,
            stored?.GeneratePrompt == null,
            stored?.EditPrompt ?? DesignGenerationDefaults.EditPrompt,
            stored?.EditPrompt == null,
            stored?.ReviewPrompt ?? DesignGenerationDefaults.ReviewPrompt,
            stored?.ReviewPrompt == null,
            stored?.UpdatedAt,
            stored?.UpdatedByName);
    }

    /// <summary>风格卡片的三枚色块：[ink, paper, accent] = [--fg, --bg, --accent]。唯一派生口径。</summary>
    internal static List<string> DerivedSwatches(DesignSystemEntry? system)
        => system == null
            ? new List<string>()
            : new List<string> { system.Swatches.Fg, system.Swatches.Bg, system.Swatches.Accent };

    internal static DesignGenerationSettings Apply(
        DesignGenerationSettings current, DesignGenerationSettingsUpdate update, IDesignSystemCatalog catalog)
    {
        var next = new DesignGenerationSettings
        {
            Id = DesignGenerationSettings.SingletonId,
            DefaultRuntime = current.DefaultRuntime,
            ReviewMode = current.ReviewMode,
            Styles = current.Styles,
            GeneratePrompt = current.GeneratePrompt,
            EditPrompt = current.EditPrompt,
            ReviewPrompt = current.ReviewPrompt,
        };
        if (update.DefaultRuntime != null)
        {
            var runtime = update.DefaultRuntime.Trim().ToLowerInvariant();
            if (runtime is not (DesignArtifactRuntimes.OpenDesign or DesignArtifactRuntimes.MapGateway))
                throw new DesignGenerationSettingsException("默认执行器只能是 open-design 或 map-gateway");
            next.DefaultRuntime = runtime == DesignGenerationDefaults.DefaultRuntime ? null : runtime;
        }
        if (update.ReviewMode != null)
        {
            var mode = update.ReviewMode.Trim().ToLowerInvariant();
            if (!DesignReviewModes.IsValid(mode))
                throw new DesignGenerationSettingsException("自查强度只能是 off、light 或 strict");
            next.ReviewMode = mode == DesignGenerationDefaults.DefaultReviewMode ? null : mode;
        }
        if (update.Styles != null) next.Styles = NormalizeStyles(update.Styles, current.Styles, catalog);
        if (update.Prompts != null)
        {
            next.GeneratePrompt = NormalizePrompt(update.Prompts.Generate, current.GeneratePrompt, DesignGenerationDefaults.GeneratePrompt, "创作");
            next.EditPrompt = NormalizePrompt(update.Prompts.Edit, current.EditPrompt, DesignGenerationDefaults.EditPrompt, "修改");
            next.ReviewPrompt = NormalizePrompt(update.Prompts.Review, current.ReviewPrompt, DesignGenerationDefaults.ReviewPrompt, "自查");
        }
        return next;
    }

    private static string? NormalizePrompt(string? submitted, string? current, string builtIn, string label)
    {
        if (submitted == null) return current;
        var value = submitted.Replace("\r\n", "\n").Trim();
        if (value.Length == 0) return null;
        if (value.Length > DesignGenerationDefaults.MaxPromptLength)
            throw new DesignGenerationSettingsException($"{label}提示词不能超过 {DesignGenerationDefaults.MaxPromptLength} 个字符");
        // 与内置默认逐字相同就不落库，保持「是否为默认」的判断诚实。
        return value == builtIn.Trim() ? null : value;
    }

    private static List<DesignStylePreset> NormalizeStyles(
        List<DesignStylePreset> submitted, List<DesignStylePreset>? previous, IDesignSystemCatalog catalog)
    {
        if (submitted.Count == 0) throw new DesignGenerationSettingsException("至少保留一套风格");
        if (submitted.Count > DesignGenerationDefaults.MaxStyles)
            throw new DesignGenerationSettingsException($"风格最多 {DesignGenerationDefaults.MaxStyles} 套");
        var builtInIds = DesignGenerationDefaults.Styles.Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<DesignStylePreset>();
        foreach (var raw in submitted)
        {
            var id = (raw.Id ?? string.Empty).Trim().ToLowerInvariant();
            if (!StyleIdPattern.IsMatch(id)) throw new DesignGenerationSettingsException($"风格编号「{raw.Id}」只能用小写字母、数字和连字符");
            if (!seen.Add(id)) throw new DesignGenerationSettingsException($"风格编号「{id}」重复");
            var name = (raw.Name ?? string.Empty).Trim();
            if (name.Length is 0 or > 40) throw new DesignGenerationSettingsException($"风格「{id}」的名称需要 1–40 个字符");
            var designSystemId = (raw.DesignSystemId ?? string.Empty).Trim().ToLowerInvariant();
            if (!DesignSystemIdPattern.IsMatch(designSystemId))
                throw new DesignGenerationSettingsException($"风格「{name}」的设计系统编号只能用小写字母、数字和连字符");
            // 新填或改过的编号必须在设计系统快照里：否则这套风格没有样张、没有色块，生成时也找不到它，
            // 却会一直挂在风格列表里被人选中。沿用库里原样的旧编号不拦，免得快照更新后连提示词都存不了。
            var unchanged = previous?.Any(p => p.Id == id && p.DesignSystemId == designSystemId) == true
                || (previous == null && DesignGenerationDefaults.Styles.Any(p => p.Id == id && p.DesignSystemId == designSystemId));
            if (!unchanged && catalog.Find(designSystemId) == null)
                throw new DesignGenerationSettingsException($"风格「{name}」引用的设计系统「{designSystemId}」不在当前快照里，请从风格画廊里选一套");
            // 色块不再是可编辑项：提交里带的 swatches 一律不采用、不落库，读取时从设计系统快照派生。
            result.Add(new DesignStylePreset
            {
                Id = id,
                Name = name,
                Description = (raw.Description ?? string.Empty).Trim() is { Length: <= 200 } description
                    ? description
                    : throw new DesignGenerationSettingsException($"风格「{name}」的说明不能超过 200 个字符"),
                DesignSystemId = designSystemId,
                Swatches = new List<string>(),
                Enabled = raw.Enabled,
                IsDefault = raw.IsDefault,
                BuiltIn = builtInIds.Contains(id),
            });
        }
        var enabled = result.Where(s => s.Enabled).ToList();
        if (enabled.Count == 0) throw new DesignGenerationSettingsException("至少启用一套风格");
        var defaults = enabled.Where(s => s.IsDefault).ToList();
        if (defaults.Count > 1) throw new DesignGenerationSettingsException("默认风格只能有一套");
        if (result.Any(s => s.IsDefault && !s.Enabled)) throw new DesignGenerationSettingsException("默认风格必须是启用状态");
        if (defaults.Count == 0) enabled[0].IsDefault = true;
        return result;
    }

    internal static DesignArtifactDesignDirection Freeze(DesignGenerationEffectiveSettings settings, string? styleId)
    {
        var requested = string.IsNullOrWhiteSpace(styleId) ? null : styleId.Trim().ToLowerInvariant();
        var style = requested == null
            ? settings.Styles.FirstOrDefault(s => s.Enabled && s.IsDefault)
              ?? settings.Styles.FirstOrDefault(s => s.Enabled)
            : settings.Styles.FirstOrDefault(s => s.Id == requested);
        if (style == null)
            throw new DesignGenerationSettingsException(requested == null ? "当前没有可用的风格，请管理员先在网页生成设置里启用一套" : $"风格「{requested}」不存在");
        if (!style.Enabled)
            throw new DesignGenerationSettingsException($"风格「{style.Name}」已停用，请换一套风格");
        var direction = new DesignArtifactDesignDirection
        {
            StyleId = style.Id,
            StyleName = style.Name,
            StyleDescription = style.Description,
            DesignSystemId = style.DesignSystemId,
            ReviewMode = settings.ReviewMode,
            GeneratePrompt = settings.GeneratePrompt,
            EditPrompt = settings.EditPrompt,
            ReviewPrompt = settings.ReviewPrompt,
        };
        direction.PromptFingerprint = Fingerprint(direction);
        return direction;
    }

    /// <summary>目录风格的 StyleId 前缀：与预设编号分开，预设 editorial 与设计系统 editorial 是两回事。</summary>
    public const string CatalogStylePrefix = "design-system:";

    internal static DesignArtifactDesignDirection FreezeCatalogStyle(
        DesignGenerationEffectiveSettings settings, IDesignSystemCatalog catalog, string? designSystemId)
    {
        var entry = catalog.Find(designSystemId);
        if (entry == null)
            throw new DesignGenerationSettingsException(
                $"没有编号为「{designSystemId?.Trim()}」的设计系统，请从风格画廊里重新选一套");
        var direction = new DesignArtifactDesignDirection
        {
            StyleId = CatalogStylePrefix + entry.Id,
            StyleName = entry.Name,
            StyleDescription = string.IsNullOrWhiteSpace(entry.Summary) ? entry.Description : entry.Summary,
            DesignSystemId = entry.Id,
            ReviewMode = settings.ReviewMode,
            GeneratePrompt = settings.GeneratePrompt,
            EditPrompt = settings.EditPrompt,
            ReviewPrompt = settings.ReviewPrompt,
        };
        direction.PromptFingerprint = Fingerprint(direction);
        return direction;
    }

    /// <summary>风格、自查强度与三段提示词共同决定这次「怎么设计」，任一变化指纹就变。</summary>
    internal static string Fingerprint(DesignArtifactDesignDirection direction)
    {
        var material = string.Join('\u001f',
            "map-design-direction-v1",
            direction.StyleId,
            direction.DesignSystemId,
            direction.ReviewMode,
            direction.GeneratePrompt,
            direction.EditPrompt,
            direction.ReviewPrompt);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material))).ToLowerInvariant()[..12];
    }
}
