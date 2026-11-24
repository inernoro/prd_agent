using MongoDB.Bson.Serialization.Attributes;
using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 月报：固定四章，全部由用户手写，不接入 AI。
/// 一个人在一个团队的一个自然月只有一份（UserId + TeamId + Year + Month）。
/// 互动（评论 / 点赞 / 浏览）与周报共用 report_comments / report_likes / report_view_events，按 ReportId 关联。
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class MonthlyReport
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>作者 UserId</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>作者名称（冗余）</summary>
    public string? UserName { get; set; }

    /// <summary>作者头像文件名（冗余）</summary>
    public string? AvatarFileName { get; set; }

    public string TeamId { get; set; } = string.Empty;

    /// <summary>团队名称（冗余）</summary>
    public string? TeamName { get; set; }

    /// <summary>自然年</summary>
    public int Year { get; set; }

    /// <summary>自然月（1-12）</summary>
    public int Month { get; set; }

    /// <summary>draft / submitted / viewed</summary>
    public string Status { get; set; } = MonthlyReportStatus.Draft;

    /// <summary>第一章：关联的周报（用户手动勾选；存快照，周报被删后仍能显示是哪一周）</summary>
    public List<MonthlyReportWeeklyLink> WeeklyLinks { get; set; } = new();

    /// <summary>第一章：本月工作成果（手写，Markdown）</summary>
    public string AchievementsText { get; set; } = string.Empty;

    /// <summary>第二章：问题与对策（选填，Markdown）</summary>
    public string? ProblemsText { get; set; }

    /// <summary>第三章：本月印象最深刻的伙伴（选填，最多 3 位）</summary>
    public List<MonthlyReportPartner> Partners { get; set; } = new();

    /// <summary>第四章：对上级/团队/公司的建议（选填，Markdown）</summary>
    public string? SuggestionsText { get; set; }

    public DateTime? SubmittedAt { get; set; }

    /// <summary>负责人首次查看时间</summary>
    public DateTime? ViewedAt { get; set; }

    /// <summary>状态变更记录（submitted / edited），复用周报的事件常量</summary>
    public List<ReportVersionEntry> VersionHistory { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>月报关联的周报（快照）</summary>
public class MonthlyReportWeeklyLink
{
    public string WeeklyReportId { get; set; } = string.Empty;
    public int WeekYear { get; set; }
    public int WeekNumber { get; set; }
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }
}

/// <summary>月报里写下的伙伴（手写名字，不要求是系统用户）</summary>
public class MonthlyReportPartner
{
    /// <summary>伙伴名字（手写，可以是系统外的人）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>理由（多行文本）</summary>
    public string Reason { get; set; } = string.Empty;

    /// <summary>
    /// 兼容字段：早期版本从系统用户里选人时存的显示名（文档字段名 UserName）。
    /// 只读用于展示与回填 Name，新写入不再产生。
    /// </summary>
    [BsonElement("UserName")]
    [BsonIgnoreIfNull]
    public string? LegacyUserName { get; set; }

    /// <summary>展示用名字：优先手写名字，旧数据回退到早期存的显示名（只出现在接口返回里，不落库）</summary>
    [BsonIgnore]
    public string DisplayName => !string.IsNullOrWhiteSpace(Name) ? Name : LegacyUserName ?? string.Empty;
}

public static class MonthlyReportStatus
{
    public const string Draft = "draft";
    public const string Submitted = "submitted";
    public const string Viewed = "viewed";

    public static readonly string[] All = { Draft, Submitted, Viewed };
}

/// <summary>月报四章（顺序即评论的 SectionIndex）</summary>
public static class MonthlyReportChapters
{
    public const int Achievements = 0;
    public const int Problems = 1;
    public const int Partners = 2;
    public const int Suggestions = 3;

    public static readonly string[] Titles =
    {
        "本月工作成果",
        "问题与对策",
        "本月印象最深刻的三个伙伴",
        "对上级/团队/公司的建议",
    };

    public static string TitleOf(int index)
        => index >= 0 && index < Titles.Length ? Titles[index] : string.Empty;
}
