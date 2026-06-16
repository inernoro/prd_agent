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
    };
}
