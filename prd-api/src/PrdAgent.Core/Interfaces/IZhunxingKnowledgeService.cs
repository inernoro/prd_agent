using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 准星知识服务：文档/条款管理与问答检索。
/// </summary>
public interface IZhunxingKnowledgeService
{
    Task<ZhunxingKnowledgeDocument> CreateDocumentAsync(
        CreateZhunxingDocumentRequest request,
        string operatorUserId,
        CancellationToken ct = default);

    Task<IReadOnlyList<ZhunxingKnowledgeDocument>> ListDocumentsAsync(
        bool includeInactive = false,
        CancellationToken ct = default);

    Task<ZhunxingKnowledgeClause> CreateClauseAsync(
        CreateZhunxingClauseRequest request,
        string operatorUserId,
        CancellationToken ct = default);

    Task<IReadOnlyList<ZhunxingKnowledgeClause>> ListClausesAsync(
        string? documentId = null,
        bool includeInactive = false,
        CancellationToken ct = default);

    Task<ZhunxingAskResponse> AskAsync(
        string userId,
        ZhunxingAskRequest request,
        CancellationToken ct = default);

    Task<ZhunxingAskFeedbackResult> SubmitAskFeedbackAsync(
        string userId,
        CreateZhunxingAskFeedbackRequest request,
        CancellationToken ct = default);

    Task<ZhunxingBootstrapResult> BootstrapAttendanceSampleAsync(
        string operatorUserId,
        CancellationToken ct = default);
}
