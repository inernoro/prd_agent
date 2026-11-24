using System.Text.Json;

namespace PrdAgent.Api.Services;

/// <summary>
/// 已经翻译成「用户看得懂、知道下一步做什么」的同步失败。
/// 抛这个类型就等于声明：这条消息可以原样落到条目上给用户看。
/// 其余任何异常都算内部细节，只进服务端日志。
/// </summary>
public sealed class GitHubSyncUserFacingException : Exception
{
    public GitHubSyncUserFacingException(string message) : base(message) { }
}

/// <summary>
/// 兜底异常 → 用户可执行文案（external-cause-first：外因与下一步在前，技术细节只进日志）。
///
/// 为什么需要它：目录同步的兜底 catch 原来把 <c>ex.Message</c> 直接写进条目的
/// SyncError，而那一栏会原样渲染到目录卡片上。分类过的失败（列目录、凭据、部分失败）
/// 本来就是可执行文案，但 JSON 解析异常、Mongo 异常、空引用之类会把实现细节和基础设施
/// 诊断摆到用户面前——他既看不懂也无从处置。
///
/// 分支只列「说得出更具体下一步」的那几类；其余（含 Mongo 写入异常）落默认分支，
/// 默认分支同样给得出下一步，不会退化成一个无法处置的名词。
/// </summary>
public static class GitHubSyncFailureMessage
{
    /// <summary>兜底异常转用户文案；已分类的失败原样返回。</summary>
    public static string Describe(Exception ex) => ex switch
    {
        GitHubSyncUserFacingException => ex.Message,
        TaskCanceledException => "同步超时：GitHub 一直没有响应。请稍后点「重试同步」。",
        HttpRequestException => "连接 GitHub 失败：网络不通或 GitHub 暂时不可用。请稍后点「重试同步」。",
        JsonException => "GitHub 返回的数据无法解析，多半是接口临时异常。请稍后点「重试同步」；一直如此就把这条目录的仓库与路径发给管理员。",
        _ => "同步失败：服务端内部错误，详情已记入服务端日志。请稍后点「重试同步」；一直如此就把这条目录的仓库与路径发给管理员。",
    };
}
