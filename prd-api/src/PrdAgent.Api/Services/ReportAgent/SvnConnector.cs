using System.Diagnostics;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// SVN 连接器 — 通过 svn log 命令行拉取提交记录
/// 要求服务器已安装 svn CLI 工具
/// </summary>
public partial class SvnConnector : ICodeSourceConnector
{
    private readonly ReportDataSource _source;
    private readonly string? _token; // SVN password
    private readonly MongoDbContext _db;
    private readonly ILogger _logger;

    public SvnConnector(ReportDataSource source, string? token, MongoDbContext db, ILogger logger)
    {
        _source = source;
        _token = token;
        _db = db;
        _logger = logger;
    }

    public async Task<bool> TestConnectionAsync(CancellationToken ct)
    {
        try
        {
            var args = BuildSvnArgs("info", _source.RepoUrl);
            var (exitCode, _) = await RunSvnAsync(args, ct);
            return exitCode == 0;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "SVN 连接测试失败: {RepoUrl}", _source.RepoUrl);
            return false;
        }
    }

    public async Task<int> SyncAsync(CancellationToken ct)
    {
        var since = _source.LastSyncAt ?? DateTime.UtcNow.AddDays(-30);
        var sinceStr = since.ToString("yyyy-MM-dd");
        var untilStr = DateTime.UtcNow.AddDays(1).ToString("yyyy-MM-dd");

        var args = BuildSvnArgs("log", _source.RepoUrl,
            "--xml", "-v",
            $"-r{{{sinceStr}}}:{{{untilStr}}}");

        var (exitCode, output) = await RunSvnAsync(args, ct);
        if (exitCode != 0)
        {
            throw new Exception($"svn log 返回非零退出码 {exitCode}: {output}");
        }

        var commits = ParseSvnLogXml(output);
        var totalSynced = 0;

        foreach (var commit in commits)
        {
            // 通过 UserMapping 映射用户
            string? mappedUserId = null;
            if (_source.UserMapping.TryGetValue(commit.AuthorName, out var mapped))
                mappedUserId = mapped;

            var reportCommit = new ReportCommit
            {
                DataSourceId = _source.Id,
                MappedUserId = mappedUserId,
                AuthorName = commit.AuthorName,
                AuthorEmail = "", // SVN 不提供 email
                CommitHash = commit.Revision,
                Message = commit.Message.Length > 500 ? commit.Message[..500] : commit.Message,
                CommittedAt = commit.Date,
                Branch = "", // SVN uses paths not branches
                Additions = commit.FilesChanged,
                Deletions = 0,
                FilesChanged = commit.FilesChanged
            };

            try
            {
                await _db.ReportCommits.ReplaceOneAsync(
                    c => c.DataSourceId == _source.Id && c.CommitHash == commit.Revision,
                    reportCommit,
                    new ReplaceOptions { IsUpsert = true },
                    ct);
                totalSynced++;
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 已存在，跳过
            }
        }

        return totalSynced;
    }

    private string BuildSvnArgs(string command, string repoUrl, params string[] extra)
    {
        var args = $"{command} \"{repoUrl}\" --non-interactive --trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other";

        // 从 UserMapping 中查找 SVN 用户名（key=__svn_username__）
        if (_source.UserMapping.TryGetValue("__svn_username__", out var username) &&
            !string.IsNullOrEmpty(username))
        {
            args += $" --username \"{username}\"";
        }

        if (!string.IsNullOrEmpty(_token))
        {
            args += $" --password \"{_token}\"";
        }

        if (extra.Length > 0)
        {
            args += " " + string.Join(" ", extra);
        }

        return args;
    }

    private static async Task<(int exitCode, string output)> RunSvnAsync(string args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "svn",
            Arguments = args,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(psi)
            ?? throw new Exception("无法启动 svn 进程，请确保服务器已安装 SVN CLI");

        var output = await process.StandardOutput.ReadToEndAsync(ct);
        var error = await process.StandardError.ReadToEndAsync(ct);
        await process.WaitForExitAsync(ct);

        return (process.ExitCode, process.ExitCode == 0 ? output : error);
    }

    private static List<SvnLogEntry> ParseSvnLogXml(string xml)
    {
        var entries = new List<SvnLogEntry>();

        // Parse svn log --xml output
        // <logentry revision="123"><author>user</author><date>2026-01-01T00:00:00.000000Z</date><paths>...</paths><msg>message</msg></logentry>
        var entryMatches = LogEntryRegex().Matches(xml);

        foreach (Match match in entryMatches)
        {
            var revision = match.Groups["rev"].Value;
            var innerXml = match.Groups["inner"].Value;

            var author = ExtractXmlValue(innerXml, "author") ?? "unknown";
            var dateStr = ExtractXmlValue(innerXml, "date");
            var message = ExtractXmlValue(innerXml, "msg") ?? "";

            var date = DateTime.TryParse(dateStr, out var d) ? d : DateTime.UtcNow;

            // Count file changes in <paths>
            var filesChanged = PathRegex().Matches(innerXml).Count;

            entries.Add(new SvnLogEntry
            {
                Revision = $"r{revision}",
                AuthorName = author,
                Date = date,
                Message = message,
                FilesChanged = filesChanged > 0 ? filesChanged : 1
            });
        }

        return entries;
    }

    private static string? ExtractXmlValue(string xml, string tag)
    {
        var match = Regex.Match(xml, $"<{tag}>(.*?)</{tag}>", RegexOptions.Singleline);
        return match.Success ? match.Groups[1].Value.Trim() : null;
    }

    [GeneratedRegex(@"<logentry\s+revision=""(?<rev>\d+)"">(?<inner>.*?)</logentry>", RegexOptions.Singleline)]
    private static partial Regex LogEntryRegex();

    [GeneratedRegex(@"<path\s")]
    private static partial Regex PathRegex();

    private class SvnLogEntry
    {
        public string Revision { get; set; } = "";
        public string AuthorName { get; set; } = "";
        public DateTime Date { get; set; }
        public string Message { get; set; } = "";
        public int FilesChanged { get; set; }
    }
}
