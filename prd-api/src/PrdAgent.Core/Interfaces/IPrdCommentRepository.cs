using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IPrdCommentRepository
{
    Task<PrdComment?> GetByIdAsync(string commentId);

    Task<List<PrdComment>> ListAsync(string documentId, string? headingId, int limit);

    Task InsertAsync(PrdComment comment);

    Task DeleteAsync(string commentId);

    Task DeleteByDocumentIdAsync(string documentId);
}
