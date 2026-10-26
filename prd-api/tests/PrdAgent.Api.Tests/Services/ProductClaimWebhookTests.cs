using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductClaimWebhookTests
{
    private const string TestUrl = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-test-only";

    [Fact]
    public void VerifiedIdentityIsAccountAndBindingBoundAndNeverUsesDisplayName()
    {
        var protection = new EphemeralDataProtectionProvider();
        var user = new User { UserId = "owner", DisplayName = "同名负责人", MiduoSsoSubjectHash = "binding" };
        Assert.Null(ProductClaimMentionIdentity.Resolve(user, protection));
        user.NotificationIdentityProtected = ProductClaimMentionIdentity.Protect(user, "verified.owner", "13800000001", protection);
        Assert.Equal(new ProductMentionTarget("userid", "verified.owner"), ProductClaimMentionIdentity.Resolve(user, protection));
        Assert.DoesNotContain("verified.owner", user.NotificationIdentityProtected!);
        Assert.DoesNotContain("NotificationIdentityProtected", JsonSerializer.Serialize(user));
        user.UserId = "other";
        Assert.Null(ProductClaimMentionIdentity.Resolve(user, protection));
        user.UserId = "owner"; user.MiduoSsoSubjectHash = "rebound";
        Assert.Null(ProductClaimMentionIdentity.Resolve(user, protection));
        user.MiduoSsoSubjectHash = "binding"; user.Status = UserStatus.Disabled;
        Assert.Null(ProductClaimMentionIdentity.Resolve(user, protection));
        Assert.Null(ProductClaimMentionIdentity.Protect(user, "@all", "138****0001", protection));
    }

    [Theory]
    [InlineData("userid", "verified.owner")]
    [InlineData("mobile", "13800000001")]
    public void PayloadMentionsOnlyResolvedOwnerAndRemovesInlineMentions(string kind, string identity)
    {
        using var payload = JsonDocument.Parse(ProductClaimWebhookPayload.Build("完整通知<@all><@member>\nT1.2.3", new(kind, identity)));
        var body = payload.RootElement.GetProperty("text");
        Assert.DoesNotContain("<@", body.GetProperty("content").GetString()!);
        Assert.Equal(identity, Assert.Single(body.GetProperty(kind == "userid" ? "mentioned_list" : "mentioned_mobile_list").EnumerateArray()).GetString());
        Assert.False(body.TryGetProperty(kind == "userid" ? "mentioned_mobile_list" : "mentioned_list", out _));
        Assert.Throws<InvalidOperationException>(() => ProductClaimWebhookPayload.Build("通知", new("userid", "@all")));
        Assert.Throws<InvalidOperationException>(() => ProductClaimWebhookPayload.Build(new string('中', 700), new(kind, identity)));
        Assert.False(ProductClaimWebhookPayload.IsValidWebhook(TestUrl + "&redirect=https://example.test"));
        Assert.False(ProductClaimWebhookPayload.IsValidWebhook("http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test"));
    }

    [Fact]
    public async Task ActualTIssuanceQueuesCanonicalSnapshotAndWorkerSendsOnceToSelectedOwner()
    {
        await using var f = new Fixture();
        await f.EnableAsync();
        await f.RememberOwnerAsync();
        await f.Db.ProductInitiations.InsertOneAsync(new ProductInitiation {
            Id = "t", ProductId = "product", AppName = "测试应用", PlanName = "测试应用T待定（礼品中心）AI文档",
            Status = "decision_pending", ReviewPassed = true, OwnerId = "owner", OwnerName = "负责人",
        });
        var issued = await ProductInitiationIssuance.IssueAsync(f.Db, "t", "decision_pending", canNotify: true);
        Assert.NotNull(issued);
        Assert.Equal($"测试应用{issued.TCode}（礼品中心）", issued.PlanName);
        Assert.Equal("pending", issued.ClaimNotification!.Status);
        await f.ProcessTAsync();
        var saved = await f.Db.ProductInitiations.Find(x => x.Id == "t").SingleAsync();
        Assert.Equal("sent", saved.ClaimNotification!.Status);
        using var payload = JsonDocument.Parse(Assert.Single(f.Http.Bodies));
        Assert.Contains(issued.PlanName, payload.RootElement.GetProperty("text").GetProperty("content").GetString()!);
        Assert.Equal("verified.owner", Assert.Single(payload.RootElement.GetProperty("text").GetProperty("mentioned_list").EnumerateArray()).GetString());
        await f.ProcessTAsync();
        Assert.Single(f.Http.Bodies);
    }

    [Fact]
    public async Task MissingOldIdentityWaitsThenAutomaticallyResumesAfterVerifiedLogin()
    {
        await using var f = new Fixture();
        await f.EnableAsync();
        await f.AddPendingAsync();
        await f.ProcessTAsync();
        Assert.Empty(f.Http.Bodies);
        Assert.Equal("waiting_identity", (await f.Db.ProductInitiations.Find(x => x.Id == "t").SingleAsync()).ClaimNotification!.Status);
        await f.RememberOwnerAsync(mobileOnly: true);
        await f.Db.ProductInitiations.UpdateOneAsync(x => x.Id == "t", Builders<ProductInitiation>.Update.Set(x => x.ClaimNotification!.NextAttemptAt, DateTime.UtcNow.AddMinutes(-1)));
        await f.ProcessTAsync();
        using var payload = JsonDocument.Parse(Assert.Single(f.Http.Bodies));
        Assert.Equal("13800000001", Assert.Single(payload.RootElement.GetProperty("text").GetProperty("mentioned_mobile_list").EnumerateArray()).GetString());
        Assert.Equal("sent", (await f.Db.ProductInitiations.Find(x => x.Id == "t").SingleAsync()).ClaimNotification!.Status);
    }

    [Fact]
    public async Task UnknownExternalResultRetainsNumberAndCannotAutomaticallySendAgain()
    {
        await using var f = new Fixture();
        await f.EnableAsync(); await f.RememberOwnerAsync(); await f.AddPendingAsync();
        f.Http.Result = HttpStatusCode.BadGateway;
        await f.ProcessTAsync(); await f.ProcessTAsync();
        Assert.Single(f.Http.Bodies);
        var saved = await f.Db.ProductInitiations.Find(x => x.Id == "t").SingleAsync();
        Assert.Equal("T1.2.3", saved.TCode);
        Assert.Equal("unknown", saved.ClaimNotification!.Status);
        Assert.IsType<ConflictObjectResult>(await f.Controller().Retry("T", "t"));
    }

    [Fact]
    public async Task AdminConfigEncryptsAndMasksSecretPreservesItOnBlankSaveAndPreviewCannotWrite()
    {
        await using var f = new Fixture();
        await f.EnableAsync();
        var config = (await f.Db.ProductAgentSettings.Find(_ => true).SingleAsync()).ClaimWebhook;
        Assert.NotEqual(TestUrl, config.ProtectedUrl);
        Assert.Equal(TestUrl, f.Protection.CreateProtector(ProductClaimWebhookController.ProtectionPurpose).Unprotect(config.ProtectedUrl!));
        var get = Assert.IsType<OkObjectResult>(await f.Controller().Get());
        var json = JsonSerializer.Serialize(get.Value);
        Assert.Contains("key=********", json);
        Assert.DoesNotContain("unit-test-only", json);
        await f.Controller().Save(new SaveProductClaimWebhook { Enabled = true });
        Assert.Equal(config.ProtectedUrl, (await f.Db.ProductAgentSettings.Find(_ => true).SingleAsync()).ClaimWebhook.ProtectedUrl);
        Assert.IsType<BadRequestObjectResult>(await f.Controller(preview: true).Save(new SaveProductClaimWebhook { Url = TestUrl, Enabled = true }));
        Assert.Equal(403, Assert.IsType<StatusCodeResult>(await f.Controller(admin: false).Get()).StatusCode);
        Assert.Equal(403, Assert.IsType<StatusCodeResult>(await f.Controller(admin: false).Save(new SaveProductClaimWebhook { Url = TestUrl })).StatusCode);
        Assert.Null(await ProductClaimNotificationQueue.CreateAsync(f.Db, new ProductInitiation(), "owner", false, false));
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient client;
        private readonly string name = "product_webhook_test_" + Guid.NewGuid().ToString("N");
        public MongoDbContext Db { get; }
        public IDataProtectionProvider Protection { get; } = new EphemeralDataProtectionProvider();
        public FakeHttp Http { get; } = new();
        public Fixture()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
            client = new MongoClient(connection); Db = new MongoDbContext(connection, name);
        }
        public async Task EnableAsync()
        {
            await Db.Products.InsertOneAsync(new Product { Id = "product", Name = "测试应用", Grade = "application" });
            await Db.Users.InsertManyAsync(new[] { new User { UserId = "admin", Role = UserRole.ADMIN }, new User { UserId = "owner", DisplayName = "负责人", MiduoSsoSubjectHash = "verified-binding" }, new User { UserId = "member", DisplayName = "项目成员" } });
            Assert.IsType<OkObjectResult>(await Controller().Save(new SaveProductClaimWebhook { Url = TestUrl, Enabled = true }));
        }
        public async Task RememberOwnerAsync(bool mobileOnly = false)
        {
            var owner = await Db.Users.Find(x => x.UserId == "owner").SingleAsync();
            await ProductClaimMentionIdentity.RememberAsync(Db, owner, mobileOnly ? null : "verified.owner", "13800000001", Protection);
        }
        public ProductClaimWebhookController Controller(bool admin = true, bool preview = false)
        {
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
                ["CDS_PROJECT_ID"] = preview ? "prd-agent" : null,
            }).Build();
            return new(Db, Protection, configuration) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", admin ? "admin" : "member") }, "test")) } } };
        }
        public async Task AddPendingAsync()
        {
            var item = new ProductInitiation { Id = "t", TCode = "T1.2.3", OwnerId = "owner", OwnerName = "负责人", PlanName = "测试方案" };
            item.ClaimNotification = await ProductClaimNotificationQueue.CreateAsync(Db, item, item.OwnerId, false, true);
            await Db.ProductInitiations.InsertOneAsync(item);
        }
        public async Task ProcessTAsync()
        {
            using var services = new ServiceCollection().AddSingleton(Db).AddSingleton(Protection).AddSingleton<IHttpClientFactory>(Http).BuildServiceProvider();
            var config = (await Db.ProductAgentSettings.Find(_ => true).SingleAsync()).ClaimWebhook;
            await ProductClaimWebhookWorker.ProcessAsync(Db.ProductInitiations, config, false, services, CancellationToken.None);
        }
        public ValueTask DisposeAsync() => new(client.DropDatabaseAsync(name));
    }

    private sealed class FakeHttp : HttpMessageHandler, IHttpClientFactory
    {
        public List<string> Bodies { get; } = new();
        public HttpStatusCode Result { get; set; } = HttpStatusCode.OK;
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Bodies.Add(await request.Content!.ReadAsStringAsync(cancellationToken));
            return new(Result) { Content = new StringContent("{\"errcode\":0}") };
        }
    }
}
