using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// 删线路之前先问一句：还有没有在途的任务正等着这条线路把结果取回来。
///
/// 为什么非问不可：视频任务提交成功后，选中的线路 id 会被**写进任务自己的文档**
/// （direct 模式写在任务根上，storyboard 模式逐镜写在分镜上），后续轮询与下载都靠它
/// 精确回到同一个上游。删掉逻辑模型会连着删掉它名下的全部线路，于是一个已经被上游受理、
/// 甚至已经计费的任务，会在下一次轮询时找不到线路而失败——用户侧看到的是「任务凭空坏了」，
/// 而操作者只是删了一条看起来没人用的模型。
///
/// 判据故意**失败即拦**：状态不在终态清单里的一律算在途，包括历史脏数据里那些不认识的状态。
/// 这是一个不可逆动作的前置闸，宁可多拦一次让人去看看，也不要漏放一次把在途任务删掉。
///
/// 权威定义在 <c>prd-api/src/PrdAgent.Core/Models/VideoGenModels.cs</c>（VideoGenRun /
/// VideoSceneItem / VideoGenRunStatus）与 <c>MongoDbContext.VideoGenRuns</c>。本项目按既定架构
/// 不引用 PrdAgent.*，所以这里是一份镜像，由 <c>OfferingReferencePolicyMirrorTests</c> 逐项对照：
/// 字段改名会让这里的过滤器一条都匹配不上（静默退化成「没有引用」，正好放行它本该拦的那次删除），
/// 新增一个状态而没归类会让「不在终态里」把它误判成在途——两种都由镜像测试在 CI 上拦下。
/// </summary>
public static class OfferingReferencePolicy
{
    /// <summary>视频任务集合（在 MAP 库，不在网关库）。</summary>
    public const string VideoRunCollectionName = "video_gen_runs";

    /// <summary>direct 模式：任务根上记着提交成功的线路。</summary>
    public const string VideoRunRootOfferingField = "DirectVideoOfferingId";

    /// <summary>storyboard 模式：每个分镜各自记着自己那条线路。</summary>
    public const string VideoRunSceneOfferingField = "Scenes.OfferingId";

    /// <summary>任务状态字段。</summary>
    public const string VideoRunStatusField = "Status";

    /// <summary>
    /// 终态：走到这几个状态的任务不会再回上游取东西，线路删了也不影响它。
    /// 其余一律算在途（见类注释：失败即拦）。
    /// </summary>
    public static readonly string[] TerminalVideoRunStatuses = ["Completed", "Failed", "Cancelled"];

    /// <summary>
    /// 还没走到终态、且引用了这几条线路中任意一条的任务。
    /// 线路清单为空时返回 null——没有线路就没有引用，不必白跑一次查询。
    /// </summary>
    /// <summary>直连视频任务的归属表。任务提交后把 OfferingId 记在这里，留 7 天。</summary>
    public const string DirectVideoOwnershipCollectionName = "direct_video_job_ownerships";

    public const string DirectVideoOwnershipOfferingField = "OfferingId";
    public const string DirectVideoOwnershipExpiresField = "ExpiresAt";
    public const string DirectVideoOwnershipRevokedField = "RevokedAt";

    /// <summary>
    /// 还能被取结果的**直连**视频任务：没过保留期、没被撤销，且它记着的正是这几条线路。
    ///
    /// 为什么非要单独一张表：走 videogen-direct 提交的任务不进 video_gen_runs，它的 OfferingId
    /// 只落在这张归属表里。只查 run 表的话，这类任务对删除闸完全不可见——删掉之后，
    /// 那些已经提交（有的已经计费）的任务再去查状态或取内容时，拿着保留下来的 OfferingId
    /// 解析不到任何上游（第 74 轮 review；形状 1：判据只覆盖了两个来源里的一个）。
    ///
    /// 判据用「没过期且没撤销」而不是任务状态：这张表本来就只保留 7 天，过期或撤销之后
    /// 那条取结果的路自己也走不通了，再拦就是无谓地挡住删除。
    /// </summary>
    public static FilterDefinition<BsonDocument>? BuildLiveDirectVideoJobFilter(
        IReadOnlyCollection<string> offeringIds,
        DateTime nowUtc)
    {
        if (offeringIds.Count == 0) return null;
        var fb = Builders<BsonDocument>.Filter;
        return fb.And(
            fb.In(DirectVideoOwnershipOfferingField, offeringIds),
            fb.Gt(DirectVideoOwnershipExpiresField, nowUtc),
            fb.Or(
                fb.Eq(DirectVideoOwnershipRevokedField, BsonNull.Value),
                fb.Not(fb.Exists(DirectVideoOwnershipRevokedField))));
    }

    public static FilterDefinition<BsonDocument>? BuildInFlightVideoRunFilter(IReadOnlyCollection<string> offeringIds)
    {
        if (offeringIds.Count == 0) return null;
        var fb = Builders<BsonDocument>.Filter;
        return fb.And(
            fb.Nin(VideoRunStatusField, TerminalVideoRunStatuses),
            fb.Or(
                fb.In(VideoRunRootOfferingField, offeringIds),
                fb.In(VideoRunSceneOfferingField, offeringIds)));
    }
}
