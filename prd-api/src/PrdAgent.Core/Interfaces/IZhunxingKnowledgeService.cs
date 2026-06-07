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

    Task<ZhunxingKnowledgeDocument?> GetDocumentByIdAsync(
        string documentId,
        CancellationToken ct = default);

    Task<IReadOnlyList<ZhunxingKnowledgeCategory>> ListCategoriesAsync(
        bool includeInactive = false,
        CancellationToken ct = default);

    Task<ZhunxingKnowledgeCategory> CreateCategoryAsync(
        CreateZhunxingCategoryRequest request,
        string operatorUserId,
        CancellationToken ct = default);

    Task<IReadOnlyList<ZhunxingKnowledgeTag>> ListTagsAsync(
        bool includeInactive = false,
        CancellationToken ct = default);

    Task<ZhunxingKnowledgeTag> CreateTagAsync(
        CreateZhunxingTagRequest request,
        string operatorUserId,
        CancellationToken ct = default);

    Task<ZhunxingKnowledgeDocument> DeactivateDocumentAsync(
        string documentId,
        string operatorUserId,
        CancellationToken ct = default);

    Task<ZhunxingDocumentVersionTimelineResult> GetDocumentVersionTimelineAsync(
        string documentId,
        CancellationToken ct = default);

    Task<ZhunxingDocumentDiffResult> GetDocumentDiffAsync(
        string sourceDocumentId,
        string targetDocumentId,
        CancellationToken ct = default);

    Task<ZhunxingExpireDocumentsResult> ExpireDocumentsAsync(
        string operatorUserId,
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

    Task<ZhunxingFeedbackSummary> GetFeedbackSummaryAsync(
        int top = 10,
        CancellationToken ct = default);

    Task<ZhunxingFeedbackListResult> ListFeedbacksAsync(
        string? feedbackType = null,
        string? status = null,
        bool? matched = null,
        string? keyword = null,
        int page = 1,
        int pageSize = 20,
        CancellationToken ct = default);

    Task<ZhunxingFeedbackListItem> UpdateFeedbackWorkflowAsync(
        string operatorUserId,
        string feedbackId,
        UpdateZhunxingFeedbackWorkflowRequest request,
        CancellationToken ct = default);

    Task<ZhunxingFeedbackReplayResult> ReplayFeedbackAsync(
        string operatorUserId,
        string feedbackId,
        ReplayZhunxingFeedbackRequest request,
        CancellationToken ct = default);

    Task<ZhunxingFeedbackFollowUpResult> MarkFeedbackFollowUpAsync(
        string operatorUserId,
        string feedbackId,
        MarkZhunxingFeedbackFollowUpRequest request,
        CancellationToken ct = default);

    Task<ZhunxingTopicSubscriptionResult> GetTopicSubscriptionAsync(
        string userId,
        CancellationToken ct = default);

    Task<ZhunxingTopicSubscriptionResult> UpdateTopicSubscriptionAsync(
        string userId,
        UpdateZhunxingTopicSubscriptionRequest request,
        CancellationToken ct = default);

    Task<ZhunxingTopicUpdateFeed> GetTopicUpdatesAsync(
        string userId,
        int days = 30,
        int top = 20,
        CancellationToken ct = default);

    Task<ZhunxingKnowledgeHeatmap> GetKnowledgeHeatmapAsync(
        int days = 30,
        int top = 8,
        CancellationToken ct = default);

    Task<ZhunxingBootstrapResult> BootstrapAttendanceSampleAsync(
        string operatorUserId,
        CancellationToken ct = default);
}
