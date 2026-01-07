namespace PrdAgent.Core.Interfaces;

/// <summary>
/// ID生成器接口
/// </summary>
public interface IIdGenerator
{
    /// <summary>
    /// 生成实体ID
    /// </summary>
    /// <param name="category">实体类别（如: user, group, platform）</param>
    /// <returns>生成的ID</returns>
    Task<string> GenerateIdAsync(string category);
}

