using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Security;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

public sealed class KeyMaintenanceContractMongoTests(ITestOutputHelper output)
{
    [Fact, Trait("Category", "Integration")]
    public async Task PolicyCasAndCutoverExpectationRejectStaleIntentBeforeWriting()
    {
        var uri = Environment.GetEnvironmentVariable("KEY_CONTRACT_TEST_MONGO_URI");
        Assert.False(string.IsNullOrWhiteSpace(uri), "点名测试需要本地 KEY_CONTRACT_TEST_MONGO_URI。");
        Assert.All(new MongoUrl(uri).Servers, server => Assert.Contains(server.Host, new[] { "localhost", "127.0.0.1", "::1" }));
        var client = new MongoClient(uri);
        var databaseName = "key_contract_test_" + Guid.NewGuid().ToString("N");
        var db = client.GetDatabase(databaseName);
        var tenant = "tenant_map_internal";
        Process? api = null;
        Task<string>? stdout = null, stderr = null;
        output.WriteLine("isolated database: " + databaseName);
        try
        {
            var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
            var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
            { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            var testAssembly = typeof(KeyMaintenanceContractMongoTests).Assembly.Location;
            start.ArgumentList.Add("exec"); start.ArgumentList.Add("--runtimeconfig");
            start.ArgumentList.Add(Path.ChangeExtension(testAssembly, ".runtimeconfig.json"));
            start.ArgumentList.Add("--depsfile"); start.ArgumentList.Add(Path.ChangeExtension(testAssembly, ".deps.json"));
            start.ArgumentList.Add(typeof(LegacyKeyPolicyConcurrency).Assembly.Location);
            start.Environment["ASPNETCORE_ENVIRONMENT"] = "Development";
            start.Environment["ASPNETCORE_URLS"] = $"http://127.0.0.1:{port}";
            start.Environment["MongoDB__ConnectionString"] = uri;
            start.Environment["MongoDB__DatabaseName"] = databaseName;
            start.Environment["LlmGateway__MongoConnectionString"] = uri;
            start.Environment["LlmGateway__DatabaseName"] = databaseName;
            start.Environment["LlmGateway__InternalTenantId"] = tenant;
            start.Environment["LLMGW_ADMIN_PASSWORD"] = "Isolated-Key-Contract-Only-2026";
            start.Environment["LLMGW_ADMIN_FORCE_RESET"] = "true";
            start.Environment["LlmGwJwt__Secret"] = "isolated-key-contract-test-secret-2026-0001";
            api = Process.Start(start)!;
            stdout = api.StandardOutput.ReadToEndAsync(); stderr = api.StandardError.ReadToEndAsync();
            using var http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}"), Timeout = TimeSpan.FromSeconds(15) };
            var ready = false;
            for (var i = 0; i < 100 && !api.HasExited; i++)
            {
                try { if ((await http.GetAsync("/gw/healthz")).IsSuccessStatusCode) { ready = true; break; } }
                catch (HttpRequestException) { }
                await Task.Delay(100);
            }
            Assert.True(ready, api.HasExited ? "isolated API exited: " + await stderr : "isolated API did not start");
            var login = await http.PostAsJsonAsync("/gw/auth/login", new { username = "admin", password = "Isolated-Key-Contract-Only-2026" });
            login.EnsureSuccessStatusCode();
            var loginJson = await login.Content.ReadFromJsonAsync<JsonElement>();
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", loginJson.GetProperty("data").GetProperty("token").GetString());

            var policies = db.GetCollection<BsonDocument>("llmgw_legacy_key_cutovers");
            var keys = db.GetCollection<BsonDocument>("llmgw_service_keys");
            var baseline = await ReadPolicy(http);
            Assert.Equal(0, baseline.GetProperty("policyRevision").GetInt64());
            var noBaseline = await http.PutAsJsonAsync("/gw/legacy-key-cutover", new { status = "observing", deadlineAt = "2099-01-01T00:00:00Z" });
            await Rejected(noBaseline, 428, "LEGACY_POLICY_REVISION_REQUIRED");
            Assert.Equal(0, await policies.CountDocumentsAsync(new BsonDocument()));

            // First two admins both saw no policy / revision zero. Only one may insert.
            var firstCreates = await Task.WhenAll(WritePolicy(http, 0, "observing"), WritePolicy(http, 0, "ready"));
            Assert.Single(firstCreates.Where(x => x.IsSuccessStatusCode));
            foreach (var failed in firstCreates.Where(x => !x.IsSuccessStatusCode)) await Rejected(failed, 409, "LEGACY_POLICY_CONFLICT");
            Assert.Equal(1, await policies.CountDocumentsAsync(new BsonDocument()));
            Assert.Equal(1, (await ReadPolicy(http)).GetProperty("policyRevision").GetInt64());

            // Stored documents without a revision migrate through the same zero baseline.
            await policies.UpdateOneAsync(new BsonDocument("TenantId", tenant), Builders<BsonDocument>.Update.Unset("PolicyRevision").Set("Status", "observing"));
            (await WritePolicy(http, 0, "ready")).EnsureSuccessStatusCode();
            await Rejected(await WritePolicy(http, 0, "observing"), 409, "LEGACY_POLICY_CONFLICT");
            Assert.Equal("ready", (await ReadPolicy(http)).GetProperty("status").GetString());

            // Runtime observations never advance the policy-edit revision or reset during a policy edit.
            await policies.UpdateOneAsync(new BsonDocument("TenantId", tenant), Builders<BsonDocument>.Update.Inc("SuccessorObservedCount", 1).Inc("SuccessorObservationCounts.sample", 1));
            (await WritePolicy(http, 1, "observing")).EnsureSuccessStatusCode();
            var afterObservation = await policies.Find(new BsonDocument("TenantId", tenant)).SingleAsync();
            Assert.Equal(2, LegacyKeyPolicyConcurrency.ReadRevision(afterObservation));
            Assert.Equal(1, afterObservation["SuccessorObservationCounts"]["sample"].ToInt64());

            // Reproduce the old tenant-only write against a revoked, unversioned legacy row.
            var counterexample = db.GetCollection<BsonDocument>("old_tenant_filter_counterexample");
            await counterexample.InsertOneAsync(new BsonDocument { { "_id", "legacy" }, { "TenantId", tenant }, { "Status", "revoked" } });
            var oldResult = await counterexample.UpdateOneAsync(new BsonDocument("TenantId", tenant), Builders<BsonDocument>.Update.Set("Status", "observing"));
            Assert.Equal(1, oldResult.ModifiedCount); // This is precisely the old lost-revocation condition.
            await counterexample.UpdateOneAsync(new BsonDocument("TenantId", tenant), Builders<BsonDocument>.Update.Set("Status", "revoked"));
            var guardedResult = await counterexample.UpdateOneAsync(Builders<BsonDocument>.Filter.Eq("TenantId", tenant) & LegacyKeyPolicyConcurrency.WriteFilter(0, "observing"), Builders<BsonDocument>.Update.Set("Status", "observing"));
            Assert.Equal(0, guardedResult.MatchedCount);
            Assert.Equal("revoked", (await counterexample.Find(new BsonDocument("_id", "legacy")).SingleAsync())["Status"].AsString);

            // The new atomic filter also rejects a read-A/write-B/read-old-A interleaving.
            var staleRevision = LegacyKeyPolicyConcurrency.ReadRevision(afterObservation);
            (await WritePolicy(http, staleRevision, "ready")).EnsureSuccessStatusCode();
            var staleResult = await policies.UpdateOneAsync(Builders<BsonDocument>.Filter.Eq("TenantId", tenant) & LegacyKeyPolicyConcurrency.WriteFilter(staleRevision, "observing"), Builders<BsonDocument>.Update.Set("Status", "observing"));
            Assert.Equal(0, staleResult.MatchedCount);
            await policies.UpdateOneAsync(new BsonDocument("TenantId", tenant), Builders<BsonDocument>.Update.Set("Status", "revoked"));
            await Rejected(await WritePolicy(http, staleRevision + 1, "observing"), 409, "LEGACY_REVOCATION_FINAL");
            Assert.Equal("revoked", (await ReadPolicy(http)).GetProperty("status").GetString());

            // No API caller may claim a different successor than the one shown in its confirmation.
            await keys.InsertManyAsync(new[] {
                new BsonDocument { { "_id", "old" }, { "KeyHash", "isolated-old-key-hash" }, { "TenantId", tenant }, { "Enabled", true }, { "IssuanceState", "issued" }, { "RotationState", "awaiting-client-cutover" }, { "RotatedByKeyId", "new-B" } },
                new BsonDocument { { "_id", "new-B" }, { "KeyHash", "isolated-new-key-hash" }, { "TenantId", tenant }, { "Enabled", true }, { "IssuanceState", "issued" }, { "RotationState", "new-key-created" }, { "RotatesKeyId", "old" } },
            });
            var keysBefore = (await keys.Find(new BsonDocument()).Sort(new BsonDocument("_id", 1)).ToListAsync()).ToJson();
            await Rejected(await http.PostAsJsonAsync("/gw/service-keys/old/rotation/client-cutover", new { }), 428, "ROTATION_EXPECTATION_REQUIRED");
            await Rejected(await http.PostAsJsonAsync("/gw/service-keys/old/rotation/client-cutover", new { expectedSuccessorKeyId = "new-A" }), 409, "ROTATION_PAIR_CHANGED");
            Assert.Equal(keysBefore, (await keys.Find(new BsonDocument()).Sort(new BsonDocument("_id", 1)).ToListAsync()).ToJson());
            var validCutover = await http.PostAsJsonAsync("/gw/service-keys/old/rotation/client-cutover", new { expectedSuccessorKeyId = "new-B" });
            validCutover.EnsureSuccessStatusCode();
            Assert.All(await keys.Find(new BsonDocument()).ToListAsync(), key => Assert.Equal("client-switched", key["RotationState"].AsString));
            output.WriteLine("old tenant-only filter reopened revoked row; guarded filter rejected it; stale/zero revision and cutover cases passed");
        }
        finally
        {
            if (api is { HasExited: false }) { api.Kill(entireProcessTree: true); await api.WaitForExitAsync(); }
            await client.DropDatabaseAsync(databaseName);
            Assert.Empty(await (await db.ListCollectionNamesAsync()).ToListAsync());
            output.WriteLine("isolated database deleted: " + databaseName);
        }
    }

    private static async Task<JsonElement> ReadPolicy(HttpClient http)
    {
        var res = await http.GetFromJsonAsync<JsonElement>("/gw/legacy-key-cutover");
        Assert.True(res.GetProperty("success").GetBoolean());
        return res.GetProperty("data");
    }
    private static Task<HttpResponseMessage> WritePolicy(HttpClient http, long revision, string status)
        => http.PutAsJsonAsync("/gw/legacy-key-cutover", new { expectedPolicyRevision = revision, status, deadlineAt = "2099-01-01T00:00:00Z", allowedAppCallerCodes = Array.Empty<string>(), successorServiceKeyIds = Array.Empty<string>(), requiredSuccessorObservations = 1 });
    private static async Task Rejected(HttpResponseMessage response, int status, string code)
    {
        Assert.Equal(status, (int)response.StatusCode);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(code, json.GetProperty("error").GetProperty("code").GetString());
    }
}
