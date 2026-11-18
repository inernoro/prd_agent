using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System.Net;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using MongoDB.Bson;
using PrdAgent.Api.Controllers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.Channels;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>Uses only an explicitly supplied disposable local MongoDB; never an application database.</summary>
[Trait("Category", "Integration")]
public class EmailInboundPersistenceTests : IAsyncLifetime
{
    private readonly ITestOutputHelper _output;
    public EmailInboundPersistenceTests(ITestOutputHelper output) => _output = output;

    private readonly string _databaseName = "email_webhook_test_" + Guid.NewGuid().ToString("N");
    private MongoDbContext _db = null!;
    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private const string Recipient = "inbox@example.net";
    private const string Owner = "configured-mailbox-owner";

    public async Task InitializeAsync()
    {
        var uri = Environment.GetEnvironmentVariable("EMAIL_WEBHOOK_TEST_MONGO");
        if (string.IsNullOrWhiteSpace(uri))
            throw new InvalidOperationException("Set EMAIL_WEBHOOK_TEST_MONGO to a disposable local MongoDB instance.");
        var settings = MongoClientSettings.FromConnectionString(uri);
        if (settings.Servers.Any(s => s.Host is not "127.0.0.1" and not "localhost" and not "::1"))
            throw new InvalidOperationException("Email webhook tests require loopback MongoDB.");
        _db = new MongoDbContext(uri, _databaseName);
        await _db.Users.InsertOneAsync(new User { UserId = Owner, Username = "mailbox", DisplayName = "Mailbox owner" });
        await _db.ChannelWhitelists.InsertOneAsync(new ChannelWhitelist
        {
            ChannelType = ChannelTypes.Email, IdentifierPattern = "*", DailyQuota = 0,
            BoundUserId = "spoofable-from-owner", BoundUserName = "Must not own the task"
        });
    }

    public async Task DisposeAsync()
    {
        if (_db != null) await _db.Database.Client.DropDatabaseAsync(_databaseName);
        _key.Dispose();
    }

