using MongoDB.Bson.Serialization;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
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

            if (idMap.GetSerializer() is not StringOrObjectIdSerializer)
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
