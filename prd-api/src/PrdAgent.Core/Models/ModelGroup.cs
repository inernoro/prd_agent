using PrdAgent.Core.Attributes;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 模型分组 - 按模型类型组织的模型列表
/// </summary>
[AppOwnership(AppNames.Llm, AppNames.LlmDisplay, IsPrimary = true)]
[BsonIgnoreExtraElements]
public class ModelGroup
{
    /// <summary>分组ID（UUID，唯一标识）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>分组名称（如：默认对话分组、快速意图分组）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>对外暴露的模型名字（允许重复，用于匹配调用方期望的模型）</summary>
    public string Code { get; set; } = string.Empty;

    /// <summary>优先级（数字越小优先级越高，默认50）</summary>
    public int Priority { get; set; } = 50;

    /// <summary>模型类型（chat/intent/vision/image-gen等）</summary>
    public string ModelType { get; set; } = string.Empty;

    /// <summary>是否为该类型的默认分组</summary>
    public bool IsDefaultForType { get; set; } = false;

    /// <summary>分组中的模型列表（按优先级排序）</summary>
    public List<ModelGroupItem> Models { get; set; } = new();

    /// <summary>
    /// 调度策略类型
    /// 0=FailFast(默认), 1=Race(演示型), 2=Sequential(顺序型),
    /// 3=RoundRobin(轮询型), 4=WeightedRandom(加权随机), 5=LeastLatency(最低延迟)
    /// </summary>
    public int StrategyType { get; set; } = 0;

    /// <summary>分组描述</summary>
    public string? Description { get; set; }

    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 分组中的模型项
/// </summary>
public class ModelGroupItem
{
    /// <summary>模型ID</summary>
    public string ModelId { get; set; } = string.Empty;
    
    /// <summary>平台ID</summary>
    public string PlatformId { get; set; } = string.Empty;
    
    /// <summary>组内优先级（越小越优先，从1开始）</summary>
    public int Priority { get; set; } = 1;

    /// <summary>
    /// 调用协议 (可选，覆盖模型级 Protocol)
    /// - null 表示沿用模型级 Protocol，再沿用平台 PlatformType（向后兼容，存量数据均为 null）
    /// - 解析优先级：池条目 Protocol > 模型 Protocol > 平台 PlatformType
    /// </summary>
    public string? Protocol { get; set; }
    
    /// <summary>健康状态</summary>
    public ModelHealthStatus HealthStatus { get; set; } = ModelHealthStatus.Healthy;
    
    /// <summary>最后失败时间</summary>
    public DateTime? LastFailedAt { get; set; }
    
    /// <summary>最后成功时间</summary>
    public DateTime? LastSuccessAt { get; set; }
    
    /// <summary>连续失败次数</summary>
    public int ConsecutiveFailures { get; set; } = 0;
    
    /// <summary>连续成功次数（用于恢复判断）</summary>
    public int ConsecutiveSuccesses { get; set; } = 0;

    /// <summary>
    /// 自动半开验证租约截止时间。租约期间只有获得租约的请求可把不可用成员作为末位候选，
    /// 避免冷却结束后并发流量同时冲击刚恢复的上游。
    /// </summary>
    public DateTime? HalfOpenLeaseUntil { get; set; }

    /// <summary>
    /// 人工请求进入半开验证的时间。成员仍保持不可用，必须先获得半开租约，
    /// 防止控制台恢复动作把并发流量直接放回刚恢复的上游。
    /// </summary>
    public DateTime? ManualRecoveryAt { get; set; }

    /// <summary>
    /// 是否启用 Prompt Cache（模型池项级开关）
    /// - null: 使用全局配置（默认行为）
    /// - true: 强制启用
    /// - false: 强制禁用
    /// </summary>
    public bool? EnablePromptCache { get; set; }

    /// <summary>
    /// 最大输出 Token 数（透传到大模型请求的 max_tokens）
    /// - null: 使用服务端默认值（当前为 4096）
    /// </summary>
    public int? MaxTokens { get; set; }

