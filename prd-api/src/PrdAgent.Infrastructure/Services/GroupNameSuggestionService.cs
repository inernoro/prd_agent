using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 群组名称建议服务实现
/// </summary>
public class GroupNameSuggestionService : IGroupNameSuggestionService
{
    private readonly IGroupService _groupService;
    private readonly IKnowledgeBaseService _kbService;
    private readonly IModelDomainService _modelDomainService;
    private readonly ILogger<GroupNameSuggestionService> _logger;

    public GroupNameSuggestionService(
        IGroupService groupService,
        IKnowledgeBaseService kbService,
        IModelDomainService modelDomainService,
        ILogger<GroupNameSuggestionService> logger)
    {
        _groupService = groupService;
        _kbService = kbService;
        _modelDomainService = modelDomainService;
        _logger = logger;
    }

    public void EnqueueGroupNameSuggestion(string groupId, string? fileName)
    {
        // 使用 Task.Run 将任务放到后台线程池执行，不阻塞当前请求
        _ = Task.Run(async () =>
        {
            try
            {
                await SuggestAndUpdateGroupNameAsync(groupId, fileName);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to suggest group name for group {GroupId}", groupId);
            }
        });
    }

    private async Task SuggestAndUpdateGroupNameAsync(string groupId, string? fileName)
    {
        try
        {
            // 获取群组信息
            var group = await _groupService.GetByIdAsync(groupId);
            if (group == null)
            {
                _logger.LogWarning("Group {GroupId} not found, skipping name suggestion", groupId);
                return;
            }

            // 如果群组已经有自定义名称（不是默认名称），则不覆盖
            if (!IsDefaultOrPlaceholderName(group.GroupName))
            {
                _logger.LogInformation("Group {GroupId} already has custom name: {GroupName}, skipping suggestion",
                    groupId, group.GroupName);
                return;
            }

            // 获取知识库文档
            var kbDocs = await _kbService.GetActiveDocumentsAsync(groupId);
            if (kbDocs.Count == 0)
            {
                _logger.LogInformation("No KB documents for group {GroupId}, skipping name suggestion", groupId);
                return;
            }

            // 从首个有内容的文档中提取片段
            var firstDoc = kbDocs.FirstOrDefault(d => !string.IsNullOrWhiteSpace(d.TextContent));
            if (firstDoc == null)
            {
                _logger.LogInformation("No meaningful text in KB docs for group {GroupId}", groupId);
                return;
            }

            var snippet = ExtractSnippet(firstDoc.TextContent!);
            if (string.IsNullOrWhiteSpace(snippet))
            {
                _logger.LogInformation("No meaningful snippet from KB docs for group {GroupId}", groupId);
                return;
            }

            // 调用意图模型生成群组名称
            _logger.LogInformation("Suggesting group name for group {GroupId}...", groupId);
            var suggestedName = await _modelDomainService.SuggestGroupNameAsync(fileName, snippet);

            if (string.IsNullOrWhiteSpace(suggestedName))
            {
                _logger.LogWarning("Failed to suggest name for group {GroupId}, got empty result", groupId);
                return;
            }

            // 更新群组名称
            await _groupService.UpdateGroupNameAsync(groupId, suggestedName);
            _logger.LogInformation("Successfully updated group {GroupId} name to: {GroupName}",
                groupId, suggestedName);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error suggesting group name for group {GroupId}", groupId);
        }
    }

    private static string ExtractSnippet(string content, int maxLength = 2000)
    {
        if (string.IsNullOrWhiteSpace(content)) return string.Empty;

        var s = content.Replace("\r\n", "\n").Replace("\r", "\n");
        var lines = s.Split('\n');
        var picked = new List<string>(capacity: 32);
        var total = 0;

        foreach (var rawLine in lines)
        {
            if (picked.Count >= 40) break;
            var line = (rawLine ?? string.Empty).TrimEnd();
            if (picked.Count == 0 && string.IsNullOrWhiteSpace(line)) continue;

            var trimmed = line.Trim();
            if (IsNoiseLine(trimmed)) continue;

            var remaining = maxLength - total;
            if (remaining <= 0) break;
            if (trimmed.Length > remaining) trimmed = trimmed[..remaining];

            picked.Add(trimmed);
            total += trimmed.Length;
            if (total >= maxLength) break;
        }

        var snippet = string.Join('\n', picked).Trim();
        return snippet;
    }

    private static bool IsDefaultOrPlaceholderName(string? name)
    {
        var s = (name ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return true;

        if (string.Equals(s, "新建群组", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(s, "未命名群组", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(s, "未命名文档", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(s, "产品需求文档", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(s, "需求文档", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(s, "产品文档", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(s, "文档", StringComparison.OrdinalIgnoreCase)) return true;

        if (s.Contains("未命名", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static bool IsNoiseLine(string line)
    {
        var s = (line ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return true;

        var badExact = new[]
        {
            "目录", "版本历史", "更新记录"
        };
        if (badExact.Any(x => string.Equals(s, x, StringComparison.OrdinalIgnoreCase))) return true;

        if (string.Equals(s, "```", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(s, "---", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }
}
