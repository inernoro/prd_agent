using System;
using System.Collections.Generic;

namespace PrdAgent.Api.Mcp;

/// <summary>
/// MCP 工具的一个参数定义。决定 inputSchema 怎么生成、tools/call 时参数往哪放（路径/查询/请求体）。
/// </summary>
public sealed class McpToolParam
{
    public required string Name { get; init; }

    /// <summary>参数位置：path（替换 {xxx}）/ query（拼到 ?） / body（放进 JSON body）</summary>
    public required string In { get; init; }

    /// <summary>JSON Schema 类型：string / number / integer / boolean</summary>
    public string Type { get; init; } = "string";

    public bool Required { get; init; }

    public string Description { get; init; } = string.Empty;

    /// <summary>可选枚举值（如 sort=hot|new）</summary>
    public string[]? EnumValues { get; init; }
}

/// <summary>
/// 一个内置 MCP 工具的声明。内置工具走固定 scope（marketplace.skills:read / document-store:read），
/// 区别于从 AgentOpenEndpoint 登记表动态生成的工具（走 agent.* scope）。
///
/// tools/call 时由 McpGatewayController 按 Method + PathTemplate + Params 拼出真实请求，
/// 回环转发当前 sk-ak Bearer 到自身真实接口，真实接口的鉴权/权限仍是最终闸门。
/// </summary>
public sealed class McpToolDef
{
    public required string Name { get; init; }
    public required string Description { get; init; }

    /// <summary>调用此工具所需的 scope（当前密钥必须持有）</summary>
    public required string RequiredScope { get; init; }

    public required string Method { get; init; }

    /// <summary>绝对路径模板，可含 {paramName} 占位，如 /api/document-store/stores/{storeId}/entries</summary>
    public required string PathTemplate { get; init; }

    public IReadOnlyList<McpToolParam> Params { get; init; } = new List<McpToolParam>();

    /// <summary>
    /// 这个工具会不会在平台里留下东西（决定它算不算「写入」、要不要扣每日写入额度）。
    ///
    /// 默认按 HTTP 动词推（非 GET 即写入），但**动词不等于语义**：取用技能是 POST，
    /// 可它只是把公开技能下载到自己名下、顺带记一次去重过的下载量，本质是读。
    /// 一个只读客户端多取几个技能就被写入额度挡住，是判据太宽（形状 1）。
    /// 语义与动词不一致时，在这里显式写出来。
    /// </summary>
    public bool? WritesData { get; init; }
}

/// <summary>
/// MAP MCP 连接器的内置工具注册表（首批：海鲜市场 + 知识库的只读能力）。
///
/// 新增内置工具只要在 All 里加一条；自动出现在 tools/list（前提是密钥持有对应 scope）。
/// 更复杂、按 Agent 暴露的能力走 AgentOpenEndpoint 动态登记，不在这里硬编码。
/// </summary>
public static class McpBuiltinTools
{
    public const string ScopeMarketplaceRead = "marketplace.skills:read";
    public const string ScopeDocStoreRead = "document-store:read";
    public const string ScopeDocStoreWrite = "document-store:write";

    /// <summary>
    /// 按真实 HTTP 请求（方法 + 路径）反查内置工具。
    ///
    /// 直连开放接口时要认出「这一次等价于哪个工具」，才能套同一套用量闸门。反查回到这张注册表，
    /// 而不是在过滤器里另写一份路径清单——两份清单迟早各走各的（形状 3：判据分裂后漂移）。
    /// </summary>
    public static McpToolDef? MatchRequest(string method, string path)
    {
        foreach (var t in All)
        {
            if (!string.Equals(t.Method, method, StringComparison.OrdinalIgnoreCase)) continue;
            if (PathTemplateMatches(t.PathTemplate, path)) return t;
        }
        return null;
    }

