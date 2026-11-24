using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.Security;

/// <summary>Policy edits have their own revision; runtime usage observations do not change it.</summary>
public static class LegacyKeyPolicyConcurrency
{
    public const string RevisionField = "PolicyRevision";

    public static long ReadRevision(BsonDocument? policy)
        => policy is not null && policy.TryGetValue(RevisionField, out var value) && value.IsNumeric
            ? value.ToInt64() : 0;

    public static FilterDefinition<BsonDocument> WriteFilter(long expectedRevision, string nextStatus)
    {
        var filter = Builders<BsonDocument>.Filter;
        var revision = expectedRevision == 0
            ? filter.Or(filter.Eq(RevisionField, 0L), filter.Exists(RevisionField, false))
            : filter.Eq(RevisionField, expectedRevision);
        // Keep permanent revocation atomic, including legacy records before revisions existed.
        return nextStatus == "revoked" ? revision : filter.And(revision,
            filter.Not(filter.Regex("Status", new BsonRegularExpression("^revoked$", "i"))));
    }
}
