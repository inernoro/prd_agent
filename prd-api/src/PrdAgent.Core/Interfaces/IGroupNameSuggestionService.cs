namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 群组名称建议服务接口
/// </summary>
public interface IGroupNameSuggestionService
{
    /// <summary>
    /// 在后台异步生成并更新群组名称（基于知识库文档内容）
    /// </summary>
    /// <param name="groupId">群组ID</param>
    /// <param name="fileName">文件名（可选，首个上传文件的名称）</param>
    void EnqueueGroupNameSuggestion(string groupId, string? fileName);
}
