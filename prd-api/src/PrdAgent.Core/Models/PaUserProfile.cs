namespace PrdAgent.Core.Models;

/// <summary>
/// 毒舌秘书跨会话画像。一个用户一条记录（UserId unique）。
/// LLM 在 chat 末尾输出 `update_profile` JSON 块时由 Controller 异步落盘。
/// 用户可在「我的画像」面板查看、编辑、删除任意条目。
/// </summary>
public class PaUserProfile
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    /// <summary>用户显示名缓存，与 JWT name claim 同步，用于 prompt 注入显示</summary>
    public string DisplayNameCache { get; set; } = string.Empty;

    public PaWorkRhythm Rhythm { get; set; } = new();
    public List<PaMemoryEntry> Memories { get; set; } = new();
    public PaUserPreferences Preferences { get; set; } = new();

    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>用户工作节奏。每个字段都是可选——只有 LLM 抽到或用户填了才有值。</summary>
public class PaWorkRhythm
{
    /// <summary>典型开始工作小时（0-23）</summary>
    public int? TypicalStartHour { get; set; }
    /// <summary>典型结束工作小时（0-23）</summary>
    public int? TypicalEndHour { get; set; }
    /// <summary>周末是否活跃</summary>
    public bool WeekendActive { get; set; }
    /// <summary>完美主义倾向：low / mid / high；为空表示未判定</summary>
    public string? PerfectionismLevel { get; set; }
}

public class PaMemoryEntry
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    /// <summary>条目类型：role / project / fact / preference</summary>
    public string Kind { get; set; } = PaMemoryKind.Fact;
    /// <summary>事实文本，≤ 60 字</summary>
    public string Text { get; set; } = string.Empty;
    /// <summary>来源：auto / suggest / manual</summary>
    public string Source { get; set; } = PaMemorySource.Manual;
    /// <summary>状态：active / archived</summary>
    public string Status { get; set; } = PaMemoryStatus.Active;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedAt { get; set; }
}

public static class PaMemoryKind
{
    public const string Role = "role";
    public const string Project = "project";
    public const string Fact = "fact";
    public const string Preference = "preference";
    public static readonly string[] All = { Role, Project, Fact, Preference };
}

public static class PaMemorySource
{
    /// <summary>LLM 高置信度抽取，立即参与注入</summary>
    public const string Auto = "auto";
    /// <summary>LLM 低置信度抽取，等用户确认才注入</summary>
    public const string Suggest = "suggest";
    /// <summary>用户手动编辑/添加，最高优先级</summary>
    public const string Manual = "manual";
    public static readonly string[] All = { Auto, Suggest, Manual };
}

public static class PaMemoryStatus
{
    public const string Active = "active";
    public const string Archived = "archived";
    public static readonly string[] All = { Active, Archived };
}

public class PaUserPreferences
{
    /// <summary>用户希望被叫的称呼（覆盖姓名）</summary>
    public string? PreferredAddress { get; set; }
    /// <summary>禁用话题（不会主动追问的方向）</summary>
    public List<string> ForbiddenTopics { get; set; } = new();
    /// <summary>毒舌强度：gentle / default / sharp</summary>
    public string SavageLevel { get; set; } = "default";
}

/// <summary>PaSession Type 常量。chat 为默认；review 用于复盘会话。</summary>
public static class PaSessionType
{
    public const string Chat = "chat";
    public const string Review = "review";
    public static readonly string[] All = { Chat, Review };
}
