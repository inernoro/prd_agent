using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using System.IdentityModel.Tokens.Jwt;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class JwtServiceTests
{
    private readonly JwtService _jwtService;

    public JwtServiceTests()
    {
        _jwtService = new JwtService(
            secret: "YourSuperSecretKeyForJwtTokenGeneration2024!",
            issuer: "prdagent-test",
            audience: "prdagent-test",
            accessTokenMinutes: 60);
    }

    [Fact]
    public void GenerateAccessToken_ShouldReturnValidToken()
    {
        // Arrange
        var user = new User
        {
            UserId = "test-user-id",
            Username = "testuser",
            DisplayName = "Test User",
            Role = UserRole.PM
        };

        // Act
        var token = _jwtService.GenerateAccessToken(
            user,
            clientType: "desktop",
            sessionKey: "test-session-key",
            tokenVersion: 1);

        // Assert
        Assert.NotNull(token);
        Assert.NotEmpty(token);
    }

    [Fact]
    public void ValidateToken_ShouldReturnValidResult()
    {
        // Arrange
        var user = new User
        {
            UserId = "test-user-id",
            Username = "testuser",
            DisplayName = "Test User",
            Role = UserRole.DEV
        };
        var token = _jwtService.GenerateAccessToken(
            user,
            clientType: "desktop",
            sessionKey: "test-session-key",
            tokenVersion: 1);

        // Act
        var result = _jwtService.ValidateToken(token);

        // Assert
        Assert.True(result.IsValid);
        Assert.Equal(user.UserId, result.UserId);
        Assert.Equal(user.Username, result.Username);
        Assert.Equal(user.Role, result.Role);
    }

    [Fact]
    public void ValidateToken_WithInvalidToken_ShouldReturnInvalid()
    {
        // Arrange
        var invalidToken = "invalid.token.here";

        // Act
        var result = _jwtService.ValidateToken(invalidToken);

        // Assert
        Assert.False(result.IsValid);
        Assert.NotNull(result.ErrorMessage);
    }

    [Fact]
    public void GenerateRefreshToken_ShouldReturnNonEmptyString()
    {
        // Act
        var refreshToken = _jwtService.GenerateRefreshToken();

        // Assert
        Assert.NotNull(refreshToken);
        Assert.NotEmpty(refreshToken);
    }

    [Fact]
    public void GetUserIdFromToken_ShouldReturnUserId()
    {
        // Arrange
        var user = new User
        {
            UserId = "test-user-id-123",
            Username = "testuser",
            Role = UserRole.QA
        };
        var token = _jwtService.GenerateAccessToken(
            user,
            clientType: "desktop",
            sessionKey: "test-session-key",
            tokenVersion: 1);

        // Act
        var userId = _jwtService.GetUserIdFromToken(token);

        // Assert
        Assert.Equal(user.UserId, userId);
    }

    [Fact]
    public void GenerateAccessToken_ShouldSupportBoundedSyntheticSession()
    {
        var before = DateTime.UtcNow;
        var user = new User
        {
            UserId = "stable-smoke-user-id",
            Username = "stable-smoke-user",
            DisplayName = "Stable Smoke User",
            Role = UserRole.QA
        };

        var token = _jwtService.GenerateAccessToken(
            user,
            clientType: "admin",
            sessionKey: "synthetic-session-key",
            tokenVersion: 1,
            expiresInMinutes: 30,
            authType: "synthetic-test");

        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);
        Assert.Equal("synthetic-test", jwt.Claims.Single(claim => claim.Type == "authType").Value);
        Assert.InRange(jwt.ValidTo, before.AddMinutes(29), before.AddMinutes(31));
    }
}
