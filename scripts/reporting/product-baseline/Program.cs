using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services.ReportAgent;

// FrozenReportGenerationService is produced mechanically by replay_product_baseline.py
// from git show of the immutable old source. No legacy algorithm is reimplemented here.
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true };
var inputPath = args[0];
var outputPath = args[1];
using var input = JsonDocument.Parse(File.ReadAllText(inputPath));
var root = input.RootElement;
var fixture = root.GetProperty("cases");
var outputs = new List<object>();
var oldType = typeof(FrozenReportGenerationService);
var prefsType = oldType.GetNestedType("GenerationSourcePrefs", BindingFlags.NonPublic)!;
var fallback = oldType.GetMethod("BuildRuleBasedSections", BindingFlags.Static | BindingFlags.NonPublic)!;
var parse = oldType.GetMethod("ParseGeneratedSections", BindingFlags.Instance | BindingFlags.NonPublic)!;
var prompt = oldType.GetMethod("BuildUserPrompt", BindingFlags.Static | BindingFlags.NonPublic)!;
var old = new FrozenReportGenerationService(null!, null!, null!, NullLogger<FrozenReportGenerationService>.Instance, null!, null!, null!);
foreach (var sample in fixture.EnumerateArray())
{
    var template = sample.GetProperty("template").Deserialize<ReportTemplate>(json)!;
    var activity = sample.GetProperty("activity").Deserialize<CollectedActivity>(json)!;
    activity.EvidenceLedger = sample.GetProperty("ledger").Deserialize<ReportEvidenceLedger>(json)!;
    var prefsJson = sample.GetProperty("sourcePrefs");
    var prefs = Activator.CreateInstance(prefsType, new object[] { prefsJson.GetProperty("dailyLogEnabled").GetBoolean(), prefsJson.GetProperty("mapPlatformEnabled").GetBoolean() })!;
    var year = sample.GetProperty("weekYear").GetInt32();
    var week = sample.GetProperty("weekNumber").GetInt32();
    var effectivePrompt = sample.TryGetProperty("effectivePrompt", out var effective) ? effective.GetString() ?? "" : "";
    var actualOldPrompt = (string)prompt.Invoke(null, new object[] { template, activity, year, week, prefs, effectivePrompt })!;
    var upstreamMode = sample.GetProperty("upstreamMode").GetString();
    List<WeeklyReportSection>? oldSections = null;
    if (upstreamMode == "captured-model-response")
        oldSections = (List<WeeklyReportSection>?)parse.Invoke(old, new object[] { sample.GetProperty("capturedResponse").GetString()!, template });
    var usedFallback = oldSections == null || oldSections.Sum(s => s.Items.Count) == 0;
    if (usedFallback)
        oldSections = (List<WeeklyReportSection>?)fallback.Invoke(null, new object[] { template, activity, prefs, year, week });
    // Same collection-to-ledger function used by both product v1 and v2 generation.
    var ledger = ReportEvidenceService.FromActivity(activity, null,
        prefsJson.GetProperty("dailyLogEnabled").GetBoolean(), prefsJson.GetProperty("mapPlatformEnabled").GetBoolean());
    var start = sample.GetProperty("start").GetDateTime();
    var end = sample.GetProperty("end").GetDateTime();
    var currentSnapshot = ReportEvidenceEngine.Build(ledger, start, end);
    var proposedOrder = ReportEvidenceService.ParseProposedOrder(
        upstreamMode == "captured-model-response" ? sample.GetProperty("capturedResponse").GetString() : null, currentSnapshot);
    var currentSections = ReportEvidenceEngine.BuildSections(template, currentSnapshot, proposedOrder);
    var caseDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sample.GetRawText()))).ToLowerInvariant();
    outputs.Add(new
    {
        id = sample.GetProperty("id").GetString(),
        inputDigest = caseDigest,
        upstreamMode,
        old = new { usedFallback, sections = oldSections, prompt = actualOldPrompt,
            originalPromptMatch = sample.TryGetProperty("capturedUserPrompt", out var capturedPrompt) ? actualOldPrompt == capturedPrompt.GetString() : (bool?)null },
        current = new { sections = currentSections, snapshot = currentSnapshot },
        note = upstreamMode == "captured-model-response"
            ? "旧模型输出为真实历史响应回放，不是本次重新调用模型；新正文与生产相同的事实引擎生成。"
            : "在同一冻结输入上，直接运行真实旧规则回退方法与生产使用的新证据引擎；上游失败档不作为模型质量改进率。"
    });
}
File.WriteAllText(outputPath, JsonSerializer.Serialize(new
{
    baseline = root.GetProperty("baseline"),
    sampleInputDigest = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(inputPath))).ToLowerInvariant(),
    outputs
}, json));
Console.WriteLine($"真实旧源与当前引擎已回放 {outputs.Count} 个固定输入，完整章节与来源已保存。");
