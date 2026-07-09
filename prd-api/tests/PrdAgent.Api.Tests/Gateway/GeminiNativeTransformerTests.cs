using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.LlmGateway.Transformers;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class GeminiNativeTransformerTests
{
    [Fact]
    public void TransformRequest_MapsOpenAiToolsAndToolResultsToGeminiNative()
    {
        var body = (JsonObject)JsonNode.Parse("""
        {
          "messages": [
            {"role":"user","content":"weather?"},
            {"role":"assistant","content":null,"tool_calls":[
              {"id":"gemini-call-get_weather","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Shanghai\"}"}}
            ]},
            {"role":"tool","tool_call_id":"gemini-call-get_weather","name":"get_weather","content":"{\"result\":\"sunny\"}"}
          ],
          "tools": [
            {"type":"function","function":{"name":"get_weather","description":"query weather","parameters":{"type":"object"}}}
          ],
          "tool_choice": {"type":"function","function":{"name":"get_weather"}}
        }
        """)!;

        var transformed = new GeminiNativeTransformer().TransformRequest(body, null);

        var contents = transformed["contents"]!.AsArray();
        contents.Count.ShouldBe(3);
        contents[1]!["role"]!.GetValue<string>().ShouldBe("model");
        var functionCall = contents[1]!["parts"]!.AsArray()[0]!["functionCall"]!.AsObject();
        functionCall["name"]!.GetValue<string>().ShouldBe("get_weather");
        functionCall["args"]!["city"]!.GetValue<string>().ShouldBe("Shanghai");

        var functionResponse = contents[2]!["parts"]!.AsArray()[0]!["functionResponse"]!.AsObject();
        functionResponse["name"]!.GetValue<string>().ShouldBe("get_weather");
        functionResponse["response"]!["result"]!.GetValue<string>().ShouldBe("sunny");

        var declarations = transformed["tools"]!.AsArray()[0]!["functionDeclarations"]!.AsArray();
        declarations[0]!["name"]!.GetValue<string>().ShouldBe("get_weather");
        transformed["toolConfig"]!["functionCallingConfig"]!["mode"]!.GetValue<string>().ShouldBe("ANY");
        transformed["toolConfig"]!["functionCallingConfig"]!["allowedFunctionNames"]!.AsArray()[0]!.GetValue<string>().ShouldBe("get_weather");
    }

    [Fact]
    public void TransformResponse_MapsGeminiFunctionCallToOpenAiToolCalls()
    {
        var raw = (JsonObject)JsonNode.Parse("""
        {
          "candidates": [
            {
              "content": {
                "parts": [
                  {"functionCall": {"name": "get_weather", "args": {"city": "Shanghai"}}}
                ]
              },
              "finishReason": "STOP"
            }
          ],
          "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 4, "totalTokenCount": 7}
        }
        """)!;

        var transformed = new GeminiNativeTransformer().TransformResponse(raw, null);

        var choice = transformed["choices"]!.AsArray()[0]!.AsObject();
        choice["finish_reason"]!.GetValue<string>().ShouldBe("tool_calls");
        var message = choice["message"]!.AsObject();
        var toolCall = message["tool_calls"]!.AsArray()[0]!.AsObject();
        toolCall["id"]!.GetValue<string>().ShouldBe("gemini-call-get_weather");
        toolCall["function"]!["name"]!.GetValue<string>().ShouldBe("get_weather");
        toolCall["function"]!["arguments"]!.GetValue<string>().ShouldBe("{\"city\":\"Shanghai\"}");
    }
}
