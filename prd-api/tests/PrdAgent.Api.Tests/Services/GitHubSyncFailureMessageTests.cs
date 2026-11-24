using System;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 目录同步兜底失败的用户文案。
///
/// 事故形状：兜底 catch 把 <c>ex.Message</c> 直接写进条目的 SyncError，而那一栏
/// 会原样渲染到目录卡片上——JSON 解析异常、Mongo 诊断、空引用因此摆到了用户面前。
/// 这里锁两件事：原始异常消息不许出现在用户文案里；已分类的可执行文案要原样透出。
/// </summary>
public class GitHubSyncFailureMessageTests
{
    [Fact]
    public void 已分类的失败原样透出()
    {
        const string classified = "仓库对当前授权不可见：可能是私有仓且你的账号没有读取权限。";

        GitHubSyncFailureMessage.Describe(new GitHubSyncUserFacingException(classified))
            .ShouldBe(classified);
    }

    [Theory]
    [InlineData("Object reference not set to an instance of an object.")]
    [InlineData("A timeout occurred after 30000ms selecting a server using CompositeServerSelector")]
    [InlineData("'<' is an invalid start of a value. Path: $ | LineNumber: 0")]
    public void 未分类异常的原始消息不许出现在用户文案里(string raw)
    {
        foreach (var ex in Unclassified(raw))
        {
            var message = GitHubSyncFailureMessage.Describe(ex);

            message.ShouldNotBeNullOrWhiteSpace();
            message.ShouldNotContain(raw, customMessage: $"{ex.GetType().Name} 的原始消息泄漏到了用户文案里");
        }
    }

    [Fact]
    public void 每一类未分类异常都给得出下一步()
    {
        foreach (var ex in Unclassified("internal detail"))
        {
            // 「重试同步」是目录卡片上真实存在的按钮；失败文案必须把用户指到它，
            // 否则用户拿到的是一个无法处置的名词（external-cause-first）。
            GitHubSyncFailureMessage.Describe(ex)
                .ShouldContain("重试同步", customMessage: $"{ex.GetType().Name} 的文案没有给下一步");
        }
    }

    private static Exception[] Unclassified(string raw) => new Exception[]
    {
        new Exception(raw),
        new TaskCanceledException(raw),
        new HttpRequestException(raw),
        new JsonException(raw),
    };
}
