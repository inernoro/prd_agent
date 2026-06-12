using System.Net;
using System.Text;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 项目简报 HTML 渲染器 — 把「服务端统计的硬数据 + LLM 结构化内容」渲染为自包含 HTML 单文件。
/// 模板固定走服务端（不让 LLM 直接写整页 HTML）：样式稳定、防 prompt 注入、省 token。
/// 所有动态文本一律 HtmlEncode。支持 5 套主题（classic/dark/warm/minimal/vivid），由 RenderData.Style 决定。
/// </summary>
public static class PmBriefingRenderer
{
    /// <summary>简报硬数据（服务端从 DB 统计，不经 LLM，保真）。整体序列化存入 PmBriefing.RenderDataJson 供切换风格重渲染。</summary>
    public class RenderData
    {
        public string ProjectTitle { get; set; } = string.Empty;
        public string ProjectNo { get; set; } = string.Empty;
        public string? LeaderName { get; set; }
        public string? PeriodText { get; set; }
        public DateTime GeneratedAt { get; set; } = DateTime.UtcNow;
        public int TaskTotal { get; set; }
        public int TaskDone { get; set; }
        public int TaskDoneRate { get; set; }
        public int MilestoneTotal { get; set; }
        public int MilestoneReached { get; set; }
        public int GoalCount { get; set; }
        public int RiskOpen { get; set; }
        public List<MilestoneRow> Milestones { get; set; } = new();
        public PmBriefingAiContent Ai { get; set; } = new();
        public string? Model { get; set; }
        /// <summary>主题 key：classic | dark | warm | minimal | vivid</summary>
        public string Style { get; set; } = "classic";
        /// <summary>报告周期起（UTC，可空=全周期）</summary>
        public DateTime? ReportFrom { get; set; }
        /// <summary>报告周期止（UTC 含当日，可空）</summary>
        public DateTime? ReportTo { get; set; }
    }

    public class MilestoneRow
    {
        public string Title { get; set; } = string.Empty;
        /// <summary>健康度 key：reached | cancelled | overdue | at_risk | on_track</summary>
        public string Health { get; set; } = "on_track";
        public DateTime? DueAt { get; set; }
        public int Progress { get; set; }
    }

    /// <summary>主题 token（参考 cds-theme-tokens：颜色全部走主题，不在模板里写死）</summary>
    private sealed record Theme(
        string Label,
        string PageBg,
        string CardBg,
        string CardBorder,
        string CardShadow,
        string Radius,
        string TextPrimary,
        string TextSecondary,
        string TextMuted,
        string Accent,
        string MetricBg,
        string MetricBorder,
        string BarTrack,
        string FooterColor,
        string FontFamily,
        string HeadingExtra,
        bool Dark);

    private const string SansFont = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    private const string SerifFont = "Georgia,'Songti SC','STSong',serif";