    /// <summary>
    /// 路径模板匹配：{xxx} 占位吃掉任意一个路径段，其余段逐段相等。
    ///
    /// 动态工具（AgentOpenEndpoint.Path）的直连反查也用这一个，别再写第二份 —— 两份匹配
    /// 迟早在占位语义上各走各的，而其中一份走偏的后果是「某条路悄悄没了闸门」。
    /// </summary>
    internal static bool PathTemplateMatches(string template, string path)
    {
        var tpl = template.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var seg = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (tpl.Length != seg.Length) return false;
        for (var i = 0; i < tpl.Length; i++)
        {
            if (tpl[i].Length > 1 && tpl[i][0] == '{' && tpl[i][^1] == '}') continue;
            if (!string.Equals(tpl[i], seg[i], StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    public static readonly IReadOnlyList<McpToolDef> All = new List<McpToolDef>
    {
        // ── 海鲜市场（技能市场）──
        new McpToolDef
        {
            Name = "marketplace_search_skills",
            Description = "搜索 MAP 海鲜市场（技能市场）里公开的技能包。可按关键词、标签过滤，按热度或最新排序。",
            RequiredScope = ScopeMarketplaceRead,
            Method = "GET",
            PathTemplate = "/api/open/marketplace/skills",
            Params = new List<McpToolParam>
            {
                new() { Name = "keyword", In = "query", Description = "标题/描述关键词，可选" },
                new() { Name = "tag", In = "query", Description = "按标签精确过滤，可选" },
                new() { Name = "sort", In = "query", Description = "排序：hot（热度，默认）或 new（最新）", EnumValues = new[] { "hot", "new" } },
                new() { Name = "limit", In = "query", Type = "integer", Description = "返回条数上限（1-200，默认 50）" },
            },
        },
        new McpToolDef
        {
            Name = "marketplace_get_skill",
            Description = "按技能 id 获取海鲜市场某个技能包的详情（标题、描述、作者、下载量、下载地址等）。",
            RequiredScope = ScopeMarketplaceRead,
            Method = "GET",
            PathTemplate = "/api/open/marketplace/skills/{id}",
            Params = new List<McpToolParam>
            {
                new() { Name = "id", In = "path", Required = true, Description = "技能包 id（来自搜索结果的 id 字段）" },
            },
        },

        // ── 知识库（文档空间）──
        new McpToolDef
        {
            Name = "knowledge_base_list_stores",
            Description = "列出当前用户自己的知识库（文档空间）。返回每个知识库的 id、名称等，用于后续按 id 查条目。",
            RequiredScope = ScopeDocStoreRead,
            Method = "GET",
            PathTemplate = "/api/open/document-store/stores",
            Params = new List<McpToolParam>
            {
                new() { Name = "limit", In = "query", Type = "integer", Description = "返回条数上限（1-200，默认 50）" },
            },
        },
        new McpToolDef
        {
            Name = "knowledge_base_list_entries",
            Description = "列出某个知识库下的文档条目（扁平返回，含嵌套文件夹内的文档）。可用关键词过滤标题。先用 knowledge_base_list_stores 拿 storeId。",
            RequiredScope = ScopeDocStoreRead,
            Method = "GET",
            PathTemplate = "/api/open/document-store/stores/{storeId}/entries",
            Params = new List<McpToolParam>
            {
                new() { Name = "storeId", In = "path", Required = true, Description = "知识库 id" },
                new() { Name = "keyword", In = "query", Description = "按标题关键词过滤，可选" },
                new() { Name = "limit", In = "query", Type = "integer", Description = "返回条数上限（1-500，默认 200）" },
            },
        },
        new McpToolDef
        {
            Name = "knowledge_base_read_entry",
            Description = "读取某个文档条目的完整正文内容。先用 knowledge_base_list_entries 拿 entryId。",
            RequiredScope = ScopeDocStoreRead,
            Method = "GET",
            PathTemplate = "/api/open/document-store/entries/{entryId}/content",
            Params = new List<McpToolParam>
            {
                new() { Name = "entryId", In = "path", Required = true, Description = "文档条目 id" },
            },
        },
        // ── 视觉创作（scope visual-agent:use）──
        new McpToolDef
        {
            Name = "map_visual_generate_image",
            Description = "用一句话生成图片，图片落进用户自己的视觉创作空间。生成是异步的：本工具返回 runId，随后用 map_visual_get_run 查进度和图片地址（通常十几秒到一分钟）。一次最多 4 张。",
            RequiredScope = McpCapabilityCatalog.ScopeVisualUse,
            Method = "POST",
            PathTemplate = "/api/open/visual/images",
            Params = new List<McpToolParam>
            {
                new() { Name = "prompt", In = "body", Required = true, Description = "画面描述，中英文均可，越具体越好" },
                new() { Name = "size", In = "body", Description = "尺寸，如 1024x1024（默认）/ 1024x1536 / 1536x1024" },
                new() { Name = "count", In = "body", Type = "integer", Description = "张数，1-4，默认 1" },
                new() { Name = "clientRequestId", In = "body", Description = "幂等键：重试时带同一个值不会重复生成" },
            },
        },
        new McpToolDef
        {
            Name = "map_visual_get_run",
            Description = "查一次生图任务的进度与结果。返回每张图的状态与可访问地址（不返回图片 base64）。runId 来自 map_visual_generate_image。",
            RequiredScope = McpCapabilityCatalog.ScopeVisualUse,
            Method = "GET",
            PathTemplate = "/api/open/visual/runs/{runId}",
            Params = new List<McpToolParam>
            {
                new() { Name = "runId", In = "path", Required = true, Description = "生图任务 id" },
            },
        },
        new McpToolDef
        {
            Name = "map_visual_list_models",
            Description = "看当前视觉创作开放给智能体的生图模型。生图报「未配默认模型」时用它确认。",
            RequiredScope = McpCapabilityCatalog.ScopeVisualUse,
            Method = "GET",
            PathTemplate = "/api/open/visual/models",
        },

        // ── 文学创作（scope literary-agent:use）──
        new McpToolDef
        {
            Name = "map_literary_list_workspaces",
            Description = "列出用户的文学创作工作区（最近更新在前），拿 workspaceId 用于后续写入。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "GET",
            PathTemplate = "/api/open/literary/workspaces",
            Params = new List<McpToolParam>
            {
                new() { Name = "limit", In = "query", Type = "integer", Description = "返回条数上限（1-100，默认 20）" },
            },
        },
        new McpToolDef
        {
            Name = "map_literary_create_workspace",
            Description = "新建一个文学创作工作区，可以同时把初稿写进去。返回 workspaceId。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "POST",
            PathTemplate = "/api/open/literary/workspaces",
            Params = new List<McpToolParam>
            {
                new() { Name = "title", In = "body", Description = "工作区标题，最长 40 字，留空为「未命名」" },
                new() { Name = "content", In = "body", Description = "初稿正文，可留空" },
                new() { Name = "clientRequestId", In = "body", Description = "幂等键" },
            },
        },
        new McpToolDef
        {
            Name = "map_literary_write_content",
            Description = "写工作区正文：mode=replace 整篇覆盖（默认），mode=append 接在末尾继续写。先用 map_literary_list_workspaces 拿 workspaceId。append 不可重试（重试会把同一段再接一遍）：没收到回应时请改用 replace 提交完整正文。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "POST",
            PathTemplate = "/api/open/literary/workspaces/{workspaceId}/content",
            Params = new List<McpToolParam>
            {
                new() { Name = "workspaceId", In = "path", Required = true, Description = "工作区 id" },
                new() { Name = "content", In = "body", Required = true, Description = "正文内容" },
                new() { Name = "mode", In = "body", Description = "replace（默认）或 append", EnumValues = new[] { "replace", "append" } },
            },
        },

        // ── 知识库写入（scope document-store:write）──
        new McpToolDef
        {
            Name = "map_kb_create_store",
            Description = "新建一个知识库（默认私有，归当前用户所有）。已经有合适的库就别新建，先用 knowledge_base_list_stores 找。",
            RequiredScope = ScopeDocStoreWrite,
            Method = "POST",
            PathTemplate = "/api/open/document-store/stores",
            Params = new List<McpToolParam>
            {
                new() { Name = "name", In = "body", Required = true, Description = "知识库名称" },
                new() { Name = "description", In = "body", Description = "一句话说明这个库放什么" },
                new() { Name = "clientRequestId", In = "body", Description = "幂等键：重试时带同一个值不会建两个库" },
            },
        },
        new McpToolDef
        {
            Name = "map_kb_create_entry",
            Description = "往知识库写一篇文档（标题 + Markdown 正文一次到位）。只能写用户自己的库，别人共享给他的库是只读的。先用 knowledge_base_list_stores 拿 storeId。",
            RequiredScope = ScopeDocStoreWrite,
            Method = "POST",
            PathTemplate = "/api/open/document-store/stores/{storeId}/entries",
            Params = new List<McpToolParam>
            {
                new() { Name = "storeId", In = "path", Required = true, Description = "知识库 id" },
                new() { Name = "title", In = "body", Required = true, Description = "文档标题" },
                new() { Name = "content", In = "body", Description = "Markdown 正文，最长 20 万字" },
                new() { Name = "summary", In = "body", Description = "一句话摘要，可留空" },
                new() { Name = "clientRequestId", In = "body", Description = "幂等键：重试时带同一个值不会写两篇" },
            },
        },
        new McpToolDef
        {
            Name = "map_kb_update_entry",
            Description = "覆盖某篇文档的正文（会留一版历史，用户可在界面回滚）。entryId 来自 knowledge_base_list_entries。",
            RequiredScope = ScopeDocStoreWrite,
            Method = "PUT",
            PathTemplate = "/api/open/document-store/entries/{entryId}/content",
            Params = new List<McpToolParam>
            {
                new() { Name = "entryId", In = "path", Required = true, Description = "文档条目 id" },
                new() { Name = "content", In = "body", Required = true, Description = "新的完整正文（整篇覆盖，不是追加）" },
            },
        },

        // ── 网页托管（scope web-pages:read / web-pages:write）──
        new McpToolDef
        {
            Name = "map_web_publish_page",
            Description = "把一整页 HTML 托管成站点，返回可以直接打开的地址。适合把生成的报告、看板、演示页交付给用户。只收 HTML 文本（不支持 zip、图片等二进制），单页上限 4MB。",
            RequiredScope = McpCapabilityCatalog.ScopeWebPagesWrite,
            Method = "POST",
            PathTemplate = "/api/open/web-pages/pages",
            Params = new List<McpToolParam>
            {
                new() { Name = "htmlContent", In = "body", Required = true, Description = "完整的 HTML 文档（含 doctype），图片请内联为 data URI" },
                new() { Name = "title", In = "body", Description = "站点标题" },
                new() { Name = "description", In = "body", Description = "一句话说明" },
                new() { Name = "folder", In = "body", Description = "归到哪个文件夹，可留空" },
                new() { Name = "clientRequestId", In = "body", Description = "幂等键：重试时带同一个值不会重复建站" },
            },
        },
        new McpToolDef
        {
            Name = "map_web_list_pages",
            Description = "列出用户托管的站点（最新在前），可按关键词过滤。用于找到之前发布过的页面。",
            RequiredScope = McpCapabilityCatalog.ScopeWebPagesRead,
            Method = "GET",
            PathTemplate = "/api/open/web-pages/pages",
            Params = new List<McpToolParam>
            {
                new() { Name = "keyword", In = "query", Description = "标题关键词，可选" },
                new() { Name = "limit", In = "query", Type = "integer", Description = "返回条数上限（1-100，默认 20）" },
            },
        },
        new McpToolDef
        {
            Name = "map_web_create_share",
            Description = "给某个托管站点建一条分享链接（默认 7 天有效）。链接是 owner-only 的：只有用户自己和他的团队打得开，不会公开到互联网。",
            RequiredScope = McpCapabilityCatalog.ScopeWebPagesWrite,
            Method = "POST",
            PathTemplate = "/api/open/web-pages/pages/{siteId}/share",
            Params = new List<McpToolParam>
            {
                new() { Name = "siteId", In = "path", Required = true, Description = "站点 id（来自 map_web_publish_page 或 map_web_list_pages）" },
                new() { Name = "title", In = "body", Description = "分享标题，留空用站点标题" },
                new() { Name = "expiresInDays", In = "body", Type = "integer", Description = "有效期天数，1-90，默认 7" },
            },
        },

        // ── 海鲜市场写侧（scope marketplace.skills:read 即可 fork）──
        new McpToolDef
        {
            Name = "map_market_fork_skill",
            Description = "取用海鲜市场里的某个技能包（下载量 +1，返回 zip 下载地址）。id 来自 marketplace_search_skills。",
            RequiredScope = ScopeMarketplaceRead,
            WritesData = false,   // POST，但语义是取用（下载到自己名下），不占写入额度
            Method = "POST",
            PathTemplate = "/api/open/marketplace/skills/{id}/fork",
            Params = new List<McpToolParam>
            {
                new() { Name = "id", In = "path", Required = true, Description = "技能包 id" },
            },
        },
    };
}
