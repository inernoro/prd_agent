using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Services;

internal static class TranscriptAsrCandidatePolicy
{
    internal const int MaxCandidates = 3;
    internal const int ChatValidationAttemptsPerCandidate = 4;

    internal static IReadOnlyList<ModelResolutionResult> SelectCandidates(
        ModelResolutionResult primary)
    {
        return new[] { primary }
            .Concat(primary.RetryCandidates ?? [])
            .Where(candidate => candidate.Success)
            .GroupBy(CandidateKey, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .Take(MaxCandidates)
            .ToList();
    }

    private static string CandidateKey(ModelResolutionResult candidate)
    {
        if (!string.IsNullOrWhiteSpace(candidate.OfferingId))
            return $"offering:{candidate.OfferingId.Trim()}";

        return string.Join("::", new[]
        {
            candidate.ActualPlatformId?.Trim(),
            candidate.ActualModel?.Trim(),
            candidate.ExchangeId?.Trim(),
            candidate.ExchangeTransformerType?.Trim(),
        });
    }
}
