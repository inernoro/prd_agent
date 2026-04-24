namespace PrdAgent.Core.Models;

/// <summary>
/// Agent 开放接口登记项。
///
/// 这是 P3「全局 Agent 开放接口基础设施」的根数据结构。
/// 每个 Agent 想暴露 HTTP 接口给外部 AI 调用时，在这里登记一条记录：
/// - 声明接口在哪（Path）、需要什么 scope、调用方样例
/// - 运行时由 AgentApiKey 鉴权 + RequireScope 过滤
/// - 登记后会在 marketplace_skills 自动落一条 `referenceType=open-api-reference` 的
///   技能条目（后续任务实现，本条只先扎根模型），让使用者在海鲜市场搜到就能用
///
/// 权限设计参考 CDS：
/// - 正向：登记时声明 required scope（如 `agent.report-agent:call`），
///   调用方在创建 AgentApiKey 时勾选对应 scope 才能访问
/// - 反向：Agent 作者可以加白名单 `AllowedCallerUserIds`，只放行特定调用方
///
/// 谁能登记：目前仅平台管理员（AdminPermission 守卫）。
/// 未来可放开到 Agent 作者本人，由他们自己登记（对应需求 #4「自助权限」）。
/// </summary>
public class AgentOpenEndpoint
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 绑定的 Agent Key（和 prd-admin/src/stores/toolboxStore.ts 的 agentKey 对齐），
    /// 例如 `report-agent` / `defect-agent` / 用户自建 Agent 的 id
    /// </summary>
    public string AgentKey { get; set; } = string.Empty;

    /// <summary>展示名（UI 上的 "Agent 开放接口名称"）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>30~120 字，描述这个接口做什么、AI 调用的典型场景</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>
    /// HTTP 方法（GET / POST / PATCH / PUT / DELETE）。当前同一 Endpoint 只支持一个方法，
    /// 需要多方法请登记多条记录（更直观、权限更清晰）
    /// </summary>
    public string HttpMethod { get; set; } = "POST";

    /// <summary>
    /// 绝对路径（必须以 `/` 开头），如 `/api/report/weekly/generate`。
    /// 由调用方拼到 PrdAgent 的 base URL 后发起请求。
    /// </summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>
    /// 此接口要求的 scope（调用方的 AgentApiKey 必须包含其一），
    /// 规范：`agent.{agentKey}:call`（Agent 级 M2M 权限），也可以自定义更细粒度的
    /// 资源访问权限，如 `agent.report-agent:publish`
    /// </summary>
    public List<string> RequiredScopes { get; set; } = new();

    /// <summary>
    /// 反向白名单 —— 非空时只允许 OwnerUserId 在此列表的 AgentApiKey 调用；
    /// 空列表代表"公开给所有持 scope 的 key"。
    /// </summary>
    public List<string> AllowedCallerUserIds { get; set; } = new();

    /// <summary>
    /// 接口入参示例（JSON 字符串），前端"调用方代码样本"会拿它渲染 curl / TS / Python。
    /// 不做结构校验，Agent 作者自行填写。
    /// </summary>
    public string? RequestExampleJson { get; set; }

    /// <summary>
    /// 接口返回示例（JSON 字符串），用于文档展示。
    /// </summary>
    public string? ResponseExampleJson { get; set; }

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>
    /// 登记者（通常是平台管理员的 userId）。仅用于审计，和 AllowedCallerUserIds 没有关系。
    /// </summary>
    public string RegisteredBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 若已经自动桥接出对应的 MarketplaceSkill 引用条目，此处记录其 Id。
    /// 让 Endpoint 停用 / 删除时能顺手清掉镜像的技能条目。
    /// </summary>
    public string? LinkedMarketplaceSkillId { get; set; }
}
