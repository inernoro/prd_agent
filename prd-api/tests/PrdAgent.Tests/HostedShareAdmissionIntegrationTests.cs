using System.Reflection;
using System.Runtime.CompilerServices;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class HostedShareAdmissionIntegrationTests
{
    [Fact]
    [Trait("Category", "Integration")]
    public async Task IndependentInstances_ReserveBeforeVerification_WithoutLosingCounts()
    {
        // Dedicated loopback fixture only. Never use application database configuration.
        var client = new MongoClient("mongodb://127.0.0.1:27083/?serverSelectionTimeoutMS=5000");
        var name = "kd13_" + Guid.NewGuid().ToString("N");
        var database = client.GetDatabase(name);
        try
        {
            var db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
            Set(db, "_database", database);
            var pwd = new CountingPasswords();
            var hash = pwd.Hash("synthetic-only");
            var share = new WebPageShareLink { Id = "test", Token = "synthetic-token", AccessLevel = "password", PasswordHash = hash.Hash, PasswordSalt = hash.Salt };
            await db.WebPageShareLinks.InsertOneAsync(share);
            // Legacy BSON omits both fields; admission must not spin on a false-only predicate.
            await db.WebPageShareLinks.UpdateOneAsync(x => x.Id == share.Id,
                Builders<WebPageShareLink>.Update.Unset(x => x.IsRevoked).Unset(x => x.RecentAttempts));
            var gate = typeof(HostedSiteService).GetMethod("EnforceShareAccessAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var tasks = Enumerable.Range(0, 80).Select(async _ =>
            {
                var service = (HostedSiteService)RuntimeHelpers.GetUninitializedObject(typeof(HostedSiteService));
                Set(service, "_db", db);
                Set(service, "_sharePwd", pwd);
                var invocation = (Task<(string Error, int HttpStatus, int? RetryAfter)?>)gate.Invoke(service, new object?[] { share, "synthetic-only", null, CancellationToken.None })!;
                return await invocation;
            });
            var results = await Task.WhenAll(tasks);
            Assert.Equal(10, results.Count(x => x == null));
            Assert.Equal(70, results.Count(x => x?.HttpStatus == 429));
            Assert.Equal(10, pwd.Verifications);
            var stored = await db.WebPageShareLinks.Find(x => x.Id == share.Id).SingleAsync();
            Assert.Equal(10, stored.RecentAttempts.Count);
            var grant = await HostedShareGrant.IssueAsync(db, stored, default);
            Assert.True(await HostedShareGrant.VerifyAsync(db, stored, grant, default));
            var grantedService = (HostedSiteService)RuntimeHelpers.GetUninitializedObject(typeof(HostedSiteService));
            Set(grantedService, "_db", db); Set(grantedService, "_sharePwd", pwd);
            for (var i = 0; i < 15; i++)
                Assert.Null(await (Task<(string Error, int HttpStatus, int? RetryAfter)?>)gate.Invoke(grantedService,
                    new object?[] { share, grant, null, CancellationToken.None })!);
            Assert.Equal(10, pwd.Verifications);
            Assert.Equal(10, (await db.WebPageShareLinks.Find(x => x.Id == share.Id).SingleAsync()).RecentAttempts.Count);
            await db.WebPageShareLinks.UpdateOneAsync(x => x.Id == share.Id,
                Builders<WebPageShareLink>.Update.Set(x => x.IsRevoked, true));
            var revoked = await (Task<(string Error, int HttpStatus, int? RetryAfter)?>)gate.Invoke(grantedService,
                new object?[] { share, grant, null, CancellationToken.None })!;
            Assert.Equal(404, revoked?.HttpStatus);
            var other = new WebPageShareLink { Id = "other", PasswordHash = stored.PasswordHash, PasswordSalt = stored.PasswordSalt };
            Assert.False(await HostedShareGrant.VerifyAsync(db, other, grant, default));
            var reset = pwd.Hash("synthetic-reset");
            stored.PasswordHash = reset.Hash;
            stored.PasswordSalt = reset.Salt;
            Assert.False(await HostedShareGrant.VerifyAsync(db, stored, grant, default));
            await database.GetCollection<MongoDB.Bson.BsonDocument>("hosted_share_grants").UpdateManyAsync(
                Builders<MongoDB.Bson.BsonDocument>.Filter.Empty,
                Builders<MongoDB.Bson.BsonDocument>.Update.Set("ExpiresAt", DateTime.UtcNow.AddMinutes(-1)));
            Assert.False(await HostedShareGrant.VerifyAsync(db, share, grant, default));
        }
        finally { await client.DropDatabaseAsync(name); }
    }

    private static void Set(object target, string field, object value) => target.GetType()
        .GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(target, value);

    private sealed class CountingPasswords : ISharePasswordService
    {
        private readonly SharePasswordService inner = new();
        public int Verifications;
        public SharePasswordHash Hash(string password) => inner.Hash(password);
        public bool Verify(string password, string hash, string salt)
        { Interlocked.Increment(ref Verifications); return inner.Verify(password, hash, salt); }
        public bool ConstantTimeStringEquals(string a, string b) => inner.ConstantTimeStringEquals(a, b);
        public RateLimitResult CheckRateLimit(IReadOnlyList<DateTime> attempts) => inner.CheckRateLimit(attempts);
    }
}
