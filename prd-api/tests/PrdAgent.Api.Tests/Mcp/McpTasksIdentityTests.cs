using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public class McpTasksIdentityTests
{
    [Fact]
    public async Task 任务台按密钥绑定用户查询_无需JWT身份也不使用其他主体()
    {
        var filters = new List<string>();
        var collection = new Mock<IMongoCollection<ActiveTaskEntry>>();
        collection.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<ActiveTaskEntry>>(),
                It.IsAny<FindOptions<ActiveTaskEntry, ActiveTaskEntry>>(), It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<ActiveTaskEntry> filter, FindOptions<ActiveTaskEntry, ActiveTaskEntry> _, CancellationToken _) =>
            {
                filters.Add(filter.Render(new RenderArgs<ActiveTaskEntry>(BsonSerializer.SerializerRegistry.GetSerializer<ActiveTaskEntry>(), BsonSerializer.SerializerRegistry)).ToString());
                var cursor = new Mock<IAsyncCursor<ActiveTaskEntry>>();
                cursor.SetupGet(x => x.Current).Returns(Array.Empty<ActiveTaskEntry>());
                cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
                return Task.FromResult(cursor.Object);
            });
        var database = new Mock<IMongoDatabase>();
        database.Setup(x => x.GetCollection<ActiveTaskEntry>("active_task_entries", null)).Returns(collection.Object);
        var db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(db, database.Object);
        var controller = new TasksOpenApiController(db)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext
            { User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("boundUserId", "key-owner") }, "ApiKey")) } }
        };
        (await controller.Mine()).ShouldBeOfType<OkObjectResult>();
        filters.Count.ShouldBe(2);
        foreach (var filter in filters) filter.ShouldContain("key-owner");
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "other-user") }, "ApiKey"));
        await Should.ThrowAsync<UnauthorizedAccessException>(() => controller.Mine());
        filters.Count.ShouldBe(2);
    }
}
