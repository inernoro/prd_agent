using System.Net;
using PrdAgent.Core.Interfaces;
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
///
/// <para><b>这个地址不是我们写的，所以三处都得当它是敌意的</b>：它来自模型供应商的响应，
/// 而我们会拿服务端去连它、把回来的字节存进公网可读的存储。<br/>
/// 一、<b>连去哪</b>：走 `SafeOutbound` 客户端 + 逐跳 `EnsureSafeHttpUrlAsync`，
/// 挡住指向 loopback / 内网 / 云元数据（169.254.169.254）的地址；重定向不自动跟，
/// 由这里手动跟且每一跳重新校验——只校验第一跳等于没校验。<br/>
/// 二、<b>回来多少</b>：边读边数，超过上限当场断开，而不是先整包读进内存再判断大小
/// （那种写法的「上限」只是个事后说法，对方给多少我们就吃多少）。<br/>
/// 三、<b>回来的是什么</b>：只认字节里的图片魔数，认不出就拒收。Content-Type 是对方
/// 说了算的，照它落库等于让对方决定我们存储里放着一个什么 MIME 的东西。</para>
/// </summary>
public sealed class HomepageAssetCopier
{
    /// <summary>与手工上传同一个上限：图片 + 短视频 20MB。</summary>
    public const long MaxBytes = 20 * 1024 * 1024;

    /// <summary>跳转最多跟这么多次；正常的签名地址要么直出、要么一跳到 CDN。</summary>
    private const int MaxRedirects = 3;

    private const string SafeOutboundClient = "SafeOutbound";

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IAssetStorage _assetStorage;
    private readonly ISafeOutboundUrlValidator _urlValidator;

    public HomepageAssetCopier(
        IHttpClientFactory httpClientFactory,
        IAssetStorage assetStorage,
        ISafeOutboundUrlValidator urlValidator)
    {
        _httpClientFactory = httpClientFactory;
        _assetStorage = assetStorage;
        _urlValidator = urlValidator;
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

        var client = _httpClientFactory.CreateClient(SafeOutboundClient);
        client.Timeout = TimeSpan.FromSeconds(60);

        byte[] bytes;
        try
        {
            bytes = await DownloadAsync(client, sourceUrl, ct);
        }
        catch (CopyFailedException) { throw; }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            throw new CopyFailedException($"取回这张图失败：{ex.Message}", ex);
        }

        if (bytes.LongLength == 0)
            throw new CopyFailedException("取回的内容是空的，没有存进来");

        // 只认字节。对方回 image/png 而内容是一段 HTML 错误页（签名过期时很常见）的话，
        // 照它的说法落库就等于把一张「打不开的图」挂上首页，而且带着一个骗人的 mime。
        var mime = SniffMime(bytes)
            ?? throw new CopyFailedException("取回的内容不是我们认得的图片（PNG / JPEG / WebP / GIF / AVIF），没有存进来");
        var objectKey = objectKeyFor(ExtensionFor(mime));

        await _assetStorage.UploadToKeyAsync(objectKey, bytes, mime, ct);
        return new Copied(objectKey, _assetStorage.BuildUrlForKey(objectKey), mime, bytes.LongLength);
    }

    /// <summary>逐跳校验地址、逐块读取字节。跳转不自动跟，因为自动跟就绕过了校验。</summary>
    private async Task<byte[]> DownloadAsync(HttpClient client, string sourceUrl, CancellationToken ct)
    {
        var url = sourceUrl;
        for (var hop = 0; hop <= MaxRedirects; hop++)
        {
            var safeUri = await _urlValidator.EnsureSafeHttpUrlAsync(url, "首页配图来源地址", ct);
            using var resp = await client.GetAsync(safeUri, HttpCompletionOption.ResponseHeadersRead, ct);

            if (IsRedirect(resp.StatusCode))
            {
                var location = resp.Headers.Location;
                if (location is null)
                    throw new CopyFailedException($"取回这张图失败（HTTP {(int)resp.StatusCode}），跳转没给出目标地址");
                url = (location.IsAbsoluteUri ? location : new Uri(safeUri, location)).ToString();
                continue;
            }

            if (!resp.IsSuccessStatusCode)
                throw new CopyFailedException($"取回这张图失败（HTTP {(int)resp.StatusCode}），可能是它的临时地址已经过期");

            // 对方自报的长度只用来提前拒绝，不用来相信：它可以少报，所以读的时候还要再数一遍。
            if (resp.Content.Headers.ContentLength is > MaxBytes)
                throw new CopyFailedException(TooLargeMessage);

            return await ReadCappedAsync(resp.Content, ct);
        }

        throw new CopyFailedException($"取回这张图失败：跳转超过 {MaxRedirects} 次");
    }

    private static async Task<byte[]> ReadCappedAsync(HttpContent content, CancellationToken ct)
    {
        await using var stream = await content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct)) > 0)
        {
            buffer.Write(chunk, 0, read);
            // 超了就当场停，别把剩下的读完——上限是为了不让对方决定我们吃多少内存。
            if (buffer.Length > MaxBytes)
                throw new CopyFailedException(TooLargeMessage);
        }
        return buffer.ToArray();
    }

    private const string TooLargeMessage = "这张图超过首页资源 20MB 上限，没有存进来";

    private static bool IsRedirect(HttpStatusCode status) =>
        status is HttpStatusCode.MovedPermanently
            or HttpStatusCode.Found
            or HttpStatusCode.SeeOther
            or HttpStatusCode.TemporaryRedirect
            or HttpStatusCode.PermanentRedirect;

    /// <summary>看头几个字节认图片格式。认不出返回 null——不认得就不该存。</summary>
    public static string? SniffMime(byte[] bytes)
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
        // ISO-BMFF：前 4 字节是 box 长度，紧接着 "ftyp"，再往后是品牌
        if (bytes.Length >= 12
            && bytes[4] == 0x66 && bytes[5] == 0x74 && bytes[6] == 0x79 && bytes[7] == 0x70
            && bytes[8] == 0x61 && bytes[9] == 0x76 && bytes[10] == 0x69 && bytes[11] is 0x66 or 0x73)
            return "image/avif";
        return null;
    }

    public static string ExtensionFor(string mime)
    {
        var m = (mime ?? string.Empty).Trim().ToLowerInvariant();
        if (m.Contains("png")) return "png";
        if (m.Contains("webp")) return "webp";
        if (m.Contains("gif")) return "gif";
        if (m.Contains("avif")) return "avif";
        if (m.Contains("jpeg") || m.Contains("jpg")) return "jpg";
        return "png";
    }
}
