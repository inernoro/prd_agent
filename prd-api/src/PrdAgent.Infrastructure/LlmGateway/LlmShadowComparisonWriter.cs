using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 影子比对落库实现：直插 llmshadow_comparisons。低频（仅 shadow 模式 + 解析比对/采样 send），无需 Channel 缓冲。
/// 任何异常都吞掉 + 仅 Warning，保证 caller 的主流程（inproc 权威结果）永不受影响。
/// </summary>
public sealed class LlmShadowComparisonWriter : ILlmShadowComparisonWriter
{
    private readonly MongoDbContext _db;
    private readonly ILogger<LlmShadowComparisonWriter> _logger;

    public LlmShadowComparisonWriter(MongoDbContext db, ILogger<LlmShadowComparisonWriter> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task RecordAsync(LlmShadowComparison comparison, CancellationToken ct = default)
    {
        try
        {
            await _db.LlmShadowComparisons.InsertOneAsync(comparison, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShadowComparison] 落库失败（不影响主流程）app={App}", comparison.AppCallerCode);
        }
    }
}
