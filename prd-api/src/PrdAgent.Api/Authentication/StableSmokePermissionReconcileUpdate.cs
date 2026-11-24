using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Authentication;

/// <summary>
/// 稳定冒烟账号补齐权限的那一条 Mongo 更新，抽成独立方法只为一件事：能拿真 Mongo 跑它。
///
/// 2026-09-15 事故复盘：第一版用 <c>$addToSet</c> / <c>$pullAll</c>，这两个操作符遇到值为 BSON null 的字段
/// 会让整条更新报错（"Cannot apply $addToSet to non-array field"）。而事故账号 <c>stsmk_cds</c> 是 09-01
/// 由旧构建自动开的号，<c>PermAllow</c> / <c>PermDeny</c> 都是 null；新开的号 <c>PermDeny</c> 同样是 null。
/// 于是补齐动作在真实数据上一次都跑不通，只是异常发生在认证处理器里，对外又是一次「无权限」。
///
/// 改用聚合管道更新：<c>$ifNull</c> 把 null / 缺失当空数组，放行清单只追加缺项且保留既有顺序，
/// 拒绝清单只摘矩阵要求的项。仍然是单文档原子操作，管理员同时改别的放行 / 拒绝项不会被覆盖。
/// </summary>
public static class StableSmokePermissionReconcileUpdate
{
    /// <param name="grant">要补进 PermAllow 的权限点（已确认缺失的那几项）。</param>
    /// <param name="release">要从 PermDeny 摘掉的权限点（矩阵要求的全集）。</param>
    public static UpdateDefinition<User> Build(IReadOnlyCollection<string> grant, IReadOnlyCollection<string> release)
    {
        var currentAllow = new BsonDocument("$ifNull", new BsonArray { "$PermAllow", new BsonArray() });
        var currentDeny = new BsonDocument("$ifNull", new BsonArray { "$PermDeny", new BsonArray() });

        // 既有顺序不动，只把还没有的项追加到末尾（$setUnion 会打乱顺序，这里刻意不用）。
        var allowExpr = new BsonDocument("$concatArrays", new BsonArray
        {
            currentAllow,
            new BsonDocument("$filter", new BsonDocument
            {
                { "input", new BsonArray(grant) },
                { "as", "item" },
                { "cond", new BsonDocument("$not", new BsonArray { new BsonDocument("$in", new BsonArray { "$$item", currentAllow }) }) },
            }),
        });
        var denyExpr = new BsonDocument("$filter", new BsonDocument
        {
            { "input", currentDeny },
            { "as", "item" },
            { "cond", new BsonDocument("$not", new BsonArray { new BsonDocument("$in", new BsonArray { "$$item", new BsonArray(release) }) }) },
        });

        var stage = new BsonDocument("$set", new BsonDocument
        {
            { nameof(User.PermAllow), allowExpr },
            { nameof(User.PermDeny), denyExpr },
        });
        return Builders<User>.Update.Pipeline(PipelineDefinition<User, User>.Create(new[] { stage }));
    }
}
