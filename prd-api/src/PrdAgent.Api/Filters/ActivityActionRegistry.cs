using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Filters;

/// <summary>
/// 团队动态白名单条目。
/// 标题来源两条路：TitleArgs 从 action 参数声明式提取（创建类动作，请求体里带标题）；
/// TitleDb 按 TargetId 预读数据库（更新/删除/状态流转类动作）——预读发生在 next() 之前，
/// 保证删除类动作仍能拿到删除前的标题快照。
/// </summary>
/// <param name="Module">模块 key（如 document-store）</param>
/// <param name="ModuleLabel">模块中文名（如「知识库」）</param>
/// <param name="ActionLabel">动作中文标签（如「发布了文档」）</param>
/// <param name="TargetRouteKey">路由里取 TargetId 的参数名（如 entryId），null 表示无目标对象</param>
/// <param name="TitleArgs">按序尝试的参数路径："request.Title"（DTO 属性）/ "title"（裸 string 参数）/ "file"（IFormFile 取 FileName）</param>
/// <param name="TitleDb">按 TargetId 预读标题的查询委托</param>
public sealed record ActivityActionDef(
    string Module,
    string ModuleLabel,
    string ActionLabel,
    string? TargetRouteKey = null,
    string[]? TitleArgs = null,
    Func<MongoDbContext, string, Task<string?>>? TitleDb = null);

/// <summary>
/// 团队动态白名单注册表（SSOT）。key 为 "ControllerName.ActionName" 复合键
/// （CreateWorkspace / CreateTemplate 等 Action 名跨 Controller 重名，单 Action 名不可用）。
/// 不在表内的动作（含所有读接口）不产生动态。
/// 登记原则：只登记"人做了一件值得团队知道的事"，点赞/收藏/置顶/分享链管理/视图打点等噪音动作禁止入表。
/// </summary>
public static class ActivityActionRegistry
{
    // ── TitleDb 查询委托 ──

    private static readonly Func<MongoDbContext, string, Task<string?>> DocEntryTitle =
        async (db, id) => (await db.DocumentEntries.Find(x => x.Id == id).FirstOrDefaultAsync())?.Title;

    private static readonly Func<MongoDbContext, string, Task<string?>> DocStoreName =
        async (db, id) => (await db.DocumentStores.Find(x => x.Id == id).FirstOrDefaultAsync())?.Name;

    private static readonly Func<MongoDbContext, string, Task<string?>> DefectTitle =
        async (db, id) => (await db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync())?.Title;

    private static readonly Func<MongoDbContext, string, Task<string?>> WeeklyReportTitle =
        async (db, id) =>
        {
            var r = await db.WeeklyReports.Find(x => x.Id == id).FirstOrDefaultAsync();
            return r == null ? null : $"{r.WeekYear}年第{r.WeekNumber}周";
        };

    private static readonly Func<MongoDbContext, string, Task<string?>> WorkspaceTitle =
        async (db, id) => (await db.ImageMasterWorkspaces.Find(x => x.Id == id).FirstOrDefaultAsync())?.Title;

    private static readonly Func<MongoDbContext, string, Task<string?>> HostedSiteTitle =
        async (db, id) => (await db.HostedSites.Find(x => x.Id == id).FirstOrDefaultAsync())?.Title;

