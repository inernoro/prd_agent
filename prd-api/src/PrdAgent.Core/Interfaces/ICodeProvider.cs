namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 代码访问层接口 - Agent 工具通过此接口访问代码库
/// </summary>
public interface ICodeProvider
{
    /// <summary>搜索代码</summary>
    Task<List<CodeSearchResult>> SearchAsync(
        string query,
        string? pathPrefix = null,
        string? fileExtension = null,
        int maxResults = 20,
        CancellationToken ct = default);

    /// <summary>读取文件内容</summary>
    Task<CodeFileContent> ReadFileAsync(
        string path,
        int? startLine = null,
        int? endLine = null,
        CancellationToken ct = default);

    /// <summary>列出目录结构</summary>
    Task<List<DirectoryEntry>> ListDirectoryAsync(
        string path,
        int depth = 2,
        string? pattern = null,
        CancellationToken ct = default);

    /// <summary>查找引用</summary>
    Task<List<CodeSearchResult>> FindReferencesAsync(
        string symbol,
        string? pathPrefix = null,
        CancellationToken ct = default);

    /// <summary>获取 Git 日志</summary>
    Task<List<GitCommitInfo>> GetGitLogAsync(
        string path,
        int count = 5,
        CancellationToken ct = default);
}

/// <summary>
/// 代码搜索结果
/// </summary>
public class CodeSearchResult
{
    public string FilePath { get; set; } = null!;
    public int? LineNumber { get; set; }
    public string? LineContent { get; set; }
    public string? Context { get; set; }
}

/// <summary>
/// 文件内容
/// </summary>
public class CodeFileContent
{
    public string FilePath { get; set; } = null!;
    public string Content { get; set; } = string.Empty;
    public int TotalLines { get; set; }
    public int? StartLine { get; set; }
    public int? EndLine { get; set; }
}

/// <summary>
/// 目录条目
/// </summary>
public class DirectoryEntry
{
    public string Path { get; set; } = null!;
    public string Name { get; set; } = null!;
    public bool IsDirectory { get; set; }
    public List<DirectoryEntry>? Children { get; set; }
}

/// <summary>
/// Git 提交信息
/// </summary>
public class GitCommitInfo
{
    public string Sha { get; set; } = null!;
    public string Message { get; set; } = null!;
    public string Author { get; set; } = null!;
    public DateTime Date { get; set; }
}

/// <summary>
/// CodeProvider 工厂接口
/// </summary>
public interface ICodeProviderFactory
{
    ICodeProvider Create(Core.Models.DefectRepoConfig repoConfig, string? token = null);
}
