using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

[ApiController]
[Authorize]
public class ModelSizesController : ControllerBase
{
    private readonly MongoDbContext _db;

    public ModelSizesController(MongoDbContext db)
    {
        _db = db;
    }

    [HttpGet("/api/model/{modelKey}/sizes")]
    [HttpGet("/api/v1/model/{modelKey}/sizes")]
    public async Task<IActionResult> GetSizes([FromRoute] string modelKey, CancellationToken ct)
    {
        var sizes = await ResolveSizesAsync(modelKey, ct);
        return Ok(ApiResponse<object>.Ok(new { modelKey, sizes }));
    }

    private async Task<IReadOnlyList<ModelSizeInfo>> ResolveSizesAsync(string modelKey, CancellationToken ct)
    {
        var key = (modelKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(key)) return DefaultSizes();

        ImageGenSizeCaps? caps = null;
        var model = await _db.LLMModels.Find(x => x.Id == key || x.ModelName == key || x.Name == key).FirstOrDefaultAsync(ct);
        if (model != null)
        {
            caps = await _db.ImageGenSizeCaps.Find(x => x.ModelId == model.Id).FirstOrDefaultAsync(ct);
        }
        if (caps == null)
        {
            caps = await _db.ImageGenSizeCaps.Find(x => x.ModelName == key.ToLowerInvariant()).FirstOrDefaultAsync(ct);
        }

        if (caps?.AllowedSizes != null && caps.AllowedSizes.Count > 0)
        {
            var parsed = new List<ModelSizeInfo>();
            foreach (var size in caps.AllowedSizes)
            {
                if (TryParseSize(size, out var w, out var h))
                {
                    parsed.Add(BuildSize(w, h));
                }
            }
            if (parsed.Count > 0) return parsed;
        }

        return DefaultSizes();
    }

    private static bool TryParseSize(string? raw, out int w, out int h)
    {
        w = 0;
        h = 0;
        var s = (raw ?? string.Empty).Trim().ToLowerInvariant();
        var parts = s.Split('x', '×');
        if (parts.Length != 2) return false;
        return int.TryParse(parts[0], out w) && int.TryParse(parts[1], out h) && w > 0 && h > 0;
    }

    private static ModelSizeInfo BuildSize(int w, int h)
    {
        var ratio = Math.Round(w / (double)h, 4);
        return new ModelSizeInfo
        {
            Width = w,
            Height = h,
            Ratio = ratio,
            Label = $"{w}x{h}"
        };
    }

    private static IReadOnlyList<ModelSizeInfo> DefaultSizes()
    {
        return new List<ModelSizeInfo>
        {
            BuildSize(1024, 1024),
            BuildSize(1536, 1024),
            BuildSize(1024, 1536),
            BuildSize(1344, 768),
            BuildSize(768, 1344),
            BuildSize(1600, 900),
            BuildSize(900, 1600)
        };
    }
}
