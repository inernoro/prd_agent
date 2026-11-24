using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ProfileAvatarObjectCleanupPolicyTests
{
    [Fact]
    public void SupersededAvatarCleanupPolicy_RejectsForeignAndActiveKeys()
    {
        const string userId = "user-1";
        var ownerPrefix = ProfileAvatarObjectCleanupPolicy.BuildOwnerPrefix(userId);
        var previous = $"{ownerPrefix}0123456789abcdef01234567.png";

        ProfileAvatarObjectCleanupPolicy.TryBuildObjectKey(
            userId,
            previous,
            currentFileName: null,
            out var normalized,
            out var objectKey).ShouldBeTrue();
        normalized.ShouldBe(previous);
        objectKey.ShouldEndWith($"/{previous}");

        ProfileAvatarObjectCleanupPolicy.TryBuildObjectKey(
            userId,
            previous,
            previous,
            out _,
            out _).ShouldBeFalse();
        ProfileAvatarObjectCleanupPolicy.TryBuildObjectKey(
            userId,
            "u-foreign-0123456789abcdef01234567.png",
            currentFileName: null,
            out _,
            out _).ShouldBeFalse();
    }

    [Fact]
    public void TaskId_IsStableForSameUserAndObjectKey()
    {
        var first = ProfileAvatarObjectCleanupPolicy.BuildTaskId(
            "user-1",
            "icon/backups/head/u-123456789abc-0123456789abcdef01234567.png");
        var second = ProfileAvatarObjectCleanupPolicy.BuildTaskId(
            "user-1",
            "ICON/BACKUPS/HEAD/U-123456789ABC-0123456789ABCDEF01234567.PNG");

        first.ShouldBe(second);
        first.Length.ShouldBe(32);
    }

    [Fact]
    public void UserMutationLeaseKey_IsStableAndDoesNotExposeUserId()
    {
        var first = ProfileAvatarObjectCleanupPolicy.BuildUserMutationLeaseKey("User-1");
        var second = ProfileAvatarObjectCleanupPolicy.BuildUserMutationLeaseKey("User-1");

        first.ShouldBe(second);
        first.ShouldStartWith("profile-avatar-user:");
        first.ShouldNotContain("User-1");
    }
}