    /// <summary>是否为主对话模型（保存池成员时从模型配置复制的能力快照）</summary>
    public bool IsMain { get; set; } = false;

    /// <summary>是否为意图模型（保存池成员时从模型配置复制的能力快照）</summary>
    public bool IsIntent { get; set; } = false;

    /// <summary>是否为视觉模型（保存池成员时从模型配置复制的能力快照）</summary>
    public bool IsVision { get; set; } = false;

    /// <summary>是否为生图模型（保存池成员时从模型配置复制的能力快照）</summary>
    public bool IsImageGen { get; set; } = false;

    /// <summary>
    /// 模型能力快照。GW 控制台保存池成员时从 LLMModel.Capabilities 复制，
    /// 供 router 做能力门与日志解释；旧数据为空时保持 best-effort。
    /// </summary>
    public List<LLMModelCapability>? Capabilities { get; set; }

    /// <summary>
    /// 输入 Token 单价（USD/百万 Token）
    /// - null: 未配置，这条模型的调用不计成本，并计入缺价统计
    /// </summary>
    public decimal? InputPricePerMillion { get; set; }

    /// <summary>
    /// 输出 Token 单价（USD/百万 Token）
    /// - null: 未配置，这条模型的调用不计成本，并计入缺价统计
    /// </summary>
    public decimal? OutputPricePerMillion { get; set; }

    /// <summary>
    /// 缓存命中的输入 Token 单价（USD/百万 Token）。
    ///
    /// null 不代表免费，代表「没配」：计价时这部分按 <see cref="InputPricePerMillion"/> 全价算。
    /// 宁可高估也不低估——低估的成本会让限额失效，而限额正是这套计价存在的理由。
    /// </summary>
    public decimal? CachedInputPricePerMillion { get; set; }

    /// <summary>
    /// 写入缓存的输入 Token 单价（USD/百万 Token），Anthropic 一类按溢价收费的协议才用得上。
    /// null 同样按全价算，理由同上。
    /// </summary>
    public decimal? CacheWritePricePerMillion { get; set; }

    /// <summary>
    /// 每次调用固定费用（USD/次），适用于图片生成等按次计费的模型
    /// - null: 不按次计费
    /// </summary>
    public decimal? PricePerCall { get; set; }

    /// <summary>
    /// 价格币种。计价口径统一为 USD：新写入一律 "USD"。
    ///
    /// 存量可能是 CNY 或 null（历史上 null 按 CNY 解释）。这类价格**不会**被当成 USD 记账——
    /// 那会把成本低估一个数量级、把限额打穿。它们在计价时判为 stale_currency，
    /// 计入缺价统计并在控制台要求先换算再启用。
    /// </summary>
    public string? PriceCurrency { get; set; }

    /// <summary>
    /// 这份价格是从哪来的：<c>upstream</c>（上游清单返回）/ <c>admin</c>（人工录入）/
    /// <c>migrated</c>（由历史 CNY 价换算而来）。
    ///
    /// 必填不是形式主义：没有来源的价格没法判断该不该信，而「看起来是真的、其实早就过时」的价格
    /// 比没有价格更危险——成本报表照算，没人会去核对。
    /// </summary>
    public string? PriceSource { get; set; }

    /// <summary>这份价格是什么时候观测到的。超过复核期（30 天）在控制台标为陈旧。</summary>
    public DateTime? PriceObservedAt { get; set; }

    /// <summary>最后一次改动价格的人，便于追溯到具体那次操作。</summary>
    public string? PriceUpdatedBy { get; set; }
}

/// <summary>
/// 模型健康状态
/// </summary>
public enum ModelHealthStatus
{
    /// <summary>健康</summary>
    Healthy = 0,
    
    /// <summary>降权（仍可用但优先级降低）</summary>
    Degraded = 1,
    
    /// <summary>不可用（暂时跳过）</summary>
    Unavailable = 2
}
