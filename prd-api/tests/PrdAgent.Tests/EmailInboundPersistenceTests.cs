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
using PrdAgent.Api.Controllers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.Channels;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>Uses only an explicitly supplied disposable local MongoDB; never an application database.</summary>
[Trait("Category", "Integration")]
public class EmailInboundPersistenceTests : IAsyncLifetime
{
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
