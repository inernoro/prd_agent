using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 「这个用途没点名模型时用它」——阶段 1 的守卫。
///
/// 背景：模型池与逻辑模型逐字段对照后，七项里六项一一对应，唯一的真差别是池能当
/// 「没点名时的兜底」。补上这个标记之后，池就不再是另一种东西，只是这一行多了个标记。
///
/// 这一阶段的全部价值在于**可回退**：把标记关掉，或者默认模型自己坏掉，线上行为必须和
/// 没有这个功能时一模一样。下面三条钉的就是这个，每条都属于「改动删掉后编译照过、
/// 测试照绿」的形状。
/// </summary>
public class GatewayDefaultModelGuardTests
{
    private static readonly string Resolver =
        ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");

    private static readonly string Console = ReadRepoFile("llmgw/console-api/Program.cs");

    private static readonly string Page = ReadRepoFile("llmgw/web/src/pages/LogicalModelsPage.tsx");

    [Fact]
    public void 默认模型只在没点名时才参与解析()
    {
        // 点名了还去看默认，就是「选 A 给 B」——本仓库专门立过规矩要防的事。
        var core = MethodSource("private async Task<ModelResolutionResult> ResolveCoreAsync");
        var call = core.IndexOf("TryResolveDefaultLogicalModelAsync", StringComparison.Ordinal);
        Assert.True(call > 0, "默认模型解析没有接进主链路：只有定义没有调用方");

        // 调用点必须被「没点名」这个条件罩住
        var guardStart = core.LastIndexOf("string.IsNullOrWhiteSpace(expectedModel)", call, StringComparison.Ordinal);
        Assert.True(guardStart > 0 && call - guardStart < 600,
            "TryResolveDefaultLogicalModelAsync 的调用点没有被「expectedModel 为空」罩住");
    }

    [Fact]
    public void 默认模型解析不出来要回落到池而不是失败()
    {
        var method = MethodSource("private async Task<ModelResolutionResult?> TryResolveDefaultLogicalModelAsync");

        // 返回 null 才会让调用方继续往下走到模型池；返回失败结果就等于把回退路堵死了，
        // 那样「把标记关掉就恢复原状」这个承诺不成立。
        Assert.Contains("if (resolved is null || resolved.Success) return resolved;", method);
        Assert.Contains("return null;", method);
        // 回落要留痕，否则默认模型坏了没人知道，只会看到流量莫名其妙走了池
        Assert.Contains("默认模型解析失败", method);
    }

    [Fact]
    public void 同用途最多一个默认且先清旧再置新()
    {
        var handler = HandlerSource("app.MapPut(\"/gw/logical-models/{id}\"");

        // 必须按 ModelType 找同用途的旧默认
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"ModelType\", modelType)", handler);
        Assert.Contains("Builders<BsonDocument>.Filter.Eq(\"IsDefaultForType\", true)", handler);
        Assert.Contains("Builders<BsonDocument>.Filter.Ne(\"_id\", id)", handler);

        // 顺序是判据：清旧的那段必须排在置新的那句之前。
        // 反过来会出现一瞬间两个默认，恰好落在那一瞬的请求解析到哪个全看运气。
        var clearOld = handler.IndexOf("Builders<BsonDocument>.Update.Set(\"IsDefaultForType\", false)", StringComparison.Ordinal);
        var setNew = handler.IndexOf("updates.Add(Builders<BsonDocument>.Update.Set(\"IsDefaultForType\", body.IsDefaultForType.Value))", StringComparison.Ordinal);
        Assert.True(clearOld > 0 && setNew > 0, "设默认的读写两段都要在");
        Assert.True(clearOld < setNew, "必须先清同用途旧默认，再置新默认");

        // 顶掉了谁要进审计：换兜底模型会改变线上行为，日后要查得到是谁在什么时候换的
        Assert.Contains("displacedDefaults", handler);
    }

    [Fact]
    public void 解析入口只有一份共用实现()
    {
        // 按名字找和按默认找必须走同一个解析体，否则就是又一次「判据分裂成两份各自漂移」——
        // 这一整项工程要消灭的正是这个形状。
        Assert.Contains("private async Task<ModelResolutionResult?> ResolveFromLogicalModelAsync", Resolver);
        Assert.True(CountOccurrences(Resolver, "ResolveFromLogicalModelAsync") >= 3,
            "共用解析体应当被按名字与按默认两条入口各调用一次");
    }

    [Fact]
    public void 控制台把换兜底这件事说清楚()
    {
        // 行上要看得见谁是默认，否则「没点名走哪个」只能靠猜
        Assert.Contains("item.isDefaultForType", Page);
        Assert.Contains("没点名时用它", Page);
        // 取消默认时要说清后果：这类请求会当场失败，而不是含糊的「没有模型可用」
        Assert.Contains("会失败，直到你给它设一个新的默认", Page);
        // 同用途旧默认被服务端清掉后，本地列表要跟着改，否则会同时显示两个默认
        Assert.Contains("x.modelType === item.modelType && x.isDefaultForType", Page);
    }

    private static string HandlerSource(string mapCall)
    {
        var start = Console.IndexOf(mapCall, StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到端点：{mapCall}");
        var end = Console.IndexOf("}).RequireAuthorization", start, StringComparison.Ordinal);
        Assert.True(end > start, $"端点 {mapCall} 没有以 RequireAuthorization 收尾，守卫的取值口径需要更新");
        return Console[start..end];
    }

    private static string MethodSource(string signature)
    {
        var start = Resolver.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到方法：{signature}");
        var depth = 0;
        var seenOpen = false;
        for (var i = start; i < Resolver.Length; i++)
        {
            if (Resolver[i] == '{') { depth++; seenOpen = true; }
            else if (Resolver[i] == '}')
            {
                depth--;
                if (seenOpen && depth == 0) return Resolver[start..(i + 1)];
            }
        }
        Assert.Fail($"方法 {signature} 的花括号没有配平，守卫的取值口径需要更新");
        return string.Empty;
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        var index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }
        return count;
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }
}