    [Theory]
    [InlineData("missing-key")]
    [InlineData("malformed-key")]
    [InlineData("missing-signature")]
    [InlineData("missing-timestamp")]
    [InlineData("bad-signature")]
    [InlineData("other-channel-key")]
    [InlineData("tampered-body")]
    [InlineData("stale")]
    [InlineData("future")]
    [InlineData("duplicate-timestamp")]
    [InlineData("wrong-recipient")]
    [InlineData("multiple-recipients")]
    [InlineData("missing-owner")]
    [InlineData("missing-recipient")]
    [InlineData("inactive-owner")]
    [InlineData("unknown-owner")]
    public async Task Rejected_requests_never_persist_tasks(string scenario)
    {
        var body = Body("rejected", scenario == "wrong-recipient" ? "other@example.net" : Recipient,
            multipleRecipients: scenario == "multiple-recipients");
        var config = Configuration();
        if (scenario == "missing-key") config["Channels:Email:SendGrid:ParsePublicKey"] = null;
        if (scenario == "malformed-key") config["Channels:Email:SendGrid:ParsePublicKey"] = "not a public key";
        if (scenario == "missing-recipient") config["Channels:Email:SendGrid:Recipient"] = null;
        if (scenario == "inactive-owner") await _db.Users.UpdateOneAsync(x => x.UserId == Owner, Builders<User>.Update.Set(x => x.Status, UserStatus.Disabled));
        if (scenario == "missing-owner") config["Channels:Email:SendGrid:OwnerUserId"] = null;
        if (scenario == "unknown-owner") config["Channels:Email:SendGrid:OwnerUserId"] = "nonexistent-owner";
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + (scenario == "stale" ? -600 : scenario == "future" ? 600 : 0);
        var context = Context(body, timestamp);
        if (scenario == "missing-timestamp") context.Request.Headers.Remove("X-Twilio-Email-Event-Webhook-Timestamp");
        if (scenario == "missing-signature") context.Request.Headers.Remove("X-Twilio-Email-Event-Webhook-Signature");
        if (scenario == "bad-signature") context.Request.Headers["X-Twilio-Email-Event-Webhook-Signature"] = "AAAA";
        if (scenario == "other-channel-key")
        {
            using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            context.Request.Headers["X-Twilio-Email-Event-Webhook-Signature"] = Sign(otherKey, timestamp, body);
        }
        if (scenario == "tampered-body") context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(body).Replace("hello", "evil!")));
        if (scenario == "duplicate-timestamp") context.Request.Headers.Append("X-Twilio-Email-Event-Webhook-Timestamp", timestamp.ToString());
        await Controller(context, config).ReceiveInbound(CancellationToken.None);
        Assert.Equal(0, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
    }

    [Fact]
    public async Task Concurrent_replays_and_recreated_services_keep_one_correctly_owned_task_and_attachment()
    {
        var body = Body("concurrent", Recipient);
        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
            Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None)));
        Assert.All(results, result => Assert.IsType<OkResult>(result));
        // New controller, service and MongoDbContext simulate a process restart without sharing any memory cache.
        _db = new MongoDbContext(Environment.GetEnvironmentVariable("EMAIL_WEBHOOK_TEST_MONGO")!, _databaseName);
        Assert.IsType<OkResult>(await Controller(Context(body, DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1), Configuration()).ReceiveInbound(CancellationToken.None));
        var task = Assert.Single(await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync());
        Assert.Equal(Owner, task.MappedUserId);
        Assert.Equal("sender@example.com", task.SenderIdentifier);
        Assert.Equal("fixture\n\nhello 中文", task.OriginalContent);
        var attachment = Assert.Single(task.Attachments);
        Assert.Equal("sample.bin", attachment.FileName);
        Assert.Equal(5, attachment.FileSize);
        Assert.Equal("application/octet-stream", attachment.MimeType);
    }

    [Fact]
    public async Task Urlencoded_html_form_survives_verification_and_deduplicates()
    {
        var fields = new Dictionary<string, string>
        {
            ["from"] = "sender@example.com", ["to"] = Recipient, ["html"] = "<p>Hello &amp; bye</p>",
            ["envelope"] = "{\"to\":[\"" + Recipient + "\"],\"from\":\"sender@example.com\"}",
            ["headers"] = "Message-ID: <urlencoded@example.com>\r\n"
        };
        var body = Encoding.UTF8.GetBytes(string.Join("&", fields.Select(x => Uri.EscapeDataString(x.Key) + "=" + Uri.EscapeDataString(x.Value))));
        for (var i = 0; i < 2; i++)
        {
            var context = Context(body);
            context.Request.ContentType = "application/x-www-form-urlencoded";
            Assert.IsType<OkResult>(await Controller(context, Configuration()).ReceiveInbound(CancellationToken.None));
        }
        var task = Assert.Single(await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync());
        Assert.Equal("Hello & bye", task.OriginalContent);
        Assert.Equal(Owner, task.MappedUserId);
    }

    [Fact]
    public async Task Mail_without_message_id_deduplicates_across_resigning_and_multipart_boundary_changes()
    {
        var body = Encoding.Latin1.GetBytes(Encoding.Latin1.GetString(Body("remove-me", Recipient))
            .Replace("Message-ID: <remove-me@example.com>\r\n", ""));
        Assert.IsType<OkResult>(await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None));
        var retriedBody = Encoding.Latin1.GetBytes(Encoding.Latin1.GetString(body).Replace("test-boundary", "retry-boundary"));
        var retry = Context(retriedBody, DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1);
        retry.Request.ContentType = "multipart/form-data; boundary=retry-boundary";
        Assert.IsType<OkResult>(await Controller(retry, Configuration()).ReceiveInbound(CancellationToken.None));
        Assert.Single(await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync());
    }

    [Fact]
    public async Task Real_http_mvc_checks_authentication_before_form_parsing_then_persists_once()
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Development" });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        builder.Configuration.AddConfiguration(Configuration());
        builder.Services.AddSingleton(_db);
        builder.Services.AddSingleton<WhitelistMatcherService>();
        builder.Services.AddSingleton<IntentDetectorService>();
        builder.Services.AddSingleton<ChannelTaskService>();
        builder.Services.AddControllers().AddApplicationPart(typeof(EmailChannelController).Assembly);
        await using var app = builder.Build();
        app.MapControllers();
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        var previousEnvironment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
        try
        {
            Environment.SetEnvironmentVariable("ASPNETCORE_ENVIRONMENT", "Development");
            using var legacyResponse = await client.PostAsync("/api/channels/email/inbound/test",
                new StringContent("{\"from\":\"sender@example.com\",\"text\":\"legacy bypass\"}", Encoding.UTF8, "application/json"));
            Assert.Equal(HttpStatusCode.NotFound, legacyResponse.StatusCode);
            Assert.Equal(0, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        }
        finally { Environment.SetEnvironmentVariable("ASPNETCORE_ENVIRONMENT", previousEnvironment); }
        var body = Body("http", Recipient);
        async Task<HttpStatusCode> Post(byte[] bytes, bool authenticated, string? contentType = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/channels/email/inbound");
            request.Content = new ByteArrayContent(bytes);
            request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType ?? "multipart/form-data; boundary=test-boundary");
            if (authenticated)
            {
                var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                request.Headers.Add("X-Twilio-Email-Event-Webhook-Timestamp", timestamp.ToString());
                request.Headers.Add("X-Twilio-Email-Event-Webhook-Signature", Sign(_key, timestamp, bytes));
            }
            using var response = await client.SendAsync(request);
            return response.StatusCode;
        }
        Assert.Equal(HttpStatusCode.Unauthorized, await Post(Encoding.ASCII.GetBytes("malformed multipart"), false));
        Assert.Equal(HttpStatusCode.Unauthorized, await Post(body, true, "multipart/form-data; boundary=wrong-boundary"));
        Assert.Equal(HttpStatusCode.Unauthorized, await Post(body, true, "multipart/form-data; boundary=test-boundary; charset=iso-8859-1"));
        Assert.Equal(HttpStatusCode.Unauthorized, await Post(Encoding.UTF8.GetBytes("text=café"), true,
            "application/x-www-form-urlencoded; charset=iso-8859-1"));
        Assert.Equal(0, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        Assert.Equal(HttpStatusCode.OK, await Post(body, true));
        Assert.Equal(HttpStatusCode.OK, await Post(body, true));
        var task = Assert.Single(await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync());
        Assert.Equal(Owner, task.MappedUserId);
        Assert.Single(task.Attachments);
        await app.StopAsync();
    }

    [Fact]
    public async Task Kd17_concurrent_same_delivery_charges_quota_once()
    {
        await SetQuotaAsync(100, DateTime.UtcNow.ToString("yyyy-MM-dd"));
        await ConfigureFailPointAsync("alwaysOn", new BsonDocument
        {
            { "failCommands", new BsonArray { "insert" } }, { "namespace", _databaseName + ".channel_tasks" },
            { "blockConnection", true }, { "blockTimeMS", 500 }
        });
        try
        {
            var body = Body("quota-replay", Recipient);
            await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
                Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None)));
        }
        finally { await DisableFailPointAsync(); }
        Assert.Equal(1, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        var whitelist = await _db.ChannelWhitelists.Find(FilterDefinition<ChannelWhitelist>.Empty).SingleAsync();
        Assert.Equal(1, whitelist.TodayUsedCount);
    }

    [Fact]
    public async Task Kd17_new_day_parallel_distinct_deliveries_cannot_exceed_quota()
    {
        await SetQuotaAsync(1, DateTime.UtcNow.AddDays(-1).ToString("yyyy-MM-dd"));
        // Delay writes so all callers read yesterday's quota snapshot before any reset completes.
        await ConfigureFailPointAsync("alwaysOn", new BsonDocument
        {
            { "failCommands", new BsonArray { "update", "findAndModify" } }, { "namespace", _databaseName + ".channel_whitelist" },
            { "blockConnection", true }, { "blockTimeMS", 500 }
        });
        try
        {
            await Task.WhenAll(Enumerable.Range(0, 8).Select(i =>
                Controller(Context(Body("new-day-" + i, Recipient)), Configuration()).ReceiveInbound(CancellationToken.None)));
        }
        finally { await DisableFailPointAsync(); }
        Assert.Equal(1, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        var whitelist = await _db.ChannelWhitelists.Find(FilterDefinition<ChannelWhitelist>.Empty).SingleAsync();
        Assert.Equal(1, whitelist.TodayUsedCount);
    }

    [Fact]
    public async Task Kd17_task_insert_failure_then_retry_does_not_charge_twice()
    {
        await SetQuotaAsync(1, DateTime.UtcNow.ToString("yyyy-MM-dd"));
        await ConfigureFailPointAsync(new BsonDocument("times", 1), new BsonDocument
        {
            { "failCommands", new BsonArray { "insert" } }, { "namespace", _databaseName + ".channel_tasks" }, { "errorCode", 2 }
        });
        var body = Body("insert-retry", Recipient);
        try
        {
            var first = await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None);
            Assert.Equal(503, Assert.IsType<StatusCodeResult>(first).StatusCode);
            Assert.Equal(0, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        }
        finally { await DisableFailPointAsync(); }
        Assert.IsType<OkResult>(await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None));
        Assert.Equal(1, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        var whitelist = await _db.ChannelWhitelists.Find(FilterDefinition<ChannelWhitelist>.Empty).SingleAsync();
        Assert.Equal(1, whitelist.TodayUsedCount);
    }

    [Theory]
    [InlineData("valid")]
    [InlineData("valid-full")]
    [InlineData("expired")]
    [InlineData("disabled")]
    [InlineData("revoked")]
    [InlineData("replaced")]
    public async Task Kd17_overnight_retry_respects_receipt_expiry_and_current_permissions(string scenario)
    {
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");
        var yesterday = DateTime.UtcNow.AddDays(-1).ToString("yyyy-MM-dd");
        await SetQuotaAsync(1, yesterday);
        var body = Body("overnight-retry", Recipient);
        await ConfigureFailPointAsync(new BsonDocument("times", 1), new BsonDocument
        {
            { "failCommands", new BsonArray { "insert" } },
            { "namespace", _databaseName + ".channel_tasks" },
            { "errorCode", 2 }
        });
        try
        {
            var result = await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None);
            Assert.Equal(503, Assert.IsType<StatusCodeResult>(result).StatusCode);
        }
        finally { await DisableFailPointAsync(); }

        var all = FilterDefinition<ChannelWhitelist>.Empty;
        var rule = await _db.ChannelWhitelists.Find(all).SingleAsync();
        var receipt = Assert.Single(rule.EmailQuotaAdmissions);
        Assert.Equal(1, rule.TodayUsedCount);
        Assert.Equal(0, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        var updates = Builders<ChannelWhitelist>.Update;
        await _db.ChannelWhitelists.UpdateOneAsync(all, updates
            .Set(x => x.TodayDate, yesterday)
            .Set(x => x.EmailQuotaAdmissions, new List<EmailQuotaAdmission>
            {
                receipt with { ExpiresAt = scenario == "expired"
                    ? DateTime.UtcNow.AddMinutes(-1) : receipt.ExpiresAt }
            }));
        if (scenario == "valid-full")
        {
            var other = Body("new-day-quota", Recipient);
            Assert.IsType<OkResult>(await Controller(Context(other), Configuration())
                .ReceiveInbound(CancellationToken.None));
        }
        if (scenario == "disabled")
            await _db.ChannelWhitelists.UpdateOneAsync(all, updates.Set(x => x.IsActive, false));
        if (scenario == "revoked")
            await _db.ChannelWhitelists.UpdateOneAsync(all, updates.Set(x => x.AllowedOperations,
                new List<string> { "unrelated-operation" }));

        if (scenario == "replaced")
        {
            await _db.ChannelWhitelists.DeleteOneAsync(all);
            rule.Id = Guid.NewGuid().ToString("N");
            rule.TodayDate = today;
            rule.EmailQuotaAdmissions.Clear();
            await _db.ChannelWhitelists.InsertOneAsync(rule);
        }

        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
            Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None)));

        var permitted = scenario is "valid" or "valid-full" or "expired";
        Assert.Equal(scenario == "valid-full" ? 2 : permitted ? 1 : 0, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        var after = await _db.ChannelWhitelists.Find(all).SingleAsync();
        Assert.Equal(permitted || scenario == "replaced" ? today : yesterday, after.TodayDate);
        Assert.Equal(scenario == "valid" ? 0 : 1, after.TodayUsedCount);
        if (scenario is "valid" or "valid-full")
            Assert.Equal(receipt, Assert.Single(after.EmailQuotaAdmissions.Where(x => x.Key == receipt.Key)));
        if (scenario == "expired")
            Assert.True(Assert.Single(after.EmailQuotaAdmissions).ExpiresAt > receipt.ExpiresAt.AddMinutes(-1));
    }

    [Fact]
    public async Task Kd17_audit_insert_failure_then_retry_repairs_one_accepted_log()
    {
        await SetQuotaAsync(100, DateTime.UtcNow.ToString("yyyy-MM-dd"));
        // Fail only this test database's accepted-audit collection, independently of write ordering.
        await ConfigureFailPointAsync(new BsonDocument("times", 1), new BsonDocument
        {
            { "failCommands", new BsonArray { "insert", "update", "findAndModify" } }, { "namespace", _databaseName + ".channel_request_logs" }, { "errorCode", 2 }
        });
        var body = Body("audit-retry", Recipient);
        try
        {
            var first = await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None);
            Assert.Equal(503, Assert.IsType<StatusCodeResult>(first).StatusCode);
            Assert.Equal(1, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        }
        finally { await DisableFailPointAsync(); }
        var retries = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
            Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None)));
        Assert.All(retries, result => Assert.IsType<OkResult>(result));
        var task = Assert.Single(await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync());
        var audit = Assert.Single(await _db.ChannelRequestLogs.Find(x => x.TaskId == task.Id
            && x.Status == ChannelRequestLogStatus.Accepted).ToListAsync());
        Assert.Equal(Owner, audit.MappedUserId);
        Assert.Equal(1, (await _db.ChannelWhitelists.Find(FilterDefinition<ChannelWhitelist>.Empty).SingleAsync()).TodayUsedCount);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public async Task Kd17_legacy_quota_document_preserves_usage_without_delivery_set(int priorUsage)
    {
        await SetQuotaAsync(priorUsage + 1, DateTime.UtcNow.ToString("yyyy-MM-dd"));
        await _db.ChannelWhitelists.UpdateManyAsync(FilterDefinition<ChannelWhitelist>.Empty,
            Builders<ChannelWhitelist>.Update.Set(x => x.TodayUsedCount, priorUsage).Unset("TodayChargedDeliveryIds"));
        await Controller(Context(Body("legacy-allowed", Recipient)), Configuration()).ReceiveInbound(CancellationToken.None);
        await Controller(Context(Body("legacy-over-quota", Recipient)), Configuration()).ReceiveInbound(CancellationToken.None);
        Assert.Equal(1, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        Assert.Equal(priorUsage + 1, (await _db.ChannelWhitelists.Find(FilterDefinition<ChannelWhitelist>.Empty).SingleAsync()).TodayUsedCount);
    }

    [Fact]
    public async Task Kd17_charged_retry_cannot_bypass_disabled_whitelist()
    {
        await SetQuotaAsync(1, DateTime.UtcNow.ToString("yyyy-MM-dd"));
        await ConfigureFailPointAsync(new BsonDocument("times", 1), new BsonDocument
        {
            { "failCommands", new BsonArray { "insert" } }, { "namespace", _databaseName + ".channel_tasks" }, { "errorCode", 2 }
        });
        var body = Body("disabled-after-charge", Recipient);
        try
        {
            var first = await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None);
            Assert.Equal(503, Assert.IsType<StatusCodeResult>(first).StatusCode);
        }
        finally { await DisableFailPointAsync(); }
        await _db.ChannelWhitelists.UpdateManyAsync(FilterDefinition<ChannelWhitelist>.Empty,
            Builders<ChannelWhitelist>.Update.Set(x => x.IsActive, false));
        await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None);
        Assert.Equal(0, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        Assert.Equal(1, (await _db.ChannelWhitelists.Find(FilterDefinition<ChannelWhitelist>.Empty).SingleAsync()).TodayUsedCount);
    }

    [Fact]
    public async Task Kd17_persisted_previous_day_delivery_replay_never_touches_today_quota()
    {
        await SetQuotaAsync(1, DateTime.UtcNow.ToString("yyyy-MM-dd"));
        var body = Body("previous-day", Recipient);
        Assert.IsType<OkResult>(await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None));
        var yesterday = DateTime.UtcNow.AddDays(-1);
        await _db.ChannelTasks.UpdateManyAsync(FilterDefinition<ChannelTask>.Empty,
            Builders<ChannelTask>.Update.Set(x => x.CreatedAt, yesterday));
        await _db.ChannelWhitelists.UpdateManyAsync(FilterDefinition<ChannelWhitelist>.Empty,
            Builders<ChannelWhitelist>.Update.Set(x => x.TodayDate, yesterday.ToString("yyyy-MM-dd")));
        _db = new MongoDbContext(Environment.GetEnvironmentVariable("EMAIL_WEBHOOK_TEST_MONGO")!, _databaseName);
        Assert.IsType<OkResult>(await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None));
        Assert.Equal(1, await _db.ChannelTasks.CountDocumentsAsync(FilterDefinition<ChannelTask>.Empty));
        var whitelist = await _db.ChannelWhitelists.Find(FilterDefinition<ChannelWhitelist>.Empty).SingleAsync();
        Assert.Equal(1, whitelist.TodayUsedCount);
        Assert.Equal(yesterday.ToString("yyyy-MM-dd"), whitelist.TodayDate);
    }

    [Fact]
    public async Task Kd17_legacy_accepted_log_is_preserved_without_duplicate_or_id_rewrite()
    {
        var body = Body("legacy-audit", Recipient);
        Assert.IsType<OkResult>(await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None));
        var task = Assert.Single(await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync());
        var original = Assert.Single(await _db.ChannelRequestLogs.Find(x => x.TaskId == task.Id).ToListAsync());
        await _db.ChannelRequestLogs.DeleteOneAsync(x => x.Id == original.Id);
        original.Id = Guid.NewGuid().ToString("N");
        await _db.ChannelRequestLogs.InsertOneAsync(original);
        _db = new MongoDbContext(Environment.GetEnvironmentVariable("EMAIL_WEBHOOK_TEST_MONGO")!, _databaseName);
        Assert.IsType<OkResult>(await Controller(Context(body), Configuration()).ReceiveInbound(CancellationToken.None));
        var preserved = Assert.Single(await _db.ChannelRequestLogs.Find(x => x.TaskId == task.Id).ToListAsync());
        Assert.Equal(original.Id, preserved.Id);
        Assert.Equal(original.CreatedAt, preserved.CreatedAt);
    }

    [Fact]
    [Trait("Category", "Manual")]
    public async Task IdempotencyDiagnostic_no_message_id_identical_independent_submissions_are_merged()
    {
        var body = Encoding.Latin1.GetBytes(Encoding.Latin1.GetString(Body("no-id-diagnostic", Recipient))
            .Replace("Message-ID: <no-id-diagnostic@example.com>\r\n", ""));
        for (var i = 0; i < 2; i++)
            Assert.IsType<OkResult>(await Controller(Context(body, DateTimeOffset.UtcNow.ToUnixTimeSeconds() + i), Configuration())
                .ReceiveInbound(CancellationToken.None));
        Assert.Single(await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync());
        _output.WriteLine("OBSERVED ONLY: two independently submitted identical messages without Message-ID yield one task; the second intentional submission is indistinguishable from retry and is merged. This is not product acceptance.");
    }

    [Fact]
    [Trait("Category", "Manual")]
    public async Task IdempotencyDiagnostic_same_message_id_changed_body_preserves_first_submission()
    {
        var first = Body("shared-message-id", Recipient);
        var second = Encoding.Latin1.GetBytes(Encoding.Latin1.GetString(first).Replace("hello ", "second "));
        Assert.IsType<OkResult>(await Controller(Context(first), Configuration()).ReceiveInbound(CancellationToken.None));
        Assert.IsType<OkResult>(await Controller(Context(second), Configuration()).ReceiveInbound(CancellationToken.None));
        var task = Assert.Single(await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync());
        Assert.Equal("fixture\n\nhello 中文", task.OriginalContent);
        _output.WriteLine("OBSERVED ONLY: same Message-ID and recipient with different signed content retains the first task/content; later content is ignored. This is compatibility evidence, not product acceptance.");
    }

    [Fact]
    [Trait("Category", "Manual")]
    public async Task IdempotencyDiagnostic_distinct_message_ids_identical_content_create_two_tasks()
    {
        for (var i = 0; i < 2; i++)
            Assert.IsType<OkResult>(await Controller(Context(Body("independent-" + i, Recipient)), Configuration())
                .ReceiveInbound(CancellationToken.None));
        var tasks = await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync();
        Assert.Equal(2, tasks.Count);
        Assert.All(tasks, task => Assert.Equal("fixture\n\nhello 中文", task.OriginalContent));
        _output.WriteLine("OBSERVED ONLY: distinct Message-IDs with identical content and recipient create two tasks. No change to the existing deduplication contract is asserted.");
    }

    [Fact]
    [Trait("Category", "Manual")]
    public async Task IdempotencyDiagnostic_same_message_id_distinct_mailboxes_create_two_tasks()
    {
        foreach (var recipient in new[] { Recipient, "other-inbox@example.net" })
        {
            var config = Configuration();
            config["Channels:Email:SendGrid:Recipient"] = recipient;
            Assert.IsType<OkResult>(await Controller(Context(Body("cross-mailbox", recipient)), config)
                .ReceiveInbound(CancellationToken.None));
        }
        var tasks = await _db.ChannelTasks.Find(FilterDefinition<ChannelTask>.Empty).ToListAsync();
        Assert.Equal(2, tasks.Count);
        Assert.All(tasks, task => Assert.Equal(Owner, task.MappedUserId));
        _output.WriteLine("OBSERVED ONLY: the same Message-ID delivered to two separately configured recipient channels creates one task per mailbox (two total), both bound to their configured owner.");
    }

    private Task SetQuotaAsync(int limit, string day) => _db.ChannelWhitelists.UpdateManyAsync(
        FilterDefinition<ChannelWhitelist>.Empty, Builders<ChannelWhitelist>.Update
            .Set(x => x.DailyQuota, limit).Set(x => x.TodayDate, day).Set(x => x.TodayUsedCount, 0));

    private async Task ConfigureFailPointAsync(BsonValue mode, BsonDocument data) =>
        await _db.Database.Client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument
        {
            { "configureFailPoint", "failCommand" }, { "mode", mode }, { "data", data }
        });

    private Task DisableFailPointAsync() => ConfigureFailPointAsync("off", new BsonDocument());

    private EmailChannelController Controller(DefaultHttpContext context, IConfiguration configuration)
    {
        var service = new ChannelTaskService(_db,
            new WhitelistMatcherService(_db, NullLogger<WhitelistMatcherService>.Instance),
            new IntentDetectorService(NullLogger<IntentDetectorService>.Instance),
            NullLogger<ChannelTaskService>.Instance);
        return new EmailChannelController(service, NullLogger<EmailChannelController>.Instance, configuration)
        { ControllerContext = new ControllerContext { HttpContext = context } };
    }

    private IConfigurationRoot Configuration() => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["Channels:Email:SendGrid:ParsePublicKey"] = Convert.ToBase64String(_key.ExportSubjectPublicKeyInfo()),
        ["Channels:Email:SendGrid:Recipient"] = Recipient,
        ["Channels:Email:SendGrid:OwnerUserId"] = Owner
    }).Build();

    private DefaultHttpContext Context(byte[] body, long? timestamp = null)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = "POST";
        context.Request.ContentType = "multipart/form-data; boundary=test-boundary";
        context.Request.ContentLength = body.Length;
        context.Request.Body = new MemoryStream(body);
        var ts = timestamp ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        context.Request.Headers["X-Twilio-Email-Event-Webhook-Timestamp"] = ts.ToString();
        context.Request.Headers["X-Twilio-Email-Event-Webhook-Signature"] = Sign(_key, ts, body);
        return context;
    }

    private static string Sign(ECDsa key, long timestamp, byte[] body) => Convert.ToBase64String(key.SignData(
        Encoding.ASCII.GetBytes(timestamp.ToString()).Concat(body).ToArray(), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence));

    private static byte[] Body(string id, string recipient, bool multipleRecipients = false)
    {
        var envelope = "{\"to\":[\"" + recipient + "\"" + (multipleRecipients ? ",\"other@example.net\"" : "") + "],\"from\":\"sender@example.com\"}";
        var fields = new Dictionary<string, string>
        {
            ["from"] = "Forged Name <sender@example.com>", ["to"] = Recipient, ["subject"] = "fixture", ["text"] = "hello 中文",
            ["envelope"] = envelope, ["headers"] = "Message-ID: <" + id + "@example.com>\r\n"
        };
        var prefix = string.Concat(fields.Select(x => "--test-boundary\r\nContent-Disposition: form-data; name=\"" + x.Key + "\"\r\n\r\n" + x.Value + "\r\n"))
            + "--test-boundary\r\nContent-Disposition: form-data; name=\"attachment1\"; filename=\"sample.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n";
        return Encoding.UTF8.GetBytes(prefix).Concat(new byte[] { 0, 255, 128, 13, 10 }).Concat(Encoding.ASCII.GetBytes("\r\n--test-boundary--\r\n")).ToArray();
    }
}
