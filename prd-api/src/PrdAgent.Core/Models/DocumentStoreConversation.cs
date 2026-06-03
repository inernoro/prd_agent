namespace PrdAgent.Core.Models;

/// <summary>
/// 知识库「智能体」(原再加工) 抽屉的 direct-chat 对话持久化。
///
/// 设计动机（2026-06-03）：抽屉的 direct-chat 不落 Run（见 DocumentStoreController），
/// 历史上只存 sessionStorage —— 关浏览器标签页/窗口即被清空（"全都清空了"）。本集合把
/// 对话提升为后端持久化，关窗/换设备都不丢。
///
/// 为什么不复用 DocumentStoreAgentRun：那是 Run/Worker 任务实体，按 CreatedAt 取"最近一条"
/// 会让旧 worker run 反复污染新会话（历史 Bugbot 十四轮）。本集合按 (UserId, SourceEntryId)
/// 唯一一条、覆盖式 upsert，彻底规避"哪个 run 才是当前会话"的歧义。
///
/// 后端只做"哑的持久化桶"：messages / pendingImages 都以前端拥有的形状存为 JSON 字符串，
/// 后端不解析、不镜像前端 ChatMessage 的复杂结构（artifacts / invoker / outboundActions 等
/// 随 blob 一起带走），避免前后端 UI 模型耦合漂移。
/// </summary>
public class DocumentStoreConversation
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>归属用户（与 SourceEntryId 一起构成唯一键）</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>源文档条目 ID</summary>
    public string SourceEntryId { get; set; } = string.Empty;

    /// <summary>所属知识库</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>前端 direct-chat 对话快照（sanitized ChatMessage[] 的 JSON）。后端只存不解析。</summary>
    public string MessagesJson { get; set; } = "[]";

    /// <summary>视觉创作 mini 面板「已生成未插入」的图（JSON 数组），关窗也不丢。</summary>
    public string PendingImagesJson { get; set; } = "[]";

    /// <summary>当前选中的智能体引用（前端 activeRef 的 JSON 镜像，便于重开抽屉恢复选择）。</summary>
    public string? ActiveRefJson { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
