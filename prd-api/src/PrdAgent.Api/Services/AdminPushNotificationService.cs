using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using MongoDB.Bson;
using System.Security.Cryptography;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AgentTools;
using PrdAgent.Infrastructure.Services.ClaudeSidecar;

namespace PrdAgent.Api.Services;

public sealed class AdminPushNotificationService
{
    private static readonly Regex PlaceholderRegex = new(@"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}", RegexOptions.Compiled);
    private static readonly HashSet<string> SupportedMethods = new(StringComparer.OrdinalIgnoreCase) { "GET", "POST" };
    private static readonly HashSet<string> SupportedBarkLevels = new(StringComparer.OrdinalIgnoreCase) { "active", "timeSensitive", "passive", "critical" };
    private const int MaxRecipientAttemptsPerWindow = 7;
    private static readonly TimeSpan RecipientWindow = TimeSpan.FromMinutes(5);
    private const int MaxCandidateNotificationsPerRecipient = 1000;
    private const string DefaultBarkServerUrl = "https://api.day.app";
    private static readonly TimeSpan FailedRetryCooldown = TimeSpan.FromMinutes(10);

    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly ILogger<AdminPushNotificationService> _logger;
    private readonly string? _publicBaseUrl;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _aggregationDelay;

    public AdminPushNotificationService(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        ISafeOutboundUrlValidator urlValidator,
        IConfiguration configuration,
        ILogger<AdminPushNotificationService> logger,
        TimeProvider? clock = null)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _urlValidator = urlValidator;
        _logger = logger;
        _publicBaseUrl = ResolvePublicBaseUrl(configuration);
        _clock = clock ?? TimeProvider.System;
        _aggregationDelay = TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue("AdminPush:AggregationSeconds", 15), 0, 60));
    }

    public static IReadOnlyList<AdminPushTopicDefinition> TopicDefinitions { get; } =
    [
        new("defect-management", "缺陷管理", "缺陷提交、指派、验收、AI 修复等提醒", "defect-agent", "defect-management"),
        new("system-alert", "系统预警", "模型池、平台密钥、开放平台额度等运营告警", "system", "system-alert"),
        new("admin-message", "管理员站内信", "服务器到期、配置提醒、人工公告等管理员通知", "admin-notice", "admin-message"),
        new("server-expiry", "服务器到期", "服务器、证书、域名、部署资源到期提醒", "admin-notice", "server-expiry"),
        new("user-voice", "用户之声", "真实用户反馈、体验痛点、主动提交的缺陷反馈", "user-voice", "user-voice"),
        new("api-request-alert", "API 请求问题", "慢接口、错误率、调用失败、网关异常等请求告警", "api-request-alert", "api-request-alert"),
        new("report-agent", "周报协作", "周报提交、退回、审阅、逾期等提醒", "report-agent", "report-agent"),
    ];

    public static IReadOnlyList<AdminPushResourceDefinition> ResourceDefinitions { get; } =
    [
        new(
            "defect-management",
            "缺陷管理",
            "缺陷提交、指派、验收、AI 修复等提醒",
            "https://placehold.co/256x256/e11d48/ffffff/png?text=DEF",
            "MAP System-缺陷管理",
            "/document-store?scope=defect-management",
            "缺陷修复验收报告",
            "acceptance-report-v2",
            "blue"),
        new(
            "system-alert",
            "系统预警",
            "通用预警、平台密钥、模型池、额度等风险提示",
            "https://placehold.co/256x256/f59e0b/111827/png?text=ALERT",
            "MAP System-系统预警",
            "/document-store?scope=system-alert",
            "MAP",
            null,
            "amber"),
        new(
            "admin-message",
            "管理员站内信",
            "服务器到期、管理员公告、配置提醒",
            "https://placehold.co/256x256/2563eb/ffffff/png?text=ADMIN",
            "MAP System-管理员站内信",
            "/document-store?scope=admin-message",
            "MAP",
            null,
            "pink"),
        new(
            "server-expiry",
            "服务器到期",
            "服务器、证书、域名、部署资源到期提醒",
            "https://placehold.co/256x256/7c3aed/ffffff/png?text=SERVER",
            "MAP System-服务器到期",
            "/document-store?scope=server-expiry",
            "MAP",
            null,
            "purple"),
        new(
            "user-voice",
            "用户之声",
            "用户主动反馈、真实缺陷、体验痛点",
            "https://placehold.co/256x256/0891b2/ffffff/png?text=VOC",
            "MAP System-用户之声",
            "/document-store?scope=user-voice",
            "MAP",
            null,
            "teal"),
        new(
            "api-request-alert",
            "API 请求问题",
            "HTTP 错误、慢请求、网关异常、第三方接口失败",
            "https://placehold.co/256x256/d97706/ffffff/png?text=API",
            "MAP System-API 请求问题",
            "/document-store?scope=api-request-alert",
            "API 请求问题",
            null,
            "orange"),
        new(
            "report-agent",
            "周报协作",
            "周报提交、退回、审阅和团队协作提醒",
            "https://placehold.co/256x256/059669/ffffff/png?text=REPORT",
            "MAP System-周报协作",
            "/document-store?scope=report-agent",
            "日报知识库",
            null,
            "green"),
    ];

    public static IReadOnlyList<AdminPushPresetDefinition> PresetDefinitions { get; } =
    [
        new(
            "bark-protocol",
            "Bark 协议",
            "bark",
            "GET",
            "",
            null,
            "application/json"),
        new(
            "bark-url",
            "Bark URL 模板",
            "url",
            "GET",
            "https://api.day.app/YOUR_KEY/MAP System-{{appname}}/{{message}}",
            null,
            "application/json"),
        new(
            "generic-webhook",
            "通用 Webhook JSON",
            "webhook",
            "POST",
            "https://example.com/webhook",
            "{\"appname\":\"{{appname}}\",\"title\":\"{{title}}\",\"message\":\"{{message}}\",\"level\":\"{{level}}\",\"source\":\"{{source}}\",\"actionUrl\":\"{{actionUrl}}\"}",
            "application/json"),
        new(
            "wechat-work-bot",
            "企业微信机器人",
            "wechat-work",
            "POST",
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY",
            "{\"msgtype\":\"text\",\"text\":{\"content\":\"MAP System-{{appname}}\\n{{title}}\\n{{message}}\\n{{actionUrl}}\"}}",
            "application/json"),
        new(
            "feishu-bot",
            "飞书机器人",
            "feishu",
            "POST",
            "https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_TOKEN",
            "{\"msg_type\":\"text\",\"content\":{\"text\":\"MAP System-{{appname}}\\n{{title}}\\n{{message}}\\n{{actionUrl}}\"}}",
            "application/json"),
        new(
            "dingtalk-bot",
            "钉钉机器人",
            "dingtalk",
            "POST",
            "https://oapi.dingtalk.com/robot/send?access_token=YOUR_TOKEN",
            "{\"msgtype\":\"text\",\"text\":{\"content\":\"MAP System-{{appname}}\\n{{title}}\\n{{message}}\\n{{actionUrl}}\"}}",
            "application/json"),
    ];

    public async Task<List<AdminPushSubscription>> GetSubscriptionsAsync(string userId, CancellationToken ct)
    {
        var existing = await _db.AdminPushSubscriptions
            .Find(x => x.UserId == userId)
            .ToListAsync(ct);

        var byTopic = existing
            .GroupBy(x => x.TopicKey)
            .ToDictionary(x => x.Key, x => x.OrderByDescending(s => s.UpdatedAt).First(), StringComparer.OrdinalIgnoreCase);

        return TopicDefinitions.Select(topic =>
        {
            if (byTopic.TryGetValue(topic.Key, out var sub)) return sub;
            var preset = PresetDefinitions[0];
            var resource = ResolveResource(topic);
            return new AdminPushSubscription
            {
                UserId = userId,
                TopicKey = topic.Key,
                Enabled = false,
                UseDefaultProfile = true,
                ChannelType = preset.ChannelType,
                Method = preset.Method,
                UrlTemplate = preset.UrlTemplate,
                BodyTemplate = preset.BodyTemplate,
                ContentType = preset.ContentType,
                BarkServerUrl = DefaultBarkServerUrl,
                BarkGroup = resource.DefaultGroup,
                BarkIcon = "{{iconUrl}}",
                BarkImageTemplate = "{{imageUrl}}",
            };
        }).ToList();
    }

    public async Task<AdminPushProfile> GetDefaultProfileAsync(string userId, CancellationToken ct)
    {
        var profile = await _db.AdminPushProfiles
            .Find(x => x.UserId == userId)
            .SortByDescending(x => x.UpdatedAt)
            .ThenByDescending(x => x.Id)
            .FirstOrDefaultAsync(ct);
        if (profile != null) return profile;

        var latestConfiguredSubscription = await _db.AdminPushSubscriptions
            .Find(x => x.UserId == userId
                && (x.ChannelType == "bark" || x.UrlTemplate != string.Empty || x.BarkKey != null))
            .SortByDescending(x => x.UpdatedAt)
            .ThenByDescending(x => x.Id)
            .FirstOrDefaultAsync(ct);

        return latestConfiguredSubscription == null
            ? BuildDefaultProfile(userId)
            : BuildProfileFromSubscription(userId, latestConfiguredSubscription);
    }

    public async Task<AdminPushProfile> UpsertDefaultProfileAsync(string userId, AdminPushProfileUpsertRequest request, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var existing = await _db.AdminPushProfiles
            .Find(x => x.UserId == userId)
            .SortByDescending(x => x.UpdatedAt)
            .ThenByDescending(x => x.Id)
            .FirstOrDefaultAsync(ct);

        var profile = existing ?? new AdminPushProfile
        {
            UserId = userId,
            CreatedAt = now,
        };

        ApplyProfileRequest(profile, request);
        profile.UpdatedAt = now;

        await ValidateProfilePreviewAsync(profile, ct);

        if (existing == null)
        {
            await _db.AdminPushProfiles.InsertOneAsync(profile, cancellationToken: CancellationToken.None);
        }
        else
        {
            await _db.AdminPushProfiles.ReplaceOneAsync(x => x.Id == profile.Id, profile, cancellationToken: CancellationToken.None);
        }

        await _db.AdminPushProfiles.DeleteManyAsync(
            x => x.UserId == userId && x.Id != profile.Id,
            CancellationToken.None);

        return profile;
    }

    public async Task<AdminPushSubscription> UpsertSubscriptionAsync(string userId, AdminPushSubscriptionUpsertRequest request, CancellationToken ct)
    {
        var topic = TopicDefinitions.FirstOrDefault(x => x.Key.Equals((request.TopicKey ?? string.Empty).Trim(), StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException("未知订阅类型");

        var useDefaultProfile = request.UseDefaultProfile ?? false;
        var channelType = NormalizeText(request.ChannelType, "url", 64);
        var isBark = channelType.Equals("bark", StringComparison.OrdinalIgnoreCase);
        var method = isBark ? "GET" : (request.Method ?? "GET").Trim().ToUpperInvariant();
        if (!SupportedMethods.Contains(method))
            throw new InvalidOperationException("推送请求方式仅支持 GET 或 POST");

        var urlTemplate = (request.UrlTemplate ?? string.Empty).Trim();
        var barkKey = NormalizeNullableText(request.BarkKey, 256);
        var barkServerUrl = NormalizeNullableText(request.BarkServerUrl, 512) ?? DefaultBarkServerUrl;
        var barkLevel = NormalizeNullableText(request.BarkLevel, 32);
        if (!string.IsNullOrWhiteSpace(barkLevel) && !SupportedBarkLevels.Contains(barkLevel))
            throw new InvalidOperationException("Bark 时效级别无效");

        var now = DateTime.UtcNow;
        var existing = await _db.AdminPushSubscriptions
            .Find(x => x.UserId == userId && x.TopicKey == topic.Key)
            .SortByDescending(x => x.UpdatedAt)
            .ThenByDescending(x => x.Id)
            .FirstOrDefaultAsync(ct);

        var entity = existing ?? new AdminPushSubscription
        {
            UserId = userId,
            TopicKey = topic.Key,
            CreatedAt = now,
        };

        entity.Enabled = request.Enabled;
        entity.UseDefaultProfile = useDefaultProfile;
        entity.ChannelType = channelType;
        entity.Method = method;
        entity.UrlTemplate = urlTemplate;
        entity.BodyTemplate = string.IsNullOrWhiteSpace(request.BodyTemplate) ? null : request.BodyTemplate;
        entity.ContentType = NormalizeText(request.ContentType, "application/json", 96);
        entity.BarkKey = barkKey;
        entity.BarkServerUrl = barkServerUrl;
        entity.BarkGroup = NormalizeNullableText(request.BarkGroup, 128);
        entity.BarkSound = NormalizeNullableText(request.BarkSound, 96);
        entity.BarkLevel = barkLevel;
        entity.BarkIcon = NormalizeNullableText(request.BarkIcon, 1024);
        entity.BarkImageTemplate = NormalizeNullableText(request.BarkImageTemplate, 1024);
        entity.BarkUrlTemplate = NormalizeNullableText(request.BarkUrlTemplate, 1024);
        entity.BarkCall = request.BarkCall;
        entity.UpdatedAt = now;

        if (entity.Enabled)
        {
            var effective = entity.UseDefaultProfile
                ? ApplyProfileToSubscription(entity, await GetDefaultProfileAsync(userId, ct))
                : entity;
            await ValidateSubscriptionPreviewAsync(effective, topic, ct);
        }

        if (existing == null)
        {
            await _db.AdminPushSubscriptions.InsertOneAsync(entity, cancellationToken: CancellationToken.None);
        }
        else
        {
            await _db.AdminPushSubscriptions.ReplaceOneAsync(x => x.Id == entity.Id, entity, cancellationToken: CancellationToken.None);
        }

        await _db.AdminPushSubscriptions.DeleteManyAsync(
            x => x.UserId == userId && x.TopicKey == topic.Key && x.Id != entity.Id,
            CancellationToken.None);

        if (entity.Enabled && existing?.Enabled != true)
        {
            var effective = entity.UseDefaultProfile
                ? ApplyProfileToSubscription(entity, await GetDefaultProfileAsync(userId, ct))
                : entity;
            await MarkExistingNotificationsAsDeliveredAsync(effective, now, ct);
        }

        return entity;
    }

    public async Task<AdminPushDeliveryLog> SendTestAsync(string userId, AdminPushSubscriptionUpsertRequest request, CancellationToken ct)
    {
        var topic = TopicDefinitions.FirstOrDefault(x => x.Key.Equals((request.TopicKey ?? string.Empty).Trim(), StringComparison.OrdinalIgnoreCase))
            ?? TopicDefinitions[0];

        var sub = new AdminPushSubscription
        {
            Id = "test",
            UserId = userId,
            TopicKey = topic.Key,
            Enabled = true,
            UseDefaultProfile = request.UseDefaultProfile ?? false,
            ChannelType = NormalizeText(request.ChannelType, "url", 64),
            Method = NormalizeText(request.ChannelType, "url", 64).Equals("bark", StringComparison.OrdinalIgnoreCase)
                ? "GET"
                : (request.Method ?? "GET").Trim().ToUpperInvariant(),
            UrlTemplate = (request.UrlTemplate ?? string.Empty).Trim(),
            BodyTemplate = string.IsNullOrWhiteSpace(request.BodyTemplate) ? null : request.BodyTemplate,
            ContentType = NormalizeText(request.ContentType, "application/json", 96),
            BarkKey = NormalizeNullableText(request.BarkKey, 256),
            BarkServerUrl = NormalizeNullableText(request.BarkServerUrl, 512) ?? DefaultBarkServerUrl,
            BarkGroup = NormalizeNullableText(request.BarkGroup, 128),
            BarkSound = NormalizeNullableText(request.BarkSound, 96),
            BarkLevel = NormalizeNullableText(request.BarkLevel, 32),
            BarkIcon = NormalizeNullableText(request.BarkIcon, 1024),
            BarkImageTemplate = NormalizeNullableText(request.BarkImageTemplate, 1024),
            BarkUrlTemplate = NormalizeNullableText(request.BarkUrlTemplate, 1024),
            BarkCall = request.BarkCall,
        };

        if (sub.UseDefaultProfile)
            sub = ApplyProfileToSubscription(sub, await GetDefaultProfileAsync(userId, ct));

        ValidateCompleteSubscription(sub);

        var notification = new AdminNotification
        {
            Id = "test",
            Title = "管理员推送测试",
            Message = "这是一条测试通知，用于验证占位符模板和外部接口连通性。",
            Level = "info",
            Source = topic.Source,
            ActionUrl = "/notifications",
            CreatedAt = DateTime.UtcNow,
        };

        var now = _clock.GetUtcNow().UtcDateTime;
        var owner = Guid.NewGuid().ToString("N");
        var state = await AcquireRecipientAsync(userId, owner, now, ct);
        if (state == null) throw new InvalidOperationException("通知正在处理，请稍后再测试");
        var states = _db.Database.GetCollection<BsonDocument>("admin_push_dispatch_state");
        var owned = new BsonDocument { { "_id", userId }, { "owner", owner } };
        try
        {
            var budget = ReadBudget(state, now);
            if (budget.Attempts.Count > 0)
                throw new InvalidOperationException("近期已发送通知，通道测试请在 5 分钟后重试");
            budget.Attempts.Add(new BsonDocument { { "at", now }, { "urgent", false } });
            var reserved = await states.UpdateOneAsync(owned, new BsonDocument("$set", BudgetFields(budget)), cancellationToken: ct);
            if (reserved.MatchedCount != 1) throw new InvalidOperationException("通知状态已变化，请稍后再测试");
            notification.Id = Guid.NewGuid().ToString("N");
            var receipt = new AdminPushDeliveryLog { UserId = userId, NotificationId = notification.Id,
                SubscriptionId = sub.Id, TopicKey = sub.TopicKey, DeliveryState = "reserved", CreatedAt = now };
            await _db.AdminPushDeliveryLogs.InsertOneAsync(receipt, cancellationToken: ct);
            return await DeliverAsync(userId, sub, notification, saveLog: true, ct, receipt);
        }
        finally { await states.UpdateOneAsync(owned, new BsonDocument("$set", new BsonDocument("leaseUntil", DateTime.UnixEpoch)), cancellationToken: CancellationToken.None); }
    }

    public async Task DispatchPendingAsync(CancellationToken ct)
    {
        var subscriptions = await _db.AdminPushSubscriptions.Find(x => x.Enabled).ToListAsync(ct);
        foreach (var recipient in PickLatestEnabledSubscriptions(subscriptions).GroupBy(x => x.UserId))
        {
            try { await DispatchRecipientAsync(recipient.Key, recipient.ToList(), ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "用户推送扫描失败 user={UserId}", recipient.Key); }
        }
    }

    private async Task<BsonDocument?> AcquireRecipientAsync(string userId, string owner, DateTime now, CancellationToken ct)
    {
        var states = _db.Database.GetCollection<BsonDocument>("admin_push_dispatch_state");
        // _id 的唯一约束让多个副本共享同一个收件人闸门；额度在联网前占用。
        try
        {
            await states.UpdateOneAsync(new BsonDocument("_id", userId),
                new BsonDocument("$setOnInsert", new BsonDocument {
                    { "leaseUntil", DateTime.UnixEpoch }, { "lastAttemptAt", now },
                    { "attempts", 0 }, { "sources", new BsonArray() }
                }), new UpdateOptions { IsUpsert = true }, ct);
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey) { }
        return await states.FindOneAndUpdateAsync(
            new BsonDocument { { "_id", userId }, { "leaseUntil", new BsonDocument("$lte", now) } },
            new BsonDocument("$set", new BsonDocument { { "owner", owner }, { "leaseUntil", now.AddMinutes(2) } }),
            new FindOneAndUpdateOptions<BsonDocument> { ReturnDocument = ReturnDocument.After }, ct);
    }

    private async Task DispatchRecipientAsync(string userId, List<AdminPushSubscription> subscriptions, CancellationToken ct)
    {
        var now = _clock.GetUtcNow().UtcDateTime;
        var states = _db.Database.GetCollection<BsonDocument>("admin_push_dispatch_state");
        var owner = Guid.NewGuid().ToString("N");
        var state = await AcquireRecipientAsync(userId, owner, now, ct);
        if (state == null) return;
        var owned = new BsonDocument { { "_id", userId }, { "owner", owner } };
        try
        {
            var budget = ReadBudget(state, now);
            if (budget.Attempts.Count >= MaxRecipientAttemptsPerWindow) return;
            var filter = Builders<AdminNotification>.Filter.Eq(x => x.Status, "open")
                & (Builders<AdminNotification>.Filter.Eq(x => x.TargetUserId, null)
                   | Builders<AdminNotification>.Filter.Eq(x => x.TargetUserId, userId))
                & (Builders<AdminNotification>.Filter.Eq(x => x.ExpiresAt, null)
                   | Builders<AdminNotification>.Filter.Gt(x => x.ExpiresAt, now));
            // 在分页之前排除已处理项，防止较新的已发送记录挡住旧的独立问题。
            var terminalReceipt = new BsonDocument("$lookup", new BsonDocument {
                { "from", "admin_push_delivery_logs" }, { "let", new BsonDocument("noticeId", new BsonDocument("$toString", "$_id")) },
                { "pipeline", new BsonArray {
                    new BsonDocument("$match", new BsonDocument {
                        { "UserId", userId },
                        { "$or", new BsonArray { new BsonDocument("Success", true),
                            new BsonDocument("DeliveryState", new BsonDocument("$in", new BsonArray { "reserved", "unconfirmed" })) } },
                        { "$expr", new BsonDocument("$or", new BsonArray {
                            new BsonDocument("$eq", new BsonArray { "$NotificationId", "$$noticeId" }),
                            new BsonDocument("$in", new BsonArray { "$$noticeId", new BsonDocument("$ifNull", new BsonArray { "$CoveredNotificationIds", new BsonArray() }) })
                        }) }
                    }), new BsonDocument("$limit", 1), new BsonDocument("$project", new BsonDocument("_id", 1))
                } }, { "as", "_pushReceipt" }
            });
            using var candidateCursor = await _db.AdminNotifications.Aggregate().Match(filter).SortBy(x => x.Level).ThenBy(x => x.CreatedAt)
                .AppendStage<AdminNotification>(terminalReceipt)
                .Match(new BsonDocument("_pushReceipt.0", new BsonDocument("$exists", false)))
                .Project<AdminNotification>(new BsonDocument("_pushReceipt", 0)).ToCursorAsync(ct);
            var candidates = new List<AdminNotification>();
            while (await candidateCursor.MoveNextAsync(ct))
            {
                foreach (var candidate in candidateCursor.Current)
                {
                    if (!subscriptions.Any(subscription => MatchesTopic(subscription.TopicKey, candidate))) continue;
                    if (candidates.Count < MaxCandidateNotificationsPerRecipient) candidates.Add(candidate);
                    else if (IsFreshUrgent(candidate, budget))
                    {
                        var replace = candidates.FindLastIndex(n => !IsFreshUrgent(n, budget));
                        if (replace >= 0) candidates[replace] = candidate;
                    }
                    // Level 排序先扫描 error；普通积压无需全部加载。
                    if (candidate.Level != "error" && candidates.Count >= MaxCandidateNotificationsPerRecipient) break;
                }
                if (candidates.Count >= MaxCandidateNotificationsPerRecipient && candidateCursor.Current.LastOrDefault()?.Level != "error") break;
            }
            var ids = candidates.Select(x => x.Id).ToList();
            var logs = await _db.AdminPushDeliveryLogs.Find(x => x.UserId == userId
                && (ids.Contains(x.NotificationId) || x.CoveredNotificationIds.Any(id => ids.Contains(id))))
                .ToListAsync(ct);
            var routes = new List<(AdminPushSubscription Route, AdminNotification Notice, string Key)>();
            foreach (var subscription in subscriptions)
            {
                var effective = subscription.UseDefaultProfile
                    ? ApplyProfileToSubscription(subscription, await GetDefaultProfileAsync(userId, ct)) : subscription;
                var routeKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                    effective.ChannelType == "bark"
                        ? $"bark:{effective.BarkServerUrl}:{effective.BarkKey}"
                        : $"{effective.ChannelType}:{effective.Method}:{effective.ContentType}:{effective.UrlTemplate}:{effective.BodyTemplate}")));
                foreach (var notice in candidates.Where(n => MatchesTopic(subscription.TopicKey, n)))
                {
                    var receipts = logs.Where(l => (l.TopicKey == subscription.TopicKey || l.CoveredNotificationIds.Contains(notice.Id))
                        && (l.NotificationId == notice.Id || l.CoveredNotificationIds.Contains(notice.Id))).ToList();
                    // 发送结果不确定时不盲目重放；记录仍可供管理员追查。
                    if (receipts.Any(l => l.Success || l.DeliveryState is "reserved" or "unconfirmed")) continue;
                    if (receipts.Count >= 3 || receipts.Any(l => l.CreatedAt > now.Subtract(FailedRetryCooldown))) continue;
                    routes.Add((effective, notice, routeKey));
                }
            }
            if (routes.Count == 0) return;
            var urgentAttempts = budget.Attempts.Where(a => a["urgent"].AsBoolean).ToList();
            var urgentReady = urgentAttempts.Count < 5 && (urgentAttempts.Count == 0
                || now - urgentAttempts.Last()["at"].ToUniversalTime() >= TimeSpan.FromMinutes(1));
            var freshUrgent = routes.Where(r => IsFreshUrgent(r.Notice, budget)).ToList();
            var useUrgent = urgentReady && freshUrgent.Count > 0;
            var normalReady = budget.Attempts.Count - urgentAttempts.Count < 2
                && (budget.Attempts.Count == 0 || now - budget.Attempts.Last()["at"].ToUniversalTime() >= TimeSpan.FromMinutes(1));
            if (!useUrgent && !normalReady) return;
            var selected = (useUrgent ? freshUrgent : routes).OrderByDescending(r => r.Notice.Level == "error")
                .ThenBy(r => r.Notice.CreatedAt).First();
            var batch = routes.Where(r => r.Key == selected.Key).DistinctBy(r => r.Notice.Id)
                .OrderByDescending(r => IsFreshUrgent(r.Notice, budget)).ToList();
            if (!useUrgent && now - batch.Min(r => r.Notice.CreatedAt) < _aggregationDelay) return;
            var notices = batch.Select(r => r.Notice).ToList();
            var notification = notices.Count == 1 ? notices[0] : new AdminNotification
            {
                Title = useUrgent ? $"新增严重故障，共 {notices.Count} 项消息" : $"有 {notices.Count} 项新消息需要查看",
                Message = $"共 {notices.Count} 项：" + string.Join("；", notices.Select(n => n.Title ?? "业务消息").Distinct()
                    .Take(2).Select(title => TrimForLog(title, 40)))
                    + "。已合并提醒，数量不等于事故数；请到消息中心逐项查看影响与处理入口。",
                Level = notices.Any(n => n.Level == "error") ? "error" : "warning",
                Source = "system", TargetUserId = userId, ActionUrl = "/?panel=notifications", CreatedAt = now,
            };
            var reservation = new AdminPushDeliveryLog
            {
                UserId = userId, SubscriptionId = selected.Route.Id, TopicKey = selected.Route.TopicKey,
                NotificationId = notification.Id, CoveredNotificationIds = notices.Select(n => n.Id).ToList(),
                DeliveryState = "reserved", CreatedAt = now,
            };
            // 先持久化额度与批次，再执行有外部副作用的网络调用。
            budget.Attempts.Add(new BsonDocument { { "at", now }, { "urgent", useUrgent } });
            foreach (var notice in notices.Where(n => n.Level == "error"))
            {
                var key = IncidentKey(notice);
                if (!budget.Incidents.Contains(key)) budget.Incidents[key] = now;
            }
            var fields = BudgetFields(budget);
            fields["leaseUntil"] = _clock.GetUtcNow().UtcDateTime.AddMinutes(2);
            var reserved = await states.UpdateOneAsync(owned, new BsonDocument("$set", fields), cancellationToken: ct);
            if (reserved.MatchedCount != 1) return;
            await _db.AdminPushDeliveryLogs.InsertOneAsync(reservation, cancellationToken: ct);
            await DeliverAsync(userId, selected.Route, notification, saveLog: true, ct, reservation);
        }
        finally
        {
            await states.UpdateOneAsync(owned, new BsonDocument("$set", new BsonDocument("leaseUntil", DateTime.UnixEpoch)),
                cancellationToken: CancellationToken.None);
        }
    }

    private sealed record DispatchBudget(List<BsonDocument> Attempts, BsonDocument Incidents);

    private static DispatchBudget ReadBudget(BsonDocument state, DateTime now)
    {
        var history = state.TryGetValue("attemptHistory", out var raw)
            ? raw.AsBsonArray.Select(a => a.AsBsonDocument).ToList()
            : Enumerable.Range(0, state.GetValue("attempts", 0).AsInt32).Select(_ => new BsonDocument {
                { "at", state.GetValue("lastAttemptAt", new BsonDateTime(DateTime.UnixEpoch)) }, { "urgent", false }
            }).ToList(); // 存量额度保守迁移，不在上线时清零。
        var recent = history.Where(a => now - a["at"].ToUniversalTime() < RecipientWindow).ToList();
        var incidents = new BsonDocument(state.GetValue("urgentIncidents", new BsonDocument()).AsBsonDocument
            .Where(e => now - e.Value.ToUniversalTime() < TimeSpan.FromMinutes(30)));
        return new DispatchBudget(recent, incidents);
    }

    private static BsonDocument BudgetFields(DispatchBudget budget) => new() {
        { "attemptHistory", new BsonArray(budget.Attempts) }, { "urgentIncidents", budget.Incidents }
    };

    private static string IncidentKey(AdminNotification notice) => Convert.ToHexString(SHA256.HashData(
        Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new[] { notice.Source,
            notice.Source == "gateway-alert" ? notice.Id
                : !string.IsNullOrWhiteSpace(notice.Key) ? notice.Key : notice.ActionUrl ?? notice.Source }))));

    private static bool IsFreshUrgent(AdminNotification notice, DispatchBudget budget) =>
        notice.Level == "error" && !budget.Incidents.Contains(IncidentKey(notice));

    private async Task<bool> HasSuccessfulDeliveryAsync(AdminPushSubscription subscription, string notificationId, CancellationToken ct)
    {
        return await _db.AdminPushDeliveryLogs
            .Find(x => x.UserId == subscription.UserId
                && x.TopicKey == subscription.TopicKey
                && x.NotificationId == notificationId
                && x.Success)
            .AnyAsync(ct);
    }

    private async Task MarkExistingNotificationsAsDeliveredAsync(AdminPushSubscription subscription, DateTime enabledAt, CancellationToken ct)
    {
        var filter = Builders<AdminNotification>.Filter.Eq(x => x.Status, "open");
        filter &= Builders<AdminNotification>.Filter.Or(
            Builders<AdminNotification>.Filter.Eq(x => x.TargetUserId, null),
            Builders<AdminNotification>.Filter.Eq(x => x.TargetUserId, subscription.UserId));
        filter &= Builders<AdminNotification>.Filter.Or(
            Builders<AdminNotification>.Filter.Eq(x => x.ExpiresAt, null),
            Builders<AdminNotification>.Filter.Gt(x => x.ExpiresAt, enabledAt));
        filter &= Builders<AdminNotification>.Filter.Lte(x => x.CreatedAt, enabledAt);

        var candidates = await _db.AdminNotifications
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Limit(500)
            .ToListAsync(ct);

        if (candidates.Count == 0) return;

        var logs = new List<AdminPushDeliveryLog>();
        foreach (var notification in candidates)
        {
            if (!MatchesTopic(subscription.TopicKey, notification)) continue;
            if (await HasSuccessfulDeliveryAsync(subscription, notification.Id, ct)) continue;

            logs.Add(new AdminPushDeliveryLog
            {
                UserId = subscription.UserId,
                SubscriptionId = subscription.Id,
                NotificationId = notification.Id,
                TopicKey = subscription.TopicKey,
                ChannelType = subscription.ChannelType,
                Method = "BASELINE",
                RequestUrl = "baseline://subscription-enabled",
                Success = true,
                ErrorMessage = "订阅开启前已有通知，已作为历史通知跳过外部推送",
                DurationMs = 0,
                CreatedAt = enabledAt,
            });
        }

        if (logs.Count > 0)
            await _db.AdminPushDeliveryLogs.InsertManyAsync(logs, cancellationToken: CancellationToken.None);
    }

    private static IEnumerable<AdminPushSubscription> PickLatestEnabledSubscriptions(IEnumerable<AdminPushSubscription> subscriptions)
    {
        return subscriptions
            .GroupBy(x => $"{x.UserId}\u0000{x.TopicKey}", StringComparer.OrdinalIgnoreCase)
            .Select(x => x
                .OrderByDescending(s => s.UpdatedAt)
                .ThenByDescending(s => s.Id, StringComparer.Ordinal)
                .First());
    }

    private async Task<AdminPushDeliveryLog> DeliverAsync(
        string userId,
        AdminPushSubscription subscription,
        AdminNotification notification,
        bool saveLog,
        CancellationToken ct, AdminPushDeliveryLog? reservation = null)
    {
        var log = reservation ?? new AdminPushDeliveryLog {
            UserId = userId, SubscriptionId = subscription.Id,
            NotificationId = notification.Id, TopicKey = subscription.TopicKey,
        };
        var sendStarted = false;
        var sw = Stopwatch.StartNew();
        try
        {
            // 调用者已固定目的通道，发送阶段不再次解析可变的默认配置。
            var effectiveSubscription = subscription;
            ValidateCompleteSubscription(effectiveSubscription);

            var placeholders = BuildPlaceholders(notification);
            var requestUrl = effectiveSubscription.ChannelType.Equals("bark", StringComparison.OrdinalIgnoreCase)
                ? BuildBarkUrl(
                    effectiveSubscription.BarkServerUrl,
                    effectiveSubscription.BarkKey,
                    notification.Title ?? "PRD Agent 通知",
                    notification.Message ?? notification.Title ?? string.Empty,
                    placeholders,
                    effectiveSubscription.BarkGroup,
                    effectiveSubscription.BarkSound,
                    effectiveSubscription.BarkLevel,
                    effectiveSubscription.BarkIcon,
                    effectiveSubscription.BarkImageTemplate,
                    effectiveSubscription.BarkUrlTemplate,
                    effectiveSubscription.BarkCall)
                : RenderTemplate(effectiveSubscription.UrlTemplate, placeholders, forUrl: true);
            var safeUri = await _urlValidator.EnsureSafeHttpUrlAsync(requestUrl, "管理员推送目标", ct);
            var method = effectiveSubscription.ChannelType.Equals("bark", StringComparison.OrdinalIgnoreCase)
                ? HttpMethod.Get
                : effectiveSubscription.Method.Equals("POST", StringComparison.OrdinalIgnoreCase) ? HttpMethod.Post : HttpMethod.Get;
            var body = method == HttpMethod.Post
                ? RenderTemplate(effectiveSubscription.BodyTemplate ?? string.Empty, placeholders, forUrl: false)
                : null;

            log.ChannelType = effectiveSubscription.ChannelType;
            log.Method = method.Method;
            log.RequestUrl = safeUri.ToString();
            log.RequestBody = body;
            var client = _httpClientFactory.CreateClient("SafeOutbound");
            client.Timeout = TimeSpan.FromSeconds(8);

            using var httpRequest = new HttpRequestMessage(method, safeUri);
            if (method == HttpMethod.Post)
            {
                httpRequest.Content = new StringContent(body ?? string.Empty, Encoding.UTF8, effectiveSubscription.ContentType);
            }

            sendStarted = true;
            using var response = await client.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, CancellationToken.None);
            log.StatusCode = (int)response.StatusCode;
            log.Success = response.IsSuccessStatusCode;
            log.DeliveryState = log.Success ? "accepted" : "failed";
            if (!response.IsSuccessStatusCode)
            {
                var responseBody = await response.Content.ReadAsStringAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(8));
                log.ErrorMessage = $"HTTP {(int)response.StatusCode}: {TrimForLog(responseBody, 240)}";
            }
        }
        catch (Exception ex)
        {
            log.Success = false;
            log.DeliveryState = sendStarted ? "unconfirmed" : "failed";
            log.ErrorMessage = TrimForLog(ex.Message, 240);
        }
        finally
        {
            log.DurationMs = sw.ElapsedMilliseconds;
            log.CreatedAt = _clock.GetUtcNow().UtcDateTime;
            if (saveLog)
            {
                if (reservation == null) await _db.AdminPushDeliveryLogs.InsertOneAsync(log, cancellationToken: CancellationToken.None);
                else await _db.AdminPushDeliveryLogs.ReplaceOneAsync(x => x.Id == log.Id, log, cancellationToken: CancellationToken.None);
            }
        }

        return log;
    }

    private async Task ValidateProfilePreviewAsync(AdminPushProfile profile, CancellationToken ct)
    {
        if (profile.ChannelType.Equals("bark", StringComparison.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(profile.BarkKey))
            return;
        if (!profile.ChannelType.Equals("bark", StringComparison.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(profile.UrlTemplate))
            return;

        var topic = TopicDefinitions[0];
        var preview = ApplyProfileToSubscription(new AdminPushSubscription
        {
            UserId = profile.UserId,
            TopicKey = topic.Key,
            Enabled = true,
        }, profile);
        await ValidateSubscriptionPreviewAsync(preview, topic, ct);
    }

    private async Task ValidateSubscriptionPreviewAsync(AdminPushSubscription subscription, AdminPushTopicDefinition topic, CancellationToken ct)
    {
        ValidateCompleteSubscription(subscription);
        var isBark = subscription.ChannelType.Equals("bark", StringComparison.OrdinalIgnoreCase);
        var previewUrl = isBark
            ? BuildBarkUrl(
                subscription.BarkServerUrl,
                subscription.BarkKey,
                "管理员推送测试",
                "这是一条测试通知",
                BuildPreviewPlaceholders(topic),
                subscription.BarkGroup,
                subscription.BarkSound,
                subscription.BarkLevel,
                subscription.BarkIcon,
                subscription.BarkImageTemplate,
                subscription.BarkUrlTemplate,
                subscription.BarkCall)
            : RenderTemplate(subscription.UrlTemplate, BuildPreviewPlaceholders(topic), forUrl: true);
        await _urlValidator.EnsureSafeHttpUrlAsync(previewUrl, "管理员推送订阅", ct);
    }

    private static void ValidateCompleteSubscription(AdminPushSubscription subscription)
    {
        if (!SupportedMethods.Contains(subscription.Method))
            throw new InvalidOperationException("推送请求方式仅支持 GET 或 POST");

        if (subscription.ChannelType.Equals("bark", StringComparison.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(subscription.BarkKey))
                throw new InvalidOperationException("启用 Bark 订阅前必须填写 Bark Key");
            var level = NormalizeNullableText(subscription.BarkLevel, 32);
            if (!string.IsNullOrWhiteSpace(level) && !SupportedBarkLevels.Contains(level))
                throw new InvalidOperationException("Bark 时效级别无效");
            return;
        }

        if (string.IsNullOrWhiteSpace(subscription.UrlTemplate))
            throw new InvalidOperationException("启用订阅前必须填写请求 URL 模板");
    }

    private static AdminPushProfile BuildDefaultProfile(string userId)
    {
        return new AdminPushProfile
        {
            UserId = userId,
            ChannelType = "bark",
            Method = "GET",
            UrlTemplate = string.Empty,
            BodyTemplate = null,
            ContentType = "application/json",
            BarkServerUrl = DefaultBarkServerUrl,
            BarkGroup = "MAP System-{{appname}}",
            BarkIcon = "{{iconUrl}}",
            BarkImageTemplate = "{{imageUrl}}",
            BarkUrlTemplate = "{{actionUrl}}",
        };
    }

    private static AdminPushProfile BuildProfileFromSubscription(string userId, AdminPushSubscription subscription)
    {
        return new AdminPushProfile
        {
            UserId = userId,
            ChannelType = subscription.ChannelType,
            Method = subscription.Method,
            UrlTemplate = subscription.UrlTemplate,
            BodyTemplate = subscription.BodyTemplate,
            ContentType = subscription.ContentType,
            BarkKey = subscription.BarkKey,
            BarkServerUrl = subscription.BarkServerUrl,
            BarkGroup = subscription.BarkGroup,
            BarkSound = subscription.BarkSound,
            BarkLevel = subscription.BarkLevel,
            BarkIcon = subscription.BarkIcon,
            BarkImageTemplate = subscription.BarkImageTemplate,
            BarkUrlTemplate = subscription.BarkUrlTemplate,
            BarkCall = subscription.BarkCall,
            CreatedAt = subscription.CreatedAt,
            UpdatedAt = subscription.UpdatedAt,
        };
    }

    private static void ApplyProfileRequest(AdminPushProfile profile, AdminPushProfileUpsertRequest request)
    {
        var channelType = NormalizeText(request.ChannelType, "bark", 64);
        var isBark = channelType.Equals("bark", StringComparison.OrdinalIgnoreCase);
        profile.ChannelType = channelType;
        profile.Method = isBark ? "GET" : (request.Method ?? "GET").Trim().ToUpperInvariant();
        if (!SupportedMethods.Contains(profile.Method))
            throw new InvalidOperationException("推送请求方式仅支持 GET 或 POST");
        profile.UrlTemplate = (request.UrlTemplate ?? string.Empty).Trim();
        profile.BodyTemplate = string.IsNullOrWhiteSpace(request.BodyTemplate) ? null : request.BodyTemplate;
        profile.ContentType = NormalizeText(request.ContentType, "application/json", 96);
        profile.BarkKey = NormalizeNullableText(request.BarkKey, 256);
        profile.BarkServerUrl = NormalizeNullableText(request.BarkServerUrl, 512) ?? DefaultBarkServerUrl;
        profile.BarkGroup = NormalizeNullableText(request.BarkGroup, 128);
        profile.BarkSound = NormalizeNullableText(request.BarkSound, 96);
        profile.BarkLevel = NormalizeNullableText(request.BarkLevel, 32);
        if (!string.IsNullOrWhiteSpace(profile.BarkLevel) && !SupportedBarkLevels.Contains(profile.BarkLevel))
            throw new InvalidOperationException("Bark 时效级别无效");
        profile.BarkIcon = NormalizeNullableText(request.BarkIcon, 1024);
        profile.BarkImageTemplate = NormalizeNullableText(request.BarkImageTemplate, 1024);
        profile.BarkUrlTemplate = NormalizeNullableText(request.BarkUrlTemplate, 1024);
        profile.BarkCall = request.BarkCall;
    }

    private static AdminPushSubscription ApplyProfileToSubscription(AdminPushSubscription subscription, AdminPushProfile profile)
    {
        return new AdminPushSubscription
        {
            Id = subscription.Id,
            UserId = subscription.UserId,
            TopicKey = subscription.TopicKey,
            Enabled = subscription.Enabled,
            UseDefaultProfile = true,
            ChannelType = profile.ChannelType,
            Method = profile.Method,
            UrlTemplate = profile.UrlTemplate,
            BodyTemplate = profile.BodyTemplate,
            ContentType = profile.ContentType,
            BarkKey = profile.BarkKey,
            BarkServerUrl = profile.BarkServerUrl,
            BarkGroup = profile.BarkGroup,
            BarkSound = profile.BarkSound,
            BarkLevel = profile.BarkLevel,
            BarkIcon = profile.BarkIcon,
            BarkImageTemplate = profile.BarkImageTemplate,
            BarkUrlTemplate = profile.BarkUrlTemplate,
            BarkCall = profile.BarkCall,
            CreatedAt = subscription.CreatedAt,
            UpdatedAt = subscription.UpdatedAt,
        };
    }

    internal static bool MatchesTopic(string topicKey, AdminNotification notification)
    {
        var source = (notification.Source ?? string.Empty).Trim();
        if (topicKey.Equals("defect-management", StringComparison.OrdinalIgnoreCase))
            return source.Equals("defect-agent", StringComparison.OrdinalIgnoreCase)
                && !IsDefectReminderNotification(notification);

        if (topicKey.Equals("report-agent", StringComparison.OrdinalIgnoreCase))
            return source.Equals("report-agent", StringComparison.OrdinalIgnoreCase);

        if (topicKey.Equals("admin-message", StringComparison.OrdinalIgnoreCase))
            return source.Equals("admin-notice", StringComparison.OrdinalIgnoreCase)
                || source.Equals("server-expiry", StringComparison.OrdinalIgnoreCase)
                || source.Contains("expiry", StringComparison.OrdinalIgnoreCase)
                || source.Contains("expire", StringComparison.OrdinalIgnoreCase);

        if (topicKey.Equals("user-voice", StringComparison.OrdinalIgnoreCase))
            return source.Equals("user-voice", StringComparison.OrdinalIgnoreCase)
                || source.Equals("team-activity-voice", StringComparison.OrdinalIgnoreCase)
                || source.Equals("user-feedback", StringComparison.OrdinalIgnoreCase);

        if (topicKey.Equals("api-request-alert", StringComparison.OrdinalIgnoreCase))
            return source.Equals("api-request-alert", StringComparison.OrdinalIgnoreCase)
                || source.Equals("api-request-log", StringComparison.OrdinalIgnoreCase)
                || source.Equals("gateway-alert", StringComparison.OrdinalIgnoreCase)
                || source.Contains("api", StringComparison.OrdinalIgnoreCase);

        if (topicKey.Equals("system-alert", StringComparison.OrdinalIgnoreCase))
        {
            if (source.Equals("defect-agent", StringComparison.OrdinalIgnoreCase)
                || source.Equals("report-agent", StringComparison.OrdinalIgnoreCase)
                || source.Equals("admin-notice", StringComparison.OrdinalIgnoreCase)
                || source.Equals("server-expiry", StringComparison.OrdinalIgnoreCase)
                || source.Equals("user-voice", StringComparison.OrdinalIgnoreCase)
                || source.Equals("api-request-alert", StringComparison.OrdinalIgnoreCase)
                || source.Equals("api-request-log", StringComparison.OrdinalIgnoreCase)
                || source.Equals("gateway-alert", StringComparison.OrdinalIgnoreCase)
                || source.Contains("expiry", StringComparison.OrdinalIgnoreCase)
                || source.Contains("expire", StringComparison.OrdinalIgnoreCase))
                return false;
            var level = (notification.Level ?? string.Empty).Trim();
            return level.Equals("warning", StringComparison.OrdinalIgnoreCase)
                || level.Equals("error", StringComparison.OrdinalIgnoreCase)
                || source.Contains("platform", StringComparison.OrdinalIgnoreCase)
                || source.Contains("quota", StringComparison.OrdinalIgnoreCase)
                || source.Equals("system", StringComparison.OrdinalIgnoreCase);
        }

        return false;
    }

    private static bool IsDefectReminderNotification(AdminNotification notification)
    {
        var source = notification.Source ?? string.Empty;
        var key = notification.Key ?? string.Empty;
        var title = notification.Title ?? string.Empty;
        var message = notification.Message ?? string.Empty;

        if (source.Equals("defect-escalation", StringComparison.OrdinalIgnoreCase)
            || source.Equals("defect-reminder", StringComparison.OrdinalIgnoreCase)
            || source.Equals("pm-reminder", StringComparison.OrdinalIgnoreCase))
            return true;

        if (key.StartsWith("defect-escalation", StringComparison.OrdinalIgnoreCase)
            || key.StartsWith("defect-reminder", StringComparison.OrdinalIgnoreCase))
            return true;

        if (title.Contains("缺陷催办", StringComparison.OrdinalIgnoreCase)
            || title.Contains("催办", StringComparison.OrdinalIgnoreCase))
            return true;

        return message.Contains("请尽快跟进", StringComparison.OrdinalIgnoreCase)
            || (message.Contains("超时", StringComparison.OrdinalIgnoreCase)
                && message.Contains("未处理", StringComparison.OrdinalIgnoreCase));
    }

    private Dictionary<string, string> BuildPreviewPlaceholders(AdminPushTopicDefinition topic)
    {
        var resource = ResolveResource(topic);
        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["appname"] = topic.Label,
            ["title"] = "管理员推送测试",
            ["message"] = "这是一条测试通知",
            ["level"] = "info",
            ["source"] = topic.Source,
            ["actionUrl"] = "/notifications",
            ["iconUrl"] = ResolveIconUrl(resource),
            ["imageUrl"] = string.Empty,
            ["createdAt"] = DateTime.UtcNow.ToString("O"),
            ["notificationId"] = "test",
        };
    }

    private Dictionary<string, string> BuildPlaceholders(AdminNotification notification)
    {
        var resource = ResolveResource(notification);
        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["appname"] = resource.AppName,
            ["title"] = notification.Title ?? string.Empty,
            ["message"] = notification.Message ?? notification.Title ?? string.Empty,
            ["level"] = notification.Level ?? string.Empty,
            ["source"] = notification.Source ?? string.Empty,
            ["actionUrl"] = ResolveActionUrl(notification.ActionUrl),
            ["actionPath"] = notification.ActionUrl ?? string.Empty,
            ["iconUrl"] = ResolveIconUrl(resource),
            ["imageUrl"] = ResolveImageUrl(notification),
            ["createdAt"] = notification.CreatedAt.ToString("O"),
            ["notificationId"] = notification.Id,
        };
    }

    private static string ResolveAppName(AdminNotification notification)
    {
        return ResolveResource(notification).AppName;
    }

    private static AdminPushResourceDefinition ResolveResource(AdminPushTopicDefinition topic)
    {
        return ResourceDefinitions.FirstOrDefault(x => x.Key.Equals(topic.ResourceKey, StringComparison.OrdinalIgnoreCase))
            ?? ResourceDefinitions[1];
    }

    private static AdminPushResourceDefinition ResolveResource(AdminNotification notification)
    {
        var source = (notification.Source ?? string.Empty).Trim();
        var key = source switch
        {
            "defect-agent" => "defect-management",
            "report-agent" => "report-agent",
            "server-expiry" => "server-expiry",
            "admin-notice" => "admin-message",
            "user-voice" => "user-voice",
            "team-activity-voice" => "user-voice",
            "user-feedback" => "user-voice",
            "api-request-alert" => "api-request-alert",
            "api-request-log" => "api-request-alert",
            "gateway-alert" => "api-request-alert",
            "llm-gateway-quota" => "system-alert",
            "platform-key-integrity" => "system-alert",
            "open-platform" => "system-alert",
            _ when source.Contains("expire", StringComparison.OrdinalIgnoreCase) => "server-expiry",
            _ when source.Contains("expiry", StringComparison.OrdinalIgnoreCase) => "server-expiry",
            _ when source.Contains("api", StringComparison.OrdinalIgnoreCase) => "api-request-alert",
            _ => "system-alert",
        };

        return ResourceDefinitions.FirstOrDefault(x => x.Key.Equals(key, StringComparison.OrdinalIgnoreCase))
            ?? ResourceDefinitions[1];
    }

    public static AdminPushResourceDefinition? FindResource(string resourceKey)
    {
        return ResourceDefinitions.FirstOrDefault(x => x.Key.Equals((resourceKey ?? string.Empty).Trim(), StringComparison.OrdinalIgnoreCase));
    }

    public static string BuildResourceIconSvg(AdminPushResourceDefinition resource)
    {
        var (background, foreground, accent, label) = resource.ColorKey switch
        {
            "blue" => ("#3f7df6", "#ffffff", "#bcd2ff", "缺"),
            "amber" => ("#f59e0b", "#111827", "#fff2c2", "警"),
            "pink" => ("#f04f9c", "#ffffff", "#ffc3df", "信"),
            "purple" => ("#7c3aed", "#ffffff", "#d7c4ff", "期"),
            "teal" => ("#21b7b7", "#ffffff", "#bdf4ef", "声"),
            "orange" => ("#d97706", "#ffffff", "#ffd9a6", "API"),
            "green" => ("#16a34a", "#ffffff", "#c5f7d4", "报"),
            _ => ("#4f46e5", "#ffffff", "#c7d2fe", "MAP"),
        };

        return $"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{EscapeXml(resource.AppName)}">
  <defs>
    <linearGradient id="g" x1="34" y1="28" x2="214" y2="224" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{background}"/>
      <stop offset="1" stop-color="#111827"/>
    </linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="{background}" flood-opacity=".32"/>
    </filter>
  </defs>
  <rect x="22" y="22" width="212" height="212" rx="42" fill="url(#g)" filter="url(#s)"/>
  <path d="M70 76h116v104H70z" fill="none" stroke="{accent}" stroke-width="10" stroke-linejoin="round" opacity=".9"/>
  <path d="M92 105h72M92 130h72M92 155h48" fill="none" stroke="{accent}" stroke-width="10" stroke-linecap="round" opacity=".72"/>
  <text x="128" y="145" text-anchor="middle" dominant-baseline="middle" font-size="{(label.Length > 1 ? 46 : 66)}" font-family="Arial, 'Microsoft YaHei', sans-serif" font-weight="800" fill="{foreground}">{EscapeXml(label)}</text>
</svg>
""";
    }

    private string ResolveIconUrl(AdminPushResourceDefinition resource)
    {
        if (string.IsNullOrWhiteSpace(_publicBaseUrl)) return resource.IconUrl;
        return $"{_publicBaseUrl}/api/public/admin-push/resources/{Uri.EscapeDataString(resource.Key)}/icon.svg";
    }

    private string ResolveActionUrl(string? actionUrl)
    {
        var trimmed = (actionUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(trimmed)) return string.Empty;
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var absolute)
            && (string.Equals(absolute.Scheme, "https", StringComparison.OrdinalIgnoreCase)
                || string.Equals(absolute.Scheme, "http", StringComparison.OrdinalIgnoreCase)))
            return trimmed;
        if (string.IsNullOrWhiteSpace(_publicBaseUrl)) return trimmed;
        return trimmed.StartsWith("/", StringComparison.Ordinal)
            ? $"{_publicBaseUrl}{trimmed}"
            : $"{_publicBaseUrl}/{trimmed}";
    }

    private static string ResolveImageUrl(AdminNotification notification)
    {
        var image = notification.Attachments?
            .FirstOrDefault(x => (x.MimeType ?? string.Empty).StartsWith("image/", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(x.Url));
        return image?.Url ?? string.Empty;
    }

    private static string RenderTemplate(string template, IReadOnlyDictionary<string, string> values, bool forUrl)
    {
        return PlaceholderRegex.Replace(template ?? string.Empty, match =>
        {
            var key = match.Groups[1].Value;
            values.TryGetValue(key, out var raw);
            var value = raw ?? string.Empty;
            return forUrl ? Uri.EscapeDataString(value) : JsonEncodedText.Encode(value).ToString();
        });
    }

    private static string RenderPlainTemplate(string template, IReadOnlyDictionary<string, string> values)
    {
        return PlaceholderRegex.Replace(template ?? string.Empty, match =>
        {
            var key = match.Groups[1].Value;
            values.TryGetValue(key, out var raw);
            return raw ?? string.Empty;
        });
    }

    private static string BuildBarkUrl(
        string? serverUrl,
        string? key,
        string title,
        string message,
        IReadOnlyDictionary<string, string> placeholders,
        string? groupTemplate,
        string? sound,
        string? level,
        string? icon,
        string? imageTemplate,
        string? urlTemplate,
        bool call)
    {
        var baseUrl = (serverUrl ?? DefaultBarkServerUrl).Trim().TrimEnd('/');
        var safeKey = Uri.EscapeDataString((key ?? string.Empty).Trim());
        var safeTitle = Uri.EscapeDataString(title);
        var safeMessage = Uri.EscapeDataString(message);
        var url = $"{baseUrl}/{safeKey}/{safeTitle}/{safeMessage}";
        var query = new List<string>();

        var group = string.IsNullOrWhiteSpace(groupTemplate)
            ? "MAP System"
            : RenderPlainTemplate(groupTemplate, placeholders);
        AddQuery(query, "group", group);
        AddQuery(query, "sound", sound);
        AddQuery(query, "level", level);
        AddQuery(query, "icon", string.IsNullOrWhiteSpace(icon) ? placeholders.GetValueOrDefault("iconUrl") : RenderPlainTemplate(icon, placeholders));
        AddQuery(query, "image", string.IsNullOrWhiteSpace(imageTemplate) ? placeholders.GetValueOrDefault("imageUrl") : RenderPlainTemplate(imageTemplate, placeholders));
        AddQuery(query, "url", string.IsNullOrWhiteSpace(urlTemplate) ? placeholders.GetValueOrDefault("actionUrl") : RenderPlainTemplate(urlTemplate, placeholders));
        if (call) AddQuery(query, "call", "1");

        return query.Count == 0 ? url : $"{url}?{string.Join("&", query)}";
    }

    private static void AddQuery(List<string> query, string key, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        query.Add($"{Uri.EscapeDataString(key)}={Uri.EscapeDataString(value)}");
    }

    private static string NormalizeText(string? value, string fallback, int maxLength)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(trimmed)) trimmed = fallback;
        return trimmed.Length > maxLength ? trimmed[..maxLength] : trimmed;
    }

    private static string? NormalizeNullableText(string? value, int maxLength)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(trimmed)) return null;
        return trimmed.Length > maxLength ? trimmed[..maxLength] : trimmed;
    }

    private static string TrimForLog(string? value, int maxLength)
    {
        var text = value ?? string.Empty;
        return text.Length > maxLength ? text[..maxLength] : text;
    }

    private static string? NormalizeBaseUrl(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim().TrimEnd('/');
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)) return null;
        if (!string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase))
            return null;
        return trimmed;
    }

    private static string? ResolvePublicBaseUrl(IConfiguration configuration)
    {
        return NormalizeBaseUrl(configuration["ServerUrl"])
            ?? NormalizeBaseUrl(configuration["App:FrontendBaseUrl"])
            ?? NormalizeBaseUrl(configuration["FrontendBaseUrl"])
            ?? NormalizeBaseUrl(configuration["FRONTEND_BASE_URL"])
            ?? NormalizeBaseUrl(configuration["PUBLIC_BASE_URL"])
            ?? NormalizeBaseUrl(configuration["APP_PUBLIC_BASE_URL"])
            ?? NormalizeBaseUrl(configuration["CDS_PREVIEW_URL"])
            ?? ResolveDerivedPreviewBaseUrl(configuration);
    }

    private static string? ResolveDerivedPreviewBaseUrl(IConfiguration configuration)
    {
        var hasExplicitPreviewSignal = HasAnyConfigValue(
            configuration,
            "MAP_PREVIEW_BRANCH",
            "VITE_GIT_BRANCH",
            "AGENT_WORKSPACE_GIT_REF",
            "GIT_BRANCH",
            "AgentWorkspace:GitRef",
            "MAP_PROJECT_SLUG",
            "AGENT_WORKSPACE_PROJECT_SLUG",
            "AgentWorkspace:ProjectSlug",
            "AGENT_WORKSPACE_GITHUB_REPOSITORY",
            "GITHUB_REPOSITORY",
            "AgentWorkspace:GitHubRepository",
            "MAP_PREVIEW_DOMAIN",
            "CDS_PREVIEW_DOMAIN",
            "PREVIEW_DOMAIN",
            "PreviewDomain");
        if (!hasExplicitPreviewSignal) return null;

        var workspace = AgentWorkspace.Resolve(configuration);
        var branch = FirstConfigValue(
                configuration,
                "MAP_PREVIEW_BRANCH",
                "VITE_GIT_BRANCH",
                "AGENT_WORKSPACE_GIT_REF",
                "GIT_BRANCH",
                "AgentWorkspace:GitRef")
            ?? workspace.GitRef;
        var project = FirstConfigValue(
            configuration,
            "MAP_PROJECT_SLUG",
            "AGENT_WORKSPACE_PROJECT_SLUG",
            "AgentWorkspace:ProjectSlug");

        if (string.IsNullOrWhiteSpace(project))
        {
            var repo = FirstConfigValue(
                    configuration,
                    "AGENT_WORKSPACE_GITHUB_REPOSITORY",
                    "GITHUB_REPOSITORY",
                    "AgentWorkspace:GitHubRepository")
                ?? workspace.GitHubRepository;
            if (!string.IsNullOrWhiteSpace(repo))
                project = repo.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
        }

        var domain = FirstConfigValue(configuration, "MAP_PREVIEW_DOMAIN", "CDS_PREVIEW_DOMAIN", "PREVIEW_DOMAIN", "PreviewDomain");
        var slug = ClaudeSidecarRouter.ComputePreviewSlug(branch, project);
        if (string.IsNullOrWhiteSpace(slug) || string.IsNullOrWhiteSpace(domain))
            return null;

        return NormalizeBaseUrl($"https://{slug}.{domain.Trim().Trim('.')}");
    }

    private static string? FirstConfigValue(IConfiguration configuration, params string[] keys)
    {
        foreach (var key in keys)
        {
            var value = configuration[key];
            if (!string.IsNullOrWhiteSpace(value))
                return value.Trim();
        }

        return null;
    }

    private static bool HasAnyConfigValue(IConfiguration configuration, params string[] keys)
    {
        foreach (var key in keys)
        {
            if (!string.IsNullOrWhiteSpace(configuration[key]))
                return true;
        }

        return false;
    }

    private static string EscapeXml(string value)
    {
        return value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal);
    }
}

public sealed record AdminPushTopicDefinition(string Key, string Label, string Description, string Source, string ResourceKey);

public sealed record AdminPushResourceDefinition(
    string Key,
    string AppName,
    string Description,
    string IconUrl,
    string DefaultGroup,
    string ResourcePath,
    string KnowledgeStoreName,
    string? KnowledgeTemplateKey,
    string ColorKey);

public sealed record AdminPushPresetDefinition(
    string Key,
    string Label,
    string ChannelType,
    string Method,
    string UrlTemplate,
    string? BodyTemplate,
    string ContentType);

public sealed class AdminPushSubscriptionUpsertRequest
{
    public string? TopicKey { get; set; }
    public bool Enabled { get; set; }
    public bool? UseDefaultProfile { get; set; }
    public string? ChannelType { get; set; }
    public string? Method { get; set; }
    public string? UrlTemplate { get; set; }
    public string? BodyTemplate { get; set; }
    public string? ContentType { get; set; }
    public string? BarkKey { get; set; }
    public string? BarkServerUrl { get; set; }
    public string? BarkGroup { get; set; }
    public string? BarkSound { get; set; }
    public string? BarkLevel { get; set; }
    public string? BarkIcon { get; set; }
    public string? BarkImageTemplate { get; set; }
    public string? BarkUrlTemplate { get; set; }
    public bool BarkCall { get; set; }
}

public sealed class AdminPushProfileUpsertRequest
{
    public string? ChannelType { get; set; }
    public string? Method { get; set; }
    public string? UrlTemplate { get; set; }
    public string? BodyTemplate { get; set; }
    public string? ContentType { get; set; }
    public string? BarkKey { get; set; }
    public string? BarkServerUrl { get; set; }
    public string? BarkGroup { get; set; }
    public string? BarkSound { get; set; }
    public string? BarkLevel { get; set; }
    public string? BarkIcon { get; set; }
    public string? BarkImageTemplate { get; set; }
    public string? BarkUrlTemplate { get; set; }
    public bool BarkCall { get; set; }
}
