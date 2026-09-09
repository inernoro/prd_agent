namespace PrdAgent.Infrastructure.GitHub;

/// <summary>
/// GitHub 仓库目录树里的一条记录（来自 Git Trees API 的 blob / tree 项）。
/// </summary>
/// <param name="Path">仓库内相对路径，不以 / 开头。</param>
/// <param name="Type">GitHub 原始类型：blob（文件）/ tree（目录）。</param>
public sealed record GitHubTreeEntry(string Path, string Type);

/// <summary>
/// 一个可被订阅同步的目录。<see cref="MarkdownCount"/> 只数**直属**该目录的 .md 文件，
/// 因为同步引擎（GitHubDirectorySyncService）本身就是按单层目录拉取的，不递归。
/// </summary>
public sealed class GitHubDirectoryNode
{
    /// <summary>仓库内目录路径；空串表示仓库根目录。</summary>
    public string Path { get; init; } = string.Empty;

    /// <summary>目录名；根目录为 "/"。</summary>
    public string Name { get; init; } = string.Empty;

    /// <summary>父目录路径；根目录为 null。</summary>
    public string? ParentPath { get; init; }

    /// <summary>层级深度，根目录为 0。</summary>
    public int Depth { get; init; }

    /// <summary>直属该目录的 Markdown 文件数（同步引擎只认 .md）。</summary>
    public int MarkdownCount { get; init; }

    /// <summary>直属该目录的全部文件数（给用户一个「这个目录多大」的感觉）。</summary>
    public int FileCount { get; init; }

    /// <summary>是否默认预勾选（doc / docs 目录及其含 Markdown 的子目录）。</summary>
    public bool Recommended { get; init; }
}

/// <summary>
/// 一次仓库目录扫描的结果。
/// </summary>
public sealed class GitHubDirectoryScan
{
    public string Owner { get; init; } = string.Empty;
    public string Repo { get; init; } = string.Empty;
    public string Branch { get; init; } = string.Empty;

    /// <summary>GitHub 侧或本地上限截断过（目录没列全）。</summary>
    public bool Truncated { get; init; }

    /// <summary>截断前的目录总数。</summary>
    public int TotalDirectories { get; init; }

    public IReadOnlyList<GitHubDirectoryNode> Directories { get; init; } = [];

    /// <summary>默认预勾选的目录路径（前端直接拿来当初始选中集）。</summary>
    public IReadOnlyList<string> RecommendedPaths =>
        Directories.Where(d => d.Recommended).Select(d => d.Path).ToList();
}

/// <summary>
/// 把 GitHub 仓库的扁平文件清单折算成「可勾选的目录清单 + 默认预勾选集合」。
///
/// 纯函数，不碰网络也不碰库 —— 判据（哪些目录算 doc 目录、哪些目录该被忽略）
/// 因此可以被单元测试直接打红，而不需要真实仓库。
///
/// 默认预勾选的判据（用户口径「递归扫出所有 doc/docs 目录预勾」）：
///   1. 路径上任意一段命中忽略名单（node_modules / dist / bin ...）或以 . 开头 → 不推荐；
///   2. 路径上存在名为 doc 或 docs 的目录段（本身或祖先）→ 命中；
///   3. 且该目录**直属**至少一个 .md 文件 —— 同步是单层的，
///      空壳容器目录（如只有子目录的 doc/）勾上去只会同步出 0 个文件。
/// </summary>
public static class GitHubDocDirectoryPlanner
{
    /// <summary>
    /// 默认扫描返回的目录数量上限，防止巨型仓库把响应撑爆。
    /// 取 1500 是量出来的：本仓库自己就有 666 个候选目录，600 那档一进来就是截断态，
    /// 而截断意味着用户想勾的某个目录可能根本没出现在清单里。
    /// </summary>
    public const int DefaultMaxDirectories = 1500;

    private static readonly HashSet<string> DocDirectoryNames =
        new(StringComparer.OrdinalIgnoreCase) { "doc", "docs" };

