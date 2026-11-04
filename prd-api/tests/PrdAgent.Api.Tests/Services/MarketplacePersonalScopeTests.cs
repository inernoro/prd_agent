using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Controllers.Api;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class MarketplacePersonalScopeTests
{
    [Theory]
    [InlineData("mine")]
    [InlineData("favorites")]
    public async Task 匿名请求个人列表必须在访问数据库前拒绝(string scope)
    {
        var controller = AnonymousController();
        var result = await controller.List(null, null, null, scope, CancellationToken.None);
        result.ShouldBeOfType<UnauthorizedObjectResult>();
    }

    [Fact]
    public async Task 不支持的范围不能回退到公开广场()
    {
        var controller = AnonymousController();
        var result = await controller.List(null, null, null, "unknown", CancellationToken.None);
        result.ShouldBeOfType<BadRequestObjectResult>();
    }

    private static MarketplaceSkillsController AnonymousController() =>
        new(null!, null!, null!, null!, null!, null!, null!, null!, null!)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
}
