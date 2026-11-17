using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Filters;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class PmProjectPermissionTests
{
    [Theory]
    [InlineData("owner", true)]
    [InlineData("leader", true)]
    [InlineData("member", false)]
    [InlineData("observer", false)]
    [InlineData("stakeholder", false)]
    [InlineData("outsider", false)]
    public void ProjectConfigurationIsManagedOnlyByOwnerOrLeader(string role, bool expected)
    {
        var project = new PmProject { OwnerId = "owner", LeaderId = "leader", MemberIds = new() { "member" }, ObserverIds = new() { "observer" }, Stakeholders = new() { new() { UserId = "stakeholder" } } };
        Assert.Equal(expected, PmProjectMembership.CanManage(project, role));
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task RoleFieldMatrix_AtomicDenial_MembershipAndConcurrentWrites()
    {
        var connection = Environment.GetEnvironmentVariable("PM_TEST_MONGO") ?? "mongodb://127.0.0.1:27029";
        var name = "pm_permissions_" + Guid.NewGuid().ToString("N");
        var db = new MongoDbContext(connection, name);
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Services.AddSingleton(db);
        builder.Services.AddScoped<PmAuditActionFilter>();
        builder.Services.AddControllers().AddApplicationPart(typeof(PmAgentController).Assembly).AddControllersAsServices();
        builder.Services.AddTransient(_ => new PmAgentController(db, null!, null!, null!, null!, null!, null!, NullLogger<PmAgentController>.Instance));
        // Test identity only; controller routes, JSON binding, storage and audit filter are real.
        builder.Services.AddAuthorization(o => o.DefaultPolicy = new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder().RequireAssertion(_ => true).Build());
        await using var app = builder.Build();
        app.Use(async (ctx, next) => { ctx.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", ctx.Request.Headers["X-Test-User"].ToString()) }, "test")); await next(); });
        app.UseAuthorization();
        app.MapControllers();
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        var roles = new[] { "owner", "leader", "member", "observer", "stakeholder", "outsider" };
        var fields = new Dictionary<string, object> {
            ["title"] = "changed", ["description"] = "changed", ["businessGoal"] = "changed", ["strategyAlignment"] = "changed",
            ["plannedStartAt"] = "2026-11-17T00:00:00Z", ["plannedEndAt"] = "2026-12-17T00:00:00Z",
            ["budget"] = 123, ["actualCost"] = 45, ["valueCoefficient"] = 2,
            ["wipLimits"] = new Dictionary<string, int> { ["todo"] = 3 }, ["deliverableTypes"] = new[] { "report" },
            ["memberIds"] = new[] { "member", "leader" }, ["lifecycle"] = "closing" };
        Assert.Equal(typeof(UpdatePmProjectRequest).GetProperties().Select(p => p.Name.ToLowerInvariant()).Order(), fields.Keys.Select(p => p.ToLowerInvariant()).Order());
        async Task<HttpResponseMessage> Send(string role, string path, object? body = null) {
            using var req = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Put, path);
            req.Headers.Add("X-Test-User", role);
            if (body != null) req.Content = JsonContent.Create(body);
            return await client.SendAsync(req);
        }
        PmProject NewProject() => new() { OwnerId = "owner", LeaderId = "leader", Title = "original", MemberIds = new() { "member", "leader" }, ObserverIds = new() { "observer" }, Stakeholders = new() { new() { UserId = "stakeholder" } } };
        try {
            await db.Users.InsertManyAsync(roles.Select(r => new User { UserId = r, Username = r, DisplayName = r }));
            foreach (var role in roles) {
                foreach (var field in fields) {
                    var p = NewProject(); await db.PmProjects.InsertOneAsync(p);
                    var before = (await db.PmProjects.Find(x => x.Id == p.Id).SingleAsync()).ToJson();
                    var path = $"/api/pm/projects/{p.Id}";
                    Assert.Equal(role == "outsider" ? HttpStatusCode.NotFound : HttpStatusCode.OK, (await Send(role, path)).StatusCode);
                    var allowed = role is "owner" or "leader";
                    Assert.Equal(allowed ? HttpStatusCode.OK : role == "outsider" ? HttpStatusCode.NotFound : HttpStatusCode.Forbidden,
                        (await Send(role, path, new Dictionary<string, object> { [field.Key] = field.Value })).StatusCode);
                    if (!allowed) {
                        Assert.Equal(before, (await db.PmProjects.Find(x => x.Id == p.Id).SingleAsync()).ToJson());
                        Assert.Equal(0, await db.PmAuditLogs.CountDocumentsAsync(x => x.ProjectId == p.Id));
                    } else {
                        Assert.Equal(1, await db.PmAuditLogs.CountDocumentsAsync(x => x.ProjectId == p.Id));
                        var saved = await db.PmProjects.Find(x => x.Id == p.Id).SingleAsync();
                        var json = System.Text.Json.JsonSerializer.SerializeToElement(saved, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
                        Assert.Equal(System.Text.Json.JsonSerializer.SerializeToElement(field.Value).ToString(), json.GetProperty(field.Key).ToString());
                        if (field.Key == "lifecycle") Assert.NotNull(saved.ClosedAt);
                    }
                }
            }
            foreach (var role in roles.Skip(2)) {
                var p = NewProject(); await db.PmProjects.InsertOneAsync(p);
                var before = (await db.PmProjects.Find(x => x.Id == p.Id).SingleAsync()).ToJson();
                var path = $"/api/pm/projects/{p.Id}";
                foreach (var suffix in new[] { "", "/members", "/observers" }) {
                    var response = await Send(role, path + suffix, suffix == "/observers" ? new { observerIds = new[] { "outsider" } } : (object)fields);
                    Assert.Equal(role == "outsider" ? HttpStatusCode.NotFound : HttpStatusCode.Forbidden, response.StatusCode);
                    Assert.Equal(before, (await db.PmProjects.Find(x => x.Id == p.Id).SingleAsync()).ToJson());
                }
                Assert.Equal(0, await db.PmAuditLogs.CountDocumentsAsync(x => x.ProjectId == p.Id));
            }
            foreach (var entry in new[] { "", "/members" }) {
                var p = NewProject(); await db.PmProjects.InsertOneAsync(p);
                Assert.Equal(HttpStatusCode.OK, (await Send("leader", $"/api/pm/projects/{p.Id}{entry}", new { memberIds = new[] { "observer", "observer", "", "missing" } })).StatusCode);
                var actual = await db.PmProjects.Find(x => x.Id == p.Id).SingleAsync();
                Assert.Equal(new[] { "leader", "observer" }, actual.MemberIds.Order());
                Assert.Empty(actual.ObserverIds);
                Assert.Equal(HttpStatusCode.OK, (await Send("owner", $"/api/pm/projects/{p.Id}/observers", new { observerIds = new[] { "member", "member", "leader", "observer", "missing", "" } })).StatusCode);
                actual = await db.PmProjects.Find(x => x.Id == p.Id).SingleAsync();
                Assert.Equal(new[] { "member" }, actual.ObserverIds);
                var stale = PmProjectMembership.SnapshotFilter(actual, "leader");
                await db.PmProjects.UpdateOneAsync(x => x.Id == p.Id, Builders<PmProject>.Update.Set(x => x.ObserverIds, new List<string> { "outsider" }));
                var refused = await db.PmProjects.UpdateOneAsync(stale, Builders<PmProject>.Update.Set(x => x.Budget, 999));
                Assert.Equal(0, refused.MatchedCount);
            }
            var legacy = NewProject(); await db.PmProjects.InsertOneAsync(legacy);
            await db.PmProjects.UpdateOneAsync(x => x.Id == legacy.Id, Builders<PmProject>.Update.Unset(x => x.ObserverIds).Unset(x => x.MemberIds));
            Assert.Equal(HttpStatusCode.OK, (await Send("leader", $"/api/pm/projects/{legacy.Id}", new { memberIds = new[] { "member" } })).StatusCode);
            await db.PmProjects.UpdateOneAsync(x => x.Id == legacy.Id, Builders<PmProject>.Update.Set(x => x.LeaderId, "outsider"));
            Assert.Equal(0, (await db.PmProjects.UpdateOneAsync(PmProjectMembership.WriteFilter(legacy.Id, "leader"), Builders<PmProject>.Update.Set(x => x.Budget, 999))).MatchedCount);
            await db.PmProjects.UpdateOneAsync(x => x.Id == legacy.Id, Builders<PmProject>.Update.Set(x => x.IsDeleted, true));
            Assert.Equal(0, (await db.PmProjects.UpdateOneAsync(PmProjectMembership.WriteFilter(legacy.Id, "owner"), Builders<PmProject>.Update.Set(x => x.Budget, 999))).MatchedCount);
            Assert.Equal(HttpStatusCode.NotFound, (await Send("owner", $"/api/pm/projects/{legacy.Id}", fields)).StatusCode);
            for (var i = 0; i < 15; i++) {
                var p = NewProject(); await db.PmProjects.InsertOneAsync(p);
                var path = $"/api/pm/projects/{p.Id}";
                var replies = await Task.WhenAll(Send("owner", path, new { budget = 900 }), Send("leader", path, new { actualCost = 120 }), Send("owner", path + (i % 2 == 0 ? "/members" : ""), new { memberIds = new[] { "outsider" } }), Send("leader", path + "/observers", new { observerIds = new[] { "outsider" } }));
                Assert.All(replies, r => Assert.Contains(r.StatusCode, new[] { HttpStatusCode.OK, HttpStatusCode.Conflict }));
                var actual = await db.PmProjects.Find(x => x.Id == p.Id).SingleAsync();
                Assert.Equal(900m, actual.Budget); Assert.Equal(120m, actual.ActualCost);
                Assert.Contains("leader", actual.MemberIds); Assert.Empty(actual.MemberIds.Intersect(actual.ObserverIds));
                Assert.Equal(replies.Take(3).Count(r => r.StatusCode == HttpStatusCode.OK), await db.PmAuditLogs.CountDocumentsAsync(x => x.ProjectId == p.Id));
            }
        } finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }
}
