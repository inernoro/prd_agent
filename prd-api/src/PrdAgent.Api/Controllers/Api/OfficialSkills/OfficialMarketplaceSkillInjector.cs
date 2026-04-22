using System.Text.RegularExpressions;

namespace PrdAgent.Api.Controllers.Api.OfficialSkills;

/// <summary>
/// 把官方 findmapskills 技能包虚拟注入到海鲜市场列表。
///
/// 为什么虚拟注入、不入库：
/// - 内容随 `OfficialSkillTemplates.FindMapSkillsSkillMd` 走，部署即更新，
///   不用维护 DB 迁移、seeder、上传 COS 的一堆幺蛾子
/// - 官方 ID 固定 `official-findmapskills`；用户上传的 ID 是 32 位 hex，不会撞
/// - Fork 直接重定向到 `/api/official-skills/findmapskills/download`，
///   fork 计数不入数据库（不污染 marketplace_skills 集合）
///
/// 调用方（`MarketplaceSkillsController` + `MarketplaceSkillsOpenApiController`）
/// 在 List 响应前 Prepend()，在 Fork / GetById 入口处用 IsOfficialId() 特判。
/// </summary>
public static class OfficialMarketplaceSkillInjector
{
    /// <summary>官方 findmapskills 在海鲜市场里的虚拟 ID（固定值）</summary>
    public const string OfficialFindMapSkillsId = "official-findmapskills";

    /// <summary>匹配任意官方条目 ID 前缀，未来再有第二个官方技能时复用</summary>
    public const string OfficialIdPrefix = "official-";

    public static bool IsOfficialId(string? id) =>
        !string.IsNullOrEmpty(id) && id.StartsWith(OfficialIdPrefix, StringComparison.Ordinal);

    /// <summary>
    /// 构造一条虚拟 findmapskills DTO（与 ToDto 形状对齐），prepend 到列表首位。
    /// </summary>
    public static object BuildFindMapSkillsDto(string baseUrl, string currentUserId)
    {
        var zipUrl = $"{baseUrl.TrimEnd('/')}/api/official-skills/{OfficialSkillTemplates.FindMapSkillsKey}/download";
        return new
        {
            Id = OfficialFindMapSkillsId,
            Title = "findmapskills · 海鲜市场操作技能",
            Description = $"官方内置 · v{OfficialSkillTemplates.FindMapSkillsVersion} · AI 装上这一个就能搜索/下载/上传/订阅海鲜市场",
            iconEmoji = "🛡️",
            coverImageUrl = (string?)null,
            previewUrl = (string?)null,
            previewSource = (string?)null,
            previewHostedSiteId = (string?)null,
            tags = new List<string> { "官方", "开放接口", "findmapskills" },
            zipUrl,
            zipSizeBytes = 0L,
            originalFileName = "findmapskills.zip",
            hasSkillMd = true,
            downloadCount = 0,
            favoriteCount = 0,
            isFavoritedByCurrentUser = false,
            forkCount = 0,
            ownerUserId = "official",
            ownerUserName = "PrdAgent 官方",
            ownerUserAvatar = (string?)null,
            createdAt = DateTime.Parse(OfficialSkillTemplates.FindMapSkillsReleaseDate + "T00:00:00Z"),
            updatedAt = DateTime.Parse(OfficialSkillTemplates.FindMapSkillsReleaseDate + "T00:00:00Z"),
        };
    }

    /// <summary>
    /// 判断当前列表筛选条件下要不要把官方条目注入。
    /// 规则：
    ///   - 无 keyword / tag / 只要是列表首屏 → 注入（让用户第一眼看到官方技能）
    ///   - 有 keyword：匹配 title/description 关键字才注入
    ///   - 有 tag：tag 必须在 ["官方","开放接口","findmapskills"] 里才注入
    /// </summary>
    public static bool ShouldInject(string? keyword, string? tag)
    {
        if (!string.IsNullOrWhiteSpace(tag))
        {
            var t = tag.Trim();
            return t.Equals("官方", StringComparison.OrdinalIgnoreCase)
                || t.Equals("开放接口", StringComparison.OrdinalIgnoreCase)
                || t.Equals("findmapskills", StringComparison.OrdinalIgnoreCase);
        }

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var k = Regex.Escape(keyword.Trim());
            // "findmapskills" / "海鲜" / "官方" / "market" 命中即注入
            var pattern = new Regex(k, RegexOptions.IgnoreCase);
            return pattern.IsMatch("findmapskills 海鲜市场操作技能 官方内置 marketplace AI 开放接口");
        }

        return true; // 无筛选条件 → 永远注入到首位
    }

    /// <summary>
    /// Fork 特判：返回官方技能的下载响应（不 +1 count、不查 DB）。
    /// </summary>
    public static object BuildForkResponse(string baseUrl, string currentUserId)
    {
        var dto = BuildFindMapSkillsDto(baseUrl, currentUserId);
        var zipUrl = $"{baseUrl.TrimEnd('/')}/api/official-skills/{OfficialSkillTemplates.FindMapSkillsKey}/download";
        return new
        {
            downloadUrl = zipUrl,
            fileName = "findmapskills.zip",
            item = dto,
        };
    }

    /// <summary>
    /// 从请求头解析 base URL（X-Client-Base-Url &gt; Origin &gt; Scheme+Host）。
    /// 给 Controller 用，省得每个 Controller 重写一遍。
    /// </summary>
    public static string ResolveBaseUrl(Microsoft.AspNetCore.Http.HttpRequest request)
    {
        string? baseUrl = request.Headers["X-Client-Base-Url"].ToString();
        if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = request.Headers["Origin"].ToString();
        if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = $"{request.Scheme}://{request.Host}";
        return baseUrl.TrimEnd('/');
    }
}
