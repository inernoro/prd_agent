namespace PrdAgent.Infrastructure.Services.AssetStorage;

public static class TencentCosStorageBase64Extensions
{
    /// <summary>
    /// 上传 base64 或 dataUrl（data:*;base64,xxx）到指定 key，返回可访问 URL。
    /// </summary>
    public static async Task<string> UploadBase64Async(
        this TencentCosStorage cos,
        string key,
        string base64OrDataUrl,
        string? contentType,
        CancellationToken ct)
    {
        if (cos == null) throw new ArgumentNullException(nameof(cos));
        if (!TryDecodeDataUrlOrBase64(base64OrDataUrl, contentType, out var mime, out var bytes))
        {
            throw new ArgumentException("base64/dataUrl 格式无效", nameof(base64OrDataUrl));
        }

        await cos.UploadBytesAsync(key, bytes, mime, ct).ConfigureAwait(false);
        return cos.BuildPublicUrl(key);
    }

    /// <summary>
    /// 下载对象并转为 base64（可选输出为 dataUrl）。
    /// </summary>
    public static async Task<string?> DownloadAsBase64Async(
        this TencentCosStorage cos,
        string key,
        bool asDataUrl,
        CancellationToken ct)
    {
        if (cos == null) throw new ArgumentNullException(nameof(cos));
        var bytes = await cos.TryDownloadBytesAsync(key, ct).ConfigureAwait(false);
        if (bytes == null || bytes.Length == 0) return null;

        var b64 = Convert.ToBase64String(bytes);
        if (!asDataUrl) return b64;

        // 这里无法可靠获知 Content-Type（除非额外 Head 取 meta）；调用方若需要严格 mime，可自行维护。
        return $"data:application/octet-stream;base64,{b64}";
    }

    private static bool TryDecodeDataUrlOrBase64(string raw, string? fallbackMime, out string mime, out byte[] bytes)
    {
        mime = string.IsNullOrWhiteSpace(fallbackMime) ? "application/octet-stream" : fallbackMime.Trim();
        bytes = Array.Empty<byte>();

        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return false;

        if (s.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = s.IndexOf(',');
            if (comma < 0) return false;
            var header = s.Substring(5, comma - 5);
            var payload = s[(comma + 1)..];
            var semi = header.IndexOf(';');
            var ct = semi >= 0 ? header[..semi] : header;
            if (!string.IsNullOrWhiteSpace(ct)) mime = ct.Trim();
            s = payload.Trim();
        }

        try
        {
            bytes = Convert.FromBase64String(s);
            return bytes.Length > 0;
        }
        catch
        {
            return false;
        }
    }
}


