using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>仅使用CI的隔离Mongo测试库，验证真实原子覆盖与并发；不调用生产或外部模型。</summary>
public sealed class ProductPermissionImportTests
{
    private static ProductPermissionWorkbook Workbook(string revision = "none") => new() { ExpectedRevision = revision,
        Sheets = ProductPermissionRules.Menus.Select(m => new ProductPermissionSheet { Menu = m.Key,
            Rows = new() { new() { UserId = "member", DisplayName = "成员", Visible = m.Key is "requirements" or "review" or "versions",
                Functions = m.Functions.ToDictionary(k => k, k => k == AdminPermissionCatalog.ProductAgentVersionApply) } } }).ToList() };

    [Fact]
    public async Task PreviewDoesNotWriteAndImportReplacesOneWholeSnapshotWithoutChangingUsers()
    {
        await using var fixture = await Fixture.Create();
        var original = await fixture.Db.Users.Find(x => x.UserId == "member").FirstAsync();
        Assert.IsType<OkObjectResult>(await fixture.Controller("admin").Preview(Workbook(), default));
        Assert.Equal(0, await fixture.Db.ProductPermissionConfigurations.CountDocumentsAsync(_ => true));
        Assert.IsType<OkObjectResult>(await fixture.Controller("admin").Import(Workbook(), default));
        var config = await fixture.Db.ProductPermissionConfigurations.Find(_ => true).SingleAsync();
        Assert.Equal(ProductPermissionRules.ConfigurationId, config.Id);
        Assert.Equal(new[] { "requirements", "review", "versions" }, Assert.Single(config.Users).Menus);
        var after = await fixture.Db.Users.Find(x => x.UserId == "member").FirstAsync();
        Assert.Equal(original.PermAllow, after.PermAllow); Assert.Equal(original.PermDeny, after.PermDeny); Assert.Equal(original.SystemRoleKey, after.SystemRoleKey);
        Assert.Equal(3, await fixture.Db.Users.CountDocumentsAsync(_ => true));
        var effective = await fixture.Permissions.GetEffectivePermissionsAsync("member", false);
        Assert.Equal(new[] { "requirements", "review", "versions" }, ProductPermissionRules.Menus.Where(m => effective.Contains(ProductPermissionRules.MenuPrefix + m.Key)).Select(m => m.Key));
        Assert.Contains("review-agent.manage", effective); Assert.Contains("other.use", effective);
        Assert.DoesNotContain(ProductPermissionRules.MapAdmin, effective);
        var admin = await fixture.Permissions.GetEffectivePermissionsAsync("admin", false);
        Assert.All(ProductPermissionRules.Menus, m => Assert.Contains(ProductPermissionRules.MenuPrefix + m.Key, admin));
    }

    [Fact]
    public async Task StaleOrMalformedWorkbookCannotPartiallyReplaceCurrentPermissions()
    {
        await using var fixture = await Fixture.Create();
        var controller = fixture.Controller("admin");
        await controller.Import(Workbook(), default);
        var first = await fixture.Db.ProductPermissionConfigurations.Find(_ => true).SingleAsync();
        var malformed = Workbook(first.Revision); malformed.Sheets.RemoveAt(0);
        Assert.IsType<BadRequestObjectResult>(await controller.Import(malformed, default));
        Assert.IsType<ConflictObjectResult>(await controller.Import(Workbook(), default));
        var unchanged = await fixture.Db.ProductPermissionConfigurations.Find(_ => true).SingleAsync();
        Assert.Equal(first.Revision, unchanged.Revision);
        var next = Workbook(first.Revision);
        foreach (var sheet in next.Sheets) { sheet.Rows[0].Visible = false; foreach (var key in sheet.Rows[0].Functions.Keys.ToList()) sheet.Rows[0].Functions[key] = false; }
        Assert.IsType<OkObjectResult>(await controller.Import(next, default));
        var replaced = await fixture.Db.ProductPermissionConfigurations.Find(_ => true).SingleAsync();
        Assert.Empty(replaced.Users[0].Menus); Assert.Equal(first.Revision, replaced.PreviousRevision);
        Assert.Equal(first.Users[0].Menus, replaced.PreviousUsers![0].Menus);
    }

    [Fact]
    public async Task ConcurrentAdministratorsCannotBothReplaceTheSameRevision()
    {
        await using var fixture = await Fixture.Create();
        await fixture.Controller("admin").Import(Workbook(), default);
        var current = await fixture.Db.ProductPermissionConfigurations.Find(_ => true).SingleAsync();
        var results = await Task.WhenAll(fixture.Controller("admin").Import(Workbook(current.Revision), default), fixture.Controller("admin").Import(Workbook(current.Revision), default));
        Assert.Single(results.OfType<OkObjectResult>());
        Assert.Single(results.OfType<ConflictObjectResult>());
        Assert.Equal(1, await fixture.Db.ProductPermissionConfigurations.CountDocumentsAsync(_ => true));
    }

    [Theory]
    [InlineData("member", false)]
    [InlineData("delegated", false)]
    [InlineData("admin", true)]
    public async Task OnlyRealMapAdministratorsNotDelegatedRolesOrAgentKeysCanReadPreviewOrImport(string id, bool agentKey)
    {
        await using var fixture = await Fixture.Create();
        var controller = fixture.Controller(id, agentKey);
        foreach (var result in new[] { await controller.Get(default), await controller.Preview(Workbook(), default), await controller.Import(Workbook(), default) })
            Assert.Equal(403, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Equal(0, await fixture.Db.ProductPermissionConfigurations.CountDocumentsAsync(_ => true));
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal MongoDbContext Db { get; }
        internal IAdminPermissionService Permissions { get; }
        private Fixture(MongoDbContext db)
        {
            Db = db;
            var roles = new Mock<ISystemRoleCacheService>();
            roles.Setup(x => x.GetRoleByKey(It.IsAny<string>())).Returns((string key) => new SystemRole {
                Key = key, Permissions = new() { AdminPermissionCatalog.Access, AdminPermissionCatalog.ProductAgentUse } });
            Permissions = new AdminPermissionService(db, roles.Object);
        }
        internal static async Task<Fixture> Create()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
            var db = new MongoDbContext(connection, "product_permission_test_" + Guid.NewGuid().ToString("N"));
            await db.Users.InsertManyAsync(new[] {
                new User { UserId = "admin", Username = "admin", DisplayName = "管理员", Role = UserRole.ADMIN },
                new User { UserId = "member", Username = "member", DisplayName = "成员", Role = UserRole.PM, PermAllow = new() { "review-agent.manage", "other.use" }, PermDeny = new() { "other.manage" }, SystemRoleKey = "custom" },
                new User { UserId = "delegated", Username = "delegated", DisplayName = "授权管理员", Role = UserRole.DEV, PermAllow = new() { "super", "authz.manage", "product-agent.admin" } },
            });
            return new Fixture(db);
        }
        internal ProductPermissionsController Controller(string id, bool agentKey = false)
        {
            var claims = new List<Claim> { new("sub", id) };
            if (agentKey) claims.Add(new("authType", "agent-apikey"));
            return new ProductPermissionsController(Db, Permissions) { ControllerContext = new() { HttpContext = new DefaultHttpContext { User = new(new ClaimsIdentity(claims, "test")) } } };
        }
        public async ValueTask DisposeAsync() => await Db.Database.Client.DropDatabaseAsync(Db.Database.DatabaseNamespace.DatabaseName);
    }
}
