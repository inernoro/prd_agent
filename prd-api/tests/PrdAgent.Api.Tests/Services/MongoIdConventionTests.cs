using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Serializers;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class MongoIdConventionTests
{
    [Fact]
    public void String_Id_Members_Use_StringOrObjectIdSerializer_And_Not_ObjectIdGenerator()
    {
        BsonClassMapRegistration.Register();

        var serializerExceptions = new HashSet<Type>
        {
            typeof(PrdAgent.Core.Models.ParsedPrd)
        };

        var violations = new List<string>();
        foreach (var map in BsonClassMap.GetRegisteredClassMaps())
        {
            var idMap = map.IdMemberMap;
            if (idMap == null) continue;
            if (idMap.MemberType != typeof(string)) continue;
            if (serializerExceptions.Contains(map.ClassType)) continue;

            // LLM Gateway 是独立新库，组织实体从创建之初就只写 GUID 字符串，
            // 不存在需要兼容的历史 ObjectId。允许其保持严格的字符串序列化，
            // 但仍由下方生成器检查禁止 MongoDB 驱动回退到 ObjectId。
            var isGatewayStringOnlyId = map.ClassType.Namespace == "PrdAgent.LlmGw.Models"
                && idMap.GetSerializer() is StringSerializer { Representation: BsonType.String };

            if (idMap.GetSerializer() is not StringOrObjectIdSerializer && !isGatewayStringOnlyId)
            {
                violations.Add($"{map.ClassType.FullName}::{idMap.MemberName} serializer={idMap.GetSerializer()?.GetType().Name ?? "null"}");
            }

            var idGenerator = idMap.IdGenerator;
            if (idGenerator != null && idGenerator.GetType().Name == "StringObjectIdGenerator")
            {
                violations.Add($"{map.ClassType.FullName}::{idMap.MemberName} idGenerator=StringObjectIdGenerator");
            }
        }

        Assert.True(violations.Count == 0, "String Id conventions violated:\n" + string.Join("\n", violations));
    }
}
