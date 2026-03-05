using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 内部工作流执行服务（v2.0）：允许其他 Agent（如 Report Agent）以编程方式触发工作流执行并等待完成。
/// </summary>
public interface IWorkflowExecutionService
{
    /// <summary>
    /// 内部触发工作流执行。
    /// </summary>
    /// <param name="workflowId">工作流 ID</param>
    /// <param name="variables">运行时变量覆盖</param>
    /// <param name="triggeredBy">触发者标识（如 "report-agent-system"）</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>创建的执行实例</returns>
    Task<WorkflowExecution> ExecuteInternalAsync(
        string workflowId,
        Dictionary<string, string>? variables = null,
        string triggeredBy = "system",
        CancellationToken ct = default);

    /// <summary>
    /// 等待工作流执行完成（轮询 DB 状态）。
    /// </summary>
    /// <param name="executionId">执行 ID</param>
    /// <param name="timeout">最大等待时间</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>完成后的执行实例</returns>
    /// <exception cref="TimeoutException">超时未完成</exception>
    /// <exception cref="InvalidOperationException">执行失败</exception>
    Task<WorkflowExecution> WaitForCompletionAsync(
        string executionId,
        TimeSpan timeout,
        CancellationToken ct = default);
}
