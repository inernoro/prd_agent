using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Tests;

public class HostedDocumentLinkParserTests
{
    private static readonly string[] Origins = { "https://map.example.test", "http://localhost:8000" };
    [Theory]
    [InlineData("https://map.example.test/s/wp/abc123", "token", "abc123", null)]
    [InlineData("/s/wp/abc123?siteId=doc-b", "token", "abc123", "doc-b")]
    [InlineData("https://map.example.test/s/1234", "sequence", "1234", null)]
    [InlineData("/s/alpha", "token", "alpha", null)]
    [InlineData("/web-pages?openSite=doc-b", "site", "doc-b", null)]
    [InlineData("http://localhost:8000/web-pages?focusSite=doc-c", "site", "doc-c", null)]
    public void ExtractsOnlyRecognizedProjectRoutes(string content, string kind, string value, string? selected)
    {
        var link = Assert.Single(HostedDocumentLinkParser.Extract(content, Origins));
        Assert.Equal(new HostedDocumentLink(kind, value, selected), link);
    }
    [Theory]
    [InlineData("https://foreign.test/s/wp/abc123")]
    [InlineData("https://map.example.test.foreign.test/s/wp/abc123")]
    [InlineData("https://user@map.example.test/s/wp/abc123")]
    [InlineData("https://map.example.test:8443/s/wp/abc123")]
    [InlineData("https://map.example.test/anything")]
    public void RejectsForeignHostsCredentialsPortsAndOtherRoutes(string content) =>
        Assert.Empty(HostedDocumentLinkParser.Extract(content, Origins));
    [Fact]
    public void HandlesMarkdownChinesePunctuationAndDeduplicates()
    {
        var links = HostedDocumentLinkParser.Extract("参考 [方案](https://map.example.test/s/wp/abc123)。再看 /s/wp/abc123，", Origins);
        Assert.Single(links);
        Assert.Equal("abc123", links[0].Value);
    }
}
