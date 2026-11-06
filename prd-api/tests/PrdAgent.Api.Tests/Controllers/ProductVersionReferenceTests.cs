using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

[Trait("Category", "Integration")]
public class ProductVersionReferenceTests
{
    [Theory]
    [InlineData("foreign-version")]
    [InlineData("deleted-version")]
    [InlineData("missing-version")]
    public async Task Requirement_create_and_update_reject_invalid_versions_without_writes(string versionId)
    {
        await using var fixture = await Fixture.CreateAsync();
        var controller = fixture.Controller();
        var before = await fixture.Db.Requirements.CountDocumentsAsync(_ => true);
        Assert.IsType<BadRequestObjectResult>(await controller.CreateRequirement("p1",
            new UpsertRequirementRequest { Title = "新需求", VersionIds = new() { versionId } }));
        Assert.Equal(before, await fixture.Db.Requirements.CountDocumentsAsync(_ => true));
        Assert.IsType<BadRequestObjectResult>(await controller.UpdateRequirement("r1",
            new UpsertRequirementRequest { Title = "不能被写入", VersionIds = new() { versionId } }));
        var unchanged = await fixture.Db.Requirements.Find(x => x.Id == "r1").SingleAsync();
        Assert.Equal("原需求", unchanged.Title);
        Assert.Equal(new[] { "v1" }, unchanged.VersionIds);
        Assert.Equal(new[] { "r1" }, (await fixture.Db.ProductVersions.Find(x => x.Id == "v1").SingleAsync()).RequirementIds);
        Assert.Equal(new[] { "foreign-requirement" }, (await fixture.Db.ProductVersions.Find(x => x.Id == "foreign-version").SingleAsync()).RequirementIds);
    }

    [Theory]
    [InlineData("foreign-requirement")]
    [InlineData("deleted-requirement")]
    [InlineData("missing-requirement")]
    public async Task Version_create_and_update_reject_invalid_requirements_without_writes(string requirementId)
    {
        await using var fixture = await Fixture.CreateAsync();
        var controller = fixture.Controller();
        var before = await fixture.Db.ProductVersions.CountDocumentsAsync(_ => true);
        Assert.IsType<BadRequestObjectResult>(await controller.CreateVersion("p1",
            new UpsertVersionRequest { VersionName = "新版本", RequirementIds = new() { requirementId } }));
        Assert.Equal(before, await fixture.Db.ProductVersions.CountDocumentsAsync(_ => true));
        Assert.IsType<BadRequestObjectResult>(await controller.UpdateVersion("v1",
            new UpsertVersionRequest { VersionName = "不能被写入", RequirementIds = new() { requirementId } }));
        var unchanged = await fixture.Db.ProductVersions.Find(x => x.Id == "v1").SingleAsync();
        Assert.Equal("原版本", unchanged.VersionName);
        Assert.Equal(new[] { "r1" }, unchanged.RequirementIds);
        Assert.Equal(new[] { "v1" }, (await fixture.Db.Requirements.Find(x => x.Id == "r1").SingleAsync()).VersionIds);
        Assert.Equal(new[] { "foreign-version" }, (await fixture.Db.Requirements.Find(x => x.Id == "foreign-requirement").SingleAsync()).VersionIds);
    }

