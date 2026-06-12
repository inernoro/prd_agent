namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 通用状态机 / 流程流转定义。
///
/// 设计目标：替代 defect-agent 那种"状态流转硬编码在 Controller switch"的反模式。
/// 每类对象（需求 / 功能 / 缺陷 / 版本 / 升级申请）绑定一个 WorkflowDefinition，
/// 实例只存 CurrentState；流转统一走 POST /transition 端点查 Transitions 表校验
/// （from → to、触发动作、允许角色）。
/// </summary>
public class ProductWorkflowDefinition
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>流程名称（如 "标准需求流程"）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>流程描述</summary>
    public string? Description { get; set; }

    /// <summary>适用对象类型，见 ProductEntityType</summary>
    public string EntityType { get; set; } = ProductEntityType.Requirement;

    /// <summary>状态节点列表</summary>
    public List<ProductWorkflowState> States { get; set; } = new();

    /// <summary>状态流转边列表</summary>
    public List<ProductWorkflowTransition> Transitions { get; set; } = new();

    /// <summary>是否为该对象类型的默认流程</summary>
    public bool IsDefault { get; set; }

    /// <summary>所属产品 ID（为空表示全局流程）</summary>
    public string? ProductId { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }

    /// <summary>
    /// 内置种子版本（来自 RequirementWorkflowCatalog / ProductWorkflowDefaults）。
    /// 仅当未用户自定义且 SeedRevision 低于代码版本时，EnsureDefaultWorkflowsSeededAsync 会覆盖状态与流转。
    /// </summary>
    public int SeedRevision { get; set; }

    /// <summary>管理员在「设置 → 流程模板」保存后为 true，禁止种子逻辑再覆盖。</summary>
    public bool IsUserCustomized { get; set; }

    /// <summary>取初始状态 Key（IsInitial 优先，否则取第一个）。</summary>
    public string? GetInitialStateKey()
        => States.FirstOrDefault(s => s.IsInitial)?.Key ?? States.FirstOrDefault()?.Key;
}

/// <summary>状态节点</summary>
public class ProductWorkflowState
{
    /// <summary>状态标识（如 pending / developing / done）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>状态显示名（如 "待评审"）</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>状态说明（配置页展示，帮助团队理解该状态含义）</summary>
    public string? Description { get; set; }

    /// <summary>状态颜色（CSS 颜色，用于标签 / 看板列着色）</summary>
    public string? Color { get; set; }

    /// <summary>是否为初始状态（新建实例的默认状态）</summary>
    public bool IsInitial { get; set; }

    /// <summary>是否为终态（流程结束）</summary>
    public bool IsFinal { get; set; }

    /// <summary>看板分组类别（如 todo / doing / done），用于看板列归并；为空则按 Key 独立成列</summary>
    public string? Category { get; set; }

    /// <summary>排序权重（看板列 / 状态选择器排序）</summary>
    public int SortOrder { get; set; }

    /// <summary>SLA 时效（小时）：对象停留在该状态超过此值即视为超时；为空表示不限。</summary>
    public int? SlaHours { get; set; }

    /// <summary>看板 WIP 上限：该状态列在制数量超过此值即告警；为空表示不限。</summary>
    public int? WipLimit { get; set; }
}

/// <summary>状态流转边（一条可执行的流转动作）</summary>
public class ProductWorkflowTransition
{
    /// <summary>流转标识（如 submit / approve / reject）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>流转动作显示名（如 "提交评审"）</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>源状态 Key（为空表示任意状态都可触发）</summary>
    public string? FromState { get; set; }

    /// <summary>目标状态 Key</summary>
    public string ToState { get; set; } = string.Empty;

    /// <summary>
    /// 允许触发该流转的角色（为空表示不限制）。
    /// 角色语义在 Controller 层解释（owner / member / manager 等）。
    /// </summary>
    public List<string>? AllowedRoles { get; set; }

    /// <summary>是否需要填写流转备注（如驳回原因）</summary>
    public bool RequireComment { get; set; }

    /// <summary>自动化：触发该流转时把处理人自动指派给操作人本人（claim）。</summary>
    public bool AutoAssignToActor { get; set; }

    /// <summary>
    /// 流转前必须已填写的字段 Key（如 title / assigneeId / grade / comment）。
    /// comment 与 RequireComment 等价；为空表示除 RequireComment 外无额外字段要求。
    /// </summary>
    public List<string>? RequiredFieldKeys { get; set; }
}
