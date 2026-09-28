using System.Text;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>「我的风格」的持久化。只做存取，归属判定一律在 <see cref="PersonalDesignStyleService"/>。</summary>
public interface IPersonalDesignStyleStore
{
    Task<List<PersonalDesignStyle>> ListByOwnerAsync(string ownerUserId, CancellationToken ct);

    Task<long> CountByOwnerAsync(string ownerUserId, CancellationToken ct);

    /// <summary>按编号取，不看归属；调用方必须自己核对 OwnerUserId。</summary>
    Task<PersonalDesignStyle?> FindAsync(string id, CancellationToken ct);

    Task InsertAsync(PersonalDesignStyle style, CancellationToken ct);

    /// <summary>按编号 + 归属人整份替换；没有命中返回 false。</summary>
    Task<bool> ReplaceAsync(PersonalDesignStyle style, CancellationToken ct);

    /// <summary>按编号 + 归属人删除；没有命中返回 false。</summary>
    Task<bool> DeleteAsync(string id, string ownerUserId, CancellationToken ct);
}

public sealed class MongoPersonalDesignStyleStore : IPersonalDesignStyleStore
{
    private readonly MongoDbContext _db;

    public MongoPersonalDesignStyleStore(MongoDbContext db) => _db = db;

    public Task<List<PersonalDesignStyle>> ListByOwnerAsync(string ownerUserId, CancellationToken ct)
        => _db.PersonalDesignStyles.Find(s => s.OwnerUserId == ownerUserId)
            .SortByDescending(s => s.UpdatedAt)
            .Limit(PersonalDesignStyle.MaxPerUser * 2)
            .ToListAsync(ct);

    public Task<long> CountByOwnerAsync(string ownerUserId, CancellationToken ct)
        => _db.PersonalDesignStyles.CountDocumentsAsync(s => s.OwnerUserId == ownerUserId, cancellationToken: ct);

    public async Task<PersonalDesignStyle?> FindAsync(string id, CancellationToken ct)
        => await _db.PersonalDesignStyles.Find(s => s.Id == id).FirstOrDefaultAsync(ct);

    public Task InsertAsync(PersonalDesignStyle style, CancellationToken ct)
        => _db.PersonalDesignStyles.InsertOneAsync(style, cancellationToken: ct);

    public async Task<bool> ReplaceAsync(PersonalDesignStyle style, CancellationToken ct)
        => (await _db.PersonalDesignStyles.ReplaceOneAsync(
            s => s.Id == style.Id && s.OwnerUserId == style.OwnerUserId, style, cancellationToken: ct)).MatchedCount > 0;

    public async Task<bool> DeleteAsync(string id, string ownerUserId, CancellationToken ct)
        => (await _db.PersonalDesignStyles.DeleteOneAsync(s => s.Id == id && s.OwnerUserId == ownerUserId, ct)).DeletedCount > 0;
}

/// <summary>「我的风格」的业务错误。<see cref="Code"/> 直接作为接口的错误码返回。</summary>
public sealed class PersonalDesignStyleException : Exception
{
    public PersonalDesignStyleException(string code, string message) : base(message) => Code = code;

    public string Code { get; }
}

/// <summary>新建或修改时提交的字段。修改时为 null 的字段保持原值。</summary>
public sealed class PersonalDesignStyleInput
{
    public string? Name { get; set; }
    public string? Instruction { get; set; }
    public List<string>? Swatches { get; set; }
    public List<string>? Fonts { get; set; }
    public string? BaseDesignSystemId { get; set; }
    public string? SourceSiteId { get; set; }
    public string? SourceSiteTitle { get; set; }
    public string? SourceNote { get; set; }
    public List<string>? SystemFilledFields { get; set; }
}

public interface IPersonalDesignStyleService
{
    Task<List<PersonalDesignStyle>> ListAsync(string userId, CancellationToken ct);

    /// <summary>只返回归属于 <paramref name="userId"/> 的那一套；别人的与不存在的一样返回 null（不暴露存在性）。</summary>
    Task<PersonalDesignStyle?> GetOwnedAsync(string userId, string id, CancellationToken ct);

