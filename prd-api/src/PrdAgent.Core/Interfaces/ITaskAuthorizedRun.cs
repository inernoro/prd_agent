namespace PrdAgent.Core.Interfaces;

/// <summary>服务端持久任务必须保存准入引用；引用不能从 JSON 请求输入或输出。</summary>
public interface ITaskAuthorizedRun
{
    string? TaskPermitId { get; set; }
}
