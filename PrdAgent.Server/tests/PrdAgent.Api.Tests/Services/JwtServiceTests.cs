using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
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
            expirationHours: 24);
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
        var token = _jwtService.GenerateAccessToken(user);

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
        var token = _jwtService.GenerateAccessToken(user);

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
        var token = _jwtService.GenerateAccessToken(user);

        // Act
        var userId = _jwtService.GetUserIdFromToken(token);

        // Assert
        Assert.Equal(user.UserId, userId);
    }
}