    Task<PersonalDesignStyle> CreateAsync(string userId, PersonalDesignStyleInput input, CancellationToken ct);

    Task<PersonalDesignStyle> UpdateAsync(string userId, string id, PersonalDesignStyleInput input, CancellationToken ct);

    Task DeleteAsync(string userId, string id, CancellationToken ct);
}

/// <summary>
/// 「我的风格」的增删改查：归属只认 OwnerUserId，每人最多 <see cref="PersonalDesignStyle.MaxPerUser"/> 套，
/// 骨架必须在当前设计系统快照里。
/// </summary>
public sealed class PersonalDesignStyleService : IPersonalDesignStyleService
{
    public const int MaxNameLength = 40;
    public const int MaxNoteLength = 500;
    public const int MaxFonts = 4;

    public static readonly IReadOnlySet<string> FillableFields = new HashSet<string>(StringComparer.Ordinal)
    {
        "name", "instruction", "swatches", "fonts", "baseDesignSystemId",
    };

    private static readonly Regex HexColor = new("^#[0-9a-f]{6}$", RegexOptions.CultureInvariant);
    private static readonly Regex IdPattern = new("^[0-9a-f]{32}$", RegexOptions.CultureInvariant);

    private readonly IPersonalDesignStyleStore _store;
    private readonly IDesignSystemCatalog _catalog;

    public PersonalDesignStyleService(IPersonalDesignStyleStore store, IDesignSystemCatalog catalog)
    {
        _store = store;
        _catalog = catalog;
    }

    public async Task<List<PersonalDesignStyle>> ListAsync(string userId, CancellationToken ct)
        => (await _store.ListByOwnerAsync(userId, ct)).Where(s => s.OwnerUserId == userId).ToList();

    public async Task<PersonalDesignStyle?> GetOwnedAsync(string userId, string id, CancellationToken ct)
    {
        var normalized = NormalizeId(id);
        if (normalized == null || string.IsNullOrWhiteSpace(userId)) return null;
        var style = await _store.FindAsync(normalized, ct);
        return style != null && string.Equals(style.OwnerUserId, userId, StringComparison.Ordinal) ? style : null;
    }

