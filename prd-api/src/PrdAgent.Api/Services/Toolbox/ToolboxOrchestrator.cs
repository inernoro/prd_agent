using PrdAgent.Core.Models.Toolbox;

namespace PrdAgent.Api.Services.Toolbox;

/// <summary>
/// 百宝箱编排器接口
/// 负责调度多个 Agent 协同工作
/// </summary>
public interface IToolboxOrchestrator
{
    /// <summary>
    /// 执行运行（串行编排）
    /// </summary>
    IAsyncEnumerable<ToolboxRunEvent> ExecuteRunAsync(
        ToolboxRun run,
        CancellationToken ct = default);
}

/// <summary>
/// 百宝箱运行事件
/// </summary>
public class ToolboxRunEvent
{
    public ToolboxRunEventType Type { get; set; }
    public string? StepId { get; set; }
    public int? StepIndex { get; set; }
    public string? AgentKey { get; set; }
    public string? Content { get; set; }
    public ToolboxArtifact? Artifact { get; set; }
    public ToolboxRunStatus? RunStatus { get; set; }
    public ToolboxStepStatus? StepStatus { get; set; }
    public string? ErrorMessage { get; set; }
    public long Seq { get; set; }
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;

    public static ToolboxRunEvent RunStarted(long seq) => new()
    {
        Type = ToolboxRunEventType.RunStarted,
        RunStatus = ToolboxRunStatus.Running,
        Seq = seq
    };

    public static ToolboxRunEvent StepStarted(string stepId, int index, string agentKey, long seq) => new()
    {
        Type = ToolboxRunEventType.StepStarted,
        StepId = stepId,
        StepIndex = index,
        AgentKey = agentKey,
        StepStatus = ToolboxStepStatus.Running,
        Seq = seq
    };

    public static ToolboxRunEvent StepProgress(string stepId, string content, long seq) => new()
    {
        Type = ToolboxRunEventType.StepProgress,
        StepId = stepId,
        Content = content,
        Seq = seq
    };

    public static ToolboxRunEvent StepArtifact(string stepId, ToolboxArtifact artifact, long seq) => new()
    {
        Type = ToolboxRunEventType.StepArtifact,
        StepId = stepId,
        Artifact = artifact,
        Seq = seq
    };

    public static ToolboxRunEvent StepCompleted(string stepId, string? output, long seq) => new()
    {
        Type = ToolboxRunEventType.StepCompleted,
        StepId = stepId,
        Content = output,
        StepStatus = ToolboxStepStatus.Completed,
        Seq = seq
    };

    public static ToolboxRunEvent StepFailed(string stepId, string error, long seq) => new()
    {
        Type = ToolboxRunEventType.StepFailed,
        StepId = stepId,
        ErrorMessage = error,
        StepStatus = ToolboxStepStatus.Failed,
        Seq = seq
    };

    public static ToolboxRunEvent RunCompleted(string? finalResponse, long seq) => new()
    {
        Type = ToolboxRunEventType.RunCompleted,
        Content = finalResponse,
        RunStatus = ToolboxRunStatus.Completed,
        Seq = seq
    };

    public static ToolboxRunEvent RunFailed(string error, long seq) => new()
    {
        Type = ToolboxRunEventType.RunFailed,
        ErrorMessage = error,
        RunStatus = ToolboxRunStatus.Failed,
        Seq = seq
    };
}

public enum ToolboxRunEventType
{
    RunStarted,
    StepStarted,
    StepProgress,
    StepArtifact,
    StepCompleted,
    StepFailed,
    RunCompleted,
    RunFailed
}

/// <summary>
/// 简单编排器实现（串行执行）
/// </summary>
public class SimpleOrchestrator : IToolboxOrchestrator
{
    private readonly IEnumerable<IAgentAdapter> _adapters;
    private readonly ILogger<SimpleOrchestrator> _logger;

    public SimpleOrchestrator(
        IEnumerable<IAgentAdapter> adapters,
        ILogger<SimpleOrchestrator> logger)
    {
        _adapters = adapters;
        _logger = logger;
    }

