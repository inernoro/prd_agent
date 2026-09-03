namespace PrdAgent.Core.Models;

/// <summary>
/// 发布收尾时发现占坑租约已经不在本次调用手上（被别人抢走，或那条占位记录被撤回了）。
///
/// 单独一个异常类型而不是复用 InvalidOperationException：调用方要据此回一个「稍后重试」，
/// 而不是 500。拿通用异常去 catch 会把同一段里别的编程错误一起吞掉，那种吞法迟早让一个
/// 真 bug 被当成「正常的重试提示」报给用户。
/// </summary>
public sealed class PublishLeaseLostException : Exception
{
    public PublishLeaseLostException(string message) : base(message) { }
}
