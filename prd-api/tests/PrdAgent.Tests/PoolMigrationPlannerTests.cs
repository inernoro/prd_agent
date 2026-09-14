using MongoDB.Bson;
using PrdAgent.LlmGw.Provisioning;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 存量模型池搬成模型的判据。
///
/// 搬迁只跑一次，跑错了拿回来的是脏数据，所以这几条用的是**行为断言**而不是字面量断言。
/// </summary>
public class PoolMigrationPlannerTests
{
    private static BsonDocument Pool(string? code = "default-generation", int strategy = 0,
        bool isDefault = false, int? priority = null, params BsonDocument[] members)
    {
        var doc = new BsonDocument
        {
            { "_id", "pool-1" }, { "Name", "图片生成默认池" }, { "ModelType", "generation" },
            { "StrategyType", strategy }, { "IsDefaultForType", isDefault },
            { "Models", new BsonArray(members) },
        };
        if (code is not null) doc["Code"] = code;
        if (priority is not null) doc["Priority"] = priority.Value;
        return doc;
    }

    private static BsonDocument Member(string modelId = "gpt-image-1", int? priority = null)
    {
        var m = new BsonDocument { { "ModelId", modelId }, { "PlatformId", "p1" } };
        if (priority is not null) m["Priority"] = priority.Value;
        return m;
    }

    [Fact]
    public void 公开名取池的Code不取Name()
    {
        // 调用方一直按 Code 请求；换成 Name 等于在搬迁这一步悄悄改了对外契约。
        Assert.Equal("default-generation", PoolMigrationPlanner.ToPublicId(Pool()));
        Assert.Equal("chat-main", PoolMigrationPlanner.ToPublicId(Pool(code: "chat-main")));
    }

    [Fact]
    public void 没有合法Code的池不搬()
    {
        // 搬过去也没有调用方能请求到它，只会在白名单里多一条死记录
        Assert.Equal(string.Empty, PoolMigrationPlanner.ToPublicId(Pool(code: null)));
        Assert.Equal(string.Empty, PoolMigrationPlanner.ToPublicId(Pool(code: "")));
        Assert.Equal(string.Empty, PoolMigrationPlanner.ToPublicId(Pool(code: "a")));
        // 首字符必须是字母或数字，与逻辑模型 PublicId 的校验一致
        Assert.Equal(string.Empty, PoolMigrationPlanner.ToPublicId(Pool(code: "-bad")));
    }

    [Fact]
    public void 只有加权随机映射成weighted其余都是priority()
    {
        // 池有六种策略，逻辑模型只有两种。真正跑在请求链路上的只有「按优先级挑、挂了换下一个」
        // 与「按权重分流」，另外四种是那套生产上没人调的调度空壳里的枚举。
        Assert.Equal("weighted", PoolMigrationPlanner.ToRoutingStrategy(Pool(strategy: 4)));
        foreach (var other in new[] { 0, 1, 2, 3, 5 })
            Assert.Equal("priority", PoolMigrationPlanner.ToRoutingStrategy(Pool(strategy: other)));
    }

    [Fact]
    public void 兜底标记原样搬过去()
    {
        Assert.True(PoolMigrationPlanner.IsDefaultForType(Pool(isDefault: true)));
        Assert.False(PoolMigrationPlanner.IsDefaultForType(Pool(isDefault: false)));
        // 字段缺失按「不是默认」——不能猜，猜错就是悄悄换掉兜底模型
        var noField = Pool();
        noField.Remove("IsDefaultForType");
        Assert.False(PoolMigrationPlanner.IsDefaultForType(noField));
    }

    [Fact]
    public void 成员优先级缺失按100不按0()
    {
        Assert.Equal(3, PoolMigrationPlanner.MemberPriority(Member(priority: 3)));
        // 0 会让这条线路无声地抢到发送队列首位，那不是「没配」该有的后果
        Assert.Equal(100, PoolMigrationPlanner.MemberPriority(Member()));
        Assert.Equal(100, PoolMigrationPlanner.MemberPriority(Member(priority: 0)));
    }

