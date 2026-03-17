using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class UserServiceTests
{
    [Fact]
    public async Task ValidateCredentialsAsync_ShouldReturnNull_WhenPasswordHashIsEmpty()
    {
        // Arrange
        var userRepo = new Mock<IUserRepository>();
        var inviteRepo = new Mock<IInviteCodeRepository>();
        var idGen = new Mock<IIdGenerator>();
        userRepo.Setup(r => r.GetByUsernameAsync("alice"))
            .ReturnsAsync(new User
            {
                UserId = "u-alice",
                Username = "alice",
                UserType = UserType.Human,
                PasswordHash = string.Empty
            });

        var sut = new UserService(userRepo.Object, inviteRepo.Object, idGen.Object);

        // Act
        var result = await sut.ValidateCredentialsAsync("alice", "any-password");

        // Assert
        Assert.Null(result);
    }

    [Fact]
    public async Task ValidateCredentialsAsync_ShouldReturnNull_WhenPasswordHashIsInvalidFormat()
    {
        // Arrange
        var userRepo = new Mock<IUserRepository>();
        var inviteRepo = new Mock<IInviteCodeRepository>();
        var idGen = new Mock<IIdGenerator>();
        userRepo.Setup(r => r.GetByUsernameAsync("bob"))
            .ReturnsAsync(new User
            {
                UserId = "u-bob",
                Username = "bob",
                UserType = UserType.Human,
                PasswordHash = "not-a-bcrypt-hash"
            });

        var sut = new UserService(userRepo.Object, inviteRepo.Object, idGen.Object);

        // Act
        var result = await sut.ValidateCredentialsAsync("bob", "any-password");

        // Assert
        Assert.Null(result);
    }
}
