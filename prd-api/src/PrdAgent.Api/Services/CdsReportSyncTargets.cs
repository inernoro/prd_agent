using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>本轮要刷新的一个镜像库，以及它该从哪个 CDS 拉。</summary>
/// <param name="StoreId">目标知识库 id。**必须显式传给导入服务**，否则它会 find-or-create，
/// 同一个人有两个镜像库时只刷得到其中一个。</param>
/// <param name="OwnerId">库的属主。导入服务用它做写入鉴权。</param>
/// <param name="SourceBaseUrl">这个库上次是从哪个 CDS 同步的；null = 还没记过，退回默认解析。</param>
public readonly record struct CdsReportSyncTarget(string StoreId, string OwnerId, string? SourceBaseUrl);

/// <summary>
/// 「刷哪些库、各自从哪个源拉」的判据。
///
/// **单独一个文件、只依赖 Core 模型**，是为了让它能被测试项目直接 link 进去跑
///（<c>CdsReportImportWorker</c> 本体拖着 BackgroundService / Mongo / 导入服务，
/// 整个搬进测试项目代价太大）。判据在这里，回归也钉在这里。
/// </summary>
public static class CdsReportSyncTargets
{
    /// <summary>
    /// 决定本轮刷哪些库、各自从哪个源拉。纯函数。
    ///
    /// 第一版是按 OwnerId 去重再用空 options 调导入，两件事都错了：
    ///
    /// 一是同一个人有两个镜像库时，find-or-create 只会命中其中一个，另一个永远不刷新，
    /// 而且看不出来——它只是一直是旧的。
    ///
    /// 二是更要命的——空 options 会让导入服务挑「最近更新的那条 active CDS 连接」。
    /// 装了两条系统互联时，它可能从 CDS-B 拉报告，写进一个来源记着 CDS-A 的库里；
    /// 两个来源的报告 id 与正文就此混进同一个镜像，每小时自动混一次，而且没有任何地方
    /// 会报错——报告 id 在不同 CDS 上可以重名，混完连「这条是谁家的」都答不上来
    ///（Codex review P1）。
    ///
    /// 所以每个库都带着自己记着的来源去同步：**库是什么源，就只从那个源拉**；源没了就让
    /// 这个库这轮失败，也不换一个源接着拉。
    /// </summary>
    public static List<CdsReportSyncTarget> Build(IEnumerable<DocumentStore> stores)
    {
        var targets = new List<CdsReportSyncTarget>();
        foreach (var s in stores)
        {
            if (s == null) continue;
            // 缺属主就没法做写入鉴权，缺 id 就只能 find-or-create——两种都不该硬着头皮同步。
            if (string.IsNullOrWhiteSpace(s.Id) || string.IsNullOrWhiteSpace(s.OwnerId)) continue;
            // 空白来源 = 这个库还没记下它从哪来（历史数据）。退回默认解析，与手动导入首次
            // 的行为一致；导入成功后服务会把来源写回库上，下一轮就钉住了。
            var source = string.IsNullOrWhiteSpace(s.PeerSyncNodeBaseUrl) ? null : s.PeerSyncNodeBaseUrl!.Trim();
            targets.Add(new CdsReportSyncTarget(s.Id, s.OwnerId, source));
        }
        return targets;
    }
}
