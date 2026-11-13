using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Assets;

public sealed class SpeechAssetProvider(MongoDbContext db, Microsoft.Extensions.Hosting.IHostEnvironment host) : IAssetProvider
{
    public string Source => "语音生成";
    public string[] SupportedCategories => ["audio"];

    public async Task<List<UnifiedAsset>> GetAssetsAsync(string userId, int limit, CancellationToken ct)
    {
        var environment = DeploymentScope.CurrentDurable ?? host.EnvironmentName;
        var runs = await db.SpeechRuns.Find(x => x.OwnerUserId == userId && x.Environment == environment
                && x.Status == SpeechRunStatus.Completed && x.AssetKey != null)
            .SortByDescending(x => x.CreatedAt).Limit(limit).ToListAsync(ct);
        return runs.Select(x => new UnifiedAsset
        {
            Id = $"speech-{x.Id}", Type = "audio", Title = x.Title, Source = Source,
            Summary = $"{x.ProfileName} · {x.VoiceId} · {x.CharacterCount}字 · {x.Format.ToUpperInvariant()}",
            Url = $"/api/mcp-speech/runs/{x.Id}/audio", Mime = x.Mime,
            SizeBytes = x.SizeBytes, CreatedAt = x.CreatedAt,
        }).ToList();
    }
}
