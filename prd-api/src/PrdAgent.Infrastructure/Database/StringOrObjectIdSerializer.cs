using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Serializers;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 兼容序列化：允许 _id 既可以是 ObjectId，也可以是 string；统一反序列化为 string。
/// </summary>
public sealed class StringOrObjectIdSerializer : SerializerBase<string?>
{
    public override string? Deserialize(BsonDeserializationContext context, BsonDeserializationArgs args)
    {
        var bsonType = context.Reader.GetCurrentBsonType();
        switch (bsonType)
        {
            case BsonType.ObjectId:
                return context.Reader.ReadObjectId().ToString();
            case BsonType.String:
                return context.Reader.ReadString();
            case BsonType.Null:
                context.Reader.ReadNull();
                return null;
            default:
                throw new FormatException($"Unsupported BSON type for string/objectId: {bsonType}");
        }
    }

    public override void Serialize(BsonSerializationContext context, BsonSerializationArgs args, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            context.Writer.WriteNull();
            return;
        }

        // 能解析为 ObjectId 的，优先写成 ObjectId；否则写成 string（兼容迁移/导入数据）。
        if (ObjectId.TryParse(value, out var objectId))
        {
            context.Writer.WriteObjectId(objectId);
            return;
        }

        context.Writer.WriteString(value);
    }
}


