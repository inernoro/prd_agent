using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Serializers;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Controllers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class SyntheticLoginControllerTests
{
    [Theory]
    [InlineData(null, true, "/")]
    [InlineData("/", true, "/")]
    [InlineData("/visual-agent?tab=recent", true, "/visual-agent?tab=recent")]
    [InlineData("https://evil.example", false, "/")]
    [InlineData("//evil.example", false, "/")]
    [InlineData("/safe\\evil", false, "/")]
    public void ReturnUrlPolicy_ShouldAllowOnlySameOriginPaths(
        string? raw,
        bool expected,
        string normalized)
    {
        var args = new object?[] { raw, null };

        var valid = Invoke<bool>("TryNormalizeReturnUrl", args);

        Assert.Equal(expected, valid);
        Assert.Equal(normalized, args[1]);
    }

    [Theory]
    [InlineData(null, 180)]
    [InlineData(1, 60)]
    [InlineData(240, 240)]
    [InlineData(900, 300)]
    public void TicketLifetime_ShouldStayWithinOneToFiveMinutes(int? requested, int expected)
    {
        Assert.Equal(expected, Invoke<int>("NormalizeTicketSeconds", requested));
    }

    [Fact]
    public void LoginUrl_ShouldCarryOneTimeCodeOnlyInFragment()
    {
        var loginUrl = Invoke<string>(
            "BuildLoginUrl",
            "one-time-code",
            "/visual-agent?tab=recent");

        Assert.StartsWith("/synthetic-login#", loginUrl);
        Assert.DoesNotContain("/synthetic-login?", loginUrl);
        Assert.Contains("code=one-time-code", loginUrl);
        Assert.Contains("returnUrl=%2Fvisual-agent%3Ftab%3Drecent", loginUrl);
    }

    [Fact]
    public void TicketIssuance_ShouldRequireAiSuperAccessScheme()
    {
        var method = typeof(SyntheticLoginController).GetMethod(nameof(SyntheticLoginController.IssueTicket));

        Assert.NotNull(method);
        var authorize = method.GetCustomAttribute<AuthorizeAttribute>();
        Assert.NotNull(authorize);
        Assert.Equal(AiAccessKeyAuthenticationHandler.SchemeName, authorize.AuthenticationSchemes);
    }

    [Fact]
    public void Exchange_ShouldBeAnonymousAndTicketBased()
    {
        var method = typeof(SyntheticLoginController).GetMethod(nameof(SyntheticLoginController.Exchange));

        Assert.NotNull(method);
        Assert.NotNull(method.GetCustomAttribute<AllowAnonymousAttribute>());
        Assert.NotNull(method.GetCustomAttribute<HttpPostAttribute>());
    }

    [Fact]
    public void AccountPolicy_ShouldFailClosedWhenAllowlistIsEmpty()
    {
        Assert.False(Invoke<bool>(
            "IsAllowedUser",
            "stable-smoke-user",
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)));
        Assert.True(Invoke<bool>(
            "IsAllowedUser",
            "stable-smoke-user",
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "stable-smoke-user" }));
    }

    [Fact]
    public void TicketIndexes_ShouldProvideUniqueHashLookupAndExpiryCleanup()
    {
        var indexes = DatabaseInitializer.BuildConsoleSsoTicketIndexes();

        Assert.Equal(2, indexes.Count);
        var rendered = indexes.Select(index => new
        {
            Keys = index.Keys.Render(new RenderArgs<BsonDocument>(
                BsonDocumentSerializer.Instance,
                BsonSerializer.SerializerRegistry)),
            index.Options.Name,
            index.Options.Unique,
            index.Options.ExpireAfter,
        }).ToList();
        Assert.Contains(rendered, index =>
            index.Keys == new BsonDocument("CodeHash", 1)
            && index.Name == "uniq_console_sso_tickets_code_hash"
            && index.Unique == true);
        Assert.Contains(rendered, index =>
            index.Keys == new BsonDocument("ExpiresAt", 1)
            && index.Name == "ttl_console_sso_tickets_expires_at"
            && index.ExpireAfter == TimeSpan.Zero);
    }

    [Fact]
    public void DirectVideoIndexes_ShouldProvideUniqueOwnershipAndExpiryCleanup()
    {
        var indexes = DatabaseInitializer.BuildDirectVideoJobOwnershipIndexes();

        Assert.Equal(2, indexes.Count);
        var rendered = indexes.Select(index => new
        {
            Keys = index.Keys.Render(new RenderArgs<DirectVideoJobOwnership>(
                BsonSerializer.SerializerRegistry.GetSerializer<DirectVideoJobOwnership>(),
                BsonSerializer.SerializerRegistry)),
            index.Options.Name,
            index.Options.Unique,
            index.Options.ExpireAfter,
        }).ToList();
        Assert.Contains(rendered, index =>
            index.Keys == new BsonDocument { { "AppKey", 1 }, { "JobId", 1 } }
            && index.Name == "uniq_direct_video_job_app_job"
            && index.Unique == true);
        Assert.Contains(rendered, index =>
            index.Keys == new BsonDocument("ExpiresAt", 1)
            && index.Name == "ttl_direct_video_job_expires_at"
            && index.ExpireAfter == TimeSpan.Zero);
    }

    private static T Invoke<T>(string name, params object?[] args)
    {
        var method = typeof(SyntheticLoginController).GetMethod(
            name,
            BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return Assert.IsAssignableFrom<T>(method.Invoke(null, args));
    }
}
