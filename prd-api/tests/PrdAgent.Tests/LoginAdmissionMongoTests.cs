using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using Xunit;

namespace PrdAgent.Tests;

public sealed class LoginAdmissionMongoTests : IAsyncLifetime
{
    private IMongoDatabase db = null!;
    private MongoClient client = null!;
    private string uri = "";
    public Task InitializeAsync()
    {
        uri = Environment.GetEnvironmentVariable("LOGIN_ADMISSION_TEST_MONGO_URI") ?? "";
        Assert.False(string.IsNullOrWhiteSpace(uri), "Explicit local LOGIN_ADMISSION_TEST_MONGO_URI is required.");
        Assert.All(new MongoUrl(uri).Servers, x => Assert.Contains(x.Host, new[] { "localhost", "127.0.0.1", "::1" }));
        client = new MongoClient(uri);
        db = client.GetDatabase("login_admission_test_" + Guid.NewGuid().ToString("N"));
        return Task.CompletedTask;
    }
    public Task DisposeAsync() => client.DropDatabaseAsync(db.DatabaseNamespace.DatabaseName);
    private IMongoCollection<LlmGwUser> Users => db.GetCollection<LlmGwUser>("llmgw_console_users");
    private static string Secret() => Guid.NewGuid().ToString("N") + "-Synthetic-only";

