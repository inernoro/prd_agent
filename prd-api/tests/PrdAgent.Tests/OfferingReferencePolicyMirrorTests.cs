using System.Reflection;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 控制台删线路前那道「还有没有在途任务在用」的闸，判的是 MAP 这一侧的视频任务。
/// 控制台按既定架构不引用 PrdAgent.*，所以它那份是镜像；这里逐项对照。
///
/// 这道闸失效的方式是**静默的**：字段改个名，过滤器一条都匹配不上，于是「没有引用」，
/// 删除照常放行——正是它本该拦下的那一次（形状 10：退路不报错，只是不再成立）。
/// 所以对照的是字段名与状态花名册这两样会漂的东西，不是文案。
/// </summary>
public class OfferingReferencePolicyMirrorTests
{
    [Fact]
    public void 过滤器认的字段在视频任务实体上真的存在()
    {
        Assert.NotNull(typeof(VideoGenRun).GetProperty(
            OfferingReferencePolicy.VideoRunRootOfferingField, BindingFlags.Public | BindingFlags.Instance));
        Assert.NotNull(typeof(VideoGenRun).GetProperty(
            OfferingReferencePolicy.VideoRunStatusField, BindingFlags.Public | BindingFlags.Instance));

        // storyboard 那一支是嵌套路径「分镜数组.线路字段」，两段都要对得上。
        var parts = OfferingReferencePolicy.VideoRunSceneOfferingField.Split('.');
        Assert.Equal(2, parts.Length);
        var scenes = typeof(VideoGenRun).GetProperty(parts[0], BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(scenes);
        var sceneType = scenes!.PropertyType.IsGenericType
            ? scenes.PropertyType.GetGenericArguments()[0]
            : scenes.PropertyType;
        Assert.NotNull(sceneType.GetProperty(parts[1], BindingFlags.Public | BindingFlags.Instance));
    }

    [Fact]
    public void 视频任务集合名两侧同一个()
    {
        var source = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Infrastructure", "Database", "MongoDbContext.cs"));
        Assert.Contains(
            $"GetCollection<VideoGenRun>(\"{OfferingReferencePolicy.VideoRunCollectionName}\")",
            source,
            StringComparison.Ordinal);
    }

    [Fact]
    public void 新增一个任务状态就必须回来决定它算不算终态()
    {
        /*
          判据是「不在终态清单里的一律算在途」，所以新增一个状态会被默认当成在途——
          方向是安全的（多拦一次），但如果那个新状态其实是终态，它会永久挡住删除而没人知道原因。
          花名册对不上就红，逼着加状态的人回到这里表个态。
        */
        string[] roster =
        [
            VideoGenRunStatus.Queued,
            VideoGenRunStatus.Scripting,
            VideoGenRunStatus.Editing,
            VideoGenRunStatus.Rendering,
            VideoGenRunStatus.Completed,
            VideoGenRunStatus.Failed,
            VideoGenRunStatus.Cancelled,
        ];
        var actual = typeof(VideoGenRunStatus)
            .GetFields(BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy)
            .Where(f => f is { IsLiteral: true, IsInitOnly: false } && f.FieldType == typeof(string))
            .Select(f => (string)f.GetRawConstantValue()!)
            .ToHashSet(StringComparer.Ordinal);

        Assert.Equal(roster.ToHashSet(StringComparer.Ordinal), actual);
        Assert.All(
            OfferingReferencePolicy.TerminalVideoRunStatuses,
            status => Assert.Contains(status, actual));
        Assert.Equal(
            new HashSet<string>(
                [VideoGenRunStatus.Completed, VideoGenRunStatus.Failed, VideoGenRunStatus.Cancelled],
                StringComparer.Ordinal),
            OfferingReferencePolicy.TerminalVideoRunStatuses.ToHashSet(StringComparer.Ordinal));
    }

    [Fact]
    public void 没有线路就不必白跑一次任务查询()
    {
        Assert.Null(OfferingReferencePolicy.BuildInFlightVideoRunFilter(Array.Empty<string>()));
        Assert.NotNull(OfferingReferencePolicy.BuildInFlightVideoRunFilter(new[] { "gw-offering-1" }));
    }

    internal static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "AGENTS.md")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    [Fact]
    public void 直连视频任务也要算进在途引用()
    {
        /*
          走 videogen-direct 提交的任务不进 video_gen_runs，它的 OfferingId 只落在
          direct_video_job_ownerships 里。只查 run 表的话，这类任务对删除闸完全不可见——
          删掉之后那些已经提交（有的已经计费）的任务再去取结果，拿着保留下来的 OfferingId
          解析不到任何上游（第 74 轮 review；形状 1：判据只覆盖了两个来源里的一个）。
        */
        Assert.Equal("direct_video_job_ownerships", OfferingReferencePolicy.DirectVideoOwnershipCollectionName);

        // 没有线路要查时不构造条件：空 In 会把整张表判成命中，等于谁都删不掉
        Assert.Null(OfferingReferencePolicy.BuildLiveDirectVideoJobFilter([], DateTime.UtcNow));

        var now = new DateTime(2026, 9, 17, 12, 0, 0, DateTimeKind.Utc);
        var rendered = OfferingReferencePolicy
            .BuildLiveDirectVideoJobFilter(["off-1"], now)!
            .Render(new RenderArgs<BsonDocument>(
                BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(),
                BsonSerializer.SerializerRegistry))
            .ToString();

        // 三条都要在：这几条线路的、没过保留期的、没被撤销的
        Assert.Contains("OfferingId", rendered);
        Assert.Contains("ExpiresAt", rendered);
        Assert.Contains("RevokedAt", rendered);
        Assert.Contains("$gt", rendered);

        // 字段名要与 DirectVideoJobOwnership 的实际落库名对得上，
        // 对不上就是一个永远命中不到的条件——闸看着在，其实不设防（形状 8）。
        var model = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/VideoGenModels.cs");
        var at = model.IndexOf("class DirectVideoJobOwnership", StringComparison.Ordinal);
        Assert.True(at > 0);
        var body = model[at..(model.IndexOf("public static string BuildJobNamespace", at, StringComparison.Ordinal))];
        Assert.Contains("public string? OfferingId", body, StringComparison.Ordinal);
        Assert.Contains("public DateTime ExpiresAt", body, StringComparison.Ordinal);
        Assert.Contains("public DateTime? RevokedAt", body, StringComparison.Ordinal);

        // 端点那一侧真的查了这张表，不是只建了个函数（形状 2）
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("directVideoJobOwnerships.CountDocumentsAsync(directJobFilter)", console, StringComparison.Ordinal);
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
}
