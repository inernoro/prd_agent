using System.Reflection;
using System.Runtime.CompilerServices;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Tests.TestHelpers;

internal static class MongoDbContextTestFactory
{
    public static MongoDbContext Create(
        IMongoCollection<GroupMember>? groupMembers = null,
        IMongoCollection<User>? users = null)
    {
        var database = new Mock<IMongoDatabase>(MockBehavior.Loose);
        database.Setup(x => x.GetCollection<GroupMember>("groupmembers", It.IsAny<MongoCollectionSettings>()))
            .Returns(groupMembers ?? CreateCollectionReturning<GroupMember>().Object);
        database.Setup(x => x.GetCollection<User>("users", It.IsAny<MongoCollectionSettings>()))
            .Returns(users ?? CreateCollectionReturning<User>().Object);

        var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        var field = typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)
                    ?? throw new InvalidOperationException("MongoDbContext._database field not found.");
        field.SetValue(context, database.Object);
        return context;
    }

    public static Mock<IMongoCollection<T>> CreateCollectionReturning<T>(params T[] items)
    {
        var cursor = new Mock<IAsyncCursor<T>>(MockBehavior.Strict);
        cursor.SetupSequence(x => x.MoveNext(It.IsAny<CancellationToken>()))
            .Returns(items.Length > 0)
            .Returns(false);
        cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(items.Length > 0)
            .ReturnsAsync(false);
        cursor.SetupGet(x => x.Current).Returns(items);
        cursor.Setup(x => x.Dispose());

        var findFluent = new Mock<IFindFluent<T, T>>(MockBehavior.Loose);
        findFluent.Setup(x => x.Limit(It.IsAny<int?>())).Returns(findFluent.Object);
        findFluent.As<IAsyncCursorSource<T>>()
            .Setup(x => x.ToCursor(It.IsAny<CancellationToken>()))
            .Returns(cursor.Object);
        findFluent.As<IAsyncCursorSource<T>>()
            .Setup(x => x.ToCursorAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(cursor.Object);

        var collection = new Mock<IMongoCollection<T>>(MockBehavior.Loose);
        collection.Setup(x => x.Find(It.IsAny<FilterDefinition<T>>(), It.IsAny<FindOptions<T, T>>()))
            .Returns(findFluent.Object);
        return collection;
    }
}
