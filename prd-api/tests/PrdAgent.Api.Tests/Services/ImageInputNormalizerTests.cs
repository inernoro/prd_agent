using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.Formats.Gif;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.PixelFormats;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

internal static class ImageInputTestData
{
    internal static byte[] Create(string mime = "image/png", byte seed = 35)
    {
        using var image = new Image<Rgba32>(16, 16, new Rgba32(seed, 90, 190, 128));
        using var stream = new MemoryStream();
        IImageEncoder encoder = mime switch
        {
            "image/jpeg" => new JpegEncoder(),
            "image/webp" => new WebpEncoder(),
            "image/gif" => new GifEncoder(),
            _ => new PngEncoder(),
        };
        image.Save(stream, encoder);
        return stream.ToArray();
    }

    internal static string DataUri(string mime = "image/png", byte seed = 35)
        => $"data:{mime};base64,{Convert.ToBase64String(Create(mime, seed))}";
}

public class ImageInputNormalizerTests
{
    [Theory]
    [InlineData("image/jpeg", "jpg")]
    [InlineData("image/png", "png")]
    [InlineData("image/webp", "webp")]
    [InlineData("image/gif", "gif")]
    public void Read_UsesDecodedFormatAndPreservesOriginalBytes(string mime, string extension)
    {
        var bytes = ImageInputTestData.Create(mime);
        var normalized = ImageInputNormalizer.Read($"data:application/octet-stream;base64,{Convert.ToBase64String(bytes)}");
        Assert.Equal(mime, normalized.MimeType);
        Assert.Equal($"input.{extension}", normalized.FileName("input"));
        Assert.Equal(bytes, normalized.Bytes);
        Assert.StartsWith($"data:{mime};base64,", normalized.DataUri);
        Assert.Equal(bytes, ImageInputNormalizer.Read(Convert.ToBase64String(bytes)).Bytes);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("not base64")]
    [InlineData("data:image/png;base64,aW1hZ2U=")]
    [InlineData("data:image/png,not-base64")]
    [InlineData("/9j/4AAQSkZJRgABAQAAAQABAAA=")]
    public void Read_RejectsEmptyNonImagesAndTruncatedJpeg(string? raw)
    {
        var error = Assert.Throws<ImageInputException>(() => ImageInputNormalizer.Read(raw));
        Assert.Contains("重新上传", error.Message);
        Assert.DoesNotContain("Exception", error.Message);
    }

    [Fact]
    public void Read_RejectsOversizedPayloadBeforeDecode()
        => Assert.Throws<ImageInputException>(() => ImageInputNormalizer.Read(new byte[ImageInputNormalizer.MaxBytes + 1]));

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task ImageClient_RejectsBrokenInputBeforeResolvingModel(int count)
    {
        // 所有依赖故意留空：格式错误必须在模型解析、存储或任何 HTTP 调用前返回。
        var client = new OpenAIImageClient(null!, null!, null!, null!,
            NullLogger<OpenAIImageClient>.Instance, null!, null!, null!);
        var references = count == 1 ? new List<string> { "broken" }
            : new List<string> { ImageInputTestData.DataUri(), "broken" };
        var response = await client.GenerateUnifiedAsync("修改参考图", 1, null, null,
            CancellationToken.None, "visual-agent.image.vision::generation", references);
        Assert.False(response.Success);
        Assert.Equal(ImageInputNormalizer.ErrorCode, response.Error?.Code);
        Assert.Contains("重新上传", response.Error?.Message);
    }

