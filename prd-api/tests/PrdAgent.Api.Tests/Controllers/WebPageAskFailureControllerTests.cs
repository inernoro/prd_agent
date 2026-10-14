using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 执行两个公开控制器方法、真实 SSE writer 与独立 Mongo GUID 数据库；
/// 只替代外部付费网关，不用纯文案函数测试冒充消费端接线已经正确。
/// </summary>
[Trait("Category", "Integration")]
public sealed class WebPageAskFailureControllerTests
{
    private const string DiagnosticCanary = "fixture-private-error https://fixture.invalid/offering SECRET-fixture-only";
    private const string PublicFallback = "回答失败了，请稍后再试。";

    public static IEnumerable<object[]> KnownRouteCases()
        => GatewayRouteFailure.All.SelectMany(code => new[]
        {
            new object[] { code, false }, new object[] { code, true },
        });

    [Theory]
    [MemberData(nameof(KnownRouteCases))]
    public async Task KnownRouteFailure_PreservesFiniteCodeAndRecoveryAction(string code, bool share)
    {
        await using var fixture = await AskFixture.CreateAsync(share,
            [GatewayStreamChunk.Fail(DiagnosticCanary, code)]);

        var events = await fixture.RunAsync();

        var error = Assert.Single(events, e => e.Type == "error").Data;
        Assert.Equal(GatewayRouteFailure.UserMessage(code), error.GetProperty("message").GetString());
        Assert.Equal(code, error.GetProperty("code").GetString());
        Assert.DoesNotContain(events, e => e.Type == "done");
        Assert.DoesNotContain(DiagnosticCanary, fixture.ResponseText);
        fixture.AssertInvocationAndRefund(1);
        var stored = await fixture.AssistantMessageAsync();
        Assert.Equal(DiagnosticCanary, stored.Error);
        Assert.Empty(stored.Content);
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData(null, true)]
    [InlineData("UNCLASSIFIED", false)]
    [InlineData("UNCLASSIFIED", true)]
    [InlineData(DiagnosticCanary, false)]
    [InlineData(DiagnosticCanary, true)]
    public async Task UnknownCode_RemainsSafeAskFallback(string? code, bool share)
    {
        await using var fixture = await AskFixture.CreateAsync(share,
            [GatewayStreamChunk.Fail(DiagnosticCanary, code)]);
        var events = await fixture.RunAsync();

        AssertError(events, "ASK_UPSTREAM_ERROR", PublicFallback);
        Assert.DoesNotContain(DiagnosticCanary, fixture.ResponseText);
        fixture.AssertInvocationAndRefund(1);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PartialAnswer_FailureRetainsContentWithoutRefundOrDone(bool share)
    {
        await using var fixture = await AskFixture.CreateAsync(share,
            [GatewayStreamChunk.Text("已产生的正文"),
             GatewayStreamChunk.Fail(DiagnosticCanary, GatewayRouteFailure.ProviderUnavailable)]);
        var events = await fixture.RunAsync();

        AssertError(events, GatewayRouteFailure.ProviderUnavailable,
            GatewayRouteFailure.UserMessage(GatewayRouteFailure.ProviderUnavailable));
        Assert.Equal("已产生的正文", Assert.Single(events, e => e.Type == "typing").Data.GetProperty("text").GetString());
        fixture.AssertInvocationAndRefund(0);
        var stored = await fixture.AssistantMessageAsync();
        Assert.Equal("已产生的正文", stored.Content);
        Assert.Equal(DiagnosticCanary, stored.Error);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EmptyAnswer_RemainsFailureAndRefundsOnce(bool share)
    {
        await using var fixture = await AskFixture.CreateAsync(share, []);
        AssertError(await fixture.RunAsync(), "ASK_EMPTY_ANSWER", PublicFallback);
        fixture.AssertInvocationAndRefund(1);
        Assert.NotNull((await fixture.AssistantMessageAsync()).Error);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task OrdinaryOrUnknownRouteException_RemainsSafeAskFailure(bool share, bool typed)
    {
        await using var fixture = await AskFixture.CreateAsync(share, [],
            failure: typed
                ? new GatewayRouteFailureException(DiagnosticCanary, DiagnosticCanary)
                : new InvalidOperationException(DiagnosticCanary));
        AssertError(await fixture.RunAsync(), "ASK_FAILED", PublicFallback);
        Assert.DoesNotContain(DiagnosticCanary, fixture.ResponseText);
        fixture.AssertInvocationAndRefund(1);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TypedRouteException_UsesSameFiniteMapping(bool share)
    {
        await using var fixture = await AskFixture.CreateAsync(share, [],
            failure: new GatewayRouteFailureException(GatewayRouteFailure.AppCallerPoolUnbound, DiagnosticCanary));
        AssertError(await fixture.RunAsync(), GatewayRouteFailure.AppCallerPoolUnbound,
            GatewayRouteFailure.UserMessage(GatewayRouteFailure.AppCallerPoolUnbound));
        Assert.DoesNotContain(DiagnosticCanary, fixture.ResponseText);
        fixture.AssertInvocationAndRefund(1);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailOpenQuota_FailureDoesNotRefundUnconsumedCounters(bool share)
    {
        await using var fixture = await AskFixture.CreateAsync(share,
            [GatewayStreamChunk.Fail(DiagnosticCanary)], consumed: false);
        AssertError(await fixture.RunAsync(), "ASK_UPSTREAM_ERROR", PublicFallback);
        fixture.AssertInvocationAndRefund(0);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NormalAnswer_StillTypesThenCompletesAndPersists(bool share)
    {
        await using var fixture = await AskFixture.CreateAsync(share,
            [GatewayStreamChunk.Text("本页的完整答案"), GatewayStreamChunk.Done("stop", null)]);
        var events = await fixture.RunAsync();

        Assert.Single(events, e => e.Type == "typing");
        Assert.Single(events, e => e.Type == "done");
        Assert.DoesNotContain(events, e => e.Type == "error");
        fixture.AssertInvocationAndRefund(0);
        var stored = await fixture.AssistantMessageAsync();
        Assert.Equal("本页的完整答案", stored.Content);
        Assert.Null(stored.Error);
    }

    private static void AssertError(List<SseFrame> events, string code, string message)
    {
        var error = Assert.Single(events, e => e.Type == "error").Data;
        Assert.Equal(code, error.GetProperty("code").GetString());
        Assert.Equal(message, error.GetProperty("message").GetString());
        Assert.DoesNotContain(events, e => e.Type == "done");
    }

    private sealed record SseFrame(string Type, JsonElement Data);

    private sealed class AskFixture : IAsyncDisposable
    {
        private const string OwnerId = "site-owner";
        private const string ReaderId = "authenticated-reader";
        private readonly MongoClient _client;
        private readonly string _databaseName;
        private readonly bool _share;
        private readonly Mock<ILlmGateway> _gateway = new(MockBehavior.Strict);
        private readonly Mock<IAskQuotaService> _quota = new(MockBehavior.Strict);
        private readonly Mock<ILLMRequestContextAccessor> _context = new(MockBehavior.Strict);
        private readonly Mock<IAskOpeningQuestionGenerator> _openers = new(MockBehavior.Strict);
        private readonly AskQuotaDecision _decision;
        private readonly WebPageAskController _controller;
        private readonly MemoryStream _body = new();
        private GatewayRequest? _request;
        private LlmRequestContext? _scope;
        private MongoDbContext Db { get; }
        private HostedSite Site { get; } = new()
        {
            Id = Guid.NewGuid().ToString("N"), OwnerUserId = OwnerId,
            Title = "stsmk-controller-error", AskEnabled = true, AskAllowAnonymous = true,
        };
        public string ResponseText { get; private set; } = string.Empty;

        private AskFixture(MongoClient client, string connection, string databaseName,
            bool share, GatewayStreamChunk[] chunks, bool consumed, Exception? failure)
        {
            _client = client;
            _databaseName = databaseName;
            _share = share;
            Db = new MongoDbContext(connection, databaseName);
            _decision = consumed ? AskQuotaDecision.Ok() : AskQuotaDecision.FailOpen();
            _quota.Setup(q => q.TryConsumeAsync(Site.Id, share ? null : ReaderId,
                It.IsAny<string?>(), Site.AskDailyLimit, CancellationToken.None)).ReturnsAsync(_decision);
            _quota.Setup(q => q.RefundAsync(_decision, Site.Id, CancellationToken.None)).Returns(Task.CompletedTask);
            _context.Setup(c => c.BeginScope(It.IsAny<LlmRequestContext>()))
                .Callback<LlmRequestContext>(scope => _scope = scope).Returns(new EmptyScope());
            _gateway.Setup(g => g.StreamAsync(It.IsAny<GatewayRequest>(), CancellationToken.None))
                .Callback<GatewayRequest, CancellationToken>((request, _) => _request = request)
                .Returns(Emit(chunks, failure));

            var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
            sites.Setup(s => s.GetByIdAsync(Site.Id, ReaderId, CancellationToken.None)).ReturnsAsync(Site);
            sites.Setup(s => s.ResolveShareSiteAsync("fixture-share", Site.Id, null, null, CancellationToken.None))
                .ReturnsAsync(new ShareSiteResolveResult { Site = Site, Share = new WebPageShareLink { ShareType = "single" } });
            var snapshots = new Mock<ISiteContentSnapshotService>(MockBehavior.Strict);
            snapshots.Setup(s => s.GetAsync(Site, CancellationToken.None))
                .ReturnsAsync(new SiteContentSnapshot { SiteId = Site.Id, Text = "本页有可读的正文。", FileCount = 1 });
            _controller = new WebPageAskController(sites.Object, snapshots.Object, _quota.Object,
                _openers.Object, _gateway.Object, _context.Object, Db, NullLogger<WebPageAskController>.Instance);
            var http = new DefaultHttpContext();
            if (!share)
                http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", ReaderId)], "test"));
            http.Response.Body = _body;
            _controller.ControllerContext = new ControllerContext { HttpContext = http };
        }

        public static async Task<AskFixture> CreateAsync(bool share, GatewayStreamChunk[] chunks,
            bool consumed = true, Exception? failure = null)
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connection);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new AskFixture(client, connection, $"web_ask_failure_{Guid.NewGuid():N}", share, chunks, consumed, failure);
        }

        public async Task<List<SseFrame>> RunAsync()
        {
            var request = new AskStreamRequest { Question = "这页说了什么？", SiteId = Site.Id };
            if (_share) await _controller.AskStreamByShare("fixture-share", request);
            else await _controller.AskStream(Site.Id, request);
            ResponseText = Encoding.UTF8.GetString(_body.ToArray());
            return ResponseText.Split("\n\n", StringSplitOptions.RemoveEmptyEntries).Select(frame =>
            {
                var lines = frame.Split('\n');
                var type = lines.Single(line => line.StartsWith("event: ", StringComparison.Ordinal))[7..];
                using var data = JsonDocument.Parse(lines.Single(line => line.StartsWith("data: ", StringComparison.Ordinal))[6..]);
                return new SseFrame(type, data.RootElement.Clone());
            }).ToList();
        }

        public void AssertInvocationAndRefund(int refunds)
        {
            _gateway.Verify(g => g.StreamAsync(It.IsAny<GatewayRequest>(), CancellationToken.None), Times.Once);
            _quota.Verify(q => q.RefundAsync(_decision, Site.Id, CancellationToken.None), Times.Exactly(refunds));
            _openers.VerifyNoOtherCalls();
            Assert.NotNull(_request);
            Assert.Equal(AppCallerRegistry.Admin.WebHosting.Ask, _request.AppCallerCode);
            Assert.Equal(ModelTypes.Chat, _request.ModelType);
            Assert.True(_request.Stream);
            Assert.Null(_request.ExpectedModel);
            Assert.NotNull(_request.Context);
            Assert.NotNull(_scope);
            Assert.Equal(_share ? OwnerId : ReaderId, _request.Context.UserId);
            Assert.Equal(_request.Context.UserId, _scope.UserId);
            Assert.Equal(_request.Context.RequestId, _scope.RequestId);
            Assert.Equal(_request.Context.SessionId, _scope.SessionId);
        }

        public Task<HostedSiteAskMessage> AssistantMessageAsync()
            => Db.HostedSiteAskMessages.Find(m => m.SiteId == Site.Id && m.Role == "assistant").SingleAsync();

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_databaseName);
            await _body.DisposeAsync();
        }

        private static async IAsyncEnumerable<GatewayStreamChunk> Emit(GatewayStreamChunk[] chunks, Exception? failure)
        {
            await Task.CompletedTask;
            foreach (var chunk in chunks) yield return chunk;
            if (failure != null) throw failure;
        }

        private sealed class EmptyScope : IDisposable
        {
            public void Dispose() { }
        }
    }
}
