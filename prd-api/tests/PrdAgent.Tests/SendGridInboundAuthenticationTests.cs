using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services.Channels;
using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.Channels;

namespace PrdAgent.Tests;

public class SendGridInboundAuthenticationTests
{
    [Theory]
    [InlineData("TASK-20261117-A1B2C3")]
    [InlineData("EMAIL-0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF")]
    public void Cancellation_intent_preserves_legacy_and_deterministic_email_task_ids(string taskId)
    {
        var detector = new IntentDetectorService(NullLogger<IntentDetectorService>.Instance);
        var result = detector.Detect(null, "[cancel] " + taskId.ToLowerInvariant());
        Assert.Equal(ChannelTaskIntent.Cancel, result.Intent);
        Assert.Equal(taskId, result.Parameters["taskId"]);
    }

    [Fact]
    public async Task Independent_python_signed_raw_fixture_verifies_and_preserves_form_and_binary_attachment()
    {
        var (request, config, now, body) = Fixture();
        var result = await SendGridInboundAuthentication.ValidateAsync(request, config, CancellationToken.None, now);
        Assert.NotNull(result);
        Assert.Equal(Convert.ToHexString(SHA256.HashData(body)), result!.BodyHash);
        Assert.Equal(0, request.Body.Position);
        var form = await request.ReadFormAsync();
        Assert.Equal("fixture 中文", form["subject"].ToString());
        Assert.Equal("hello\r\nworld", form["text"].ToString());
        var file = Assert.Single(form.Files);
        using var output = new MemoryStream();
        await file.CopyToAsync(output);
        Assert.Equal(new byte[] { 0, 255, 128 }.Concat(System.Text.Encoding.ASCII.GetBytes("binary")).ToArray(), output.ToArray());
    }

    [Theory]
    [InlineData("body-byte")]
    [InlineData("attachment-byte")]
    [InlineData("timestamp")]
    [InlineData("expired")]
    [InlineData("future")]
    [InlineData("signature")]
    [InlineData("key")]
    [InlineData("legacy-key-only")]
    [InlineData("missing-config")]
    [InlineData("oversized")]
    [InlineData("charset")]
    public async Task Independent_fixture_rejects_mutation_or_incomplete_authentication(string mutation)
    {
        var (request, config, now, body) = Fixture();
        if (mutation is "body-byte" or "attachment-byte")
        {
            body[mutation == "body-byte" ? 80 : Array.IndexOf(body, (byte)255)] ^= 1;
            request.Body = new MemoryStream(body);
        }
        if (mutation == "timestamp") request.Headers[SendGridInboundAuthentication.TimestampHeader] = (now.ToUnixTimeSeconds() + 1).ToString();
        if (mutation == "expired") now = now.AddSeconds(301);
        if (mutation == "future") now = now.AddSeconds(-301);
        if (mutation == "signature") request.Headers[SendGridInboundAuthentication.SignatureHeader] = "invalid";
        if (mutation == "key") config["Channels:Email:SendGrid:ParsePublicKey"] = "invalid";
        if (mutation == "legacy-key-only")
        {
            config["Channels:Email:SendGrid:WebhookSigningKey"] = config["Channels:Email:SendGrid:ParsePublicKey"];
            config["Channels:Email:SendGrid:ParsePublicKey"] = null;
        }
        if (mutation == "missing-config") config = new ConfigurationBuilder().Build();
        if (mutation == "charset") request.ContentType += "; charset=iso-8859-1";
        if (mutation == "oversized") request.ContentLength = SendGridInboundAuthentication.MaxBodyBytes + 1;
        Assert.Null(await SendGridInboundAuthentication.ValidateAsync(request, config, CancellationToken.None, now));
    }

    private static (HttpRequest, IConfigurationRoot, DateTimeOffset, byte[]) Fixture()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "fixtures", "sendgrid-inbound");
        var body = File.ReadAllBytes(Path.Combine(root, "multipart.bin"));
        using var metadata = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "multipart.json")));
        var data = metadata.RootElement;
        var request = new DefaultHttpContext().Request;
        request.ContentType = data.GetProperty("contentType").GetString();
        request.Body = new MemoryStream(body);
        request.ContentLength = body.Length;
        request.Headers[SendGridInboundAuthentication.SignatureHeader] = data.GetProperty("signature").GetString();
        request.Headers[SendGridInboundAuthentication.TimestampHeader] = data.GetProperty("timestamp").GetString();
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Channels:Email:SendGrid:ParsePublicKey"] = data.GetProperty("publicKey").GetString(),
            ["Channels:Email:SendGrid:Recipient"] = "inbox@example.net",
            ["Channels:Email:SendGrid:OwnerUserId"] = "mailbox-owner"
        }).Build();
        return (request, config, DateTimeOffset.FromUnixTimeSeconds(long.Parse(data.GetProperty("timestamp").GetString()!)), body);
    }
}
