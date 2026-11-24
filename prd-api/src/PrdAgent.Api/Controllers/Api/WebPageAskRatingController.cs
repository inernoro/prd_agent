using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/web-pages/ask/messages")]
public class WebPageAskRatingController : ControllerBase
{
    private readonly MongoDbContext _db;
    public WebPageAskRatingController(MongoDbContext db) => _db = db;

    // 匿名提问者同样能评价自己的回答；仅持有一次回答专属回执者可写，不接受站点/会话 ID 代替。
    [AllowAnonymous]
    [HttpPut("{messageId}/rating")]
    public async Task<IActionResult> Rate(string messageId, [FromBody] AskRatingRequest request)
    {
        if (!AskAnswerRating.IsValid(request.Rating, request.Token))
            return BadRequest(ApiResponse<object>.Fail("INVALID_RATING", "请选择 1 到 5 分，并使用本次回答的评价入口。"));
        var result = await _db.HostedSiteAskMessages.UpdateOneAsync(
            RatingFilter(messageId, request.Token!, DeploymentScope.Current),
            Builders<HostedSiteAskMessage>.Update.Set(m => m.Rating, request.Rating).Set(m => m.RatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "此回答无法评价，请重新提问后再试。"));
        return Ok(ApiResponse<object>.Ok(new { rating = request.Rating }));
    }

    public static FilterDefinition<HostedSiteAskMessage> RatingFilter(string id, string token, string? deployment)
    {
        var hash = AskAnswerRating.Hash(token);
        return Builders<HostedSiteAskMessage>.Filter.Where(m => m.Id == id
            && m.RatingTokenHash == hash && m.DeploymentSlug == deployment
            && m.Role == "assistant" && m.Error == null && m.Content != "");
    }
}

public class AskRatingRequest
{
    public int Rating { get; set; }
    public string? Token { get; set; }
}
