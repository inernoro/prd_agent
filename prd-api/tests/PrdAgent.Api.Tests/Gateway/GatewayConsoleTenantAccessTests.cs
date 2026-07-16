using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Provisioning;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayConsoleTenantAccessTests
{
    [Fact]
    public async Task TenantProvisioningCompensation_RemovesEveryCatchablePartialStage()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var users = scope.Database.GetCollection<LlmGwUser>("llmgw_console_users");
        var tenants = scope.Database.GetCollection<LlmGwTenant>("llmgw_tenants");
        var teams = scope.Database.GetCollection<LlmGwTeam>("llmgw_teams");
        var memberships = scope.Database.GetCollection<LlmGwMembership>("llmgw_memberships");
        var owner = new LlmGwUser { Id = "owner", Username = "owner", TenantIds = ["home"] };
        await users.InsertOneAsync(owner);

        for (var stage = 1; stage <= 4; stage++)
        {
            var tenantId = $"tenant-stage-{stage}";
            var teamId = $"team-stage-{stage}";
            var membershipId = $"membership-stage-{stage}";
            if (stage >= 1) await tenants.InsertOneAsync(new LlmGwTenant { Id = tenantId, Name = tenantId });
            if (stage >= 2) await teams.InsertOneAsync(new LlmGwTeam { Id = teamId, TenantId = tenantId, Name = teamId });
            if (stage >= 3) await memberships.InsertOneAsync(new LlmGwMembership { Id = membershipId, TenantId = tenantId, UserId = owner.Id, TeamIds = [teamId] });
            if (stage >= 4) await users.UpdateOneAsync(x => x.Id == owner.Id, Builders<LlmGwUser>.Update.AddToSet(x => x.TenantIds, tenantId));

            await ProvisioningCompensation.RollbackTenantCreationAsync(
                users, tenants, teams, memberships, owner.Id, tenantId, teamId, membershipId);

            (await tenants.CountDocumentsAsync(x => x.Id == tenantId)).ShouldBe(0);
            (await teams.CountDocumentsAsync(x => x.TenantId == tenantId)).ShouldBe(0);
            (await memberships.CountDocumentsAsync(x => x.TenantId == tenantId)).ShouldBe(0);
            (await users.Find(x => x.Id == owner.Id).SingleAsync()).TenantIds.ShouldBe(["home"]);
        }
    }

    [Fact]
    public async Task MemberProvisioningCompensation_PreservesConcurrentWinnerDirectory()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var users = scope.Database.GetCollection<LlmGwUser>("llmgw_console_users");
        var memberships = scope.Database.GetCollection<LlmGwMembership>("llmgw_memberships");
        var user = new LlmGwUser { Id = "user-a", Username = "alice", TenantIds = ["tenant-a"] };
        var winner = new LlmGwMembership { Id = "winner", TenantId = "tenant-a", UserId = user.Id };
        await users.InsertOneAsync(user);
        await memberships.InsertOneAsync(winner);

        await ProvisioningCompensation.RollbackMemberCreationAsync(
            users,
            memberships,
            "tenant-a",
            user.Id,
            "loser",
            createdUser: false,
            hadTenantDirectoryEntry: false);

        (await memberships.CountDocumentsAsync(x => x.Id == winner.Id)).ShouldBe(1);
        (await users.Find(x => x.Id == user.Id).SingleAsync()).TenantIds.ShouldContain("tenant-a");
    }

    [Fact]
    public async Task AdversarialMatrix_TwoTenantsTwoTeamsTwoUsersAndTwoKeysPerTeamStayIsolated()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var logs = scope.Database.GetCollection<BsonDocument>("llm_request_logs");
        var keys = scope.Database.GetCollection<BsonDocument>("llmgw_service_keys");
        var callers = scope.Database.GetCollection<BsonDocument>("llmgw_app_callers");
        var memberships = scope.Database.GetCollection<LlmGwMembership>("llmgw_memberships");
        var logDocs = new List<BsonDocument>();
        var keyDocs = new List<BsonDocument>();
        var callerDocs = new List<BsonDocument>();
        var membershipDocs = new List<LlmGwMembership>();
        foreach (var tenantId in new[] { "tenant-a", "tenant-b" })
        {
            foreach (var teamSuffix in new[] { "1", "2" })
            {
                var teamId = $"{tenantId}-team-{teamSuffix}";
                callerDocs.Add(new BsonDocument
                {
                    { "_id", $"caller-{teamId}" }, { "TenantId", tenantId }, { "TeamId", teamId },
                    { "AppCallerCode", $"caller-{teamId}::chat" },
                });
                foreach (var userSuffix in new[] { "1", "2" })
                {
                    membershipDocs.Add(new LlmGwMembership
                    {
                        Id = $"membership-{teamId}-{userSuffix}", TenantId = tenantId,
                        UserId = $"user-{teamId}-{userSuffix}", Role = LlmGwTenantRoles.Developer,
                        TeamIds = [teamId],
                    });
                }
                foreach (var keySuffix in new[] { "1", "2" })
                {
                    var keyId = $"key-{teamId}-{keySuffix}";
                    keyDocs.Add(new BsonDocument
                    {
                        { "_id", keyId }, { "TenantId", tenantId }, { "TeamId", teamId },
                        { "CreatedByUserId", $"user-{teamId}-1" }, { "Enabled", true },
                    });
                    logDocs.Add(new BsonDocument
                    {
                        { "_id", $"log-{teamId}-{keySuffix}" }, { "TenantId", tenantId }, { "TeamId", teamId },
                        { "ServiceKeyId", keyId }, { "Status", "succeeded" },
                    });
                }
            }
        }
        await logs.InsertManyAsync(logDocs);
        await keys.InsertManyAsync(keyDocs);
        await callers.InsertManyAsync(callerDocs);
        await memberships.InsertManyAsync(membershipDocs);

        var developer = CreateHttpContext(LlmGwTenantRoles.Developer, ["tenant-a-team-1"]);
        var owner = CreateHttpContext(LlmGwTenantRoles.Owner, ["tenant-a-team-1"]);
        var developerLogs = await logs.Find(TenantAccess.FilterTeamScope(developer, Builders<BsonDocument>.Filter.Empty)).ToListAsync();
        var developerKeys = await keys.Find(TenantAccess.FilterTeamScope(developer, Builders<BsonDocument>.Filter.Empty)).ToListAsync();
        var ownerLogs = await logs.Find(TenantAccess.FilterTeamScope(owner, Builders<BsonDocument>.Filter.Empty)).ToListAsync();
        var forbiddenDetail = await logs.Find(TenantAccess.FilterTeamScope(
                developer,
                Builders<BsonDocument>.Filter.Eq("_id", "log-tenant-a-team-2-1")))
            .FirstOrDefaultAsync();
        var forbiddenWrite = await callers.UpdateOneAsync(
            TenantAccess.FilterTeamScope(developer, Builders<BsonDocument>.Filter.Eq("_id", "caller-tenant-a-team-2")),
            Builders<BsonDocument>.Update.Set("Status", "disabled"));

        membershipDocs.Count.ShouldBe(8);
        keyDocs.Count.ShouldBe(8);
        developerLogs.Count.ShouldBe(2);
        developerKeys.Count.ShouldBe(2);
        developerLogs.All(x => x["TenantId"] == "tenant-a" && x["TeamId"] == "tenant-a-team-1").ShouldBeTrue();
        ownerLogs.Count.ShouldBe(4);
        ownerLogs.All(x => x["TenantId"] == "tenant-a").ShouldBeTrue();
        forbiddenDetail.ShouldBeNull();
        forbiddenWrite.ModifiedCount.ShouldBe(0);
    }

    [Fact]
    public async Task TeamScopedLogFilter_DeveloperOnlySeesAssignedTeam()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var logs = scope.Database.GetCollection<BsonDocument>("llm_request_logs");
        await logs.InsertManyAsync(
        [
            new BsonDocument { { "_id", "log-a" }, { "TenantId", "tenant-a" }, { "TeamId", "team-a" } },
            new BsonDocument { { "_id", "log-b" }, { "TenantId", "tenant-a" }, { "TeamId", "team-b" } },
            new BsonDocument { { "_id", "log-other" }, { "TenantId", "tenant-b" }, { "TeamId", "team-a" } },
        ]);
        var http = CreateHttpContext(LlmGwTenantRoles.Developer, ["team-a"]);

        var visible = await logs.Find(TenantAccess.FilterTeamScope(
                http,
                Builders<BsonDocument>.Filter.Empty))
            .ToListAsync();

        visible.Select(x => x["_id"].AsString).ShouldBe(["log-a"]);
    }

    [Fact]
    public async Task TeamScopedLogFilter_OwnerSeesAllTeamsInTenantOnly()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var logs = scope.Database.GetCollection<BsonDocument>("llm_request_logs");
        await logs.InsertManyAsync(
        [
            new BsonDocument { { "_id", "log-a" }, { "TenantId", "tenant-a" }, { "TeamId", "team-a" } },
            new BsonDocument { { "_id", "log-b" }, { "TenantId", "tenant-a" }, { "TeamId", "team-b" } },
            new BsonDocument { { "_id", "log-other" }, { "TenantId", "tenant-b" }, { "TeamId", "team-a" } },
        ]);
        var http = CreateHttpContext(LlmGwTenantRoles.Owner, ["team-a"]);

        var visible = await logs.Find(TenantAccess.FilterTeamScope(
                http,
                Builders<BsonDocument>.Filter.Empty))
            .SortBy(x => x["_id"])
            .ToListAsync();

        visible.Select(x => x["_id"].AsString).ShouldBe(["log-a", "log-b"]);
    }

    [Fact]
    public async Task TenantContext_OldSecurityVersionIsRejectedAfterPasswordChange()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var users = scope.Database.GetCollection<LlmGwUser>("llmgw_console_users");
        var memberships = scope.Database.GetCollection<LlmGwMembership>("llmgw_memberships");
        var tenants = scope.Database.GetCollection<LlmGwTenant>("llmgw_tenants");
        var teams = scope.Database.GetCollection<LlmGwTeam>("llmgw_teams");
        var user = new LlmGwUser { Id = "user-a", Username = "alice", SecurityVersion = 2 };
        var membership = new LlmGwMembership
        {
            Id = "membership-a",
            TenantId = "tenant-a",
            UserId = user.Id,
            Role = LlmGwTenantRoles.Developer,
            TeamIds = ["team-a"],
            Version = 1,
        };
        await users.InsertOneAsync(user);
        await memberships.InsertOneAsync(membership);
        await tenants.InsertOneAsync(new LlmGwTenant { Id = "tenant-a", Name = "Tenant A" });
        await teams.InsertOneAsync(new LlmGwTeam { Id = "team-a", TenantId = "tenant-a", Name = "Team A" });

        var oldContext = CreateAuthenticatedHttpContext(user, membership, securityVersion: 1);
        var currentContext = CreateAuthenticatedHttpContext(user, membership, securityVersion: 2);

        (await TenantAccess.ResolveAsync(oldContext, users, memberships, tenants, teams, CancellationToken.None)).ShouldBeNull();
        (await TenantAccess.ResolveAsync(currentContext, users, memberships, tenants, teams, CancellationToken.None)).ShouldNotBeNull();
    }

    [Fact]
    public void Jwt_ContainsUserSecurityVersion()
    {
        var user = new LlmGwUser { Id = "user-a", Username = "alice", SecurityVersion = 7 };
        var tenant = new LlmGwTenant { Id = "tenant-a", Name = "Tenant A" };
        var membership = new LlmGwMembership { Id = "membership-a", TenantId = tenant.Id, UserId = user.Id };
        var jwt = new GwJwt(new string('x', 64), "llmgw-test");

        var (token, _) = jwt.Issue(user, tenant, membership);
        var parsed = new JwtSecurityTokenHandler().ReadJwtToken(token);

        parsed.Claims.Single(x => x.Type == TenantAccess.UserSecurityVersionClaim).Value.ShouldBe("7");
    }

    private static DefaultHttpContext CreateHttpContext(string role, IReadOnlyList<string> teamIds)
    {
        var http = new DefaultHttpContext();
        http.Items[TenantAccess.ItemKey] = new TenantAccessContext(
            "tenant-a",
            "Tenant A",
            false,
            "user-a",
            "alice",
            "membership-a",
            1,
            role,
            teamIds);
        return http;
    }

    private static DefaultHttpContext CreateAuthenticatedHttpContext(
        LlmGwUser user,
        LlmGwMembership membership,
        long securityVersion)
    {
        var http = new DefaultHttpContext();
        http.User = new ClaimsPrincipal(new ClaimsIdentity(
        [
            new Claim(ClaimTypes.NameIdentifier, user.Id),
            new Claim(ClaimTypes.Name, user.Username),
            new Claim(TenantAccess.TenantClaim, membership.TenantId),
            new Claim(TenantAccess.MembershipClaim, membership.Id),
            new Claim(TenantAccess.MembershipVersionClaim, membership.Version.ToString()),
            new Claim(TenantAccess.UserSecurityVersionClaim, securityVersion.ToString()),
        ], "test"));
        return http;
    }

    private static async Task<TestDatabase?> TryCreateDatabaseAsync()
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                               ?? "mongodb://localhost:27017";
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(2);
        var client = new MongoClient(settings);
        try
        {
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            var databaseName = $"llmgw_console_tenant_access_{Guid.NewGuid():N}";
            return new TestDatabase(client, databaseName);
        }
        catch (Exception ex)
        {
            throw new Xunit.Sdk.XunitException($"MongoDB 租户隔离测试依赖不可用：{ex.Message}");
        }
    }

    private sealed class TestDatabase : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        public TestDatabase(MongoClient client, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Database = client.GetDatabase(databaseName);
        }

        public IMongoDatabase Database { get; }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
