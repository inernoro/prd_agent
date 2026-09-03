using System;
using System.Collections.Generic;
using System.Linq;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Mcp;

/// <summary>
/// 一块可以交给外部智能体的能力（接入台上的一张卡）。
///
/// 一块能力 = 一组 scope + 它们对应的后台权限位 + 归属这组 scope 的 MCP 工具。
/// 工具清单不在这里重复维护，由 <see cref="McpCapabilityCatalog.ToolsOf"/> 从
/// <see cref="McpBuiltinTools.All"/> 按 scope 反查得到 —— 两处各写一份必然漂移。
/// </summary>
public sealed class McpCapability
{
    public required string Key { get; init; }

    /// <summary>接入向导 / 接入台上显示的名字</summary>
    public required string Title { get; init; }

    /// <summary>一句话说清「勾了它，智能体能替我做什么」</summary>
    public required string Summary { get; init; }

    /// <summary>只读 scope；null 表示这块能力没有纯读的档位</summary>
    public string? ReadScope { get; init; }

    /// <summary>写入 scope；null 表示这块能力不提供写入</summary>
    public string? WriteScope { get; init; }

    /// <summary>写入动作是否默认需要用户逐次放行（接入台「等我拍板」）</summary>
    public bool WriteNeedsApproval { get; init; }

    /// <summary>
    /// 持写 scope 能不能顺带用只读工具。
    ///
    /// 这条**必须跟真实闸门一致**，不能按 `{res}:write / {res}:read` 的字面规律推：
    /// 知识库与网页托管的读端点写成 `[RequireScope(read, write)]`，写确实能读；
    /// 海鲜市场的读端点是 `[RequireScope(read)]` 精确匹配，持写 scope 打过去会 403。
    /// 网关这边要是自作主张放行，tools/list 会列出一批调用即 403 的工具。
    /// </summary>
    public bool WriteImpliesRead { get; init; }

    public IEnumerable<string> AllScopes()
    {
        if (!string.IsNullOrEmpty(ReadScope)) yield return ReadScope!;
        if (!string.IsNullOrEmpty(WriteScope)) yield return WriteScope!;
    }
}

/// <summary>
/// 接入台的能力目录 —— 「智能体能被授权做什么」的唯一事实源。
///
/// 三个消费方都读这里，不各自维护清单：
///   1. 签发密钥时的 scope 白名单与用户权限交集校验（AgentApiKeysController）
///   2. 接入向导与接入台面板的能力卡（/api/mcp-console/*）
///   3. MCP 工具可见性（工具的 RequiredScope 必须落在本目录声明的 scope 里）
///
/// scope 与后台权限位的换算沿用 AdminPermissionMiddleware.HasScopeGrant 的口径：
/// scope `a:b` 满足权限 `a.b`，且 `{res}:write` 蕴含 `{res}.read`。
/// </summary>
public static class McpCapabilityCatalog
{
    public const string ScopeVisualUse = "visual-agent:use";
    public const string ScopeLiteraryUse = "literary-agent:use";
    public const string ScopeWebPagesRead = "web-pages:read";
    public const string ScopeWebPagesWrite = "web-pages:write";
    public const string ScopeMarketplaceRead = "marketplace.skills:read";
    public const string ScopeMarketplaceWrite = "marketplace.skills:write";
    public const string ScopeDocStoreRead = "document-store:read";
    public const string ScopeDocStoreWrite = "document-store:write";

    public static readonly IReadOnlyList<McpCapability> All = new List<McpCapability>
    {
        new()
        {
            Key = "visual",
            Title = "视觉创作",
            Summary = "给一句话就出图，图片进你自己的视觉创作工作区；任务在服务端跑，关掉客户端也不会断。",
            WriteScope = ScopeVisualUse,
            WriteNeedsApproval = false,
        },
        new()
        {
            Key = "literary",
            Title = "文学创作",
            Summary = "开工作区、续写、改稿，产出留在你的文学创作空间。",
            WriteScope = ScopeLiteraryUse,
            WriteNeedsApproval = true,
        },
        new()
        {
            Key = "knowledge",
            Title = "知识库",
            Summary = "读你的文档空间，也能把整理好的稿子写回去；附件类暂时只收纯文本。",
            ReadScope = ScopeDocStoreRead,
            WriteScope = ScopeDocStoreWrite,
            WriteNeedsApproval = true,
            WriteImpliesRead = true,   // /api/open/document-store 的读端点是 [RequireScope(read, write)]
        },
        new()
        {
            Key = "web",
            Title = "网页托管",
            Summary = "智能体写完一页 HTML 直接托管，回给你一条能点开的地址。",
            ReadScope = ScopeWebPagesRead,
            WriteScope = ScopeWebPagesWrite,
            WriteNeedsApproval = true,
            WriteImpliesRead = true,   // /api/open/web-pages 的列表端点是 [RequireScope(read, write)]
        },
        new()
        {
            Key = "market",
            // 只有读这一档。上传技能包走 multipart，MCP 传不了二进制，所以没有任何工具挂在
            // marketplace.skills:write 上 —— 之前把它摆成能力卡的写入档，等于让用户勾一个
            // 「勾了也多不出任何工具」的空头 scope，卡片文案还写着「能把技能包发上去」。
            // 那个 scope 本身仍然有效（市场上传 REST 接口在用），只是不该出现在接入台的向导里。
            Title = "海鲜市场",
            Summary = "去技能市场找技能、把技能取到自己名下。上传技能包要传 zip，MCP 传不了二进制，这一期只能在网页里发。",
            ReadScope = ScopeMarketplaceRead,
            WriteScope = null,
            WriteNeedsApproval = false,
            WriteImpliesRead = false,
        },
    };

