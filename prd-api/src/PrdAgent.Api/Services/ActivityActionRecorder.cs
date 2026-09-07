using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Api.Filters;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public interface IActivityActionRecorder
{
    Task<bool> RecordHttpAsync(
        ActivityActionDef definition,
        string action,
        string actorId,
        string? targetId,
        string? targetTitle,
        string method,
        string path,
        CancellationToken ct = default);

    Task<bool> RecordDomainAsync(
        string action,
        string actorId,
        string targetId,
        string? targetTitle,
        string deduplicationKey,
        DateTime occurredAt,
        CancellationToken ct = default);
}

/// <summary>
/// HTTP 动作与后台领域事实共用的团队动态写入器。
/// 后台动作必须由 DomainActions 声明并携带唯一幂等键；写入内容仅限展示元数据。
/// </summary>
public sealed class ActivityActionRecorder : IActivityActionRecorder
{
    internal const int MaxDisplayTextLength = 200;
    internal const int MaxDeduplicationKeyLength = 200;
    private static readonly Regex BearerSecret = new(
        @"\bBearer\s+[A-Za-z0-9._~+/=-]+",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));
    private static readonly Regex AssignedSecret = new(
        @"\b(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|password|secret|cookie|set-cookie)\b\s*[:=]\s*(?:Bearer\s+)?(?:[\""'][^\""'\r\n]*[\""']|[^\s,;}\]]+)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));
    private static readonly Regex OpenAiStyleSecret = new(
        @"\bsk-[A-Za-z0-9_-]{8,}\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));

    private readonly MongoDbContext _db;

    public ActivityActionRecorder(MongoDbContext db)
    {
        _db = db;
    }

    public async Task<bool> RecordHttpAsync(
        ActivityActionDef definition,
        string action,
        string actorId,
        string? targetId,
        string? targetTitle,
        string method,
        string path,
        CancellationToken ct = default)
    {
        var entry = BuildEntry(
            definition,
            action,
            actorId,
            targetId,
            targetTitle,
            method,
            path,
            null,
            DateTime.UtcNow);
        await _db.ActivityLogs.InsertOneAsync(entry, cancellationToken: ct);
        return true;
    }

    public async Task<bool> RecordDomainAsync(
        string action,
        string actorId,
        string targetId,
        string? targetTitle,
        string deduplicationKey,
        DateTime occurredAt,
        CancellationToken ct = default)
    {
        if (!ActivityActionRegistry.DomainActions.TryGetValue(action, out var definition))
            throw new InvalidOperationException("未登记的领域动态动作");
        var normalizedKey = (deduplicationKey ?? string.Empty).Trim();
        if (normalizedKey.Length == 0 || normalizedKey.Length > MaxDeduplicationKeyLength)
            throw new InvalidOperationException("领域动态幂等键格式不正确");

        var entry = BuildEntry(
            definition,
            action,
            actorId,
            targetId,
            targetTitle,
            "DOMAIN",
            "design-artifact/generated-site-published",
            normalizedKey,
            occurredAt);
        try
        {
            var result = await _db.ActivityLogs.UpdateOneAsync(
                item => item.DeduplicationKey == normalizedKey,
                Builders<ActivityLog>.Update
                    .SetOnInsert(item => item.Id, entry.Id)
                    .SetOnInsert(item => item.ActorId, entry.ActorId)
                    .SetOnInsert(item => item.Module, entry.Module)
                    .SetOnInsert(item => item.ModuleLabel, entry.ModuleLabel)
                    .SetOnInsert(item => item.Action, entry.Action)
                    .SetOnInsert(item => item.ActionLabel, entry.ActionLabel)
                    .SetOnInsert(item => item.TargetId, entry.TargetId)
                    .SetOnInsert(item => item.TargetTitle, entry.TargetTitle)
                    .SetOnInsert(item => item.TargetUrl, entry.TargetUrl)
                    .SetOnInsert(item => item.Method, entry.Method)
                    .SetOnInsert(item => item.Path, entry.Path)
                    .SetOnInsert(item => item.DeduplicationKey, entry.DeduplicationKey)
                    .SetOnInsert(item => item.CreatedAt, entry.CreatedAt),
                new UpdateOptions { IsUpsert = true },
                ct);
            if (result.UpsertedId != null) return true;
            await EnsureDeduplicationIdentityAsync(normalizedKey, entry, ct);
            return false;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            await EnsureDeduplicationIdentityAsync(normalizedKey, entry, ct);
            return false;
        }
    }

    private async Task EnsureDeduplicationIdentityAsync(
        string deduplicationKey,
        ActivityLog expected,
        CancellationToken ct)
    {
        var existing = await _db.ActivityLogs
            .Find(item => item.DeduplicationKey == deduplicationKey)
            .FirstOrDefaultAsync(ct)
            ?? throw new InvalidOperationException("领域动态幂等记录不存在");
        if (!string.Equals(existing.Action, expected.Action, StringComparison.Ordinal)
            || !string.Equals(existing.ActorId, expected.ActorId, StringComparison.Ordinal)
            || !string.Equals(existing.TargetId, expected.TargetId, StringComparison.Ordinal)
            || !string.Equals(existing.Method, expected.Method, StringComparison.Ordinal)
            || !string.Equals(existing.Path, expected.Path, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("领域动态幂等键与既有事实不一致");
        }
    }

    private static ActivityLog BuildEntry(
        ActivityActionDef definition,
        string action,
        string actorId,
        string? targetId,
        string? targetTitle,
        string method,
        string path,
        string? deduplicationKey,
        DateTime occurredAt)
    {
        var normalizedActor = RequiredBounded(actorId, nameof(actorId));
        var normalizedAction = RequiredBounded(action, nameof(action));
        var normalizedTarget = OptionalBounded(targetId);
        return new ActivityLog
        {
            ActorId = normalizedActor,
            Module = definition.Module,
            ModuleLabel = definition.ModuleLabel,
            Action = normalizedAction,
            ActionLabel = definition.ActionLabel,
            TargetId = normalizedTarget,
            TargetTitle = OptionalBounded(targetTitle),
            Method = RequiredBounded(method, nameof(method)),
            Path = RequiredBounded(path, nameof(path)),
            DeduplicationKey = deduplicationKey,
            CreatedAt = occurredAt.Kind == DateTimeKind.Utc ? occurredAt : occurredAt.ToUniversalTime(),
        };
    }

    private static string RequiredBounded(string? value, string field)
    {
        var normalized = OptionalBounded(value);
        return normalized ?? throw new InvalidOperationException($"团队动态字段 {field} 不能为空");
    }

    private static string? OptionalBounded(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = value.Replace('\r', ' ').Replace('\n', ' ').Trim();
        normalized = BearerSecret.Replace(normalized, "Bearer ***");
        normalized = AssignedSecret.Replace(normalized, "$1=***");
        normalized = OpenAiStyleSecret.Replace(normalized, "***");
        return normalized.Length <= MaxDisplayTextLength
            ? normalized
            : normalized[..MaxDisplayTextLength];
    }
}
