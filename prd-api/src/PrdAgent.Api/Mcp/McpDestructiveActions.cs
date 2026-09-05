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

    /// <summary>
    /// 承诺的另一半：公开发布。
    ///
    /// 向导对用户的原话是「删除、<b>公开发布</b>这类收不回来的动作一律不给」，而上一版
    /// 只兑现了「删除」那半句 —— 持 <c>literary:write</c> 的钥匙照样能打
    /// <c>POST /api/literary-agent/prompts/&#123;id&#125;/publish</c> 把主人的提示词公开出去。
    /// 撤下来不难，已经被别人看见/抄走的那部分收不回来，所以它跟删除同档。
    ///
    /// 认「最后一段是 publish，或以 -publish 收尾」两种形状：后者是本仓库真实存在的
    /// <c>creative-publish</c> 这类命名，不是臆想的同义词。<c>unpublish</c> 没有连字符，
    /// 落不进这条 —— 撤回本来就该放行。
    ///
    /// 内置工具没有一条路径落在这里：网页托管发布走的是
    /// <c>POST /api/open/web-pages/pages</c>（最后一段是 pages），分享链走 <c>/share</c>
    /// 且按工具说明只对本人与团队可见，都不受影响。
    /// </summary>
    private static bool IsPublicPublishSegment(string last)
        => string.Equals(last, "publish", StringComparison.OrdinalIgnoreCase)
           || last.EndsWith("-publish", StringComparison.OrdinalIgnoreCase);

    /// <summary>这一次请求要不要挡下来。</summary>
    public static bool IsDestructiveRequest(string? httpMethod, string? path)
    {
        if (IsDestructiveMethod(httpMethod)) return true;
        if (string.IsNullOrWhiteSpace(path)) return false;

        // 顺序要紧：先摘查询串与锚点，再去尾斜杠。反过来写的话
        // `/api/web-pages/batch-delete/?dry=1` 的最后一段会被切成 `?dry=1`，
        // 一个尾斜杠就把整条从门下放过去了。
        var normalized = path;
        var cut = normalized.IndexOfAny(new[] { '?', '#' });
        if (cut >= 0) normalized = normalized[..cut];
        normalized = normalized.TrimEnd('/');

        var slash = normalized.LastIndexOf('/');
        var last = slash >= 0 ? normalized[(slash + 1)..] : normalized;

        if (IsPublicPublishSegment(last)) return true;

        foreach (var seg in DestructiveLastSegments)
            if (string.Equals(last, seg, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }
}
