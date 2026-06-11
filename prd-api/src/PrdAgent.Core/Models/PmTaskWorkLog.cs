namespace PrdAgent.Core.Models;

/// <summary>
/// 任务工作日志 — 处理人按天记录"做了什么、完成多少进度"（流水多条，一天可多条）。
///
/// 字段对齐 <see cref="DailyLogItem"/>（周报模块 report_daily_logs），预留 TaskId + Category，
/// 便于后续单独做一期"任务日志汇总进个人日报/周报"，本期独立存在不联动。
/// </summary>
public class PmTaskWorkLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属任务 ID</summary>
    public string TaskId { get; set; } = string.Empty;

    /// <summary>所属项目 ID（冗余，便于按项目查询/清理）</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>填写人 UserId</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>填写人名称（冗余）</summary>
    public string? UserName { get; set; }

    /// <summary>工作发生日期（按天分组展示）</summary>
    public DateTime Date { get; set; }

    /// <summary>工作内容描述（今天做了什么）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>耗时（分钟，选填）</summary>
    public int? DurationMinutes { get; set; }

    /// <summary>填写时上报的任务进度 0-100（选填；非空时联动更新任务 ProgressPercent）</summary>
    public int? ProgressPercent { get; set; }

    /// <summary>分类（复用 DailyLogCategory：development/meeting/...，预留与周报联动）</summary>
    public string Category { get; set; } = DailyLogCategory.Development;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
