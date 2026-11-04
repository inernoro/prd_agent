using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class HostedSiteReviewVersionAccessTests
{
    [Theory]
    [InlineData(401, "UNAUTHORIZED")]
    [InlineData(403, "VISIBILITY_DENIED")]
    [InlineData(404, "not_found")]
    [InlineData(400, "expired")]
    [InlineData(429, "rate_limited")]
    public async Task SharedVersionMetadataAndPreview_ApplyShareGateBeforeAnyRevisionLookup(int status, string code)
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(s => s.ResolveShareSiteAsync("share", null, "pw", null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult
            {
                Error = "分享访问被拒绝", HttpStatus = status, ErrorCode = code, RetryAfterSeconds = status == 429 ? 12 : null,
            });
        // 空数据库依赖刻意使“在门禁之前查询历史版本”的回归直接失败。
        var controller = new WebPagesController(sites.Object, null!, null!, null!, null!, null!)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var list = Assert.IsAssignableFrom<ObjectResult>(await controller.ListSharedReviewVersions("share", "pw"));
        var preview = Assert.IsAssignableFrom<ObjectResult>(await controller.PreviewSharedReviewVersion("share", "private-draft", "pw"));
        Assert.Equal(status, list.StatusCode);
        Assert.Equal(status, preview.StatusCode);
        sites.VerifyAll();
        if (status == 429) Assert.Equal("12", controller.Response.Headers["Retry-After"].ToString());
    }
}