    public async Task<PersonalDesignStyle> CreateAsync(string userId, PersonalDesignStyleInput input, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(userId)) throw new PersonalDesignStyleException(ErrorCodes.UNAUTHORIZED, "请先登录");
        var count = await _store.CountByOwnerAsync(userId, ct);
        if (count >= PersonalDesignStyle.MaxPerUser)
            throw new PersonalDesignStyleException(ErrorCodes.QUOTA_EXCEEDED,
                $"「我的风格」最多保存 {PersonalDesignStyle.MaxPerUser} 套，先删掉一套不用的再新建");
        var style = new PersonalDesignStyle { OwnerUserId = userId };
        Apply(style, input, isCreate: true);
        await EnsureNameUniqueAsync(userId, style.Name, exceptId: null, ct);
        style.CreatedAt = DateTime.UtcNow;
        style.UpdatedAt = style.CreatedAt;
        await _store.InsertAsync(style, ct);
        return style;
    }

    public async Task<PersonalDesignStyle> UpdateAsync(string userId, string id, PersonalDesignStyleInput input, CancellationToken ct)
    {
        var style = await GetOwnedAsync(userId, id, ct)
            ?? throw new PersonalDesignStyleException(ErrorCodes.NOT_FOUND, "这套风格不存在或已被删除");
        Apply(style, input, isCreate: false);
        await EnsureNameUniqueAsync(userId, style.Name, style.Id, ct);
        style.UpdatedAt = DateTime.UtcNow;
        if (!await _store.ReplaceAsync(style, ct))
            throw new PersonalDesignStyleException(ErrorCodes.NOT_FOUND, "这套风格不存在或已被删除");
        return style;
    }

    public async Task DeleteAsync(string userId, string id, CancellationToken ct)
    {
        var style = await GetOwnedAsync(userId, id, ct)
            ?? throw new PersonalDesignStyleException(ErrorCodes.NOT_FOUND, "这套风格不存在或已被删除");
        if (!await _store.DeleteAsync(style.Id, userId, ct))
            throw new PersonalDesignStyleException(ErrorCodes.NOT_FOUND, "这套风格不存在或已被删除");
    }

    private async Task EnsureNameUniqueAsync(string userId, string name, string? exceptId, CancellationToken ct)
    {
        var mine = await _store.ListByOwnerAsync(userId, ct);
        if (mine.Any(s => s.Id != exceptId && string.Equals(s.Name.Trim(), name, StringComparison.OrdinalIgnoreCase)))
            throw new PersonalDesignStyleException(ErrorCodes.DUPLICATE, $"你已经有一套叫「{name}」的风格，换个名字");
    }

    private void Apply(PersonalDesignStyle style, PersonalDesignStyleInput input, bool isCreate)
    {
        if (isCreate || input.Name != null) style.Name = NormalizeName(input.Name);
        if (isCreate || input.Instruction != null) style.Instruction = NormalizeInstruction(input.Instruction);
        if (isCreate || input.Swatches != null) style.Swatches = NormalizeSwatches(input.Swatches);
        if (isCreate || input.Fonts != null) style.Fonts = NormalizeFonts(input.Fonts);
        if (isCreate || input.BaseDesignSystemId != null)
        {
            var baseId = (input.BaseDesignSystemId ?? string.Empty).Trim().ToLowerInvariant();
            if (_catalog.Find(baseId) == null)
                throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT,
                    baseId.Length == 0 ? "请选一个设计系统骨架" : $"设计系统「{baseId}」不在当前风格目录里，请重新选一个");
            style.BaseDesignSystemId = baseId;
        }
        if (isCreate)
        {
            style.SourceSiteId = TrimOptional(input.SourceSiteId, 64);
            style.SourceSiteTitle = TrimOptional(input.SourceSiteTitle, 200);
            var note = TrimOptional(input.SourceNote, int.MaxValue);
            if (note != null && note.Length > MaxNoteLength)
                throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, $"描述不能超过 {MaxNoteLength} 个字");
            style.SourceNote = note;
        }
        if (input.SystemFilledFields != null)
            style.SystemFilledFields = input.SystemFilledFields.Where(FillableFields.Contains).Distinct(StringComparer.Ordinal).ToList();
        else if (!isCreate)
        {
            // 修改时没带标记：被改过的字段不再算系统填的。
            var changed = new List<string>();
            if (input.Name != null) changed.Add("name");
            if (input.Instruction != null) changed.Add("instruction");
            if (input.Swatches != null) changed.Add("swatches");
            if (input.Fonts != null) changed.Add("fonts");
            if (input.BaseDesignSystemId != null) changed.Add("baseDesignSystemId");
            style.SystemFilledFields = style.SystemFilledFields.Where(f => !changed.Contains(f)).ToList();
        }
    }

    internal static string NormalizeName(string? raw)
    {
        var name = (raw ?? string.Empty).Trim();
        if (name.Length is 0 or > MaxNameLength)
            throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, $"名称需要 1–{MaxNameLength} 个字");
        if (name.Any(c => char.IsControl(c) || c is '<' or '>' or '"'))
            throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, "名称里不能有尖括号、双引号或换行");
        return name;
    }

    internal static string NormalizeInstruction(string? raw)
    {
        var value = (raw ?? string.Empty).Replace("\r\n", "\n").Trim();
        if (value.Length == 0)
            throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, "风格说明不能为空：至少写一句想要的配色、字体或版式");
        if (value.Length > PersonalStyleDeriver.MaxInstructionLength)
            throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, $"风格说明不能超过 {PersonalStyleDeriver.MaxInstructionLength} 个字");
        return value;
    }

    internal static List<string> NormalizeSwatches(List<string>? raw)
    {
        var values = (raw ?? new List<string>()).Select(v => (v ?? string.Empty).Trim().ToLowerInvariant()).ToList();
        if (values.Count == 0) return values;
        if (values.Count != 3 || values.Any(v => !HexColor.IsMatch(v)))
            throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, "色块要么不填，要么是三枚 #rrggbb（正文、底色、强调色）");
        return values;
    }

    internal static List<string> NormalizeFonts(List<string>? raw)
    {
        var values = (raw ?? new List<string>()).Select(v => (v ?? string.Empty).Trim()).Where(v => v.Length > 0).Distinct().ToList();
        if (values.Count > MaxFonts || values.Any(v => v.Length > 60 || v.Any(char.IsControl)))
            throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, $"字体最多 {MaxFonts} 个，每个不超过 60 个字");
        return values;
    }

    /// <summary>接受裸编号或带 personal: 前缀的 StyleId；格式不对返回 null。</summary>
    public static string? NormalizeId(string? raw)
    {
        var value = (raw ?? string.Empty).Trim();
        if (value.StartsWith(PersonalDesignStyle.StyleIdPrefix, StringComparison.Ordinal))
            value = value[PersonalDesignStyle.StyleIdPrefix.Length..];
        value = value.ToLowerInvariant();
        return IdPattern.IsMatch(value) ? value : null;
    }

    public static bool IsPersonalStyleId(string? styleId)
        => !string.IsNullOrWhiteSpace(styleId)
           && styleId.Trim().StartsWith(PersonalDesignStyle.StyleIdPrefix, StringComparison.Ordinal);

    private static string? TrimOptional(string? value, int max)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        return trimmed.Length > max ? trimmed[..max] : trimmed;
    }
}

