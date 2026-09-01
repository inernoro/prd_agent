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

        Assert.Equal("ZIP 包含的文件数超过上限（20000），请删除无用文件或拆分后再上传", error);
    }
}
