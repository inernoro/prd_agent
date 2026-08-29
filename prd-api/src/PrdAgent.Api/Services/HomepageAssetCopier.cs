using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 把一张外部图片取回来、存进我们自己的对象存储，返回本站地址。
///
/// <para><b>为什么必须复制字节</b>：首页那几个槽位是**未登录访客**看的，一挂就是几个月。
/// 生图产物的地址在两种情况下完全不同——绑了工作区的那种，Worker 已经把图落进我们的
/// 存储，地址恒定；没绑工作区的那种（首页配图正是这种），`Url` 就是供应商返回的地址，
/// 常常带签名、有有效期。把后者原样写进槽位，生成当天一切正常，等地址过期，首页就是
/// 一排裂图，而管理端不会有任何报错——**没有任何人会在过期那天恰好在看**。</para>
///
/// <para>所以这里不去判断「这个地址是不是我们自己的」：那种判断窄一分就漏一类
/// （换个 CDN 域名、换个前缀、供应商地址长得像我们的），而漏掉的代价是几个月后才显形。
/// 一律复制，代价是七张图多存一份，换来的是一条可以一句话说清的不变量：
/// <b>首页槽位引用的对象，一定是我们自己存的。</b></para>
/// </summary>
public sealed class HomepageAssetCopier
{
    /// <summary>与手工上传同一个上限：图片 + 短视频 20MB。</summary>
    public const long MaxBytes = 20 * 1024 * 1024;

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IAssetStorage _assetStorage;

    public HomepageAssetCopier(IHttpClientFactory httpClientFactory, IAssetStorage assetStorage)
    {
        _httpClientFactory = httpClientFactory;
        _assetStorage = assetStorage;
    }

    /// <summary>复制结果：都是要写进槽位记录的东西。</summary>
    public sealed record Copied(string ObjectKey, string Url, string Mime, long SizeBytes);

    /// <summary>取不回来时的说法，直接给管理员看，所以要说清是哪一步断的。</summary>
    public sealed class CopyFailedException : Exception
    {
        public CopyFailedException(string message, Exception? inner = null) : base(message, inner) { }
    }

    /// <summary>
    /// 下载 <paramref name="sourceUrl"/> 并上传到 <paramref name="objectKeyFor"/> 给出的 key。
    ///
    /// key 由调用方按 slot 决定（扩展名要等下载完拿到真实 mime 才知道，所以传的是个函数）。
    /// </summary>
    public async Task<Copied> CopyAsync(
        string sourceUrl,
        Func<string, string> objectKeyFor,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sourceUrl))
            throw new CopyFailedException("没有可下载的图片地址");

        using var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(60);

        byte[] bytes;
        string? contentType;
        try
        {
            using var resp = await client.GetAsync(sourceUrl, ct);
            if (!resp.IsSuccessStatusCode)
                throw new CopyFailedException($"取回这张图失败（HTTP {(int)resp.StatusCode}），可能是它的临时地址已经过期");
            bytes = await resp.Content.ReadAsByteArrayAsync(ct);
            contentType = resp.Content.Headers.ContentType?.MediaType;
        }
        catch (CopyFailedException) { throw; }
        catch (Exception ex)
        {
            throw new CopyFailedException($"取回这张图失败：{ex.Message}", ex);
        }

        if (bytes.LongLength == 0)
            throw new CopyFailedException("取回的内容是空的，没有存进来");
        if (bytes.LongLength > MaxBytes)
            throw new CopyFailedException($"这张图 {bytes.LongLength / 1024 / 1024}MB，超过首页资源 20MB 上限");

        // CDN 常常回 application/octet-stream。照它落库的话，前端 <img> 认不出这个 mime——
        // 所以通用类型一律按字节里的魔数重判，判不出才退回 png。
        var mime = IsGenericMime(contentType) ? SniffMime(bytes) : contentType!;
        var objectKey = objectKeyFor(ExtensionFor(mime));

        await _assetStorage.UploadToKeyAsync(objectKey, bytes, mime, ct);
        return new Copied(objectKey, _assetStorage.BuildUrlForKey(objectKey), mime, bytes.LongLength);
    }

    private static bool IsGenericMime(string? contentType) =>
        string.IsNullOrWhiteSpace(contentType)
        || contentType.Equals("application/octet-stream", StringComparison.OrdinalIgnoreCase)
        || contentType.Equals("binary/octet-stream", StringComparison.OrdinalIgnoreCase);

    /// <summary>看头几个字节认图片格式。认不出按 png 走——首页配图本来就都是图。</summary>
    public static string SniffMime(byte[] bytes)
    {
        if (bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47)
            return "image/png";
        if (bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF)
            return "image/jpeg";
        if (bytes.Length >= 12
            && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
            && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50)
            return "image/webp";
        if (bytes.Length >= 6 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46)
            return "image/gif";
        return "image/png";
    }

    public static string ExtensionFor(string mime)
    {
        var m = (mime ?? string.Empty).Trim().ToLowerInvariant();
        if (m.Contains("png")) return "png";
        if (m.Contains("webp")) return "webp";
        if (m.Contains("gif")) return "gif";
        if (m.Contains("jpeg") || m.Contains("jpg")) return "jpg";
        return "png";
    }
}
