using PrdAgent.Core.Models.MultiImage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ImageReferenceContractTests
{
    [Theory]
    [InlineData(null, 0)]
    [InlineData(null, 1)]
    [InlineData(0, 0)]
    [InlineData(1, 1)]
    [InlineData(2, 2)]
    public void MatchingOrLegacyReferenceCountsAreAccepted(int? expected, int submitted)
    {
        var result = ImageReferenceContract.Validate(expected, submitted);

        Assert.True(result.IsValid);
        Assert.Null(result.ErrorCode);
        Assert.Equal(submitted, result.ExpectedCount);
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(2, 0)]
    [InlineData(2, 1)]
    public void MissingAnyDeclaredReferenceIsRejected(int expected, int submitted)
    {
        var result = ImageReferenceContract.Validate(expected, submitted);

        Assert.False(result.IsValid);
        Assert.Equal(ImageReferenceContract.IncompleteCode, result.ErrorCode);
        Assert.Equal(expected, result.ExpectedCount);
        Assert.Equal(submitted, result.SubmittedCount);
    }

    [Fact]
    public void MaskWithoutReferenceImageIsRejectedEvenForLegacyCaller()
    {
        var result = ImageReferenceContract.Validate(null, 0, hasMask: true);

        Assert.False(result.IsValid);
        Assert.Equal(ImageReferenceContract.IncompleteCode, result.ErrorCode);
        Assert.Equal(1, result.ExpectedCount);
    }

    [Fact]
    public void NegativeCountsAreRejectedAsInvalidInput()
    {
        var result = ImageReferenceContract.Validate(-1, 0);

        Assert.False(result.IsValid);
        Assert.Equal(ImageReferenceContract.InvalidCountCode, result.ErrorCode);
    }
}
