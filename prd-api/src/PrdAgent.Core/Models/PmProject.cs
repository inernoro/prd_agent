namespace PrdAgent.Core.Models;

/// <summary>
/// 项目管理 - 项目实体。
///
/// 对齐米多 PMO 方法论：
/// - 项目 = 临时性 + 明确起止/目标/资源/干系人验收的工作
/// - 类型分级：S(战略) / I(创新) / O(运营，含 常规/定向整改/专项督办)
/// - 全生命周期：立项注册 → 进行 → 结案 → 评价(NPSS) → 奖金
/// - 价值导向：成功 = Value > Effort + Expense（NPSS 评价见 PmEvaluation，Phase 2）
/// </summary>
public class PmProject
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>项目编号（如 PM-2026-0001，自动生成）</summary>
    public string ProjectNo { get; set; } = string.Empty;

    /// <summary>项目名称</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>项目描述 / 背景</summary>
    public string? Description { get; set; }

    /// <summary>业务目标（立项必填，AI 拆解任务的依据）</summary>
    public string BusinessGoal { get; set; } = string.Empty;

    /// <summary>项目类型：strategic(S) / innovation(I) / operation(O)</summary>
    public string ProjectType { get; set; } = PmProjectType.Operation;

    /// <summary>
    /// 运营级子类型（仅 ProjectType=operation 时有效）：
    /// routine(常规运营) / rectification(定向整改) / supervision(专项督办)
    /// </summary>
    public string? OperationSubType { get; set; }

    /// <summary>
    /// 生命周期状态：
    /// registered(已立项) / running(进行中) / closing(结案中) / evaluated(已评价) / archived(已归档)
    /// </summary>
    public string Lifecycle { get; set; } = PmProjectLifecycle.Registered;

    /// <summary>项目 Leader 的 UserId（职级约束在 Controller 层校验：S≥L3 / O≥L2）</summary>
    public string LeaderId { get; set; } = string.Empty;

    /// <summary>项目 Leader 名称（冗余，便于展示）</summary>
    public string? LeaderName { get; set; }

    /// <summary>项目成员 UserId 列表</summary>
    public List<string> MemberIds { get; set; } = new();

    /// <summary>战略对齐说明（对齐哪个年度经营计划/战略目标）</summary>
    public string? StrategyAlignment { get; set; }

    /// <summary>计划开始时间</summary>
    public DateTime? PlannedStartAt { get; set; }

    /// <summary>计划结束时间</summary>
    public DateTime? PlannedEndAt { get; set; }

    /// <summary>实际结案时间</summary>
    public DateTime? ClosedAt { get; set; }

    /// <summary>预算金额（预算绑定机制，单位：元）</summary>
    public decimal? Budget { get; set; }

    /// <summary>实际成本（结案时填写，单位：元）</summary>
    public decimal? ActualCost { get; set; }

    /// <summary>立项方案文档（关联 Attachment / 文本，可选）</summary>
    public string? ProposalRef { get; set; }

    /// <summary>项目计划文档引用（可选）</summary>
    public string? PlanRef { get; set; }

    /// <summary>项目总结文档引用（结案时关联）</summary>
    public string? SummaryRef { get; set; }

    /// <summary>所属者（创建人）UserId</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>任务总数（反规范化缓存）</summary>
    public int TaskCount { get; set; }

    /// <summary>已完成任务数（反规范化缓存）</summary>
    public int DoneTaskCount { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}

/// <summary>项目类型常量</summary>
public static class PmProjectType
{
    /// <summary>战略级项目（S）</summary>
    public const string Strategic = "strategic";
    /// <summary>创新级项目（I）</summary>
    public const string Innovation = "innovation";
    /// <summary>运营级项目（O）</summary>
    public const string Operation = "operation";

    public static readonly string[] All = { Strategic, Innovation, Operation };
}

/// <summary>运营级项目子类型常量</summary>
public static class PmOperationSubType
{
    /// <summary>常规运营项目</summary>
    public const string Routine = "routine";
    /// <summary>定向整改项目</summary>
    public const string Rectification = "rectification";
    /// <summary>专项督办项目</summary>
    public const string Supervision = "supervision";

    public static readonly string[] All = { Routine, Rectification, Supervision };
}

/// <summary>项目生命周期状态常量</summary>
public static class PmProjectLifecycle
{
    public const string Registered = "registered";
    public const string Running = "running";
    public const string Closing = "closing";
    public const string Evaluated = "evaluated";
    public const string Archived = "archived";

    public static readonly string[] All = { Registered, Running, Closing, Evaluated, Archived };
}
