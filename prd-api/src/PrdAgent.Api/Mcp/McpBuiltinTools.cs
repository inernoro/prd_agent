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

    /// <summary>Type=array 时元素的 JSON Schema 类型（integer / string ...）；不填则元素类型不限。</summary>
    public string? ItemsType { get; init; }
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
    /// 按**框架真正选中的那条路由模板**反查工具（形状 6：判据要读生效的值，不是自己再猜一遍）。
    ///
    /// 拿原始路径去匹配会让占位符吞掉同级的静态路由：`GET /api/open/marketplace/skills/tags`
    /// 是一条真实存在的、不是 MCP 工具的接口，却会被 `marketplace_get_skill` 的
    /// `/skills/{id}` 吃掉 —— 于是它白扣一次这把密钥的分钟窗口、还在调用记录里留下一条
    /// 根本没发生过的 `marketplace_get_skill`，反复请求甚至能把人限到 429。
    ///
    /// 改成拿 ActionDescriptor 的路由模板比：占位段只与占位段相等，静态段只与静态段相等。
    /// `tags` 是静态段，与 `{id}` 不再相等，整类「静态兄弟被占位吃掉」就此消失。
    /// </summary>
    public static McpToolDef? MatchRouteTemplate(string method, string? routeTemplate)
    {
        if (string.IsNullOrWhiteSpace(routeTemplate)) return null;
        foreach (var t in All)
        {
            if (!string.Equals(t.Method, method, StringComparison.OrdinalIgnoreCase)) continue;
            if (RouteTemplatesEqual(t.PathTemplate, routeTemplate)) return t;
        }
        return null;
    }

    /// <summary>两条路由模板是不是同一条：段数相同，且逐段「占位对占位、静态对静态」。</summary>
    internal static bool RouteTemplatesEqual(string a, string b)
    {
        var x = a.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var y = b.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (x.Length != y.Length) return false;
        for (var i = 0; i < x.Length; i++)
        {
            var xp = IsPlaceholder(x[i]);
            var yp = IsPlaceholder(y[i]);
            if (xp != yp) return false;
            // 占位段的名字与路由约束（{id:int}）不参与比较：叫什么不影响它是同一条路由。
            if (!xp && !string.Equals(x[i], y[i], StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    private static bool IsPlaceholder(string segment)
        => segment.Length > 1 && segment[0] == '{' && segment[^1] == '}';

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
            Description = "读取某个文档条目的完整正文内容。先用 knowledge_base_list_entries 拿 entryId。返回里的 updatedAt 是版本令牌：要覆盖这篇文档时把它原样传给 map_kb_update_entry 的 expectedUpdatedAt。",
            RequiredScope = ScopeDocStoreRead,
            Method = "GET",
            PathTemplate = "/api/open/document-store/entries/{entryId}/content",
            Params = new List<McpToolParam>
            {
                new() { Name = "entryId", In = "path", Required = true, Description = "文档条目 id" },
            },
        },
        // ── 任务台（scope active-tasks:use / :manage）──
        new McpToolDef
        {
            Name = "map_tasks_mine",
            Description = "读「我」的任务台：此刻在做什么（做了多久、卡在等谁）、队列里还堆着几件、最近结了哪些案（含每件「做成了什么样」的那句话）。",
            RequiredScope = McpCapabilityCatalog.ScopeTasksUse,
            Method = "GET",
            PathTemplate = "/api/open/tasks/mine",
            WritesData = false,
        },
        new McpToolDef
        {
            Name = "map_tasks_add",
            Description = "往「我」的队列尾部加一件任务。适合把缺陷、PR、告警变成一条待办；带上 sourceUrl 人接手时点得开。不会打断手上正在做的那件。",
            RequiredScope = McpCapabilityCatalog.ScopeTasksUse,
            Method = "POST",
            PathTemplate = "/api/open/tasks/mine",
            Params = new List<McpToolParam>
            {
                new() { Name = "title", In = "body", Required = true, Description = "要做的是什么，一句话" },
                new() { Name = "note", In = "body", Description = "补充说明，可选" },
                new() { Name = "sourceUrl", In = "body", Description = "来源链接（缺陷/PR/告警地址），可选" },
                new() { Name = "dueAt", In = "body", Description = "什么时候要，ISO 8601 时间，可选。不确定就别填——大多数任务不该有时间要求" },
            },
        },
        new McpToolDef
        {
            Name = "map_tasks_team",
            Description = "读全员此刻在做什么、谁卡住了在等谁、每人队列里堆了多少件，以及最近结案的那几条。需要管理档。",
            RequiredScope = McpCapabilityCatalog.ScopeTasksManage,
            Method = "GET",
            PathTemplate = "/api/open/tasks/team",
            WritesData = false,
        },
        new McpToolDef
        {
            Name = "map_tasks_assign",
            Description = "派一件给别人，排到他的队尾，不打断他手上那件；任务上会带派活人的名字。userId 先用 map_tasks_team 拿。需要管理档。",
            RequiredScope = McpCapabilityCatalog.ScopeTasksManage,
            Method = "POST",
            PathTemplate = "/api/open/tasks/assign",
            Params = new List<McpToolParam>
            {
                new() { Name = "userId", In = "body", Required = true, Description = "派给谁，取自 map_tasks_team 的 people[].userId" },
                new() { Name = "title", In = "body", Required = true, Description = "要做的是什么，一句话" },
                new() { Name = "note", In = "body", Description = "为什么派这件，可选" },
                new() { Name = "sourceUrl", In = "body", Description = "来源链接，可选" },
                new() { Name = "dueAt", In = "body", Description = "什么时候要，ISO 8601 时间，可选" },
            },
        },
        new McpToolDef
        {
            Name = "map_tasks_suggest",
            Description = "给某人提一条建议。和 map_tasks_assign 的区别：派活直接进对方队列（要管理档），建议提了什么都不会发生，由对方自己决定要不要吸取成任务，所以只要 use 档。想提醒别人一件事、又不想替他排队，用这个。userId 先用 map_tasks_team 拿。",
            RequiredScope = McpCapabilityCatalog.ScopeTasksUse,
            Method = "POST",
            PathTemplate = "/api/open/tasks/suggest",
            Params = new List<McpToolParam>
            {
                new() { Name = "userId", In = "body", Required = true, Description = "提给谁，取自 map_tasks_team 的 people[].userId" },
                new() { Name = "text", In = "body", Required = true, Description = "建议内容。不用写成任务的样子——吸取那一步会把它整理成可以动手做的事" },
                new() { Name = "sourceUrl", In = "body", Description = "来源链接（缺陷/PR/告警地址），可选" },
            },
        },
        new McpToolDef
        {
            Name = "map_debt_list",
            Description = "读工程债务台账：还欠着什么、谁认领了、哪几条已经转成任务了。债务正文来自仓库的 doc/debt.*.md，认领人与状态来自任务台。mineOnly=true 只看我认领的。",
            RequiredScope = McpCapabilityCatalog.ScopeTasksUse,
            Method = "GET",
            PathTemplate = "/api/open/tasks/debts",
            WritesData = false,
            Params = new List<McpToolParam>
            {
                new() { Name = "mineOnly", In = "query", Type = "boolean", Description = "只看我认领的那几条，默认 false" },
            },
        },
        new McpToolDef
        {
            Name = "map_debt_sync",
            Description = "把仓库里 doc/debt.*.md 的债务台账推到任务台，按 key 幂等（重复推同一条只更新不新建）。key 形如 platform.active-tasks#15 —— 台账文件名去掉 debt. 前缀和 .md，加表格里的编号。**只覆盖正文**（标题/现状/补的条件）；谁认领了、转成了哪条任务一律不动，所以反复跑不会抹掉认领记录。改完 debt 文档顺手跑一次即可。",
            RequiredScope = McpCapabilityCatalog.ScopeTasksUse,
            Method = "POST",
            PathTemplate = "/api/open/tasks/debts/sync",
            Params = new List<McpToolParam>
            {
                new() { Name = "items", In = "body", Required = true, Type = "array", Description = "债务条目数组，每项 {key, title, status?, closeCondition?, sourcePath?}。key 必须是「模块#编号」格式" },
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
            Name = "map_literary_get_workspace",
            Description = "读一个文学创作工作区的正文与配图进度。illustrations[] 给出每个标记当前的描述 prompt、status、图片 url 与 assetId（生图后轮询它即可，一次看全部）。format=marked 返回带 [插图]: 标记的整篇（标记里是当前描述，含用户在网页上改过的），改稿重配时拿它改、原样作为 markedContent 写回；format=illustrated 返回把已完成配图插在原位的 Markdown；plain 是不带标记的原稿。只改某一张图的描述用 map_literary_update_illustration，不必整篇重写。正文很长时用 offset 分段读，hasMore 说明还有没有。updatedAt 是版本令牌：整篇覆盖时原样传给 map_literary_write_content 的 expectedUpdatedAt。historyImageCount 是被换下的旧图数，明细用 map_literary_list_history。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "GET",
            PathTemplate = "/api/open/literary/workspaces/{workspaceId}",
            Params = new List<McpToolParam>
            {
                new() { Name = "workspaceId", In = "path", Required = true, Description = "工作区 id" },
                new() { Name = "offset", In = "query", Type = "integer", Description = "从第几个字开始读（默认 0）" },
                new() { Name = "limit", In = "query", Type = "integer", Description = "本次最多读多少字（默认 20000）" },
                new() { Name = "format", In = "query", Description = "plain 原稿（不带标记）；marked 带 [插图]: 当前描述 的整篇，改稿重配用它；illustrated 按真实标记位置返回已完成配图的 Markdown，未完成保留标记", EnumValues = new[] { "plain", "marked", "illustrated" } },
            },
        },
        new McpToolDef
        {
            Name = "map_literary_list_presets",
            Description = "列出这个账号在文学创作里能选的风格（参考图配置）、水印配置和尺寸，并标出账号默认配置。用户点名风格时，style 传同一名称或 ID（none 表示不用参考图）；已有文章沿用风格时，传读取工作区返回的 illustrationPrefs.styleId。sizes 对应该风格下这台客户端所用模型（sizeModel）的真实能力，不传 style 则按账号默认风格查询。先查预设，再把同一风格、水印和支持的尺寸传给 map_literary_generate_image。查询不会占用模型恢复探测或生图额度。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "GET",
            PathTemplate = "/api/open/literary/presets",
            Params = new List<McpToolParam>
            {
                new() { Name = "style", In = "query", Description = "准备生图的风格名称或 ID；none = 不用参考图；不传按账号默认风格列尺寸。已有文章沿用风格时传 illustrationPrefs.styleId。" },
            },
        },
        new McpToolDef
        {
            Name = "map_literary_create_workspace",
            Description = "新建私有文学工作区，可带初稿及文件夹。需要配图时传 markedContent（与 content 互斥）：正文中独立一行写 [插图]: 画面描述（全角冒号、【插图】也认），单篇 1-20 张。返回里直接带 workflowVersion 与 illustrations[].index，可立刻调用 map_literary_generate_image。不给 title 时取正文第一行。同一个 clientRequestId 只对应一篇：内容不同会返回 IDEMPOTENCY_CONFLICT。归档到文件夹不等于公开发布。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "POST",
            PathTemplate = "/api/open/literary/workspaces",
            Params = new List<McpToolParam>
            {
                new() { Name = "title", In = "body", Description = "工作区标题，最长 40 字；留空取正文第一行" },
                new() { Name = "content", In = "body", Description = "初稿正文（不配图时用），可留空；不能含 [插图] 标记" },
                new() { Name = "markedContent", In = "body", Description = "含 1-20 行 [插图]: 描述 的完整文章，与 content 互斥；最多 200000 字，每个描述最多 4000 字，描述不能为空" },
                new() { Name = "folderName", In = "body", Description = "文学创作内文件夹名称，最长 80 字；不填写为未分类，不公开发布" },
                new() { Name = "clientRequestId", In = "body", Description = "幂等键：一篇文章一个值，重试原样提交" },
            },
        },
        new McpToolDef
        {
            Name = "map_literary_write_content",
            Description = "写工作区正文：mode=replace 整篇覆盖（默认），mode=append 接在末尾继续写。改稿后要重新配图时传 markedContent（带 [插图]: 标记的整篇，只能 replace；先用 map_literary_get_workspace format=marked 读回再改，并把读回的 updatedAt 作为 expectedUpdatedAt 一起传，标记里的描述是当前值）：画面描述没变的标记会沿用原来那张图（reusedImages），只需为 needsGeneration 里的标记调用生图；被换下的旧图保留在历史里、不删除。返回新的 workflowVersion 与 illustrations。改稿或续写前用 map_literary_get_workspace 读回原稿，并把它回的 updatedAt 传给 expectedUpdatedAt —— 期间被用户改过就会 409 而不是把对方的稿子盖掉。append 不可重试（重试会把同一段再接一遍）：没收到回应时请改用 replace 提交完整正文。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "POST",
            PathTemplate = "/api/open/literary/workspaces/{workspaceId}/content",
            Params = new List<McpToolParam>
            {
                new() { Name = "workspaceId", In = "path", Required = true, Description = "工作区 id" },
                new() { Name = "content", In = "body", Description = "正文内容（不带配图标记）；与 markedContent 二选一" },
                new() { Name = "markedContent", In = "body", Description = "带 [插图]: 标记的整篇正文（1-20 个标记），用于改稿后重新配图；不想换图的小节，把原来的画面描述原样写回即可保留原图。与 content 二选一，只能整篇覆盖" },
                new() { Name = "mode", In = "body", Description = "replace（默认）或 append", EnumValues = new[] { "replace", "append" } },
                new() { Name = "expectedUpdatedAt", In = "body", Description = "上次读到这篇正文时它的 updatedAt。传 markedContent 整篇重写时必填；纯正文 mode=replace 传了才有「期间被改过就不覆盖」这层保护。" },
            },
        },

        new McpToolDef
        {
            Name = "map_literary_generate_image",
            Description = "为文学工作区的配图标记生成图片，保存到该工作区并回填原文位置。markerIndexes 可一次传多个（每个标记一个独立任务），markerIndex 只生一张，二选一。风格 style、水印 watermark 可传名称或 ID（none 表示不用）；不传时沿用这篇文章上次指定的那套，从没指定过才用账号默认；可选值先用 map_literary_list_presets 查。size 传比例（如 3:2）或 宽x高，必须是 map_literary_list_presets 的 sizes 里有的；模型不支持的尺寸会被直接拒绝（不入队、不扣额度）并列出可选项。返回里 applied 说明实际套用了哪套风格/水印/尺寸以及来源（explicit 本次指定 / remembered 沿用上次 / account-default 账号默认）。异步执行：之后用 map_literary_get_workspace 看 illustrations[].status/url，一次看全部。超时重试必须保持 clientRequestId 与其它参数不变。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "POST", PathTemplate = "/api/open/literary/workspaces/{workspaceId}/images",
            Params = new List<McpToolParam>
            {
                new() { Name = "workspaceId", In = "path", Required = true, Description = "文学工作区 id" },
                new() { Name = "markerIndexes", In = "body", Type = "array", ItemsType = "integer", Description = "批量：要生成的标记序号列表（illustrations[].index，从 0 开始），最多 20 个" },
                new() { Name = "markerIndex", In = "body", Type = "integer", Description = "单张：一个标记序号；与 markerIndexes 二选一" },
                new() { Name = "workflowVersion", In = "body", Type = "integer", Required = true, Description = "建稿 / 读取工作区返回的 workflowVersion，改稿后旧版本不能生成" },
                new() { Name = "clientRequestId", In = "body", Required = true, Description = "1-200 字的幂等键，一次请求一个值，原样重试使用同一个值" },
                new() { Name = "style", In = "body", Description = "风格（参考图配置）名称或 ID；none = 不用参考图；不传 = 沿用这篇文章上次指定的，没有则账号当前启用的那套" },
                new() { Name = "watermark", In = "body", Description = "水印配置名称或 ID；none = 不打水印；不传 = 沿用这篇文章上次指定的，没有则账号给文学创作绑定的那套" },
                new() { Name = "size", In = "body", Description = "尺寸：比例如 1:1、3:2，或 宽x高如 1536x1024，可用值以 map_literary_list_presets 的 sizes 为准；不传 = 沿用这篇文章上次指定的，没有则 1:1" },
            },
        },
        new McpToolDef
        {
            Name = "map_literary_update_illustration",
            Description = "只改一个配图标记的画面描述，正文和其它标记都不动（与用户在网页上改描述是同一处）。改完图不会自动换：要按新描述出图，再对这个标记调用 map_literary_generate_image。读稿之后文章被改过（包括用户在网页上改描述）会返回 409，重读后再改。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "POST", PathTemplate = "/api/open/literary/workspaces/{workspaceId}/illustrations/{markerIndex}/prompt",
            Params = new List<McpToolParam>
            {
                new() { Name = "workspaceId", In = "path", Required = true, Description = "文学工作区 id" },
                new() { Name = "markerIndex", In = "path", Type = "integer", Required = true, Description = "标记序号（illustrations[].index，从 0 开始）" },
                new() { Name = "prompt", In = "body", Required = true, Description = "新的画面描述，1-4000 字" },
                new() { Name = "workflowVersion", In = "body", Type = "integer", Required = true, Description = "读稿返回的 workflowVersion" },
                new() { Name = "expectedUpdatedAt", In = "body", Required = true, Description = "读稿返回的 updatedAt，原样传回；期间用户在网页上改过就返回 409，不会盖掉对方的修改" },
            },
        },
        new McpToolDef
        {
            Name = "map_literary_list_history",
            Description = "列出这篇文章生成过的全部配图，含重画、改稿后被换下的旧图（与网页「历史配图」同一份）。每张给 assetId、url、当时所在的标记 markerIndex、当时的描述、是否正挂在正文上（mountedAt 列出它现在挂的全部位置，同一张图可以挂在多处），以及什么时候、因为什么被换下（replacedAt / replacedReason）。previousSets 是每次换稿（网页换正文、整篇重写、重新生成标记）前真正挂在正文上的那组图，从新到旧，是存档时记下的，不用按生成时间推断：用户说「恢复成上传前用的那几张」就取 previousSets[0]。换稿后带标记写回时，描述与上一组一致的标记会自动沿用那张图（看写稿回执的 reusedImages）；其余用 map_literary_restore_image 一张张放回。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "GET", PathTemplate = "/api/open/literary/workspaces/{workspaceId}/history",
            Params = new List<McpToolParam> { new() { Name = "workspaceId", In = "path", Required = true, Description = "文学工作区 id" } },
        },
        new McpToolDef
        {
            Name = "map_literary_restore_image",
            Description = "把历史里的一张旧图放回指定配图位置，不重新生成、不消耗额度；被换下的那张同样留在历史里。图若记着当初的描述，标记描述会一并换成它（返回的 prompt），保证图和描述对得上。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "POST", PathTemplate = "/api/open/literary/workspaces/{workspaceId}/illustrations/{markerIndex}/restore",
            Params = new List<McpToolParam>
            {
                new() { Name = "workspaceId", In = "path", Required = true, Description = "文学工作区 id" },
                new() { Name = "markerIndex", In = "path", Type = "integer", Required = true, Description = "放到哪个标记上（从 0 开始）" },
                new() { Name = "assetId", In = "body", Required = true, Description = "map_literary_list_history 返回的 assetId" },
                new() { Name = "workflowVersion", In = "body", Type = "integer", Required = true, Description = "读稿返回的 workflowVersion" },
            },
        },
        new McpToolDef
        {
            Name = "map_literary_get_image_run",
            Description = "只读查询文学配图进度与图片地址；每 5 秒查询一次，finished=true 即停止，失败时按 error 提示处理。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "GET", PathTemplate = "/api/open/literary/image-runs/{runId}",
            Params = new List<McpToolParam> { new() { Name = "runId", In = "path", Required = true, Description = "文学配图任务 id" } },
        },
        new McpToolDef
        {
            Name = "map_literary_move_workspace",
            Description = "将已有文学文章及配图一起移到指定文件夹，不复制文章、不创建空白文章、不公开发布。重复调用安全。",
            RequiredScope = McpCapabilityCatalog.ScopeLiteraryUse,
            Method = "POST", PathTemplate = "/api/open/literary/workspaces/{workspaceId}/folder",
            Params = new List<McpToolParam>
            {
                new() { Name = "workspaceId", In = "path", Required = true, Description = "文学工作区 id" },
                new() { Name = "folderName", In = "body", Required = true, Description = "最多 80 字，空字符串表示移回未分类" },
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
            Description = "覆盖某篇文档的正文（会留一版历史，用户可在界面回滚）。entryId 来自 knowledge_base_list_entries。**先读再写**：把 knowledge_base_read_entry 回的 updatedAt 原样传给 expectedUpdatedAt，期间被别人改过就会 409 而不是把对方的改动盖掉；不传这个参数就没有这层保护。",
            RequiredScope = ScopeDocStoreWrite,
            Method = "PUT",
            PathTemplate = "/api/open/document-store/entries/{entryId}/content",
            Params = new List<McpToolParam>
            {
                new() { Name = "entryId", In = "path", Required = true, Description = "文档条目 id" },
                new() { Name = "content", In = "body", Required = true, Description = "新的完整正文（整篇覆盖，不是追加）" },
                new() { Name = "expectedUpdatedAt", In = "body", Description = "上次读到这篇文档时它的 updatedAt。传了才有「别人改过就不覆盖」这层保护。" },
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
