using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Filters;

/// <summary>
/// MAP 侧模型管理写接口退场闸（全局挂载）。
///
/// 2026-08-25：上游 Provider、模型、模型池、AppCaller 绑定统一由 LLM Gateway 控制台维护。
/// MAP 的 <c>api/mds</c> 只剩读能力（实验台挑模型、视觉创作读适配器信息等），
/// 所有写操作一律 410 Gone，并在响应里指路。
///
/// 为什么用一道闸而不是逐个删 42 个 action：
/// 1. 逐个删是一次性动作，挡不住下一个人再加一个写端点——闸是**结构性**的，
///    新加的写端点默认就被挡住（predicate-and-wiring-discipline 形状 2：
///    删掉之后不会红的约束，必须换成会红的守卫）；
/// 2. 读路径必须原样活着（LlmGateway/ModelResolver 仍从 llmplatforms / llmmodels /
///    model_groups 兜底解析），逐个删容易误伤。
///
/// 判据取的是**路由模板**而不是原始 path：模板是归一化的（<c>api/mds/platforms/{id}</c>），
/// 不受实际 id 长相影响，也不会被大小写、尾斜杠、query 串绕开
///（形状 1：语义相同、写法不同的输入不能让判据翻转）。
/// </summary>
public sealed class MdsWriteRetiredFilter : IActionFilter
{
    /// <summary>网关控制台的说明位置。真实入口由服务端 SSO 票据下发，这里只给一句话指路。</summary>
    private const string Guidance =
        "MAP 的模型管理已下线，上游、模型、模型池请到 LLM Gateway 控制台配置（MAP 左下角「模型网关」进入）。";

    /// <summary>
    /// 非 GET 但语义是「读 / 探测」、且仍有存活调用方的端点。
    /// 每加一条都必须能说清「它不写任何配置」，否则不许进这张表。
    /// </summary>
    private static readonly HashSet<string> ReadOnlyProbes = new(StringComparer.OrdinalIgnoreCase)
    {
        // 批量读取模型适配器信息，纯查询（POST 只是为了带模型 id 列表，不写任何配置）。
        // 澄清：视觉创作走的是 /api/visual-agent/image-gen/adapter-info，不是这条；
        // 这条目前前端无活消费方，留着是因为它语义是读——不该用 410 去挡一个读接口。
        "POST api/mds/adapter-info/batch",
        // 从上游重新拉取模型清单：只清/写本地缓存，不改 llmplatforms / llmmodels
        "POST api/mds/platforms/{id}/refresh-models",
    };

    /// <summary>
    /// 运维专用豁免：**确实是写**，但没有 UI 入口，只有带管理员 token 的运维脚本会打。
    /// 现在只有一条 —— `scripts/llmgw-prod-asr-credential-rotate.py` 轮换豆包 ASR 中继密钥时
    /// 走 `PUT api/mds/exchanges/{id}`。把它一起挡掉会直接打断线上凭据轮换链路
    ///（production-release-safety：别在不了解发布链路时顺手掐一条）。
    ///
    /// 这条是**已知债务**，不是设计：中继配置最终也应搬到 LLM Gateway 控制台，
    /// 届时连同该脚本一起迁走并删掉这张表。新增任何一条豁免都必须同时说明
    /// 「谁在打它、为什么不能走网关」，否则不许加。
    /// </summary>
    private static readonly HashSet<string> OpsOnlyWrites = new(StringComparer.OrdinalIgnoreCase)
    {
        "PUT api/mds/exchanges/{id}",
    };

    /// <summary>
    /// 是不是 mds 这个模块的路由。
    ///
    /// 必须**按段**判定，不能裸 StartsWith("api/mds")——那样 <c>api/mdsomething-else</c>
    /// 也会被误当成 mds 端点连带挡掉（形状 1：语义不同、写法相近的输入让判据翻转）。
    /// 前后斜杠都先削掉，避免 <c>/api/mds/</c> 这种写法漏判。
    /// </summary>
    private static bool IsMdsRoute(string normalizedTemplate)
        => normalizedTemplate.Equals("api/mds", StringComparison.OrdinalIgnoreCase)
        || normalizedTemplate.StartsWith("api/mds/", StringComparison.OrdinalIgnoreCase);

    public void OnActionExecuting(ActionExecutingContext context)
    {
        var template = context.ActionDescriptor.AttributeRouteInfo?.Template;
        if (string.IsNullOrWhiteSpace(template)) return;
        // 归一化一次，判据和白名单查表用同一个取值口径（形状 6：别一处取原值一处取归一值）
        var normalized = template.Trim().Trim('/');
        if (!IsMdsRoute(normalized)) return;

        var method = context.HttpContext.Request.Method;
        if (HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method)) return;
        var key = $"{method} {normalized}";
        if (ReadOnlyProbes.Contains(key) || OpsOnlyWrites.Contains(key)) return;

        context.Result = new ObjectResult(
            ApiResponse<object>.Fail("MDS_WRITE_RETIRED", Guidance))
        {
            StatusCode = StatusCodes.Status410Gone,
        };
    }

    public void OnActionExecuted(ActionExecutedContext context)
    {
        // 无后置逻辑：拦截发生在 executing 阶段。
    }
}
