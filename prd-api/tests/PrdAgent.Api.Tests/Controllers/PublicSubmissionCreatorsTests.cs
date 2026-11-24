using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
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
            NullLogger.Instance,
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
            NullLogger.Instance,
            CancellationToken.None);

        Assert.Equal(60, creators.Count);
        Assert.InRange(maxInFlight, 1, 8);
    }

    [Fact]
    public async Task ResolveCreators_ShouldDegradeAvatarWhenStorageProbeThrows()
    {
        // 对象存储抖一次只该让这一个头像退回占位，不该把整张创作者榜打成 500。
        var candidates = new[]
        {
            new SubmissionsController.PublicSubmissionCreatorCandidate(
                "flaky", "抖动用户", "boom.jpg", 5),
            new SubmissionsController.PublicSubmissionCreatorCandidate(
                "healthy", "正常用户", "fine.jpg", 2),
        };
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage
            .Setup(x => x.ExistsAsync("icon/backups/head/boom.jpg", It.IsAny<CancellationToken>()))
            .ThrowsAsync(new HttpRequestException("storage blip"));
        storage
            .Setup(x => x.ExistsAsync("icon/backups/head/fine.jpg", It.IsAny<CancellationToken>()))
            .ReturnsAsync(true);
        var logger = new RecordingLogger();

        var creators = await SubmissionsController.ResolvePublicSubmissionCreatorsAsync(
            candidates,
            new Dictionary<string, User>(StringComparer.Ordinal),
            storage.Object,
            logger,
            CancellationToken.None);

        Assert.Collection(
            creators,
            creator =>
            {
                Assert.Equal("抖动用户", creator.OwnerUserName);
                Assert.Null(creator.OwnerAvatarFileName);
            },
            creator =>
            {
                Assert.Equal("正常用户", creator.OwnerUserName);
                Assert.Equal("fine.jpg", creator.OwnerAvatarFileName);
            });
        // 降级不许静默（predicate-and-wiring-discipline 形状 10）
        Assert.Contains(logger.Warnings, line => line.Contains("flaky", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ResolveCreators_ShouldStillPropagateCallerCancellation()
    {
        var candidates = new[]
        {
            new SubmissionsController.PublicSubmissionCreatorCandidate(
                "user", "用户", "avatar.png", 1),
        };
        using var cts = new CancellationTokenSource();
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage
            .Setup(x => x.ExistsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(async (string _, CancellationToken token) =>
            {
                await cts.CancelAsync();
                token.ThrowIfCancellationRequested();
                return true;
            });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => SubmissionsController.ResolvePublicSubmissionCreatorsAsync(
                candidates,
                new Dictionary<string, User>(StringComparer.Ordinal),
                storage.Object,
                NullLogger.Instance,
                cts.Token));
    }

    private sealed class RecordingLogger : ILogger
    {
        public List<string> Warnings { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (logLevel >= LogLevel.Warning)
            {
                Warnings.Add(formatter(state, exception));
            }
        }
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
