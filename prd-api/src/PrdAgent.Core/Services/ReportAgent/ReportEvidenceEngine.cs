using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services.ReportAgent;

/// <summary>三个交付阶段各自依据事件重建。语言模型仅能建议排序，不能改写事实。</summary>
public static class ReportEvidenceEngine
{
    private static readonly HashSet<string> Kinds = new(StringComparer.Ordinal)
    { "observation", "started", "commit", "merged", "code_complete", "validation_passed", "validation_failed", "release_succeeded", "release_failed", "blocked", "unblocked" };
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static (DateTimeOffset Start, DateTimeOffset End) Bounds(DateTime start, DateTime end)
        => (new DateTimeOffset(DateTime.SpecifyKind(start.Date, DateTimeKind.Unspecified), TimeSpan.FromHours(8)), new DateTimeOffset(DateTime.SpecifyKind(end.Date.AddDays(1), DateTimeKind.Unspecified), TimeSpan.FromHours(8)));

    public static ReportEvidenceLedger Merge(IEnumerable<ReportEvidenceLedger?> ledgers)
    {
        var result = new ReportEvidenceLedger();
        var workItems = new Dictionary<string, ReportEvidenceWorkItem>(StringComparer.Ordinal);
        var events = new Dictionary<string, ReportEvidenceEvent>(StringComparer.Ordinal);
        var inputs = ledgers.Where(l => l != null).Cast<ReportEvidenceLedger>().ToList();
        result.HistoryComplete = inputs.Count > 0 && inputs.All(l => l.HistoryComplete);
        foreach (var ledger in inputs)
        {
            if (ledger.SchemaVersion != 1) throw new InvalidOperationException("报告证据版本不受支持");
            result.Limitations.AddRange(ledger.Limitations);
            foreach (var item in ledger.WorkItems)
            {
                if (string.IsNullOrWhiteSpace(item.Id) || string.IsNullOrWhiteSpace(item.Title))
                    throw new InvalidOperationException("事项需要稳定标识与标题");
                workItems[item.Id] = item;
            }
            foreach (var e in ledger.Events)
            {
                if (string.IsNullOrWhiteSpace(e.Id) || !Kinds.Contains(e.Kind) || string.IsNullOrWhiteSpace(e.Source.Uri) || string.IsNullOrWhiteSpace(e.Source.Excerpt))
                    throw new InvalidOperationException("证据需要来源、原文、标识和有效事件类型");
                if ((e.Kind is "commit" or "merged" or "code_complete" || e.Kind.StartsWith("validation_") || e.Kind.StartsWith("release_")) && string.IsNullOrWhiteSpace(e.Revision))
                    throw new InvalidOperationException("代码、验证与发布事件需要明确版本");
                if (e.Kind.StartsWith("validation_") && e.Scope is not ("feature" or "ci"))
                    throw new InvalidOperationException("验证需要明确功能或 CI 范围");
                if (e.Kind.StartsWith("release_") && e.Environment is not ("production" or "preview"))
                    throw new InvalidOperationException("发布需要明确正式或预览环境");
                if (e.Kind == "blocked" && string.IsNullOrWhiteSpace(e.Reason))
                    throw new InvalidOperationException("阻塞需要明确原因");
                if (e.TimeBasis is not ("occurred" or "observed"))
                    throw new InvalidOperationException("证据需要区分发生时间与观测时间");
                if (events.TryGetValue(e.Id, out var prior) && JsonSerializer.Serialize(prior, Json) != JsonSerializer.Serialize(e, Json))
                    throw new InvalidOperationException("相同来源记录发生冲突，请核对原始证据");
                events[e.Id] = e;
            }
        }
        result.WorkItems = workItems.Values.OrderBy(i => i.Id, StringComparer.Ordinal).ToList();
        result.Events = events.Values.OrderBy(e => e.OccurredAt).ThenBy(e => e.Order).ThenBy(e => e.Id, StringComparer.Ordinal).ToList();
        if (result.Events.Any(e => e.WorkItemId != null && !workItems.ContainsKey(e.WorkItemId)))
            throw new InvalidOperationException("来源记录关联的事项不存在");
        result.Limitations = result.Limitations.Distinct().ToList();
        return result;
    }

    private sealed class State
    {
        public string Code = "unknown", Validation = "unknown", Release = "unknown";
        public string? Revision, ReleasedRevision, BlockReason;
        public bool CiFailed;
        public Dictionary<string, ReportEvidenceEvent> First = new();
        public bool Complete => Code == "complete" && Validation == "passed" && Release == "released" && BlockReason == null && !CiFailed;
    }

