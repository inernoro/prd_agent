using System;

namespace PrdAgent.Api.Mcp;

/// <summary>
/// 智能体一律不许做的动作 —— 收不回来的那些。
///
/// 接入向导对用户的原话是「删除和公开发布这类收不回来的动作一律不开放给智能体」。
/// 兑现这句话需要两道门，因为一把 AgentApiKey 有两条路能打到平台：
/// <list type="number">
/// <item>走网关 <c>/api/mcp</c> —— 登记表里的 DELETE 在列举与调用两处都被挡；</item>
/// <item>拿同一把 <c>sk-ak</c> 直连普通业务控制器 —— 它们大多只有 <c>[Authorize]</c>，
/// 而默认策略接受 ApiKey scheme；<c>AdminPermissionMiddleware</c> 再把 scope
/// <c>a:b</c> 认成 admin 权限 <c>a.b</c>。于是持 <c>web-pages:write</c> 的钥匙
/// 能直接调 <c>DELETE /api/web-pages/&#123;id&#125;</c>，把主人的站点删掉。</item>
/// </list>
///
/// 判据放在这里而不是网关里，是因为**只在网关挡住等于只锁了正门**。两条路共用这一处，
/// 不各写各的 —— 那是判据分裂的现成温床（本 PR 里已经栽过好几次）。
///
/// 已知边界（与 <c>doc/debt.platform.md</c> #18 同一条）：这里认的是**方法与路径命名**，
/// 不是语义。一个把删除做成 <c>POST /things/&#123;id&#125;/archive</c> 的接口照样过得去，
/// 而一个只是「按 id 取消订阅」的 DELETE 会被一起关在门外。要认得准，
/// 需要登记表补一个破坏性标记 + 一档独立 scope + 一次显式确认。
/// </summary>
public static class McpDestructiveActions
{
    /// <summary>方法本身就收不回来。</summary>
    public static bool IsDestructiveMethod(string? httpMethod)
        => string.Equals(httpMethod?.Trim(), "DELETE", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 伪装成 POST 的删除。只认路径**最后一段**精确等于这几个动词 ——
    /// 模糊匹配（例如「含 delete 字样」）会误伤 <c>/deleted-items</c> 这类查询路由。
    /// </summary>
    private static readonly string[] DestructiveLastSegments =
    {
        "batch-delete", "bulk-delete", "delete-all", "purge",
    };

    /// <summary>这一次请求要不要挡下来。</summary>
    public static bool IsDestructiveRequest(string? httpMethod, string? path)
    {
        if (IsDestructiveMethod(httpMethod)) return true;
        if (string.IsNullOrWhiteSpace(path)) return false;

        var trimmed = path.TrimEnd('/');
        var slash = trimmed.LastIndexOf('/');
        var last = slash >= 0 ? trimmed[(slash + 1)..] : trimmed;
        // 查询串不该混进段名（/x/batch-delete?dry=1）
        var q = last.IndexOf('?');
        if (q >= 0) last = last[..q];

        foreach (var seg in DestructiveLastSegments)
            if (string.Equals(last, seg, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }
}
