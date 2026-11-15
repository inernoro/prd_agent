using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

[Trait("Category", "Integration")]
public class LoginEnvironmentOptionsTests
{
    [Fact]
    public async Task LockedLogin_ExplainsCurrentEnvironment_WithoutTryingPasswordAgain()
    {
        var attempts = new Mock<ILoginAttemptService>();
        attempts.Setup(x => x.IsLockedAsync("fixture-user")).ReturnsAsync(true);
        attempts.Setup(x => x.GetLockoutRemainingSecondsAsync("fixture-user")).ReturnsAsync(821);
        var controller = new AuthController(null!, null!, attempts.Object, null!, null!, null!,
            NullLogger<AuthController>.Instance);
        var result = Assert.IsType<ObjectResult>(await controller.Login(new LoginRequest
        { Username = "fixture-user", Password = "FixturePassword123!", ClientType = "admin" }));
        Assert.Equal(429, result.StatusCode);
        var response = Assert.IsType<ApiResponse<object>>(result.Value);
        Assert.Equal(ErrorCodes.ACCOUNT_LOCKED, response.Error!.Code);
        Assert.Contains("当前环境", response.Error.Message);
        Assert.Contains("821 秒后重试", response.Error.Message);
        attempts.Verify(x => x.RecordFailedAttemptAsync(It.IsAny<string>()), Times.Never);
    }

    [Theory]
    [InlineData(null, "https://main.example.test/login", false, null)]
    [InlineData("false", "https://main.example.test/login", false, null)]
    [InlineData("true", "https://main.example.test/login", true, "https://main.example.test/login")]
    [InlineData("true", "http://main.example.test/", true, null)]
    [InlineData("true", "https://user:secret@main.example.test/", true, null)]
    [InlineData("true", "https://main.example.test/?token=secret", true, null)]
    [InlineData("true", "https://main.example.test/#secret", true, null)]
    [InlineData("true", "javascript:alert(1)", true, null)]
    [InlineData("true", null, true, null)]
    public async Task AnonymousOptions_DescribeOnlyExplicitIsolation_WithoutExposingCredentials(
        string? isolated, string? primary, bool expectedIsolated, string? expectedPrimary)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
        var name = "test_login_environment_" + Guid.NewGuid().ToString("N");
        var client = new MongoClient(connection);
        try
        {
            var db = new MongoDbContext(connection, name);
            var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:AccountStoreIsolated"] = isolated,
                ["Auth:PrimaryLoginUrl"] = primary,
                ["MongoDB:ConnectionString"] = "private-connection-secret",
                ["ROOT_ACCESS_PASSWORD"] = "private-root-secret"
            }).Build();
            var controller = new MiduoPlanetSsoController(null!, null!, null!, null!, db, config, null!,
                NullLogger<MiduoPlanetSsoController>.Instance, null!)
            { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            var result = Assert.IsType<OkObjectResult>(await controller.Options());
            var response = Assert.IsType<ApiResponse<SsoOptionsResponse>>(result.Value);
            Assert.True(response.Success);
            Assert.Equal(expectedIsolated, response.Data!.LoginEnvironment?.IsolatedAccountStore == true);
            Assert.Equal(expectedPrimary, response.Data.LoginEnvironment?.PrimaryLoginUrl);
            Assert.Empty(response.Data.Items);
            var json = System.Text.Json.JsonSerializer.Serialize(response);
            Assert.DoesNotContain("secret", json);
        }
        finally { await client.DropDatabaseAsync(name); }
    }
}
