using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class PublicSubmissionCreatorsTests
{
    [Fact]
    public async Task ResolveCreators_ShouldPreferCurrentProfileAndSuppressMissingAvatarObjects()
    {
        var candidates = new[]
        {
            new SubmissionsController.PublicSubmissionCreatorCandidate(
                "cleared", "历史名称一", "stale-cleared.jpg", 4),
            new SubmissionsController.PublicSubmissionCreatorCandidate(
                "missing", "历史名称二", "stale-missing.jpg", 3),
            new SubmissionsController.PublicSubmissionCreatorCandidate(
                "present", "历史名称三", "stale-present.jpg", 2),
        };
        var currentUsers = new Dictionary<string, User>(StringComparer.Ordinal)
        {
            ["cleared"] = User("cleared", "当前名称一", avatarFileName: null),
            ["missing"] = User("missing", "当前名称二", "current-missing.jpg"),
            ["present"] = User("present", "当前名称三", "Current-Present.JPG"),
        };
        using var cts = new CancellationTokenSource();
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage
            .Setup(x => x.ExistsAsync(
                "icon/backups/head/current-missing.jpg",
                It.Is<CancellationToken>(ct => ct == cts.Token)))
            .ReturnsAsync(false);
        storage
            .Setup(x => x.ExistsAsync(
                "icon/backups/head/current-present.jpg",
                It.Is<CancellationToken>(ct => ct == cts.Token)))
            .ReturnsAsync(true);

        var creators = await SubmissionsController.ResolvePublicSubmissionCreatorsAsync(
            candidates,
            currentUsers,
            storage.Object,
            cts.Token);

        Assert.Collection(
            creators,
            creator =>
            {
                Assert.Equal("当前名称一", creator.OwnerUserName);
                Assert.Null(creator.OwnerAvatarFileName);
            },
            creator =>
            {
                Assert.Equal("当前名称二", creator.OwnerUserName);
                Assert.Null(creator.OwnerAvatarFileName);
            },
            creator =>
            {
                Assert.Equal("当前名称三", creator.OwnerUserName);
                Assert.Equal("Current-Present.JPG", creator.OwnerAvatarFileName);
            });
        storage.Verify(
            x => x.ExistsAsync("icon/backups/head/stale-cleared.jpg", It.IsAny<CancellationToken>()),
            Times.Never);
        storage.Verify(
            x => x.ExistsAsync("icon/backups/head/stale-missing.jpg", It.IsAny<CancellationToken>()),
            Times.Never);
        storage.Verify(
            x => x.ExistsAsync("icon/backups/head/stale-present.jpg", It.IsAny<CancellationToken>()),
            Times.Never);
        storage.VerifyAll();
    }

    [Fact]
    public async Task ResolveCreators_ShouldBoundConcurrentAvatarChecks()
    {
        var candidates = Enumerable.Range(0, 60)
            .Select(index => new SubmissionsController.PublicSubmissionCreatorCandidate(
                $"user-{index}",
                $"用户 {index}",
                $"avatar-{index}.png",
                1))
            .ToArray();
        var currentUsers = new Dictionary<string, User>(StringComparer.Ordinal);
        var inFlight = 0;
        var maxInFlight = 0;
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage
            .Setup(x => x.ExistsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(async (string _, CancellationToken ct) =>
            {
                var current = Interlocked.Increment(ref inFlight);
                UpdateMaximum(ref maxInFlight, current);
                try
                {
                    await Task.Delay(5, ct);
                    return true;
                }
                finally
                {
                    Interlocked.Decrement(ref inFlight);
                }
            });

        var creators = await SubmissionsController.ResolvePublicSubmissionCreatorsAsync(
            candidates,
            currentUsers,
            storage.Object,
            CancellationToken.None);

        Assert.Equal(60, creators.Count);
        Assert.InRange(maxInFlight, 1, 8);
    }

    private static User User(string userId, string displayName, string? avatarFileName) => new()
    {
        UserId = userId,
        Username = $"account-{userId}",
        DisplayName = displayName,
        AvatarFileName = avatarFileName,
    };

    private static void UpdateMaximum(ref int target, int value)
    {
        while (true)
        {
            var current = Volatile.Read(ref target);
            if (current >= value || Interlocked.CompareExchange(ref target, value, current) == current)
            {
                return;
            }
        }
    }
}