/// <summary>一次提取的草稿：交给界面审阅、可改，改完才保存。</summary>
public sealed record PersonalStyleDraft(
    string Name,
    string Instruction,
    List<string> Swatches,
    List<string> Fonts,
    string BaseDesignSystemId,
    string BaseDesignSystemName,
    string BaseReason,
    List<PersonalStyleTrait> Traits,
    string Evidence,
    string? SourceSiteId,
    string? SourceSiteTitle,
    string? SourceNote,
    List<string> SystemFilledFields);

public interface IPersonalStyleDerivationService
{
    Task<PersonalStyleDraft> DeriveAsync(string userId, string? siteId, string? note, CancellationToken ct);
}

/// <summary>
/// 从「我自己的一张网页」和/或一段描述里提取风格草稿。只读入口 HTML 与它引用的站内 CSS（各有上限），
/// 全程确定性解析，不调模型；站点必须归属于当前用户（团队里别人的网页不能拿来提取）。
/// </summary>
public sealed class PersonalStyleDerivationService : IPersonalStyleDerivationService
{
    public const int MaxLinkedStylesheets = 4;
    public const long MaxStylesheetBytes = 512 * 1024;

    private readonly IHostedSiteService _sites;
    private readonly IAssetStorage _storage;
    private readonly IDesignSystemCatalog _catalog;
    private readonly IDesignGenerationSettingsService _settings;

    public PersonalStyleDerivationService(
        IHostedSiteService sites,
        IAssetStorage storage,
        IDesignSystemCatalog catalog,
        IDesignGenerationSettingsService settings)
    {
        _sites = sites;
        _storage = storage;
        _catalog = catalog;
        _settings = settings;
    }

