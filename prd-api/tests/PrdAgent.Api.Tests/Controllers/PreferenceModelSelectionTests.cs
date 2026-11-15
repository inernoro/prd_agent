using PrdAgent.Api.Services;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System.Security.Claims;
using Moq;
using PrdAgent.Core.Interfaces;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class PreferenceModelSelectionTests
{
    [Fact]
    public async Task StaleBrowserPreferenceIsRejectedBeforeAnyDatabaseWrite()
    {
        var catalog = new Mock<IModelPoolQueryService>();
        catalog.Setup(x => x.GetModelPoolsAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync([Current()]);
        // 不可连接的本地地址证明拒绝发生在写库前；此测试不访问外部服务。
        var controller = new UserPreferencesController(new MongoDbContext("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100", "synthetic"), catalog.Object)
        { ControllerContext = new() { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "synthetic-user")], "test")) } } };
        var result = await controller.UpdateLiteraryAgentPreferences(new() { LiteraryAgentPreferences = new() { ImageModelId = "pool_deleted-id" } });
        var response = Assert.IsType<ApiResponse<object>>(Assert.IsType<BadRequestObjectResult>(result).Value);
        Assert.Equal("MODEL_REFERENCE_INVALID", response.Error?.Code);
    }

    private static ModelPoolForAppResult Current(string id = "stable")
        => new() { Id = id, Code = "image-quality", ResolutionType = "LogicalModel", Aliases = ["retired-public"], LegacyPoolIds = ["legacy-pool"] };

    [Theory]
    [InlineData("retired-public")]
    [InlineData("image-quality")]
    [InlineData("stable")]
    [InlineData("pool_stable")]
    [InlineData("pool_legacy-pool")]
    public void CurrentIdentityOrDeclaredInheritanceSavesCanonicalPoolId(string selected)
    {
        Assert.True(PreferenceModelSelection.TryNormalize([Current(), Current()], selected, out var canonical));
        Assert.Equal("pool_stable", canonical);
    }

    [Theory]
    [InlineData("pool_deleted-id")]
    [InlineData("unregistered-old-model")]
    public void StaleClientCannotReintroduceUnmappedDeletedIdentity(string selected)
        => Assert.False(PreferenceModelSelection.TryNormalize([Current()], selected, out _));

    [Fact]
    public void AmbiguousInheritanceDoesNotPickFirstAndEmptySelectionStillFollowsDefault()
    {
        Assert.False(PreferenceModelSelection.TryNormalize([Current(), Current("other")], "retired-public", out _));
        Assert.True(PreferenceModelSelection.TryNormalize([], null, out var canonical));
        Assert.Null(canonical);
    }
}
