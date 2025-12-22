using MongoDB.Bson.Serialization;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 统一的字符串主键生成器：使用 Guid("N")，避免任何 ObjectId/BsonId 相关兼容问题。
/// </summary>
public sealed class GuidStringIdGenerator : IIdGenerator
{
    public static readonly GuidStringIdGenerator Instance = new();

    private GuidStringIdGenerator() { }

    public object GenerateId(object container, object document)
    {
        return Guid.NewGuid().ToString("N");
    }

    public bool IsEmpty(object id)
    {
        return id is not string s || string.IsNullOrWhiteSpace(s);
    }
}


