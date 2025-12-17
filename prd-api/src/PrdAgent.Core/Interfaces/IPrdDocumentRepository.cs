using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// PRD 文档持久化仓储（长期存储）
/// </summary>
public interface IPrdDocumentRepository
{
    Task<ParsedPrd?> GetByIdAsync(string documentId);
    Task UpsertAsync(ParsedPrd document);
    Task DeleteAsync(string documentId);
}

