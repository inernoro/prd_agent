using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 设计运行时数据面是 [AllowAnonymous] 入口，票据是唯一的门。
/// PR #1533 评审（Codex P2，评论 4082427132 / 4082726315）指出：结果提交与两条模型代理
/// 先把请求体整段读进内存（最多 6 MiB / 1 MiB）、再校验票据，没有票据的请求也能换来一次
/// 完整的上传、分配与 JSON 解析。这里断言的是行为：票据不对时，请求体一个字节都不读。
/// </summary>
public sealed class DesignArtifactRuntimeAuthBeforeBodyTests
{
    [Fact]
    public async Task WorkspaceResult_RejectsInvalidTicketWithoutReadingBody()
    {
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(x => x.ValidatePreviewAsync("run-1", "forged", It.IsAny<CancellationToken>()))
            .ThrowsAsync(new UnauthorizedAccessException());
        var (controller, body) = Build(broker.Object, "Bearer forged");

        var result = await controller.CommitWorkspaceResult("run-1", CancellationToken.None);

        Assert.Equal(401, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Equal(0, body.ReadCalls);
        broker.VerifyAll();
        broker.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task WorkspaceResult_MissingBearerIsRejectedWithoutReadingBody()
    {
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        var (controller, body) = Build(broker.Object, authorization: null);

        var result = await controller.CommitWorkspaceResult("run-1", CancellationToken.None);

        Assert.Equal(401, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Equal(0, body.ReadCalls);
        broker.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ModelProxy_RejectsInvalidTicketWithoutReadingBody(bool responses)
    {
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(x => x.ValidateModelTicketAsync("run-1", "forged", It.IsAny<CancellationToken>()))
            .ThrowsAsync(new UnauthorizedAccessException());
        var (controller, body) = Build(broker.Object, "Bearer forged");

        if (responses)
            await controller.ProxyResponses("run-1", CancellationToken.None);
        else
            await controller.ProxyChatCompletions("run-1", CancellationToken.None);

        Assert.Equal(401, controller.Response.StatusCode);
        Assert.Equal(0, body.ReadCalls);
        broker.VerifyAll();
        // 票据不对就不该记一次模型调用。
        broker.VerifyNoOtherCalls();
    }

    private static (DesignArtifactRuntimeController Controller, CountingStream Body) Build(
        IDesignArtifactWorkspaceBroker broker, string? authorization)
    {
        var controller = new DesignArtifactRuntimeController(broker, new NoClientFactory(),
            new ConfigurationBuilder().Build(), NullLogger<DesignArtifactRuntimeController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var body = new CountingStream();
        controller.Request.Body = body;
        if (authorization != null) controller.Request.Headers.Authorization = authorization;
        controller.Response.Body = new MemoryStream();
        return (controller, body);
    }

    private sealed class NoClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) =>
            throw new InvalidOperationException("未授权请求不应走到上游网关");
    }

    /// <summary>一个永远有数据可读的请求体，只记被读了几次。</summary>
    private sealed class CountingStream : Stream
    {
        public int ReadCalls { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            ReadCalls++;
            var n = Math.Min(count, 1024);
            Array.Fill(buffer, (byte)'{', offset, n);
            return n;
        }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            ReadCalls++;
            var n = Math.Min(buffer.Length, 1024);
            buffer.Span[..n].Fill((byte)'{');
            return ValueTask.FromResult(n);
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
