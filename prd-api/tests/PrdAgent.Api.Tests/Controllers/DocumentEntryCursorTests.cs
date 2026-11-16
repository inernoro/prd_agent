using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class DocumentEntryCursorTests
{
    [Fact]
    public void Cursor_RoundTrips_AndRejectsOtherStoresOrMalformedValues()
    {
        var before = DateTime.UtcNow.AddSeconds(-1);
        var token = new DocumentEntryCursor("mine", before, "entry-a").Encode();
        DocumentEntryCursor.TryDecode(token, "mine", out var cursor).ShouldBeTrue();
        cursor.ShouldBe(new DocumentEntryCursor("mine", before, "entry-a"));
        DocumentEntryCursor.TryDecode(token, "other", out _).ShouldBeFalse();
        DocumentEntryCursor.TryDecode("garbage", "mine", out _).ShouldBeFalse();
        DocumentEntryCursor.TryDecode(Convert.ToBase64String("null"u8.ToArray()), "mine", out _).ShouldBeFalse();
        DocumentEntryCursor.TryDecode(new string('x', 2049), "mine", out _).ShouldBeFalse();
        DocumentEntryCursor.TryDecode(new DocumentEntryCursor("mine", DateTime.UtcNow.AddDays(1), "a").Encode(), "mine", out _).ShouldBeFalse();
    }
}
