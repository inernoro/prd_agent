using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 文档服务接口
/// </summary>
public interface IDocumentService
{
    /// <summary>解析Markdown文档</summary>
    Task<ParsedPrd> ParseAsync(string content);
    
    /// <summary>获取文档</summary>
    Task<ParsedPrd?> GetByIdAsync(string documentId);
    
    /// <summary>保存文档（元数据持久化，内容缓存）</summary>
    Task<ParsedPrd> SaveAsync(ParsedPrd document);
    
    /// <summary>估算Token数量</summary>
    int EstimateTokens(string content);
}



