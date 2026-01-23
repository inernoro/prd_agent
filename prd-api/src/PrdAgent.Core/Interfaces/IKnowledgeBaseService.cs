using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 知识库服务接口
/// </summary>
public interface IKnowledgeBaseService
{
    /// <summary>获取群组的活跃文档列表</summary>
    Task<List<KbDocument>> GetActiveDocumentsAsync(string groupId);

    /// <summary>获取单个文档</summary>
    Task<KbDocument?> GetByIdAsync(string documentId);

    /// <summary>上传文档（支持多文件）</summary>
    Task<List<KbDocument>> UploadDocumentsAsync(
        string groupId,
        string uploadedBy,
        List<KbUploadFile> files,
        CancellationToken ct = default);

    /// <summary>替换文档</summary>
    Task<KbDocument> ReplaceDocumentAsync(
        string documentId,
        string groupId,
        KbUploadFile file,
        CancellationToken ct = default);

    /// <summary>删除文档（软删除）</summary>
    Task DeleteDocumentAsync(string documentId, string groupId);

    /// <summary>获取群组文档数量</summary>
    Task<int> GetDocumentCountAsync(string groupId);

    /// <summary>检查群组是否有知识库文档</summary>
    Task<bool> HasDocumentsAsync(string groupId);
}

/// <summary>
/// 待上传文件（内存数据）
/// </summary>
public class KbUploadFile
{
    public string FileName { get; set; } = string.Empty;
    public byte[] Content { get; set; } = Array.Empty<byte>();
    public string MimeType { get; set; } = string.Empty;
    public long Size { get; set; }
}
