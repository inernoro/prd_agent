using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers;

[ApiController]
[Authorize]
public class WatermarkController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly WatermarkFontRegistry _fontRegistry;
    private readonly ILogger<WatermarkController> _logger;

    public WatermarkController(MongoDbContext db, WatermarkFontRegistry fontRegistry, ILogger<WatermarkController> logger)
    {
        _db = db;
        _fontRegistry = fontRegistry;
        _logger = logger;
    }

    [HttpGet("/api/user/watermark")]
    [HttpGet("/api/v1/user/watermark")]
    public async Task<IActionResult> GetWatermark(CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var doc = await _db.WatermarkSettings.Find(x => x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (doc == null)
        {
            var def = BuildDefaultSpec();
            return Ok(ApiResponse<WatermarkSettings>.Ok(new WatermarkSettings
            {
                OwnerUserId = userId,
                Enabled = def.Enabled,
                Spec = def,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            }));
        }

        if (doc.Spec != null)
        {
            doc.Spec.Enabled = doc.Enabled;
        }

        return Ok(ApiResponse<WatermarkSettings>.Ok(doc));
    }

    [HttpPut("/api/user/watermark")]
    [HttpPut("/api/v1/user/watermark")]
    public async Task<IActionResult> PutWatermark([FromBody] PutWatermarkRequest request, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        if (request?.Spec == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "spec 不能为空"));
        }

        var spec = request.Spec;
        var (ok, message) = WatermarkSpecValidator.Validate(spec, _fontRegistry.FontKeys);
        if (!ok)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, message ?? "水印配置无效"));
        }

        spec.Enabled = request.Spec.Enabled;

        var now = DateTime.UtcNow;
        var update = Builders<WatermarkSettings>.Update
            .Set(x => x.OwnerUserId, userId)
            .Set(x => x.Enabled, spec.Enabled)
            .Set(x => x.Spec, spec)
            .Set(x => x.UpdatedAt, now)
            .SetOnInsert(x => x.CreatedAt, now);

        var options = new FindOneAndUpdateOptions<WatermarkSettings>
        {
            IsUpsert = true,
            ReturnDocument = ReturnDocument.After
        };

        var saved = await _db.WatermarkSettings.FindOneAndUpdateAsync(
            Builders<WatermarkSettings>.Filter.Eq(x => x.OwnerUserId, userId),
            update,
            options,
            ct);

        return Ok(ApiResponse<WatermarkSettings>.Ok(saved));
    }

    [HttpGet("/api/watermark/fonts")]
    [HttpGet("/api/v1/watermark/fonts")]
    public IActionResult GetFonts()
    {
        var fonts = _fontRegistry.BuildFontInfos(fontKey => $"/api/watermark/fonts/{Uri.EscapeDataString(fontKey)}/file");
        return Ok(ApiResponse<IReadOnlyList<WatermarkFontInfo>>.Ok(fonts));
    }

    [AllowAnonymous]
    [HttpGet("/api/watermark/fonts/{fontKey}/file")]
    [HttpGet("/api/v1/watermark/fonts/{fontKey}/file")]
    public IActionResult GetFontFile([FromRoute] string fontKey)
    {
        var path = _fontRegistry.TryResolveFontFile(fontKey);
        if (string.IsNullOrWhiteSpace(path)) return NotFound();
        var fileName = Path.GetFileName(path);
        var mime = "font/ttf";
        if (fileName.EndsWith(".otf", StringComparison.OrdinalIgnoreCase)) mime = "font/otf";
        if (fileName.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase)) mime = "font/woff2";
        return PhysicalFile(path, mime);
    }

    private WatermarkSpec BuildDefaultSpec()
    {
        var fontKey = _fontRegistry.FontKeys.FirstOrDefault() ?? _fontRegistry.DefaultFontKey;
        return new WatermarkSpec
        {
            Enabled = false,
            Text = "米多AI生成",
            FontKey = fontKey,
            FontSizePx = 28,
            Opacity = 0.6,
            PositionMode = "pixel",
            Anchor = "bottom-right",
            OffsetX = 24,
            OffsetY = 24,
            IconEnabled = false,
            IconImageRef = null,
            BaseCanvasWidth = 320,
            ModelKey = "default",
            Color = "#FFFFFF"
        };
    }

    private static string? GetUserId(ClaimsPrincipal user)
    {
        return user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
            ?? user.FindFirst("sub")?.Value
            ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
            ?? user.FindFirst("nameid")?.Value;
    }
}
