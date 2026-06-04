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
    private static readonly Dictionary<string, TopicDefinition> TopicCatalog = BuildTopicCatalog();

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
        var answerRole = NormalizeAnswerRole(request.AnswerRole);
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
                AnswerRole = answerRole,
                Confidence = 0,
                RiskLevel = ZhunxingRiskLevels.Public,
                DecisionTree = BuildNoMatchDecisionTree(),
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
                AnswerRole = answerRole,
                Confidence = 0,
                RiskLevel = ZhunxingRiskLevels.Public,
                DecisionTree = BuildNoMatchDecisionTree(),
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
        var conflictClauses = DetectConflicts(question, citations);
        var conflictDetected = conflictClauses.Count > 0;
        var decisionTree = BuildDecisionTree(question, citations, conflictDetected);
        var roleAnswer = BuildRoleAnswer(answerRole, primary, citations, conflictDetected);

        _logger.LogInformation(
            "[Zhunxing] Ask answered. userId={UserId} question={Question} hits={Hits}",
            userId,
            question,
            citations.Count);

        return new ZhunxingAskResponse
        {
            Matched = true,
            Answer = roleAnswer,
            AnswerRole = answerRole,
            Confidence = confidence,
            RiskLevel = riskLevel,
            DecisionTree = decisionTree,
            ConflictDetected = conflictDetected,
            ConflictMessage = conflictDetected
                ? "命中条款存在口径差异，请先按高风险路径执行并联系 HR/制度管理员确认。"
                : null,
            ConflictClauses = conflictClauses,
            Citations = citations,
            FollowUpSuggestion = conflictDetected
                ? "当前命中条款存在潜在冲突，建议先人工确认最终口径后再执行。"
                : "如涉及特殊情形（例外审批、法定节假日调整、处罚认定），请联系责任部门进行最终确认。",
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

    public async Task<ZhunxingTopicSubscriptionResult> GetTopicSubscriptionAsync(
        string userId,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userId))
            throw new ArgumentException("userId 不能为空", nameof(userId));

        var existing = await _db.ZhunxingTopicSubscriptions
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        return new ZhunxingTopicSubscriptionResult
        {
            UserId = userId,
            Topics = existing == null
                ? GetDefaultTopics()
                : NormalizeTopics(existing.Topics),
            UpdatedAt = existing?.UpdatedAt ?? DateTime.UtcNow,
        };
    }

    public async Task<ZhunxingTopicSubscriptionResult> UpdateTopicSubscriptionAsync(
        string userId,
        UpdateZhunxingTopicSubscriptionRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userId))
            throw new ArgumentException("userId 不能为空", nameof(userId));
        if (request == null)
            throw new ArgumentException("request 不能为空", nameof(request));

        var normalizedTopics = NormalizeTopics(request.Topics);
        if (normalizedTopics.Count == 0)
            normalizedTopics = GetDefaultTopics();

        var now = DateTime.UtcNow;
        var existing = await _db.ZhunxingTopicSubscriptions
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (existing == null)
        {
            var subscription = new ZhunxingTopicSubscription
            {
                UserId = userId,
                Topics = normalizedTopics,
                CreatedAt = now,
                UpdatedAt = now,
            };
            await _db.ZhunxingTopicSubscriptions.InsertOneAsync(subscription, cancellationToken: ct);
        }
        else
        {
            var update = Builders<ZhunxingTopicSubscription>.Update
                .Set(x => x.Topics, normalizedTopics)
                .Set(x => x.UpdatedAt, now);
            await _db.ZhunxingTopicSubscriptions.UpdateOneAsync(
                Builders<ZhunxingTopicSubscription>.Filter.Eq(x => x.UserId, userId),
                update,
                cancellationToken: ct);
        }

        return new ZhunxingTopicSubscriptionResult
        {
            UserId = userId,
            Topics = normalizedTopics,
            UpdatedAt = now,
        };
    }

    public async Task<ZhunxingTopicUpdateFeed> GetTopicUpdatesAsync(
        string userId,
        int days = 30,
        int top = 20,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userId))
            throw new ArgumentException("userId 不能为空", nameof(userId));

        var safeDays = Math.Clamp(days, 1, 180);
        var safeTop = Math.Clamp(top, 1, 100);
        var since = DateTime.UtcNow.AddDays(-safeDays);

        var subscription = await _db.ZhunxingTopicSubscriptions
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        var subscribedTopics = subscription == null
            ? GetDefaultTopics()
            : NormalizeTopics(subscription.Topics);

        var documents = await _db.ZhunxingKnowledgeDocuments
            .Find(x => x.IsActive)
            .ToListAsync(ct);
        var documentMap = documents.ToDictionary(x => x.Id, x => x.Title, StringComparer.Ordinal);

        var recentClauses = await _db.ZhunxingKnowledgeClauses
            .Find(x => x.IsActive && x.UpdatedAt >= since)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(1000)
            .ToListAsync(ct);

        var updates = new List<ZhunxingTopicUpdateItem>();
        foreach (var clause in recentClauses)
        {
            var matchedTopics = MatchTopics(clause.Title, clause.RuleText, clause.Keywords)
                .Where(subscribedTopics.Contains)
                .ToList();
            if (matchedTopics.Count == 0)
                continue;

            foreach (var topic in matchedTopics)
            {
                updates.Add(new ZhunxingTopicUpdateItem
                {
                    Topic = topic,
                    TopicLabel = TopicCatalog[topic].Label,
                    DocumentId = clause.DocumentId,
                    DocumentTitle = documentMap.TryGetValue(clause.DocumentId, out var title) ? title : "未知文档",
                    ClauseId = clause.Id,
                    Chapter = clause.Chapter,
                    ClauseTitle = clause.Title,
                    Summary = BuildSnippet(clause.RuleText),
                    RiskLevel = clause.RiskLevel,
                    UpdatedAt = clause.UpdatedAt,
                });
            }
        }

        var ordered = updates
            .OrderByDescending(x => x.UpdatedAt)
            .ThenByDescending(x => GetRiskRank(NormalizeRiskLevel(x.RiskLevel)))
            .Take(safeTop)
            .ToList();

        return new ZhunxingTopicUpdateFeed
        {
            Days = safeDays,
            TotalUpdates = updates.Count,
            ReturnedUpdates = ordered.Count,
            Items = ordered,
            GeneratedAt = DateTime.UtcNow,
        };
    }

    public async Task<ZhunxingKnowledgeHeatmap> GetKnowledgeHeatmapAsync(
        int days = 30,
        int top = 8,
        CancellationToken ct = default)
    {
        var safeDays = Math.Clamp(days, 1, 180);
        var safeTop = Math.Clamp(top, 1, 20);
        var since = DateTime.UtcNow.AddDays(-safeDays);

        var feedbacks = await _db.ZhunxingAskFeedbacks
            .Find(x => x.CreatedAt >= since)
            .SortByDescending(x => x.CreatedAt)
            .Limit(5000)
            .ToListAsync(ct);

        var bucketMap = TopicCatalog.Values
            .ToDictionary(
                x => x.Key,
                x => new HeatmapAccumulator(x.Key, x.Label),
                StringComparer.Ordinal);

        foreach (var feedback in feedbacks)
        {
            var text = $"{feedback.Question} {feedback.Comment}";
            var topics = MatchTopics(feedback.Question, text, feedback.CitationClauseIds);
            if (topics.Count == 0)
                continue;

            foreach (var topic in topics)
            {
                if (!bucketMap.TryGetValue(topic, out var bucket))
                    continue;

                bucket.QuestionCount++;
                bucket.ConfidenceSum += Math.Clamp(feedback.Confidence, 0, 1);
                if (feedback.FeedbackType == ZhunxingFeedbackTypes.NoMatch)
                    bucket.NoMatchCount++;
                if (NormalizeFeedbackStatus(feedback.Status) is ZhunxingFeedbackStatuses.New
                    or ZhunxingFeedbackStatuses.Triaged
                    or ZhunxingFeedbackStatuses.InProgress)
                {
                    bucket.PendingCount++;
                }
            }
        }

        var buckets = bucketMap.Values
            .Where(x => x.QuestionCount > 0)
            .Select(x =>
            {
                var avgConfidence = x.QuestionCount == 0 ? 0 : Math.Round(x.ConfidenceSum / x.QuestionCount, 2);
                var heatScore = Math.Round(
                    x.QuestionCount * 1.0
                    + x.NoMatchCount * 1.6
                    + x.PendingCount * 1.3
                    + (1 - avgConfidence) * 2.0,
                    2);
                return new ZhunxingHeatmapBucket
                {
                    Topic = x.Topic,
                    TopicLabel = x.TopicLabel,
                    QuestionCount = x.QuestionCount,
                    NoMatchCount = x.NoMatchCount,
                    PendingCount = x.PendingCount,
                    AvgConfidence = avgConfidence,
                    HeatScore = heatScore,
                };
            })
            .OrderByDescending(x => x.HeatScore)
            .ThenByDescending(x => x.QuestionCount)
            .Take(safeTop)
            .ToList();

        return new ZhunxingKnowledgeHeatmap
        {
            Days = safeDays,
            TotalFeedbackCount = feedbacks.Count,
            GeneratedAt = DateTime.UtcNow,
            Buckets = buckets,
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

    private static Dictionary<string, TopicDefinition> BuildTopicCatalog()
    {
        return new Dictionary<string, TopicDefinition>(StringComparer.Ordinal)
        {
            ["attendance"] = new("attendance", "考勤管理", "考勤", "打卡", "迟到", "早退", "工时", "旷工"),
            ["leave"] = new("leave", "请假休假", "请假", "事假", "病假", "产假", "陪产假", "休假"),
            ["handover"] = new("handover", "交接流程", "交接", "移交", "对接", "交付"),
            ["approval"] = new("approval", "审批规则", "审批", "负责人", "流程节点", "签批"),
            ["discipline"] = new("discipline", "违规与处罚", "违纪", "处罚", "旷工", "警告", "通报"),
            ["rnd"] = new("rnd", "产研协作", "产研", "研发", "需求", "测试", "发布"),
            ["sales"] = new("sales", "市场销售协同", "市场", "销售", "客户", "商机", "报价"),
        };
    }

    private static List<string> GetDefaultTopics()
    {
        return new List<string> { "attendance", "leave", "handover", "approval" };
    }

    private static List<string> NormalizeTopics(IEnumerable<string>? topics)
    {
        if (topics == null)
            return new List<string>();

        return topics
            .Select(x => x.Trim().ToLowerInvariant())
            .Where(x => TopicCatalog.ContainsKey(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    private static List<string> MatchTopics(string title, string body, IEnumerable<string>? keywords)
    {
        var keywordSet = new HashSet<string>(
            (keywords ?? Array.Empty<string>())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim().ToLowerInvariant()),
            StringComparer.Ordinal);
        var corpus = $"{title} {body}".ToLowerInvariant();

        var matched = new List<string>();
        foreach (var topic in TopicCatalog.Values)
        {
            if (topic.Keywords.Any(keyword =>
                corpus.Contains(keyword, StringComparison.Ordinal)
                || keywordSet.Any(k => k.Contains(keyword, StringComparison.Ordinal) || keyword.Contains(k, StringComparison.Ordinal))))
            {
                matched.Add(topic.Key);
            }
        }

        return matched;
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

    private static string NormalizeAnswerRole(string? answerRole)
    {
        if (string.IsNullOrWhiteSpace(answerRole))
            return ZhunxingAnswerRoles.Employee;

        var normalized = answerRole.Trim().ToLowerInvariant();
        if (normalized is ZhunxingAnswerRoles.Employee
            or ZhunxingAnswerRoles.Supervisor
            or ZhunxingAnswerRoles.Hr)
        {
            return normalized;
        }

        return ZhunxingAnswerRoles.Employee;
    }

    private static List<ZhunxingDecisionStep> BuildNoMatchDecisionTree()
    {
        return new List<ZhunxingDecisionStep>
        {
            new()
            {
                StepNo = 1,
                Condition = "如果当前问题未命中",
                Action = "补充部门、流程节点、时长/阈值等关键上下文后重试。",
            },
            new()
            {
                StepNo = 2,
                Condition = "如果仍未命中",
                Action = "提交未命中反馈，由管理员补充条款后回放验证。",
            },
        };
    }

    private static List<ZhunxingDecisionStep> BuildDecisionTree(
        string question,
        IReadOnlyList<ZhunxingCitation> citations,
        bool conflictDetected)
    {
        var steps = new List<ZhunxingDecisionStep>
        {
            new()
            {
                StepNo = 1,
                Condition = "如果问题同时涉及多个流程（如请假+考勤）",
                Action = "先拆分流程逐项判断，避免混用条款导致误判。",
            },
        };

        var orderedCitations = citations
            .OrderByDescending(x => x.MatchScore)
            .ThenBy(x => x.Chapter, StringComparer.Ordinal)
            .Take(3)
            .ToList();

        var stepNo = 2;
        foreach (var citation in orderedCitations)
        {
            steps.Add(new ZhunxingDecisionStep
            {
                StepNo = stepNo++,
                Condition = BuildDecisionCondition(question, citation),
                Action = $"按 {citation.Chapter}《{citation.ClauseTitle}》执行：{BuildSnippet(citation.FullText)}",
                ClauseId = citation.ClauseId,
                Chapter = citation.Chapter,
                RiskLevel = citation.RiskLevel,
            });
        }

        if (conflictDetected)
        {
            steps.Add(new ZhunxingDecisionStep
            {
                StepNo = stepNo,
                Condition = "如果命中条款出现口径冲突",
                Action = "暂停自动执行，升级责任部门人工确认后再落地。",
            });
        }

        return steps;
    }

    private static string BuildDecisionCondition(string question, ZhunxingCitation citation)
    {
        var constraint = TryExtractConstraint(citation);
        if (constraint != null)
        {
            return $"如果满足「{citation.ClauseTitle}」且阈值为 {constraint.Operator}{constraint.Value}{constraint.Unit}";
        }

        var questionPrefix = question.Length > 16 ? $"{question[..16]}..." : question;
        return $"如果你的场景与「{questionPrefix}」匹配到 {citation.Chapter} 章节";
    }

    private static string BuildRoleAnswer(
        string answerRole,
        ZhunxingKnowledgeClause primaryClause,
        IReadOnlyList<ZhunxingCitation> citations,
        bool conflictDetected)
    {
        var primarySnippet = BuildSnippet(primaryClause.RuleText);
        var citationBrief = citations
            .Take(3)
            .Select(x => $"{x.DocumentTitle} {x.Chapter}")
            .ToList();

        return answerRole switch
        {
            ZhunxingAnswerRoles.Supervisor => string.Join(Environment.NewLine, new[]
            {
                $"审批口径：{primarySnippet}",
                $"管理动作：按 {primaryClause.Chapter}《{primaryClause.Title}》作为团队执行口径，超范围事项走升级审批。",
                $"风险提醒：当前风险等级为 {NormalizeRiskLabel(MaxRiskLevel(citations.Select(x => x.RiskLevel)))}。",
                conflictDetected
                    ? "冲突提示：当前命中条款存在口径差异，请先人工确认后再批复。"
                    : "复核建议：对特殊个案先核验例外条件，再做最终审批。",
            }),
            ZhunxingAnswerRoles.Hr => string.Join(Environment.NewLine, new[]
            {
                $"条款原文：{primaryClause.RuleText}",
                $"引用依据：{string.Join("；", citationBrief)}",
                "HR校验：请同步核验适用范围、例外条件、最新生效版本。",
                conflictDetected
                    ? "冲突提示：命中条款存在阈值或口径差异，需在制度层统一解释后发布。"
                    : "一致性提示：如有跨制度关联，建议附带相关补充说明。",
            }),
            _ => string.Join(Environment.NewLine, new[]
            {
                $"结论：{primarySnippet}",
                $"执行步骤：先按 {primaryClause.Chapter}《{primaryClause.Title}》执行，再补齐审批或留痕动作。",
                conflictDetected
                    ? "注意：当前条款存在冲突风险，请先找 HR/制度管理员确认。"
                    : "提示：遇到例外场景时请先提交审批后执行。",
            }),
        };
    }

    private static string NormalizeRiskLabel(string riskLevel)
    {
        return NormalizeRiskLevel(riskLevel) switch
        {
            ZhunxingRiskLevels.Sensitive => "高风险",
            ZhunxingRiskLevels.Internal => "内部",
            _ => "公开",
        };
    }

    private static List<ZhunxingConflictClause> DetectConflicts(string question, IReadOnlyList<ZhunxingCitation> citations)
    {
        if (citations.Count < 2)
            return new List<ZhunxingConflictClause>();

        var structured = citations
            .Select(c => new
            {
                Citation = c,
                Constraint = TryExtractConstraint(c),
            })
            .Where(x => x.Constraint != null)
            .Select(x => new
            {
                x.Citation,
                Constraint = x.Constraint!,
            })
            .ToList();

        if (structured.Count < 2)
            return new List<ZhunxingConflictClause>();

        var questionLower = question.ToLowerInvariant();
        var conflictMap = new Dictionary<string, ZhunxingConflictClause>(StringComparer.Ordinal);
        for (var i = 0; i < structured.Count; i++)
        {
            var left = structured[i];
            for (var j = i + 1; j < structured.Count; j++)
            {
                var right = structured[j];
                if (!string.Equals(left.Constraint.Topic, right.Constraint.Topic, StringComparison.Ordinal))
                    continue;
                if (!string.Equals(left.Constraint.Unit, right.Constraint.Unit, StringComparison.Ordinal))
                    continue;
                if (Math.Abs(left.Citation.MatchScore - right.Citation.MatchScore) > 2)
                    continue;
                if (!IsConflictPair(left.Constraint, right.Constraint))
                    continue;
                if (!TopicLikelyRelevantToQuestion(left.Constraint.Topic, questionLower))
                    continue;

                var reason =
                    $"同主题出现不同阈值：{left.Constraint.Operator}{left.Constraint.Value}{left.Constraint.Unit} 与 {right.Constraint.Operator}{right.Constraint.Value}{right.Constraint.Unit}";
                MergeConflictClause(conflictMap, left.Citation, reason);
                MergeConflictClause(conflictMap, right.Citation, reason);
            }
        }

        return conflictMap.Values
            .OrderByDescending(x => GetRiskRank(x.RiskLevel))
            .ThenBy(x => x.Chapter, StringComparer.Ordinal)
            .ToList();
    }

    private static bool TopicLikelyRelevantToQuestion(string topic, string questionLower)
    {
        return topic switch
        {
            "leave_approval" => questionLower.Contains("请假", StringComparison.Ordinal),
            "leave_limit" => questionLower.Contains("请假", StringComparison.Ordinal) || questionLower.Contains("事假", StringComparison.Ordinal),
            "attendance" => questionLower.Contains("考勤", StringComparison.Ordinal) || questionLower.Contains("打卡", StringComparison.Ordinal),
            "discipline" => questionLower.Contains("旷工", StringComparison.Ordinal) || questionLower.Contains("迟到", StringComparison.Ordinal),
            _ => true,
        };
    }

    private static bool IsConflictPair(ClauseConstraint left, ClauseConstraint right)
    {
        if (left.Value == right.Value && left.Operator == right.Operator)
            return false;

        var complementaryBoundary =
            (left.Operator == "<=" && right.Operator == ">" && left.Value == right.Value)
            || (left.Operator == ">" && right.Operator == "<=" && left.Value == right.Value);
        if (complementaryBoundary)
            return false;

        if (left.Operator == "==" && right.Operator == "==" && left.Value != right.Value)
            return true;

        if ((left.Operator == "<=" && right.Operator == "<=")
            || (left.Operator == ">=" && right.Operator == ">=")
            || (left.Operator == ">" && right.Operator == ">")
            || (left.Operator == "<" && right.Operator == "<"))
        {
            return left.Value != right.Value;
        }

        return (left.Operator == "<=" && right.Operator == ">=" && left.Value != right.Value)
            || (left.Operator == ">=" && right.Operator == "<=" && left.Value != right.Value)
            || (left.Operator == "<=" && right.Operator == ">")
            || (left.Operator == ">" && right.Operator == "<=");
    }

    private static void MergeConflictClause(
        Dictionary<string, ZhunxingConflictClause> conflictMap,
        ZhunxingCitation citation,
        string reason)
    {
        if (conflictMap.ContainsKey(citation.ClauseId))
            return;

        conflictMap[citation.ClauseId] = new ZhunxingConflictClause
        {
            ClauseId = citation.ClauseId,
            DocumentTitle = citation.DocumentTitle,
            Chapter = citation.Chapter,
            ClauseTitle = citation.ClauseTitle,
            RuleSummary = BuildSnippet(citation.FullText),
            ConflictReason = reason,
            RiskLevel = citation.RiskLevel,
        };
    }

    private static ClauseConstraint? TryExtractConstraint(ZhunxingCitation citation)
    {
        var topic = InferConstraintTopic(citation);
        if (string.IsNullOrWhiteSpace(topic))
            return null;

        var text = $"{citation.ClauseTitle} {citation.FullText}";

        var lessEqual = Regex.Match(text, @"(?:不超过|不高于|上限(?:为)?|最多|累计不超过)\s*(\d+)\s*(小时|天|分钟|次)");
        if (lessEqual.Success)
        {
            return new ClauseConstraint
            {
                Topic = topic,
                Operator = "<=",
                Value = int.Parse(lessEqual.Groups[1].Value),
                Unit = lessEqual.Groups[2].Value,
            };
        }

        var greater = Regex.Match(text, @"(?:超过|大于)\s*(\d+)\s*(小时|天|分钟|次)");
        if (greater.Success)
        {
            return new ClauseConstraint
            {
                Topic = topic,
                Operator = ">",
                Value = int.Parse(greater.Groups[1].Value),
                Unit = greater.Groups[2].Value,
            };
        }

        var greaterEqual = Regex.Match(text, @"(?:不少于|不低于|至少)\s*(\d+)\s*(小时|天|分钟|次)");
        if (greaterEqual.Success)
        {
            return new ClauseConstraint
            {
                Topic = topic,
                Operator = ">=",
                Value = int.Parse(greaterEqual.Groups[1].Value),
                Unit = greaterEqual.Groups[2].Value,
            };
        }

        var equal = Regex.Match(text, @"(?:为|可享受|享受)\s*(\d+)\s*(小时|天|分钟|次)");
        if (equal.Success)
        {
            return new ClauseConstraint
            {
                Topic = topic,
                Operator = "==",
                Value = int.Parse(equal.Groups[1].Value),
                Unit = equal.Groups[2].Value,
            };
        }

        return null;
    }

    private static string InferConstraintTopic(ZhunxingCitation citation)
    {
        var text = $"{citation.ClauseTitle} {citation.FullText}".ToLowerInvariant();
        if (text.Contains("请假", StringComparison.Ordinal) && text.Contains("审批", StringComparison.Ordinal))
            return "leave_approval";
        if (text.Contains("请假", StringComparison.Ordinal) && text.Contains("上限", StringComparison.Ordinal))
            return "leave_limit";
        if (text.Contains("打卡", StringComparison.Ordinal) || text.Contains("考勤", StringComparison.Ordinal))
            return "attendance";
        if (text.Contains("迟到", StringComparison.Ordinal) || text.Contains("旷工", StringComparison.Ordinal))
            return "discipline";

        return string.Empty;
    }

    private sealed class ClauseConstraint
    {
        public string Topic { get; init; } = string.Empty;
        public string Operator { get; init; } = string.Empty;
        public int Value { get; init; }
        public string Unit { get; init; } = string.Empty;
    }

    private sealed class TopicDefinition
    {
        public TopicDefinition(string key, string label, params string[] keywords)
        {
            Key = key;
            Label = label;
            Keywords = keywords;
        }

        public string Key { get; }
        public string Label { get; }
        public IReadOnlyList<string> Keywords { get; }
    }

    private sealed class HeatmapAccumulator
    {
        public HeatmapAccumulator(string topic, string topicLabel)
        {
            Topic = topic;
            TopicLabel = topicLabel;
        }

        public string Topic { get; }
        public string TopicLabel { get; }
        public int QuestionCount { get; set; }
        public int NoMatchCount { get; set; }
        public int PendingCount { get; set; }
        public double ConfidenceSum { get; set; }
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
