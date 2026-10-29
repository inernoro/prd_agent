using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Governance;
using PrdAgent.LlmGw.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 真 Mongo + 生产 serving 端点/密钥门与控制台授权。仅使用本地隔离数据库和计数上游，零收费调用。
/// 必须显式设置 MONGODB_TEST_CONNECTION；连不上则测试失败，禁止把未执行冒充通过。
/// </summary>
[Trait("Category", "Integration")]
public sealed class GatewayMinimumProtectionIntegrationTests
{
    private const string InternalKey = "phase0-local-internal-key";
    private const string Tenant = "tenant_map_internal";
    private const string Caller = "future-business.omitted-protection::chat";
    private static readonly string ManualPermitId = Guid.NewGuid().ToString("N");
    private static readonly string AutomaticPermitId = Guid.NewGuid().ToString("N");

    [Fact]
    public async Task MissingPoliciesAreBoundedAcrossTwoServingInstancesBeforeUpstream()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant);
        await using var first = await Serving(database, new() { ["AppCallerPerHour"] = 5 });
        await using var second = await Serving(database, new() { ["AppCallerPerHour"] = 5 });
        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(i =>
            Send((i % 2 == 0 ? first : second).GetTestClient(), automatic: false)));

        responses.Count(r => r.StatusCode == HttpStatusCode.OK).ShouldBe(5);
        responses.Count(r => r.StatusCode == HttpStatusCode.TooManyRequests).ShouldBe(15);
        database.UpstreamCalls.ShouldBe(5);
        var blocked = responses.First(r => r.StatusCode == HttpStatusCode.TooManyRequests);
        (await blocked.Content.ReadAsStringAsync()).ShouldContain("GATEWAY_SAFETY_LIMITED");
        blocked.Headers.GetValues("X-LLMGW-Safety-Window-Seconds").Single().ShouldBe("3600");
        var warnings = await database.Alerts.Find(new BsonDocument { { "Kind", "warning" } }).ToListAsync();
        warnings.Count.ShouldBe(1);
        warnings[0]["Count"].ToInt64().ShouldBe(5);
        var denials = await database.Alerts.Find(new BsonDocument { { "Kind", "blocked" } }).ToListAsync();
        denials.Count.ShouldBe(1);
        denials[0]["Count"].ToInt64().ShouldBe(20);
    }

    [Fact]
    public async Task DynamicExplicitRateObservationUsesSameGeneralBucketAsFixedProtection()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await SeedDynamicHistory(database);
        var coordinator = new GatewayMinimumProtectionCoordinator(database.Data,
            new ConfigurationBuilder().AddInMemoryCollection(DynamicPolicy()).Build(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<GatewayMinimumProtectionCoordinator>.Instance);
        for (var index = 0; index < 6; index++)
            (await coordinator.CheckAsync(Tenant, Caller, "chat", null, Guid.NewGuid().ToString("N"),
                new GatewayMinimumRequestIdentity("interactive", null), 1000, 100, default)).Rejected.ShouldBeFalse();
        var alert = await database.Alerts.Find(new BsonDocument("Metric", "request_rate_baseline")).SingleAsync();
        alert["Origin"].AsString.ShouldBe("general");
        alert["Count"].ToInt64().ShouldBe(6);
        alert["BaselineAverage"].ToDecimal().ShouldBe(2m);
        (await database.Windows.CountDocumentsAsync(new BsonDocument("Origin", "interactive"))).ShouldBe(0);
    }

    [Theory]
    [InlineData(false, "TenantPerHour")]
    [InlineData(true, "AutomaticTenantPerHour")]
    public async Task TenantLimitsAggregateDifferentBusinessCallers(bool automatic, string limitName)
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await using var app = await Serving(database, new() { [limitName] = 2 });
        var client = app.GetTestClient();
        (await Send(client, automatic, caller: "future-business.first::chat")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Send(client, automatic, caller: "future-business.second::chat")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var blocked = await Send(client, automatic, caller: "future-business.third::chat");
        blocked.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        blocked.Headers.GetValues("X-LLMGW-Safety-Scope").Single().ShouldBe("tenant");
        database.UpstreamCalls.ShouldBe(2);
    }

    [Fact]
    public async Task AlertWriteFailureCannotReleaseCounterOrHardLimit()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.Data.Database.CreateCollectionAsync(GatewayMinimumProtectionCoordinator.AlertsCollection,
            new CreateCollectionOptions<BsonDocument>
            {
                Validator = new BsonDocument("$jsonSchema", new BsonDocument("required", new BsonArray { "test-only-required-field" })),
            });
        await database.AddCallerAsync(Tenant);
        await using var app = await Serving(database, new() { ["AppCallerPerHour"] = 1 });
        (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        database.UpstreamCalls.ShouldBe(1);
        (await database.Alerts.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(0);
        var counter = await database.Windows.Find(new BsonDocument
        {
            { "Origin", "general" }, { "Scope", "app-caller" }, { "WindowSeconds", 3600 },
        }).SingleAsync();
        counter["Count"].ToInt64().ShouldBe(2);
    }

    [Fact]
    public async Task RejectedAutomaticRetriesCannotExhaustNormalUserQuota()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant);
        await using var app = await Serving(database, new()
        {
            ["AutomaticAppCallerPerHour"] = 1,
            ["AppCallerPerHour"] = 2,
        });
        var client = app.GetTestClient();
        (await Send(client, true)).StatusCode.ShouldBe(HttpStatusCode.OK);
        for (var i = 0; i < 20; i++)
            (await Send(client, true)).StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        (await Send(client, false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        database.UpstreamCalls.ShouldBe(2);
        var counter = await database.Windows.Find(new BsonDocument
        {
            { "Origin", "general" }, { "Scope", "app-caller" }, { "WindowSeconds", 3600 },
        }).SingleAsync();
        counter["Count"].ToInt64().ShouldBe(1, "自动调用与被 automatic 闸拒绝的重试不能占用人工操作额度");
    }

    [Fact]
    public async Task SuccessfulAutomaticRequestCannotConsumeLastNormalUserFallbackAdmission()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant);
        await using var app = await Serving(database, new() { ["AppCallerPerHour"] = 2, ["TenantPerHour"] = 2 });
        var client = app.GetTestClient();
        (await Send(client, false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Send(client, true)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Send(client, false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        database.UpstreamCalls.ShouldBe(3);
        var counter = await database.Windows.Find(new BsonDocument
        {
            { "Origin", "general" }, { "Scope", "app-caller" }, { "WindowSeconds", 3600 },
        }).SingleAsync();
        counter["Count"].ToInt64().ShouldBe(2, "一般基线的最后一次准入必须留给正常用户，自动成功调用只占 automatic 窗口");
    }

    [Theory]
    [InlineData("AutomaticAppCallerPerMinute", 60)]
    [InlineData("AutomaticAppCallerPerHour", 3600)]
    [InlineData("AutomaticAppCallerPerDay", 86400)]
    public async Task AutomaticLimitsSurviveRestartAndRevisionChangeWhileManualRequestStillWorks(string limitName, int seconds)
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant);
        var limits = new Dictionary<string, int> { [limitName] = 2 };
        await using (var first = await Serving(database, limits))
        {
            (await Send(first.GetTestClient(), true, deployment: "revision-one")).StatusCode.ShouldBe(HttpStatusCode.OK);
            (await Send(first.GetTestClient(), true, deployment: "revision-two")).StatusCode.ShouldBe(HttpStatusCode.OK);
        }
        await using var restarted = await Serving(database, limits);
        var blocked = await Send(restarted.GetTestClient(), true, deployment: "revision-three");
        blocked.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        blocked.Headers.GetValues("X-LLMGW-Safety-Window-Seconds").Single().ShouldBe(seconds.ToString());
        (await blocked.Content.ReadAsStringAsync()).ShouldContain("AUTOMATIC_CONSUMPTION_LIMITED");
        (await Send(restarted.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        database.UpstreamCalls.ShouldBe(3);
        var automatic = await database.Windows.Find(new BsonDocument
        {
            { "Origin", "automatic" }, { "Scope", "app-caller" }, { "WindowSeconds", seconds },
        }).SingleAsync();
        automatic["Count"].ToInt64().ShouldBe(3, "普通用户请求不能消耗 automatic 窗口");
    }

    [Fact]
    public async Task ExternalCredentialCannotBorrowInteractiveQuotaEvenAtMapNativeIngress()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        const string externalTenant = "tenant-external";
        const string externalKey = "phase0-local-external-key";
        await database.AddCallerAsync(externalTenant);
        await database.Data.Database.GetCollection<LlmGwTenant>("llmgw_tenants")
            .InsertOneAsync(new LlmGwTenant { Id = externalTenant, Name = "External" });
        var record = new GatewayServiceKeyRecord
        {
            TenantId = externalTenant, KeyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(externalKey))).ToLowerInvariant(),
            KeyPrefix = "local-external", SourceSystem = "map", ClientCode = "external-client", Environment = "test", Purpose = "runtime",
            AppCallerCodes = [Caller], IngressProtocols = ["gw-native"], Scopes = ["invoke"],
        };
        await database.Data.Database.GetCollection<GatewayServiceKeyRecord>("llmgw_service_keys").InsertOneAsync(record);
        await database.Data.Database.GetCollection<GatewayServiceKeyDirectoryRecord>("llmgw_service_key_directory")
            .InsertOneAsync(new GatewayServiceKeyDirectoryRecord { TenantId = externalTenant, KeyHash = record.KeyHash, ServiceKeyId = record.Id });
        await using var app = await Serving(database, new() { ["AutomaticAppCallerPerHour"] = 1 });
        (await Send(app.GetTestClient(), true, key: externalKey)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Send(app.GetTestClient(), true, key: externalKey)).StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        (await database.Windows.CountDocumentsAsync(new BsonDocument { { "Origin", "general" } })).ShouldBe(0);
        database.UpstreamCalls.ShouldBe(1);
    }

    [Fact]
    public async Task PositiveConfiguredLimitsRemainAuthoritativeAndProduceDurableAlerts()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant, rate: 2);
        await database.Data.Database.GetCollection<GatewayTenantGovernanceRecord>("llmgw_tenants")
            .InsertOneAsync(new GatewayTenantGovernanceRecord { Id = Tenant, RateLimitPerMinute = 100 });
        await using var app = await Serving(database, new() { ["AppCallerPerMinute"] = 1, ["AppCallerPerHour"] = 1, ["AppCallerPerDay"] = 1 });
        (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var denied = await Send(app.GetTestClient(), false);
        denied.StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        (await denied.Content.ReadAsStringAsync()).ShouldContain("APP_CALLER_RATE_LIMITED");
        (await database.Windows.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(0,
            "已明确配置普通限额时不覆盖其授权，automatic 仍会额外受保护");
        (await database.Alerts.CountDocumentsAsync(new BsonDocument { { "Kind", "warning" } })).ShouldBe(1);
        (await database.Alerts.CountDocumentsAsync(new BsonDocument { { "Kind", "blocked" } })).ShouldBe(1);
    }

    [Fact]
    public async Task WarningIsReadableOnlyThroughAuthenticatedTenantAndTeamScope()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant);
        await using var serving = await Serving(database, new() { ["AppCallerPerHour"] = 2 });
        (await Send(serving.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Send(serving.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var warning = await database.Alerts.Find(new BsonDocument { { "Kind", "warning" } }).SingleAsync();
        warning.Contains("QuestionText").ShouldBeFalse();
        warning.Contains("ApiKey").ShouldBeFalse();
        await using var console = await Console(database);
        var client = console.GetTestClient();
        (await client.GetAsync("/gw/logs/consumption-alerts")).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await database.TokenAsync(Tenant, "admin"));
        var response = await client.GetAsync("/gw/logs/consumption-alerts?TenantId=other-tenant");
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.Content.ReadAsStringAsync()).ShouldContain(warning["_id"].AsString);

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await database.TokenAsync("other-tenant", "admin"));
        (await (await client.GetAsync("/gw/logs/consumption-alerts")).Content.ReadAsStringAsync()).ShouldNotContain(warning["_id"].AsString);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await database.TokenAsync(Tenant, "viewer", "team-other"));
        (await (await client.GetAsync("/gw/logs/consumption-alerts")).Content.ReadAsStringAsync()).ShouldNotContain(warning["_id"].AsString);
        await database.Alerts.UpdateOneAsync(new BsonDocument { { "_id", warning["_id"] } }, new BsonDocument("$set", new BsonDocument("TeamId", "team-other")));
        (await (await client.GetAsync("/gw/logs/consumption-alerts")).Content.ReadAsStringAsync()).ShouldContain(warning["_id"].AsString);
    }

    [Fact]
    public async Task DynamicBaselineDetectsSharedSpikeWithoutWeakeningFixedLimit()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant);
        await SeedDynamicHistory(database);
        var policy = DynamicPolicy();
        await using var first = await Serving(database, new() { ["AppCallerPerHour"] = 8 }, policy);
        await using var second = await Serving(database, new() { ["AppCallerPerHour"] = 8 }, policy);
        var responses = await Task.WhenAll(Enumerable.Range(0, 10).Select(i =>
            Send((i % 2 == 0 ? first : second).GetTestClient(), false)));
        responses.Count(item => item.StatusCode == HttpStatusCode.OK).ShouldBe(8);
        responses.Count(item => item.StatusCode == HttpStatusCode.TooManyRequests).ShouldBe(2);
        database.UpstreamCalls.ShouldBe(8);
        var dynamicAlert = await database.Alerts.Find(new BsonDocument("Metric", "request_rate_baseline")).SingleAsync();
        dynamicAlert["Count"].ToInt64().ShouldBe(10);
        dynamicAlert["Limit"].ToInt32().ShouldBe(6);
        dynamicAlert["ThresholdPercent"].ToInt32().ShouldBe(100, "动态触发线本身已由倍数与最低量确定");
        dynamicAlert["BaselineAverage"].ToDecimal().ShouldBe(2m);
        dynamicAlert["BaselineSamples"].ToInt32().ShouldBe(3);
        dynamicAlert["Kind"].AsString.ShouldBe("warning", "动态检测只预警，固定限制仍是拒绝依据");
        dynamicAlert["Origin"].AsString.ShouldBe("general");
        (await database.Alerts.CountDocumentsAsync(new BsonDocument("Kind", "blocked"))).ShouldBe(1);
        await using var console = await Console(database);
        var client = console.GetTestClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await database.TokenAsync(Tenant, "admin"));
        var readable = await client.GetAsync("/gw/logs/consumption-alerts");
        (await readable.Content.ReadAsStringAsync()).ShouldContain("request_rate_baseline");
    }

    [Fact]
    public async Task DynamicBaselineAlsoObservesExplicitRatePoliciesAndNeverUsesCurrentOrForeignWindows()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant, rate: 100);
        await database.Data.Database.GetCollection<GatewayTenantGovernanceRecord>("llmgw_tenants")
            .InsertOneAsync(new GatewayTenantGovernanceRecord { Id = Tenant, RateLimitPerMinute = 1000 });
        await SeedDynamicHistory(database);
        await using var app = await Serving(database, new(), DynamicPolicy());
        for (var index = 0; index < 6; index++)
            (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var alert = await database.Alerts.Find(new BsonDocument("Metric", "request_rate_baseline")).SingleAsync();
        alert["Count"].ToInt64().ShouldBe(6);
        alert["BaselineAverage"].ToDecimal().ShouldBe(2m);
        database.UpstreamCalls.ShouldBe(6);
    }

    [Theory]
    [InlineData("Multiplier", "1")]
    [InlineData("Multiplier", "")]
    [InlineData("MinimumSamples", "99")]
    [InlineData("Enabled", "false")]
    public async Task MissingOrInvalidDynamicPolicyCannotChangeFixedProtection(string field, string value)
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant);
        await SeedDynamicHistory(database);
        var policy = DynamicPolicy();
        policy["LlmGateway:MinimumProtection:DynamicRateBaseline:" + field] = value;
        await using var app = await Serving(database, new() { ["AppCallerPerHour"] = 1 }, policy);
        (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        database.UpstreamCalls.ShouldBe(1);
        (await database.Alerts.CountDocumentsAsync(new BsonDocument("Metric", "request_rate_baseline"))).ShouldBe(0);
    }

    [Fact]
    public async Task DynamicColdStartAndAlertFailureDoNotRelaxFixedLimit()
    {
        await using var database = await DiagnosticDatabase.CreateAsync();
        await database.AddCallerAsync(Tenant);
        await database.Data.Database.CreateCollectionAsync(GatewayMinimumProtectionCoordinator.AlertsCollection,
            new CreateCollectionOptions<BsonDocument>
            {
                Validator = new BsonDocument("$jsonSchema", new BsonDocument("required", new BsonArray { "test-only-required-field" })),
            });
        await using var app = await Serving(database, new() { ["AppCallerPerHour"] = 8 }, DynamicPolicy());
        for (var index = 0; index < 6; index++)
            (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await database.Alerts.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(0);
        await SeedDynamicHistory(database);
        for (var index = 0; index < 2; index++)
            (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Send(app.GetTestClient(), false)).StatusCode.ShouldBe(HttpStatusCode.TooManyRequests);
        database.UpstreamCalls.ShouldBe(8);
        (await database.Alerts.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(0);
    }

    private static Dictionary<string, string?> DynamicPolicy() => new()
    {
        ["LlmGateway:MinimumProtection:DynamicRateBaseline:Enabled"] = "true",
        ["LlmGateway:MinimumProtection:DynamicRateBaseline:WindowSeconds"] = "3600",
        ["LlmGateway:MinimumProtection:DynamicRateBaseline:SampleWindows"] = "4",
        ["LlmGateway:MinimumProtection:DynamicRateBaseline:MinimumSamples"] = "3",
        ["LlmGateway:MinimumProtection:DynamicRateBaseline:Multiplier"] = "2",
        ["LlmGateway:MinimumProtection:DynamicRateBaseline:MinimumCount"] = "6",
    };

    private static async Task SeedDynamicHistory(DiagnosticDatabase database)
    {
        var now = DateTime.UtcNow;
        var current = new DateTime(now.Ticks - now.Ticks % TimeSpan.TicksPerHour, DateTimeKind.Utc);
        BsonDocument Window(DateTime start, long count, string tenant = Tenant, string origin = "general") => new()
        {
            ["_id"] = Guid.NewGuid().ToString("N"), ["TenantId"] = tenant, ["AppCallerCode"] = Caller,
            ["RequestType"] = "chat", ["Scope"] = "app-caller", ["Origin"] = origin,
            ["WindowSeconds"] = 3600, ["WindowStart"] = start, ["Count"] = count, ["ExpiresAt"] = now.AddDays(1),
        };
        await database.Windows.InsertManyAsync(new[]
        {
            Window(current.AddHours(-1), 2), Window(current.AddHours(-2), 2), Window(current.AddHours(-3), 2),
            Window(current, 10000), Window(current.AddHours(1), 10000), Window(current.AddHours(-5), 10000),
            Window(current.AddHours(-1), 10000, "foreign-tenant"), Window(current.AddHours(-1), 10000, origin: "automatic"),
        });
    }

    private static async Task<HttpResponseMessage> Send(HttpClient client, bool automatic, string deployment = "local-revision", string key = InternalKey, string caller = Caller)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/send")
        {
            Content = JsonContent.Create(new GatewayRequest
            {
                AppCallerCode = caller, ModelType = "chat",
                Context = new GatewayRequestContext { RequestId = Guid.NewGuid().ToString("N"), UserId = "normal-user", SourceSystem = "map" },
            }),
        };
        request.Headers.Add("X-Gateway-Key", key);
        request.Headers.Add("X-Gateway-Source", "map");
        request.Headers.Add(GatewayTaskAdmission.HeaderName, automatic ? AutomaticPermitId : ManualPermitId);
        PlatformExecutionFixture.Headers(request, automatic ? AutomaticPermitId : ManualPermitId);
        if (automatic)
        {
            request.Headers.Add("X-Gateway-Execution-Origin", "automatic");
            request.Headers.Add("X-Gateway-Source-Deployment", deployment);
        }
        return await client.SendAsync(request);
    }

    private static async Task<WebApplication> Serving(DiagnosticDatabase database, Dictionary<string, int> overrides,
        Dictionary<string, string?>? additionalConfiguration = null)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        var defaults = new Dictionary<string, string?>();
        foreach (var prefix in new[] { "Tenant", "AppCaller", "AutomaticTenant", "AutomaticAppCaller" })
            foreach (var period in new[] { "PerMinute", "PerHour", "PerDay" })
                defaults["LlmGateway:MinimumProtection:" + prefix + period] = "1000";
        foreach (var (name, value) in overrides) defaults["LlmGateway:MinimumProtection:" + name] = value.ToString();
        builder.Configuration.AddInMemoryCollection(defaults);
        if (additionalConfiguration is not null) builder.Configuration.AddInMemoryCollection(additionalConfiguration);
        builder.Services.AddSingleton(database.Data);
        builder.Services.AddHttpContextAccessor();
        builder.Services.AddSingleton<GatewayMinimumProtectionCoordinator>();
        builder.Services.AddSingleton<GatewayBudgetCoordinator>();
        builder.Services.AddSingleton<IGatewayScopedKeyAuthorizer, GatewayScopedKeyAuthorizer>();
        builder.Services.AddSingleton<IGatewayTaskAdmission, GatewayTaskAdmission>();
        builder.Services.AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>();
        var gateway = new Mock<PrdAgent.Core.LlmGateway.ILlmGateway>();
        gateway.Setup(g => g.SendAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Callback(() => Interlocked.Increment(ref database.UpstreamCalls))
            .ReturnsAsync(new GatewayResponse { Success = true, StatusCode = 200, Content = "counted upstream" });
        builder.Services.AddSingleton(gateway.Object);
        var app = builder.Build();
        app.MapGatewayServingEndpoints(new JsonSerializerOptions(), InternalKey, "local-phase0");
        await app.StartAsync();
        return app;
    }

    private static async Task<WebApplication> Console(DiagnosticDatabase database)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true, ValidIssuer = database.Jwt.Issuer, ValidateAudience = false,
                ValidateLifetime = true, ValidateIssuerSigningKey = true, IssuerSigningKey = database.Jwt.SigningKey,
            });
        builder.Services.AddAuthorization(options => options.AddPolicy("LogsRead", policy =>
            policy.RequireAuthenticatedUser().RequireAssertion(context => TenantAccess.HasPermission(context.User, LlmGwPermissions.LogsRead))));
        var app = builder.Build();
        app.UseAuthentication();
        app.Use(async (http, next) =>
        {
            if (http.User.Identity?.IsAuthenticated == true)
            {
                var access = await TenantAccess.ResolveAsync(http,
                    database.Data.Database.GetCollection<LlmGwUser>("llmgw_console_users"),
                    database.Data.Database.GetCollection<LlmGwMembership>("llmgw_memberships"),
                    database.Data.Database.GetCollection<LlmGwTenant>("llmgw_tenants"),
                    database.Data.Database.GetCollection<LlmGwTeam>("llmgw_teams"), http.RequestAborted);
                access.ShouldNotBeNull();
                http.Items[TenantAccess.ItemKey] = access;
            }
            await next();
        });
        app.UseAuthorization();
        app.MapGatewayConsumptionAlerts(database.Data.Database, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        await app.StartAsync();
        return app;
    }

    private sealed class DiagnosticDatabase : IAsyncDisposable
    {
        public LlmGatewayDataContext Data { get; }
        public IMongoCollection<BsonDocument> Windows => Data.Database.GetCollection<BsonDocument>(GatewayMinimumProtectionCoordinator.WindowsCollection);
        public IMongoCollection<BsonDocument> Alerts => Data.Database.GetCollection<BsonDocument>(GatewayMinimumProtectionCoordinator.AlertsCollection);
        public GwJwt Jwt { get; } = new(new string('x', 64), "phase0-local-test");
        public int UpstreamCalls;
        private readonly MongoClient _client;
        private DiagnosticDatabase(string connection)
        {
            _client = new MongoClient(connection);
            Data = new LlmGatewayDataContext(connection, "phase0_gateway_diagnostic_" + Guid.NewGuid().ToString("N"));
        }
        public static async Task<DiagnosticDatabase> CreateAsync()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION");
            if (string.IsNullOrWhiteSpace(connection))
                throw new InvalidOperationException("必须设置 MONGODB_TEST_CONNECTION 指向隔离诊断 Mongo；此测试不能静默跳过");
            BsonClassMapRegistration.RegisterConventionsOnly();
            var database = new DiagnosticDatabase(connection);
            await database.Data.Database.RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            foreach (var (id, origin) in new[] { (ManualPermitId, TaskExecutionOrigins.Interactive), (AutomaticPermitId, TaskExecutionOrigins.Agent) })
                await database.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName).InsertOneAsync(PlatformExecutionFixture.Prepare(new GatewayTaskPermitRecord
                {
                    Id = id, TenantId = Tenant, ActorUserId = "normal-user", SubjectUserIds = ["normal-user"],
                    TriggerCredentialId = "phase0-test-task", Origin = origin, SourceDeployment = "prd-agent:production",
                    SourceTask = "request:minimum-protection-fixture", MaxCalls = GatewayTaskPermitRecord.MaximumCalls, MaxRuns = 1,
                    ExpiresAt = DateTime.UtcNow.AddHours(1),
                    AllowedAppCallerCodes = [Caller, "future-business.first::chat", "future-business.second::chat", "future-business.third::chat"],
                }));
            return database;
        }
        public Task AddCallerAsync(string tenantId, int? rate = null)
            => Data.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers").InsertOneAsync(new GatewayAppCallerRecord
            {
                TenantId = tenantId, AppCallerCode = Caller, RequestType = "chat", Status = "active", RateLimitPerMinute = rate,
            });
        public async Task<string> TokenAsync(string tenantId, string role, string? team = null)
        {
            var tenant = new LlmGwTenant { Id = tenantId, Name = tenantId };
            await Data.Database.GetCollection<LlmGwTenant>("llmgw_tenants").ReplaceOneAsync(
                x => x.Id == tenantId, tenant, new ReplaceOptions { IsUpsert = true });
            if (team is not null)
                await Data.Database.GetCollection<LlmGwTeam>("llmgw_teams").ReplaceOneAsync(
                    x => x.Id == team, new LlmGwTeam { Id = team, TenantId = tenantId }, new ReplaceOptions { IsUpsert = true });
            var user = new LlmGwUser { Username = "diagnostic-" + role, TenantIds = [tenantId] };
            var membership = new LlmGwMembership { TenantId = tenantId, UserId = user.Id, Role = role, TeamIds = team is null ? [] : [team] };
            await Data.Database.GetCollection<LlmGwUser>("llmgw_console_users").InsertOneAsync(user);
            await Data.Database.GetCollection<LlmGwMembership>("llmgw_memberships").InsertOneAsync(membership);
            return Jwt.Issue(user, tenant, membership).Token;
        }
        public ValueTask DisposeAsync() => new(_client.DropDatabaseAsync(Data.DatabaseName));
    }
}
