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
    private readonly IHttpClientFactory _httpClientFactory;

    public VideoDownloadController(
        IVideoGenService videoGenService,
        IAssetStorage assetStorage,
        IDataProtectionProvider dataProtectionProvider,
        IHttpClientFactory httpClientFactory)
    {
        _videoGenService = videoGenService;
        _assetStorage = assetStorage;
        _ticketProtector = dataProtectionProvider.CreateProtector(VideoDownloadTicket.ProtectorPurpose);
        _httpClientFactory = httpClientFactory;
    }

    [AllowAnonymous]
    [HttpPost]
    [Consumes("application/x-www-form-urlencoded")]
    [Produces("video/mp4")]
    [ProducesResponseType(StatusCodes.Status200OK)]
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

        var localAsset = await _assetStorage.TryOpenReadByShaAsync(
            run.VideoAssetSha256,
            ct,
            domain: AppDomainPaths.DomainVideoAgent,
            type: AppDomainPaths.TypeVideo);
        if (localAsset != null)
        {
            return File(
                localAsset.Content,
                "video/mp4",
                $"video-{run.Id}.mp4",
                enableRangeProcessing: true);
        }

        var assetUrl = _assetStorage.TryBuildUrlBySha(
            run.VideoAssetSha256,
            "video/mp4",
            domain: AppDomainPaths.DomainVideoAgent,
            type: AppDomainPaths.TypeVideo);
        if (!Uri.TryCreate(assetUrl, UriKind.Absolute, out var assetUri)
            || (assetUri.Scheme != Uri.UriSchemeHttps && assetUri.Scheme != Uri.UriSchemeHttp))
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                "视频文件暂时不可用，请返回视频页面重新生成后下载"));
        }

        using var upstream = await _httpClientFactory
            .CreateClient("AssetStorageStream")
            .GetAsync(assetUri, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!upstream.IsSuccessStatusCode)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                "视频文件暂时不可用，请返回视频页面重新生成后下载"));
        }

        Response.ContentType = "video/mp4";
        Response.ContentLength = upstream.Content.Headers.ContentLength;
        Response.Headers.ContentDisposition = new System.Net.Http.Headers.ContentDispositionHeaderValue("attachment")
        {
            FileName = $"video-{run.Id}.mp4",
            FileNameStar = $"video-{run.Id}.mp4",
        }.ToString();
        await using var stream = await upstream.Content.ReadAsStreamAsync(ct);
        await stream.CopyToAsync(Response.Body, 128 * 1024, ct);
        return new EmptyResult();
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