    [Fact]
    public void UserError_ExplainsInputRecoveryWithoutUpstreamDetails()
    {
        var error = ImageGenerationUserError.FromGateway(GatewayRawResponse.Fail(
            ImageInputNormalizer.ErrorCode, "decoder internal diagnostic", 400));
        Assert.Equal(ImageInputNormalizer.ErrorCode, error.Code);
        Assert.Equal(ImageInputNormalizer.ErrorMessage, error.Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Gateway_NormalizesDirectAndCanonicalMultipart(bool canonical)
    {
        var jpeg = ImageInputTestData.Create("image/jpeg");
        var png = ImageInputTestData.Create();
        var http = new InspectingHttpFactory();
        var resolver = new Mock<IModelResolver>();
        var gateway = new LlmGateway(resolver.Object, http, NullLogger<LlmGateway>.Instance);
        var sourceFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
        {
            ["image[0]"] = ("first.png", jpeg, "image/png"),
            ["image[1]"] = ("second.jpg", png, "image/jpeg"),
            ["mask"] = ("mask.jpg", png, "image/jpeg"),
        };
        var response = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = "prd-agent-web.lab::generation",
            ModelType = "generation",
            EndpointPath = "images/edits",
            IsMultipart = !canonical,
            MultipartFields = canonical ? null : new() { ["prompt"] = "保留参考图" },
            MultipartFiles = canonical ? null : sourceFiles,
            CanonicalImageRequest = canonical ? new()
            {
                Prompt = "保留参考图",
                Images = [$"data:image/png;base64,{Convert.ToBase64String(jpeg)}", $"data:image/jpeg;base64,{Convert.ToBase64String(png)}"],
                MaskBase64 = $"data:image/jpeg;base64,{Convert.ToBase64String(png)}",
            } : null,
        }, Resolution());

        Assert.True(response.Success, response.ErrorMessage);
        Assert.Equal(1, http.Calls);
        Assert.Equal(new[] { "image/jpeg", "image/png", "image/png" }, http.Parts.Select(p => p.Mime));
        Assert.Equal(new[] { ".jpg", ".png", ".png" }, http.Parts.Select(p => Path.GetExtension(p.Name)));
        Assert.Equal(jpeg, http.Parts[0].Bytes);
        Assert.Equal(png, http.Parts[1].Bytes);
        Assert.Equal(png, http.Parts[2].Bytes);
        Assert.Equal("first.png", sourceFiles["image[0]"].FileName);
        Assert.Equal("image/png", sourceFiles["image[0]"].MimeType);
        resolver.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Gateway_RejectsOneBrokenReferenceWithoutSendingOrDroppingIt(bool canonical)
    {
        var http = new InspectingHttpFactory();
        var resolver = new Mock<IModelResolver>();
        var gateway = new LlmGateway(resolver.Object, http, NullLogger<LlmGateway>.Instance);
        var response = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = "prd-agent-web.lab::generation",
            ModelType = "generation",
            EndpointPath = "images/edits",
            IsMultipart = !canonical,
            MultipartFields = canonical ? null : new() { ["prompt"] = "保留参考图" },
            MultipartFiles = canonical ? null : new()
            {
                ["image[0]"] = ("valid.png", ImageInputTestData.Create(), "image/png"),
                ["image[1]"] = ("broken.png", [1, 2, 3], "image/png"),
            },
            CanonicalImageRequest = canonical ? new()
            {
                Prompt = "保留参考图",
                Images = [ImageInputTestData.DataUri(), "data:image/png;base64,AQID"],
            } : null,
        }, Resolution());
        Assert.False(response.Success);
        Assert.Equal(400, response.StatusCode);
        Assert.Equal(ImageInputNormalizer.ErrorCode, response.ErrorCode);
        Assert.Contains("重新上传", response.ErrorMessage);
        Assert.Equal(0, http.Calls);
        resolver.VerifyNoOtherCalls();
    }

    private static GatewayModelResolution Resolution() => new()
    {
        Success = true, ResolutionType = "Pinned", ActualModel = "image-edit-model",
        ActualPlatformId = "image", PlatformType = "openai", Protocol = "openai",
        ApiUrl = "https://provider.example.com", ApiKey = "test", SupportsImageGeneration = true,
    };

    private sealed class InspectingHttpFactory : IHttpClientFactory
    {
        internal int Calls;
        internal List<(string Name, string Mime, byte[] Bytes)> Parts { get; } = [];
        public HttpClient CreateClient(string name) => new(new Handler(this));

        private sealed class Handler(InspectingHttpFactory owner) : HttpMessageHandler
        {
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                owner.Calls++;
                var multipart = Assert.IsType<MultipartFormDataContent>(request.Content);
                foreach (var part in multipart.Where(part => part.Headers.ContentDisposition?.FileName is not null))
                {
                    var bytes = await part.ReadAsByteArrayAsync(ct);
                    var mime = part.Headers.ContentType!.MediaType!;
                    Assert.Equal(Image.DetectFormat(bytes).DefaultMimeType, mime);
                    owner.Parts.Add((part.Headers.ContentDisposition!.FileName!.Trim('"'), mime, bytes));
                }
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"data\":[{\"url\":\"https://example.com/output.png\"}]}"),
                };
            }
        }
    }
}