    /// <summary>白名单字典："Controller.Action" → 条目定义</summary>
    public static readonly IReadOnlyDictionary<string, ActivityActionDef> Actions =
        new Dictionary<string, ActivityActionDef>(StringComparer.Ordinal)
        {
            // ── 知识库 document-store ──
            ["DocumentStore.CreateStore"] = new("document-store", "知识库", "创建了知识库", TitleArgs: new[] { "request.Name" }),
            ["DocumentStore.AddEntry"] = new("document-store", "知识库", "发布了文档", "storeId", TitleArgs: new[] { "request.Title" }),
            ["DocumentStore.UpdateEntry"] = new("document-store", "知识库", "更新了文档", "entryId", TitleDb: DocEntryTitle),
            ["DocumentStore.UpdateEntryContent"] = new("document-store", "知识库", "更新了文档内容", "entryId", TitleDb: DocEntryTitle),
            ["DocumentStore.DeleteEntry"] = new("document-store", "知识库", "删除了文档", "entryId", TitleDb: DocEntryTitle),
            ["DocumentStore.DeleteStore"] = new("document-store", "知识库", "删除了知识库", "storeId", TitleDb: DocStoreName),
            ["DocumentStore.UploadFile"] = new("document-store", "知识库", "上传了文档", "storeId", TitleArgs: new[] { "file" }),

            // ── 缺陷管理 defect-agent ──
            ["DefectAgent.CreateDefect"] = new("defect-agent", "缺陷管理", "创建了缺陷", TitleArgs: new[] { "request.Title" }),
            ["DefectAgent.SubmitDefect"] = new("defect-agent", "缺陷管理", "提交了缺陷", "id", TitleDb: DefectTitle),
            ["DefectAgent.AssignDefect"] = new("defect-agent", "缺陷管理", "指派了缺陷", "id", TitleDb: DefectTitle),
            ["DefectAgent.ResolveDefect"] = new("defect-agent", "缺陷管理", "标记缺陷已修复", "id", TitleDb: DefectTitle),
            ["DefectAgent.VerifyPass"] = new("defect-agent", "缺陷管理", "验证通过了缺陷", "id", TitleDb: DefectTitle),
            ["DefectAgent.RejectDefect"] = new("defect-agent", "缺陷管理", "驳回了缺陷", "id", TitleDb: DefectTitle),
            ["DefectAgent.CloseDefect"] = new("defect-agent", "缺陷管理", "关闭了缺陷", "id", TitleDb: DefectTitle),
            ["DefectAgent.ReopenDefect"] = new("defect-agent", "缺陷管理", "重新打开了缺陷", "id", TitleDb: DefectTitle),
            ["DefectAgent.SendMessage"] = new("defect-agent", "缺陷管理", "评论了缺陷", "id", TitleDb: DefectTitle),
            ["DefectAgent.DeleteDefect"] = new("defect-agent", "缺陷管理", "删除了缺陷", "id", TitleDb: DefectTitle),

            // ── 周报/日报 report-agent ──
            ["ReportAgent.CreateReport"] = new("report-agent", "周报", "创建了周报"),
            ["ReportAgent.SubmitReport"] = new("report-agent", "周报", "发布了周报", "id", TitleDb: WeeklyReportTitle),
            ["ReportAgent.ReviewReport"] = new("report-agent", "周报", "审阅了周报", "id", TitleDb: WeeklyReportTitle),
            ["ReportAgent.ReturnReport"] = new("report-agent", "周报", "退回了周报", "id", TitleDb: WeeklyReportTitle),
            ["ReportAgent.CreateComment"] = new("report-agent", "周报", "评论了周报", "id", TitleDb: WeeklyReportTitle),
            ["ReportAgent.SaveDailyLog"] = new("report-agent", "周报", "提交了日报", TitleArgs: new[] { "request.Date" }),

            // ── 视觉创作 visual-agent ──
            ["ImageMaster.CreateWorkspace"] = new("visual-agent", "视觉创作", "创建了工作区", TitleArgs: new[] { "request.Title" }),
            ["ImageMaster.DeleteWorkspace"] = new("visual-agent", "视觉创作", "删除了工作区", "id", TitleDb: WorkspaceTitle),
            ["ImageMaster.CreateWorkspaceImageGenRun"] = new("visual-agent", "视觉创作", "发起了图片生成", "id", TitleDb: WorkspaceTitle),
            ["ImageGen.CreateRun"] = new("visual-agent", "视觉创作", "发起了图片生成"),

            // ── 文学创作 literary-agent ──
            ["LiteraryAgentWorkspace.CreateWorkspace"] = new("literary-agent", "文学创作", "创建了工作区", TitleArgs: new[] { "request.Title" }),
            ["LiteraryAgentWorkspace.DeleteWorkspace"] = new("literary-agent", "文学创作", "删除了工作区", "id", TitleDb: WorkspaceTitle),
            ["LiteraryAgentImageGen.CreateRun"] = new("literary-agent", "文学创作", "生成了配图"),

            // ── 网页托管 web-pages ──
            ["WebPages.Upload"] = new("web-pages", "网页托管", "发布了站点", TitleArgs: new[] { "title", "file" }),
            ["WebPages.CreateFromContent"] = new("web-pages", "网页托管", "发布了站点", TitleArgs: new[] { "req.Title" }),
            ["WebPages.Update"] = new("web-pages", "网页托管", "更新了站点", "id", TitleDb: HostedSiteTitle),
            ["WebPages.Delete"] = new("web-pages", "网页托管", "删除了站点", "id", TitleDb: HostedSiteTitle),
        };

    /// <summary>导出去重后的模块清单（前端筛选下拉用，避免前后端模块清单漂移）</summary>
    public static IReadOnlyList<(string Key, string Label)> Modules { get; } = Actions.Values
        .Select(d => (d.Module, d.ModuleLabel))
        .Distinct()
        .ToList();
}
