using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.LogicalModels;

public static class LogicalModelCapabilityPolicy
{
    public const string ImageGeneration = "image_generation";

    public static readonly IReadOnlyList<string> ImageScenarioCapabilities =
        ["text2img", "img2img", "vision_generation"];

    public static List<string> Normalize(string? modelType, IEnumerable<string>? capabilities)
    {
        var normalized = (capabilities ?? [])
            .Select(x => x?.Trim().ToLowerInvariant() ?? string.Empty)
            .Where(x => x.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        if (!string.Equals(modelType?.Trim(), "generation", StringComparison.OrdinalIgnoreCase)
            || !normalized.Contains(ImageGeneration, StringComparer.Ordinal)
            || normalized.Any(IsImageScenarioCapability))
        {
            return normalized;
        }

        normalized.AddRange(ImageScenarioCapabilities);
        return normalized;
    }

    public static async Task<long> BackfillLegacyGenerationModelsAsync(
        IMongoCollection<BsonDocument> logicalModels,
        CancellationToken ct)
    {
        var update = Builders<BsonDocument>.Update.Combine(
            Builders<BsonDocument>.Update.AddToSetEach("Capabilities", ImageScenarioCapabilities),
            Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));
        var result = await logicalModels.UpdateManyAsync(
            BuildLegacyGenerationModelsFilter(),
            update,
            cancellationToken: ct);
        return result.ModifiedCount;
    }

    public static BsonDocument BuildLegacyGenerationModelsFilter()
        => new()
        {
            ["ModelType"] = "generation",
            ["Capabilities"] = new BsonDocument
            {
                ["$in"] = new BsonArray { ImageGeneration },
                ["$nin"] = new BsonArray(ImageScenarioCapabilities),
            },
        };

    private static bool IsImageScenarioCapability(string capability)
        => ImageScenarioCapabilities.Contains(capability, StringComparer.Ordinal);
}
