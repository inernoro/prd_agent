using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.Api.Services;

/// <summary>
/// 构造后台任务 owner 的可接管范围。部署域上线前 owner 只有分支名；
/// 这类历史 owner 只能按明确的退役名单接管，不能根据字符串形状推断其已经停止。
/// </summary>
internal static class LegacyOwnerScope
{
    internal static FilterDefinition<T> Build<T>(
        string ownerField,
        IReadOnlyCollection<string> compatibleOwnerIds,
        bool includeUnowned,
        IReadOnlyCollection<string> retiredLegacyOwnerIds)
    {
        var filters = new List<FilterDefinition<T>>
        {
            Builders<T>.Filter.In(ownerField, compatibleOwnerIds),
        };

        if (includeUnowned)
        {
            filters.Add(Builders<T>.Filter.Eq(ownerField, BsonNull.Value));
            filters.Add(Builders<T>.Filter.Eq(ownerField, string.Empty));
            filters.Add(Builders<T>.Filter.Exists(ownerField, false));
        }

        if (retiredLegacyOwnerIds.Count > 0)
        {
            filters.Add(Builders<T>.Filter.In(ownerField, retiredLegacyOwnerIds));
        }

        return filters.Count == 1
            ? filters[0]
            : Builders<T>.Filter.Or(filters);
    }
}
