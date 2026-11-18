using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class HostedShareLifecycleIntegrationTests
{
    [Theory]
    [Trait("Category", "Integration")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LegacyAndHashedShares_ExchangeCookie_ResetKeepsTokenAndInvalidatesGrant(bool legacy)
    {
        var client = new MongoClient("mongodb://127.0.0.1:27083/?serverSelectionTimeoutMS=5000");
        var name = "kd13_lifecycle_" + Guid.NewGuid().ToString("N");
        try
        {
            var db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
            Set(db, "_database", client.GetDatabase(name));
            var passwords = new SharePasswordService();
            var hash = passwords.Hash("synthetic-original");
            var share = new WebPageShareLink { Id = "share", Token = "stable", AccessLevel = "password", Visibility = "public",
                CreatedBy = "owner", CreatedByName = "Synthetic", Password = legacy ? "synthetic-original" : null,
                PasswordHash = legacy ? null : hash.Hash, PasswordSalt = legacy ? null : hash.Salt };
            await db.WebPageShareLinks.InsertOneAsync(share);
            var service = (HostedSiteService)RuntimeHelpers.GetUninitializedObject(typeof(HostedSiteService));
            Set(service, "_db", db); Set(service, "_sharePwd", passwords);
            var controller = (WebPagesController)RuntimeHelpers.GetUninitializedObject(typeof(WebPagesController));
            Set(controller, "_db", db); Set(controller, "_siteService", service);
            controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };
            Assert.IsType<OkObjectResult>(await controller.UnlockShare("stable", new() { Password = "synthetic-original" }, default));
            var cookie = controller.Response.Headers.SetCookie.ToString();
            Assert.Contains("httponly", cookie.ToLowerInvariant());
            Assert.Contains("secure", cookie.ToLowerInvariant());
            Assert.Contains("samesite=strict", cookie.ToLowerInvariant());
            Assert.DoesNotContain("synthetic-original", cookie);
            var grant = Uri.UnescapeDataString(cookie.Split(';')[0].Split('=', 2)[1]);
            Assert.Null((await service.ViewShareAsync("stable", grant))!.Error);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.NameIdentifier, "owner") }, "fixture"));
            Assert.IsType<OkObjectResult>(await controller.ResetSharePassword("share", new() { Password = "synthetic-replacement" }, default));
            var stored = await db.WebPageShareLinks.Find(x => x.Id == "share").SingleAsync();
            Assert.Equal("stable", stored.Token);
            Assert.Null(stored.Password);
            Assert.True(passwords.Verify("synthetic-replacement", stored.PasswordHash!, stored.PasswordSalt!));
            Assert.Equal(401, (await service.ViewShareAsync("stable", grant))!.HttpStatus);
            Assert.Equal(401, (await service.ViewShareAsync("stable", "synthetic-original"))!.HttpStatus);
            Assert.Null((await service.ViewShareAsync("stable", "synthetic-replacement"))!.Error);
            await db.WebPageShareLinks.UpdateOneAsync(x => x.Id == "share", Builders<WebPageShareLink>.Update.Set(x => x.AccessLevel, "public"));
            controller.Response.Headers.Clear();
            controller.HttpContext.User = new ClaimsPrincipal();
            Assert.IsType<OkObjectResult>(await controller.UnlockShare("stable", new(), default));
            Assert.False(controller.Response.Headers.ContainsKey("Set-Cookie"));
        }
        finally { await client.DropDatabaseAsync(name); }
    }
    private static void Set(object target, string name, object value) => target.GetType()
        .GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);
}
