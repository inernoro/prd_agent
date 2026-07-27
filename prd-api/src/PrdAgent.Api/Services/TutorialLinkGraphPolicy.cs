using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

internal static class TutorialLinkGraphPolicy
{
    internal const int CurrentSchemaVersion = 2;
    internal const int MaxSurfaces = 200;
    internal const int MaxVersions = 50;

    internal static string? ValidateShape(TutorialLinkGraphRevision graph)
    {
        if (graph.SchemaVersion != CurrentSchemaVersion)
            return $"schemaVersion 必须为 {CurrentSchemaVersion}";
        if (string.IsNullOrWhiteSpace(graph.SourceRevision) || graph.SourceRevision.Length > 256)
            return "sourceRevision 不能为空且不能超过 256 个字符";
        if (!DocumentStorePublisherPolicy.IsSha256(graph.ManifestSha256))
            return "manifestSha256 无效";
        if (string.IsNullOrWhiteSpace(graph.VerifiedAtCommit) || graph.VerifiedAtCommit.Length > 64)
            return "verifiedAtCommit 不能为空且不能超过 64 个字符";
        if (graph.GeneratedAt == default)
            return "generatedAt 不能为空";
        if (graph.Surfaces.Count is < 1 or > MaxSurfaces)
            return $"surfaces 数量必须在 1 到 {MaxSurfaces} 之间";

        var surfaceIds = new HashSet<string>(StringComparer.Ordinal);
        var routes = new HashSet<string>(StringComparer.Ordinal);
        foreach (var surface in graph.Surfaces)
        {
            if (!DocumentStorePublisherPolicy.IsSafeToken(surface.Id) || !surfaceIds.Add(surface.Id))
                return $"页面标识无效或重复：{surface.Id}";
            if (string.IsNullOrWhiteSpace(surface.PagePath) || surface.PagePath.Length > 2048)
                return $"页面 {surface.Id} 的 pagePath 无效";
            if (surface.Routes.Count == 0)
                return $"页面 {surface.Id} 至少需要一个 route";
            foreach (var route in surface.Routes)
            {
                if (string.IsNullOrWhiteSpace(route) || route.Length > 512 || !route.StartsWith('/'))
                    return $"页面 {surface.Id} 包含无效 route";
                if (!routes.Add(route)) return $"route 重复：{route}";
            }

            if (surface.TutorialSourceIds.Count == 0)
                return $"页面 {surface.Id} 没有关联教程";
            var sourceIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var sourceId in surface.TutorialSourceIds)
            {
                if (!DocumentStorePublisherPolicy.IsSafeToken(sourceId) || !sourceIds.Add(sourceId))
                    return $"页面 {surface.Id} 的教程 sourceId 无效或重复：{sourceId}";
            }

            var linkedSources = new HashSet<string>(StringComparer.Ordinal);
            foreach (var link in surface.TutorialLinks)
            {
                if (!sourceIds.Contains(link.SourceId))
                    return $"页面 {surface.Id} 的步骤链接引用了未关联教程：{link.SourceId}";
                if (!linkedSources.Add(link.SourceId))
                    return $"页面 {surface.Id} 的步骤链接重复：{link.SourceId}";
                if (link.StepIds.Count == 0 || link.StepIds.Any(stepId => !DocumentStorePublisherPolicy.IsSafeToken(stepId)))
                    return $"页面 {surface.Id} 的步骤标识无效";
                if (link.StepIds.Distinct(StringComparer.Ordinal).Count() != link.StepIds.Count)
                    return $"页面 {surface.Id} 的步骤标识重复";
                if (link.EvidenceIds.Count == 0
                    || link.EvidenceIds.Any(value => string.IsNullOrWhiteSpace(value) || value.Length > 256))
                    return $"页面 {surface.Id} 的步骤链接缺少验收证据";
                if (link.EvidenceIds.Distinct(StringComparer.Ordinal).Count() != link.EvidenceIds.Count)
                    return $"页面 {surface.Id} 的验收证据重复";
            }
        }

        return null;
    }

    internal static string ComputeSha256(TutorialLinkGraphRevision graph)
    {
        var canonical = new
        {
            schemaVersion = graph.SchemaVersion,
            graph.SourceRevision,
            manifestSha256 = graph.ManifestSha256.ToLowerInvariant(),
            graph.VerifiedAtCommit,
            generatedAt = graph.GeneratedAt.ToUniversalTime().ToString("O"),
            surfaces = graph.Surfaces.OrderBy(surface => surface.Id, StringComparer.Ordinal).Select(surface => new
            {
                surface.Id,
                surface.Label,
                routes = surface.Routes.OrderBy(value => value, StringComparer.Ordinal),
                surface.PagePath,
                changeSources = surface.ChangeSources.OrderBy(value => value, StringComparer.Ordinal),
                tutorialSourceIds = surface.TutorialSourceIds.OrderBy(value => value, StringComparer.Ordinal),
                tutorialLinks = surface.TutorialLinks.OrderBy(link => link.SourceId, StringComparer.Ordinal).Select(link => new
                {
                    link.SourceId,
                    stepIds = link.StepIds.OrderBy(value => value, StringComparer.Ordinal),
                    evidenceIds = link.EvidenceIds.OrderBy(value => value, StringComparer.Ordinal),
                    impact = link.Impact.OrderBy(value => value, StringComparer.Ordinal),
                }),
                anchors = surface.Anchors.OrderBy(anchor => anchor.Name, StringComparer.Ordinal).Select(anchor => new
                {
                    anchor.Name,
                    anchor.Product,
                    anchor.Tutorial,
                }),
            }),
        };
        return DocumentStorePublisherPolicy.Sha256(JsonSerializer.Serialize(canonical));
    }

    internal static TutorialLinkGraphRevision PrepareRevision(TutorialLinkGraphRevision source, string actor)
    {
        source.GraphSha256 = ComputeSha256(source);
        source.SavedAt = DateTime.UtcNow;
        source.SavedBy = actor;
        return source;
    }
}