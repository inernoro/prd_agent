using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.LlmGw;
using PrdAgent.LlmGw.Auth;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class UpstreamNetworkAuditTests
{
    [Fact]
    public async Task DisconnectedProbePersistsFailureBeforeStoppingRemainingSamples()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var browser = new CancellationTokenSource();
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var database = new Mock<IMongoDatabase>();
        var upstream = new BsonDocument
        {
            { "_id", "upstream" }, { "TenantId", "test-org" },
            { "ApiUrl", $"http://127.0.0.1:{port}/probe" },
            { "UpstreamProxy", new BsonDocument("Mode", "direct") },
        };
        database.Setup(x => x.GetCollection<BsonDocument>("llmgw_platforms", null)).Returns(Collection(upstream));
        database.Setup(x => x.GetCollection<BsonDocument>("llmgw_tenants", null)).Returns(Collection(new BsonDocument("_id", "test-org")));
        var audit = new Mock<IMongoCollection<BsonDocument>>();
        var persisted = new TaskCompletionSource<BsonDocument>(TaskCreationOptions.RunContinuationsAsynchronously);
        audit.Setup(x => x.InsertOneAsync(It.IsAny<BsonDocument>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()))
            .Callback<BsonDocument, InsertOneOptions, CancellationToken>((doc, _, token) =>
            {
                Assert.False(token.CanBeCanceled);
                persisted.TrySetResult(doc);
            }).Returns(Task.CompletedTask);
        database.Setup(x => x.GetCollection<BsonDocument>("llmgw_operation_audits", null)).Returns(audit.Object);

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddAuthorization(options =>
        {
            options.AddPolicy("ConfigWrite", policy => policy.RequireAssertion(_ => true));
            options.AddPolicy("LogsRead", policy => policy.RequireAssertion(_ => true));
        });
        await using var app = builder.Build();
        app.Use(async (http, next) =>
        {
            http.Items[TenantAccess.ItemKey] = new TenantAccessContext("test-org", "test", true,
                "user", "tester", "membership", 1, "owner", []);
            await next();
        });
        new UpstreamProxyService(database.Object, new ConfigurationBuilder().Build(), "test-org")
            .MapEndpoints(app, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        await app.StartAsync(timeout.Token);
        using var client = app.GetTestClient();
        var request = client.PostAsJsonAsync("/gw/upstreams/platform/upstream/network-test", new { samples = 3 }, browser.Token);
        using var peer = await listener.AcceptTcpClientAsync(timeout.Token);
        // 仅在 HEAD 真正发到第三方后断开浏览器，覆盖在途调用取消。
        var received = new byte[4096];
        Assert.True(await peer.GetStream().ReadAsync(received, timeout.Token) > 0);
        browser.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await request);
        var record = await persisted.Task.WaitAsync(timeout.Token);
        Assert.False(record["Success"].AsBoolean);
        var evidence = record["Changes"].AsBsonDocument;
        Assert.Equal(1, evidence["attempt"].AsInt32);
        Assert.Equal("request-canceled", evidence["failureStage"].AsString);
        Assert.False(evidence["receivedResponse"].AsBoolean);
        Assert.True(evidence["httpStatus"].IsBsonNull);
        audit.Verify(x => x.InsertOneAsync(It.IsAny<BsonDocument>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    private static IMongoCollection<BsonDocument> Collection(BsonDocument document)
    {
        var collection = new Mock<IMongoCollection<BsonDocument>>();
        collection.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<BsonDocument>>(),
                It.IsAny<FindOptions<BsonDocument, BsonDocument>>(), It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                var cursor = new Mock<IAsyncCursor<BsonDocument>>();
                cursor.SetupGet(x => x.Current).Returns(new[] { document });
                cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
                return Task.FromResult(cursor.Object);
            });
        return collection.Object;
    }
}