    private static readonly Dictionary<string, Theme> Themes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["classic"] = new Theme("经典商务", "#F3F4F6", "#FFFFFF", "#E5E7EB", "0 1px 3px rgba(0,0,0,0.04)", "14px",
            "#111827", "#1F2937", "#6B7280", "#2563EB", "#F9FAFB", "#E5E7EB", "#E5E7EB", "#9CA3AF", SansFont, "", false),
        ["dark"] = new Theme("暗夜科技", "#0F172A", "#1E293B", "#334155", "0 4px 16px rgba(0,0,0,0.4)", "14px",
            "#F1F5F9", "#CBD5E1", "#94A3B8", "#38BDF8", "#162032", "#2B3A52", "#334155", "#64748B", SansFont, "", true),
        ["warm"] = new Theme("暖纸杂志", "#F8F1E7", "#FFFBF4", "#E8DCC8", "0 1px 4px rgba(120,90,40,0.08)", "10px",
            "#3D2E1E", "#54422C", "#8B7A63", "#B45309", "#F4EBDD", "#E8DCC8", "#E8DCC8", "#A8957B", SansFont,
            $"font-family:{SerifFont};letter-spacing:1px", false),
        ["minimal"] = new Theme("极简黑白", "#FFFFFF", "#FFFFFF", "#111111", "none", "0",
            "#111111", "#222222", "#777777", "#111111", "#FAFAFA", "#DDDDDD", "#EEEEEE", "#999999", SansFont,
            "text-transform:uppercase;letter-spacing:2px;font-size:13px", false),
        ["vivid"] = new Theme("活力渐变", "linear-gradient(135deg,#EEF2FF 0%,#FDF2F8 60%,#FFF7ED 100%)", "rgba(255,255,255,0.92)", "#E9D5FF",
            "0 4px 18px rgba(124,58,237,0.10)", "18px",
            "#1E1B4B", "#3730A3", "#7C7AA6", "#7C3AED", "#F5F3FF", "#E9D5FF", "#EDE9FE", "#A78BFA", SansFont, "", false),
    };

    /// <summary>所有可选主题（key + 中文名 + 预览色），前端风格选择器消费同一份（SSOT，不在前端硬编码）。</summary>
    public static IReadOnlyList<(string Key, string Label, string Accent, string PageBg)> Styles =>
        new[] { "classic", "dark", "warm", "minimal", "vivid" }
            .Select(k => (k, Themes[k].Label, Themes[k].Accent, Themes[k].PageBg))
            .ToList();

    public static bool IsValidStyle(string? style) => !string.IsNullOrWhiteSpace(style) && Themes.ContainsKey(style);

    private static readonly TimeZoneInfo ChinaTimeZone = TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai");

    /// <summary>UTC → 中国时区（简报面向国内干系人，沿用 PmOverdueReminderWorker 同款时区约定）</summary>
    public static DateTime ToCst(DateTime utc) => TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), ChinaTimeZone);

    /// <summary>中国时区本地时刻 → UTC（解析前端传来的 yyyy-MM-dd 周期日期用）</summary>
    public static DateTime CstToUtc(DateTime cst) => TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(cst, DateTimeKind.Unspecified), ChinaTimeZone);

    private static string E(string? s) => WebUtility.HtmlEncode(s ?? string.Empty);

    private static (string label, string color, string bg) StatusMeta(string status, bool dark) => status switch
    {
        "at_risk" => dark ? ("有风险", "#FBBF24", "rgba(251,191,36,0.15)") : ("有风险", "#B45309", "#FEF3C7"),
        "off_track" => dark ? ("已偏离", "#F87171", "rgba(248,113,113,0.15)") : ("已偏离", "#B91C1C", "#FEE2E2"),
        _ => dark ? ("正常推进", "#34D399", "rgba(52,211,153,0.15)") : ("正常推进", "#047857", "#D1FAE5"),
    };

    private static (string label, string color) HealthMeta(string health, bool dark) => health switch
    {
        "reached" => ("已达成", dark ? "#34D399" : "#047857"),
        "cancelled" => ("已取消", dark ? "#94A3B8" : "#6B7280"),
        "overdue" => ("已逾期", dark ? "#F87171" : "#B91C1C"),
        "at_risk" => ("临近风险", dark ? "#FBBF24" : "#B45309"),
        _ => ("正常", dark ? "#60A5FA" : "#1D4ED8"),
    };

    private static (string label, string color) RiskMeta(string level, bool dark) => level switch
    {
        "high" => ("高", dark ? "#F87171" : "#B91C1C"),
        "low" => ("低", dark ? "#34D399" : "#047857"),
        _ => ("中", dark ? "#FBBF24" : "#B45309"),
    };

    public static string Render(RenderData d)
    {
        var t = Themes.TryGetValue(d.Style ?? "classic", out var theme) ? theme : Themes["classic"];
        var (stLabel, stColor, stBg) = StatusMeta(d.Ai.Status, t.Dark);
        var dateText = ToCst(d.GeneratedAt).ToString("yyyy-MM-dd");
        var sb = new StringBuilder();
        sb.Append("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">");
        sb.Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
        sb.Append($"<title>{E(d.ProjectTitle)} 项目简报 · {dateText}</title>");
        sb.Append("<style>");
        sb.Append("*{margin:0;padding:0;box-sizing:border-box}");
        sb.Append($"body{{font-family:{t.FontFamily};background:{t.PageBg};color:{t.TextPrimary};line-height:1.65;min-height:100vh}}");
        sb.Append(".page{max-width:860px;margin:0 auto;padding:32px 20px 48px}");
        sb.Append($".card{{background:{t.CardBg};border:1px solid {t.CardBorder};border-radius:{t.Radius};padding:28px 32px;margin-bottom:16px;box-shadow:{t.CardShadow}}}");
        sb.Append($".hd-kicker{{font-size:12px;letter-spacing:2px;color:{t.TextMuted};text-transform:uppercase;margin-bottom:8px}}");
        sb.Append("h1{font-size:24px;font-weight:700;letter-spacing:0.3px}");
        sb.Append($".hd-meta{{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:12px;font-size:13px;color:{t.TextMuted}}}");
        sb.Append(".pill{display:inline-block;font-size:12.5px;font-weight:600;padding:3px 12px;border-radius:999px;vertical-align:3px;margin-left:12px}");
        sb.Append($"h2{{font-size:15px;font-weight:700;margin-bottom:14px;padding-left:10px;border-left:3px solid {t.Accent};{t.HeadingExtra}}}");
        sb.Append(".metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}");
        sb.Append($".metric{{background:{t.MetricBg};border:1px solid {t.MetricBorder};border-radius:{(t.Radius == "0" ? "0" : "10px")};padding:14px 16px}}");
        sb.Append($".metric .v{{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:{t.TextPrimary}}}");
        sb.Append($".metric .k{{font-size:12px;color:{t.TextMuted};margin-top:2px}}");
        sb.Append($"ul.plain{{list-style:none}}ul.plain li{{position:relative;padding-left:18px;margin-bottom:8px;font-size:14px;color:{t.TextSecondary}}}");
        sb.Append($"ul.plain li::before{{content:'';position:absolute;left:2px;top:9px;width:6px;height:6px;border-radius:50%;background:{t.Accent}}}");
        sb.Append("table{width:100%;border-collapse:collapse;font-size:13.5px}");
        sb.Append($"th{{text-align:left;font-weight:600;color:{t.TextMuted};font-size:12.5px;padding:8px 10px;border-bottom:1px solid {t.MetricBorder}}}");
        sb.Append($"td{{padding:9px 10px;border-bottom:1px solid {t.MetricBg};color:{t.TextSecondary}}}");
        sb.Append($".bar{{background:{t.BarTrack};border-radius:999px;height:6px;width:120px;overflow:hidden}}");
        sb.Append(".bar>span{display:block;height:100%;border-radius:999px}");
        sb.Append(".tag{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px}");
        sb.Append($".risk-item{{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;font-size:14px;color:{t.TextSecondary}}}");
        sb.Append($".summary{{font-size:14.5px;color:{t.TextSecondary};white-space:pre-wrap}}");
        sb.Append($".status-note{{font-size:13px;color:{t.TextMuted};margin-top:8px}}");
        sb.Append($"@media print{{body{{background:{(t.Dark ? "#0F172A" : "#fff")}}}.card{{box-shadow:none}}}}");
        sb.Append("</style></head><body><div class=\"page\">");

        // 头部
        sb.Append("<div class=\"card\">");
        sb.Append("<div class=\"hd-kicker\">PROJECT BRIEFING · 项目简报</div>");
        sb.Append($"<h1>{E(d.ProjectTitle)}<span class=\"pill\" style=\"color:{stColor};background:{stBg}\">{stLabel}</span></h1>");
        sb.Append("<div class=\"hd-meta\">");
        sb.Append($"<span>编号 {E(d.ProjectNo)}</span>");
        if (!string.IsNullOrWhiteSpace(d.LeaderName)) sb.Append($"<span>负责人 {E(d.LeaderName)}</span>");
        if (!string.IsNullOrWhiteSpace(d.PeriodText)) sb.Append($"<span>计划周期 {E(d.PeriodText)}</span>");
        if (d.ReportFrom.HasValue && d.ReportTo.HasValue)
            sb.Append($"<span>报告周期 {ToCst(d.ReportFrom.Value):yyyy-MM-dd} ~ {ToCst(d.ReportTo.Value):yyyy-MM-dd}</span>");
        sb.Append($"<span>简报日期 {dateText}</span>");
        sb.Append("</div>");
        if (!string.IsNullOrWhiteSpace(d.Ai.StatusNote))
            sb.Append($"<div class=\"status-note\">{E(d.Ai.StatusNote)}</div>");
        sb.Append("</div>");

        // 核心指标（服务端硬数据）
        sb.Append("<div class=\"card\"><h2>关键数据</h2><div class=\"metrics\">");
        sb.Append($"<div class=\"metric\"><div class=\"v\">{d.TaskDoneRate}%</div><div class=\"k\">任务完成率（{d.TaskDone}/{d.TaskTotal}）</div></div>");
        sb.Append($"<div class=\"metric\"><div class=\"v\">{d.MilestoneReached}/{d.MilestoneTotal}</div><div class=\"k\">里程碑已达成</div></div>");
        sb.Append($"<div class=\"metric\"><div class=\"v\">{d.GoalCount}</div><div class=\"k\">在跟团队目标</div></div>");
        sb.Append($"<div class=\"metric\"><div class=\"v\">{d.RiskOpen}</div><div class=\"k\">未关闭风险</div></div>");
        sb.Append("</div></div>");

        // 整体摘要
        if (!string.IsNullOrWhiteSpace(d.Ai.Summary))
            sb.Append($"<div class=\"card\"><h2>整体进展</h2><div class=\"summary\">{E(d.Ai.Summary)}</div></div>");

        // 进展亮点
        if (d.Ai.Highlights.Count > 0)
        {
            sb.Append("<div class=\"card\"><h2>本期亮点</h2><ul class=\"plain\">");
            foreach (var h in d.Ai.Highlights) sb.Append($"<li>{E(h)}</li>");
            sb.Append("</ul></div>");
        }

        // 里程碑（硬数据）
        if (d.Milestones.Count > 0)
        {
            sb.Append("<div class=\"card\"><h2>里程碑进展</h2><table><tr><th>里程碑</th><th>计划日期</th><th>进度</th><th>状态</th></tr>");
            foreach (var m in d.Milestones)
            {
                var (hl, hc) = HealthMeta(m.Health, t.Dark);
                sb.Append("<tr>");
                sb.Append($"<td>{E(m.Title)}</td>");
                sb.Append($"<td style=\"color:{t.TextMuted}\">{(m.DueAt.HasValue ? ToCst(m.DueAt.Value).ToString("yyyy-MM-dd") : "未排期")}</td>");
                sb.Append($"<td><div class=\"bar\"><span style=\"width:{Math.Clamp(m.Progress, 0, 100)}%;background:{hc}\"></span></div></td>");
                sb.Append($"<td><span class=\"tag\" style=\"color:{hc};background:{hc}1f\">{hl}</span></td>");
                sb.Append("</tr>");
            }
            sb.Append("</table></div>");
        }

        // 风险与问题
        if (d.Ai.Risks.Count > 0)
        {
            sb.Append("<div class=\"card\"><h2>风险与问题</h2>");
            foreach (var r in d.Ai.Risks)
            {
                var (rl, rc) = RiskMeta(r.Level, t.Dark);
                sb.Append($"<div class=\"risk-item\"><span class=\"tag\" style=\"color:{rc};background:{rc}1f;flex-shrink:0;margin-top:2px\">{rl}</span><span>{E(r.Text)}</span></div>");
            }
            sb.Append("</div>");
        }

        // 下一步计划
        if (d.Ai.NextSteps.Count > 0)
        {
            sb.Append("<div class=\"card\"><h2>下一步计划</h2><ul class=\"plain\">");
            foreach (var n in d.Ai.NextSteps) sb.Append($"<li>{E(n)}</li>");
            sb.Append("</ul></div>");
        }

        sb.Append("</div></body></html>");
        return sb.ToString();
    }
}
