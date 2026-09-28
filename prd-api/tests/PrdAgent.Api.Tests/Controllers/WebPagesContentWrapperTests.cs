using System.IO.Compression;
using System.Reflection;
using System.Text;
using PrdAgent.Api.Controllers.Api;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class WebPagesContentWrapperTests
{
    [Fact]
    public void MarkdownWrapper_RendersMermaid_WithoutEnablingRawHtml()
    {
        var markdown = "# 流程\n```mermaid\ngraph TD\nA-->B\n```\n<script>alert(1)</script>";
        var html = Invoke("BuildMarkdownWrapper", Encoding.UTF8.GetBytes(markdown), "流程");

        Assert.Contains("class=\"mermaid\"", html);
        Assert.Contains("graph TD", html);
        Assert.Contains("mermaid@11.14.0", html);
        Assert.Contains("securityLevel: 'strict'", html);
        Assert.DoesNotContain("<script>alert(1)</script>", html);
    }

    [Fact]
    public void TextWrapper_EscapesHtml_AndPreservesLineBreaks()
    {
        var html = Invoke("BuildTextWrapper", Encoding.UTF8.GetBytes("first\n<script>alert(1)</script>"), "a&b");

        Assert.Contains("<pre>first\n&lt;script&gt;alert(1)&lt;/script&gt;</pre>", html);
        Assert.Contains("<title>a&amp;b</title>", html);
        Assert.DoesNotContain("<script>alert(1)</script>", html);
    }

    [Fact]
    public void ImageWrapper_UsesEncodedRelativeAssetPath()
    {
        var html = Invoke("BuildImageWrapper", "my image.png", "a<image>");

        Assert.Contains("src=\"my%20image.png\"", html);
        Assert.Contains("img-src http: https: data:", html);
        Assert.Contains("alt=\"a&lt;image&gt;\"", html);
        Assert.DoesNotContain("<image>", html);
    }

    [Fact]
    public void GalleryZip_RequiresOnlyImagesAndAnEntryPage()
    {
        static byte[] Zip(params string[] names)
        {
            using var stream = new MemoryStream();
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
                foreach (var name in names)
                    archive.CreateEntry(name);
            return stream.ToArray();
        }
        var method = typeof(WebPagesController).GetMethod("IsGalleryZip",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);
        Assert.True(Assert.IsType<bool>(method!.Invoke(null,
            [Zip("index.html", "images/image-01.png", "images/image-02.jpg")])));
        Assert.False(Assert.IsType<bool>(method.Invoke(null,
            [Zip("index.html", "images/image-01.png", "app.js")])));
    }

    private static string Invoke(string methodName, params object[] args)
    {
        var method = typeof(WebPagesController).GetMethod(methodName,
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);
        return Assert.IsType<string>(method!.Invoke(null, args));
    }
}
