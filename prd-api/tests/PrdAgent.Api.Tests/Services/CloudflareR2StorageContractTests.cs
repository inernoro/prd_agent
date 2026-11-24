using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class CloudflareR2StorageContractTests
{
    [Fact]
    public void CreateClientConfig_ShouldUseR2EndpointAndAutoSigningRegion()
    {
        var config = CloudflareR2Storage.CreateClientConfig("account-123", endpoint: null);

        config.ServiceURL.TrimEnd('/').ShouldBe("https://account-123.r2.cloudflarestorage.com");
        config.ForcePathStyle.ShouldBeTrue();
        config.AuthenticationRegion.ShouldBe("auto");
    }

    [Fact]
    public void CreateClientConfig_ShouldPreserveConfiguredJurisdictionEndpoint()
    {
        const string endpoint = "https://account-123.eu.r2.cloudflarestorage.com";

        var config = CloudflareR2Storage.CreateClientConfig("account-123", endpoint);

        config.ServiceURL.TrimEnd('/').ShouldBe(endpoint);
        config.AuthenticationRegion.ShouldBe("auto");
    }

    [Fact]
    public void CreatePutObjectRequest_ShouldUseSignedFixedLengthR2Upload()
    {
        var payload = new byte[640 * 1024];
        var request = CloudflareR2Storage.CreatePutObjectRequest(
            "recordings",
            "data/document-store/audio/test.m4a",
            payload,
            "audio/mp4",
            "private, max-age=0");
        try
        {
            request.BucketName.ShouldBe("recordings");
            request.Key.ShouldBe("data/document-store/audio/test.m4a");
            request.ContentType.ShouldBe("audio/mp4");
            request.Headers.CacheControl.ShouldBe("private, max-age=0");
            request.DisablePayloadSigning.ShouldBe(false);
            request.DisableDefaultChecksumValidation.ShouldBe(true);
            request.UseChunkEncoding.ShouldBe(false);
            request.Headers.ContentLength.ShouldBe(payload.LongLength);
        }
        finally
        {
            request.InputStream.Dispose();
        }
    }

    [Theory]
    [InlineData("audio/mp4;codecs=mp4a.40.2", "audio/mp4")]
    [InlineData(" Audio/WebM; codecs=opus ", "audio/webm")]
    [InlineData("audio/x-m4a", "audio/x-m4a")]
    [InlineData(null, "application/octet-stream")]
    public void CreatePutObjectRequest_ShouldNormalizeBrowserCodecParameters(
        string? contentType,
        string expected)
    {
        var request = CloudflareR2Storage.CreatePutObjectRequest(
            "recordings",
            "data/prd-agent/doc/test.m4a",
            [1, 2, 3],
            contentType,
            cacheControl: null);
        try
        {
            request.ContentType.ShouldBe(expected);
        }
        finally
        {
            request.InputStream.Dispose();
        }
    }
}
