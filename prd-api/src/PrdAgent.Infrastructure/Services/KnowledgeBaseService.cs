using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using UglyToad.PdfPig;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 知识库服务实现
/// </summary>
public class KnowledgeBaseService : IKnowledgeBaseService
{
    private readonly IMongoCollection<KbDocument> _kbDocuments;
    private readonly IAssetStorage _storage;
    private readonly ILogger<KnowledgeBaseService> _logger;

    private const int MaxDocumentsPerGroup = 10;
    private const long MaxFileSizeBytes = 10 * 1024 * 1024; // 10MB
    private const string StorageDomain = "kb-documents";
    private const string StorageTypePdf = "pdf";
    private const string StorageTypeMd = "md";

    public KnowledgeBaseService(
        MongoDbContext db,
        IAssetStorage storage,
        ILogger<KnowledgeBaseService> logger)
        : this(db.KbDocuments, storage, logger) { }

    public KnowledgeBaseService(
        IMongoCollection<KbDocument> kbDocuments,
        IAssetStorage storage,
        ILogger<KnowledgeBaseService> logger)
    {
        _kbDocuments = kbDocuments;
        _storage = storage;
        _logger = logger;
    }

    public async Task<List<KbDocument>> GetActiveDocumentsAsync(string groupId)
    {
        return await _kbDocuments
            .Find(d => d.GroupId == groupId && d.Status == KbDocumentStatus.Active)
            .SortBy(d => d.UploadedAt)
            .ToListAsync();
    }

    public async Task<KbDocument?> GetByIdAsync(string documentId)
    {
        return await _kbDocuments
            .Find(d => d.DocumentId == documentId && d.Status == KbDocumentStatus.Active)
            .FirstOrDefaultAsync();
    }

    public async Task<List<KbDocument>> UploadDocumentsAsync(
        string groupId,
        string uploadedBy,
        List<KbUploadFile> files,
        CancellationToken ct = default)
    {
        // 校验数量上限
        var existingCount = await GetDocumentCountAsync(groupId);
        if (existingCount + files.Count > MaxDocumentsPerGroup)
        {
            throw new InvalidOperationException(
                $"知识库文档总数不能超过{MaxDocumentsPerGroup}份（当前{existingCount}份，本次上传{files.Count}份）");
        }

        var results = new List<KbDocument>();
        foreach (var file in files)
        {
            ValidateFile(file);
            var doc = await UploadSingleDocumentAsync(groupId, uploadedBy, file, ct);
            results.Add(doc);
        }

        return results;
    }

    public async Task<KbDocument> ReplaceDocumentAsync(
        string documentId,
        string groupId,
        KbUploadFile file,
        CancellationToken ct = default)
    {
        ValidateFile(file);

        var existing = await GetByIdAsync(documentId);
        if (existing == null || existing.GroupId != groupId)
        {
            throw new InvalidOperationException("文档不存在或不属于该群组");
        }

        // 上传新文件到 COS
        var fileType = DetectFileType(file.FileName);
        var storageType = fileType == KbFileType.Pdf ? StorageTypePdf : StorageTypeMd;
        var stored = await _storage.SaveAsync(file.Content, file.MimeType, ct, StorageDomain, storageType);

        // 提取文本
        var textContent = ExtractText(file.Content, fileType, file.FileName);
        var charCount = textContent?.Length ?? 0;
        var tokenEstimate = EstimateTokens(charCount);

        // 尝试删除旧文件
        if (!string.IsNullOrEmpty(existing.FileSha256))
        {
            try
            {
                var oldStorageType = existing.FileType == KbFileType.Pdf ? StorageTypePdf : StorageTypeMd;
                await _storage.DeleteByShaAsync(existing.FileSha256, ct, StorageDomain, oldStorageType);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to delete old KB file: {Sha256}", existing.FileSha256);
            }
        }

        // 更新文档记录
        var update = Builders<KbDocument>.Update
            .Set(d => d.FileName, file.FileName)
            .Set(d => d.FileType, fileType)
            .Set(d => d.FileSize, file.Size)
            .Set(d => d.FileUrl, stored.Url)
            .Set(d => d.FileSha256, stored.Sha256)
            .Set(d => d.TextContent, textContent)
            .Set(d => d.CharCount, charCount)
            .Set(d => d.TokenEstimate, tokenEstimate)
            .Inc(d => d.ReplaceVersion, 1);

        await _kbDocuments.UpdateOneAsync(
            d => d.DocumentId == documentId,
            update,
            cancellationToken: ct);

        _logger.LogInformation("KB document replaced: {DocumentId} in group {GroupId}", documentId, groupId);

        return (await GetByIdAsync(documentId))!;
    }

