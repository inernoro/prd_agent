using System.Net;
using System.Text;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 项目简报 HTML 渲染器 — 把「服务端统计的硬数据 + LLM 结构化内容」渲染为自包含 HTML 单文件。
/// 模板固定走服务端（不让 LLM 直接写整页 HTML）：样式稳定、防 prompt 注入、省 token。
/// 所有动态文本一律 HtmlEncode。
/// </summary>
public static class PmBriefingRenderer
{
    /// <summary>简报硬数据（服务端从 DB 统计，不经 LLM，保真）。</summary>
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
    }

    public class MilestoneRow
    {
        public string Title { get; set; } = string.Empty;
        /// <summary>健康度 key：reached | cancelled | overdue | at_risk | on_track</summary>
        public string Health { get; set; } = "on_track";
        public DateTime? DueAt { get; set; }
        public int Progress { get; set; }
    }

    private static readonly TimeZoneInfo ChinaTimeZone = TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai");

    /// <summary>UTC → 中国时区（简报面向国内干系人，沿用 PmOverdueReminderWorker 同款时区约定）</summary>
    public static DateTime ToCst(DateTime utc) => TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), ChinaTimeZone);

    private static string E(string? s) => WebUtility.HtmlEncode(s ?? string.Empty);

    private static (string label, string color, string bg) StatusMeta(string status) => status switch
    {
        "at_risk" => ("有风险", "#B45309", "#FEF3C7"),
        "off_track" => ("已偏离", "#B91C1C", "#FEE2E2"),
        _ => ("正常推进", "#047857", "#D1FAE5"),
    };

    private static (string label, string color) HealthMeta(string health) => health switch
    {
        "reached" => ("已达成", "#047857"),
        "cancelled" => ("已取消", "#6B7280"),
        "overdue" => ("已逾期", "#B91C1C"),
        "at_risk" => ("临近风险", "#B45309"),
        _ => ("正常", "#1D4ED8"),
    };

    private static (string label, string color) RiskMeta(string level) => level switch
    {
        "high" => ("高", "#B91C1C"),
        "low" => ("低", "#047857"),
        _ => ("中", "#B45309"),
    };

    public static string Render(RenderData d)
    {
        var (stLabel, stColor, stBg) = StatusMeta(d.Ai.Status);
        var dateText = ToCst(d.GeneratedAt).ToString("yyyy-MM-dd");
        var sb = new StringBuilder();
        sb.Append("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">");
        sb.Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
        sb.Append($"<title>{E(d.ProjectTitle)} 项目简报 · {dateText}</title>");
        sb.Append("<style>");
        sb.Append("*{margin:0;padding:0;box-sizing:border-box}");
        sb.Append("body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;background:#F3F4F6;color:#111827;line-height:1.65}");
        sb.Append(".page{max-width:860px;margin:0 auto;padding:32px 20px 48px}");
        sb.Append(".card{background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:28px 32px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04)}");
        sb.Append(".hd-kicker{font-size:12px;letter-spacing:2px;color:#6B7280;text-transform:uppercase;margin-bottom:8px}");
        sb.Append("h1{font-size:24px;font-weight:700;letter-spacing:0.3px}");
        sb.Append(".hd-meta{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:12px;font-size:13px;color:#6B7280}");
        sb.Append(".pill{display:inline-block;font-size:12.5px;font-weight:600;padding:3px 12px;border-radius:999px;vertical-align:3px;margin-left:12px}");
        sb.Append("h2{font-size:15px;font-weight:700;margin-bottom:14px;padding-left:10px;border-left:3px solid #2563EB}");
        sb.Append(".metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}");
        sb.Append(".metric{background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:14px 16px}");
        sb.Append(".metric .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}");
        sb.Append(".metric .k{font-size:12px;color:#6B7280;margin-top:2px}");
        sb.Append("ul.plain{list-style:none}ul.plain li{position:relative;padding-left:18px;margin-bottom:8px;font-size:14px}");
        sb.Append("ul.plain li::before{content:'';position:absolute;left:2px;top:9px;width:6px;height:6px;border-radius:50%;background:#2563EB}");
        sb.Append("table{width:100%;border-collapse:collapse;font-size:13.5px}");
        sb.Append("th{text-align:left;font-weight:600;color:#6B7280;font-size:12.5px;padding:8px 10px;border-bottom:1px solid #E5E7EB}");
        sb.Append("td{padding:9px 10px;border-bottom:1px solid #F3F4F6}");
        sb.Append(".bar{background:#E5E7EB;border-radius:999px;height:6px;width:120px;overflow:hidden}");
        sb.Append(".bar>span{display:block;height:100%;border-radius:999px}");
        sb.Append(".tag{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px}");
        sb.Append(".risk-item{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;font-size:14px}");
        sb.Append(".summary{font-size:14.5px;color:#1F2937;white-space:pre-wrap}");
        sb.Append(".status-note{font-size:13px;color:#6B7280;margin-top:8px}");
        sb.Append("footer{text-align:center;font-size:12px;color:#9CA3AF;margin-top:24px}");
        sb.Append("@media print{body{background:#fff}.card{box-shadow:none;border-color:#D1D5DB}}");
        sb.Append("</style></head><body><div class=\"page\">");

        // 头部
        sb.Append("<div class=\"card\">");
        sb.Append("<div class=\"hd-kicker\">PROJECT BRIEFING · 项目简报</div>");
        sb.Append($"<h1>{E(d.ProjectTitle)}<span class=\"pill\" style=\"color:{stColor};background:{stBg}\">{stLabel}</span></h1>");
        sb.Append("<div class=\"hd-meta\">");
        sb.Append($"<span>编号 {E(d.ProjectNo)}</span>");
        if (!string.IsNullOrWhiteSpace(d.LeaderName)) sb.Append($"<span>负责人 {E(d.LeaderName)}</span>");
        if (!string.IsNullOrWhiteSpace(d.PeriodText)) sb.Append($"<span>计划周期 {E(d.PeriodText)}</span>");
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
                var (hl, hc) = HealthMeta(m.Health);
                sb.Append("<tr>");
                sb.Append($"<td>{E(m.Title)}</td>");
                sb.Append($"<td style=\"color:#6B7280\">{(m.DueAt.HasValue ? ToCst(m.DueAt.Value).ToString("yyyy-MM-dd") : "未排期")}</td>");
                sb.Append($"<td><div class=\"bar\"><span style=\"width:{Math.Clamp(m.Progress, 0, 100)}%;background:{hc}\"></span></div></td>");
                sb.Append($"<td><span class=\"tag\" style=\"color:{hc};background:{hc}1a\">{hl}</span></td>");
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
                var (rl, rc) = RiskMeta(r.Level);
                sb.Append($"<div class=\"risk-item\"><span class=\"tag\" style=\"color:{rc};background:{rc}1a;flex-shrink:0;margin-top:2px\">{rl}</span><span>{E(r.Text)}</span></div>");
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

        // 页脚
        sb.Append("<footer>");
        sb.Append($"由 PRD Agent 项目管理智能体生成 · {ToCst(d.GeneratedAt):yyyy-MM-dd HH:mm}");
        if (!string.IsNullOrWhiteSpace(d.Model)) sb.Append($" · 模型 {E(d.Model)}");
        sb.Append("</footer>");

        sb.Append("</div></body></html>");
        return sb.ToString();
    }
}
