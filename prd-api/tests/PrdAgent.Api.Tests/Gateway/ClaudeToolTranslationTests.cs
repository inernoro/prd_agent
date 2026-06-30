using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// Claude 适配器 OpenAI 兼容工具链翻译自测（纯函数，无 Mongo / 无 HTTP）。
///
/// 覆盖评审 P2 三处中的「非流式」两处：
///   - assistant.tool_calls / role:"tool" 消息 → Claude tool_use / tool_result content block（多轮工具循环不再 400）。
///   - tool_choice:"none" → 整段不附 tools（Claude 不可能 emit tool_use，兑现调用方禁用意图）。
/// （流式 tool_use 增量聚合属有状态解析，单独一批做。）
///
/// 走 public BuildHttpRequest → 读回序列化 body 断言，等价于 ConvertToClaudeFormat 的输出。
/// 不打 Integration/Manual trait → CI 默认 dotnet test 真跑。
/// </summary>
public class ClaudeToolTranslationTests
{
    private static JsonObject Convert(string openaiJson, bool cache = false)
    {
        var body = (JsonObject)JsonNode.Parse(openaiJson)!;
        var req = new ClaudeGatewayAdapter()
            .BuildHttpRequest("https://api.anthropic.com/v1/messages", "k", body, cache);
        var json = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
        return (JsonObject)JsonNode.Parse(json)!;
    }

    [Fact]
    public void AssistantToolCalls_TranslatedToClaudeToolUseBlocks()
    {
        var result = Convert("""
        {
          "model": "claude-x",
          "messages": [
            {"role":"user","content":"weather?"},
            {"role":"assistant","content":null,"tool_calls":[
               {"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"SF\"}"}}
            ]},
            {"role":"tool","tool_call_id":"call_1","content":"sunny"}
          ]
        }
        """);

        var msgs = result["messages"]!.AsArray();
        msgs.Count.ShouldBe(3);

        // [1] assistant → tool_use 块
        var asst = msgs[1]!.AsObject();
        asst["role"]!.GetValue<string>().ShouldBe("assistant");
        var toolUse = asst["content"]!.AsArray()[0]!.AsObject();
        toolUse["type"]!.GetValue<string>().ShouldBe("tool_use");
        toolUse["id"]!.GetValue<string>().ShouldBe("call_1");
        toolUse["name"]!.GetValue<string>().ShouldBe("get_weather");
        toolUse["input"]!["city"]!.GetValue<string>().ShouldBe("SF"); // arguments 字符串被解析回对象

        // [2] tool → user 轮的 tool_result 块
        var toolResultUser = msgs[2]!.AsObject();
        toolResultUser["role"]!.GetValue<string>().ShouldBe("user");
        var tr = toolResultUser["content"]!.AsArray()[0]!.AsObject();
        tr["type"]!.GetValue<string>().ShouldBe("tool_result");
        tr["tool_use_id"]!.GetValue<string>().ShouldBe("call_1");
        tr["content"]!.GetValue<string>().ShouldBe("sunny");
    }

    [Fact]
    public void ConsecutiveToolMessages_MergedIntoSingleUserTurn()
    {
        // 并行工具调用：assistant 一轮调两个工具 → 两个 tool 结果消息必须合并进同一个 user 轮
        // （Claude 要求 tool_result 与 tool_use 配对在相邻 assistant/user 轮，且不允许连续 user 轮）。
        var result = Convert("""
        {
          "model": "claude-x",
          "messages": [
            {"role":"assistant","content":null,"tool_calls":[
               {"id":"a","type":"function","function":{"name":"f1","arguments":"{}"}},
               {"id":"b","type":"function","function":{"name":"f2","arguments":"{}"}}
            ]},
            {"role":"tool","tool_call_id":"a","content":"r1"},
            {"role":"tool","tool_call_id":"b","content":"r2"}
          ]
        }
        """);

        var msgs = result["messages"]!.AsArray();
        msgs.Count.ShouldBe(2); // assistant + 一个合并的 user（不是两个 user）

        var asstBlocks = msgs[0]!.AsObject()["content"]!.AsArray();
        asstBlocks.Count.ShouldBe(2); // 两个 tool_use

        var userTurn = msgs[1]!.AsObject();
        userTurn["role"]!.GetValue<string>().ShouldBe("user");
        var results = userTurn["content"]!.AsArray();
        results.Count.ShouldBe(2); // 两个 tool_result 合并在一个 user 轮
        results[0]!["tool_use_id"]!.GetValue<string>().ShouldBe("a");
        results[1]!["tool_use_id"]!.GetValue<string>().ShouldBe("b");
    }

    [Fact]
    public void ToolChoiceNone_DropsToolsEntirely()
    {
        var result = Convert("""
        {
          "model": "claude-x",
          "tool_choice": "none",
          "tools": [{"type":"function","function":{"name":"f","parameters":{"type":"object"}}}],
          "messages": [{"role":"user","content":"hi"}]
        }
        """);

        result.ContainsKey("tools").ShouldBeFalse();       // 整段不附 tools
        result.ContainsKey("tool_choice").ShouldBeFalse(); // 也不设 tool_choice
    }

    [Fact]
    public void ToolChoiceAuto_KeepsToolsAndChoice()
    {
        var result = Convert("""
        {
          "model": "claude-x",
          "tool_choice": "auto",
          "tools": [{"type":"function","function":{"name":"f","description":"d","parameters":{"type":"object"}}}],
          "messages": [{"role":"user","content":"hi"}]
        }
        """);

        var tools = result["tools"]!.AsArray();
        tools.Count.ShouldBe(1);
        tools[0]!["name"]!.GetValue<string>().ShouldBe("f");           // OpenAI function 包裹 → Claude 扁平 name
        tools[0]!["input_schema"]!["type"]!.GetValue<string>().ShouldBe("object"); // parameters → input_schema
        result["tool_choice"]!["type"]!.GetValue<string>().ShouldBe("auto");
    }

    [Fact]
    public void PlainMessages_PassThroughUnchanged()
    {
        var result = Convert("""
        {
          "model": "claude-x",
          "messages": [
            {"role":"system","content":"be brief"},
            {"role":"user","content":"hi"}
          ]
        }
        """);

        // system 抽出到 system 字段
        result["system"]!.AsArray()[0]!["text"]!.GetValue<string>().ShouldBe("be brief");
        // 普通 user 原样
        var msgs = result["messages"]!.AsArray();
        msgs.Count.ShouldBe(1);
        msgs[0]!["role"]!.GetValue<string>().ShouldBe("user");
        msgs[0]!["content"]!.GetValue<string>().ShouldBe("hi");
    }
}