    public async IAsyncEnumerable<ToolboxRunEvent> ExecuteRunAsync(
        ToolboxRun run,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        long seq = 0;
        var previousOutputs = new Dictionary<string, string>();
        var allArtifacts = new List<ToolboxArtifact>();

        _logger.LogInformation("开始执行 Run: {RunId}, Steps: {StepCount}", run.Id, run.Steps.Count);

        yield return ToolboxRunEvent.RunStarted(++seq);

        foreach (var step in run.Steps.OrderBy(s => s.Index))
        {
            // 查找对应的 Adapter
            var adapter = _adapters.FirstOrDefault(a => a.AgentKey == step.AgentKey);
            if (adapter == null)
            {
                _logger.LogWarning("未找到 Agent 适配器: {AgentKey}", step.AgentKey);
                yield return ToolboxRunEvent.StepFailed(step.StepId, $"未找到 Agent: {step.AgentKey}", ++seq);
                continue;
            }

            // 步骤开始
            yield return ToolboxRunEvent.StepStarted(step.StepId, step.Index, step.AgentKey, ++seq);

            var context = new AgentExecutionContext
            {
                RunId = run.Id,
                StepId = step.StepId,
                UserId = run.UserId,
                UserMessage = run.UserMessage,
                Action = step.Action,
                Input = step.Input,
                Intent = run.Intent,
                PreviousOutputs = previousOutputs
            };

            var stepContent = new System.Text.StringBuilder();
            var stepArtifacts = new List<ToolboxArtifact>();
            var stepSuccess = true;
            string? stepError = null;

            try
            {
                await foreach (var chunk in adapter.StreamExecuteAsync(context, ct))
                {
                    switch (chunk.Type)
                    {
                        case AgentChunkType.Text:
                            if (!string.IsNullOrEmpty(chunk.Content))
                            {
                                stepContent.Append(chunk.Content);
                                yield return ToolboxRunEvent.StepProgress(step.StepId, chunk.Content, ++seq);
                            }
                            break;

                        case AgentChunkType.Artifact:
                            if (chunk.Artifact != null)
                            {
                                stepArtifacts.Add(chunk.Artifact);
                                allArtifacts.Add(chunk.Artifact);
                                yield return ToolboxRunEvent.StepArtifact(step.StepId, chunk.Artifact, ++seq);
                            }
                            break;

                        case AgentChunkType.Error:
                            stepSuccess = false;
                            stepError = chunk.Content;
                            break;

                        case AgentChunkType.Done:
                            // 如果 Done 携带了最终内容，更新
                            if (!string.IsNullOrEmpty(chunk.Content))
                            {
                                stepContent.Clear();
                                stepContent.Append(chunk.Content);
                            }
                            break;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Agent 执行异常: {AgentKey}, Step: {StepId}", step.AgentKey, step.StepId);
                stepSuccess = false;
                stepError = ex.Message;
            }

            if (stepSuccess)
            {
                var output = stepContent.ToString();
                previousOutputs[step.StepId] = output;
                step.Output = output;
                step.Status = ToolboxStepStatus.Completed;
                step.ArtifactIds = stepArtifacts.Select(a => a.Id).ToList();
                step.CompletedAt = DateTime.UtcNow;

                yield return ToolboxRunEvent.StepCompleted(step.StepId, output, ++seq);
                _logger.LogInformation("步骤完成: {StepId}, Agent: {AgentKey}, OutputLength: {Length}",
                    step.StepId, step.AgentKey, output.Length);
            }
            else
            {
                step.Status = ToolboxStepStatus.Failed;
                step.ErrorMessage = stepError;
                step.CompletedAt = DateTime.UtcNow;

                yield return ToolboxRunEvent.StepFailed(step.StepId, stepError ?? "未知错误", ++seq);
                _logger.LogWarning("步骤失败: {StepId}, Error: {Error}", step.StepId, stepError);

                // 步骤失败，整个 Run 失败
                yield return ToolboxRunEvent.RunFailed($"步骤 {step.Index + 1} 执行失败: {stepError}", ++seq);
                yield break;
            }
        }

        // 所有步骤完成
        var finalResponse = BuildFinalResponse(run, previousOutputs, allArtifacts);
        run.FinalResponse = finalResponse;
        run.Artifacts = allArtifacts;
        run.Status = ToolboxRunStatus.Completed;
        run.CompletedAt = DateTime.UtcNow;
        run.LastSeq = seq;

        yield return ToolboxRunEvent.RunCompleted(finalResponse, ++seq);
        _logger.LogInformation("Run 完成: {RunId}, Artifacts: {ArtifactCount}", run.Id, allArtifacts.Count);
    }

    private static string BuildFinalResponse(
        ToolboxRun run,
        Dictionary<string, string> outputs,
        List<ToolboxArtifact> artifacts)
    {
        var sb = new System.Text.StringBuilder();

        // 如果只有一个步骤，直接返回其输出
        if (run.Steps.Count == 1)
        {
            return outputs.Values.FirstOrDefault() ?? string.Empty;
        }

        // 多步骤：组合所有输出
        sb.AppendLine("## 执行结果\n");

        foreach (var step in run.Steps.OrderBy(s => s.Index))
        {
            if (outputs.TryGetValue(step.StepId, out var output))
            {
                sb.AppendLine($"### {step.Index + 1}. {step.AgentDisplayName}");
                sb.AppendLine();
                sb.AppendLine(output);
                sb.AppendLine();
            }
        }

        // 附加图片成果物
        var images = artifacts.Where(a => a.Type == ToolboxArtifactType.Image && !string.IsNullOrEmpty(a.Url)).ToList();
        if (images.Any())
        {
            sb.AppendLine("### 生成的图片\n");
            foreach (var img in images)
            {
                sb.AppendLine($"![{img.Name}]({img.Url})");
                sb.AppendLine();
            }
        }

        return sb.ToString();
    }
}
