using System.Reflection;
using System.Text.RegularExpressions;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Tests;

/// <summary>
/// GatewayRawRequest 在跨进程链路上被"逐字段拷贝"了两次：
///   1. MAP 侧 HttpLlmGatewayClient —— 把请求打包发给 llmgw serving 的 /gw/v1/raw；
///   2. serving 侧 ApplyIngressRouting —— 收到后按已验证的租户/路由信息重建一份。
/// 两处都是手写的对象初始化器。给 GatewayRawRequest 加了新字段却忘了同步这两处，
/// 结果不是编译错误，而是**该字段在 http 模式下静默丢失**——本地 inproc 一切正常，
/// 生产走 http 就行为不一致，极难查。EndpointPathIsAbsolute 落地时就踩了这个坑。
///
/// 本守卫扫这两处源码里赋值的属性名，与 GatewayRawRequest 的公开属性集合逐一对账。
/// </summary>
public class GatewayRawRequestRelayGuardTests
{
    /// <summary>
    /// 明确不转发的字段及原因。往这里加条目必须写清为什么，不许拿它当"编译过了就行"的垃圾桶。
    /// </summary>
    private static readonly Dictionary<string, string> IntentionallyNotRelayed = new()
    {
        // 内联字节不跨进程：先落对象存储换成 MultipartFileRefs，再过线（见 HttpLlmGatewayClient 注释）
        ["MultipartFiles"] = "大负载禁止 base64 内联过线，改传 MultipartFileRefs",
        // 下面几个由过线两端各自按已验证信息重算，不能原样透传
        ["ExpectedModel"] = "由调用方 resolution / serving ingress 重新锁定",
        ["PinnedPlatformId"] = "由 serving ingress 按已验证路由重建",
        ["PinnedModelId"] = "由 serving ingress 按已验证路由重建",
        ["RequiredLogicalModelPublicId"] = "由调用方 resolution 写入，不接受下游伪造",
        ["Context"] = "两端都要重建（打传输标记 / 覆盖已验证租户）",
    };

    [Fact]
    public void HttpLlmGatewayClient_RelaysEveryRawRequestField()
        => AssertRelaysAllFields(
            Path.Combine(FindSrcRoot(), "PrdAgent.Infrastructure", "LlmGateway", "HttpLlmGatewayClient.cs"),
            "MAP 侧过线拷贝");

    [Fact]
    public void ServingIngressRouting_RelaysEveryRawRequestField()
        => AssertRelaysAllFields(
            Path.Combine(FindRepoRoot(), "llmgw", "serving", "GatewayHttpEndpoints.cs"),
            "serving 侧重建拷贝");

    private static void AssertRelaysAllFields(string sourcePath, string label)
    {
        Assert.True(File.Exists(sourcePath), $"{label} 源文件不存在：{sourcePath}");
        var source = File.ReadAllText(sourcePath);

        var assigned = ExtractAssignedProperties(source);
        Assert.True(assigned.Count > 0, $"{label} 没找到 new GatewayRawRequest {{ ... }} 初始化器，守卫已失效");

        var expected = typeof(GatewayRawRequest)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.CanWrite)
            .Select(p => p.Name)
            .Where(name => !IntentionallyNotRelayed.ContainsKey(name))
            .ToList();

        var missing = expected.Where(name => !assigned.Contains(name)).OrderBy(x => x).ToList();

        Assert.True(missing.Count == 0,
            $"{label}（{Path.GetFileName(sourcePath)}）漏了 GatewayRawRequest 的字段：{string.Join(", ", missing)}。\n" +
            "这类遗漏不会编译报错，只会让该字段在 http 模式下静默丢失。\n" +
            "要么在拷贝处补上，要么在 IntentionallyNotRelayed 里显式登记并写明原因。");
    }

    /// <summary>抓出所有 new GatewayRawRequest { ... } 初始化器里被赋值的属性名</summary>
    private static HashSet<string> ExtractAssignedProperties(string source)
    {
        var assigned = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match start in Regex.Matches(source, @"new\s+GatewayRawRequest\s*\{"))
        {
            var open = source.IndexOf('{', start.Index);
            if (open < 0) continue;

            var depth = 0;
            var end = -1;
            for (var i = open; i < source.Length; i++)
            {
                if (source[i] == '{') depth++;
                else if (source[i] == '}')
                {
                    depth--;
                    if (depth == 0) { end = i; break; }
                }
            }
            if (end < 0) continue;

            var block = source[open..end];
            // 只认初始化器最外层的 "PropertyName =" —— 嵌套对象里的同名属性不算
            var nested = 0;
            var lineStart = 0;
            for (var i = 0; i < block.Length; i++)
            {
                if (block[i] == '{') nested++;
                else if (block[i] == '}') nested--;
                else if (block[i] == ',' && nested <= 1)
                {
                    TryTakeAssignment(block[lineStart..i], nested, assigned);
                    lineStart = i + 1;
                }
            }
            TryTakeAssignment(block[lineStart..], nested, assigned);
        }
        return assigned;
    }

    private static void TryTakeAssignment(string segment, int nested, HashSet<string> sink)
    {
        // 第一段会带上初始化器的左花括号；字段前还可能有解释性行注释。
        // 先移除这两类非语义前缀，避免真实已转发字段被误报为缺失。
        var normalized = Regex.Replace(segment, @"(?m)^\s*//.*(?:\r?\n|$)", string.Empty)
            .TrimStart('{', ' ', '\t', '\r', '\n')
            .Trim();
        var m = Regex.Match(normalized, @"^([A-Z][A-Za-z0-9_]*)\s*=");
        if (m.Success) sink.Add(m.Groups[1].Value);
    }

    private static string FindSrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln")))
                return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "llmgw", "serving"))) return dir.FullName;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));
    }
}
