using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Integration;

/// <summary>
/// PR Review Prism API integration tests.
///
/// Requires: real MongoDB + Redis + ROOT_ACCESS_USERNAME/ROOT_ACCESS_PASSWORD configured.
/// CI skips these (Category=Integration).
/// </summary>
[Collection("Integration")]
[Trait("Category", TestCategories.Integration)]
public class PrReviewPrismApiIntegrationTests : IClassFixture<WebApplicationFactory<Program>>, IAsyncLifetime
{
    private readonly WebApplicationFactory<Program> _factory;
    private readonly ITestOutputHelper _output;
    private string? _rootAccessToken;

    public PrReviewPrismApiIntegrationTests(WebApplicationFactory<Program> factory, ITestOutputHelper output)
    {
        _factory = factory;
        _output = output;
    }

    public async Task InitializeAsync()
    {
        var client = _factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/v1/auth/login", new
        {
            username = Environment.GetEnvironmentVariable("ROOT_ACCESS_USERNAME") ?? "root",
            password = Environment.GetEnvironmentVariable("ROOT_ACCESS_PASSWORD") ?? "root",
            clientType = "admin"
        });

        if (loginResponse.StatusCode != HttpStatusCode.OK)
        {
            var body = await loginResponse.Content.ReadAsStringAsync();
            Log($"[Init] root login failed: {loginResponse.StatusCode} - {Truncate(body, 200)}");
            return;
        }

