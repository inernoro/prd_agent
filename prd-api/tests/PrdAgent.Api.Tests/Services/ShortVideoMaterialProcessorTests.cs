using Moq;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ShortVideoMaterialProcessorTests
{
    [Fact]
    public void RequireResolvedVideoUrl_ShouldRejectMissingVideoUrl()
    {
        var ex = Should.Throw<InvalidOperationException>(() => ShortVideoMaterialProcessor.RequireResolvedVideoUrl(null));

        ex.Message.ShouldContain("未返回可下载的视频文件地址");
    }

    [Theory]
    [InlineData("/video.mp4")]
    [InlineData("file:///tmp/video.mp4")]
    public void RequireResolvedVideoUrl_ShouldRejectInvalidVideoUrl(string videoUrl)
    {
        var ex = Should.Throw<InvalidOperationException>(() => ShortVideoMaterialProcessor.RequireResolvedVideoUrl(videoUrl));

        ex.Message.ShouldContain("视频文件地址无效");
    }

    [Fact]
    public void RequireResolvedVideoUrl_ShouldReturnTrimmedHttpVideoUrl()
    {
        var result = ShortVideoMaterialProcessor.RequireResolvedVideoUrl(" https://cdn.example.test/video.mp4 ");

        result.ShouldBe("https://cdn.example.test/video.mp4");
    }

    [Theory]
    [InlineData("这不是链接")]
    [InlineData("/video.mp4")]
    [InlineData("file:///tmp/video.mp4")]
    [InlineData("https:///missing-host")]
    public void IsHttpUrl_ShouldRejectNonPublicUrl(string value)
    {
        ShortVideoMaterialProcessor.IsHttpUrl(value).ShouldBeFalse();
    }

    [Theory]
    [InlineData("https://www.bilibili.com/video/BV1test")]
    [InlineData(" http://example.test/video ")]
    public void IsHttpUrl_ShouldAcceptCompleteHttpUrl(string value)
    {
        ShortVideoMaterialProcessor.IsHttpUrl(value).ShouldBeTrue();
    }
    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("https://synthetic.invalid/video.mp4", null, "direct-video")]
    [InlineData("https://synthetic.invalid/VIDEO.MOV?token=synthetic", null, "direct-video")]
    [InlineData("https://synthetic.invalid/video.webm", " 用户提供的原文 ", "manual")]
    public async Task DirectFileConsumer_DoesNotRequirePlatformParser(string url, string? text, string expectedMode)
    {
        var provider = new Moq.Mock<IServiceProvider>(Moq.MockBehavior.Strict);
        var context = (PrdAgent.Infrastructure.Database.MongoDbContext)System.Runtime.CompilerServices.RuntimeHelpers
            .GetUninitializedObject(typeof(PrdAgent.Infrastructure.Database.MongoDbContext));
        var config = new Microsoft.Extensions.Configuration.ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["ShortVideo:TikHubApiKey"] = "" }).Build();
        var processor = new ShortVideoMaterialProcessor(context,
            new Moq.Mock<PrdAgent.Core.Interfaces.IDocumentService>(Moq.MockBehavior.Strict).Object,
            config, provider.Object, Microsoft.Extensions.Logging.Abstractions.NullLogger<ShortVideoMaterialProcessor>.Instance);
        var method = typeof(ShortVideoMaterialProcessor).GetMethod("ResolveParsedSourceAsync",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        var task = (Task)method.Invoke(processor, [url, "unknown", text, "合成标题"])!;
        await task;
        var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
        result.GetType().GetProperty("VideoUrl")!.GetValue(result).ShouldBe(url);
        result.GetType().GetProperty("SourceMode")!.GetValue(result).ShouldBe(expectedMode);
        result.GetType().GetProperty("SourceText")!.GetValue(result).ShouldBe(text?.Trim());
        provider.VerifyNoOtherCalls();
    }

    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("video/mp4", "合成素材.mp4")]
    [InlineData("video/quicktime", "合成素材.mov")]
    [InlineData("video/webm", "合成素材.webm")]
    [InlineData("video/x-matroska", "合成素材.mkv")]
    [InlineData("video/x-msvideo", "合成素材.avi")]
    public async Task StoredFileConsumer_UsesActualContainerExtension(string mime, string expected)
    {
        var (processor, stored, attachments, entries) = CreateStoredFileConsumer();
        var method = typeof(ShortVideoMaterialProcessor).GetMethod("CreateVideoEntryAsync",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        var parameters = method.GetParameters();
        var video = Activator.CreateInstance(parameters[4].ParameterType,
            ["https://synthetic.invalid/stored", mime, 4L, "synthetic-sha"]);
        var parsed = Activator.CreateInstance(parameters[5].ParameterType,
            [null, null, "direct-video", "synthetic", null, "https://synthetic.invalid/source", null]);
        var task = (Task)method.Invoke(processor,
            [new PrdAgent.Core.Models.DocumentStore { Id = "synthetic-store" }, "synthetic-owner", "合成用户",
                "合成素材", video, parsed, "https://synthetic.invalid/source", "unknown", "synthetic-run", DateTime.UnixEpoch])!;
        await task;
        var entry = (PrdAgent.Core.Models.DocumentEntry)task.GetType().GetProperty("Result")!.GetValue(task)!;
        stored.Single().FileName.ShouldBe(expected);
        stored.Single().MimeType.ShouldBe(mime);
        entry.Title.ShouldBe(expected); entry.ContentType.ShouldBe(mime);
        attachments.Verify(x => x.InsertOneAsync(Moq.It.IsAny<PrdAgent.Core.Models.Attachment>(), null,
            CancellationToken.None), Moq.Times.Once);
        entries.Verify(x => x.InsertOneAsync(Moq.It.IsAny<PrdAgent.Core.Models.DocumentEntry>(), null,
            CancellationToken.None), Moq.Times.Once);
    }

    private static (ShortVideoMaterialProcessor Processor, List<PrdAgent.Core.Models.Attachment> Stored,
        Moq.Mock<MongoDB.Driver.IMongoCollection<PrdAgent.Core.Models.Attachment>> Attachments,
        Moq.Mock<MongoDB.Driver.IMongoCollection<PrdAgent.Core.Models.DocumentEntry>> Entries) CreateStoredFileConsumer()
    {
        var stored = new List<PrdAgent.Core.Models.Attachment>();
        var attachments = new Moq.Mock<MongoDB.Driver.IMongoCollection<PrdAgent.Core.Models.Attachment>>(Moq.MockBehavior.Strict);
        attachments.Setup(x => x.InsertOneAsync(Moq.It.IsAny<PrdAgent.Core.Models.Attachment>(), null,
            CancellationToken.None)).Callback<PrdAgent.Core.Models.Attachment, MongoDB.Driver.InsertOneOptions, CancellationToken>(
                (item, _, _) => stored.Add(item)).Returns(Task.CompletedTask);
        var entries = new Moq.Mock<MongoDB.Driver.IMongoCollection<PrdAgent.Core.Models.DocumentEntry>>(Moq.MockBehavior.Strict);
        entries.Setup(x => x.InsertOneAsync(Moq.It.IsAny<PrdAgent.Core.Models.DocumentEntry>(), null,
            CancellationToken.None)).Returns(Task.CompletedTask);
        var stores = new Moq.Mock<MongoDB.Driver.IMongoCollection<PrdAgent.Core.Models.DocumentStore>>(Moq.MockBehavior.Strict);
        stores.Setup(x => x.UpdateOneAsync(Moq.It.IsAny<MongoDB.Driver.FilterDefinition<PrdAgent.Core.Models.DocumentStore>>(),
            Moq.It.IsAny<MongoDB.Driver.UpdateDefinition<PrdAgent.Core.Models.DocumentStore>>(), null,
            CancellationToken.None)).ReturnsAsync(new MongoDB.Driver.UpdateResult.Acknowledged(1, 1, null));
        var database = new Moq.Mock<MongoDB.Driver.IMongoDatabase>(Moq.MockBehavior.Strict);
        database.Setup(x => x.GetCollection<PrdAgent.Core.Models.Attachment>("attachments", null)).Returns(attachments.Object);
        database.Setup(x => x.GetCollection<PrdAgent.Core.Models.DocumentEntry>("document_entries", null)).Returns(entries.Object);
        database.Setup(x => x.GetCollection<PrdAgent.Core.Models.DocumentStore>("document_stores", null)).Returns(stores.Object);
        var context = (PrdAgent.Infrastructure.Database.MongoDbContext)System.Runtime.CompilerServices.RuntimeHelpers
            .GetUninitializedObject(typeof(PrdAgent.Infrastructure.Database.MongoDbContext));
        typeof(PrdAgent.Infrastructure.Database.MongoDbContext).GetField("_database",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(context, database.Object);
        return (new ShortVideoMaterialProcessor(context,
            new Moq.Mock<PrdAgent.Core.Interfaces.IDocumentService>(Moq.MockBehavior.Strict).Object,
            new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(),
            new Moq.Mock<IServiceProvider>(Moq.MockBehavior.Strict).Object,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<ShortVideoMaterialProcessor>.Instance), stored, attachments, entries);
    }

}
