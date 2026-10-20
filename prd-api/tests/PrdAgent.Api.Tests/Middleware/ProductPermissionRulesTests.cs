using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Middleware;

public class ProductPermissionRulesTests
{
    private static User Person(string id = "u1", string name = "成员") => new() { UserId = id, Username = id, DisplayName = name, Role = UserRole.PM };
    private static ProductPermissionWorkbook Book() => new()
    {
        ExpectedRevision = "none",
        Sheets = ProductPermissionRules.Menus.Select(m => new ProductPermissionSheet { Menu = m.Key,
            Rows = new() { new() { UserId = "u1", Username = "u1", DisplayName = "成员",
                Visible = m.Key is "requirements" or "review" or "versions",
                Functions = m.Functions.ToDictionary(k => k, k => k == AdminPermissionCatalog.ProductAgentVersionApply) } } }).ToList()
    };

    [Fact]
    public void EntireWorkbookGrantsOnlyThreeMenusAndPreservesStandaloneAndOtherApps()
    {
        var person = Person();
        var config = new ProductPermissionConfiguration { Users = ProductPermissionRules.Normalize(Book(), new[] { person }) };
        var effective = ProductPermissionRules.Apply(person, new[] { "super", "review-agent.manage", "other.use", "product-agent.admin", ProductPermissionRules.MapAdmin }, config);
        Assert.Equal(new[] { "requirements", "review", "versions" }, ProductPermissionRules.Menus.Where(m => effective.Contains(ProductPermissionRules.MenuPrefix + m.Key)).Select(m => m.Key));
        Assert.Contains("review-agent.manage", effective); Assert.Contains("other.use", effective);
        Assert.DoesNotContain(ProductPermissionRules.MapAdmin, effective); Assert.DoesNotContain("product-agent.admin", effective);
        Assert.Contains(AdminPermissionCatalog.ProductAgentVersionApply, effective);
        var omitted = ProductPermissionRules.Apply(Person("absent"), effective, config);
        Assert.DoesNotContain(AdminPermissionCatalog.ProductAgentUse, omitted);
        Assert.DoesNotContain(AdminPermissionCatalog.ProductAgentVersionApply, omitted);
        Assert.Contains("review-agent.manage", omitted);
    }

    [Fact]
    public void RealMapAdminAlwaysHasAllButOrdinarySuperCannotForgeIdentity()
    {
        var admin = Person(); admin.Role = UserRole.ADMIN;
        var result = ProductPermissionRules.Apply(admin, Array.Empty<string>(), new());
        Assert.Contains(ProductPermissionRules.MapAdmin, result);
        Assert.All(ProductPermissionRules.Menus, m => Assert.Contains(ProductPermissionRules.MenuPrefix + m.Key, result));
        Assert.DoesNotContain(ProductPermissionRules.MapAdmin, ProductPermissionRules.Apply(Person(), new[] { ProductPermissionRules.MapAdmin }, null));
    }

    [Theory]
    [InlineData("missing")][InlineData("duplicate")][InlineData("mismatch")][InlineData("unknown-function")][InlineData("closed-function")][InlineData("null")]
    public void InvalidWorkbookIsRejectedBeforePersistence(string kind)
    {
        var book = Book();
        if (kind == "missing") book.Sheets.RemoveAt(0);
        if (kind == "duplicate") book.Sheets[0] = book.Sheets[1];
        if (kind == "mismatch") book.Sheets[0].Rows[0].Username = "not-u1";
        if (kind == "unknown-function") book.Sheets[0].Rows[0].Functions["super"] = true;
        if (kind == "closed-function") book.Sheets.Single(s => s.Menu == "versions").Rows[0].Visible = false;
        if (kind == "null") book.Sheets = null!;
        Assert.Throws<ArgumentException>(() => ProductPermissionRules.Normalize(book, new[] { Person() }));
    }

    [Fact]
    public void SameNameMustResolveUniquelyAndEverySheetHasSameDirectory()
    {
        var book = Book();
        foreach (var s in book.Sheets) { s.Rows[0].UserId = ""; s.Rows[0].Username = ""; }
        Assert.Throws<ArgumentException>(() => ProductPermissionRules.Normalize(book, new[] { Person(), Person("u2") }));
        Assert.Single(ProductPermissionRules.Normalize(book, new[] { Person() }));
        book.Sheets[0].Rows.Add(new() { UserId = "u2", Functions = new() });
        Assert.Throws<ArgumentException>(() => ProductPermissionRules.Normalize(book, new[] { Person(), Person("u2", "第二人") }));
    }

    [Theory]
    [InlineData("/api/product/overview/requirements", "GET", true)]
    [InlineData("/api/product/review/submissions", "POST", true)]
    [InlineData("/api/product/review/assessments", "GET", true)]
    [InlineData("/api/product/products/p1/initiations", "POST", true)]
    [InlineData("/api/product/products/p1/releases", "POST", true)]
    [InlineData("/api/product/overview/stats", "GET", false)]
    [InlineData("/api/product/overview/defects", "GET", false)]
    [InlineData("/api/product/products", "POST", false)]
    [InlineData("/api/product/categories", "POST", false)]
    [InlineData("/api/product/future-unknown-route", "GET", false)]
    public void MenuPolicyDoesNotLetOrdinarySuperBypassSelectedMenus(string path, string method, bool allowed)
    {
        var perms = ProductPermissionRules.Apply(Person(), new[] { "super" }, new() { Users = ProductPermissionRules.Normalize(Book(), new[] { Person() }) });
        Assert.Equal(allowed, ProductMenuRoutePolicy.Allows(perms.ToArray(), path, method));
    }

    [Theory]
    [InlineData("/api/product/review/dimensions", false)]
    [InlineData("/api/review-agent/dimensions", true)]
    public async Task ProductScopedRequestDoesNotReuseStaleReviewManagerClaims(string path, bool expectedManager)
    {
        var scanner = new Mock<IAdminControllerScanner>();
        scanner.Setup(x => x.GetRequiredPermission(path, "GET")).Returns(path.StartsWith("/api/product/") ? AdminPermissionCatalog.ProductAgentUse : AdminPermissionCatalog.ReviewAgentUse);
        var service = new Mock<IAdminPermissionService>();
        service.Setup(x => x.GetEffectivePermissionsAsync("u1", false, default)).ReturnsAsync(new[] { AdminPermissionCatalog.Access, AdminPermissionCatalog.ProductAgentUse,
            ProductPermissionRules.Scoped, ProductPermissionRules.MenuPrefix + "review", AdminPermissionCatalog.ReviewAgentUse, AdminPermissionCatalog.ReviewAgentManage, "super" });
        var called = false;
        var middleware = new AdminPermissionMiddleware(ctx => { called = true; Assert.Equal(expectedManager, ctx.User.HasClaim("permissions", AdminPermissionCatalog.ReviewAgentManage)); return Task.CompletedTask; }, NullLogger<AdminPermissionMiddleware>.Instance, scanner.Object);
        var context = new DefaultHttpContext { User = new(new ClaimsIdentity(new[] { new Claim("sub", "u1"), new Claim("permissions", AdminPermissionCatalog.ReviewAgentManage) }, "test")) };
        context.Request.Path = path; context.Request.Method = "GET";
        await middleware.Invoke(context, service.Object);
        Assert.True(called);
    }
}
