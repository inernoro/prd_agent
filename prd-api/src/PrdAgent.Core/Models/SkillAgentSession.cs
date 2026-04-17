namespace PrdAgent.Core.Models;

/// <summary>
/// 技能生成 Agent 的会话状态（持久化到 MongoDB `skill_agent_sessions` 集合）。
///
/// 字段命名/Id 声明遵循 CLAUDE.md 项目规则 #7（对照 DefectReport.cs 等现存 Model 写法）：
/// - `Id` 为 string 主键，初始化为 Guid.NewGuid().ToString("N")
/// - 通过 BsonClassMapRegistration.RegisterSkillAgentSession 绑定到 `_id`
/// - 不加任何 [BsonId] / [BsonRepresentation] 属性
///
/// 生命周期：
/// - 由 SkillAgentController.CreateSession 创建，同时写入内存 Dictionary 和本集合
/// - 每次阶段推进 / 消息追加 / SavedSkillKey 赋值后由 ISkillAgentSessionStore.SaveAsync upsert
/// - 内存层 2h 无活动被清理；DB 层靠 LastActiveAt TTL 索引（7 天）兜底
/// </summary>
public class SkillAgentSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;

    /// <summary>当前阶段：intent / scope / draft / metadata / preview</summary>
    public string CurrentStage { get; set; } = "intent";

    /// <summary>用户提炼出的意图描述（intent 阶段完成后写入）</summary>
    public string? Intent { get; set; }

    /// <summary>增量构建中的技能草稿（stage 推进过程中填充）</summary>
    public Skill? SkillDraft { get; set; }

    /// <summary>AI / 用户对话历史（供 LLM 上下文 + 前端聊天气泡还原）</summary>
    public List<SkillAgentMessage> Messages { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 首次保存成功后记录的 SkillKey。
    /// 后续"保存并试跑"会认它为准走 Update，避免因 Title 变更导致 SkillKey 漂移而新建重复记录。
    /// </summary>
    public string? SavedSkillKey { get; set; }
}

/// <summary>会话中的一条消息。用 record 保证结构体语义（前端只需 role/content）</summary>
public record SkillAgentMessage(string Role, string Content);
