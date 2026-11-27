using System;

namespace PrdAgent.Api.Mcp;

/// <summary>
/// 识别未注册为内置网页托管工具的破坏性操作，供 MCP 网关和权限中间件使用。
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
    /// 文学等模块的未受控公开发布仍被禁止：持 <c>literary:write</c> 的钥匙不应直接打
    /// <c>POST /api/literary-agent/prompts/&#123;id&#125;/publish</c> 把主人的提示词公开出去。
    /// 撤下来不难，已经被别人看见/抄走的那部分收不回来，所以它跟删除同档。
    ///
    /// 认「最后一段是 publish，或以 -publish 收尾」两种形状：后者是本仓库真实存在的
    /// <c>creative-publish</c> 这类命名，不是臆想的同义词。<c>unpublish</c> 没有连字符，
    /// 落不进这条 —— 撤回本来就该放行。
    ///
    /// 内置工具没有一条路径落在这里：网页托管发布走的是
    /// <c>POST /api/open/web-pages/pages</c>（最后一段是 pages），分享链走 <c>/share</c>
    /// 且其开放接口执行对象权限和私有资料核查；它们不受这条按路径动词的闸影响。
    /// </summary>
    private static bool IsPublicPublishSegment(string last)
        => string.Equals(last, "publish", StringComparison.OrdinalIgnoreCase)
           || last.EndsWith("-publish", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 开放层：<c>/api/open/</c> 下那批**专门为 API key 设计**的接口。
    ///
    /// 这个判据回答的是「这条路是不是给 API key 走的」，跟
    /// <see cref="IsDestructiveRequest"/>（「这个动作收不收得回来」）是两件事，
    /// 直连那道门要两个一起看，网关那条路只看后者 —— 那条管的是 MCP 工具面，
    /// 而向导那句承诺说的正是工具面。分开是有意的，不是判据分裂。
    ///
    /// 为什么要这条豁免：直连那道门原本要挡的是**普通业务控制器**——
    /// <c>DELETE /api/web-pages/&#123;id&#125;</c> 这类只挂 <c>[Authorize]</c>、
    /// 从没为 API key 设计过，却因为默认策略收 ApiKey scheme、middleware 又把
    /// scope <c>a:b</c> 认成 admin 权限 <c>a.b</c> 而被打通的路。开放层不是这种：
    /// 那八个控制器每一个都显式写着 <c>[Authorize(AuthenticationSchemes = "ApiKey")]</c>
    /// + <c>[RequireScope]</c>，本来就是给 sk-ak 走的受控接口，各自的 scope 就是它的门。
    ///
    /// 不豁免的实际后果（上一版发生过）：<c>llmgw/tutorial/publisher.py</c> 用
    /// <c>MAP_DOC_STORE_KEY</c>（sk-ak 前缀 → authType=agent-apikey）打
    /// <c>POST .../tutorial-link-graph/publish</c> 与回滚用的
    /// <c>DELETE .../nodes/&#123;sourceId&#125;</c>，两条一起 403，教程发布与它的回滚全断。
    ///
    /// **结尾那个斜杠是判据的一部分**：<c>/api/open-platform/</c> 与 <c>/api/open-api/</c>
    /// 是三个挂 <c>[AdminController]</c> 的后台控制器，跟开放层没有关系，
    /// 写成 <c>StartsWith("/api/open")</c> 会把它们的 DELETE 一起放行。
    /// </summary>
    public static bool IsCuratedOpenApiPath(string? path)
        => path != null && path.StartsWith("/api/open/", StringComparison.OrdinalIgnoreCase);

    internal static bool IsHostedSiteManagementPath(string path)
        => path.Equals("/api/web-pages", StringComparison.OrdinalIgnoreCase)
           || path.StartsWith("/api/web-pages/", StringComparison.OrdinalIgnoreCase);

    /// <summary>这一次请求是否命中通用操作限制。</summary>
    public static bool IsDestructiveRequest(string? httpMethod, string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return IsDestructiveMethod(httpMethod);

        // 顺序要紧：先摘查询串与锚点，再去尾斜杠。反过来写的话
        // `/api/web-pages/batch-delete/?dry=1` 的最后一段会被切成 `?dry=1`，
        // 一个尾斜杠就把整条从门下放过去了。
        var normalized = path;
        var cut = normalized.IndexOfAny(new[] { '?', '#' });
        if (cut >= 0) normalized = normalized[..cut];
        normalized = normalized.TrimEnd('/');

        if (IsDestructiveMethod(httpMethod))
        {
            const string hostedPage = "/api/open/web-pages/pages/";
            return !normalized.StartsWith(hostedPage, StringComparison.OrdinalIgnoreCase)
                || normalized[hostedPage.Length..].IndexOfAny(new[] { '/', '\\' }) >= 0;
        }

        // 网关使用已注册的网页托管工具。原生管理 API 在权限中间件中应用站点模块授权。
        if (IsHostedSiteManagementPath(normalized)
            && !string.Equals(httpMethod, "GET", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(httpMethod, "HEAD", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(httpMethod, "OPTIONS", StringComparison.OrdinalIgnoreCase))
            return true;

        var slash = normalized.LastIndexOf('/');
        var last = slash >= 0 ? normalized[(slash + 1)..] : normalized;

        if (IsPublicPublishSegment(last)) return true;

        foreach (var seg in DestructiveLastSegments)
            if (string.Equals(last, seg, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }
}