    private static readonly HashSet<string> IgnoredSegments =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "node_modules", "dist", "build", "bin", "obj", "out", "target",
            "vendor", "coverage", "__pycache__", "venv", "site-packages",
            "packages", "third_party", "thirdparty",
        };

    /// <summary>目录段是否属于「不该出现在知识库里」的构建/依赖产物。</summary>
    public static bool IsIgnoredSegment(string segment)
        => IgnoredSegments.Contains(segment) || segment.StartsWith('.');

    /// <summary>目录名是否是 doc / docs。</summary>
    public static bool IsDocDirectoryName(string name) => DocDirectoryNames.Contains(name);

    /// <summary>
    /// 路径是否落在某个 doc / docs 目录之内（含它自己）。
    /// 只看路径形状，不看有没有 Markdown —— 后者由 <see cref="BuildDirectories"/> 叠加。
    /// </summary>
    public static bool IsUnderDocDirectory(string path)
    {
        if (string.IsNullOrEmpty(path)) return false;

        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var hitDoc = false;
        foreach (var segment in segments)
        {
            if (IsIgnoredSegment(segment)) return false;
            if (IsDocDirectoryName(segment)) hitDoc = true;
        }
        return hitDoc;
    }

    /// <summary>
    /// 把 Git Trees API 的扁平清单折成目录节点列表（按路径升序，根目录在最前）。
    /// </summary>
    /// <param name="entries">仓库全量条目（blob + tree）。</param>
    /// <param name="maxDirectories">返回上限；超出时优先保留推荐目录及其祖先。</param>
    /// <param name="truncatedUpstream">GitHub 自己是否已经截断了目录树。</param>
    public static GitHubDirectoryScan BuildDirectories(
        IEnumerable<GitHubTreeEntry> entries,
        string owner,
        string repo,
        string branch,
        int maxDirectories = DefaultMaxDirectories,
        bool truncatedUpstream = false)
    {
        var markdownCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        var fileCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        var directories = new HashSet<string>(StringComparer.Ordinal) { string.Empty };

        foreach (var entry in entries)
        {
            var path = (entry.Path ?? string.Empty).Trim().Trim('/');
            if (path.Length == 0) continue;

            if (string.Equals(entry.Type, "tree", StringComparison.OrdinalIgnoreCase))
            {
                directories.Add(path);
                continue;
            }

            if (!string.Equals(entry.Type, "blob", StringComparison.OrdinalIgnoreCase)) continue;

            var parent = ParentOf(path);
            directories.Add(parent);
            fileCounts[parent] = fileCounts.GetValueOrDefault(parent) + 1;
            if (IsMarkdown(path))
            {
                markdownCounts[parent] = markdownCounts.GetValueOrDefault(parent) + 1;
            }
        }

        var nodes = directories
            .Select(path => new GitHubDirectoryNode
            {
                Path = path,
                Name = path.Length == 0 ? "/" : path[(path.LastIndexOf('/') + 1)..],
                ParentPath = path.Length == 0 ? null : ParentOf(path),
                Depth = path.Length == 0 ? 0 : path.Count(c => c == '/') + 1,
                MarkdownCount = markdownCounts.GetValueOrDefault(path),
                FileCount = fileCounts.GetValueOrDefault(path),
                Recommended = IsUnderDocDirectory(path) && markdownCounts.GetValueOrDefault(path) > 0,
            })
            .OrderBy(n => n.Path, StringComparer.Ordinal)
            .ToList();

        var total = nodes.Count;
        var truncated = truncatedUpstream;
        if (total > maxDirectories)
        {
            nodes = TrimToLimit(nodes, maxDirectories);
            truncated = true;
        }

        return new GitHubDirectoryScan
        {
            Owner = owner,
            Repo = repo,
            Branch = branch,
            Truncated = truncated,
            TotalDirectories = total,
            Directories = nodes,
        };
    }

    /// <summary>
    /// 超限时的取舍：先保推荐目录及其全部祖先（否则前端的树会断链），
    /// 再按路径顺序补齐其余目录，最后仍按路径升序返回。
    /// </summary>
    private static List<GitHubDirectoryNode> TrimToLimit(List<GitHubDirectoryNode> nodes, int limit)
    {
        var byPath = nodes.ToDictionary(n => n.Path, StringComparer.Ordinal);
        var keep = new HashSet<string>(StringComparer.Ordinal) { string.Empty };

        foreach (var node in nodes.Where(n => n.Recommended))
        {
            if (keep.Count >= limit) break;
            keep.Add(node.Path);
            for (var parent = node.ParentPath; parent != null; parent = byPath.GetValueOrDefault(parent)?.ParentPath)
            {
                keep.Add(parent);
                if (parent.Length == 0) break;
            }
        }

        foreach (var node in nodes)
        {
            if (keep.Count >= limit) break;
            keep.Add(node.Path);
        }

        return nodes.Where(n => keep.Contains(n.Path)).ToList();
    }

    private static bool IsMarkdown(string path)
        => path.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
        || path.EndsWith(".markdown", StringComparison.OrdinalIgnoreCase);

    private static string ParentOf(string path)
    {
        var idx = path.LastIndexOf('/');
        return idx < 0 ? string.Empty : path[..idx];
    }
}