    public async Task DeleteDocumentAsync(string documentId, string groupId)
    {
        var existing = await GetByIdAsync(documentId);
        if (existing == null || existing.GroupId != groupId)
        {
            throw new InvalidOperationException("文档不存在或不属于该群组");
        }

        var update = Builders<KbDocument>.Update
            .Set(d => d.Status, KbDocumentStatus.Deleted);

        await _kbDocuments.UpdateOneAsync(
            d => d.DocumentId == documentId,
            update);

        _logger.LogInformation("KB document deleted: {DocumentId} in group {GroupId}", documentId, groupId);
    }

    public async Task<int> GetDocumentCountAsync(string groupId)
    {
        return (int)await _kbDocuments.CountDocumentsAsync(
            d => d.GroupId == groupId && d.Status == KbDocumentStatus.Active);
    }

    public async Task<bool> HasDocumentsAsync(string groupId)
    {
        return await _kbDocuments.Find(
            d => d.GroupId == groupId && d.Status == KbDocumentStatus.Active)
            .AnyAsync();
    }

    private async Task<KbDocument> UploadSingleDocumentAsync(
        string groupId,
        string uploadedBy,
        KbUploadFile file,
        CancellationToken ct)
    {
        var fileType = DetectFileType(file.FileName);
        var storageType = fileType == KbFileType.Pdf ? StorageTypePdf : StorageTypeMd;

        // 上传到 COS
        var stored = await _storage.SaveAsync(file.Content, file.MimeType, ct, StorageDomain, storageType);

        // 提取文本内容
        var textContent = ExtractText(file.Content, fileType, file.FileName);
        var charCount = textContent?.Length ?? 0;
        var tokenEstimate = EstimateTokens(charCount);

        var doc = new KbDocument
        {
            DocumentId = Guid.NewGuid().ToString("N"),
            GroupId = groupId,
            FileName = file.FileName,
            FileType = fileType,
            FileSize = file.Size,
            FileUrl = stored.Url,
            FileSha256 = stored.Sha256,
            TextContent = textContent,
            CharCount = charCount,
            TokenEstimate = tokenEstimate,
            UploadedBy = uploadedBy,
            UploadedAt = DateTime.UtcNow,
            ReplaceVersion = 1,
            Status = KbDocumentStatus.Active
        };

        await _kbDocuments.InsertOneAsync(doc, cancellationToken: ct);

        _logger.LogInformation("KB document uploaded: {DocumentId} ({FileName}) to group {GroupId}",
            doc.DocumentId, doc.FileName, groupId);

        return doc;
    }

    private void ValidateFile(KbUploadFile file)
    {
        if (file.Size > MaxFileSizeBytes)
        {
            throw new InvalidOperationException($"文件 {file.FileName} 大小超过限制（最大10MB）");
        }

        if (file.Size == 0 || file.Content.Length == 0)
        {
            throw new InvalidOperationException($"文件 {file.FileName} 内容为空");
        }

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (ext is not (".pdf" or ".md"))
        {
            throw new InvalidOperationException($"文件 {file.FileName} 格式不支持（仅支持 .pdf 和 .md）");
        }
    }

    private static KbFileType DetectFileType(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext == ".pdf" ? KbFileType.Pdf : KbFileType.Markdown;
    }

    private string? ExtractText(byte[] content, KbFileType fileType, string fileName)
    {
        try
        {
            if (fileType == KbFileType.Markdown)
            {
                return System.Text.Encoding.UTF8.GetString(content);
            }

            // PDF 文本提取
            using var document = PdfDocument.Open(content);
            var sb = new System.Text.StringBuilder();
            foreach (var page in document.GetPages())
            {
                var text = page.Text;
                if (!string.IsNullOrWhiteSpace(text))
                {
                    sb.AppendLine(text);
                }
            }

            var result = sb.ToString().Trim();
            if (string.IsNullOrWhiteSpace(result))
            {
                _logger.LogWarning("PDF text extraction returned empty for: {FileName}", fileName);
                return null;
            }

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to extract text from: {FileName}", fileName);
            return null;
        }
    }

    private static int EstimateTokens(int charCount)
    {
        // 中文约 1.5 字/token，英文约 4 字符/token，取折中
        return (int)(charCount / 1.8);
    }
}
