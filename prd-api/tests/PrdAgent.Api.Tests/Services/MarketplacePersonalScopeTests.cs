using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using PrdAgent.Api.Controllers.Api;
using System.Reflection;
using System.Text.Json;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class MarketplacePersonalScopeTests
{
    [Theory]
    [InlineData("1.2.3")]
    [InlineData("v2.0.0")]
    [InlineData(null)]
    public void 列表与收藏响应必须序列化真实版本且不编造历史版本(string? version)
    {
        var skill = new MarketplaceSkill { Version = version };
        var mapper = typeof(MarketplaceSkillsController).GetMethod("ToDto", BindingFlags.Static | BindingFlags.NonPublic)!;
        var dto = mapper.Invoke(null, new object[] { skill, "viewer", 0L });
        var json = JsonSerializer.SerializeToElement(dto, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        json.TryGetProperty("version", out var actual).ShouldBeTrue();
        actual.GetString().ShouldBe(version);
    }

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
