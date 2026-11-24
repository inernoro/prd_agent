namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 上传解包进度的读写通道。
///
/// 为什么需要它：上传站点是一次同步 POST，前端在等这个响应，没法同时收 SSE。
/// 但 ZIP 解包 + 逐文件传 COS 在服务端可能跑几十秒（2000+ 文件的构建产物很常见），
/// 这段时间前端只知道「字节送完了」，不知道服务端在干什么、还有多久——
/// 用户看到的就是一根满进度条 + 一个计时器（expectation-management 里的「不知道还要多久」）。
///
/// 做法是让前端在 POST 之前自己生成一个 uploadId 随表单发过来，服务端解包时把进度
/// 写进 Redis，前端另开一路轮询去读。刻意**不**改 POST 的返回契约：
/// 现有调用方（拖拽上传、其他 Agent 走 API 建站）不传 uploadId 就完全不受影响。
/// </summary>
public interface IUploadProgressService
{
    /// <summary>
    /// 记一次进度。uploadId 为空直接跳过（老调用方不传，等于不记录）。
    /// 这个方法在解包循环里被高频调用，实现必须自己做节流并吞掉所有异常——
    /// 进度是辅助信息，Redis 抖一下不该让上传本身失败。
    /// </summary>
    Task ReportAsync(string? uploadId, UploadProgressSnapshot snapshot, CancellationToken ct = default);

    /// <summary>读一次进度；没有记录（还没开始 / 已过期）返回 null。</summary>
    Task<UploadProgressSnapshot?> GetAsync(string uploadId, CancellationToken ct = default);

    /// <summary>标记这次上传彻底结束，让轮询方立刻停下而不是等 TTL。</summary>
    Task CompleteAsync(string? uploadId, CancellationToken ct = default);
}

/// <summary>
/// 服务端解包的一帧进度。字段全部来自解包循环里的真实计数，没有估算值——
/// 算不出来的就是 null，前端据此不显示，而不是显示一个编的数
/// （no-rootless-tree：拉不到就说拉不到）。
/// </summary>
public class UploadProgressSnapshot
{
    /// <summary>已处理完（解出并传到对象存储）的文件数</summary>
    public int DoneFiles { get; set; }

    /// <summary>这个包里一共有几个有效文件。ZIP 的条目表一开始就能全部读出来，所以这是真实总数。</summary>
    public int TotalFiles { get; set; }

    /// <summary>已识别到的入口文件名；还没扫到就是 null（不猜 index.html）</summary>
    public string? EntryFile { get; set; }

    /// <summary>正在处理的那个文件的相对路径</summary>
    public string? CurrentPath { get; set; }

    /// <summary>正在处理的那个文件的字节数</summary>
    public long CurrentSize { get; set; }

    /// <summary>true = 这次上传已结束（成功或失败），轮询方该停了</summary>
    public bool Finished { get; set; }
}
