using System.IO.Compression;
using System.Reflection;
using System.Text;
using Microsoft.AspNetCore.Http;
using PrdAgent.Api.Controllers.Api;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class WebPagesControllerMultiHtmlUploadTests
{
    [Fact]
    public async Task BuildMultiHtmlZipAsync_PreservesMultipleHtmlFiles()
    {
        var files = new List<IFormFile>
        {
            FormFile("index.html", "<html><body>index</body></html>"),
            FormFile("balance-detail.html", "<html><body>detail</body></html>"),
        };

        var zipBytes = await InvokeBuildMultiHtmlZipAsync(files);

        using var zip = new ZipArchive(new MemoryStream(zipBytes), ZipArchiveMode.Read);
        var names = zip.Entries.Select(e => e.FullName).OrderBy(x => x).ToList();
        Assert.Equal(new[] { "balance-detail.html", "index.html" }, names);
    }

    [Fact]
    public async Task BuildMultiHtmlZipAsync_RejectsMixedFileTypes()
    {
        var files = new List<IFormFile>
        {
            FormFile("index.html", "<html></html>"),
            FormFile("style.css", "body{}"),
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => InvokeBuildMultiHtmlZipAsync(files));
        Assert.Contains("仅支持 .html / .htm", ex.Message);
    }

    private static async Task<byte[]> InvokeBuildMultiHtmlZipAsync(IReadOnlyList<IFormFile> files)
    {
        var method = typeof(WebPagesController).GetMethod(
            "BuildMultiHtmlZipAsync",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);

        var task = (Task<byte[]>)method!.Invoke(null, new object[] { files })!;
        return await task;
    }

    private static IFormFile FormFile(string fileName, string content)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        return new FormFile(new MemoryStream(bytes), 0, bytes.Length, "files", fileName);
    }
}
