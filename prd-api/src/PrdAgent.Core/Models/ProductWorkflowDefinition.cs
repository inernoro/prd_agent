namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 通用状态机 / 流程流转定义（参考 TAPD）。
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
}
