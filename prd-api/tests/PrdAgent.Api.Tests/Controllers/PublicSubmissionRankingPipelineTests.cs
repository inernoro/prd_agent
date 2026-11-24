using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class PublicSubmissionRankingPipelineTests
{
    [Fact]
    public void Pipeline_WiresExposureBaselineAndLatestLiteraryActivity()
    {
        var pipeline = SubmissionsController.BuildPublicRankingPipeline(
            new BsonDocument("IsPublic", true),
            skip: 12,
            limit: 24);

        pipeline[0]["$match"]["IsPublic"].AsBoolean.ShouldBeTrue();

        var lookup = pipeline.Single(x => x.Contains("$lookup"))["$lookup"].AsBsonDocument;
        lookup["from"].AsString.ShouldBe("image_master_workspaces");
        lookup["localField"].AsString.ShouldBe("WorkspaceId");

        var activityStage = pipeline.Single(x =>
            x.TryGetValue("$set", out var setValue)
            && setValue.AsBsonDocument.Contains("_activityAt"));
        var activityJson = activityStage.ToJson();
        activityJson.ShouldContain("literary");
        activityJson.ShouldContain("$_rankingWorkspace.UpdatedAt");

        var hotStage = pipeline.Single(x =>
            x.TryGetValue("$set", out var setValue)
            && setValue.AsBsonDocument.Contains("_hot"));
        var hotJson = hotStage.ToJson();
        hotJson.ShouldContain(GalleryRanking.ExposureBaseline.ToString("0.0"));
        hotJson.ShouldContain(GalleryRanking.FreshnessScaleHours.ToString("0.0"));
        hotJson.ShouldContain("$_activityAt");
        hotJson.ShouldContain("$LikeCount");
        hotJson.ShouldContain("$ViewCount");

        pipeline.Single(x => x.Contains("$skip"))["$skip"].ToInt32().ShouldBe(12);
        pipeline.Single(x => x.Contains("$limit"))["$limit"].ToInt32().ShouldBe(24);

        var responseTimeStage = pipeline.Single(x =>
            x.TryGetValue("$set", out var setValue)
            && setValue.AsBsonDocument.Contains("UpdatedAt"));
        responseTimeStage["$set"]["UpdatedAt"].AsString.ShouldBe("$_activityAt");
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task Pipeline_OnMongo_PromotesUnseenAndRecentlyUpdatedWorks()
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION");
        if (string.IsNullOrWhiteSpace(connectionString)) return;

        var client = new MongoClient(connectionString);
        var databaseName = $"gallery_ranking_{Guid.NewGuid():N}";
        var database = client.GetDatabase(databaseName);
        var submissions = database.GetCollection<Submission>("submissions");
        var workspaces = database.GetCollection<ImageMasterWorkspace>("image_master_workspaces");
        var now = DateTime.UtcNow;

        try
        {
            var literaryWorkspace = new ImageMasterWorkspace
            {
                Id = "literary-workspace",
                OwnerUserId = "owner",
                ScenarioType = "article-illustration",
                CreatedAt = now.AddDays(-60),
                UpdatedAt = now.AddHours(-2),
            };
            await workspaces.InsertOneAsync(literaryWorkspace);

            await submissions.InsertManyAsync(new[]
            {
                NewSubmission("old-viewed", "visual", now.AddDays(-30), viewCount: 20),
                NewSubmission("fresh-unseen", "visual", now.AddHours(-1), viewCount: 0),
                NewSubmission(
                    "updated-literary",
                    "literary",
                    now.AddDays(-60),
                    viewCount: 0,
                    workspaceId: literaryWorkspace.Id),
            });

            var pipeline = SubmissionsController.BuildPublicRankingPipeline(
                new BsonDocument("IsPublic", true),
                skip: 0,
                limit: 20);
            var ranked = await submissions.Aggregate<Submission>(pipeline).ToListAsync();

            ranked.Select(x => x.Id).ShouldBe(new[]
            {
                "fresh-unseen",
                "updated-literary",
                "old-viewed",
            });
            ranked.Single(x => x.Id == "updated-literary").UpdatedAt
                .ShouldBe(literaryWorkspace.UpdatedAt, tolerance: TimeSpan.FromMilliseconds(1));
        }
        finally
        {
            await client.DropDatabaseAsync(databaseName);
        }
    }

    private static Submission NewSubmission(
        string id,
        string contentType,
        DateTime createdAt,
        int viewCount,
        string? workspaceId = null)
        => new()
        {
            Id = id,
            Title = id,
            ContentType = contentType,
            WorkspaceId = workspaceId,
            OwnerUserId = "owner",
            OwnerUserName = "作者",
            IsPublic = true,
            LikeCount = 0,
            ViewCount = viewCount,
            CreatedAt = createdAt,
            UpdatedAt = createdAt,
        };
}
