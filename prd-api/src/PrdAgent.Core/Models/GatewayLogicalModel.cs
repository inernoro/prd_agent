using MongoDB.Bson.Serialization.Attributes;
using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 面向调用方公开的逻辑模型。调用方只选择 PublicId，不感知具体 Provider、Endpoint 或凭据。
/// </summary>
[AppOwnership(AppNames.Llm, AppNames.LlmDisplay, IsPrimary = true)]
[BsonIgnoreExtraElements]
public sealed class GatewayLogicalModel
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string PublicId { get; set; } = string.Empty;
    public string PublicIdNormalized { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string ModelType { get; set; } = string.Empty;
    public List<string> Capabilities { get; set; } = new();
    public List<string> AllowedAppCallerCodes { get; set; } = new();
    public string RoutingStrategy { get; set; } = "priority";
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// 这个用途没点名模型时用它。
    ///
    /// 字段名与模型池的 <c>ModelGroup.IsDefaultForType</c> 刻意一模一样：那正是池与本类型
    /// 逐字段对照后唯一的真差别，补上它之后「模型池」就不再是另一种东西，只是这一行多了个标记。
    ///
    /// 同一租户同一 <see cref="ModelType"/> 最多一个默认。这个不变量由写入侧保证——
    /// 唯一索引做不到，因为 false 与字段缺失都算「不是默认」，Mongo 的部分索引要按
    /// 布尔值过滤才行，而存量文档压根没有这个字段。写入侧先清同用途旧默认再置新的，
    /// 顺序反过来会出现一瞬间两个默认，恰好落在那一瞬的请求会解析到哪个全看运气。
    /// </summary>
    public bool IsDefaultForType { get; set; }

    /// <summary>
    /// 「对这些调用方而言，我是默认」——不点名时优先于 <see cref="IsDefaultForType"/>。
    ///
    /// 为什么必须有这一条：<see cref="IsDefaultForType"/> 是**按用途**的默认，一个用途只有一个。
    /// 而模型池契约提供的是**按调用方**的默认（这个调用方不点名时用它自己那个池）。
    /// 少了这一层，把最后一个走池的调用方切过来时它会掉到全局默认上——换了模型，
    /// 那不是断流是换药。2026-09-15 盘点线上数据时才看出这个缺口。
    ///
    /// 与 <see cref="AllowedAppCallerCodes"/> 刻意分开两个字段：授权回答「能不能点名我」，
    /// 这个回答「不点名时是不是我」。挤进一个字段的话，想给某人当默认就必须同时把别人挡在外面。
    ///
    /// 同一租户同一用途下，一个调用方最多被一个模型认领；这个不变量由写入侧保证。
    /// </summary>
    public List<string> DefaultForAppCallerCodes { get; set; } = new();

    /// <summary>
    /// 这个模型是从哪几个模型池搬过来的（池文档 _id）。
    ///
    /// 为什么必须记下来：`model_policy=pool` 这条对外契约还活着——serving 收到它时会把
    /// `model_pool_id` 塞进 expectedModel 往下传（系统设置里的连通性测试就走这条路）。
    /// 而客户端与设置里存的是**池文档 ID**，不是搬迁后对外模型的 PublicId。
    /// 点名解析只按 PublicId 查的话，这些请求一律查不到，又因为 expectedModel 非空而跳过
    /// 默认那一支，配置权威的租户直接拿到 MODEL_NOT_FOUND——池退场把它们整条打断了。
    ///
    /// 记下来源之后，那些请求仍然落到同一个上游：池 ID 就是这个模型的一个别名。
    /// 这不是永久契约，是搬迁期的桥；等所有生产方都改用 PublicId 之后可以连同
    /// `model_policy=pool` 一起退场。
    /// </summary>
    public List<string> MigratedFromPoolIds { get; set; } = new();

    public int DisplayOrder { get; set; } = 100;
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 逻辑模型的一条上游供给。TargetKind=model 时 TargetId 指向 llmgw_models；
/// TargetKind=exchange 时 TargetId 指向 llmgw_model_exchanges。
/// </summary>
[AppOwnership(AppNames.Llm, AppNames.LlmDisplay, IsPrimary = true)]
[BsonIgnoreExtraElements]
public sealed class GatewayModelOffering
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string LogicalModelId { get; set; } = string.Empty;
    public string TargetKind { get; set; } = "model";
    public string TargetId { get; set; } = string.Empty;
    public string? UpstreamModelId { get; set; }
    public string? Protocol { get; set; }
    public string? EndpointPath { get; set; }
    public int Priority { get; set; } = 100;
    public int Weight { get; set; } = 100;
    public bool Enabled { get; set; } = true;
    public ModelHealthStatus HealthStatus { get; set; } = ModelHealthStatus.Healthy;
    public DateTime? LastFailedAt { get; set; }
    public DateTime? LastSuccessAt { get; set; }
    public int ConsecutiveFailures { get; set; }
    public int ConsecutiveSuccesses { get; set; }

    /// <summary>
    /// 自动半开验证租约截止时间。与模型池成员同义：租约期间只有拿到租约的那个请求能把
    /// 不可用 Offering 当候选，避免冷却结束后并发流量一起冲刚回血的上游。
    ///
    /// 补这个字段之前，Offering 被标为不可用后是**永远不会自己回来**的——所有候选查询都
    /// 无条件 `Ne(HealthStatus, Unavailable)`，摘掉之后它再也拿不到一次成功来翻身，只能等
    /// 有人去控制台改一次密钥。一个模型挂多条上游本该更稳，那样反而是线路越多、熄灭得越多。
    /// </summary>
    public DateTime? HalfOpenLeaseUntil { get; set; }

    /// <summary>
    /// 人工请求进入半开验证的时间。Offering 仍保持不可用，必须先拿到半开租约才会被试探，
    /// 防止控制台上点一下「恢复」就把并发流量直接放回刚恢复的上游。
    /// </summary>
    public DateTime? ManualRecoveryAt { get; set; }

    public int? MaxConcurrency { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public string? Notes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
