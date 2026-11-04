using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class WebPageAskRatingTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(6)]
    [InlineData(-1)]
    public async Task 无效分数不触碰数据库(int rating)
    {
        var controller = new WebPageAskRatingController(null!);
        Assert.IsType<BadRequestObjectResult>(await controller.Rate("answer", new() { Rating = rating, Token = AskAnswerRating.CreateToken() }));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("session-id")]
    public async Task 无回执不能冒领评分(string? token)
    {
        var controller = new WebPageAskRatingController(null!);
        Assert.IsType<BadRequestObjectResult>(await controller.Rate("answer", new() { Rating = 3, Token = token }));
    }

    [Fact]
    public void 评分过滤器绑定回答回执部署与成功状态()
    {
        var token = AskAnswerRating.CreateToken();
        Assert.True(AskAnswerRating.IsValid(5, token));
        Assert.NotEqual(token, AskAnswerRating.CreateToken());
        var registry = BsonSerializer.SerializerRegistry;
        var filter = WebPageAskRatingController.RatingFilter("answer", token, "branch-a")
            .Render(new RenderArgs<HostedSiteAskMessage>(registry.GetSerializer<HostedSiteAskMessage>(), registry)).ToJson();
        Assert.Contains("answer", filter);
        Assert.Contains(AskAnswerRating.Hash(token), filter);
        Assert.DoesNotContain(token, filter);
        Assert.Contains("branch-a", filter);
        Assert.Contains("assistant", filter);
        Assert.Contains("Error", filter);
        Assert.Contains("Content", filter);
    }

    [Theory]
    [InlineData("/api/web-pages/site/ask/stream", true)]
    [InlineData("/api/web-pages/shares/view/token/ask/stream", true)]
    [InlineData("/api/web-pages/ask/messages/id/rating", true)]
    [InlineData("/api/web-pages/site/ask/config", false)]
    public void 回执路径不进入请求响应正文日志(string path, bool expected)
        => Assert.Equal(expected, AskAnswerRating.CarriesReceipt(path));

    [Fact]
    public void 消息对外序列化保留分数但不泄露回执摘要()
    {
        var message = new HostedSiteAskMessage { Rating = 4, RatingTokenHash = "secret-hash" };
        var json = JsonSerializer.Serialize(message);
        Assert.Contains("\"Rating\":4", json);
        Assert.DoesNotContain("secret-hash", json);
        Assert.DoesNotContain("RatingTokenHash", json);
    }
}
