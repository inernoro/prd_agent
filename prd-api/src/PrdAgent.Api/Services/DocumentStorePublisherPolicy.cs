using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

internal enum PublisherContentDecision
{
    Create,
    Noop,
    Update,
    Conflict,
}

/// <summary>
/// 知识库受控发布器的纯策略。标题不参与身份判断；受管身份只由 publisher + sourceId 决定。
/// </summary>
internal static partial class DocumentStorePublisherPolicy
{
    internal const string PublisherKey = "publisher";
    internal const string PublisherSchemaKey = "publisherSchema";
    internal const string SourceIdKey = "sourceId";
    internal const string SourcePathKey = "sourcePath";
    internal const string SourceSha256Key = "sourceSha256";
    internal const string ManifestSha256Key = "manifestSha256";
    internal const string SourceRevisionKey = "sourceRevision";
    internal const string KindKey = "kind";
    internal const string LastAppliedSha256Key = "lastAppliedSha256";
    internal const string CreatedByRunIdKey = "createdByRunId";
    internal const string LastAppliedRunIdKey = "lastAppliedRunId";
    internal const string DerivedStateKey = "publisherDerivedState";

    private static readonly HashSet<string> ReservedKeys = new(StringComparer.Ordinal)
    {
        PublisherKey,
        PublisherSchemaKey,
        SourceIdKey,
        SourcePathKey,
        SourceSha256Key,
        ManifestSha256Key,
        SourceRevisionKey,
        KindKey,
        LastAppliedSha256Key,
        CreatedByRunIdKey,
        LastAppliedRunIdKey,
        DerivedStateKey,
    };

    [GeneratedRegex("^[a-z0-9][a-z0-9._-]{1,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeTokenRegex();

    [GeneratedRegex("^[a-fA-F0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();

    internal static bool IsSafeToken(string? value)
        => !string.IsNullOrWhiteSpace(value) && SafeTokenRegex().IsMatch(value);

    internal static bool IsSha256(string? value)
        => !string.IsNullOrWhiteSpace(value) && Sha256Regex().IsMatch(value);

    internal static bool WouldCreateParentCycle(
        string entryId,
        string? targetParentId,
        IReadOnlyDictionary<string, string?> parentById)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal) { entryId };
        var cursor = targetParentId;
        while (!string.IsNullOrWhiteSpace(cursor))
        {
            if (!visited.Add(cursor)) return true;
            cursor = parentById.TryGetValue(cursor, out var parentId) ? parentId : null;
        }

        return false;
    }

    internal static bool HasIdentityConflicts(
        IReadOnlyList<DocumentEntry> entries,
        string publisher)
    {
        var publisherEntries = entries.Where(entry => entry.Metadata.TryGetValue(
                PublisherKey,
                out var marker)
            && string.Equals(marker, publisher, StringComparison.Ordinal)).ToList();
        if (publisherEntries.Any(entry => !entry.Metadata.TryGetValue(SourceIdKey, out var sourceId)
                                          || !IsSafeToken(sourceId)))
            return true;
        return publisherEntries
            .GroupBy(entry => entry.Metadata[SourceIdKey], StringComparer.Ordinal)
            .Any(group => group.Count() > 1);
    }

    internal static string Sha256(string content)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    internal static string MetadataSha256(IReadOnlyDictionary<string, string> metadata)
    {
        var canonical = string.Join("\n", metadata
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => $"{pair.Key.Length}:{pair.Key}:{pair.Value.Length}:{pair.Value}"));
        return Sha256(canonical);
    }

    internal static bool IsSafeMetadata(IReadOnlyDictionary<string, string>? metadata)
        => metadata == null || metadata.Count <= 64 && metadata.All(pair =>
            !string.IsNullOrWhiteSpace(pair.Key)
            && pair.Key.Length <= 128
            && !pair.Key.StartsWith('$')
            && !pair.Key.Contains('.')
            && pair.Value != null
            && pair.Value.Length <= 4096);

    internal static PublisherContentDecision Decide(
        bool exists,
        string? currentSha256,
        string? lastAppliedSha256,
        string targetSha256)
    {
        if (!exists) return PublisherContentDecision.Create;
        if (string.Equals(currentSha256, targetSha256, StringComparison.OrdinalIgnoreCase))
            return PublisherContentDecision.Noop;
        if (!string.IsNullOrWhiteSpace(lastAppliedSha256)
            && string.Equals(currentSha256, lastAppliedSha256, StringComparison.OrdinalIgnoreCase))
            return PublisherContentDecision.Update;
        return PublisherContentDecision.Conflict;
    }

    internal static Dictionary<string, string> MergeMetadata(
        IReadOnlyDictionary<string, string>? current,
        IReadOnlyDictionary<string, string>? requested,
        string publisher,
        string sourceId,
        string sourcePath,
        string sourceSha256,
        string manifestSha256,
        string sourceRevision,
        string kind,
        string? createdByRunId = null,
        string? lastAppliedRunId = null,
        string derivedState = "ready")
    {
        var merged = current == null
            ? new Dictionary<string, string>(StringComparer.Ordinal)
            : current.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);

        if (requested != null)
        {
            foreach (var pair in requested)
            {
                if (!ReservedKeys.Contains(pair.Key)) merged[pair.Key] = pair.Value;
            }
        }

        merged[PublisherKey] = publisher;
        merged[PublisherSchemaKey] = "1";
        merged[SourceIdKey] = sourceId;
        merged[SourcePathKey] = sourcePath;
        merged[SourceSha256Key] = sourceSha256;
        merged[ManifestSha256Key] = manifestSha256;
        merged[SourceRevisionKey] = sourceRevision;
        merged[KindKey] = kind;
        merged[LastAppliedSha256Key] = sourceSha256;
        if (!string.IsNullOrWhiteSpace(createdByRunId))
            merged[CreatedByRunIdKey] = createdByRunId;
        if (!string.IsNullOrWhiteSpace(lastAppliedRunId))
            merged[LastAppliedRunIdKey] = lastAppliedRunId;
        merged[DerivedStateKey] = derivedState;
        return merged;
    }

    internal static bool IsManagedBy(
        IReadOnlyDictionary<string, string>? metadata,
        string publisher,
        string sourceId)
        => metadata != null
           && metadata.TryGetValue(PublisherKey, out var actualPublisher)
           && metadata.TryGetValue(SourceIdKey, out var actualSourceId)
           && string.Equals(actualPublisher, publisher, StringComparison.Ordinal)
           && string.Equals(actualSourceId, sourceId, StringComparison.Ordinal);
}