    [Theory]
    [InlineData("foreign-version")]
    [InlineData("deleted-version")]
    [InlineData("missing-version")]
    public async Task Scheduled_transition_rejects_invalid_version_before_state_or_relationship_changes(string versionId)
    {
        await using var fixture = await Fixture.CreateAsync();
        var definition = ProductWorkflowDefaults.Requirement();
        definition.Id = "workflow";
        await fixture.Db.ProductWorkflowDefinitions.InsertOneAsync(definition);
        await fixture.Db.Requirements.UpdateOneAsync(x => x.Id == "r1",
            Builders<Requirement>.Update.Set(x => x.WorkflowDefId, definition.Id).Set(x => x.CurrentState, RequirementWorkflowCatalog.New));
        var edge = definition.Transitions.First(x => x.ToState == RequirementWorkflowCatalog.Scheduled && x.FromState == RequirementWorkflowCatalog.New);
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().Transition(new TransitionRequest {
            EntityType = ProductEntityType.Requirement, EntityId = "r1", TransitionKey = edge.Key, VersionIds = new() { versionId },
        }));
        var unchanged = await fixture.Db.Requirements.Find(x => x.Id == "r1").SingleAsync();
        Assert.Equal(RequirementWorkflowCatalog.New, unchanged.CurrentState);
        Assert.Equal(new[] { "v1" }, unchanged.VersionIds);
        Assert.Equal(new[] { "r1" }, (await fixture.Db.ProductVersions.Find(x => x.Id == "v1").SingleAsync()).RequirementIds);
    }

    [Fact]
    public async Task Valid_requirement_update_moves_both_sides_and_allows_clearing()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductVersions.InsertOneAsync(new ProductVersion { Id = "v2", ProductId = "p1", VersionName = "新版本" });
        Assert.IsType<OkObjectResult>(await fixture.Controller().UpdateRequirement("r1",
            new UpsertRequirementRequest { VersionIds = new() { "v2" } }));
        Assert.Empty((await fixture.Db.ProductVersions.Find(x => x.Id == "v1").SingleAsync()).RequirementIds);
        Assert.Equal(new[] { "r1" }, (await fixture.Db.ProductVersions.Find(x => x.Id == "v2").SingleAsync()).RequirementIds);
        Assert.IsType<OkObjectResult>(await fixture.Controller().UpdateRequirement("r1",
            new UpsertRequirementRequest { VersionIds = new() }));
        Assert.Empty((await fixture.Db.Requirements.Find(x => x.Id == "r1").SingleAsync()).VersionIds);
        Assert.Empty((await fixture.Db.ProductVersions.Find(x => x.Id == "v2").SingleAsync()).RequirementIds);
    }

    [Theory]
    [InlineData("foreign-version")]
    [InlineData("deleted-version")]
    [InlineData("missing-version")]
    public async Task Scheduled_transition_also_validates_existing_references(string versionId)
    {
        await using var fixture = await Fixture.CreateAsync();
        var definition = ProductWorkflowDefaults.Requirement(); definition.Id = "workflow";
        await fixture.Db.ProductWorkflowDefinitions.InsertOneAsync(definition);
        await fixture.Db.Requirements.UpdateOneAsync(x => x.Id == "r1", Builders<Requirement>.Update
            .Set(x => x.WorkflowDefId, definition.Id).Set(x => x.CurrentState, RequirementWorkflowCatalog.New)
            .Set(x => x.VersionIds, new List<string> { versionId }));
        var edge = definition.Transitions.First(x => x.ToState == RequirementWorkflowCatalog.Scheduled && x.FromState == RequirementWorkflowCatalog.New);
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().Transition(new TransitionRequest {
            EntityType = ProductEntityType.Requirement, EntityId = "r1", TransitionKey = edge.Key,
        }));
        Assert.Equal(RequirementWorkflowCatalog.New, (await fixture.Db.Requirements.Find(x => x.Id == "r1").SingleAsync()).CurrentState);
    }

    [Fact]
    public async Task Mixed_valid_and_invalid_references_do_not_partially_update_relationships()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.ProductVersions.InsertOneAsync(new ProductVersion { Id = "v2", ProductId = "p1" });
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().UpdateRequirement("r1",
            new UpsertRequirementRequest { VersionIds = new() { "v2", "foreign-version" } }));
        Assert.Equal(new[] { "v1" }, (await fixture.Db.Requirements.Find(x => x.Id == "r1").SingleAsync()).VersionIds);
        Assert.Empty((await fixture.Db.ProductVersions.Find(x => x.Id == "v2").SingleAsync()).RequirementIds);
    }

    [Fact]
    public async Task Invalid_scheduled_request_does_not_bind_or_change_a_legacy_requirement()
    {
        await using var fixture = await Fixture.CreateAsync();
        await fixture.Db.Requirements.UpdateOneAsync(x => x.Id == "r1",
            Builders<Requirement>.Update.Set(x => x.CurrentState, RequirementWorkflowCatalog.New));
        var edge = ProductWorkflowDefaults.Requirement().Transitions.First(x =>
            x.ToState == RequirementWorkflowCatalog.Scheduled && x.FromState == RequirementWorkflowCatalog.New);
        Assert.IsType<BadRequestObjectResult>(await fixture.Controller().Transition(new TransitionRequest {
            EntityType = ProductEntityType.Requirement, EntityId = "r1", TransitionKey = edge.Key, VersionIds = new() { "foreign-version" },
        }));
        var unchanged = await fixture.Db.Requirements.Find(x => x.Id == "r1").SingleAsync();
        Assert.Null(unchanged.WorkflowDefId);
        Assert.Equal(RequirementWorkflowCatalog.New, unchanged.CurrentState);
        Assert.Equal(new[] { "v1" }, unchanged.VersionIds);
    }

    [Fact]
    public async Task Creating_version_with_valid_requirements_also_updates_requirement_side()
    {
        await using var fixture = await Fixture.CreateAsync();
        var response = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateVersion("p1",
            new UpsertVersionRequest { VersionName = "新增版本", RequirementIds = new() { "r1" } }));
        var version = Assert.IsType<ProductVersion>(Assert.IsType<ApiResponse<object>>(response.Value).Data);
        Assert.Contains(version.Id, (await fixture.Db.Requirements.Find(x => x.Id == "r1").SingleAsync()).VersionIds);
        Assert.Contains("r1", version.RequirementIds);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient client;
        private readonly string name = "product_reference_test_" + Guid.NewGuid().ToString("N");
        public MongoDbContext Db { get; }
        private Fixture(string connection) { client = new MongoClient(connection); Db = new MongoDbContext(connection, name); }
        public static async Task<Fixture> CreateAsync()
        {
            var fixture = new Fixture(Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018");
            await fixture.Db.Products.InsertManyAsync(new[] {
                new Product { Id = "p1", Name = "本产品", OwnerId = "me" },
                new Product { Id = "p2", Name = "另一产品", OwnerId = "other" },
            });
            await fixture.Db.Requirements.InsertManyAsync(new[] {
                new Requirement { Id = "r1", ProductId = "p1", Title = "原需求", OwnerId = "me", VersionIds = new() { "v1" } },
                new Requirement { Id = "foreign-requirement", ProductId = "p2", Title = "外部需求", VersionIds = new() { "foreign-version" } },
                new Requirement { Id = "deleted-requirement", ProductId = "p1", IsDeleted = true },
            });
            await fixture.Db.ProductVersions.InsertManyAsync(new[] {
                new ProductVersion { Id = "v1", ProductId = "p1", VersionName = "原版本", RequirementIds = new() { "r1" } },
                new ProductVersion { Id = "foreign-version", ProductId = "p2", RequirementIds = new() { "foreign-requirement" } },
                new ProductVersion { Id = "deleted-version", ProductId = "p1", IsDeleted = true },
            });
            return fixture;
        }
        public ProductAgentController Controller() => new(Db, NullLogger<ProductAgentController>.Instance, null!, null!, null!, null!, null!, null!) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "me"), new Claim("permissions", AdminPermissionCatalog.ProductAgentUse) }, "test")),
            } },
        };
        public ValueTask DisposeAsync() => new(client.DropDatabaseAsync(name));
    }
}