    private static State Replay(IEnumerable<ReportEvidenceEvent> events)
    {
        var s = new State();
        foreach (var e in events)
        {
            if (s.Revision == null && (e.Kind.StartsWith("validation_") || e.Kind.StartsWith("release_"))) s.Revision = e.Revision;
            if (e.Kind is "commit" or "merged" or "code_complete")
            {
                if (s.Revision != e.Revision)
                {
                    s.Revision = e.Revision;
                    s.CiFailed = false;
                    s.Code = "in_progress";
                    if (s.Validation != "unknown") s.Validation = "stale";
                    s.Release = s.ReleasedRevision == e.Revision ? "released" : "unknown";
                }
                if (e.Kind == "code_complete") { s.Code = "complete"; s.First.TryAdd("code", e); }
            }
            else if (e.Kind is "started" or "observation") { if (s.Code == "unknown") s.Code = "in_progress"; }
            else if (e.Kind.StartsWith("validation_") && e.Scope == "ci" && e.Revision == s.Revision) s.CiFailed = e.Kind == "validation_failed";
            else if (e.Kind.StartsWith("validation_") && e.Scope == "feature" && e.Revision == s.Revision)
            {
                s.Validation = e.Kind == "validation_passed" ? "passed" : "failed";
                if (s.Validation == "passed") s.First.TryAdd("validation", e);
            }
            else if (e.Kind.StartsWith("release_") && e.Environment == "production")
            {
                if (e.Kind == "release_succeeded") { s.ReleasedRevision = e.Revision; s.First.TryAdd("release", e); }
                if (s.Revision == e.Revision) s.Release = e.Kind == "release_succeeded" ? "released" : "failed";
            }
            else if (e.Kind == "blocked") s.BlockReason = e.Reason;
            else if (e.Kind == "unblocked") s.BlockReason = null;
        }
        return s;
    }

    public static string Label(string status) => status switch
    {
        "complete" => "完成", "passed" => "通过", "released" => "已上线", "failed" => "失败",
        "stale" => "变更后待复验", "in_progress" => "有进展，完成未证实", _ => "未证实"
    };

    private static ReportEvidenceCitation Cite(ReportEvidenceEvent e) => new()
    { Id = e.Id, Uri = e.Source.Uri, Excerpt = e.Source.Excerpt, OccurredAt = e.OccurredAt, Kind = e.Kind, Revision = e.Revision };

