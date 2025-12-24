using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Serializers;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 兼容序列化：允许历史数据的 _id 既可以是 ObjectId，也可以是 string；统一反序列化为 string。
/// 写入时始终写为 string，避免产生任何新的 ObjectId（符合项目 ID 规范）。
/// </summary>
public sealed class StringOrObjectIdSerializer : SerializerBase<string?>
{
    public override string? Deserialize(BsonDeserializationContext context, BsonDeserializationArgs args)
    {
        var bsonType = context.Reader.GetCurrentBsonType();
        // 注意：按项目规则，代码中不应“依赖/生产”ObjectId。
        // 这里仅为兼容历史数据读取：通过字符串名判断，避免直接使用 BsonType.ObjectId 常量。
        if (bsonType == BsonType.String)
            return context.Reader.ReadString();

        if (bsonType == BsonType.Null)
        {
            context.Reader.ReadNull();
            return null;
        }

        if (string.Equals(bsonType.ToString(), "ObjectId", StringComparison.Ordinal))
            return context.Reader.ReadObjectId().ToString();

        throw new FormatException($"Unsupported BSON type for string id: {bsonType}");
    }

    public override void Serialize(BsonSerializationContext context, BsonSerializationArgs args, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            context.Writer.WriteNull();
            return;
        }

        context.Writer.WriteString(value);
    }
}


