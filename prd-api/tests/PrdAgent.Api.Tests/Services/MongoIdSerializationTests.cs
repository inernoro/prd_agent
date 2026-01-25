using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
public class MongoIdSerializationTests
{
    [Fact]
    public void GroupMember_Id_CanDeserialize_FromLegacyObjectId()
    {
        BsonClassMapRegistration.Register();

        var objectId = new ObjectId("507f1f77bcf86cd799439011");
        var doc = new BsonDocument
        {
            { "_id", objectId },
            { "GroupId", "g1" },
            { "UserId", "u1" },
            { "MemberRole", (int)UserRole.DEV },
            { "JoinedAt", DateTime.UtcNow }
        };

        var member = BsonSerializer.Deserialize<GroupMember>(doc);

        Assert.Equal("507f1f77bcf86cd799439011", member.Id);
        Assert.Equal("g1", member.GroupId);
        Assert.Equal("u1", member.UserId);
        Assert.Equal(UserRole.DEV, member.MemberRole);
    }

    [Fact]
    public void GroupMember_Id_Serializes_AsString_EvenIfLooksLikeObjectId()
    {
        BsonClassMapRegistration.Register();

        var member = new GroupMember
        {
            Id = "507f1f77bcf86cd799439011",
            GroupId = "g1",
            UserId = "u1",
            MemberRole = UserRole.DEV,
            JoinedAt = DateTime.UtcNow
        };

        var doc = member.ToBsonDocument();

        Assert.True(doc.Contains("_id"));
        Assert.True(doc["_id"].IsString);
        Assert.Equal("507f1f77bcf86cd799439011", doc["_id"].AsString);
    }
}


