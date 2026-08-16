using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.Api.Services;

/// <summary>
/// 构造后台任务 owner 的可接管范围。部署域上线前 owner 只有分支名；
/// 这类历史 owner 只能按明确的退役名单和创建时间截止线接管，
/// 不能根据字符串形状推断其已经停止。
/// </summary>
internal static class LegacyOwnerScope
{
    internal static FilterDefinition<T> Build<T>(
        string ownerField,
        IReadOnlyCollection<string> compatibleOwnerIds,
        bool includeUnowned,
        IReadOnlyCollection<string> retiredLegacyOwnerIds,
        DateTime? legacyOwnerCreatedBeforeUtc)
    {
        var filters = new List<FilterDefinition<T>>
        {
            Builders<T>.Filter.In(ownerField, compatibleOwnerIds),
        };

        var legacyOwners = new List<FilterDefinition<T>>();
        if (includeUnowned)
        {
            legacyOwners.Add(Builders<T>.Filter.Eq(ownerField, BsonNull.Value));
            legacyOwners.Add(Builders<T>.Filter.Eq(ownerField, string.Empty));
            legacyOwners.Add(Builders<T>.Filter.Exists(ownerField, false));
        }

        if (retiredLegacyOwnerIds.Count > 0)
        {
            legacyOwners.Add(Builders<T>.Filter.In(ownerField, retiredLegacyOwnerIds));
        }

        if (legacyOwners.Count > 0 && legacyOwnerCreatedBeforeUtc != null)
        {
            filters.Add(Builders<T>.Filter.And(
                Builders<T>.Filter.Or(legacyOwners),
                Builders<T>.Filter.Lte("CreatedAt", legacyOwnerCreatedBeforeUtc.Value)));
        }

        return filters.Count == 1
            ? filters[0]
            : Builders<T>.Filter.Or(filters);
    }
}
