namespace PrdAgent.Core.Models;

/// <summary>
/// 项目管理 - 项目实体。
///
/// 通用项目管理方法论：
/// - 项目 = 临时性 + 明确起止/目标/资源/干系人验收的工作
/// - 类型分级：普通(General，默认) / 战略(S) / 创新(I) / 运营(O，含 常规/定向整改/专项督办)
/// - 全生命周期：立项注册 → 进行 → 结案 → 评价(NPSS) → 奖金
/// - 价值导向：成功 = Value > Effort + Expense（NPSS 评价见 PmEvaluation）
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

    /// <summary>项目类型：general(普通,默认) / strategic(S) / innovation(I) / operation(O)</summary>
    public string ProjectType { get; set; } = PmProjectType.General;

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

    /// <summary>项目成员 UserId 列表（参与项目执行/日常事务的人）</summary>
    public List<string> MemberIds { get; set; } = new();

    /// <summary>
    /// 项目观察者 UserId 列表（拥有与成员一样的访问权限，但主要是看，一般不参与日常事务）。
    /// 与 MemberIds 互斥（同一人不能既是成员又是观察者）；与 Stakeholders 可重叠（观察者可同时是干系人）。
    /// </summary>
    public List<string> ObserverIds { get; set; } = new();

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

    /// <summary>项目价值系数（奖金计算用，基准值 1，由 PMO 调整）</summary>
    public double ValueCoefficient { get; set; } = 1.0;

    /// <summary>立项方案文档（关联 Attachment / 文本，可选）</summary>
    public string? ProposalRef { get; set; }

    /// <summary>项目计划文档引用（可选）</summary>
    public string? PlanRef { get; set; }

    /// <summary>项目总结文档引用（结案时关联）</summary>
    public string? SummaryRef { get; set; }

    /// <summary>所属者（创建人）UserId</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>项目知识库绑定的 DocumentStore ID（首次进入「知识库」tab 时 find-or-create）</summary>
    public string? KnowledgeStoreId { get; set; }

    /// <summary>任务总数（反规范化缓存）</summary>
    public int TaskCount { get; set; }

    /// <summary>已完成任务数（反规范化缓存）</summary>
    public int DoneTaskCount { get; set; }

    // ── Phase 2: 干系人 + NPSS 评价 ──

    /// <summary>项目干系人列表（权力利益矩阵 + 加权打分载体）</summary>
    public List<PmStakeholder> Stakeholders { get; set; } = new();

    /// <summary>结案评价（NPSS）最终结果，未评价时为 null</summary>
    public PmEvaluation? Evaluation { get; set; }

    /// <summary>当前/最近一轮结案评价（多人独立打分 → 汇总），未发起时为 null</summary>
    public PmEvaluationRound? EvaluationRound { get; set; }

    // ── Phase 4: 优秀项目评选 ──

    /// <summary>是否被评选为优秀项目（PMO 年度评选）</summary>
    public bool IsExcellent { get; set; }

    /// <summary>优秀项目评选时间</summary>
    public DateTime? ExcellenceAwardedAt { get; set; }

    /// <summary>看板 WIP 限制（status → 在制上限），未设置的列不限制</summary>
    public Dictionary<string, int> WipLimits { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}

/// <summary>
/// 项目干系人 — 权力利益矩阵分类 + NPSS 加权打分载体。
/// </summary>
public class PmStakeholder
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>干系人名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>关联系统用户 ID（必填，干系人一律为 MAP 用户）</summary>
    public string? UserId { get; set; }

    /// <summary>[已废弃] 旧版"外部手填"标记，保留仅为兼容旧数据反序列化</summary>
    [Obsolete("外部干系人改为：选一位 MAP 用户作代表 + 备注，见 IsRepresentative/Note")]
    public bool IsExternal { get; set; }

    /// <summary>是否为外部方代表（该用户代表外部客户/单位参与与打分）</summary>
    public bool IsRepresentative { get; set; }

    /// <summary>备注（作代表时必填，说明代表谁/职责）</summary>
    public string? Note { get; set; }

    /// <summary>角色（决定打分权重）：beneficiary(客户/业务方) / management(管理层) / team(项目团队) / other(其他)</summary>
    public string Role { get; set; } = PmStakeholderRole.Other;

    /// <summary>权力高低：high / low（权力利益矩阵横轴）</summary>
    public string Power { get; set; } = PmStakeholderAxis.Low;

    /// <summary>利益高低：high / low（权力利益矩阵纵轴）</summary>
    public string Interest { get; set; } = PmStakeholderAxis.Low;

    /// <summary>[已废弃] 旧版单人评分流程的打分字段，仅为兼容旧数据反序列化保留，不再使用</summary>
    [Obsolete("评分已迁移至 PmEvaluationRound.Participants")]
    public int? Score { get; set; }
}

