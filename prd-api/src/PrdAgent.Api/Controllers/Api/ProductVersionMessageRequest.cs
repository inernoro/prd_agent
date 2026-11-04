namespace PrdAgent.Api.Controllers.Api;

/// <summary>产品管理版本消息解析请求；不扩展产品评审智能体接口。</summary>
public sealed class ParseProductVersionMessageRequest
{
    public string? Kind { get; set; }
    public string? Text { get; set; }
}
