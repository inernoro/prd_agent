using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class LiteraryImageRequestRecoveryTests
{
    [Fact, Trait("Category", "Integration")]
    public async Task ConcurrentReplayCannotInsertTwoRunsWithoutSecondaryUniqueIndex()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("请求恢复回归必须提供独占测试Mongo");
        var name = "test_literary_replay_" + Guid.NewGuid().ToString("N");
        var client = new MongoClient(connection);
        try
        {
            var runs = client.GetDatabase(name).GetCollection<ImageGenRun>("image_gen_runs");
            async Task<bool> Insert()
            {
                try
                {
                    await runs.InsertOneAsync(new() { Id = LiteraryAgentImageGenController.RequestRunId("owner", "main::request")!,
                        OwnerAdminId = "owner", AppKey = "literary-agent", IdempotencyKey = "main::request" });
                    return true;
                }
                catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey) { return false; }
            }
            var accepted = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Insert()));
            Assert.Equal(1, accepted.Count(x => x));
            Assert.Equal(1, await runs.CountDocumentsAsync(FilterDefinition<ImageGenRun>.Empty));
            Assert.NotEqual(LiteraryAgentImageGenController.RequestRunId("owner", "main::request"), LiteraryAgentImageGenController.RequestRunId("other", "main::request"));
            Assert.Null(LiteraryAgentImageGenController.RequestRunId("owner", ""));
        }
        finally { await client.DropDatabaseAsync(name); }
    }

    [Fact, Trait("Category", "Integration")]
    public async Task LookupIsReadOnlyOwnerAndAppScopedAndEscapesRequestKey()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("请求恢复回归必须提供独占测试Mongo");
        var name = "test_literary_request_recovery_" + Guid.NewGuid().ToString("N");
        var client = new MongoClient(connection);
        try
        {
            var context = new MongoDbContext(connection, name);
            var raw = client.GetDatabase(name).GetCollection<ImageGenRun>("image_gen_runs");
            const string key = "request.one[*]";
            await raw.InsertManyAsync([
                new() { Id = "original", OwnerAdminId = "owner", AppKey = "literary-agent", IdempotencyKey = "test::main::revision::old::" + key, Status = ImageGenRunStatus.Completed },
                new() { Id = "other-owner", OwnerAdminId = "other", AppKey = "literary-agent", IdempotencyKey = key },
                new() { Id = "other-app", OwnerAdminId = "owner", AppKey = "visual-agent", IdempotencyKey = key },
                new() { Id = "not-literal", OwnerAdminId = "owner", AppKey = "literary-agent", IdempotencyKey = "requestXone" },
            ]);
            var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
            var controller = new LiteraryAgentImageGenController(context, Mock.Of<IRunEventStore>(), gateway.Object, NullLogger<LiteraryAgentImageGenController>.Instance)
            { ControllerContext = new() { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "owner")], "test")) } } };
            var result = Assert.IsType<OkObjectResult>(await controller.GetRunByRequest(key, CancellationToken.None));
            var data = Assert.IsType<ApiResponse<object>>(result.Value).Data!;
            Assert.Equal("original", data.GetType().GetProperty("runId")!.GetValue(data));
            Assert.IsType<NotFoundObjectResult>(await controller.GetRunByRequest("missing", CancellationToken.None));
            // 同一请求跨旧 revision 重放时，空的新请求体也只能回放原任务，不能再次入队。
            controller.HttpContext.Request.Headers["Idempotency-Key"] = key;
            var replay = Assert.IsType<OkObjectResult>(await controller.CreateRun(new(), CancellationToken.None));
            var replayData = Assert.IsType<ApiResponse<object>>(replay.Value).Data!;
            Assert.Equal("original", replayData.GetType().GetProperty("runId")!.GetValue(replayData));
            Assert.Equal(4, await raw.CountDocumentsAsync(FilterDefinition<ImageGenRun>.Empty));
            gateway.VerifyNoOtherCalls();
        }
        finally { await client.DropDatabaseAsync(name); }
    }
}