/// <summary>
/// 结案评价一轮 — 多人独立打分 → 系统汇总。
/// 由立项人/Leader 发起，各干系人各自打分（互相不可见），全部完成后汇总出 NPSS。
/// </summary>
public class PmEvaluationRound
{
    /// <summary>状态：collecting(收集中) / finalized(已汇总)</summary>
    public string Status { get; set; } = PmEvaluationRoundStatus.Collecting;

    public string InitiatedBy { get; set; } = string.Empty;
    public string? InitiatedByName { get; set; }
    public DateTime InitiatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? FinalizedAt { get; set; }

    /// <summary>参评人（发起时按干系人快照生成）</summary>
    public List<PmEvaluationParticipant> Participants { get; set; } = new();

    /// <summary>汇总结果（finalized 后填充）</summary>
    public PmEvaluation? Result { get; set; }
}

/// <summary>一轮评价中的单个参评人 + 其打分</summary>
public class PmEvaluationParticipant
{
    /// <summary>对应干系人 Id（快照）</summary>
    public string StakeholderId { get; set; } = string.Empty;
    public string? UserId { get; set; }
    public string Name { get; set; } = string.Empty;
    /// <summary>[已废弃] 兼容旧字段</summary>
    [Obsolete] public bool IsExternal { get; set; }
    public bool IsRepresentative { get; set; }
    public string? Note { get; set; }
    public string Role { get; set; } = PmStakeholderRole.Other;

    /// <summary>打分（0-10），未打分为 null</summary>
    public int? Score { get; set; }
    public DateTime? ScoredAt { get; set; }
    /// <summary>实际录入人（内部=本人 UserId；外部=立项人 UserId）</summary>
    public string? ScoredBy { get; set; }
}

/// <summary>评价轮状态常量</summary>
public static class PmEvaluationRoundStatus
{
    public const string Collecting = "collecting";
    public const string Finalized = "finalized";
}

/// <summary>
/// 项目结案评价（NPSS）。
/// 满意度 = 干系人加权打分（受益方权重为其他 2 倍），等级据此判定。
/// </summary>
public class PmEvaluation
{
    /// <summary>干系人满意度得分（0-100，加权后 ×10）</summary>
    public double SatisfactionScore { get; set; }

    /// <summary>项目等级：success(成功 9-10) / mediocre(平庸 7-8) / fail(失败 0-6)</summary>
    public string Grade { get; set; } = PmEvaluationGrade.Fail;

    /// <summary>各角色组加权明细（角色 → 该组平均分 0-10）</summary>
    public Dictionary<string, double> RoleAverages { get; set; } = new();

    public DateTime EvaluatedAt { get; set; } = DateTime.UtcNow;
    public string EvaluatedBy { get; set; } = string.Empty;
}

/// <summary>干系人角色常量（决定打分权重）</summary>
public static class PmStakeholderRole
{
    /// <summary>受益方：客户 / 业务方（权重为其他 2 倍，默认占 50%）</summary>
    public const string Beneficiary = "beneficiary";
    /// <summary>管理层（默认占 20%）</summary>
    public const string Management = "management";
    /// <summary>项目团队（默认占 20%）</summary>
    public const string Team = "team";
    /// <summary>其他干系人（默认占 10%）</summary>
    public const string Other = "other";

    public static readonly string[] All = { Beneficiary, Management, Team, Other };

    /// <summary>
    /// 角色基准权重（受益方为其他 2 倍）。实际计算时按"在场角色组"重归一化。
    /// </summary>
    public static readonly Dictionary<string, double> BaseWeights = new()
    {
        [Beneficiary] = 0.5,
        [Management] = 0.2,
        [Team] = 0.2,
        [Other] = 0.1,
    };
}

/// <summary>权力 / 利益高低轴常量（权力利益矩阵）</summary>
public static class PmStakeholderAxis
{
    public const string High = "high";
    public const string Low = "low";
}

/// <summary>NPSS 项目等级常量</summary>
public static class PmEvaluationGrade
{
    /// <summary>成功项目（满意度 9-10 分）</summary>
    public const string Success = "success";
    /// <summary>平庸项目（满意度 7-8 分）</summary>
    public const string Mediocre = "mediocre";
    /// <summary>失败项目（满意度 0-6 分）</summary>
    public const string Fail = "fail";

    /// <summary>根据 0-10 满意度判定等级</summary>
    public static string FromScore10(double score10)
        => score10 >= 9 ? Success : score10 >= 7 ? Mediocre : Fail;
}

/// <summary>项目类型常量</summary>
public static class PmProjectType
{
    /// <summary>普通项目（默认，不分级的通用项目）</summary>
    public const string General = "general";
    /// <summary>战略级项目（S）</summary>
    public const string Strategic = "strategic";
    /// <summary>创新级项目（I）</summary>
    public const string Innovation = "innovation";
    /// <summary>运营级项目（O）</summary>
    public const string Operation = "operation";

    public static readonly string[] All = { General, Strategic, Innovation, Operation };
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
