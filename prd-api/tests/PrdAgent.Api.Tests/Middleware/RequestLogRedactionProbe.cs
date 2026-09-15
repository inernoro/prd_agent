using System.Reflection;
using PrdAgent.Api.Middleware;
using Shouldly;

namespace PrdAgent.Api.Tests.Middleware;

/// <summary>
/// 问中间件那个私有判据本人：这条路径的请求/响应体挡不挡。
///
/// 单独成件，是因为它已经有两处要用（跨实例同步一处、智能体开放层一处）。抄两份
/// 就是下一次判据分裂的起点：一处跟着改名改了、另一处继续在旧名字上假绿。
/// 走反射而不是扫源码，是因为要断言的是**真正生效的那份匹配**——清单在、匹配写错
/// （裸前缀把邻居一起收走）的情况，扫字面量看不出来。
/// </summary>
internal static class RequestLogRedactionProbe
{
    public static bool CarriesCredential(string path)
    {
        var method = typeof(RequestResponseLoggingMiddleware)
            .GetMethod("CarriesCredential", BindingFlags.NonPublic | BindingFlags.Static);
        method.ShouldNotBeNull("CarriesCredential 改名了（两条守卫盯的都是它，同步改这里，别把断言删掉）");
        return (bool)method!.Invoke(null, new object?[] { path })!;
    }
}
