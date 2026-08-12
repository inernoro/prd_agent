using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 浏览器原生视频下载入口。只接受短时、资源级签名凭据，不接受用户身份明文。
/// </summary>
[ApiController]
[Route("api/video-download")]
public sealed class VideoDownloadController : ControllerBase
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly IVideoGenService _videoGenService;
    private readonly IAssetStorage _assetStorage;
    private readonly IDataProtector _ticketProtector;

    public VideoDownloadController(
        IVideoGenService videoGenService,
        IAssetStorage assetStorage,
        IDataProtectionProvider dataProtectionProvider)
    {
        _videoGenService = videoGenService;
        _assetStorage = assetStorage;
        _ticketProtector = dataProtectionProvider.CreateProtector(VideoDownloadTicket.ProtectorPurpose);
    }

    [AllowAnonymous]
    [HttpPost]
    [Consumes("application/x-www-form-urlencoded")]
    [Produces("video/mp4")]
    [ProducesResponseType(typeof(FileContentResult), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Download([FromForm] string? ticket, CancellationToken ct)
    {
        var payload = ReadTicket(ticket);
        if (payload == null || payload.ExpiresAt <= DateTime.UtcNow)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                "下载凭据已失效，请返回视频页面重新点击下载"));
        }

        var run = await _videoGenService.GetRunAsync(payload.RunId, payload.OwnerAdminId, ct: ct);
        if (run == null
            || run.Status != VideoGenRunStatus.Completed
            || string.IsNullOrWhiteSpace(run.VideoAssetSha256))
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                "视频文件暂时不可用，请返回视频页面重新生成后下载"));
        }

        var asset = await _assetStorage.TryReadByShaAsync(
            run.VideoAssetSha256,
            ct,
            domain: AppDomainPaths.DomainVideoAgent,
            type: AppDomainPaths.TypeVideo);
        if (asset == null || asset.Value.bytes.Length == 0)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                "视频文件暂时不可用，请返回视频页面重新生成后下载"));
        }

        return File(asset.Value.bytes, "video/mp4", $"video-{run.Id}.mp4");
    }

    private VideoDownloadTicket? ReadTicket(string? ticket)
    {
        if (string.IsNullOrWhiteSpace(ticket)) return null;
        try
        {
            return JsonSerializer.Deserialize<VideoDownloadTicket>(
                _ticketProtector.Unprotect(ticket),
                JsonOptions);
        }
        catch
        {
            return null;
        }
    }
}

internal sealed record VideoDownloadTicket(
    string RunId,
    string OwnerAdminId,
    DateTime ExpiresAt)
{
    internal const string ProtectorPurpose = "PrdAgent.VideoAgent.DownloadTicket.v1";
    internal static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);
}
