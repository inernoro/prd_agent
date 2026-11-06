using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ShortVideoSourceDownloaderTests
{
    private static string Metadata(params string[] urls) => JsonSerializer.Serialize(new
    {
        rawResponse = JsonSerializer.Serialize(new { data = new { aweme_detail = new { video = new { play_addr_h264 = new { url_list = urls } } } } })
    });

    [Fact]
    public void Candidates_AreExistingParserPlaybackAddressesOnlyAndBounded()
    {
        var result = ShortVideoSourceDownloader.SelectCandidates("https://cdn.test/one", Metadata(
            "https://cdn.test/one", "https://cdn.test/two", "file:///tmp/secret", "https://cdn.test/three", "https://cdn.test/four"));
        Assert.Equal(new[] { "https://cdn.test/one", "https://cdn.test/two", "https://cdn.test/three" }, result);
        foreach (var metadata in new[] { "not-json", "null", "[]", JsonSerializer.Serialize(new { rawResponse = "{\"data\":[]}" }), JsonSerializer.Serialize(new { rawResponse = "{\"data\":{\"video\":null}}" }) })
            Assert.Single(ShortVideoSourceDownloader.SelectCandidates("https://cdn.test/one", metadata));
    }

    [Fact]
    public async Task Forbidden_UsesNextProvidedAddressAndPreservesBothAuditsWithoutSignedUrls()
    {
        await using var mongo = await RunMongoFixture.CreateAsync("short_video_source_audit");
        using var handler = new SequenceHandler(
            new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("AccessDenied token=private-value https://cdn.test/one?signature=hidden-value") },
            new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([0, 1, 2, 3]) });
        handler.Responses.Last().Content.Headers.ContentType = new("video/mp4");
        var run = new ShortVideoMaterialRun { UserId = "stsmk-owner" };
        var downloader = new ShortVideoSourceDownloader(mongo.Db, new Clients(handler), new TestValidator(), NullLogger<ShortVideoSourceDownloader>.Instance);
        var result = await downloader.DownloadAsync(run, "https://cdn.test/one?signature=hidden-value", Metadata("https://cdn.test/two"));
        Assert.Equal(new byte[] { 0, 1, 2, 3 }, result.Bytes);
        Assert.Equal(2, handler.Calls.Count);
        var logs = await mongo.Db.ApiRequestLogs.Find(x => x.SessionId == run.Id).SortBy(x => x.StartedAt).ToListAsync();
        Assert.Equal(new[] { 403, 200 }, logs.Select(x => x.StatusCode));
        Assert.All(logs, log => { Assert.Equal(run.UserId, log.UserId); Assert.Equal("outbound", log.Direction); });
        var evidence = JsonSerializer.Serialize(logs);
        Assert.Contains("switch_candidate", evidence);
        Assert.Contains("media_body_excluded", evidence);
        Assert.DoesNotContain("hidden-value", evidence);
        Assert.DoesNotContain("private-value", evidence);
        Assert.DoesNotContain("?signature", evidence);
    }

    [Theory]
    [InlineData(500, "video/mp4", "http_failed")]
    [InlineData(200, "text/html", "invalid_media")]
    public async Task OtherFailures_DoNotRetryAndRemainQueryable(int status, string mime, string outcome)
    {
        await using var mongo = await RunMongoFixture.CreateAsync("short_video_source_failure");
        var response = new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("upstream unavailable") };
        response.Content.Headers.ContentType = new(mime);
        using var handler = new SequenceHandler(response);
        var run = new ShortVideoMaterialRun { UserId = "stsmk-owner" };
        var downloader = new ShortVideoSourceDownloader(mongo.Db, new Clients(handler), new TestValidator(), NullLogger<ShortVideoSourceDownloader>.Instance);
        await Assert.ThrowsAnyAsync<Exception>(() => downloader.DownloadAsync(run, "https://cdn.test/one", Metadata("https://cdn.test/two")));
        Assert.Single(handler.Calls);
        var log = await mongo.Db.ApiRequestLogs.Find(x => x.SessionId == run.Id).SingleAsync();
        Assert.Contains(outcome, log.ResponseBody);
        Assert.Contains("upstream unavailable", log.ResponseBody);
    }

    [Fact]
    public async Task BackupPrivateAddress_IsBlockedBeforeNetworkAndAuditDistinguishesNoResponse()
    {
        await using var mongo = await RunMongoFixture.CreateAsync("short_video_source_ssrf");
        using var handler = new SequenceHandler(new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("denied") });
        var run = new ShortVideoMaterialRun { UserId = "stsmk-owner" };
        var downloader = new ShortVideoSourceDownloader(mongo.Db, new Clients(handler), new TestValidator(), NullLogger<ShortVideoSourceDownloader>.Instance);
        await Assert.ThrowsAsync<InvalidOperationException>(() => downloader.DownloadAsync(run, "https://cdn.test/one", Metadata("http://169.254.169.254/latest/meta-data")));
        Assert.Single(handler.Calls);
        var log = await mongo.Db.ApiRequestLogs.Find(x => x.SessionId == run.Id && x.StatusCode == 0).SingleAsync();
        using var body = JsonDocument.Parse(log.ResponseBody!);
        Assert.False(body.RootElement.GetProperty("responseReceived").GetBoolean());
        Assert.Equal("network_failed", body.RootElement.GetProperty("outcome").GetString());
    }

    private sealed class Clients(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
    private sealed class TestValidator : ISafeOutboundUrlValidator
    {
        public bool IsSafeAddress(IPAddress address) => !IPAddress.IsLoopback(address);
        public async Task<Uri> EnsureSafeHttpUrlAsync(string? url, string purpose, CancellationToken ct = default)
        {
            var uri = new Uri(url!);
            return uri.Host == "cdn.test" ? uri : await new SafeOutboundUrlValidator().EnsureSafeHttpUrlAsync(url, purpose, ct);
        }
    }
    private sealed class SequenceHandler(params HttpResponseMessage[] responses) : HttpMessageHandler
    {
        public HttpResponseMessage[] Responses { get; } = responses;
        public List<string> Calls { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add(request.RequestUri!.ToString());
            return Task.FromResult(Responses[Calls.Count - 1]);
        }
    }
}
