using System.Linq.Expressions;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// MongoDB仓储接口
/// </summary>
public interface IMongoRepository<T> where T : class
{
    Task<T?> FindByIdAsync(string id);
    Task<T?> FindOneAsync(Expression<Func<T, bool>> filter);
    Task<List<T>> FindAsync(Expression<Func<T, bool>> filter);
    Task<List<T>> FindAllAsync();
    Task InsertAsync(T entity);
    Task UpdateAsync(string id, T entity);
    Task<T?> FindOneAndUpdateAsync(Expression<Func<T, bool>> filter, object update);
    Task DeleteAsync(string id);
    Task DeleteAsync(Expression<Func<T, bool>> filter);
    Task<long> CountAsync(Expression<Func<T, bool>> filter);
}