using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Arena;

[Trait("Category", "Integration")]
public sealed class ArenaReferenceIntegrityTests
{
    [Fact]
    public async Task DeletedPlatformSlotIsRejectedBeforeQueueAndRetainedForRepair()
    {
        await using var f = new Fixture();
        var slot = new ArenaSlot { Group = "group", PlatformId = "deleted", ModelId = "old-model" };
        await f.Db.ArenaSlots.InsertOneAsync(slot);
        var result = await f.Controller.CreateRun(Request(slot), CancellationToken.None);
        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Equal("deleted", (await f.Db.ArenaSlots.Find(x => x.Id == slot.Id).SingleAsync()).PlatformId);
        f.Queue.VerifyNoOtherCalls();
        f.Store.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task RunIgnoresClientModelOverridesAndUsesStoredLogicalIdentity()
    {
        await using var f = new Fixture();
        var slot = new ArenaSlot { Group = "group", LogicalModelId = "logical-id", PlatformId = "logical-model", ModelId = "old-public-name" };
        await f.Db.ArenaSlots.InsertOneAsync(slot);
        RunMeta? written = null;
        f.Store.Setup(x => x.SetRunAsync(RunKinds.Arena, It.IsAny<RunMeta>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()))
            .Callback<string, RunMeta, TimeSpan?, CancellationToken>((_, meta, _, _) => written = meta).Returns(Task.CompletedTask);
        f.Queue.Setup(x => x.EnqueueAsync(RunKinds.Arena, It.IsAny<string>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var result = await f.Controller.CreateRun(Request(slot), CancellationToken.None);
        Assert.IsType<OkObjectResult>(result);
        using var doc = JsonDocument.Parse(written!.InputJson!);
        var queued = doc.RootElement.GetProperty("slots")[0];
        Assert.Equal("logical-id", queued.GetProperty("logicalModelId").GetString());
        Assert.Equal("current-public-name", queued.GetProperty("modelId").GetString());
        Assert.Equal("logical-model", queued.GetProperty("platformId").GetString());
    }

    [Fact]
    public async Task ExplicitRepairPreservesSlotIdentityAndHistory()
    {
        await using var f = new Fixture();
        var slot = new ArenaSlot { Group = "group", PlatformId = "deleted", ModelId = "old-model", DisplayName = "旧模型", SortOrder = 21 };
        await f.Db.ArenaSlots.InsertOneAsync(slot);
        var battle = new ArenaBattle { GroupKey = "group", Responses = [new ArenaBattleResponse { SlotId = slot.Id, PlatformId = "deleted", ModelId = "old-model" }] };
        await f.Db.ArenaBattles.InsertOneAsync(battle);
        var result = await f.Controller.UpdateSlot(slot.Id, new UpsertArenaSlotRequest { LogicalModelId = "logical-id" }, CancellationToken.None);
        Assert.IsType<OkObjectResult>(result);
        var repaired = await f.Db.ArenaSlots.Find(x => x.Id == slot.Id).SingleAsync();
        Assert.Equal(slot.CreatedAt.Ticks / TimeSpan.TicksPerMillisecond, repaired.CreatedAt.Ticks / TimeSpan.TicksPerMillisecond);
        Assert.Equal("logical-id", repaired.LogicalModelId);
        Assert.Equal("group", repaired.Group);
        Assert.Equal(21, repaired.SortOrder);
        Assert.Equal("old-model", (await f.Db.ArenaBattles.Find(x => x.Id == battle.Id).SingleAsync()).Responses[0].ModelId);
    }

    [Fact]
    public async Task CannotCreateOrEnableStalePhysicalReference()
    {
        await using var f = new Fixture();
        var create = await f.Controller.CreateSlot(new UpsertArenaSlotRequest { Group = "group", DisplayName = "旧", PlatformId = "deleted", ModelId = "current-public-name" }, CancellationToken.None);
        Assert.IsType<BadRequestObjectResult>(create);
        var slot = new ArenaSlot { Group = "group", PlatformId = "deleted", ModelId = "old", Enabled = false };
        await f.Db.ArenaSlots.InsertOneAsync(slot);
        Assert.IsType<BadRequestObjectResult>(await f.Controller.ToggleSlot(slot.Id, CancellationToken.None));
        Assert.False((await f.Db.ArenaSlots.Find(x => x.Id == slot.Id).SingleAsync()).Enabled);
    }

    [Fact]
    public async Task DirectoryFailureKeepsStoredConfigurationVisibleAsUnknown()
    {
        await using var f = new Fixture();
        var slot = new ArenaSlot { Group = "group", PlatformId = "deleted", ModelId = "old-model" };
        await f.Db.ArenaSlots.InsertOneAsync(slot);
        f.Gateway.Setup(x => x.GetAvailablePoolsAsync(AppCallerRegistry.Desktop.Arena.BattleChat, ModelTypes.Chat, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new HttpRequestException("directory down"));
        var result = Assert.IsType<OkObjectResult>(await f.Controller.ListSlots("group", CancellationToken.None));
        var json = JsonSerializer.Serialize(result.Value);
        Assert.Contains("unknown", json);
        Assert.Contains("old-model", json);
        Assert.Equal("deleted", (await f.Db.ArenaSlots.Find(x => x.Id == slot.Id).SingleAsync()).PlatformId);
    }

    [Fact]
    public async Task RepairRejectsConcurrentConfigurationChangeInsteadOfOverwritingIt()
    {
        await using var f = new Fixture();
        var slot = new ArenaSlot { Group = "group", PlatformId = "deleted", ModelId = "old-model", DisplayName = "原名" };
        await f.Db.ArenaSlots.InsertOneAsync(slot);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<List<AvailableModelPool>>(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Gateway.Setup(x => x.GetAvailablePoolsAsync(AppCallerRegistry.Desktop.Arena.BattleChat, ModelTypes.Chat, It.IsAny<CancellationToken>()))
            .Returns(() => { entered.TrySetResult(); return release.Task; });
        var repair = f.Controller.UpdateSlot(slot.Id, new() { LogicalModelId = "logical-id" }, CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await f.Db.ArenaSlots.UpdateOneAsync(x => x.Id == slot.Id, Builders<ArenaSlot>.Update.Set(x => x.DisplayName, "另一个编辑").Set(x => x.UpdatedAt, DateTime.UtcNow.AddSeconds(1)));
        release.SetResult([new AvailableModelPool { Id = "logical-id", Code = "current-public-name", ResolutionType = "LogicalModel", Models = [new PoolModelInfo { HealthStatus = "Healthy" }] }]);
        Assert.IsType<ConflictObjectResult>(await repair);
        Assert.Equal("另一个编辑", (await f.Db.ArenaSlots.Find(x => x.Id == slot.Id).SingleAsync()).DisplayName);
    }

    private static CreateArenaRunRequest Request(ArenaSlot slot) => new() {
        Prompt = "测试", GroupKey = "group", Slots = [new() { SlotId = slot.Id, PlatformId = "forged", ModelId = "forged", Label = "A" }] };

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly string _database = "arena_reference_test_" + Guid.NewGuid().ToString("N");
        private readonly MongoClient _client;
        public MongoDbContext Db { get; }
        public Mock<IRunQueue> Queue { get; } = new(MockBehavior.Strict);
        public Mock<IRunEventStore> Store { get; } = new(MockBehavior.Strict);
        public ArenaController Controller { get; }
        public Mock<ILlmGateway> Gateway { get; } = new(MockBehavior.Strict);
        public Fixture()
        {
            var uri = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27912";
            _client = new MongoClient(uri);
            Db = new MongoDbContext(uri, _database);
            var gateway = Gateway;
            gateway.Setup(x => x.GetAvailablePoolsAsync(AppCallerRegistry.Desktop.Arena.BattleChat, ModelTypes.Chat, It.IsAny<CancellationToken>()))
                .ReturnsAsync([new AvailableModelPool { Id = "logical-id", Code = "current-public-name", Name = "当前模型", ResolutionType = "LogicalModel", Models = [new PoolModelInfo { HealthStatus = "Healthy" }] }]);
            Controller = new ArenaController(Db, Store.Object, Queue.Object, new BusinessModelReferenceService(gateway.Object)) {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "test-user")], "test")) } }
            };
        }
        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_database);
    }
}