    [Fact, Trait("Category", "Integration")]
    public async Task BootstrapRequiresMaterialAndClaimsOnceAcrossInstancesAndRestarts()
    {
        Assert.Null(await new OwnerBootstrap(db).InitializeAsync(null));
        Assert.Equal(0, await Users.CountDocumentsAsync(FilterDefinition<LlmGwUser>.Empty));
        await Assert.ThrowsAsync<InvalidOperationException>(() => new OwnerBootstrap(db).InitializeAsync("admin"));
        var password = Secret();
        var ids = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ => new OwnerBootstrap(db).InitializeAsync(password)));
        Assert.Single(ids.Distinct());
        var owner = Assert.Single(await Users.Find(FilterDefinition<LlmGwUser>.Empty).ToListAsync());
        Assert.True(PasswordHasher.Verify(password, owner.PasswordHash));
        Assert.True(owner.MustChangePassword);
        await Users.UpdateOneAsync(x => x.Id == owner.Id, Builders<LlmGwUser>.Update.Set(x => x.Username, "renamed").Set(x => x.IsActive, false));
        Assert.Equal(owner.Id, await new OwnerBootstrap(db).InitializeAsync(Secret()));
        var preserved = await Users.Find(x => x.Id == owner.Id).SingleAsync();
        Assert.Equal("renamed", preserved.Username); Assert.False(preserved.IsActive);
        Assert.Equal(owner.PasswordHash, preserved.PasswordHash);
        await Users.DeleteOneAsync(x => x.Id == owner.Id);
        await new OwnerBootstrap(db).InitializeAsync(password);
        Assert.Equal(0, await Users.CountDocumentsAsync(FilterDefinition<LlmGwUser>.Empty));
    }

    [Fact, Trait("Category", "Integration")]
    public async Task ExistingAccountsAreNotOverwrittenAndRecoveryIsOneTimeAndAudited()
    {
        var password = Secret();
        var user = new LlmGwUser { Username = "existing", PasswordHash = PasswordHasher.Hash(password), IsActive = false };
        await Users.InsertOneAsync(user);
        Assert.Null(await new OwnerBootstrap(db).InitializeAsync(Secret()));
        Assert.Single(await Users.Find(FilterDefinition<LlmGwUser>.Empty).ToListAsync());
        var operation = Guid.NewGuid().ToString("N"); var recoveryPassword = Secret();
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => new OwnerBootstrap(db).RecoverAsync(user.Id, operation, recoveryPassword)));
        var recovered = await Users.Find(x => x.Id == user.Id).SingleAsync();
        Assert.True(PasswordHasher.Verify(recoveryPassword, recovered.PasswordHash));
        Assert.True(recovered.IsActive); Assert.True(recovered.MustChangePassword);
        Assert.Equal(user.SecurityVersion + 1, recovered.SecurityVersion);
        var changed = PasswordHasher.Hash(Secret());
        await Users.UpdateOneAsync(x => x.Id == user.Id, Builders<LlmGwUser>.Update.Set(x => x.PasswordHash, changed));
        await new OwnerBootstrap(db).RecoverAsync(user.Id, operation, recoveryPassword);
        Assert.Equal(changed, (await Users.Find(x => x.Id == user.Id).SingleAsync()).PasswordHash);
        var audit = await db.GetCollection<BsonDocument>("llmgw_owner_bootstrap").Find(new BsonDocument("_id", "recovery:" + operation)).SingleAsync();
        Assert.Equal("complete", audit["State"]); Assert.False(audit.Contains("AfterHash"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => new OwnerBootstrap(db).RecoverAsync(Guid.NewGuid().ToString("N"), Guid.NewGuid().ToString("N"), recoveryPassword));
    }

    [Fact, Trait("Category", "Integration")]
    public async Task PreparedBootstrapResumesAndRecoveryConflictDoesNotOverwrite()
    {
        var user = new LlmGwUser { Username = "admin", PasswordHash = PasswordHasher.Hash(Secret()) };
        var state = db.GetCollection<BsonDocument>("llmgw_owner_bootstrap");
        await state.InsertOneAsync(new BsonDocument
        {
            { "_id", "owner" }, { "State", "prepared" }, { "Provisioned", false },
            { "UserId", user.Id }, { "User", user.ToBsonDocument() }
        });
        // Crash after user insertion but before marking bootstrap complete.
        await Users.InsertOneAsync(user);
        Assert.Equal(user.Id, await new OwnerBootstrap(db).InitializeAsync(null));
        Assert.Single(await Users.Find(FilterDefinition<LlmGwUser>.Empty).ToListAsync());
        var operation = Guid.NewGuid().ToString("N");
        await state.InsertOneAsync(new BsonDocument
        {
            { "_id", "recovery:" + operation }, { "State", "prepared" }, { "UserId", user.Id },
            { "BeforeHash", user.PasswordHash }, { "BeforeVersion", user.SecurityVersion }, { "AfterHash", PasswordHasher.Hash(Secret()) }
        });
        await Users.UpdateOneAsync(x => x.Id == user.Id, Builders<LlmGwUser>.Update.Inc(x => x.SecurityVersion, 1).Set(x => x.IsActive, false));
        await Assert.ThrowsAsync<InvalidOperationException>(() => new OwnerBootstrap(db).RecoverAsync(user.Id, operation, Secret()));
        var preserved = await Users.Find(x => x.Id == user.Id).SingleAsync();
        Assert.False(preserved.IsActive); Assert.Equal(user.PasswordHash, preserved.PasswordHash);
        Assert.Equal("conflict", (await state.Find(new BsonDocument("_id", "recovery:" + operation)).SingleAsync())["State"]);
    }

    private async Task ResetWindow() => await db.GetCollection<BsonDocument>("llmgw_login_admission").UpdateOneAsync(
        new BsonDocument("_id", "login"), new BsonDocument("$set", new BsonDocument("Window", DateTime.UnixEpoch)));

    [Fact, Trait("Category", "Integration")]
    public async Task BudgetsAreAtomicSharedBoundedAndRecoverAfterWindow()
    {
        // Avoid crossing a real server minute in this bounded concurrency experiment.
        if (DateTime.UtcNow.Second > 45) await Task.Delay(TimeSpan.FromSeconds(61 - DateTime.UtcNow.Second));
        var gates = new[] { new LoginAdmission(db), new LoginAdmission(db) };
        await Task.WhenAll(gates.Select(g => g.InitializeAsync()));
        var account = await Task.WhenAll(Enumerable.Range(0, 40).Select(i => gates[i % 2].TryAcquireAsync("same", IPAddress.Parse($"192.0.2.{i + 1}"))));
        Assert.Equal(LoginAdmission.AccountLimit, account.Count(x => x));
        await ResetWindow();
        var ip = await Task.WhenAll(Enumerable.Range(0, 60).Select(i => gates[i % 2].TryAcquireAsync("account" + i, IPAddress.Loopback)));
        Assert.Equal(LoginAdmission.IpLimit, ip.Count(x => x));
        await ResetWindow();
        var global = await Task.WhenAll(Enumerable.Range(0, 240).Select(i => gates[i % 2].TryAcquireAsync("account" + i, IPAddress.Parse($"198.51.100.{i + 1}"))));
        Assert.Equal(LoginAdmission.GlobalLimit, global.Count(x => x));
        var doc = await db.GetCollection<BsonDocument>("llmgw_login_admission").Find(new BsonDocument("_id", "login")).SingleAsync();
        Assert.Equal(LoginAdmission.GlobalLimit, doc["Accounts"].AsBsonDocument.ElementCount);
        Assert.False(await new LoginAdmission(db).TryAcquireAsync("restart", IPAddress.Parse("203.0.113.1")));
        await ResetWindow(); Assert.True(await gates[0].TryAcquireAsync("same", IPAddress.Loopback));
        Assert.Equal(LoginAdmission.NormalizeIp(IPAddress.Loopback), LoginAdmission.NormalizeIp(IPAddress.Parse("::ffff:127.0.0.1")));
        Assert.Equal(LoginAdmission.NormalizeIp(IPAddress.Parse("2001:db8::1")), LoginAdmission.NormalizeIp(IPAddress.Parse("2001:db8::2")));
    }

    [Fact, Trait("Category", "Integration")]
    public async Task HttpLoginRejectsDefaultAndStopsHashingAndAuditingAfterAdmission()
    {
        await using (var empty = await StartApi(null))
        {
            var result = await empty.Http.PostAsJsonAsync("/gw/auth/login", new { username = "admin", password = "admin" });
            Assert.False((await result.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("success").GetBoolean());
            Assert.Equal(0, await Users.CountDocumentsAsync(FilterDefinition<LlmGwUser>.Empty));
        }
        var password = Secret();
        await using var api = await StartApi(password);
        await ResetWindow();
        var good = await api.Http.PostAsJsonAsync("/gw/auth/login", new { username = "admin", password });
        var json = await good.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.GetProperty("success").GetBoolean());
        Assert.True(json.GetProperty("data").GetProperty("mustChangePassword").GetBoolean());
        for (var i = 1; i < LoginAdmission.AccountLimit; i++)
            await api.Http.PostAsJsonAsync("/gw/auth/login", new { username = "admin", password = "wrong" });
        // Empty PBKDF2 output is a tripwire: Verify would throw if called past the gate.
        await Users.UpdateOneAsync(x => x.Username == "admin", Builders<LlmGwUser>.Update.Set(x => x.PasswordHash, "pbkdf2$100000$$"));
        var audits = db.GetCollection<BsonDocument>("llmgw_login_audits");
        var before = await audits.CountDocumentsAsync(new BsonDocument());
        await using var replica = await StartApi(null);
        var blocked = await Task.WhenAll(Enumerable.Range(0, 25).Select(i =>
        {
            var request = new HttpRequestMessage(HttpMethod.Post, "/gw/auth/login") { Content = JsonContent.Create(new { username = "admin", password = "wrong" }) };
            request.Headers.Add("X-Forwarded-For", $"198.51.100.{i + 1}");
            return (i % 2 == 0 ? api.Http : replica.Http).SendAsync(request);
        }));
        Assert.All(blocked, r => { Assert.Equal(HttpStatusCode.TooManyRequests, r.StatusCode); Assert.Equal(TimeSpan.FromSeconds(60), r.Headers.RetryAfter!.Delta); });
        Assert.Equal(before, await audits.CountDocumentsAsync(new BsonDocument()));
        await ResetWindow();
        for (var i = 0; i < LoginAdmission.IpLimit; i++)
        {
            api.Http.DefaultRequestHeaders.Remove("X-Forwarded-For");
            api.Http.DefaultRequestHeaders.Add("X-Forwarded-For", $"203.0.113.{i + 1}");
            await api.Http.PostAsJsonAsync("/gw/auth/login", new { username = "missing" + i, password = "wrong" });
        }
        Assert.Equal(HttpStatusCode.TooManyRequests, (await api.Http.PostAsJsonAsync("/gw/auth/login", new { username = "another", password = "wrong" })).StatusCode);
        var failures = await audits.Find(new BsonDocument("Reason", "USER_NOT_FOUND")).ToListAsync();
        Assert.All(failures, x => Assert.Contains(x["RemoteIp"].AsString, new[] { "127.0.0.1", "::ffff:127.0.0.1" }));
        // Removing the authoritative budget document fails closed (no upsert/reset on request).
        await db.GetCollection<BsonDocument>("llmgw_login_admission").DeleteOneAsync(new BsonDocument("_id", "login"));
        Assert.Equal(HttpStatusCode.TooManyRequests, (await api.Http.PostAsJsonAsync("/gw/auth/login", new { username = "admin", password })).StatusCode);
    }

    [Fact, Trait("Category", "Integration")]
    public async Task TrustedProxyUsesNearestHopAndClaimInvalidatesCompetingSession()
    {
        var password = Secret();
        await using var api = await StartApi(password, true);
        api.Http.DefaultRequestHeaders.Add("X-Forwarded-For", "192.0.2.123, 203.0.113.7");
        var first = await (await api.Http.PostAsJsonAsync("/gw/auth/login", new { username = "admin", password })).Content.ReadFromJsonAsync<JsonElement>();
        var second = await (await api.Http.PostAsJsonAsync("/gw/auth/login", new { username = "admin", password })).Content.ReadFromJsonAsync<JsonElement>();
        var token1 = first.GetProperty("data").GetProperty("token").GetString();
        var token2 = second.GetProperty("data").GetProperty("token").GetString();
        // Existing interactive password length semantics must remain usable after admission.
        var passwords = new[] { Secret() + new string('x', 1100), Secret() + new string('y', 1100) };
        var claims = await Task.WhenAll(new[] { token1, token2 }.Select((token, i) =>
        {
            var request = new HttpRequestMessage(HttpMethod.Post, "/gw/auth/change-password")
            { Content = JsonContent.Create(new { oldPassword = password, newPassword = passwords[i] }) };
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            return api.Http.SendAsync(request);
        }));
        Assert.Single(claims.Where(r => r.IsSuccessStatusCode));
        var winner = Array.FindIndex(claims, r => r.IsSuccessStatusCode);
        Assert.Contains(claims[1 - winner].StatusCode, new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Conflict });
        var normal = await (await api.Http.PostAsJsonAsync("/gw/auth/login", new { username = "admin", password = passwords[winner] })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(normal.GetProperty("success").GetBoolean());
        Assert.False(normal.GetProperty("data").GetProperty("mustChangePassword").GetBoolean());
        var audit = await db.GetCollection<BsonDocument>("llmgw_login_audits").Find(new BsonDocument()).ToListAsync();
        Assert.All(audit, row => Assert.Equal("203.0.113.7", row["RemoteIp"].AsString));
    }

    [Fact, Trait("Category", "Integration")]
    public async Task RejectedAttemptAuditsAreAggregatedAcrossInstances()
    {
        var gates = new[] { new LoginAdmission(db), new LoginAdmission(db) };
        await Task.WhenAll(gates.Select(g => g.InitializeAsync()));
        foreach (var gate in gates) { for (var i = 0; i < 100; i++) gate.RecordDenied(); gate.RecordUnavailable(); }
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(70));
        var loops = gates.Select(g => g.RunAuditLoopAsync(Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, stop.Token)).ToArray();
        try
        {
            var collection = db.GetCollection<BsonDocument>("llmgw_login_admission");
            BsonDocument summary = null!;
            for (var i = 0; i < 65; i++)
            {
                summary = await collection.Find(new BsonDocument("_id", "denied-summary")).SingleAsync();
                if (summary["Denied"].ToInt64() == 200) break;
                await Task.Delay(1000);
            }
            Assert.Equal(200, summary["Denied"].ToInt64());
            Assert.Equal(2, summary["Unavailable"].ToInt64());
            Assert.Equal(2, await collection.CountDocumentsAsync(new BsonDocument()));
        }
        finally { stop.Cancel(); await Task.WhenAll(loops); }
    }

    private async Task<ApiProcess> StartApi(string? password, bool trustedProxy = false)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        var assembly = typeof(LoginAdmissionMongoTests).Assembly.Location;
        foreach (var argument in new[] { "exec", "--runtimeconfig", Path.ChangeExtension(assembly, ".runtimeconfig.json"), "--depsfile", Path.ChangeExtension(assembly, ".deps.json"), typeof(OwnerBootstrap).Assembly.Location }) start.ArgumentList.Add(argument);
        start.Environment["ASPNETCORE_ENVIRONMENT"] = "Development";
        start.Environment["ASPNETCORE_URLS"] = $"http://127.0.0.1:{port}";
        foreach (var key in new[] { "MongoDB__ConnectionString", "LlmGateway__MongoConnectionString" }) start.Environment[key] = uri;
        foreach (var key in new[] { "MongoDB__DatabaseName", "LlmGateway__DatabaseName" }) start.Environment[key] = db.DatabaseNamespace.DatabaseName;
        start.Environment["LLMGW_ADMIN_PASSWORD"] = password ?? "";
        start.Environment["LLMGW_ADMIN_FORCE_RESET"] = "false";
        start.Environment["LLMGW_ADMIN_ENV_AUTHORITY"] = "false";
        start.Environment["LLMGW_TRUSTED_PROXIES"] = trustedProxy ? "127.0.0.1" : "";
        var process = Process.Start(start)!;
        var api = new ApiProcess(process, port);
        for (var i = 0; i < 200 && !process.HasExited; i++)
        {
            try { if ((await api.Http.GetAsync("/gw/healthz")).IsSuccessStatusCode) return api; } catch (HttpRequestException) { }
            await Task.Delay(100);
        }
        await api.DisposeAsync();
        throw new Exception("Isolated API failed to start: " + await api.Error + await api.Output);
    }
    private sealed class ApiProcess : IAsyncDisposable
    {
        private readonly Process process;
        public HttpClient Http { get; }
        public Task<string> Error { get; }
        public Task<string> Output { get; }
        public ApiProcess(Process process, int port)
        {
            this.process = process; Error = process.StandardError.ReadToEndAsync(); Output = process.StandardOutput.ReadToEndAsync();
            Http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}"), Timeout = TimeSpan.FromSeconds(10) };
        }
        public async ValueTask DisposeAsync()
        {
            Http.Dispose(); if (!process.HasExited) process.Kill(true);
            await process.WaitForExitAsync(); process.Dispose();
        }
    }
}
