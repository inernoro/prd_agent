using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 准星知识库服务（MVP）：规则检索 + 条款引用。
/// </summary>
public class ZhunxingKnowledgeService : IZhunxingKnowledgeService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<ZhunxingKnowledgeService> _logger;

    public ZhunxingKnowledgeService(
        MongoDbContext db,
        ILogger<ZhunxingKnowledgeService> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<ZhunxingKnowledgeDocument> CreateDocumentAsync(
        CreateZhunxingDocumentRequest request,
        string operatorUserId,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            throw new ArgumentException("文档标题不能为空", nameof(request));

        var now = DateTime.UtcNow;
        var normalizedTitle = request.Title.Trim();
        var normalizedVersion = string.IsNullOrWhiteSpace(request.Version) ? "v1.0" : request.Version.Trim();
        var normalizedScope = (request.Scope ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        var existing = await _db.ZhunxingKnowledgeDocuments
            .Find(x => x.Title == normalizedTitle && x.Version == normalizedVersion)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
            throw new InvalidOperationException("同标题同版本的知识文档已存在");

        var doc = new ZhunxingKnowledgeDocument
        {
            Title = normalizedTitle,
            Version = normalizedVersion,
            EffectiveDate = request.EffectiveDate == default ? now : request.EffectiveDate,
            Scope = normalizedScope,
            OwnerDepartment = request.OwnerDepartment?.Trim(),
            CreatedBy = operatorUserId,
            UpdatedBy = operatorUserId,
            CreatedAt = now,
            UpdatedAt = now,
            IsActive = true,
        };

        await _db.ZhunxingKnowledgeDocuments.InsertOneAsync(doc, cancellationToken: ct);
        return doc;
    }

    public async Task<IReadOnlyList<ZhunxingKnowledgeDocument>> ListDocumentsAsync(
        bool includeInactive = false,
        CancellationToken ct = default)
    {
        var filter = includeInactive
            ? Builders<ZhunxingKnowledgeDocument>.Filter.Empty
            : Builders<ZhunxingKnowledgeDocument>.Filter.Eq(x => x.IsActive, true);

        var list = await _db.ZhunxingKnowledgeDocuments
            .Find(filter)
            .SortByDescending(x => x.EffectiveDate)
            .ThenByDescending(x => x.UpdatedAt)
            .ToListAsync(ct);
        return list;
    }

    public async Task<ZhunxingKnowledgeClause> CreateClauseAsync(
        CreateZhunxingClauseRequest request,
        string operatorUserId,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.DocumentId))
            throw new ArgumentException("documentId 不能为空", nameof(request));
        if (string.IsNullOrWhiteSpace(request.Chapter))
            throw new ArgumentException("chapter 不能为空", nameof(request));
        if (string.IsNullOrWhiteSpace(request.Title))
            throw new ArgumentException("title 不能为空", nameof(request));
        if (string.IsNullOrWhiteSpace(request.RuleText))
            throw new ArgumentException("ruleText 不能为空", nameof(request));

        var doc = await _db.ZhunxingKnowledgeDocuments
            .Find(x => x.Id == request.DocumentId && x.IsActive)
            .FirstOrDefaultAsync(ct);
        if (doc == null)
            throw new InvalidOperationException("关联文档不存在或已停用");

        var now = DateTime.UtcNow;
        var chapter = request.Chapter.Trim();
        var title = request.Title.Trim();
        var keywords = (request.Keywords ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var riskLevel = NormalizeRiskLevel(request.RiskLevel);

        var clause = new ZhunxingKnowledgeClause
        {
            DocumentId = request.DocumentId,
            Chapter = chapter,
            Title = title,
            RuleText = request.RuleText.Trim(),
            Keywords = keywords,
            RiskLevel = riskLevel,
            SortOrder = request.SortOrder,
            CreatedBy = operatorUserId,
            UpdatedBy = operatorUserId,
            CreatedAt = now,
            UpdatedAt = now,
            IsActive = true,
        };

        await _db.ZhunxingKnowledgeClauses.InsertOneAsync(clause, cancellationToken: ct);
        return clause;
    }

    public async Task<IReadOnlyList<ZhunxingKnowledgeClause>> ListClausesAsync(
        string? documentId = null,
        bool includeInactive = false,
        CancellationToken ct = default)
    {
        var builder = Builders<ZhunxingKnowledgeClause>.Filter;
        var filters = new List<FilterDefinition<ZhunxingKnowledgeClause>>();
        if (!includeInactive)
            filters.Add(builder.Eq(x => x.IsActive, true));
        if (!string.IsNullOrWhiteSpace(documentId))
            filters.Add(builder.Eq(x => x.DocumentId, documentId));

        var filter = filters.Count == 0
            ? builder.Empty
            : builder.And(filters);

        var list = await _db.ZhunxingKnowledgeClauses
            .Find(filter)
            .SortBy(x => x.DocumentId)
            .ThenBy(x => x.SortOrder)
            .ThenBy(x => x.Chapter)
            .ToListAsync(ct);

        return list;
    }

    public async Task<ZhunxingAskResponse> AskAsync(
        string userId,
        ZhunxingAskRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Question))
            throw new ArgumentException("question 不能为空", nameof(request));

        var topK = Math.Clamp(request.TopK <= 0 ? 3 : request.TopK, 1, 5);
        var question = request.Question.Trim();
        var tokens = ExtractTokens(question);

        var clauses = await _db.ZhunxingKnowledgeClauses
            .Find(x => x.IsActive)
            .SortBy(x => x.SortOrder)
            .ThenBy(x => x.UpdatedAt)
            .Limit(1000)
            .ToListAsync(ct);

        if (clauses.Count == 0)
        {
            return new ZhunxingAskResponse
            {
                Matched = false,
                Answer = "当前知识库尚未初始化，暂时无法给出制度依据。请先完成知识条款录入。",
                Confidence = 0,
                RiskLevel = ZhunxingRiskLevels.Public,
                FollowUpSuggestion = "请联系管理员先初始化准星知识库，或补充对应制度条款后再提问。",
            };
        }

        var scored = clauses
            .Select(clause => new
            {
                Clause = clause,
                Score = CalculateScore(clause, question, tokens),
            })
            .Where(x => x.Score > 0)
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Clause.SortOrder)
            .Take(topK)
            .ToList();

        if (scored.Count == 0)
        {
            return new ZhunxingAskResponse
            {
                Matched = false,
                Answer = "未找到与你问题完全匹配的有效条款。为避免误导，当前先不给出结论。",
                Confidence = 0,
                RiskLevel = ZhunxingRiskLevels.Public,
                FollowUpSuggestion = "请补充场景（部门、流程节点、时长或审批条件），或联系 HR/制度管理员人工确认。",
            };
        }

        var documentIds = scored.Select(x => x.Clause.DocumentId).Distinct().ToList();
        var docs = await _db.ZhunxingKnowledgeDocuments
            .Find(x => documentIds.Contains(x.Id))
            .ToListAsync(ct);
        var docMap = docs.ToDictionary(x => x.Id, x => x, StringComparer.Ordinal);

        var primary = scored[0].Clause;
        var citations = scored.Select(x =>
        {
            docMap.TryGetValue(x.Clause.DocumentId, out var doc);
            return new ZhunxingCitation
            {
                DocumentId = x.Clause.DocumentId,
                DocumentTitle = doc?.Title ?? "未知文档",
                ClauseId = x.Clause.Id,
                Chapter = x.Clause.Chapter,
                ClauseTitle = x.Clause.Title,
                Snippet = BuildSnippet(x.Clause.RuleText),
                FullText = x.Clause.RuleText,
                RiskLevel = x.Clause.RiskLevel,
                MatchScore = x.Score,
            };
        }).ToList();

        var confidence = ComputeConfidence(scored.Select(x => x.Score).ToList());
        var riskLevel = MaxRiskLevel(citations.Select(x => x.RiskLevel));

        _logger.LogInformation(
            "[Zhunxing] Ask answered. userId={UserId} question={Question} hits={Hits}",
            userId,
            question,
            citations.Count);

        return new ZhunxingAskResponse
        {
            Matched = true,
            Answer = primary.RuleText,
            Confidence = confidence,
            RiskLevel = riskLevel,
            Citations = citations,
            FollowUpSuggestion = "如涉及特殊情形（例外审批、法定节假日调整、处罚认定），请联系责任部门进行最终确认。",
        };
    }

    public async Task<ZhunxingAskFeedbackResult> SubmitAskFeedbackAsync(
        string userId,
        CreateZhunxingAskFeedbackRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Question))
            throw new ArgumentException("question 不能为空", nameof(request));

        var feedbackType = NormalizeFeedbackType(request.FeedbackType);
        var feedback = new ZhunxingAskFeedback
        {
            UserId = userId,
            Question = request.Question.Trim(),
            Matched = request.Matched,
            Confidence = Math.Clamp(request.Confidence ?? 0, 0, 1),
            FeedbackType = feedbackType,
            Comment = string.IsNullOrWhiteSpace(request.Comment) ? null : request.Comment.Trim(),
            CitationClauseIds = (request.CitationClauseIds ?? new List<string>())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim())
                .Distinct(StringComparer.Ordinal)
                .ToList(),
            Status = ZhunxingFeedbackStatuses.New,
            UpdatedAt = DateTime.UtcNow,
            CreatedAt = DateTime.UtcNow,
        };

        await _db.ZhunxingAskFeedbacks.InsertOneAsync(feedback, cancellationToken: ct);
        _logger.LogInformation(
            "[Zhunxing] Ask feedback accepted. userId={UserId} feedbackType={FeedbackType} matched={Matched}",
            userId,
            feedback.FeedbackType,
            feedback.Matched);

        return new ZhunxingAskFeedbackResult
        {
            FeedbackId = feedback.Id,
            Message = "反馈已记录，管理员会根据反馈补充规则与检索策略。",
        };
    }

    public async Task<ZhunxingFeedbackSummary> GetFeedbackSummaryAsync(
        int top = 10,
        CancellationToken ct = default)
    {
        var topN = Math.Clamp(top, 1, 20);
        var noMatchFilter = Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.FeedbackType, ZhunxingFeedbackTypes.NoMatch);

        var totalCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(Builders<ZhunxingAskFeedback>.Filter.Empty, cancellationToken: ct);
        var noMatchCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(noMatchFilter, cancellationToken: ct);
        var answerInaccurateCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.FeedbackType, ZhunxingFeedbackTypes.AnswerInaccurate),
            cancellationToken: ct);
        var missingContextCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.FeedbackType, ZhunxingFeedbackTypes.MissingContext),
            cancellationToken: ct);
        var pendingFilter = Builders<ZhunxingAskFeedback>.Filter.Or(
            Builders<ZhunxingAskFeedback>.Filter.In(
                x => x.Status,
                new[] { ZhunxingFeedbackStatuses.New, ZhunxingFeedbackStatuses.Triaged, ZhunxingFeedbackStatuses.InProgress }),
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.Status, null),
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.Status, string.Empty));
        var pendingCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(
            pendingFilter,
            cancellationToken: ct);
        var resolvedCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.Status, ZhunxingFeedbackStatuses.Resolved),
            cancellationToken: ct);
        var closedCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.Status, ZhunxingFeedbackStatuses.Closed),
            cancellationToken: ct);
        var followUpNotifiedCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(
            Builders<ZhunxingAskFeedback>.Filter.Ne(x => x.FollowUpNotifiedAt, null),
            cancellationToken: ct);
        var replayVerifiedCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(
            Builders<ZhunxingAskFeedback>.Filter.Ne(x => x.ReplayAt, null),
            cancellationToken: ct);
        var replayMatchedCount = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.ReplayMatched, true),
            cancellationToken: ct);

        var noMatchSamples = await _db.ZhunxingAskFeedbacks
            .Find(noMatchFilter)
            .SortByDescending(x => x.CreatedAt)
            .Limit(1000)
            .ToListAsync(ct);

        var topQuestions = noMatchSamples
            .GroupBy(x => NormalizeQuestionClusterKey(x.Question), StringComparer.Ordinal)
            .Select(g =>
            {
                var latest = g.OrderByDescending(x => x.CreatedAt).First();
                return new ZhunxingFeedbackCluster
                {
                    ClusterKey = g.Key,
                    SampleQuestion = latest.Question,
                    Count = g.Count(),
                    LastOccurredAt = latest.CreatedAt,
                };
            })
            .OrderByDescending(x => x.Count)
            .ThenByDescending(x => x.LastOccurredAt)
            .Take(topN)
            .ToList();

        return new ZhunxingFeedbackSummary
        {
            TotalCount = totalCount,
            NoMatchCount = noMatchCount,
            AnswerInaccurateCount = answerInaccurateCount,
            MissingContextCount = missingContextCount,
            PendingCount = pendingCount,
            ResolvedCount = resolvedCount,
            ClosedCount = closedCount,
            FollowUpNotifiedCount = followUpNotifiedCount,
            ReplayVerifiedCount = replayVerifiedCount,
            ReplayMatchedCount = replayMatchedCount,
            TopNoMatchQuestions = topQuestions,
        };
    }

    public async Task<ZhunxingFeedbackListResult> ListFeedbacksAsync(
        string? feedbackType = null,
        string? status = null,
        bool? matched = null,
        string? keyword = null,
        int page = 1,
        int pageSize = 20,
        CancellationToken ct = default)
    {
        var safePage = Math.Max(1, page);
        var safePageSize = Math.Clamp(pageSize, 1, 100);
        var builder = Builders<ZhunxingAskFeedback>.Filter;
        var filters = new List<FilterDefinition<ZhunxingAskFeedback>>();

        if (!string.IsNullOrWhiteSpace(feedbackType)
            && !string.Equals(feedbackType, "all", StringComparison.OrdinalIgnoreCase))
        {
            var normalizedType = NormalizeFeedbackType(feedbackType);
            filters.Add(builder.Eq(x => x.FeedbackType, normalizedType));
        }

        if (!string.IsNullOrWhiteSpace(status)
            && !string.Equals(status, "all", StringComparison.OrdinalIgnoreCase))
        {
            var normalizedStatus = NormalizeFeedbackStatus(status);
            if (normalizedStatus == ZhunxingFeedbackStatuses.New)
            {
                filters.Add(builder.Or(
                    builder.Eq(x => x.Status, normalizedStatus),
                    builder.Eq(x => x.Status, null),
                    builder.Eq(x => x.Status, string.Empty)));
            }
            else
            {
                filters.Add(builder.Eq(x => x.Status, normalizedStatus));
            }
        }

        if (matched.HasValue)
            filters.Add(builder.Eq(x => x.Matched, matched.Value));

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var escaped = Regex.Escape(keyword.Trim());
            var regex = new BsonRegularExpression(escaped, "i");
            filters.Add(builder.Or(
                builder.Regex(x => x.Question, regex),
                builder.Regex(x => x.Comment, regex)));
        }

        var filter = filters.Count == 0 ? builder.Empty : builder.And(filters);
        var total = await _db.ZhunxingAskFeedbacks.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.ZhunxingAskFeedbacks
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((safePage - 1) * safePageSize)
            .Limit(safePageSize)
            .ToListAsync(ct);

        return new ZhunxingFeedbackListResult
        {
            Total = total,
            Page = safePage,
            PageSize = safePageSize,
            Items = items.Select(ToFeedbackListItem).ToList(),
        };
    }

    public async Task<ZhunxingFeedbackListItem> UpdateFeedbackWorkflowAsync(
        string operatorUserId,
        string feedbackId,
        UpdateZhunxingFeedbackWorkflowRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(feedbackId))
            throw new ArgumentException("feedbackId 不能为空", nameof(feedbackId));

        var feedback = await _db.ZhunxingAskFeedbacks
            .Find(x => x.Id == feedbackId)
            .FirstOrDefaultAsync(ct);
        if (feedback == null)
            throw new InvalidOperationException("反馈记录不存在");

        var updateDefs = new List<UpdateDefinition<ZhunxingAskFeedback>>
        {
            Builders<ZhunxingAskFeedback>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow),
        };

        if (request.OwnerDepartment != null)
        {
            var ownerDepartment = string.IsNullOrWhiteSpace(request.OwnerDepartment)
                ? null
                : request.OwnerDepartment.Trim();
            updateDefs.Add(Builders<ZhunxingAskFeedback>.Update.Set(x => x.OwnerDepartment, ownerDepartment));
        }

        if (request.AssigneeUserId != null)
        {
            var assigneeUserId = string.IsNullOrWhiteSpace(request.AssigneeUserId)
                ? null
                : request.AssigneeUserId.Trim();
            updateDefs.Add(Builders<ZhunxingAskFeedback>.Update.Set(x => x.AssigneeUserId, assigneeUserId));
        }

        if (request.ResolutionType != null)
        {
            var resolutionType = string.IsNullOrWhiteSpace(request.ResolutionType)
                ? null
                : NormalizeResolutionType(request.ResolutionType);
            updateDefs.Add(Builders<ZhunxingAskFeedback>.Update.Set(x => x.ResolutionType, resolutionType));
        }

        if (request.ResolutionNote != null)
        {
            var resolutionNote = string.IsNullOrWhiteSpace(request.ResolutionNote)
                ? null
                : request.ResolutionNote.Trim();
            updateDefs.Add(Builders<ZhunxingAskFeedback>.Update.Set(x => x.ResolutionNote, resolutionNote));
        }

        if (!string.IsNullOrWhiteSpace(request.Status))
        {
            var targetStatus = NormalizeFeedbackStatus(request.Status);
            if (!CanTransitFeedbackStatus(feedback.Status, targetStatus))
                throw new ArgumentException($"状态流转不合法：{feedback.Status} -> {targetStatus}", nameof(request.Status));

            updateDefs.Add(Builders<ZhunxingAskFeedback>.Update.Set(x => x.Status, targetStatus));

            if (targetStatus == ZhunxingFeedbackStatuses.Resolved)
            {
                updateDefs.Add(Builders<ZhunxingAskFeedback>.Update.Set(x => x.ResolvedAt, DateTime.UtcNow));
                updateDefs.Add(Builders<ZhunxingAskFeedback>.Update.Set(x => x.ResolvedBy, operatorUserId));
            }
        }

        await _db.ZhunxingAskFeedbacks.UpdateOneAsync(
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.Id, feedbackId),
            Builders<ZhunxingAskFeedback>.Update.Combine(updateDefs),
            cancellationToken: ct);

        var updated = await _db.ZhunxingAskFeedbacks
            .Find(x => x.Id == feedbackId)
            .FirstOrDefaultAsync(ct);
        if (updated == null)
            throw new InvalidOperationException("反馈记录不存在");

        return ToFeedbackListItem(updated);
    }

    public async Task<ZhunxingFeedbackReplayResult> ReplayFeedbackAsync(
        string operatorUserId,
        string feedbackId,
        ReplayZhunxingFeedbackRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(feedbackId))
            throw new ArgumentException("feedbackId 不能为空", nameof(feedbackId));

        var feedback = await _db.ZhunxingAskFeedbacks
            .Find(x => x.Id == feedbackId)
            .FirstOrDefaultAsync(ct);
        if (feedback == null)
            throw new InvalidOperationException("反馈记录不存在");

        var replayQuestion = string.IsNullOrWhiteSpace(request.Question)
            ? feedback.Question
            : request.Question.Trim();
        var topK = Math.Clamp(request.TopK <= 0 ? 3 : request.TopK, 1, 5);
        var askResult = await AskAsync(operatorUserId, new ZhunxingAskRequest
        {
            Question = replayQuestion,
            TopK = topK,
        }, ct);
        var replayedAt = DateTime.UtcNow;
        var regressionDetected = feedback.Status == ZhunxingFeedbackStatuses.Resolved && !askResult.Matched;

        var update = Builders<ZhunxingAskFeedback>.Update
            .Set(x => x.ReplayQuestion, replayQuestion)
            .Set(x => x.ReplayMatched, askResult.Matched)
            .Set(x => x.ReplayConfidence, askResult.Confidence)
            .Set(x => x.ReplayRiskLevel, askResult.RiskLevel)
            .Set(x => x.ReplayAnswerSnippet, BuildSnippet(askResult.Answer))
            .Set(x => x.ReplayAt, replayedAt)
            .Set(x => x.UpdatedAt, replayedAt);
        await _db.ZhunxingAskFeedbacks.UpdateOneAsync(
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.Id, feedbackId),
            update,
            cancellationToken: ct);

        return new ZhunxingFeedbackReplayResult
        {
            FeedbackId = feedbackId,
            Question = replayQuestion,
            Matched = askResult.Matched,
            Confidence = askResult.Confidence,
            RiskLevel = askResult.RiskLevel,
            Answer = askResult.Answer,
            ReplayedAt = replayedAt,
            RegressionDetected = regressionDetected,
        };
    }

    public async Task<ZhunxingFeedbackFollowUpResult> MarkFeedbackFollowUpAsync(
        string operatorUserId,
        string feedbackId,
        MarkZhunxingFeedbackFollowUpRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(feedbackId))
            throw new ArgumentException("feedbackId 不能为空", nameof(feedbackId));

        var feedback = await _db.ZhunxingAskFeedbacks
            .Find(x => x.Id == feedbackId)
            .FirstOrDefaultAsync(ct);
        if (feedback == null)
            throw new InvalidOperationException("反馈记录不存在");

        if (feedback.Status != ZhunxingFeedbackStatuses.Resolved
            && feedback.Status != ZhunxingFeedbackStatuses.Closed)
        {
            throw new ArgumentException("仅已解决状态可执行回访通知");
        }

        var followUpAt = DateTime.UtcNow;
        var followUpNote = string.IsNullOrWhiteSpace(request.FollowUpNote)
            ? "已根据反馈完成规则补充，欢迎重新提问验证效果。"
            : request.FollowUpNote.Trim();
        var update = Builders<ZhunxingAskFeedback>.Update
            .Set(x => x.FollowUpNote, followUpNote)
            .Set(x => x.FollowUpBy, operatorUserId)
            .Set(x => x.FollowUpNotifiedAt, followUpAt)
            .Set(x => x.Status, ZhunxingFeedbackStatuses.Closed)
            .Set(x => x.UpdatedAt, followUpAt);
        await _db.ZhunxingAskFeedbacks.UpdateOneAsync(
            Builders<ZhunxingAskFeedback>.Filter.Eq(x => x.Id, feedbackId),
            update,
            cancellationToken: ct);

        return new ZhunxingFeedbackFollowUpResult
        {
            FeedbackId = feedbackId,
            Message = "回访通知已记录",
            FollowUpNotifiedAt = followUpAt,
            Status = ZhunxingFeedbackStatuses.Closed,
        };
    }

    public async Task<ZhunxingBootstrapResult> BootstrapAttendanceSampleAsync(
        string operatorUserId,
        CancellationToken ct = default)
    {
        const string docTitle = "米多公司考勤管理办法";
        const string docVersion = "v2026.02.01";

        var doc = await _db.ZhunxingKnowledgeDocuments
            .Find(x => x.Title == docTitle && x.Version == docVersion)
            .FirstOrDefaultAsync(ct);
        if (doc == null)
        {
            doc = new ZhunxingKnowledgeDocument
            {
                Title = docTitle,
                Version = docVersion,
                EffectiveDate = new DateTime(2026, 2, 1, 0, 0, 0, DateTimeKind.Utc),
                Scope = new List<string> { "all-departments" },
                OwnerDepartment = "HR",
                IsActive = true,
                CreatedBy = operatorUserId,
                UpdatedBy = operatorUserId,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            };
            await _db.ZhunxingKnowledgeDocuments.InsertOneAsync(doc, cancellationToken: ct);
        }

        var seeds = BuildAttendanceSeedClauses(doc.Id, operatorUserId);
        var upserted = 0;
        foreach (var seed in seeds)
        {
            var filter = Builders<ZhunxingKnowledgeClause>.Filter.Eq(x => x.DocumentId, doc.Id)
                         & Builders<ZhunxingKnowledgeClause>.Filter.Eq(x => x.Chapter, seed.Chapter)
                         & Builders<ZhunxingKnowledgeClause>.Filter.Eq(x => x.Title, seed.Title);

            var existing = await _db.ZhunxingKnowledgeClauses.Find(filter).FirstOrDefaultAsync(ct);
            if (existing == null)
            {
                await _db.ZhunxingKnowledgeClauses.InsertOneAsync(seed, cancellationToken: ct);
                upserted++;
                continue;
            }

            var update = Builders<ZhunxingKnowledgeClause>.Update
                .Set(x => x.RuleText, seed.RuleText)
                .Set(x => x.Keywords, seed.Keywords)
                .Set(x => x.RiskLevel, seed.RiskLevel)
                .Set(x => x.SortOrder, seed.SortOrder)
                .Set(x => x.IsActive, true)
                .Set(x => x.UpdatedBy, operatorUserId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow);
            await _db.ZhunxingKnowledgeClauses.UpdateOneAsync(
                Builders<ZhunxingKnowledgeClause>.Filter.Eq(x => x.Id, existing.Id),
                update,
                cancellationToken: ct);
            upserted++;
        }

        return new ZhunxingBootstrapResult
        {
            DocumentId = doc.Id,
            DocumentTitle = doc.Title,
            UpsertedClauseCount = upserted,
        };
    }

    private static List<string> ExtractTokens(string question)
    {
        var tokens = Regex.Matches(question, @"[\u4e00-\u9fa5A-Za-z0-9]{2,}")
            .Select(m => m.Value.Trim().ToLowerInvariant())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        return tokens;
    }

    private static int CalculateScore(
        ZhunxingKnowledgeClause clause,
        string question,
        IReadOnlyCollection<string> tokens)
    {
        var score = 0;
        var title = clause.Title.ToLowerInvariant();
        var text = clause.RuleText.ToLowerInvariant();
        var chapter = clause.Chapter.ToLowerInvariant();
        var keywordSet = new HashSet<string>(
            clause.Keywords.Select(x => x.ToLowerInvariant()),
            StringComparer.Ordinal);

        foreach (var token in tokens)
        {
            if (keywordSet.Any(k => k.Contains(token, StringComparison.Ordinal) || token.Contains(k, StringComparison.Ordinal)))
                score += 6;
            if (title.Contains(token, StringComparison.Ordinal))
                score += 4;
            if (text.Contains(token, StringComparison.Ordinal))
                score += 3;
            if (chapter.Contains(token, StringComparison.Ordinal))
                score += 2;
        }

        if (question.Contains("依据", StringComparison.Ordinal) || question.Contains("条款", StringComparison.Ordinal))
            score += 1;

        return score;
    }

    private static string BuildSnippet(string text)
    {
        var normalized = text.Trim();
        return normalized.Length <= 120
            ? normalized
            : $"{normalized[..120]}...";
    }

    private static string NormalizeRiskLevel(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return ZhunxingRiskLevels.Internal;

        var normalized = value.Trim().ToLowerInvariant();
        if (normalized is ZhunxingRiskLevels.Public or ZhunxingRiskLevels.Internal or ZhunxingRiskLevels.Sensitive)
            return normalized;
        return ZhunxingRiskLevels.Internal;
    }

    private static double ComputeConfidence(IReadOnlyList<int> scores)
    {
        if (scores.Count == 0)
            return 0;

        var top = scores[0];
        var second = scores.Count > 1 ? scores[1] : 0;
        var normalizedTop = Math.Min(top, 30) / 30.0;
        var gap = Math.Max(0, top - second);
        var normalizedGap = Math.Min(gap, 10) / 10.0;
        var confidence = 0.45 + normalizedTop * 0.35 + normalizedGap * 0.2;
        return Math.Round(Math.Clamp(confidence, 0.05, 0.99), 2);
    }

    private static string MaxRiskLevel(IEnumerable<string> riskLevels)
    {
        var maxRank = -1;
        var maxRisk = ZhunxingRiskLevels.Public;
        foreach (var riskLevel in riskLevels)
        {
            var normalized = NormalizeRiskLevel(riskLevel);
            var rank = GetRiskRank(normalized);
            if (rank > maxRank)
            {
                maxRank = rank;
                maxRisk = normalized;
            }
        }

        return maxRisk;
    }

    private static int GetRiskRank(string riskLevel)
    {
        return riskLevel switch
        {
            ZhunxingRiskLevels.Sensitive => 3,
            ZhunxingRiskLevels.Internal => 2,
            _ => 1,
        };
    }

    private static string NormalizeFeedbackType(string? feedbackType)
    {
        if (string.IsNullOrWhiteSpace(feedbackType))
            return ZhunxingFeedbackTypes.NoMatch;

        var normalized = feedbackType.Trim().ToLowerInvariant();
        if (normalized is ZhunxingFeedbackTypes.NoMatch
            or ZhunxingFeedbackTypes.AnswerInaccurate
            or ZhunxingFeedbackTypes.MissingContext)
            return normalized;

        return ZhunxingFeedbackTypes.NoMatch;
    }

    private static string NormalizeFeedbackStatus(string? status)
    {
        if (string.IsNullOrWhiteSpace(status))
            return ZhunxingFeedbackStatuses.New;

        var normalized = status.Trim().ToLowerInvariant();
        if (normalized is ZhunxingFeedbackStatuses.New
            or ZhunxingFeedbackStatuses.Triaged
            or ZhunxingFeedbackStatuses.InProgress
            or ZhunxingFeedbackStatuses.Resolved
            or ZhunxingFeedbackStatuses.Closed)
        {
            return normalized;
        }

        return ZhunxingFeedbackStatuses.New;
    }

    private static string NormalizeResolutionType(string? resolutionType)
    {
        if (string.IsNullOrWhiteSpace(resolutionType))
            return ZhunxingFeedbackResolutionTypes.Other;

        var normalized = resolutionType.Trim().ToLowerInvariant();
        if (normalized is ZhunxingFeedbackResolutionTypes.AddClause
            or ZhunxingFeedbackResolutionTypes.UpdateClause
            or ZhunxingFeedbackResolutionTypes.RetrievalTuning
            or ZhunxingFeedbackResolutionTypes.ProcessClarification
            or ZhunxingFeedbackResolutionTypes.Other)
        {
            return normalized;
        }

        return ZhunxingFeedbackResolutionTypes.Other;
    }

    private static bool CanTransitFeedbackStatus(string? sourceStatus, string targetStatus)
    {
        var source = NormalizeFeedbackStatus(sourceStatus);
        if (source == targetStatus)
            return true;

        return source switch
        {
            ZhunxingFeedbackStatuses.New => targetStatus is ZhunxingFeedbackStatuses.Triaged
                or ZhunxingFeedbackStatuses.InProgress
                or ZhunxingFeedbackStatuses.Resolved
                or ZhunxingFeedbackStatuses.Closed,
            ZhunxingFeedbackStatuses.Triaged => targetStatus is ZhunxingFeedbackStatuses.InProgress
                or ZhunxingFeedbackStatuses.Resolved
                or ZhunxingFeedbackStatuses.Closed,
            ZhunxingFeedbackStatuses.InProgress => targetStatus is ZhunxingFeedbackStatuses.Resolved
                or ZhunxingFeedbackStatuses.Closed,
            ZhunxingFeedbackStatuses.Resolved => targetStatus == ZhunxingFeedbackStatuses.Closed,
            _ => false,
        };
    }

    private static ZhunxingFeedbackListItem ToFeedbackListItem(ZhunxingAskFeedback x)
    {
        return new ZhunxingFeedbackListItem
        {
            Id = x.Id,
            UserId = x.UserId,
            Question = x.Question,
            Matched = x.Matched,
            Confidence = x.Confidence,
            FeedbackType = x.FeedbackType,
            Comment = x.Comment,
            CitationClauseIds = x.CitationClauseIds,
            Status = NormalizeFeedbackStatus(x.Status),
            OwnerDepartment = x.OwnerDepartment,
            AssigneeUserId = x.AssigneeUserId,
            ResolutionType = x.ResolutionType,
            ResolutionNote = x.ResolutionNote,
            ResolvedBy = x.ResolvedBy,
            ResolvedAt = x.ResolvedAt,
            ReplayQuestion = x.ReplayQuestion,
            ReplayMatched = x.ReplayMatched,
            ReplayConfidence = x.ReplayConfidence,
            ReplayRiskLevel = x.ReplayRiskLevel,
            ReplayAnswerSnippet = x.ReplayAnswerSnippet,
            ReplayAt = x.ReplayAt,
            FollowUpNote = x.FollowUpNote,
            FollowUpBy = x.FollowUpBy,
            FollowUpNotifiedAt = x.FollowUpNotifiedAt,
            UpdatedAt = x.UpdatedAt,
            CreatedAt = x.CreatedAt,
        };
    }

    private static string NormalizeQuestionClusterKey(string question)
    {
        if (string.IsNullOrWhiteSpace(question))
            return "empty";

        var normalized = question.Trim().ToLowerInvariant();
        normalized = Regex.Replace(normalized, @"[\s，。！？、,.!?;:：；""'（）()\[\]【】\-_/\\]+", string.Empty);
        if (normalized.Length > 24)
            normalized = normalized[..24];

        return string.IsNullOrWhiteSpace(normalized) ? "empty" : normalized;
    }

    private static List<ZhunxingKnowledgeClause> BuildAttendanceSeedClauses(string documentId, string operatorUserId)
    {
        var now = DateTime.UtcNow;
        return new List<ZhunxingKnowledgeClause>
        {
            NewClause(documentId, "6.2", "每日工作时间", "每日工作时间为 8 小时，上午 09:00-12:00，下午 13:30-18:30，午休不计入工时。", 10, operatorUserId, now, "作息", "工作时间", "工时"),
            NewClause(documentId, "8.2", "打卡次数", "打卡频次为一日两次，上午 9:00 前打卡一次，下午 18:30 后打卡一次。", 20, operatorUserId, now, "打卡", "上下班", "考勤"),
            NewClause(documentId, "8.4", "打卡定位要求", "正常打卡需在公司办公区域范围内连接 wifi 完成，不在范围内的打卡视为无效。", 30, operatorUserId, now, "定位", "wifi", "无效打卡"),
            NewClause(documentId, "9.1", "迟到与早退", "上班打卡时间超过规定上班时间视为迟到，下班打卡时间早于规定下班时间视为早退。", 40, operatorUserId, now, "迟到", "早退"),
            NewClause(documentId, "10.1.3", "请假审批权限", "请假时长不超过 40 小时由部门负责人审批，请假时长大于 40 小时须部门负责人及人力资源负责人共同审批。", 50, operatorUserId, now, "请假", "审批", "40小时"),
            NewClause(documentId, "10.2.4", "事假时长上限", "单次事假时长上限为 24 小时，每季度事假累计不超过 80 小时，全年累计不超过 160 小时。", 60, operatorUserId, now, "事假", "上限"),
            NewClause(documentId, "10.5.1", "产假与奖励假", "公司女职员生育可享 98 天基础产假，符合国家及广州市计划生育政策规定的，额外享受 80 天奖励假。", 70, operatorUserId, now, "产假", "奖励假"),
            NewClause(documentId, "10.6.1", "陪产假", "符合合法法规规定并持有结婚证及生育登记证明的男性职员，在其配偶产假期间可享受 15 天陪产假。", 80, operatorUserId, now, "陪产假", "男性职员"),
            NewClause(documentId, "12.1.5", "旷工认定阈值", "迟到或早退故意不打卡，且迟到或早退超过 120 分钟的，视为旷工。", 90, operatorUserId, now, "旷工", "120分钟", "迟到"),
            NewClause(documentId, "12.3", "严重违纪阈值", "员工月累计旷工 3 天，财务季度内累计旷工 5 天的，视为严重违纪。", 100, operatorUserId, now, "严重违纪", "旷工累计"),
        };
    }

    private static ZhunxingKnowledgeClause NewClause(
        string documentId,
        string chapter,
        string title,
        string ruleText,
        int sortOrder,
        string operatorUserId,
        DateTime now,
        params string[] keywords)
    {
        return new ZhunxingKnowledgeClause
        {
            DocumentId = documentId,
            Chapter = chapter,
            Title = title,
            RuleText = ruleText,
            Keywords = keywords.ToList(),
            RiskLevel = ZhunxingRiskLevels.Internal,
            SortOrder = sortOrder,
            IsActive = true,
            CreatedBy = operatorUserId,
            UpdatedBy = operatorUserId,
            CreatedAt = now,
            UpdatedAt = now,
        };
    }
}