    /// <summary>本目录声明过的全部 scope（签发密钥的白名单来源）。</summary>
    public static readonly IReadOnlySet<string> AllScopes =
        All.SelectMany(c => c.AllScopes()).ToHashSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// 要按「密钥主人当前还有没有这个权限位」把关的 scope —— 签发时取交集、鉴权时再核一遍，两处同一份名单。
    ///
    /// 只覆盖本轮新接进来的四个 scope，两条理由缺一不可：
    ///   1. 存量兼容：marketplace / document-store 的密钥早就在跑，它们签发时从来没过权限交集，
    ///      纳进来会让已经在用的接入突然签不出、也调不动。
    ///   2. 判据得站得住：这四个 scope 对应的权限位（visual-agent.use / literary-agent.use /
    ///      web-pages.read / web-pages.write）在权限目录里真实存在，而 `marketplace.skills:read`
    ///      压根没有对应的权限位 —— 海鲜市场开放接口的闸门是 `[RequireScope]` 自己，不走后台权限位。
    ///      拿一个不存在的权限位去要求用户，等于谁都签不出来（连 root 都不行）。
    ///
    /// 换句话说：这个集合 = 「既受后台权限位管、又没有存量包袱」的那部分。
    /// 往里加 scope 前先确认权限目录里真有对应的 key，否则 McpCapabilityCatalogTests 会红。
    /// </summary>
    public static readonly IReadOnlySet<string> PermissionCheckedScopes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        ScopeVisualUse, ScopeLiteraryUse, ScopeWebPagesRead, ScopeWebPagesWrite,
    };

    /// <summary>这块能力的 scope 是否受后台权限位把关（决定接入向导里要不要提示「你还没有这个权限」）。</summary>
    public static bool IsPermissionChecked(McpCapability capability) =>
        capability.AllScopes().Any(PermissionCheckedScopes.Contains);

    public static McpCapability? ByScope(string scope) =>
        All.FirstOrDefault(c => c.AllScopes().Contains(scope, StringComparer.OrdinalIgnoreCase));

    /// <summary>归属某块能力的内置工具（按 scope 反查，不另维护清单）。</summary>
    public static IReadOnlyList<McpToolDef> ToolsOf(McpCapability capability)
    {
        var scopes = capability.AllScopes().ToHashSet(StringComparer.OrdinalIgnoreCase);
        return McpBuiltinTools.All.Where(t => scopes.Contains(t.RequiredScope)).ToList();
    }

    /// <summary>
    /// scope 换算成后台权限位：`a:b` → `a.b`。与 AdminPermissionMiddleware.HasScopeGrant 同口径。
    /// </summary>
    public static string ToPermission(string scope) => scope.Replace(':', '.');

    /// <summary>
    /// 持有 <paramref name="ownedPermissions"/> 的用户，能不能被授予 <paramref name="scope"/>。
    /// 写蕴含读：持 `{res}.write` 的人可以拿 `{res}:read` scope。
    /// </summary>
    public static bool PermissionsAllowScope(IReadOnlyCollection<string> ownedPermissions, string scope)
    {
        var required = ToPermission(scope);
        // super 是全站通配（AdminPermissionMiddleware 就是这么认的）。不认它的话，
        // 持 super 的管理员界面上用得了这些功能、却签不出对应的密钥，接入台还把能力显示成灰的。
        foreach (var owned in ownedPermissions)
            if (string.Equals(owned, AdminPermissionCatalog.Super, StringComparison.OrdinalIgnoreCase))
                return true;

        foreach (var owned in ownedPermissions)
        {
            if (string.Equals(owned, required, StringComparison.OrdinalIgnoreCase)) return true;
            if (owned.EndsWith(".write", StringComparison.OrdinalIgnoreCase)
                && required.EndsWith(".read", StringComparison.OrdinalIgnoreCase)
                && string.Equals(owned[..^6], required[..^5], StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    /// <summary>
    /// 持有 <paramref name="owned"/> 这些 scope 的密钥，能不能用要求 <paramref name="required"/> 的工具。
    /// 精确匹配优先；写蕴含读**按能力声明**，不按命名规律（见 McpCapability.WriteImpliesRead）。
    /// </summary>
    public static bool ScopeSatisfies(IReadOnlyCollection<string> owned, string required)
    {
        foreach (var s in owned)
            if (string.Equals(s, required, StringComparison.OrdinalIgnoreCase))
                return true;

        // 写蕴含读只在那块能力的真实闸门也蕴含时才成立（见 McpCapability.WriteImpliesRead）。
        // 早先这里按 `:write` / `:read` 的字面规律一刀切，等于替海鲜市场做了它并不认的决定 ——
        // tools/list 会列出一批调用即 403 的工具。判据要认真实闸门，不认命名规律。
        var cap = All.FirstOrDefault(c =>
            !string.IsNullOrEmpty(c.ReadScope) && string.Equals(c.ReadScope, required, StringComparison.OrdinalIgnoreCase));
        if (cap is { WriteImpliesRead: true } && !string.IsNullOrEmpty(cap.WriteScope)
            && owned.Any(o => string.Equals(o, cap.WriteScope, StringComparison.OrdinalIgnoreCase)))
            return true;

        return false;
    }

    /// <summary>权限位对应的中文名（拒绝签发时告诉用户缺的是哪一项，而不是甩一个 key）。</summary>
    public static string DescribePermission(string permission) =>
        AdminPermissionCatalog.All.FirstOrDefault(p => string.Equals(p.Key, permission, StringComparison.OrdinalIgnoreCase))?.Name
        ?? permission;
}
