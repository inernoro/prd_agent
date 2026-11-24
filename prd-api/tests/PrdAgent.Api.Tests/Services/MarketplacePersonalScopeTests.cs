using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using PrdAgent.Api.Controllers.Api;
using System.Reflection;
using System.Text.Json;
using System.IO.Compression;
using System.Security.Claims;
using PrdAgent.Infrastructure.Services.MarketplaceSkills;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class MarketplacePersonalScopeTests
{
    [Theory]
    [InlineData(65)]
    [InlineData(8192)]
    public async Task 超长上传版本在存储与数据库访问前拒绝(int length)
    {
        using var zip = new MemoryStream();
        using (var archive = new ZipArchive(zip, ZipArchiveMode.Create, leaveOpen: true))
        using (var writer = new StreamWriter(archive.CreateEntry("SKILL.md").Open()))
            await writer.WriteAsync($"---\nname: sample\nversion: {new string('1', length)}\n---\n# Skill");
        zip.Position = 0;
        var controller = new MarketplaceSkillsController(null!, null!, null!, null!, new SkillZipMetadataExtractor(), null!, null!, null!, null!)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "viewer") }, "test"))
            } }
        };
        var result = await controller.Upload(new FormFile(zip, 0, zip.Length, "file", "skill.zip"),
            null, null, null, null, null, null, null, null, CancellationToken.None);
        var response = result.ShouldBeOfType<BadRequestObjectResult>().Value.ShouldBeOfType<ApiResponse<object>>();
        response.Error!.Code.ShouldBe("INVALID_VERSION");
    }

    [Theory]
    [InlineData(64, true)]
    [InlineData(65, false)]
    [InlineData(8 * 1024 * 1024, false)]
    public void 既有超长版本不能放大列表与收藏响应(int length, bool preserved)
    {
        var skill = new MarketplaceSkill { Version = new string('1', length) };
        var mapper = typeof(MarketplaceSkillsController).GetMethod("ToDto", BindingFlags.Static | BindingFlags.NonPublic)!;
        var dto = mapper.Invoke(null, new object[] { skill, "viewer", 0L });
        var json = JsonSerializer.SerializeToElement(dto, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        json.GetProperty("version").GetString().ShouldBe(preserved ? skill.Version : null);
        json.GetRawText().Length.ShouldBeLessThan(2048);
    }

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
