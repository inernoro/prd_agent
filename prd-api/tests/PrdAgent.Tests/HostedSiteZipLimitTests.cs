using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteZipLimitTests
{
    [Theory]
    [InlineData(5001)]
    [InlineData(20000)]
    public void ZipFileCountLimit_allows_large_prototype_archives_within_the_new_boundary(int fileCount)
    {
        Assert.Null(HostedSiteService.ValidateZipFileCount(fileCount));
    }

    [Fact]
    public void ZipFileCountLimit_rejects_archives_above_the_boundary_with_recovery_guidance()
    {
        var error = HostedSiteService.ValidateZipFileCount(20001);

        Assert.Equal("ZIP 包含的文件数超过上限（20000），请删除无用文件后再上传", error);
    }

    [Fact]
    public void ZipManifestLimit_allows_twenty_thousand_files_with_normal_paths()
    {
        var files = Enumerable.Range(0, HostedSiteService.MaxZipFileCount)
            .Select(i => File($"assets/{i}.js"))
            .ToList();

        Assert.Null(HostedSiteService.ValidateZipManifestSize(files));
    }

    [Fact]
    public void ZipManifestLimit_rejects_long_paths_before_the_mongo_document_limit()
    {
        var longFolder = new string('a', 1200);
        var files = Enumerable.Range(0, 6000)
            .Select(i => File($"{longFolder}/{i}.js"))
            .ToList();

        var error = HostedSiteService.ValidateZipManifestSize(files);

        Assert.Equal(
            "ZIP 文件路径信息过多，无法安全保存。请缩短文件名和目录层级，或删除无用文件后再上传",
            error);
    }

    private static HostedSiteFile File(string path) => new()
    {
        Path = path,
        CosKey = $"web-hosting/sites/00000000000000000000000000000000/{path}",
        Size = 1,
        MimeType = "application/javascript",
    };
}
