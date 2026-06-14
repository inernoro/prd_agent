using System.Reflection;
using PrdAgent.Core.Models;
using PrdAgent.Core.Sync;
using PrdAgent.Infrastructure.Sync.Resources;
using Xunit;

namespace PrdAgent.Tests;

public class DocumentStorePeerSyncTimestampTests
{
    [Fact]
    public void PreserveTimestampsDetectsExistingEntryTimeDrift()
    {
        var existing = new DocumentEntry
        {
            CreatedAt = new DateTime(2026, 6, 13, 1, 0, 0, DateTimeKind.Utc),
            UpdatedAt = new DateTime(2026, 6, 13, 2, 0, 0, DateTimeKind.Utc),
            LastChangedAt = new DateTime(2026, 6, 13, 2, 0, 0, DateTimeKind.Utc),
        };
        var incoming = new SyncRecord
        {
            CreatedAt = new DateTime(2026, 6, 10, 1, 0, 0, DateTimeKind.Utc),
            UpdatedAt = new DateTime(2026, 6, 10, 2, 0, 0, DateTimeKind.Utc),
            LastChangedAt = new DateTime(2026, 6, 10, 2, 0, 0, DateTimeKind.Utc),
        };

        Assert.True(NeedsRecordTimestampRefresh(existing, incoming, preserveTimestamps: true));
    }

    [Fact]
    public void PreserveTimestampsIgnoresMongoSubMillisecondRounding()
    {
        var existing = new DocumentEntry
        {
            CreatedAt = new DateTime(638854056000000000, DateTimeKind.Utc),
            UpdatedAt = new DateTime(638854056010000000, DateTimeKind.Utc),
            LastChangedAt = new DateTime(638854056020000000, DateTimeKind.Utc),
        };
        var incoming = new SyncRecord
        {
            CreatedAt = existing.CreatedAt.AddTicks(999),
            UpdatedAt = existing.UpdatedAt.AddTicks(999),
            LastChangedAt = existing.LastChangedAt!.Value.AddTicks(999),
        };

        Assert.False(NeedsRecordTimestampRefresh(existing, incoming, preserveTimestamps: true));
    }

    [Fact]
    public void TimestampDriftIsIgnoredWhenPreserveTimestampsIsDisabled()
    {
        var existing = new DocumentEntry
        {
            CreatedAt = new DateTime(2026, 6, 13, 1, 0, 0, DateTimeKind.Utc),
            UpdatedAt = new DateTime(2026, 6, 13, 2, 0, 0, DateTimeKind.Utc),
        };
        var incoming = new SyncRecord
        {
            CreatedAt = new DateTime(2026, 6, 10, 1, 0, 0, DateTimeKind.Utc),
            UpdatedAt = new DateTime(2026, 6, 10, 2, 0, 0, DateTimeKind.Utc),
        };

        Assert.False(NeedsRecordTimestampRefresh(existing, incoming, preserveTimestamps: false));
    }

    private static bool NeedsRecordTimestampRefresh(
        DocumentEntry existing,
        SyncRecord incoming,
        bool preserveTimestamps)
    {
        var method = typeof(DocumentStoreSyncResource).GetMethod(
            "NeedsRecordTimestampRefresh",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);
        return (bool)method.Invoke(null, new object[] { existing, incoming, preserveTimestamps })!;
    }
}
