using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 影子双发比对记录写入器（落 llmshadow_comparisons）。
/// 调用方一律 fire-and-forget；实现必须吞掉所有异常，绝不让比对落库失败影响主流程（caller 永远拿 inproc 结果）。
/// </summary>
public interface ILlmShadowComparisonWriter
{
    Task RecordAsync(LlmShadowComparison comparison, CancellationToken ct = default);
}
