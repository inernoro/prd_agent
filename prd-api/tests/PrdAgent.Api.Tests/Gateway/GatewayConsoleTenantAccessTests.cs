using System.IdentityModel.Tokens.Jwt;
using System.Net;
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
    public async Task MapSsoTicket_ConcurrentConsumptionHasExactlyOneWinnerAndRejectsExpiredTicket()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var tickets = scope.Database.GetCollection<BsonDocument>("llmgw_map_sso_tickets");
        var now = DateTime.UtcNow;
        var code = new string('a', 43);
        await tickets.InsertManyAsync([
            new BsonDocument
            {
                { "_id", "valid" },
                { "CodeHash", MapSsoTicketStore.HashCode(code) },
                { "Purpose", MapSsoTicketStore.Purpose },
                { "Audience", MapSsoTicketStore.Audience },
                { "MapRole", "ADMIN" },
                { "State", "issued" },
                { "ExpiresAt", now.AddSeconds(60) },
            },
            new BsonDocument
            {
                { "_id", "expired" },
                { "CodeHash", MapSsoTicketStore.HashCode(new string('b', 43)) },
                { "Purpose", MapSsoTicketStore.Purpose },
                { "Audience", MapSsoTicketStore.Audience },
                { "MapRole", "ADMIN" },
                { "State", "issued" },
                { "ExpiresAt", now.AddSeconds(-1) },
            },
        ]);

        var claims = await Task.WhenAll(Enumerable.Range(0, 8)
            .Select(_ => MapSsoTicketStore.TryClaimAsync(tickets, code, now)));

        claims.Count(x => x is not null).ShouldBe(1);
        (await tickets.Find(Builders<BsonDocument>.Filter.Eq("_id", "valid")).SingleAsync())["State"].AsString.ShouldBe("claimed");
        (await MapSsoTicketStore.TryClaimAsync(tickets, code, now)).ShouldBeNull();
        (await MapSsoTicketStore.TryClaimAsync(tickets, new string('b', 43), now)).ShouldBeNull();
    }

    [Theory]
    [InlineData("https://api.example.com/v1", "passthrough", null)]
    [InlineData("http://api.example.com/v1", "gemini-native", null)]
    [InlineData("wss://openspeech.example.com/asr", "doubao-asr-stream", null)]
    [InlineData("https://openspeech.example.com/asr", "doubao-asr-stream", "必须使用公网 WSS")]
    [InlineData("ws://openspeech.example.com/asr", "doubao-asr-stream", "必须使用公网 WSS")]
    [InlineData("wss://api.example.com/v1", "passthrough", "WSS 仅支持豆包流式语音识别")]
    [InlineData("ws://api.example.com/v1", "passthrough", "其他 Exchange 必须使用 HTTP 或 HTTPS")]
    public void ExternalExchangeTransport_MustMatchTransformer(
        string targetUrl,
        string transformerType,
        string? expectedError)
    {
        var error = GatewayConfigurationProvisioning.ValidateExternalExchangeTransport(targetUrl, transformerType);

        if (expectedError is null)
            error.ShouldBeNull();
        else
            error.ShouldNotBeNull().ShouldContain(expectedError);
    }

    [Theory]
    [InlineData("0.0.0.0")]
    [InlineData("10.0.0.1")]
    [InlineData("100.64.0.1")]
    [InlineData("127.0.0.1")]
    [InlineData("169.254.169.254")]
    [InlineData("172.16.0.1")]
    [InlineData("192.0.0.1")]
    [InlineData("192.0.2.1")]
    [InlineData("192.88.99.1")]
    [InlineData("192.168.0.1")]
    [InlineData("198.18.0.1")]
    [InlineData("198.51.100.1")]
    [InlineData("203.0.113.1")]
    [InlineData("224.0.0.1")]
    [InlineData("64:ff9b::1")]
    [InlineData("64:ff9b:1::1")]
    [InlineData("100::1")]
    [InlineData("100:0:0:1::1")]
    [InlineData("2001::1")]
    [InlineData("2001:db8::1")]
    [InlineData("2002::1")]
    [InlineData("3fff::1")]
    [InlineData("5f00::1")]
    [InlineData("fc00::1")]
    [InlineData("fe80::1")]
    [InlineData("ff00::1")]
    public void ExternalExchangeAddress_RejectsPrivateAndSpecialUseRanges(string rawAddress)
    {
        GatewayConfigurationProvisioning.IsSafeExternalExchangeAddress(IPAddress.Parse(rawAddress)).ShouldBeFalse();
    }

    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("1.1.1.1")]
    [InlineData("192.0.0.9")]
    [InlineData("192.0.0.10")]
    [InlineData("192.31.196.1")]
    [InlineData("192.52.193.1")]
    [InlineData("192.175.48.1")]
    [InlineData("2001:1::1")]
    [InlineData("2001:3::1")]
    [InlineData("2001:4:112::1")]
    [InlineData("2001:20::1")]
    [InlineData("2001:30::1")]
    [InlineData("2606:4700:4700::1111")]
    public void ExternalExchangeAddress_AllowsPublicAddresses(string rawAddress)
    {
        GatewayConfigurationProvisioning.IsSafeExternalExchangeAddress(IPAddress.Parse(rawAddress)).ShouldBeTrue();
    }

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
    public async Task HardExitRepairer_RollsBackExpiredTenantAndMemberProvisioningByExactIds()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var users = scope.Database.GetCollection<LlmGwUser>("llmgw_console_users");
        var tenants = scope.Database.GetCollection<LlmGwTenant>("llmgw_tenants");
        var teams = scope.Database.GetCollection<LlmGwTeam>("llmgw_teams");
        var memberships = scope.Database.GetCollection<LlmGwMembership>("llmgw_memberships");
        var operations = scope.Database.GetCollection<GatewayRecoveryOperation>("llmgw_recovery_operations");
        var owner = new LlmGwUser { Id = "owner", Username = "owner", TenantIds = ["home", "tenant-crashed"] };
        var tenantMembership = new LlmGwMembership
        {
            Id = "owner-crashed",
            TenantId = "tenant-crashed",
            UserId = owner.Id,
            Role = LlmGwTenantRoles.Owner,
        };
        await users.InsertOneAsync(owner);
        await tenants.InsertManyAsync([
            new LlmGwTenant
            {
                Id = "tenant-crashed",
                Name = "Crashed",
                OwnerAuthorityInitialized = true,
                ActiveOwnerMembershipIds = [tenantMembership.Id],
                OwnerFenceGeneration = 1,
            },
            new LlmGwTenant
            {
                Id = "tenant-stable",
                Name = "Stable",
                OwnerAuthorityInitialized = true,
                ActiveOwnerMembershipIds = ["stable-owner", "member-crashed"],
                OwnerFenceGeneration = 2,
            },
        ]);
        await teams.InsertOneAsync(new LlmGwTeam { Id = "team-crashed", TenantId = "tenant-crashed", Name = "Default" });
        await memberships.InsertManyAsync([
            tenantMembership,
            new LlmGwMembership { Id = "stable-owner", TenantId = "tenant-stable", UserId = "stable-user", Role = LlmGwTenantRoles.Owner },
            new LlmGwMembership { Id = "member-crashed", TenantId = "tenant-stable", UserId = "member-user", Role = LlmGwTenantRoles.Owner },
        ]);
        await users.InsertOneAsync(new LlmGwUser { Id = "member-user", Username = "member-user", TenantIds = ["tenant-stable"] });
        await operations.InsertManyAsync([
            new GatewayRecoveryOperation
            {
                Id = "op-tenant",
                Kind = GatewayRecoveryKinds.TenantCreate,
                TenantId = "tenant-crashed",
                UserId = owner.Id,
                TeamId = "team-crashed",
                MembershipId = tenantMembership.Id,
                LeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1),
            },
            new GatewayRecoveryOperation
            {
                Id = "op-member",
                Kind = GatewayRecoveryKinds.MemberCreate,
                Status = "repairing",
                TenantId = "tenant-stable",
                UserId = "member-user",
                MembershipId = "member-crashed",
                RepairToken = "crashed-repairer",
                RepairGeneration = 1,
                LeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1),
            },
        ]);

        (await GatewayRecoveryOperations.RepairExpiredAsync(scope.Database)).ShouldBe(2);

        (await tenants.CountDocumentsAsync(x => x.Id == "tenant-crashed")).ShouldBe(0);
        (await teams.CountDocumentsAsync(x => x.TenantId == "tenant-crashed")).ShouldBe(0);
        (await memberships.CountDocumentsAsync(x => x.Id == tenantMembership.Id || x.Id == "member-crashed")).ShouldBe(0);
        (await users.CountDocumentsAsync(x => x.Id == "member-user")).ShouldBe(0);
        (await users.Find(x => x.Id == owner.Id).SingleAsync()).TenantIds.ShouldBe(["home"]);
        (await tenants.Find(x => x.Id == "tenant-stable").SingleAsync()).ActiveOwnerMembershipIds.ShouldBe(["stable-owner"]);
        (await operations.CountDocumentsAsync(x => x.Status == "repaired")).ShouldBe(2);
        var reclaimedMemberOperation = await operations.Find(x => x.Id == "op-member").SingleAsync();
        reclaimedMemberOperation.RepairGeneration.ShouldBe(2);
        reclaimedMemberOperation.RepairToken.ShouldNotBe("crashed-repairer");
    }

    [Fact]
    public async Task Repairer_StaleGenerationCannotApplyBusinessWritesAfterTakeover()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var users = scope.Database.GetCollection<LlmGwUser>("llmgw_console_users");
        var tenants = scope.Database.GetCollection<LlmGwTenant>("llmgw_tenants");
        var memberships = scope.Database.GetCollection<LlmGwMembership>("llmgw_memberships");
        var operations = scope.Database.GetCollection<GatewayRecoveryOperation>("llmgw_recovery_operations");
        var member = new LlmGwMembership
        {
            Id = "member-protected-by-new-generation",
            TenantId = "tenant-a",
            UserId = "user-a",
            Role = LlmGwTenantRoles.Owner,
        };
        await users.InsertOneAsync(new LlmGwUser
        {
            Id = member.UserId,
            Username = member.UserId,
            TenantIds = [member.TenantId],
        });
        await tenants.InsertOneAsync(new LlmGwTenant
        {
            Id = member.TenantId,
            Name = "Tenant A",
            OwnerAuthorityInitialized = true,
            ActiveOwnerMembershipIds = [member.Id],
            OwnerFenceGeneration = 2,
        });
        await memberships.InsertOneAsync(member);
        await operations.InsertOneAsync(new GatewayRecoveryOperation
        {
            Id = "op-member-stale",
            Kind = GatewayRecoveryKinds.MemberCreate,
            Status = "repairing",
            TenantId = member.TenantId,
            UserId = member.UserId,
            MembershipId = member.Id,
            RepairToken = "new-repairer",
            RepairGeneration = 2,
            LeaseExpiresAt = DateTime.UtcNow.AddMinutes(2),
        });
        var staleClaim = new GatewayRecoveryOperation
        {
            Id = "op-member-stale",
            Kind = GatewayRecoveryKinds.MemberCreate,
            Status = "repairing",
            TenantId = member.TenantId,
            UserId = member.UserId,
            MembershipId = member.Id,
            RepairToken = "old-repairer",
            RepairGeneration = 1,
            LeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1),
        };

        var repairClaimed = typeof(GatewayRecoveryOperations).GetMethod(
            "RepairClaimedAsync",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
        repairClaimed.ShouldNotBeNull();
        var repairTask = repairClaimed.Invoke(
            null,
            [scope.Database, staleClaim, "old-repairer"]) as Task<string>;
        Assert.NotNull(repairTask);
        var detail = await repairTask!;

        detail.ShouldBe("repair-lease-lost");
        (await memberships.CountDocumentsAsync(x => x.Id == member.Id)).ShouldBe(1);
        (await users.CountDocumentsAsync(x => x.Id == member.UserId)).ShouldBe(1);
        (await tenants.Find(x => x.Id == member.TenantId).SingleAsync())
            .ActiveOwnerMembershipIds.ShouldBe([member.Id]);
    }

    [Fact]
    public async Task HardExitRepairer_DoesNotClaimProvisioningWhileLiveRequestRenewsLease()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var tenants = scope.Database.GetCollection<LlmGwTenant>("llmgw_tenants");
        var operations = scope.Database.GetCollection<GatewayRecoveryOperation>("llmgw_recovery_operations");
        await tenants.InsertOneAsync(new LlmGwTenant
        {
            Id = "tenant-live",
            Name = "Live",
            OwnerAuthorityInitialized = true,
            ActiveOwnerMembershipIds = ["owner-live"],
            OwnerFenceGeneration = 1,
        });
        await operations.InsertOneAsync(new GatewayRecoveryOperation
        {
            Id = "op-live",
            Kind = GatewayRecoveryKinds.TenantCreate,
            TenantId = "tenant-live",
            MembershipId = "owner-live",
            LeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1),
        });

        await using (await GatewayRecoveryOperations.StartHeartbeatAsync(
                         operations,
                         "op-live",
                         TimeSpan.FromMilliseconds(20)))
        {
            await operations.UpdateOneAsync(
                x => x.Id == "op-live",
                Builders<GatewayRecoveryOperation>.Update.Set(x => x.LeaseExpiresAt, DateTime.UtcNow.AddSeconds(-1)));
            GatewayRecoveryOperation? active = null;
            for (var attempt = 0; attempt < 100; attempt++)
            {
                active = await operations.Find(x => x.Id == "op-live").SingleAsync();
                if (active.LeaseExpiresAt > DateTime.UtcNow.AddMinutes(1)) break;
                await Task.Delay(20);
            }
            (await GatewayRecoveryOperations.RepairExpiredAsync(scope.Database)).ShouldBe(0);
            active.ShouldNotBeNull();
            active.Status.ShouldBe("pending");
            active.LeaseExpiresAt.ShouldBeGreaterThan(DateTime.UtcNow.AddMinutes(1));
            (await tenants.CountDocumentsAsync(x => x.Id == "tenant-live")).ShouldBe(1);
        }

        await operations.UpdateOneAsync(
            x => x.Id == "op-live",
            Builders<GatewayRecoveryOperation>.Update.Set(x => x.LeaseExpiresAt, DateTime.UtcNow.AddSeconds(-1)));
        (await GatewayRecoveryOperations.RepairExpiredAsync(scope.Database)).ShouldBe(1);
        (await tenants.CountDocumentsAsync(x => x.Id == "tenant-live")).ShouldBe(0);
    }

    [Fact]
    public async Task OwnerAuthority_ConcurrentRemovalsAtomicallyPreserveOneOwner()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var tenants = scope.Database.GetCollection<LlmGwTenant>("llmgw_tenants");
        await tenants.InsertOneAsync(new LlmGwTenant
        {
            Id = "tenant-a",
            Name = "Tenant A",
            OwnerAuthorityInitialized = true,
            ActiveOwnerMembershipIds = ["owner-a", "owner-b"],
            OwnerFenceGeneration = 7,
        });

        var decisions = await Task.WhenAll(
            TenantOwnerAuthority.TryRemoveAsync(tenants, "tenant-a", "owner-a"),
            TenantOwnerAuthority.TryRemoveAsync(tenants, "tenant-a", "owner-b"));

        decisions.Count(x => x.Result == OwnerRemovalResult.Removed).ShouldBe(1);
        decisions.Count(x => x.Result == OwnerRemovalResult.LastOwner).ShouldBe(1);
        var tenant = await tenants.Find(x => x.Id == "tenant-a").SingleAsync();
        tenant.ActiveOwnerMembershipIds.Count.ShouldBe(1);
        tenant.OwnerFenceGeneration.ShouldBe(8);
    }

    [Fact]
    public async Task OwnerMutationRepairer_CompletesHardExitAfterAuthoritativeRemovalAndPromotion()
    {
        var database = await TryCreateDatabaseAsync();
        if (database is null) return;
        await using var scope = database;
        var tenants = scope.Database.GetCollection<LlmGwTenant>("llmgw_tenants");
        var memberships = scope.Database.GetCollection<LlmGwMembership>("llmgw_memberships");
        var operations = scope.Database.GetCollection<GatewayRecoveryOperation>("llmgw_recovery_operations");
        await tenants.InsertOneAsync(new LlmGwTenant
        {
            Id = "tenant-a",
            Name = "Tenant A",
            OwnerAuthorityInitialized = true,
            ActiveOwnerMembershipIds = ["owner-a", "owner-b"],
            OwnerFenceGeneration = 3,
        });
        await memberships.InsertManyAsync([
            new LlmGwMembership { Id = "owner-a", TenantId = "tenant-a", UserId = "user-a", Role = LlmGwTenantRoles.Owner, Version = 1 },
            new LlmGwMembership { Id = "owner-b", TenantId = "tenant-a", UserId = "user-b", Role = LlmGwTenantRoles.Owner, Version = 1 },
            new LlmGwMembership { Id = "admin-c", TenantId = "tenant-a", UserId = "user-c", Role = LlmGwTenantRoles.Admin, Version = 1 },
        ]);
        (await TenantOwnerAuthority.TryRemoveAsync(tenants, "tenant-a", "owner-a")).Result.ShouldBe(OwnerRemovalResult.Removed);
        await memberships.UpdateOneAsync(
            x => x.Id == "admin-c",
            Builders<LlmGwMembership>.Update.Set(x => x.Role, LlmGwTenantRoles.Owner).Set(x => x.Version, 2));
        await operations.InsertManyAsync([
            new GatewayRecoveryOperation
            {
                Id = "op-remove",
                Kind = GatewayRecoveryKinds.OwnerMutation,
                TenantId = "tenant-a",
                MembershipId = "owner-a",
                ExpectedMembershipVersion = 1,
                TargetRole = LlmGwTenantRoles.Admin,
                TargetStatus = "active",
                LeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1),
            },
            new GatewayRecoveryOperation
            {
                Id = "op-add",
                Kind = GatewayRecoveryKinds.OwnerMutation,
                TenantId = "tenant-a",
                MembershipId = "admin-c",
                ExpectedMembershipVersion = 1,
                TargetRole = LlmGwTenantRoles.Owner,
                TargetStatus = "active",
                LeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1),
            },
        ]);

        (await GatewayRecoveryOperations.RepairExpiredAsync(scope.Database)).ShouldBe(2);

        (await memberships.Find(x => x.Id == "owner-a").SingleAsync()).Role.ShouldBe(LlmGwTenantRoles.Admin);
        var tenant = await tenants.Find(x => x.Id == "tenant-a").SingleAsync();
        tenant.ActiveOwnerMembershipIds.OrderBy(x => x).ShouldBe(["admin-c", "owner-b"]);
        (await operations.CountDocumentsAsync(x => x.Status == "repaired")).ShouldBe(2);
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

    [Fact]
    public void MapSsoJwt_ContainsIdentityProviderAndUsesRequestedShortLifetime()
    {
        var user = new LlmGwUser
        {
            Id = "map-user-a",
            Username = "map-user-a",
            IdentityProvider = "map",
            SecurityVersion = 2,
        };
        var tenant = new LlmGwTenant { Id = "internal", Name = "Internal" };
        var membership = new LlmGwMembership
        {
            Id = "membership-a",
            TenantId = tenant.Id,
            UserId = user.Id,
            Role = LlmGwTenantRoles.Admin,
        };
        var jwt = new GwJwt(new string('x', 64), "llmgw-test");

        var (token, expiresAt) = jwt.Issue(user, tenant, membership, TimeSpan.FromMinutes(15));
        var parsed = new JwtSecurityTokenHandler().ReadJwtToken(token);

        parsed.Claims.Single(x => x.Type == "identity_provider").Value.ShouldBe("map");
        (expiresAt - DateTime.UtcNow).ShouldBeInRange(TimeSpan.FromMinutes(14), TimeSpan.FromMinutes(16));
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
