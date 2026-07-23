using Xunit;

namespace PrdAgent.Tests;

public class RateLimitPipelineOrderTests
{
    [Fact]
    public void Authentication_MustRunBeforeRateLimiting()
    {
        var program = ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs");
        var authenticationIndex = program.IndexOf("app.UseAuthentication();", StringComparison.Ordinal);
        var rateLimitIndex = program.IndexOf("app.UseRateLimiting();", StringComparison.Ordinal);

        Assert.True(authenticationIndex >= 0, "Program.cs 必须注册身份认证中间件");
        Assert.True(rateLimitIndex >= 0, "Program.cs 必须注册限流中间件");
        Assert.True(
            authenticationIndex < rateLimitIndex,
            "限流必须在身份认证之后执行，已登录用户才能按 userId 隔离限流桶");
    }

    private static string ReadRepoFile(string relativePath)
    {
        var root = LocateRepoRoot();
        var fullPath = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(fullPath), $"找不到文件: {fullPath}");
        return File.ReadAllText(fullPath);
    }

    private static string LocateRepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(directory.FullName, "prd-api")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    }
}
