using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class DocumentAssetCleanupPolicyTests
{
    [Theory]
    [InlineData("_it/stable-smoke-document/test.webm", true)]
    [InlineData("_it/stable-smoke-document/sub/test.pdf", true)]
    [InlineData("_it/stable-smoke-document/../avatar.png", false)]
    [InlineData("avatar/users/test.png", false)]
    [InlineData("", false)]
    public void ManagedKeyGuard_AcceptsOnlyStableSmokeDocumentObjects(string key, bool expected)
    {
        DocumentAssetCleanupService.IsManagedStorageKey(key).ShouldBe(expected);
    }

    [Fact]
    public void TaskId_IsDeterministicAndKeySpecific()
    {
        var first = DocumentAssetCleanupService.BuildTaskId(
            "_it/stable-smoke-document/first.webm");
        var repeated = DocumentAssetCleanupService.BuildTaskId(
            "_it/stable-smoke-document/first.webm");
        var second = DocumentAssetCleanupService.BuildTaskId(
            "_it/stable-smoke-document/second.webm");

        first.ShouldBe(repeated);
        first.ShouldNotBe(second);
        first.Length.ShouldBe(64);
    }

    [Fact]
    public void CleanupPurposes_KeepUploadRollbackSeparateFromUnlinkDeletion()
    {
        DocumentAssetCleanupService.PendingUploadPurpose.ShouldBe("pending-upload");
        DocumentAssetCleanupService.DeleteAfterUnlinkPurpose.ShouldBe("delete-after-unlink");
    }
}
