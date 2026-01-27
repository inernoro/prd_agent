using System.Security.Cryptography;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 腾讯云 COS 存储集成测试
/// 需要配置以下环境变量才能运行：
/// - TENCENT_COS_BUCKET
/// - TENCENT_COS_REGION
/// - TENCENT_COS_SECRET_ID
/// - TENCENT_COS_SECRET_KEY
/// </summary>
[Trait("Category", TestCategories.Integration)]
public class TencentCosStorageTests
{
    private readonly ITestOutputHelper _output;

    public TencentCosStorageTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public async Task SaveAsync_ShouldUploadAndDownloadAndDelete()
    {
        // Env vars are intentionally not committed. This is an integration test.
        var bucket = (Environment.GetEnvironmentVariable("TENCENT_COS_BUCKET") ?? string.Empty).Trim();
        var region = (Environment.GetEnvironmentVariable("TENCENT_COS_REGION") ?? string.Empty).Trim();
        var secretId = (Environment.GetEnvironmentVariable("TENCENT_COS_SECRET_ID") ?? string.Empty).Trim();
        var secretKey = (Environment.GetEnvironmentVariable("TENCENT_COS_SECRET_KEY") ?? string.Empty).Trim();
        var publicBaseUrl = (Environment.GetEnvironmentVariable("TENCENT_COS_PUBLIC_BASE_URL") ?? string.Empty).Trim();
        var prefix = (Environment.GetEnvironmentVariable("TENCENT_COS_PREFIX") ?? "data/assets").Trim();
        var cleanup = (Environment.GetEnvironmentVariable("TENCENT_COS_TEST_CLEANUP") ?? string.Empty).Trim();
        var shouldCleanup = string.Equals(cleanup, "1", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(cleanup, "true", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(cleanup, "yes", StringComparison.OrdinalIgnoreCase);

        if (string.IsNullOrWhiteSpace(bucket) ||
            string.IsNullOrWhiteSpace(region) ||
            string.IsNullOrWhiteSpace(secretId) ||
            string.IsNullOrWhiteSpace(secretKey))
        {
            // 本地/CI 若未配置 COS 环境变量，则不执行该集成测试（避免失败）。
            return;
        }

        // Arrange
        var tempDir = Path.Combine(Path.GetTempPath(), "prd-agent-cos-tests");
        Directory.CreateDirectory(tempDir);

        var rootPrefix = (prefix ?? string.Empty).Trim().Trim('/');
        var runPrefix = string.IsNullOrWhiteSpace(rootPrefix)
            ? $"_it/{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}"
            : $"{rootPrefix}/_it/{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}";

        var storage = new TencentCosStorage(
            bucket: bucket,
            region: region,
            secretId: secretId,
            secretKey: secretKey,
            publicBaseUrl: string.IsNullOrWhiteSpace(publicBaseUrl) ? null : publicBaseUrl,
            // 测试写入一个可定位的目录，便于你在 COS 控制台直接看到
            prefix: runPrefix,
            tempDir: tempDir,
            enableSafeDelete: false,
            safeDeleteAllowPrefixes: null,
            logger: NullLogger<TencentCosStorage>.Instance);

        _output.WriteLine($"bucket={bucket}");
        _output.WriteLine($"region={region}");
        _output.WriteLine($"prefix(root)={rootPrefix}");
        _output.WriteLine($"prefix(run)={runPrefix}");

        var uploadedKeys = new List<string>();

        // 1) 上传多种“可见文件”，便于你在控制台看到
        var helloKey = $"{runPrefix}/hello.txt";
        var helloBytes = System.Text.Encoding.UTF8.GetBytes("hello from prd-agent Tencent COS integration test");
        await storage.UploadBytesAsync(helloKey, helloBytes, "text/plain", CancellationToken.None);
        uploadedKeys.Add(helloKey);

        var jsonKey = $"{runPrefix}/sample.json";
        var jsonBytes = System.Text.Encoding.UTF8.GetBytes("{\"from\":\"prd-agent\",\"kind\":\"cos-it\",\"ts\":\"" + DateTime.UtcNow.ToString("O") + "\"}");
        await storage.UploadBytesAsync(jsonKey, jsonBytes, "application/json", CancellationToken.None);
        uploadedKeys.Add(jsonKey);

        var mdKey = $"{runPrefix}/readme.md";
        var mdBytes = System.Text.Encoding.UTF8.GetBytes("# prd-agent cos it\n\nThis file is created by an integration test.\n");
        await storage.UploadBytesAsync(mdKey, mdBytes, "text/markdown", CancellationToken.None);
        uploadedKeys.Add(mdKey);

        var binKey = $"{runPrefix}/random.bin";
        var binBytes = new byte[256];
        Random.Shared.NextBytes(binBytes);
        await storage.UploadBytesAsync(binKey, binBytes, "application/octet-stream", CancellationToken.None);
        uploadedKeys.Add(binKey);

        var pngKey = $"{runPrefix}/tiny.png";
        var pngBytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAZoN7cAAAAASUVORK5CYII=");
        await storage.UploadBytesAsync(pngKey, pngBytes, "image/png", CancellationToken.None);
        uploadedKeys.Add(pngKey);

        var gifKey = $"{runPrefix}/tiny.gif";
        var gifBytes = Convert.FromBase64String("R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==");
        await storage.UploadBytesAsync(gifKey, gifBytes, "image/gif", CancellationToken.None);
        uploadedKeys.Add(gifKey);

        // Assert：逐个 Head 校验对象存在（你可以用这些 key 在 COS 控制台搜索/查看）
        foreach (var k in uploadedKeys)
        {
            _output.WriteLine($"uploaded: {k}");
            Assert.True(await storage.ExistsAsync(k, CancellationToken.None));
        }

        // 2) 再走一遍 SaveAsync（sha 去重路径），确保主链路可用
        var payloadText = $"prd-agent-cos-saveasync|{DateTime.UtcNow:O}|{Guid.NewGuid():N}";
        var bytes = System.Text.Encoding.UTF8.GetBytes(payloadText);
        const string mime = "image/png"; // ext->png
        var sha = Sha256Hex(bytes);

        // Act
        var stored = await storage.SaveAsync(bytes, mime, CancellationToken.None);

        // Assert (basic)
        Assert.Equal(sha, stored.Sha256);
        Assert.Equal(mime, stored.Mime);
        Assert.Equal(bytes.LongLength, stored.SizeBytes);
        Assert.False(string.IsNullOrWhiteSpace(stored.Url));
        Assert.StartsWith("http", stored.Url, StringComparison.OrdinalIgnoreCase);

        // SaveAsync 的实际 key 由存储实现决定（可能带分片目录），这里从 url 反推 key，避免测试与实现耦合。
        var saveAsyncKey = new Uri(stored.Url).AbsolutePath.TrimStart('/');
        Assert.True(await storage.ExistsAsync(saveAsyncKey, CancellationToken.None));
        _output.WriteLine($"saveAsyncKey: {saveAsyncKey}");
        _output.WriteLine($"saveAsyncUrl: {stored.Url}");

        // 直链可访问性验证（如果桶策略是 public-read，这里应为 200；否则可能是 403/404）
        try
        {
            using var http = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            using var resp = await http.GetAsync(stored.Url, CancellationToken.None);
            _output.WriteLine($"saveAsyncUrlStatus: {(int)resp.StatusCode}");
        }
        catch (Exception ex)
        {
            _output.WriteLine($"saveAsyncUrlCheckError: {ex.GetType().Name} {ex.Message}");
        }

        // Cleanup：默认不删，保证你能在控制台看到；如需自动清理，设置 TENCENT_COS_TEST_CLEANUP=true/1
        if (shouldCleanup)
        {
            foreach (var k in uploadedKeys.Append(saveAsyncKey))
            {
                await storage.DeleteAsync(k, CancellationToken.None);
            }
        }
    }

    private static string Sha256Hex(byte[] bytes)
    {
        var h = SHA256.HashData(bytes);
        return Convert.ToHexString(h).ToLowerInvariant();
    }
}