    public static ReportDeliverySnapshot Build(ReportEvidenceLedger ledger, DateTime start, DateTime end)
    {
        var data = Merge(new[] { ledger });
        var (lo, hi) = Bounds(start, end);
        var events = data.Events.Where(e => e.OccurredAt < hi).ToList();
        var result = new ReportDeliverySnapshot { PeriodStart = start.Date, PeriodEnd = end.Date,
            InputDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(data, Json)))).ToLowerInvariant(),
            Limitations = data.Limitations.ToList(), NewMilestones = new() { ["code"] = data.HistoryComplete ? 0 : null, ["validation"] = data.HistoryComplete ? 0 : null, ["release"] = data.HistoryComplete ? 0 : null } };
        foreach (var work in data.WorkItems)
        {
            var history = events.Where(e => e.WorkItemId == work.Id).ToList();
            if (history.Count == 0) continue;
            var current = Replay(history);
            var previous = Replay(history.Where(e => e.OccurredAt < lo));
            var period = history.Where(e => e.OccurredAt >= lo).ToList();
            if (period.Count == 0 && current.Complete) continue;
            var milestones = current.First.Where(p => p.Value.OccurredAt >= lo && p.Value.TimeBasis == "occurred").Select(p => p.Key).ToList();
            foreach (var milestone in milestones) if (result.NewMilestones[milestone].HasValue) result.NewMilestones[milestone]++;
            result.Items.Add(new ReportDeliveryItem
            {
                Id = work.Id, Title = work.Title, Owner = work.Owner, NextStep = work.NextStep,
                Movement = history[0].OccurredAt >= lo ? "本期首次记录，不等于新增成果" : period.Count > 0 ? "延续推进" : "延续，本期无新证据",
                PreviousSummary = $"功能：{Label(previous.Code)}；验证：{Label(previous.Validation)}；上线：{Label(previous.Release)}",
                CodeStatus = current.Code, CodeLabel = Label(current.Code), ValidationStatus = current.Validation, ValidationLabel = Label(current.Validation),
                ReleaseStatus = current.Release, ReleaseLabel = Label(current.Release), Revision = current.Revision, BlockReason = current.BlockReason ?? (current.CiFailed ? "当前版本的 CI 测试失败；功能验收与正式上线仍需独立证据。" : null),
                Sources = history.Select(Cite).ToList(), NewMilestones = data.HistoryComplete ? milestones : new()
            });
        }
        result.Items = result.Items.OrderByDescending(i => i.BlockReason != null || i.ValidationStatus == "failed" || i.ReleaseStatus == "failed").ThenBy(i => i.Id, StringComparer.Ordinal).ToList();
        result.UnassignedEvidenceCount = events.Count(e => e.WorkItemId == null && e.OccurredAt >= lo);
        if (!data.HistoryComplete) result.Limitations.Add("事项历史覆盖尚未核实，不能把首次采到的记录计作本期新增成果。");
        if (result.UnassignedEvidenceCount > 0) result.Limitations.Add($"本期 {result.UnassignedEvidenceCount} 条来源尚未关联稳定事项，不计成果，也不按标题猜测归并。");
        if (result.Items.Count == 0) result.Limitations.Add("未采到可关联的工作事项；行为次数不能证明按计划推进、交付完成或没有风险。");
        result.Headline = result.Items.Count > 0 ? $"持续跟踪 {result.Items.Count} 个事项；功能、验证与上线分别以来源核查。" : "当前证据不足以判断交付成果或风险，需要补充工作事项来源。";
        result.Metrics.Add(new() { Key = "efficiency", Label = "效率变化", Text = "不可用：没有同口径测量，不从提交数、代码量或调用次数判断效率。" });
        var registered = events.Where(e => e.OccurredAt >= lo && e.RegisteredMinutes is > 0).ToList();
        result.Metrics.Add(new() { Key = "hours", Label = "已登记工时", Available = registered.Count > 0,
            Text = registered.Count > 0 ? $"本人明确登记 {registered.Sum(e => (long)e.RegisteredMinutes!.Value)} 分钟；仅代表这些记录，不是实际总工时。" : "不可用：没有明确工时登记，跨日跨度不是工时。", Sources = registered.Select(Cite).ToList() });
        result.Metrics.Add(new() { Key = "benefit", Label = "已实现收益", Text = "不可用：没有可核查的收益测量，预期价值不能当作已实现收益。" });
        result.Limitations = result.Limitations.Distinct().ToList();
        return result;
    }

    public static List<WeeklyReportSection> BuildSections(ReportTemplate template, ReportDeliverySnapshot snapshot, IEnumerable<string>? proposedOrder = null)
    {
        var order = (proposedOrder ?? Array.Empty<string>()).Distinct().ToList();
        var items = snapshot.Items.OrderBy(i => order.IndexOf(i.Id) < 0 ? int.MaxValue : order.IndexOf(i.Id)).ToList();
        var sections = template.Sections.Select(s => new WeeklyReportSection { TemplateSection = s }).ToList();
        var eligible = sections.Where(s => s.TemplateSection.SectionType is not (ReportSectionType.ManualList or ReportSectionType.FreeText)).ToList();
        if (eligible.Count == 0) return sections;
        var delivery = eligible.FirstOrDefault(s => !IsRisk(s) && !IsPlan(s) && !IsMetrics(s)) ?? eligible[0];
        var risk = eligible.FirstOrDefault(IsRisk);
        var plan = eligible.FirstOrDefault(IsPlan);
        var metrics = eligible.FirstOrDefault(IsMetrics);
        foreach (var item in items)
        {
            delivery.Items.Add(new WeeklyReportItem { Content = $"{item.Title}（{item.Movement}）：功能{item.CodeLabel}；验证{item.ValidationLabel}；上线{item.ReleaseLabel}。" + (item.BlockReason == null ? "" : $"风险：{item.BlockReason}。"), Source = "evidence", SourceRef = string.Join("\n", item.Sources.Select(s => s.Uri).Distinct()) });
            if (risk != null && risk != delivery && (item.BlockReason != null || item.ValidationStatus is "failed" or "stale" || item.ReleaseStatus == "failed"))
                risk.Items.Add(new() { Content = $"{item.Title}：{item.BlockReason ?? (item.ValidationStatus == "stale" ? "旧版本验证不能覆盖后续修改，需复验" : "验证或发布失败，需补闭环证据")}。", Source = "evidence", SourceRef = string.Join("\n", item.Sources.Select(s => s.Uri).Distinct()) });
            if (plan != null && plan != delivery && !string.IsNullOrWhiteSpace(item.NextStep))
                plan.Items.Add(new() { Content = $"{item.Title}：{item.NextStep}；执行人：{item.Owner ?? "待确认"}。", Source = "evidence", SourceRef = string.Join("\n", item.Sources.Select(s => s.Uri).Distinct()) });
        }
        if (items.Count == 0) delivery.Items.Add(new() { Content = snapshot.Headline, Source = "evidence-gap" });
        if (risk != null && risk != delivery && risk.Items.Count == 0)
            risk.Items.Add(new() { Content = "当前来源不足以判断是否存在其他风险；未采到风险记录不等于没有风险。", Source = "evidence-gap" });
        if (metrics != null && metrics != delivery)
            metrics.Items.AddRange(snapshot.Metrics.Select(m => new WeeklyReportItem { Content = $"{m.Label}：{m.Text}", Source = m.Available ? "evidence" : "evidence-gap", SourceRef = m.Sources.Count > 0 ? string.Join("\n", m.Sources.Select(s => s.Uri).Distinct()) : null }));
        return sections;
    }

    private static bool IsRisk(WeeklyReportSection s) => s.TemplateSection.Title.Contains("风险") || s.TemplateSection.Title.Contains("问题") || s.TemplateSection.Title.Contains("阻塞");
    private static bool IsPlan(WeeklyReportSection s) => s.TemplateSection.Title.Contains("计划") || s.TemplateSection.Title.Contains("下周") || s.TemplateSection.Title.Contains("待办");
    private static bool IsMetrics(WeeklyReportSection s) => s.TemplateSection.SectionType == ReportSectionType.AutoStats || s.TemplateSection.Title.Contains("指标") || s.TemplateSection.Title.Contains("效率") || s.TemplateSection.Title.Contains("工时");
}
