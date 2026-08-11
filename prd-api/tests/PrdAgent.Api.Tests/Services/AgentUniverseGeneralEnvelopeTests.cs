using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 通用智能体接进「智能体宇宙」信封时，两条信封的字段名不一样：
/// 对话事件用 text，本信封的 text 事件用 content。
///
/// 只改事件名不改字段，前端流式渲染会一个字都收不到——**不报错、不变红，只是不出字**。
/// 这正是「名字对上了、字段没对上」那种静默退化，必须有断言盯着。
/// </summary>
public class AgentUniverseGeneralEnvelopeTests
{
    [Fact]
    public void TextDelta_载荷必须从对话的_text_字段取出()
    {
        AgentUniverseController.ExtractTextDelta("""{"text":"这段录音的结论是"}""")
            .ShouldBe("这段录音的结论是");
    }

    [Fact]
    public void 取错字段名会拿到空_这条用例就是那道闸()
    {
        // 若哪天把对话事件的字段改名（或这里改去读 content），必须在这里先红
        AgentUniverseController.ExtractTextDelta("""{"content":"错字段"}""").ShouldBeNull();
    }

    [Theory]
    [InlineData("""{"text":null}""")]
    [InlineData("""{"text":123}""")]
    [InlineData("""{}""")]
    [InlineData("not json at all")]
    [InlineData("[1,2,3]")]
    public void 坏载荷一律返回空而不是抛异常_不能因为一条脏事件掐断整条流(string payload)
    {
        AgentUniverseController.ExtractTextDelta(payload).ShouldBeNull();
    }

    [Fact]
    public void 通用体的_agentKey_与权限键必须对齐()
    {
        // 前端按这个 key 发起 invoke，权限门按 {key}.use 判定；两者漂开就会「有权限却被拒」
        AgentUniverseController.GeneralAgentKey.ShouldBe("chat-agent");
        PrdAgent.Core.Security.AdminPermissionCatalog.ChatAgentUse
            .ShouldBe(AgentUniverseController.GeneralAgentKey + ".use");
    }

    [Fact]
    public void 事件类型常量未被改名_否则控制器的_switch_会静默落空()
    {
        ChatAgentEventTypes.TextDelta.ShouldBe("text_delta");
        ChatAgentEventTypes.ToolStarted.ShouldBe("tool_started");
        ChatAgentEventTypes.ToolFinished.ShouldBe("tool_finished");
        ChatAgentEventTypes.Done.ShouldBe("done");
        ChatAgentEventTypes.Error.ShouldBe("error");
    }

    [Fact]
    public void 运行时只在终态给定稿全文时_必须把它当正文补发()
    {
        // 攒完了一次性给全文的运行时：不补发 = 用户看到一个字都没有的空回答
        AgentUniverseController.ShouldEmitFinalText(streamedAnyText: false, finalText: "结论是这样")
            .ShouldBeTrue();
    }

    [Fact]
    public void 已经流过增量就不许再补发_本信封的_text_是追加语义()
    {
        // 边跑边发增量的运行时：补发等于把整段答案原样贴第二遍
        AgentUniverseController.ShouldEmitFinalText(streamedAnyText: true, finalText: "结论是这样")
            .ShouldBeFalse();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void 终态没带定稿全文时不补发空白(string? finalText)
    {
        AgentUniverseController.ShouldEmitFinalText(streamedAnyText: false, finalText).ShouldBeFalse();
    }

    [Fact]
    public void 终态载荷的字段名与对话路径一致_都是_text()
    {
        // 对话路径 TranslateOneOff 把 Done 译成 { text = evt.FinalText }。
        // 这里读的必须是同一个字段名，读错就退化成「永远没有定稿全文」——不报错，只是不出字。
        AgentUniverseController.ExtractTextDelta("""{"text":"定稿全文"}""").ShouldBe("定稿全文");
    }
}