        var text = await loginResponse.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text);
        _rootAccessToken = doc.RootElement.GetProperty("data").GetProperty("accessToken").GetString();
        Log($"[Init] root login ok, token length={_rootAccessToken?.Length}");
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Status_NoAuth_ShouldReturn401()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/pr-review-prism/status");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Create_InvalidPullRequestUrl_ShouldReturn400()
    {
        if (!HasToken)
        {
            Log("[Skip] no token");
            return;
        }

        var client = CreateAuthenticatedClient();
        if (!await EnsurePrReviewPrismAccessibleAsync(client))
        {
            return;
        }

        var response = await client.PostAsJsonAsync("/api/pr-review-prism/submissions", new
        {
            pullRequestUrl = "https://github.com/inernoro/prd_agent/issues/1",
            note = "invalid-url-test"
        });

        var body = await response.Content.ReadAsStringAsync();
        Log($"[CreateInvalid] {response.StatusCode} - {Truncate(body, 200)}");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        AssertErrorCode(body, "INVALID_FORMAT");
    }

    [Fact]
    public async Task BatchRefresh_EmptyIds_ShouldReturn400()
    {
        if (!HasToken)
        {
            Log("[Skip] no token");
            return;
        }

        var client = CreateAuthenticatedClient();
        if (!await EnsurePrReviewPrismAccessibleAsync(client))
        {
            return;
        }

        var response = await client.PostAsJsonAsync("/api/pr-review-prism/submissions/batch-refresh", new
        {
            ids = Array.Empty<string>()
        });

        var body = await response.Content.ReadAsStringAsync();
        Log($"[BatchRefreshEmptyIds] {response.StatusCode} - {Truncate(body, 200)}");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        AssertErrorCode(body, "INVALID_FORMAT");
    }

    [Fact]
    public async Task SubmissionWorkflow_CreateReuseListGetRefreshDelete_ShouldSucceed()
    {
        if (!HasToken)
        {
            Log("[Skip] no token");
            return;
        }

        var client = CreateAuthenticatedClient();
        if (!await EnsurePrReviewPrismAccessibleAsync(client))
        {
            return;
        }

        var prNumber = Random.Shared.Next(10000000, 99999999);
        var url = $"https://github.com/inernoro/prd_agent/pull/{prNumber}";
        var note1 = $"it-prism-note-{Guid.NewGuid():N}";
        var note2 = $"{note1}-updated";
        string? submissionId = null;

        try
        {
            // 1) Create
            var createResponse = await client.PostAsJsonAsync("/api/pr-review-prism/submissions", new
            {
                pullRequestUrl = url,
                note = note1
            });
            var createBody = await createResponse.Content.ReadAsStringAsync();
            Log($"[Create] {createResponse.StatusCode} - {Truncate(createBody, 240)}");
            Assert.Equal(HttpStatusCode.OK, createResponse.StatusCode);

            using (var createDoc = JsonDocument.Parse(createBody))
            {
                Assert.True(createDoc.RootElement.GetProperty("success").GetBoolean());
                var data = createDoc.RootElement.GetProperty("data");
                Assert.False(data.GetProperty("reused").GetBoolean());
                var submission = data.GetProperty("submission");
                submissionId = submission.GetProperty("id").GetString();
                Assert.False(string.IsNullOrWhiteSpace(submissionId));
            }

            // 2) Create same URL again -> reused = true and note updated
            var reuseResponse = await client.PostAsJsonAsync("/api/pr-review-prism/submissions", new
            {
                pullRequestUrl = url,
                note = note2
            });
            var reuseBody = await reuseResponse.Content.ReadAsStringAsync();
            Log($"[Reuse] {reuseResponse.StatusCode} - {Truncate(reuseBody, 240)}");
            Assert.Equal(HttpStatusCode.OK, reuseResponse.StatusCode);

            using (var reuseDoc = JsonDocument.Parse(reuseBody))
            {
                Assert.True(reuseDoc.RootElement.GetProperty("success").GetBoolean());
                var data = reuseDoc.RootElement.GetProperty("data");
                Assert.True(data.GetProperty("reused").GetBoolean());
                var submission = data.GetProperty("submission");
                Assert.Equal(submissionId, submission.GetProperty("id").GetString());
                Assert.Equal(note2, submission.GetProperty("note").GetString());
            }

            // 3) List -> should include created item
            var listResponse = await client.GetAsync("/api/pr-review-prism/submissions?page=1&pageSize=50");
            var listBody = await listResponse.Content.ReadAsStringAsync();
            Log($"[List] {listResponse.StatusCode}");
            Assert.Equal(HttpStatusCode.OK, listResponse.StatusCode);

            using (var listDoc = JsonDocument.Parse(listBody))
            {
                Assert.True(listDoc.RootElement.GetProperty("success").GetBoolean());
                var items = listDoc.RootElement.GetProperty("data").GetProperty("items");
                Assert.Contains(items.EnumerateArray(), x => x.GetProperty("id").GetString() == submissionId);
            }

            // 4) Get by id
            var getResponse = await client.GetAsync($"/api/pr-review-prism/submissions/{submissionId}");
            var getBody = await getResponse.Content.ReadAsStringAsync();
            Log($"[Get] {getResponse.StatusCode}");
            Assert.Equal(HttpStatusCode.OK, getResponse.StatusCode);

            using (var getDoc = JsonDocument.Parse(getBody))
            {
                Assert.True(getDoc.RootElement.GetProperty("success").GetBoolean());
                var submission = getDoc.RootElement.GetProperty("data").GetProperty("submission");
                Assert.Equal(submissionId, submission.GetProperty("id").GetString());
            }

            // 5) Refresh
            var refreshResponse = await client.PostAsync($"/api/pr-review-prism/submissions/{submissionId}/refresh", null);
            var refreshBody = await refreshResponse.Content.ReadAsStringAsync();
            Log($"[Refresh] {refreshResponse.StatusCode}");
            Assert.Equal(HttpStatusCode.OK, refreshResponse.StatusCode);

            using (var refreshDoc = JsonDocument.Parse(refreshBody))
            {
                Assert.True(refreshDoc.RootElement.GetProperty("success").GetBoolean());
                var submission = refreshDoc.RootElement.GetProperty("data").GetProperty("submission");
                Assert.Equal(submissionId, submission.GetProperty("id").GetString());
            }

            // 6) Batch refresh
            var batchRefreshResponse = await client.PostAsJsonAsync("/api/pr-review-prism/submissions/batch-refresh", new
            {
                ids = new[] { submissionId }
            });
            var batchRefreshBody = await batchRefreshResponse.Content.ReadAsStringAsync();
            Log($"[BatchRefresh] {batchRefreshResponse.StatusCode} - {Truncate(batchRefreshBody, 240)}");
            Assert.Equal(HttpStatusCode.OK, batchRefreshResponse.StatusCode);

            using (var batchRefreshDoc = JsonDocument.Parse(batchRefreshBody))
            {
                Assert.True(batchRefreshDoc.RootElement.GetProperty("success").GetBoolean());
                var data = batchRefreshDoc.RootElement.GetProperty("data");
                Assert.Equal(1, data.GetProperty("total").GetInt32());
                Assert.Equal(1, data.GetProperty("successCount").GetInt32());
                Assert.Equal(0, data.GetProperty("failureCount").GetInt32());
            }

            // 7) Delete
            var deleteResponse = await client.DeleteAsync($"/api/pr-review-prism/submissions/{submissionId}");
            var deleteBody = await deleteResponse.Content.ReadAsStringAsync();
            Log($"[Delete] {deleteResponse.StatusCode}");
            Assert.Equal(HttpStatusCode.OK, deleteResponse.StatusCode);

            using (var deleteDoc = JsonDocument.Parse(deleteBody))
            {
                Assert.True(deleteDoc.RootElement.GetProperty("success").GetBoolean());
                Assert.True(deleteDoc.RootElement.GetProperty("data").GetProperty("deleted").GetBoolean());
            }

            // 8) Get deleted -> 404
            var getDeletedResponse = await client.GetAsync($"/api/pr-review-prism/submissions/{submissionId}");
            var getDeletedBody = await getDeletedResponse.Content.ReadAsStringAsync();
            Log($"[GetDeleted] {getDeletedResponse.StatusCode}");
            Assert.Equal(HttpStatusCode.NotFound, getDeletedResponse.StatusCode);
            AssertErrorCode(getDeletedBody, "NOT_FOUND");
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(submissionId))
            {
                _ = await client.DeleteAsync($"/api/pr-review-prism/submissions/{submissionId}");
            }
        }
    }

    private bool HasToken => !string.IsNullOrWhiteSpace(_rootAccessToken);

    private HttpClient CreateAuthenticatedClient()
    {
        if (!HasToken)
        {
            throw new InvalidOperationException("No valid root access token.");
        }

        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _rootAccessToken);
        return client;
    }

    private async Task<bool> EnsurePrReviewPrismAccessibleAsync(HttpClient client)
    {
        var statusResponse = await client.GetAsync("/api/pr-review-prism/status");
        var body = await statusResponse.Content.ReadAsStringAsync();
        Log($"[Probe] status={statusResponse.StatusCode}, body={Truncate(body, 180)}");

        if (statusResponse.StatusCode == HttpStatusCode.Forbidden)
        {
            Log("[Skip] current account has no pr-review-prism.use permission");
            return false;
        }

        if (statusResponse.StatusCode != HttpStatusCode.OK)
        {
            Log("[Skip] pr-review-prism endpoint is not ready");
            return false;
        }

        return true;
    }

    private static void AssertErrorCode(string responseBody, string expectedCode)
    {
        using var doc = JsonDocument.Parse(responseBody);
        if (doc.RootElement.TryGetProperty("error", out var error) &&
            error.TryGetProperty("code", out var code))
        {
            Assert.Equal(expectedCode, code.GetString());
        }
    }

    private void Log(string message) => _output.WriteLine(message);

    private static string Truncate(string value, int maxLen)
        => value.Length <= maxLen ? value : value[..maxLen] + "...";
}
