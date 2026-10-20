using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record HistoricalReleaseCandidate(string Id, string VCode, string PlanName);
public sealed record ReleaseHistoryCheck(bool Blocked, bool NeedsConfirmation, string Message,
    string? ConfirmationToken, IReadOnlyList<HistoricalReleaseCandidate> Candidates);

/// <summary>只读核对历史 V 表的 T 对照；确定编号优先，名称近似只提示，不改历史。</summary>
public static class ProductVersionHistoryLinks
{
    private static readonly Regex TNumber = new(@"(?<![A-Za-z0-9])T\d+\.\d+\.\d+(?!\d)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static HashSet<string> ExplicitTCodes(string? tCode, IReadOnlyDictionary<string, string>? legacyData, string? linkedTCode = null)
    {
        var values = new List<string?> { tCode, linkedTCode };
        if (legacyData != null)
            values.AddRange(legacyData.Where(pair => {
                var key = Regex.Replace(pair.Key, @"[\s\p{P}\p{S}]", "").ToLowerInvariant();
                return key.StartsWith("内部版本号", StringComparison.Ordinal)
                    || key is "t号" or "t立项号" or "立项号" or "关联t号" or "tcode";
            }).Select(pair => pair.Value));
        return values.Where(value => !string.IsNullOrWhiteSpace(value))
            .SelectMany(value => TNumber.Matches(value!).Select(match => match.Value.ToUpperInvariant())).ToHashSet();
    }

    public static async Task<ReleaseHistoryCheck> CheckAsync(MongoDbContext db, string productId, string applicationName,
        string tCode, string? planName)
    {
        var code = tCode.Trim().ToUpperInvariant();
        var initiations = await db.ProductInitiations.Find(x => x.ProductId == productId || x.AppName == applicationName).ToListAsync();
        var oldT = await db.VersionRegistrations.Find(x => x.Kind == VersionRegistrationKind.Internal && x.ApplicationName == applicationName).ToListAsync();
        var currentTitle = initiations.FirstOrDefault(x => !x.IsDeleted && x.TCode == code)?.PlanName
            ?? oldT.FirstOrDefault(x => x.Code == code)?.PlanName ?? planName;
        var sameTitleCodes = initiations.Where(x => !x.IsDeleted && ProductVersionPlanMatching.HistoricalTitlesEqual(currentTitle, x.PlanName))
            .Select(x => x.TCode).Concat(oldT.Where(x => ProductVersionPlanMatching.HistoricalTitlesEqual(currentTitle, x.PlanName)).Select(x => (string?)x.Code))
            .Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!.Trim().ToUpperInvariant()).Distinct().ToList();

        var releases = await db.ProductReleases.Find(x => !x.IsTemporaryOptimization && (x.ProductId == productId || x.AppName == applicationName)).ToListAsync();
        // 旧登记导入已把 V 表关联号保存到 TCode；只有产品历史记录保存 LegacyData。
        var legacy = await db.VersionRegistrations.Find(x => x.Kind == VersionRegistrationKind.Formal
            && x.ApplicationName == applicationName).ToListAsync();
        var evidence = releases.Select(x => new HistoryRow("product:" + x.Id, x.VCode, x.PlanName,
                ExplicitTCodes(x.TCode, x.LegacyData, initiations.FirstOrDefault(t => t.Id == x.InitiationId)?.TCode)))
            .Concat(legacy.Select(x => new HistoryRow("legacy:" + x.Id, x.Code, x.PlanName ?? string.Empty,
                    ExplicitTCodes(x.TCode, null, oldT.FirstOrDefault(t => t.Id == x.SourceInternalRegistrationId)?.Code)))).ToList();
        return Resolve(code, currentTitle, sameTitleCodes, evidence);
    }

    public sealed record HistoryRow(string Id, string VCode, string PlanName, HashSet<string> TCodes);

    public static ReleaseHistoryCheck Resolve(string tCode, string? planName, IReadOnlyList<string> sameTitleTCodes, IReadOnlyList<HistoryRow> rows)
    {
        var occupied = new List<HistoricalReleaseCandidate>();
        var uncertain = new List<HistoricalReleaseCandidate>();
        foreach (var row in rows)
        {
            var candidate = new HistoricalReleaseCandidate(row.Id, row.VCode, row.PlanName);
            if (row.TCodes.Contains(tCode)) {
                // V 表已有明确关系，即使标题不同也已占用；多编号冲突亦不能当作无关联。
                occupied.Add(candidate); continue;
            }
            if (row.TCodes.Count > 0) continue; // 明确关联另一个 T，名称不能覆盖编号。
            if (!ProductVersionPlanMatching.HistoricalTitlesSimilar(planName, row.PlanName)) continue;
            if (ProductVersionPlanMatching.HistoricalTitlesEqual(planName, row.PlanName)
                && sameTitleTCodes.Count == 1 && sameTitleTCodes[0] == tCode) occupied.Add(candidate);
            else uncertain.Add(candidate);
        }
        if (occupied.Count > 0)
            return new(true, false, $"历史 V 表已关联该 T，不能重复申领：{string.Join("；", occupied.Select(x => x.VCode + "「" + x.PlanName + "」"))}", null, occupied);
        if (uncertain.Count == 0) return new(false, false, "未发现已占用或待确认的历史 V 对照", null, uncertain);
        var token = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new {
            tCode, planName, rows = uncertain.OrderBy(x => x.Id).ToArray(),
        }))));
        return new(false, true, "历史 V 表有相近方案，但缺少明确 T 对照。请核对后确认是否为不同方案。", token, uncertain);
    }

}
