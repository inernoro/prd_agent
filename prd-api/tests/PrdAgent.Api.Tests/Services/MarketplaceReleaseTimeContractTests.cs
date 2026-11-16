using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class MarketplaceReleaseTimeContractTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void Dto_KeepsContentTimeSeparateFromDownloadAndFavoriteActivity(bool openApi, bool edited)
    {
        var uploaded = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);
        var contentTime = uploaded.AddDays(2);
        var skill = new MarketplaceSkill
        {
            CreatedAt = uploaded,
            ContentUpdatedAt = edited ? contentTime : null,
            // 模拟此后发生的下载/收藏；不能把此活动时间当成内容更新。
            UpdatedAt = uploaded.AddMonths(1),
            DownloadCount = 20,
            FavoritedByUserIds = new List<string> { "viewer" }
        };
        var controller = openApi ? typeof(MarketplaceSkillsOpenApiController) : typeof(MarketplaceSkillsController);
        object? target = null;
        if (openApi)
        {
            var context = new DefaultHttpContext();
            context.Request.Scheme = "https";
            context.Request.Host = new HostString("example.test");
            target = new MarketplaceSkillsOpenApiController(null!, null!, null!, null!, null!, null!)
            {
                ControllerContext = new ControllerContext { HttpContext = context }
            };
        }
        var method = controller.GetMethod("ToDto", BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance)!;
        var dto = method.Invoke(target, openApi ? new object[] { skill, "viewer" } : new object[] { skill, "viewer", 0L });
        var json = JsonSerializer.SerializeToElement(dto);

        Assert.Equal(uploaded, json.GetProperty("createdAt").GetDateTime());
        Assert.Equal(skill.UpdatedAt, json.GetProperty("updatedAt").GetDateTime());
        if (edited) Assert.Equal(contentTime, json.GetProperty("contentUpdatedAt").GetDateTime());
        else Assert.Equal(JsonValueKind.Null, json.GetProperty("contentUpdatedAt").ValueKind);
    }
}
