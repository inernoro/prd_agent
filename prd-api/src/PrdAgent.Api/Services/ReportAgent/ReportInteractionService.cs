using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>互动操作的失败结果：HTTP 状态 + 错误码 + 给人看的原因。</summary>
public sealed record ReportInteractionError(int StatusCode, string Code, string Message);

/// <summary>
/// 周报与月报共用的互动逻辑（评论 / 评论图片 / 点赞 / 浏览）。
/// 只负责「对一个已通过访问校验的 reportId 做什么」，访问校验由调用方（周报 / 月报控制器）
/// 统一走 ReportAccessPolicy 完成，这里不做任何权限判断。
/// 三张表（report_comments / report_likes / report_view_events）按 ReportId 关联，周报与月报 Id 都是 Guid，互不冲突。
/// </summary>
public sealed class ReportInteractionService
{
    public const long MaxCommentImageBytes = 5 * 1024 * 1024;

    /// <summary>单条评论最多携带的图片数</summary>
    public const int MaxCommentImages = 9;

    private static readonly HashSet<string> AllowedImageMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "image/gif"
    };

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;

    public ReportInteractionService(MongoDbContext db, IAssetStorage assetStorage)
    {
        _db = db;
        _assetStorage = assetStorage;
    }

    public static string ResolveUserDisplayName(User? user, string? claimName, string userId)
    {
        var displayName = user?.DisplayName?.Trim();
        if (!string.IsNullOrWhiteSpace(displayName))
            return displayName;

        var username = user?.Username?.Trim();
        if (!string.IsNullOrWhiteSpace(username))
            return username;

        var nameFromClaim = claimName?.Trim();
        if (!string.IsNullOrWhiteSpace(nameFromClaim))
            return nameFromClaim;

        // 评论必须实名展示：兜底至少展示 userId，不再显示“匿名”
        return userId;
    }

    /// <summary>裁剪可空字符串到指定长度；空白视为 null（划词锚点字段用）</summary>
    private static string? Truncate(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    #region Comments

    public async Task<List<ReportComment>> ListCommentsAsync(string reportId, int? sectionIndex)
    {
        var filter = Builders<ReportComment>.Filter.Eq(c => c.ReportId, reportId);
        if (sectionIndex.HasValue)
            filter &= Builders<ReportComment>.Filter.Eq(c => c.SectionIndex, sectionIndex.Value);

        var comments = await _db.ReportComments
            .Find(filter)
            .SortBy(c => c.CreatedAt)
            .ToListAsync();

        var pendingResolved = comments
            .Where(c => string.IsNullOrWhiteSpace(c.AuthorDisplayName) || c.AuthorDisplayName.Trim() == "匿名")
            .ToList();

        if (pendingResolved.Count > 0)
        {
            var authorIds = pendingResolved
                .Select(c => c.AuthorUserId)
                .Where(uid => !string.IsNullOrWhiteSpace(uid))
                .Distinct()
                .ToList();

            if (authorIds.Count > 0)
            {
                var users = await _db.Users
                    .Find(u => authorIds.Contains(u.UserId))
                    .ToListAsync();

                var userMap = users.ToDictionary(u => u.UserId, u => u);
                foreach (var comment in pendingResolved)
                {
                    userMap.TryGetValue(comment.AuthorUserId, out var authorUser);
                    comment.AuthorDisplayName = ResolveUserDisplayName(authorUser, null, comment.AuthorUserId);
                }
            }
        }

        await PopulateCommentAttachmentsAsync(comments);
        return comments;
    }

    /// <summary>
    /// 按 AttachmentIds 批量解析附件详情，填充到评论的 Attachments（仅接口返回，不落库）。
    /// 附件已被清理时静默跳过该图，评论文字仍正常展示。
    /// </summary>
    private async Task PopulateCommentAttachmentsAsync(List<ReportComment> comments)
    {
        var allIds = comments
            .Where(c => c.AttachmentIds is { Count: > 0 })
            .SelectMany(c => c.AttachmentIds!)
            .Distinct()
            .ToList();
        if (allIds.Count == 0) return;

        var attachments = await _db.Attachments
            .Find(a => allIds.Contains(a.AttachmentId))
            .ToListAsync();
        var map = attachments.ToDictionary(a => a.AttachmentId, a => a);

        foreach (var comment in comments)
        {
            if (comment.AttachmentIds is not { Count: > 0 }) continue;
            comment.Attachments = comment.AttachmentIds
                .Where(map.ContainsKey)
                .Select(aid =>
                {
                    var a = map[aid];
                    return new ReportCommentAttachmentInfo
                    {
                        AttachmentId = a.AttachmentId,
                        Url = a.Url,
                        FileName = a.FileName,
                        MimeType = a.MimeType
                    };
                })
                .ToList();
        }
    }

    /// <summary>创建评论（支持段落级 + 回复 + 划词锚点 + 图片）。sectionTitle 由调用方按自己的章节结构解析。</summary>
    public async Task<(ReportComment? Comment, ReportInteractionError? Error)> CreateCommentAsync(
        string reportId,
        string sectionTitle,
        string userId,
        string? claimName,
        CreateCommentRequest req)
    {
        var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var authorDisplayName = ResolveUserDisplayName(currentUser, claimName, userId);

        // 图片附件：去重清洗 + 数量上限 + 归属校验（只能引用自己上传的图片附件）
        var attachmentIds = (req.AttachmentIds ?? new List<string>())
            .Where(a => !string.IsNullOrWhiteSpace(a))
            .Select(a => a.Trim())
            .Distinct()
            .ToList();

        if (string.IsNullOrWhiteSpace(req.Content) && attachmentIds.Count == 0)
            return (null, new(400, "INVALID_FORMAT", "评论内容不能为空"));

        if (attachmentIds.Count > MaxCommentImages)
            return (null, new(400, "TOO_MANY_IMAGES", $"每条评论最多 {MaxCommentImages} 张图片"));

        if (attachmentIds.Count > 0)
        {
            var ownedAttachments = await _db.Attachments
                .Find(a => attachmentIds.Contains(a.AttachmentId))
                .ToListAsync();
            if (ownedAttachments.Count != attachmentIds.Count ||
                ownedAttachments.Any(a => a.UploaderId != userId || a.Type != AttachmentType.Image))
                return (null, new(400, "INVALID_ATTACHMENT", "存在无效的评论图片附件"));
        }

        // 如果是回复，验证父评论存在
        if (!string.IsNullOrEmpty(req.ParentCommentId))
        {
            var parent = await _db.ReportComments.Find(c => c.Id == req.ParentCommentId && c.ReportId == reportId).AnyAsync();
            if (!parent)
                return (null, new(400, "NOT_FOUND", "父评论不存在"));
        }

        // 划词锚点仅顶级评论生效；裁剪长度防止超长选区/上下文膨胀存储
        var isReply = !string.IsNullOrEmpty(req.ParentCommentId);
        var selectedText = isReply ? null : Truncate(req.SelectedText, 500);

        var comment = new ReportComment
        {
            ReportId = reportId,
            SectionIndex = req.SectionIndex,
            SectionTitleSnapshot = sectionTitle,
            ParentCommentId = string.IsNullOrEmpty(req.ParentCommentId) ? null : req.ParentCommentId,
            AuthorUserId = userId,
            AuthorDisplayName = authorDisplayName,
            Content = (req.Content ?? string.Empty).Trim(),
            AttachmentIds = attachmentIds.Count > 0 ? attachmentIds : null,
            SelectedText = selectedText,
            ContextBefore = selectedText == null ? null : Truncate(req.ContextBefore, 100),
            ContextAfter = selectedText == null ? null : Truncate(req.ContextAfter, 100),
            StartOffset = selectedText == null ? null : req.StartOffset,
            EndOffset = selectedText == null ? null : req.EndOffset
        };

        await _db.ReportComments.InsertOneAsync(comment);
        await PopulateCommentAttachmentsAsync(new List<ReportComment> { comment });
        return (comment, null);
    }

    /// <summary>上传评论图片，返回附件信息。</summary>
    public async Task<(object? Data, ReportInteractionError? Error)> UploadCommentImageAsync(
        string userId,
        IFormFile? file,
        CancellationToken ct)
    {
        if (file == null || file.Length == 0)
            return (null, new(400, "INVALID_FILE", "请选择图片文件"));

        if (file.Length > MaxCommentImageBytes)
            return (null, new(400, "FILE_TOO_LARGE", "图片大小不能超过 5MB"));

        var mimeType = file.ContentType?.Trim().ToLowerInvariant() ?? "application/octet-stream";
        if (!AllowedImageMimeTypes.Contains(mimeType))
            return (null, new(400, "UNSUPPORTED_TYPE", $"不支持的图片类型: {mimeType}"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        var stored = await _assetStorage.SaveAsync(
            bytes,
            mimeType,
            ct,
            domain: AppDomainPaths.DomainPrdAgent,
            type: AppDomainPaths.TypeImg);
        var attachment = new Attachment
        {
            UploaderId = userId,
            FileName = file.FileName,
            MimeType = mimeType,
            Size = file.Length,
            Url = stored.Url,
            StorageKey = stored.Key,
            Type = AttachmentType.Image,
            UploadedAt = DateTime.UtcNow
        };
        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: ct);

        return (new
        {
            attachmentId = attachment.AttachmentId,
            url = attachment.Url,
            fileName = attachment.FileName,
            mimeType = attachment.MimeType,
            size = attachment.Size
        }, null);
    }

    /// <summary>编辑评论（仅作者或管理员）</summary>
    public async Task<(ReportComment? Comment, ReportInteractionError? Error)> UpdateCommentAsync(
        string reportId,
        string commentId,
        string userId,
        bool isAdmin,
        string? content)
    {
        var comment = await _db.ReportComments.Find(c => c.Id == commentId && c.ReportId == reportId).FirstOrDefaultAsync();
        if (comment == null)
            return (null, new(404, "NOT_FOUND", "评论不存在"));

        if (comment.AuthorUserId != userId && !isAdmin)
            return (null, new(403, "PERMISSION_DENIED", "只能编辑自己的评论"));

        if (string.IsNullOrWhiteSpace(content))
            return (null, new(400, "INVALID_FORMAT", "评论内容不能为空"));

        var trimmed = content.Trim();
        if (trimmed == comment.Content)
            return (comment, null);

        var update = Builders<ReportComment>.Update
            .Set(c => c.Content, trimmed)
            .Set(c => c.UpdatedAt, DateTime.UtcNow);
        await _db.ReportComments.UpdateOneAsync(c => c.Id == commentId, update);

        comment.Content = trimmed;
        comment.UpdatedAt = DateTime.UtcNow;
        return (comment, null);
    }

    /// <summary>删除评论及其所有回复（仅作者或管理员）</summary>
    public async Task<ReportInteractionError?> DeleteCommentAsync(
        string reportId,
        string commentId,
        string userId,
        bool isAdmin)
    {
        var comment = await _db.ReportComments.Find(c => c.Id == commentId && c.ReportId == reportId).FirstOrDefaultAsync();
        if (comment == null)
            return new(404, "NOT_FOUND", "评论不存在");

        if (comment.AuthorUserId != userId && !isAdmin)
            return new(403, "PERMISSION_DENIED", "只能删除自己的评论");

        await _db.ReportComments.DeleteManyAsync(
            c => c.Id == commentId || c.ParentCommentId == commentId);
        return null;
    }

    #endregion

    #region Likes

    public async Task<object> BuildLikeSummaryAsync(string reportId, string currentUserId)
    {
        var likes = await _db.ReportLikes
            .Find(x => x.ReportId == reportId)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync();

        var authorIds = likes
            .Select(x => x.UserId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct()
            .ToList();

        Dictionary<string, User> userMap = new(StringComparer.Ordinal);
        if (authorIds.Count > 0)
        {
            var users = await _db.Users.Find(u => authorIds.Contains(u.UserId)).ToListAsync();
            userMap = users.ToDictionary(u => u.UserId, u => u);
        }

        foreach (var like in likes)
        {
            userMap.TryGetValue(like.UserId, out var user);
            if (string.IsNullOrWhiteSpace(like.UserName))
            {
                like.UserName = ResolveUserDisplayName(user, null, like.UserId);
            }
            if (string.IsNullOrWhiteSpace(like.AvatarFileName) && !string.IsNullOrWhiteSpace(user?.AvatarFileName))
            {
                like.AvatarFileName = user!.AvatarFileName;
            }
        }

        return new
        {
            likedByMe = likes.Any(x => x.UserId == currentUserId),
            count = likes.Count,
            users = likes.Select(x => new
            {
                userId = x.UserId,
                userName = !string.IsNullOrWhiteSpace(x.UserName) ? x.UserName : x.UserId,
                avatarFileName = x.AvatarFileName,
                likedAt = x.CreatedAt
            }).ToList()
        };
    }

    /// <summary>点赞（幂等）</summary>
    public async Task LikeAsync(string reportId, string userId, string? claimName)
    {
        var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var like = new ReportLike
        {
            ReportId = reportId,
            UserId = userId,
            UserName = ResolveUserDisplayName(currentUser, claimName, userId),
            AvatarFileName = currentUser?.AvatarFileName
        };

        try
        {
            await _db.ReportLikes.InsertOneAsync(like);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 幂等：重复点赞不报错
        }
    }

    /// <summary>取消点赞（幂等）</summary>
    public Task UnlikeAsync(string reportId, string userId)
        => _db.ReportLikes.DeleteOneAsync(x => x.ReportId == reportId && x.UserId == userId);

    #endregion

    #region Views

    /// <summary>记录一次浏览（每次打开/刷新都记录）</summary>
    public async Task<DateTime> RecordViewAsync(string reportId, string userId, string? claimName)
    {
        var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var viewEvent = new ReportViewEvent
        {
            ReportId = reportId,
            UserId = userId,
            UserName = ResolveUserDisplayName(currentUser, claimName, userId),
            AvatarFileName = currentUser?.AvatarFileName,
            ViewedAt = DateTime.UtcNow
        };

        await _db.ReportViewEvents.InsertOneAsync(viewEvent);
        return viewEvent.ViewedAt;
    }

    public async Task<object> BuildViewSummaryAsync(string reportId, string reportOwnerUserId)
    {
        var events = await _db.ReportViewEvents
            .Find(x => x.ReportId == reportId)
            .SortByDescending(x => x.ViewedAt)
            .ToListAsync();

        var viewerIds = events
            .Select(x => x.UserId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct()
            .ToList();

        Dictionary<string, User> userMap = new(StringComparer.Ordinal);
        if (viewerIds.Count > 0)
        {
            var users = await _db.Users.Find(u => viewerIds.Contains(u.UserId)).ToListAsync();
            userMap = users.ToDictionary(u => u.UserId, u => u);
        }

        foreach (var viewEvent in events)
        {
            userMap.TryGetValue(viewEvent.UserId, out var user);
            if (string.IsNullOrWhiteSpace(viewEvent.UserName))
            {
                viewEvent.UserName = ResolveUserDisplayName(user, null, viewEvent.UserId);
            }
            if (string.IsNullOrWhiteSpace(viewEvent.AvatarFileName) && !string.IsNullOrWhiteSpace(user?.AvatarFileName))
            {
                viewEvent.AvatarFileName = user!.AvatarFileName;
            }
        }

        var groupedByUser = events
            .GroupBy(x => x.UserId)
            .Select(g =>
            {
                var latest = g.OrderByDescending(x => x.ViewedAt).First();
                var userId = latest.UserId;
                var displayName = !string.IsNullOrWhiteSpace(latest.UserName) ? latest.UserName : userId;
                var isFrequent = g.Count() > 5;
                var isOwner = !string.IsNullOrWhiteSpace(reportOwnerUserId) && userId == reportOwnerUserId;
                return new
                {
                    userId,
                    userName = displayName,
                    avatarFileName = latest.AvatarFileName,
                    viewCount = g.Count(),
                    lastViewedAt = latest.ViewedAt,
                    isFrequent,
                    isOwner
                };
            })
            .OrderBy(x => x.isOwner)
            .ThenByDescending(x => x.lastViewedAt)
            .ToList();

        return new
        {
            count = groupedByUser.Count,
            totalViewCount = events.Count,
            users = groupedByUser
        };
    }

    #endregion

    /// <summary>删除一份报告时清理它的全部互动数据（评论 / 点赞 / 浏览）。</summary>
    public async Task DeleteAllForReportAsync(string reportId)
    {
        await _db.ReportComments.DeleteManyAsync(c => c.ReportId == reportId);
        await _db.ReportLikes.DeleteManyAsync(l => l.ReportId == reportId);
        await _db.ReportViewEvents.DeleteManyAsync(v => v.ReportId == reportId);
    }
}
