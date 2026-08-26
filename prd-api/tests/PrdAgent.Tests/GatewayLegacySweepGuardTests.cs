using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 网关「MAP 遗留配置可清理」守卫。
///
/// 背景：平台与模型的删除阻挡清单一直**会数** MAP 侧的引用
///（CollectPlatformDeleteBlockersAsync / CollectModelDeleteBlockersAsync 都扫 modelGroups / mapModels），
/// 但删除历来只写 GW 集合。2026-08-25 MAP 的 `api/mds` 写接口整体退场（410）之后，
/// 这个不对称从「难看」升级成「死锁」：网关报着一串 MAP 遗留池挡路，两边都没有端点能扫掉它们。
///
/// 这组用例钉住修复后的**对称性**：凡是阻挡清单数得出来的来源，删除路径就必须够得着。
/// 谁把 MAP 分支删掉、或者把 append-only 的 dangling 例外放宽成「什么成员都能摘」，这里都会红。
/// </summary>
public class GatewayLegacySweepGuardTests
{
    private static readonly string Console = ReadRepoFile("llmgw/console-api/Program.cs");

    /// <summary>取某个 minimal-api 端点处理器的源码片段，避免整文件 Contains 误判到别处。</summary>
    private static string HandlerSource(string mapCall)
    {
        var start = Console.IndexOf(mapCall, StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到端点：{mapCall}");
        var end = Console.IndexOf("}).RequireAuthorization", start, StringComparison.Ordinal);
        Assert.True(end > start, $"端点 {mapCall} 没有以 RequireAuthorization 收尾，守卫的取值口径需要更新");
        return Console[start..end];
    }

    [Fact]
    public void 删除模型池_必须能扫掉MAP遗留池()
    {
        var handler = HandlerSource("app.MapDelete(\"/gw/pools/{id}\"");

        // 落回 MAP 集合去找，而不是直接 NOT_GW_AUTHORITY 打死
        Assert.Contains("modelGroups.Find(sourceFilter)", handler);
        // 真的删到 MAP 集合上（只判「找得到」不够——找到了却仍删 GW 集合等于没修）
        Assert.Contains("modelGroups.DeleteOneAsync(sourceFilter)", handler);
        // 只有内部租户可以碰 MAP 兼容层
        Assert.Contains("TenantAccess.GetRequired(http).TenantId == internalTenantId", handler);
        // 审计要分得清扫的是哪一侧
        Assert.Contains("map_model_group", handler);
    }

    [Fact]
    public void 删除模型_必须能扫掉MAP遗留模型()
    {
        var handler = HandlerSource("app.MapDelete(\"/gw/models/{id}\"");

        Assert.Contains("models.Find(sourceFilter)", handler);
        Assert.Contains("models.DeleteOneAsync(sourceFilter)", handler);
        Assert.Contains("TenantAccess.GetRequired(http).TenantId == internalTenantId", handler);
        Assert.Contains("map_llm_model", handler);
    }

    [Fact]
    public void MAP分支不得绕过引用检查()
    {
        // 能扫 debris 不等于可以无脑级联删。两个端点都必须先算 blockers 再删，
        // 顺序错了就会把「还被别人引用的东西」也一并删掉。
        foreach (var (endpoint, blockerCall) in new[]
                 {
                     ("app.MapDelete(\"/gw/pools/{id}\"", "AppCallers"),
                     ("app.MapDelete(\"/gw/models/{id}\"", "CollectModelDeleteBlockersAsync"),
                 })
        {
            var handler = HandlerSource(endpoint);
            var blockerAt = handler.IndexOf(blockerCall, StringComparison.Ordinal);
            var deleteAt = handler.IndexOf("DeleteOneAsync", StringComparison.Ordinal);
            Assert.True(blockerAt >= 0, $"{endpoint} 里找不到引用检查 {blockerCall}");
            Assert.True(deleteAt > blockerAt, $"{endpoint} 必须先算引用阻挡再删除");
            Assert.Contains("TotalCount > 0", handler);
        }
    }

    [Fact]
    public void 平台托管默认池只对死成员放开摘除()
    {
        var handler = HandlerSource("app.MapDelete(\"/gw/pools/{id}/models\"");

        // 例外必须走那个专门的判定函数，而不是把 append-only 检查整段删掉
        Assert.Contains("IsManagedAppendOnlyPool(pool)", handler);
        Assert.Contains("IsDanglingPoolMemberAsync", handler);
        Assert.Contains("APPEND_ONLY_POOL", handler);
    }

    [Fact]
    public void 死成员判定必须两侧都查不到才算死()
    {
        var fn = Console[Console.IndexOf("static async Task<bool> IsDanglingPoolMemberAsync", StringComparison.Ordinal)..];
        fn = fn[..fn.IndexOf("\nstatic ", StringComparison.Ordinal)];

        // GW 侧查得到 -> 活的
        Assert.Contains("gwPlatforms.Find", fn);
        // MAP 侧查得到 -> 也是活的（只查一侧就会把 MAP 来源的活成员误判成死成员）
        Assert.Contains("mapPlatforms.Find", fn);
        // 四条早退：成员不存在 / platformId 为空 / GW 侧命中 / MAP 侧命中。
        // 任一命中立即 return false，不允许改成「都查完再取或」——那种写法一旦某条查询抛错或被短路，
        // 就会把活成员判成死成员摘掉（宁可拒绝，不可误删）。
        Assert.Equal(4, Regex.Matches(fn, @"return false;").Count);
        // 成员不存在、platformId 为空，一律当活成员保护
        Assert.Contains("if (targets.Count == 0) return false;", fn);
        Assert.Contains("if (string.IsNullOrWhiteSpace(memberPlatformId)) return false;", fn);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }
}
