using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.Api.Services;

/// <summary>
/// 构造后台任务 owner 的可接管范围。部署域上线前 owner 只有分支名，不含 "::"；
/// 这类历史 owner 只能由获权的正式部署接管，CDS 预览不得跨分支消费。
/// </summary>
internal static class LegacyOwnerScope
{
    private const string BranchOnlyOwnerPattern = "^(?!.*::).+$";

    internal static FilterDefinition<T> Build<T>(
        string ownerField,
        IReadOnlyCollection<string> compatibleOwnerIds,
        bool includeUnowned,
        bool includeLegacyBranchOnlyOwners)
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

        if (includeLegacyBranchOnlyOwners)
        {
            filters.Add(Builders<T>.Filter.Regex(
                ownerField,
                new BsonRegularExpression(BranchOnlyOwnerPattern)));
        }

        return filters.Count == 1
            ? filters[0]
            : Builders<T>.Filter.Or(filters);
    }
}