    public async Task<PersonalStyleDraft> DeriveAsync(string userId, string? siteId, string? note, CancellationToken ct)
    {
        var trimmedSiteId = siteId?.Trim();
        var trimmedNote = note?.Trim();
        if (string.IsNullOrEmpty(trimmedSiteId) && string.IsNullOrEmpty(trimmedNote))
            throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, "选一张你自己的网页，或写几句想要的风格，至少给一样");
        if (trimmedNote is { Length: > PersonalDesignStyleService.MaxNoteLength })
            throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, $"描述不能超过 {PersonalDesignStyleService.MaxNoteLength} 个字");

        string? html = null;
        var linkedCss = new List<string>();
        HostedSite? site = null;
        if (!string.IsNullOrEmpty(trimmedSiteId))
        {
            HostedSiteEditableEntry entry;
            try { entry = await _sites.GetEditableEntryHtmlAsync(trimmedSiteId, userId, ct); }
            catch (KeyNotFoundException) { throw new PersonalDesignStyleException(ErrorCodes.NOT_FOUND, "这张网页不存在，或你没有权限读取它"); }
            catch (InvalidOperationException ex) { throw new PersonalDesignStyleException(ErrorCodes.INVALID_FORMAT, $"这张网页读不出样式：{ex.Message}"); }
            // 编辑权限覆盖团队编辑者；这里只认网页的主人，别人的网页不能拿来当「我的风格」。
            if (!string.Equals(entry.Site.OwnerUserId, userId, StringComparison.Ordinal))
                throw new PersonalDesignStyleException(ErrorCodes.PERMISSION_DENIED, "只能从你自己创建的网页提取风格");
            site = entry.Site;
            html = entry.Html;
            var files = site.Files ?? new List<HostedSiteFile>();
            foreach (var path in PersonalStyleDeriver.LocalStylesheetPaths(html, site.EntryFile).Take(MaxLinkedStylesheets))
            {
                var file = files.FirstOrDefault(f => string.Equals(f.Path, path, StringComparison.OrdinalIgnoreCase));
                if (file == null || string.IsNullOrWhiteSpace(file.CosKey) || file.Size > MaxStylesheetBytes) continue;
                var bytes = await _storage.TryDownloadBytesAsync(file.CosKey, ct);
                if (bytes is { Length: > 0 }) linkedCss.Add(Encoding.UTF8.GetString(bytes));
            }
        }

        var derivation = PersonalStyleDeriver.Derive(html, linkedCss, trimmedNote);
        if (!derivation.FoundAnything)
            throw new PersonalDesignStyleException(ErrorCodes.CONTENT_EMPTY,
                "这张网页里没读到可用的样式（可能是纯文字或整页图片），换一张，或直接写几句你想要的风格");

        var settings = await _settings.GetAsync(ct);
        var defaultPreset = settings.Styles.FirstOrDefault(s => s.Enabled && s.IsDefault) ?? settings.Styles.FirstOrDefault(s => s.Enabled);
        var defaultDesignSystemId = defaultPreset != null && _catalog.Find(defaultPreset.DesignSystemId) != null
            ? defaultPreset.DesignSystemId
            : _catalog.All.First().Id;
        var choice = PersonalStyleDeriver.ChooseBaseDesignSystem(
            _catalog, derivation.Swatches, trimmedNote, settings.Styles, defaultDesignSystemId);
        var baseEntry = _catalog.Find(choice.DesignSystemId)!;

        var baseName = site != null && !string.IsNullOrWhiteSpace(site.Title) ? site.Title.Trim() : "我的风格";
        var name = baseName.Length > PersonalDesignStyleService.MaxNameLength - 2
            ? baseName[..(PersonalDesignStyleService.MaxNameLength - 2)] + "风格"
            : baseName == "我的风格" ? baseName : baseName + "风格";
        name = new string(name.Where(c => !char.IsControl(c) && c is not ('<' or '>' or '"')).ToArray());

        var filled = new List<string> { "name", "instruction", "baseDesignSystemId" };
        if (derivation.Swatches.Count > 0) filled.Add("swatches");
        if (derivation.Fonts.Count > 0) filled.Add("fonts");

        return new PersonalStyleDraft(
            name,
            derivation.Instruction,
            derivation.Swatches,
            derivation.Fonts,
            baseEntry.Id,
            baseEntry.Name,
            choice.Reason,
            derivation.Traits,
            derivation.Evidence,
            site?.Id,
            site?.Title,
            string.IsNullOrEmpty(trimmedNote) ? null : trimmedNote,
            filled);
    }
}
