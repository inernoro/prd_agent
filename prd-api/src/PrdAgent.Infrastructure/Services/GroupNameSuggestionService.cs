using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 群组名称建议服务实现
/// </summary>
public class GroupNameSuggestionService : IGroupNameSuggestionService
{
    private readonly IGroupService _groupService;
    private readonly IDocumentService _documentService;
    private readonly IModelDomainService _modelDomainService;
    private readonly ILogger<GroupNameSuggestionService> _logger;

    public GroupNameSuggestionService(
        IGroupService groupService,
        IDocumentService documentService,
        IModelDomainService modelDomainService,
        ILogger<GroupNameSuggestionService> logger)
    {
        _groupService = groupService;
        _documentService = documentService;
        _modelDomainService = modelDomainService;
        _logger = logger;
    }

    public void EnqueueGroupNameSuggestion(string groupId, string? fileName, string prdDocumentId)
    {
        // 使用 Task.Run 将任务放到后台线程池执行，不阻塞当前请求
        _ = Task.Run(async () =>
        {
            try
            {
                await SuggestAndUpdateGroupNameAsync(groupId, fileName, prdDocumentId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to suggest group name for group {GroupId}", groupId);
            }
        });
    }

    private async Task SuggestAndUpdateGroupNameAsync(string groupId, string? fileName, string prdDocumentId)
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
            if (!string.IsNullOrWhiteSpace(group.GroupName) && 
                group.GroupName != "新建群组" && 
                group.GroupName != "未命名群组")
            {
                _logger.LogInformation("Group {GroupId} already has custom name: {GroupName}, skipping suggestion", 
                    groupId, group.GroupName);
                return;
            }

            // 获取 PRD 文档
            if (string.IsNullOrWhiteSpace(prdDocumentId))
            {
                _logger.LogInformation("No PRD document for group {GroupId}, skipping name suggestion", groupId);
                return;
            }

            var document = await _documentService.GetByIdAsync(prdDocumentId);
            if (document == null)
            {
                _logger.LogWarning("PRD document {PrdDocumentId} not found for group {GroupId}", 
                    prdDocumentId, groupId);
                return;
            }

            // 提取文档片段用于生成名称
            var snippet = ExtractSnippet(document.RawContent);
            if (string.IsNullOrWhiteSpace(snippet))
            {
                _logger.LogInformation("No meaningful snippet from PRD for group {GroupId}", groupId);
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
        if (string.IsNullOrWhiteSpace(content))
            return string.Empty;

        var trimmed = content.Trim();
        if (trimmed.Length <= maxLength)
            return trimmed;

        // 取前面的内容作为片段
        return trimmed[..maxLength];
    }
}


