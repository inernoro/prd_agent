using PrdAgent.Api.Tests.Middleware;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests;

/// <summary>
/// OpenDesign 运行时数据面在请求日志中间件里的两条性质，2026-09-20 两条 P1 各对应一条。
///
/// 一、`workspace/result` 的请求体是 `files[].contentBase64` —— 刚生成的整页 HTML 与
/// 由知识库推导出的正文。这条路由还是 `[AllowAnonymous]`，落库时挂匿名身份，
/// 而 apirequestlogs 是同项目所有分支预览共用的那张表。不许进。
///
/// 二、模型代理那两条随时可能以 SSE 返回，而容器里的 SDK 只在请求体里写 `stream`、
/// Accept 常常是 application/json。判错就会被全量缓冲，下游收不到增量字节，
/// 撞上 90 秒中继空闲超时——一次健康的长生成被掐断，且现象看起来像"模型很慢"。
/// </summary>
public sealed class DesignRuntimeDataPlaneLoggingTests
{
    [Theory]
    [InlineData("/api/design-artifacts/runtime/abc123/workspace/result")]
    [InlineData("/api/design-artifacts/runtime/abc123/workspace/input")]
    [InlineData("/api/design-artifacts/runtime/abc123/llm/v1/responses")]
    public void 运行时数据面的请求体不得落进共享日志表(string path)
    {
        RequestLogRedactionProbe.CarriesCredential(path).ShouldBeTrue();
    }

    [Theory]
    // 用户自己那套 design-artifacts 接口不在此列：它们要留着排障，挡过宽不会有人发现。
    [InlineData("/api/design-artifacts/runs")]
    [InlineData("/api/design-artifacts/runs/abc123")]
    [InlineData("/api/design-artifacts/runtime-capabilities")]
    public void 用户侧的设计接口仍然照常记录(string path)
    {
        RequestLogRedactionProbe.CarriesCredential(path).ShouldBeFalse(
            customMessage: "挡得过宽不报错，但排障能力会无声地少一块");
    }

    [Theory]
    [InlineData("/api/design-artifacts/runtime/abc123/llm/v1/chat/completions")]
    [InlineData("/api/design-artifacts/runtime/abc123/llm/v1/responses")]
    public void 模型代理必须始终按流式放行(string path)
    {
        RequestLogRedactionProbe.IsDesignRuntimeModelProxy(path).ShouldBeTrue();
    }

    [Theory]
    // 同一前缀下的非模型路由不该被当成流式：它们是普通 JSON，缓冲无害且日志有用。
    [InlineData("/api/design-artifacts/runtime/abc123/workspace/result")]
    [InlineData("/api/design-artifacts/runtime/abc123/llm/v1/models")]
    // 别的接口更不该被这条判据顺手收走。
    [InlineData("/api/design-artifacts/runs")]
    public void 非模型代理的路由不许被判成流式(string path)
    {
        RequestLogRedactionProbe.IsDesignRuntimeModelProxy(path).ShouldBeFalse();
    }
}
