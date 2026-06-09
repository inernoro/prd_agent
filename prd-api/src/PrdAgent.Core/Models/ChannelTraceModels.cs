using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 商品溯源智能体（appKey: channel-trace-agent）
///
/// 面向「防窜物流」领域的内部研发辅助智能体，三大能力各对应一类实体：
///   1. 业务知识库（ChannelTraceKnowledge）—— 沉淀防窜物流业务知识，供知识问答检索
///   2. 线上问题案例（ChannelTraceCase）—— 记录常见线上问题 + 排查路径，供相似案例召回
///   3. 代码差异对比（ChannelTraceDiff）—— 业务规则描述 vs 当前代码实现的差异分析报告
/// </summary>
[BsonIgnoreExtraElements]
public class ChannelTraceKnowledge
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>知识条目标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>知识正文（Markdown）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>分类标签（如 上码 / 关联 / 解绑 / 窜货判定 / 物流轨迹）</summary>
    public List<string> Tags { get; set; } = new();

    public string CreatedBy { get; set; } = string.Empty;
    public string CreatedByName { get; set; } = string.Empty;
    public string? UpdatedBy { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 线上问题案例：现象 + 根因 + 排查步骤，作为后续相似问题快速排查的知识沉淀。
/// </summary>
[BsonIgnoreExtraElements]
public class ChannelTraceCase
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>案例标题（一句话概括问题）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>问题现象（用户/线上观测到的表现）</summary>
    public string Symptom { get; set; } = string.Empty;

    /// <summary>根因分析</summary>
    public string? RootCause { get; set; }

    /// <summary>排查步骤 / 解决方案（Markdown）</summary>
    public string? Resolution { get; set; }

    /// <summary>分类标签（如 上码失败 / 关联错乱 / 轨迹缺失 / 窜货误判）</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>严重程度：low / medium / high</summary>
    public string Severity { get; set; } = ChannelTraceCaseSeverities.Medium;

    public string CreatedBy { get; set; } = string.Empty;
    public string CreatedByName { get; set; } = string.Empty;
    public string? UpdatedBy { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 代码差异对比报告：把「防窜物流业务规则描述」与「当前代码实现」交给 AI 比对，
/// 输出两者的差异清单（已实现 / 未实现 / 实现有偏差 / 代码多做）。
/// </summary>
[BsonIgnoreExtraElements]
public class ChannelTraceDiff
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>对比任务标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>业务规则描述（期望行为）</summary>
    public string BusinessRule { get; set; } = string.Empty;

    /// <summary>当前代码实现（粘贴的代码片段 / 逻辑描述）</summary>
    public string CodeContent { get; set; } = string.Empty;

    /// <summary>可选：代码位置标注（仓库 / 文件 / 函数），仅用于报告展示</summary>
    public string? CodeLocation { get; set; }

    /// <summary>AI 生成的差异报告（Markdown 全文）</summary>
    public string? DiffReport { get; set; }

    /// <summary>状态：Queued / Running / Done / Error</summary>
    public string Status { get; set; } = ChannelTraceDiffStatuses.Queued;

    public string? ErrorMessage { get; set; }

    /// <summary>本次 AI 调用使用的模型（AI 模型可见性原则）</summary>
    public string? Model { get; set; }
    public string? ModelPlatform { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public string CreatedByName { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
}

public static class ChannelTraceCaseSeverities
{
    public const string Low = "low";
    public const string Medium = "medium";
    public const string High = "high";
}

public static class ChannelTraceDiffStatuses
{
    public const string Queued = "Queued";
    public const string Running = "Running";
    public const string Done = "Done";
    public const string Error = "Error";
}