    [Fact]
    public void 能力从池成员快照里取不能是空集合()
    {
        // 这个洞是影子比对在真实环境上抓出来的：搬过去的模型能力为空，能力门一律不放行，
        // 于是搬迁报成功、调用方却调不到它，请求默默回落到池。
        var withCaps = Pool(members: new BsonDocument
        {
            { "ModelId", "gpt-image-1" }, { "PlatformId", "p1" },
            { "Capabilities", new BsonArray(new[]
                {
                    new BsonDocument { { "Type", "image_generation" }, { "Value", true } },
                    // Value=false 是「明确不具备」，不是「没说」，不能当成具备
                    new BsonDocument { { "Type", "video_generation" }, { "Value", false } },
                }) },
        });
        var caps = PoolMigrationPlanner.CollectCapabilities(withCaps);
        Assert.Contains("image_generation", caps);
        Assert.DoesNotContain("video_generation", caps);

        // 成员一条快照都没有时退到这个用途的基线能力，而不是交出空集合
        Assert.Equal(new[] { "image_generation" }, PoolMigrationPlanner.CollectCapabilities(Pool(members: Member())));
        var chat = Pool(members: Member());
        chat["ModelType"] = "chat";
        Assert.Equal(new[] { "chat" }, PoolMigrationPlanner.CollectCapabilities(chat));
    }

    [Fact]
    public void 搬迁默认试运行且不动旧表也能重复跑()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var start = console.IndexOf("app.MapPost(\"/gw/pools/migrate-to-models\"", StringComparison.Ordinal);
        Assert.True(start >= 0, "搬迁端点不存在");
        var end = console.IndexOf("}).RequireAuthorization", start, StringComparison.Ordinal);
        Assert.True(end > start);
        var handler = console[start..end];

        // 默认试运行：搬迁只跑一次，不该由一次手滑决定
        Assert.Contains("var dryRun = apply != true;", handler);
        Assert.Contains("if (!dryRun)", handler);

        // 只读旧表：llmgw_model_pools 一个字节都不动，回退就是把新建的删掉
        Assert.DoesNotContain("gwModelPools.UpdateOne", handler);
        Assert.DoesNotContain("gwModelPools.DeleteOne", handler);
        Assert.DoesNotContain("gwModelPools.InsertOne", handler);
        Assert.Contains("gwModelPools.Find(", handler);

        // 可重复跑：同名模型只补线路，同一条线路不重复建
        Assert.Contains("if (duplicate) continue;", handler);
        Assert.Contains("result.LinkedToExisting++", handler);

        // 健康状态不搬：搬一个几个月前的「不可用」过来，新路径一上来就少一条线路
        Assert.Contains("{ \"HealthStatus\", 0 }", handler);

        // 跳过要给原因，不能静默吞掉
        Assert.Contains("result.Skipped.Add", handler);

        // 能力必须从池成员快照里取：传 null 得到空集合，空能力的模型能力门不放行
        Assert.Contains("PoolMigrationPlanner.CollectCapabilities(pool)", handler);
        Assert.DoesNotContain("NormalizeDetailed(modelType, null)", handler);

        // 同用途最多一个默认：搬迁是直接 Insert，绕过了 PUT 端点那条互斥。
        // 不在这里再走一遍同一条规则，就是判据分裂成两份各自漂移——这一整项工程要消灭的正是它。
        Assert.Contains("fb.Eq(\"IsDefaultForType\", true)", handler);
        Assert.Contains("entry.IsDefaultForType = false;", handler);
        Assert.Contains("同用途只能有一个默认", handler);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }

    [Fact]
    public void 空池与无名池都要报出跳过原因()
    {
        // 静默跳过等于让人以为都搬完了
        Assert.Null(PoolMigrationPlanner.SkipReason(Pool(members: Member())));

        var noCode = PoolMigrationPlanner.SkipReason(Pool(code: null, members: Member()));
        Assert.NotNull(noCode);
        Assert.Contains("对外标识", noCode);

        var empty = PoolMigrationPlanner.SkipReason(Pool());
        Assert.NotNull(empty);
        Assert.Contains("一个成员都没有", empty);
    }
}
