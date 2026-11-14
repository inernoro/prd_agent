using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>媒体进程只消费本地文件；采用版本优先从配置存储按完整摘要读取。</summary>
public static class VideoSceneMedia
{
    public static string? AssetSha(VideoGenScene scene)
    {
        var version = scene.Versions.FirstOrDefault(item => item.Id == scene.ActiveVersionId && item.VideoUrl == scene.VideoUrl)
            ?? (scene.ActiveVersionId == null ? scene.Versions.FirstOrDefault(item => item.VideoUrl == scene.VideoUrl) : null);
        var sha = version?.AssetSha256;
        return sha?.Length == 64 && sha.All(Uri.IsHexDigit) ? sha : null;
    }

    public static async Task CopyToFileAsync(IAssetStorage storage, HttpClient client, VideoGenScene scene,
        string path, long maxBytes, CancellationToken ct, bool allowLegacyHttps = false)
    {
        var sha = AssetSha(scene);
        if (sha != null)
        {
            var local = await storage.TryOpenReadByShaAsync(sha, ct, AppDomainPaths.DomainVideoAgent, AppDomainPaths.TypeVideo);
            if (local != null)
            {
                await using var input = local.Content;
                await CopyBoundedAsync(input, path, maxBytes, local.Length, ct);
                return;
            }
        }
        // 远端地址只能由配置存储根据摘要生成；旧任务显式沿既有 HTTPS 路径处理。
        var source = sha == null ? (allowLegacyHttps ? scene.VideoUrl : null)
            : storage.TryBuildUrlBySha(sha, "video/mp4", AppDomainPaths.DomainVideoAgent, AppDomainPaths.TypeVideo);
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("采用的视频素材暂不可用或缺少持久资产标识，请重新导入本镜素材后再导出。");
        using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        await CopyBoundedAsync(stream, path, maxBytes, response.Content.Headers.ContentLength, ct);
    }

    private static async Task CopyBoundedAsync(Stream input, string path, long maxBytes, long? length, CancellationToken ct)
    {
        if (length > maxBytes) throw new InvalidOperationException("视频素材超过大小限制，请更换本镜素材后重试。");
        await using var output = File.Create(path);
        var buffer = new byte[81920];
        long total = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer, ct);
            if (read == 0) break;
            total += read;
            if (total > maxBytes) throw new InvalidOperationException("视频素材超过大小限制，请更换本镜素材后重试。");
            await output.WriteAsync(buffer.AsMemory(0, read), ct);
        }
    }
}
