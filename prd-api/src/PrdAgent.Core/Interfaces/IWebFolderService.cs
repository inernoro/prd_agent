using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 网页/知识库自定义文件夹领域服务。
/// 负责文件夹的 CRUD（按 OwnerUserId 隔离）以及「按文件夹生成」——
/// 把文件夹绑定的 Markdown 模板（或 skill，best-effort）渲染为托管网页 /
/// 知识库条目。
/// </summary>
public interface IWebFolderService
{
    /// <summary>创建文件夹（OwnerUserId 由调用方传入的 userId 强制覆盖）</summary>
    Task<WebFolder> CreateAsync(string userId, WebFolder input, CancellationToken ct = default);

    /// <summary>列出当前用户的全部文件夹（按 SortOrder、CreatedAt 排序）</summary>
    Task<List<WebFolder>> ListAsync(string userId, CancellationToken ct = default);

    /// <summary>更新文件夹（仅允许更新自己的；返回更新后的实体，不存在/无权返回 null）</summary>
    Task<WebFolder?> UpdateAsync(string id, string userId, WebFolder patch, CancellationToken ct = default);

    /// <summary>删除文件夹（仅允许删除自己的）</summary>
    Task<bool> DeleteAsync(string id, string userId, CancellationToken ct = default);

    /// <summary>
    /// 按文件夹生成网页 / 知识库条目。
    /// 返回包含 generated 标志的结果对象；未配置生成器或暂不支持时返回
    /// { generated = false, reason = "..." }，调用方据此提示用户。
    /// </summary>
    Task<object> GenerateAsync(string id, string userId, CancellationToken ct = default);
}
