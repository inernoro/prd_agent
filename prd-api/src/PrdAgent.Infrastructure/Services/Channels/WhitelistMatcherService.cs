using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using MongoDB.Bson;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Channels;

/// <summary>
/// 白名单匹配服务
/// </summary>
public class WhitelistMatcherService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<WhitelistMatcherService> _logger;

    public WhitelistMatcherService(MongoDbContext db, ILogger<WhitelistMatcherService> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 匹配白名单结果
    /// </summary>
    public class MatchResult
    {
        /// <summary>是否匹配成功</summary>
        public bool IsMatch { get; set; }

        /// <summary>匹配的白名单规则</summary>
        public ChannelWhitelist? Whitelist { get; set; }

        /// <summary>拒绝原因（匹配失败时）</summary>
        public string? RejectReason { get; set; }

        /// <summary>拒绝原因显示名称</summary>
        public string? RejectReasonDisplay { get; set; }

        public static MatchResult Success(ChannelWhitelist whitelist) => new()
        {
            IsMatch = true,
            Whitelist = whitelist
        };

        public static MatchResult Fail(string reason) => new()
        {
            IsMatch = false,
            RejectReason = reason,
            RejectReasonDisplay = ChannelRejectReason.GetDisplayName(reason)
        };
    }

    /// <summary>
    /// 检查发送者是否在白名单中
    /// </summary>
    /// <param name="channelType">通道类型</param>
    /// <param name="senderIdentifier">发送者标识（邮箱、手机号等）</param>
    /// <param name="targetAgent">目标 Agent（可选，用于检查 Agent 权限）</param>
    /// <param name="operation">操作类型（可选，用于检查操作权限）</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>匹配结果</returns>
    public async Task<MatchResult> MatchAsync(
        string channelType,
        string senderIdentifier,
        string? targetAgent = null,
        string? operation = null,
        CancellationToken ct = default,
        string? deliveryId = null,
        string? emailOwnerId = null)
    {
        var normalizedIdentifier = senderIdentifier.ToLowerInvariant();

        // 获取该通道所有启用的白名单规则（按优先级排序）
        var rules = await _db.ChannelWhitelists
            .Find(x => x.ChannelType == channelType && x.IsActive)
            .SortBy(x => x.Priority)
            .ToListAsync(ct);

        if (rules.Count == 0)
        {
            _logger.LogDebug("No whitelist rules found for channel {ChannelType}", channelType);
            return MatchResult.Fail(ChannelRejectReason.NotWhitelisted);
        }

        // 按优先级遍历，找到第一个匹配的规则
        foreach (var rule in rules)
        {
            if (!MatchPattern(rule.IdentifierPattern, normalizedIdentifier))
            {
                continue;
            }

            _logger.LogDebug("Whitelist rule matched: {RuleId} {Pattern} for {Identifier}",
                rule.Id, rule.IdentifierPattern, normalizedIdentifier);

            // 检查 Agent 权限
            if (!string.IsNullOrWhiteSpace(targetAgent) && rule.AllowedAgents.Count > 0)
            {
                if (!rule.AllowedAgents.Contains(targetAgent))
                {
                    _logger.LogDebug("Agent {Agent} not allowed by rule {RuleId}", targetAgent, rule.Id);
                    return MatchResult.Fail(ChannelRejectReason.AgentNotAllowed);
                }
            }

            // 检查操作权限
            if (!string.IsNullOrWhiteSpace(operation) && rule.AllowedOperations.Count > 0)
            {
                if (!rule.AllowedOperations.Contains(operation))
                {
                    _logger.LogDebug("Operation {Operation} not allowed by rule {RuleId}", operation, rule.Id);
                    return MatchResult.Fail(ChannelRejectReason.OperationNotAllowed);
                }
            }

            // 检查每日配额
            if (rule.DailyQuota > 0)
            {
                var receiptKey = deliveryId == null ? null : Convert.ToHexString(
                    System.Security.Cryptography.SHA256.HashData(
                        System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(
                            new[] { deliveryId, normalizedIdentifier, targetAgent, operation, emailOwnerId })));
                var quotaOk = await CheckAndIncrementQuotaAsync(rule, deliveryId, receiptKey, ct);
                if (!quotaOk)
                {
                    _logger.LogDebug("Quota exceeded for rule {RuleId}", rule.Id);
                    return MatchResult.Fail(ChannelRejectReason.QuotaExceeded);
                }
            }

            return MatchResult.Success(rule);
        }

        _logger.LogDebug("No matching whitelist rule for {ChannelType}:{Identifier}", channelType, normalizedIdentifier);
        return MatchResult.Fail(ChannelRejectReason.NotWhitelisted);
    }

    /// <summary>
    /// 匹配模式（支持通配符 *）
    /// </summary>
    /// <param name="pattern">模式（如 *@company.com, user@*.com, exact@email.com）</param>
    /// <param name="identifier">标识（已小写化）</param>
    /// <returns>是否匹配</returns>
    public static bool MatchPattern(string pattern, string identifier)
    {
        if (string.IsNullOrWhiteSpace(pattern) || string.IsNullOrWhiteSpace(identifier))
        {
            return false;
        }

        var normalizedPattern = pattern.Trim().ToLowerInvariant();
        var normalizedIdentifier = identifier.Trim().ToLowerInvariant();

        // 精确匹配
        if (!normalizedPattern.Contains('*'))
        {
            return normalizedPattern == normalizedIdentifier;
        }

        // 全局通配
        if (normalizedPattern == "*")
        {
            return true;
        }

        // 转换为正则表达式
        // * 匹配任意字符（但邮箱场景下不应跨越 @，因此使用 [^@]* 或 .* 取决于场景）
        // 这里使用简单的 .* 替换，适用于大多数场景
        var regexPattern = "^" + Regex.Escape(normalizedPattern).Replace("\\*", ".*") + "$";

        try
        {
            return Regex.IsMatch(normalizedIdentifier, regexPattern);
        }
        catch (RegexParseException)
        {
            return false;
        }
    }

    /// <summary>
    /// 检查并增加配额
    /// </summary>
    private async Task<bool> CheckAndIncrementQuotaAsync(ChannelWhitelist rule, string? deliveryId, string? receiptKey, CancellationToken ct)
    {
        // Read the date, quota and counter on the server in the same atomic operation. In
        // particular, a losing "reset yesterday" writer must not silently bypass today's quota.
        var today = new BsonDocument("$dateToString", new BsonDocument
        {
            { "format", "%Y-%m-%d" }, { "date", "$$NOW" }, { "timezone", "UTC" }
        });
        var sameDay = new BsonDocument("$eq", new BsonArray { "$TodayDate", today });
        var used = new BsonDocument("$cond", new BsonArray
        {
            sameDay, new BsonDocument("$ifNull", new BsonArray { "$TodayUsedCount", 0 }), 0
        });
        var ids = new BsonDocument("$cond", new BsonArray
        {
            sameDay, new BsonDocument("$ifNull", new BsonArray { "$TodayChargedDeliveryIds", new BsonArray() }), new BsonArray()
        });
        var unexpired = new BsonDocument("$filter", new BsonDocument
        {
            { "input", new BsonDocument("$ifNull", new BsonArray { "$EmailQuotaAdmissions", new BsonArray() }) },
            { "cond", new BsonDocument("$gt", new BsonArray { "$$this.ExpiresAt", "$$NOW" }) }
        });
        BsonValue alreadyCharged = BsonBoolean.False;
        BsonValue admissions = unexpired;
        if (receiptKey != null)
        {
            var receiptKeys = new BsonDocument("$map", new BsonDocument
            {
                { "input", unexpired }, { "in", "$$this.Key" }
            });
            alreadyCharged = new BsonDocument("$or", new BsonArray
            {
                new BsonDocument("$in", new BsonArray { receiptKey, receiptKeys }),
                new BsonDocument("$in", new BsonArray { new BsonDocument("$literal", deliveryId), ids })
            });
            // A fixed 24-hour window covers overnight recovery without extending on retries.
            var receipt = new BsonDocument
            {
                { "Key", receiptKey },
                { "ExpiresAt", new BsonDocument("$add", new BsonArray { "$$NOW", 86_400_000 }) }
            };
            admissions = new BsonDocument("$cond", new BsonArray
            {
                alreadyCharged, unexpired,
                new BsonDocument("$concatArrays", new BsonArray { unexpired, new BsonArray { receipt } })
            });
        }

        var rules = Builders<ChannelWhitelist>.Filter;
        var filter = rules.Eq(x => x.Id, rule.Id)
            & rules.Eq(x => x.IsActive, true)
            & rules.Gt(x => x.DailyQuota, 0)
            & new BsonDocument("$expr", new BsonDocument("$or", new BsonArray
            {
                alreadyCharged, new BsonDocument("$lt", new BsonArray { used, "$DailyQuota" })
            }));
        if (receiptKey != null)
        {
            // Recheck policy fields in the same write that consumes or reuses admission.
            var agents = rules.Eq(x => x.AllowedAgents, rule.AllowedAgents);
            if (rule.AllowedAgents.Count == 0)
                agents |= rules.Exists(x => x.AllowedAgents, false);
            var operations = rules.Eq(x => x.AllowedOperations, rule.AllowedOperations);
            if (rule.AllowedOperations.Count == 0)
                operations |= rules.Exists(x => x.AllowedOperations, false);
            var priority = rules.Eq(x => x.Priority, rule.Priority);
            if (rule.Priority == 100)
                priority |= rules.Exists(x => x.Priority, false);
            filter &= rules.Eq(x => x.ChannelType, rule.ChannelType)
                & rules.Eq(x => x.IdentifierPattern, rule.IdentifierPattern)
                & agents & operations & priority
                & rules.Eq(x => x.BoundUserId, rule.BoundUserId);
        }
        PipelineDefinition<ChannelWhitelist, ChannelWhitelist> pipeline = new[]
        {
            new BsonDocument("$set", new BsonDocument
            {
                { "TodayDate", today },
                { "TodayUsedCount", new BsonDocument("$add", new BsonArray
                    { used, new BsonDocument("$cond", new BsonArray { alreadyCharged, 0, 1 }) }) },
                { "TodayChargedDeliveryIds", ids },
                { "EmailQuotaAdmissions", admissions },
                { "UpdatedAt", "$$NOW" }
            })
        };
        var admitted = await _db.ChannelWhitelists.FindOneAndUpdateAsync(filter,
            Builders<ChannelWhitelist>.Update.Pipeline(pipeline),
            new FindOneAndUpdateOptions<ChannelWhitelist> { ReturnDocument = ReturnDocument.After }, ct);
        // The counter represents admission, not successful task completion: retain it on an
        // uncertain/failed insert. The same delivery may retry without spending a second slot.
        return admitted != null;
    }

    /// <summary>
    /// 解析身份映射（查找对应的系统用户）
    /// </summary>
    public async Task<ChannelIdentityMapping?> ResolveIdentityAsync(
        string channelType,
        string senderIdentifier,
        CancellationToken ct = default)
    {
        var normalizedIdentifier = senderIdentifier.ToLowerInvariant();

        return await _db.ChannelIdentityMappings
            .Find(x => x.ChannelType == channelType && x.ChannelIdentifier == normalizedIdentifier && x.IsVerified)
            .FirstOrDefaultAsync(ct);
    }
}
