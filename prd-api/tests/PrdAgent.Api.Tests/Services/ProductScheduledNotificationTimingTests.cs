using PrdAgent.Api.Services.ProductAgent;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductScheduledNotificationTimingTests
{
    private static readonly DateTime Now = new(2026, 11, 5, 1, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData("once", "09:15", "2026-11-05", null, 2026, 11, 5, 1, 15)]
    [InlineData("daily", "09:00", null, null, 2026, 11, 6, 1, 0)]
    [InlineData("weekly", "08:00", null, 5, 2026, 11, 6, 0, 0)]
    [InlineData("monthly", "09:00", null, 31, 2026, 12, 31, 1, 0)]
    public void SchedulesAtTheNextBeijingTime(string frequency, string time, string? date, int? day,
        int year, int month, int dayOfMonth, int hour, int minute)
    {
        Assert.True(ProductScheduledNotificationTiming.TryGetNext(frequency, time, date, day, Now, out var next));
        Assert.Equal(new DateTime(year, month, dayOfMonth, hour, minute, 0, DateTimeKind.Utc), next);
        Assert.Equal(DateTimeKind.Utc, next!.Value.Kind);
    }

    [Fact]
    public void DueOneTimeNotificationHasNoNextRun()
    {
        Assert.True(ProductScheduledNotificationTiming.TryGetNext("once", "09:00", "2026-11-05", null, Now, out var next));
        Assert.Null(next);
    }

    [Theory]
    [InlineData("weekly", "08:30", null, 7)]
    [InlineData("monthly", "08:30", null, 0)]
    [InlineData("once", "08:30", "2026-11-31", null)]
    [InlineData("daily", "24:00", null, null)]
    public void RejectsInvalidSchedules(string frequency, string time, string? date, int? day)
    {
        Assert.False(ProductScheduledNotificationTiming.TryGetNext(frequency, time, date, day, Now, out _));
    }
}
